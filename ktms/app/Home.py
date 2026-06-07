"""KTMS entry point — DB init, auth dialog, redirect to Dashboard."""
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

# ── Page config ───────────────────────────────────────────────────────────────
st.set_page_config(
    page_title="KTMS — K-MARIS Trade Management",
    page_icon="⚓",
    layout="wide",
    initial_sidebar_state="collapsed",
)

from app.utils.auth import current_user, logout, _login_dialog
from app.utils.helpers import inject_css
inject_css()

# ── Already logged in → go straight to Dashboard ─────────────────────────────
if current_user():
    st.switch_page("pages/1_Dashboard.py")
    st.stop()

# ── Not logged in: show branding backdrop + login dialog ──────────────────────
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
