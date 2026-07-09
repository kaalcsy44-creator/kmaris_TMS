"""K-Maris TMS — rfq routes (split from admin_api.py; behavior unchanged)."""
from __future__ import annotations

from _core import (
    Customer,
    Depends,
    File,
    FollowUpLevel,
    _deal_identity,
    HTTPException,
    INTERNAL_STEPS,
    Order,
    Quotation,
    RFQ,
    RFQStatus,
    RfqAssignNo,
    RfqCreate,
    RfqLevelUpdate,
    RfqCancelUpdate,
    RfqUpdate,
    StageDateUpdate,
    StageNoteAdd,
    StageNoteDelete,
    StageNoteUpdate,
    UploadFile,
    User,
    Vendor,
    VendorQuote,
    VendorRFQ,
    Vessel,
    WorkType,
    USD_KRW_RATE,
    _apply_owner_filter,
    _assign_rfq_no,
    _next_kmaris_rfq_no,
    _coerce_work_type,
    _dual_money,
    _enum_val,
    _first_rfq_iso,
    _fmt_received,
    _item_view,
    _items_cost_total,
    _kst,
    _kst_iso,
    _new_tmp_rfq_no,
    _ocr_image_media_type,
    _pipeline_stage,
    _project_no_map,
    _rfq_no_disp,
    _status_label,
    _total_amount,
    _vrfq_sent_iso,
    app,
    datetime,
    extract_text_from_pdf,
    get_current_user,
    get_session,
    parse_rfq_fields,
    parse_rfq_image,
    require_token,
    steps_for,
)



@app.get("/api/admin/rfq-overview", dependencies=[Depends(require_token)])
def rfq_overview(customer_id: int | None = None, work_type: str | None = None,
                 mine: int = 0, assignee: int | None = None,
                 user: dict = Depends(get_current_user)):
    """RFQ 거래별 통합 현황 — Streamlit render_overview 와 동일한 행 데이터를 JSON으로."""
    s = get_session()
    try:
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        vessel_names = {v.id: v.name for v in s.query(Vessel).all()}
        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}
        user_names = {u.id: u.username for u in s.query(User).all()}

        q = s.query(RFQ).order_by(RFQ.id.desc())
        if customer_id:
            q = q.filter(RFQ.customer_id == customer_id)
        wt = _coerce_work_type(work_type)
        if wt is not None:
            q = q.filter(RFQ.work_type == wt)
        q = _apply_owner_filter(q, RFQ, user, mine, assignee)
        rfqs = q.all()

        rows = []
        for r in rfqs:
            stage = _pipeline_stage(s, r.id)

            vrfqs = (s.query(VendorRFQ).filter_by(rfq_id=r.id)
                     .order_by(VendorRFQ.id.desc()).all())
            if vrfqs:
                vr0 = vrfqs[0]
                vrfq_at = _fmt_received(_vrfq_sent_iso(vr0))
                # "2. Vendor RFQ 발신" 칼럼은 발송한 Vendor사 이름을 표시한다.
                _vnames = []
                for x in vrfqs:
                    nm = vendor_names.get(x.vendor_id, "—")
                    if nm not in _vnames:
                        _vnames.append(nm)
                vrfq_vendors = _vnames[0] + (f"  (외 {len(_vnames) - 1}곳)" if len(_vnames) > 1 else "")
            else:
                vrfq_at, vrfq_vendors = "", ""

            vrfq_ids = [x.id for x in vrfqs]
            vqs = (s.query(VendorQuote)
                   .filter(VendorQuote.vendor_rfq_id.in_(vrfq_ids))
                   .order_by(VendorQuote.id.desc()).all()
                   if vrfq_ids else [])
            if vqs:
                vq0 = vqs[0]
                _vq_no = getattr(vq0, "vendor_quote_no", None) or "—"
                vq_main = str(_vq_no) + (f"  (외 {len(vqs) - 1}건)" if len(vqs) > 1 else "")
                vq_at = _kst(vq0.created_at)
                # 매입(견적) 금액은 수신한 모든 벤더 견적을 합산(견적이 여러 건이면 각기 다른
                # 품목 담당 → 전체 매입원가). 통화 혼재 시 USD 환산 합산 후 대표 통화로 표기.
                _disp_vcur = (getattr(vq0, "currency", None) or "USD").upper()
                _vendor_usd_sum = 0.0
                for _vq in vqs:
                    _vc = (getattr(_vq, "currency", None) or "USD").upper()
                    _vt = _items_cost_total(_vq.items)
                    _vendor_usd_sum += (_vt / USD_KRW_RATE) if _vc == "KRW" else _vt
                vendor_amount = (
                    _dual_money(_vendor_usd_sum * USD_KRW_RATE, "KRW")
                    if _disp_vcur == "KRW"
                    else _dual_money(_vendor_usd_sum, "USD")
                )
            else:
                vq_main, vq_at, vendor_amount = "", "", ""

            qtns = (s.query(Quotation).filter_by(rfq_id=r.id)
                    .order_by(Quotation.id.desc()).all())
            if qtns:
                qtn0 = qtns[0]
                qtn_main, qtn_at = qtn0.qtn_no, _kst(qtn0.created_at)
                # 매출(견적) 금액은 발행한 모든 고객 견적 합산(각기 다른 품목 담당).
                # 통화 혼재 시 USD 환산 합산 후 대표(최신) 견적 통화로 표기.
                _c_disp = (qtn0.currency or "USD").upper()
                _cust_usd_sum = 0.0
                for _q in qtns:
                    _qc = (getattr(_q, "currency", None) or "USD").upper()
                    _qt = _total_amount(_q.items or [])
                    _cust_usd_sum += (_qt / USD_KRW_RATE) if _qc == "KRW" else _qt
                customer_amount = (
                    _dual_money(_cust_usd_sum * USD_KRW_RATE, "KRW")
                    if _c_disp == "KRW"
                    else _dual_money(_cust_usd_sum, "USD")
                )
            else:
                qtn_main, qtn_at, customer_amount = "", "", ""

            rows.append({
                "id": r.id,
                "customer_rfq_no": r.customer_rfq_no or "",
                # 공통 식별 컬럼(Deal identity): customer·vessel·assignee·level·
                # work_type·project_title·contact_person·first_rfq_at·project_no
                **_deal_identity(s, r, cust_names=cust_names,
                                 vessel_names=vessel_names, user_names=user_names),
                "item_count": len(r.items or []),
                "crfq_no": _rfq_no_disp(r.rfq_no),
                "crfq_at": _fmt_received(getattr(r, "received_at", None) or "") or _kst(r.created_at),
                # K-Maris RFQ No.는 Vendor RFQ 발신 시점에 부여된다. 발신한 거래에서만 표시.
                "vrfq_kmaris_no": (_rfq_no_disp(r.rfq_no) if vrfqs else ""),
                "vrfq_vendors": vrfq_vendors,
                "vrfq_at": vrfq_at,
                "vquote_no": vq_main,
                "vquote_at": vq_at,
                "vendor_amount": vendor_amount,
                "cquote_no": qtn_main,
                "cquote_at": qtn_at,
                "customer_amount": customer_amount,
                "stage": stage,
                "status": _status_label(stage, r.work_type),
            })

        return {"steps": INTERNAL_STEPS, "rows": rows}
    finally:
        s.close()


@app.get("/api/admin/rfq/next-no", dependencies=[Depends(require_token)])
def next_rfq_no_endpoint():
    """자동채번 미리보기 — 다음에 생성될 K-Maris RFQ No.(할당하지 않음).
    ('/rfq/{rfq_id}' 보다 먼저 등록해 'next-no' 가 int 파싱으로 가려지지 않게 한다.)"""
    s = get_session()
    try:
        return {"rfq_no": _next_kmaris_rfq_no(s)}
    finally:
        s.close()


@app.get("/api/admin/rfq/{rfq_id}", dependencies=[Depends(require_token)])
def rfq_detail(rfq_id: int):
    """RFQ 1건 상세 — 품목, 12단계 진행, 연결 문서(Vendor RFQ/Quote/Quotation)."""
    s = get_session()
    try:
        r = s.query(RFQ).filter_by(id=rfq_id).first()
        if not r:
            raise HTTPException(status_code=404, detail="RFQ not found")

        cust = s.query(Customer).filter_by(id=r.customer_id).first()
        vessel = s.query(Vessel).filter_by(id=r.vessel_id).first() if r.vessel_id else None
        pic = s.query(User).filter_by(id=r.created_by).first() if r.created_by else None
        stage = _pipeline_stage(s, r.id)

        vrfqs = (s.query(VendorRFQ).filter_by(rfq_id=r.id)
                 .order_by(VendorRFQ.id.desc()).all())
        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}
        vrfq_view = [{
            "id": v.id,
            "vendor": vendor_names.get(v.vendor_id, "—"),
            "at": _fmt_received(_vrfq_sent_iso(v)),
        } for v in vrfqs]

        vrfq_ids = [v.id for v in vrfqs]
        vqs = (s.query(VendorQuote)
               .filter(VendorQuote.vendor_rfq_id.in_(vrfq_ids))
               .order_by(VendorQuote.id.desc()).all() if vrfq_ids else [])
        vquote_view = [{
            "vendor_quote_no": getattr(q, "vendor_quote_no", None) or "—",
            "amount": _dual_money(_items_cost_total(q.items), getattr(q, "currency", None) or "USD"),
            "at": _kst(q.created_at),
        } for q in vqs]

        qtn = (s.query(Quotation).filter_by(rfq_id=r.id)
               .order_by(Quotation.id.desc()).first())
        qtn_view = None
        if qtn:
            qtn_view = {
                "qtn_no": qtn.qtn_no,
                "amount": _dual_money(_total_amount(qtn.items or []), qtn.currency),
                "status": _enum_val(qtn.status),
                "at": _kst(qtn.created_at),
            }

        steps = [{
            "no": i,
            "name": name,
            "state": ("done" if i < stage else "current" if i == stage else "todo"),
        } for i, name in enumerate(steps_for(r.work_type), start=1)]

        return {
            "id": r.id,
            "rfq_no": _rfq_no_disp(r.rfq_no),
            "assignee_id": r.created_by or 0,   # 담당자(PIC)
            "assignee": pic.username if pic else "",   # 담당자(PIC) username(비활성/삭제 시 빈값)
            "customer_rfq_no": r.customer_rfq_no or "",
            "contact_person": getattr(r, "contact_person", None) or "",
            "customer": cust.name if cust else "—",
            "customer_id": r.customer_id or 0,
            "customer_contact": (cust.contact if cust else "") or "",
            "customer_email": (cust.email if cust else "") or "",
            "vessel": vessel.name if vessel else "",
            "vessel_id": r.vessel_id or 0,
            "project_title": getattr(r, "project_title", None) or "",
            "work_type": _enum_val(r.work_type) if r.work_type else "부품공급",
            "received_at": getattr(r, "received_at", None) or "",
            "first_rfq_at": _first_rfq_iso(r),
            "project_no": _project_no_map(s).get(r.id, ""),
            "date": r.date or "",
            "notes": r.notes or "",
            "request_channel": getattr(r, "request_channel", None) or "",
            "follow_up_level": _enum_val(r.follow_up_level) if r.follow_up_level else "B",
            "stage": stage,
            "status": _status_label(stage, r.work_type),
            "steps": steps,
            "items": [_item_view(it) for it in (r.items or [])],
            "source_files": getattr(r, "source_files", None) or [],
            "vendor_rfqs": vrfq_view,
            "vendor_quotes": vquote_view,
            "quotation": qtn_view,
        }
    finally:
        s.close()


@app.post("/api/admin/ocr/rfq", dependencies=[Depends(require_token)])
def ocr_rfq_pdf(file: UploadFile = File(...)):
    """Customer RFQ 자동 입력 — PDF(텍스트 추출) 또는 이미지/캡쳐(Claude 비전) 지원."""
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
            return parse_rfq_image(file.file.read(), img_media, customer_names)
        if fname.endswith(".pdf"):
            raw_text = extract_text_from_pdf(file.file)
            if not raw_text:
                raise HTTPException(status_code=400, detail="PDF에서 텍스트를 추출할 수 없습니다.")
            return parse_rfq_fields(raw_text, customer_names)
        raise HTTPException(status_code=400, detail="PDF 또는 이미지(PNG·JPG·WEBP) 파일만 업로드할 수 있습니다.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"OCR 추출 실패: {exc}") from exc


def _clean_source_files(src) -> list[dict]:
    """Auto-fill 소스 파일 메타를 정규화(파일명 없는 항목 제외, 시각 기본값 채움)."""
    out = []
    for f in (src or []):
        name = (getattr(f, "name", "") or "").strip()
        if not name:
            continue
        out.append({
            "name": name,
            "media_type": (getattr(f, "media_type", "") or "").strip(),
            "item_count": int(getattr(f, "item_count", 0) or 0),
            "at": (getattr(f, "at", "") or "").strip() or _kst_iso(datetime.utcnow()),
        })
    return out


@app.post("/api/admin/rfq", dependencies=[Depends(require_token)])
def create_rfq(body: RfqCreate, user: dict = Depends(get_current_user)):
    """Customer RFQ 신규 등록. 케이마리스 RFQ No.는 기본적으로 미발급(임시) 상태로
    두고 Vendor RFQ 발신 시점에 부여한다. body.rfq_no 로 수동 선지정도 가능."""
    s = get_session()
    try:
        cust = s.query(Customer).filter_by(id=body.customer_id).first()
        if not cust:
            raise HTTPException(status_code=400, detail="Customer를 선택하세요.")
        items = [{
            "part_no": (it.part_no or "").strip(),
            "description": (it.description or "").strip(),
            "type": (it.type or "").strip(),
            "serial_no": (it.serial_no or "").strip(),
            "qty": it.qty or 1,
            "remark": (it.remark or "").strip(),
        } for it in body.items if (it.part_no or it.description)]
        src_files = _clean_source_files(body.source_files)

        try:
            work_type = WorkType(body.work_type) if body.work_type else WorkType.PARTS
        except ValueError:
            work_type = WorkType.PARTS

        manual_no = (body.rfq_no or "").strip()
        if manual_no:
            if s.query(RFQ).filter_by(rfq_no=manual_no).first():
                raise HTTPException(status_code=400, detail=f"이미 존재하는 RFQ No.입니다: {manual_no}")
            rfq_no = manual_no
        else:
            rfq_no = _new_tmp_rfq_no(s)   # 미발급 — Vendor RFQ 발신 시 부여

        received_at = (body.received_at or "").strip() or _kst_iso(datetime.utcnow())
        rfq = RFQ(
            rfq_no=rfq_no,
            customer_rfq_no=(body.customer_rfq_no or "").strip() or None,
            contact_person=(body.contact_person or "").strip() or None,
            project_title=(body.project_title or "").strip() or None,
            work_type=work_type,
            request_channel=(body.request_channel or "").strip() or None,
            notes=(body.notes or "").strip() or None,
            customer_id=cust.id,
            vessel_id=body.vessel_id,
            date=received_at[:10],
            received_at=received_at,
            status=RFQStatus.RECEIVED,
            items=items,
            source_files=src_files,
            created_by=(user.get("id") or None),   # 담당자 = 등록한 내부 직원
        )
        s.add(rfq)
        s.commit()
        return {"ok": True, "id": rfq.id, "rfq_no": _rfq_no_disp(rfq_no)}
    finally:
        s.close()


@app.post("/api/admin/rfq/{rfq_id}/assign-no", dependencies=[Depends(require_token)])
def assign_rfq_no_endpoint(rfq_id: int, body: RfqAssignNo):
    """케이마리스 RFQ No. 단독 발번(미발급이면 부여, 이미 발급됐으면 유지)."""
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            raise HTTPException(status_code=404, detail="RFQ를 찾을 수 없습니다.")
        no = _assign_rfq_no(s, rfq, body.mode, body.rfq_no)
        s.commit()
        return {"ok": True, "rfq_no": _rfq_no_disp(no)}
    finally:
        s.close()


@app.patch("/api/admin/rfq/{rfq_id}", dependencies=[Depends(require_token)])
def update_rfq(rfq_id: int, body: RfqUpdate):
    """업무 타입·고객사·선박·고객 RFQ No.·프로젝트 제목 등 RFQ 헤더 필드를 수정한다."""
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            raise HTTPException(status_code=404, detail="RFQ를 찾을 수 없습니다.")

        if body.customer_id is not None:
            cust = s.query(Customer).filter_by(id=body.customer_id).first()
            if not cust:
                raise HTTPException(status_code=400, detail="Customer를 찾을 수 없습니다.")
            rfq.customer_id = body.customer_id
        if body.vessel_id is not None:
            # 0/음수 → 선박 미지정으로 해제
            if body.vessel_id <= 0:
                rfq.vessel_id = None
            else:
                vessel = s.query(Vessel).filter_by(id=body.vessel_id).first()
                if not vessel:
                    raise HTTPException(status_code=400, detail="선박을 찾을 수 없습니다.")
                rfq.vessel_id = body.vessel_id
        if body.customer_rfq_no is not None:
            rfq.customer_rfq_no = body.customer_rfq_no.strip() or None
        if body.rfq_no is not None:
            new_no = body.rfq_no.strip()
            if new_no and new_no != rfq.rfq_no:
                dup = s.query(RFQ).filter(RFQ.rfq_no == new_no, RFQ.id != rfq_id).first()
                if dup:
                    raise HTTPException(status_code=400, detail=f"이미 존재하는 RFQ No.입니다: {new_no}")
                rfq.rfq_no = new_no
        if body.contact_person is not None:
            rfq.contact_person = body.contact_person.strip() or None
        if body.project_title is not None:
            rfq.project_title = body.project_title.strip() or None
        if body.request_channel is not None:
            rfq.request_channel = body.request_channel.strip() or None
        if body.notes is not None:
            rfq.notes = body.notes.strip() or None
        if body.work_type is not None:
            wt = _coerce_work_type(body.work_type)
            if wt is None:
                raise HTTPException(status_code=400, detail="잘못된 업무 타입입니다.")
            rfq.work_type = wt
        if body.received_at is not None:
            recv = body.received_at.strip()
            if recv:
                rfq.received_at = recv
                rfq.date = recv[:10]
        if body.assignee_id is not None:
            # 0/음수 → 담당자 미지정 해제. 그 외엔 해당 직원이 존재할 때만 지정.
            if body.assignee_id <= 0:
                rfq.created_by = None
            elif s.query(User).filter_by(id=body.assignee_id).first():
                rfq.created_by = body.assignee_id
            else:
                raise HTTPException(status_code=400, detail="담당자(사용자)를 찾을 수 없습니다.")
        if body.items is not None:
            rfq.items = [{
                "part_no": (it.part_no or "").strip(),
                "description": (it.description or "").strip(),
                "type": (it.type or "").strip(),
                "serial_no": (it.serial_no or "").strip(),
                "qty": it.qty or 1,
                "remark": (it.remark or "").strip(),
            } for it in body.items if (it.part_no or it.description)]
        if body.source_files is not None:
            # 프론트가 현재 전체 목록을 보내므로 통째로 교체.
            rfq.source_files = _clean_source_files(body.source_files)

        s.commit()
        return {"ok": True, "id": rfq.id}
    finally:
        s.close()


@app.put("/api/admin/rfq/{rfq_id}/level", dependencies=[Depends(require_token)])
def update_rfq_level(rfq_id: int, body: RfqLevelUpdate):
    """RFQ Follow-up Level(A/B/C) 변경. 상태(12단계)는 진행에 따라 자동 반영되므로
    여기서는 Level 만 수정한다 (Streamlit 2_CRFQ.py render_rfq_detail 패리티)."""
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            raise HTTPException(status_code=404, detail="RFQ를 찾을 수 없습니다.")
        try:
            rfq.follow_up_level = FollowUpLevel(body.follow_up_level)
        except ValueError:
            raise HTTPException(status_code=400, detail="잘못된 Level 값입니다.")
        s.commit()
        return {"ok": True, "follow_up_level": _enum_val(rfq.follow_up_level)}
    finally:
        s.close()


@app.put("/api/admin/rfq/{rfq_id}/cancel", dependencies=[Depends(require_token)])
def update_rfq_cancel(rfq_id: int, body: RfqCancelUpdate):
    """딜을 종결(취소/실주)로 표시하거나 재활성화한다.
    종결 → status=LOST (보드에서 Cancelled 존으로 분류), 재활성 → status=RECEIVED.
    진행 단계(stage)는 레코드 기반 자동 산출이라 건드리지 않는다."""
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            raise HTTPException(status_code=404, detail="RFQ를 찾을 수 없습니다.")
        rfq.status = RFQStatus.LOST if body.cancelled else RFQStatus.RECEIVED
        s.commit()
        return {"ok": True, "cancelled": body.cancelled}
    finally:
        s.close()


@app.put("/api/admin/rfq/{rfq_id}/stage-date", dependencies=[Depends(require_token)])
def update_rfq_stage_date(rfq_id: int, body: StageDateUpdate):
    """내부 12단계 중 한 단계의 완료 일시를 수동 입력/수정/해제한다."""
    if not (1 <= body.stage <= len(INTERNAL_STEPS)):
        raise HTTPException(status_code=400, detail="잘못된 단계 번호입니다.")
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            raise HTTPException(status_code=404, detail="RFQ를 찾을 수 없습니다.")
        # JSON 컬럼은 새 dict 로 재할당해야 변경이 감지된다.
        dates = dict(getattr(rfq, "stage_dates", None) or {})
        key = str(body.stage)
        val = (body.value or "").strip()
        if val:
            dates[key] = val
        else:
            dates.pop(key, None)
        rfq.stage_dates = dates
        s.commit()
        return {"ok": True, "stage_dates": dates}
    finally:
        s.close()


@app.post("/api/admin/rfq/{rfq_id}/stage-note", dependencies=[Depends(require_token)])
def add_rfq_stage_note(rfq_id: int, body: StageNoteAdd):
    """내부 12단계 중 한 단계에 코멘트/활동이력을 추가한다(누적 기록).
    날짜·시각·소통 상대(Customer/Vendor)·소통 수단(이메일/통화/문자 등)·내용을 함께 저장."""
    if not (1 <= body.stage <= len(INTERNAL_STEPS)):
        raise HTTPException(status_code=400, detail="잘못된 단계 번호입니다.")
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="활동 내용을 입력하세요.")
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            raise HTTPException(status_code=404, detail="RFQ를 찾을 수 없습니다.")
        notes = dict(getattr(rfq, "stage_notes", None) or {})
        key = str(body.stage)
        log = list(notes.get(key, []))
        log.append({
            "text": text,
            "datetime": (body.datetime or "").strip() or _kst_iso(datetime.utcnow()),
            "party": (body.party or "").strip(),
            "channel": (body.channel or "").strip(),
            "at": _kst_iso(datetime.utcnow()),   # 기록 생성 시각(감사용)
        })
        notes[key] = log
        rfq.stage_notes = notes  # JSON 컬럼은 새 dict 재할당이 필요
        s.commit()
        return {"ok": True, "stage": body.stage, "notes": log}
    finally:
        s.close()


@app.post("/api/admin/rfq/{rfq_id}/stage-note-update", dependencies=[Depends(require_token)])
def update_rfq_stage_note(rfq_id: int, body: StageNoteUpdate):
    """기존 활동 기록 1건을 수정한다. 생성 시각(at)은 유지한다."""
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="활동 내용을 입력하세요.")
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            raise HTTPException(status_code=404, detail="RFQ를 찾을 수 없습니다.")
        notes = dict(getattr(rfq, "stage_notes", None) or {})
        key = str(body.stage)
        log = list(notes.get(key, []))
        if not (0 <= body.index < len(log)):
            raise HTTPException(status_code=400, detail="잘못된 기록 인덱스입니다.")
        old = log[body.index]
        log[body.index] = {
            "text": text,
            "datetime": (body.datetime or "").strip() or old.get("datetime") or _kst_iso(datetime.utcnow()),
            "party": (body.party or "").strip(),
            "channel": (body.channel or "").strip(),
            "at": old.get("at") or _kst_iso(datetime.utcnow()),  # 생성 시각 유지
        }
        notes[key] = log
        rfq.stage_notes = notes
        s.commit()
        return {"ok": True, "stage": body.stage, "notes": log}
    finally:
        s.close()


@app.post("/api/admin/rfq/{rfq_id}/stage-note-delete", dependencies=[Depends(require_token)])
def delete_rfq_stage_note(rfq_id: int, body: StageNoteDelete):
    """단계 코멘트 1건 삭제."""
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            raise HTTPException(status_code=404, detail="RFQ를 찾을 수 없습니다.")
        notes = dict(getattr(rfq, "stage_notes", None) or {})
        key = str(body.stage)
        log = list(notes.get(key, []))
        if 0 <= body.index < len(log):
            log.pop(body.index)
            if log:
                notes[key] = log
            else:
                notes.pop(key, None)
            rfq.stage_notes = notes
            s.commit()
        return {"ok": True, "stage": body.stage, "notes": notes.get(key, [])}
    finally:
        s.close()


@app.delete("/api/admin/rfq/{rfq_id}", dependencies=[Depends(require_token)])
def delete_rfq(rfq_id: int):
    """RFQ 삭제. 연결된 Vendor RFQ/Quote 도 함께 삭제한다. 단, 이미 Customer
    Quotation 이나 Order 로 진행된 건은 데이터 보호를 위해 삭제를 막는다."""
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            raise HTTPException(status_code=404, detail="RFQ를 찾을 수 없습니다.")

        if s.query(Quotation).filter_by(rfq_id=rfq_id).first():
            raise HTTPException(status_code=400,
                detail="이미 Customer Quotation 이 연결된 RFQ 입니다. 먼저 견적을 정리하세요.")
        if s.query(Order).filter_by(rfq_id=rfq_id).first():
            raise HTTPException(status_code=400,
                detail="이미 Order 로 진행된 RFQ 입니다. 삭제할 수 없습니다.")

        rfq_no = rfq.rfq_no
        vrfq_ids = [v.id for v in s.query(VendorRFQ).filter_by(rfq_id=rfq_id).all()]
        if vrfq_ids:
            (s.query(VendorQuote)
             .filter(VendorQuote.vendor_rfq_id.in_(vrfq_ids))
             .delete(synchronize_session=False))
        s.query(VendorRFQ).filter_by(rfq_id=rfq_id).delete(synchronize_session=False)
        s.query(RFQ).filter_by(id=rfq_id).delete(synchronize_session=False)
        s.commit()
        return {"ok": True, "rfq_no": rfq_no}
    finally:
        s.close()
