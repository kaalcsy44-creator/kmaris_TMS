"""Vendor P/O 발신 — 발주서(Purchase Order) 생성 · 이메일 발송 · 발신 내역.

구조는 'Vendor RFQ 발신'(3_VRFQ.py)과 동일한 패턴:
  탭1 발주서 생성  ·  탭2 발주서 이메일 발송(미리보기→발송)  ·  탭3 발신 내역
"""
from __future__ import annotations
import os
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pandas as pd
import streamlit as st
from app.utils.auth import require_auth
from app.utils.helpers import (
    inject_css, hint, section_header, next_po_no,
    get_customer, get_vessel, get_vendor, vendor_options,
    order_list, get_order, rfq_id_for_order, pipeline_status_label,
    vendor_quotes_for_rfq_vendor, price_map_from_quote,
)
from db.engine import get_session
from db.models import Order, PurchaseOrder, OrderStatus
from services.email_svc import send_email
from services.pdf_svc import build_po_payload, generate_po_pdf


# ── 발주서 이메일 본문 빌더 (영문 / 국문) ──────────────────────────────────────
def _po_item_lines(items, korean: bool) -> str:
    qty_label = "수량" if korean else "Qty"
    desc_label = "품명" if korean else "Desc"
    return "\n".join(
        f"  {i+1:>2}. Part No.: {str(it.get('part_no','—')):<20s}"
        f"  {qty_label}: {it.get('qty','—')} {str(it.get('unit','')):<5s}"
        f"  Maker: {it.get('maker','—')}\n"
        f"       {desc_label}: {it.get('description','—')}"
        for i, it in enumerate(items or [])
    )


def _build_vendor_po_email(po, vendor, order, vessel, notes: str) -> str:
    """English purchase order email."""
    vendor_name = vendor.name if vendor else "Vendor"
    vessel_str = vessel.name if vessel else "—"
    body = f"""Dear {vendor_name},

Please find attached our official Purchase Order for the following marine spare parts.

PO No.        : {po.po_no}
Order Ref.    : {order.ord_no if order else '—'}
Vessel        : {vessel_str}
Order Date    : {po.date or date.today().isoformat()}

──────────────────────── ITEM LIST ────────────────────────
{_po_item_lines(po.items, korean=False)}
────────────────────────────────────────────────────────────

Please confirm the following upon receipt:
  • Acceptance of this Purchase Order
  • Confirmed delivery schedule (ex-works / shipment date)
  • Any discrepancy in part number, quantity, or price

"""
    if notes:
        body += f"Additional Notes:\n{notes}\n\n"
    body += """Kindly acknowledge receipt and confirm within 3 business days.

Best regards,
K-MARIS Energy & Solutions Co., Ltd.
Email: sales@k-maris.com  |  www.k-maris.com
Engineering Reliability. Supplying Performance.
"""
    return body


def _build_vendor_po_email_ko(po, vendor, order, vessel, notes: str) -> str:
    """Korean purchase order email."""
    vendor_name = vendor.name if vendor else "Vendor"
    vessel_str = vessel.name if vessel else "—"
    body = f"""{vendor_name} 귀중

안녕하세요,
항상 협조해 주셔서 감사드립니다.

아래 선박용 부품에 대한 발주서를 첨부와 같이 송부드립니다.

발주번호 : {po.po_no}
오더참조 : {order.ord_no if order else '—'}
선박명   : {vessel_str}
발주일   : {po.date or date.today().isoformat()}

──────────────────────── 품목 리스트 ────────────────────────
{_po_item_lines(po.items, korean=True)}
──────────────────────────────────────────────────────────────

수령 후 아래 사항을 확인·회신해 주시기 바랍니다:
  • 본 발주 수락 여부
  • 확정 납기 (출고 예정일)
  • 품번·수량·단가 상이 여부

"""
    if notes:
        body += f"추가 사항:\n{notes}\n\n"
    body += """영업일 기준 3일 이내 수령 확인 및 회신 부탁드립니다.

감사합니다.
K-MARIS Energy & Solutions Co., Ltd.
Email: sales@k-maris.com  |  www.k-maris.com
Engineering Reliability. Supplying Performance.
"""
    return body


def _po_pdf_bytes(po, vendor, vessel):
    """발주서 PDF 생성. 실패 시 None."""
    try:
        payload = build_po_payload(
            po_no=po.po_no,
            date=po.date or date.today().isoformat(),
            vendor=vendor,
            vessel=vessel,
            items=po.items or [],
        )
        return generate_po_pdf(payload)
    except Exception as exc:  # noqa: BLE001
        st.warning(f"⚠️ 발주서 PDF 생성 실패: {exc}")
        return None


def _all_purchase_orders():
    s = get_session()
    try:
        return s.query(PurchaseOrder).order_by(PurchaseOrder.id.desc()).all()
    finally:
        s.close()


def _get_po(po_id: int):
    s = get_session()
    try:
        return s.query(PurchaseOrder).get(po_id)
    finally:
        s.close()





def render_vendor_po_create_tab() -> None:
    orders = order_list()
    if not orders:
        hint("등록된 오더가 없습니다. 먼저 'Customer P/O 신규 등록' 탭에서 수주를 등록하세요.")
    else:
        ord_opts = {}
        for o in orders:
            c = get_customer(o.customer_id)
            _rid = rfq_id_for_order(o)
            _status = pipeline_status_label(_rid) if _rid else o.status.value
            label = f"{o.ord_no} · {c.name if c else '—'} · {_status}"
            ord_opts[label] = o.id

        cur_id = st.session_state.get("ord_detail_id")
        labels = list(ord_opts.keys())
        default_idx = 0
        if cur_id in ord_opts.values():
            default_idx = list(ord_opts.values()).index(cur_id)

        sel_label = st.selectbox("대상 오더 선택", labels, index=default_idx, key="po_create_ord_sel")
        st.session_state["ord_detail_id"] = ord_opts[sel_label]

        order = get_order(int(st.session_state["ord_detail_id"]))
        if order:
            cust = get_customer(order.customer_id)
            vessel = get_vessel(order.vessel_id) if order.vessel_id else None
            st.markdown(
                f"**대상 오더:** `{order.ord_no}`  ·  {cust.name if cust else '—'}"
                f"  ·  {vessel.name if vessel else '—'}  ·  품목 {len(order.items or [])}개"
            )
            st.markdown("---")

            vendor_opts = vendor_options()
            # ── Vendor 선택 (폼 밖 — 수신 견적 단가 조회에 필요) ───────────────
            sel_vendor = st.selectbox(
                "Vendor 선택", ["— 없음 —"] + list(vendor_opts.keys()), key="po_vendor_sel"
            )
            vid = vendor_opts.get(sel_vendor) if sel_vendor != "— 없음 —" else None

            # ── 수신한 Vendor 견적 단가 참조 ─────────────────────────────────
            _seed_key = f"po_seed_{order.id}_{vid}" if vid else None
            if vid:
                _rfq_id = rfq_id_for_order(order)
                _vqs = vendor_quotes_for_rfq_vendor(_rfq_id, vid) if _rfq_id else []
                if _vqs:
                    # 견적이 여러 개면 어느 견적의 단가를 참조할지 선택 (기본=최신)
                    if len(_vqs) > 1:
                        _vq_opts = {
                            f"{q.received_date or '—'} · VQ#{q.id} · 품목 {len(q.items or [])}개": q.id
                            for q in _vqs
                        }
                        _sel_vq_label = st.selectbox(
                            f"참조할 Vendor 견적 ({len(_vqs)}건 수신 — 최신순)",
                            list(_vq_opts.keys()), key=f"po_vq_sel_{order.id}_{vid}",
                        )
                        _sel_vq = next((q for q in _vqs if q.id == _vq_opts[_sel_vq_label]), _vqs[0])
                    else:
                        _sel_vq = _vqs[0]

                    _price_map = price_map_from_quote(_sel_vq)
                    _hit = sum(1 for it in (order.items or [])
                               if str(it.get("part_no", "")).strip() in _price_map)
                    cols = st.columns([3, 2])
                    cols[0].caption(
                        f"📥 선택 견적(VQ#{_sel_vq.id}, {_sel_vq.received_date or '—'}) — "
                        f"단가 {len(_price_map)}개 보유 (주문 품목 중 {_hit}개 매칭)"
                    )
                    if cols[1].button("Vendor 수신 견적 단가 불러오기", key=f"po_loadvq_{order.id}_{vid}"):
                        merged = []
                        for it in (order.items or []):
                            row = dict(it)
                            pn = str(it.get("part_no", "")).strip()
                            if pn in _price_map:
                                row["unit_price"] = _price_map[pn]
                            merged.append(row)
                        st.session_state[_seed_key] = merged
                        st.rerun()
                elif _rfq_id is None:
                    st.caption("⚠️ 이 오더에 연결된 RFQ가 없어 Vendor 견적을 찾을 수 없습니다. "
                               "'Customer P/O 목록 → 오더 상세 → RFQ 연결'에서 먼저 연결하세요.")
                else:
                    st.caption("이 Vendor로부터 수신한 견적이 없습니다. 주문 단가로 발주서를 생성합니다.")

            # 견적 단가를 불러왔으면 그 값으로, 아니면 주문 품목으로 seed
            seed_items = st.session_state.get(_seed_key) if _seed_key else None
            if not seed_items:
                seed_items = order.items or []

            with st.form("po_form"):
                po_date = st.date_input("발주일", date.today(), key="po_date_input")
                po_items_df = st.data_editor(
                    pd.DataFrame(seed_items) if seed_items else pd.DataFrame(
                        columns=["item_no", "part_no", "description", "qty", "unit", "unit_price"]),
                    num_rows="dynamic", use_container_width=True, key=f"po_items_{order.id}_{vid}",
                )
                gen_po = st.form_submit_button("발주서 생성", type="primary")

            if gen_po and vid:
                po_no_gen = next_po_no()
                items_data = po_items_df.fillna("").to_dict(orient="records")
                session = get_session()
                try:
                    po = PurchaseOrder(
                        po_no=po_no_gen,
                        order_id=order.id,
                        vendor_id=vid,
                        date=po_date.isoformat(),
                        items=items_data,
                        status="발주완료",
                        # sent_date/sent_to_email은 실제 이메일 발송 성공 시에만 기록
                    )
                    session.add(po)
                    o = session.query(Order).get(order.id)
                    o.status = OrderStatus.PO_SENT
                    session.commit()
                    if _seed_key:
                        st.session_state.pop(_seed_key, None)
                    st.success(f"✅ 발주서 생성 완료: **{po_no_gen}**")
                    st.info("📨 '발주서 이메일 발송' 탭에서 Vendor에게 발주서를 송부할 수 있습니다.")
                finally:
                    session.close()
            elif gen_po and not vid:
                st.error("Vendor를 먼저 선택하세요.")

            # 이 오더로 발행된 발주서
            session = get_session()
            try:
                pos = session.query(PurchaseOrder).filter_by(order_id=order.id).all()
                if pos:
                    st.markdown("**발행된 발주서**")
                    po_rows = []
                    for po in pos:
                        v = get_vendor(po.vendor_id)
                        po_rows.append({
                            "PO No.": po.po_no, "Vendor": v.name if v else "—",
                            "발주일": po.date or "—", "상태": po.status,
                            "품목수": len(po.items or []),
                        })
                    st.dataframe(pd.DataFrame(po_rows), use_container_width=True, hide_index=True)
            finally:
                session.close()

    # ══════════════════════════════════════════════════════════════════════════════
    # TAB 2 — 발주서 이메일 발송 (발행된 발주서 대상)
    # ══════════════════════════════════════════════════════════════════════════════


def render_vendor_po_send_tab() -> None:
    pos = _all_purchase_orders()
    if not pos:
        hint("발행된 발주서가 없습니다. 먼저 '발주서 생성' 탭에서 발주서를 생성하세요.")
    else:
        po_opts = {}
        for po in pos:
            v = get_vendor(po.vendor_id)
            label = f"{po.po_no} · {v.name if v else '—'} · {po.status}"
            po_opts[label] = po.id

        sel_po_label = st.selectbox("발송할 발주서 선택", list(po_opts.keys()), key="po_send_sel")
        po = _get_po(int(po_opts[sel_po_label]))
        vendor = get_vendor(po.vendor_id) if po else None
        order = get_order(po.order_id) if po and po.order_id else None
        vessel = get_vessel(order.vessel_id) if order and order.vessel_id else None

        st.markdown(
            f"**발주서:** `{po.po_no}`  ·  {vendor.name if vendor else '—'}"
            f"  ·  오더 {order.ord_no if order else '—'}  ·  품목 {len(po.items or [])}개"
        )
        st.markdown("---")

        _preview_key = f"po_email_preview_{po.id}"

        if not st.session_state.get(_preview_key):
            lang_sel = st.radio(
                "이메일 언어", ["🇺🇸 English (영문)", "🇰🇷 Korean (국문)"],
                horizontal=True, key=f"po_lang_{po.id}",
            )
            po_notes = st.text_area("Vendor에게 전달할 메모", height=80, key=f"po_notes_{po.id}")

            if st.button("이메일 미리보기", type="secondary", key=f"po_preview_btn_{po.id}"):
                is_korean = "Korean" in lang_sel
                if is_korean:
                    subject = f"[K-MARIS] 발주서 송부 — {po.po_no} / {vessel.name if vessel else po.po_no}"
                    body = _build_vendor_po_email_ko(po, vendor, order, vessel, po_notes)
                else:
                    subject = f"[K-MARIS] Purchase Order — {po.po_no} / {vessel.name if vessel else po.po_no}"
                    body = _build_vendor_po_email(po, vendor, order, vessel, po_notes)
                pdf_bytes = _po_pdf_bytes(po, vendor, vessel)
                st.session_state[_preview_key] = {
                    "vendor_email": (vendor.email or "") if vendor else "",
                    "lang": lang_sel,
                    "subject": subject,
                    "body": body,
                    "pdf_bytes": pdf_bytes,
                    "pdf_filename": f"{po.po_no}_PurchaseOrder.pdf",
                }
                st.rerun()
        else:
            prev = st.session_state[_preview_key]
            lang_badge = "🇰🇷 국문" if "Korean" in prev.get("lang", "") else "🇺🇸 영문"
            st.info("📧 아래 이메일을 검토·수정 후 발송하세요. 실제 발송에 성공해야 '발신 내역'에 기록됩니다.")

            email_label = prev["vendor_email"] or "⚠️ 이메일 주소 없음"
            with st.expander(f"{vendor.name if vendor else '—'}  ({email_label})  [{lang_badge}]", expanded=True):
                to_email = st.text_input("수신자 이메일", value=prev["vendor_email"], key=f"po_to_{po.id}")
                subj_col, pdf_col = st.columns([3, 1])
                subject = subj_col.text_input("제목", value=prev["subject"], key=f"po_subj_{po.id}")
                if prev.get("pdf_bytes"):
                    pdf_col.markdown("<br>", unsafe_allow_html=True)
                    pdf_col.download_button(
                        label="📥 발주서 (.pdf)",
                        data=prev["pdf_bytes"],
                        file_name=prev["pdf_filename"],
                        mime="application/pdf",
                        key=f"po_pdf_{po.id}",
                        use_container_width=True,
                        help="Vendor에게 발송되는 발주서 PDF입니다. 이메일 발송 시 자동 첨부됩니다.",
                    )
                body = st.text_area("본문 (직접 수정 가능)", value=prev["body"], height=340, key=f"po_body_{po.id}")

            _smtp_ok = bool(os.getenv("SMTP_USER") and os.getenv("SMTP_PASSWORD"))
            if not _smtp_ok:
                st.warning(
                    "⚠️ SMTP 미설정: 이메일을 발송할 수 없습니다. "
                    "Settings > Secrets에 SMTP_USER / SMTP_PASSWORD를 등록하세요."
                )

            col_send, col_cancel, _ = st.columns([2, 1, 4])
            _send_disabled = (not to_email) or (not _smtp_ok)
            if col_send.button("이메일 발송", type="primary", use_container_width=True,
                               disabled=_send_disabled, key=f"po_send_btn_{po.id}"):
                attachments = None
                if prev.get("pdf_bytes"):
                    attachments = [(prev["pdf_filename"], prev["pdf_bytes"])]
                sent_ok = send_email(to=to_email, subject=subject, body=body, attachments=attachments)
                if sent_ok:
                    session = get_session()
                    try:
                        p = session.query(PurchaseOrder).get(po.id)
                        p.status = "이메일 발송완료"
                        p.sent_to_email = to_email
                        p.sent_date = date.today().isoformat()
                        session.commit()
                    finally:
                        session.close()
                    st.success(f"✅ 발주서 {po.po_no} 이메일 발송 완료 → {to_email}")
                    st.session_state.pop(_preview_key, None)
                    st.rerun()
                else:
                    st.error("❌ 이메일 발송 실패 — SMTP 서버 오류. 발신 내역에 기록되지 않았습니다.")

            if col_cancel.button("취소", use_container_width=True, key=f"po_cancel_{po.id}"):
                st.session_state.pop(_preview_key, None)
                st.rerun()

    # ══════════════════════════════════════════════════════════════════════════════
    # TAB 3 — 발신 내역 (실제 이메일이 발송된 발주서만)
    # ══════════════════════════════════════════════════════════════════════════════


def render_vendor_po_sent_tab() -> None:
    st.caption("실제로 이메일이 발송된 발주서만 표시됩니다. (생성만 하고 미발송한 발주서는 제외)")
    pos = [p for p in _all_purchase_orders() if p.status == "이메일 발송완료"]
    if not pos:
        hint("아직 이메일로 발송된 발주서가 없습니다. '발주서 이메일 발송' 탭에서 발송하세요.")
    else:
        rows = []
        for po in pos:
            v = get_vendor(po.vendor_id)
            o = get_order(po.order_id) if po.order_id else None
            _rid = rfq_id_for_order(o) if o else None
            rows.append({
                "PO No.": po.po_no,
                "오더 No.": o.ord_no if o else "—",
                "Vendor": v.name if v else "—",
                "수신자 이메일": po.sent_to_email or "—",  # 실제 발송 주소만 (마스터 이메일 폴백 없음)
                "발송일": po.sent_date or "—",
                "상태": pipeline_status_label(_rid) if _rid else po.status,
                "품목수": len(po.items or []),
            })
        st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)




def render_vendor_po_tabs() -> None:
    tab_create, tab_send, tab_sent = st.tabs([
        "🧾 발주서 생성", "📨 발주서 이메일 발송", "📜 발신 내역"
    ])
    with tab_create:
        render_vendor_po_create_tab()
    with tab_send:
        render_vendor_po_send_tab()
    with tab_sent:
        render_vendor_po_sent_tab()


def render_vendor_po_page() -> None:
    require_auth()
    inject_css()
    section_header("send", "Vendor P/O 발신 (Purchase Order)")
    render_vendor_po_tabs()


if __name__ == "__main__":
    try:
        st.set_page_config(page_title="Vendor P/O 발신 — KTMS", page_icon="📨", layout="wide")
    except Exception:
        pass
    render_vendor_po_page()
