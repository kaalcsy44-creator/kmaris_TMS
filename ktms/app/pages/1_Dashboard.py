from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import streamlit as st
from app.utils.auth import require_auth
from app.utils.helpers import inject_css, hint, section_header, dashboard_stats, status_badge, NAVY, BLUE

try:
    st.set_page_config(page_title="Dashboard — KTMS", page_icon="📊", layout="wide")
except Exception:
    pass
require_auth()
inject_css()

section_header("dashboard", "Dashboard")

stats = dashboard_stats()

# ── KPI cards ─────────────────────────────────────────────────────────────────
c1, c2, c3, c4 = st.columns(4)
kpis = [
    (c1, "Open RFQ",       stats["open_rfq"],                        "건 진행 중"),
    (c2, "Active Orders",  stats["active_orders"],                    "건 배송 준비 중"),
    (c3, "AR Outstanding", f"USD {stats['ar_outstanding_usd']:,.0f}", "미수금"),
    (c4, "이번 달 견적",    stats["monthly_quotes"],                   "건 발송"),
]
for col, label, value, sub in kpis:
    with col:
        st.markdown(f"""
        <div class="ktms-kpi">
            <div style="font-size:0.85rem;color:#555;">{label}</div>
            <div class="ktms-kpi-value">{value}</div>
            <div class="ktms-kpi-label">{sub}</div>
        </div>
        """, unsafe_allow_html=True)

st.markdown("---")

# ── Urgent follow-up & Overdue AR ─────────────────────────────────────────────
col_left, col_right = st.columns(2)

with col_left:
    section_header("alert", "긴급 Follow-up — Level A 견적")
    urgent = stats["urgent_quotes"]
    if urgent:
        for q in urgent:
            st.markdown(f"""
            <div style="border:1px solid #dee2e6;border-radius:6px;padding:10px 14px;margin-bottom:6px;">
                <b>{q.qtn_no}</b>
                &nbsp;<span class="badge-A">Level A</span>
                <span style="float:right;color:#dc3545;">만료: {q.valid_until}</span><br>
                <small style="color:#555;">상태: </small>{status_badge(q.status.value)}
            </div>
            """, unsafe_allow_html=True)
    else:
        st.success("긴급 follow-up 견적이 없습니다.")

with col_right:
    section_header("clock", "연체 AR")
    overdue = stats["overdue_ar"]
    if overdue:
        from app.utils.helpers import get_session, Order
        for ar in overdue:
            s = get_session()
            order = s.query(Order).get(ar.order_id)
            s.close()
            outstanding = ar.invoice_amount - ar.paid_amount
            st.markdown(f"""
            <div style="border:1px solid #f5c2c7;border-radius:6px;padding:10px 14px;margin-bottom:6px;background:#fff5f5;">
                <b>{ar.ci_no or 'N/A'}</b>
                <span style="float:right;color:#dc3545;font-weight:700;">{ar.currency} {outstanding:,.2f}</span><br>
                <small style="color:#555;">오더: {order.ord_no if order else '—'} | 만기: {ar.due_date}</small>
            </div>
            """, unsafe_allow_html=True)
    else:
        st.success("연체 AR이 없습니다.")

st.markdown("---")

# ── Recent RFQ activity ───────────────────────────────────────────────────────
section_header("rfq", "최근 RFQ 현황")
from app.utils.helpers import rfq_list, get_customer, get_vessel

rfqs = rfq_list()[:10]
if rfqs:
    rows = []
    for r in rfqs:
        c = get_customer(r.customer_id)
        v = get_vessel(r.vessel_id) if r.vessel_id else None
        rows.append({
            "RFQ No.": r.rfq_no,
            "Customer": c.name if c else "—",
            "선박": v.name if v else "—",
            "품목수": len(r.items or []),
            "Level": r.follow_up_level.value if r.follow_up_level else "—",
            "상태": r.status.value,
            "날짜": r.date or "—",
        })
    import pandas as pd
    df = pd.DataFrame(rows)
    st.dataframe(df, use_container_width=True, hide_index=True)
else:
    hint("등록된 RFQ가 없습니다.")
