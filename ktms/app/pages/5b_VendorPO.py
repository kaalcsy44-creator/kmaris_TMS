"""Vendor P/O 발신 — 수주 오더 기준으로 Vendor 발주서(Purchase Order) 생성·발송."""
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
    inject_css, hint, section_header, next_doc_no,
    get_customer, get_vessel, get_vendor, vendor_options,
    order_list, get_order,
)
from db.engine import get_session
from db.models import Order, PurchaseOrder, OrderStatus

try:
    st.set_page_config(page_title="Vendor P/O 발신 — KTMS", page_icon="📨", layout="wide")
except Exception:
    pass
require_auth()
inject_css()

section_header("send", "Vendor P/O 발신 (Purchase Order)")

# ── 대상 오더 선택 ────────────────────────────────────────────────────────────
orders = order_list()
if not orders:
    hint("등록된 오더가 없습니다. 먼저 'Customer PO 수신'에서 수주를 등록하세요.")
    st.stop()

ord_opts = {}
for o in orders:
    c = get_customer(o.customer_id)
    label = f"{o.ord_no} · {c.name if c else '—'} · {o.status.value}"
    ord_opts[label] = o.id

# 직전에 선택한 오더를 기본값으로
cur_id = st.session_state.get("ord_detail_id")
labels = list(ord_opts.keys())
default_idx = 0
if cur_id in ord_opts.values():
    default_idx = list(ord_opts.values()).index(cur_id)

sel_label = st.selectbox("대상 오더 선택", labels, index=default_idx)
st.session_state["ord_detail_id"] = ord_opts[sel_label]

order = get_order(int(st.session_state["ord_detail_id"]))
if not order:
    st.error("선택한 오더를 찾을 수 없습니다. 다시 선택하세요.")
    st.stop()

cust   = get_customer(order.customer_id)
vessel = get_vessel(order.vessel_id) if order.vessel_id else None

st.markdown(
    f"**대상 오더:** `{order.ord_no}`  ·  {cust.name if cust else '—'}"
    f"  ·  {vessel.name if vessel else '—'}  ·  품목 {len(order.items or [])}개"
)
st.markdown("---")

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
