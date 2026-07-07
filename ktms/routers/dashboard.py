"""K-Maris TMS — dashboard routes (split from admin_api.py; behavior unchanged)."""
from __future__ import annotations

from _core import (
    ARRecord,
    ARStatus,
    CommercialInvoice,
    Customer,
    Depends,
    FollowUpLevel,
    INTERNAL_STEPS,
    ORDER_STEPS,
    Order,
    OrderStatus,
    PurchaseOrder,
    Quotation,
    QuotationStatus,
    RFQ,
    RFQStatus,
    RFQ_STEPS,
    USD_KRW_RATE,
    User,
    Vendor,
    VendorQuote,
    VendorRFQ,
    Vessel,
    _apply_owner_filter,
    _coerce_work_type,
    _cur2,
    _dual_money,
    _enum_val,
    _first_rfq_iso,
    _fmt_received,
    _items_cost_total,
    _kst,
    _month_key,
    _order_for_rfq,
    _orders_for_rfq,
    _pipeline_stage,
    _project_no_map,
    _quotation_total,
    _rfq_for_order,
    _rfq_no_disp,
    _search_href,
    _stage_auto_times,
    _next_action,
    _last_activity_iso,
    _days_since_iso,
    steps_for,
    _status_label,
    _total_amount,
    _vrfq_sent_iso,
    app,
    date,
    datetime,
    get_current_user,
    get_session,
    order_tracking_step,
    require_token,
    rfq_tracking_step,
    timedelta,
    timezone,
)



@app.get("/api/admin/pipeline", dependencies=[Depends(require_token)])
def pipeline_overview(customer_id: int | None = None, work_type: str | None = None,
                      mine: int = 0, assignee: int | None = None,
                      user: dict = Depends(get_current_user)):
    """거래(RFQ) 1건 = 1행으로, RFQ→Quote(1~4)와 Order→Vendor PO(5~6) 체인을 한 번에
    합친 통합 파이프라인. 진행현황(내부확인용)이 RFQ표·PO표를 대체하는 단일 목록으로 쓴다."""
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
        today_iso = (datetime.utcnow() + timedelta(hours=9)).date().isoformat()  # KST
        for r in rfqs:
            stage = _pipeline_stage(s, r.id)

            # 2) Vendor RFQ 발신
            vrfqs = (s.query(VendorRFQ).filter_by(rfq_id=r.id)
                     .order_by(VendorRFQ.id.desc()).all())
            if vrfqs:
                _vnames = []
                for x in vrfqs:
                    nm = vendor_names.get(x.vendor_id, "—")
                    if nm not in _vnames:
                        _vnames.append(nm)
                # 복수 벤더는 모두 줄바꿈으로 기재(프런트 white-space:pre-line).
                vrfq_vendors = "\n".join(_vnames)
                vrfq_at = _fmt_received(_vrfq_sent_iso(vrfqs[0]))
            else:
                vrfq_vendors, vrfq_at = "", ""

            # 3) Vendor Quot. 수신
            vrfq_ids = [x.id for x in vrfqs]
            vqs = (s.query(VendorQuote)
                   .filter(VendorQuote.vendor_rfq_id.in_(vrfq_ids))
                   .order_by(VendorQuote.id.desc()).all() if vrfq_ids else [])
            if vqs:
                vq0 = vqs[0]
                _vq_no = getattr(vq0, "vendor_quote_no", None) or "—"
                vquote_no = str(_vq_no) + (f"  (외 {len(vqs) - 1}건)" if len(vqs) > 1 else "")
                vquote_at = _kst(vq0.created_at)
                _cur = getattr(vq0, "currency", None) or "USD"
                _vendor_total = _items_cost_total(vq0.items)
                vendor_amount = _dual_money(_vendor_total, _cur)
                vendor_usd = (_vendor_total / USD_KRW_RATE) if _cur.upper() == "KRW" else _vendor_total
            else:
                vquote_no, vquote_at, vendor_amount = "", "", ""
                vendor_usd = None

            # 4) Customer Quot. 발신
            qtn = (s.query(Quotation).filter_by(rfq_id=r.id)
                   .order_by(Quotation.id.desc()).first())
            if qtn:
                cquote_no, cquote_at = qtn.qtn_no, _kst(qtn.created_at)
                _customer_total = _total_amount(qtn.items or [])
                _c_cur = (qtn.currency or "USD").upper()
                customer_amount = _dual_money(_customer_total, qtn.currency)
                customer_usd = (_customer_total / USD_KRW_RATE) if _c_cur == "KRW" else _customer_total
            else:
                cquote_no, cquote_at, customer_amount = "", "", ""
                customer_usd = None

            # 5) Customer P/O 수신 · 6) Vendor P/O 발신
            o = _order_for_rfq(s, r.id)
            vpos = (s.query(PurchaseOrder).filter_by(order_id=o.id)
                    .order_by(PurchaseOrder.id.desc()).all()) if o else []
            if vpos:
                vp0 = vpos[0]
                vendor_po_no = (vp0.po_no or "—") + (f"  (외 {len(vpos) - 1}건)" if len(vpos) > 1 else "")
                # 발주서가 복수 벤더로 나간 경우 모두 줄바꿈으로 기재.
                _po_vnames: list[str] = []
                for vp in vpos:
                    nm = vendor_names.get(vp.vendor_id, "—")
                    if nm not in _po_vnames:
                        _po_vnames.append(nm)
                vendor_po_vendor = "\n".join(_po_vnames)
                vendor_po_email = vp0.sent_to_email or "—"
                vendor_po_at = _kst(vp0.created_at)
            else:
                vendor_po_no = vendor_po_vendor = vendor_po_email = vendor_po_at = ""

            # 카드 금액(딜 총액): 한 프로젝트에 고객 P/O(오더)가 여러 건이면 모두 합산한다.
            # 통화가 섞이면 USD 로 환산해 합산 후, 대표(첫) 오더 통화로 표기.
            orders_all = _orders_for_rfq(s, r.id)
            if orders_all:
                disp_cur = (getattr(orders_all[0], "currency", None) or "USD").upper()
                total_usd = 0.0
                for oo in orders_all:
                    t = _total_amount(oo.items or [])
                    oc = (getattr(oo, "currency", None) or "USD").upper()
                    total_usd += (t / USD_KRW_RATE) if oc == "KRW" else t
                order_amount = (
                    _dual_money(total_usd * USD_KRW_RATE, "KRW")
                    if disp_cur == "KRW"
                    else _dual_money(total_usd, "USD")
                )
            else:
                order_amount = ""

            # 마진 = 수주(고객 견적) − 발주(벤더 견적). 통화가 섞일 수 있어 USD 로 환산해
            # 계산한 뒤 이중통화 문자열로 표기한다. 둘 중 하나라도 없으면 마진은 빈 값.
            if customer_usd is not None and vendor_usd is not None:
                _margin_usd = customer_usd - vendor_usd
                margin_amount = _dual_money(_margin_usd, "USD")
                margin_pct = round(_margin_usd / customer_usd * 100, 1) if customer_usd else None
            else:
                margin_amount, margin_pct = "", None

            # 품목 요약 — 카드/사이드바에 "(첫 품목) 외 N unit" 형태로 표기하기 위한 첫 품목명.
            _row_items = (o.items if o else None) or r.items or []
            item_count = len(_row_items)
            _it0 = _row_items[0] if _row_items else {}
            first_item = (_it0.get("description") or _it0.get("part_no") or "").strip()

            # 단계 일시·노트 + 다음 액션(P3). stage_auto 는 한 번만 계산해 재사용.
            _sd = getattr(r, "stage_dates", None) or {}
            _auto = _stage_auto_times(s, r, o)
            _sn = getattr(r, "stage_notes", None) or {}
            _lost = _enum_val(r.status) == RFQStatus.LOST.value
            _stalled = (
                _days_since_iso(_last_activity_iso(_sd, _auto, _sn), today_iso)
                if (stage < 12 and not _lost) else None
            )
            _na = _next_action(stage, steps_for(r.work_type), lost=_lost, stalled_days=_stalled)

            rows.append({
                "rfq_id": r.id,
                "order_id": o.id if o else 0,
                # 식별
                "customer_rfq_no": r.customer_rfq_no or "",
                "kmaris_rfq_no": _rfq_no_disp(r.rfq_no),
                "work_type": _enum_val(r.work_type) if r.work_type else "부품공급",
                "trade_type": (o.trade_type if o else "수출") or "수출",
                "customer": cust_names.get(r.customer_id, "—"),
                "customer_id": r.customer_id or 0,
                "vessel": (vessel_names.get(r.vessel_id) if r.vessel_id else "") or "",
                "vessel_id": r.vessel_id or 0,
                "project_title": getattr(r, "project_title", None) or "",
                "received_at": getattr(r, "received_at", None) or "",
                "first_rfq_at": _first_rfq_iso(r),
                "project_no": _project_no_map(s).get(r.id, ""),
                # 담당자(PIC) = created_by 직원. 직접 지정 가능(설정 시 created_by 갱신).
                "assignee": user_names.get(getattr(r, "created_by", None), "") or "",
                "assignee_id": getattr(r, "created_by", None) or 0,
                "item_count": item_count,
                "first_item": first_item,
                "crfq_at": _fmt_received(getattr(r, "received_at", None) or "") or _kst(r.created_at),
                # 1~4 RFQ 체인
                "vrfq_vendors": vrfq_vendors,
                "vrfq_at": vrfq_at,
                "vquote_no": vquote_no,
                "vquote_at": vquote_at,
                "vendor_amount": vendor_amount,
                "cquote_no": cquote_no,
                "cquote_at": cquote_at,
                "customer_amount": customer_amount,
                # 마진(수주−발주) — 이중통화 문자열 + 마진율(%). 한쪽이라도 없으면 빈 값/None.
                "margin_amount": margin_amount,
                "margin_pct": margin_pct,
                # 딜 총액(고객 P/O 여러 건 합산) — PO 이후 단계 카드 금액에 사용.
                "order_amount": order_amount,
                # 5~6 PO 체인
                "customer_po_no": (o.po_no if o else "") or "",
                "customer_po_at": _kst(o.created_at) if o else "",
                "vendor_po_no": vendor_po_no,
                "vendor_po_at": vendor_po_at,
                "vendor": vendor_po_vendor,
                "vendor_email": vendor_po_email,
                # 상태 · 단계 일시
                "stage": stage,
                "status": _status_label(stage, r.work_type),
                "stage_dates": _sd,
                "stage_auto": _auto,
                "stage_notes": _sn,
                # 다음 액션(P3) — stage 단일 소스 + 실주/정체 예외
                "next_action": _na["text"],
                "next_level": _na["level"],
            })

        return {"steps": INTERNAL_STEPS, "rows": rows}
    finally:
        s.close()


@app.get("/api/admin/search", dependencies=[Depends(require_token)])
def global_search(q: str = "", limit: int = 40, user: dict = Depends(get_current_user)):
    """전역 통합 검색 — RFQ(프로젝트) 1건을 단위로 식별자·품목·연락처·관련 문서번호까지
    훑어 매칭 결과를 반환한다. 본인 담당 스코프(own)는 파이프라인과 동일하게 강제된다."""
    term = (q or "").strip().lower()
    if len(term) < 2:
        return {"results": [], "query": q}
    tokens = [t for t in term.split() if t]

    s = get_session()
    try:
        cust = {c.id: c for c in s.query(Customer).all()}
        vessels = {v.id: v for v in s.query(Vessel).all()}
        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}
        user_names = {u.id: u.username for u in s.query(User).all()}
        proj_map = _project_no_map(s)

        base = s.query(RFQ).order_by(RFQ.id.desc())
        base = _apply_owner_filter(base, RFQ, user, 0, None)
        rfqs = base.all()
        rfq_ids = [r.id for r in rfqs]

        # 관련 문서를 RFQ마다 개별 조회하면(N+1) 스코프가 커질수록 검색이 느려진다.
        # 스코프 내 벤더RFQ·벤더견적·견적·오더·벤더PO를 한 번에 벌크 로드해
        # rfq_id / order_id 기준 맵으로 만들어 이후 메모리에서만 매칭한다.
        vrfq_by_rfq: dict[int, list] = {}
        all_vrfqs = (s.query(VendorRFQ).filter(VendorRFQ.rfq_id.in_(rfq_ids)).all()
                     if rfq_ids else [])
        for x in all_vrfqs:
            vrfq_by_rfq.setdefault(x.rfq_id, []).append(x)
        vrfq_rfq = {x.id: x.rfq_id for x in all_vrfqs}

        vq_by_rfq: dict[int, list] = {}
        vrfq_ids = list(vrfq_rfq)
        all_vqs = (s.query(VendorQuote).filter(VendorQuote.vendor_rfq_id.in_(vrfq_ids)).all()
                   if vrfq_ids else [])
        for vq in all_vqs:
            rid = vrfq_rfq.get(vq.vendor_rfq_id)
            if rid:
                vq_by_rfq.setdefault(rid, []).append(vq)

        qtn_latest_by_rfq: dict[int, Quotation] = {}
        qtn_rfq: dict[int, int] = {}
        all_qtns = (s.query(Quotation).filter(Quotation.rfq_id.in_(rfq_ids))
                    .order_by(Quotation.id.asc()).all() if rfq_ids else [])
        for qt in all_qtns:
            qtn_rfq[qt.id] = qt.rfq_id
            qtn_latest_by_rfq[qt.rfq_id] = qt  # asc 정렬 → 마지막(최고 id)이 최신으로 남는다

        # 오더: 직접 연결(rfq_id) 우선, 없으면 Quotation 경유. (_order_for_rfq 벌크판)
        order_by_rfq: dict[int, Order] = {}
        for o in (s.query(Order).filter(Order.rfq_id.in_(rfq_ids))
                  .order_by(Order.created_at.desc()).all() if rfq_ids else []):
            order_by_rfq.setdefault(o.rfq_id, o)  # created_at desc → 첫 항목이 최신
        all_qtn_ids = list(qtn_rfq)
        for o in (s.query(Order).filter(Order.quotation_id.in_(all_qtn_ids))
                  .order_by(Order.created_at.desc()).all() if all_qtn_ids else []):
            rid = qtn_rfq.get(o.quotation_id)
            if rid and rid not in order_by_rfq:
                order_by_rfq[rid] = o

        po_by_order: dict[int, list] = {}
        order_ids = [o.id for o in order_by_rfq.values()]
        for vp in (s.query(PurchaseOrder).filter(PurchaseOrder.order_id.in_(order_ids)).all()
                   if order_ids else []):
            po_by_order.setdefault(vp.order_id, []).append(vp)

        results = []
        for r in rfqs:
            # 검색 대상 텍스트를 (분류 라벨, 텍스트) 쌍으로 모은다.
            fields: list[tuple[str, str]] = []

            def add(label: str, *vals) -> None:
                for v in vals:
                    if v:
                        fields.append((label, str(v)))

            c = cust.get(r.customer_id)
            ves = vessels.get(r.vessel_id) if r.vessel_id else None
            proj_no = proj_map.get(r.id, "")
            add("Customer RFQ No.", r.customer_rfq_no)
            add("K-Maris RFQ No.", _rfq_no_disp(r.rfq_no))
            add("Project No.", proj_no)
            add("Project title", getattr(r, "project_title", None))
            add("Customer", c.name if c else None)
            add("Contact", getattr(c, "contact", None), getattr(c, "email", None))
            add("Vessel", ves.name if ves else None, getattr(ves, "imo", None) if ves else None)
            add("PIC", user_names.get(getattr(r, "created_by", None)))
            add("Notes", getattr(r, "notes", None))
            for it in (r.items or []):
                add("Item", it.get("part_no"), it.get("description"))

            # 관련 문서(벤더 RFQ·벤더 견적·고객 견적·오더·벤더 PO) — 벌크 맵에서 조회.
            for x in vrfq_by_rfq.get(r.id, []):
                add("Vendor", vendor_names.get(x.vendor_id), x.sent_to_email)
            for vq in vq_by_rfq.get(r.id, []):
                add("Vendor quote No.", getattr(vq, "vendor_quote_no", None))
                for it in (vq.items or []):
                    add("Item", it.get("part_no"), it.get("description"))
            qtn = qtn_latest_by_rfq.get(r.id)
            if qtn:
                add("Quotation No.", qtn.qtn_no)
            o = order_by_rfq.get(r.id)
            if o:
                add("Customer PO No.", o.po_no)
                for vp in po_by_order.get(o.id, []):
                    add("Vendor PO No.", vp.po_no)
                    add("Vendor", vendor_names.get(vp.vendor_id))

            blob = "\n".join(t.lower() for _, t in fields)
            if not all(tok in blob for tok in tokens):
                continue

            # 매칭 필드/스니펫 = 첫 토큰을 포함하는 첫 항목.
            primary = tokens[0]
            matched_label, matched_text = "", ""
            for label, text in fields:
                if primary in text.lower():
                    matched_label, matched_text = label, text
                    break

            stage = _pipeline_stage(s, r.id)
            is_service = (_enum_val(r.work_type) if r.work_type else "부품공급") == "서비스"
            results.append({
                "rfq_id": r.id,
                "order_id": o.id if o else 0,
                "project_no": proj_no,
                "customer": c.name if c else "—",
                "vessel": (ves.name if ves else "") or "",
                "project_title": getattr(r, "project_title", None) or "",
                "status": _status_label(stage, r.work_type),
                "stage": stage,
                "matched_label": matched_label,
                "matched_text": matched_text,
                "href": _search_href(stage, r.id, o.id if o else 0, is_service),
            })
            if len(results) >= limit:
                break

        return {"results": results, "query": q}
    finally:
        s.close()


@app.get("/api/admin/dashboard", dependencies=[Depends(require_token)])
def dashboard():
    """운영 현황 요약 — 핵심 KPI + 12단계 분포 + 최근 RFQ."""
    s = get_session()
    try:
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        vessel_names = {v.id: v.name for v in s.query(Vessel).all()}
        rfqs = s.query(RFQ).all()
        orders = s.query(Order).all()
        quotes = s.query(Quotation).all()
        ars = s.query(ARRecord).all()

        today_iso = date.today().isoformat()
        soon_iso = (date.today() + timedelta(days=7)).isoformat()
        urgent_cutoff = (date.today() + timedelta(days=3)).isoformat()

        # ── 운영 KPI ──────────────────────────────────────────────────────────
        open_rfq = sum(1 for r in rfqs if r.status in
                       {RFQStatus.RECEIVED, RFQStatus.SOURCING, RFQStatus.QUOTING})
        active_orders = sum(1 for o in orders if o.status in
                            {OrderStatus.RECEIVED, OrderStatus.PO_SENT, OrderStatus.PREPARING,
                             OrderStatus.SHIPPED, OrderStatus.IN_TRANSIT})

        now = datetime.now(timezone.utc)
        monthly_quotes = sum(
            1 for q in quotes
            if q.created_at and q.created_at.year == now.year
            and q.created_at.month == now.month
        )
        ar_outstanding = sum(
            (a.invoice_amount or 0) - (a.paid_amount or 0)
            for a in ars
            if a.status in {ARStatus.OUTSTANDING, ARStatus.PARTIAL, ARStatus.OVERDUE}
            and (a.currency or "USD") == "USD"
        )

        urgent = [q for q in quotes
                  if q.status == QuotationStatus.SENT
                  and q.follow_up_level == FollowUpLevel.A
                  and q.valid_until and q.valid_until <= urgent_cutoff]
        overdue = [a for a in ars if a.status == ARStatus.OVERDUE]
        pending_po = sum(1 for o in orders if o.status == OrderStatus.RECEIVED)
        expiring = sum(
            1 for q in quotes
            if q.status in (QuotationStatus.SENT, QuotationStatus.NEGOTIATING)
            and q.valid_until and today_iso <= q.valid_until <= soon_iso
        )

        # ── 영업 성과 KPI ─────────────────────────────────────────────────────
        total_rfq = len(rfqs)
        sent_quote_rfq_ids = {q.rfq_id for q in quotes
                              if q.rfq_id and q.status != QuotationStatus.DRAFT}
        handling_rate = (len(sent_quote_rfq_ids) / total_rfq * 100) if total_rfq else 0.0

        rfq_created = {r.id: r.created_at for r in rfqs}
        _tat = []
        for q in quotes:
            base = rfq_created.get(q.rfq_id) if q.rfq_id else None
            if base and q.created_at and q.status != QuotationStatus.DRAFT:
                h = (q.created_at - base).total_seconds() / 3600
                if h >= 0:
                    _tat.append(h)
        quotation_tat_h = (sum(_tat) / len(_tat)) if _tat else None

        _sent_like = {QuotationStatus.SENT, QuotationStatus.NEGOTIATING,
                      QuotationStatus.WON, QuotationStatus.LOST, QuotationStatus.EXPIRED}
        sent_quotes = [q for q in quotes if q.status in _sent_like]
        won_quotes = [q for q in quotes if q.status == QuotationStatus.WON]
        hit_rate = (len(won_quotes) / len(sent_quotes) * 100) if sent_quotes else 0.0

        # 매출(판매가)은 앱 전역과 동일하게 amount 기반(_quotation_total, 할인 반영)으로,
        # 원가는 cost_price 합(_items_cost_total)으로 잡는다. 예전엔 매출을 unit_price 로
        # 계산했으나 견적 품목은 판매가를 amount 에 저장해 매출이 과소 집계 → 마진이
        # 비정상적으로 음수(-800%대)로 나오던 버그를 수정. 견적 통화가 섞일 수 있어 각
        # 견적을 USD 로 환산한 뒤 합산해 단일 마진율을 낸다.
        margin_basis = won_quotes or sent_quotes
        _rev = _cost = 0.0
        for q in margin_basis:
            fx = (1.0 / USD_KRW_RATE) if _cur2(q.currency) == "KRW" else 1.0
            _rev += _quotation_total(q.items or [], getattr(q, "discount_pct", 0) or 0) * fx
            _cost += _items_cost_total(q.items or []) * fx
        gross_margin_pct = ((_rev - _cost) / _rev * 100) if _rev else 0.0

        negotiating_value_usd = 0.0
        for q in quotes:
            if q.status == QuotationStatus.NEGOTIATING and (q.currency or "USD") == "USD":
                for it in (q.items or []):
                    amt = it.get("amount")
                    if amt in (None, ""):
                        amt = float(it.get("unit_price", 0) or 0) * float(it.get("qty", 1) or 1)
                    negotiating_value_usd += float(amt or 0)

        dist = [0] * len(INTERNAL_STEPS)
        for r in rfqs:
            dist[_pipeline_stage(s, r.id) - 1] += 1

        recent = []
        for r in sorted(rfqs, key=lambda x: x.id, reverse=True)[:8]:
            stage = _pipeline_stage(s, r.id)
            recent.append({
                "rfq_no": _rfq_no_disp(r.rfq_no),
                "customer": cust_names.get(r.customer_id, "—"),
                "stage": stage,
                "status": _status_label(stage, r.work_type),
                "at": _kst(r.created_at),
            })

        # ── Snapshot: 고객 추적(RFQ/Order) + 내부 12단계 (per-RFQ) ───────────────
        def _cv(cid, vid) -> str:
            nm = cust_names.get(cid, "—")
            vn = vessel_names.get(vid) if vid else None
            return f"{nm} · {vn}" if vn else nm

        snapshot = []
        for r in sorted(rfqs, key=lambda x: x.id, reverse=True)[:20]:
            o = _order_for_rfq(s, r.id)
            order_row = None
            if o:
                order_row = {
                    "customer_vessel": _cv(o.customer_id, o.vessel_id),
                    "status": _enum_val(o.status),
                    "item_count": len(o.items or []),
                    "date": o.date or "—",
                    "step": order_tracking_step(_enum_val(o.status))[0],
                }
            _lvl = getattr(r, "follow_up_level", None)
            snapshot.append({
                "id": r.id,
                "rfq_no": _rfq_no_disp(r.rfq_no),
                "customer_rfq_no": r.customer_rfq_no or "",
                "project_title": getattr(r, "project_title", None) or "",
                "customer": cust_names.get(r.customer_id, "—"),
                "vessel": (vessel_names.get(r.vessel_id) if r.vessel_id else "") or "",
                "customer_vessel": _cv(r.customer_id, r.vessel_id),
                "stage_dates": getattr(r, "stage_dates", None) or {},
                "stage_auto": _stage_auto_times(s, r, o),
                "status": _enum_val(r.status),
                "item_count": len(r.items or []),
                "follow_up_level": _enum_val(_lvl) if _lvl else "—",
                "date": r.date or "—",
                "step": rfq_tracking_step(_enum_val(r.status))[0],
                "stage": _pipeline_stage(s, r.id),
                "order": order_row,
            })

        return {
            "kpi": {
                "open_rfq": open_rfq,
                "total_rfq": len(rfqs),
                "active_orders": active_orders,
                "monthly_quotes": monthly_quotes,
                "ar_outstanding_usd": round(ar_outstanding, 2),
            },
            "ops": {
                "urgent": len(urgent),
                "pending_po": pending_po,
                "overdue": len(overdue),
                "expiring": expiring,
            },
            "perf": {
                "handling_rate": round(handling_rate, 0),
                "quotation_tat_h": round(quotation_tat_h, 0) if quotation_tat_h is not None else None,
                "hit_rate": round(hit_rate, 0),
                "gross_margin_pct": round(gross_margin_pct, 1),
                "negotiating_value_usd": round(negotiating_value_usd, 0),
            },
            "alerts": {
                "urgent_quotes": [
                    {"qtn_no": q.qtn_no, "valid_until": q.valid_until or "",
                     "status": _enum_val(q.status)} for q in urgent
                ],
                "overdue_ar": [
                    {"ci_no": a.ci_no or "", "currency": a.currency or "USD",
                     "outstanding": round((a.invoice_amount or 0) - (a.paid_amount or 0), 2),
                     "due_date": a.due_date or ""} for a in overdue
                ],
            },
            "steps": INTERNAL_STEPS,
            "stage_distribution": dist,
            "recent": recent,
            "snapshot": snapshot,
            "rfq_steps": RFQ_STEPS,
            "order_steps": ORDER_STEPS,
        }
    finally:
        s.close()


@app.get("/api/admin/statistics", dependencies=[Depends(require_token)])
def statistics(months: int = 12):
    """통계 대시보드 — 월별 시계열(매출·견적·수주), 랭킹(고객·품목), KPI, 업무알림.

    금액은 USD/KRW 통화별로 분리 집계(환산 없음, 프런트 토글로 전환).
    매출 인식 시점은 세금계산서 발행일(RFQ.stage_dates["11"]) 기준.
    """
    months = max(1, min(int(months or 12), 36))
    s = get_session()
    try:
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        orders_all = s.query(Order).all()
        order_map = {o.id: o for o in orders_all}
        rfq_map = {r.id: r for r in s.query(RFQ).all()}

        # ── 월 버킷(최근 N개월, KST) ───────────────────────────────────────────
        now_kst = datetime.now(timezone.utc) + timedelta(hours=9)
        month_labels: list[str] = []
        y, m = now_kst.year, now_kst.month
        for _ in range(months):
            month_labels.append(f"{y:04d}-{m:02d}")
            m -= 1
            if m == 0:
                m = 12
                y -= 1
        month_labels.reverse()
        month_set = set(month_labels)
        cur_month = month_labels[-1]
        prev_month = month_labels[-2] if len(month_labels) >= 2 else ""

        CURS = ("USD", "KRW")
        # series[currency][metric] = {month: amount}
        def _blank():
            return {cur: {mo: 0.0 for mo in month_labels} for cur in CURS}
        rev_series = _blank()
        quote_series = _blank()
        order_series = _blank()
        cust_rev: dict[str, dict[str, float]] = {c: {} for c in CURS}
        item_rev: dict[str, dict[str, dict]] = {c: {} for c in CURS}

        # RFQ.id → 세금계산서 발행월(stage_dates["11"]) 매핑
        def _issue_month(rfq) -> str:
            sd = (getattr(rfq, "stage_dates", None) or {}) if rfq else {}
            return _month_key(sd.get("11") or "")

        # ── 매출(세금계산서 발행 기준) + 고객사 랭킹 ─────────────────────────────
        for a in s.query(ARRecord).all():
            o = order_map.get(a.order_id)
            rfq = _rfq_for_order(s, o) if o else None
            mo = _issue_month(rfq)
            if not mo or mo not in month_set:
                continue
            cur = _cur2(a.currency)
            amt = float(a.invoice_amount or 0)
            rev_series[cur][mo] += amt
            cname = cust_names.get(o.customer_id, "—") if o else "—"
            cust_rev[cur][cname] = cust_rev[cur].get(cname, 0.0) + amt

        # ── 견적금액(발송월 기준) ───────────────────────────────────────────────
        for q in s.query(Quotation).all():
            mo = _month_key(getattr(q, "sent_at", None) or q.sent_date or q.date or "")
            if not mo or mo not in month_set:
                continue
            cur = _cur2(q.currency)
            quote_series[cur][mo] += _quotation_total(q.items or [], getattr(q, "discount_pct", 0) or 0)

        # ── 수주금액(오더 수주월 기준) ──────────────────────────────────────────
        for o in orders_all:
            mo = _month_key(o.date or (o.created_at.isoformat() if o.created_at else ""))
            if not mo or mo not in month_set:
                continue
            qtn = s.query(Quotation).filter_by(id=o.quotation_id).first() if o.quotation_id else None
            if qtn:
                cur = _cur2(qtn.currency)
                amt = _quotation_total(qtn.items or [], getattr(qtn, "discount_pct", 0) or 0)
            else:
                cur = "USD"
                amt = _total_amount(o.items or [])
            order_series[cur][mo] += amt

        # ── 품목별 매출(청구 품목=CI items 기준, 기간 내) ────────────────────────
        for ci in s.query(CommercialInvoice).all():
            mo = _month_key(ci.date or "")
            if not mo or mo not in month_set:
                continue
            cur = _cur2(ci.currency)
            for it in (ci.items or []):
                pn = (it.get("part_no") or "").strip() or "—"
                amt = it.get("amount")
                if amt in (None, ""):
                    amt = float(it.get("unit_price", 0) or 0) * float(it.get("qty", 1) or 1)
                rec = item_rev[cur].setdefault(pn, {"part_no": pn, "description": it.get("description") or "", "amount": 0.0})
                rec["amount"] += float(amt or 0)

        def _series_list(series):
            return {cur: [round(series[cur][mo], 2) for mo in month_labels] for cur in CURS}

        def _top(dmap, key_field, n=10):
            out = {}
            for cur in CURS:
                if key_field == "customer":
                    items = [{"name": k, "amount": round(v, 2)} for k, v in dmap[cur].items()]
                else:
                    items = [{"part_no": r["part_no"], "description": r["description"], "amount": round(r["amount"], 2)} for r in dmap[cur].values()]
                items.sort(key=lambda x: x["amount"], reverse=True)
                out[cur] = items[:n]
            return out

        # ── KPI(이번 달 + 전월대비) ─────────────────────────────────────────────
        def _kpi():
            out = {}
            for cur in CURS:
                out[cur] = {
                    "revenue": round(rev_series[cur][cur_month], 2),
                    "revenue_prev": round(rev_series[cur].get(prev_month, 0.0), 2) if prev_month else 0.0,
                    "order": round(order_series[cur][cur_month], 2),
                    "order_prev": round(order_series[cur].get(prev_month, 0.0), 2) if prev_month else 0.0,
                    "quote": round(quote_series[cur][cur_month], 2),
                    "quote_prev": round(quote_series[cur].get(prev_month, 0.0), 2) if prev_month else 0.0,
                }
            return out

        # ── 업무 알림 ───────────────────────────────────────────────────────────
        today_iso = now_kst.strftime("%Y-%m-%d")
        week_iso = (now_kst + timedelta(days=7)).strftime("%Y-%m-%d")
        cutoff60 = (now_kst - timedelta(days=60)).strftime("%Y-%m-%d")

        def _cust_of(o):
            return cust_names.get(o.customer_id, "—") if o else "—"

        today_delivery, week_delivery, uninvoiced, unreceived_po = [], [], [], []
        for o in orders_all:
            pd = o.promised_delivery or ""
            delivered = bool(o.delivered_date)
            rfq = _rfq_for_order(s, o)
            pno = _project_no_map(s).get(rfq.id, "") if rfq else ""
            if pd and not delivered:
                if pd[:10] == today_iso:
                    today_delivery.append({"order_id": o.id, "project_no": pno, "customer": _cust_of(o), "date": pd})
                elif today_iso < pd[:10] <= week_iso:
                    week_delivery.append({"order_id": o.id, "project_no": pno, "customer": _cust_of(o), "date": pd})
            # 미청구: 인도완료(delivered_date) 이나 세금계산서(11단계) 미발행
            sd = (getattr(rfq, "stage_dates", None) or {}) if rfq else {}
            if delivered and not sd.get("11"):
                uninvoiced.append({"order_id": o.id, "project_no": pno, "customer": _cust_of(o), "date": o.delivered_date or ""})

        # 미입고 발주: 발송된 Vendor P/O 인데 해당 오더가 아직 미인도
        for po in s.query(PurchaseOrder).all():
            o = order_map.get(po.order_id)
            sent = (po.status == "이메일 발송완료") or bool(po.sent_date)
            if sent and o and not o.delivered_date:
                rfq = _rfq_for_order(s, o)
                pno = _project_no_map(s).get(rfq.id, "") if rfq else ""
                unreceived_po.append({"order_id": o.id, "po_no": po.po_no or "", "project_no": pno, "customer": _cust_of(o), "date": po.sent_date or ""})

        # 미회신 견적: 발송/협상 상태 & 발송 후 7일 경과(수주·실주 아님)
        unanswered = []
        wk_ago = (now_kst - timedelta(days=7)).strftime("%Y-%m-%d")
        for q in s.query(Quotation).all():
            if q.status in (QuotationStatus.SENT, QuotationStatus.NEGOTIATING):
                sd = (getattr(q, "sent_at", None) or q.sent_date or q.date or "")[:10]
                if sd and sd <= wk_ago:
                    unanswered.append({"rfq_id": q.rfq_id, "qtn_no": q.qtn_no or "", "customer": cust_names.get(q.customer_id, "—"), "date": sd, "status": _enum_val(q.status)})

        # 장기 미수금: 연체 & 만기 60일 초과
        long_overdue = []
        for a in s.query(ARRecord).all():
            outstanding = (a.invoice_amount or 0) - (a.paid_amount or 0)
            if a.status != ARStatus.PAID and a.due_date and a.due_date < cutoff60 and outstanding > 0:
                o = order_map.get(a.order_id)
                long_overdue.append({"order_id": a.order_id, "ci_no": a.ci_no or "", "customer": _cust_of(o), "due_date": a.due_date, "currency": _cur2(a.currency), "outstanding": round(outstanding, 2)})

        # 납기 지연 건수: 약속납기 지난 미인도 오더
        delivery_delays = sum(
            1 for o in orders_all
            if o.promised_delivery and not o.delivered_date and o.promised_delivery[:10] < today_iso
        )

        return {
            "months": month_labels,
            "currencies": list(CURS),
            "series": {
                "revenue": _series_list(rev_series),
                "quote": _series_list(quote_series),
                "order": _series_list(order_series),
            },
            "customer_top": _top(cust_rev, "customer"),
            "item_top": _top(item_rev, "item"),
            "kpi": _kpi(),
            "delivery_delays": delivery_delays,
            "alerts": {
                "today_delivery": today_delivery,
                "week_delivery": week_delivery,
                "unanswered_quotes": unanswered,
                "unreceived_po": unreceived_po,
                "uninvoiced": uninvoiced,
                "long_overdue_ar": long_overdue,
            },
        }
    finally:
        s.close()
