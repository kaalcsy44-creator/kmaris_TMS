"""Google 공유 드라이브 연동 — 프로젝트 폴더를 만들고 발행 문서를 그 안에 올린다.

프로젝트 하나 = KTMS 레코드(RFQ) 하나 = 드라이브 폴더 하나.

    K-MARIS PROJECTS (공유 드라이브)
    ├── 00 ★PROJECT_PARTS      ← DRIVE_PARTS_ROOT_ID   (work_type=PARTS)
    │   └── 261107 Everhonest MSC VERACRUZ AE CW Pump Spares
    │       ├── 01 RFQ   접수 첨부
    │       ├── 02 QTN   견적서
    │       ├── 03 PO    P/O
    │       └── 04 INV   PI · CI · PL · S/A 등 인보이스·선적서류
    └── 00 ★PROJECT_SERVICE    ← DRIVE_SERVICE_ROOT_ID (work_type=SERVICE)

인증: 서비스 계정 키(JSON). 다음 순서로 찾는다.
    DRIVE_SA_KEY_JSON  키 내용 전체(Render 는 이것을 쓴다)
    DRIVE_SA_KEY_FILE  키 파일 경로
    ktms/config/ktms_drive_sa.json  (로컬 기본 위치, gitignore 대상)
옛 GOOGLE_SA_KEY_* 는 일부러 읽지 않는다 — 그 키는 다른 앱(workstream)의 프로젝트에 있고,
드라이브 권한이 없어 섞이면 조용히 403 이 난다.

규칙
- 지우지 않고 덮어쓰지 않는다. 같은 이름이 있으면 " (2)" 를 붙여 새로 올린다.
- ensure_* 는 멱등이다. 이미 있으면 만들지 않고 그것을 돌려준다.
- 실패는 DriveError 로 올린다. 발행·등록을 막지 않도록 삼키는 것은 호출하는 쪽의 몫이다
  (try_* 래퍼가 그 일을 한다).
"""
from __future__ import annotations

import io
import json
import logging
import os
import re
import threading
import time
from datetime import date, datetime
from pathlib import Path
from typing import BinaryIO

log = logging.getLogger(__name__)

API = "https://www.googleapis.com/drive/v3"
UPLOAD_API = "https://www.googleapis.com/upload/drive/v3"
FOLDER_MIME = "application/vnd.google-apps.folder"
SCOPES = ["https://www.googleapis.com/auth/drive"]
TIMEOUT = 30            # 초. 드라이브가 느려도 요청 하나가 이보다 오래 붙잡지 않는다.
CHUNK = 8 * 1024 * 1024  # 이어 올리기 조각 크기(256KB 의 배수여야 한다)
NAME_MAX = 120

_DEFAULT_KEY_FILE = Path(__file__).resolve().parent.parent / "config" / "ktms_drive_sa.json"

# 하위 폴더: (표준 이름, 기존 폴더에서 같은 자리로 인정하는 이름들).
# 이미 있는 폴더 이름은 바꾸지 않는다 — '03 PO PI' 가 있는 프로젝트는 그것을 PO 칸으로 쓴다.
SUBFOLDERS: dict[str, tuple[str, tuple[str, ...]]] = {
    "RFQ": ("01 RFQ", ("01 RFQ", "RFQ")),
    "QTN": ("02 QTN", ("02 QTN", "QTN")),
    "PO":  ("03 PO",  ("03 PO", "03 PO PI", "PO", "PO PI")),
    "INV": ("04 INV", ("04 INV", "INV")),
}


class DriveError(RuntimeError):
    """드라이브 호출 실패(설정 누락 포함)."""


# ── 설정 ──────────────────────────────────────────────────────────────────────

def _key_info() -> dict | None:
    raw = (os.environ.get("DRIVE_SA_KEY_JSON") or "").strip()
    if raw:
        return json.loads(raw)
    path = (os.environ.get("DRIVE_SA_KEY_FILE") or "").strip()
    p = Path(path) if path else _DEFAULT_KEY_FILE
    if p.is_file():
        return json.loads(p.read_text(encoding="utf-8"))
    return None


def root_id(work_type: str | None = None) -> str | None:
    """업무 타입별 루트 폴더 ID. SERVICE 가 아니면 PARTS 로 본다."""
    wt = str(getattr(work_type, "name", work_type) or "").upper()
    var = "DRIVE_SERVICE_ROOT_ID" if wt in ("SERVICE", "서비스") else "DRIVE_PARTS_ROOT_ID"
    return (os.environ.get(var) or "").strip() or None


def enabled(work_type: str | None = None) -> bool:
    """키와 루트 ID 가 모두 있으면 True. 하나라도 없으면 연동을 건너뛴다."""
    try:
        return _key_info() is not None and root_id(work_type) is not None
    except Exception:
        return False


# ── HTTP ──────────────────────────────────────────────────────────────────────

_session = None
_session_lock = threading.Lock()


def _http():
    """인증된 requests 세션(토큰은 만료되면 스스로 갱신한다)."""
    global _session
    with _session_lock:
        if _session is None:
            info = _key_info()
            if info is None:
                raise DriveError("드라이브 서비스 계정 키가 설정되지 않았습니다(DRIVE_SA_KEY_JSON).")
            from google.oauth2.service_account import Credentials
            from google.auth.transport.requests import AuthorizedSession
            _session = AuthorizedSession(Credentials.from_service_account_info(info, scopes=SCOPES))
        return _session


def _call(method: str, url: str, *, params=None, json_body=None, data=None,
          headers=None, ok=(200,), retries: int = 3):
    """요청 하나. 429·5xx 는 잠깐 쉬었다 다시 시도하고, 그래도 안 되면 DriveError."""
    p = {"supportsAllDrives": "true", **(params or {})}
    last = None
    for attempt in range(retries):
        try:
            r = _http().request(method, url, params=p, json=json_body, data=data,
                                headers=headers, timeout=TIMEOUT)
        except DriveError:
            raise
        except Exception as exc:          # 네트워크 끊김·타임아웃
            last = f"{type(exc).__name__}: {exc}"
        else:
            if r.status_code in ok:
                return r
            try:
                msg = r.json().get("error", {}).get("message") or r.text
            except ValueError:
                msg = r.text
            last = f"HTTP {r.status_code}: {' '.join(str(msg).split())[:200]}"
            if r.status_code not in (429, 500, 502, 503, 504):
                break
        time.sleep(1.5 * (attempt + 1))
    raise DriveError(f"{method} {url.rsplit('/', 2)[-1]} 실패 — {last}")


def _q_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("'", "\\'")


def _children(parent_id: str, *, name: str | None = None, folders_only: bool = False,
              fields: str = "id,name,mimeType") -> list[dict]:
    q = [f"'{_q_escape(parent_id)}' in parents", "trashed = false"]
    if name is not None:
        q.append(f"name = '{_q_escape(name)}'")
    if folders_only:
        q.append(f"mimeType = '{FOLDER_MIME}'")
    out: list[dict] = []
    token = None
    while True:
        params = {"q": " and ".join(q), "corpora": "allDrives", "includeItemsFromAllDrives": "true",
                  "fields": f"nextPageToken,files({fields})", "pageSize": 1000}
        if token:
            params["pageToken"] = token
        body = _call("GET", f"{API}/files", params=params).json()
        out.extend(body.get("files", []))
        token = body.get("nextPageToken")
        if not token:
            return out


def get_folder(folder_id: str) -> dict | None:
    """폴더가 살아 있으면 메타({id,name,parents}), 없거나 휴지통이면 None."""
    r = _call("GET", f"{API}/files/{folder_id}",
              params={"fields": "id,name,mimeType,trashed,parents"}, ok=(200, 404))
    if r.status_code == 404:
        return None
    meta = r.json()
    if meta.get("trashed") or meta.get("mimeType") != FOLDER_MIME:
        return None
    return meta


# ── 이름 ──────────────────────────────────────────────────────────────────────

_FORBIDDEN = re.compile(r'[\\/:*?"<>|\r\n\t]+')


def sanitize_name(name: str, max_len: int = NAME_MAX) -> str:
    """폴더·파일명에 못 쓰는 글자(\\ / : * ? " < > |)를 지우고 공백을 하나로, 길이를 자른다."""
    s = _FORBIDDEN.sub(" ", str(name or ""))
    s = re.sub(r"\s+", " ", s).strip(" .")
    return s[:max_len].rstrip(" .")


def _yymmdd(d) -> str:
    if isinstance(d, (date, datetime)):
        return d.strftime("%y%m%d")
    digits = re.sub(r"\D", "", str(d or ""))
    if len(digits) >= 8:            # 2026-11-07 / 20261107
        return digits[2:8]
    if len(digits) == 6:            # 이미 yymmdd
        return digits
    return datetime.now().strftime("%y%m%d")


def project_folder_name(received: str | date | None, customer: str | None,
                        vessel: str | None, title: str | None) -> str:
    """`yymmdd 고객사 선박명 아이템제목`. 빈 칸은 NA 로 채운다(비워 두지 않는다)."""
    parts = [_yymmdd(received)]
    for v in (customer, vessel, title):
        v = sanitize_name(v or "")
        parts.append(v or "NA")
    return sanitize_name(" ".join(parts))


def folder_url(folder_id: str) -> str:
    return f"https://drive.google.com/drive/folders/{folder_id}"


# ── 폴더 ──────────────────────────────────────────────────────────────────────

# 같은 폴더 안에서 "이름 확인 → 만들기"가 동시에 두 번 돌면(버튼 두 번 누름) 같은 이름이
# 둘 생긴다. 부모 폴더마다 잠금을 따로 둔다 — 큰 파일 업로드가 다른 프로젝트를 붙잡지 않게.
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(parent_id: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(parent_id, threading.Lock())


def _create_folder(parent_id: str, name: str) -> str:
    r = _call("POST", f"{API}/files", params={"fields": "id"},
              json_body={"name": name, "mimeType": FOLDER_MIME, "parents": [parent_id]})
    return r.json()["id"]


def ensure_folder(parent_id: str, name: str) -> str:
    """parent 아래 `name` 폴더의 ID. 없으면 만든다(멱등)."""
    name = sanitize_name(name)
    if not name:
        raise DriveError("폴더 이름이 비어 있습니다.")
    with _lock_for(parent_id):
        found = _children(parent_id, name=name, folders_only=True)
        if found:
            return sorted(found, key=lambda f: f["id"])[0]["id"]
        return _create_folder(parent_id, name)


def ensure_project_folder(project_name: str, *, work_type: str | None = None,
                          folder_id: str | None = None) -> str:
    """프로젝트 폴더 ID(멱등).

    이미 연결된 folder_id 가 살아 있으면 그것을 쓴다 — 사람이 폴더를 옮기거나 이름을
    고쳐도 새로 만들지 않기 위해서다. 없으면 루트 바로 아래에서 같은 이름을 찾고,
    그래도 없으면 만든다.
    """
    if folder_id and get_folder(folder_id):
        return folder_id
    root = root_id(work_type)
    if not root:
        raise DriveError("드라이브 루트 폴더 ID 가 설정되지 않았습니다(DRIVE_PARTS_ROOT_ID / DRIVE_SERVICE_ROOT_ID).")
    return ensure_folder(root, project_name)


def ensure_subfolders(project_folder_id: str) -> dict[str, str]:
    """`01 RFQ`·`02 QTN`·`03 PO`·`04 INV` 를 갖추고 {"RFQ": id, ...} 를 돌려준다.

    이미 있는 폴더는 이름이 조금 달라도(`RFQ`, `03 PO PI`) 그 자리로 인정하고 이름을
    바꾸지 않는다. 없는 것만 표준 이름으로 만든다.
    """
    with _lock_for(project_folder_id):
        existing = {f["name"].strip().upper(): f["id"]
                    for f in sorted(_children(project_folder_id, folders_only=True),
                                    key=lambda f: f["id"], reverse=True)}
        out: dict[str, str] = {}
        for key, (canonical, aliases) in SUBFOLDERS.items():
            hit = next((existing[a.upper()] for a in aliases if a.upper() in existing), None)
            out[key] = hit or _create_folder(project_folder_id, canonical)
        return out


def ensure_project(project_name: str, *, work_type: str | None = None,
                   folder_id: str | None = None) -> dict:
    """프로젝트 폴더 + 하위 폴더 한 번에. {"folder_id", "folder_url", "sub": {...}}."""
    fid = ensure_project_folder(project_name, work_type=work_type, folder_id=folder_id)
    return {"folder_id": fid, "folder_url": folder_url(fid), "sub": ensure_subfolders(fid)}


def subfolder_id(project_folder_id: str, key: str) -> str:
    """하위 폴더 하나(RFQ/QTN/PO/INV)의 ID. 없으면 만든다."""
    key = key.upper()
    if key not in SUBFOLDERS:
        raise DriveError(f"알 수 없는 하위 폴더: {key}")
    return ensure_subfolders(project_folder_id)[key]


# ── 파일 ──────────────────────────────────────────────────────────────────────

def _split_ext(filename: str) -> tuple[str, str]:
    stem, dot, ext = filename.rpartition(".")
    if not dot or not stem or len(ext) > 8 or " " in ext:
        return filename, ""
    return stem, "." + ext


def _numbered(filename: str, n: int) -> str:
    if n <= 1:
        return filename
    stem, ext = _split_ext(filename)
    return f"{stem} ({n}){ext}"


def _free_name(folder_id: str, filename: str, md5: str | None,
               prop: tuple[str, str] | None = None) -> tuple[str, str | None]:
    """(올릴 이름, 내용이 같은 기존 파일 ID|None). 덮어쓰지 않도록 ' (n)' 을 붙인다.

    같다고 보는 기준: md5(바이트가 같을 때) 또는 prop=(키, 값) — 파일에 붙여 둔
    appProperties 가 같을 때(생성 시각만 다른 같은 문서를 가려낸다)."""
    stem, ext = _split_ext(filename)
    # 같은 이름과 번호 붙은 이름을 한 번에 모은다(이름이 stem 으로 시작하는 것).
    q_stem = stem[:80]
    siblings = [f for f in _children(folder_id, fields="id,name,md5Checksum,mimeType,appProperties")
                if f.get("mimeType") != FOLDER_MIME and f["name"].startswith(q_stem)]
    names = {f["name"] for f in siblings}
    if md5 or prop:
        pat = re.compile(rf"^{re.escape(stem)}( \(\d+\))?{re.escape(ext)}$")
        for f in siblings:
            if not pat.match(f["name"]):
                continue
            if (md5 and f.get("md5Checksum") == md5) or (
                    prop and (f.get("appProperties") or {}).get(prop[0]) == prop[1]):
                return f["name"], f["id"]
    n = 1
    while _numbered(filename, n) in names:
        n += 1
    return _numbered(filename, n), None


def upload_file(folder_id: str, filename: str, data: bytes | BinaryIO,
                mime: str = "application/octet-stream", *, skip_if_same: bool = False,
                app_properties: dict[str, str] | None = None,
                skip_if_prop: str | None = None) -> dict:
    """파일 하나를 올린다. 같은 이름이 있으면 ' (2)' 를 붙인다 — 덮어쓰지 않는다.

    data 는 bytes 또는 읽기 가능한 파일 객체. 큰 파일도 조각(8MB)으로 나눠 올려
    메모리에 한꺼번에 올리지 않는다.
    skip_if_same=True 면 같은 이름 계열에 내용(md5)이 같은 파일이 이미 있을 때 올리지 않고
    그 파일을 돌려준다.
    반환: {"id", "name", "url", "skipped": bool}
    """
    filename = sanitize_name(filename, max_len=180) or "file"
    md5 = None
    if skip_if_same:
        import hashlib
        h = hashlib.md5()
        if isinstance(data, (bytes, bytearray)):
            h.update(data)
        else:
            pos = data.tell()
            for chunk in iter(lambda: data.read(CHUNK), b""):
                h.update(chunk)
            data.seek(pos)
        md5 = h.hexdigest()

    prop = None
    if skip_if_prop and app_properties and app_properties.get(skip_if_prop):
        prop = (skip_if_prop, app_properties[skip_if_prop])
    with _lock_for(folder_id):
        name, same_id = _free_name(folder_id, filename, md5, prop)
        if same_id:
            return {"id": same_id, "name": name, "url": file_url(same_id), "skipped": True}

        stream = io.BytesIO(data) if isinstance(data, (bytes, bytearray)) else data
        start = stream.tell()
        stream.seek(0, io.SEEK_END)
        size = stream.tell() - start
        stream.seek(start)

        init = _call("POST", f"{UPLOAD_API}/files",
                     params={"uploadType": "resumable", "fields": "id,name"},
                     json_body={"name": name, "parents": [folder_id], "mimeType": mime,
                                **({"appProperties": app_properties} if app_properties else {})},
                     headers={"X-Upload-Content-Type": mime, "X-Upload-Content-Length": str(size)})
        session_url = init.headers["Location"]

        sent = 0
        result = None
        while True:
            chunk = stream.read(CHUNK)
            end = sent + len(chunk) - 1
            rng = f"bytes {sent}-{end}/{size}" if chunk else f"bytes */{size}"
            r = _call("PUT", session_url, data=chunk,
                      headers={"Content-Range": rng, "Content-Type": mime}, ok=(200, 201, 308))
            sent += len(chunk)
            if r.status_code in (200, 201):
                result = r.json()
                break
            if not chunk:
                raise DriveError("업로드가 끝나지 않았습니다.")
    return {"id": result["id"], "name": result.get("name", name),
            "url": file_url(result["id"]), "skipped": False}


def upload_text(folder_id: str, filename: str, text: str) -> dict:
    """글(메신저 접수 내용 등)을 .md/.txt 파일로 올린다."""
    mime = "text/markdown" if filename.lower().endswith(".md") else "text/plain"
    return upload_file(folder_id, filename, text.encode("utf-8"), f"{mime}; charset=utf-8")


def file_url(file_id: str) -> str:
    return f"https://drive.google.com/file/d/{file_id}/view"


# ── 실패를 삼키는 래퍼 ───────────────────────────────────────────────────────

def try_call(fn, *args, **kwargs):
    """드라이브 실패가 본 작업(등록·발행)을 막지 않게 — 예외를 로그로 남기고 None.

    설정이 없어 연동이 꺼져 있으면 조용히 None.
    """
    try:
        return fn(*args, **kwargs)
    except DriveError as exc:
        log.warning("drive_svc: %s", exc)
    except Exception:
        log.exception("drive_svc: 예기치 못한 오류")
    return None
