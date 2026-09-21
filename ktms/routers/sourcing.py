"""K-Maris TMS — sourcing routes (split from admin_api.py; behavior unchanged)."""
from __future__ import annotations

from _core import (
    Customer,
    Depends,
    _deal_identity,
    File,
    Form,
    HTTPException,
    List,
    RFQ,
    resolve_signature,
    signature_html_for,
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
    VendorRfqDeclineBody,
    VendorRfqUpdate,
    VendorRfqXlsxRequest,
    VendorRfqEmailPreviewReq,
    VendorRfqEmailSendReq,
    Vessel,
    _assign_rfq_no,
    _assign_vrfq_no,
    _next_kmaris_rfq_no,
    _rfq_unassigned,
    build_po_payload,
    clean_source_files,
    generate_pdf,
    send_email,
    default_from,
)
from services.mail_compose import build_attachments, compose_body, compose_parts
from services.vendor_match import suggest_vendors
from _core import (
    DealLineAward,
    LineAwardsSave,
    index_doc_by_line,
    is_option_row,
    line_id_of,
    _base_meta,
    cached_aggregate,
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
    build_vendor_rfq_email,
    get_current_user,
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
                # 이 Vendor RFQ 고유의 K-Maris RFQ No.(구 레코드는 프로젝트 번호로 폴백).
                "kmaris_rfq_no": _rfq_no_disp(vr.kmaris_rfq_no or (rfq.rfq_no if rfq else "")),
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


@app.get("/api/admin/rfq/{rfq_id}/vendor-suggestions",
         dependencies=[Depends(require_token)])
@cached_aggregate()
def rfq_vendor_suggestions(rfq_id: int, limit: int = 6):
    """이 딜의 품목에 맞는 거래선 추천 — 2단계에서 "어디에 물어볼까"의 밑그림.

    근거는 1단계 품목의 분류·품번과 벤더의 취급품목·거래이력이다(services.vendor_match).
    이미 이 딜에서 RFQ 를 보낸 벤더는 뺀다 — 그 벤더들은 화면에 탭으로 이미 서 있다."""
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            raise HTTPException(status_code=404, detail="RFQ를 찾을 수 없습니다.")
        sent = [v.vendor_id for v in s.query(VendorRFQ).filter_by(rfq_id=rfq_id).all()
                if v.vendor_id]
        return suggest_vendors(s, rfq.items or [],
                               limit=max(1, min(int(limit or 6), 12)),
                               exclude_ids=sent)
    finally:
        s.close()


@app.post("/api/admin/rfq/{rfq_id}/vendor-rfq-preview",
          dependencies=[Depends(require_token)])
def vendor_rfq_preview(rfq_id: int, body: VendorRfqPreviewRequest,
                       user: dict = Depends(get_current_user)):
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            raise HTTPException(status_code=404, detail="RFQ를 찾을 수 없습니다.")
        # 미리보기는 DB를 변경하지 않는다. 이번 발송에 부여될 vendor 번호를 계산해 표시만 한다.
        existing = s.query(VendorRFQ).filter_by(rfq_id=rfq.id).count()
        manual_no = (body.rfq_no or "").strip()
        if body.rfq_no_mode == "manual" and manual_no:
            disp_no = manual_no
        elif existing == 0 and not _rfq_unassigned(rfq.rfq_no):
            disp_no = rfq.rfq_no
        else:
            disp_no = _next_kmaris_rfq_no(s)
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
            subj, bod = build_vendor_rfq_email(
                s, user.get("id"), rfq, cust, vessel, vendor, body.notes, lang, items, rfq_no=disp_no)
            previews.append({
                "vendor_id": vendor.id,
                "vendor_name": vendor.name,
                "to": vendor.email or "",
                "subject": subj,
                "body": bod,
                "xlsx_filename": f"{disp_no}_VendorQuoteSheet_{safe_vname}.xlsx",
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
def vendor_rfq_email_preview(vrfq_id: int, body: VendorRfqEmailPreviewReq,
                             user: dict = Depends(get_current_user)):
    s = get_session()
    try:
        vr, rfq, vendor, cust, vessel, rfq_no, items, safe = _vrfq_ctx(s, vrfq_id)
        lang = "ko" if body.lang == "ko" else "en"
        # 서명은 별도 필드로 내려보내고 본문 템플릿에서는 뺀다(발송 시 다시 합쳐진다).
        subject, mail_body = build_vendor_rfq_email(
            s, user.get("id"), rfq, cust, vessel, vendor, "", lang, vr.items or None,
            rfq_no=rfq_no, inline_signature=False)
        return {
            "to": vr.sent_to_email or (vendor.email if vendor else "") or "",
            "from": default_from(),
            "subject": subject,
            "body": mail_body,
            "signature": resolve_signature(s, user.get("id"), lang),
            "smtp_configured": bool(os.getenv("SMTP_USER") and os.getenv("SMTP_PASSWORD")),
        }
    finally:
        s.close()


@app.post("/api/admin/vendor-rfq/{vrfq_id}/send", dependencies=[Depends(require_token)])
def vendor_rfq_email_send(
    vrfq_id: int,
    to: str = Form(...),
    subject: str = Form(""),
    body: str = Form(""),
    notes: str = Form(""),
    signature: str = Form(""),
    include_signature: bool = Form(True),
    cc: str = Form(""),
    from_email: str = Form(""),
    format: str = Form("pdf"),
    include_document: bool = Form(True),
    files: List[UploadFile] = File(default=[]),
    user: dict = Depends(get_current_user),
):
    """Vendor RFQ 이메일 발송 — 생성 문서(PDF/XLSX) + 사용자가 추가한 첨부.
    include_document=False 면 문서를 만들지 않고 본문(+업로드 첨부)만 보낸다."""
    s = get_session()
    try:
        vr, rfq, vendor, cust, vessel, rfq_no, items, safe = _vrfq_ctx(s, vrfq_id)
        if not to.strip():
            raise HTTPException(status_code=400, detail="수신자 이메일을 입력하세요.")
        generated = None
        if include_document:
            if format == "pdf":
                payload = build_po_payload(
                    po_no=rfq_no, date=vr.sent_date or date.today().isoformat(),
                    vendor=vendor, vessel=vessel, items=items,
                )
                generated = (f"{rfq_no}_RFQ_{safe}.pdf", generate_pdf("vendor_rfq", payload))
            else:
                xlsx = make_vendor_rfq_quote_xlsx(
                    rfq_no=rfq_no, vessel_name=vessel.name if vessel else "—",
                    customer_name=cust.name if cust else "—",
                    enquiry_date=vr.sent_date or date.today().isoformat(),
                    vendor_name=vendor.name if vendor else "—", items=items,
                )
                generated = (f"{rfq_no}_VendorQuoteSheet_{safe}.xlsx", xlsx)
        attachments = build_attachments(generated, files)
        # 저장된 표 서명(HTML)을 손대지 않고 그대로 쓰는 발송이면 HTML 파트에 그 표를
        # 붙인다. 서명을 화면에서 고쳤다면 None 이 돌아와 고친 평문이 그대로 나간다.
        mail_text, mail_html = compose_parts(
            body, notes, signature, include_signature,
            signature_html_for(s, user.get("id"), signature),
        )
        sent = send_email(
            to=to.strip(),
            subject=subject,
            body=mail_text,
            html_body=mail_html,
            attachments=attachments,
            cc=cc.strip(),
            from_addr=from_email.strip(),
        )
        if not sent:
            raise HTTPException(status_code=400, detail="이메일 발송 실패 — SMTP 설정 또는 서버 상태를 확인하세요.")
        vr.sent_to_email = to.strip()
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
        sent_at = (body.sent_at or "").strip() or _kst_iso(datetime.utcnow())
        # 발신 화면에서 선택·편집한 품목이 오면 그것을, 없으면 RFQ 원본을 저장.
        sent_items = (_sanitize_vendor_rfq_items(body.rfq_items)
                      if body.rfq_items is not None else (rfq.items or []))
        saved = 0
        result_rows = []
        last_no = ""
        # 이 프로젝트에 이미 저장된 Vendor RFQ 수(첫 vendor 판정용).
        existing_count = s.query(VendorRFQ).filter_by(rfq_id=rfq.id).count()
        manual_no = (body.rfq_no or "").strip()
        for item in body.items:
            vendor = s.query(Vendor).filter_by(id=item.vendor_id).first()
            if not vendor:
                continue
            # Vendor RFQ별 고유 K-Maris RFQ No.(같은 프로젝트라도 vendor마다 다음 번호).
            if body.rfq_no_mode == "manual" and manual_no:
                vno = _assign_vrfq_no(s, "manual", manual_no)
                manual_no = ""   # 수동 번호는 첫 vendor에만 적용, 이후는 자동
            elif existing_count == 0 and not _rfq_unassigned(rfq.rfq_no):
                # 'Create RFQ'로 미리 발번한 프로젝트 번호를 첫 vendor에 그대로 사용.
                vno = rfq.rfq_no
            else:
                vno = _assign_vrfq_no(s, "auto", "")
            vrfq = VendorRFQ(
                rfq_id=rfq.id,
                vendor_id=vendor.id,
                kmaris_rfq_no=vno,
                sent_date=sent_at[:10],
                sent_at=sent_at,
                sent_to_email=item.to or "",
                status="발신완료",
                items=sent_items,
            )
            s.add(vrfq)
            s.flush()
            # 프로젝트 RFQ가 미발급이면 첫 vendor 번호로 채워 단계 판정·배지 연속성 유지.
            if _rfq_unassigned(rfq.rfq_no):
                rfq.rfq_no = vno
            existing_count += 1
            saved += 1
            last_no = vno
            result_rows.append({"vendor": vendor.name, "kmaris_rfq_no": vno})

        rfq.status = RFQStatus.SOURCING
        s.commit()
        return {
            "ok": True,
            "saved": saved,
            "rows": result_rows,
            "rfq_no": last_no or _rfq_no_disp(rfq.rfq_no),
        }
    finally:
        s.close()


# Vendor RFQ '견적 불가' 상태 문자열. 프로젝트 정보 Vendor 필드에서 취소선(제외) 판정에 쓴다.
_VRFQ_DECLINED = "견적 불가"


@app.post("/api/admin/vendor-rfq/{vrfq_id}/toggle-decline",
          dependencies=[Depends(require_token)])
def vendor_rfq_toggle_decline(
    vrfq_id: int,
    body: VendorRfqDeclineBody | None = None,
    user: dict = Depends(get_current_user),
):
    """이 Vendor RFQ 의 '견적 불가' 표시를 토글한다. 견적이 이미 수신된 벤더는 표시에서
    quoted 가 우선하므로 영향이 없다. 해제 시 '발신완료' 로 되돌린다.
    '견적 불가'로 표시할 때는 통보 일시·사유를 받아 활동로그(3단계 Quote Received)에 자동 기록한다."""
    s = get_session()
    try:
        vr = s.query(VendorRFQ).filter_by(id=vrfq_id).first()
        if not vr:
            raise HTTPException(status_code=404, detail="Vendor RFQ를 찾을 수 없습니다.")
        declined = (vr.status or "") != _VRFQ_DECLINED
        vr.status = _VRFQ_DECLINED if declined else "발신완료"
        # 표시(declined=True)로 전환할 때만 활동로그에 한 줄 남긴다. 해제는 조용히 토글.
        if declined:
            rfq = s.query(RFQ).filter_by(id=vr.rfq_id).first() if vr.rfq_id else None
            vendor = s.query(Vendor).filter_by(id=vr.vendor_id).first() if vr.vendor_id else None
            if rfq is not None:
                reason = ((body.reason if body else None) or "").strip()
                when = ((body.datetime if body else None) or "").strip() or _kst_iso(datetime.utcnow())
                notes = dict(getattr(rfq, "stage_notes", None) or {})
                key = "3"   # Quote Received — 벤더가 견적 불가를 통보한 시점
                log = list(notes.get(key, []))
                log.append({
                    "text": "견적 불가 통보" + (f" — {reason}" if reason else ""),
                    "datetime": when,
                    "party": (vendor.name if vendor else "") or "",   # 통보한 벤더
                    "person": (vendor.contact if vendor else "") or "",  # 벤더 담당자
                    "channel": "",
                    "direction": "in",   # 벤더로부터 수신
                    "star": False,
                    "pic": (user.get("username") if user else "") or "",
                    "at": _kst_iso(datetime.utcnow()),
                })
                notes[key] = log
                rfq.stage_notes = notes
        s.commit()
        return {"ok": True, "declined": declined, "status": vr.status}
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
            "type": it.get("type", ""),
            "serial_no": it.get("serial_no", ""),
            "qty": it.get("qty", 1),
            # 옵션 표시행 표식 — 나눠 둔 옵션이 공급사 요청서에서도 그대로 서게 한다.
            "row_kind": it.get("row_kind", "") or "",
            "lid": line_id_of(it),
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
            # Vendor RFQ 자신의 번호 우선(구 레코드는 프로젝트 RFQ 번호로 폴백).
            "kmaris_rfq_no": _rfq_no_disp(vr.kmaris_rfq_no or (rfq.rfq_no if rfq else "")),
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
                "type": (it.get("type") or "").strip(),
                "serial_no": (it.get("serial_no") or "").strip(),
                "qty": it.get("qty", 1) or 1,
                "unit": (it.get("unit") or "").strip(),
                "remark": (it.get("remark") or "").strip(),
                "row_kind": it.get("row_kind", "") or "",
                # 라인 ID — 이 벤더에게 물어본 줄이 딜의 어느 줄인지. 떨어뜨리면
                # 소싱 보드에서 이 벤더 칸이 통째로 빈다.
                "lid": line_id_of(it),
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
            fx_rate=body.fx_rate,
            source_files=clean_source_files(body.source_files),
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
                # 이 견적이 어느 Vendor RFQ 에 대한 답인지 — 개요에서 번호를 누르면 그 벤더의
                # 3단계 탭이 열린 채로 뜨게 하는 데 쓴다(벤더가 여럿이면 어느 탭인지가 중요).
                "vendor_rfq_id": q.vendor_rfq_id,
                "vendor_quote_no": getattr(q, "vendor_quote_no", None) or "—",
                # 이름만으로는 공급사 칸(아이디로 고른다)을 채울 수 없다 — 매입 청구서를
                # 이 견적에서 불러올 때 공급사까지 함께 앉히려면 아이디가 있어야 한다.
                "vendor_id": (vrfq.vendor_id or 0) if vrfq else 0,
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
            "fx_rate": getattr(q, "fx_rate", None),
            "items": q.items or [],
            "terms": getattr(q, "terms", None) or {},
            "source_files": getattr(q, "source_files", None) or [],
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
        if body.fx_rate is not None:
            q.fx_rate = body.fx_rate
        if body.source_files is not None:
            q.source_files = clean_source_files(body.source_files)
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
        # 이 견적을 골라 둔 라인 채택도 함께 거둔다 — 남겨 두면 사라진 견적을 가리키는
        # 채택이 되어, 4단계 "채택분 불러오기"가 값 없는 줄을 싣는다.
        s.query(DealLineAward).filter_by(vendor_quote_id=vq_id).delete(synchronize_session=False)
        s.query(VendorQuote).filter_by(id=vq_id).delete(synchronize_session=False)
        s.commit()
        return {"ok": True, "vendor_quote_no": no}
    finally:
        s.close()


# ── 라인 소싱 보드 · 라인별 채택 ───────────────────────────────────────────────
# 한 딜의 품목 열일곱 줄이 모두 한 곳에서 오지는 않는다. 여섯 줄은 A, 아홉 줄은 B,
# 두 줄은 아직 아무도 못 준다고 한다. 여태 그 사정은 벤더 RFQ 문서 세 장에 흩어져
# 있었고, "무엇이 아직 안 나갔나"를 알려면 세 장을 다 열어 봐야 했다.
#
# 이 보드는 그 세 장을 한 표로 눕힌다 — 행은 딜의 품목 줄, 열은 물어본 곳.


def _cell_cost(it) -> float | None:
    """벤더 견적 줄의 단가. 값이 없으면 None(물어는 봤는데 값이 안 온 줄)."""
    if not isinstance(it, dict):
        return None
    v = it.get("cost_price")
    if v is None:
        v = it.get("unit_price")
    if v is None:
        amt, qty = it.get("amount"), it.get("qty")
        try:
            if amt is not None and float(qty or 0):
                return float(amt) / float(qty)
        except (TypeError, ValueError, ZeroDivisionError):
            return None
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _line_board(s, rfq) -> dict:
    """딜 1건의 소싱 현황 — 품목 줄 × 물어본 곳 표, 그리고 줄마다의 채택."""
    lines_src = [it for it in (rfq.items or []) if isinstance(it, dict) and not is_option_row(it)]
    # 옛 딜에는 라인 ID가 없다. 화면에서 보기만 해도 이름이 붙게 하려면 여기서 심어야
    # 하는데, 조회가 데이터를 고치는 것은 규칙 밖이다 — 대신 이름 없는 줄은 예전처럼
    # 품번/순서 규칙으로 맞춘다(index_doc_by_line). 1단계에서 한 번 저장하면 생긴다.
    lines = []
    for i, it in enumerate(lines_src):
        lines.append({
            "lid": line_id_of(it) or f"#{i + 1}",
            "no": i + 1,
            "part_no": it.get("part_no") or "",
            "description": it.get("description") or "",
            "maker": it.get("maker") or "",
            "qty": it.get("qty", 1) or 1,
            "unit": it.get("unit") or "",
            "remark": it.get("remark") or "",
            "named": bool(line_id_of(it)),
        })

    vrfqs = (s.query(VendorRFQ).filter_by(rfq_id=rfq.id)
             .order_by(VendorRFQ.id.asc()).all())
    vendor_names = {v.id: v.name for v in s.query(Vendor).all()} if vrfqs else {}
    vq_by_vrfq: dict[int, list] = {}
    if vrfqs:
        for q in (s.query(VendorQuote)
                  .filter(VendorQuote.vendor_rfq_id.in_([v.id for v in vrfqs]))
                  .order_by(VendorQuote.id.asc()).all()):
            vq_by_vrfq.setdefault(q.vendor_rfq_id, []).append(q)

    # 채택 기록 — 줄당 한 곳(스키마의 rfq_id+lid 유일 제약).
    awards = {a.lid: a for a in s.query(DealLineAward).filter_by(rfq_id=rfq.id).all()}

    cols = []
    cells: dict[str, dict[str, dict]] = {}

    for vr in vrfqs:
        declined = (vr.status or "") == _VRFQ_DECLINED
        quotes = vq_by_vrfq.get(vr.id, [])
        cols.append({
            "vrfq_id": vr.id,
            "vendor_id": vr.vendor_id or 0,
            "vendor": vendor_names.get(vr.vendor_id, "—"),
            "kmaris_rfq_no": _rfq_no_disp(vr.kmaris_rfq_no or ""),
            "sent_at": vr.sent_at or "",
            "status": vr.status or "",
            "declined": declined,
            "quotes": [{
                "id": q.id,
                "vendor_quote_no": q.vendor_quote_no or "",
                "currency": q.currency or "USD",
                "received_at": q.received_at or q.received_date or "",
            } for q in quotes],
        })
        # 이 벤더에게 물어본 줄 — 갈라 보냈으면 딜의 일부만 여기 있다.
        asked = index_doc_by_line(lines_src, vr.items or [])
        # 그 벤더가 값을 매긴 줄. 견적이 여러 장이면 나중 것이 앞선 것을 덮는다
        # (같은 줄을 다시 견적해 왔다면 나중 값이 지금 값이다).
        priced: dict[str, tuple] = {}
        for q in quotes:
            for lid, it in index_doc_by_line(lines_src, q.items or []).items():
                priced[lid] = (q, it, _cell_cost(it))
        for idx, ln in enumerate(lines):
            key = line_id_of(lines_src[idx]) or ln["lid"]
            hit, got = asked.get(key), priced.get(key)
            if hit is None and got is None:
                continue
            if got is not None:
                q, it, cost = got
                cells.setdefault(ln["lid"], {})[str(vr.id)] = {
                    "state": "quoted" if cost is not None else "no_price",
                    "unit_cost": cost,
                    "currency": q.currency or "USD",
                    "lead_time": (it.get("lead_time") or "") if isinstance(it, dict) else "",
                    "qty": (it.get("qty") if isinstance(it, dict) else None) or ln["qty"],
                    "vendor_quote_id": q.id,
                    "vendor_quote_no": q.vendor_quote_no or "",
                }
            elif declined:
                cells.setdefault(ln["lid"], {})[str(vr.id)] = {"state": "declined"}
            elif quotes:
                # 물어봤고 답도 왔는데 이 줄만 빠졌다 — 가장 놓치기 쉬운 칸이다.
                cells.setdefault(ln["lid"], {})[str(vr.id)] = {"state": "omitted"}
            else:
                cells.setdefault(ln["lid"], {})[str(vr.id)] = {"state": "sent"}

    vendor_of_quote = {}
    for c in cols:
        for q in c["quotes"]:
            vendor_of_quote[q["id"]] = (c["vendor_id"], c["vendor"])

    for ln in lines:
        row = cells.get(ln["lid"], {})
        states = [c.get("state") for c in row.values()]
        best = None
        for key, c in row.items():
            if c.get("state") != "quoted" or c.get("unit_cost") is None:
                continue
            if best is None or c["unit_cost"] < best["unit_cost"]:
                best = {**c, "vrfq_id": int(key)}
        ln["sent_count"] = len(states)
        ln["quoted_count"] = sum(1 for x in states if x == "quoted")
        # 최저가 — 통화가 섞이면 비교가 뜻을 잃으므로 한 통화일 때만 매긴다.
        curs = {c.get("currency") for c in row.values() if c.get("state") == "quoted"}
        ln["best"] = best if len(curs) <= 1 else None
        ln["mixed_currency"] = len(curs) > 1
        a = awards.get(ln["lid"])
        if a is not None:
            vid, vname = vendor_of_quote.get(a.vendor_quote_id, (a.vendor_id or 0, ""))
            ln["award"] = {
                "vendor_quote_id": a.vendor_quote_id,
                "vendor_id": vid or (a.vendor_id or 0),
                "vendor": vname or (vendor_names.get(a.vendor_id, "") or ""),
                "unit_cost": a.unit_cost,
                "currency": a.currency or "",
                "lead_time": a.lead_time or "",
                "reason": a.reason or "",
                "chosen_at": a.chosen_at or "",
            }
            ln["state"] = "awarded"
        else:
            ln["award"] = None
            if ln["quoted_count"]:
                ln["state"] = "quoted"
            elif not states:
                ln["state"] = "not_sourced"
            elif all(x == "declined" for x in states):
                ln["state"] = "declined"
            else:
                ln["state"] = "sourcing"

    return {
        "rfq_id": rfq.id,
        "lines": lines,
        "vendors": cols,
        "cells": cells,
        # 옛 딜 안내용 — 이름 없는 줄이 있으면 화면이 "1단계에서 한 번 저장"을 권한다.
        "lines_named": sum(1 for ln in lines if ln["named"]),
        "lines_total": len(lines),
        "summary": {
            "not_sourced": sum(1 for ln in lines if ln["state"] == "not_sourced"),
            "sourcing": sum(1 for ln in lines if ln["state"] == "sourcing"),
            "quoted": sum(1 for ln in lines if ln["state"] == "quoted"),
            "awarded": sum(1 for ln in lines if ln["state"] == "awarded"),
            "declined": sum(1 for ln in lines if ln["state"] == "declined"),
        },
    }


@app.get("/api/admin/rfq/{rfq_id}/line-board", dependencies=[Depends(require_token)])
def line_board(rfq_id: int):
    """2·3단계 공용 — 품목 줄 × 물어본 곳 현황표(+ 줄별 채택)."""
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            raise HTTPException(status_code=404, detail="RFQ를 찾을 수 없습니다.")
        return _line_board(s, rfq)
    finally:
        s.close()


@app.put("/api/admin/rfq/{rfq_id}/line-awards", dependencies=[Depends(require_token)])
def save_line_awards(rfq_id: int, body: LineAwardsSave, user: dict = Depends(get_current_user)):
    """줄별 매입처 채택을 저장한다. 보낸 줄만 반영하고 나머지는 건드리지 않는다.

    vendor_quote_id 를 비워 보내면 그 줄의 채택을 취소한다. 한 줄에 한 곳이므로
    같은 줄을 다시 저장하면 앞선 선택을 덮는다."""
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            raise HTTPException(status_code=404, detail="RFQ를 찾을 수 없습니다.")
        lines_src = [it for it in (rfq.items or [])
                     if isinstance(it, dict) and not is_option_row(it)]
        known = {line_id_of(it) for it in lines_src if line_id_of(it)}
        # 이 딜에 딸린 벤더 견적만 고를 수 있다 — 남의 딜 견적을 채택할 길을 막는다.
        vrfqs = s.query(VendorRFQ).filter_by(rfq_id=rfq.id).all()
        vendor_of_vrfq = {v.id: v.vendor_id for v in vrfqs}
        vq_map = {}
        if vrfqs:
            for q in s.query(VendorQuote).filter(
                    VendorQuote.vendor_rfq_id.in_(list(vendor_of_vrfq.keys()))).all():
                vq_map[q.id] = q
        now = _kst_iso(datetime.utcnow())
        saved, cleared = 0, 0
        for a in body.awards:
            lid = (a.lid or "").strip()
            if not lid:
                continue
            if lid not in known:
                raise HTTPException(
                    status_code=400,
                    detail=f"라인 ID를 알 수 없습니다({lid}). 1단계 품목을 한 번 저장해 라인 ID를 부여하세요.")
            row = s.query(DealLineAward).filter_by(rfq_id=rfq.id, lid=lid).first()
            if not a.vendor_quote_id:
                if row is not None:
                    s.delete(row)
                    cleared += 1
                continue
            q = vq_map.get(a.vendor_quote_id)
            if q is None:
                raise HTTPException(status_code=400, detail="이 딜의 벤더 견적이 아닙니다.")
            # 채택 시점의 값을 사본으로 남긴다 — 벤더가 견적을 고쳐 보내도 무엇을 보고
            # 골랐는지가 남는다(현재가는 vendor_quote_id 를 따라가면 언제든 다시 읽는다).
            hit = index_doc_by_line(lines_src, q.items or []).get(lid) or {}
            if row is None:
                row = DealLineAward(rfq_id=rfq.id, lid=lid)
                s.add(row)
            row.vendor_quote_id = q.id
            row.vendor_id = vendor_of_vrfq.get(q.vendor_rfq_id) or None
            row.unit_cost = _cell_cost(hit)
            row.currency = q.currency or "USD"
            row.lead_time = (hit.get("lead_time") or "")[:60]
            row.reason = ((a.reason or "").strip() or None)
            row.chosen_at = now
            row.chosen_by = (user.get("id") or None) if user else None
            saved += 1
        s.commit()
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        return {"ok": True, "saved": saved, "cleared": cleared, **_line_board(s, rfq)}
    finally:
        s.close()


@app.get("/api/admin/rfq/{rfq_id}/awarded-items", dependencies=[Depends(require_token)])
def awarded_items(rfq_id: int):
    """채택된 줄을 문서용 품목으로 — 4단계 고객 견적과 6단계 벤더 발주서가 쓴다.

    `items` 는 딜의 품목 순서 그대로다(고객이 보는 견적서는 우리가 어디서 샀는지가
    아니라 저들이 물어본 순서로 서야 한다). `by_vendor` 는 같은 줄을 벤더별로 묶은
    것으로, 발주서를 벤더 수만큼 나눠 뽑을 때 쓴다."""
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            raise HTTPException(status_code=404, detail="RFQ를 찾을 수 없습니다.")
        lines_src = [it for it in (rfq.items or [])
                     if isinstance(it, dict) and not is_option_row(it)]
        awards = {a.lid: a for a in s.query(DealLineAward).filter_by(rfq_id=rfq.id).all()}
        if not awards:
            return {"items": [], "by_vendor": [], "currencies": []}
        vq_ids = [a.vendor_quote_id for a in awards.values() if a.vendor_quote_id]
        vq_map = {q.id: q for q in s.query(VendorQuote).filter(VendorQuote.id.in_(vq_ids)).all()} if vq_ids else {}
        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}
        # 견적마다 그 문서의 줄을 딜 라인에 붙여 둔다(단가·납기는 벤더가 쓴 것을 쓴다).
        doc_lines = {qid: index_doc_by_line(lines_src, q.items or []) for qid, q in vq_map.items()}
        items, groups, currencies = [], {}, []
        for it in lines_src:
            lid = line_id_of(it)
            a = awards.get(lid) if lid else None
            if a is None or not a.vendor_quote_id:
                continue
            q = vq_map.get(a.vendor_quote_id)
            hit = (doc_lines.get(a.vendor_quote_id) or {}).get(lid) or {}
            cur = (q.currency if q else a.currency) or "USD"
            if cur not in currencies:
                currencies.append(cur)
            row = {
                "lid": lid,
                # 품번·품명은 우리가 받아 적은 쪽(딜)을 쓴다 — 고객이 쓴 말이 정본이다.
                # 벤더가 자기 품번으로 바꿔 적어 보내는 일이 흔한데, 그 번호를 고객
                # 견적서에 옮기면 우리 매입처의 코드를 고객에게 넘기는 셈이 된다.
                "part_no": it.get("part_no") or "",
                "description": it.get("description") or hit.get("description") or "",
                # 벤더 쪽 품번은 따로 실어 보낸다 — 발주서(6단계)는 이쪽을 써야
                # 벤더가 자기 번호로 알아본다.
                "vendor_part_no": hit.get("part_no") or "",
                "type": it.get("type") or hit.get("type") or "",
                "serial_no": it.get("serial_no") or hit.get("serial_no") or "",
                "maker": it.get("maker") or hit.get("maker") or hit.get("manufacturer") or "",
                "qty": it.get("qty", 1) or 1,
                "unit": hit.get("unit") or it.get("unit") or "PCS",
                "cost_price": a.unit_cost if a.unit_cost is not None else _cell_cost(hit),
                "currency": cur,
                "lead_time": hit.get("lead_time") or a.lead_time or "",
                "remark": it.get("remark") or "",
                "category_id": it.get("category_id"),
                "applied_to": it.get("applied_to"),
                "vendor_id": a.vendor_id or 0,
                "vendor": vendor_names.get(a.vendor_id, "") or "",
                "vendor_quote_id": a.vendor_quote_id,
                "vendor_quote_no": (q.vendor_quote_no or "") if q else "",
            }
            items.append(row)
            g = groups.setdefault(a.vendor_id or 0, {
                "vendor_id": a.vendor_id or 0,
                "vendor": row["vendor"],
                "currency": cur,
                "vendor_quote_ids": [],
                "items": [],
            })
            g["items"].append(row)
            if a.vendor_quote_id not in g["vendor_quote_ids"]:
                g["vendor_quote_ids"].append(a.vendor_quote_id)
        return {
            "items": items,
            "by_vendor": list(groups.values()),
            # 채택이 두 통화에 걸치면 고객 견적의 원가 통화를 하나로 고를 수 없다 —
            # 화면이 그 사실을 먼저 알려 주도록 함께 내보낸다.
            "currencies": currencies,
        }
    finally:
        s.close()
