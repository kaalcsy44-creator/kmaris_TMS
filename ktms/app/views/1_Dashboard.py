from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import streamlit as st

from app.utils.auth import require_auth
from app.utils.helpers import (
    BLUE,
    INTERNAL_STEPS,
    dashboard_snapshot,
    dashboard_stats,
    hint,
    inject_css,
    internal_progress_bar_html,
    internal_stepper_html,
    section_header,
    status_badge,
    tracking_stepper_html,
)
from services.tracking_status import ORDER_STEPS, RFQ_STEPS

try:
    st.set_page_config(page_title="Dashboard · KTMS", page_icon="📊", layout="wide")
except Exception:
    pass

require_auth()
inject_css()

stats = dashboard_stats()
snapshot = dashboard_snapshot(limit=20)


def kpi_card(label: str, value, sub: str, accent: str = BLUE, chip_html: str = "") -> str:
    foot = f'<div class="kc-foot">{chip_html}</div>' if chip_html else ""
    return f"""
    <div class="ktms-kpi-c" style="border-left-color:{accent};">
        <div class="kc-lbl">{label}</div>
        <div class="kc-val">{value}</div>
        <div class="kc-sub">{sub}</div>
        {foot}
    </div>
    """


def chip(text: str, tone: str = "gray") -> str:
    return f'<span class="kc-chip {tone}">{text}</span>'


def rfq_card_html(r: dict) -> str:
    cust_no = (
        f'<span style="font-weight:600;color:#6B7280;font-size:12px;">'
        f'&nbsp;· Customer RFQ {r["customer_rfq_no"]}</span>'
        if r["customer_rfq_no"] else ""
    )
    return f"""
    <div class="ktms-track-card">
        <div class="ktms-track-card-head">
            <span class="ktms-track-card-title">{r["rfq_no"]}{cust_no}</span>
            <span class="ktms-track-card-badge">{status_badge(r["status"])}</span>
        </div>
        <div class="ktms-track-card-sub">{r["customer_vessel"]}</div>
        <div class="ktms-track-card-meta">Items {r["item_count"]} · Level {r["follow_up_level"]} · {r["date"]}</div>
        {tracking_stepper_html(RFQ_STEPS, r["step"])}
    </div>
    """


def order_card_html(o: dict) -> str:
    return f"""
    <div class="ktms-track-card">
        <div class="ktms-track-card-head">
            <span class="ktms-track-card-title">{o["ord_no"]}</span>
            <span class="ktms-track-card-badge">{status_badge(o["status"])}</span>
        </div>
        <div class="ktms-track-card-sub">{o["customer_vessel"]}</div>
        <div class="ktms-track-card-meta">Items {o["item_count"]} · {o["date"]}</div>
        {tracking_stepper_html(ORDER_STEPS, o["step"])}
    </div>
    """


def empty_order_card_html() -> str:
    return f"""
    <div class="ktms-track-card">
        <div class="ktms-track-card-head">
            <span class="ktms-track-card-title">No linked order</span>
        </div>
        <div class="ktms-track-card-sub">Order has not been created yet.</div>
        <div class="ktms-track-card-meta">&nbsp;</div>
        {tracking_stepper_html(ORDER_STEPS, -1)}
    </div>
    """


section_header("dashboard", "운영 현황")
urgent_n = len(stats["urgent_quotes"])
overdue_n = len(stats["overdue_ar"])
pending_n = stats["pending_po"]
expiring_n = stats["expiring_quotes"]

c1, c2, c3, c4 = st.columns(4)
ops = [
    (c1, "Open RFQ", stats["open_rfq"], "진행 중", BLUE, chip(f"Urgent {urgent_n}", "red") if urgent_n else chip("Urgent 0")),
    (c2, "Active Orders", stats["active_orders"], "배송 준비/진행", BLUE, chip(f"PO pending {pending_n}", "amber") if pending_n else chip("PO pending 0")),
    (c3, "AR Outstanding", f"USD {stats['ar_outstanding_usd']:,.0f}", "미수금", "#dc3545" if overdue_n else BLUE, chip(f"Overdue {overdue_n}", "red") if overdue_n else chip("Overdue 0")),
    (c4, "This Month Quotes", stats["monthly_quotes"], "견적", BLUE, chip(f"Expiring {expiring_n}", "amber") if expiring_n else chip("Expiring 0")),
]
for col, label, value, sub, accent, foot in ops:
    with col:
        st.markdown(kpi_card(label, value, sub, accent, foot), unsafe_allow_html=True)

section_header("rfq", "영업 성과 KPI")
tat = stats["quotation_tat_h"]
tat_val = f"{tat:,.0f}h" if tat is not None else "—"
nego_usd = stats["negotiating_value_usd"]
p1, p2, p3, p4 = st.columns(4)
perf = [
    (p1, "RFQ Handling Rate", f"{stats['handling_rate']:.0f}%", "견적 제출률", BLUE, ""),
    (p2, "Quotation TAT", tat_val, "평균 응답시간", "#2e8b57", ""),
    (p3, "Hit Rate", f"{stats['hit_rate']:.0f}%", "PO 전환율", "#e8830c", chip(f"Negotiating USD {nego_usd:,.0f}", "blue")),
    (p4, "Gross Margin", f"{stats['gross_margin_pct']:.1f}%", "매출이익률", "#1a7a4a", ""),
]
for col, label, value, sub, accent, foot in perf:
    with col:
        st.markdown(kpi_card(label, value, sub, accent, foot), unsafe_allow_html=True)

st.markdown("---")
left, right = st.columns(2)

with left:
    section_header("alert", "긴급 Follow-up · Level A 견적")
    if stats["urgent_quotes"]:
        for q in stats["urgent_quotes"]:
            st.markdown(
                f"""
                <div style="border:1px solid #dee2e6;border-radius:6px;padding:10px 14px;margin-bottom:6px;">
                    <b>{q.qtn_no}</b>
                    <span style="float:right;color:#dc3545;">Valid until: {q.valid_until}</span><br>
                    <small style="color:#555;">Status: </small>{status_badge(q.status.value)}
                </div>
                """,
                unsafe_allow_html=True,
            )
    else:
        st.success("긴급 follow-up 견적이 없습니다.")

with right:
    section_header("clock", "연체 AR")
    if stats["overdue_ar"]:
        for ar in stats["overdue_ar"]:
            outstanding = ar.invoice_amount - ar.paid_amount
            st.markdown(
                f"""
                <div style="border:1px solid #f5c2c7;border-radius:6px;padding:10px 14px;margin-bottom:6px;background:#fff5f5;">
                    <b>{ar.ci_no or 'N/A'}</b>
                    <span style="float:right;color:#dc3545;font-weight:700;">{ar.currency} {outstanding:,.2f}</span><br>
                    <small style="color:#555;">Due: {ar.due_date}</small>
                </div>
                """,
                unsafe_allow_html=True,
            )
    else:
        st.success("연체 AR이 없습니다.")

st.markdown("---")
section_header("rfq", "RFQ · Order 진행 현황")
hint("각 건을 펼치면 고객에게 보이는 RFQ/Order 추적 단계를 확인할 수 있습니다.")

rfqs = snapshot["rfqs"]
if rfqs:
    for r in rfqs:
        label = f'{r["rfq_no"]} · :gray[{r["customer_vessel"]}] · {RFQ_STEPS[r["step"]]}'
        with st.expander(label, expanded=False):
            col_rfq, col_order = st.columns(2)
            with col_rfq:
                st.markdown("**RFQ**")
                st.markdown(rfq_card_html(r), unsafe_allow_html=True)
            with col_order:
                st.markdown("**Linked Order**")
                st.markdown(
                    order_card_html(r["order"]) if r["order"] else empty_order_card_html(),
                    unsafe_allow_html=True,
                )
else:
    hint("등록된 RFQ가 없습니다.")

if snapshot["orphans"]:
    st.markdown("---")
    section_header("order", "RFQ 연결 없는 Order")
    for order in snapshot["orphans"]:
        st.markdown(order_card_html(order), unsafe_allow_html=True)

st.markdown("---")
section_header("order", "내부 진행 현황 (12단계)")
hint("거래 건의 전체 흐름을 12단계로 추적합니다. 각 건을 펼치면 단계별 상세를 볼 수 있습니다.")

if rfqs:
    for r in rfqs:
        stage = r["stage"]
        label = f'{r["rfq_no"]} · :gray[{r["customer_vessel"]}] · {stage}/{len(INTERNAL_STEPS)} {INTERNAL_STEPS[stage - 1]}'
        with st.expander(label, expanded=False):
            st.markdown(internal_progress_bar_html(stage), unsafe_allow_html=True)
            st.markdown(internal_stepper_html(stage), unsafe_allow_html=True)
else:
    hint("등록된 RFQ가 없습니다.")
