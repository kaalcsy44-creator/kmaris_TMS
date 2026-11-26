"""경비 청구(Expense claims) — 직원이 개인 돈(개인카드·현금)으로 쓴 업무 경비를 돌려받는 청구서.

  · 청구서 = 직원 1명 × 한 달 1장. 줄 = 사용 건(날짜·분류·내역·사용처·금액·부가세·영수증·프로젝트).
  · 법인카드 사용분은 넣지 않는다 — 카드 대금이 따로 나가므로 넣으면 두 번 센다.
  · 작성(draft) → 제출(submitted) → 승인(approved) / 반려(rejected).
    승인자 = Finance 편집 권한이 있는 사람. 본인 청구는 본인이 승인하지 못한다(admin 만 예외 —
    사용자가 한 명뿐인 동안 막히지 않게).
  · 승인하면 Outflow 에 지급 1건(분류 경비정산, 수취인 = 청구자)이 생긴다. 지급 처리는 그 줄에서.
    손익(finance_profit)은 그 지급을 청구서 줄로 풀어 분류별(경비:식대 …)·사용일 기준으로 싣는다.
  · 출장 보고서의 경비 시트에서 개인 결제분을 이 청구서로 넘길 수 있다(trip_key 로 중복 방지).
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta

from fastapi import Response
from pydantic import BaseModel

from _core import (
    Depends,
    File,
    FinancePayable,
    HTTPException,
    UploadFile,
    UserRole,
    _can,
    _ocr_image_media_type,
    _project_no_map,
    app,
    get_current_user,
    get_session,
    require_token,
)
from db.models import ExpenseClaim, ExpenseReceipt, ScheduleEvent

# 경비 분류 — 저장값(한글 코드)과 화면 표기. 손익의 운영비 줄은 "경비:<코드>" 로 선다.
EXPENSE_CATEGORIES = ["식대", "교통비", "주차·통행료", "숙박", "통신비", "사무용품", "접대비", "기타"]
PAYABLE_CATEGORY = "경비정산"
STATUSES = ("draft", "submitted", "approved", "rejected")


def _now() -> str:
    return (datetime.utcnow() + timedelta(hours=9)).strftime("%Y-%m-%dT%H:%M")


def _num(v) -> float:
    try:
        return round(float(str(v).replace(",", "")), 2) if v not in (None, "") else 0.0
    except (TypeError, ValueError):
        return 0.0


def _clean_line(x: dict) -> dict:
    cat = str(x.get("category") or "기타").strip()
    amount = _num(x.get("amount"))
    vat = min(max(_num(x.get("vat")), 0.0), amount)
    return {
        "id": str(x.get("id") or uuid.uuid4().hex[:10]),
        "date": str(x.get("date") or "")[:10],
        "category": cat if cat in EXPENSE_CATEGORIES else "기타",
        "detail": str(x.get("detail") or "").strip()[:200],
        "place": str(x.get("place") or "").strip()[:120],
        "amount": amount,
        "vat": vat,
        "rfq_id": int(x.get("rfq_id") or 0) or None,
        "receipt_id": int(x.get("receipt_id") or 0) or None,
        "trip_key": str(x.get("trip_key") or "")[:60],
        "trip_title": str(x.get("trip_title") or "")[:200],
        "note": str(x.get("note") or "").strip()[:300],
    }


def _total(c: ExpenseClaim) -> tuple[float, float]:
    lines = c.lines or []
    return (round(sum(_num(l.get("amount")) for l in lines), 2),
            round(sum(_num(l.get("vat")) for l in lines), 2))


def _mine(c: ExpenseClaim, user: dict) -> bool:
    """청구자 본인인가 — 저장된 user_id 가 비었으면(개발용 토큰 사용자 id 0) 0 으로 본다."""
    return (c.user_id or 0) == (user.get("id") or 0)


def _is_finance_editor(user: dict) -> bool:
    return _can(user.get("role", ""), "finance", "edit")


def _can_see(c: ExpenseClaim, user: dict) -> bool:
    return _mine(c, user) or _can(user.get("role", ""), "finance", "view")


def _can_approve(c: ExpenseClaim, user: dict) -> bool:
    if not _is_finance_editor(user):
        return False
    return not _mine(c, user) or user.get("role") == UserRole.ADMIN.value


def _out(s, c: ExpenseClaim, user: dict, pno: dict | None = None) -> dict:
    total, vat = _total(c)
    pay = s.query(FinancePayable).filter_by(id=c.payable_id).first() if c.payable_id else None
    pno = pno if pno is not None else _project_no_map(s)
    return {
        "id": c.id, "user_id": c.user_id or 0, "claimant": c.claimant or "", "month": c.month or "",
        "status": c.status or "draft", "note": c.note or "",
        "lines": [{**l, "project_no": pno.get(l.get("rfq_id") or 0, "")} for l in (c.lines or [])],
        "total": total, "vat": vat, "count": len(c.lines or []),
        "submitted_at": c.submitted_at or "", "approved_at": c.approved_at or "",
        "approver": c.approver or "", "reject_note": c.reject_note or "",
        "payable_id": c.payable_id or 0,
        "paid": bool(pay and pay.paid), "paid_date": (pay.paid_date or "") if pay else "",
        "due_date": (pay.due_date or "") if pay else "",
        # 화면이 버튼을 고르는 데 쓴다 — 서버도 같은 규칙으로 막는다.
        "mine": _mine(c, user),
        "can_edit": _mine(c, user) and (c.status or "draft") in ("draft", "rejected"),
        "can_approve": _can_approve(c, user),
    }


def _get(s, claim_id: int, user: dict) -> ExpenseClaim:
    c = s.query(ExpenseClaim).filter_by(id=claim_id).first()
    if not c or not _can_see(c, user):
        raise HTTPException(status_code=404, detail="Expense claim not found.")
    return c


@app.get("/api/admin/expenses", dependencies=[Depends(require_token)])
def list_expense_claims(scope: str = "mine", user: dict = Depends(get_current_user)):
    """scope=mine 은 내 청구서, all 은 전부(Finance 열람 권한)."""
    s = get_session()
    try:
        rows = s.query(ExpenseClaim).all()
        if scope != "all" or not _can(user.get("role", ""), "finance", "view"):
            rows = [c for c in rows if _mine(c, user)]
        pno = _project_no_map(s)
        rows = sorted(rows, key=lambda c: (c.month or "", c.id), reverse=True)
        return {"rows": [_out(s, c, user, pno) for c in rows], "categories": EXPENSE_CATEGORIES,
                "can_approve": _is_finance_editor(user)}
    finally:
        s.close()


class ClaimNewIn(BaseModel):
    month: str


@app.post("/api/admin/expenses", dependencies=[Depends(require_token)])
def create_expense_claim(body: ClaimNewIn, user: dict = Depends(get_current_user)):
    """내 청구서 한 장(그 달) — 아직 승인 전인 것이 있으면 그것을 돌려준다."""
    month = (body.month or "")[:7]
    if len(month) != 7:
        raise HTTPException(status_code=400, detail="Pick the month.")
    s = get_session()
    try:
        c = next((c for c in s.query(ExpenseClaim).filter(ExpenseClaim.month == month,
                                                           ExpenseClaim.status != "approved").all()
                  if _mine(c, user)), None)
        if c is None:
            c = ExpenseClaim(user_id=user.get("id") or None, claimant=user.get("username") or "",
                             month=month, status="draft", lines=[])
            s.add(c)
            s.commit()
        return _out(s, c, user)
    finally:
        s.close()


@app.get("/api/admin/expenses/{claim_id}", dependencies=[Depends(require_token)])
def get_expense_claim(claim_id: int, user: dict = Depends(get_current_user)):
    s = get_session()
    try:
        return _out(s, _get(s, claim_id, user), user)
    finally:
        s.close()


class ClaimSaveIn(BaseModel):
    lines: list[dict] = []
    note: str = ""
    claimant: str | None = None


def _drop_orphan_receipts(s, c: ExpenseClaim) -> None:
    used = {l.get("receipt_id") for l in (c.lines or []) if l.get("receipt_id")}
    for r in s.query(ExpenseReceipt.id).filter(ExpenseReceipt.claim_id == c.id).all():
        if r.id not in used:
            s.query(ExpenseReceipt).filter_by(id=r.id).delete()


@app.put("/api/admin/expenses/{claim_id}", dependencies=[Depends(require_token)])
def save_expense_claim(claim_id: int, body: ClaimSaveIn, user: dict = Depends(get_current_user)):
    s = get_session()
    try:
        c = _get(s, claim_id, user)
        if not _mine(c, user) or (c.status or "draft") not in ("draft", "rejected"):
            raise HTTPException(status_code=409, detail="Only your own draft or returned claim can be changed.")
        c.lines = sorted((_clean_line(x) for x in body.lines if isinstance(x, dict)),
                         key=lambda l: (l["date"], l["id"]))
        c.note = (body.note or "").strip()
        if body.claimant and body.claimant.strip():
            c.claimant = body.claimant.strip()[:120]
        _drop_orphan_receipts(s, c)
        s.commit()
        return _out(s, c, user)
    finally:
        s.close()


@app.delete("/api/admin/expenses/{claim_id}", dependencies=[Depends(require_token)])
def delete_expense_claim(claim_id: int, user: dict = Depends(get_current_user)):
    s = get_session()
    try:
        c = _get(s, claim_id, user)
        if (c.status or "draft") == "approved":
            raise HTTPException(status_code=409, detail="Reopen the approved claim first.")
        if not _mine(c, user) and user.get("role") != UserRole.ADMIN.value:
            raise HTTPException(status_code=403, detail="Only the claimant can delete it.")
        s.query(ExpenseReceipt).filter_by(claim_id=c.id).delete()
        s.delete(c)
        s.commit()
        return {"ok": True}
    finally:
        s.close()


@app.post("/api/admin/expenses/{claim_id}/submit", dependencies=[Depends(require_token)])
def submit_expense_claim(claim_id: int, user: dict = Depends(get_current_user)):
    s = get_session()
    try:
        c = _get(s, claim_id, user)
        if not _mine(c, user) or (c.status or "draft") not in ("draft", "rejected"):
            raise HTTPException(status_code=409, detail="This claim can't be submitted now.")
        total, _ = _total(c)
        if total <= 0:
            raise HTTPException(status_code=400, detail="Add at least one expense with an amount.")
        missing = [l for l in (c.lines or []) if not l.get("date")]
        if missing:
            raise HTTPException(status_code=400, detail="Every line needs a date.")
        c.status, c.submitted_at, c.reject_note = "submitted", _now(), ""
        s.commit()
        return _out(s, c, user)
    finally:
        s.close()


class ApproveIn(BaseModel):
    due_date: str = ""


@app.post("/api/admin/expenses/{claim_id}/approve", dependencies=[Depends(require_token)])
def approve_expense_claim(claim_id: int, body: ApproveIn, user: dict = Depends(get_current_user)):
    """승인 — Outflow 에 지급 1건(경비정산)을 만든다. 지급 처리는 그 줄에서 한다."""
    s = get_session()
    try:
        c = _get(s, claim_id, user)
        if (c.status or "") != "submitted":
            raise HTTPException(status_code=409, detail="Only a submitted claim can be approved.")
        if not _can_approve(c, user):
            raise HTTPException(status_code=403, detail="Someone with Finance edit rights (not the claimant) approves it.")
        total, vat = _total(c)
        today = date.today().isoformat()
        by_cat: dict[str, float] = {}
        for l in c.lines or []:
            by_cat[l.get("category") or "기타"] = by_cat.get(l.get("category") or "기타", 0) + _num(l.get("amount"))
        breakdown = " · ".join(f"{k} {v:,.0f}" for k, v in by_cat.items())
        p = FinancePayable(
            category=PAYABLE_CATEGORY, counterparty=c.claimant or "", description=f"경비 청구 {c.month}",
            amount=total, vat_amount=vat, currency="KRW", bill_date=today,
            due_date=(body.due_date or "")[:10] or today, recurrence="none", paid=False, paid_dates=[],
            notes=f"Expense claim #{c.id} · {len(c.lines or [])} line(s) · {breakdown}",
            owner_id=user.get("id") or None, expense_claim_id=c.id,
        )
        s.add(p)
        s.flush()
        # 직원 계좌도 지급처 명부에 한 번만 두게 잇는다(routers/payees.py).
        from routers.payees import sync_payee_from_payable
        sync_payee_from_payable(s, p)
        c.status, c.approved_at, c.approver, c.payable_id = "approved", _now(), user.get("username") or "", p.id
        s.commit()
        return _out(s, c, user)
    finally:
        s.close()


class RejectIn(BaseModel):
    note: str = ""


@app.post("/api/admin/expenses/{claim_id}/reject", dependencies=[Depends(require_token)])
def reject_expense_claim(claim_id: int, body: RejectIn, user: dict = Depends(get_current_user)):
    s = get_session()
    try:
        c = _get(s, claim_id, user)
        if (c.status or "") != "submitted" or not _can_approve(c, user):
            raise HTTPException(status_code=409, detail="Only a submitted claim can be returned, by the approver.")
        c.status, c.reject_note = "rejected", (body.note or "").strip()
        s.commit()
        return _out(s, c, user)
    finally:
        s.close()


@app.post("/api/admin/expenses/{claim_id}/reopen", dependencies=[Depends(require_token)])
def reopen_expense_claim(claim_id: int, user: dict = Depends(get_current_user)):
    """승인 취소 — 아직 지급하지 않았을 때만. 만든 지급을 지우고 제출 상태로 돌린다."""
    s = get_session()
    try:
        c = _get(s, claim_id, user)
        if (c.status or "") != "approved" or not _is_finance_editor(user):
            raise HTTPException(status_code=409, detail="Only an approved claim can be reopened, by Finance.")
        p = s.query(FinancePayable).filter_by(id=c.payable_id).first() if c.payable_id else None
        if p is not None and (p.paid or (p.paid_dates or [])):
            raise HTTPException(status_code=409, detail="Already paid — undo the payment in Outflow first.")
        if p is not None:
            s.delete(p)
        c.status, c.payable_id, c.approved_at, c.approver = "submitted", None, "", ""
        s.commit()
        return _out(s, c, user)
    finally:
        s.close()


# ── 영수증 — 원본 보관 + 자동 입력 ──────────────────────────────────────────────
_RECEIPT_INSTRUCTIONS = (
    "The attached file is a receipt for a business expense paid by an employee (card slip, cash receipt, "
    "taxi or train ticket, parking or toll receipt, hotel folio, restaurant bill). Extract ONE expense.\n"
    "date = the transaction date YYYY-MM-DD. place = the merchant / store name as printed. detail = a short "
    "line saying what it was in the receipt's language (e.g. '점심 식대', 'Taxi to Busan port', '주차비').\n"
    "category = one of 식대 (meals, cafe), 교통비 (taxi, train, bus, flight, fuel), 주차·통행료 (parking, "
    "tolls), 숙박 (hotel), 통신비 (phone, internet), 사무용품 (office supplies, printing, courier), 접대비 "
    "(client entertainment, gifts), 기타 (anything else).\n"
    "amount = the total paid including VAT (합계·결제금액), number only. vat = the VAT (부가세) printed on "
    "the receipt, 0 if none is printed. currency = ISO code (KRW for 원).\n"
    "Use null for anything not printed. Do NOT invent values."
)


def _read_receipt(data: bytes, media: str) -> dict:
    from services.pdf_parser import _ask_claude, _nullable_str, _parse_image, _pdf_document_block
    head = {
        "category": {"type": "string", "enum": EXPENSE_CATEGORIES},
        **_nullable_str("date", "place", "detail", "currency"),
        "amount": {"type": ["number", "null"]},
        "vat": {"type": ["number", "null"]},
    }
    schema = {"type": "object", "properties": head, "required": list(head), "additionalProperties": False}
    if media == "application/pdf":
        return _ask_claude([_pdf_document_block(data), {"type": "text", "text": _RECEIPT_INSTRUCTIONS}], schema)
    return _parse_image(data, media, _RECEIPT_INSTRUCTIONS, schema)


@app.post("/api/admin/expenses/{claim_id}/receipts", dependencies=[Depends(require_token)])
def upload_expense_receipt(claim_id: int, file: UploadFile = File(...), read: int = 1,
                           user: dict = Depends(get_current_user)):
    """영수증을 청구서에 붙이고(read=1 이면) 읽어 낸 줄 초안을 함께 돌려준다. 줄은 화면이 저장한다."""
    fname = (file.filename or "receipt").strip()
    media = _ocr_image_media_type(file) or ("application/pdf" if fname.lower().endswith(".pdf") else None)
    if not media:
        raise HTTPException(status_code=400, detail="이미지(PNG·JPG·WEBP) 또는 PDF 파일만 올릴 수 있습니다.")
    file.file.seek(0)
    data = file.file.read()
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="파일이 너무 큽니다(15MB 이하).")
    s = get_session()
    try:
        c = _get(s, claim_id, user)
        if not _mine(c, user) or (c.status or "draft") not in ("draft", "rejected"):
            raise HTTPException(status_code=409, detail="Only your own draft or returned claim can be changed.")
        r = ExpenseReceipt(claim_id=c.id, filename=fname[:255], mime=media, data=data)
        s.add(r)
        s.commit()
        rid = r.id
    finally:
        s.close()
    fields: dict = {}
    warn = ""
    if read:
        try:
            got = _read_receipt(data, media)
            fields = {k: got.get(k) for k in ("date", "place", "detail", "category", "amount", "vat", "currency")}
            if (fields.get("currency") or "KRW").upper() != "KRW":
                warn = f"Receipt is in {fields.get('currency')} — enter the KRW amount you were charged."
        except Exception as exc:   # 읽기 실패해도 영수증은 붙었다 — 칸은 사람이 채운다
            warn = f"Could not read the receipt: {exc}"
    return {"receipt_id": rid, "filename": fname, "fields": fields, "warning": warn}


@app.get("/api/admin/expenses/receipts/{receipt_id}", dependencies=[Depends(require_token)])
def get_expense_receipt(receipt_id: int, user: dict = Depends(get_current_user)):
    s = get_session()
    try:
        r = s.query(ExpenseReceipt).filter_by(id=receipt_id).first()
        if not r:
            raise HTTPException(status_code=404, detail="Receipt not found.")
        _get(s, r.claim_id, user)   # 볼 수 있는 청구서의 영수증인가
        from urllib.parse import quote
        return Response(content=r.data or b"", media_type=r.mime or "application/octet-stream",
                        headers={"Content-Disposition": f"inline; filename*=UTF-8''{quote(r.filename or 'receipt')}"})
    finally:
        s.close()


# ── 출장 보고서 → 경비 청구 ────────────────────────────────────────────────────
_PERSONAL = ("개인", "현금", "cash", "personal", "own", "private")
_CORPORATE = ("법인", "corporate", "company card", "회사")
_TRIP_CAT = [("식", "식대"), ("meal", "식대"), ("food", "식대"), ("lunch", "식대"), ("dinner", "식대"),
             ("택시", "교통비"), ("taxi", "교통비"), ("교통", "교통비"), ("항공", "교통비"), ("flight", "교통비"),
             ("train", "교통비"), ("ktx", "교통비"), ("기차", "교통비"), ("버스", "교통비"), ("유류", "교통비"),
             ("주차", "주차·통행료"), ("parking", "주차·통행료"), ("통행", "주차·통행료"), ("toll", "주차·통행료"),
             ("숙박", "숙박"), ("hotel", "숙박"), ("호텔", "숙박"), ("접대", "접대비"), ("entertain", "접대비"),
             ("통신", "통신비"), ("phone", "통신비"), ("sim", "통신비"),
             # 출장 보고서 경비 시트의 분류(영문) — TripReport.EXPENSE_CATEGORIES
             ("transport", "교통비"), ("lodging", "숙박"), ("communication", "통신비")]


def _trip_category(text: str) -> str:
    t = (text or "").lower()
    return next((c for k, c in _TRIP_CAT if k in t), "기타")


@app.post("/api/admin/expenses/from-trip/{event_id}", dependencies=[Depends(require_token)])
def expenses_from_trip(event_id: int, user: dict = Depends(get_current_user)):
    """출장 보고서 경비 시트의 개인 결제분(개인카드·현금)을 내 경비 청구서로 넘긴다.
    사용일의 달 청구서에 들어가고(없으면 만든다), 이미 넘긴 줄은 다시 넘기지 않는다."""
    s = get_session()
    try:
        ev = s.query(ScheduleEvent).filter_by(id=event_id).first()
        if not ev:
            raise HTTPException(status_code=404, detail="Trip not found.")
        rows = ((ev.trip or {}).get("expenses") or []) if isinstance(ev.trip, dict) else []
        title = (ev.title or "Business trip")[:200]
        mine = [c for c in s.query(ExpenseClaim).all() if _mine(c, user)]
        done = {l.get("trip_key") for c in mine for l in (c.lines or []) if l.get("trip_key")}
        added, skipped_corp, skipped_dup, locked = 0, 0, 0, 0
        by_month: dict[str, ExpenseClaim] = {}
        for i, x in enumerate(rows):
            if not isinstance(x, dict):
                continue
            pay = str(x.get("payment") or "").lower()
            if any(k in pay for k in _CORPORATE) or not any(k in pay for k in _PERSONAL):
                skipped_corp += 1   # 법인카드·결제수단 미기재는 넘기지 않는다
                continue
            key = f"trip:{ev.id}:{i}"
            if key in done:
                skipped_dup += 1
                continue
            day = str(x.get("date") or ev.date or "")[:10]
            if len(day) != 10:
                continue
            month = day[:7]
            c = by_month.get(month) or next(
                (c for c in mine if c.month == month and (c.status or "draft") in ("draft", "rejected")), None)
            if c is None:
                if any(c.month == month and (c.status or "") == "submitted" for c in mine):
                    locked += 1   # 이미 제출한 달 — 승인/반려 뒤에 다시 넘긴다
                    continue
                c = ExpenseClaim(user_id=user.get("id") or None, claimant=user.get("username") or "",
                                 month=month, status="draft", lines=[])
                s.add(c)
                mine.append(c)
            by_month[month] = c
            c.lines = sorted([*(c.lines or []), _clean_line({
                "date": day, "category": _trip_category(f"{x.get('category') or ''} {x.get('detail') or ''}"),
                "detail": str(x.get("detail") or x.get("category") or "").strip(),
                "amount": x.get("amount"), "vat": 0, "trip_key": key, "trip_title": title,
                "note": " · ".join(str(v) for v in (x.get("fx_note"), x.get("note")) if v),
            })], key=lambda l: (l["date"], l["id"]))
            added += 1
        s.commit()
        return {"ok": True, "added": added, "skipped_corporate": skipped_corp,
                "skipped_already": skipped_dup, "skipped_submitted": locked,
                "months": sorted(by_month)}
    finally:
        s.close()
