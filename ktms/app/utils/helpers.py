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
    RFQ, VendorRFQ, VendorQuote, Quotation, Order, CommercialInvoice,
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
#   li:1  → " " header (invisible)   li:2  → Dashboard
#   li:3  → "RFQ 관리" header        li:4  → CRFQ   li:5 → VRFQ
#   li:6  → "영업 관리" header        li:7  → Quotation  li:8 → Orders
#   li:9  → Documents  li:10 → AR    li:11 → "시스템" header  li:12 → Settings
_NAV_ICON_POSITIONS = [
    (2, 0), (4, 1), (5, 2), (7, 3), (8, 4), (9, 5), (10, 6), (12, 7),
]
_NAV_ICON_CSS = "\n".join(
    f"[data-testid=\"stSidebar\"] nav li:nth-child({pos}) a::before {{ background-image: url(\"{_ICONS[idx]}\") !important; }}"
    for pos, idx in _NAV_ICON_POSITIONS
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
    left: 210px !important;
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
section[data-testid="stSidebar"] nav {{
    margin-top: 72px !important;
}}
[data-testid="stSidebar"] .stMarkdown, [data-testid="stSidebar"] label,
[data-testid="stSidebar"] .stSelectbox label, [data-testid="stSidebar"] p {{
    color: #E8EDF5 !important;
}}
[data-testid="stSidebar"] h1, [data-testid="stSidebar"] h2,
[data-testid="stSidebar"] h3 {{ color: white !important; }}

/* ── Nav section labels (RFQ 관리, 영업 관리, 시스템) ──────────────────── */
[data-testid="stSidebar"] nav li p {{
    font-size: 10px !important;
    font-weight: 800 !important;
    text-transform: uppercase !important;
    letter-spacing: 0.12em !important;
    color: rgba(180,200,230,0.38) !important;
    padding: 20px 12px 5px 14px !important;
    margin: 0 !important;
    pointer-events: none !important;
    user-select: none !important;
    border-top: 1px solid rgba(255,255,255,0.07) !important;
}}
[data-testid="stSidebar"] nav li:first-child p,
[data-testid="stSidebar"] nav li:nth-child(1) p {{
    border-top: none !important;
    padding-top: 4px !important;
    color: transparent !important;
}}

/* ── Nav page links ──────────────────────────────────────────────────────── */
[data-testid="stSidebar"] nav a,
[data-testid="stSidebar"] nav a * {{
    color: #C4CFDE !important;
    opacity: 1 !important;
    font-weight: 600 !important;
    font-size: 13.5px !important;
    letter-spacing: -.01em !important;
}}
[data-testid="stSidebar"] nav a[aria-current="page"],
[data-testid="stSidebar"] nav a[aria-current="page"] * {{
    color: #FFFFFF !important;
    font-weight: 700 !important;
}}
[data-testid="stSidebar"] nav li a {{
    display: flex !important;
    align-items: center !important;
    border-radius: 0 8px 8px 0 !important;
    padding-left: 14px !important;
    margin-left: 0 !important;
    border-left: 3px solid transparent !important;
    transition: background .15s, border-color .15s !important;
}}
[data-testid="stSidebar"] nav li a:hover {{
    background: rgba(255,255,255,.07) !important;
    border-left-color: rgba(0,85,168,.4) !important;
}}
[data-testid="stSidebar"] nav li a[aria-current="page"] {{
    background: rgba(0,85,168,.30) !important;
    border-left: 3px solid {BLUE} !important;
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
    opacity: 0.50 !important;
    flex-shrink: 0 !important;
}}
[data-testid="stSidebar"] nav li a[aria-current="page"]::before,
[data-testid="stSidebar"] nav li a:hover::before {{
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
