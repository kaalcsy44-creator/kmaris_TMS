"""AR / SOA management — track receivables, mark payments."""
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
from app.utils.helpers import inject_css, hint, section_header, ar_list, get_order, get_customer, status_badge, CURRENCIES, NAVY
from db.engine import get_session
from db.models import ARRecord, ARStatus

try:
    st.set_page_config(page_title="AR 관리 — KTMS", page_icon="💰", layout="wide")
except Exception:
    pass
require_auth()
inject_css()

section_header("ar", "AR 관리 (Accounts Receivable / SOA)")

# ── Filters ───────────────────────────────────────────────────────────────────
col_f1, col_f2 = st.columns(2)
status_filter = col_f1.selectbox("상태 필터", ["전체"] + [s.value for s in ARStatus])
currency_filter = col_f2.selectbox("통화 필터", ["전체"] + CURRENCIES)

ar_records = ar_list(None if status_filter == "전체" else status_filter)
if currency_filter != "전체":
    ar_records = [r for r in ar_records if r.currency == currency_filter]

# ── Summary KPIs ──────────────────────────────────────────────────────────────
total_outstanding = sum((r.invoice_amount - r.paid_amount) for r in ar_records if r.currency == "USD")
total_overdue     = sum((r.invoice_amount - r.paid_amount) for r in ar_records
                        if r.status == ARStatus.OVERDUE and r.currency == "USD")

k1, k2, k3 = st.columns(3)
k1.metric("전체 미수금 (USD)", f"{total_outstanding:,.2f}")
k2.metric("연체 (USD)",        f"{total_overdue:,.2f}")
k3.metric("건수",              len(ar_records))

st.markdown("---")

# ── SOA Table ─────────────────────────────────────────────────────────────────
if not ar_records:
    hint("AR 레코드가 없습니다. 문서 탭에서 Tax Invoice를 생성하면 자동 등록됩니다.")
    st.stop()

rows = []
for r in ar_records:
    order = get_order(r.order_id)
    cust  = get_customer(order.customer_id) if order else None
    outstanding = r.invoice_amount - r.paid_amount
    today_str = date.today().isoformat()
    if r.status not in (ARStatus.PAID,) and r.due_date and r.due_date < today_str:
        auto_status = "연체"
    else:
        auto_status = r.status.value
    rows.append({
        "ID": r.id,
        "CI No.": r.ci_no or "—",
        "Customer": cust.name if cust else "—",
        "오더": order.ord_no if order else "—",
        "통화": r.currency,
        "Invoice": f"{r.invoice_amount:,.2f}",
        "수금": f"{r.paid_amount:,.2f}",
        "미수금": f"{outstanding:,.2f}",
        "만기일": r.due_date or "—",
        "상태": auto_status,
    })

df = pd.DataFrame(rows)
selected = st.dataframe(
    df.drop(columns=["ID"]),
    use_container_width=True, hide_index=True,
    selection_mode="single-row", on_select="rerun",
)
sel = selected.selection.rows if hasattr(selected, "selection") else []

st.markdown("---")

# ── Payment record ────────────────────────────────────────────────────────────
if sel:
    ar_id = int(df.iloc[sel[0]]["ID"])
    session = get_session()
    try:
        ar = session.query(ARRecord).get(ar_id)
    finally:
        session.close()

    if ar:
        st.markdown(f"### {ar.ci_no or 'AR'} 수금 등록")
        outstanding = ar.invoice_amount - ar.paid_amount
        st.info(f"인보이스: {ar.currency} {ar.invoice_amount:,.2f} | 수금: {ar.currency} {ar.paid_amount:,.2f} | **미수금: {ar.currency} {outstanding:,.2f}**")

        with st.form("payment_form"):
            p1, p2 = st.columns(2)
            pay_amount  = p1.number_input("수금액", min_value=0.0, max_value=float(ar.invoice_amount), value=float(outstanding), step=100.0)
            due_date    = p2.date_input("결제기한 설정", value=date.today())
            new_status  = p1.selectbox("상태", [s.value for s in ARStatus],
                                       index=[s.value for s in ARStatus].index(ar.status.value))
            notes_input = p2.text_input("메모", value=ar.notes or "")
            save_pay    = st.form_submit_button("수금 등록", type="primary", use_container_width=True)

        if save_pay:
            session = get_session()
            try:
                a = session.query(ARRecord).get(ar_id)
                a.paid_amount += pay_amount
                a.due_date     = due_date.isoformat()
                a.notes        = notes_input
                if a.paid_amount >= a.invoice_amount:
                    a.status = ARStatus.PAID
                elif a.paid_amount > 0:
                    a.status = ARStatus.PARTIAL
                else:
                    a.status = ARStatus(new_status)
                session.commit()
                st.success(f"수금 등록 완료. 잔액: {ar.currency} {a.invoice_amount - a.paid_amount:,.2f}")
                st.rerun()
            finally:
                session.close()
else:
    hint("테이블에서 레코드를 선택하면 수금 등록 폼이 표시됩니다.")

# ── Manual AR entry ────────────────────────────────────────────────────────────
st.markdown("---")
with st.expander("직접 AR 레코드 추가", expanded=False):
    orders = st.session_state.get("_all_orders")
    from app.utils.helpers import order_list
    all_orders = order_list()
    if all_orders:
        ord_opts = {o.ord_no: o.id for o in all_orders}
        with st.form("manual_ar"):
            mc1, mc2, mc3 = st.columns(3)
            sel_ord   = mc1.selectbox("오더", list(ord_opts.keys()))
            ci_no_in  = mc2.text_input("CI No.")
            inv_amt   = mc3.number_input("Invoice 금액", min_value=0.0, step=100.0)
            cur_in    = mc1.selectbox("통화", CURRENCIES)
            due_in    = mc2.date_input("결제기한", date.today())
            add_ar    = st.form_submit_button("AR 추가")
        if add_ar:
            session = get_session()
            try:
                ar = ARRecord(
                    order_id=ord_opts[sel_ord],
                    ci_no=ci_no_in,
                    invoice_amount=inv_amt,
                    paid_amount=0.0,
                    currency=cur_in,
                    due_date=due_in.isoformat(),
                    status=ARStatus.OUTSTANDING,
                )
                session.add(ar)
                session.commit()
                st.success("AR 레코드 추가 완료!")
                st.rerun()
            finally:
                session.close()
