"""Simple DB-backed authentication for Streamlit."""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import bcrypt
import streamlit as st
from db.engine import get_session
from db.models import User, UserRole


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


def login(username: str, password: str):
    session = get_session()
    try:
        user = session.query(User).filter_by(username=username, is_active=True).first()
        if user and verify_password(password, user.password_hash):
            return {"id": user.id, "username": user.username,
                    "role": user.role.value, "email": user.email or ""}
        return None
    finally:
        session.close()


def logout():
    for key in ["user", "page"]:
        st.session_state.pop(key, None)


def current_user():
    return st.session_state.get("user")


def is_admin() -> bool:
    u = current_user()
    return u is not None and u["role"] == UserRole.ADMIN.value


def login_page():
    """Full-page, vertically-centered login. No sidebar, no header — just the box."""
    st.markdown(
        """
        <style>
        /* Hide the sidebar and its collapse control */
        [data-testid="stSidebar"],
        [data-testid="stSidebarNav"],
        [data-testid="stSidebarCollapsedControl"],
        [data-testid="collapsedControl"] { display: none !important; }
        /* Hide the top header bar (hamburger / toolbar) */
        [data-testid="stHeader"] { display: none !important; }
        /* Center the login content vertically and horizontally, no scroll */
        [data-testid="stAppViewContainer"] > .main { margin-left: 0 !important; }
        [data-testid="stAppViewContainer"] .block-container {
            max-width: 660px !important;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            justify-content: center;
            padding-top: 1rem !important;
            padding-bottom: 1rem !important;
        }
        /* Center the title/caption markdown blocks (Streamlit h1 default-aligns left) */
        [data-testid="stAppViewContainer"] .block-container [data-testid="stMarkdownContainer"],
        [data-testid="stAppViewContainer"] .block-container [data-testid="stMarkdownContainer"] * {
            text-align: center !important;
        }
        </style>
        """,
        unsafe_allow_html=True,
    )

    from app.utils.helpers import kmaris_emblem_svg
    st.markdown(
        f"<div style='text-align:center;margin-bottom:1.4rem;'>"
        f"<div style='display:flex;justify-content:center;'>"
        f"{kmaris_emblem_svg(width=108, height=116)}</div>"
        f"<div style='opacity:.55;font-size:.92rem;margin-top:.4rem;'>"
        f"K-Maris Trade Management System</div>"
        f"</div>",
        unsafe_allow_html=True,
    )
    with st.form("login_form"):
        username = st.text_input("사용자명", placeholder="username")
        password = st.text_input("비밀번호", type="password", placeholder="password")
        submitted = st.form_submit_button("로그인", type="primary", use_container_width=True)
    if submitted:
        user = login(username, password)
        if user:
            st.session_state["user"] = user
            st.rerun()
        else:
            st.error("사용자명 또는 비밀번호가 올바르지 않습니다.")
    st.markdown(
        "<p style='text-align:center;opacity:.55;font-size:.82rem;margin-top:.8rem;'>"
        "최초 로그인: admin / admin1234 — 로그인 후 즉시 변경하세요.</p>",
        unsafe_allow_html=True,
    )


def require_auth():
    """Call at the top of every page. Shows login page and stops if not logged in."""
    if not st.session_state.get("user"):
        login_page()
        st.stop()


def require_admin():
    require_auth()
    if not is_admin():
        st.error("관리자 권한이 필요합니다.")
        st.stop()
