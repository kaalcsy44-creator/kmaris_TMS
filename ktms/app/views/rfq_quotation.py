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

    # ── 선택 상태 (st.button 기반 — 부분 갱신이라 페이지 리로드/로그아웃 없음) ──
    selected_rfq_id = int(st.session_state.get("rfq_detail_id") or 0)
    chosen = next((rw for rw in rows if int(rw["ID"]) == selected_rfq_id), None)

    # 열 정의: (헤더, 본문 key, 일시 key, 컬럼 비율, 우측정렬)
    COLS = [
        ("고객 RFQ No.", "고객 RFQ No.", None, 0.90, False),
        ("Customer", "Customer", None, 3.00, False),
        ("선박", "선박", None, 1.35, False),
        ("품목수", "품목수", None, 0.60, True),
        ("1. Customer RFQ 수신", "1. Customer RFQ 수신", "1. Customer RFQ 수신 일시", 1.55, False),
        ("2. Vendor RFQ 발신", "2. Vendor RFQ 발신", "2. Vendor RFQ 발신 일시", 2.00, False),
        ("3. Vendor Quot. 수신", "3. Vendor Quot. 수신", "3. Vendor Quot. 수신 일시", 1.55, False),
        ("Vendor 견적 금액", "Vendor 견적 금액", None, 1.15, True),
        ("4. Customer Quot. 발신", "4. Customer Quot. 발신", "4. Customer Quot. 발신 일시", 1.55, False),
        ("Customer 견적 금액", "Customer 견적 금액", None, 1.25, True),
        ("상태", "상태", None, 1.35, False),
    ]
    col_ratios = [0.40] + [c[3] for c in COLS]

    # 행마다 고유 key 컨테이너에 줄무늬/선택색을 직접 지정한다.
    # (Streamlit DOM 래핑 때문에 nth-of-type 줄무늬가 불안정하므로 회피)
    stripe_sel = ",".join(
        f".st-key-rfq_ovrow_{i}" for i in range(len(rows)) if i % 2 == 1
    )
    stripe_css = (stripe_sel + " { background:#F4F8FC; }") if stripe_sel else ""
    sel_idx = next((i for i, rw in enumerate(rows) if int(rw["ID"]) == selected_rfq_id), None)
    sel_css = (
        ".st-key-rfq_ovrow_%d { background:#DCEBFF !important; "
        "box-shadow:inset 3px 0 0 #0055A8; }" % sel_idx
        if sel_idx is not None else ""
    )

    st.markdown(
        """
        <style>
        .st-key-rfq_overview_grid { overflow-x:auto; border:1px solid #E3EAF3;
            border-radius:10px; box-shadow:0 2px 10px rgba(11,29,58,.05); gap:0 !important; }
        .st-key-rfq_overview_grid [data-testid="stVerticalBlock"] { gap:0 !important; }
        .st-key-rfq_overview_grid [data-testid="stElementContainer"],
        .st-key-rfq_overview_grid [data-testid="stMarkdown"] { margin:0 !important; }
        /* 헤더/행 컨테이너 — 전체 폭 확보(가로 스크롤 시 배경이 끝까지 따라오도록) */
        .st-key-rfq_ovhead, [class*="st-key-rfq_ovrow_"] { min-width:1520px; }
        .st-key-rfq_ovhead [data-testid="stHorizontalBlock"],
        [class*="st-key-rfq_ovrow_"] [data-testid="stHorizontalBlock"] {
            min-width:1520px; gap:0 !important; align-items:center; flex-wrap:nowrap; }
        .st-key-rfq_ovhead { background:#EDF2FA; border-bottom:2px solid #CBD8E8; }
        [class*="st-key-rfq_ovrow_"] { background:#FFFFFF; border-bottom:1px solid #E5EBF3; }
        [class*="st-key-rfq_ovrow_"]:hover { background:#EAF3FF; }
        .rfq-h { color:#45526A; font-size:10px; font-weight:700; letter-spacing:.2px;
                 line-height:1.15; padding:5px 8px; white-space:normal; word-break:keep-all; }
        .rfq-m { color:#111827; font-size:10px; line-height:1.25; padding:3px 8px;
                 white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .rfq-s { color:#8A95A5; font-size:9px; line-height:1.1; padding:0 8px 3px;
                 white-space:nowrap; font-variant-numeric:tabular-nums; }
        .rfq-r { text-align:right; }
        .st-key-rfq_overview_grid [data-testid="stButton"] button {
            width:20px !important; height:20px !important; min-height:20px !important;
            padding:0 !important; font-size:10px !important; border-radius:5px !important; }
        </style>
        """,
        unsafe_allow_html=True,
    )
    st.markdown("<style>" + stripe_css + sel_css + "</style>", unsafe_allow_html=True)

    def _cell(col, main, sub, right: bool) -> None:
        rcls = " rfq-r" if right else ""
        m = _html.escape(str(main)) if main not in (None, "", "—") else "—"
        h = f'<div class="rfq-m{rcls}">{m}</div>'
        if sub:
            h += f'<div class="rfq-s{rcls}">{_html.escape(str(sub))}</div>'
        col.markdown(h, unsafe_allow_html=True)

    with st.container(key="rfq_overview_grid"):
        with st.container(key="rfq_ovhead"):
            hc = st.columns(col_ratios, gap="small", vertical_alignment="center")
            hc[0].markdown('<div class="rfq-h">&nbsp;</div>', unsafe_allow_html=True)
            for col, (h, _m, _s, _w, r) in zip(hc[1:], COLS):
                rcls = " rfq-r" if r else ""
                col.markdown(f'<div class="rfq-h{rcls}">{_html.escape(h)}</div>',
                             unsafe_allow_html=True)

        for idx, rw in enumerate(rows):
            rid = int(rw["ID"])
            is_sel = rid == selected_rfq_id
            with st.container(key=f"rfq_ovrow_{idx}"):
                cols = st.columns(col_ratios, gap="small", vertical_alignment="center")
                with cols[0]:
                    if st.button("✓" if is_sel else " ", key=f"rfq_row_select_{rid}", help="선택"):
                        if is_sel:
                            st.session_state.pop("rfq_detail_id", None)
                        else:
                            st.session_state["rfq_detail_id"] = rid
                        st.rerun()
                for col, (_h, m, s, _w, r) in zip(cols[1:], COLS):
                    _cell(col, rw[m], rw[s] if s else "", r)

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
