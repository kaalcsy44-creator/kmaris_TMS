"""KTMS 프로젝트(RFQ) ↔ 공유 드라이브 폴더 잇기.

drive_svc 는 드라이브만 알고, 이 모듈은 KTMS 레코드를 안다 — 폴더 이름을 RFQ·고객사·
선박에서 만들고, 만든 폴더의 ID 를 RFQ 에 적는다.

폴더는 자동으로 만들지 않는다(2026-11-17 사용자 요청). 등록·승인·업로드·발행 어디서도
몰래 만들지 않고, 사람이 "Create folder" 확인 창에서 이름·하위 폴더를 보고 승인할 때만
만든다(첨부 업로드에서 "폴더 만들고 올리기"를 고른 경우 포함). 만든 것은 created 로 돌려준다.
"""
from __future__ import annotations

import hashlib
import io
import logging
import re
import zipfile

from db.engine import get_session
from db.models import RFQ, Customer, Vessel
from services import drive_svc

log = logging.getLogger(__name__)


def customer_label(c: Customer | None) -> str:
    """폴더명에 쓰는 고객사 표기 — 약칭, 없으면 회사명."""
    if c is None:
        return ""
    return (getattr(c, "short_name", None) or "").strip() or (c.name or "").strip()


def work_type_key(rfq: RFQ) -> str:
    wt = getattr(rfq.work_type, "name", None) or str(rfq.work_type or "")
    return "SERVICE" if wt.upper() in ("SERVICE", "서비스") else "PARTS"


def folder_name(s, rfq: RFQ) -> str:
    cust = s.query(Customer).filter_by(id=rfq.customer_id).first() if rfq.customer_id else None
    ves = s.query(Vessel).filter_by(id=rfq.vessel_id).first() if rfq.vessel_id else None
    received = (getattr(rfq, "received_at", None) or rfq.date or "")[:10]
    return drive_svc.project_folder_name(received, customer_label(cust),
                                         ves.name if ves else "", rfq.project_title or "")


def _free_folder_name(s, rfq: RFQ, wt: str, base: str | None = None) -> tuple[str, str | None]:
    """(이 RFQ 가 쓸 폴더 이름, 이어 쓸 기존 폴더 ID|None).

    같은 이름 폴더가 이미 **다른 프로젝트에 연결돼** 있으면 ' (2)' 를 붙인다 — 같은 날 같은
    고객·선박에 제목이 빈 딜 둘이 한 폴더를 나눠 쓰지 않게. 연결 안 된 같은 이름 폴더
    (사람이 먼저 만들어 둔 것)는 그대로 이어 쓴다."""
    base = drive_svc.sanitize_name(base or "") or folder_name(s, rfq)
    root = drive_svc.root_id(wt)
    for n in range(1, 50):
        nm = base if n == 1 else f"{base} ({n})"
        found = drive_svc._children(root, name=drive_svc.sanitize_name(nm), folders_only=True)
        if not found:
            return nm, None
        ids = sorted(f["id"] for f in found)
        taken = {fid for (fid,) in s.query(RFQ.drive_folder_id)
                 .filter(RFQ.drive_folder_id.in_(ids), RFQ.id != rfq.id).all()}
        free = next((i for i in ids if i not in taken), None)
        if free:
            return nm, free
    raise drive_svc.DriveError(f"폴더 이름을 정하지 못했습니다: {base}")


def status(rfq: RFQ) -> dict:
    """화면용: 연동이 켜져 있는가, 폴더가 연결돼 있는가."""
    return {
        "enabled": drive_svc.enabled(work_type_key(rfq)),
        "folder_id": getattr(rfq, "drive_folder_id", None) or "",
        "folder_url": getattr(rfq, "drive_folder_url", None) or "",
    }


NO_FOLDER = "이 프로젝트에는 아직 드라이브 폴더가 없습니다 — 📁 Create folder 로 먼저 만드세요."

ALL_SUBS = tuple(drive_svc.SUBFOLDERS.keys())          # ("RFQ", "QTN", "PO", "INV")


def preview_rfq_folder(rfq_id: int) -> dict:
    """"폴더 만들기" 확인 창용 — 무엇이 만들어질지 미리 보여 준다(드라이브에 쓰지 않는다).

    reuse_existing: 루트에 같은 이름의 (어느 딜에도 안 걸린) 폴더가 이미 있어 새로 만들지
    않고 그것을 잇게 되는 경우."""
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if rfq is None:
            raise drive_svc.DriveError(f"RFQ {rfq_id} 가 없습니다.")
        wt = work_type_key(rfq)
        if not drive_svc.enabled(wt):
            raise drive_svc.DriveError("드라이브 연동이 설정되지 않았습니다.")
        linked = getattr(rfq, "drive_folder_id", None)
        if linked:
            meta = drive_svc.get_folder(linked)
            if meta:
                return {"linked": True, "name": meta.get("name", ""), "root": wt,
                        "reuse_existing": True, "folder_url": drive_svc.folder_url(linked),
                        "subfolders": [{"key": k, "name": drive_svc.SUBFOLDERS[k][0]} for k in ALL_SUBS]}
        name, free_id = _free_folder_name(s, rfq, wt)
        return {"linked": False, "name": name, "root": wt, "reuse_existing": bool(free_id),
                "folder_url": drive_svc.folder_url(free_id) if free_id else "",
                "subfolders": [{"key": k, "name": drive_svc.SUBFOLDERS[k][0]} for k in ALL_SUBS]}
    finally:
        s.close()


def ensure_rfq_folder(rfq_id: int, *, create: bool = False, subs=ALL_SUBS,
                      name: str | None = None) -> dict:
    """RFQ 의 프로젝트 폴더와 하위 폴더 `subs` 를 갖추고 링크를 적는다. 멱등.

    create=False(기본): 프로젝트 폴더가 연결돼 있지 않으면 만들지 않고 DriveError(NO_FOLDER).
    폴더는 사람이 "Create folder" 로 확인하고 만들 때만 생긴다(2026-11-17 사용자 요청).
    이미 연결된 폴더가 살아 있으면 그것을 쓴다(이름이 바뀌었어도).
    반환에 이번에 **새로 만든** 것들(created)을 담는다 — 화면이 그대로 보여 준다.
    """
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if rfq is None:
            raise drive_svc.DriveError(f"RFQ {rfq_id} 가 없습니다.")
        wt = work_type_key(rfq)
        if not drive_svc.enabled(wt):
            raise drive_svc.DriveError("드라이브 연동이 설정되지 않았습니다.")
        created: list[str] = []
        linked = getattr(rfq, "drive_folder_id", None)
        meta = drive_svc.get_folder(linked) if linked else None
        if meta:
            fid, fname = linked, meta.get("name", "")
        elif not create:
            raise drive_svc.DriveError(NO_FOLDER)
        else:
            root = drive_svc.root_id(wt)
            fname, free_id = _free_folder_name(s, rfq, wt, name)
            if free_id:
                fid = free_id
            else:
                fid, made = drive_svc.ensure_folder_report(root, fname)
                if made:
                    created.append(drive_svc.sanitize_name(fname))
        sub, made_subs = drive_svc.ensure_subfolders_report(fid, subs) if subs else ({}, [])
        prefix = drive_svc.sanitize_name(fname)
        created += [f"{prefix}/{n}" for n in made_subs]
        if rfq.drive_folder_id != fid:
            rfq.drive_folder_id = fid
            rfq.drive_folder_url = drive_svc.folder_url(fid)
            s.commit()
        if created:
            log.info("project_drive: RFQ %s — 생성 %s", rfq_id, created)
        return {"folder_id": fid, "folder_url": drive_svc.folder_url(fid), "folder_name": fname,
                "sub": sub, "created": created}
    finally:
        s.close()


MAX_UPLOAD = 50 * 1024 * 1024     # 이보다 큰 파일은 건너뛰고 경고만 남긴다


def intake_markdown(s, rfq: RFQ, text: str, by: str, at: str) -> str:
    """메신저로 받은 접수 대화를 남기는 글. 메신저 대화는 다른 곳에 기록이 남지 않는다."""
    cust = s.query(Customer).filter_by(id=rfq.customer_id).first() if rfq.customer_id else None
    ves = s.query(Vessel).filter_by(id=rfq.vessel_id).first() if rfq.vessel_id else None
    head = [
        "# 접수 내용",
        "",
        f"- 프로젝트: {rfq.rfq_no} · {rfq.project_title or '-'}",
        f"- 고객: {(cust.name if cust else '-')}{(' · ' + rfq.contact_person) if rfq.contact_person else ''}",
        f"- 선박: {ves.name if ves else '-'}",
        f"- 접수 채널: {rfq.request_channel or '-'}",
        f"- 접수 일시: {(rfq.received_at or rfq.date or '-').replace('T', ' ')}",
        f"- 기록: {at} · {by or '-'}",
        "",
        "---",
        "",
    ]
    return "\n".join(head) + text.strip() + "\n"


def save_intake(rfq_id: int, files: list, text: str = "", *, by: str = "", at: str = "",
                text_name: str = "00 접수내용.md", raw_text: bool = False,
                create_folder: bool = False) -> dict:
    """접수 첨부를 `01 RFQ` 에 올린다. 파일명은 원본 그대로, 같은 이름이면 ' (2)'.

    files: [(파일명, 읽기 가능한 파일 객체, 크기, mime)]. 50MB 초과는 건너뛰고, 한 파일이
    실패해도 나머지는 계속 올린다(부분 실패 허용).
    프로젝트 폴더가 없으면: create_folder=True(사람이 "폴더 만들고 올리기"를 고름)일 때만
    폴더 + `01 RFQ` 하나를 만들고, 아니면 DriveError(NO_FOLDER). 만든 것은 created 로 돌려준다.
    """
    folder = ensure_rfq_folder(rfq_id, create=create_folder, subs=("RFQ",))
    rfq_dir = folder["sub"]["RFQ"]
    saved, skipped, failed = [], [], []
    for name, stream, size, mime in files:
        name = name or "file"
        if size is not None and size > MAX_UPLOAD:
            skipped.append({"name": name, "reason": f"{size / 1024 / 1024:.0f}MB — 50MB 초과"})
            continue
        try:
            up = drive_svc.upload_file(rfq_dir, name, stream, mime or "application/octet-stream")
            saved.append({"name": up["name"], "url": up["url"]})
        except drive_svc.DriveError as exc:
            log.warning("project_drive: %s 업로드 실패 — %s", name, exc)
            failed.append({"name": name, "reason": str(exc)[:200]})
    if (text or "").strip():
        if raw_text:
            body = text          # 머리글을 이미 갖춘 글(메일 본문 등)은 그대로
        else:
            s = get_session()
            try:
                rfq = s.query(RFQ).filter_by(id=rfq_id).first()
                body = intake_markdown(s, rfq, text, by, at)
            finally:
                s.close()
        try:
            up = drive_svc.upload_text(rfq_dir, text_name, body)
            saved.append({"name": up["name"], "url": up["url"]})
        except drive_svc.DriveError as exc:
            failed.append({"name": text_name, "reason": str(exc)[:200]})
    return {"folder_url": folder["folder_url"], "rfq_folder_url": drive_svc.folder_url(rfq_dir),
            "created": folder["created"], "saved": saved, "skipped": skipped, "failed": failed}


# ── 발행 문서 보관(다운로드할 때 함께) ─────────────────────────────────────────

# 문서 종류 → 하위 폴더. 고객에게 나가는 문서만 둔다(홈택스 업로드용 xlsx 등 내부 자료 제외).
DOC_FOLDER = {
    "quotation": "QTN",
    "vendor_po": "PO",
    "pi": "INV", "ci": "INV", "pl": "INV", "sa": "INV", "sm": "INV",
    "tax_invoice": "INV", "credit_note": "INV",
}


def _vendor_rfq_of(s, vq_id: int):
    from db.models import VendorQuote, VendorRFQ
    q = s.query(VendorQuote).filter_by(id=vq_id).first()
    return s.query(VendorRFQ).filter_by(id=q.vendor_rfq_id).first() if q else None


def rfq_id_for(s, ref: str) -> int | None:
    """'qtn:12' · 'order:5' · 'rfq:9' · 'vpo:3' · 'cn:4' → 그 문서가 속한 프로젝트(RFQ) id."""
    from db.models import Claim, CreditNote, Order, PurchaseOrder, Quotation
    from _core import _rfq_for_order
    kind, _, raw = (ref or "").partition(":")
    try:
        key = int(raw)
    except ValueError:
        return None

    def by_order(oid):
        o = s.query(Order).filter_by(id=oid).first() if oid else None
        r = _rfq_for_order(s, o) if o else None
        return r.id if r else None

    if kind == "rfq":
        return key if s.query(RFQ.id).filter_by(id=key).first() else None
    if kind == "qtn":
        q = s.query(Quotation).filter_by(id=key).first()
        return q.rfq_id if q else None
    if kind == "vq":
        v = _vendor_rfq_of(s, key)
        return v.rfq_id if v else None
    if kind == "order":
        return by_order(key)
    if kind == "vpo":
        po = s.query(PurchaseOrder).filter_by(id=key).first()
        return by_order(po.order_id) if po else None
    if kind == "cn":
        cn = s.query(CreditNote).filter_by(id=key).first()
        if not cn:
            return None
        cl = s.query(Claim).filter_by(id=cn.claim_id).first() if cn.claim_id else None
        return (cl.rfq_id if cl and cl.rfq_id else None) or by_order(cn.order_id)
    return None


_PDF_VOLATILE = re.compile(rb"/(CreationDate|ModDate)\s*\(D:[^)]*\)|/ID\s*\[\s*<[0-9a-fA-F]*>\s*<[0-9a-fA-F]*>\s*\]")


def fingerprint(data: bytes, filename: str) -> str:
    """같은 문서를 다시 받았는지 가리는 지문 — 만든 시각(PDF 날짜·ID, xlsx 속성)을 빼고 잰다.

    PDF·xlsx 는 같은 내용이라도 만들 때마다 시각이 박혀 바이트가 달라진다. 그대로 비교하면
    "다운로드할 때마다 (2)·(3)…"이 쌓인다."""
    h = hashlib.sha256()
    low = (filename or "").lower()
    if data[:5] == b"%PDF-":
        h.update(_PDF_VOLATILE.sub(b"", data))
    elif low.endswith((".xlsx", ".xlsm", ".docx")) and data[:2] == b"PK":
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                for n in sorted(z.namelist()):
                    if n == "docProps/core.xml":
                        continue
                    h.update(n.encode())
                    h.update(z.read(n))
        except zipfile.BadZipFile:
            h.update(data)
    else:
        h.update(data)
    return h.hexdigest()[:40]


def archive_doc(ref: str, doc: str, filename: str, data: bytes, mime: str) -> dict:
    """발행 문서 한 벌을 프로젝트 폴더의 해당 하위 폴더에 남긴다.

    덮어쓰지 않는다 — 내용이 바뀐 재발행은 ' (2)' 로 새로 남고, 내용이 같으면(다시 받기만
    한 것) 건너뛴다. 반환: {"status": "saved"|"same"|"no_project", "name", "url"}."""
    key = DOC_FOLDER.get(doc)
    if key is None:
        raise drive_svc.DriveError(f"보관하지 않는 문서 종류: {doc}")
    s = get_session()
    try:
        rfq_id = rfq_id_for(s, ref)
    finally:
        s.close()
    if not rfq_id:
        return {"status": "no_project", "name": filename, "url": ""}
    try:
        folder = ensure_rfq_folder(rfq_id, subs=(key,))      # 폴더를 새로 만들지는 않는다
    except drive_svc.DriveError as exc:
        if str(exc) == NO_FOLDER:
            return {"status": "no_folder", "name": filename, "url": ""}
        raise
    target = folder["sub"][key]
    fp =fingerprint(data, filename)
    up = drive_svc.upload_file(target, filename, data, mime or "application/octet-stream",
                               app_properties={"ktms_fp": fp, "ktms_doc": doc},
                               skip_if_prop="ktms_fp")
    return {"status": "same" if up["skipped"] else "saved", "name": up["name"], "url": up["url"],
            "folder": key, "created": folder["created"]}


# ── 견적을 저장할 때 02 QTN 에 남기기(사람이 창에서 확인하고 누른 것만) ──────────

QTN_KEY = "QTN"
MAX_DEPTH = 2          # 02 QTN 아래로 상대 이름 / (선택) 하위 폴더 하나까지


def _loose(name: str) -> str:
    """폴더 이름 견주기 — 대소문자·기호·법인 표기 차이는 같은 회사로 본다."""
    t = re.sub(r"[^0-9a-z가-힣]+", " ", (name or "").lower())
    t = re.sub(r"\b(co|ltd|limited|inc|corp|corporation|company|pte|pty|gmbh|llc)\b|주식회사", " ", t)
    return " ".join(t.split())


def _party_names(s, ref: str, rfq: RFQ) -> list[str]:
    """02 QTN 아래 폴더 이름 후보 — 받은 견적은 공급사명, 보낸 견적은 고객사명(약칭 먼저)."""
    from db.models import Vendor
    kind, _, raw = (ref or "").partition(":")
    if kind == "vq":
        v = _vendor_rfq_of(s, int(raw)) if raw.isdigit() else None
        ven = s.query(Vendor).filter_by(id=v.vendor_id).first() if v and v.vendor_id else None
        return [ven.name.strip()] if ven and (ven.name or "").strip() else []
    cust = s.query(Customer).filter_by(id=rfq.customer_id).first() if rfq.customer_id else None
    return [n for n in dict.fromkeys([customer_label(cust), (cust.name or "").strip() if cust else ""]) if n]


def save_target(rfq_id: int, ref: str) -> dict:
    """저장 창용 — 어디에 저장되는지 미리 보여 준다(드라이브에 쓰지 않는다).

    party: 기본 폴더 이름. 02 QTN 에 같은 회사로 보이는 폴더가 이미 있으면 그 이름을 쓴다."""
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if rfq is None:
            raise drive_svc.DriveError(f"RFQ {rfq_id} 가 없습니다.")
        if rfq_id_for(s, ref) != rfq_id:
            raise drive_svc.DriveError("이 견적은 그 프로젝트의 것이 아닙니다.")
        fid, names = getattr(rfq, "drive_folder_id", None), _party_names(s, ref, rfq)
    finally:
        s.close()
    meta = drive_svc.get_folder(fid) if fid else None
    if not meta:
        raise drive_svc.DriveError(NO_FOLDER)
    sub = drive_svc.find_subfolder(fid, QTN_KEY)
    existing = sorted((f["name"] for f in drive_svc._children(sub["id"], folders_only=True)),
                      key=str.lower) if sub else []
    keys = {_loose(n) for n in names} - {""}
    hit = next((n for n in existing if _loose(n) in keys), None)
    return {"project": meta.get("name", ""), "sub": sub["name"] if sub else drive_svc.SUBFOLDERS[QTN_KEY][0],
            "existing": existing, "party": hit or (drive_svc.sanitize_name(names[0]) if names else "")}


def save_quote_files(rfq_id: int, folders: list[str], files: list) -> dict:
    """견적 파일들을 `02 QTN/[폴더]/[폴더]` 에 올린다. 없는 폴더만 만든다.

    files: [(파일명, 읽기 가능한 파일 객체, 크기, mime)]. 덮어쓰지 않는다 — 같은 이름에
    내용이 바뀌었으면 ' (2)', 같으면 건너뛰고 same 으로 알린다. 부분 실패를 허용한다."""
    names = [n for n in (drive_svc.sanitize_name(f) for f in folders) if n]
    if len(names) > MAX_DEPTH:
        raise drive_svc.DriveError("하위 폴더는 두 단계까지만 만들 수 있습니다.")
    base = ensure_rfq_folder(rfq_id, subs=(QTN_KEY,))        # 프로젝트 폴더는 새로 만들지 않는다
    created = list(base["created"])
    target = base["sub"][QTN_KEY]
    sub = drive_svc.find_subfolder(base["folder_id"], QTN_KEY)
    path = [base["folder_name"], sub["name"] if sub else drive_svc.SUBFOLDERS[QTN_KEY][0]]
    for n in names:
        target, made = drive_svc.ensure_folder_report(target, n)
        path.append(n)
        if made:
            created.append("/".join(path[1:]))
    saved, skipped, failed = [], [], []
    for name, stream, size, mime in files:
        name = name or "file"
        if size is not None and size > MAX_UPLOAD:
            skipped.append({"name": name, "reason": f"{size / 1024 / 1024:.0f}MB — 50MB 초과"})
            continue
        try:
            data = stream.read()
            up = drive_svc.upload_file(target, name, data, mime or "application/octet-stream",
                                       app_properties={"ktms_fp": fingerprint(data, name)},
                                       skip_if_prop="ktms_fp")
            saved.append({"name": up["name"], "url": up["url"], "same": up["skipped"]})
        except drive_svc.DriveError as exc:
            log.warning("project_drive: %s 업로드 실패 — %s", name, exc)
            failed.append({"name": name, "reason": str(exc)[:200]})
    return {"folder_url": drive_svc.folder_url(target), "path": " / ".join(path),
            "created": created, "saved": saved, "skipped": skipped, "failed": failed}
