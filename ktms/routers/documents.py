"""K-Maris TMS — documents routes (split from admin_api.py; behavior unchanged)."""
from __future__ import annotations

from _core import (
    ARRecord,
    ARStatus,
    CommercialInvoice,
    CommercialInvoiceSave,
    Customer,
    DeliveryProof,
    Depends,
    DocumentMilestoneUpdate,
    File,
    HTTPException,
    Order,
    PackingList,
    PackingListSave,
    PurchaseOrder,
    Response,
    ServiceStageSave,
    ShippingAdvice,
    ShippingAdviceSave,
    ShippingAdviceSend,
    TaxInvoiceData,
    TaxInvoiceSave,
    UploadFile,
    User,
    Vendor,
    Vessel,
    _customer_for_order,
    _doc_file_response,
    _document_detail_payload,
    _enum_val,
    _first_rfq_iso,
    _kst_iso,
    _latest_ci,
    _latest_pl,
    _latest_sa,
    _latest_tax,
    _manual_doc_no,
    _project_no_for_order,
    _project_no_map,
    _rfq_for_order,
    _total_amount,
    _tracking_url,
    _vessel_for_order,
    app,
    build_payload,
    date,
    datetime,
    generate_pdf,
    generate_tax_xlsx,
    get_session,
    require_token,
    send_email,
    shipping_advice_email_body,
)



@app.get("/api/admin/documents-overview", dependencies=[Depends(require_token)])
def documents_overview():
    """문서 현황 — 오더별 CI/PL/SA/Tax 생성 여부와 문서번호."""
    s = get_session()
    try:
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        vessel_names = {v.id: v.name for v in s.query(Vessel).all()}
        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}
        user_names = {u.id: u.username for u in s.query(User).all()}
        # order_id → 발주 Vendor 이름들(중복 제거, 발주 순). 표시는 첫 벤더 + 외 N곳.
        po_vendors_by_order: dict[int, list[str]] = {}
        for po in s.query(PurchaseOrder).order_by(PurchaseOrder.id).all():
            nm = vendor_names.get(po.vendor_id)
            if not nm:
                continue
            lst = po_vendors_by_order.setdefault(po.order_id, [])
            if nm not in lst:
                lst.append(nm)

        # ci_id → pl/tax 존재 매핑
        ci_by_order: dict[int, CommercialInvoice] = {}
        for ci in s.query(CommercialInvoice).all():
            # 오더당 최신 CI 1건
            if ci.order_id not in ci_by_order or ci.id > ci_by_order[ci.order_id].id:
                ci_by_order[ci.order_id] = ci
        pl_ci_ids = {pl.ci_id for pl in s.query(PackingList).all()}
        pl_no_by_ci = {pl.ci_id: pl.pl_no for pl in s.query(PackingList).all()}
        tax_ci_ids = {tx.ci_id for tx in s.query(TaxInvoiceData).all()}
        tax_no_by_ci = {tx.ci_id: tx.tax_no for tx in s.query(TaxInvoiceData).all()}
        sa_by_order: dict[int, ShippingAdvice] = {}
        for sa in s.query(ShippingAdvice).all():
            if sa.order_id not in sa_by_order or sa.id > sa_by_order[sa.order_id].id:
                sa_by_order[sa.order_id] = sa
        pod_by_order: dict[int, DeliveryProof] = {}
        for pod in s.query(DeliveryProof).all():
            if pod.order_id not in pod_by_order or pod.id > pod_by_order[pod.order_id].id:
                pod_by_order[pod.order_id] = pod

        rows = []
        for o in s.query(Order).order_by(Order.id.desc()).all():
            ci = ci_by_order.get(o.id)
            sa = sa_by_order.get(o.id)
            pod = pod_by_order.get(o.id)
            ci_id = ci.id if ci else None
            # 업무타입(서비스)·서비스 단계(7·8 수동완료) 상태 — RFQ.stage_dates 기준
            rfq = _rfq_for_order(s, o)
            wt = _enum_val(rfq.work_type) if (rfq and rfq.work_type) else "부품공급"
            sd = (getattr(rfq, "stage_dates", None) or {}) if rfq else {}
            svc = getattr(o, "service_info", None) or {}
            rows.append({
                "id": o.id,
                "customer": cust_names.get(o.customer_id, "—"),
                "project_title": (getattr(rfq, "project_title", None) or "") if rfq else "",
                "contact_person": (getattr(rfq, "contact_person", None) or "") if rfq else "",
                "assignee": (user_names.get(rfq.created_by, "") or "") if rfq else "",
                "assignee_id": (rfq.created_by or 0) if rfq else 0,
                "vessel": vessel_names.get(o.vessel_id, "") if o.vessel_id else "",
                "po_no": o.po_no or "",
                "trade_type": o.trade_type or "수출",
                "work_type": wt,
                "vendor": (lambda v: (v[0] + (f"  (외 {len(v) - 1}곳)" if len(v) > 1 else "")) if v else "")(po_vendors_by_order.get(o.id, [])),
                "first_rfq_at": _first_rfq_iso(rfq),
                "project_no": _project_no_map(s).get(rfq.id, "") if rfq else "",
                "ci_no": ci.ci_no if ci else "",
                "pl_no": pl_no_by_ci.get(ci_id, "") if ci_id else "",
                "sa_no": sa.sa_no if sa else "",
                "sa_sent_date": (sa.sent_date or "") if sa else "",
                "tax_no": tax_no_by_ci.get(ci_id, "") if ci_id else "",
                "pod_filename": (pod.filename or "") if pod else "",
                "has_ci": bool(ci),
                "has_pl": bool(ci_id and ci_id in pl_ci_ids),
                "has_sa": bool(sa),
                "has_pod": bool(pod),
                "has_tax": bool(ci_id and ci_id in tax_ci_ids),
                # 서비스 단계 수동 완료 상태(7). 8(Complete·Report)은 has_pod, 9(Billing)은 svc_billed.
                "svc_ready_done": bool(sd.get("7")),
                "svc_billed": bool(svc.get("9")),
            })
        return {"rows": rows}
    finally:
        s.close()


@app.get("/api/admin/documents/{order_id}", dependencies=[Depends(require_token)])
def document_detail(order_id: int):
    s = get_session()
    try:
        order = s.query(Order).filter_by(id=order_id).first()
        if not order:
            raise HTTPException(status_code=404, detail="Order瑜?李얠쓣 ???놁뒿?덈떎.")
        return _document_detail_payload(s, order)
    finally:
        s.close()


@app.post("/api/admin/documents/{order_id}/service",
          dependencies=[Depends(require_token)])
def save_service_stage(order_id: int, body: ServiceStageSave):
    """서비스 업무 7~9단계 입력값 저장 + 단계 완료 처리.
    7·8 은 RFQ.stage_dates 로 완료, 9 는 청구내역으로 AR 레코드를 생성/갱신한다."""
    if body.stage not in (7, 8, 9):
        raise HTTPException(status_code=400, detail="잘못된 서비스 단계입니다.")
    s = get_session()
    try:
        order = s.query(Order).filter_by(id=order_id).first()
        if not order:
            raise HTTPException(status_code=404, detail="Order를 찾을 수 없습니다.")
        info = dict(getattr(order, "service_info", None) or {})
        info[str(body.stage)] = body.data
        order.service_info = info

        if body.stage in (7, 8):
            rfq = _rfq_for_order(s, order)
            if rfq:
                dates = dict(getattr(rfq, "stage_dates", None) or {})
                if body.complete:
                    dates[str(body.stage)] = _kst_iso(datetime.utcnow())
                else:
                    dates.pop(str(body.stage), None)
                rfq.stage_dates = dates
        elif body.stage == 9 and body.complete:
            def _f(v) -> float:
                try:
                    return float(v or 0)
                except (TypeError, ValueError):
                    return 0.0
            d = body.data or {}
            service_items = d.get("items") if isinstance(d.get("items"), list) else []
            total = _total_amount(service_items) + sum(_f(d.get(k)) for k in ("labor_cost", "travel_cost", "material_cost", "other_cost"))
            ar = s.query(ARRecord).filter_by(order_id=order.id).first()
            if not ar:
                ar = ARRecord(order_id=order.id, ci_no="",
                              invoice_amount=total, paid_amount=0.0,
                              currency=d.get("currency", "USD"),
                              status=ARStatus.OUTSTANDING)
                s.add(ar)
            else:
                ar.invoice_amount = total
                ar.currency = d.get("currency", "USD")
        s.commit()
        return {"ok": True}
    finally:
        s.close()


@app.delete("/api/admin/documents/{order_id}/service/{stage}",
            dependencies=[Depends(require_token)])
def delete_service_stage(order_id: int, stage: int):
    """서비스 단계 입력값 삭제 + 완료 해제. 9단계는 연결 AR 레코드도 삭제한다."""
    if stage not in (7, 8, 9):
        raise HTTPException(status_code=400, detail="잘못된 서비스 단계입니다.")
    s = get_session()
    try:
        order = s.query(Order).filter_by(id=order_id).first()
        if not order:
            raise HTTPException(status_code=404, detail="Order를 찾을 수 없습니다.")
        info = dict(getattr(order, "service_info", None) or {})
        info.pop(str(stage), None)
        order.service_info = info
        if stage in (7, 8):
            rfq = _rfq_for_order(s, order)
            if rfq:
                dates = dict(getattr(rfq, "stage_dates", None) or {})
                dates.pop(str(stage), None)
                rfq.stage_dates = dates
        if stage == 9:
            s.query(ARRecord).filter_by(order_id=order.id).delete(synchronize_session=False)
        s.commit()
        return {"ok": True}
    finally:
        s.close()


@app.post("/api/admin/documents/{order_id}/milestone",
          dependencies=[Depends(require_token)])
def document_milestone(order_id: int, body: DocumentMilestoneUpdate):
    if body.field not in {"consignee_confirmed_date", "vendor_docs_sent_date"}:
        raise HTTPException(status_code=400, detail="Invalid milestone field")
    s = get_session()
    try:
        order = s.query(Order).filter_by(id=order_id).first()
        if not order:
            raise HTTPException(status_code=404, detail="Order瑜?李얠쓣 ???놁뒿?덈떎.")
        setattr(order, body.field, date.today().isoformat() if body.value else None)
        s.commit()
        return {"ok": True, "value": getattr(order, body.field) or ""}
    finally:
        s.close()


@app.post("/api/admin/documents/{order_id}/ci",
          dependencies=[Depends(require_token)])
def save_commercial_invoice(order_id: int, body: CommercialInvoiceSave):
    s = get_session()
    try:
        order = s.query(Order).filter_by(id=order_id).first()
        if not order:
            raise HTTPException(status_code=404, detail="Order瑜?李얠쓣 ???놁뒿?덈떎.")
        ci = _latest_ci(s, order_id)
        if not ci:
            ci = CommercialInvoice(
                ci_no=_manual_doc_no(s, CommercialInvoice, "ci_no", body.ci_no, None),
                order_id=order.id,
                date=body.date or date.today().isoformat(),
            )
            s.add(ci)
        elif body.ci_no is not None:
            ci.ci_no = _manual_doc_no(s, CommercialInvoice, "ci_no", body.ci_no, ci.id)
        ci.date = body.date or ci.date or date.today().isoformat()
        ci.currency = body.currency or "USD"
        ci.vat_rate = body.vat_rate or 0.0
        ci.items = body.items or []
        ci.shipping = body.shipping or {}
        s.commit()
        return {"ok": True, "id": ci.id, "ci_no": ci.ci_no}
    finally:
        s.close()


@app.get("/api/admin/documents/{order_id}/ci/pdf",
         dependencies=[Depends(require_token)])
def commercial_invoice_pdf(order_id: int):
    s = get_session()
    try:
        order = s.query(Order).filter_by(id=order_id).first()
        ci = _latest_ci(s, order_id) if order else None
        if not order or not ci:
            raise HTTPException(status_code=404, detail="Commercial Invoice瑜?李얠쓣 ???놁뒿?덈떎.")
        payload = build_payload(
            doc_no=ci.ci_no, date=ci.date,
            customer=_customer_for_order(s, order),
            vessel=_vessel_for_order(s, order),
            items=ci.items or [], terms=ci.terms or {},
            currency=ci.currency or "USD", vat_rate=ci.vat_rate or 0.0,
            shipping=ci.shipping or {}, po_no=order.po_no or "",
            export_ref=_project_no_for_order(s, order),
        )
        pdf = generate_pdf("commercial_invoice", payload)
        return _doc_file_response(pdf, f"{ci.ci_no}_CI.pdf", "application/pdf")
    finally:
        s.close()


@app.delete("/api/admin/documents/{order_id}/ci",
            dependencies=[Depends(require_token)])
def delete_commercial_invoice(order_id: int):
    """Commercial Invoice 삭제. 하위 Packing List 는 함께 삭제(CI 없이는 존재 불가).
    다운스트림 세금계산서(9단계)가 있으면 막는다 — 먼저 그걸 삭제해야 한다."""
    s = get_session()
    try:
        ci = _latest_ci(s, order_id)
        if not ci:
            raise HTTPException(status_code=404, detail="Commercial Invoice가 없습니다.")
        if s.query(TaxInvoiceData).filter_by(ci_id=ci.id).first():
            raise HTTPException(status_code=400,
                detail="세금계산서가 있어 삭제할 수 없습니다. 먼저 9단계 세금계산서를 삭제하세요.")
        # 하위 Packing List 를 CI 삭제보다 먼저 DB 에 반영해야 FK 제약(Postgres)에 안 걸린다.
        s.query(PackingList).filter_by(ci_id=ci.id).delete(synchronize_session=False)
        s.flush()
        s.delete(ci)
        s.commit()
        return {"ok": True}
    finally:
        s.close()


@app.post("/api/admin/documents/{order_id}/pl",
          dependencies=[Depends(require_token)])
def save_packing_list(order_id: int, body: PackingListSave):
    s = get_session()
    try:
        order = s.query(Order).filter_by(id=order_id).first()
        ci = _latest_ci(s, order_id) if order else None
        if not order or not ci:
            raise HTTPException(status_code=400, detail="먼저 Commercial Invoice를 생성하세요.")
        pl = _latest_pl(s, ci.id)
        if not pl:
            pl = PackingList(
                pl_no=_manual_doc_no(s, PackingList, "pl_no", body.pl_no, None),
                ci_id=ci.id,
                date=body.date or date.today().isoformat(),
            )
            s.add(pl)
        elif body.pl_no is not None:
            pl.pl_no = _manual_doc_no(s, PackingList, "pl_no", body.pl_no, pl.id)
        pl.date = body.date or pl.date or date.today().isoformat()
        pl.items = body.items or []
        s.commit()
        return {"ok": True, "id": pl.id, "pl_no": pl.pl_no}
    finally:
        s.close()


@app.get("/api/admin/documents/{order_id}/pl/pdf",
         dependencies=[Depends(require_token)])
def packing_list_pdf(order_id: int):
    s = get_session()
    try:
        order = s.query(Order).filter_by(id=order_id).first()
        ci = _latest_ci(s, order_id) if order else None
        pl = _latest_pl(s, ci.id if ci else None)
        if not order or not ci or not pl:
            raise HTTPException(status_code=404, detail="Packing List瑜?李얠쓣 ???놁뒿?덈떎.")
        payload = build_payload(
            doc_no=pl.pl_no, date=pl.date,
            customer=_customer_for_order(s, order),
            vessel=_vessel_for_order(s, order),
            items=pl.items or [], terms={},
            currency=ci.currency or "USD",
            shipping=ci.shipping or {}, po_no=order.po_no or "",
            export_ref=_project_no_for_order(s, order),
        )
        pdf = generate_pdf("packing_list", payload)
        return _doc_file_response(pdf, f"{pl.pl_no}_PL.pdf", "application/pdf")
    finally:
        s.close()


@app.delete("/api/admin/documents/{order_id}/pl",
            dependencies=[Depends(require_token)])
def delete_packing_list(order_id: int):
    s = get_session()
    try:
        ci = _latest_ci(s, order_id)
        pl = _latest_pl(s, ci.id if ci else None)
        if not pl:
            raise HTTPException(status_code=404, detail="Packing List가 없습니다.")
        s.delete(pl)
        s.commit()
        return {"ok": True}
    finally:
        s.close()


@app.post("/api/admin/documents/{order_id}/sa",
          dependencies=[Depends(require_token)])
def save_shipping_advice(order_id: int, body: ShippingAdviceSave):
    s = get_session()
    try:
        order = s.query(Order).filter_by(id=order_id).first()
        if not order:
            raise HTTPException(status_code=404, detail="Order瑜?李얠쓣 ???놁뒿?덈떎.")
        sa = _latest_sa(s, order_id)
        if not sa:
            sa = ShippingAdvice(
                sa_no=_manual_doc_no(s, ShippingAdvice, "sa_no", body.sa_no, None),
                order_id=order.id,
                date=body.date or date.today().isoformat(),
            )
            s.add(sa)
        elif body.sa_no is not None:
            sa.sa_no = _manual_doc_no(s, ShippingAdvice, "sa_no", body.sa_no, sa.id)
        sa.date = body.date or sa.date or date.today().isoformat()
        sa.shipping = body.shipping or {}
        s.commit()
        return {"ok": True, "id": sa.id, "sa_no": sa.sa_no}
    finally:
        s.close()


@app.get("/api/admin/documents/{order_id}/sa/pdf",
         dependencies=[Depends(require_token)])
def shipping_advice_pdf(order_id: int):
    s = get_session()
    try:
        order = s.query(Order).filter_by(id=order_id).first()
        sa = _latest_sa(s, order_id) if order else None
        ci = _latest_ci(s, order_id) if order else None
        if not order or not sa:
            raise HTTPException(status_code=404, detail="Shipping Advice瑜?李얠쓣 ???놁뒿?덈떎.")
        payload = build_payload(
            doc_no=sa.sa_no, date=sa.date,
            customer=_customer_for_order(s, order),
            vessel=_vessel_for_order(s, order),
            items=(ci.items if ci else order.items) or [], terms={},
            currency=(ci.currency if ci else "USD") or "USD",
            shipping=sa.shipping or {}, po_no=order.po_no or "",
            export_ref=_project_no_for_order(s, order),
        )
        pdf = generate_pdf("shipping_advice", payload)
        return _doc_file_response(pdf, f"{sa.sa_no}_SA.pdf", "application/pdf")
    finally:
        s.close()


@app.delete("/api/admin/documents/{order_id}/sa",
            dependencies=[Depends(require_token)])
def delete_shipping_advice(order_id: int):
    s = get_session()
    try:
        sa = _latest_sa(s, order_id)
        if not sa:
            raise HTTPException(status_code=404, detail="Shipping Advice가 없습니다.")
        s.delete(sa)
        s.commit()
        return {"ok": True}
    finally:
        s.close()


@app.post("/api/admin/documents/{order_id}/sa/send",
          dependencies=[Depends(require_token)])
def send_shipping_advice(order_id: int, body: ShippingAdviceSend):
    s = get_session()
    try:
        order = s.query(Order).filter_by(id=order_id).first()
        sa = _latest_sa(s, order_id) if order else None
        ci = _latest_ci(s, order_id) if order else None
        if not order or not sa:
            raise HTTPException(status_code=404, detail="Shipping Advice瑜?李얠쓣 ???놁뒿?덈떎.")
        cust = _customer_for_order(s, order)
        payload = build_payload(
            doc_no=sa.sa_no, date=sa.date, customer=cust,
            vessel=_vessel_for_order(s, order),
            items=(ci.items if ci else order.items) or [], terms={},
            currency=(ci.currency if ci else "USD") or "USD",
            shipping=sa.shipping or {}, po_no=order.po_no or "",
            export_ref=_project_no_for_order(s, order),
        )
        pdf = generate_pdf("shipping_advice", payload)
        subject = body.subject or f"[K-MARIS] Shipping Advice {sa.sa_no}"
        mail_body = body.body or shipping_advice_email_body(
            cust.name if cust else "Customer", sa.sa_no,
            _tracking_url("order", order.tracking_token),
        )
        ok = send_email(body.to, subject, mail_body, [(f"{sa.sa_no}_SA.pdf", pdf)])
        if ok:
            sa.sent_date = date.today().isoformat()
            s.commit()
        return {"ok": ok, "sent_date": sa.sent_date or ""}
    finally:
        s.close()


@app.post("/api/admin/documents/{order_id}/tax",
          dependencies=[Depends(require_token)])
def save_tax_invoice(order_id: int, body: TaxInvoiceSave):
    s = get_session()
    try:
        order = s.query(Order).filter_by(id=order_id).first()
        ci = _latest_ci(s, order_id) if order else None
        if not order or not ci:
            raise HTTPException(status_code=400, detail="먼저 Commercial Invoice를 생성하세요.")
        tax = _latest_tax(s, ci.id)
        if not tax:
            tax = TaxInvoiceData(
                tax_no=_manual_doc_no(s, TaxInvoiceData, "tax_no", body.tax_no, None),
                ci_id=ci.id,
                date=body.date or date.today().isoformat(),
            )
            s.add(tax)
        elif body.tax_no is not None:
            tax.tax_no = _manual_doc_no(s, TaxInvoiceData, "tax_no", body.tax_no, tax.id)
        tax.date = body.date or tax.date or date.today().isoformat()
        tax.items = body.items or ci.items or []

        ar = s.query(ARRecord).filter_by(order_id=order.id, ci_no=ci.ci_no).first()
        invoice_amount = _total_amount(tax.items or [])
        if not ar:
            ar = ARRecord(
                order_id=order.id,
                ci_no=ci.ci_no,
                invoice_amount=invoice_amount,
                paid_amount=0.0,
                currency=ci.currency or "USD",
                status=ARStatus.OUTSTANDING,
            )
            s.add(ar)
        else:
            ar.invoice_amount = invoice_amount
            ar.currency = ci.currency or "USD"
        s.commit()
        return {"ok": True, "id": tax.id, "tax_no": tax.tax_no, "ar_id": ar.id}
    finally:
        s.close()


@app.get("/api/admin/documents/{order_id}/tax/xlsx",
         dependencies=[Depends(require_token)])
def tax_invoice_xlsx(order_id: int):
    s = get_session()
    try:
        order = s.query(Order).filter_by(id=order_id).first()
        ci = _latest_ci(s, order_id) if order else None
        tax = _latest_tax(s, ci.id if ci else None)
        if not order or not ci or not tax:
            raise HTTPException(status_code=404, detail="Tax Invoice Data瑜?李얠쓣 ???놁뒿?덈떎.")
        cust = _customer_for_order(s, order)
        payload = build_payload(
            doc_no=tax.tax_no, date=tax.date,
            customer=cust,
            vessel=_vessel_for_order(s, order),
            items=tax.items or [], terms={},
            currency="KRW", vat_rate=0.0,
            tax_invoice={
                "issue_date": tax.date,
                "supply_type": "Export / Zero-rated",
                "buyer_business_no": cust.tax_id if cust else "",
            },
        )
        xlsx = generate_tax_xlsx(payload)
        return _doc_file_response(
            xlsx,
            f"{tax.tax_no}_tax_invoice.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
    finally:
        s.close()


# ── 9) 운송 완료 · POD 수취 — 인도 증빙(POD) 파일 ───────────────────────────────
@app.post("/api/admin/documents/{order_id}/pod", dependencies=[Depends(require_token)])
def upload_pod(order_id: int, file: UploadFile = File(...)):
    """POD(인도 증빙) 파일 업로드 — 오더당 1건(기존 파일 교체). 업로드 시 9단계 완료."""
    s = get_session()
    try:
        order = s.query(Order).filter_by(id=order_id).first()
        if not order:
            raise HTTPException(status_code=404, detail="Order를 찾을 수 없습니다.")
        file.file.seek(0)
        data = file.file.read()
        if not data:
            raise HTTPException(status_code=400, detail="빈 파일입니다.")
        s.query(DeliveryProof).filter_by(order_id=order_id).delete()
        proof = DeliveryProof(
            order_id=order_id,
            filename=file.filename or "POD",
            mime=file.content_type or "application/octet-stream",
            data=data,
            uploaded_at=_kst_iso(datetime.utcnow()),
        )
        s.add(proof)
        s.commit()
        return {"ok": True, "filename": proof.filename, "uploaded_at": proof.uploaded_at}
    finally:
        s.close()


@app.get("/api/admin/documents/{order_id}/pod/file", dependencies=[Depends(require_token)])
def download_pod(order_id: int):
    s = get_session()
    try:
        proof = (s.query(DeliveryProof).filter_by(order_id=order_id)
                 .order_by(DeliveryProof.created_at.desc()).first())
        if not proof or not proof.data:
            raise HTTPException(status_code=404, detail="POD 파일이 없습니다.")
        return Response(
            content=proof.data,
            media_type=proof.mime or "application/octet-stream",
            headers={"Content-Disposition": f'attachment; filename="{proof.filename or "POD"}"'},
        )
    finally:
        s.close()


@app.delete("/api/admin/documents/{order_id}/pod", dependencies=[Depends(require_token)])
def delete_pod(order_id: int):
    s = get_session()
    try:
        n = s.query(DeliveryProof).filter_by(order_id=order_id).delete()
        s.commit()
        return {"ok": True, "deleted": n}
    finally:
        s.close()
