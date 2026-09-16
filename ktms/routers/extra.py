"""K-Maris TMS — extra charge routes (추가비용 · 양쪽 견적과 승인).

일정이 밀려 항공권을 바꾸거나 비자를 새로 받는 식으로, 본 계약 금액과 별개인 비용이
뒤늦게 붙는다. 본 대금을 이미 받은 뒤에 생기기도 하고 작업 전에 생기기도 한다.

한 건 안에 양쪽이 다 들어간다 — 공급사가 견적을 보내오면 우리가 승인하고(매입),
우리가 견적을 발행하면 고객이 승인한다(매출). 둘을 한 레코드에 두는 까닭은 마진이다.
따로 두면 추가비용을 원가 그대로 넘겼는지 얹었는지 볼 수 있는 자리가 없다.

승인일이 곧 스위치다. 값이 들어오면 그 쪽의 청구 레코드를 만들고 비우면 되돌린다 —
'승인' 단추를 따로 두지 않는 까닭은, 승인은 날짜가 있는 사실이지 상태 플래그가 아니기
때문이다(언제 승인했는지를 못 적으면 나중에 되짚을 수 없다).

매입측은 벤더 P/O 없이 APRecord 만 만든다. 여기에 보조 P/O 를 끊으면 _deal_progress 의
ap_all_paid 가 벤더 P/O 목록을 all() 로 훑으므로, 그 건이 미지급인 동안 이미 끝난
9·10·11단계가 통째로 되돌아간다.
"""
from __future__ import annotations

from _core import (
    APRecord,
    ARRecord,
    ARStatus,
    Depends,
    ExtraCharge,
    ExtraChargeSave,
    HTTPException,
    Order,
    RFQ,
    Vendor,
    _ar_outstanding,
    _enum_val,
    _rfq_for_order,
    _total_amount,
    app,
    date,
    get_current_user,
    get_session,
    log_stage_note,
    require_token,
)

REASONS = {"schedule_delay", "scope_change", "rework", "other"}
TIMINGS = {"before", "after"}


def _log(s, rfq_id: int, text: str, pic: str = "") -> None:
    """딜의 활동기록에 한 줄 — 9단계(청구) 칸에 붙인다.

    추가비용은 청구서가 하나 더 느는 사건이라, 나중에 "이 딜에 왜 청구서가 둘이지?"를
    되짚는 자리가 단계 보드다. 그 자리에 자국이 없으면 이 탭을 열어 볼 생각을 못 한다.
    """
    if rfq_id:
        log_stage_note(s, rfq_id, text, pic, stage=9, system="extra")


def _resolve_deal(s, body: ExtraChargeSave) -> tuple[int, int]:
    """본문의 order_id / rfq_id 를 채운다 — 오더만 오면 그 오더의 프로젝트를 찾는다."""
    order_id = body.order_id or 0
    rfq_id = body.rfq_id or 0
    if order_id:
        order = s.query(Order).filter_by(id=order_id).first()
        if not order:
            raise HTTPException(status_code=404, detail="Order를 찾을 수 없습니다.")
        if not rfq_id:
            rfq = _rfq_for_order(s, order)
            rfq_id = rfq.id if rfq else 0
    if rfq_id and not s.query(RFQ).filter_by(id=rfq_id).first():
        raise HTTPException(status_code=404, detail="프로젝트(RFQ)를 찾을 수 없습니다.")
    if not order_id:
        raise HTTPException(status_code=400, detail="추가비용은 고객 P/O 에 붙어야 합니다.")
    return order_id, rfq_id


def _amount_of(explicit, items) -> float:
    """금액을 비워 보내면 품목 합으로 채운다 — 화면에서 단가만 고쳐도 합이 어긋나지 않게."""
    if explicit is not None:
        try:
            return round(float(explicit), 2)
        except (TypeError, ValueError):
            pass
    return round(_total_amount(items or []), 2)


def _apply(s, e: ExtraCharge, body: ExtraChargeSave) -> None:
    """본문 → 레코드. 승인일 두 개는 아래 _sync_* 가 읽어 청구 레코드를 맞춘다."""
    e.title = (body.title or "").strip()
    e.reason = body.reason if body.reason in REASONS else "schedule_delay"
    e.occurred_date = (body.occurred_date or "")[:10]
    e.timing = body.timing if body.timing in TIMINGS else "before"
    e.description = body.description or ""
    e.notes = body.notes or ""

    e.vendor_id = body.vendor_id or None
    e.vendor_quote_no = (body.vendor_quote_no or "").strip()
    e.vendor_quote_date = (body.vendor_quote_date or "")[:10]
    e.vendor_currency = (body.vendor_currency or "KRW").upper()
    e.vendor_items = body.vendor_items or []
    e.vendor_amount = _amount_of(body.vendor_amount, e.vendor_items)
    e.vendor_approved_date = (body.vendor_approved_date or "")[:10]

    e.quote_no = (body.quote_no or "").strip()
    e.quote_date = (body.quote_date or "")[:10]
    e.valid_until = (body.valid_until or "")[:10]
    e.currency = (body.currency or "USD").upper()
    e.fx_rate = float(body.fx_rate) if body.fx_rate else 1.0
    e.items = body.items or []
    e.amount = _amount_of(body.amount, e.items)
    e.vat_rate = float(body.vat_rate or 0)
    e.sent_date = (body.sent_date or "")[:10]
    e.approved_date = (body.approved_date or "")[:10]
    e.approved_ref = (body.approved_ref or "").strip()


def _status_of(s, e: ExtraCharge) -> str:
    """상태는 적힌 사실에서 끌어낸다 — 손으로 고르게 하면 사실과 어긋난 채로 남는다.
    반드시 _sync_ar/_sync_ap 뒤에 부른다(그 결과를 읽으므로)."""
    ar = s.query(ARRecord).filter_by(extra_id=e.id).first()
    ap = s.query(APRecord).filter_by(extra_id=e.id).first()
    ar_done = ar is not None and _ar_outstanding(ar) <= 0.01
    ap_done = ap is None or (ap.invoice_amount or 0) - (ap.paid_amount or 0) <= 0.01
    if ar_done and ap_done:
        return "settled"
    if ar is not None or ap is not None:
        return "invoiced"
    if e.approved_date or e.vendor_approved_date:
        return "approved"
    if e.sent_date or e.vendor_quote_no:
        return "quoted"
    return "draft"


def _sync_ar(s, e: ExtraCharge) -> None:
    """고객 승인일이 있으면 추가 청구서(ARRecord kind=extra)를 세우고, 없으면 거둔다.

    이미 수금이 잡힌 청구서는 승인일을 지워도 지우지 않는다 — 돈이 들어온 기록을
    화면의 날짜 하나로 없앨 수는 없다.
    """
    ar = s.query(ARRecord).filter_by(extra_id=e.id).first()
    if e.approved_date:
        if not ar:
            ar = ARRecord(order_id=e.order_id, extra_id=e.id, kind="extra", ci_no="",
                          paid_amount=0.0, status=ARStatus.OUTSTANDING)
            s.add(ar)
        ar.invoice_amount = e.amount or 0.0
        ar.currency = e.currency or "USD"
        ar.vat_rate = e.vat_rate or 0.0
        ar.items = e.items or []
        ar.invoice_no = ar.invoice_no or (f"{e.quote_no}-INV" if e.quote_no else "")
        ar.invoice_date = ar.invoice_date or e.approved_date
        ar.notes = f"Extra charge: {e.title or ''}".strip()
    elif ar is not None and (ar.paid_amount or 0) <= 0:
        s.delete(ar)


def _sync_ap(s, e: ExtraCharge) -> None:
    """우리 승인일이 있으면 추가 지급(APRecord kind=extra)을 세우고, 없으면 거둔다.
    po_id 는 비운다 — 모듈 머리 주석 참고."""
    ap = s.query(APRecord).filter_by(extra_id=e.id).first()
    if e.vendor_approved_date and e.vendor_id:
        if not ap:
            ap = APRecord(order_id=e.order_id, extra_id=e.id, kind="extra", po_id=None,
                          paid_amount=0.0, status=ARStatus.OUTSTANDING)
            s.add(ap)
        ap.vendor_id = e.vendor_id
        ap.invoice_amount = e.vendor_amount or 0.0
        ap.currency = e.vendor_currency or "KRW"
        ap.items = e.vendor_items or []
        ap.bill_no = ap.bill_no or e.vendor_quote_no or ""
        ap.bill_date = ap.bill_date or e.vendor_approved_date
        ap.notes = f"Extra charge: {e.title or ''}".strip()
    elif ap is not None and (ap.paid_amount or 0) <= 0:
        s.delete(ap)


def _row(s, e: ExtraCharge, vendor_names: dict[int, str]) -> dict:
    ar = s.query(ARRecord).filter_by(extra_id=e.id).first()
    ap = s.query(APRecord).filter_by(extra_id=e.id).first()
    # 마진 — 고객 청구액에서 벤더 원가를 뺀다. 통화가 다르면 fx_rate 로 청구 통화에 맞춘다.
    cost_in_sales_cur = round((e.vendor_amount or 0) * (e.fx_rate or 1.0), 2)
    margin = round((e.amount or 0) - cost_in_sales_cur, 2)
    return {
        "id": e.id,
        "rfq_id": e.rfq_id or 0,
        "order_id": e.order_id or 0,
        "title": e.title or "",
        "reason": e.reason or "schedule_delay",
        "occurred_date": e.occurred_date or "",
        "timing": e.timing or "before",
        "description": e.description or "",
        "status": e.status or "draft",
        "vendor_id": e.vendor_id or 0,
        "vendor": vendor_names.get(e.vendor_id or 0, ""),
        "vendor_quote_no": e.vendor_quote_no or "",
        "vendor_quote_date": e.vendor_quote_date or "",
        "vendor_currency": e.vendor_currency or "KRW",
        "vendor_items": e.vendor_items or [],
        "vendor_amount": e.vendor_amount or 0.0,
        "vendor_approved_date": e.vendor_approved_date or "",
        "quote_no": e.quote_no or "",
        "quote_date": e.quote_date or "",
        "valid_until": e.valid_until or "",
        "currency": e.currency or "USD",
        "fx_rate": e.fx_rate or 1.0,
        "items": e.items or [],
        "amount": e.amount or 0.0,
        "vat_rate": e.vat_rate or 0.0,
        "sent_date": e.sent_date or "",
        "approved_date": e.approved_date or "",
        "approved_ref": e.approved_ref or "",
        "notes": e.notes or "",
        "margin": margin,
        "cost_in_sales_currency": cost_in_sales_cur,
        # 세운 청구 레코드 — 화면이 수금/지급 현황을 따로 조회하지 않게 함께 싣는다.
        "ar": None if ar is None else {
            "id": ar.id,
            "invoice_no": ar.invoice_no or "",
            "invoice_amount": ar.invoice_amount or 0.0,
            "paid_amount": ar.paid_amount or 0.0,
            "outstanding": _ar_outstanding(ar),
            "currency": ar.currency or "USD",
            "due_date": ar.due_date or "",
            "paid_date": ar.paid_date or "",
            "status": _enum_val(ar.status),
        },
        "ap": None if ap is None else {
            "id": ap.id,
            "bill_no": ap.bill_no or "",
            "invoice_amount": ap.invoice_amount or 0.0,
            "paid_amount": ap.paid_amount or 0.0,
            "outstanding": round((ap.invoice_amount or 0) - (ap.paid_amount or 0), 2),
            "currency": ap.currency or "KRW",
            "due_date": ap.due_date or "",
            "paid_date": ap.paid_date or "",
            "status": _enum_val(ap.status),
        },
    }


@app.get("/api/admin/extra-charges", dependencies=[Depends(require_token)])
def list_extra_charges(order_id: int = 0, rfq_id: int = 0):
    """추가비용 목록 — 고객 P/O(order_id) 또는 프로젝트(rfq_id) 기준. 둘 다 없으면 전체."""
    s = get_session()
    try:
        q = s.query(ExtraCharge)
        if order_id:
            q = q.filter(ExtraCharge.order_id == order_id)
        elif rfq_id:
            q = q.filter(ExtraCharge.rfq_id == rfq_id)
        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}
        rows = [_row(s, e, vendor_names) for e in q.order_by(ExtraCharge.id.asc()).all()]
        return {"rows": rows}
    finally:
        s.close()


@app.post("/api/admin/extra-charges", dependencies=[Depends(require_token)])
def create_extra_charge(body: ExtraChargeSave, user: dict = Depends(get_current_user)):
    s = get_session()
    try:
        order_id, rfq_id = _resolve_deal(s, body)
        e = ExtraCharge(order_id=order_id, rfq_id=rfq_id or None,
                        created_by=(user or {}).get("id"))
        _apply(s, e, body)
        s.add(e)
        s.flush()          # id 가 있어야 청구 레코드를 붙일 수 있다
        _sync_ar(s, e)
        _sync_ap(s, e)
        e.status = _status_of(s, e)
        _log(s, rfq_id, f"추가비용 등록 — {e.title or '(제목 없음)'}", (user or {}).get("name", ""))
        s.commit()
        return {"ok": True, "id": e.id}
    finally:
        s.close()


@app.put("/api/admin/extra-charges/{extra_id}", dependencies=[Depends(require_token)])
def update_extra_charge(extra_id: int, body: ExtraChargeSave,
                        user: dict = Depends(get_current_user)):
    s = get_session()
    try:
        e = s.query(ExtraCharge).filter_by(id=extra_id).first()
        if not e:
            raise HTTPException(status_code=404, detail="추가비용 건을 찾을 수 없습니다.")
        was_approved = bool(e.approved_date)
        _apply(s, e, body)
        _sync_ar(s, e)
        _sync_ap(s, e)
        e.status = _status_of(s, e)
        if e.approved_date and not was_approved:
            _log(s, e.rfq_id or 0,
                 f"추가비용 고객 승인 — {e.title or ''} {e.currency} {e.amount:,.2f}",
                 (user or {}).get("name", ""))
        s.commit()
        return {"ok": True, "id": e.id}
    finally:
        s.close()


@app.delete("/api/admin/extra-charges/{extra_id}", dependencies=[Depends(require_token)])
def delete_extra_charge(extra_id: int):
    """추가비용 삭제 — 수금·지급이 잡힌 건은 막는다.

    지우면 그 청구서가 사라져 미수·미지급이 조용히 줄어든다. 먼저 수금/지급을 되돌려
    잔액을 원래대로 만든 다음 지우게 한다(크레딧 노트 삭제와 같은 규칙).
    """
    s = get_session()
    try:
        e = s.query(ExtraCharge).filter_by(id=extra_id).first()
        if not e:
            raise HTTPException(status_code=404, detail="추가비용 건을 찾을 수 없습니다.")
        ar = s.query(ARRecord).filter_by(extra_id=e.id).first()
        ap = s.query(APRecord).filter_by(extra_id=e.id).first()
        if (ar and (ar.paid_amount or 0) > 0) or (ap and (ap.paid_amount or 0) > 0):
            raise HTTPException(
                status_code=400,
                detail="이미 수금/지급이 기록된 추가비용입니다. 먼저 그 기록을 되돌려 주세요.")
        if ar:
            s.delete(ar)
        if ap:
            s.delete(ap)
        s.delete(e)
        s.commit()
        return {"ok": True}
    finally:
        s.close()
