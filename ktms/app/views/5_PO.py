"""P/O — Customer P/O and Vendor P/O workflow tabs."""
from __future__ import annotations
import html as _html
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

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


def _vendor_po_no_for_display(po: PurchaseOrder) -> str:
    """Legacy KMS-PO-YYYY-NNNN numbers are shown as KMS-PO-yymm-NNN."""
    po_no = po.po_no or "—"
    parts = po_no.split("-")
    if len(parts) == 4 and parts[0] == "KMS" and parts[1] == "PO" and len(parts[2]) == 4:
        period = (po.date or "")[:7].replace("-", "")
        if len(period) == 6 and period.isdigit():
            return f"KMS-PO-{period[2:]}-{int(parts[3]):03d}"
    return po_no


_PO_OV_CSS = """
<style>
.po-wrap { overflow-x:auto; border:1px solid #D7E2EE; border-radius:12px;
           box-shadow:0 4px 20px rgba(11,29,58,.06); }
.po-table { width:100%; border-collapse:collapse; font-size:13px; }
.po-table th { text-align:left; padding:9px 12px; background:#F1F5FB; color:#0B1D3A;
               font-weight:700; font-size:11.5px; white-space:nowrap;
               border-bottom:2px solid #D7E2EE; }
.po-table td { padding:7px 12px; border-bottom:1px solid #EDF2F8; vertical-align:top;
               color:#1F2937; white-space:nowrap; }
.po-table tr:last-child td { border-bottom:none; }
.po-table tbody tr:hover td { background:#F8FBFF; }
.po-table tbody tr.sel td { background:#EAF3FF; }
.po-sub { font-size:80%; color:#9AA6B5; margin-top:1px; }
.po-r { text-align:right; }
.po-chk { text-align:center; padding-left:10px; padding-right:4px; }
.po-box { text-decoration:none; font-size:17px; color:#9AA6B5; line-height:1; }
.po-box.on, .po-box:hover { color:#0055A8; }
</style>
"""


def _td(main, sub: str = "", cls: str = "") -> str:
    m = _html.escape(str(main)) if main not in (None, "", "—") else "—"
    inner = f"<div>{m}</div>"
    if sub:
        inner += f'<div class="po-sub">{_html.escape(str(sub))}</div>'
    return f'<td class="{cls}">{inner}</td>'


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
            "고객 PO No.": f"{o.po_no if o else '—'}\n수신일시: {o.date if o else '—'}",
            "오더 No.": o.ord_no if o else "—",
            "품목수": len((o.items if o else None) or r.items or []),
            "Vendor PO No.": f"{vendor_po_no}\n발신일시: {sent_date}",
            "Vendor": vendor_nm,
            "수신자 이메일": sent_email,
            "상태": pipeline_status_label(r.id),
        })

    if not rows:
        hint("필터 조건에 맞는 RFQ/P/O가 없습니다.")
        return

    st.caption("고객 PO No.는 'Customer P/O 신규 등록'에서 PDF 자동 인식 또는 수기 입력한 고객 주문서 번호입니다.")

    selected_order_id = int(st.session_state.get("ord_detail_id") or 0)
    header_cols = st.columns([0.35, 1.35, 1.7, 1.8, 1.35, 1.2, 0.65, 1.7, 1.5, 1.8, 1.2])
    for col, label in zip(
        header_cols,
        ["", "고객RFQ No.", "Customer", "선박", "고객 PO No.", "오더 No.",
         "품목수", "Vendor PO No.", "Vendor", "수신자 이메일", "상태"],
    ):
        col.markdown(f"**{label}**")

    st.divider()
    for idx, rw in enumerate(rows):
        oid = int(rw["ID"])
        is_selected = bool(oid and oid == selected_order_id)
        cols = st.columns([0.35, 1.35, 1.7, 1.8, 1.35, 1.2, 0.65, 1.7, 1.5, 1.8, 1.2])
        with cols[0]:
            if oid:
                if st.button("✓" if is_selected else " ", key=f"po_row_select_{oid}", help="선택"):
                    if is_selected:
                        st.session_state.pop("ord_detail_id", None)
                    else:
                        st.session_state["ord_detail_id"] = oid
                    st.rerun()
            else:
                st.caption("—")
        cols[1].write(rw["고객RFQ No."])
        cols[2].write(rw["Customer"])
        cols[3].write(rw["선박"])
        cols[4].write(rw["고객 PO No."])
        cols[5].write(rw["오더 No."])
        cols[6].write(rw["품목수"])
        cols[7].write(rw["Vendor PO No."])
        cols[8].write(rw["Vendor"])
        cols[9].write(rw["수신자 이메일"])
        cols[10].write(rw["상태"])
        if idx < len(rows) - 1:
            st.divider()

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
