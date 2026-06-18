"""Quotation management — create, margin calc, PDF generate, email send."""
from __future__ import annotations
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pandas as pd
import streamlit as st
from app.utils.auth import require_auth, current_user
from app.utils.helpers import (
    inject_css, hint, section_header, next_doc_no, next_quotation_no, status_badge, tracking_url,
    customer_options, vessel_options, rfq_list,
    quotation_list, get_quotation, get_rfq,
    get_customer, get_vessel, get_vendor, apply_margin, total_amount,
    vendor_quote_list, get_vendor_quote, get_vrfq, pipeline_status_label,
    CURRENCIES, NAVY, BLUE,
)
from db.engine import get_session
from db.models import Quotation, RFQ, VendorQuote, VendorRFQ, QuotationStatus, FollowUpLevel, RFQStatus
from services.pdf_svc import build_payload, generate_pdf
from services.email_svc import send_email, quotation_email_body, quotation_email_subject

# 페이지 셋업(set_page_config/require_auth/inject_css/section_header)은 통합 페이지
# rfq_quotation.py 에서 처리한다. 이 모듈은 탭별 render 함수만 노출한다.


def render_quotation_detail():
    """견적 목록에서 선택한 견적의 상세(정보·상태·품목)를 인라인 표시."""
    qtn_id = st.session_state.get("qtn_detail_id")
    if not qtn_id:
        hint("위 목록에서 견적을 선택하면 상세가 여기에 표시됩니다.")
        return
    qtn = get_quotation(int(qtn_id))
    if not qtn:
        hint("선택한 견적을 찾을 수 없습니다. 목록에서 다시 선택하세요.")
        return

    cust   = get_customer(qtn.customer_id)
    vessel = get_vessel(qtn.vessel_id) if qtn.vessel_id else None

    col_info, col_act = st.columns([3, 1])
    with col_info:
        st.markdown(f"### {qtn.qtn_no}")
        m1, m2, m3, m4 = st.columns(4)
        info_cards = [
            (m1, "Customer",  cust.name if cust else "—"),
            (m2, "선박",      vessel.name if vessel else "—"),
            (m3, "통화/합계", f"{qtn.currency} {total_amount(qtn.items or []):,.2f}"),
            (m4, "유효기간",  qtn.valid_until or "—"),
        ]
        for col, label, value in info_cards:
            with col:
                st.markdown(f"""
                <div class="ktms-info-card">
                    <div class="ktms-info-label">{label}</div>
                    <div class="ktms-info-value">{value}</div>
                </div>
                """, unsafe_allow_html=True)
        st.markdown(f"**상태:** {status_badge(qtn.status.value)}", unsafe_allow_html=True)
        st.caption("📨 PDF 생성·이메일 발송은 'Customer Quot. 발신' 탭에서 진행하세요.")

    with col_act:
        new_stat = st.selectbox("상태 변경", [s.value for s in QuotationStatus],
                                index=[s.value for s in QuotationStatus].index(qtn.status.value))
        if st.button("상태 업데이트", key="qtn_stat_update"):
            s = get_session()
            try:
                q = s.query(Quotation).get(qtn.id)
                q.status = QuotationStatus(new_stat)
                s.commit()
                st.success("업데이트!")
                st.rerun()
            finally:
                s.close()

    if qtn.items:
        st.markdown("**품목 리스트**")
        money_cols = {c: st.column_config.NumberColumn(c, format="%,.2f")
                       for c in ("cost_price", "unit_price", "amount") if c in qtn.items[0]}
        st.dataframe(pd.DataFrame(qtn.items), use_container_width=True, hide_index=True,
                     column_config=money_cols)


# ══════════════════════════════════════════════════════════════════════════════
# TAB — Customer Quot. 목록
# ══════════════════════════════════════════════════════════════════════════════
def render_qtn_list():
    col_f1, col_f2 = st.columns(2)
    status_filter = col_f1.selectbox("상태 필터", ["전체"] + [s.value for s in QuotationStatus])
    level_filter  = col_f2.selectbox("Level 필터", ["전체", "A", "B", "C"])

    quotes = quotation_list(None if status_filter == "전체" else status_filter)
    if level_filter != "전체":
        quotes = [q for q in quotes if q.follow_up_level and q.follow_up_level.value == level_filter]

    if quotes:
        rows = []
        for q in quotes:
            c = get_customer(q.customer_id)
            rows.append({
                "ID": q.id,
                "견적 No.": q.qtn_no,
                "Customer": c.name if c else "—",
                "품목수": len(q.items or []),
                "통화": q.currency,
                "합계": f"{total_amount(q.items or []):,.2f}",
                "Level": q.follow_up_level.value if q.follow_up_level else "—",
                "상태": pipeline_status_label(q.rfq_id) if q.rfq_id else q.status.value,
                "유효기간": q.valid_until or "—",
            })
        df = pd.DataFrame(rows)
        selected = st.dataframe(
            df.drop(columns=["ID"]),
            use_container_width=True, hide_index=True,
            selection_mode="single-row", on_select="rerun",
        )
        sel_rows = selected.selection.rows if hasattr(selected, "selection") else []
        if sel_rows:
            st.session_state["qtn_detail_id"] = int(df.iloc[sel_rows[0]]["ID"])
    else:
        hint("작성된 견적이 없습니다.")

    # ── 선택한 견적 상세 (인라인) ─────────────────────────────────────────────
    st.markdown("---")
    render_quotation_detail()

# ══════════════════════════════════════════════════════════════════════════════
# TAB — Customer Quot. 신규 등록
# ══════════════════════════════════════════════════════════════════════════════
def render_qtn_new():
    st.subheader("신규 견적 작성")

    with st.expander("Vendor 견적에서 불러오기 — 권장", expanded=True):
        all_vqs = vendor_quote_list()
        if all_vqs:
            # VRFQ → Vendor 이름을 조합해 라벨 생성
            vq_opts = {}
            for vq in all_vqs:
                vrfq = get_vrfq(vq.vendor_rfq_id)
                rfq_obj = get_rfq(vrfq.rfq_id) if vrfq else None
                vendor = get_vendor(vrfq.vendor_id) if vrfq else None
                label = (
                    f"{vq.received_date or '—'}  |  "
                    f"{vendor.name if vendor else '—'}  |  "
                    f"VRFQ: {vrfq.vrfq_no if vrfq else '—'}  |  "
                    f"RFQ: {rfq_obj.rfq_no if rfq_obj else '—'}"
                )
                vq_opts[label] = vq.id
            sel_vq_label = st.selectbox("Vendor 견적 선택", ["— 직접 입력 —"] + list(vq_opts.keys()),
                                         key="sel_vq")
            if st.button("Vendor 견적 불러오기", key="btn_load_vq"):
                if sel_vq_label != "— 직접 입력 —":
                    st.session_state["load_vq_id"] = vq_opts[sel_vq_label]
                    st.session_state.pop("load_rfq_id", None)
                    st.rerun()
        else:
            hint("등록된 Vendor 견적이 없습니다. RFQ 관리 → Vendor 견적 수신 등록을 먼저 하세요.")

    with st.expander("Customer RFQ에서 불러오기 (품목 정보만, 가격 없음)", expanded=False):
        rfqs = rfq_list()
        if rfqs:
            rfq_opts = {f"{r.rfq_no} · {pipeline_status_label(r.id)}": r.id for r in rfqs}
            sel_rfq_no = st.selectbox("RFQ 선택", ["— 직접 입력 —"] + list(rfq_opts.keys()),
                                       key="sel_rfq_for_qtn")
            if st.button("RFQ 불러오기", key="btn_load_rfq"):
                if sel_rfq_no != "— 직접 입력 —":
                    st.session_state["load_rfq_id"] = rfq_opts[sel_rfq_no]
                    st.session_state.pop("load_vq_id", None)
                    st.rerun()
        else:
            hint("등록된 RFQ가 없습니다.")

    # Pre-fill: 공급사 견적 우선, 없으면 Customer RFQ
    prefill_rfq = None
    prefill_vq = None
    if "load_vq_id" in st.session_state:
        prefill_vq = get_vendor_quote(st.session_state["load_vq_id"])
        if prefill_vq:
            vrfq = get_vrfq(prefill_vq.vendor_rfq_id)
            prefill_rfq = get_rfq(vrfq.rfq_id) if vrfq else None
    elif "load_rfq_id" in st.session_state:
        prefill_rfq = get_rfq(st.session_state["load_rfq_id"])

    with st.form("new_qtn_form"):
        c1, c2, c3 = st.columns(3)
        with c1:
            cust_opts = customer_options()
            if cust_opts:
                default_cust = list(cust_opts.keys())[0]
                _ref_rfq = prefill_rfq  # 공급사 견적 or RFQ 불러오기 모두 prefill_rfq에 담김
                if _ref_rfq:
                    c = get_customer(_ref_rfq.customer_id)
                    if c and c.name in cust_opts:
                        default_cust = c.name
                cust_name = st.selectbox("Customer *", list(cust_opts.keys()),
                                         index=list(cust_opts.keys()).index(default_cust))
                cust_id = cust_opts[cust_name]
            else:
                st.warning("Customer를 먼저 등록하세요.")
                cust_id = None
            qtn_date = st.date_input("견적일", value=date.today())
            valid_days = st.number_input("유효기간 (일)", min_value=1, max_value=90, value=15)
        with c2:
            vessel_opts = vessel_options(cust_id)
            vessel_choices = ["— 없음 —"] + list(vessel_opts.keys())
            default_vessel_idx = 0
            if prefill_rfq and prefill_rfq.vessel_id:
                v = get_vessel(prefill_rfq.vessel_id)
                if v and v.name in vessel_opts:
                    default_vessel_idx = vessel_choices.index(v.name)
            vessel_name = st.selectbox("선박 (선택)", vessel_choices, index=default_vessel_idx)
            vessel_id = vessel_opts.get(vessel_name) if vessel_name != "— 없음 —" else None
            currency = st.selectbox("통화", CURRENCIES)
            vat_rate = st.number_input("VAT Rate", 0.0, 1.0, 0.0, 0.01, format="%.2f")
        with c3:
            follow_level = st.selectbox("Follow-up Level", [l.value for l in FollowUpLevel], index=1)
            default_margin_pct = st.number_input("기본 마진율 (%)", 0.0, 200.0, 20.0, 1.0,
                                                   help="품목별 margin_pct를 비워두면 이 값이 적용됩니다.")
            discount_pct = st.number_input("DC (%)", 0.0, 50.0, 0.0, 0.5)

        st.markdown("**품목 리스트** (cost_price, margin_pct 입력 → unit_price 자동 계산. margin_pct 비우면 기본 마진율 적용)")
        default_cols = ["item_no", "part_no", "description", "maker", "origin",
                        "qty", "unit", "cost_price", "margin_pct", "unit_price", "lead_time", "remark"]

        seed_items: list = []
        if prefill_vq and prefill_vq.items:
            # 공급사 견적에서 불러오기 — cost_price 자동 채움
            for i, itm in enumerate(prefill_vq.items, 1):
                seed_items.append({
                    "item_no": itm.get("item_no", i),
                    "part_no": itm.get("part_no", ""),
                    "description": itm.get("description", ""),
                    "maker": itm.get("maker", ""),
                    "origin": itm.get("origin", ""),
                    "qty": itm.get("qty", 1),
                    "unit": itm.get("unit", "PCS"),
                    "cost_price": float(itm.get("cost_price", 0.0)),
                    "margin_pct": default_margin_pct,
                    "unit_price": 0.0,
                    "lead_time": itm.get("lead_time", ""),
                    "remark": itm.get("remark", ""),
                })
        elif prefill_rfq and prefill_rfq.items:
            # Customer RFQ에서 불러오기 — 품목 정보만, cost_price = 0
            for i, itm in enumerate(prefill_rfq.items, 1):
                seed_items.append({
                    "item_no": i, "part_no": itm.get("part_no", ""),
                    "description": itm.get("description", ""), "maker": itm.get("maker", ""),
                    "origin": "", "qty": itm.get("qty", 1), "unit": itm.get("unit", "PCS"),
                    "cost_price": 0.0, "margin_pct": default_margin_pct, "unit_price": 0.0,
                    "lead_time": itm.get("lead_time_req", ""), "remark": "",
                })

        seed_df = pd.DataFrame(seed_items, columns=default_cols) if seed_items else \
                  pd.DataFrame(columns=default_cols)
        items_df = st.data_editor(
            seed_df, num_rows="dynamic", use_container_width=True,
            column_config={
                "qty":        st.column_config.NumberColumn("qty", min_value=0, step=1),
                "cost_price": st.column_config.NumberColumn("cost_price", format="%,.2f"),
                "margin_pct": st.column_config.NumberColumn("margin_pct (%)", min_value=0.0, max_value=200.0,
                                                              step=1.0, format="%.1f", default=default_margin_pct),
                "unit_price": st.column_config.NumberColumn("unit_price (auto)", format="%,.2f"),
            },
            key="qtn_items",
        )

        # Terms — 드롭다운에서 선택하거나, 목록에 없으면 직접 입력(타이핑 후 Enter)
        st.markdown("**거래 조건**")
        st.caption("드롭다운에서 선택하거나, 목록에 없으면 직접 입력해 추가할 수 있습니다.")

        _INCOTERMS = ["FCA Busan, Korea", "FOB Busan, Korea", "CIF (지정 목적항)",
                      "CFR (지정 목적항)", "DAP (지정 목적지)", "EXW Busan"]
        _SHIPMENT  = ["Air courier / Sea freight", "By Air (Courier)",
                      "By Sea (FCL)", "By Sea (LCL)"]
        _PAYMENT   = ["100% T/T in advance", "T/T 30 days after delivery",
                      "T/T 50% in advance, 50% before shipment", "L/C at sight"]
        _PACKING   = ["Standard export packing", "Seaworthy export packing",
                      "Wooden case packing"]
        _DELIVERY  = ["Busan, Republic of Korea", "Incheon, Republic of Korea"]
        _WARRANTY  = ["Manufacturer's standard warranty", "12 months from delivery",
                      "6 months from delivery", "No warranty"]

        def _term_field(col, label, options, key):
            return col.selectbox(
                label, options, index=0, key=f"qtn_term_{key}",
                accept_new_options=True,
                help="목록에 없으면 직접 입력 후 Enter로 추가할 수 있습니다.",
            )

        tc1, tc2 = st.columns(2)
        incoterms = _term_field(tc1, "Incoterms",       _INCOTERMS, "incoterms")
        payment   = _term_field(tc1, "Payment Terms",   _PAYMENT,   "payment")
        delivery  = _term_field(tc1, "Delivery Place",  _DELIVERY,  "delivery")
        shipment  = _term_field(tc2, "Shipment Method", _SHIPMENT,  "shipment")
        packing   = _term_field(tc2, "Packing",         _PACKING,   "packing")
        warranty  = _term_field(tc2, "Warranty",        _WARRANTY,  "warranty")
        remarks = st.text_area("Remarks", "Bank charges outside Korea shall be borne by Buyer.", height=60)

        save_btn = st.form_submit_button("견적 저장", type="primary", use_container_width=True)

    if save_btn and cust_id:
        raw_items = items_df.fillna("").to_dict(orient="records")
        # Apply margin
        for item in raw_items:
            item["item_no"] = item.get("item_no") or raw_items.index(item) + 1
        priced_items = apply_margin(raw_items, default_margin_pct, discount_pct)

        qtn_no = next_quotation_no()
        valid_until = (qtn_date + timedelta(days=int(valid_days))).isoformat()
        terms = {
            "incoterms": incoterms, "payment_terms": payment,
            "delivery_place": delivery, "shipment_method": shipment,
            "packing": packing, "warranty": warranty, "remarks": remarks,
        }
        session = get_session()
        try:
            qtn = Quotation(
                qtn_no=qtn_no,
                rfq_id=prefill_rfq.id if prefill_rfq else None,
                customer_id=cust_id,
                vessel_id=vessel_id,
                date=qtn_date.isoformat(),
                valid_until=valid_until,
                currency=currency,
                vat_rate=vat_rate,
                items=priced_items,
                terms=terms,
                status=QuotationStatus.DRAFT,
                follow_up_level=FollowUpLevel(follow_level),
                created_by=current_user()["id"],
            )
            session.add(qtn)
            if prefill_rfq:
                r = session.query(RFQ).get(prefill_rfq.id)
                r.status = RFQStatus.QUOTING
            session.commit()
            st.session_state["qtn_detail_id"] = qtn.id
            st.session_state.pop("load_rfq_id", None)
            st.session_state.pop("load_vq_id", None)
            st.success(f"견적 저장 완료: **{qtn_no}** — '🔍 견적 상세' 탭에서 PDF 생성 및 발송하세요.")
        finally:
            session.close()

# ══════════════════════════════════════════════════════════════════════════════
# TAB — Customer Quot. 발신 (선택한 견적 대상: PDF + EMAIL)
# ══════════════════════════════════════════════════════════════════════════════
def render_qtn_send():
    qtn_id = st.session_state.get("qtn_detail_id")
    if not qtn_id:
        hint("먼저 'Customer Quot. 목록' 탭에서 견적을 선택하세요.")
        return

    qtn = get_quotation(int(qtn_id))
    if not qtn:
        st.error("선택한 견적을 찾을 수 없습니다. 목록에서 다시 선택하세요.")
        return

    cust   = get_customer(qtn.customer_id)
    vessel = get_vessel(qtn.vessel_id) if qtn.vessel_id else None

    st.subheader("Customer Quotation 발신")
    st.markdown(
        f"**대상 견적:** `{qtn.qtn_no}`  ·  {cust.name if cust else '—'}"
        f"  ·  {qtn.currency} {total_amount(qtn.items or []):,.2f}  ·  유효기간 {qtn.valid_until or '—'}"
    )
    st.markdown("---")
    col_pdf, col_email = st.columns(2)

    with col_pdf:
        st.markdown("**PDF 생성**")
        doc_type_sel = st.selectbox("문서 종류", ["quotation", "proforma_invoice"])
        if st.button("📄 PDF 생성 & 다운로드"):
            try:
                payload = build_payload(
                    doc_no=qtn.qtn_no if doc_type_sel == "quotation" else next_doc_no("proforma"),
                    date=qtn.date or date.today().isoformat(),
                    customer=cust, vessel=vessel,
                    items=qtn.items or [],
                    terms=qtn.terms or {},
                    currency=qtn.currency,
                    vat_rate=qtn.vat_rate,
                    valid_until=qtn.valid_until or "",
                )
                pdf_bytes = generate_pdf(doc_type_sel, payload)
                fname = f"{qtn.qtn_no}_{doc_type_sel}.pdf"
                st.download_button("⬇️ PDF 다운로드", data=pdf_bytes, file_name=fname, mime="application/pdf")
            except Exception as e:
                st.error(f"PDF 생성 오류: {e}")

    with col_email:
        st.markdown("**이메일 발송**")
        to_email = st.text_input("수신자 이메일", value=cust.email if cust and cust.email else "")

        lang_label = st.selectbox("언어", ["English", "한국어"], key=f"qtn_email_lang_{qtn.id}")
        lang_code = "en" if lang_label == "English" else "kr"
        attach_types = st.multiselect(
            "첨부 문서", ["quotation", "proforma_invoice"],
            default=["quotation"], key=f"qtn_email_attach_{qtn.id}",
        )

        subj_key = f"qtn_email_subject_{qtn.id}"
        body_key = f"qtn_email_body_{qtn.id}"
        track_url = tracking_url("rfq", get_rfq(qtn.rfq_id).tracking_token) if qtn.rfq_id else ""

        if subj_key not in st.session_state:
            st.session_state[subj_key] = quotation_email_subject(qtn.qtn_no, lang_code)
        if body_key not in st.session_state:
            st.session_state[body_key] = quotation_email_body(
                cust.name if cust else "Customer", qtn.qtn_no, track_url, lang=lang_code,
            )

        if st.button("🔄 제목/본문 자동 생성", key=f"qtn_email_regen_{qtn.id}"):
            st.session_state[subj_key] = quotation_email_subject(qtn.qtn_no, lang_code)
            st.session_state[body_key] = quotation_email_body(
                cust.name if cust else "Customer", qtn.qtn_no, track_url, lang=lang_code,
            )
            st.rerun()

        subject = st.text_input("제목", key=subj_key)
        body = st.text_area("본문 (수정 가능)", key=body_key, height=220)

        with st.expander("📧 이메일 미리보기"):
            st.write(f"**받는사람:** {to_email or '—'}")
            st.write(f"**제목:** {subject}")
            if attach_types:
                st.write(f"**첨부파일:** {', '.join(f'{qtn.qtn_no}_{t}.pdf' for t in attach_types)}")
            st.text(body)

        if st.button("📧 견적서 이메일 발송"):
            try:
                attachments = []
                for doc_type_sel in attach_types:
                    doc_no = qtn.qtn_no if doc_type_sel == "quotation" else next_doc_no("proforma")
                    payload = build_payload(
                        doc_no=doc_no, date=qtn.date or date.today().isoformat(),
                        customer=cust, vessel=vessel,
                        items=qtn.items or [], terms=qtn.terms or {},
                        currency=qtn.currency, vat_rate=qtn.vat_rate,
                        valid_until=qtn.valid_until or "",
                    )
                    pdf_bytes = generate_pdf(doc_type_sel, payload)
                    attachments.append((f"{qtn.qtn_no}_{doc_type_sel}.pdf", pdf_bytes))

                ok = send_email(
                    to=to_email,
                    subject=subject,
                    body=body,
                    attachments=attachments,
                )
                if ok:
                    session = get_session()
                    try:
                        q = session.query(Quotation).get(qtn.id)
                        q.status = QuotationStatus.SENT
                        q.sent_date = date.today().isoformat()
                        if qtn.rfq_id:
                            r = session.query(RFQ).get(qtn.rfq_id)
                            if r:
                                r.status = RFQStatus.SENT
                        session.commit()
                    finally:
                        session.close()
                    st.success(f"이메일 발송 완료 → {to_email}")
                else:
                    st.error("이메일 발송 실패. .env의 SMTP 설정을 확인하세요.")
            except Exception as e:
                st.error(f"오류: {e}")
