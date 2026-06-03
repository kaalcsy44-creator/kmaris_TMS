"""KTMS entry point — login screen."""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import streamlit as st
from app.utils.auth import login, logout, current_user
from app.utils.helpers import inject_css, NAVY, BLUE

st.set_page_config(
    page_title="KTMS — K-MARIS Trade Management",
    page_icon="⚓",
    layout="wide",
    initial_sidebar_state="collapsed",
)
inject_css()

# ── If already logged in, show quick nav ─────────────────────────────────────
if current_user():
    u = current_user()
    st.markdown(f"""
    <div style="background:{NAVY};color:white;padding:20px 30px;border-radius:10px;margin-bottom:20px;">
        <h2 style="margin:0;">⚓ K-MARIS Trade Management System</h2>
        <p style="margin:4px 0 0;opacity:0.7;">Engineering Reliability. Supplying Performance.</p>
    </div>
    """, unsafe_allow_html=True)

    st.success(f"✅ {u['username']} 님으로 로그인되어 있습니다. 좌측 메뉴에서 페이지를 선택하세요.")
    st.info("👈 사이드바에서 원하는 메뉴를 선택하거나, 아래 바로가기를 클릭하세요.")

    cols = st.columns(4)
    pages = [
        ("📊 Dashboard", "pages/1_Dashboard"),
        ("📋 RFQ 관리", "pages/2_RFQ"),
        ("📄 견적", "pages/3_Quotation"),
        ("📦 오더", "pages/4_Orders"),
    ]
    for col, (label, _) in zip(cols, pages):
        col.button(label, use_container_width=True)

    st.markdown("---")
    if st.button("🔓 로그아웃"):
        logout()
        st.rerun()
    st.stop()

# ── Login form ────────────────────────────────────────────────────────────────
col_left, col_center, col_right = st.columns([1, 1.4, 1])
with col_center:
    st.markdown(f"""
    <div style="text-align:center;padding:30px 0 20px;">
        <div style="background:{NAVY};display:inline-block;padding:16px 32px;border-radius:10px;">
            <span style="color:white;font-size:2rem;">⚓</span>
            <span style="color:white;font-size:1.6rem;font-weight:700;margin-left:10px;">K-MARIS KTMS</span>
        </div>
        <p style="color:#555;margin-top:12px;">Trade Management System</p>
    </div>
    """, unsafe_allow_html=True)

    with st.form("login_form"):
        username = st.text_input("사용자명", placeholder="username")
        password = st.text_input("비밀번호", type="password", placeholder="password")
        submitted = st.form_submit_button("로그인", use_container_width=True, type="primary")

    if submitted:
        user = login(username, password)
        if user:
            st.session_state["user"] = user
            st.success("로그인 성공!")
            st.rerun()
        else:
            st.error("사용자명 또는 비밀번호가 올바르지 않습니다.")

    st.markdown(f"""
    <div style="text-align:center;color:#aaa;font-size:0.8rem;margin-top:20px;">
        최초 로그인: admin / admin1234<br>
        <span style="color:{BLUE};">로그인 후 비밀번호를 즉시 변경하세요.</span>
    </div>
    """, unsafe_allow_html=True)
