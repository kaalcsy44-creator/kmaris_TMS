"""P/O — Customer P/O and Vendor P/O workflow tabs."""
from __future__ import annotations
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pandas as pd
import streamlit as st
from app.utils.auth import require_auth
from app.utils.helpers import (
    inject_css, hint, section_header,
    customer_name, vessel_name, order_list, get_vendor,
    rfq_id_for_order, pipeline_status_label,
)
from db.engine import get_session
from db.models import PurchaseOrder, OrderStatus


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


# ── 상단: 통합 현황 (Customer P/O 수신 + Vendor P/O 발신을 한 테이블로 병합) ────────
def _sent_pos_by_order() -> dict[int, list]:
    """오더 ID → 이메일 발송완료된 Vendor P/O 목록(최신순)."""
    s = get_session()
    try:
        pos = (s.query(PurchaseOrder)
               .filter(PurchaseOrder.status == "이메일 발송완료")
               .order_by(PurchaseOrder.id.desc()).all())
    finally:
        s.close()
    by_ord: dict[int, list] = {}
    for po in pos:
        if po.order_id:
            by_ord.setdefault(po.order_id, []).append(po)
    return by_ord


def render_po_overview() -> None:
    status_filter = st.selectbox("상태 필터", ["전체"] + [s.value for s in OrderStatus], key="po_ov_status")
    orders = order_list(None if status_filter == "전체" else status_filter)
    if not orders:
        hint("등록된 오더가 없습니다.")
        return

    sent_by_ord = _sent_pos_by_order()
    rows = []
    for o in orders:
        _rid = rfq_id_for_order(o)
        vpos = sent_by_ord.get(o.id, [])
        if vpos:
            vp0 = vpos[0]
            v = get_vendor(vp0.vendor_id)
            vendor_po_no = vp0.po_no + (f"  (외 {len(vpos) - 1}건)" if len(vpos) > 1 else "")
            vendor_nm = v.name if v else "—"
            sent_email = vp0.sent_to_email or "—"
            sent_date = vp0.sent_date or "—"
        else:
            vendor_po_no = vendor_nm = sent_email = sent_date = "—"
        rows.append({
            "ID": o.id,
            "오더 No.": o.ord_no,
            "Customer": customer_name(o.customer_id),
            "선박": vessel_name(o.vessel_id),
            "고객 PO No.": o.po_no or "—",
            "품목수": len(o.items or []),
            "등록일": o.date or "—",
            "Vendor PO No.": vendor_po_no,
            "Vendor": vendor_nm,
            "수신자 이메일": sent_email,
            "발송일": sent_date,
            "상태": pipeline_status_label(_rid) if _rid else o.status.value,
        })

    df = pd.DataFrame(rows)
    selected = st.dataframe(
        df.drop(columns=["ID"]),
        use_container_width=True, hide_index=True,
        selection_mode="single-row", on_select="rerun",
    )
    sel = selected.selection.rows if hasattr(selected, "selection") else []
    if sel:
        st.session_state["ord_detail_id"] = int(df.iloc[sel[0]]["ID"])

    st.markdown("---")
    _customer_po.render_order_detail()


render_po_overview()

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
