"""K-Maris TMS — quotation routes (split from admin_api.py; behavior unchanged)."""
from __future__ import annotations

from _core import (
    Customer,
    CustomerQuoteCreate,
    CustomerQuoteUpdate,
    Depends,
    HTTPException,
    Order,
    Quotation,
    QuotationEmailPreviewReq,
    QuotationSendReq,
    QuotationStatus,
    RFQ,
    Response,
    User,
    Vessel,
    _apply_owner_filter,
    _base_meta,
    _enum_val,
    _first_rfq_iso,
    _kst_iso,
    _next_kmaris_quotation_no,
    _pipeline_stage,
    _project_no_map,
    _quotation_total,
    _rfq_no_disp,
    _status_label,
    app,
    build_payload,
    make_document_xlsx,
    date,
    datetime,
    generate_pdf,
    get_current_user,
    get_session,
    os,
    quotation_email_body,
    quotation_email_subject,
    require_token,
    send_email,
    default_from,
    USD_KRW_RATE,
)
from services.fx import get_deal_base_rate


@app.get("/api/admin/fx-rate", dependencies=[Depends(require_token)])
def fx_rate(date: str = "", cur: str = "USD"):
    """해당일의 매매기준율(수출입은행) 조회. cur↔KRW 환율(1 cur = ? KRW).

    조회 실패(주말·공휴일·인증키 미설정 등)면 고정환율로 폴백하고 source=fixed 로 알린다.
    프런트 '매매기준율' 토글에서 사용한다."""
    rate, used = get_deal_base_rate(date, cur)
    if rate is not None:
        return {"rate": round(rate, 4), "date_used": used, "cur": (cur or "USD").upper(),
                "source": "exim"}
    return {"rate": USD_KRW_RATE, "date_used": "", "cur": (cur or "USD").upper(),
            "source": "fixed"}



@app.get("/api/admin/quotation/next-no", dependencies=[Depends(require_token)])
def next_quotation_no_endpoint():
    """자동채번 미리보기 — 다음에 생성될 Quotation No.(KMS-QUO-yymm-nnn). 할당하지 않음.
    ('/quotation/{...}' 라우트보다 먼저 등록해 경로 충돌을 피한다.)"""
    s = get_session()
    try:
        return {"qtn_no": _next_kmaris_quotation_no(s)}
    finally:
        s.close()


@app.get("/api/admin/quotation-overview", dependencies=[Depends(require_token)])
def quotation_overview(customer_id: int | None = None,
                       mine: int = 0, assignee: int | None = None,
                       user: dict = Depends(get_current_user)):
    """Customer Quotation 현황 — 견적 목록(고객/선박/금액/상태/파이프라인)."""
    s = get_session()
    try:
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        vessel_names = {v.id: v.name for v in s.query(Vessel).all()}
        user_names = {u.id: u.username for u in s.query(User).all()}
        rfqs_all = s.query(RFQ).all()
        rfq_map = {r.id: r for r in rfqs_all}
        rfq_nos = {r.id: _rfq_no_disp(r.rfq_no) for r in rfqs_all}
        rfq_wt = {r.id: r.work_type for r in rfqs_all}

        q = s.query(Quotation)
        if customer_id:
            q = q.filter(Quotation.customer_id == customer_id)
        q = _apply_owner_filter(q, Quotation, user, mine, assignee)

        rows = []
        for qt in q.order_by(Quotation.id.desc()).all():
            stage = _pipeline_stage(s, qt.rfq_id) if qt.rfq_id else 0
            rows.append({
                "id": qt.id,
                "rfq_id": qt.rfq_id,
                "qtn_no": qt.qtn_no,
                "rfq_no": rfq_nos.get(qt.rfq_id, "") if qt.rfq_id else "",
                "customer": cust_names.get(qt.customer_id, "—"),
                "assignee": (user_names.get(getattr(rfq_map.get(qt.rfq_id), "created_by", None), "") or "") if qt.rfq_id else "",
                "assignee_id": (getattr(rfq_map.get(qt.rfq_id), "created_by", None) or 0) if qt.rfq_id else 0,
                "project_title": (getattr(rfq_map.get(qt.rfq_id), "project_title", None) or "") if qt.rfq_id else "",
                "contact_person": (getattr(rfq_map.get(qt.rfq_id), "contact_person", None) or "") if qt.rfq_id else "",
                "vessel": vessel_names.get(qt.vessel_id, "") if qt.vessel_id else "",
                "currency": qt.currency or "USD",
                "amount": round(_quotation_total(qt.items or [], getattr(qt, "discount_pct", 0) or 0), 2),
                "item_count": len(qt.items or []),
                "status": _enum_val(qt.status),
                "level": _enum_val(qt.follow_up_level) if qt.follow_up_level else "",
                "valid_until": qt.valid_until or "",
                "sent_at": getattr(qt, "sent_at", None) or "",
                "sent_date": getattr(qt, "sent_at", None) or qt.sent_date or "",
                "date": qt.date or "",
                "stage": stage,
                "pipeline": _status_label(stage, rfq_wt.get(qt.rfq_id)) if stage else "",
                # 공통 식별 컬럼
                "work_type": (_enum_val(rfq_wt.get(qt.rfq_id)) if rfq_wt.get(qt.rfq_id) else "부품공급"),
                "first_rfq_at": _first_rfq_iso(rfq_map.get(qt.rfq_id)),
                "project_no": _project_no_map(s).get(qt.rfq_id, "") if qt.rfq_id else "",
            })
        return {"rows": rows}
    finally:
        s.close()


@app.post("/api/admin/rfq/{rfq_id}/customer-quote",
          dependencies=[Depends(require_token)])
def create_customer_quote(rfq_id: int, body: CustomerQuoteCreate,
                          user: dict = Depends(get_current_user)):
    """Customer Quote 발신. 품목 단위 items가 있으면 그대로 저장한다."""
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            raise HTTPException(status_code=404, detail="RFQ를 찾을 수 없습니다.")

        items = body.items
        if not items:
            amount = float(body.amount or 0)
            items = [{"amount": amount, "qty": 1, "unit_price": amount}]

        terms = dict(body.terms or {})
        if body.remarks and not terms.get("remarks"):
            terms["remarks"] = body.remarks

        # 번호: 수동 입력값이 있으면 사용(중복 검사), 비우면 자동 채번(KMS-QUO-yymm-nnn).
        qtn_no = (body.qtn_no or "").strip() or None
        if qtn_no and s.query(Quotation).filter_by(qtn_no=qtn_no).first():
            raise HTTPException(status_code=409, detail="Quotation No. already exists.")
        if not qtn_no:
            qtn_no = _next_kmaris_quotation_no(s)
        sent_at = (body.sent_at or "").strip()
        qtn = Quotation(
            qtn_no=qtn_no,
            rfq_id=rfq.id,
            customer_id=rfq.customer_id,
            vessel_id=rfq.vessel_id,
            currency=(body.currency or "USD"),
            cost_currency=(body.cost_currency or None),
            round_digits=body.round_digits,
            discount_pct=(body.discount_pct or 0.0),
            fx_rate=body.fx_rate,
            status=QuotationStatus.SENT,
            valid_until=body.valid_until,
            items=items,
            terms=terms,
            date=date.today().strftime("%Y-%m-%d"),
            sent_date=(sent_at[:10] if sent_at else date.today().strftime("%Y-%m-%d")),
            sent_at=(sent_at or None),
            created_by=(user.get("id") or None),   # 담당자 = 발행한 내부 직원
        )
        s.add(qtn)
        s.commit()
        return {"ok": True, "id": qtn.id, "qtn_no": qtn.qtn_no or ""}
    finally:
        s.close()


@app.get("/api/admin/quotation/{qtn_id}", dependencies=[Depends(require_token)])
def customer_quotation_detail(qtn_id: int):
    """Customer Quotation 1건 상세 — 원본 품목(cost/margin 등)·거래조건 포함."""
    s = get_session()
    try:
        qtn = s.query(Quotation).filter_by(id=qtn_id).first()
        if not qtn:
            raise HTTPException(status_code=404, detail="견적서를 찾을 수 없습니다.")
        cust = s.query(Customer).filter_by(id=qtn.customer_id).first()
        vessel = s.query(Vessel).filter_by(id=qtn.vessel_id).first() if qtn.vessel_id else None
        rfq = s.query(RFQ).filter_by(id=qtn.rfq_id).first() if qtn.rfq_id else None
        return {
            "id": qtn.id,
            "qtn_no": qtn.qtn_no,
            "rfq_id": qtn.rfq_id,
            "assignee_id": (rfq.created_by or 0) if rfq else 0,
            "rfq_no": _rfq_no_disp(rfq.rfq_no) if rfq else "",
            **_base_meta(s, rfq),   # 공통 기본정보(고객·선박·업무·Project No.·최초 RFQ)
            "currency": qtn.currency or "USD",
            "cost_currency": getattr(qtn, "cost_currency", None) or "",
            "round_digits": getattr(qtn, "round_digits", None),
            "discount_pct": getattr(qtn, "discount_pct", 0) or 0,
            "fx_rate": getattr(qtn, "fx_rate", None),
            "amount": round(_quotation_total(qtn.items or [], getattr(qtn, "discount_pct", 0) or 0), 2),
            "valid_until": qtn.valid_until or "",
            "status": _enum_val(qtn.status),
            "level": _enum_val(qtn.follow_up_level) if qtn.follow_up_level else "",
            "sent_at": getattr(qtn, "sent_at", None) or "",
            "sent_date": getattr(qtn, "sent_at", None) or qtn.sent_date or "",
            "date": qtn.date or "",
            "terms": qtn.terms or {},
            "items": qtn.items or [],
            # 고객 정보에 등록된 기본 결제조건(상세 편집 시 payment_terms 기본값용)
            "default_payment_terms": (getattr(cust, "payment_terms", None) or "") if cust else "",
        }
    finally:
        s.close()


@app.put("/api/admin/quotation/{qtn_id}", dependencies=[Depends(require_token)])
def update_customer_quotation(qtn_id: int, body: CustomerQuoteUpdate):
    """Customer Quotation 수정 — 통화·유효기간·상태·거래조건·품목 교체."""
    s = get_session()
    try:
        qtn = s.query(Quotation).filter_by(id=qtn_id).first()
        if not qtn:
            raise HTTPException(status_code=404, detail="견적서를 찾을 수 없습니다.")
        if body.qtn_no is not None:
            qtn_no = body.qtn_no.strip()
            if qtn_no:
                dup = s.query(Quotation).filter(Quotation.qtn_no == qtn_no, Quotation.id != qtn_id).first()
                if dup:
                    raise HTTPException(status_code=409, detail="Quotation No. already exists.")
                qtn.qtn_no = qtn_no
        if body.sent_at is not None:
            sent_at = body.sent_at.strip()
            qtn.sent_at = sent_at or None
            qtn.sent_date = sent_at[:10] if sent_at else None
        if body.currency is not None:
            qtn.currency = body.currency or "USD"
        if body.cost_currency is not None:
            qtn.cost_currency = body.cost_currency or None
        if body.round_digits is not None:
            qtn.round_digits = body.round_digits
        if body.discount_pct is not None:
            qtn.discount_pct = body.discount_pct
        if body.fx_rate is not None:
            qtn.fx_rate = body.fx_rate
        if body.valid_until is not None:
            qtn.valid_until = body.valid_until or None
        if body.terms is not None:
            qtn.terms = body.terms
        if body.items is not None:
            qtn.items = body.items
        if body.status is not None and body.status.strip():
            try:
                qtn.status = QuotationStatus(body.status.strip())
            except ValueError:
                pass
        s.commit()
        return {"ok": True, "qtn_no": qtn.qtn_no}
    finally:
        s.close()


@app.delete("/api/admin/quotation/{qtn_id}", dependencies=[Depends(require_token)])
def delete_customer_quotation(qtn_id: int):
    """Customer Quotation 삭제 — 오더로 진행된 견적은 거부한다."""
    s = get_session()
    try:
        qtn = s.query(Quotation).filter_by(id=qtn_id).first()
        if not qtn:
            raise HTTPException(status_code=404, detail="견적서를 찾을 수 없습니다.")
        if s.query(Order).filter_by(quotation_id=qtn_id).first():
            raise HTTPException(status_code=400,
                detail="이미 오더로 진행된 견적입니다. 삭제할 수 없습니다.")
        qtn_no = qtn.qtn_no
        s.query(Quotation).filter_by(id=qtn_id).delete(synchronize_session=False)
        s.commit()
        return {"ok": True, "qtn_no": qtn_no}
    finally:
        s.close()


def _quotation_payload(s, qtn):
    """견적서 문서(PDF/Excel) payload — 고객·선박·품목·약관 + 헤더 문서필드.
    Messrs·Attn.·Ref No. 는 terms JSON 에 저장(비어 있으면 담당자/고객 RFQ No. 로 시드)."""
    cust = s.query(Customer).filter_by(id=qtn.customer_id).first()
    vessel = s.query(Vessel).filter_by(id=qtn.vessel_id).first() if qtn.vessel_id else None
    rfq = s.query(RFQ).filter_by(id=qtn.rfq_id).first() if getattr(qtn, "rfq_id", None) else None
    project_title = (getattr(rfq, "project_title", None) or "") if rfq else ""
    tm = qtn.terms or {}
    ref_no = tm.get("ref_no") or ((getattr(rfq, "customer_rfq_no", None) or "") if rfq else "")
    attn = tm.get("attn") or (getattr(cust, "contact", None) or "" if cust else "")
    messrs = tm.get("messrs") or ""
    return build_payload(
        doc_no=qtn.qtn_no,
        date=qtn.date or date.today().isoformat(),
        customer=cust,
        vessel=vessel,
        items=qtn.items or [],
        terms=tm,
        currency=qtn.currency or "USD",
        vat_rate=qtn.vat_rate or 0.0,
        valid_until=qtn.valid_until or "",
        discount_pct=getattr(qtn, "discount_pct", 0) or 0.0,
        project_title=project_title,
        ref_no=ref_no,
        attn=attn,
        messrs=messrs,
    )


@app.get("/api/admin/quotations/{qtn_id}/pdf", dependencies=[Depends(require_token)])
def quotation_pdf(qtn_id: int, doc_type: str = "quotation"):
    s = get_session()
    try:
        qtn = s.query(Quotation).filter_by(id=qtn_id).first()
        if not qtn:
            raise HTTPException(status_code=404, detail="견적서를 찾을 수 없습니다.")
        payload = _quotation_payload(s, qtn)
        pdf = generate_pdf(doc_type, payload)
        return Response(
            content=pdf,
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{qtn.qtn_no}.pdf"'},
        )
    finally:
        s.close()


@app.get("/api/admin/quotations/{qtn_id}/xlsx", dependencies=[Depends(require_token)])
def quotation_xlsx(qtn_id: int, doc_type: str = "quotation"):
    s = get_session()
    try:
        qtn = s.query(Quotation).filter_by(id=qtn_id).first()
        if not qtn:
            raise HTTPException(status_code=404, detail="견적서를 찾을 수 없습니다.")
        payload = _quotation_payload(s, qtn)
        xlsx = make_document_xlsx(doc_type, payload)
        return Response(
            content=xlsx,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{qtn.qtn_no}.xlsx"'},
        )
    finally:
        s.close()


@app.post("/api/admin/quotations/{qtn_id}/email-preview", dependencies=[Depends(require_token)])
def quotation_email_preview(qtn_id: int, body: QuotationEmailPreviewReq):
    s = get_session()
    try:
        qtn = s.query(Quotation).filter_by(id=qtn_id).first()
        if not qtn:
            raise HTTPException(status_code=404, detail="견적서를 찾을 수 없습니다.")
        cust = s.query(Customer).filter_by(id=qtn.customer_id).first()
        lang = "kr" if body.lang in ("ko", "kr") else "en"
        return {
            "to": (cust.email if cust else "") or "",
            "from": default_from(),
            "subject": quotation_email_subject(qtn.qtn_no, lang),
            "body": quotation_email_body(cust.name if cust else "Customer", qtn.qtn_no, "", lang),
            "smtp_configured": bool(os.getenv("SMTP_USER") and os.getenv("SMTP_PASSWORD")),
        }
    finally:
        s.close()


@app.post("/api/admin/quotations/{qtn_id}/send", dependencies=[Depends(require_token)])
def quotation_send(qtn_id: int, body: QuotationSendReq):
    s = get_session()
    try:
        qtn = s.query(Quotation).filter_by(id=qtn_id).first()
        if not qtn:
            raise HTTPException(status_code=404, detail="견적서를 찾을 수 없습니다.")
        if not body.to.strip():
            raise HTTPException(status_code=400, detail="수신자 이메일을 입력하세요.")
        cust = s.query(Customer).filter_by(id=qtn.customer_id).first()
        payload = _quotation_payload(s, qtn)
        if body.format == "xlsx":
            attach = (f"{qtn.qtn_no}.xlsx", make_document_xlsx(body.doc_type, payload))
        else:
            attach = (f"{qtn.qtn_no}.pdf", generate_pdf(body.doc_type, payload))
        sent = send_email(
            to=body.to.strip(),
            subject=body.subject,
            body=body.body,
            attachments=[attach],
            cc=body.cc.strip(),
            from_addr=body.from_email.strip(),
        )
        if not sent:
            raise HTTPException(status_code=400, detail="이메일 발송 실패 — SMTP 설정 또는 서버 상태를 확인하세요.")
        qtn.status = QuotationStatus.SENT
        # 사용자가 발송일시를 직접 입력했으면 보존하고, 비어 있을 때만 발송 시각으로 채운다.
        if not (getattr(qtn, "sent_at", None) or qtn.sent_date):
            qtn.sent_at = _kst_iso(datetime.utcnow())
            qtn.sent_date = qtn.sent_at[:10]
        s.commit()
        return {"ok": True, "sent_date": qtn.sent_at or qtn.sent_date}
    finally:
        s.close()
