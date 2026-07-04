"""K-Maris TMS — po routes (split from admin_api.py; behavior unchanged)."""
from __future__ import annotations

from _core import (
    ARRecord,
    CommercialInvoice,
    Customer,
    DeliveryProof,
    Depends,
    File,
    HTTPException,
    INTERNAL_STEPS,
    Order,
    OrderCreate,
    OrderStatus,
    OrderUpdate,
    PackingList,
    PurchaseOrder,
    PurchaseOrderCreate,
    PurchaseOrderUpdate,
    Quotation,
    QuotationStatus,
    RFQ,
    Response,
    ShippingAdvice,
    StageCompleteBody,
    TaxInvoiceData,
    UploadFile,
    User,
    Vendor,
    VendorPoPreview,
    VendorPoSend,
    VendorRFQ,
    Vessel,
    _base_meta,
    _enum_val,
    _first_rfq_iso,
    _fmt_received,
    _item_view,
    _kst,
    _kst_iso,
    _ocr_image_media_type,
    _order_for_rfq,
    _pipeline_stage,
    _project_no_for_order,
    _project_no_map,
    _rfq_for_order,
    _rfq_no_disp,
    _status_label,
    _total_amount,
    _vendor_po_email_body,
    _vrfq_sent_iso,
    app,
    build_po_payload,
    date,
    datetime,
    extract_text_from_pdf,
    generate_po_pdf,
    get_session,
    os,
    parse_order_fields,
    parse_order_image,
    require_token,
    send_email,
    steps_for,
)



@app.get("/api/admin/po-overview", dependencies=[Depends(require_token)])
def po_overview():
    """고객 P/O · Vendor P/O 현황 — RFQ → Order → PurchaseOrder 체인."""
    s = get_session()
    try:
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        vessel_names = {v.id: v.name for v in s.query(Vessel).all()}
        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}

        rows = []
        for r in s.query(RFQ).order_by(RFQ.id.desc()).all():
            o = _order_for_rfq(s, r.id)
            vpos = (s.query(PurchaseOrder).filter_by(order_id=o.id)
                    .order_by(PurchaseOrder.id.desc()).all()) if o else []
            if vpos:
                vp0 = vpos[0]
                vendor_po_no = (vp0.po_no or "—") + (
                    f"  (외 {len(vpos) - 1}건)" if len(vpos) > 1 else "")
                vendor_nm = vendor_names.get(vp0.vendor_id, "—")
                vendor_email = vp0.sent_to_email or "—"
                # Vendor P/O 발신 일시 (시·분) — created_at 기준, 앱 전반 규칙과 동일
                vendor_po_at = _kst(vp0.created_at)
            else:
                vendor_po_no = vendor_nm = vendor_email = vendor_po_at = ""

            # Vendor RFQ 발신 일시 (시·분) — Vendor RFQ를 보낸 거래에서만
            vrfqs = (s.query(VendorRFQ).filter_by(rfq_id=r.id)
                     .order_by(VendorRFQ.id.desc()).all())
            vrfq_at = _fmt_received(_vrfq_sent_iso(vrfqs[0])) if vrfqs else ""

            stage = _pipeline_stage(s, r.id)
            rows.append({
                "id": o.id if o else 0,
                "customer_rfq_no": r.customer_rfq_no or "",
                "crfq_at": _kst(r.created_at),
                "kmaris_rfq_no": _rfq_no_disp(r.rfq_no),
                "vrfq_at": vrfq_at,
                "customer": cust_names.get(r.customer_id, "—"),
                "vessel": vessel_names.get(r.vessel_id, "") if r.vessel_id else "",
                "customer_po_no": (o.po_no if o else "") or "",
                # 고객 P/O 수신 일시 (시·분) — 시스템 수신(created_at) 기준
                "customer_po_at": _kst(o.created_at) if o else "",
                "item_count": len((o.items if o else None) or r.items or []),
                "vendor_po_no": vendor_po_no,
                "vendor_po_at": vendor_po_at,
                "vendor": vendor_nm,
                "vendor_email": vendor_email,
                "stage": stage,
                "status": _status_label(stage, r.work_type),
            })
        return {"rows": rows}
    finally:
        s.close()


@app.get("/api/admin/order/{order_id}", dependencies=[Depends(require_token)])
def order_detail(order_id: int):
    """Order 1건 상세 — 고객 P/O, Vendor P/O, 품목, 연결 문서."""
    s = get_session()
    try:
        o = s.query(Order).filter_by(id=order_id).first()
        if not o:
            raise HTTPException(status_code=404, detail="Order not found")

        cust = s.query(Customer).filter_by(id=o.customer_id).first()
        vessel = s.query(Vessel).filter_by(id=o.vessel_id).first() if o.vessel_id else None
        rfq = _rfq_for_order(s, o)
        qtn = s.query(Quotation).filter_by(id=o.quotation_id).first() if o.quotation_id else None
        stage = _pipeline_stage(s, rfq.id) if rfq else 5

        steps = [{
            "no": i,
            "name": name,
            "state": ("done" if i < stage else "current" if i == stage else "todo"),
        } for i, name in enumerate(steps_for(rfq.work_type if rfq else None), start=1)]

        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}
        vendor_emails = {v.id: v.email for v in s.query(Vendor).all()}
        vpos = (s.query(PurchaseOrder).filter_by(order_id=o.id)
                .order_by(PurchaseOrder.id.desc()).all())
        vendor_po_view = [{
            "id": po.id,
            "po_no": po.po_no or "",
            "vendor": vendor_names.get(po.vendor_id, "—"),
            "vendor_email": po.sent_to_email or vendor_emails.get(po.vendor_id, "") or "",
            "date": po.date or "",
            "sent_date": po.sent_date or "",
            "status": po.status or "",
            "item_count": len(po.items or []),
        } for po in vpos]

        ci = s.query(CommercialInvoice).filter_by(order_id=o.id).order_by(CommercialInvoice.id.desc()).first()
        sa = s.query(ShippingAdvice).filter_by(order_id=o.id).order_by(ShippingAdvice.id.desc()).first()
        pl = (s.query(PackingList).filter_by(ci_id=ci.id).order_by(PackingList.id.desc()).first()
              if ci else None)
        tax = (s.query(TaxInvoiceData).filter_by(ci_id=ci.id).order_by(TaxInvoiceData.id.desc()).first()
               if ci else None)
        ars = s.query(ARRecord).filter_by(order_id=o.id).order_by(ARRecord.id.desc()).all()

        return {
            "id": o.id,
            "assignee_id": (rfq.created_by or 0) if rfq else 0,
            "customer_po_no": o.po_no or "",
            "customer_po_at": o.date or "",
            "rfq_no": _rfq_no_disp(rfq.rfq_no) if rfq else "",
            "customer_rfq_no": (rfq.customer_rfq_no or _rfq_no_disp(rfq.rfq_no)) if rfq else "",
            "quotation_no": qtn.qtn_no if qtn else "",
            "currency": (qtn.currency if qtn else "USD") or "USD",
            "project_no": _project_no_map(s).get(rfq.id, "") if rfq else "",
            "first_rfq_at": _first_rfq_iso(rfq),
            "customer": cust.name if cust else "—",
            "customer_contact": (cust.contact if cust else "") or "",
            "customer_email": (cust.email if cust else "") or "",
            "vessel": vessel.name if vessel else "",
            "work_type": _enum_val(rfq.work_type) if (rfq and rfq.work_type) else "부품공급",
            "trade_type": o.trade_type or "수출",
            "project_title": (rfq.project_title or "") if rfq else "",
            "status": _status_label(stage, rfq.work_type) if rfq else _enum_val(o.status),
            "order_status": _enum_val(o.status),
            "stage": stage,
            "promised_delivery": o.promised_delivery or "",
            "shipped_date": o.shipped_date or "",
            "delivered_date": o.delivered_date or "",
            "tracking_token": o.tracking_token or "",
            "steps": steps,
            "items": [_item_view(it) for it in (o.items or [])],
            "vendor_pos": vendor_po_view,
            "documents": {
                "ci_no": ci.ci_no if ci else "",
                "pl_no": pl.pl_no if pl else "",
                "sa_no": sa.sa_no if sa else "",
                "tax_no": tax.tax_no if tax else "",
                "ar": [{
                    "ci_no": ar.ci_no or "",
                    "currency": ar.currency or "USD",
                    "invoice_amount": round(ar.invoice_amount or 0, 2),
                    "paid_amount": round(ar.paid_amount or 0, 2),
                    "due_date": ar.due_date or "",
                    "status": _enum_val(ar.status),
                } for ar in ars],
            },
        }
    finally:
        s.close()


@app.get("/api/admin/po-work-options", dependencies=[Depends(require_token)])
def po_work_options():
    """P/O 작업 탭용 옵션 — Streamlit Customer P/O / Vendor P/O 탭 데이터."""
    s = get_session()
    try:
        customers = [{"id": c.id, "name": c.name} for c in s.query(Customer).order_by(Customer.name).all()]
        vessels = [{
            "id": v.id,
            "name": v.name,
            "customer_id": v.customer_id,
        } for v in s.query(Vessel).order_by(Vessel.name).all()]
        vendors = [{
            "id": v.id,
            "name": v.name,
            "email": v.email or "",
        } for v in s.query(Vendor).order_by(Vendor.name).all()]

        cust_names = {c["id"]: c["name"] for c in customers}
        vessel_names = {v["id"]: v["name"] for v in vessels}
        user_names = {u.id: u.username for u in s.query(User).all()}

        rfqs = []
        for r in s.query(RFQ).order_by(RFQ.id.desc()).all():
            stage = _pipeline_stage(s, r.id)
            rfqs.append({
                "id": r.id,
                "rfq_no": _rfq_no_disp(r.rfq_no),
                "customer_rfq_no": r.customer_rfq_no or "",
                "customer_id": r.customer_id,
                "customer": cust_names.get(r.customer_id, "—"),
                "vessel_id": r.vessel_id,
                "vessel": vessel_names.get(r.vessel_id, "") if r.vessel_id else "",
                "status": _status_label(stage, r.work_type),
                "items": [_item_view(it) for it in (r.items or [])],
            })

        quotations = []
        for q in s.query(Quotation).order_by(Quotation.id.desc()).all():
            quotations.append({
                "id": q.id,
                "qtn_no": q.qtn_no,
                "rfq_id": q.rfq_id,
                "customer_id": q.customer_id,
                "customer": cust_names.get(q.customer_id, "—"),
                "vessel_id": q.vessel_id,
                "vessel": vessel_names.get(q.vessel_id, "") if q.vessel_id else "",
                "status": _enum_val(q.status),
                "currency": q.currency or "USD",
                "amount": round(_total_amount(q.items or []), 2),
                "items": [_item_view(it) for it in (q.items or [])],
            })

        orders = []
        for o in s.query(Order).order_by(Order.id.desc()).all():
            rfq = _rfq_for_order(s, o)
            qtn = s.query(Quotation).filter_by(id=o.quotation_id).first() if o.quotation_id else None
            stage = _pipeline_stage(s, rfq.id) if rfq else 5
            orders.append({
                "id": o.id,
                "customer_id": o.customer_id,
                "customer": cust_names.get(o.customer_id, "—"),
                "vessel_id": o.vessel_id,
                "vessel": vessel_names.get(o.vessel_id, "") if o.vessel_id else "",
                "po_no": o.po_no or "",
                "date": o.date or "",
                "trade_type": o.trade_type or "수출",
                "currency": (qtn.currency if qtn else "USD") or "USD",
                "status": _status_label(stage, rfq.work_type) if rfq else _enum_val(o.status),
                "items": [_item_view(it) for it in (o.items or [])],
                # 공통 식별 컬럼
                "project_title": (getattr(rfq, "project_title", None) or "") if rfq else "",
                "contact_person": (getattr(rfq, "contact_person", None) or "") if rfq else "",
                "assignee": (user_names.get(rfq.created_by, "") or "") if rfq else "",
                "assignee_id": (rfq.created_by or 0) if rfq else 0,
                "work_type": (_enum_val(rfq.work_type) if rfq and rfq.work_type else "부품공급"),
                "first_rfq_at": _first_rfq_iso(rfq),
                "project_no": _project_no_map(s).get(rfq.id, "") if rfq else "",
            })

        purchase_orders = []
        for po in s.query(PurchaseOrder).order_by(PurchaseOrder.id.desc()).all():
            o = s.query(Order).filter_by(id=po.order_id).first()
            vendor = s.query(Vendor).filter_by(id=po.vendor_id).first()
            rfq = _rfq_for_order(s, o) if o else None
            qtn = s.query(Quotation).filter_by(id=o.quotation_id).first() if o and o.quotation_id else None
            purchase_orders.append({
                "id": po.id,
                "po_no": po.po_no or "",
                "order_id": po.order_id,
                "customer_po_no": (o.po_no if o else "") or "",
                "vendor_id": po.vendor_id,
                "vendor": vendor.name if vendor else "—",
                "vendor_email": po.sent_to_email or (vendor.email if vendor else "") or "",
                "date": po.date or "",
                "sent_date": po.sent_date or "",
                "status": po.status or "",
                "sent": po.status == "이메일 발송완료",
                "items": [_item_view(it) for it in (po.items or [])],
                "currency": (qtn.currency if qtn else "USD") or "USD",
                # 공통 식별 컬럼
                "customer": cust_names.get(o.customer_id, "—") if o else "—",
                "project_title": (getattr(rfq, "project_title", None) or "") if rfq else "",
                "contact_person": (getattr(rfq, "contact_person", None) or "") if rfq else "",
                "assignee": (user_names.get(rfq.created_by, "") or "") if rfq else "",
                "assignee_id": (rfq.created_by or 0) if rfq else 0,
                "vessel": (vessel_names.get(o.vessel_id, "") if o and o.vessel_id else ""),
                "trade_type": (o.trade_type or "수출") if o else "수출",
                "work_type": (_enum_val(rfq.work_type) if rfq and rfq.work_type else "부품공급"),
                "first_rfq_at": _first_rfq_iso(rfq),
                "project_no": _project_no_map(s).get(rfq.id, "") if rfq else "",
            })

        return {
            "customers": customers,
            "vessels": vessels,
            "vendors": vendors,
            "rfqs": rfqs,
            "quotations": quotations,
            "orders": orders,
            "purchase_orders": purchase_orders,
            "smtp_configured": bool(os.getenv("SMTP_USER") and os.getenv("SMTP_PASSWORD")),
        }
    finally:
        s.close()


@app.post("/api/admin/ocr/order", dependencies=[Depends(require_token)])
def ocr_order_pdf(file: UploadFile = File(...)):
    """Customer P/O 자동 입력 — PDF 또는 이미지/캡쳐 지원."""
    s = get_session()
    try:
        customer_names = [c.name for c in s.query(Customer).order_by(Customer.name).all()]
    finally:
        s.close()
    fname = (file.filename or "").lower()
    img_media = _ocr_image_media_type(file)
    try:
        file.file.seek(0)
        if img_media:
            return parse_order_image(file.file.read(), img_media, customer_names)
        if fname.endswith(".pdf"):
            raw_text = extract_text_from_pdf(file.file)
            if not raw_text:
                raise HTTPException(status_code=400, detail="PDF에서 텍스트를 추출할 수 없습니다.")
            return parse_order_fields(raw_text, customer_names)
        raise HTTPException(status_code=400, detail="PDF 또는 이미지(PNG·JPG·WEBP) 파일만 업로드할 수 있습니다.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"OCR 추출 실패: {exc}") from exc


@app.post("/api/admin/orders", dependencies=[Depends(require_token)])
def create_order(body: OrderCreate):
    """Customer P/O 수신 탭 — 신규 오더 등록."""
    s = get_session()
    try:
        cust = s.query(Customer).filter_by(id=body.customer_id).first()
        if not cust:
            raise HTTPException(status_code=400, detail="Customer를 선택하세요.")
        qtn = s.query(Quotation).filter_by(id=body.quotation_id).first() if body.quotation_id else None
        rfq_id = body.rfq_id or (qtn.rfq_id if qtn else None)
        items = []
        for it in body.items:
            if not (it.part_no or it.description):
                continue
            qty = it.qty or 1
            unit_price = it.unit_price or 0
            items.append({
                "part_no": it.part_no.strip(),
                "description": it.description.strip(),
                "maker": it.maker.strip(),
                "qty": qty,
                "unit": it.unit or "PCS",
                "unit_price": unit_price,
                "amount": it.amount if it.amount is not None else qty * unit_price,
                "remark": (it.remark or "").strip(),
            })

        order = Order(
            quotation_id=qtn.id if qtn else None,
            rfq_id=rfq_id,
            customer_id=cust.id,
            vessel_id=body.vessel_id,
            po_no=(body.po_no or "").strip(),
            date=body.date or date.today().isoformat(),
            trade_type=(body.trade_type or "수출").strip() or "수출",
            promised_delivery=body.promised_delivery or None,
            status=OrderStatus.RECEIVED,
            items=items,
        )
        s.add(order)
        if qtn:
            qtn.status = QuotationStatus.WON
        s.commit()
        return {"ok": True, "id": order.id, "project_no": _project_no_for_order(s, order)}
    finally:
        s.close()


@app.put("/api/admin/orders/{order_id}", dependencies=[Depends(require_token)])
def update_order(order_id: int, body: OrderUpdate):
    """오더 수정 — 헤더 필드 + 품목 리스트 교체."""
    s = get_session()
    try:
        order = s.query(Order).filter_by(id=order_id).first()
        if not order:
            raise HTTPException(status_code=404, detail="오더를 찾을 수 없습니다.")
        if body.customer_id is not None:
            order.customer_id = body.customer_id
        if body.vessel_id is not None:
            order.vessel_id = body.vessel_id or None
        if body.po_no is not None:
            order.po_no = body.po_no.strip()
        if body.date is not None:
            order.date = body.date or order.date
        if body.trade_type is not None:
            order.trade_type = (body.trade_type or "수출").strip() or "수출"
        if body.promised_delivery is not None:
            order.promised_delivery = body.promised_delivery or None
        if body.items is not None:
            items = []
            for it in body.items:
                if not (it.part_no or it.description):
                    continue
                qty = it.qty or 1
                unit_price = it.unit_price or 0
                items.append({
                    "part_no": it.part_no.strip(),
                    "description": it.description.strip(),
                    "maker": it.maker.strip(),
                    "qty": qty,
                    "unit": it.unit or "PCS",
                    "unit_price": unit_price,
                    "amount": it.amount if it.amount is not None else qty * unit_price,
                    "remark": (it.remark or "").strip(),
                })
            order.items = items
        s.commit()
        return {"ok": True, "id": order.id, "project_no": _project_no_for_order(s, order)}
    finally:
        s.close()


@app.delete("/api/admin/orders/{order_id}", dependencies=[Depends(require_token)])
def delete_order(order_id: int):
    """오더 삭제 — 발주서·문서·AR 등 다운스트림이 있으면 데이터 보호를 위해 거부한다."""
    s = get_session()
    try:
        order = s.query(Order).filter_by(id=order_id).first()
        if not order:
            raise HTTPException(status_code=404, detail="오더를 찾을 수 없습니다.")
        if s.query(PurchaseOrder).filter_by(order_id=order_id).first():
            raise HTTPException(status_code=400,
                detail="발주서(Vendor P/O)가 연결된 오더입니다. 먼저 발주서를 삭제하세요.")
        if s.query(CommercialInvoice).filter_by(order_id=order_id).first() or \
           s.query(ShippingAdvice).filter_by(order_id=order_id).first():
            raise HTTPException(status_code=400,
                detail="선적/송장 문서가 연결된 오더입니다. 삭제할 수 없습니다.")
        if s.query(ARRecord).filter_by(order_id=order_id).first():
            raise HTTPException(status_code=400,
                detail="AR(미수금) 기록이 연결된 오더입니다. 삭제할 수 없습니다.")
        project_no = _project_no_for_order(s, order)
        # 연결된 견적 상태(수주확정)는 되돌리지 않는다(별도 화면에서 관리).
        s.query(DeliveryProof).filter_by(order_id=order_id).delete(synchronize_session=False)
        s.query(Order).filter_by(id=order_id).delete(synchronize_session=False)
        s.commit()
        return {"ok": True, "project_no": project_no}
    finally:
        s.close()


@app.post("/api/admin/vendor-pos", dependencies=[Depends(require_token)])
def create_purchase_order(body: PurchaseOrderCreate):
    """Vendor P/O 발신 탭 — 발주서 생성."""
    s = get_session()
    try:
        order = s.query(Order).filter_by(id=body.order_id).first()
        if not order:
            raise HTTPException(status_code=404, detail="오더를 찾을 수 없습니다.")
        vendor = s.query(Vendor).filter_by(id=body.vendor_id).first()
        if not vendor:
            raise HTTPException(status_code=400, detail="Vendor를 선택하세요.")

        items = []
        for it in body.items:
            if not (it.part_no or it.description):
                continue
            qty = it.qty or 1
            unit_price = it.unit_price or 0
            items.append({
                "part_no": it.part_no.strip(),
                "description": it.description.strip(),
                "maker": it.maker.strip(),
                "qty": qty,
                "unit": it.unit or "PCS",
                "unit_price": unit_price,
                "amount": it.amount if it.amount is not None else qty * unit_price,
            })

        # 수동 입력. 비우면 번호 없이 저장(나중에 편집에서 채움).
        po_no = (body.po_no or "").strip() or None
        if po_no and s.query(PurchaseOrder).filter_by(po_no=po_no).first():
            raise HTTPException(status_code=400, detail=f"이미 존재하는 PO No. 입니다: {po_no}")
        po = PurchaseOrder(
            po_no=po_no,
            order_id=order.id,
            vendor_id=vendor.id,
            date=body.date or date.today().isoformat(),
            items=items,
            status="발주완료",
        )
        s.add(po)
        order.status = OrderStatus.PO_SENT
        s.commit()
        return {"ok": True, "id": po.id, "po_no": po.po_no}
    finally:
        s.close()


@app.get("/api/admin/vendor-pos/{po_id}", dependencies=[Depends(require_token)])
def vendor_po_detail(po_id: int):
    """Vendor P/O(발주서) 1건 상세."""
    s = get_session()
    try:
        po = s.query(PurchaseOrder).filter_by(id=po_id).first()
        if not po:
            raise HTTPException(status_code=404, detail="발주서를 찾을 수 없습니다.")
        order = s.query(Order).filter_by(id=po.order_id).first()
        vendor = s.query(Vendor).filter_by(id=po.vendor_id).first()
        rfq = _rfq_for_order(s, order) if order else None
        qtn = s.query(Quotation).filter_by(id=order.quotation_id).first() if order and order.quotation_id else None
        return {
            "id": po.id,
            "po_no": po.po_no or "",
            "order_id": po.order_id,
            "assignee_id": (rfq.created_by or 0) if rfq else 0,
            "customer_po_no": (order.po_no if order else "") or "",
            **_base_meta(s, rfq, order),   # 공통 기본정보
            "vendor_id": po.vendor_id or 0,
            "vendor": vendor.name if vendor else "—",
            "vendor_email": po.sent_to_email or (vendor.email if vendor else "") or "",
            "date": po.date or "",
            "sent_date": po.sent_date or "",
            "status": po.status or "",
            "sent": po.status == "이메일 발송완료",
            "currency": (qtn.currency if qtn else "USD") or "USD",
            "items": [_item_view(it) for it in (po.items or [])],
        }
    finally:
        s.close()


@app.put("/api/admin/vendor-pos/{po_id}", dependencies=[Depends(require_token)])
def update_purchase_order(po_id: int, body: PurchaseOrderUpdate):
    """발주서 수정 — Vendor·발주일·상태·품목 교체."""
    s = get_session()
    try:
        po = s.query(PurchaseOrder).filter_by(id=po_id).first()
        if not po:
            raise HTTPException(status_code=404, detail="발주서를 찾을 수 없습니다.")
        if body.vendor_id is not None:
            po.vendor_id = body.vendor_id
        if body.po_no is not None:
            new_no = body.po_no.strip()
            if new_no and new_no != po.po_no:
                if s.query(PurchaseOrder).filter(PurchaseOrder.po_no == new_no, PurchaseOrder.id != po.id).first():
                    raise HTTPException(status_code=400, detail=f"이미 존재하는 PO No. 입니다: {new_no}")
                po.po_no = new_no
        if body.date is not None:
            po.date = body.date or po.date
        if body.sent_date is not None:
            # 메일 발송 없이도 수동으로 발송일 입력 가능 (빈 값이면 해제)
            po.sent_date = body.sent_date.strip() or None
        if body.status is not None:
            po.status = body.status.strip() or po.status
        if body.items is not None:
            items = []
            for it in body.items:
                if not (it.part_no or it.description):
                    continue
                qty = it.qty or 1
                unit_price = it.unit_price or 0
                items.append({
                    "part_no": it.part_no.strip(),
                    "description": it.description.strip(),
                    "maker": it.maker.strip(),
                    "qty": qty,
                    "unit": it.unit or "PCS",
                    "unit_price": unit_price,
                    "amount": it.amount if it.amount is not None else qty * unit_price,
                    "remark": (it.remark or "").strip(),
                })
            po.items = items
        s.commit()
        return {"ok": True, "id": po.id, "po_no": po.po_no}
    finally:
        s.close()


@app.delete("/api/admin/vendor-pos/{po_id}", dependencies=[Depends(require_token)])
def delete_purchase_order(po_id: int):
    """발주서 삭제."""
    s = get_session()
    try:
        po = s.query(PurchaseOrder).filter_by(id=po_id).first()
        if not po:
            raise HTTPException(status_code=404, detail="발주서를 찾을 수 없습니다.")
        po_no = po.po_no
        s.query(PurchaseOrder).filter_by(id=po_id).delete(synchronize_session=False)
        s.commit()
        return {"ok": True, "po_no": po_no}
    finally:
        s.close()


@app.post("/api/admin/vendor-pos/{po_id}/preview", dependencies=[Depends(require_token)])
def vendor_po_preview(po_id: int, body: VendorPoPreview):
    s = get_session()
    try:
        po = s.query(PurchaseOrder).filter_by(id=po_id).first()
        if not po:
            raise HTTPException(status_code=404, detail="발주서를 찾을 수 없습니다.")
        vendor = s.query(Vendor).filter_by(id=po.vendor_id).first()
        order = s.query(Order).filter_by(id=po.order_id).first()
        vessel = s.query(Vessel).filter_by(id=order.vessel_id).first() if order and order.vessel_id else None
        lang = "ko" if body.lang == "ko" else "en"
        subject = (
            f"[K-MARIS] 발주서 송부 — {po.po_no} / {vessel.name if vessel else po.po_no}"
            if lang == "ko"
            else f"[K-MARIS] Purchase Order — {po.po_no} / {vessel.name if vessel else po.po_no}"
        )
        return {
            "to": (vendor.email if vendor else "") or "",
            "subject": subject,
            "body": _vendor_po_email_body(po, vendor, order, vessel, body.notes, lang, _project_no_for_order(s, order)),
            "pdf_filename": f"{po.po_no}_PurchaseOrder.pdf",
            "smtp_configured": bool(os.getenv("SMTP_USER") and os.getenv("SMTP_PASSWORD")),
        }
    finally:
        s.close()


@app.get("/api/admin/vendor-pos/{po_id}/pdf", dependencies=[Depends(require_token)])
def vendor_po_pdf(po_id: int):
    s = get_session()
    try:
        po = s.query(PurchaseOrder).filter_by(id=po_id).first()
        if not po:
            raise HTTPException(status_code=404, detail="발주서를 찾을 수 없습니다.")
        vendor = s.query(Vendor).filter_by(id=po.vendor_id).first()
        order = s.query(Order).filter_by(id=po.order_id).first()
        vessel = s.query(Vessel).filter_by(id=order.vessel_id).first() if order and order.vessel_id else None
        payload = build_po_payload(
            po_no=po.po_no,
            date=po.date or date.today().isoformat(),
            vendor=vendor,
            vessel=vessel,
            items=po.items or [],
        )
        pdf = generate_po_pdf(payload)
        return Response(
            content=pdf,
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{po.po_no}_PurchaseOrder.pdf"'},
        )
    finally:
        s.close()


@app.post("/api/admin/vendor-pos/{po_id}/send", dependencies=[Depends(require_token)])
def vendor_po_send(po_id: int, body: VendorPoSend):
    s = get_session()
    try:
        po = s.query(PurchaseOrder).filter_by(id=po_id).first()
        if not po:
            raise HTTPException(status_code=404, detail="발주서를 찾을 수 없습니다.")
        if not body.to.strip():
            raise HTTPException(status_code=400, detail="수신자 이메일을 입력하세요.")
        vendor = s.query(Vendor).filter_by(id=po.vendor_id).first()
        order = s.query(Order).filter_by(id=po.order_id).first()
        vessel = s.query(Vessel).filter_by(id=order.vessel_id).first() if order and order.vessel_id else None
        payload = build_po_payload(
            po_no=po.po_no,
            date=po.date or date.today().isoformat(),
            vendor=vendor,
            vessel=vessel,
            items=po.items or [],
        )
        pdf = generate_po_pdf(payload)
        sent = send_email(
            to=body.to.strip(),
            subject=body.subject,
            body=body.body,
            attachments=[(f"{po.po_no}_PurchaseOrder.pdf", pdf)],
        )
        if not sent:
            raise HTTPException(status_code=400, detail="이메일 발송 실패 — SMTP 설정 또는 서버 상태를 확인하세요.")
        po.status = "이메일 발송완료"
        po.sent_to_email = body.to.strip()
        po.sent_date = date.today().isoformat()
        s.commit()
        return {"ok": True, "sent_date": po.sent_date}
    finally:
        s.close()


@app.post("/api/admin/orders/{order_id}/stage/{stage}/complete",
          dependencies=[Depends(require_token)])
def complete_order_stage(order_id: int, stage: int, body: StageCompleteBody):
    """10·11 등 수동 완료 단계를 토글한다. 완료 시 RFQ.stage_dates[stage]=지정 시각(없으면 현재)."""
    if not (1 <= stage <= len(INTERNAL_STEPS)):
        raise HTTPException(status_code=400, detail="잘못된 단계 번호입니다.")
    s = get_session()
    try:
        order = s.query(Order).filter_by(id=order_id).first()
        if not order:
            raise HTTPException(status_code=404, detail="Order를 찾을 수 없습니다.")
        rfq = _rfq_for_order(s, order)
        if not rfq:
            raise HTTPException(status_code=400, detail="연결된 RFQ가 없습니다.")
        dates = dict(getattr(rfq, "stage_dates", None) or {})
        key = str(stage)
        if body.done:
            dates[key] = (body.at or "").strip()[:16] or _kst_iso(datetime.utcnow())
        else:
            dates.pop(key, None)
        rfq.stage_dates = dates
        s.commit()
        return {"ok": True, "stage": _pipeline_stage(s, rfq.id), "done": body.done}
    finally:
        s.close()


@app.get("/api/admin/vendor-po-overview", dependencies=[Depends(require_token)])
def vendor_po_overview():
    """Vendor P/O 발신 내역 — PurchaseOrder 1건당 1행(생성·발송 포함 전체)."""
    s = get_session()
    try:
        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}
        ord_map = {o.id: o for o in s.query(Order).all()}
        cust_names = {c.id: c.name for c in s.query(Customer).all()}

        rows = []
        for po in s.query(PurchaseOrder).order_by(PurchaseOrder.id.desc()).all():
            o = ord_map.get(po.order_id)
            rows.append({
                "id": po.id,
                "po_no": po.po_no or "",
                "customer": cust_names.get(o.customer_id, "—") if o else "—",
                "vendor": vendor_names.get(po.vendor_id, "—"),
                "vendor_email": po.sent_to_email or "",
                "date": po.date or "",
                "sent_date": po.sent_date or "",
                "status": po.status or "",
                "item_count": len(po.items or []),
                "sent": (po.status == "이메일 발송완료"),
            })
        return {"rows": rows}
    finally:
        s.close()
