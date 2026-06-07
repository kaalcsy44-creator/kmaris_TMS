"""Shared DB helper functions and UI utilities."""
from __future__ import annotations
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import streamlit as st
from db.engine import get_session
from db.models import (
    Customer, Vendor, Vessel, ItemMaster,
    RFQ, Quotation, Order, CommercialInvoice,
    PackingList, ShippingAdvice, ARRecord,
    DocSequence, FollowUpLevel,
    RFQStatus, QuotationStatus, OrderStatus, ARStatus,
)

# ── Color palette (matches kmaris_docs.py) ───────────────────────────────────
NAVY = "#0B1D3A"
BLUE = "#0055A8"
LIGHT_BLUE = "#EAF3FF"

# ── White SVG nav icons (Feather-style, URL-encoded) ─────────────────────────
_S = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E"
_E = "%3C/svg%3E"
_ICONS = [
    # Dashboard — 2×2 grid
    _S+"%3Crect x='3' y='3' width='7' height='7' rx='1'/%3E%3Crect x='14' y='3' width='7' height='7' rx='1'/%3E%3Crect x='14' y='14' width='7' height='7' rx='1'/%3E%3Crect x='3' y='14' width='7' height='7' rx='1'/%3E"+_E,
    # RFQ — file-text
    _S+"%3Cpath d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'/%3E%3Cpolyline points='14 2 14 8 20 8'/%3E%3Cline x1='16' y1='13' x2='8' y2='13'/%3E%3Cline x1='16' y1='17' x2='8' y2='17'/%3E"+_E,
    # Quotation — clipboard
    _S+"%3Cpath d='M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2'/%3E%3Crect x='9' y='3' width='6' height='4' rx='2'/%3E%3Cline x1='9' y1='12' x2='15' y2='12'/%3E%3Cline x1='9' y1='16' x2='13' y2='16'/%3E"+_E,
    # Orders — package box
    _S+"%3Cpath d='M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z'/%3E%3Cpolyline points='3.27 6.96 12 12.01 20.73 6.96'/%3E%3Cline x1='12' y1='22.08' x2='12' y2='12'/%3E"+_E,
    # Documents — folder
    _S+"%3Cpath d='M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'/%3E"+_E,
    # AR — credit card
    _S+"%3Crect x='1' y='4' width='22' height='16' rx='2' ry='2'/%3E%3Cline x1='1' y1='10' x2='23' y2='10'/%3E"+_E,
    # Settings — sliders
    _S+"%3Cline x1='4' y1='21' x2='4' y2='14'/%3E%3Cline x1='4' y1='10' x2='4' y2='3'/%3E%3Cline x1='12' y1='21' x2='12' y2='12'/%3E%3Cline x1='12' y1='8' x2='12' y2='3'/%3E%3Cline x1='20' y1='21' x2='20' y2='16'/%3E%3Cline x1='20' y1='12' x2='20' y2='3'/%3E%3Cline x1='1' y1='14' x2='7' y2='14'/%3E%3Cline x1='9' y1='8' x2='15' y2='8'/%3E%3Cline x1='17' y1='16' x2='23' y2='16'/%3E"+_E,
]
_NAV_ICON_CSS = "\n".join(
    f"[data-testid=\"stSidebar\"] nav li:nth-child({i}) a::before {{ background-image: url(\"{u}\") !important; }}"
    for i, u in enumerate(_ICONS, 1)
)

KTMS_CSS = f"""
<style>
/* ── Sidebar width (≈half of 344px default) ── */
section[data-testid="stSidebar"] {{
    min-width: 210px !important;
    max-width: 210px !important;
    width: 210px !important;
}}

/* ── Nav: push down by ~2 items ── */
section[data-testid="stSidebar"] nav {{
    margin-top: 72px !important;
}}

/* ── Main content: pad top to clear fixed header (toolbar38 + section36 + tabs52) ── */
.main .block-container,
[data-testid="stMainBlockContainer"] {{
    padding-top: 130px !important;
}}

/* ── Sidebar colors ── */
[data-testid="stSidebar"] {{background-color: {NAVY};}}
[data-testid="stSidebar"] .stMarkdown, [data-testid="stSidebar"] label,
[data-testid="stSidebar"] .stSelectbox label, [data-testid="stSidebar"] p {{color: #E8EDF5;}}
[data-testid="stSidebar"] h1, [data-testid="stSidebar"] h2, [data-testid="stSidebar"] h3 {{color: white;}}

/* ── Nav text color ── */
[data-testid="stSidebar"] nav a,
[data-testid="stSidebar"] nav a * {{
    color: #C4CFDE !important;
    opacity: 1 !important;
}}
[data-testid="stSidebar"] nav a[aria-current="page"],
[data-testid="stSidebar"] nav a[aria-current="page"] * {{
    color: #FFFFFF !important;
}}

/* ── Nav icons via ::before + SVG data URI ── */
[data-testid="stSidebar"] nav li a {{
    display: flex !important;
    align-items: center !important;
}}
[data-testid="stSidebar"] nav li a::before {{
    content: '' !important;
    display: inline-block !important;
    width: 14px !important;
    height: 14px !important;
    min-width: 14px !important;
    background-size: contain !important;
    background-repeat: no-repeat !important;
    background-position: center !important;
    margin-right: 10px !important;
    opacity: 0.55 !important;
    flex-shrink: 0 !important;
}}
[data-testid="stSidebar"] nav li a[aria-current="page"]::before,
[data-testid="stSidebar"] nav li a:hover::before {{
    opacity: 1 !important;
}}
{_NAV_ICON_CSS}

/* ── Sidebar bottom: fixed user+logout area ── */
[data-testid="stSidebarUserContent"] {{
    position: fixed !important;
    bottom: 0 !important;
    left: 0 !important;
    width: 210px !important;
    background-color: {NAVY} !important;
    padding: 10px 16px 16px !important;
    border-top: 1px solid rgba(255,255,255,0.1) !important;
    z-index: 100 !important;
}}

/* Logout button: transparent bg matching dark sidebar */
[data-testid="stSidebarUserContent"] button,
[data-testid="stSidebarUserContent"] [data-testid^="baseButton"] {{
    background: transparent !important;
    background-color: transparent !important;
    border: 1px solid rgba(255,255,255,0.2) !important;
    color: #C4CFDE !important;
    box-shadow: none !important;
    height: 28px !important;
    min-height: 0 !important;
    padding: 0 4px !important;
    border-radius: 5px !important;
}}
[data-testid="stSidebarUserContent"] button:hover,
[data-testid="stSidebarUserContent"] [data-testid^="baseButton"]:hover {{
    background: rgba(255,255,255,0.1) !important;
    color: #FFFFFF !important;
    border-color: rgba(255,255,255,0.35) !important;
}}
[data-testid="stSidebarUserContent"] button svg,
[data-testid="stSidebarUserContent"] [data-testid^="baseButton"] svg {{
    color: #C4CFDE !important;
    fill: #C4CFDE !important;
}}
[data-testid="stSidebarUserContent"] button p,
[data-testid="stSidebarUserContent"] [data-testid^="baseButton"] p {{
    display: none !important;
}}

.ktms-kpi {{
    background:{LIGHT_BLUE}; border-left:4px solid {BLUE};
    border-radius:8px; padding:16px 20px; margin-bottom:8px;
}}
.ktms-kpi-value {{font-size:2rem; font-weight:700; color:{NAVY};}}
.ktms-kpi-label {{font-size:0.85rem; color:#555; margin-top:2px;}}
.ktms-section {{
    background:{NAVY}; color:white; padding:6px 14px;
    font-weight:600;
    position:fixed !important;
    top:38px !important;
    left:210px !important;
    right:0 !important;
    z-index:1000 !important;
    margin:0 !important;
    border-radius:0 !important;
}}

/* ── Fixed tab bar (just below title: 38px toolbar + 36px section = 74px) ── */
[data-baseweb="tab-list"] {{
    position:fixed !important;
    top:74px !important;
    left:210px !important;
    right:0 !important;
    z-index:999 !important;
    background:white !important;
    border-bottom:2px solid #e8e8e8 !important;
    padding:0 1rem !important;
}}

/* ── When sidebar is collapsed: reset left to 0 ── */
[data-testid="stSidebar"][aria-expanded="false"] ~ section .ktms-section,
[data-testid="stSidebar"][aria-expanded="false"] ~ section [data-baseweb="tab-list"] {{
    left:0 !important;
}}
.badge-A {{background:#dc3545; color:white; padding:2px 8px; border-radius:12px; font-size:0.78rem;}}
.badge-B {{background:#fd7e14; color:white; padding:2px 8px; border-radius:12px; font-size:0.78rem;}}
.badge-C {{background:#6c757d; color:white; padding:2px 8px; border-radius:12px; font-size:0.78rem;}}
</style>
"""

TRACKING_BASE_URL = "https://www.k-maris.com/track"


def inject_css():
    st.markdown(KTMS_CSS, unsafe_allow_html=True)


def tracking_url(kind: str, token: str) -> str:
    return f"{TRACKING_BASE_URL}/{kind}/{token}"


# ── Document numbering ────────────────────────────────────────────────────────

_PREFIX = {
    "rfq":       "CRFQ",
    "vendor_rfq": "VRFQ",
    "quotation": "QTN",
    "proforma":  "PI",
    "order":     "ORD",
    "po":        "PO",
    "ci":        "CI",
    "pl":        "PL",
    "sa":        "SA",
    "tax":       "TAX",
}


def next_doc_no(doc_type: str, company_prefix: str = "KMS") -> str:
    session = get_session()
    try:
        yr = date.today().year
        seq = session.query(DocSequence).filter_by(doc_type=doc_type, year=yr).first()
        if not seq:
            seq = DocSequence(doc_type=doc_type, year=yr, last_seq=0)
            session.add(seq)
        seq.last_seq += 1
        session.commit()
        prefix = _PREFIX.get(doc_type, "DOC")
        return f"{company_prefix}-{prefix}-{yr}-{seq.last_seq:04d}"
    finally:
        session.close()


# ── Master data loaders ───────────────────────────────────────────────────────

def all_customers() -> List[Customer]:
    s = get_session()
    try:
        return s.query(Customer).order_by(Customer.name).all()
    finally:
        s.close()


def all_vendors() -> List[Vendor]:
    s = get_session()
    try:
        return s.query(Vendor).order_by(Vendor.name).all()
    finally:
        s.close()


def all_vessels() -> List[Vessel]:
    s = get_session()
    try:
        return s.query(Vessel).order_by(Vessel.name).all()
    finally:
        s.close()


def customer_vessels(customer_id: int) -> List[Vessel]:
    s = get_session()
    try:
        return s.query(Vessel).filter(
            (Vessel.customer_id == customer_id) | (Vessel.customer_id == None)
        ).order_by(Vessel.name).all()
    finally:
        s.close()


def get_customer(cid: int) -> Optional[Customer]:
    s = get_session()
    try:
        return s.query(Customer).get(cid)
    finally:
        s.close()


def get_vessel(vid: int) -> Optional[Vessel]:
    s = get_session()
    try:
        return s.query(Vessel).get(vid)
    finally:
        s.close()


def get_vendor(vid: int) -> Optional[Vendor]:
    s = get_session()
    try:
        return s.query(Vendor).get(vid)
    finally:
        s.close()


# ── Selectbox helpers ─────────────────────────────────────────────────────────

def customer_options() -> Dict[str, int]:
    return {c.name: c.id for c in all_customers()}


def vendor_options() -> Dict[str, int]:
    return {v.name: v.id for v in all_vendors()}


def vessel_options(customer_id: int = None) -> Dict[str, int]:
    vessels = customer_vessels(customer_id) if customer_id else all_vessels()
    return {v.name: v.id for v in vessels}


# ── RFQ helpers ───────────────────────────────────────────────────────────────

def rfq_list(status: str = None) -> List[RFQ]:
    s = get_session()
    try:
        q = s.query(RFQ).order_by(RFQ.created_at.desc())
        if status:
            q = q.filter(RFQ.status == status)
        return q.all()
    finally:
        s.close()


def get_rfq(rfq_id: int) -> Optional[RFQ]:
    s = get_session()
    try:
        return s.query(RFQ).get(rfq_id)
    finally:
        s.close()


# ── Quotation helpers ─────────────────────────────────────────────────────────

def quotation_list(status: str = None) -> List[Quotation]:
    s = get_session()
    try:
        q = s.query(Quotation).order_by(Quotation.created_at.desc())
        if status:
            q = q.filter(Quotation.status == status)
        return q.all()
    finally:
        s.close()


def get_quotation(qid: int) -> Optional[Quotation]:
    s = get_session()
    try:
        return s.query(Quotation).get(qid)
    finally:
        s.close()


# ── Order helpers ─────────────────────────────────────────────────────────────

def order_list(status: str = None) -> List[Order]:
    s = get_session()
    try:
        q = s.query(Order).order_by(Order.created_at.desc())
        if status:
            q = q.filter(Order.status == status)
        return q.all()
    finally:
        s.close()


def get_order(oid: int) -> Optional[Order]:
    s = get_session()
    try:
        return s.query(Order).get(oid)
    finally:
        s.close()


def get_ci_for_order(order_id: int) -> Optional[CommercialInvoice]:
    s = get_session()
    try:
        return s.query(CommercialInvoice).filter_by(order_id=order_id).first()
    finally:
        s.close()


# ── AR helpers ────────────────────────────────────────────────────────────────

def ar_list(status: str = None) -> List[ARRecord]:
    s = get_session()
    try:
        q = s.query(ARRecord).order_by(ARRecord.due_date)
        if status:
            q = q.filter(ARRecord.status == status)
        return q.all()
    finally:
        s.close()


# ── Dashboard stats ───────────────────────────────────────────────────────────

def dashboard_stats() -> Dict[str, Any]:
    s = get_session()
    try:
        today = date.today().isoformat()
        month_start = date.today().replace(day=1).isoformat()

        open_rfq = s.query(RFQ).filter(
            RFQ.status.in_([RFQStatus.RECEIVED, RFQStatus.SOURCING, RFQStatus.QUOTING])
        ).count()

        active_orders = s.query(Order).filter(
            Order.status.in_([OrderStatus.RECEIVED, OrderStatus.PO_SENT,
                              OrderStatus.PREPARING, OrderStatus.SHIPPED, OrderStatus.IN_TRANSIT])
        ).count()

        ar_rows = s.query(ARRecord).filter(
            ARRecord.status.in_([ARStatus.OUTSTANDING, ARStatus.PARTIAL, ARStatus.OVERDUE])
        ).all()
        ar_outstanding_usd = sum(
            (r.invoice_amount - r.paid_amount) for r in ar_rows if r.currency == "USD"
        )

        monthly_quotes = s.query(Quotation).filter(
            Quotation.created_at >= month_start
        ).count()

        urgent_quotes = s.query(Quotation).filter(
            Quotation.status == QuotationStatus.SENT,
            Quotation.follow_up_level == FollowUpLevel.A,
            Quotation.valid_until <= (date.today() + timedelta(days=3)).isoformat(),
        ).all()

        overdue_ar = s.query(ARRecord).filter(
            ARRecord.status == ARStatus.OVERDUE
        ).all()

        return {
            "open_rfq": open_rfq,
            "active_orders": active_orders,
            "ar_outstanding_usd": ar_outstanding_usd,
            "monthly_quotes": monthly_quotes,
            "urgent_quotes": urgent_quotes,
            "overdue_ar": overdue_ar,
        }
    finally:
        s.close()


# ── Margin calculation ────────────────────────────────────────────────────────

def apply_margin(items: List[Dict], margin_pct: float, discount_pct: float = 0.0) -> List[Dict]:
    result = []
    for item in items:
        cost = float(item.get("cost_price", item.get("unit_price", 0)))
        sell = cost * (1 + margin_pct / 100) * (1 - discount_pct / 100)
        sell = round(sell, 2)
        new_item = dict(item)
        new_item["cost_price"] = cost
        new_item["unit_price"] = sell
        qty = float(new_item.get("qty", 1))
        new_item["amount"] = round(sell * qty, 2)
        result.append(new_item)
    return result


def total_amount(items: List[Dict]) -> float:
    return sum(float(i.get("amount", 0)) for i in items)


def status_color(status: str) -> str:
    colors = {
        "수신완료": "#0055A8", "공급사 소싱중": "#fd7e14", "견적 중": "#6f42c1",
        "이메일 발송 완료": "#20c997", "수주완료": "#198754", "실주": "#dc3545",
        "초안": "#6c757d", "발송완료": "#0055A8", "협상중": "#fd7e14",
        "수주확정": "#198754", "만료": "#adb5bd",
        "오더 수주": "#0055A8", "발주 완료": "#6f42c1", "제조/준비중": "#fd7e14",
        "출고완료": "#20c997", "운송중": "#0dcaf0", "목적지 하차 완료": "#198754",
        "미수": "#fd7e14", "일부수금": "#6f42c1", "완납": "#198754", "연체": "#dc3545",
    }
    return colors.get(status, "#6c757d")


def status_badge(status: str) -> str:
    color = status_color(status)
    return f'<span style="background:{color};color:white;padding:2px 10px;border-radius:12px;font-size:0.8rem;">{status}</span>'
