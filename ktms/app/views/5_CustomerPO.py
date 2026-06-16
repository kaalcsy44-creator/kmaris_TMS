"""Customer P/O 수신 — 고객 P/O로 수주 등록 · 오더 목록 · 납기/상태 관리."""
from __future__ import annotations
import sys
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pandas as pd
import streamlit as st
from app.utils.auth import require_auth
from app.utils.helpers import (
    inject_css, hint, section_header, next_doc_no, status_badge, tracking_url,
    quotation_list, get_quotation, get_customer, get_vessel, get_vendor,
    vendor_options, order_list, get_order, NAVY,
)
from db.engine import get_session
from db.models import Order, PurchaseOrder, Quotation, OrderStatus, QuotationStatus
from services.sheets_svc import upsert_order as _sheet_upsert_order

try:
    st.set_page_config(page_title="Customer P/O 수신 — KTMS", page_icon="📥", layout="wide")
except Exception:
    pass
require_auth()
inject_css()

section_header("order", "고객 P/O 수신 (Customer PO)")


def render_order_detail():
    """오더 목록에서 선택한 오더의 상세(정보·상태·납기·품목)를 인라인 표시."""
    ord_id = st.session_state.get("ord_detail_id")
    if not ord_id:
        hint("위 목록에서 오더를 선택하면 상세가 여기에 표시됩니다.")
        return
    order = get_order(int(ord_id))
    if not order:
        hint("선택한 오더를 찾을 수 없습니다. 목록에서 다시 선택하세요.")
        return

    cust   = get_customer(order.customer_id)
    vessel = get_vessel(order.vessel_id) if order.vessel_id else None

    col_info, col_act = st.columns([3, 1])
    with col_info:
        st.markdown(f"### {order.ord_no}")
        m1, m2, m3 = st.columns(3)
        info_cards = [
            (m1, "Customer", cust.name if cust else "—"),
            (m2, "선박", vessel.name if vessel else "—"),
            (m3, "PO No.", order.po_no or "—"),
        ]
        for col, label, value in info_cards:
            with col:
                st.markdown(f"""
                <div class="ktms-info-card">
                    <div class="ktms-info-label">{label}</div>
                    <div class="ktms-info-value">{value}</div>
                </div>
                """, unsafe_allow_html=True)
        st.markdown(f"**상태:** {status_badge(order.status.value)}", unsafe_allow_html=True)
        t_url = tracking_url("order", order.tracking_token)
        st.markdown(f"🔗 **고객 트래킹 링크:** [{t_url}]({t_url})")
        st.caption("📨 Vendor 발주서(발주) 생성은 좌측 메뉴 'Vendor PO 발신'에서 진행하세요.")

    with col_act:
        new_stat = st.selectbox("상태 변경", [s.value for s in OrderStatus],
                                index=[s.value for s in OrderStatus].index(order.status.value))
        if st.button("상태 업데이트", key="ord_stat"):
            s = get_session()
            try:
                o = s.query(Order).get(order.id)
                o.status = OrderStatus(new_stat)
                # 출고/인도 시점 자동 기록 (미입력 시에만)
                today_iso = date.today().isoformat()
                if OrderStatus(new_stat) == OrderStatus.SHIPPED and not o.shipped_date:
                    o.shipped_date = today_iso
                if OrderStatus(new_stat) == OrderStatus.DELIVERED and not o.delivered_date:
                    o.delivered_date = today_iso
                s.commit()
                _sheet_upsert_order(o, get_customer(o.customer_id), get_vessel(o.vessel_id) if o.vessel_id else None)
                st.success("업데이트!")
                st.rerun()
            finally:
                s.close()

    # ── 납기 일정 (약속/출고/인도) ────────────────────────────────────────────
    with st.expander("📅 납기 일정 (OTD 측정)", expanded=False):
        from datetime import datetime as _dt

        def _parse(d):
            try:
                return _dt.strptime(d, "%Y-%m-%d").date() if d else None
            except (TypeError, ValueError):
                return None

        with st.form("delivery_dates"):
            d1, d2, d3 = st.columns(3)
            promised_in  = d1.date_input("약속 납기일", value=_parse(order.promised_delivery))
            shipped_in   = d2.date_input("실제 출고일", value=_parse(order.shipped_date))
            delivered_in = d3.date_input("실제 인도일", value=_parse(order.delivered_date))
            save_dates = st.form_submit_button("납기 일정 저장")

        if save_dates:
            s = get_session()
            try:
                o = s.query(Order).get(order.id)
                o.promised_delivery = promised_in.isoformat() if promised_in else None
                o.shipped_date      = shipped_in.isoformat() if shipped_in else None
                o.delivered_date    = delivered_in.isoformat() if delivered_in else None
                s.commit()
                st.success("납기 일정 저장 완료")
                st.rerun()
            finally:
                s.close()

        pd_, dd_ = _parse(order.promised_delivery), _parse(order.delivered_date)
        if pd_ and dd_:
            days = (dd_ - pd_).days
            if days <= 0:
                st.success(f"✅ 납기 준수 (약속 대비 {-days}일 빠름)" if days < 0 else "✅ 납기 정시 준수")
            else:
                st.error(f"⚠️ 납기 지연 — 약속보다 {days}일 초과")

    if order.items:
        st.markdown("**품목 리스트**")
        st.dataframe(pd.DataFrame(order.items), use_container_width=True, hide_index=True)


tab_new, tab_list = st.tabs(["➕ 신규 등록", "📋 오더 목록"])

# ══════════════════════════════════════════════════════════════════════════════
# TAB — LIST
# ══════════════════════════════════════════════════════════════════════════════
with tab_list:
    status_filter = st.selectbox("상태 필터", ["전체"] + [s.value for s in OrderStatus])
    orders = order_list(None if status_filter == "전체" else status_filter)

    if orders:
        rows = []
        for o in orders:
            c = get_customer(o.customer_id)
            v = get_vessel(o.vessel_id) if o.vessel_id else None
            rows.append({
                "ID": o.id,
                "오더 No.": o.ord_no,
                "Customer": c.name if c else "—",
                "선박": v.name if v else "—",
                "PO No.": o.po_no or "—",
                "품목수": len(o.items or []),
                "상태": o.status.value,
                "날짜": o.date or "—",
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
    else:
        hint("등록된 오더가 없습니다.")

    # ── 선택한 오더 상세 (인라인) ─────────────────────────────────────────────
    st.markdown("---")
    render_order_detail()

# ══════════════════════════════════════════════════════════════════════════════
# TAB — NEW ORDER
# ══════════════════════════════════════════════════════════════════════════════
with tab_new:
    st.subheader("신규 오더 등록")
    hint("고객 P/O(주문서)로 오더를 등록합니다. PDF 자동 인식 · 수주 확정 견적 불러오기 · 직접 입력 모두 가능합니다.")

    # ── 오더 PDF 자동 입력 (AI OCR) ───────────────────────────────────────────
    from app.utils.helpers import customer_options as _customer_options
    with st.expander("📄 오더 PDF로 자동 입력 (AI OCR)", expanded=False):
        ord_pdf = st.file_uploader(
            "고객 오더(P/O) PDF 업로드", type=["pdf"], key="ord_pdf_uploader",
            help="고객이 보낸 주문서(PDF)를 업로드하면 AI가 Customer·PO번호·선박·품목을 자동 인식합니다.",
        )
        if ord_pdf and st.button("AI로 정보 추출", key="btn_ord_ocr", type="secondary"):
            with st.spinner("AI가 PDF를 분석하고 있습니다..."):
                try:
                    from services.pdf_parser import extract_text_from_pdf, parse_order_fields
                    raw_text = extract_text_from_pdf(ord_pdf)
                    if not raw_text:
                        st.warning("PDF에서 텍스트를 추출할 수 없습니다. 스캔 이미지 PDF는 지원되지 않습니다.")
                    else:
                        st.session_state["order_ocr"] = parse_order_fields(
                            raw_text, list(_customer_options().keys())
                        )
                        st.rerun()
                except ImportError:
                    st.error("pdfplumber 또는 anthropic 패키지가 설치되지 않았습니다. requirements.txt를 확인하세요.")
                except Exception as exc:
                    st.error(f"추출 실패: {exc}")

        if st.session_state.get("order_ocr"):
            st.success("추출 완료! 아래 폼에 자동 반영됩니다. 내용을 검토·수정 후 등록하세요.")
            if st.button("OCR 결과 지우기", key="clear_ord_ocr"):
                st.session_state.pop("order_ocr", None)
                st.rerun()

    ocr = st.session_state.get("order_ocr", {}) or {}

    def _ocr_date(key):
        v = ocr.get(key)
        try:
            return datetime.strptime(v, "%Y-%m-%d").date() if v else None
        except (TypeError, ValueError):
            return None

    def _match(name, choices):
        if not name:
            return None
        n = str(name).strip().lower()
        for ch in choices:
            cl = ch.lower()
            if n == cl or n in cl or cl in n:
                return ch
        return None

    with st.expander("견적서에서 불러오기", expanded=True):
        won_quotes = [q for q in quotation_list() if q.status == QuotationStatus.WON or True]
        if won_quotes:
            qtn_opts = {q.qtn_no: q.id for q in won_quotes}
            sel_qtn = st.selectbox("견적 선택", ["— 없음 —"] + list(qtn_opts.keys()))
            if sel_qtn != "— 없음 —" and st.button("견적 데이터 불러오기"):
                st.session_state["load_qtn_id"] = qtn_opts[sel_qtn]
                st.rerun()
        else:
            hint("견적이 없습니다.")

    prefill_qtn = None
    if "load_qtn_id" in st.session_state:
        prefill_qtn = get_quotation(st.session_state["load_qtn_id"])

    with st.form("new_order_form"):
        c1, c2 = st.columns(2)
        with c1:
            from app.utils.helpers import customer_options
            cust_opts = customer_options()
            default_cust = list(cust_opts.keys())[0] if cust_opts else ""
            if prefill_qtn:
                c = get_customer(prefill_qtn.customer_id)
                if c and c.name in cust_opts:
                    default_cust = c.name
            elif ocr.get("customer_hint"):
                _m = _match(ocr["customer_hint"], list(cust_opts.keys()))
                if _m:
                    default_cust = _m
            cust_name = st.selectbox("Customer *", list(cust_opts.keys()) if cust_opts else ["—"],
                                     index=list(cust_opts.keys()).index(default_cust) if default_cust in cust_opts else 0)
            cust_id = cust_opts.get(cust_name)
            ord_date = st.date_input("수주일", value=_ocr_date("order_date") or date.today())
        with c2:
            po_no = st.text_input("고객 PO No.", value=ocr.get("po_no") or "")
            from app.utils.helpers import vessel_options
            vessel_opts = vessel_options(cust_id)
            _vchoices = ["— 없음 —"] + list(vessel_opts.keys())
            _vmatch = _match(ocr.get("vessel_name"), list(vessel_opts.keys()))
            vessel_name = st.selectbox("선박", _vchoices,
                                       index=_vchoices.index(_vmatch) if _vmatch else 0)
            vessel_id = vessel_opts.get(vessel_name) if vessel_name != "— 없음 —" else None
            promised = st.date_input("약속 납기일 (선택)", value=_ocr_date("promised_delivery"),
                                     help="고객과 약속한 납기일 — 납기 준수율(OTD) 측정 기준")

        # Items - 견적 우선, 없으면 OCR 추출 품목
        seed_items = list(prefill_qtn.items) if prefill_qtn and prefill_qtn.items else []
        if not seed_items and ocr.get("items"):
            for i, it in enumerate(ocr["items"], 1):
                seed_items.append({
                    "item_no": i,
                    "part_no": it.get("part_no", ""),
                    "description": it.get("description", ""),
                    "maker": it.get("maker", ""),
                    "qty": it.get("qty", 1),
                    "unit": it.get("unit", "PCS"),
                    "unit_price": it.get("unit_price", 0) or 0,
                })
        items_df = st.data_editor(
            pd.DataFrame(seed_items) if seed_items else pd.DataFrame(
                columns=["item_no", "part_no", "description", "maker", "qty", "unit", "unit_price"]),
            num_rows="dynamic", use_container_width=True, key="ord_items",
        )
        save_ord = st.form_submit_button("오더 등록", type="primary", use_container_width=True)

    if save_ord and cust_id:
        ord_no = next_doc_no("order")
        items_data = items_df.fillna("").to_dict(orient="records")
        session = get_session()
        try:
            order = Order(
                ord_no=ord_no,
                quotation_id=prefill_qtn.id if prefill_qtn else None,
                customer_id=cust_id,
                vessel_id=vessel_id,
                po_no=po_no,
                date=ord_date.isoformat(),
                promised_delivery=promised.isoformat() if promised else None,
                status=OrderStatus.RECEIVED,
                items=items_data,
            )
            session.add(order)
            if prefill_qtn:
                q = session.query(Quotation).get(prefill_qtn.id)
                q.status = QuotationStatus.WON
            session.commit()
            st.session_state["ord_detail_id"] = order.id
            st.session_state.pop("load_qtn_id", None)
            st.session_state.pop("order_ocr", None)
            t_url = tracking_url("order", order.tracking_token)
            st.success(f"✅ 오더 등록 완료: **{ord_no}**")
            st.info(f"🔗 고객 트래킹 링크: {t_url}")
            _sheet_upsert_order(order, get_customer(order.customer_id), get_vessel(order.vessel_id) if order.vessel_id else None)
        finally:
            session.close()
