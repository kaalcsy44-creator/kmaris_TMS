"""P/O — Customer P/O and Vendor P/O workflow tabs."""
from __future__ import annotations
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import streamlit as st
from app.utils.auth import require_auth
from app.utils.helpers import inject_css, section_header


def _load_view_module(filename: str, module_name: str):
    path = Path(__file__).resolve().parent / filename
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load view module: {filename}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


try:
    st.set_page_config(page_title="P/O — KTMS", page_icon="📦", layout="wide")
except Exception:
    pass
require_auth()
inject_css()

_customer_po = _load_view_module("5_CustomerPO.py", "ktms_customer_po_view")
_vendor_po = _load_view_module("5b_VendorPO.py", "ktms_vendor_po_view")

section_header("order", "P/O")

# ── 상단: 목록/내역 현황 (Customer P/O 수신 · Vendor P/O 발신) ────────────────────
tab_c_list, tab_v_sent = st.tabs([
    "Customer P/O 수신 목록",
    "Vendor P/O 발신 목록",
])
with tab_c_list:
    _customer_po.render_customer_po_list_tab()
with tab_v_sent:
    _vendor_po.render_vendor_po_sent_tab()

st.markdown("---")

# ── 하단: 작업 탭 (신규 등록 · Vendor P/O 생성 · 이메일 발송) ──────────────────────
TABS = [
    ("Customer P/O 신규 등록", _customer_po.render_customer_po_new_tab),
    ("Vendor P/O 생성", _vendor_po.render_vendor_po_create_tab),
    ("Vendor P/O 이메일 발송", _vendor_po.render_vendor_po_send_tab),
]
_labels = [t[0] for t in TABS]
_render_by_label = {label: fn for label, fn in TABS}

choice = st.segmented_control(
    "P/O 작업",
    _labels,
    default=_labels[0],
    key="po_tab",
    label_visibility="collapsed",
)
if choice not in _render_by_label:
    choice = _labels[0]

st.markdown("")
_render_by_label[choice]()
