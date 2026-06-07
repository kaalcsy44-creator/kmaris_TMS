"""KTMS entry point — DB init, auth dialog, navigation."""
from __future__ import annotations
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import streamlit as st

# ── Inject Streamlit secrets → os.environ (cloud deployment) ─────────────────
_SECRET_KEYS = [
    "DATABASE_URL", "SMTP_HOST", "SMTP_PORT", "SMTP_USER",
    "SMTP_PASSWORD", "SMTP_FROM", "ANTHROPIC_API_KEY",
]
for _k in _SECRET_KEYS:
    try:
        if _k in st.secrets and _k not in os.environ:
            os.environ[_k] = str(st.secrets[_k])
    except Exception:
        pass

# ── Auto-initialize DB tables on first run ────────────────────────────────────
try:
    from db.engine import Base, get_engine, get_session
    from db.models import *  # noqa: F401,F403
    Base.metadata.create_all(bind=get_engine())
except Exception as _e:
    st.error(f"DB 초기화 오류: {_e}")
    st.stop()

# ── Auto-seed admin + sample data on first cloud run ─────────────────────────
try:
    import bcrypt as _bcrypt
    from db.models import User, UserRole, Customer, Vendor
    _s = get_session()
    if _s.query(User).count() == 0:
        _pw = _bcrypt.hashpw(b"admin1234", _bcrypt.gensalt()).decode()
        _s.add(User(username="admin", email="admin@k-maris.com",
                    password_hash=_pw, role=UserRole.ADMIN))
        _s.add(Customer(name="ABC Ship Management Pte. Ltd.",
                        address="10 Anson Road, Singapore",
                        contact="Mr. John Lee", email="purchase@example.com",
                        tax_id="SG-000000", country="Singapore"))
        _s.add(Vendor(name="MAN Energy Solutions",
                      address="Teglholmsgade 41, Copenhagen, Denmark",
                      contact="Mr. Klaus Schmidt", email="spares@man-es.com",
                      country="Denmark",
                      specialization="MAN B&W Engine OEM Parts"))
        _s.commit()
    _s.close()
except Exception:
    pass

# ── Page config (called ONCE here — page files skip this) ─────────────────────
st.set_page_config(
    page_title="KTMS — K-MARIS Trade Management",
    page_icon="⚓",
    layout="wide",
    initial_sidebar_state="expanded",
)

from app.utils.auth import current_user, logout, _login_dialog
from app.utils.helpers import inject_css
inject_css()

# ── Dialog centering CSS ──────────────────────────────────────────────────────
st.markdown(
    """
    <style>
    div[data-testid="stDialog"] > div[data-baseweb="modal"] > div {
        align-items: center !important;
    }
    div[data-testid="stDialog"] div[data-baseweb="dialog"] {
        margin-top: 0 !important;
    }
    </style>
    """,
    unsafe_allow_html=True,
)

# ── Not logged in: show backdrop + login dialog ───────────────────────────────
if not current_user():
    st.markdown(
        """
        <div style="
            display:flex; flex-direction:column; align-items:center;
            justify-content:center; min-height:60vh; text-align:center;
        ">
            <div style="
                background:#0B1D3A; color:white;
                padding:32px 56px; border-radius:14px;
                display:inline-block; margin-bottom:20px;
            ">
                <div style="font-size:3rem;">⚓</div>
                <h1 style="margin:10px 0 6px;font-size:2rem;font-weight:700;">
                    K-MARIS Trade Management System
                </h1>
                <p style="margin:0;opacity:0.7;font-size:1rem;">
                    Engineering Reliability. Supplying Performance.
                </p>
            </div>
        </div>
        """,
        unsafe_allow_html=True,
    )
    _login_dialog()
    st.stop()

# ── Logged in: build navigation (Home itself NOT included → removed from sidebar) ─
pages = [
    st.Page("pages/1_Dashboard.py", title="Dashboard",  icon=":material/dashboard:",      default=True),
    st.Page("pages/2_RFQ.py",       title="RFQ",        icon=":material/request_quote:"),
    st.Page("pages/3_Quotation.py", title="Quotation",  icon=":material/receipt_long:"),
    st.Page("pages/4_Orders.py",    title="Orders",     icon=":material/inventory_2:"),
    st.Page("pages/5_Documents.py", title="Documents",  icon=":material/folder_open:"),
    st.Page("pages/6_AR.py",        title="AR",         icon=":material/payments:"),
    st.Page("pages/7_Settings.py",  title="Settings",   icon=":material/settings:"),
]
pg = st.navigation(pages)

# ── Sidebar: user info + logout icon (fixed bottom) ───────────────────────────
with st.sidebar:
    u = current_user()
    c1, c2 = st.columns([5, 1])
    with c1:
        st.markdown(
            f'<div style="font-size:.84rem;color:#E8EDF5;font-weight:600;line-height:2.2;">'
            f'👤 {u["username"]}</div>',
            unsafe_allow_html=True,
        )
    with c2:
        if st.button("⏻", key="sidebar_logout", help="로그아웃", use_container_width=True):
            logout()
            st.rerun()

pg.run()
