"""RFQ & Quotation — 통합 페이지.

상단에 거래(RFQ)별 통합 현황 테이블(기존 4개 '목록/내역' 메뉴를 한 테이블로 병합)을
두고, 그 아래 탭바에는 작업(신규 등록·발신·수신 등록) 5개만 둔다. 위젯 충돌과
st.stop() 문제를 피하기 위해 '선택된 한 탭'만 렌더한다.
"""
from __future__ import annotations
import html as _html
import importlib.util
import sys
from datetime import timedelta
from pathlib import Path

_VIEWS = Path(__file__).resolve().parent
ROOT = _VIEWS.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import streamlit as st
from app.utils.auth import require_auth
from app.utils.helpers import (
    inject_css, hint, section_header,
    rfq_list, customer_name, vessel_name, customer_options,
    pipeline_status_label, INTERNAL_STEPS, total_amount,
)
from db.engine import get_session
from db.models import VendorRFQ, VendorQuote, Quotation

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


def _kst(dt) -> str:
    """UTC datetime → KST(+9h) 'yy-mm-dd hh:mm'. 없으면 '—'."""
    if not dt:
        return "—"
    return (dt + timedelta(hours=9)).strftime("%y-%m-%d %H:%M")


def _items_cost_total(items) -> float:
    """Vendor 견적 품목의 cost_price×qty 합계."""
    tot = 0.0
    for it in (items or []):
        try:
            tot += float(it.get("cost_price", 0) or 0) * float(it.get("qty", 1) or 1)
        except (TypeError, ValueError):
            pass
    return tot


_OV_CSS = """
<style>
.ov-wrap { overflow-x:auto; border:1px solid #D7E2EE; border-radius:12px;
           box-shadow:0 4px 20px rgba(11,29,58,.06); }
.ov-table { width:100%; border-collapse:collapse; font-size:13px; }
.ov-table th { text-align:left; padding:9px 12px; background:#F1F5FB; color:#0B1D3A;
               font-weight:700; font-size:11.5px; white-space:nowrap;
               border-bottom:2px solid #D7E2EE; }
.ov-table td { padding:7px 12px; border-bottom:1px solid #EDF2F8; vertical-align:top;
               color:#1F2937; white-space:nowrap; }
.ov-table tr:last-child td { border-bottom:none; }
.ov-table tbody tr:hover td { background:#F8FBFF; }
.ov-table tbody tr.sel td { background:#EAF3FF; }
.ov-sub { font-size:80%; color:#9AA6B5; margin-top:1px; }
.ov-r { text-align:right; }
.ov-chk { text-align:center; padding-left:10px; padding-right:4px; }
.ov-box { text-decoration:none; font-size:17px; color:#9AA6B5; line-height:1; }
.ov-box.on, .ov-box:hover { color:#0055A8; }
</style>
"""


def _td(main, sub: str = "", cls: str = "") -> str:
    m = _html.escape(str(main)) if main not in (None, "", "—") else "—"
    inner = f"<div>{m}</div>"
    if sub:
        inner += f'<div class="ov-sub">{_html.escape(str(sub))}</div>'
    return f'<td class="{cls}">{inner}</td>'


# ══════════════════════════════════════════════════════════════════════════════
# 통합 현황 테이블 — 거래(RFQ) 1건당 한 행 (기존 4개 목록/내역 병합)
# ══════════════════════════════════════════════════════════════════════════════
def render_overview():
    col_f1, col_f2, col_f3 = st.columns([2, 2, 1])
    with col_f1:
        stage_opts = ["전체"] + [f"{i}/{len(INTERNAL_STEPS)} {n}" for i, n in enumerate(INTERNAL_STEPS, 1)]
        status_filter = st.selectbox("상태 필터 (12단계)", stage_opts, key="ov_status")
    with col_f2:
        cust_opts = {"전체": None, **customer_options()}
        cust_sel = st.selectbox("Customer 필터", list(cust_opts.keys()), key="ov_cust")
    with col_f3:
        st.markdown("<br>", unsafe_allow_html=True)
        st.button("새로고침", use_container_width=True, key="ov_refresh")

    rfqs = rfq_list()
    if cust_sel != "전체" and cust_opts[cust_sel]:
        rfqs = [r for r in rfqs if r.customer_id == cust_opts[cust_sel]]

    s = get_session()
    try:
        rows = []
        for r in rfqs:
            stage_lbl = pipeline_status_label(r.id)
            if status_filter != "전체" and stage_lbl != status_filter:
                continue
            c_name = customer_name(r.customer_id)
            v_name = vessel_name(r.vessel_id)

            # 6) Vendor RFQ 발신 — 최신 1건 + (외 N건)
            vrfqs = (s.query(VendorRFQ).filter_by(rfq_id=r.id)
                     .order_by(VendorRFQ.id.desc()).all())
            if vrfqs:
                vr0 = vrfqs[0]
                vrfq_main = vr0.vrfq_no + (f"  (외 {len(vrfqs) - 1}건)" if len(vrfqs) > 1 else "")
                vrfq_sub = _kst(vr0.created_at)
            else:
                vrfq_main, vrfq_sub = "—", ""

            # 7) Vendor Quot. 수신 — 최신 1건 + (외 N건), 7-1) 금액
            vrfq_ids = [x.id for x in vrfqs]
            vqs = (s.query(VendorQuote)
                   .filter(VendorQuote.vendor_rfq_id.in_(vrfq_ids))
                   .order_by(VendorQuote.id.desc()).all()
                   if vrfq_ids else [])
            if vqs:
                vq0 = vqs[0]
                # getattr 폴백: 배포 직후 모듈 캐시로 신규 컬럼이 아직 매핑 안 됐어도 크래시 방지.
                _vq_no = getattr(vq0, "vendor_quote_no", None) or "—"
                vq_main = str(_vq_no) + (f"  (외 {len(vqs) - 1}건)" if len(vqs) > 1 else "")
                vq_sub = _kst(vq0.created_at)
                _vq_cur = getattr(vq0, "currency", None) or "USD"
                vq_amt = f"{_vq_cur} {_items_cost_total(vq0.items):,.2f}"
            else:
                vq_main, vq_sub, vq_amt = "—", "", "—"

            # 8) Customer Quot. 발신 (최신), 9) 금액
            qtn = (s.query(Quotation).filter_by(rfq_id=r.id)
                   .order_by(Quotation.id.desc()).first())
            if qtn:
                qtn_main, qtn_sub = qtn.qtn_no, _kst(qtn.created_at)
                qtn_amt = f"{qtn.currency} {total_amount(qtn.items or []):,.2f}"
            else:
                qtn_main, qtn_sub, qtn_amt = "—", "", "—"

            rows.append({
                "ID": r.id,
                "QTN_ID": qtn.id if qtn else 0,
                "VRFQ_ID": vrfq_ids[0] if vrfq_ids else 0,  # 최신 VRFQ
                "고객 RFQ No.": r.customer_rfq_no or "—",
                "Customer": c_name,
                "선박": v_name,
                "품목수": len(r.items or []),
                "1. Customer RFQ 수신": r.rfq_no,
                "1. Customer RFQ 수신 일시": _kst(r.created_at),
                "2. Vendor RFQ 발신": vrfq_main,
                "2. Vendor RFQ 발신 일시": vrfq_sub,
                "3. Vendor Quot. 수신": vq_main,
                "3. Vendor Quot. 수신 일시": vq_sub,
                "Vendor 견적 금액": vq_amt,
                "4. Customer Quot. 발신": qtn_main,
                "4. Customer Quot. 발신 일시": qtn_sub,
                "Customer 견적 금액": qtn_amt,
                "상태": stage_lbl,
            })
    finally:
        s.close()

    if not rows:
        hint("표시할 RFQ가 없습니다. 'Customer RFQ · 신규 등록' 탭에서 등록하세요.")
        return

    st.markdown(
        """
        <style>
        .st-key-rfq_overview_grid {
            overflow-x: auto;
            overflow-y: hidden;
            border: 1px solid #E3EAF3;
            border-radius: 10px;
            gap: 0 !important;
        }
        /* base row */
        .st-key-rfq_overview_grid [data-testid="stHorizontalBlock"] {
            min-width: 1580px;
            padding: 3px 6px;
            margin: 0 !important;
            align-items: center;
            background: #FFFFFF;
            border-bottom: 1px solid #EEF2F8;
        }
        /* zebra */
        .st-key-rfq_overview_grid [data-testid="stHorizontalBlock"]:nth-of-type(even) {
            background: #F6F9FC;
        }
        /* header row */
        .st-key-rfq_overview_grid [data-testid="stHorizontalBlock"]:first-of-type {
            background: #EEF3FA;
            border-bottom: 2px solid #D7E2EE;
            padding: 6px 6px;
        }
        /* hover (data rows only) */
        .st-key-rfq_overview_grid [data-testid="stHorizontalBlock"]:not(:first-of-type):hover {
            background: #EAF3FF;
        }
        .st-key-rfq_overview_grid [data-testid="stHorizontalBlock"]:last-of-type {
            border-bottom: none;
        }
        .st-key-rfq_overview_grid [data-testid="stVerticalBlock"] {
            gap: 0 !important;
        }
        .st-key-rfq_overview_grid [data-testid="stElementContainer"] {
            margin: 0 !important;
        }
        .st-key-rfq_overview_grid [data-testid="stMarkdown"],
        .st-key-rfq_overview_grid [data-testid="stMarkdownContainer"] {
            margin: 0 !important;
            padding: 0 !important;
        }
        .rfq-grid-head {
            color: #45526A;
            font-size: 10px;
            font-weight: 700;
            letter-spacing: 0.2px;
            line-height: 1.15;
            margin: 0;
            white-space: nowrap;
        }
        .rfq-grid-main {
            color: #111827;
            font-size: 10px;
            line-height: 1.2;
            margin: 0;
            white-space: nowrap;
        }
        .rfq-grid-sub {
            color: #8A95A5;
            font-size: 9px;
            line-height: 1.05;
            margin-top: 1px;
            white-space: nowrap;
            font-variant-numeric: tabular-nums;
        }
        .rfq-grid-r {
            text-align: right;
            font-variant-numeric: tabular-nums;
        }
        .st-key-rfq_overview_grid [data-testid="stButton"] button {
            width: 22px !important;
            height: 22px !important;
            min-height: 22px !important;
            padding: 0 !important;
            font-size: 10px !important;
            border-radius: 6px !important;
        }
        </style>
        """,
        unsafe_allow_html=True,
    )

    # 우측 정렬 대상 열 인덱스: 품목수, Vendor 견적 금액, Customer 견적 금액
    RIGHT_COLS = {4, 8, 10}

    def _cell(col, main, sub: str = "", right: bool = False) -> None:
        main_text = "—" if main in (None, "") else str(main)
        cls = "rfq-grid-main rfq-grid-r" if right else "rfq-grid-main"
        html = f'<div class="{cls}">{_html.escape(main_text)}</div>'
        if sub:
            sub_cls = "rfq-grid-sub rfq-grid-r" if right else "rfq-grid-sub"
            html += f'<div class="{sub_cls}">{_html.escape(str(sub))}</div>'
        col.markdown(html, unsafe_allow_html=True)

    def _header(col, label: str, right: bool = False) -> None:
        cls = "rfq-grid-head rfq-grid-r" if right else "rfq-grid-head"
        col.markdown(f'<div class="{cls}">{_html.escape(label)}</div>', unsafe_allow_html=True)

    selected_rfq_id = int(st.session_state.get("rfq_detail_id") or 0)
    col_widths = [0.30, 0.90, 2.80, 1.50, 0.50, 1.50, 1.80, 1.50, 1.10, 1.50, 1.10, 1.30]
    chosen = None
    with st.container(key="rfq_overview_grid"):
        header_cols = st.columns(col_widths, gap="small", vertical_alignment="center")
        for i, (col, label) in enumerate(zip(
            header_cols,
            ["", "고객 RFQ No.", "Customer", "선박", "품목수", "1. Customer RFQ 수신",
             "2. Vendor RFQ 발신", "3. Vendor Quot. 수신", "Vendor 견적 금액",
             "4. Customer Quot. 발신", "Customer 견적 금액", "상태"],
        )):
            _header(col, label, right=i in RIGHT_COLS)

        for idx, rw in enumerate(rows):
            rid = int(rw["ID"])
            is_selected = rid == selected_rfq_id
            if is_selected:
                chosen = rw

            cols = st.columns(col_widths, gap="small", vertical_alignment="center")
            with cols[0]:
                if st.button("✓" if is_selected else " ", key=f"rfq_row_select_{rid}", help="선택"):
                    if is_selected:
                        st.session_state.pop("rfq_detail_id", None)
                        st.session_state.pop("qtn_detail_id", None)
                        st.session_state.pop("vrfq_detail_id", None)
                    else:
                        st.session_state["rfq_detail_id"] = rid
                    st.rerun()
            _cell(cols[1], rw["고객 RFQ No."])
            _cell(cols[2], rw["Customer"])
            _cell(cols[3], rw["선박"])
            _cell(cols[4], rw["품목수"], right=True)
            _cell(cols[5], rw["1. Customer RFQ 수신"], rw["1. Customer RFQ 수신 일시"])
            _cell(cols[6], rw["2. Vendor RFQ 발신"], rw["2. Vendor RFQ 발신 일시"])
            _cell(cols[7], rw["3. Vendor Quot. 수신"], rw["3. Vendor Quot. 수신 일시"])
            _cell(cols[8], rw["Vendor 견적 금액"], right=True)
            _cell(cols[9], rw["4. Customer Quot. 발신"], rw["4. Customer Quot. 발신 일시"])
            _cell(cols[10], rw["Customer 견적 금액"], right=True)
            _cell(cols[11], rw["상태"])

    if chosen:
        st.session_state["rfq_detail_id"] = chosen["ID"]
        if chosen["QTN_ID"]:
            st.session_state["qtn_detail_id"] = chosen["QTN_ID"]
        else:
            st.session_state.pop("qtn_detail_id", None)
        if chosen["VRFQ_ID"]:
            st.session_state["vrfq_detail_id"] = chosen["VRFQ_ID"]
        else:
            st.session_state.pop("vrfq_detail_id", None)
    else:
        st.session_state.pop("rfq_detail_id", None)
        st.session_state.pop("qtn_detail_id", None)
        st.session_state.pop("vrfq_detail_id", None)

    with st.expander("선택한 건 상세 · 액션", expanded=bool(chosen)):
        _crfq.render_rfq_detail()
        if st.session_state.get("qtn_detail_id"):
            st.markdown("---")
            st.markdown("#### 견적 상세")
            _qtn.render_quotation_detail()


render_overview()
st.markdown("---")


# ── 작업 탭바 (신규 등록 · 발신 · 수신 등록) ──────────────────────────────────────
TABS = [
    ("1. Customer RFQ 수신", _crfq.render_crfq_new),
    ("2. Vendor RFQ 발신", _vrfq.render_vrfq_send),
    ("3. Vendor Quot. 수신", _vq.render_vquote_register),
    ("4. Customer Quot. 발신", _qtn.render_qtn_create_send),
]
_labels = [t[0] for t in TABS]
_render_by_label = {label: fn for label, fn in TABS}

choice = st.segmented_control(
    "RFQ & Quotation 작업",
    _labels,
    default=_labels[0],
    key="rfq_qtn_tab",
    label_visibility="collapsed",
)
if choice not in _render_by_label:
    choice = _labels[0]

st.markdown("")
_render_by_label[choice]()
