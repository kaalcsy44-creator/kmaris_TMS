"""K-Maris TMS — sourcing routes (split from admin_api.py; behavior unchanged)."""
from __future__ import annotations

from _core import (
    Customer,
    Depends,
    _deal_identity,
    File,
    HTTPException,
    RFQ,
    RFQStatus,
    Response,
    UploadFile,
    User,
    Vendor,
    VendorQuote,
    VendorQuoteCreate,
    VendorQuoteUpdate,
    VendorRFQ,
    VendorRfqCreate,
    VendorRfqPreviewRequest,
    VendorRfqSendRequest,
    VendorRfqUpdate,
    VendorRfqXlsxRequest,
    VendorRfqEmailPreviewReq,
    VendorRfqEmailSendReq,
    Vessel,
    _assign_rfq_no,
    build_po_payload,
    generate_pdf,
    send_email,
    _base_meta,
    _date_iso,
    _enum_val,
    _first_rfq_iso,
    _item_view,
    _kst_iso,
    _ocr_image_media_type,
    _pipeline_stage,
    _project_no_map,
    _rfq_no_disp,
    _sanitize_vendor_rfq_items,
    _status_label,
    _vendor_rfq_email_body,
    app,
    date,
    datetime,
    excel_to_text,
    extract_text_from_pdf,
    get_session,
    io,
    make_vendor_rfq_quote_xlsx,
    os,
    parse_vendor_quote_bytes,
    parse_vendor_quote_image,
    parse_vendor_quote_pdf_document,
    parse_vendor_quote_text,
    require_token,
    text,
)



@app.get("/api/admin/vrfq-overview", dependencies=[Depends(require_token)])
def vrfq_overview():
    """Vendor RFQ 발신 내역 — VendorRFQ 1건당 1행(고객 RFQ·Vendor·수신 견적 수)."""
    s = get_session()
    try:
        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}
        vendor_emails = {v.id: (v.email or "") for v in s.query(Vendor).all()}
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        vessel_names = {v.id: v.name for v in s.query(Vessel).all()}
        user_names = {u.id: u.username for u in s.query(User).all()}
        rfq_map = {r.id: r for r in s.query(RFQ).all()}

        quote_counts: dict[int, int] = {}
        for vq in s.query(VendorQuote).all():
            quote_counts[vq.vendor_rfq_id] = quote_counts.get(vq.vendor_rfq_id, 0) + 1

        rows = []
        for vr in s.query(VendorRFQ).order_by(VendorRFQ.id.desc()).all():
            rfq = rfq_map.get(vr.rfq_id)
            rows.append({
                "id": vr.id,
                "rfq_id": vr.rfq_id,
                # 고객 RFQ No.는 1단계의 고객 참조번호(없으면 "—"). K-Maris RFQ No.가 아님.
                "customer_rfq_no": (rfq.customer_rfq_no or "—") if rfq else "—",
                "vendor": vendor_names.get(vr.vendor_id, "—"),
                "vendor_email": vr.sent_to_email or vendor_emails.get(vr.vendor_id, "") or "",
                "sent_date": vr.sent_date or "",
                "status": vr.status or "",
                "item_count": len(vr.items or []),
                "quote_count": quote_counts.get(vr.id, 0),
                # 공통 식별 컬럼(Deal identity)
                **_deal_identity(s, rfq, cust_names=cust_names,
                                 vessel_names=vessel_names, user_names=user_names),
            })
        return {"rows": rows}
    finally:
        s.close()


@app.get("/api/admin/vendor-quote-overview", dependencies=[Depends(require_token)])
def vendor_quote_overview():
    """Vendor Quote 수신 내역 — VendorQuote 1건당 1행(전체 프로젝트)."""
    s = get_session()
    try:
        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        vessel_names = {v.id: v.name for v in s.query(Vessel).all()}
        user_names = {u.id: u.username for u in s.query(User).all()}
        rfq_map = {r.id: r for r in s.query(RFQ).all()}
        # vendor_rfq_id → (rfq_id, vendor_id, vrfq_no)
        vrfq_map = {vr.id: vr for vr in s.query(VendorRFQ).all()}

        rows = []
        for q in s.query(VendorQuote).order_by(VendorQuote.id.desc()).all():
            vr = vrfq_map.get(q.vendor_rfq_id)
            rfq = rfq_map.get(vr.rfq_id) if vr else None
            items = q.items or []
            amount = 0.0
            for it in items:
                amt = it.get("amount")
                if amt is None:
                    amt = float(it.get("cost_price", 0) or 0) * float(it.get("qty", 1) or 1)
                amount += float(amt or 0)
            rows.append({
                "id": q.id,
                "rfq_id": vr.rfq_id if vr else None,
                "vendor_quote_no": getattr(q, "vendor_quote_no", None) or "—",
                "customer_rfq_no": (rfq.customer_rfq_no or "—") if rfq else "—",
                "vendor": vendor_names.get(vr.vendor_id, "—") if vr else "—",
                "received_at": getattr(q, "received_at", None) or "",
                "received_date": q.received_date or "",
                "item_count": len(items),
                "amount": round(amount, 2),
                "currency": getattr(q, "currency", None) or "USD",
                # 공통 식별 컬럼(Deal identity)
                **_deal_identity(s, rfq, cust_names=cust_names,
                                 vessel_names=vessel_names, user_names=user_names),
                "status": (_status_label(_pipeline_stage(s, rfq.id), rfq.work_type) if rfq else ""),
            })
        return {"rows": rows}
    finally:
        s.close()


@app.post("/api/admin/rfq/{rfq_id}/vendor-rfq-preview",
          dependencies=[Depends(require_token)])
def vendor_rfq_preview(rfq_id: int, body: VendorRfqPreviewRequest):
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            raise HTTPException(status_code=404, detail="RFQ를 찾을 수 없습니다.")
        # Vendor RFQ 발신 단계 진입 시 케이마리스 RFQ No. 부여(미발급이면).
        _assign_rfq_no(s, rfq, body.rfq_no_mode, body.rfq_no)
        s.commit()
        cust = s.query(Customer).filter_by(id=rfq.customer_id).first()
        vessel = s.query(Vessel).filter_by(id=rfq.vessel_id).first() if rfq.vessel_id else None
        lang = "ko" if body.lang == "ko" else "en"
        items = _sanitize_vendor_rfq_items(body.items) if body.items is not None else None
        previews = []
        for vid in body.vendor_ids:
            vendor = s.query(Vendor).filter_by(id=vid).first()
            if not vendor:
                continue
            safe_vname = "".join(c for c in vendor.name if c.isalnum() or c in "._- ")[:40]
            previews.append({
                "vendor_id": vendor.id,
                "vendor_name": vendor.name,
                "to": vendor.email or "",
                "subject": (
                    f"[K-MARIS] 견적 요청 — {rfq.rfq_no} / {vessel.name if vessel else rfq.rfq_no}"
                    if lang == "ko"
                    else f"[K-MARIS] Inquiry — {rfq.rfq_no} / {vessel.name if vessel else rfq.rfq_no}"
                ),
                "body": _vendor_rfq_email_body(rfq, cust, vessel, vendor, body.notes, lang, items),
                "xlsx_filename": f"{rfq.rfq_no}_VendorQuoteSheet_{safe_vname}.xlsx",
            })
        return {
            "previews": previews,
            "smtp_configured": bool(os.getenv("SMTP_USER") and os.getenv("SMTP_PASSWORD")),
        }
    finally:
        s.close()


@app.get("/api/admin/rfq/{rfq_id}/vendor-rfq-xlsx/{vendor_id}",
         dependencies=[Depends(require_token)])
def vendor_rfq_xlsx(rfq_id: int, vendor_id: int):
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            raise HTTPException(status_code=404, detail="RFQ를 찾을 수 없습니다.")
        vendor = s.query(Vendor).filter_by(id=vendor_id).first()
        if not vendor:
            raise HTTPException(status_code=404, detail="Vendor를 찾을 수 없습니다.")
        cust = s.query(Customer).filter_by(id=rfq.customer_id).first()
        vessel = s.query(Vessel).filter_by(id=rfq.vessel_id).first() if rfq.vessel_id else None
        xlsx = make_vendor_rfq_quote_xlsx(
            rfq_no=rfq.rfq_no,
            vessel_name=vessel.name if vessel else "—",
            customer_name=cust.name if cust else "—",
            enquiry_date=rfq.date or date.today().isoformat(),
            vendor_name=vendor.name,
            items=rfq.items or [],
        )
        safe_vname = "".join(c for c in vendor.name if c.isalnum() or c in "._- ")[:40]
        filename = f"{rfq.rfq_no}_VendorQuoteSheet_{safe_vname}.xlsx"
        return Response(
            content=xlsx,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    finally:
        s.close()


@app.post("/api/admin/rfq/{rfq_id}/vendor-rfq-xlsx/{vendor_id}",
          dependencies=[Depends(require_token)])
def vendor_rfq_xlsx_post(rfq_id: int, vendor_id: int, body: VendorRfqXlsxRequest):
    """XLSX 견적 양식 — 발신 화면에서 선택·편집한 품목을 반영해 생성(POST)."""
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            raise HTTPException(status_code=404, detail="RFQ를 찾을 수 없습니다.")
        vendor = s.query(Vendor).filter_by(id=vendor_id).first()
        if not vendor:
            raise HTTPException(status_code=404, detail="Vendor를 찾을 수 없습니다.")
        cust = s.query(Customer).filter_by(id=rfq.customer_id).first()
        vessel = s.query(Vessel).filter_by(id=rfq.vessel_id).first() if rfq.vessel_id else None
        items = (_sanitize_vendor_rfq_items(body.items)
                 if body.items is not None else (rfq.items or []))
        xlsx = make_vendor_rfq_quote_xlsx(
            rfq_no=rfq.rfq_no,
            vessel_name=vessel.name if vessel else "—",
            customer_name=cust.name if cust else "—",
            enquiry_date=rfq.date or date.today().isoformat(),
            vendor_name=vendor.name,
            items=items,
        )
        safe_vname = "".join(c for c in vendor.name if c.isalnum() or c in "._- ")[:40]
        filename = f"{rfq.rfq_no}_VendorQuoteSheet_{safe_vname}.xlsx"
        return Response(
            content=xlsx,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    finally:
        s.close()


# ── Vendor RFQ 1건(단일 벤더) 문서 생성 + 이메일 발송 — 상세편집 DocSendPanel용 ──
def _vrfq_ctx(s, vrfq_id: int):
    """VendorRFQ 1건의 rfq/vendor/customer/vessel/rfq_no/items 를 한 번에 로드."""
    vr = s.query(VendorRFQ).filter_by(id=vrfq_id).first()
    if not vr:
        raise HTTPException(status_code=404, detail="Vendor RFQ를 찾을 수 없습니다.")
    rfq = s.query(RFQ).filter_by(id=vr.rfq_id).first()
    vendor = s.query(Vendor).filter_by(id=vr.vendor_id).first()
    cust = s.query(Customer).filter_by(id=rfq.customer_id).first() if rfq else None
    vessel = s.query(Vessel).filter_by(id=rfq.vessel_id).first() if rfq and rfq.vessel_id else None
    rfq_no = _rfq_no_disp(rfq.rfq_no) if rfq else "RFQ"
    items = vr.items or (rfq.items if rfq else []) or []
    safe = "".join(c for c in (vendor.name if vendor else "vendor") if c.isalnum() or c in "._- ")[:40]
    return vr, rfq, vendor, cust, vessel, rfq_no, items, safe


@app.get("/api/admin/vendor-rfq/{vrfq_id}/pdf", dependencies=[Depends(require_token)])
def vendor_rfq_pdf(vrfq_id: int):
    s = get_session()
    try:
        vr, rfq, vendor, cust, vessel, rfq_no, items, safe = _vrfq_ctx(s, vrfq_id)
        payload = build_po_payload(
            po_no=rfq_no, date=vr.sent_date or date.today().isoformat(),
            vendor=vendor, vessel=vessel, items=items,
        )
        pdf = generate_pdf("vendor_rfq", payload)
        return Response(
            content=pdf, media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{rfq_no}_RFQ_{safe}.pdf"'},
        )
    finally:
        s.close()


@app.get("/api/admin/vendor-rfq/{vrfq_id}/xlsx", dependencies=[Depends(require_token)])
def vendor_rfq_xlsx_single(vrfq_id: int):
    s = get_session()
    try:
        vr, rfq, vendor, cust, vessel, rfq_no, items, safe = _vrfq_ctx(s, vrfq_id)
        xlsx = make_vendor_rfq_quote_xlsx(
            rfq_no=rfq_no, vessel_name=vessel.name if vessel else "—",
            customer_name=cust.name if cust else "—",
            enquiry_date=vr.sent_date or date.today().isoformat(),
            vendor_name=vendor.name if vendor else "—", items=items,
        )
        return Response(
            content=xlsx,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{rfq_no}_VendorQuoteSheet_{safe}.xlsx"'},
        )
    finally:
        s.close()


@app.post("/api/admin/vendor-rfq/{vrfq_id}/email-preview", dependencies=[Depends(require_token)])
def vendor_rfq_email_preview(vrfq_id: int, body: VendorRfqEmailPreviewReq):
    s = get_session()
    try:
        vr, rfq, vendor, cust, vessel, rfq_no, items, safe = _vrfq_ctx(s, vrfq_id)
        lang = "ko" if body.lang == "ko" else "en"
        subject = (
            f"[K-MARIS] 견적 요청 — {rfq_no} / {vessel.name if vessel else rfq_no}"
            if lang == "ko"
            else f"[K-MARIS] Inquiry — {rfq_no} / {vessel.name if vessel else rfq_no}"
        )
        return {
            "to": vr.sent_to_email or (vendor.email if vendor else "") or "",
            "subject": subject,
            "body": _vendor_rfq_email_body(rfq, cust, vessel, vendor, "", lang, vr.items or None),
            "smtp_configured": bool(os.getenv("SMTP_USER") and os.getenv("SMTP_PASSWORD")),
        }
    finally:
        s.close()


@app.post("/api/admin/vendor-rfq/{vrfq_id}/send", dependencies=[Depends(require_token)])
def vendor_rfq_email_send(vrfq_id: int, body: VendorRfqEmailSendReq):
    s = get_session()
    try:
        vr, rfq, vendor, cust, vessel, rfq_no, items, safe = _vrfq_ctx(s, vrfq_id)
        if not body.to.strip():
            raise HTTPException(status_code=400, detail="수신자 이메일을 입력하세요.")
        if body.format == "pdf":
            payload = build_po_payload(
                po_no=rfq_no, date=vr.sent_date or date.today().isoformat(),
                vendor=vendor, vessel=vessel, items=items,
            )
            attach = (f"{rfq_no}_RFQ_{safe}.pdf", generate_pdf("vendor_rfq", payload))
        else:
            xlsx = make_vendor_rfq_quote_xlsx(
                rfq_no=rfq_no, vessel_name=vessel.name if vessel else "—",
                customer_name=cust.name if cust else "—",
                enquiry_date=vr.sent_date or date.today().isoformat(),
                vendor_name=vendor.name if vendor else "—", items=items,
            )
            attach = (f"{rfq_no}_VendorQuoteSheet_{safe}.xlsx", xlsx)
        sent = send_email(to=body.to.strip(), subject=body.subject, body=body.body, attachments=[attach])
        if not sent:
            raise HTTPException(status_code=400, detail="이메일 발송 실패 — SMTP 설정 또는 서버 상태를 확인하세요.")
        vr.sent_to_email = body.to.strip()
        vr.sent_date = date.today().isoformat()
        vr.status = "이메일 발송완료"
        s.commit()
        return {"ok": True, "sent_date": vr.sent_date}
    finally:
        s.close()


@app.post("/api/admin/rfq/{rfq_id}/vendor-rfq-send",
          dependencies=[Depends(require_token)])
def vendor_rfq_send(rfq_id: int, body: VendorRfqSendRequest):
    """Vendor RFQ '발신 완료' 기록 — 시스템이 직접 이메일을 발송하지 않고, 선택한
    Vendor별 VendorRFQ 레코드를 저장(2단계 완료)한다. 케이마리스 RFQ No.도 부여한다.
    이메일은 '이메일 생성'에서 만든 초안을 사용자가 직접 발송한다."""
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            raise HTTPException(status_code=404, detail="RFQ를 찾을 수 없습니다.")
        # 케이마리스 RFQ No. 부여(미발급이면)
        _assign_rfq_no(s, rfq, body.rfq_no_mode, body.rfq_no)
        sent_at = (body.sent_at or "").strip() or _kst_iso(datetime.utcnow())
        # 발신 화면에서 선택·편집한 품목이 오면 그것을, 없으면 RFQ 원본을 저장.
        sent_items = (_sanitize_vendor_rfq_items(body.rfq_items)
                      if body.rfq_items is not None else (rfq.items or []))
        saved = 0
        result_rows = []
        for item in body.items:
            vendor = s.query(Vendor).filter_by(id=item.vendor_id).first()
            if not vendor:
                continue
            vrfq = VendorRFQ(
                rfq_id=rfq.id,
                vendor_id=vendor.id,
                sent_date=sent_at[:10],
                sent_at=sent_at,
                sent_to_email=item.to or "",
                status="발신완료",
                items=sent_items,
            )
            s.add(vrfq)
            s.flush()
            saved += 1
            result_rows.append({"vendor": vendor.name})

        rfq.status = RFQStatus.SOURCING
        s.commit()
        return {
            "ok": True,
            "saved": saved,
            "rows": result_rows,
            "rfq_no": _rfq_no_disp(rfq.rfq_no),
        }
    finally:
        s.close()


@app.post("/api/admin/rfq/{rfq_id}/vendor-rfq",
          dependencies=[Depends(require_token)])
def create_vendor_rfq(rfq_id: int, body: VendorRfqCreate):
    """RFQ로부터 Vendor RFQ 발신(생성). 품목은 RFQ 품목을 그대로 이관한다."""
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            raise HTTPException(status_code=404, detail="RFQ를 찾을 수 없습니다.")
        vendor = s.query(Vendor).filter_by(id=body.vendor_id).first()
        if not vendor:
            raise HTTPException(status_code=400, detail="Vendor를 선택하세요.")
        _assign_rfq_no(s, rfq)   # 미발급이면 케이마리스 RFQ No. 자동 부여

        # 요청 품목(가격 제외)만 이관
        req_items = [{
            "part_no": it.get("part_no", ""),
            "description": it.get("description", ""),
            "qty": it.get("qty", 1),
        } for it in (rfq.items or [])]

        vrfq = VendorRFQ(
            rfq_id=rfq.id,
            vendor_id=vendor.id,
            sent_date=date.today().strftime("%Y-%m-%d"),
            sent_to_email=vendor.email or "",
            status="발송됨",
            items=req_items,
        )
        s.add(vrfq)
        s.commit()
        return {"ok": True, "id": vrfq.id, "vendor": vendor.name}
    finally:
        s.close()


@app.get("/api/admin/vendor-rfq/{vrfq_id}", dependencies=[Depends(require_token)])
def vendor_rfq_detail(vrfq_id: int):
    """Vendor RFQ(발신) 1건 상세."""
    s = get_session()
    try:
        vr = s.query(VendorRFQ).filter_by(id=vrfq_id).first()
        if not vr:
            raise HTTPException(status_code=404, detail="Vendor RFQ를 찾을 수 없습니다.")
        vendor = s.query(Vendor).filter_by(id=vr.vendor_id).first()
        rfq = s.query(RFQ).filter_by(id=vr.rfq_id).first() if vr.rfq_id else None
        customer = s.query(Customer).filter_by(id=rfq.customer_id).first() if rfq else None
        vessel = s.query(Vessel).filter_by(id=rfq.vessel_id).first() if rfq and rfq.vessel_id else None
        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}
        vendor_emails = {v.id: (v.email or "") for v in s.query(Vendor).all()}
        quote_count = s.query(VendorQuote).filter_by(vendor_rfq_id=vr.id).count()
        sibling_vrfqs = []
        if rfq:
            quote_counts: dict[int, int] = {}
            for q in s.query(VendorQuote).filter(VendorQuote.vendor_rfq_id.in_(
                [x.id for x in s.query(VendorRFQ).filter_by(rfq_id=rfq.id).all()]
            )).all():
                quote_counts[q.vendor_rfq_id] = quote_counts.get(q.vendor_rfq_id, 0) + 1
            for x in s.query(VendorRFQ).filter_by(rfq_id=rfq.id).order_by(VendorRFQ.id.desc()).all():
                sibling_vrfqs.append({
                    "id": x.id,
                    "vendor": vendor_names.get(x.vendor_id, "—"),
                    "vendor_email": x.sent_to_email or vendor_emails.get(x.vendor_id, "") or "",
                    "sent_at": x.sent_at or "",
                    "status": x.status or "",
                    "quote_count": quote_counts.get(x.id, 0),
                    "current": x.id == vr.id,
                })
        return {
            "id": vr.id,
            "rfq_id": vr.rfq_id,
            "assignee_id": (rfq.created_by or 0) if rfq else 0,
            "customer_rfq_no": rfq.customer_rfq_no if rfq else "",
            "kmaris_rfq_no": _rfq_no_disp(rfq.rfq_no) if rfq else "",
            "project_no": _project_no_map(s).get(rfq.id, "") if rfq else "",
            "first_rfq_at": _first_rfq_iso(rfq) if rfq else "",
            "customer": customer.name if customer else "",
            "customer_contact": getattr(customer, "contact", "") if customer else "",
            "customer_email": getattr(customer, "email", "") if customer else "",
            "vessel": vessel.name if vessel else "—",
            "project_title": rfq.project_title if rfq else "",
            "work_type": rfq.work_type if rfq else "",
            "received_at": rfq.received_at if rfq else "",
            "vendor_id": vr.vendor_id or 0,
            "vendor": vendor.name if vendor else "—",
            "vendor_email": vr.sent_to_email or (vendor.email if vendor else "") or "",
            "sent_date": vr.sent_date or "",
            "sent_at": vr.sent_at or "",
            "status": vr.status or "",
            "quote_count": quote_count,
            "items": [_item_view(it) for it in (vr.items or [])],
            "project_vendor_rfqs": sibling_vrfqs,
        }
    finally:
        s.close()


@app.put("/api/admin/vendor-rfq/{vrfq_id}", dependencies=[Depends(require_token)])
def update_vendor_rfq(vrfq_id: int, body: VendorRfqUpdate):
    """Vendor RFQ 수정 — Vendor·발신정보·상태·품목 교체."""
    s = get_session()
    try:
        vr = s.query(VendorRFQ).filter_by(id=vrfq_id).first()
        if not vr:
            raise HTTPException(status_code=404, detail="Vendor RFQ를 찾을 수 없습니다.")
        if body.vendor_id is not None:
            vr.vendor_id = body.vendor_id
        if body.sent_to_email is not None:
            vr.sent_to_email = body.sent_to_email.strip()
        if body.status is not None:
            vr.status = body.status.strip() or vr.status
        if body.sent_at is not None:
            vr.sent_at = body.sent_at.strip()
            if body.sent_at.strip():
                vr.sent_date = body.sent_at.strip()[:10]
        if body.sent_date is not None:
            vr.sent_date = body.sent_date.strip()
        if body.items is not None:
            vr.items = [{
                "part_no": (it.get("part_no") or "").strip(),
                "description": (it.get("description") or "").strip(),
                "qty": it.get("qty", 1) or 1,
                "unit": (it.get("unit") or "").strip(),
                "remark": (it.get("remark") or "").strip(),
            } for it in body.items if (it.get("part_no") or it.get("description"))]
        s.commit()
        return {"ok": True, "id": vr.id}
    finally:
        s.close()


@app.delete("/api/admin/vendor-rfq/{vrfq_id}", dependencies=[Depends(require_token)])
def delete_vendor_rfq(vrfq_id: int):
    """Vendor RFQ 삭제 — 수신된 Vendor 견적이 있으면 거부한다."""
    s = get_session()
    try:
        vr = s.query(VendorRFQ).filter_by(id=vrfq_id).first()
        if not vr:
            raise HTTPException(status_code=404, detail="Vendor RFQ를 찾을 수 없습니다.")
        if s.query(VendorQuote).filter_by(vendor_rfq_id=vrfq_id).first():
            raise HTTPException(status_code=400,
                detail="수신된 Vendor 견적이 있는 Vendor RFQ 입니다. 먼저 견적을 삭제하세요.")
        s.query(VendorRFQ).filter_by(id=vrfq_id).delete(synchronize_session=False)
        s.commit()
        return {"ok": True, "id": vrfq_id}
    finally:
        s.close()


@app.post("/api/admin/vendor-quote-parse", dependencies=[Depends(require_token)])
def vendor_quote_parse(file: UploadFile = File(...)):
    """Vendor 견적 응답 파일(PDF/Excel/이미지) → 품목 리스트 자동 추출.

    정형 양식(KTMS 견적요청 시트)은 표 파서로 먼저 시도하고, 비정형 PDF는
    Claude 텍스트 파서로, 이미지/캡쳐는 Claude 비전으로 추출한다.
    """
    name = file.filename or ""
    lower = name.lower()
    img_media = _ocr_image_media_type(file)
    try:
        file.file.seek(0)
        raw = file.file.read()

        # 1) 이미지/캡쳐 → Claude 비전
        if img_media:
            return parse_vendor_quote_image(raw, img_media)

        # 2) Excel/정형 PDF → 표 파서 우선
        if lower.endswith((".xlsx", ".xls", ".pdf")):
            items = parse_vendor_quote_bytes(raw, name)
            if items:
                return {"items": items}

            # 3) 표 파서 실패 → Claude 폴백
            if lower.endswith(".pdf"):
                # 3a) 텍스트가 있으면 텍스트 파서
                text = extract_text_from_pdf(io.BytesIO(raw))
                if text:
                    result = parse_vendor_quote_text(text)
                    if result.get("items"):
                        return result
                # 3b) 텍스트 없음(스캔본)·텍스트 파서 실패 → PDF 비전 파서
                return parse_vendor_quote_pdf_document(raw)

            # Excel 비정형 → 셀 전체를 텍스트로 덤프해 Claude 텍스트 파서로 폴백
            xls_text = excel_to_text(raw)
            if xls_text:
                return parse_vendor_quote_text(xls_text)
            return {"items": []}

        raise HTTPException(
            status_code=400,
            detail="PDF·Excel 또는 이미지(PNG·JPG·WEBP) 파일만 업로드할 수 있습니다.",
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Vendor 견적 파싱 실패: {exc}") from exc


@app.post("/api/admin/rfq/{rfq_id}/vendor-quote",
          dependencies=[Depends(require_token)])
def create_vendor_quote(rfq_id: int, body: VendorQuoteCreate):
    """Vendor Quote 수신 등록. 품목 단위 items가 있으면 그대로 저장한다."""
    s = get_session()
    try:
        vrfq = s.query(VendorRFQ).filter_by(id=body.vendor_rfq_id, rfq_id=rfq_id).first()
        if not vrfq:
            raise HTTPException(status_code=400, detail="해당 RFQ의 Vendor RFQ를 선택하세요.")
        # Vendor 견적번호는 선택 입력(비워도 등록 가능).

        items = body.items
        if not items:
            amount = float(body.amount or 0)
            items = [{"cost_price": amount, "qty": 1, "amount": amount}]

        # 수신 일시: 수동 입력(received_at) 우선, 없으면 날짜만, 둘 다 없으면 현재(KST)
        received_at = (body.received_at or "").strip()
        if not received_at:
            received_at = _date_iso(body.received_date) or _kst_iso(datetime.utcnow())

        vq = VendorQuote(
            vendor_rfq_id=vrfq.id,
            vendor_quote_no=body.vendor_quote_no.strip(),
            received_date=received_at[:10],
            received_at=received_at,
            currency=body.currency or "USD",
            items=items,
            terms=body.terms or {},
            notes=body.notes or "",
        )
        s.add(vq)
        vrfq.status = "견적 수신완료"
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if rfq and rfq.status == RFQStatus.SOURCING:
            rfq.status = RFQStatus.QUOTING
        s.commit()
        return {"ok": True, "vendor_quote_no": vq.vendor_quote_no}
    finally:
        s.close()


@app.get("/api/admin/rfq/{rfq_id}/vendor-quotes",
         dependencies=[Depends(require_token)])
def rfq_vendor_quotes(rfq_id: int):
    """해당 RFQ의 Vendor 견적 목록(품목 포함). Customer Quotation 작성 시
    공급사 견적에서 cost_price/품목 정보를 불러오기 위한 selector 데이터."""
    s = get_session()
    try:
        vrfqs = s.query(VendorRFQ).filter_by(rfq_id=rfq_id).all()
        vrfq_map = {v.id: v for v in vrfqs}
        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}
        vqs = (s.query(VendorQuote)
               .filter(VendorQuote.vendor_rfq_id.in_(list(vrfq_map.keys())))
               .order_by(VendorQuote.id.desc()).all() if vrfq_map else [])
        out = []
        for q in vqs:
            vrfq = vrfq_map.get(q.vendor_rfq_id)
            out.append({
                "id": q.id,
                "vendor_quote_no": getattr(q, "vendor_quote_no", None) or "—",
                "vendor": vendor_names.get(vrfq.vendor_id, "—") if vrfq else "—",
                "received_date": q.received_date or "",
                "received_at": getattr(q, "received_at", None) or "",
                "currency": getattr(q, "currency", None) or "USD",
                "items": q.items or [],
                "terms": getattr(q, "terms", None) or {},
            })
        return {"vendor_quotes": out}
    finally:
        s.close()


@app.get("/api/admin/vendor-quote/{vq_id}", dependencies=[Depends(require_token)])
def vendor_quote_detail(vq_id: int):
    """Vendor Quote(수신 견적) 1건 상세 — 원본 품목(cost_price 등) 포함."""
    s = get_session()
    try:
        q = s.query(VendorQuote).filter_by(id=vq_id).first()
        if not q:
            raise HTTPException(status_code=404, detail="Vendor 견적을 찾을 수 없습니다.")
        vr = s.query(VendorRFQ).filter_by(id=q.vendor_rfq_id).first()
        vendor = s.query(Vendor).filter_by(id=vr.vendor_id).first() if vr else None
        rfq = s.query(RFQ).filter_by(id=vr.rfq_id).first() if vr and vr.rfq_id else None
        return {
            "id": q.id,
            "vendor_quote_no": q.vendor_quote_no or "",
            "vendor_rfq_id": q.vendor_rfq_id,
            "rfq_id": vr.rfq_id if vr else None,
            "assignee_id": (rfq.created_by or 0) if rfq else 0,
            "customer_rfq_no": _rfq_no_disp(rfq.rfq_no) if rfq else "",
            **_base_meta(s, rfq),   # 공통 기본정보(고객·선박·업무·Project No.·최초 RFQ)
            "vendor": vendor.name if vendor else "—",
            "received_date": q.received_date or "",
            "received_at": q.received_at or "",
            "notes": q.notes or "",
            "currency": getattr(q, "currency", None) or "USD",
            "items": q.items or [],
            "terms": getattr(q, "terms", None) or {},
            # 벤더 정보에 등록된 기본 결제조건(상세 편집 시 payment_terms 기본값용)
            "default_payment_terms": (getattr(vendor, "payment_terms", None) or "") if vendor else "",
        }
    finally:
        s.close()


@app.put("/api/admin/vendor-quote/{vq_id}", dependencies=[Depends(require_token)])
def update_vendor_quote(vq_id: int, body: VendorQuoteUpdate):
    """Vendor Quote 수정 — 견적번호·수신일시·비고·품목 교체."""
    s = get_session()
    try:
        q = s.query(VendorQuote).filter_by(id=vq_id).first()
        if not q:
            raise HTTPException(status_code=404, detail="Vendor 견적을 찾을 수 없습니다.")
        if body.vendor_quote_no is not None:
            q.vendor_quote_no = body.vendor_quote_no.strip()
        if body.notes is not None:
            q.notes = body.notes
        if body.currency is not None:
            cur = (body.currency or "USD").strip().upper() or "USD"
            q.currency = cur
            s.flush()
            s.execute(
                text("UPDATE vendor_quotes SET currency = :currency WHERE id = :id"),
                {"currency": cur, "id": vq_id},
            )
        if body.received_at is not None and body.received_at.strip():
            q.received_at = body.received_at.strip()
            q.received_date = body.received_at.strip()[:10]
        elif body.received_date is not None:
            q.received_date = body.received_date.strip()
        if body.items is not None:
            q.items = body.items
        if body.terms is not None:
            q.terms = body.terms
        s.commit()
        saved_currency = (
            s.execute(text("SELECT currency FROM vendor_quotes WHERE id = :id"), {"id": vq_id}).scalar()
            or "USD"
        )
        return {"ok": True, "vendor_quote_no": q.vendor_quote_no, "currency": saved_currency}
    finally:
        s.close()


@app.delete("/api/admin/vendor-quote/{vq_id}", dependencies=[Depends(require_token)])
def delete_vendor_quote(vq_id: int):
    """Vendor Quote 삭제."""
    s = get_session()
    try:
        q = s.query(VendorQuote).filter_by(id=vq_id).first()
        if not q:
            raise HTTPException(status_code=404, detail="Vendor 견적을 찾을 수 없습니다.")
        no = q.vendor_quote_no or ""
        s.query(VendorQuote).filter_by(id=vq_id).delete(synchronize_session=False)
        s.commit()
        return {"ok": True, "vendor_quote_no": no}
    finally:
        s.close()
