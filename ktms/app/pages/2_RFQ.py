"""RFQ Management — receive, register, send to vendors, track status."""
from __future__ import annotations
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pandas as pd
import streamlit as st
from app.utils.auth import require_auth, current_user
from app.utils.helpers import (
    inject_css, hint, section_header, next_doc_no, status_badge, tracking_url,
    customer_options, vessel_options, vendor_options,
    rfq_list, get_rfq, get_customer, get_vessel, get_vendor, NAVY, BLUE,
)
from db.engine import get_session
from db.models import RFQ, VendorRFQ, RFQStatus, FollowUpLevel, Customer, Vessel
from services.email_svc import send_email
from services.vendor_xlsx import make_vendor_rfq_quote_xlsx
from services.sheets_svc import upsert_rfq as _sheet_upsert_rfq


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
    vendor_name = vendor.name if vendor else "공급사"
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

try:
    st.set_page_config(page_title="RFQ 관리 — KTMS", page_icon="📋", layout="wide")
except Exception:
    pass
require_auth()
inject_css()

section_header("rfq", "RFQ 관리")

tab_list, tab_new, tab_detail = st.tabs(["RFQ 리스트", "신규 RFQ 등록", "RFQ 상세"])

# ══════════════════════════════════════════════════════════════════════════════
# TAB 1 — LIST
# ══════════════════════════════════════════════════════════════════════════════
with tab_list:
    col_f1, col_f2, col_f3 = st.columns([2, 2, 1])
    with col_f1:
        status_filter = st.selectbox("상태 필터", ["전체"] + [s.value for s in RFQStatus])
    with col_f2:
        cust_opts = {"전체": None, **customer_options()}
        cust_sel = st.selectbox("고객사 필터", list(cust_opts.keys()))
    with col_f3:
        st.markdown("<br>", unsafe_allow_html=True)
        refresh = st.button("새로고침", use_container_width=True)

    rfqs = rfq_list(None if status_filter == "전체" else status_filter)
    if cust_sel != "전체" and cust_opts[cust_sel]:
        rfqs = [r for r in rfqs if r.customer_id == cust_opts[cust_sel]]

    if rfqs:
        rows = []
        for r in rfqs:
            c = get_customer(r.customer_id)
            v = get_vessel(r.vessel_id) if r.vessel_id else None
            rows.append({
                "ID": r.id,
                "RFQ No.": r.rfq_no,
                "고객사": c.name if c else "—",
                "선박": v.name if v else "—",
                "품목수": len(r.items or []),
                "Level": r.follow_up_level.value if r.follow_up_level else "—",
                "상태": r.status.value,
                "날짜": r.date or "—",
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
            sel_id = df.iloc[sel_rows[0]]["ID"]
            st.session_state["rfq_detail_id"] = int(sel_id)
            hint(f"RFQ ID {sel_id} 선택됨 — '🔍 RFQ 상세' 탭에서 확인하세요.")
    else:
        hint("등록된 RFQ가 없습니다.")

# ══════════════════════════════════════════════════════════════════════════════
# TAB 2 — NEW RFQ
# ══════════════════════════════════════════════════════════════════════════════
with tab_new:
    st.subheader("신규 RFQ 등록")

    # ── PDF 자동 입력 ────────────────────────────────────────────────────────
    with st.expander("PDF로 자동 입력 (AI OCR)", expanded=False):
        pdf_file = st.file_uploader(
            "RFQ PDF 파일 업로드", type=["pdf"], key="rfq_pdf_uploader",
            help="PDF를 업로드하면 AI가 고객사·선박·품목 정보를 자동으로 인식합니다.",
        )
        if pdf_file:
            if st.button("AI로 정보 추출", key="btn_rfq_ocr", type="secondary"):
                with st.spinner("AI가 PDF를 분석하고 있습니다..."):
                    try:
                        from services.pdf_parser import extract_text_from_pdf, parse_rfq_fields
                        raw_text = extract_text_from_pdf(pdf_file)
                        if not raw_text:
                            st.warning("PDF에서 텍스트를 추출할 수 없습니다. 스캔 이미지 PDF는 지원되지 않습니다.")
                        else:
                            cust_names = list(customer_options().keys())
                            result = parse_rfq_fields(raw_text, cust_names)
                            st.session_state["rfq_ocr"] = result
                    except ImportError:
                        st.error("pdfplumber 또는 anthropic 패키지가 설치되지 않았습니다. requirements.txt를 확인하세요.")
                    except Exception as exc:
                        st.error(f"추출 실패: {exc}")

        ocr_data = st.session_state.get("rfq_ocr", {})
        if ocr_data and not ocr_data.get("_error"):
            st.success("추출 완료! 아래 폼에 자동으로 반영됩니다. 내용을 검토하고 수정 후 등록하세요.")
            col_p1, col_p2 = st.columns(2)
            col_p1.markdown(f"**선박:** {ocr_data.get('vessel_name') or '—'}")
            col_p1.markdown(f"**날짜:** {ocr_data.get('rfq_date') or '—'}")
            col_p2.markdown(f"**고객사 힌트:** {ocr_data.get('customer_hint') or '—'}")
            if ocr_data.get("notes"):
                st.caption(f"비고: {ocr_data['notes']}")
            ocr_items_preview = ocr_data.get("items") or []
            if ocr_items_preview:
                st.markdown(f"**인식된 품목 ({len(ocr_items_preview)}건)**")
                st.dataframe(pd.DataFrame(ocr_items_preview), use_container_width=True, hide_index=True)
            if st.button("OCR 초기화", key="btn_clear_ocr"):
                st.session_state.pop("rfq_ocr", None)
                st.rerun()

    # ── OCR 결과 및 매칭 상태 계산 ──────────────────────────────────────────
    ocr = st.session_state.get("rfq_ocr", {})
    _cust_hint_raw = ocr.get("customer_hint") or ""
    _vessel_hint_raw = ocr.get("vessel_name") or ""

    _cust_opts_now = customer_options()
    _vessel_opts_all = vessel_options()

    def _hint_matched(hint: str, options: dict) -> bool:
        if not hint:
            return True
        h = hint.lower()
        return any(h in k.lower() or k.lower() in h for k in options)

    _cust_matched = _hint_matched(_cust_hint_raw, _cust_opts_now)
    _vessel_matched = _hint_matched(_vessel_hint_raw, _vessel_opts_all)

    # ── 신규 고객사 빠른 등록 ────────────────────────────────────────────────
    _cust_expand = bool(_cust_hint_raw) and not _cust_matched
    with st.expander("신규 고객사 빠른 등록", expanded=_cust_expand):
        if _cust_expand:
            st.info(f'OCR 인식: **"{_cust_hint_raw}"** — DB에 없는 고객사입니다. 등록 후 자동 선택됩니다.')
        nc1, nc2 = st.columns(2)
        nc_name    = nc1.text_input("고객사명 *", value=_cust_hint_raw, key="nc_name")
        nc_country = nc2.text_input("국가", key="nc_country")
        nc_contact = nc1.text_input("담당자", key="nc_contact")
        nc_email   = nc2.text_input("이메일", key="nc_email")
        nc_addr    = nc1.text_input("주소", key="nc_addr")
        nc_taxid   = nc2.text_input("Tax ID / 사업자번호", key="nc_taxid")
        if st.button("고객사 등록", key="btn_quick_cust", type="primary"):
            if nc_name.strip():
                _s = get_session()
                try:
                    _s.add(Customer(name=nc_name.strip(), country=nc_country,
                                    contact=nc_contact, email=nc_email,
                                    address=nc_addr, tax_id=nc_taxid))
                    _s.commit()
                    st.success(f"✅ 고객사 '{nc_name.strip()}' 등록 완료! 아래 드롭다운에 반영됩니다.")
                    st.rerun()
                finally:
                    _s.close()
            else:
                st.warning("고객사명을 입력하세요.")

    # ── 신규 선박 빠른 등록 ──────────────────────────────────────────────────
    _cust_opts_now2 = customer_options()   # 고객사 등록 후 갱신
    _vessel_expand = bool(_vessel_hint_raw) and not _vessel_matched
    with st.expander("신규 선박 빠른 등록", expanded=_vessel_expand):
        if _vessel_expand:
            st.info(f'OCR 인식: **"{_vessel_hint_raw}"** — DB에 없는 선박입니다. 등록 후 자동 선택됩니다.')
        nv_name   = st.text_input("선박명 *", value=_vessel_hint_raw, key="nv_name")
        nv1, nv2  = st.columns(2)
        nv_imo    = nv1.text_input("IMO No.", key="nv_imo")
        nv_engine = nv2.text_input("Main Engine Type", key="nv_engine")
        nv_hull   = nv1.text_input("Hull No.", key="nv_hull")
        _owner_opts = {"— 없음 —": None, **_cust_opts_now2}
        # OCR 고객사 힌트로 선주 자동 매칭
        _owner_idx = 0
        if _cust_hint_raw:
            for i, k in enumerate(_owner_opts):
                if _cust_hint_raw.lower() in k.lower() or k.lower() in _cust_hint_raw.lower():
                    _owner_idx = i
                    break
        nv_owner  = nv2.selectbox("선주 (고객사)", list(_owner_opts.keys()),
                                   index=_owner_idx, key="nv_owner")
        if st.button("선박 등록", key="btn_quick_vessel", type="primary"):
            if nv_name.strip():
                _s = get_session()
                try:
                    _s.add(Vessel(name=nv_name.strip(), imo=nv_imo,
                                  engine_type=nv_engine, hull_no=nv_hull,
                                  customer_id=_owner_opts.get(nv_owner)))
                    _s.commit()
                    st.success(f"✅ 선박 '{nv_name.strip()}' 등록 완료! 아래 드롭다운에 반영됩니다.")
                    st.rerun()
                finally:
                    _s.close()
            else:
                st.warning("선박명을 입력하세요.")

    # ── 폼 기본값 계산 ───────────────────────────────────────────────────────
    _ocr_date = date.today()
    if ocr.get("rfq_date"):
        try:
            from datetime import datetime as _dt
            _ocr_date = _dt.strptime(ocr["rfq_date"], "%Y-%m-%d").date()
        except ValueError:
            pass

    _item_cols = ["part_no", "description", "maker", "qty", "unit", "lead_time_req", "remark"]
    _ocr_items = ocr.get("items") or []
    _default_items = (
        pd.DataFrame(_ocr_items).reindex(columns=_item_cols).fillna("")
        if _ocr_items else pd.DataFrame(columns=_item_cols)
    )

    # ── 등록 폼 ──────────────────────────────────────────────────────────────
    with st.form("new_rfq_form"):
        c1, c2 = st.columns(2)
        with c1:
            cust_opts2 = customer_options()
            if cust_opts2:
                cust_keys = list(cust_opts2.keys())
                _cust_hint = _cust_hint_raw.lower()
                _cust_idx = 0
                if _cust_hint:
                    for i, k in enumerate(cust_keys):
                        if _cust_hint in k.lower() or k.lower() in _cust_hint:
                            _cust_idx = i
                            break
                cust_name = st.selectbox("고객사 *", cust_keys, index=_cust_idx)
                cust_id = cust_opts2[cust_name]
            else:
                hint("위 '신규 고객사 빠른 등록'에서 먼저 등록하세요.")
                cust_id = None
            rfq_date = st.date_input("RFQ 수신일", value=_ocr_date)
            follow_level = st.selectbox("Follow-up Level", [l.value for l in FollowUpLevel], index=1)
        with c2:
            vessel_opts = vessel_options(cust_id)
            vessel_keys = ["— 없음 —"] + list(vessel_opts.keys())
            _vessel_hint = _vessel_hint_raw.lower()
            _vessel_idx = 0
            if _vessel_hint:
                for i, k in enumerate(vessel_keys):
                    if _vessel_hint in k.lower() or k.lower() in _vessel_hint:
                        _vessel_idx = i
                        break
            vessel_sel = st.selectbox("선박 (선택)", vessel_keys, index=_vessel_idx)
            vessel_id = vessel_opts.get(vessel_sel) if vessel_sel != "— 없음 —" else None
            notes = st.text_area("비고 / 고객 요청사항", value=ocr.get("notes") or "", height=96)

        st.markdown("**품목 리스트**")
        items_df = st.data_editor(
            _default_items, num_rows="dynamic", use_container_width=True,
            column_config={
                "qty": st.column_config.NumberColumn("qty", min_value=0, step=1),
            },
            key="new_rfq_items",
        )
        submitted = st.form_submit_button("RFQ 등록", type="primary", use_container_width=True)

    if submitted and cust_id:
        items_data = items_df.fillna("").to_dict(orient="records")
        rfq_no = next_doc_no("rfq")
        session = get_session()
        try:
            rfq = RFQ(
                rfq_no=rfq_no,
                customer_id=cust_id,
                vessel_id=vessel_id,
                date=rfq_date.isoformat(),
                status=RFQStatus.RECEIVED,
                follow_up_level=FollowUpLevel(follow_level),
                items=items_data,
                notes=notes,
                created_by=current_user()["id"],
            )
            session.add(rfq)
            session.commit()
            st.success(f"✅ RFQ 등록 완료: **{rfq_no}**")
            t_url = tracking_url("rfq", rfq.tracking_token)
            st.info(f"🔗 고객 트래킹 링크: {t_url}")
            _sheet_upsert_rfq(rfq, get_customer(rfq.customer_id), get_vessel(rfq.vessel_id) if rfq.vessel_id else None)
            st.session_state.pop("rfq_ocr", None)
        finally:
            session.close()

# ══════════════════════════════════════════════════════════════════════════════
# TAB 3 — DETAIL
# ══════════════════════════════════════════════════════════════════════════════
with tab_detail:
    rfq_id = st.session_state.get("rfq_detail_id")
    if not rfq_id:
        hint("RFQ 리스트에서 항목을 선택하거나 직접 ID를 입력하세요.")
        rfq_id = st.number_input("RFQ ID", min_value=1, step=1, value=1)
        if not st.button("불러오기"):
            st.stop()

    rfq = get_rfq(int(rfq_id))
    if not rfq:
        st.error("해당 RFQ를 찾을 수 없습니다.")
        st.stop()

    cust = get_customer(rfq.customer_id)
    vessel = get_vessel(rfq.vessel_id) if rfq.vessel_id else None

    col_info, col_actions = st.columns([3, 1])
    with col_info:
        st.markdown(f"### {rfq.rfq_no}")
        c1, c2, c3 = st.columns(3)
        c1.metric("고객사", cust.name if cust else "—")
        c2.metric("선박", vessel.name if vessel else "—")
        c3.metric("품목수", len(rfq.items or []))
        st.markdown(f"**상태:** {status_badge(rfq.status.value)}&nbsp;&nbsp;"
                    f"**Follow-up:** <span class='badge-{rfq.follow_up_level.value}'>{rfq.follow_up_level.value}</span>"
                    f"&nbsp;&nbsp;**날짜:** {rfq.date}", unsafe_allow_html=True)
        if rfq.notes:
            st.caption(f"비고: {rfq.notes}")

        # Tracking link
        t_url = tracking_url("rfq", rfq.tracking_token)
        st.markdown(f"🔗 **고객 트래킹 링크:** [{t_url}]({t_url})")

    with col_actions:
        st.markdown("**액션**")
        # Status update
        new_status = st.selectbox("상태 변경", [s.value for s in RFQStatus],
                                  index=[s.value for s in RFQStatus].index(rfq.status.value))
        if st.button("상태 업데이트"):
            session = get_session()
            try:
                r = session.query(RFQ).get(rfq.id)
                r.status = RFQStatus(new_status)
                session.commit()
                _sheet_upsert_rfq(r, get_customer(r.customer_id), get_vessel(r.vessel_id) if r.vessel_id else None)
                st.success("상태 업데이트 완료!")
                st.rerun()
            finally:
                session.close()

        new_level = st.selectbox("Level 변경", [l.value for l in FollowUpLevel],
                                 index=[l.value for l in FollowUpLevel].index(rfq.follow_up_level.value))
        if st.button("Level 업데이트"):
            session = get_session()
            try:
                r = session.query(RFQ).get(rfq.id)
                r.follow_up_level = FollowUpLevel(new_level)
                session.commit()
                st.success("Level 업데이트!")
                st.rerun()
            finally:
                session.close()

        st.markdown("---")
        st.markdown("**삭제**")
        if st.button("RFQ 삭제", type="secondary", use_container_width=True):
            st.session_state["rfq_delete_confirm"] = rfq.id

    # 삭제 확인 (col_actions 바깥에서 전체 폭으로 표시)
    if st.session_state.get("rfq_delete_confirm") == rfq.id:
        st.warning(
            f"**{rfq.rfq_no}** 를 정말 삭제하시겠습니까?  \n"
            "연결된 Vendor RFQ도 함께 삭제됩니다. 이 작업은 되돌릴 수 없습니다."
        )
        col_yes, col_no, _ = st.columns([1, 1, 4])
        if col_yes.button("확인 삭제", type="primary", key="btn_delete_yes"):
            session = get_session()
            try:
                session.query(VendorRFQ).filter_by(rfq_id=rfq.id).delete()
                session.query(RFQ).filter_by(id=rfq.id).delete()
                session.commit()
                st.session_state.pop("rfq_delete_confirm", None)
                st.session_state.pop("rfq_detail_id", None)
                st.success(f"✅ {rfq.rfq_no} 삭제 완료.")
                st.rerun()
            finally:
                session.close()
        if col_no.button("취소", key="btn_delete_no"):
            st.session_state.pop("rfq_delete_confirm", None)
            st.rerun()

    # Items table
    st.markdown("**품목 리스트**")
    if rfq.items:
        st.dataframe(pd.DataFrame(rfq.items), use_container_width=True, hide_index=True)
    else:
        hint("품목 없음")

    # ── Vendor RFQ 발송 ──────────────────────────────────────────────────────
    st.markdown("---")
    section_header("send", "Vendor RFQ 발송")

    _preview_key = f"vrfq_preview_{rfq.id}"
    vendor_opts = vendor_options()

    if not vendor_opts:
        st.warning("Vendor를 먼저 등록하세요 (⚙️ 설정).")

    # ── STEP 1: Vendor 선택 → 미리보기 생성 ──────────────────────────────────
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

    # ── STEP 2: 미리보기 / 수정 / 발송 ──────────────────────────────────────
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
                        help="공급사가 단가·납기 등을 기입해서 반환하는 Excel 양식입니다. 이메일 발송 시 자동 첨부됩니다.",
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

        # ── SMTP 설정 상태 사전 확인 ────────────────────────────────────────
        import os as _os
        _smtp_ok = bool(_os.getenv("SMTP_USER") and _os.getenv("SMTP_PASSWORD"))
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

    # Existing Vendor RFQs
    session = get_session()
    try:
        vrfqs = session.query(VendorRFQ).filter_by(rfq_id=rfq.id).all()
        if vrfqs:
            st.markdown("**발송된 Vendor RFQ**")
            vrows = []
            for vr in vrfqs:
                v = get_vendor(vr.vendor_id)
                vrows.append({
                    "VRFQ No.": vr.vrfq_no,
                    "Vendor": v.name if v else "—",
                    "수신자 이메일": getattr(vr, "sent_to_email", None) or (v.email if v else "—") or "—",
                    "발송일": vr.sent_date or "—",
                    "상태": vr.status,
                })
            st.dataframe(pd.DataFrame(vrows), use_container_width=True, hide_index=True)
    finally:
        session.close()
