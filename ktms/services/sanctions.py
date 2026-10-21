"""제재 선박 명부 — 미국 OFAC SDN 과 영국 UK Sanctions List 에 오른 배를 IMO 번호로 찾는다.

왜 IMO 인가: 제재된 배는 이름을 자주 바꾼다. 명부에는 지정 당시 이름(예: MARABELLA SUN)이
남아 있는데 우리 명부에는 지금 이름(CHARIOT TIDE)이 적혀 있어, 이름으로 맞추면 놓친다.
IMO 번호는 배가 평생 들고 다니는 번호라 이름이 바뀌어도 그대로다.

두 명부 모두 정부가 무료로 공개하는 파일이다. 받아서 IMO → 지정 내역만 추려 DB
(app_settings["sanctions_vessels"])에 둔다 — Render 는 배포마다 파일시스템이 새로 생기므로
파일에 두면 재배포 때마다 사라진다. 하루 한 번 새로 받는다(start()). 받기에 실패하면
어제 것을 그대로 쓴다 — 명부가 비는 것보다 하루 묵은 것이 낫다.

이 확인은 **경고용**이다. 거래를 막지 않는다(사용자 결정, 2026-10-21).
"""
from __future__ import annotations

import csv
import io
import re
import sys
import threading
import time
import urllib.request
from datetime import datetime, timedelta

from db.models import AppSetting

STATE_KEY = "sanctions_vessels"

OFAC_SDN_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV"
UK_LIST_URL = "https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv"

# 앞뒤가 숫자만 아니면 된다 — 영국 명부는 "IMO9323376" 처럼 붙여 적는다(\b 로는 못 잡는다).
_IMO = re.compile(r"(?<!\d)(\d{7})(?!\d)")
# 하루 한 번이면 충분하다 — 두 명부 모두 많아야 주 몇 번 갱신된다.
_REFRESH_EVERY = timedelta(hours=20)
_CHECK_EVERY_SEC = 60 * 60

# 프로세스 안 캐시 — 목록 화면마다 DB 의 큰 JSON 을 다시 읽지 않게. (updated_at, by_imo)
_memo: dict = {"at": 0.0, "by_imo": None, "updated_at": ""}
_MEMO_TTL_SEC = 10 * 60


def _norm_imo(v) -> str:
    m = _IMO.search(str(v or ""))
    return m.group(1) if m else ""


def _parse_ofac(text: str) -> dict[str, dict]:
    """SDN.CSV — 열 순서: ent_num, name, sdn_type, program, title, call_sign, vess_type,
    tonnage, grt, vess_flag, vess_owner, remarks. 배는 remarks 에 'IMO 1234567' 이 있다."""
    out: dict[str, dict] = {}
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 12 or row[2].strip().lower() != "vessel":
            continue
        m = re.search(r"IMO (\d{7})", row[11])
        if not m:
            continue
        clean = lambda v: "" if v.strip() in ("-0-", "") else v.strip()
        out[m.group(1)] = {
            "source": "US OFAC",
            "name": clean(row[1]),
            "program": clean(row[3]).replace("] [", ", "),
            "vessel_type": clean(row[6]),
            "flag": clean(row[9]),
        }
    return out


def _parse_uk(text: str) -> dict[str, dict]:
    """UK Sanctions List CSV — 첫 줄은 'Report Date', 둘째 줄이 머리글. 배는
    Designation Type 이 'Ship' 이고 'IMO number' 칸이 있다. 별칭마다 줄이 반복된다."""
    # splitlines() 는 칸 안의 특수 줄바꿈 문자(\x1c·  등)에서도 끊어 행을 망가뜨린다 —
    # 머리글 자리에서 잘라 csv 에 통째로 맡긴다.
    head = text.find("Last Updated,")
    out: dict[str, dict] = {}
    for row in csv.DictReader(io.StringIO(text[head:] if head >= 0 else text, newline="")):
        if (row.get("Designation Type") or "").strip().lower() != "ship":
            continue
        imo = _norm_imo(row.get("IMO number"))
        if not imo or imo in out:
            continue
        name = (row.get("Name 6") or "").strip()
        # 이름 없이 'IMO 9317315 ('LUCH')' 처럼 적힌 줄 — 괄호 안이 배 이름이다.
        m = re.search(r"\(\s*'?([^')]+?)'?\s*\)", name) if name.upper().startswith("IMO") else None
        out[imo] = {
            "source": "UK",
            "name": m.group(1) if m else name,
            # "The Russia (Sanctions) (EU Exit) Regulations 2019" → "Russia"
            "program": re.sub(r"^The\s+|\s*\(Sanctions\).*$", "", (row.get("Regime Name") or "").strip()),
            "vessel_type": "",
            "flag": "",
        }
    return out


def refresh(session) -> dict:
    """두 명부를 새로 받아 DB 에 둔다. 한쪽이 실패하면 그쪽은 지난번 값을 유지한다."""
    row = session.query(AppSetting).filter_by(key=STATE_KEY).first()
    prev = (row.value or {}) if row else {}
    prev_lists = prev.get("lists") or {}
    lists: dict[str, dict] = {}
    errors: dict[str, str] = {}
    for key, url, parse in (("ofac", OFAC_SDN_URL, _parse_ofac), ("uk", UK_LIST_URL, _parse_uk)):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "KTMS/1.0"})
            with urllib.request.urlopen(req, timeout=120) as resp:
                parsed = parse(resp.read().decode("utf-8-sig", errors="ignore"))
            if not parsed:
                raise ValueError("no vessels parsed")
            lists[key] = {"fetched_at": datetime.utcnow().isoformat(timespec="seconds"), "by_imo": parsed}
        except Exception as exc:
            errors[key] = str(exc)[:200]
            if key in prev_lists:
                lists[key] = prev_lists[key]
    value = {
        "updated_at": datetime.utcnow().isoformat(timespec="seconds"),
        "lists": lists,
        "errors": errors,
    }
    if row is None:
        row = AppSetting(key=STATE_KEY, value=value)
        session.add(row)
    else:
        row.value = value
        row.updated_at = datetime.utcnow()
    session.commit()
    _memo.update(at=0.0, by_imo=None)
    return status(session)


def _load(session) -> dict[str, list[dict]]:
    """IMO → 지정 내역 목록(명부마다 하나). 프로세스 캐시를 먼저 본다."""
    now = time.time()
    if _memo["by_imo"] is not None and now - _memo["at"] < _MEMO_TTL_SEC:
        return _memo["by_imo"]
    row = session.query(AppSetting).filter_by(key=STATE_KEY).first()
    by_imo: dict[str, list[dict]] = {}
    for lst in ((row.value or {}).get("lists") or {}).values() if row else []:
        for imo, hit in (lst.get("by_imo") or {}).items():
            by_imo.setdefault(imo, []).append(hit)
    _memo.update(at=now, by_imo=by_imo, updated_at=((row.value or {}).get("updated_at") if row else "") or "")
    return by_imo


def check(session, imo) -> list[dict]:
    """이 IMO 가 오른 명부들. 없으면 []."""
    key = _norm_imo(imo)
    return list(_load(session).get(key, [])) if key else []


def status(session) -> dict:
    row = session.query(AppSetting).filter_by(key=STATE_KEY).first()
    v = (row.value or {}) if row else {}
    lists = v.get("lists") or {}
    return {
        "updated_at": v.get("updated_at") or "",
        "lists": {k: {"fetched_at": l.get("fetched_at"), "vessels": len(l.get("by_imo") or {})}
                  for k, l in lists.items()},
        "errors": v.get("errors") or {},
    }


def _needs_refresh(session) -> bool:
    row = session.query(AppSetting).filter_by(key=STATE_KEY).first()
    try:
        last = datetime.fromisoformat(((row.value or {}) if row else {}).get("updated_at") or "")
    except ValueError:
        return True
    return datetime.utcnow() - last > _REFRESH_EVERY


def _loop(get_session) -> None:
    while True:
        s = get_session()
        try:
            if _needs_refresh(s):
                refresh(s)
        except Exception as exc:
            print(f"[WARN] sanctions refresh failed: {exc}", file=sys.stderr)
        finally:
            s.close()
        time.sleep(_CHECK_EVERY_SEC)


def start(get_session) -> None:
    """서버가 뜨면 얇은 스레드 하나로 하루 한 번 명부를 새로 받는다(mail_auto 와 같은 방식 —
    "몇 시에"가 아니라 "마지막으로 받은 지 하루가 지났나"를 자주 본다)."""
    threading.Thread(target=_loop, args=(get_session,), daemon=True, name="sanctions-refresh").start()
