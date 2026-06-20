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
    customer_name, vessel_name, get_vendor,
    get_order_for_rfq, pipeline_status_label, rfq_list,
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
def _pos_by_order() -> dict[int, list]:
    """오더 ID → Vendor P/O 목록(최신순)."""
    s = get_session()
    try:
        pos = (s.query(PurchaseOrder)
               .order_by(PurchaseOrder.id.desc()).all())
    finally:
        s.close()
    by_ord: dict[int, list] = {}
    for po in pos:
        if po.order_id:
            by_ord.setdefault(po.order_id, []).append(po)
    return by_ord


def _with_subline(main: str, label: str, value: str | None) -> str:
    return f"{main or '—'}\n{label}: {value or '—'}"


def _vendor_po_no_for_display(po: PurchaseOrder) -> str:
    """Legacy KMS-PO-YYYY-NNNN numbers are shown as KMS-PO-yymm-NNN."""
    po_no = po.po_no or "—"
    parts = po_no.split("-")
    if len(parts) == 4 and parts[0] == "KMS" and parts[1] == "PO" and len(parts[2]) == 4:
        period = (po.date or "")[:7].replace("-", "")
        if len(period) == 6 and period.isdigit():
            return f"KMS-PO-{period[2:]}-{int(parts[3]):03d}"
    return po_no


def render_po_overview() -> None:
    status_filter = st.selectbox("상태 필터", ["전체"] + [s.value for s in OrderStatus], key="po_ov_status")
    rfqs = rfq_list()
    if not rfqs:
        hint("등록된 RFQ가 없습니다.")
        return

    pos_by_ord = _pos_by_order()
    rows = []
    for r in rfqs:
        o = get_order_for_rfq(r.id)
        if status_filter != "전체" and (not o or o.status.value != status_filter):
            continue

        vpos = pos_by_ord.get(o.id, []) if o else []
        if vpos:
            vp0 = vpos[0]
            v = get_vendor(vp0.vendor_id)
            vendor_po_no = _vendor_po_no_for_display(vp0) + (f"  (외 {len(vpos) - 1}건)" if len(vpos) > 1 else "")
            vendor_nm = v.name if v else "—"
            sent_email = vp0.sent_to_email or "—"
            sent_date = vp0.sent_date or "미발신"
        else:
            vendor_po_no = vendor_nm = sent_email = sent_date = "—"
        rows.append({
            "ID": o.id if o else 0,
            "고객RFQ No.": r.customer_rfq_no or r.rfq_no,
            "Customer": customer_name(r.customer_id),
            "선박": vessel_name(r.vessel_id),
            "고객 PO No.": _with_subline(o.po_no if o else "—", "수신일시", o.date if o else None),
            "오더 No.": o.ord_no if o else "—",
            "품목수": len((o.items if o else None) or r.items or []),
            "Vendor PO No.": _with_subline(vendor_po_no, "발신일시", sent_date),
            "Vendor": vendor_nm,
            "수신자 이메일": sent_email,
            "상태": pipeline_status_label(r.id),
        })

    df = pd.DataFrame(rows)
    if df.empty:
        hint("필터 조건에 맞는 RFQ/P/O가 없습니다.")
        return

    st.caption("고객 PO No.는 'Customer P/O 신규 등록'에서 PDF 자동 인식 또는 수기 입력한 고객 주문서 번호입니다.")
    selected = st.dataframe(
        df.drop(columns=["ID"]),
        use_container_width=True, hide_index=True,
        selection_mode="single-row", on_select="rerun",
    )
    sel = selected.selection.rows if hasattr(selected, "selection") else []
    if sel:
        selected_order_id = int(df.iloc[sel[0]]["ID"])
        if selected_order_id:
            st.session_state["ord_detail_id"] = selected_order_id
        else:
            st.session_state.pop("ord_detail_id", None)

    st.markdown("---")
    _customer_po.render_order_detail()


render_po_overview()

st.markdown("---")

def render_vendor_po_workflow() -> None:
    _vendor_po.render_vendor_po_create_tab()
    st.markdown("---")
    _vendor_po.render_vendor_po_send_tab()


# ── 하단: 작업 탭 (Customer P/O 수신 · Vendor P/O 발신) ────────────────────────
TABS = [
    ("5. Customer P/O 수신", _customer_po.render_customer_po_new_tab),
    ("6. Vendor P/O 발신", render_vendor_po_workflow),
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
