"""Vendor RFQ 발신 — compose & send vendor RFQs for a selected customer RFQ, track sent VRFQs."""
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
    inject_css, hint, section_header, next_doc_no,
    vendor_options, rfq_list, get_rfq, get_customer, get_vessel, get_vendor,
    vrfq_list_for_rfq, vendor_quotes_for_vrfq, pipeline_status_label,
)
from db.engine import get_session
from db.models import RFQ, VendorRFQ, RFQStatus
from services.email_svc import send_email
from services.vendor_xlsx import make_vendor_rfq_quote_xlsx


def _build_vendor_rfq_email(rfq, cust, vessel, vendor, notes: str) -> str:
    """English vendor RFQ inquiry email."""
    items = rfq.items or []
    item_lines = "\n".join(
        f"  {i+1:>2}. Part No.: {str(item.get('part_no','—')):<20s}"
        f"  Qty: {item.get('qty','—')} {item.get('unit',''):<5s}"
        f"  Maker: {item.get('maker','—')}\n"
        f"       Desc: {item.get('description','—')}"
        for i, item in enumerate(items)
    )
    vendor_name = vendor.name if vendor else "Vendor"
    vessel_str = vessel.name if vessel else "—"
    cust_str = cust.name if cust else "—"

    body = f"""Dear {vendor_name},

We would like to request your best quotation for the following marine spare parts.

RFQ Reference : {rfq.rfq_no}
Vessel        : {vessel_str}
End Customer  : {cust_str}
Enquiry Date  : {rfq.date or date.today().isoformat()}

──────────────────────── ITEM LIST ────────────────────────
{item_lines}
────────────────────────────────────────────────────────────

Please quote for each item:
  • Unit price (USD, CNF Busan port)
  • Lead time
  • Country of origin / Manufacturer
  • Technical remarks or alternatives (if any)

"""
    if notes:
        body += f"Additional Notes:\n{notes}\n\n"

    body += """Kindly reply within 5 business days.

Best regards,
K-MARIS Energy & Solutions Co., Ltd.
Email: sales@k-maris.com  |  www.k-maris.com
Engineering Reliability. Supplying Performance.
"""
    return body


def _build_vendor_rfq_email_ko(rfq, cust, vessel, vendor, notes: str) -> str:
    """Korean vendor RFQ inquiry email."""
    items = rfq.items or []
    item_lines = "\n".join(
        f"  {i+1:>2}. Part No.: {str(item.get('part_no','—')):<20s}"
        f"  수량: {item.get('qty','—')} {item.get('unit',''):<5s}"
        f"  Maker: {item.get('maker','—')}\n"
        f"       품명: {item.get('description','—')}"
        for i, item in enumerate(items)
    )
    vendor_name = vendor.name if vendor else "Vendor"
    vessel_str = vessel.name if vessel else "—"
    cust_str = cust.name if cust else "—"

    body = f"""{vendor_name} 귀중

안녕하세요,
항상 협조해 주셔서 감사드립니다.

아래 선박용 부품에 대한 견적을 요청드립니다.

RFQ 번호 : {rfq.rfq_no}
선박명    : {vessel_str}
발주처    : {cust_str}
문의일    : {rfq.date or date.today().isoformat()}

──────────────────────── 품목 리스트 ────────────────────────
{item_lines}
──────────────────────────────────────────────────────────────

각 품목에 대해 아래 사항을 포함하여 견적을 회신해 주시기 바랍니다:
  • 단가 (USD, CNF 부산항 기준)
  • 납기
  • 원산지 / 제조사
  • 기술적 비고 또는 대체품 (해당 시)

"""
    if notes:
        body += f"추가 사항:\n{notes}\n\n"

    body += """영업일 기준 5일 이내 회신 부탁드립니다.

감사합니다.
K-MARIS Energy & Solutions Co., Ltd.
Email: sales@k-maris.com  |  www.k-maris.com
Engineering Reliability. Supplying Performance.
"""
    return body


# 페이지 셋업(set_page_config/require_auth/inject_css/section_header)은 통합 페이지
# rfq_quotation.py 에서 처리한다. 이 모듈은 탭별 render 함수만 노출한다.


# ══════════════════════════════════════════════════════════════════════════════
# TAB — Vendor RFQ 작성·발신 (선택한 Customer RFQ 대상)
# ══════════════════════════════════════════════════════════════════════════════
def render_vrfq_send():
    rfqs = rfq_list()
    if not rfqs:
        hint("먼저 'Customer RFQ 수신' 메뉴에서 RFQ를 등록하세요.")
        return

    # 대상 Customer RFQ 선택 (다른 페이지에서 선택한 RFQ를 기본값으로)
    rfq_label_map = {}
    for r in rfqs:
        c = get_customer(r.customer_id)
        v = get_vessel(r.vessel_id) if r.vessel_id else None
        label = (
            f"{r.rfq_no}  |  {c.name if c else '—'}"
            f"  |  {v.name if v else '—'}  |  {pipeline_status_label(r.id)}"
        )
        rfq_label_map[label] = r.id

    labels = list(rfq_label_map.keys())
    _presel = st.session_state.get("rfq_detail_id")
    default_idx = 0
    if _presel:
        for i, rid in enumerate(rfq_label_map.values()):
            if rid == _presel:
                default_idx = i
                break

    sel_label = st.selectbox("대상 Customer RFQ 선택", labels, index=default_idx,
                             key="vrfq_send_rfq_sel")
    rfq_id = rfq_label_map[sel_label]
    st.session_state["rfq_detail_id"] = rfq_id  # 다른 페이지와 선택 동기화

    rfq = get_rfq(rfq_id)
    cust = get_customer(rfq.customer_id)
    vessel = get_vessel(rfq.vessel_id) if rfq.vessel_id else None

    st.markdown(
        f"**대상 RFQ:** `{rfq.rfq_no}`  ·  {cust.name if cust else '—'}"
        f"  ·  {vessel.name if vessel else '—'}  ·  품목 {len(rfq.items or [])}개"
    )
    st.markdown("---")

    _preview_key = f"vrfq_preview_{rfq.id}"
    vendor_opts = vendor_options()

    if not vendor_opts:
        st.warning("Vendor를 먼저 등록하세요 (⚙️ 설정).")

    elif not st.session_state.get(_preview_key):
        sel_vendors = st.multiselect(
            "Vendor 선택", list(vendor_opts.keys()), key=f"vrfq_sel_{rfq.id}"
        )
        lang_sel = st.radio(
            "이메일 언어",
            ["🇺🇸 English (영문)", "🇰🇷 Korean (국문)"],
            horizontal=True,
            key=f"vrfq_lang_{rfq.id}",
        )
        vrfq_notes = st.text_area(
            "Vendor에게 전달할 메모", height=80, key=f"vrfq_notes_{rfq.id}"
        )

        if st.button(
            "이메일 미리보기",
            disabled=not sel_vendors,
            type="secondary",
            use_container_width=False,
        ):
            is_korean = "Korean" in lang_sel
            previews = []
            for vname in sel_vendors:
                vid = vendor_opts[vname]
                v = get_vendor(vid)
                xlsx_bytes = make_vendor_rfq_quote_xlsx(
                    rfq_no=rfq.rfq_no,
                    vessel_name=vessel.name if vessel else "—",
                    customer_name=cust.name if cust else "—",
                    enquiry_date=rfq.date or date.today().isoformat(),
                    vendor_name=vname,
                    items=rfq.items or [],
                )
                safe_vname = "".join(c for c in vname if c.isalnum() or c in "._- ")[:40]
                if is_korean:
                    subject = f"[K-MARIS] 견적 요청 — {rfq.rfq_no} / {vessel.name if vessel else rfq.rfq_no}"
                    body = _build_vendor_rfq_email_ko(rfq, cust, vessel, v, vrfq_notes)
                else:
                    subject = f"[K-MARIS] Inquiry — {rfq.rfq_no} / {vessel.name if vessel else rfq.rfq_no}"
                    body = _build_vendor_rfq_email(rfq, cust, vessel, v, vrfq_notes)
                previews.append({
                    "vendor_name": vname,
                    "vendor_id": vid,
                    "vendor_email": (v.email or "") if v else "",
                    "lang": lang_sel,
                    "subject": subject,
                    "body": body,
                    "xlsx_bytes": xlsx_bytes,
                    "xlsx_filename": f"{rfq.rfq_no}_VendorQuoteSheet_{safe_vname}.xlsx",
                })
            st.session_state[_preview_key] = previews
            st.rerun()

    else:
        previews = st.session_state[_preview_key]
        st.info(
            f"📧 아래 {len(previews)}개 이메일을 검토·수정 후 발송하세요. "
            "이메일 주소가 없으면 DB 저장만 됩니다."
        )

        edited = []
        for i, prev in enumerate(previews):
            email_label = prev["vendor_email"] or "⚠️ 이메일 주소 없음"
            lang_badge = "🇰🇷 국문" if "Korean" in prev.get("lang", "") else "🇺🇸 영문"
            with st.expander(f"{prev['vendor_name']}  ({email_label})  [{lang_badge}]", expanded=True):
                to_email = st.text_input(
                    "수신자 이메일", value=prev["vendor_email"], key=f"vrfq_to_{rfq.id}_{i}"
                )
                subj_col, xlsx_col = st.columns([3, 1])
                subject = subj_col.text_input(
                    "제목", value=prev["subject"], key=f"vrfq_subj_{rfq.id}_{i}"
                )
                if prev.get("xlsx_bytes"):
                    xlsx_col.markdown("<br>", unsafe_allow_html=True)
                    xlsx_col.download_button(
                        label="📥 견적서 양식 (.xlsx)",
                        data=prev["xlsx_bytes"],
                        file_name=prev["xlsx_filename"],
                        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        key=f"vrfq_xlsx_{rfq.id}_{i}",
                        use_container_width=True,
                        help="Vendor가 단가·납기 등을 기입해서 반환하는 Excel 양식입니다. 이메일 발송 시 자동 첨부됩니다.",
                    )
                body = st.text_area(
                    "본문 (직접 수정 가능)", value=prev["body"],
                    height=340, key=f"vrfq_body_{rfq.id}_{i}"
                )
            edited.append({
                **prev,
                "to_email": to_email,
                "subject": subject,
                "body": body,
            })

        _smtp_ok = bool(os.getenv("SMTP_USER") and os.getenv("SMTP_PASSWORD"))
        if not _smtp_ok:
            st.warning(
                "⚠️ SMTP 미설정: 이메일이 발송되지 않습니다. "
                "Settings > Secrets에 SMTP_USER / SMTP_PASSWORD를 등록하세요. "
                "DB 저장만 진행됩니다."
            )

        col_send, col_cancel, _ = st.columns([2, 1, 4])
        if col_send.button("발송 + DB 저장", type="primary", use_container_width=True):
            session = get_session()
            try:
                sent_ok, sent_fail, saved = 0, 0, 0
                for e in edited:
                    vrfq_no = next_doc_no("vendor_rfq")
                    vrfq = VendorRFQ(
                        vrfq_no=vrfq_no,
                        rfq_id=rfq.id,
                        vendor_id=e["vendor_id"],
                        sent_date=date.today().isoformat(),
                        sent_to_email=e["to_email"] or "",
                        status="발송됨",
                        items=rfq.items or [],
                    )
                    session.add(vrfq)
                    saved += 1

                    if e["to_email"] and _smtp_ok:
                        attachments = None
                        if e.get("xlsx_bytes"):
                            attachments = [(e["xlsx_filename"], e["xlsx_bytes"])]
                        ok = send_email(
                            to=e["to_email"],
                            subject=e["subject"],
                            body=e["body"],
                            attachments=attachments,
                        )
                        if ok:
                            sent_ok += 1
                            vrfq.status = "이메일 발송완료"
                        else:
                            sent_fail += 1
                            st.warning(f"⚠️ {e['vendor_name']} SMTP 발송 실패 — 서버 오류")

                r = session.query(RFQ).get(rfq.id)
                r.status = RFQStatus.SOURCING
                session.commit()
                st.success(
                    f"✅ DB 저장 {saved}건 완료"
                    + (f" | 이메일 발송 성공 {sent_ok}건" if sent_ok else "")
                    + (f" | 실패 {sent_fail}건" if sent_fail else "")
                )
                st.session_state.pop(_preview_key, None)
                st.rerun()
            finally:
                session.close()

        if col_cancel.button("취소", use_container_width=True):
            st.session_state.pop(_preview_key, None)
            st.rerun()

    # ── 이 RFQ로 발송된 Vendor RFQ ────────────────────────────────────────────
    vrfqs = vrfq_list_for_rfq(rfq.id)
    if vrfqs:
        st.markdown("**이 RFQ로 발송된 Vendor RFQ**")
        vrows = []
        for vr in vrfqs:
            v = get_vendor(vr.vendor_id)
            existing_quotes = vendor_quotes_for_vrfq(vr.id)
            vrows.append({
                "VRFQ No.": vr.vrfq_no,
                "Vendor": v.name if v else "—",
                "수신자 이메일": getattr(vr, "sent_to_email", None) or (v.email if v else "—") or "—",
                "발송일": vr.sent_date or "—",
                "상태": vr.status,
                "수신된 견적": f"{len(existing_quotes)}건",
            })
        st.dataframe(pd.DataFrame(vrows), use_container_width=True, hide_index=True)
        hint("Vendor 견적을 받으셨나요? 'Vendor Quotation 수신' 메뉴에서 등록하세요.")

# ══════════════════════════════════════════════════════════════════════════════
# TAB — Vendor RFQ 발신 내역 (전체 VRFQ)
# ══════════════════════════════════════════════════════════════════════════════
def render_vrfq_sent():
    _s = get_session()
    try:
        all_vrfqs = _s.query(VendorRFQ).order_by(VendorRFQ.id.desc()).all()
    finally:
        _s.close()

    if not all_vrfqs:
        hint("아직 발송된 Vendor RFQ가 없습니다. 좌측 'Vendor RFQ 작성·발신' 탭에서 발송하세요.")
    else:
        rows = []
        for vr in all_vrfqs:
            v = get_vendor(vr.vendor_id)
            rfq_obj = get_rfq(vr.rfq_id)
            qs = vendor_quotes_for_vrfq(vr.id)
            rows.append({
                "ID": vr.id,
                "VRFQ No.": vr.vrfq_no,
                "Customer RFQ": rfq_obj.rfq_no if rfq_obj else "—",
                "Vendor": v.name if v else "—",
                "수신자 이메일": vr.sent_to_email or (v.email if v else "—") or "—",
                "발송일": vr.sent_date or "—",
                "상태": vr.status,
                "수신된 견적 수": len(qs),
            })

        df = pd.DataFrame(rows)
        selected = st.dataframe(
            df.drop(columns=["ID"]),
            use_container_width=True,
            hide_index=True,
            selection_mode="single-row",
            on_select="rerun",
        )
        sel_rows = selected.selection.rows if hasattr(selected, "selection") else []
        if sel_rows:
            sel_vrfq_id = int(df.iloc[sel_rows[0]]["ID"])
            st.session_state["vrfq_detail_id"] = sel_vrfq_id
            hint(f"VRFQ ID {sel_vrfq_id} 선택됨 — 'Vendor Quotation 수신' 메뉴에서 견적을 등록하세요.")
