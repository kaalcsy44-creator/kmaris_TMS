"""RFQ & Quotation — 통합 페이지.

상단에 거래(RFQ)별 통합 현황 테이블(기존 4개 '목록/내역' 메뉴를 한 테이블로 병합)을
두고, 그 아래 탭바에는 작업(신규 등록·발신·수신 등록) 5개만 둔다. 위젯 충돌과
st.stop() 문제를 피하기 위해 '선택된 한 탭'만 렌더한다.
"""
from __future__ import annotations
import importlib.util
import sys
from datetime import timedelta
from pathlib import Path

_VIEWS = Path(__file__).resolve().parent
ROOT = _VIEWS.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pandas as pd
import streamlit as st
from app.utils.auth import require_auth
from app.utils.helpers import (
    inject_css, hint, section_header,
    rfq_list, get_customer, get_vessel, customer_options,
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


# ══════════════════════════════════════════════════════════════════════════════
# 통합 현황 테이블 — 거래(RFQ) 1건당 한 행 (기존 4개 목록/내역 병합)
# ══════════════════════════════════════════════════════════════════════════════
def render_overview():
    col_f1, col_f2, col_f3 = st.columns([2, 2, 1])
    with col_f1:
        stage_opts = ["전체"] + [f"{i}/14 {n}" for i, n in enumerate(INTERNAL_STEPS, 1)]
        status_filter = st.selectbox("상태 필터 (14단계)", stage_opts, key="ov_status")
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
            c = get_customer(r.customer_id)
            v = get_vessel(r.vessel_id) if r.vessel_id else None

            # 6) Vendor RFQ 발신 — 최신 1건 + (외 N건)
            vrfqs = (s.query(VendorRFQ).filter_by(rfq_id=r.id)
                     .order_by(VendorRFQ.id.desc()).all())
            if vrfqs:
                vr0 = vrfqs[0]
                vrfq_cell = f"{vr0.vrfq_no} · {_kst(vr0.created_at)}"
                if len(vrfqs) > 1:
                    vrfq_cell += f"  (외 {len(vrfqs) - 1}건)"
            else:
                vrfq_cell = "—"

            # 7) Vendor Quot. 수신 — 최신 1건 + (외 N건), 7-1) 금액
            vrfq_ids = [x.id for x in vrfqs]
            vqs = (s.query(VendorQuote)
                   .filter(VendorQuote.vendor_rfq_id.in_(vrfq_ids))
                   .order_by(VendorQuote.id.desc()).all()
                   if vrfq_ids else [])
            if vqs:
                vq0 = vqs[0]
                # getattr 폴백: 배포 직후 모듈 캐시로 신규 컬럼이 아직 매핑 안 됐어도 크래시 방지.
                _vq_no = getattr(vq0, "vendor_quote_no", None)
                vq_cell = f"{_vq_no or '—'} · {_kst(vq0.created_at)}"
                if len(vqs) > 1:
                    vq_cell += f"  (외 {len(vqs) - 1}건)"
                vq_amt_cell = f"{_items_cost_total(vq0.items):,.2f}"
            else:
                vq_cell, vq_amt_cell = "—", "—"

            # 8) Customer Quot. 발신 (최신), 9) 금액
            qtn = (s.query(Quotation).filter_by(rfq_id=r.id)
                   .order_by(Quotation.id.desc()).first())
            if qtn:
                qtn_cell = f"{qtn.qtn_no} · {_kst(qtn.created_at)}"
                qtn_amt_cell = f"{qtn.currency} {total_amount(qtn.items or []):,.2f}"
            else:
                qtn_cell, qtn_amt_cell = "—", "—"

            rows.append({
                "ID": r.id,
                "QTN_ID": qtn.id if qtn else 0,
                "VRFQ_ID": vrfq_ids[0] if vrfq_ids else 0,  # 최신 VRFQ
                "고객 RFQ No.": r.customer_rfq_no or "—",
                "Customer": c.name if c else "—",
                "선박": v.name if v else "—",
                "품목수": len(r.items or []),
                "Customer RFQ 수신": f"{r.rfq_no} · {_kst(r.created_at)}",
                "Vendor RFQ 발신": vrfq_cell,
                "Vendor Quot. 수신": vq_cell,
                "Vendor 견적 금액": vq_amt_cell,
                "Customer Quot. 발신": qtn_cell,
                "Customer 견적 금액": qtn_amt_cell,
                "상태": stage_lbl,
            })
    finally:
        s.close()

    if not rows:
        hint("표시할 RFQ가 없습니다. 'Customer RFQ · 신규 등록' 탭에서 등록하세요.")
        return

    df = pd.DataFrame(rows)
    selected = st.dataframe(
        df.drop(columns=["ID", "QTN_ID", "VRFQ_ID"]),
        use_container_width=True, hide_index=True,
        selection_mode="single-row", on_select="rerun", key="ov_table",
    )
    sel = selected.selection.rows if hasattr(selected, "selection") else []
    if sel:
        row = df.iloc[sel[0]]
        st.session_state["rfq_detail_id"] = int(row["ID"])
        if int(row["QTN_ID"]):
            st.session_state["qtn_detail_id"] = int(row["QTN_ID"])
        if int(row["VRFQ_ID"]):
            st.session_state["vrfq_detail_id"] = int(row["VRFQ_ID"])

    with st.expander("선택한 건 상세 · 액션", expanded=bool(sel)):
        _crfq.render_rfq_detail()
        if st.session_state.get("qtn_detail_id"):
            st.markdown("---")
            st.markdown("#### 견적 상세")
            _qtn.render_quotation_detail()


render_overview()
st.markdown("---")


# ── 작업 탭바 (신규 등록 · 발신 · 수신 등록) ──────────────────────────────────────
TABS = [
    ("Customer RFQ · 신규 등록", _crfq.render_crfq_new),
    ("Vendor RFQ · 작성·발신",   _vrfq.render_vrfq_send),
    ("Vendor Quot. · 수신 등록", _vq.render_vquote_register),
    ("Customer Quot. · 신규 등록", _qtn.render_qtn_new),
    ("Customer Quot. · 발신",    _qtn.render_qtn_send),
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
