"""RFQ & Quotation — 통합 페이지.

기존 4개 메뉴(Customer RFQ 수신 · Vendor RFQ 발신 · Vendor Quot. 수신 ·
Customer Quot. 발신)의 9개 소메뉴를 한 페이지의 탭바로 합친다. 위젯 충돌과
st.stop() 문제를 피하기 위해 '선택된 한 탭'만 렌더한다.
"""
from __future__ import annotations
import importlib.util
import sys
from pathlib import Path

_VIEWS = Path(__file__).resolve().parent
ROOT = _VIEWS.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import streamlit as st
from app.utils.auth import require_auth
from app.utils.helpers import inject_css, section_header

try:
    st.set_page_config(page_title="RFQ & Quotation — KTMS", page_icon="📨", layout="wide")
except Exception:
    pass
require_auth()
inject_css()
section_header("rfq", "RFQ & Quotation")


def _load(modname: str, filename: str):
    """digit-prefix 파일명도 로드 가능하도록 importlib로 적재 후 sys.modules에 캐시."""
    if modname in sys.modules:
        return sys.modules[modname]
    spec = importlib.util.spec_from_file_location(modname, _VIEWS / filename)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[modname] = mod
    spec.loader.exec_module(mod)
    return mod


_crfq = _load("ktms_crfq",   "2_CRFQ.py")
_vrfq = _load("ktms_vrfq",   "3_VRFQ.py")
_vq   = _load("ktms_vquote", "vendor_quote.py")
_qtn  = _load("ktms_qtn",    "4_Quotation.py")

# 원래 9개 소메뉴 순서대로 (라벨, render 함수)
TABS = [
    ("Customer RFQ · 신규 등록",   _crfq.render_crfq_new),
    ("Customer RFQ · 목록",        _crfq.render_crfq_list),
    ("Vendor RFQ · 작성·발신",     _vrfq.render_vrfq_send),
    ("Vendor RFQ · 발신 내역",     _vrfq.render_vrfq_sent),
    ("Vendor Quot. · 수신 등록",   _vq.render_vquote_register),
    ("Vendor Quot. · 목록",        _vq.render_vquote_list),
    ("Customer Quot. · 신규 등록", _qtn.render_qtn_new),
    ("Customer Quot. · 목록",      _qtn.render_qtn_list),
    ("Customer Quot. · 발신",      _qtn.render_qtn_send),
]
_labels = [t[0] for t in TABS]
_render_by_label = {label: fn for label, fn in TABS}

choice = st.segmented_control(
    "RFQ & Quotation 단계",
    _labels,
    default=_labels[0],
    key="rfq_qtn_tab",
    label_visibility="collapsed",
)
if choice not in _render_by_label:
    choice = _labels[0]

st.markdown("")
_render_by_label[choice]()
