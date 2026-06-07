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
    inject_css, hint, next_doc_no, status_badge, tracking_url,
    customer_options, vessel_options, rfq_list,
    quotation_list, get_quotation, get_rfq,
    get_customer, get_vessel, apply_margin, total_amount,
    NAVY, BLUE,
)
from db.engine import get_session
from db.models import Quotation, RFQ, QuotationStatus, FollowUpLevel, RFQStatus
from services.pdf_svc import build_payload, generate_pdf
from services.email_svc import send_email, quotation_email_body

try:
    st.set_page_config(page_title="견적 관리 — KTMS", page_icon="📄", layout="wide")
except Exception:
    pass
require_auth()
inject_css()

st.markdown('<div class="ktms-section">📄 견적 관리 (Quotation)</div>', unsafe_allow_html=True)

tab_list, tab_new, tab_detail = st.tabs(["📋 견적 리스트", "➕ 신규 견적 작성", "🔍 견적 상세"])

# ══════════════════════════════════════════════════════════════════════════════
# TAB 1 — LIST
# ══════════════════════════════════════════════════════════════════════════════
with tab_list:
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
                "고객사": c.name if c else "—",
                "품목수": len(q.items or []),
                "통화": q.currency,
                "합계": f"{total_amount(q.items or []):,.2f}",
                "Level": q.follow_up_level.value if q.follow_up_level else "—",
                "상태": q.status.value,
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
            hint("'🔍 견적 상세' 탭에서 확인하세요.")
    else:
        hint("작성된 견적이 없습니다.")

# ══════════════════════════════════════════════════════════════════════════════
# TAB 2 — NEW QUOTATION
# ══════════════════════════════════════════════════════════════════════════════
with tab_new:
    st.subheader("신규 견적 작성")

    with st.expander("RFQ에서 불러오기 (선택사항)", expanded=False):
        rfqs = rfq_list()
        if rfqs:
            rfq_opts = {r.rfq_no: r.id for r in rfqs}
            sel_rfq_no = st.selectbox("RFQ 선택", ["— 직접 입력 —"] + list(rfq_opts.keys()))
            load_rfq_btn = st.button("RFQ 데이터 불러오기")
            if load_rfq_btn and sel_rfq_no != "— 직접 입력 —":
                st.session_state["load_rfq_id"] = rfq_opts[sel_rfq_no]
                st.rerun()
        else:
            hint("등록된 RFQ가 없습니다.")

    # Pre-fill from RFQ if selected
    prefill_rfq = None
    if "load_rfq_id" in st.session_state:
        prefill_rfq = get_rfq(st.session_state["load_rfq_id"])

    with st.form("new_qtn_form"):
        c1, c2, c3 = st.columns(3)
        with c1:
            cust_opts = customer_options()
            if cust_opts:
                default_cust = list(cust_opts.keys())[0]
                if prefill_rfq:
                    c = get_customer(prefill_rfq.customer_id)
                    if c and c.name in cust_opts:
                        default_cust = c.name
                cust_name = st.selectbox("고객사 *", list(cust_opts.keys()),
                                         index=list(cust_opts.keys()).index(default_cust))
                cust_id = cust_opts[cust_name]
            else:
                st.warning("고객사를 먼저 등록하세요.")
                cust_id = None
            qtn_date = st.date_input("견적일", value=date.today())
            valid_days = st.number_input("유효기간 (일)", min_value=1, max_value=90, value=15)
        with c2:
            vessel_opts = vessel_options(cust_id)
            vessel_name = st.selectbox("선박 (선택)", ["— 없음 —"] + list(vessel_opts.keys()))
            vessel_id = vessel_opts.get(vessel_name) if vessel_name != "— 없음 —" else None
            currency = st.selectbox("통화", ["USD", "EUR", "KRW", "SGD", "JPY"])
            vat_rate = st.number_input("VAT Rate", 0.0, 1.0, 0.0, 0.01, format="%.2f")
        with c3:
            follow_level = st.selectbox("Follow-up Level", [l.value for l in FollowUpLevel], index=1)
            margin_pct = st.number_input("마진율 (%)", 0.0, 200.0, 20.0, 1.0)
            discount_pct = st.number_input("DC (%)", 0.0, 50.0, 0.0, 0.5)

        st.markdown("**품목 리스트** (cost_price 입력 → 마진 적용 후 unit_price 자동 계산)")
        default_cols = ["item_no", "part_no", "description", "maker", "origin",
                        "qty", "unit", "cost_price", "unit_price", "lead_time", "remark"]

        seed_items: list = []
        if prefill_rfq and prefill_rfq.items:
            for i, itm in enumerate(prefill_rfq.items, 1):
                seed_items.append({
                    "item_no": i, "part_no": itm.get("part_no", ""),
                    "description": itm.get("description", ""), "maker": itm.get("maker", ""),
                    "origin": "", "qty": itm.get("qty", 1), "unit": itm.get("unit", "PCS"),
                    "cost_price": 0.0, "unit_price": 0.0,
                    "lead_time": itm.get("lead_time_req", ""), "remark": "",
                })

        seed_df = pd.DataFrame(seed_items, columns=default_cols) if seed_items else \
                  pd.DataFrame(columns=default_cols)
        items_df = st.data_editor(
            seed_df, num_rows="dynamic", use_container_width=True,
            column_config={
                "qty":        st.column_config.NumberColumn("qty", min_value=0, step=1),
                "cost_price": st.column_config.NumberColumn("cost_price", format="%.2f"),
                "unit_price": st.column_config.NumberColumn("unit_price (auto)", format="%.2f"),
            },
            key="qtn_items",
        )

        # Terms
        st.markdown("**거래 조건**")
        tc1, tc2 = st.columns(2)
        with tc1:
            incoterms = st.text_input("Incoterms", "FCA Busan, Korea")
            payment   = st.text_input("Payment Terms", "100% T/T in advance")
            delivery  = st.text_input("Delivery Place", "Busan, Republic of Korea")
        with tc2:
            shipment  = st.text_input("Shipment Method", "Air courier / Sea freight")
            packing   = st.text_input("Packing", "Standard export packing")
            warranty  = st.text_input("Warranty", "Manufacturer's standard warranty")
        remarks = st.text_area("Remarks", "Bank charges outside Korea shall be borne by Buyer.", height=60)

        save_btn = st.form_submit_button("💾 견적 저장", type="primary", use_container_width=True)

    if save_btn and cust_id:
        raw_items = items_df.fillna("").to_dict(orient="records")
        # Apply margin
        for item in raw_items:
            item["item_no"] = item.get("item_no") or raw_items.index(item) + 1
        priced_items = apply_margin(raw_items, margin_pct, discount_pct)

        qtn_no = next_doc_no("quotation")
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
            st.success(f"✅ 견적 저장 완료: **{qtn_no}** — '🔍 견적 상세' 탭에서 PDF 생성 및 발송하세요.")
        finally:
            session.close()

# ══════════════════════════════════════════════════════════════════════════════
# TAB 3 — DETAIL (PDF + EMAIL)
# ══════════════════════════════════════════════════════════════════════════════
with tab_detail:
    qtn_id = st.session_state.get("qtn_detail_id")
    if not qtn_id:
        hint("견적 리스트에서 항목을 선택하거나 ID를 입력하세요.")
        qtn_id = st.number_input("견적 ID", min_value=1, step=1, value=1)
        if not st.button("불러오기", key="qtn_load"):
            st.stop()

    qtn = get_quotation(int(qtn_id))
    if not qtn:
        st.error("견적을 찾을 수 없습니다.")
        st.stop()

    cust   = get_customer(qtn.customer_id)
    vessel = get_vessel(qtn.vessel_id) if qtn.vessel_id else None

    col_info, col_act = st.columns([3, 1])
    with col_info:
        st.markdown(f"### {qtn.qtn_no}")
        m1, m2, m3, m4 = st.columns(4)
        m1.metric("고객사",   cust.name if cust else "—")
        m2.metric("선박",     vessel.name if vessel else "—")
        m3.metric("통화/합계", f"{qtn.currency} {total_amount(qtn.items or []):,.2f}")
        m4.metric("유효기간", qtn.valid_until or "—")
        st.markdown(f"**상태:** {status_badge(qtn.status.value)}", unsafe_allow_html=True)

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
        st.dataframe(pd.DataFrame(qtn.items), use_container_width=True, hide_index=True)

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
        if st.button("📧 견적서 이메일 발송"):
            try:
                payload = build_payload(
                    doc_no=qtn.qtn_no, date=qtn.date or date.today().isoformat(),
                    customer=cust, vessel=vessel,
                    items=qtn.items or [], terms=qtn.terms or {},
                    currency=qtn.currency, vat_rate=qtn.vat_rate,
                    valid_until=qtn.valid_until or "",
                )
                pdf_bytes = generate_pdf("quotation", payload)
                body = quotation_email_body(
                    cust.name if cust else "Customer", qtn.qtn_no,
                    tracking_url("rfq", get_rfq(qtn.rfq_id).tracking_token) if qtn.rfq_id else "",
                )
                ok = send_email(
                    to=to_email,
                    subject=f"[K-MARIS] Quotation {qtn.qtn_no}",
                    body=body,
                    attachments=[(f"{qtn.qtn_no}_quotation.pdf", pdf_bytes)],
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
                    st.success(f"✅ 이메일 발송 완료 → {to_email}")
                else:
                    st.error("이메일 발송 실패. .env의 SMTP 설정을 확인하세요.")
            except Exception as e:
                st.error(f"오류: {e}")
