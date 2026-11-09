"""K-Maris TMS — RFQ 후보 함: 받은 메일에서 찾은 새 RFQ 를 사람이 승인해 프로젝트로 세운다.

판정은 services/rfq_detect.py 가 매일 아침 메일 일과 끝에 한다(여기서 수동으로도 돌린다).
승인 한 번에: 고객·선박(없으면 새로) → KTMS 프로젝트 등록 → 드라이브 폴더 → 메일함에서
원본을 다시 받아 첨부와 메일 본문을 `01 RFQ` 에 저장 → 그 메일(과 같은 대화)을 새 딜에 붙임.
자동 승인은 없다.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import BackgroundTasks
from pydantic import BaseModel

from _core import (
    Customer,
    Depends,
    EmailMessage,
    HTTPException,
    RFQ,
    RfqCreate,
    Vessel,
    _rfq_no_disp,
    app,
    get_current_user,
    get_session,
    require_token,
)
from db.models import RfqCandidate
from routers.rfq import create_rfq
from services import drive_svc, mail_sync, project_drive, rfq_detect


def _row(s, c: RfqCandidate, m: EmailMessage) -> dict:
    cust = s.query(Customer).filter_by(id=c.customer_id).first() if c.customer_id else None
    ves = s.query(Vessel).filter_by(id=c.vessel_id).first() if c.vessel_id else None
    rfq = s.query(RFQ).filter_by(id=c.rfq_id).first() if c.rfq_id else None
    preview = (m.summary or "").strip() or " ".join((m.body_text or "").split())[:400]
    return {
        "id": c.id, "email_id": m.id, "status": c.status,
        "confidence": round(c.confidence or 0, 2), "reason": c.reason or "",
        "subject": m.subject or "", "from_name": m.from_name or "", "from_addr": m.from_addr or "",
        "sent_at": m.sent_at or "", "account": m.received_account or "",
        "attachments": [a.get("name", "") for a in (m.attachments or [])][:20],
        "preview": preview, "body": (m.body_text or "")[:6000],
        "customer_id": c.customer_id or 0,
        "customer_name": cust.name if cust else "",
        "customer_contact": (cust.contact or "") if cust else "",
        "customer_short": (getattr(cust, "short_name", None) or "") if cust else "",
        "customer_guess": c.customer_guess or "",
        "vessel_id": c.vessel_id or 0, "vessel": (ves.name if ves else (c.vessel or "")),
        "item_title": c.item_title or "", "work_type": c.work_type or "PARTS",
        "folder_name": c.folder_name or "",
        "rfq_id": c.rfq_id or 0, "rfq_no": _rfq_no_disp(rfq.rfq_no) if rfq else "",
        "folder_url": (rfq.drive_folder_url or "") if rfq else "",
    }


@app.get("/api/admin/rfq-candidates", dependencies=[Depends(require_token)])
def list_rfq_candidates(status: str = "pending"):
    """후보 목록. pending 은 RFQ 로 판정됐고(신뢰도 기준 이상) 아직 아무 딜에도 붙지 않은
    메일만 — 그사이 사람이 손으로 등록해 메일이 딜에 붙었으면 목록에서 저절로 빠진다."""
    s = get_session()
    try:
        q = (s.query(RfqCandidate, EmailMessage)
             .join(EmailMessage, EmailMessage.id == RfqCandidate.email_id)
             .filter(RfqCandidate.is_rfq.is_(True), RfqCandidate.confidence >= rfq_detect.THRESHOLD))
        if status == "pending":
            q = q.filter(RfqCandidate.status == "pending", EmailMessage.rfq_id.is_(None))
        elif status in ("approved", "rejected"):
            q = q.filter(RfqCandidate.status == status)
        rows = q.order_by(EmailMessage.sent_at.desc()).limit(200).all()
        return {"rows": [_row(s, c, m) for c, m in rows]}
    finally:
        s.close()


@app.post("/api/admin/rfq-candidates/run", dependencies=[Depends(require_token)])
def run_rfq_detection(days: int = 14, limit: int = 30):
    """지금 판정 — 매일 아침 일과를 기다리지 않고 최근 메일을 판정한다."""
    since = (datetime.now(mail_sync.KST) - timedelta(days=max(1, min(days, 60)))).strftime("%Y-%m-%d")
    s = get_session()
    try:
        return rfq_detect.run(s, since=since, limit=max(1, min(limit, 60)))
    finally:
        s.close()


@app.post("/api/admin/rfq-candidates/{cand_id}/reject", dependencies=[Depends(require_token)])
def reject_rfq_candidate(cand_id: int, user: dict = Depends(get_current_user)):
    s = get_session()
    try:
        c = s.query(RfqCandidate).filter_by(id=cand_id).first()
        if not c:
            raise HTTPException(status_code=404, detail="후보를 찾을 수 없습니다.")
        if c.status == "approved":
            raise HTTPException(status_code=400, detail="이미 승인한 후보입니다.")
        c.status, c.decided_by, c.decided_at = "rejected", user.get("id") or None, datetime.utcnow()
        s.commit()
        return {"ok": True}
    finally:
        s.close()


class NewCustomerIn(BaseModel):
    name: str
    contact: str = ""
    email: str = ""
    short_name: str = ""


class ApproveIn(BaseModel):
    customer_id: int = 0                    # 고객 담당자 레코드(없으면 new_customer)
    new_customer: NewCustomerIn | None = None
    vessel_id: int = 0                      # 0 + vessel_name → 새 선박, 둘 다 없으면 선박 없음
    vessel_name: str = ""
    project_title: str = ""
    work_type: str = "PARTS"                # PARTS | SERVICE
    customer_rfq_no: str = ""


def _mail_head(m: EmailMessage) -> str:
    """`00 메일본문.md` 의 머리 — 제목·보낸이·받는이·일시·사서함·첨부 목록."""
    return "\n".join([
        f"# {m.subject or '(no subject)'}",
        "",
        f"- From: {m.from_name or ''} <{m.from_addr or ''}>",
        f"- To: {', '.join(m.to_addrs or [])}",
        *([f"- Cc: {', '.join(m.cc_addrs or [])}"] if m.cc_addrs else []),
        f"- Date: {(m.sent_at or '').replace('T', ' ')} (KST)",
        f"- Mailbox: {m.received_account or '-'}",
        *([f"- Attachments: {', '.join(a.get('name', '') for a in m.attachments)}"]
          if m.attachments else []),
        "",
        "---",
        "",
        "",
    ])


@app.post("/api/admin/rfq-candidates/{cand_id}/approve", dependencies=[Depends(require_token)])
def approve_rfq_candidate(cand_id: int, body: ApproveIn, background: BackgroundTasks,
                          user: dict = Depends(get_current_user)):
    """승인 — 프로젝트 등록 + 드라이브 폴더 + 첨부·메일 본문 `01 RFQ` + 메일을 새 딜에 붙임.

    프로젝트가 서면 승인은 끝난 것이다. 드라이브(메일 원본 받기·업로드)가 실패해도 되돌리지
    않고 결과에 사유만 싣는다 — 첨부는 프로젝트 화면의 Drive files 로 다시 올릴 수 있다."""
    s = get_session()
    try:
        c = s.query(RfqCandidate).filter_by(id=cand_id).first()
        if not c:
            raise HTTPException(status_code=404, detail="후보를 찾을 수 없습니다.")
        if c.status != "pending":
            raise HTTPException(status_code=400, detail="이미 처리한 후보입니다.")
        m = s.query(EmailMessage).filter_by(id=c.email_id).first()
        if m.rfq_id:
            raise HTTPException(status_code=400, detail="이 메일은 이미 다른 딜에 붙어 있습니다.")

        # 고객 — 고른 담당자, 없으면 새로(회사·담당자·메일). 약칭은 같은 회사의 것을 물려받는다.
        cust_id = body.customer_id
        if not cust_id:
            nc = body.new_customer
            if not nc or not nc.name.strip():
                raise HTTPException(status_code=400, detail="고객사를 고르거나 새로 입력하세요.")
            mates = [x for x in s.query(Customer).all()
                     if (x.name or "").strip().lower() == nc.name.strip().lower()]
            email = (nc.email or m.from_addr or "").strip()
            cu = Customer(name=nc.name.strip(), contact=nc.contact.strip(), email=email,
                          emails=[email] if email else [],
                          short_name=(nc.short_name.strip()
                                      or next((x.short_name for x in mates if x.short_name), None)
                                      or None))
            s.add(cu)
            s.flush()
            cust_id = cu.id
        elif not s.query(Customer.id).filter_by(id=cust_id).first():
            raise HTTPException(status_code=400, detail="고객 담당자를 찾을 수 없습니다.")
        cust = s.query(Customer).filter_by(id=cust_id).first()

        ves_id = body.vessel_id or None
        if not ves_id and body.vessel_name.strip():
            name = body.vessel_name.strip()
            same = [v for v in s.query(Vessel).all() if (v.name or "").strip().lower() == name.lower()]
            if same:
                ves_id = same[-1].id
            else:
                v = Vessel(name=name, customer_id=cust_id)
                s.add(v)
                s.flush()
                ves_id = v.id
        # 커밋하면 객체 값이 만료된다 — 아래에서 쓸 값을 미리 떠 둔다.
        contact = (cust.contact or "") if cust else ""
        mail = {"id": m.id, "message_id": m.message_id, "account": m.received_account or "",
                "sent_at": m.sent_at or "", "subject": m.subject or "",
                "thread": m.thread_key or m.message_id, "head": _mail_head(m),
                "body": (m.body_text or "").strip()}
        s.commit()
    finally:
        s.close()

    # 프로젝트 등록은 1단계 화면과 같은 길로 — 번호 채번·메일 묶음·폴더 생성 훅이 그대로 돈다.
    created = create_rfq(RfqCreate(
        customer_id=cust_id, vessel_id=ves_id,
        customer_rfq_no=body.customer_rfq_no or "",
        contact_person=contact,
        received_at=mail["sent_at"][:16] or None,
        project_title=body.project_title.strip(),
        work_type="서비스" if body.work_type == "SERVICE" else "부품공급",
        request_channel="Email",
        notes=f"From mail: {mail['subject']}"[:500],
    ), background, user)
    rfq_id = created["id"]

    s = get_session()
    try:
        c = s.query(RfqCandidate).filter_by(id=cand_id).first()
        c.status, c.rfq_id = "approved", rfq_id
        c.decided_by, c.decided_at = user.get("id") or None, datetime.utcnow()
        # 근거 메일과 같은 대화의 아직 안 붙은 메일을 새 딜로 — 이후 회신은 스레드로 따라온다.
        for x in s.query(EmailMessage).filter(EmailMessage.rfq_id.is_(None),
                                              EmailMessage.thread_key == mail["thread"]).all():
            x.rfq_id, x.match_by, x.not_deal = rfq_id, "manual", False
            if x.direction == "in" and not x.customer_id:
                x.customer_id = cust_id
        mm = s.query(EmailMessage).filter_by(id=mail["id"]).first()
        if mm.rfq_id is None:
            mm.rfq_id, mm.match_by, mm.not_deal = rfq_id, "manual", False
        if not mm.customer_id:
            mm.customer_id = cust_id
        s.commit()
    finally:
        s.close()

    # 메일 원본을 다시 받아 첨부 + 본문을 01 RFQ 에. 실패해도 승인은 그대로.
    out = {"ok": True, "rfq_id": rfq_id, "rfq_no": created.get("rfq_no", ""),
           "folder_url": "", "saved": [], "skipped": [], "failed": [], "drive_error": ""}
    try:
        raw = mail_sync.fetch_raw_message(mail["message_id"], mail["account"])
        files, body_text = [], mail["body"]
        if raw:
            import email as _email
            import io
            msg = _email.message_from_bytes(raw)
            files = [(n, io.BytesIO(b), len(b), t) for n, b, t in mail_sync.attachment_files(msg)]
            body_text = mail_sync.body_and_attachments(msg)[0].strip() or body_text
        else:
            out["drive_error"] = "메일함에서 원본을 찾지 못해 첨부는 올리지 못했습니다(본문만 저장)."
        text = mail["head"] + body_text + "\n"
        res =project_drive.save_intake(rfq_id, files, text, text_name="00 메일본문.md", raw_text=True)
        out.update({k: res[k] for k in ("folder_url", "saved", "skipped", "failed")})
    except drive_svc.DriveError as exc:
        out["drive_error"] = f"드라이브: {exc}"[:300]
    except Exception as exc:
        out["drive_error"] = f"{type(exc).__name__}: {exc}"[:300]
    return out
