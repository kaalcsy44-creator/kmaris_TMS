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

stats = dashboard_stats()


def kpi_card(label: str, value, sub: str, accent: str = BLUE, chip: str = "") -> str:
    """컴팩트 KPI 카드 — 동일 크기, 좌측 accent 보더, 하단 알림 칩(선택)."""
    chip_html = f'<div class="kc-foot">{chip}</div>' if chip else ""
    return f"""
    <div class="ktms-kpi-c" style="border-left-color:{accent};">
        <div class="kc-lbl">{label}</div>
        <div class="kc-val">{value}</div>
        <div class="kc-sub">{sub}</div>
        {chip_html}
    </div>
    """


def chip(text: str, tone: str = "gray") -> str:
    return f'<span class="kc-chip {tone}">{text}</span>'


# ── 1단: 운영 현황 ─────────────────────────────────────────────────────────────
section_header("dashboard", "운영 현황")
urgent_n = len(stats["urgent_quotes"])
overdue_n = len(stats["overdue_ar"])
pending_n = stats["pending_po"]
expiring_n = stats["expiring_quotes"]
c1, c2, c3, c4 = st.columns(4)
ops = [
    (c1, "Open RFQ",       stats["open_rfq"],                        "진행 중",
     BLUE,
     chip(f"긴급 {urgent_n}", "red") if urgent_n else chip("긴급 0", "gray")),
    (c2, "Active Orders",  stats["active_orders"],                    "배송 준비 중",
     BLUE,
     chip(f"발주 대기 {pending_n}", "amber") if pending_n else chip("발주 대기 0", "gray")),
    (c3, "AR Outstanding", f"USD {stats['ar_outstanding_usd']:,.0f}", "미수금",
     "#dc3545" if overdue_n else BLUE,
     chip(f"연체 {overdue_n}", "red") if overdue_n else chip("연체 0", "gray")),
    (c4, "이번 달 견적",    stats["monthly_quotes"],                   "발송",
     BLUE,
     chip(f"만료 임박 {expiring_n}", "amber") if expiring_n else chip("만료 임박 0", "gray")),
]
for col, label, value, sub, accent, chip_html in ops:
    with col:
        st.markdown(kpi_card(label, value, sub, accent, chip_html), unsafe_allow_html=True)

# ── 2단: 핵심 성과 KPI ─────────────────────────────────────────────────────────
section_header("rfq", "핵심 성과 KPI")
tat = stats["quotation_tat_h"]
tat_val = f"{tat:,.0f}h" if tat is not None else "—"
nego_usd = stats["negotiating_value_usd"]
p1, p2, p3, p4 = st.columns(4)
perf = [
    (p1, "RFQ Handling Rate", f"{stats['handling_rate']:.0f}%", "견적 제출률",
     "#0055A8", ""),
    (p2, "Quotation TAT",     tat_val,                          "평균 응답시간",
     "#2e8b57", ""),
    (p3, "Hit Rate",          f"{stats['hit_rate']:.0f}%",      "PO 전환율",
     "#e8830c", chip(f"협상중 USD {nego_usd:,.0f}", "blue")),
    (p4, "Gross Margin",      f"{stats['gross_margin_pct']:.1f}%", "매출이익률",
     "#1a7a4a", ""),
]
for col, label, value, sub, accent, chip_html in perf:
    with col:
        st.markdown(kpi_card(label, value, sub, accent, chip_html), unsafe_allow_html=True)

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


def _customer_vessel(c, v) -> str:
    name = c.name if c else "—"
    if v and v.name:
        return f"{name} · {v.name}"
    return name


def _rfq_card_html(r) -> str:
    c = get_customer(r.customer_id)
    v = get_vessel(r.vessel_id) if r.vessel_id else None
    step, _key = rfq_tracking_step(r.status.value)
    return f"""
    <div class="ktms-track-card">
        <div class="ktms-track-card-head">
            <span class="ktms-track-card-title">{r.rfq_no}</span>
            <span class="ktms-track-card-badge">{status_badge(r.status.value)}</span>
        </div>
        <div class="ktms-track-card-sub">{_customer_vessel(c, v)}</div>
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
            <span class="ktms-track-card-title">{o.ord_no}</span>
            <span class="ktms-track-card-badge">{status_badge(o.status.value)}</span>
        </div>
        <div class="ktms-track-card-sub">{_customer_vessel(c, v)}</div>
        <div class="ktms-track-card-meta">품목 {len(o.items or [])}개 · {o.date or '—'}</div>
        {tracking_stepper_html(ORDER_STEPS, step)}
    </div>
    """


def _empty_order_card_html() -> str:
    return f"""
    <div class="ktms-track-card">
        <div class="ktms-track-card-head">
            <span class="ktms-track-card-title">—</span>
        </div>
        <div class="ktms-track-card-sub">아직 Order가 생성되지 않았습니다</div>
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
