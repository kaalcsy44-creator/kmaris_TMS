"""Simple DB-backed authentication for Streamlit."""
from __future__ import annotations
import sys, os
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
            return {"id": user.id, "username": user.username, "role": user.role.value, "email": user.email or ""}
        return None
    finally:
        session.close()


def logout():
    for key in ["user", "page"]:
        st.session_state.pop(key, None)


def current_user():
    return st.session_state.get("user")


def require_auth():
    """Call at the top of every page. Stops rendering if not logged in."""
    if not st.session_state.get("user"):
        st.warning("로그인이 필요합니다. 홈 화면으로 이동하세요.")
        st.stop()


def is_admin() -> bool:
    u = current_user()
    return u is not None and u["role"] == UserRole.ADMIN.value


def require_admin():
    require_auth()
    if not is_admin():
        st.error("관리자 권한이 필요합니다.")
        st.stop()
