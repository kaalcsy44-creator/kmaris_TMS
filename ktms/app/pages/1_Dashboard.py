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

# ── RFQ ↔ Order 진행 현황 (좌우 페어링) ─────────────────────────────────────────
section_header("rfq", "RFQ ↔ Order 진행 현황")
from app.utils.helpers import (
    rfq_list, get_customer, get_vessel, status_badge, tracking_stepper_html,
    get_order_for_rfq, orphan_order_list,
)
from services.tracking_status import RFQ_STEPS, ORDER_STEPS, rfq_tracking_step, order_tracking_step


def _rfq_card_html(r) -> str:
    c = get_customer(r.customer_id)
    v = get_vessel(r.vessel_id) if r.vessel_id else None
    step, _key = rfq_tracking_step(r.status.value)
    return f"""
    <div class="ktms-track-card">
        <div class="ktms-track-card-head">
            <div>
                <span class="ktms-track-card-title">{r.rfq_no}</span>
                <span class="ktms-track-card-sub">{c.name if c else '—'} · {v.name if v else '—'}</span>
            </div>
            <div>{status_badge(r.status.value)}</div>
        </div>
        <div class="ktms-track-card-meta">품목 {len(r.items or [])}개 · Level {r.follow_up_level.value if r.follow_up_level else '—'} · {r.date or '—'}</div>
        {tracking_stepper_html(RFQ_STEPS, step)}
    </div>
    """


def _order_card_html(o) -> str:
    c = get_customer(o.customer_id)
    v = get_vessel(o.vessel_id) if o.vessel_id else None
    step, _key = order_tracking_step(o.status.value)
    return f"""
    <div class="ktms-track-card">
        <div class="ktms-track-card-head">
            <div>
                <span class="ktms-track-card-title">{o.ord_no}</span>
                <span class="ktms-track-card-sub">{c.name if c else '—'} · {v.name if v else '—'}</span>
            </div>
            <div>{status_badge(o.status.value)}</div>
        </div>
        <div class="ktms-track-card-meta">품목 {len(o.items or [])}개 · {o.date or '—'}</div>
        {tracking_stepper_html(ORDER_STEPS, step)}
    </div>
    """


def _empty_order_card_html() -> str:
    return f"""
    <div class="ktms-track-card">
        <div class="ktms-track-card-head">
            <div>
                <span class="ktms-track-card-title">—</span>
                <span class="ktms-track-card-sub">아직 Order가 생성되지 않았습니다</span>
            </div>
        </div>
        <div class="ktms-track-card-meta">&nbsp;</div>
        {tracking_stepper_html(ORDER_STEPS, -1)}
    </div>
    """


rfqs = rfq_list()[:10]
if rfqs:
    col_rfq, col_order = st.columns(2)
    with col_rfq:
        st.markdown("**RFQ**")
    with col_order:
        st.markdown("**연결된 Order**")
    for r in rfqs:
        col_rfq, col_order = st.columns(2)
        with col_rfq:
            st.markdown(_rfq_card_html(r), unsafe_allow_html=True)
        with col_order:
            o = get_order_for_rfq(r.id)
            st.markdown(_order_card_html(o) if o else _empty_order_card_html(), unsafe_allow_html=True)
else:
    hint("등록된 RFQ가 없습니다.")

# ── RFQ와 연결되지 않은 Order ───────────────────────────────────────────────────
orphans = orphan_order_list()
if orphans:
    st.markdown("---")
    section_header("order", "RFQ 연결 없는 Order")
    for o in orphans:
        st.markdown(_order_card_html(o), unsafe_allow_html=True)
