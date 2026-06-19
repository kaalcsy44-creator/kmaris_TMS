"""Customer RFQ Management — receive, register, send to vendors, track status."""
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
    inject_css, hint, section_header, next_doc_no, next_rfq_no, tracking_url,
    customer_options, vessel_options,
    rfq_list, get_rfq, get_customer, get_vessel, NAVY, BLUE,
    INTERNAL_STEPS, pipeline_status_label, clear_cached_reference_data,
)
from db.engine import get_session
from db.models import RFQ, VendorRFQ, RFQStatus, FollowUpLevel, Customer, Vessel
from services.sheets_svc import upsert_rfq as _sheet_upsert_rfq

# 페이지 셋업(set_page_config/require_auth/inject_css/section_header)은 통합 페이지
# rfq_quotation.py 에서 처리한다. 이 모듈은 탭별 render 함수만 노출한다.


def render_rfq_detail():
    """RFQ 목록에서 선택한 RFQ의 상세(정보·상태/Level·삭제·품목)를 인라인 표시."""
    rfq_id = st.session_state.get("rfq_detail_id")
    if not rfq_id:
        hint("위 목록에서 RFQ를 선택하면 상세가 여기에 표시됩니다.")
        return
    rfq = get_rfq(int(rfq_id))
    if not rfq:
        hint("선택한 RFQ를 찾을 수 없습니다. 목록에서 다시 선택하세요.")
        return

    cust = get_customer(rfq.customer_id)
    vessel = get_vessel(rfq.vessel_id) if rfq.vessel_id else None

    col_info, col_actions = st.columns([3, 1])
    with col_info:
        st.markdown(f"### {rfq.rfq_no}")
        if rfq.customer_rfq_no:
            st.caption(f"고객 RFQ No.: **{rfq.customer_rfq_no}**")
        c1, c2, c3 = st.columns(3)
        info_cards = [
            (c1, "Customer", cust.name if cust else "—"),
            (c2, "선박", vessel.name if vessel else "—"),
            (c3, "품목수", len(rfq.items or [])),
        ]
        for col, label, value in info_cards:
            with col:
                st.markdown(f"""
                <div class="ktms-info-card">
                    <div class="ktms-info-label">{label}</div>
                    <div class="ktms-info-value">{value}</div>
                </div>
                """, unsafe_allow_html=True)
        _stage_lbl = pipeline_status_label(rfq.id)
        _stage_badge = (f"<span style='background:rgba(0,85,168,.12);color:{BLUE};"
                        f"padding:3px 10px;border-radius:999px;font-size:12px;"
                        f"font-weight:800;letter-spacing:.03em;'>{_stage_lbl}</span>")
        st.markdown(f"**상태:** {_stage_badge}&nbsp;&nbsp;"
                    f"**Follow-up:** <span class='badge-{rfq.follow_up_level.value}'>{rfq.follow_up_level.value}</span>"
                    f"&nbsp;&nbsp;**날짜:** {rfq.date}", unsafe_allow_html=True)
        if rfq.notes:
            st.caption(f"비고: {rfq.notes}")

        t_url = tracking_url("rfq", rfq.tracking_token)
        st.markdown(f"🔗 **고객 트래킹 링크:** [{t_url}]({t_url})")
        st.caption("📨 이 RFQ로 Vendor에 견적을 요청하려면 'Vendor RFQ 발신' 메뉴로 이동하세요.")

    with col_actions:
        st.markdown("**액션**")
        st.caption("ℹ 상태는 14단계 진행에 따라 자동 반영됩니다.")
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

    st.markdown("**품목 리스트**")
    if rfq.items:
        st.dataframe(pd.DataFrame(rfq.items), use_container_width=True, hide_index=True)
    else:
        hint("품목 없음")


# ══════════════════════════════════════════════════════════════════════════════
# TAB — Customer RFQ 목록
# ══════════════════════════════════════════════════════════════════════════════
def render_crfq_list():
    col_f1, col_f2, col_f3 = st.columns([2, 2, 1])
    with col_f1:
        _stage_filter_opts = ["전체"] + [f"{i}/14 {name}" for i, name in enumerate(INTERNAL_STEPS, 1)]
        status_filter = st.selectbox("상태 필터 (14단계)", _stage_filter_opts)
    with col_f2:
        cust_opts = {"전체": None, **customer_options()}
        cust_sel = st.selectbox("Customer 필터", list(cust_opts.keys()))
    with col_f3:
        st.markdown("<br>", unsafe_allow_html=True)
        refresh = st.button("새로고침", use_container_width=True)

    rfqs = rfq_list()
    if cust_sel != "전체" and cust_opts[cust_sel]:
        rfqs = [r for r in rfqs if r.customer_id == cust_opts[cust_sel]]

    rows = []
    for r in rfqs:
        stage_lbl = pipeline_status_label(r.id)
        if status_filter != "전체" and stage_lbl != status_filter:
            continue
        c = get_customer(r.customer_id)
        v = get_vessel(r.vessel_id) if r.vessel_id else None
        rows.append({
            "ID": r.id,
            "RFQ No. (K-Maris)": r.rfq_no,
            "고객 RFQ No.": r.customer_rfq_no or "—",
            "Customer": c.name if c else "—",
            "선박": v.name if v else "—",
            "품목수": len(r.items or []),
            "Level": r.follow_up_level.value if r.follow_up_level else "—",
            "상태": stage_lbl,
            "날짜": r.date or "—",
        })

    if rows:
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
            st.session_state["rfq_detail_id"] = int(df.iloc[sel_rows[0]]["ID"])
    elif status_filter != "전체" or cust_sel != "전체":
        hint("필터 조건에 맞는 RFQ가 없습니다.")
    else:
        hint("등록된 RFQ가 없습니다.")

    # ── 선택한 RFQ 상세 (인라인) ──────────────────────────────────────────────
    st.markdown("---")
    render_rfq_detail()

# ══════════════════════════════════════════════════════════════════════════════
# TAB — Customer RFQ 신규 등록
# ══════════════════════════════════════════════════════════════════════════════
def render_crfq_new():
    st.subheader("신규 RFQ 등록")

    # ── PDF 자동 입력 ────────────────────────────────────────────────────────
    with st.expander("PDF로 자동 입력 (AI OCR)", expanded=False):
        pdf_file = st.file_uploader(
            "RFQ PDF 파일 업로드", type=["pdf"], key="rfq_pdf_uploader",
            help="PDF를 업로드하면 AI가 Customer·선박·품목 정보를 자동으로 인식합니다.",
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
            col_p2.markdown(f"**Customer 힌트:** {ocr_data.get('customer_hint') or '—'}")
            col_p2.markdown(f"**고객 RFQ No.:** {ocr_data.get('customer_rfq_no') or '—'}")
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

    # ── 신규 Customer 빠른 등록 ────────────────────────────────────────────────
    _cust_expand = bool(_cust_hint_raw) and not _cust_matched
    with st.expander("신규 Customer 빠른 등록", expanded=_cust_expand):
        if _cust_expand:
            st.info(f'OCR 인식: **"{_cust_hint_raw}"** — DB에 없는 Customer입니다. 등록 후 자동 선택됩니다.')
        nc1, nc2 = st.columns(2)
        nc_name    = nc1.text_input("Customer명 *", value=_cust_hint_raw, key="nc_name")
        nc_country = nc2.text_input("국가", key="nc_country")
        nc_contact = nc1.text_input("담당자", key="nc_contact")
        nc_email   = nc2.text_input("이메일", key="nc_email")
        nc_addr    = nc1.text_input("주소", key="nc_addr")
        nc_taxid   = nc2.text_input("Tax ID / 사업자번호", key="nc_taxid")
        if st.button("Customer 등록", key="btn_quick_cust", type="primary"):
            if nc_name.strip():
                _s = get_session()
                try:
                    _s.add(Customer(name=nc_name.strip(), country=nc_country,
                                    contact=nc_contact, email=nc_email,
                                    address=nc_addr, tax_id=nc_taxid))
                    _s.commit()
                    clear_cached_reference_data()
                    st.success(f"✅ Customer '{nc_name.strip()}' 등록 완료! 아래 드롭다운에 반영됩니다.")
                    st.rerun()
                finally:
                    _s.close()
            else:
                st.warning("Customer명을 입력하세요.")

    # ── 신규 선박 빠른 등록 ──────────────────────────────────────────────────
    _cust_opts_now2 = customer_options()
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
        _owner_idx = 0
        if _cust_hint_raw:
            for i, k in enumerate(_owner_opts):
                if _cust_hint_raw.lower() in k.lower() or k.lower() in _cust_hint_raw.lower():
                    _owner_idx = i
                    break
        nv_owner  = nv2.selectbox("선주 (Customer)", list(_owner_opts.keys()),
                                   index=_owner_idx, key="nv_owner")
        if st.button("선박 등록", key="btn_quick_vessel", type="primary"):
            if nv_name.strip():
                _s = get_session()
                try:
                    _s.add(Vessel(name=nv_name.strip(), imo=nv_imo,
                                  engine_type=nv_engine, hull_no=nv_hull,
                                  customer_id=_owner_opts.get(nv_owner)))
                    _s.commit()
                    clear_cached_reference_data()
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
                cust_name = st.selectbox("Customer *", cust_keys, index=_cust_idx)
                cust_id = cust_opts2[cust_name]
            else:
                hint("위 '신규 Customer 빠른 등록'에서 먼저 등록하세요.")
                cust_id = None
            customer_rfq_no = st.text_input(
                "고객사 RFQ No.", value=ocr.get("customer_rfq_no") or "",
                placeholder="고객사가 부여한 RFQ 번호 (예: RFQ-2026-123)",
                help="K-Maris 내부 관리번호(KMS-RFQ-yymm-NNN)는 등록 시 자동으로 생성됩니다.",
            )
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
        rfq_no = next_rfq_no()
        session = get_session()
        try:
            rfq = RFQ(
                rfq_no=rfq_no,
                customer_rfq_no=(customer_rfq_no or "").strip() or None,
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
            _cust_no_txt = f" (고객 RFQ No.: {rfq.customer_rfq_no})" if rfq.customer_rfq_no else ""
            st.success(f"✅ RFQ 등록 완료: **{rfq_no}**{_cust_no_txt}")
            t_url = tracking_url("rfq", rfq.tracking_token)
            st.info(f"🔗 고객 트래킹 링크: {t_url}")
            _sheet_upsert_rfq(rfq, get_customer(rfq.customer_id), get_vessel(rfq.vessel_id) if rfq.vessel_id else None)
            st.session_state.pop("rfq_ocr", None)
        finally:
            session.close()
