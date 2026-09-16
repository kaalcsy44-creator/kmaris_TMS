"""K-Maris TMS — ap routes (매입 청구·전자세금계산서 수취; ARRecord 의 매입측 대응).

벤더가 보낸 대금청구서/거래명세서(금액 확정)와 전자세금계산서 수취를 vendor P/O 단위로
기록한다. 각 AP 레코드는 하나의 PurchaseOrder(po_id)에 1:1 로 연결되며, Finance 의
지급(payable) 소스로 자동 반영된다(_ap_record_rows).
"""
from __future__ import annotations

from _core import (
    _rfq_for_order,
    APPayment,
    APRecord,
    APSave,
    ARStatus,
    Customer,
    Depends,
    HTTPException,
    Order,
    PurchaseOrder,
    Vendor,
    _ap_record_rows,
    _ar_status_from_text,
    _enum_val,
    app,
    date,
    get_session,
    require_token,
)


def _ap_out(r: APRecord, po_no: str = "", vendor: str = "") -> dict:
    """APRecord → 편집 폼용 dict."""
    invoice = round(r.invoice_amount or 0, 2)
    paid = round(r.paid_amount or 0, 2)
    return {
        "id": r.id,
        "po_id": r.po_id,
        "kind": getattr(r, "kind", None) or "main",
        "order_id": r.order_id,
        "vendor_id": r.vendor_id,
        "po_no": po_no,
        "vendor": vendor,
        "bill_no": r.bill_no or "",
        "bill_date": r.bill_date or "",
        "invoice_amount": invoice,
        "paid_amount": paid,
        "paid_date": r.paid_date or "",
        "outstanding": round(invoice - paid, 2),
        "currency": r.currency or "KRW",
        "vat_rate": r.vat_rate if r.vat_rate is not None else 0.1,
        "due_date": r.due_date or "",
        "status": _enum_val(r.status),
        "items": r.items or [],
        "charges": r.charges or {},
        "notes": r.notes or "",
        "tax_received": bool(r.tax_received),
        "tax_received_date": r.tax_received_date or "",
        "tax_invoice_no": r.tax_invoice_no or "",
    }


@app.get("/api/admin/ap/by-order/{order_id}", dependencies=[Depends(require_token)])
def ap_by_order(order_id: int):
    """이 오더의 vendor P/O 목록 + 각 P/O 의 AP 레코드(없으면 null).

    프로젝트 9~11단계 AP 탭이 벤더 P/O 선택기와 편집 폼을 그리는 데 사용한다.
    rfq_id 를 함께 준다 — 청구 품목을 3단계에 받아 둔 공급사 견적에서 끌어올 때 필요하다.
    화면이 다른 목록(po-work-options)을 뒤져 오더→프로젝트를 되짚게 두면, 그 목록에
    이 오더가 없을 때 아무 말 없이 빈 손이 된다.
    """
    s = get_session()
    try:
        order = s.query(Order).filter_by(id=order_id).first()
        rfq = _rfq_for_order(s, order) if order else None
        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}
        pos = (
            s.query(PurchaseOrder)
            .filter_by(order_id=order_id)
            .order_by(PurchaseOrder.id)
            .all()
        )
        all_aps = s.query(APRecord).filter_by(order_id=order_id).order_by(APRecord.id).all()
        ap_by_po = {a.po_id: a for a in all_aps if a.po_id}
        rows = []
        for po in pos:
            vendor = vendor_names.get(po.vendor_id, "—")
            existing = ap_by_po.get(po.id)
            rows.append({
                "po_id": po.id,
                "po_no": po.po_no or "",
                "vendor_id": po.vendor_id,
                "vendor": vendor,
                "currency": po.currency or "KRW",
                "date": po.date or "",
                "items": po.items or [],
                "ap": _ap_out(existing, po.po_no or "", vendor) if existing else None,
            })
        # 추가 매입 — 본 발주와 별개로 받은 청구(일정 지연에 따른 항공권 변경 같은 것).
        # P/O 가 없으므로 자기 자신이 곧 한 줄이다. 화면은 이것도 P/O 줄과 같은 모양으로
        # 받아 같은 편집 폼에 넘긴다(po_id 0 = 발주 없는 줄).
        for a in all_aps:
            if a.po_id or (getattr(a, "kind", None) or "main") != "extra":
                continue
            vendor = vendor_names.get(a.vendor_id, "—")
            rows.append({
                "po_id": 0,
                "ap_id": a.id,
                "po_no": "",
                "vendor_id": a.vendor_id or 0,
                "vendor": vendor,
                "currency": a.currency or "KRW",
                "date": a.bill_date or "",
                "items": a.items or [],
                "ap": _ap_out(a, "", vendor),
            })
        return {"rows": rows, "rfq_id": rfq.id if rfq else 0}
    finally:
        s.close()


@app.post("/api/admin/ap", dependencies=[Depends(require_token)])
def create_ap(body: APSave):
    s = get_session()
    try:
        kind = "extra" if (body.kind == "extra" or not body.po_id) else "main"
        po = None
        if kind == "main":
            po = s.query(PurchaseOrder).filter_by(id=body.po_id).first()
            if not po:
                raise HTTPException(status_code=404, detail="Purchase order not found.")
            existing = s.query(APRecord).filter_by(po_id=body.po_id).first()
            if existing:
                raise HTTPException(status_code=400, detail="This P/O already has an AP record.")
        elif not body.vendor_id:
            # P/O 가 없으면 공급사를 잡아 줄 것이 없다 — 지급 대장이 "누구에게"를 잃는다.
            raise HTTPException(status_code=400, detail="추가 매입은 공급사를 골라야 합니다.")
        if not s.query(Order).filter_by(id=body.order_id).first():
            raise HTTPException(status_code=404, detail="Order not found.")
        ap = APRecord(
            po_id=body.po_id or None,
            kind=kind,
            order_id=body.order_id,
            vendor_id=body.vendor_id if body.vendor_id is not None else (po.vendor_id if po else None),
            bill_no=body.bill_no or "",
            bill_date=body.bill_date or "",
            invoice_amount=body.invoice_amount or 0.0,
            paid_amount=body.paid_amount or 0.0,
            paid_date=body.paid_date or "",
            currency=body.currency or "KRW",
            vat_rate=body.vat_rate if body.vat_rate is not None else 0.1,
            due_date=body.due_date,
            status=_ar_status_from_text(body.status, body.paid_amount or 0.0, body.invoice_amount or 0.0),
            items=body.items or [],
            charges=body.charges or {},
            notes=body.notes or "",
            tax_received=bool(body.tax_received),
            tax_received_date=body.tax_received_date or "",
            tax_invoice_no=body.tax_invoice_no or "",
        )
        s.add(ap)
        s.commit()
        return {"ok": True, "id": ap.id}
    finally:
        s.close()


@app.put("/api/admin/ap/{ap_id}", dependencies=[Depends(require_token)])
def update_ap(ap_id: int, body: APSave):
    s = get_session()
    try:
        ap = s.query(APRecord).filter_by(id=ap_id).first()
        if not ap:
            raise HTTPException(status_code=404, detail="AP record not found.")
        # 추가 매입은 P/O 가 없다 — 빈 값이 0 으로 들어가 없는 발주를 가리키지 않게 한다.
        ap.po_id = body.po_id or None
        if body.kind in ("main", "extra"):
            ap.kind = body.kind
        ap.order_id = body.order_id
        if body.vendor_id is not None:
            ap.vendor_id = body.vendor_id
        ap.invoice_amount = body.invoice_amount or 0.0
        ap.paid_amount = body.paid_amount or 0.0
        ap.currency = body.currency or "KRW"
        ap.due_date = body.due_date
        ap.status = _ar_status_from_text(body.status, ap.paid_amount or 0.0, ap.invoice_amount or 0.0)
        # 부분 저장(수취 토글 등)과 충돌하지 않도록, 전달된 필드만 갱신.
        if body.bill_no is not None:
            ap.bill_no = body.bill_no
        if body.bill_date is not None:
            ap.bill_date = body.bill_date
        if body.vat_rate is not None:
            ap.vat_rate = body.vat_rate
        if body.items is not None:
            ap.items = body.items
        if body.charges is not None:
            ap.charges = body.charges
        if body.notes is not None:
            ap.notes = body.notes
        if body.tax_received is not None:
            ap.tax_received = bool(body.tax_received)
        if body.tax_received_date is not None:
            ap.tax_received_date = body.tax_received_date
        if body.tax_invoice_no is not None:
            ap.tax_invoice_no = body.tax_invoice_no
        if body.paid_date is not None:
            ap.paid_date = body.paid_date
        # 지급액을 0 으로 되돌리면 지급일도 함께 지운다 — 지급 안 한 건에 날짜만 남으면
        # Finance 실적 집계가 있지도 않은 출금을 그 달에 잡는다.
        if not (ap.paid_amount or 0):
            ap.paid_date = ""
        s.commit()
        return {"ok": True, "id": ap.id, "status": _enum_val(ap.status)}
    finally:
        s.close()


@app.delete("/api/admin/ap/{ap_id}", dependencies=[Depends(require_token)])
def delete_ap(ap_id: int):
    s = get_session()
    try:
        ap = s.query(APRecord).filter_by(id=ap_id).first()
        if not ap:
            raise HTTPException(status_code=404, detail="AP record not found.")
        s.delete(ap)
        s.commit()
        return {"ok": True}
    finally:
        s.close()


@app.post("/api/admin/ap/{ap_id}/payment", dependencies=[Depends(require_token)])
def ap_payment(ap_id: int, body: APPayment):
    """지급 등록 — paid_amount 누적 + 실제 지급일 기록 후 상태 자동 갱신."""
    s = get_session()
    try:
        ap = s.query(APRecord).filter_by(id=ap_id).first()
        if not ap:
            raise HTTPException(status_code=404, detail="AP record not found.")
        if body.amount <= 0:
            raise HTTPException(status_code=400, detail="Payment amount must be greater than 0.")
        ap.paid_amount = (ap.paid_amount or 0) + body.amount
        # 실제 지급일 — 여러 번 나눠 내면 마지막 지급일이 남는다(회차별 이력은 안 남긴다).
        ap.paid_date = (body.paid_date or date.today().isoformat())[:10]
        if body.due_date:
            ap.due_date = body.due_date
        if ap.paid_amount >= (ap.invoice_amount or 0):
            ap.status = ARStatus.PAID
        elif ap.paid_amount > 0:
            ap.status = ARStatus.PARTIAL
        else:
            ap.status = ARStatus.OUTSTANDING
        s.commit()
        return {"ok": True, "paid_amount": ap.paid_amount, "paid_date": ap.paid_date or "",
                "status": _enum_val(ap.status)}
    finally:
        s.close()
