"""Shared DB helper functions and UI utilities."""
from __future__ import annotations
import base64
import sys
import urllib.parse
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
    RFQ, VendorRFQ, VendorQuote, Quotation, Order, PurchaseOrder, CommercialInvoice,
    PackingList, ShippingAdvice, TaxInvoiceData, ARRecord,
    DocSequence, FollowUpLevel,
    RFQStatus, QuotationStatus, OrderStatus, ARStatus,
)

# ── Color palette (matches kmaris_docs.py) ───────────────────────────────────
NAVY = "#0B1D3A"
BLUE = "#0055A8"
LIGHT_BLUE = "#EAF3FF"

# ── Shared constants (single source of truth) ────────────────────────────────
CURRENCIES = ["USD", "EUR", "KRW", "SGD", "JPY"]

# ── White SVG nav icons (Feather-style, URL-encoded) ─────────────────────────
_S = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E"
_E = "%3C/svg%3E"
_ICONS = [
    # [0] Dashboard — 2×2 grid
    _S+"%3Crect x='3' y='3' width='7' height='7' rx='1'/%3E%3Crect x='14' y='3' width='7' height='7' rx='1'/%3E%3Crect x='14' y='14' width='7' height='7' rx='1'/%3E%3Crect x='3' y='14' width='7' height='7' rx='1'/%3E"+_E,
    # [1] CRFQ — file-text
    _S+"%3Cpath d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'/%3E%3Cpolyline points='14 2 14 8 20 8'/%3E%3Cline x1='16' y1='13' x2='8' y2='13'/%3E%3Cline x1='16' y1='17' x2='8' y2='17'/%3E"+_E,
    # [2] VRFQ — send (paper-plane)
    _S+"%3Cline x1='22' y1='2' x2='11' y2='13'/%3E%3Cpolygon points='22 2 15 22 11 13 2 9 22 2'/%3E"+_E,
    # [3] Quotation — clipboard
    _S+"%3Cpath d='M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2'/%3E%3Crect x='9' y='3' width='6' height='4' rx='2'/%3E%3Cline x1='9' y1='12' x2='15' y2='12'/%3E%3Cline x1='9' y1='16' x2='13' y2='16'/%3E"+_E,
    # [4] Orders — package box
    _S+"%3Cpath d='M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z'/%3E%3Cpolyline points='3.27 6.96 12 12.01 20.73 6.96'/%3E%3Cline x1='12' y1='22.08' x2='12' y2='12'/%3E"+_E,
    # [5] Documents — folder
    _S+"%3Cpath d='M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'/%3E"+_E,
    # [6] AR — credit card
    _S+"%3Crect x='1' y='4' width='22' height='16' rx='2' ry='2'/%3E%3Cline x1='1' y1='10' x2='23' y2='10'/%3E"+_E,
    # [7] Settings — sliders
    _S+"%3Cline x1='4' y1='21' x2='4' y2='14'/%3E%3Cline x1='4' y1='10' x2='4' y2='3'/%3E%3Cline x1='12' y1='21' x2='12' y2='12'/%3E%3Cline x1='12' y1='8' x2='12' y2='3'/%3E%3Cline x1='20' y1='21' x2='20' y2='16'/%3E%3Cline x1='20' y1='12' x2='20' y2='3'/%3E%3Cline x1='1' y1='14' x2='7' y2='14'/%3E%3Cline x1='9' y1='8' x2='15' y2='8'/%3E%3Cline x1='17' y1='16' x2='23' y2='16'/%3E"+_E,
]
# Nav layout with dict sections (each section header is a <li> with a <p>):
#   li:1  → " " header (invisible)    li:2  → Dashboard   li:3  → RFQ & Quotation   li:4 → P/O
#   li:5  → "선적 · 정산" header       li:6  → Documents   li:7  → AR
#   li:8  → "시스템" header           li:9  → Settings
_NAV_ICON_POSITIONS = [
    (2, 0), (3, 1), (4, 4), (6, 5), (7, 6), (9, 7),
]
_NAV_ICON_CSS = "\n".join(
    f"[data-testid=\"stSidebar\"] nav li:nth-child({pos}) a::before {{ background-image: url(\"{_ICONS[idx]}\") !important; }}"
    for pos, idx in _NAV_ICON_POSITIONS
)


# ── K-MARIS brand emblem (official logo PNG, transparent background) ──────────
_EMBLEM_PATH = Path(__file__).resolve().parent.parent / "assets" / "kmaris_emblem.png"
_EMBLEM_B64 = base64.b64encode(_EMBLEM_PATH.read_bytes()).decode()
_EMBLEM_DATA_URI = f"data:image/png;base64,{_EMBLEM_B64}"
# Cropped emblem aspect ratio (width / height) — used to size without distortion.
_EMBLEM_AR = 300 / 217


def kmaris_emblem_img(height: int = 112) -> str:
    """Official K-MARIS emblem as an <img> tag (for light backgrounds, e.g. login)."""
    width = round(height * _EMBLEM_AR)
    return (
        f'<img src="{_EMBLEM_DATA_URI}" alt="K-MARIS" '
        f'width="{width}" height="{height}" '
        f'style="display:block;width:{width}px;height:{height}px;" />'
    )


def _sidebar_logo_svg() -> str:
    """Sidebar lockup: emblem in a white chip + white 'TMS' wordmark (on navy)."""
    # Emblem fitted inside the 54×54 white chip, centered (keeps aspect ratio).
    img_w = 44
    img_h = round(img_w / _EMBLEM_AR)        # ≈ 32
    img_x = 2 + (54 - img_w) / 2             # center horizontally in chip
    img_y = 5 + (54 - img_h) / 2             # center vertically in chip
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'width="134" height="64" viewBox="0 0 134 64" fill="none">'
        f'<rect x="2" y="5" width="54" height="54" rx="12" fill="#FFFFFF"/>'
        f'<image x="{img_x:.1f}" y="{img_y:.1f}" width="{img_w}" height="{img_h}" '
        f'xlink:href="{_EMBLEM_DATA_URI}"/>'
        f'<text x="66" y="44" font-family="Arial,Helvetica,sans-serif" '
        f'font-size="30" font-weight="800" letter-spacing="-0.5" '
        f'fill="#FFFFFF">TMS</text>'
        f'</svg>'
    )


# URL-encoded as a CSS background data URI (injected into KTMS_CSS below).
_SIDEBAR_LOGO_URI = "data:image/svg+xml," + urllib.parse.quote(
    _sidebar_logo_svg(), safe="",
)

KTMS_CSS = f"""
<style>
@import url('https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200');
/* ════════════════════════════════════════════════════════════════════════════
   K-MARIS KTMS — Design System (matches k-maris.com)
   Font    : Arial, Helvetica Neue, Helvetica, sans-serif
   Navy    : #0B1D3A  |  Blue : #0055A8  |  Sky : #3BA6E0
   Light   : #F6F8FB  |  Line : #D7E2EE  |  Text : #1F2937
   ════════════════════════════════════════════════════════════════════════════ */

/* ── Global font & body ──────────────────────────────────────────────────── */
*, html, body, .stApp,
[data-testid="stAppViewContainer"],
[data-testid="stMainBlockContainer"],
.stMarkdown, button, input, textarea, select,
[data-baseweb="input"], [data-baseweb="select"],
[data-baseweb="textarea"], [data-baseweb="tab"] {{
    font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif !important;
}}

/* ── Restore Material Symbols font (overridden by * above) ──────────────── */
.material-symbols-outlined,
.material-symbols-rounded,
.material-symbols-sharp,
span[class*="material-symbols"],
[data-testid="stIconMaterial"] {{
    font-family: 'Material Symbols Outlined' !important;
    font-variation-settings: 'FILL' 0, 'wght' 300, 'GRAD' 0, 'opsz' 24 !important;
    line-height: 1 !important;
    letter-spacing: normal !important;
    word-wrap: normal !important;
    white-space: nowrap !important;
    direction: ltr !important;
    font-feature-settings: 'liga' !important;
    -webkit-font-feature-settings: 'liga' !important;
}}

/* ── App background ──────────────────────────────────────────────────────── */
.stApp, [data-testid="stAppViewContainer"] {{
    background-color: #F6F8FB !important;
}}
.main .block-container,
[data-testid="stMainBlockContainer"] {{
    padding-top: 105px !important;
    background-color: #F6F8FB !important;
}}

/* ── Headings ────────────────────────────────────────────────────────────── */
.stMarkdown h1, .stMarkdown h2, .stMarkdown h3, .stMarkdown h4,
h1, h2, h3, h4 {{
    font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif !important;
    color: {NAVY} !important;
    font-weight: 800 !important;
    letter-spacing: -.025em;
    line-height: 1.14;
}}
.stMarkdown h1 {{ font-size: 1.9rem; }}
.stMarkdown h2 {{ font-size: 1.45rem; }}
.stMarkdown h3 {{ font-size: 1.1rem; letter-spacing: -.015em; }}
.stMarkdown p  {{ color: #1F2937; line-height: 1.65; }}

/* ── Metric cards (KPI) ──────────────────────────────────────────────────── */
[data-testid="stMetric"] {{
    background: #ffffff !important;
    border: 1px solid #D7E2EE !important;
    border-radius: 14px !important;
    padding: 18px 22px !important;
    box-shadow: 0 4px 20px rgba(11,29,58,.07) !important;
    transition: box-shadow .2s, transform .2s;
}}
[data-testid="stMetric"]:hover {{
    box-shadow: 0 10px 36px rgba(11,29,58,.14) !important;
    transform: translateY(-2px);
}}
[data-testid="stMetricValue"] > div {{
    color: {NAVY} !important;
    font-weight: 800 !important;
    letter-spacing: -.03em !important;
    font-size: 2rem !important;
}}
[data-testid="stMetricLabel"] > div {{
    color: #6B7280 !important;
    font-size: 11px !important;
    font-weight: 700 !important;
    text-transform: uppercase !important;
    letter-spacing: .08em !important;
}}

/* ── Primary buttons ─────────────────────────────────────────────────────── */
[data-testid="baseButton-primary"] {{
    background-color: {BLUE} !important;
    color: #ffffff !important;
    font-weight: 800 !important;
    font-size: 14px !important;
    border-radius: 14px !important;
    min-height: 44px !important;
    border: none !important;
    box-shadow: 0 4px 16px rgba(0,85,168,.28) !important;
    letter-spacing: -.01em !important;
    transition: background .18s, box-shadow .18s, transform .18s !important;
}}
[data-testid="baseButton-primary"]:hover {{
    background-color: #004899 !important;
    box-shadow: 0 6px 24px rgba(0,85,168,.4) !important;
    transform: translateY(-1px) !important;
}}

/* ── Secondary buttons ───────────────────────────────────────────────────── */
[data-testid="baseButton-secondary"] {{
    background-color: #ffffff !important;
    color: {BLUE} !important;
    font-weight: 700 !important;
    font-size: 14px !important;
    border-radius: 14px !important;
    min-height: 44px !important;
    border: 2px solid {BLUE} !important;
    box-shadow: none !important;
    transition: background .15s !important;
}}
[data-testid="baseButton-secondary"]:hover {{
    background-color: #EBF4FF !important;
}}

/* ── Text inputs ─────────────────────────────────────────────────────────── */
[data-baseweb="input"] > div,
[data-baseweb="textarea"] > div {{
    border: 1.5px solid #D7E2EE !important;
    border-radius: 8px !important;
    background: #ffffff !important;
    transition: border-color .15s, box-shadow .15s !important;
}}
[data-baseweb="input"]:focus-within > div,
[data-baseweb="textarea"]:focus-within > div {{
    border-color: {BLUE} !important;
    box-shadow: 0 0 0 3px rgba(0,85,168,.1) !important;
}}
[data-baseweb="input"] input,
[data-baseweb="textarea"] textarea {{
    color: #1F2937 !important;
    font-size: 14px !important;
}}

/* ── Select box ──────────────────────────────────────────────────────────── */
[data-baseweb="select"] > div:first-child {{
    border: 1.5px solid #D7E2EE !important;
    border-radius: 8px !important;
    min-height: 42px !important;
    background: #ffffff !important;
    transition: border-color .15s, box-shadow .15s !important;
}}
[data-baseweb="select"]:focus-within > div:first-child {{
    border-color: {BLUE} !important;
    box-shadow: 0 0 0 3px rgba(0,85,168,.1) !important;
}}

/* ── Field labels ────────────────────────────────────────────────────────── */
.stTextInput label, .stSelectbox label, .stTextArea label,
.stDateInput label, .stNumberInput label, .stMultiSelect label,
.stRadio > label, .stCheckbox > label, .stFileUploader label {{
    font-weight: 700 !important;
    font-size: 13px !important;
    color: {NAVY} !important;
    letter-spacing: .01em !important;
}}

/* ── Expanders ───────────────────────────────────────────────────────────── */
[data-testid="stExpander"] {{
    border: 1px solid #D7E2EE !important;
    border-radius: 14px !important;
    box-shadow: 0 4px 20px rgba(11,29,58,.07) !important;
    background: #ffffff !important;
    overflow: hidden !important;
}}
[data-testid="stExpander"] summary,
[data-testid="stExpander"] summary p {{
    font-weight: 700 !important;
    color: {NAVY} !important;
    font-size: 14px !important;
}}
/* 토글 라벨 안 :gray[...] 부분(고객사·선박명) — 약간 작게, 비-bold, 회색 유지 */
[data-testid="stExpander"] summary p span[style*="color"] {{
    font-weight: 400 !important;
    font-size: 0.88em !important;
}}

/* ── Forms ───────────────────────────────────────────────────────────────── */
[data-testid="stForm"] {{
    background: #ffffff !important;
    border: 1px solid #D7E2EE !important;
    border-radius: 14px !important;
    padding: 20px 24px !important;
    box-shadow: 0 4px 20px rgba(11,29,58,.07) !important;
}}

/* ── DataFrames ──────────────────────────────────────────────────────────── */
[data-testid="stDataFrame"] > div {{
    border: 1px solid #D7E2EE !important;
    border-radius: 14px !important;
    overflow: hidden !important;
    box-shadow: 0 4px 20px rgba(11,29,58,.07) !important;
}}

/* ── Alert / info boxes ──────────────────────────────────────────────────── */
[data-testid="stAlert"] {{
    border-radius: 10px !important;
    border-left-width: 4px !important;
    font-size: 13.5px !important;
    font-weight: 600 !important;
}}

/* ── Dialog ──────────────────────────────────────────────────────────────── */
[data-testid="stDialog"] [data-baseweb="dialog"] {{
    border-radius: 20px !important;
    box-shadow: 0 24px 64px rgba(11,29,58,.18) !important;
    border: 1px solid #D7E2EE !important;
}}
[data-testid="stDialog"] h2 {{
    font-weight: 800 !important;
    letter-spacing: -.025em !important;
    color: {NAVY} !important;
}}

/* ── Tabs ────────────────────────────────────────────────────────────────── */
[data-baseweb="tab-list"] {{
    position: fixed !important;
    top: 96px !important;
    left: 220px !important;
    right: 0 !important;
    z-index: 999 !important;
    background: #ffffff !important;
    border-bottom: 2px solid #D7E2EE !important;
    padding: 0 1rem !important;
}}
[data-baseweb="tab"] {{
    font-weight: 700 !important;
    font-size: 13.5px !important;
    color: #6B7280 !important;
    letter-spacing: -.01em !important;
}}
[data-baseweb="tab"][aria-selected="true"] {{
    color: {BLUE} !important;
    font-weight: 800 !important;
}}
[data-baseweb="tab-highlight"] {{
    background-color: {BLUE} !important;
    height: 3px !important;
    border-radius: 3px 3px 0 0 !important;
}}
[data-baseweb="tab-panel"],
[data-baseweb="tab-panel"][role="tabpanel"],
[role="tabpanel"], div[role="tabpanel"],
[data-testid="stTab"], [data-testid="stTabPanel"] {{
    border-top: none !important;
    border: none !important;
    box-shadow: none !important;
    outline: none !important;
    padding-top: 0 !important;
    margin-top: 0 !important;
}}
[data-baseweb="tab-panel"] > div, [role="tabpanel"] > div {{
    border-top: none !important;
    padding-top: 0 !important;
    margin-top: 0 !important;
}}
[data-baseweb="tab-panel"] > div > div, [role="tabpanel"] > div > div {{
    border-top: none !important;
    margin-top: 0 !important;
}}
[data-baseweb="tab-panel"] hr, [role="tabpanel"] hr {{ display: none !important; }}
[data-baseweb="tab-border"] {{ display: none !important; }}

/* ── Sidebar ─────────────────────────────────────────────────────────────── */
section[data-testid="stSidebar"] {{
    min-width: 220px !important;
    max-width: 220px !important;
    width: 220px !important;
    background-color: {NAVY} !important;
}}
/* 사이드바 콘텐츠 컨테이너의 좌우 기본 여백 제거 → 메뉴를 좌끝단까지 */
section[data-testid="stSidebar"] > div,
section[data-testid="stSidebar"] [data-testid="stSidebarContent"] {{
    padding-left: 0 !important;
    padding-right: 0 !important;
}}
section[data-testid="stSidebar"] nav {{
    margin-top: 72px !important;
    padding-left: 0 !important;
    margin-left: 0 !important;
}}
/* ── Sidebar brand logo (top, sits in the 72px gap above the nav) ─────────── */
[data-testid="stSidebarNav"] {{
    position: relative !important;
    /* 메뉴 항목을 아래로 내림. 로고(::before)는 absolute라 영향 없이 제자리 유지 */
    padding-top: 84px !important;
}}
[data-testid="stSidebarNav"]::before {{
    content: "" !important;
    position: absolute !important;
    top: -24px !important;
    left: 14px !important;
    width: 124px !important;
    height: 52px !important;
    background-image: url("{_SIDEBAR_LOGO_URI}") !important;
    background-repeat: no-repeat !important;
    background-position: left center !important;
    background-size: contain !important;
    pointer-events: none !important;
}}
[data-testid="stSidebar"] .stMarkdown, [data-testid="stSidebar"] label,
[data-testid="stSidebar"] .stSelectbox label, [data-testid="stSidebar"] p {{
    color: #E8EDF5 !important;
}}
[data-testid="stSidebar"] h1, [data-testid="stSidebar"] h2,
[data-testid="stSidebar"] h3 {{ color: white !important; }}

/* ── Nav section labels — correct testid is stNavSectionHeader ───────────── */
[data-testid="stNavSectionHeader"] {{
    font-size: 9px !important;
    font-weight: 700 !important;
    text-transform: uppercase !important;
    letter-spacing: 0.14em !important;
    color: rgba(150,158,170,0.34) !important;
    padding: 14px 6px 5px 3px !important;
    margin: 0 !important;
    border-top: 1px solid rgba(255,255,255,0.08) !important;
}}
[data-testid="stNavSectionHeader"] [data-testid="stIconMaterial"] {{
    font-size: 14px !important;
    color: rgba(180,200,230,0.35) !important;
}}
/* " " 더미 섹션 헤더 (Dashboard 위) 완전 숨김 */
[data-testid="stSidebarNavItems"] > *:first-child [data-testid="stNavSectionHeader"] {{
    display: none !important;
}}

/* ── Nav page links ──────────────────────────────────────────────────────── */
/* 네비게이션 컨테이너의 좌측 기본 여백 제거 (리스트 padding 포함) — 최대 내어쓰기 */
[data-testid="stSidebarNav"],
[data-testid="stSidebarNavItems"],
[data-testid="stSidebar"] nav ul,
[data-testid="stSidebar"] nav li {{
    padding-left: 0 !important;
    margin-left: 0 !important;
    list-style: none !important;
}}
[data-testid="stSidebarNavLink"],
[data-testid="stSidebar"] nav a {{
    color: #C4CFDE !important;
    font-weight: 600 !important;
    font-size: 11.5px !important;
    letter-spacing: -.02em !important;
    line-height: 1.2 !important;
    display: flex !important;
    align-items: center !important;
    border-radius: 0 8px 8px 0 !important;
    padding: 7px 2px 7px 10px !important;
    margin-left: 0 !important;
    border-left: 3px solid transparent !important;
    transition: background .15s, border-color .15s !important;
}}
/* 줄바꿈 없이 한 줄 유지 + 말줄임(...) 제거 */
[data-testid="stSidebarNavLink"] *,
[data-testid="stSidebar"] nav a * {{
    color: #C4CFDE !important;
    opacity: 1 !important;
    white-space: nowrap !important;
    overflow: visible !important;
    text-overflow: clip !important;
}}
[data-testid="stSidebarNavLink"]:hover,
[data-testid="stSidebar"] nav a:hover {{
    background: rgba(255,255,255,.07) !important;
    border-left-color: rgba(0,85,168,.4) !important;
}}
[data-testid="stSidebarNavLink"][aria-current="page"],
[data-testid="stSidebar"] nav a[aria-current="page"] {{
    background: rgba(0,85,168,.30) !important;
    border-left: 3px solid {BLUE} !important;
    color: #FFFFFF !important;
}}
[data-testid="stSidebarNavLink"][aria-current="page"] *,
[data-testid="stSidebar"] nav a[aria-current="page"] * {{
    color: #FFFFFF !important;
    font-weight: 700 !important;
}}
[data-testid="stSidebarNavLink"]::before,
[data-testid="stSidebar"] nav a::before {{
    display: none !important;
}}
[data-testid="stSidebarNavLink"][aria-current="page"]::before,
[data-testid="stSidebarNavLink"]:hover::before,
[data-testid="stSidebar"] nav a[aria-current="page"]::before,
[data-testid="stSidebar"] nav a:hover::before {{
    opacity: 1 !important;
}}
{_NAV_ICON_CSS}

/* ── Sidebar bottom user/logout area ─────────────────────────────────────── */
[data-testid="stSidebarUserContent"] {{
    position: fixed !important;
    bottom: 0 !important;
    left: 0 !important;
    width: 220px !important;
    background-color: {NAVY} !important;
    padding: 10px 16px 16px !important;
    border-top: 1px solid rgba(255,255,255,.1) !important;
    z-index: 100 !important;
}}
[data-testid="stSidebarUserContent"] button,
[data-testid="stSidebarUserContent"] [data-testid^="baseButton"] {{
    background: transparent !important;
    background-color: transparent !important;
    border: 1px solid rgba(255,255,255,.2) !important;
    color: #C4CFDE !important;
    box-shadow: none !important;
    height: 28px !important;
    min-height: 0 !important;
    padding: 0 4px !important;
    border-radius: 5px !important;
}}
[data-testid="stSidebarUserContent"] button:hover,
[data-testid="stSidebarUserContent"] [data-testid^="baseButton"]:hover {{
    background: rgba(255,255,255,.1) !important;
    color: #FFFFFF !important;
    border-color: rgba(255,255,255,.35) !important;
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

/* ── Logout button SVG icon ──────────────────────────────────────────────── */
[data-testid="stSidebarUserContent"] button {{
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
}}
[data-testid="stSidebarUserContent"] button::before {{
    content: '' !important;
    display: block !important;
    width: 15px !important;
    height: 15px !important;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'/%3E%3Cpolyline points='16 17 21 12 16 7'/%3E%3Cline x1='21' y1='12' x2='9' y2='12'/%3E%3C/svg%3E") !important;
    background-size: contain !important;
    background-repeat: no-repeat !important;
    background-position: center !important;
    opacity: 0.65 !important;
    transition: opacity .15s !important;
    flex-shrink: 0 !important;
}}
[data-testid="stSidebarUserContent"] button:hover::before {{
    opacity: 1 !important;
}}

/* ── Section header bar ──────────────────────────────────────────────────── */
.ktms-section {{
    background: {NAVY};
    color: white;
    padding: 7px 18px;
    font-weight: 800;
    font-size: 13.5px;
    letter-spacing: .04em;
    text-transform: uppercase;
    position: fixed !important;
    top: 60px !important;
    left: 210px !important;
    right: 0 !important;
    z-index: 1000 !important;
    margin: 0 !important;
    border-radius: 0 !important;
    border-bottom: 2px solid {BLUE};
}}

/* ── When sidebar is collapsed ───────────────────────────────────────────── */
[data-testid="stSidebar"][aria-expanded="false"] ~ section .ktms-section,
[data-testid="stSidebar"][aria-expanded="false"] ~ section [data-baseweb="tab-list"] {{
    left: 0 !important;
}}

/* ── KPI cards ───────────────────────────────────────────────────────────── */
.ktms-kpi {{
    background: #ffffff;
    border: 1px solid #D7E2EE;
    border-left: 4px solid {BLUE};
    border-radius: 14px;
    padding: 18px 22px;
    margin-bottom: 8px;
    box-shadow: 0 4px 20px rgba(11,29,58,.07);
    transition: box-shadow .2s, transform .2s;
}}
.ktms-kpi:hover {{
    box-shadow: 0 10px 36px rgba(11,29,58,.14);
    transform: translateY(-2px);
}}
.ktms-kpi-value {{
    font-size: 2rem;
    font-weight: 800;
    color: {NAVY};
    letter-spacing: -.03em;
}}
.ktms-kpi-label {{
    font-size: 11px;
    font-weight: 700;
    color: #6B7280;
    text-transform: uppercase;
    letter-spacing: .08em;
    margin-top: 4px;
}}

/* ── Compact KPI cards (uniform size, half height) ───────────────────────── */
.ktms-kpi-c {{
    background: #ffffff;
    border: 1px solid #D7E2EE;
    border-left: 4px solid {BLUE};
    border-radius: 12px;
    padding: 11px 15px;
    margin-bottom: 10px;
    box-shadow: 0 2px 10px rgba(11,29,58,.05);
    min-height: 96px;
    display: flex;
    flex-direction: column;
    transition: box-shadow .18s, transform .18s;
}}
.ktms-kpi-c:hover {{
    box-shadow: 0 8px 24px rgba(11,29,58,.12);
    transform: translateY(-1px);
}}
.ktms-kpi-c .kc-lbl {{
    font-size: 12px;
    font-weight: 700;
    color: #5b6b7f;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}}
.ktms-kpi-c .kc-val {{
    font-size: 1.5rem;
    font-weight: 800;
    color: {NAVY};
    letter-spacing: -.025em;
    line-height: 1.1;
    margin-top: 2px;
}}
.ktms-kpi-c .kc-sub {{
    font-size: 11px;
    color: #9aa6b5;
    margin-top: 3px;
}}
.ktms-kpi-c .kc-foot {{
    margin-top: auto;
    padding-top: 6px;
}}
.ktms-kpi-c .kc-chip {{
    display: inline-block;
    font-size: 10.5px;
    font-weight: 700;
    padding: 1px 8px;
    border-radius: 999px;
    letter-spacing: .01em;
}}
.kc-chip.gray  {{ background:#eef1f5; color:#7a8699; }}
.kc-chip.blue  {{ background:rgba(0,85,168,.10);  color:#0055A8; }}
.kc-chip.amber {{ background:rgba(232,131,12,.14); color:#b5680a; }}
.kc-chip.red   {{ background:rgba(220,53,69,.12);  color:#c0392b; }}

/* ── Detail info cards (smaller value, full text visible) ────────────────── */
.ktms-info-card {{
    background: #ffffff;
    border: 1px solid #D7E2EE;
    border-left: 4px solid {BLUE};
    border-radius: 14px;
    padding: 14px 18px;
    margin-bottom: 8px;
}}
.ktms-info-label {{
    font-size: 11px;
    font-weight: 700;
    color: #6B7280;
    text-transform: uppercase;
    letter-spacing: .08em;
    margin-bottom: 4px;
}}
.ktms-info-value {{
    font-size: 1.05rem;
    font-weight: 800;
    color: {NAVY};
    letter-spacing: -.01em;
    word-break: break-word;
    line-height: 1.3;
}}

/* ── Follow-up level badges ──────────────────────────────────────────────── */
.badge-A {{
    background: rgba(220,53,69,.12);
    color: #c0392b;
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: .04em;
    border: 1px solid rgba(220,53,69,.25);
}}
.badge-B {{
    background: rgba(253,126,20,.12);
    color: #d0681a;
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: .04em;
    border: 1px solid rgba(253,126,20,.25);
}}
.badge-C {{
    background: rgba(108,117,125,.1);
    color: #495057;
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: .04em;
    border: 1px solid rgba(108,117,125,.2);
}}

/* ── Customer tracking stepper (mirrors k-maris.com/track) ───────────────── */
.ktms-track-card {{
    border: 1px solid #E3E9F0;
    border-radius: 8px;
    padding: 10px 14px 12px;
    margin-bottom: 8px;
}}
.ktms-track-card-head {{
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: nowrap;
    gap: 6px;
}}
.ktms-track-card-title {{
    font-weight: 800;
    color: #0B1D3A;
    font-size: 13.5px;
    white-space: nowrap;
}}
.ktms-track-card-badge {{
    flex-shrink: 0;
}}
.ktms-track-card-sub {{
    display: block;
    color: #6B7280;
    font-size: 12px;
    margin: 2px 0 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}}
.ktms-track-card-meta {{
    font-size: 11px;
    color: #9aa6b5;
    margin: 2px 0 8px;
}}
.ktms-stepper {{
    display: flex;
    align-items: flex-start;
}}
.ktms-step-wrap {{
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 72px;
}}
.ktms-step-dot {{
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
    border: 2px solid #D7E2EE;
    flex-shrink: 0;
    box-sizing: border-box;
}}
.ktms-step-dot.done {{
    background: #0055A8;
    border-color: #0055A8;
}}
.ktms-step-dot.current {{
    background: #fff;
    border-color: #0055A8;
    border-width: 3px;
    box-shadow: 0 0 0 4px rgba(0,85,168,.14);
}}
.ktms-step-line {{
    flex: 1;
    height: 2px;
    background: #D7E2EE;
    margin-top: 6px;
    min-width: 16px;
}}
.ktms-step-line.done {{
    background: #0055A8;
}}
.ktms-step-label {{
    font-size: 9.5px;
    color: #9aa6b5;
    margin-top: 4px;
    text-align: center;
    line-height: 1.25;
    padding: 0 2px;
}}
.ktms-step-label.done {{
    color: #0055A8;
    font-weight: 700;
}}
.ktms-step-label.current {{
    color: #0055A8;
    font-weight: 800;
}}
</style>
"""

TRACKING_BASE_URL = "https://www.k-maris.com/track.html"

# ── Feather-style SVG icons (stroke, white, 15×15) — matches k-maris.com ─────
_SI = "xmlns='http://www.w3.org/2000/svg' width='15' height='15' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'"
_SECTION_ICONS: Dict[str, str] = {
    "dashboard":  f"<svg {_SI}><rect x='3' y='3' width='7' height='7' rx='1'/><rect x='14' y='3' width='7' height='7' rx='1'/><rect x='14' y='14' width='7' height='7' rx='1'/><rect x='3' y='14' width='7' height='7' rx='1'/></svg>",
    "rfq":        f"<svg {_SI}><path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'/><polyline points='14 2 14 8 20 8'/><line x1='16' y1='13' x2='8' y2='13'/><line x1='16' y1='17' x2='8' y2='17'/></svg>",
    "quotation":  f"<svg {_SI}><path d='M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2'/><rect x='9' y='3' width='6' height='4' rx='2'/><line x1='9' y1='12' x2='15' y2='12'/><line x1='9' y1='16' x2='13' y2='16'/></svg>",
    "order":      f"<svg {_SI}><path d='M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z'/><polyline points='3.27 6.96 12 12.01 20.73 6.96'/><line x1='12' y1='22.08' x2='12' y2='12'/></svg>",
    "documents":  f"<svg {_SI}><path d='M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'/></svg>",
    "ar":         f"<svg {_SI}><rect x='1' y='4' width='22' height='16' rx='2' ry='2'/><line x1='1' y1='10' x2='23' y2='10'/></svg>",
    "settings":   f"<svg {_SI}><line x1='4' y1='21' x2='4' y2='14'/><line x1='4' y1='10' x2='4' y2='3'/><line x1='12' y1='21' x2='12' y2='12'/><line x1='12' y1='8' x2='12' y2='3'/><line x1='20' y1='21' x2='20' y2='16'/><line x1='20' y1='12' x2='20' y2='3'/><line x1='1' y1='14' x2='7' y2='14'/><line x1='9' y1='8' x2='15' y2='8'/><line x1='17' y1='16' x2='23' y2='16'/></svg>",
    "send":       f"<svg {_SI}><line x1='22' y1='2' x2='11' y2='13'/><polygon points='22 2 15 22 11 13 2 9 22 2'/></svg>",
    "po":         f"<svg {_SI}><path d='M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z'/></svg>",
    "alert":      f"<svg {_SI}><polygon points='13 2 3 14 12 14 11 22 21 10 12 10 13 2'/></svg>",
    "clock":      f"<svg {_SI}><circle cx='12' cy='12' r='10'/><polyline points='12 6 12 12 16 14'/></svg>",
    "link":       f"<svg {_SI}><path d='M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'/><path d='M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'/></svg>",
}


def inject_css():
    st.markdown(KTMS_CSS, unsafe_allow_html=True)


def section_header(icon: str, title: str) -> None:
    """Render a fixed section header bar with a Feather-style SVG icon."""
    svg = _SECTION_ICONS.get(icon, "")
    st.markdown(
        f'<div class="ktms-section">'
        f'<span style="display:inline-flex;align-items:center;gap:8px;vertical-align:middle;">'
        f'{svg}{title}</span></div>',
        unsafe_allow_html=True,
    )


def hint(text: str) -> None:
    st.markdown(
        f'<p style="color:#6B7280;font-size:0.82rem;margin:2px 0 10px 0;'
        f'padding-left:10px;border-left:2px solid #D7E2EE;">ℹ {text}</p>',
        unsafe_allow_html=True,
    )


def tracking_url(kind: str, token: str) -> str:
    return f"{TRACKING_BASE_URL}?type={kind}&token={token}"


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


def next_po_no(company_prefix: str = "KMS") -> str:
    """Vendor Purchase Order 번호: KMS-PO-yymm-NNN (월 단위 시퀀스 리셋)."""
    session = get_session()
    try:
        today = date.today()
        period = today.year * 100 + today.month
        seq = session.query(DocSequence).filter_by(doc_type="po_internal", year=period).first()
        if not seq:
            seq = DocSequence(doc_type="po_internal", year=period, last_seq=0)
            session.add(seq)
        seq.last_seq += 1
        session.commit()
        return f"{company_prefix}-PO-{today:%y%m}-{seq.last_seq:03d}"
    finally:
        session.close()


def next_rfq_no(company_prefix: str = "KMS") -> str:
    """K-Maris 내부 관리용 Customer RFQ 번호: KMS-RFQ-yymm-NNN.

    시퀀스는 (연+월) 단위로 리셋된다. DocSequence는 doc_type='rfq_internal',
    year=YYYYMM(예: 202606)으로 저장해 기존 'rfq' 시퀀스와 충돌하지 않는다.
    """
    session = get_session()
    try:
        today = date.today()
        period = today.year * 100 + today.month   # 예: 202606
        seq = session.query(DocSequence).filter_by(doc_type="rfq_internal", year=period).first()
        if not seq:
            seq = DocSequence(doc_type="rfq_internal", year=period, last_seq=0)
            session.add(seq)
        seq.last_seq += 1
        session.commit()
        return f"{company_prefix}-RFQ-{today:%y%m}-{seq.last_seq:03d}"
    finally:
        session.close()


def next_quotation_no(company_prefix: str = "KMS") -> str:
    """K-Maris 내부 관리용 Customer 견적 번호: KMS-QUO-yymm-NNN (월 단위 시퀀스 리셋)."""
    session = get_session()
    try:
        today = date.today()
        period = today.year * 100 + today.month   # 예: 202606
        seq = session.query(DocSequence).filter_by(doc_type="quotation_internal", year=period).first()
        if not seq:
            seq = DocSequence(doc_type="quotation_internal", year=period, last_seq=0)
            session.add(seq)
        seq.last_seq += 1
        session.commit()
        return f"{company_prefix}-QUO-{today:%y%m}-{seq.last_seq:03d}"
    finally:
        session.close()


# ── Master data loaders ───────────────────────────────────────────────────────

@st.cache_data(ttl=15, show_spinner=False)
def _cached_customer_options() -> Dict[str, int]:
    s = get_session()
    try:
        return {c.name: c.id for c in s.query(Customer).order_by(Customer.name).all()}
    finally:
        s.close()


@st.cache_data(ttl=15, show_spinner=False)
def _cached_vendor_options() -> Dict[str, int]:
    s = get_session()
    try:
        return {v.name: v.id for v in s.query(Vendor).order_by(Vendor.name).all()}
    finally:
        s.close()


@st.cache_data(ttl=15, show_spinner=False)
def _cached_vessel_options(customer_id: int | None = None) -> Dict[str, int]:
    s = get_session()
    try:
        vessels = s.query(Vessel).order_by(Vessel.name).all()
        if customer_id:
            vessels = sorted(
                vessels,
                key=lambda v: (
                    0 if v.customer_id == customer_id else 1 if v.customer_id is None else 2,
                    (v.name or "").lower(),
                ),
            )
        return {v.name: v.id for v in vessels}
    finally:
        s.close()


@st.cache_data(ttl=15, show_spinner=False)
def _cached_customer_name_map() -> Dict[int, str]:
    """{customer_id: name} — 목록 루프에서 행마다 get_customer() 하는 N+1을 제거한다."""
    s = get_session()
    try:
        return {c.id: c.name for c in s.query(Customer).all()}
    finally:
        s.close()


@st.cache_data(ttl=15, show_spinner=False)
def _cached_vessel_name_map() -> Dict[int, str]:
    """{vessel_id: name} — 목록 루프 N+1 제거용."""
    s = get_session()
    try:
        return {v.id: v.name for v in s.query(Vessel).all()}
    finally:
        s.close()


def customer_name(cid: int | None) -> str:
    """캐시된 맵에서 고객명을 조회 (목록 루프용, DB 세션 미발생)."""
    if not cid:
        return "—"
    return _cached_customer_name_map().get(cid, "—")


def vessel_name(vid: int | None) -> str:
    """캐시된 맵에서 선박명을 조회 (목록 루프용, DB 세션 미발생)."""
    if not vid:
        return "—"
    return _cached_vessel_name_map().get(vid, "—")


def clear_cached_reference_data() -> None:
    _cached_customer_options.clear()
    _cached_vendor_options.clear()
    _cached_vessel_options.clear()
    _cached_customer_name_map.clear()
    _cached_vessel_name_map.clear()
    clear_pipeline_cache()


def clear_pipeline_cache() -> None:
    """RFQ 진행단계 캐시 무효화 — 상태/주문/견적 등 변경 직후 호출해 즉시 반영."""
    internal_pipeline_stage.clear()


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
    return _cached_customer_options()


def vendor_options() -> Dict[str, int]:
    return _cached_vendor_options()


def vessel_options(customer_id: int = None) -> Dict[str, int]:
    return _cached_vessel_options(customer_id)


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


# ── VendorRFQ / VendorQuote helpers ──────────────────────────────────────────

def vrfq_list_for_rfq(rfq_id: int) -> List[VendorRFQ]:
    s = get_session()
    try:
        return s.query(VendorRFQ).filter_by(rfq_id=rfq_id).order_by(VendorRFQ.created_at.desc()).all()
    finally:
        s.close()


def get_vrfq(vrfq_id: int) -> Optional[VendorRFQ]:
    s = get_session()
    try:
        return s.query(VendorRFQ).get(vrfq_id)
    finally:
        s.close()


def vendor_quote_list() -> List[VendorQuote]:
    s = get_session()
    try:
        return s.query(VendorQuote).order_by(VendorQuote.created_at.desc()).all()
    finally:
        s.close()


def vendor_quotes_for_vrfq(vrfq_id: int) -> List[VendorQuote]:
    s = get_session()
    try:
        return s.query(VendorQuote).filter_by(vendor_rfq_id=vrfq_id).order_by(VendorQuote.created_at.desc()).all()
    finally:
        s.close()


def get_vendor_quote(vq_id: int) -> Optional[VendorQuote]:
    s = get_session()
    try:
        return s.query(VendorQuote).get(vq_id)
    finally:
        s.close()


def rfq_id_for_order(order: Order) -> Optional[int]:
    """Order에 연결된 RFQ id를 반환. ① Order.rfq_id 우선, 없으면 ② Quotation.rfq_id 경유."""
    if order is None:
        return None
    if getattr(order, "rfq_id", None):
        return order.rfq_id
    if order.quotation_id:
        q = get_quotation(order.quotation_id)
        if q and q.rfq_id:
            return q.rfq_id
    return None


def vendor_quotes_for_rfq_vendor(rfq_id: int, vendor_id: int) -> List[VendorQuote]:
    """RFQ + Vendor로 수신된 Vendor Quote 목록 (최신순). 발주서 단가 참조 선택용."""
    if not rfq_id or not vendor_id:
        return []
    s = get_session()
    try:
        vrfq_ids = [
            v.id for v in s.query(VendorRFQ)
            .filter_by(rfq_id=rfq_id, vendor_id=vendor_id).all()
        ]
        if not vrfq_ids:
            return []
        return (
            s.query(VendorQuote)
            .filter(VendorQuote.vendor_rfq_id.in_(vrfq_ids))
            .order_by(VendorQuote.created_at.desc())
            .all()
        )
    finally:
        s.close()


def price_map_from_quote(vq: Optional[VendorQuote]) -> Dict[str, float]:
    """특정 Vendor Quote의 {part_no: cost_price} 매핑."""
    pmap: Dict[str, float] = {}
    if not vq:
        return pmap
    for it in (vq.items or []):
        pn = str(it.get("part_no", "")).strip()
        if not pn:
            continue
        cp = it.get("cost_price")
        try:
            pmap[pn] = float(cp) if cp not in ("", None) else 0.0
        except (ValueError, TypeError):
            pmap[pn] = 0.0
    return pmap


def vendor_quote_price_map(rfq_id: int, vendor_id: int) -> Dict[str, float]:
    """RFQ + Vendor 기준 '최신' Vendor Quote의 단가 매핑 (편의 함수)."""
    qs = vendor_quotes_for_rfq_vendor(rfq_id, vendor_id)
    return price_map_from_quote(qs[0]) if qs else {}


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


def orphan_order_list(limit: int = 10) -> List[Order]:
    """RFQ와 연결되지 않은 Order 목록.

    연결 기준: ① Order.rfq_id 직접 연결, 또는 ② Quotation.rfq_id 경유 연결.
    둘 다 없는 Order만 orphan으로 본다.
    """
    s = get_session()
    try:
        return (
            s.query(Order)
            .outerjoin(Quotation, Order.quotation_id == Quotation.id)
            .filter(
                Order.rfq_id.is_(None)
                & ((Order.quotation_id.is_(None)) | (Quotation.rfq_id.is_(None)))
            )
            .order_by(Order.created_at.desc())
            .limit(limit)
            .all()
        )
    finally:
        s.close()


def get_order_for_rfq(rfq_id: int) -> Optional[Order]:
    """RFQ에 연결된 Order 조회 (가장 최근 1건).

    ① Order.rfq_id 직접 연결을 우선, 없으면 ② RFQ → Quotation → Order 경로로 조회.
    """
    s = get_session()
    try:
        direct = (
            s.query(Order)
            .filter(Order.rfq_id == rfq_id)
            .order_by(Order.created_at.desc())
            .first()
        )
        if direct:
            return direct
        return (
            s.query(Order)
            .join(Quotation, Order.quotation_id == Quotation.id)
            .filter(Quotation.rfq_id == rfq_id)
            .order_by(Order.created_at.desc())
            .first()
        )
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

def _safe_status_value(obj) -> str:
    return obj.value if hasattr(obj, "value") else str(obj or "")


def _item_count(items) -> int:
    return len(items or [])


@st.cache_data(ttl=15, show_spinner=False)
@st.cache_data(ttl=15, show_spinner=False)
def dashboard_snapshot(limit: int = 20) -> Dict[str, Any]:
    from services.tracking_status import rfq_tracking_step, order_tracking_step

    s = get_session()
    try:
        rfqs = s.query(RFQ).order_by(RFQ.created_at.desc()).limit(limit).all()
        rfq_ids = [r.id for r in rfqs]
        customer_ids = {r.customer_id for r in rfqs if r.customer_id}
        vessel_ids = {r.vessel_id for r in rfqs if r.vessel_id}

        quotations = s.query(Quotation).filter(Quotation.rfq_id.in_(rfq_ids)).all() if rfq_ids else []
        qtn_by_id = {q.id: q for q in quotations}
        qtn_ids = list(qtn_by_id)

        orders = []
        if rfq_ids:
            orders.extend(s.query(Order).filter(Order.rfq_id.in_(rfq_ids)).order_by(Order.created_at.desc()).all())
        if qtn_ids:
            orders.extend(s.query(Order).filter(Order.quotation_id.in_(qtn_ids)).order_by(Order.created_at.desc()).all())

        order_by_rfq: Dict[int, Order] = {}
        for order in orders:
            rid = order.rfq_id or (qtn_by_id.get(order.quotation_id).rfq_id if order.quotation_id in qtn_by_id else None)
            if rid and rid not in order_by_rfq:
                order_by_rfq[rid] = order
            if order.customer_id:
                customer_ids.add(order.customer_id)
            if order.vessel_id:
                vessel_ids.add(order.vessel_id)

        customers = {c.id: c.name for c in s.query(Customer).filter(Customer.id.in_(customer_ids)).all()} if customer_ids else {}
        vessels = {v.id: v.name for v in s.query(Vessel).filter(Vessel.id.in_(vessel_ids)).all()} if vessel_ids else {}

        vrfqs = s.query(VendorRFQ).filter(VendorRFQ.rfq_id.in_(rfq_ids)).all() if rfq_ids else []
        vrfq_by_rfq: Dict[int, list[int]] = {}
        for vrfq in vrfqs:
            vrfq_by_rfq.setdefault(vrfq.rfq_id, []).append(vrfq.id)
        vrfq_ids = [v.id for v in vrfqs]
        quoted_vrfq_ids = {row[0] for row in s.query(VendorQuote.vendor_rfq_id).filter(VendorQuote.vendor_rfq_id.in_(vrfq_ids)).all()} if vrfq_ids else set()
        sent_quote_rfqs = {q.rfq_id for q in quotations if q.rfq_id and q.status != QuotationStatus.DRAFT}

        order_ids = [o.id for o in order_by_rfq.values()]
        po_order_ids = {row[0] for row in s.query(PurchaseOrder.order_id).filter(PurchaseOrder.order_id.in_(order_ids)).all()} if order_ids else set()
        sa_order_ids = {row[0] for row in s.query(ShippingAdvice.order_id).filter(ShippingAdvice.order_id.in_(order_ids)).all()} if order_ids else set()
        cis = s.query(CommercialInvoice).filter(CommercialInvoice.order_id.in_(order_ids)).all() if order_ids else []
        ci_by_order = {ci.order_id: ci for ci in cis}
        ci_ids = [ci.id for ci in cis]
        tax_ci_ids = {row[0] for row in s.query(TaxInvoiceData.ci_id).filter(TaxInvoiceData.ci_id.in_(ci_ids)).all()} if ci_ids else set()
        ar_by_order: Dict[int, list[ARRecord]] = {}
        if order_ids:
            for ar in s.query(ARRecord).filter(ARRecord.order_id.in_(order_ids)).all():
                ar_by_order.setdefault(ar.order_id, []).append(ar)

        def customer_vessel(customer_id, vessel_id) -> str:
            name = customers.get(customer_id, "—")
            vessel = vessels.get(vessel_id)
            return f"{name} · {vessel}" if vessel else name

        def pipeline_stage(rfq_id: int) -> int:
            stage = 1
            ids = vrfq_by_rfq.get(rfq_id, [])
            if ids:
                stage = max(stage, 2)
                if any(i in quoted_vrfq_ids for i in ids):
                    stage = max(stage, 3)
            if rfq_id in sent_quote_rfqs:
                stage = max(stage, 4)
            order = order_by_rfq.get(rfq_id)
            if not order:
                return stage
            stage = max(stage, 5)
            if order.id in po_order_ids:
                stage = max(stage, 6)
            stage = max(stage, {
                OrderStatus.RECEIVED: 5,
                OrderStatus.PO_SENT: 6,
                OrderStatus.PREPARING: 7,
                OrderStatus.SHIPPED: 9,
                OrderStatus.IN_TRANSIT: 10,
                OrderStatus.DELIVERED: 11,
            }.get(order.status, 5))
            if getattr(order, "consignee_confirmed_date", None):
                stage = max(stage, 8)
            if order.id in sa_order_ids:
                stage = max(stage, 9)
            if getattr(order, "vendor_docs_sent_date", None):
                stage = max(stage, 10)
            ci = ci_by_order.get(order.id)
            if ci:
                stage = max(stage, 10)
                if ci.id in tax_ci_ids:
                    stage = max(stage, 13)
            ars = ar_by_order.get(order.id, [])
            if ars:
                stage = max(stage, 12)
                if any(ar.status == ARStatus.PAID for ar in ars):
                    stage = max(stage, 14)
            return stage

        rfq_rows = []
        for r in rfqs:
            rfq_step, _ = rfq_tracking_step(_safe_status_value(r.status))
            order = order_by_rfq.get(r.id)
            order_row = None
            if order:
                order_step, _ = order_tracking_step(_safe_status_value(order.status))
                order_row = {
                    "ord_no": order.ord_no,
                    "status": _safe_status_value(order.status),
                    "customer_vessel": customer_vessel(order.customer_id, order.vessel_id),
                    "item_count": _item_count(order.items),
                    "date": order.date or "—",
                    "step": order_step,
                }
            rfq_rows.append({
                "rfq_no": r.rfq_no,
                "customer_rfq_no": r.customer_rfq_no or "",
                "status": _safe_status_value(r.status),
                "customer_vessel": customer_vessel(r.customer_id, r.vessel_id),
                "item_count": _item_count(r.items),
                "follow_up_level": _safe_status_value(r.follow_up_level) or "—",
                "date": r.date or "—",
                "step": rfq_step,
                "order": order_row,
                "stage": pipeline_stage(r.id),
            })

        orphan_rows = []
        orphans = (
            s.query(Order)
            .outerjoin(Quotation, Order.quotation_id == Quotation.id)
            .filter(Order.rfq_id.is_(None) & ((Order.quotation_id.is_(None)) | (Quotation.rfq_id.is_(None))))
            .order_by(Order.created_at.desc())
            .limit(10)
            .all()
        )
        for order in orphans:
            order_step, _ = order_tracking_step(_safe_status_value(order.status))
            orphan_rows.append({
                "ord_no": order.ord_no,
                "status": _safe_status_value(order.status),
                "customer_vessel": customer_vessel(order.customer_id, order.vessel_id),
                "item_count": _item_count(order.items),
                "date": order.date or "—",
                "step": order_step,
            })

        return {"rfqs": rfq_rows, "orphans": orphan_rows}
    finally:
        s.close()


@st.cache_data(ttl=15, show_spinner=False)
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

        # ── 성과 KPI (첨부 KPI 시트 기준, 계산 가능한 4종) ──────────────────────
        all_rfqs = s.query(RFQ).all()
        all_quotes = s.query(Quotation).all()
        total_rfq = len(all_rfqs)

        # RFQ Handling Rate — 받은 RFQ 중 실제 견적(초안 제외)이 제출된 비율
        sent_quote_rfq_ids = {
            q.rfq_id for q in all_quotes
            if q.rfq_id and q.status != QuotationStatus.DRAFT
        }
        handling_rate = (len(sent_quote_rfq_ids) / total_rfq * 100) if total_rfq else 0.0

        # Quotation TAT — RFQ 접수 → 견적 제출까지 평균 시간(h)
        rfq_created = {r.id: r.created_at for r in all_rfqs}
        _tat = []
        for q in all_quotes:
            base = rfq_created.get(q.rfq_id) if q.rfq_id else None
            if base and q.created_at and q.status != QuotationStatus.DRAFT:
                h = (q.created_at - base).total_seconds() / 3600
                if h >= 0:
                    _tat.append(h)
        quotation_tat_h = (sum(_tat) / len(_tat)) if _tat else None

        # Hit Rate — 발송된 견적 대비 수주확정(PO 전환) 비율
        _sent_like = {QuotationStatus.SENT, QuotationStatus.NEGOTIATING,
                      QuotationStatus.WON, QuotationStatus.LOST, QuotationStatus.EXPIRED}
        sent_quotes = [q for q in all_quotes if q.status in _sent_like]
        won_quotes = [q for q in all_quotes if q.status == QuotationStatus.WON]
        hit_rate = (len(won_quotes) / len(sent_quotes) * 100) if sent_quotes else 0.0

        # Gross Margin — 수주확정 견적 기준(없으면 발송 견적 전체)
        margin_basis = won_quotes or sent_quotes
        _rev = _cost = 0.0
        for q in margin_basis:
            for it in (q.items or []):
                qty = float(it.get("qty", 1) or 1)
                _rev += float(it.get("unit_price", 0) or 0) * qty
                _cost += float(it.get("cost_price", 0) or 0) * qty
        gross_margin_pct = ((_rev - _cost) / _rev * 100) if _rev else 0.0

        # ── 추천 운영 지표 3종 ─────────────────────────────────────────────────
        today_iso = date.today().isoformat()
        soon_iso = (date.today() + timedelta(days=7)).isoformat()

        # 견적 만료 임박 — 발송/협상중 & 유효기간 7일 이내
        expiring_quotes = sum(
            1 for q in all_quotes
            if q.status in (QuotationStatus.SENT, QuotationStatus.NEGOTIATING)
            and q.valid_until and today_iso <= q.valid_until <= soon_iso
        )

        # 협상중 파이프라인 금액 (USD)
        negotiating_value_usd = 0.0
        for q in all_quotes:
            if q.status == QuotationStatus.NEGOTIATING and (q.currency or "USD") == "USD":
                for it in (q.items or []):
                    amt = it.get("amount")
                    if amt in (None, ""):
                        amt = float(it.get("unit_price", 0) or 0) * float(it.get("qty", 1) or 1)
                    negotiating_value_usd += float(amt or 0)

        # 발주 대기 — 수주됐으나 PO 미발행 Order
        pending_po = s.query(Order).filter(Order.status == OrderStatus.RECEIVED).count()

        return {
            "open_rfq": open_rfq,
            "active_orders": active_orders,
            "ar_outstanding_usd": ar_outstanding_usd,
            "monthly_quotes": monthly_quotes,
            "urgent_quotes": urgent_quotes,
            "overdue_ar": overdue_ar,
            # 성과 KPI
            "handling_rate": handling_rate,
            "quotation_tat_h": quotation_tat_h,
            "hit_rate": hit_rate,
            "gross_margin_pct": gross_margin_pct,
            # 운영 지표
            "expiring_quotes": expiring_quotes,
            "negotiating_value_usd": negotiating_value_usd,
            "pending_po": pending_po,
        }
    finally:
        s.close()


# ── Margin calculation ────────────────────────────────────────────────────────

def apply_margin(items: List[Dict], default_margin_pct: float, discount_pct: float = 0.0) -> List[Dict]:
    """품목별 margin_pct가 있으면 그 값을, 없으면 default_margin_pct를 사용해 unit_price 계산."""
    result = []
    for item in items:
        cost = float(item.get("cost_price", item.get("unit_price", 0)))
        margin_pct = item.get("margin_pct")
        margin_pct = float(margin_pct) if margin_pct not in (None, "") else float(default_margin_pct)
        sell = cost * (1 + margin_pct / 100) * (1 - discount_pct / 100)
        sell = round(sell, 2)
        new_item = dict(item)
        new_item["cost_price"] = cost
        new_item["margin_pct"] = margin_pct
        new_item["unit_price"] = sell
        qty = float(new_item.get("qty", 1))
        new_item["amount"] = round(sell * qty, 2)
        result.append(new_item)
    return result


def total_amount(items: List[Dict]) -> float:
    return sum(float(i.get("amount", 0)) for i in items)


def missing_items(order_items: List[Dict], doc_items: List[Dict]) -> List[Dict]:
    """수주 오더 품목 대비 문서(CI/PL)에서 누락·수량부족 항목을 반환.

    Part No.(없으면 description) 기준으로 매칭하여, 문서 합산 수량이 오더 수량보다
    적은 항목을 [{part_no, description, order_qty, doc_qty}] 형태로 돌려준다.
    """
    def _key(it: Dict) -> str:
        return (str(it.get("part_no", "") or "").strip().upper()
                or str(it.get("description", "") or "").strip().upper())

    def _qty(it: Dict) -> float:
        try:
            return float(it.get("qty", 0) or 0)
        except (TypeError, ValueError):
            return 0.0

    doc_qty: Dict[str, float] = {}
    for it in (doc_items or []):
        k = _key(it)
        if k:
            doc_qty[k] = doc_qty.get(k, 0.0) + _qty(it)

    out: List[Dict] = []
    for it in (order_items or []):
        k = _key(it)
        if not k:
            continue
        oq, dq = _qty(it), doc_qty.get(k, 0.0)
        if dq + 1e-9 < oq:
            out.append({
                "part_no": it.get("part_no", ""),
                "description": it.get("description", ""),
                "order_qty": oq,
                "doc_qty": dq,
            })
    return out


_STATUS_STYLES: dict[str, tuple[str, str]] = {
    # bg, text  — matches k-maris.com tracking badge palette
    "수신완료":           ("rgba(59,166,224,.15)",  "#1a7aad"),
    "공급사 소싱중":       ("rgba(255,189,46,.18)",  "#a07000"),
    "견적 중":            ("rgba(255,189,46,.18)",  "#a07000"),
    "이메일 발송 완료":    ("rgba(72,199,131,.18)",  "#1a7a4a"),
    "수주완료":           ("rgba(72,199,131,.85)",  "#ffffff"),
    "실주":              ("rgba(220,53,69,.15)",   "#b02030"),
    "초안":              ("rgba(108,117,125,.12)", "#495057"),
    "발송완료":           ("rgba(0,85,168,.12)",    "#0055A8"),
    "협상중":             ("rgba(255,189,46,.18)",  "#a07000"),
    "수주확정":           ("rgba(72,199,131,.85)",  "#ffffff"),
    "만료":              ("rgba(108,117,125,.12)", "#6B7280"),
    "오더 수주":          ("rgba(99,179,237,.18)",  "#1a5a8a"),
    "발주 완료":          ("rgba(255,189,46,.18)",  "#a07000"),
    "제조/준비중":        ("rgba(255,189,46,.18)",  "#a07000"),
    "출고완료":           ("rgba(59,166,224,.18)",  "#1a6080"),
    "운송중":             ("rgba(59,166,224,.22)",  "#1a7aad"),
    "목적지 하차 완료":    ("rgba(72,199,131,.85)",  "#ffffff"),
    "미수":              ("rgba(255,189,46,.18)",  "#a07000"),
    "일부수금":           ("rgba(99,179,237,.18)",  "#1a5a8a"),
    "완납":              ("rgba(72,199,131,.85)",  "#ffffff"),
    "연체":              ("rgba(220,53,69,.15)",   "#b02030"),
}


def status_color(status: str) -> str:
    bg, _ = _STATUS_STYLES.get(status, ("rgba(108,117,125,.12)", "#495057"))
    return bg


def status_badge(status: str) -> str:
    bg, text = _STATUS_STYLES.get(status, ("rgba(108,117,125,.12)", "#495057"))
    return (
        f'<span style="'
        f'background:{bg};color:{text};'
        f'padding:3px 10px;border-radius:999px;'
        f'font-size:12px;font-weight:800;letter-spacing:.03em;'
        f'">{status}</span>'
    )


def tracking_stepper_html(steps: List[str], current_step: int) -> str:
    """Render a compact dot+bar stepper matching k-maris.com/track's progress bar."""
    parts = []
    for i, name in enumerate(steps):
        if i > 0:
            line_cls = "done" if i <= current_step else ""
            parts.append(f'<div class="ktms-step-line {line_cls}"></div>')
        if i < current_step:
            dot_cls, label_cls = "done", "done"
        elif i == current_step:
            dot_cls, label_cls = "current", "current"
        else:
            dot_cls, label_cls = "", ""
        parts.append(
            f'<div class="ktms-step-wrap">'
            f'<div class="ktms-step-dot {dot_cls}"></div>'
            f'<div class="ktms-step-label {label_cls}">{name}</div>'
            f'</div>'
        )
    return f'<div class="ktms-stepper">{"".join(parts)}</div>'


# ── 내부 진행 현황 (12단계 파이프라인) ──────────────────────────────────────────
# 직원용. 고객용 추적(RFQ_STEPS/ORDER_STEPS)과 별개로, 거래 한 건의 전체 흐름을
# 12단계로 본다. 일부 단계는 전용 데이터가 없어 인접 단계의 증거
# (주문 상태·서류 발행 여부)로 근사 추정한다.
INTERNAL_STEPS: List[str] = [
    "Customer RFQ 수신",
    "Vendor RFQ 발신",
    "Vendor Quot. 수신",
    "Customer Quot. 발신",
    "Customer P/O 수신",
    "Vendor P/O 발신",
    "Delivery Readiness",
    "Delivery arrangement",
    "운송 완료 · POD 수취",
    "Tax Invoice 작성 · 대금 청구",
    "세금계산서 발행",
    "대금 결제 완료",
]


@st.cache_data(ttl=20, show_spinner=False)
def internal_pipeline_stage(rfq_id: int) -> int:
    """RFQ 1건의 내부 진행 단계(1~12)를 관련 레코드 증거로 추정한다.

    NOTE: 행마다 ~12개 쿼리를 새 세션으로 실행하므로 목록(overview/PO/대시보드)에서
    N+1의 핵심 비용이었다. ttl=20s 캐시로 같은 rerun·연속 클릭에서 재계산을 막는다.
    데이터 변경 직후 즉시 반영이 필요하면 clear_pipeline_cache()를 호출한다.

    진행은 단조(monotonic) — 가장 멀리 도달한 단계를 반환한다. 전용 데이터가
    없는 단계는 인접 증거로 근사한다(예: 출고완료·ShippingAdvice→Delivery arrangement).
    """
    s = get_session()
    try:
        stage = 1  # Customer RFQ 수신 (RFQ 레코드 존재)

        vrfqs = s.query(VendorRFQ).filter_by(rfq_id=rfq_id).all()
        if vrfqs:
            stage = max(stage, 2)
            vrfq_ids = [v.id for v in vrfqs]
            if s.query(VendorQuote).filter(VendorQuote.vendor_rfq_id.in_(vrfq_ids)).first():
                stage = max(stage, 3)

        if (s.query(Quotation)
                .filter(Quotation.rfq_id == rfq_id, Quotation.status != QuotationStatus.DRAFT)
                .first()):
            stage = max(stage, 4)

        # Order — ① RFQ 직접 연결 우선, 없으면 ② Quotation 경유
        order = (s.query(Order).filter(Order.rfq_id == rfq_id)
                 .order_by(Order.created_at.desc()).first())
        if not order:
            order = (s.query(Order).join(Quotation, Order.quotation_id == Quotation.id)
                     .filter(Quotation.rfq_id == rfq_id)
                     .order_by(Order.created_at.desc()).first())

        if order:
            stage = max(stage, 5)  # Customer P/O 수신
            if s.query(PurchaseOrder).filter_by(order_id=order.id).first():
                stage = max(stage, 6)  # Vendor P/O 발신

            ost = order.status.value if hasattr(order.status, "value") else str(order.status)
            stage = max(stage, {
                "오더 수주": 5,
                "발주 완료": 6,
                "제조/준비중": 7,    # Delivery Readiness
                "출고완료": 8,       # Delivery arrangement
                "운송중": 8,
                "목적지 하차 완료": 9,  # 운송 완료 · POD 수취
            }.get(ost, 5))

            # 8) Delivery arrangement — 기존 수동 문서 확인 필드를 단계 근거로 재사용
            # getattr 폴백: 배포 직후 모듈 캐시로 신규 컬럼이 아직 매핑 안 됐어도 크래시 방지.
            if getattr(order, "consignee_confirmed_date", None):
                stage = max(stage, 8)
            if s.query(ShippingAdvice).filter_by(order_id=order.id).first():
                stage = max(stage, 8)
            if getattr(order, "vendor_docs_sent_date", None):
                stage = max(stage, 8)
            ci = s.query(CommercialInvoice).filter_by(order_id=order.id).first()
            if ci:
                stage = max(stage, 8)  # 선적서류(CI/PL) 작성
                if s.query(TaxInvoiceData).filter_by(ci_id=ci.id).first():
                    stage = max(stage, 11)  # 세금계산서 발행

            ars = s.query(ARRecord).filter_by(order_id=order.id).all()
            if ars:
                stage = max(stage, 10)  # Tax Invoice 작성 · 대금 청구
                if any((a.status.value if hasattr(a.status, "value") else a.status) == "완납"
                       for a in ars):
                    stage = max(stage, 12)  # 대금 결제 완료
        return stage
    finally:
        s.close()


def pipeline_status_label(rfq_id: int) -> str:
    """RFQ의 현재 '상태'를 12단계 진행 기준으로 표기. 예: '5/12 Customer P/O 수신'."""
    st_ = internal_pipeline_stage(rfq_id)
    return f"{st_}/{len(INTERNAL_STEPS)} {INTERNAL_STEPS[st_ - 1]}"


def internal_progress_bar_html(current_stage: int, total: int | None = None) -> str:
    """진행 막대 (collapsed 요약용)."""
    total = total or len(INTERNAL_STEPS)
    segs = "".join(
        f'<div style="flex:1;height:6px;border-radius:2px;'
        f'background:{BLUE if i <= current_stage else "#D7E2EE"};"></div>'
        for i in range(1, total + 1)
    )
    return f'<div style="display:flex;gap:2px;margin:6px 0 2px;">{segs}</div>'


def internal_stepper_html(current_stage: int) -> str:
    """내부 진행 단계 세로 스텝 리스트 (done ✓ / current ● / pending ○)."""
    rows = []
    for i, name in enumerate(INTERNAL_STEPS, start=1):
        if i < current_stage:
            icon, color, chip_bg, weight = "✓", BLUE, "rgba(0,85,168,.12)", "700"
        elif i == current_stage:
            icon, color, chip_bg, weight = "●", BLUE, "rgba(0,85,168,.18)", "800"
        else:
            icon, color, chip_bg, weight = "○", "#9aa6b5", "#eef1f5", "500"
        rows.append(
            f'<div style="display:flex;align-items:center;gap:9px;padding:3px 0;">'
            f'<span style="display:inline-flex;width:19px;height:19px;border-radius:50%;'
            f'align-items:center;justify-content:center;font-size:11px;font-weight:700;'
            f'background:{chip_bg};color:{color};flex-shrink:0;">{icon}</span>'
            f'<span style="font-size:12.5px;color:{color};font-weight:{weight};">{i}. {name}</span>'
            f'</div>'
        )
    return "<div>" + "".join(rows) + "</div>"
