"""KTMS entry point — DB init, auth dialog, navigation."""
from __future__ import annotations
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import streamlit as st
from dotenv import load_dotenv

# ── Load local .env (local development) ──────────────────────────────────────
load_dotenv(ROOT / ".env")

# ── Inject Streamlit secrets → os.environ (cloud deployment) ─────────────────
_SECRET_KEYS = [
    "DATABASE_URL", "SMTP_HOST", "SMTP_PORT", "SMTP_USER",
    "SMTP_PASSWORD", "SMTP_FROM", "ANTHROPIC_API_KEY",
    "GOOGLE_SHEET_ID", "GOOGLE_SA_KEY_JSON", "GOOGLE_SA_KEY_FILE",
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

# ── Column migrations (idempotent, SQLite + PostgreSQL) ───────────────────────
try:
    from init_db import migrate_columns
    migrate_columns()
except Exception as _mig_err:
    st.warning(f"⚠️ 컬럼 마이그레이션 경고: {_mig_err}")

# ── Auto-seed admin + sample data on first cloud run ─────────────────────────
try:
    import bcrypt as _bcrypt
    from db.models import User, UserRole, Customer, Vendor
    _s = get_session()
    _user_count = _s.query(User).count()
    _admin_exists = _s.query(User).filter_by(username="admin").first() is not None
    if _user_count == 0 or not _admin_exists:
        if not _admin_exists:
            _pw = _bcrypt.hashpw(b"admin1234", _bcrypt.gensalt()).decode()
            _s.add(User(username="admin", email="admin@k-maris.com",
                        password_hash=_pw, role=UserRole.ADMIN))
        if _s.query(Customer).count() == 0:
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
except Exception as _seed_err:
    st.error(f"⚠️ DB 초기 사용자 생성 실패: {_seed_err}")
    st.stop()

# ── Page config (called ONCE here — page files skip this) ─────────────────────
st.set_page_config(
    page_title="KTMS — K-MARIS Trade Management",
    page_icon="⚓",
    layout="wide",
    initial_sidebar_state="expanded",
)

from app.utils.auth import current_user, logout, login_page
from app.utils.helpers import inject_css
inject_css()

# ── Not logged in: show full-page login (no sidebar) ──────────────────────────
if not current_user():
    login_page()
    st.stop()

# ── Logged in: build navigation (Home itself NOT included → removed from sidebar) ─
pages = {
    " ": [
        st.Page("pages/1_Dashboard.py", title="Dashboard", default=True),
    ],
    "RFQ": [
        st.Page("pages/2_CRFQ.py",        title="Customer RFQ 수신"),
        st.Page("pages/3_VRFQ.py",        title="Vendor RFQ 발신"),
    ],
    "Quotation": [
        st.Page("pages/vendor_quote.py",  title="Vendor Quot. 수신"),
        st.Page("pages/4_Quotation.py",   title="Customer Quot. 발신"),
    ],
    "P/O": [
        st.Page("pages/5_CustomerPO.py",  title="Customer PO 수신"),
        st.Page("pages/5b_VendorPO.py",   title="Vendor PO 발신"),
    ],
    "선적 · 정산": [
        st.Page("pages/6_Documents.py", title="Documents"),
        st.Page("pages/7_AR.py",        title="AR"),
    ],
    "시스템": [
        st.Page("pages/8_Settings.py", title="Settings"),
    ],
}
pg = st.navigation(pages)

# ── Sidebar: user info + logout icon (fixed bottom) ───────────────────────────
with st.sidebar:
    u = current_user()
    initial = u["username"][0].upper()
    c1, c2 = st.columns([5, 1])
    with c1:
        st.markdown(
            f'<div style="display:flex;align-items:center;gap:8px;padding:4px 0;">'
            f'<span style="width:24px;height:24px;background:rgba(255,255,255,0.18);border-radius:50%;'
            f'display:inline-flex;align-items:center;justify-content:center;'
            f'font-size:.72rem;color:#E8EDF5;font-weight:700;flex-shrink:0;">{initial}</span>'
            f'<span style="font-size:.84rem;color:#C4CFDE;font-weight:500;">{u["username"]}</span>'
            f'</div>',
            unsafe_allow_html=True,
        )
    with c2:
        if st.button(" ", key="sidebar_logout", help="로그아웃", use_container_width=True):
            logout()
            st.rerun()

pg.run()
