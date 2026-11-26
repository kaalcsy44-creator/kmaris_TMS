"""다음 오더 때 받기(Carry-over) — 고객이 "다음 발주 때 함께 결제"하기로 한 받을 돈.

예: P-084 의 CI 에 실은 운임 USD 200 을 고객이 다음 오더 때 내겠다고 했다.

  · 돈은 원래 딜의 청구서(ARRecord)에 그대로 남는다 — 매출·손익·미수는 P-084 의 것이다.
    그 청구서에 carry_next 표시만 단다(연체 알림 대신 "다음 오더 때 받을 돈" 알림).
  · 같은 고객사의 다음 딜에서 PI·CI 를 열면 편집기가 "이 청구서에 추가"를 띄운다. 누르면
    품목 한 줄이 carry_ar_id 표식을 달고 들어간다 — 문서 합계·PDF·Excel 은 그대로 따라온다.
  · 그 줄은 새 딜의 받을 돈(AR)에는 넣지 않는다(ar_from_pi 등에서 뺀다) — 같은 돈이 두 딜에
    미수로 서면 안 된다. 고객이 새 청구서대로 결제하면 그중 이 몫은 원래 청구서에 수금으로 적는다.
  · 어디에 실렸는지는 따로 저장하지 않고 PI·CI 품목의 표식으로 찾는다 — 줄을 지우면 저절로
    "아직 안 실림"으로 돌아가 엇갈릴 일이 없다.
"""
from __future__ import annotations

from pydantic import BaseModel

from _core import (
    ARRecord,
    Customer,
    Depends,
    HTTPException,
    Order,
    RFQ,
    _ar_outstanding,
    _orders_for_rfq,
    _project_no_map,
    _rfq_for_order,
    app,
    get_session,
    require_token,
)
from db.models import CommercialInvoice, ProformaInvoice


def carry_ar_id(it) -> int:
    """문서 품목이 이월 줄이면 그 원래 청구서(ARRecord) id, 아니면 0."""
    if not isinstance(it, dict):
        return 0
    try:
        return int(it.get("carry_ar_id") or 0)
    except (TypeError, ValueError):
        return 0


def _company_key(name: str) -> str:
    return (name or "").strip().lower()


def _carried_in(s, ar_ids: set[int]) -> dict[int, list[dict]]:
    """이월 청구서 id → 그것을 한 줄로 실은 PI·CI 들."""
    out: dict[int, list[dict]] = {}
    if not ar_ids:
        return out
    pno = _project_no_map(s)
    orders = {o.id: o for o in s.query(Order).all()}

    def rfq_of(order_id, rfq_id=None) -> int:
        if rfq_id:
            return rfq_id
        o = orders.get(order_id or 0)
        r = _rfq_for_order(s, o) if o else None
        return r.id if r else 0

    for kind, Model, no_attr in (("pi", ProformaInvoice, "pi_no"), ("ci", CommercialInvoice, "ci_no")):
        for d in s.query(Model).all():
            for it in d.items or []:
                aid = carry_ar_id(it)
                if aid in ar_ids:
                    rid = rfq_of(d.order_id, getattr(d, "rfq_id", None))
                    out.setdefault(aid, []).append({
                        "kind": kind, "id": d.id, "no": getattr(d, no_attr) or kind.upper(),
                        "rfq_id": rid, "project_no": pno.get(rid, ""),
                        "amount": it.get("amount"), "currency": (d.currency or "USD").upper(),
                    })
    return out


def _ar_brief(s, ar: ARRecord, order: Order | None, pno: dict, carried: list[dict]) -> dict:
    rfq = _rfq_for_order(s, order) if order else None
    first = next((it for it in (ar.items or []) if isinstance(it, dict) and it.get("description")), None)
    return {
        "ar_id": ar.id,
        "rfq_id": rfq.id if rfq else 0,
        "project_no": pno.get(rfq.id, "") if rfq else "",
        "project_title": (rfq.project_title or "") if rfq else "",
        "invoice_no": ar.invoice_no or ar.ci_no or "",
        "kind": ar.kind or "main",
        "description": (first or {}).get("description") or "",
        "currency": (ar.currency or "USD").upper(),
        "outstanding": round(_ar_outstanding(ar), 2),
        "note": ar.carry_note or "",
        "carried_in": carried,
    }


def open_carry_overs(s, company: str | None = None) -> list[dict]:
    """아직 받지 못한 '다음 오더 때 받기' 청구서들(회사명을 주면 그 회사 것만)."""
    ars = [a for a in s.query(ARRecord).filter(ARRecord.carry_next == True).all()  # noqa: E712
           if _ar_outstanding(a) > 0]
    if not ars:
        return []
    orders = {o.id: o for o in s.query(Order).all()}
    cust = {c.id: c.name or "" for c in s.query(Customer).all()}
    key = _company_key(company) if company is not None else None
    pno = _project_no_map(s)
    carried = _carried_in(s, {a.id for a in ars})
    out = []
    for a in ars:
        o = orders.get(a.order_id or 0)
        name = cust.get(o.customer_id, "") if o else ""
        if key is not None and _company_key(name) != key:
            continue
        out.append({**_ar_brief(s, a, o, pno, carried.get(a.id, [])), "customer": name})
    return out


class CarryNextIn(BaseModel):
    on: bool
    note: str = ""


@app.post("/api/admin/ar/{ar_id}/carry-next", dependencies=[Depends(require_token)])
def set_carry_next(ar_id: int, body: CarryNextIn):
    """청구서에 '다음 오더 때 받기' 표시를 달거나 뗀다."""
    s = get_session()
    try:
        ar = s.query(ARRecord).filter_by(id=ar_id).first()
        if not ar:
            raise HTTPException(status_code=404, detail="청구서를 찾을 수 없습니다.")
        if body.on and _ar_outstanding(ar) <= 0:
            raise HTTPException(status_code=400, detail="Nothing left to collect on this invoice.")
        ar.carry_next = bool(body.on)
        ar.carry_note = (body.note or "").strip()[:300] if body.on else ""
        s.commit()
        return {"ok": True, "carry_next": ar.carry_next, "carry_note": ar.carry_note or ""}
    finally:
        s.close()


@app.get("/api/admin/projects/{rfq_id}/carry-overs", dependencies=[Depends(require_token)])
def project_carry_overs(rfq_id: int):
    """이 딜의 고객사가 다른 딜에서 '다음 오더 때' 내기로 한 받을 돈 — PI·CI 편집기가 띄운다.
    이 딜 자신의 청구서는 뺀다(제 청구서에 제 돈을 얹을 일은 없다)."""
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            raise HTTPException(status_code=404, detail="프로젝트를 찾을 수 없습니다.")
        c = s.query(Customer).filter_by(id=rfq.customer_id).first() if rfq.customer_id else None
        if not c:
            return {"items": []}
        own = {o.id for o in _orders_for_rfq(s, rfq_id)}
        mine = {a.id for a in s.query(ARRecord).filter(ARRecord.order_id.in_(own)).all()} if own else set()
        return {"items": [x for x in open_carry_overs(s, c.name or "") if x["ar_id"] not in mine]}
    finally:
        s.close()


@app.get("/api/admin/carry-overs", dependencies=[Depends(require_token)])
def all_carry_overs():
    """모든 고객의 '다음 오더 때 받을 돈' — Finance·알림용."""
    s = get_session()
    try:
        return {"items": open_carry_overs(s)}
    finally:
        s.close()

