"""KTMS 프로젝트(RFQ) ↔ 공유 드라이브 폴더 잇기.

drive_svc 는 드라이브만 알고, 이 모듈은 KTMS 레코드를 안다 — 폴더 이름을 RFQ·고객사·
선박에서 만들고, 만든 폴더의 ID 를 RFQ 에 적는다.

드라이브 실패가 프로젝트 등록을 막지 않는다. 등록 응답이 나간 뒤(백그라운드) 폴더를
만들고, 실패하면 drive_folder_id 가 빈 채로 남아 화면이 "폴더 만들기"를 띄운다.
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


def _free_folder_name(s, rfq: RFQ, wt: str) -> tuple[str, str | None]:
    """(이 RFQ 가 쓸 폴더 이름, 이어 쓸 기존 폴더 ID|None).

    같은 이름 폴더가 이미 **다른 프로젝트에 연결돼** 있으면 ' (2)' 를 붙인다 — 같은 날 같은
    고객·선박에 제목이 빈 딜 둘이 한 폴더를 나눠 쓰지 않게. 연결 안 된 같은 이름 폴더
    (사람이 먼저 만들어 둔 것)는 그대로 이어 쓴다."""
    base = folder_name(s, rfq)
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


def ensure_rfq_folder(rfq_id: int) -> dict:
    """RFQ 의 프로젝트 폴더(+01~04 하위 폴더)를 갖추고 링크를 적는다. 멱등.

    이미 연결된 폴더가 살아 있으면 그것을 쓰고(이름이 바뀌었어도), 없으면 루트에서
    같은 이름을 찾거나 새로 만든다. 실패는 DriveError 로 올라간다.
    """
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if rfq is None:
            raise drive_svc.DriveError(f"RFQ {rfq_id} 가 없습니다.")
        wt = work_type_key(rfq)
        if not drive_svc.enabled(wt):
            raise drive_svc.DriveError("드라이브 연동이 설정되지 않았습니다.")
        linked = getattr(rfq, "drive_folder_id", None)
        if linked and drive_svc.get_folder(linked):
            out = drive_svc.ensure_project("", work_type=wt, folder_id=linked)
        else:
            name, free_id = _free_folder_name(s, rfq, wt)
            out = drive_svc.ensure_project(name, work_type=wt, folder_id=free_id)
        if rfq.drive_folder_id != out["folder_id"]:
            rfq.drive_folder_id = out["folder_id"]
            rfq.drive_folder_url = out["folder_url"]
            s.commit()
        return out
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


def save_intake(rfq_id: int, files: list, text: str = "", *, by: str = "", at: str = "") -> dict:
    """접수 첨부를 `01 RFQ` 에 올린다. 파일명은 원본 그대로, 같은 이름이면 ' (2)'.

    files: [(파일명, 읽기 가능한 파일 객체, 크기, mime)]. 50MB 초과는 건너뛰고, 한 파일이
    실패해도 나머지는 계속 올린다(부분 실패 허용). 폴더를 못 만들면 DriveError.
    """
    folder = ensure_rfq_folder(rfq_id)
    rfq_dir = drive_svc.subfolder_id(folder["folder_id"], "RFQ")
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
        s = get_session()
        try:
            rfq = s.query(RFQ).filter_by(id=rfq_id).first()
            body = intake_markdown(s, rfq, text, by, at)
        finally:
            s.close()
        try:
            up = drive_svc.upload_text(rfq_dir, "00 접수내용.md", body)
            saved.append({"name": up["name"], "url": up["url"]})
        except drive_svc.DriveError as exc:
            failed.append({"name": "00 접수내용.md", "reason": str(exc)[:200]})
    return {"folder_url": folder["folder_url"], "rfq_folder_url": drive_svc.folder_url(rfq_dir),
            "saved": saved, "skipped": skipped, "failed": failed}


# ── 발행 문서 보관(다운로드할 때 함께) ─────────────────────────────────────────

# 문서 종류 → 하위 폴더. 고객에게 나가는 문서만 둔다(홈택스 업로드용 xlsx 등 내부 자료 제외).
DOC_FOLDER = {
    "quotation": "QTN",
    "vendor_po": "PO",
    "pi": "INV", "ci": "INV", "pl": "INV", "sa": "INV", "sm": "INV",
    "tax_invoice": "INV", "credit_note": "INV",
}


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
    folder = ensure_rfq_folder(rfq_id)
    target = drive_svc.subfolder_id(folder["folder_id"], key)
    fp = fingerprint(data, filename)
    up = drive_svc.upload_file(target, filename, data, mime or "application/octet-stream",
                               app_properties={"ktms_fp": fp, "ktms_doc": doc},
                               skip_if_prop="ktms_fp")
    return {"status": "same" if up["skipped"] else "saved", "name": up["name"], "url": up["url"],
            "folder": key}


def ensure_rfq_folder_quietly(rfq_id: int) -> None:
    """등록 직후 백그라운드로 부른다 — 연동이 꺼져 있으면 아무것도 안 하고, 실패는 로그만."""
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if rfq is None or not drive_svc.enabled(work_type_key(rfq)):
            return
    finally:
        s.close()
    drive_svc.try_call(ensure_rfq_folder, rfq_id)
