"""Order management — receive order, generate PO, track status."""
from __future__ import annotations
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pandas as pd
import streamlit as st
from app.utils.auth import require_auth
from app.utils.helpers import (
    inject_css, hint, section_header, next_doc_no, status_badge, tracking_url,
    quotation_list, get_quotation, get_customer, get_vessel, get_vendor,
    vendor_options, order_list, get_order, NAVY,
)
from db.engine import get_session
from db.models import Order, PurchaseOrder, Quotation, OrderStatus, QuotationStatus
from services.sheets_svc import upsert_order as _sheet_upsert_order

try:
    st.set_page_config(page_title="오더 관리 — KTMS", page_icon="📦", layout="wide")
except Exception:
    pass
require_auth()
inject_css()

section_header("order", "오더 관리 (Orders)")

tab_list, tab_new, tab_detail = st.tabs(["오더 목록", "신규 등록", "오더 상세"])

# ══════════════════════════════════════════════════════════════════════════════
# TAB 1 — LIST
# ══════════════════════════════════════════════════════════════════════════════
with tab_list:
    status_filter = st.selectbox("상태 필터", ["전체"] + [s.value for s in OrderStatus])
    orders = order_list(None if status_filter == "전체" else status_filter)

    if orders:
        rows = []
        for o in orders:
            c = get_customer(o.customer_id)
            v = get_vessel(o.vessel_id) if o.vessel_id else None
            rows.append({
                "ID": o.id,
                "오더 No.": o.ord_no,
                "Customer": c.name if c else "—",
                "선박": v.name if v else "—",
                "PO No.": o.po_no or "—",
                "품목수": len(o.items or []),
                "상태": o.status.value,
                "날짜": o.date or "—",
            })
        df = pd.DataFrame(rows)
        selected = st.dataframe(
            df.drop(columns=["ID"]),
            use_container_width=True, hide_index=True,
            selection_mode="single-row", on_select="rerun",
        )
        sel = selected.selection.rows if hasattr(selected, "selection") else []
        if sel:
            st.session_state["ord_detail_id"] = int(df.iloc[sel[0]]["ID"])
            hint("'🔍 오더 상세' 탭에서 확인하세요.")
    else:
        hint("등록된 오더가 없습니다.")

# ══════════════════════════════════════════════════════════════════════════════
# TAB 2 — NEW ORDER
# ══════════════════════════════════════════════════════════════════════════════
with tab_new:
    st.subheader("신규 오더 등록")
    hint("수주 확정된 견적에서 자동 생성하거나, 독립적으로 등록할 수 있습니다.")

    with st.expander("견적서에서 불러오기", expanded=True):
        won_quotes = [q for q in quotation_list() if q.status == QuotationStatus.WON or True]
        if won_quotes:
            qtn_opts = {q.qtn_no: q.id for q in won_quotes}
            sel_qtn = st.selectbox("견적 선택", ["— 없음 —"] + list(qtn_opts.keys()))
            if sel_qtn != "— 없음 —" and st.button("견적 데이터 불러오기"):
                st.session_state["load_qtn_id"] = qtn_opts[sel_qtn]
                st.rerun()
        else:
            hint("견적이 없습니다.")

    prefill_qtn = None
    if "load_qtn_id" in st.session_state:
        prefill_qtn = get_quotation(st.session_state["load_qtn_id"])

    with st.form("new_order_form"):
        c1, c2 = st.columns(2)
        with c1:
            from app.utils.helpers import customer_options
            cust_opts = customer_options()
            default_cust = list(cust_opts.keys())[0] if cust_opts else ""
            if prefill_qtn:
                c = get_customer(prefill_qtn.customer_id)
                if c and c.name in cust_opts:
                    default_cust = c.name
            cust_name = st.selectbox("Customer *", list(cust_opts.keys()) if cust_opts else ["—"],
                                     index=list(cust_opts.keys()).index(default_cust) if default_cust in cust_opts else 0)
            cust_id = cust_opts.get(cust_name)
            ord_date = st.date_input("수주일", value=date.today())
        with c2:
            po_no = st.text_input("고객 PO No.", value="")
            from app.utils.helpers import vessel_options
            vessel_opts = vessel_options(cust_id)
            vessel_name = st.selectbox("선박", ["— 없음 —"] + list(vessel_opts.keys()))
            vessel_id = vessel_opts.get(vessel_name) if vessel_name != "— 없음 —" else None

        # Items - pre-fill from quotation
        seed_items = prefill_qtn.items if prefill_qtn and prefill_qtn.items else []
        items_df = st.data_editor(
            pd.DataFrame(seed_items) if seed_items else pd.DataFrame(
                columns=["item_no", "part_no", "description", "maker", "qty", "unit", "unit_price"]),
            num_rows="dynamic", use_container_width=True, key="ord_items",
        )
        save_ord = st.form_submit_button("오더 등록", type="primary", use_container_width=True)

    if save_ord and cust_id:
        ord_no = next_doc_no("order")
        items_data = items_df.fillna("").to_dict(orient="records")
        session = get_session()
        try:
            order = Order(
                ord_no=ord_no,
                quotation_id=prefill_qtn.id if prefill_qtn else None,
                customer_id=cust_id,
                vessel_id=vessel_id,
                po_no=po_no,
                date=ord_date.isoformat(),
                status=OrderStatus.RECEIVED,
                items=items_data,
            )
            session.add(order)
            if prefill_qtn:
                q = session.query(Quotation).get(prefill_qtn.id)
                q.status = QuotationStatus.WON
            session.commit()
            st.session_state["ord_detail_id"] = order.id
            st.session_state.pop("load_qtn_id", None)
            t_url = tracking_url("order", order.tracking_token)
            st.success(f"✅ 오더 등록 완료: **{ord_no}**")
            st.info(f"🔗 고객 트래킹 링크: {t_url}")
            _sheet_upsert_order(order, get_customer(order.customer_id), get_vessel(order.vessel_id) if order.vessel_id else None)
        finally:
            session.close()

# ══════════════════════════════════════════════════════════════════════════════
# TAB 3 — DETAIL
# ══════════════════════════════════════════════════════════════════════════════
with tab_detail:
    ord_id = st.session_state.get("ord_detail_id")
    if not ord_id:
        hint("오더 리스트에서 선택하거나 ID를 입력하세요.")
        ord_id = st.number_input("오더 ID", min_value=1, step=1, value=1)
        if not st.button("불러오기", key="ord_load"):
            st.stop()

    order = get_order(int(ord_id))
    if not order:
        st.error("오더를 찾을 수 없습니다.")
        st.stop()

    cust   = get_customer(order.customer_id)
    vessel = get_vessel(order.vessel_id) if order.vessel_id else None

    col_info, col_act = st.columns([3, 1])
    with col_info:
        st.markdown(f"### {order.ord_no}")
        m1, m2, m3 = st.columns(3)
        info_cards = [
            (m1, "Customer", cust.name if cust else "—"),
            (m2, "선박", vessel.name if vessel else "—"),
            (m3, "PO No.", order.po_no or "—"),
        ]
        for col, label, value in info_cards:
            with col:
                st.markdown(f"""
                <div class="ktms-info-card">
                    <div class="ktms-info-label">{label}</div>
                    <div class="ktms-info-value">{value}</div>
                </div>
                """, unsafe_allow_html=True)
        st.markdown(f"**상태:** {status_badge(order.status.value)}", unsafe_allow_html=True)
        t_url = tracking_url("order", order.tracking_token)
        st.markdown(f"🔗 **고객 트래킹 링크:** [{t_url}]({t_url})")

    with col_act:
        new_stat = st.selectbox("상태 변경", [s.value for s in OrderStatus],
                                index=[s.value for s in OrderStatus].index(order.status.value))
        if st.button("상태 업데이트", key="ord_stat"):
            s = get_session()
            try:
                o = s.query(Order).get(order.id)
                o.status = OrderStatus(new_stat)
                s.commit()
                _sheet_upsert_order(o, get_customer(o.customer_id), get_vessel(o.vessel_id) if o.vessel_id else None)
                st.success("업데이트!")
                st.rerun()
            finally:
                s.close()

    if order.items:
        st.markdown("**품목 리스트**")
        st.dataframe(pd.DataFrame(order.items), use_container_width=True, hide_index=True)

    # Purchase Orders
    st.markdown("---")
    st.subheader("Vendor 발주서 (Purchase Order)")

    vendor_opts = vendor_options()
    with st.form("po_form"):
        sel_vendor = st.selectbox("Vendor 선택", ["— 없음 —"] + list(vendor_opts.keys()))
        po_date = st.date_input("발주일", date.today(), key="po_date_input")
        po_items_df = st.data_editor(
            pd.DataFrame(order.items) if order.items else pd.DataFrame(
                columns=["item_no", "part_no", "description", "qty", "unit", "unit_price"]),
            num_rows="dynamic", use_container_width=True, key="po_items",
        )
        gen_po = st.form_submit_button("발주서 생성", type="primary")

    if gen_po and sel_vendor != "— 없음 —":
        po_no_gen = next_doc_no("po")
        vid = vendor_opts[sel_vendor]
        items_data = po_items_df.fillna("").to_dict(orient="records")
        session = get_session()
        try:
            po = PurchaseOrder(
                po_no=po_no_gen,
                order_id=order.id,
                vendor_id=vid,
                date=po_date.isoformat(),
                items=items_data,
                status="발주완료",
                sent_date=date.today().isoformat(),
            )
            session.add(po)
            o = session.query(Order).get(order.id)
            o.status = OrderStatus.PO_SENT
            session.commit()
            st.success(f"✅ 발주서 생성 완료: **{po_no_gen}**")
        finally:
            session.close()

    # Existing POs
    session = get_session()
    try:
        pos = session.query(PurchaseOrder).filter_by(order_id=order.id).all()
        if pos:
            st.markdown("**발행된 발주서**")
            po_rows = []
            for po in pos:
                v = get_vendor(po.vendor_id)
                po_rows.append({
                    "PO No.": po.po_no, "Vendor": v.name if v else "—",
                    "발주일": po.date or "—", "상태": po.status,
                    "품목수": len(po.items or []),
                })
            st.dataframe(pd.DataFrame(po_rows), use_container_width=True, hide_index=True)
    finally:
        session.close()
