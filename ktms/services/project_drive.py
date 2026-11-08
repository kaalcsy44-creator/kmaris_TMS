"""KTMS 프로젝트(RFQ) ↔ 공유 드라이브 폴더 잇기.

drive_svc 는 드라이브만 알고, 이 모듈은 KTMS 레코드를 안다 — 폴더 이름을 RFQ·고객사·
선박에서 만들고, 만든 폴더의 ID 를 RFQ 에 적는다.

드라이브 실패가 프로젝트 등록을 막지 않는다. 등록 응답이 나간 뒤(백그라운드) 폴더를
만들고, 실패하면 drive_folder_id 가 빈 채로 남아 화면이 "폴더 만들기"를 띄운다.
"""
from __future__ import annotations

import logging

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
