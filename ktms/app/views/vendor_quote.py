"""Vendor Quotation 수신 — register vendor quotes received against a sent VRFQ + list all received quotes."""
from __future__ import annotations
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
    inject_css, hint, section_header,
    get_rfq, get_vendor, vendor_quotes_for_vrfq,
)
from db.engine import get_session
from db.models import VendorRFQ, VendorQuote, RFQ, RFQStatus

try:
    st.set_page_config(page_title="Vendor Quot. 수신 — KTMS", page_icon="📥", layout="wide")
except Exception:
    pass
require_auth()
inject_css()

section_header("quotation", "Vendor Quot. 수신")

tab_register, tab_list = st.tabs(["➕ 견적 수신 등록", "📋 수신 견적 목록"])

# 전체 VRFQ 로드 (두 탭 공용)
_s2 = get_session()
try:
    all_vrfqs2 = _s2.query(VendorRFQ).order_by(VendorRFQ.id.desc()).all()
finally:
    _s2.close()

# ══════════════════════════════════════════════════════════════════════════════
# TAB 1 — 견적 수신 등록
# ══════════════════════════════════════════════════════════════════════════════
with tab_register:
    st.subheader("Vendor 견적 수신 등록")

    if not all_vrfqs2:
        hint("아직 발송된 Vendor RFQ가 없습니다. 'Vendor RFQ 발신' 메뉴에서 먼저 발송하세요.")
    else:
        # VRFQ 선택 (수신 견적 목록에서 클릭하면 자동 선택)
        vrfq_label_map = {}
        for vr in all_vrfqs2:
            v = get_vendor(vr.vendor_id)
            rfq_obj = get_rfq(vr.rfq_id)
            qs = vendor_quotes_for_vrfq(vr.id)
            badge = f" ✅{len(qs)}건" if qs else ""
            label = (
                f"{vr.vrfq_no}  |  {v.name if v else '—'}"
                f"  |  CRFQ: {rfq_obj.rfq_no if rfq_obj else '—'}"
                f"  |  {vr.status}{badge}"
            )
            vrfq_label_map[label] = vr

        _presel_id = st.session_state.get("vrfq_detail_id")
        _default_idx = 0
        if _presel_id:
            for i, vr in enumerate(all_vrfqs2):
                if vr.id == _presel_id:
                    _default_idx = i
                    break

        sel_vq_label = st.selectbox(
            "Vendor RFQ 선택",
            list(vrfq_label_map.keys()),
            index=_default_idx,
            key="vq_sel_vrfq_label",
        )
        sel_vrfq = vrfq_label_map[sel_vq_label]
        linked_rfq = get_rfq(sel_vrfq.rfq_id)

        st.markdown("---")

        # ── 기등록 견적 목록 ──────────────────────────────────────────────────
        existing_quotes = vendor_quotes_for_vrfq(sel_vrfq.id)
        if existing_quotes:
            with st.expander(f"기등록 견적 ({len(existing_quotes)}건)", expanded=False):
                for eq in existing_quotes:
                    c1, c2, c3 = st.columns([2, 6, 1])
                    c1.markdown(f"**{eq.received_date or '—'}**")
                    c2.markdown(eq.notes or "")
                    if c3.button("삭제", key=f"del_vq_{eq.id}", type="secondary"):
                        _ds = get_session()
                        try:
                            _ds.query(VendorQuote).filter_by(id=eq.id).delete()
                            _ds.commit()
                            st.success("삭제 완료")
                            st.rerun()
                        finally:
                            _ds.close()
                    if eq.items:
                        st.dataframe(pd.DataFrame(eq.items), use_container_width=True, hide_index=True)

        # ── 신규 견적 등록 폼 ─────────────────────────────────────────────────
        with st.expander("신규 견적 수신 등록", expanded=True):
            vq_date = st.date_input("견적 수신일", value=date.today(), key="vq_tab_date")
            vq_notes = st.text_input("비고 (Vendor 메모 등)", key="vq_tab_notes")

            # ── Session-state keys (version counter = data_editor key 변경 트리거) ──
            _parse_key   = f"vq_parsed_{sel_vrfq.id}"
            _fhash_key   = f"vq_fhash_{sel_vrfq.id}"
            _ver_key     = f"vq_ver_{sel_vrfq.id}"
            _msg_key     = f"vq_msg_{sel_vrfq.id}"
            _ver         = st.session_state.get(_ver_key, 0)
            _editor_key  = f"vq_items_{sel_vrfq.id}_v{_ver}"

            # 파싱 완료 메시지 (이전 run에서 저장한 것) 표시
            if _msg_key in st.session_state:
                st.success(st.session_state.pop(_msg_key))

            # ── Vendor 견적 파일 업로드 (PDF/Excel → 자동 파싱) ───────────────
            st.markdown("**Vendor 견적 파일 업로드**")
            _uploaded = st.file_uploader(
                "Vendor가 가격/납기를 입력하여 반환한 PDF 또는 Excel 파일을 업로드하면 "
                "Unit Price, Lead Time, Origin 등이 자동으로 채워집니다.",
                type=["pdf", "xlsx", "xls"],
                key=f"vq_upload_{sel_vrfq.id}",
            )

            if _uploaded is not None:
                import hashlib
                _raw = _uploaded.getvalue()
                _fhash = hashlib.md5(_raw).hexdigest()
                if st.session_state.get(_fhash_key) != _fhash:
                    # 새 파일 — 파싱 후 버전 증가 → 다음 run에서 editor 키 변경
                    with st.spinner("파일 파싱 중..."):
                        try:
                            from services.quote_response_parser import parse_vendor_quote_bytes as _pvq
                            _parsed = _pvq(_raw, _uploaded.name)
                            if _parsed:
                                st.session_state[_parse_key] = _parsed
                                st.session_state[_fhash_key] = _fhash
                                st.session_state[_ver_key]   = _ver + 1
                                st.session_state[_msg_key]   = (
                                    f"✅ {len(_parsed)}개 품목의 가격·납기·원산지 추출 완료 "
                                    "— 아래 표를 확인 후 저장하세요."
                                )
                                st.rerun()  # 새 editor 키로 위젯을 새로 생성
                            else:
                                st.warning(
                                    "파일에서 견적 데이터를 추출하지 못했습니다. "
                                    "KTMS에서 발행한 Vendor Quotation Request Sheet 형식인지 확인하세요."
                                )
                        except Exception as _e:
                            st.error(f"파싱 오류: {_e}")
            else:
                st.session_state.pop(_fhash_key, None)

            st.markdown("---")

            vq_cols = ["item_no", "part_no", "description", "maker", "origin",
                       "qty", "unit", "cost_price", "lead_time", "remark"]

            base_items = sel_vrfq.items or (linked_rfq.items if linked_rfq else [])
            seed_rows = []
            for i, itm in enumerate(base_items, 1):
                seed_rows.append({
                    "item_no": i,
                    "part_no": itm.get("part_no", ""),
                    "description": itm.get("description", ""),
                    "maker": itm.get("maker", ""),
                    "origin": "",
                    "qty": itm.get("qty", 1),
                    "unit": itm.get("unit", "PCS"),
                    "cost_price": float(itm.get("cost_price", 0.0)),
                    "lead_time": "",
                    "remark": "",
                })

            # ── 파싱된 데이터를 seed_rows에 병합 ────────────────────────────
            if _parse_key in st.session_state:
                _pmap = {
                    p.get("part_no", ""): p
                    for p in st.session_state[_parse_key]
                    if p.get("part_no")
                }
                _matched = 0
                for row in seed_rows:
                    _pd = _pmap.get(row["part_no"], {})
                    if not _pd:
                        continue
                    _matched += 1
                    if _pd.get("cost_price") not in ("", None):
                        try:
                            row["cost_price"] = float(_pd["cost_price"])
                        except (ValueError, TypeError):
                            pass
                    for _fld in ("lead_time", "origin", "remark"):
                        if _pd.get(_fld):
                            row[_fld] = _pd[_fld]
                    if _pd.get("manufacturer"):
                        row["maker"] = _pd["manufacturer"]
                if _matched:
                    hint(f"업로드 파일에서 {_matched}개 품목 데이터가 적용되었습니다.")

            vq_df = st.data_editor(
                pd.DataFrame(seed_rows, columns=vq_cols) if seed_rows
                else pd.DataFrame(columns=vq_cols),
                num_rows="dynamic",
                use_container_width=True,
                column_config={
                    "qty": st.column_config.NumberColumn("qty", min_value=0, step=1),
                    "cost_price": st.column_config.NumberColumn("cost_price (공급가)", format="%.2f"),
                },
                key=_editor_key,
            )

            if st.button("견적 저장", type="primary", key="btn_save_vq_tab"):
                items_data = vq_df.fillna("").to_dict(orient="records")
                _ss = get_session()
                try:
                    vq_new = VendorQuote(
                        vendor_rfq_id=sel_vrfq.id,
                        received_date=vq_date.isoformat(),
                        items=items_data,
                        notes=vq_notes,
                    )
                    _ss.add(vq_new)
                    _vr = _ss.query(VendorRFQ).get(sel_vrfq.id)
                    _vr.status = "견적 수신완료"
                    if linked_rfq:
                        _rfq_upd = _ss.query(RFQ).get(linked_rfq.id)
                        if _rfq_upd and _rfq_upd.status == RFQStatus.SOURCING:
                            _rfq_upd.status = RFQStatus.QUOTING
                    _ss.commit()
                    st.session_state.pop(_parse_key, None)
                    st.session_state.pop(_fhash_key, None)
                    st.session_state[_ver_key] = _ver + 1  # 저장 후 폼 초기화
                    st.session_state[_msg_key] = (
                        f"✅ {sel_vrfq.vrfq_no} Vendor 견적 등록 완료! "
                        "이제 Quotation 작성 시 이 견적을 불러올 수 있습니다."
                    )
                    st.rerun()
                finally:
                    _ss.close()

# ══════════════════════════════════════════════════════════════════════════════
# TAB 2 — 수신 견적 목록 (전체)
# ══════════════════════════════════════════════════════════════════════════════
with tab_list:
    _sl = get_session()
    try:
        all_quotes = _sl.query(VendorQuote).order_by(VendorQuote.id.desc()).all()
        vrfq_by_id = {vr.id: vr for vr in _sl.query(VendorRFQ).all()}
    finally:
        _sl.close()

    if not all_quotes:
        hint("아직 수신된 Vendor 견적이 없습니다. '견적 수신 등록' 탭에서 등록하세요.")
    else:
        rows = []
        for q in all_quotes:
            vr = vrfq_by_id.get(q.vendor_rfq_id)
            vendor = get_vendor(vr.vendor_id) if vr else None
            rfq_obj = get_rfq(vr.rfq_id) if vr else None
            rows.append({
                "VRFQ_ID": vr.id if vr else 0,
                "VRFQ No.": vr.vrfq_no if vr else "—",
                "Vendor": vendor.name if vendor else "—",
                "Customer RFQ": rfq_obj.rfq_no if rfq_obj else "—",
                "수신일": q.received_date or "—",
                "품목수": len(q.items or []),
                "비고": (q.notes or "")[:40],
            })

        df = pd.DataFrame(rows)
        selected = st.dataframe(
            df.drop(columns=["VRFQ_ID"]),
            use_container_width=True,
            hide_index=True,
            selection_mode="single-row",
            on_select="rerun",
        )
        sel_rows = selected.selection.rows if hasattr(selected, "selection") else []
        if sel_rows:
            sel_vrfq_id = int(df.iloc[sel_rows[0]]["VRFQ_ID"])
            if sel_vrfq_id:
                st.session_state["vrfq_detail_id"] = sel_vrfq_id
                hint(f"VRFQ ID {sel_vrfq_id} 선택됨 — '견적 수신 등록' 탭에서 해당 VRFQ가 선택됩니다.")
