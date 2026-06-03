"""RFQ Management — receive, register, send to vendors, track status."""
from __future__ import annotations
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pandas as pd
import streamlit as st
from app.utils.auth import require_auth, current_user
from app.utils.helpers import (
    inject_css, next_doc_no, status_badge, tracking_url,
    customer_options, vessel_options, vendor_options,
    rfq_list, get_rfq, get_customer, get_vessel, get_vendor, NAVY, BLUE,
)
from db.engine import get_session
from db.models import RFQ, VendorRFQ, RFQStatus, FollowUpLevel

st.set_page_config(page_title="RFQ 관리 — KTMS", page_icon="📋", layout="wide")
require_auth()
inject_css()

st.markdown('<div class="ktms-section">📋 RFQ 관리</div>', unsafe_allow_html=True)

tab_list, tab_new, tab_detail = st.tabs(["📋 RFQ 리스트", "➕ 신규 RFQ 등록", "🔍 RFQ 상세"])

# ══════════════════════════════════════════════════════════════════════════════
# TAB 1 — LIST
# ══════════════════════════════════════════════════════════════════════════════
with tab_list:
    col_f1, col_f2, col_f3 = st.columns([2, 2, 1])
    with col_f1:
        status_filter = st.selectbox("상태 필터", ["전체"] + [s.value for s in RFQStatus])
    with col_f2:
        cust_opts = {"전체": None, **customer_options()}
        cust_sel = st.selectbox("고객사 필터", list(cust_opts.keys()))
    with col_f3:
        st.markdown("<br>", unsafe_allow_html=True)
        refresh = st.button("🔄 새로고침", use_container_width=True)

    rfqs = rfq_list(None if status_filter == "전체" else status_filter)
    if cust_sel != "전체" and cust_opts[cust_sel]:
        rfqs = [r for r in rfqs if r.customer_id == cust_opts[cust_sel]]

    if rfqs:
        rows = []
        for r in rfqs:
            c = get_customer(r.customer_id)
            v = get_vessel(r.vessel_id) if r.vessel_id else None
            rows.append({
                "ID": r.id,
                "RFQ No.": r.rfq_no,
                "고객사": c.name if c else "—",
                "선박": v.name if v else "—",
                "품목수": len(r.items or []),
                "Level": r.follow_up_level.value if r.follow_up_level else "—",
                "상태": r.status.value,
                "날짜": r.date or "—",
            })
        df = pd.DataFrame(rows)
        selected = st.dataframe(
            df.drop(columns=["ID"]),
            use_container_width=True,
            hide_index=True,
            selection_mode="single-row",
            on_select="rerun",
        )
        sel_rows = selected.selection.rows if hasattr(selected, "selection") else []
        if sel_rows:
            sel_id = df.iloc[sel_rows[0]]["ID"]
            st.session_state["rfq_detail_id"] = int(sel_id)
            st.info(f"RFQ ID {sel_id} 선택됨 — '🔍 RFQ 상세' 탭에서 확인하세요.")
    else:
        st.info("등록된 RFQ가 없습니다.")

# ══════════════════════════════════════════════════════════════════════════════
# TAB 2 — NEW RFQ
# ══════════════════════════════════════════════════════════════════════════════
with tab_new:
    st.subheader("신규 RFQ 등록")
    with st.form("new_rfq_form"):
        c1, c2 = st.columns(2)
        with c1:
            cust_opts2 = customer_options()
            if cust_opts2:
                cust_name = st.selectbox("고객사 *", list(cust_opts2.keys()))
                cust_id = cust_opts2[cust_name]
            else:
                st.warning("고객사를 먼저 등록하세요 (⚙️ 설정 탭).")
                cust_id = None
                cust_name = ""
            rfq_date = st.date_input("RFQ 수신일", value=date.today())
            follow_level = st.selectbox("Follow-up Level", [l.value for l in FollowUpLevel], index=1)
        with c2:
            vessel_opts = vessel_options(cust_id)
            vessel_name = st.selectbox("선박 (선택)", ["— 없음 —"] + list(vessel_opts.keys()))
            vessel_id = vessel_opts.get(vessel_name) if vessel_name != "— 없음 —" else None
            notes = st.text_area("비고 / 고객 요청사항", height=96)

        st.markdown("**품목 리스트**")
        default_items = pd.DataFrame(columns=["part_no", "description", "maker", "qty", "unit", "lead_time_req", "remark"])
        items_df = st.data_editor(
            default_items, num_rows="dynamic", use_container_width=True,
            column_config={
                "qty": st.column_config.NumberColumn("qty", min_value=0, step=1),
            },
            key="new_rfq_items",
        )
        submitted = st.form_submit_button("💾 RFQ 등록", type="primary", use_container_width=True)

    if submitted and cust_id:
        items_data = items_df.fillna("").to_dict(orient="records")
        rfq_no = next_doc_no("rfq")
        session = get_session()
        try:
            rfq = RFQ(
                rfq_no=rfq_no,
                customer_id=cust_id,
                vessel_id=vessel_id,
                date=rfq_date.isoformat(),
                status=RFQStatus.RECEIVED,
                follow_up_level=FollowUpLevel(follow_level),
                items=items_data,
                notes=notes,
                created_by=current_user()["id"],
            )
            session.add(rfq)
            session.commit()
            st.success(f"✅ RFQ 등록 완료: **{rfq_no}**")
            t_url = tracking_url("rfq", rfq.tracking_token)
            st.info(f"🔗 고객 트래킹 링크: {t_url}")
        finally:
            session.close()

# ══════════════════════════════════════════════════════════════════════════════
# TAB 3 — DETAIL
# ══════════════════════════════════════════════════════════════════════════════
with tab_detail:
    rfq_id = st.session_state.get("rfq_detail_id")
    if not rfq_id:
        st.info("RFQ 리스트에서 항목을 선택하거나 직접 ID를 입력하세요.")
        rfq_id = st.number_input("RFQ ID", min_value=1, step=1, value=1)
        if not st.button("불러오기"):
            st.stop()

    rfq = get_rfq(int(rfq_id))
    if not rfq:
        st.error("해당 RFQ를 찾을 수 없습니다.")
        st.stop()

    cust = get_customer(rfq.customer_id)
    vessel = get_vessel(rfq.vessel_id) if rfq.vessel_id else None

    col_info, col_actions = st.columns([3, 1])
    with col_info:
        st.markdown(f"### {rfq.rfq_no}")
        c1, c2, c3 = st.columns(3)
        c1.metric("고객사", cust.name if cust else "—")
        c2.metric("선박", vessel.name if vessel else "—")
        c3.metric("품목수", len(rfq.items or []))
        st.markdown(f"**상태:** {status_badge(rfq.status.value)}&nbsp;&nbsp;"
                    f"**Follow-up:** <span class='badge-{rfq.follow_up_level.value}'>{rfq.follow_up_level.value}</span>"
                    f"&nbsp;&nbsp;**날짜:** {rfq.date}", unsafe_allow_html=True)
        if rfq.notes:
            st.caption(f"비고: {rfq.notes}")

        # Tracking link
        t_url = tracking_url("rfq", rfq.tracking_token)
        st.markdown(f"🔗 **고객 트래킹 링크:** [{t_url}]({t_url})")

    with col_actions:
        st.markdown("**액션**")
        # Status update
        new_status = st.selectbox("상태 변경", [s.value for s in RFQStatus],
                                  index=[s.value for s in RFQStatus].index(rfq.status.value))
        if st.button("상태 업데이트"):
            session = get_session()
            try:
                r = session.query(RFQ).get(rfq.id)
                r.status = RFQStatus(new_status)
                session.commit()
                st.success("상태 업데이트 완료!")
                st.rerun()
            finally:
                session.close()

        new_level = st.selectbox("Level 변경", [l.value for l in FollowUpLevel],
                                 index=[l.value for l in FollowUpLevel].index(rfq.follow_up_level.value))
        if st.button("Level 업데이트"):
            session = get_session()
            try:
                r = session.query(RFQ).get(rfq.id)
                r.follow_up_level = FollowUpLevel(new_level)
                session.commit()
                st.success("Level 업데이트!")
                st.rerun()
            finally:
                session.close()

    # Items table
    st.markdown("**품목 리스트**")
    if rfq.items:
        st.dataframe(pd.DataFrame(rfq.items), use_container_width=True, hide_index=True)
    else:
        st.info("품목 없음")

    # Vendor RFQ section
    st.markdown("---")
    st.markdown(f'<div class="ktms-section">📤 Vendor RFQ 발송</div>', unsafe_allow_html=True)

    vendor_opts = vendor_options()
    if vendor_opts:
        with st.form("vendor_rfq_form"):
            sel_vendors = st.multiselect("Vendor 선택", list(vendor_opts.keys()))
            vrfq_notes = st.text_area("Vendor에게 전달할 메모", height=60)
            send_vrfq = st.form_submit_button("📤 Vendor RFQ 발송", type="primary")

        if send_vrfq and sel_vendors:
            session = get_session()
            try:
                for vname in sel_vendors:
                    vid = vendor_opts[vname]
                    vrfq_no = next_doc_no("vendor_rfq")
                    vrfq = VendorRFQ(
                        vrfq_no=vrfq_no,
                        rfq_id=rfq.id,
                        vendor_id=vid,
                        sent_date=date.today().isoformat(),
                        status="발송됨",
                        items=rfq.items or [],
                    )
                    session.add(vrfq)
                # Update RFQ status
                r = session.query(RFQ).get(rfq.id)
                r.status = RFQStatus.SOURCING
                session.commit()
                st.success(f"✅ {len(sel_vendors)}개 Vendor에게 RFQ 발송 완료!")
            finally:
                session.close()
    else:
        st.warning("Vendor를 먼저 등록하세요 (⚙️ 설정).")

    # Existing Vendor RFQs
    session = get_session()
    try:
        vrfqs = session.query(VendorRFQ).filter_by(rfq_id=rfq.id).all()
        if vrfqs:
            st.markdown("**발송된 Vendor RFQ**")
            vrows = []
            for vr in vrfqs:
                v = get_vendor(vr.vendor_id)
                vrows.append({
                    "VRFQ No.": vr.vrfq_no,
                    "Vendor": v.name if v else "—",
                    "발송일": vr.sent_date or "—",
                    "상태": vr.status,
                })
            st.dataframe(pd.DataFrame(vrows), use_container_width=True, hide_index=True)
    finally:
        session.close()
