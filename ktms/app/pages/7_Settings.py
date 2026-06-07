"""Settings — company profile, users, master data (customers/vendors/vessels/items)."""
from __future__ import annotations
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import streamlit as st
from app.utils.auth import require_auth, is_admin, hash_password, current_user
from app.utils.helpers import inject_css, NAVY
from db.engine import get_session
from db.models import User, UserRole, Customer, Vendor, Vessel, ItemMaster

try:
    st.set_page_config(page_title="설정 — KTMS", page_icon="⚙️", layout="wide")
except Exception:
    pass
require_auth()
inject_css()

st.markdown('<div class="ktms-section">⚙️ 설정 (Settings)</div>', unsafe_allow_html=True)

_config_path = ROOT / "config" / "company.json"

tabs = st.tabs(["🏢 회사 정보", "👤 사용자 관리", "🏭 고객사", "🔧 Vendor", "🚢 선박", "📦 품목 마스터"])

# ══════════════════════════════════════════════════════════════════════════════
# COMPANY PROFILE
# ══════════════════════════════════════════════════════════════════════════════
with tabs[0]:
    st.subheader("회사 정보")
    try:
        company = json.loads(_config_path.read_text(encoding="utf-8"))
    except Exception:
        company = {}

    with st.form("company_form"):
        f1, f2 = st.columns(2)
        company["company_name_en"] = f1.text_input("영문 회사명", company.get("company_name_en", ""))
        company["company_name_kr"] = f2.text_input("한글 회사명", company.get("company_name_kr", ""))
        company["address"]         = st.text_input("주소", company.get("address", ""))
        company["business_no"]     = f1.text_input("사업자번호", company.get("business_no", ""))
        company["phone"]           = f2.text_input("전화", company.get("phone", ""))
        company["general_email"]   = f1.text_input("일반 이메일", company.get("general_email", ""))
        company["sales_email"]     = f2.text_input("영업 이메일", company.get("sales_email", ""))
        company["tax_email"]       = f1.text_input("세금계산서 이메일", company.get("tax_email", ""))
        company["website"]         = f2.text_input("웹사이트", company.get("website", ""))
        company["bank_name"]       = f1.text_input("은행명", company.get("bank_name", ""))
        company["bank_account"]    = f2.text_input("계좌번호", company.get("bank_account", ""))
        company["bank_holder"]     = f1.text_input("예금주", company.get("bank_holder", ""))
        company["swift"]           = f2.text_input("SWIFT", company.get("swift", ""))
        company["tagline"]         = st.text_input("태그라인", company.get("tagline", ""))
        save_co = st.form_submit_button("💾 저장", type="primary")

    if save_co:
        _config_path.write_text(json.dumps(company, ensure_ascii=False, indent=2), encoding="utf-8")
        st.success("회사 정보 저장 완료!")

# ══════════════════════════════════════════════════════════════════════════════
# USER MANAGEMENT (admin only)
# ══════════════════════════════════════════════════════════════════════════════
with tabs[1]:
    st.subheader("사용자 관리")
    if not is_admin():
        st.warning("관리자만 사용자를 관리할 수 있습니다.")
    else:
        session = get_session()
        try:
            users = session.query(User).all()
        finally:
            session.close()

        import pandas as pd
        if users:
            st.dataframe(pd.DataFrame([{
                "ID": u.id, "사용자명": u.username, "이메일": u.email or "—",
                "역할": u.role.value, "활성": u.is_active,
            } for u in users]), use_container_width=True, hide_index=True)

        st.markdown("---")
        st.subheader("신규 사용자 추가")
        with st.form("add_user"):
            uc1, uc2 = st.columns(2)
            new_uname = uc1.text_input("사용자명")
            new_email = uc2.text_input("이메일")
            new_pw    = uc1.text_input("비밀번호", type="password")
            new_role  = uc2.selectbox("역할", [r.value for r in UserRole])
            add_u = st.form_submit_button("사용자 추가")
        if add_u and new_uname and new_pw:
            session = get_session()
            try:
                u = User(
                    username=new_uname, email=new_email,
                    password_hash=hash_password(new_pw),
                    role=UserRole(new_role),
                )
                session.add(u)
                session.commit()
                st.success(f"사용자 '{new_uname}' 추가 완료!")
                st.rerun()
            finally:
                session.close()

        st.markdown("---")
        st.subheader("내 비밀번호 변경")
        with st.form("change_pw"):
            old_pw = st.text_input("현재 비밀번호", type="password")
            new_pw1 = st.text_input("새 비밀번호", type="password")
            new_pw2 = st.text_input("새 비밀번호 확인", type="password")
            ch_pw = st.form_submit_button("비밀번호 변경")
        if ch_pw:
            from app.utils.auth import verify_password
            session = get_session()
            try:
                u = session.query(User).get(current_user()["id"])
                if not verify_password(old_pw, u.password_hash):
                    st.error("현재 비밀번호가 올바르지 않습니다.")
                elif new_pw1 != new_pw2:
                    st.error("새 비밀번호가 일치하지 않습니다.")
                else:
                    u.password_hash = hash_password(new_pw1)
                    session.commit()
                    st.success("비밀번호 변경 완료!")
            finally:
                session.close()

# ══════════════════════════════════════════════════════════════════════════════
# CUSTOMERS
# ══════════════════════════════════════════════════════════════════════════════
with tabs[2]:
    st.subheader("고객사 관리")
    import pandas as pd
    session = get_session()
    try:
        customers = session.query(Customer).order_by(Customer.name).all()
    finally:
        session.close()

    if customers:
        st.dataframe(pd.DataFrame([{
            "ID": c.id, "고객사명": c.name, "국가": c.country or "—",
            "담당자": c.contact or "—", "이메일": c.email or "—",
        } for c in customers]), use_container_width=True, hide_index=True)

    with st.form("add_customer"):
        st.markdown("**신규 고객사 추가**")
        cc1, cc2 = st.columns(2)
        c_name    = cc1.text_input("고객사명 *")
        c_country = cc2.text_input("국가")
        c_addr    = cc1.text_input("주소")
        c_contact = cc2.text_input("담당자")
        c_email   = cc1.text_input("이메일")
        c_taxid   = cc2.text_input("Tax ID / 사업자번호")
        add_c = st.form_submit_button("고객사 추가", type="primary")
    if add_c and c_name:
        session = get_session()
        try:
            session.add(Customer(name=c_name, address=c_addr, contact=c_contact,
                                 email=c_email, tax_id=c_taxid, country=c_country))
            session.commit()
            st.success(f"고객사 '{c_name}' 추가 완료!")
            st.rerun()
        finally:
            session.close()

# ══════════════════════════════════════════════════════════════════════════════
# VENDORS
# ══════════════════════════════════════════════════════════════════════════════
with tabs[3]:
    st.subheader("Vendor (공급사) 관리")
    session = get_session()
    try:
        vendors = session.query(Vendor).order_by(Vendor.name).all()
    finally:
        session.close()

    if vendors:
        st.dataframe(pd.DataFrame([{
            "ID": v.id, "Vendor명": v.name, "국가": v.country or "—",
            "담당자": v.contact or "—", "이메일": v.email or "—",
            "전문분야": v.specialization or "—",
        } for v in vendors]), use_container_width=True, hide_index=True)

    with st.form("add_vendor"):
        st.markdown("**신규 Vendor 추가**")
        vc1, vc2 = st.columns(2)
        v_name  = vc1.text_input("Vendor명 *")
        v_cntry = vc2.text_input("국가")
        v_addr  = vc1.text_input("주소")
        v_cont  = vc2.text_input("담당자")
        v_email = vc1.text_input("이메일")
        v_spec  = vc2.text_input("전문분야 (ex. MAN B&W Engine OEM)")
        add_v = st.form_submit_button("Vendor 추가", type="primary")
    if add_v and v_name:
        session = get_session()
        try:
            session.add(Vendor(name=v_name, address=v_addr, contact=v_cont,
                               email=v_email, country=v_cntry, specialization=v_spec))
            session.commit()
            st.success(f"Vendor '{v_name}' 추가 완료!")
            st.rerun()
        finally:
            session.close()

# ══════════════════════════════════════════════════════════════════════════════
# VESSELS
# ══════════════════════════════════════════════════════════════════════════════
with tabs[4]:
    st.subheader("선박 관리")
    session = get_session()
    try:
        vessels = session.query(Vessel).order_by(Vessel.name).all()
    finally:
        session.close()

    if vessels:
        st.dataframe(pd.DataFrame([{
            "ID": v.id, "선박명": v.name, "IMO": v.imo or "—",
            "엔진": v.engine_type or "—", "Hull No.": v.hull_no or "—",
        } for v in vessels]), use_container_width=True, hide_index=True)

    with st.form("add_vessel"):
        st.markdown("**신규 선박 추가**")
        from app.utils.helpers import customer_options
        cust_opts = {"— 없음 —": None, **customer_options()}
        ves1, ves2 = st.columns(2)
        v_name    = ves1.text_input("선박명 *")
        v_imo     = ves2.text_input("IMO No.")
        v_engine  = ves1.text_input("Main Engine Type (ex. MAN B&W 6S50MC-C)")
        v_hull    = ves2.text_input("Hull No.")
        v_owner   = st.selectbox("선주 (고객사)", list(cust_opts.keys()))
        add_ves   = st.form_submit_button("선박 추가", type="primary")
    if add_ves and v_name:
        session = get_session()
        try:
            session.add(Vessel(name=v_name, imo=v_imo, engine_type=v_engine,
                               hull_no=v_hull, customer_id=cust_opts.get(v_owner)))
            session.commit()
            st.success(f"선박 '{v_name}' 추가 완료!")
            st.rerun()
        finally:
            session.close()

# ══════════════════════════════════════════════════════════════════════════════
# ITEM MASTER
# ══════════════════════════════════════════════════════════════════════════════
with tabs[5]:
    st.subheader("품목 마스터 DB")
    session = get_session()
    try:
        items = session.query(ItemMaster).order_by(ItemMaster.part_no).all()
    finally:
        session.close()

    if items:
        st.dataframe(pd.DataFrame([{
            "ID": i.id, "Part No.": i.part_no, "Description": i.description or "—",
            "Maker": i.maker or "—", "Origin": i.origin or "—",
            "Unit": i.unit, "HS Code": i.hs_code or "—",
            "기준단가": f"{i.std_price:,.2f}",
        } for i in items]), use_container_width=True, hide_index=True)

    with st.form("add_item"):
        st.markdown("**품목 추가**")
        ic1, ic2 = st.columns(2)
        i_part  = ic1.text_input("Part No. *")
        i_desc  = ic2.text_input("Description")
        i_maker = ic1.text_input("Maker")
        i_orig  = ic2.text_input("Origin")
        i_unit  = ic1.text_input("Unit", "PCS")
        i_hs    = ic2.text_input("HS Code")
        i_price = ic1.number_input("기준단가 (USD)", 0.0, step=1.0)
        add_i = st.form_submit_button("품목 추가", type="primary")
    if add_i and i_part:
        session = get_session()
        try:
            session.add(ItemMaster(part_no=i_part, description=i_desc, maker=i_maker,
                                   origin=i_orig, unit=i_unit, hs_code=i_hs, std_price=i_price))
            session.commit()
            st.success(f"품목 '{i_part}' 추가 완료!")
            st.rerun()
        finally:
            session.close()
