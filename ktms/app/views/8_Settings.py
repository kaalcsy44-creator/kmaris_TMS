"""Settings — company profile, users, master data (customers/vendors/vessels/items)."""
from __future__ import annotations
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pandas as pd
import streamlit as st
from app.utils.auth import require_auth, is_admin, hash_password, current_user
from app.utils.helpers import inject_css, section_header, customer_options, get_customer, NAVY, clear_cached_reference_data
from db.engine import get_session
from db.models import User, UserRole, Customer, Vendor, Vessel, ItemMaster

try:
    st.set_page_config(page_title="설정 — KTMS", page_icon="⚙️", layout="wide")
except Exception:
    pass
require_auth()
inject_css()

section_header("settings", "설정 (Settings)")

_config_path = ROOT / "config" / "company.json"


# ══════════════════════════════════════════════════════════════════════════════
# Reusable master-data CRUD: select a row to edit/delete, else add a new one.
# ══════════════════════════════════════════════════════════════════════════════
def master_crud(*, model, order_by, label, list_cols, fields, key):
    """단일 폼으로 마스터 데이터를 추가/수정/삭제.

    list_cols : [(헤더, getter(record_dict)->값)]  — 목록 표 컬럼
    fields    : [{name, label, col(0/1), kind('text'|'num'|'select'),
                  required, options(name->value), default}]
    """
    sel_key = f"{key}_sel_id"
    ver_key = f"{key}_ver"
    ver = st.session_state.get(ver_key, 0)

    def _reset_selection():
        st.session_state[ver_key] = ver + 1
        st.session_state.pop(sel_key, None)

    # ── load records (detached dicts so we can use them after the session closes)
    session = get_session()
    try:
        records = session.query(model).order_by(order_by).all()
        recs = [{"id": r.id, **{f["name"]: getattr(r, f["name"]) for f in fields}}
                for r in records]
    finally:
        session.close()

    # ── selectable list
    if recs:
        df = pd.DataFrame([{"ID": d["id"], **{h: g(d) for h, g in list_cols}} for d in recs])
        event = st.dataframe(
            df, use_container_width=True, hide_index=True,
            selection_mode="single-row", on_select="rerun", key=f"{key}_table_{ver}",
        )
        sel_rows = event.selection.rows if hasattr(event, "selection") else []
        if sel_rows:
            st.session_state[sel_key] = int(df.iloc[sel_rows[0]]["ID"])
    else:
        st.caption("등록된 항목이 없습니다. 아래에서 추가하세요.")

    sel_id = st.session_state.get(sel_key)
    cur = next((d for d in recs if d["id"] == sel_id), None)
    if sel_id is not None and cur is None:        # selected row was deleted elsewhere
        _reset_selection()
        sel_id, cur = None, None
    editing = cur is not None
    fkey = sel_id if editing else "new"           # vary widget keys → defaults refresh

    st.markdown(f"#### {'✏️ ' + label + ' 수정' if editing else '➕ ' + label + ' 신규 추가'}")
    if editing:
        st.caption("다른 항목은 위 표에서 클릭 · 신규 입력은 '선택 해제'")

    with st.form(f"{key}_form"):
        cols = st.columns(2)
        values: dict = {}
        for f in fields:
            c = cols[f.get("col", 0)]
            wkey = f"{key}_{f['name']}_{fkey}"
            default = cur[f["name"]] if editing else f.get("default")
            kind = f.get("kind", "text")
            if kind == "select":
                opts = f["options"]
                names = list(opts.keys())
                cur_name = next((n for n, v in opts.items() if v == default), names[0])
                idx = names.index(cur_name) if cur_name in names else 0
                picked = c.selectbox(f["label"], names, index=idx, key=wkey)
                values[f["name"]] = opts[picked]
            elif kind == "num":
                values[f["name"]] = c.number_input(
                    f["label"], 0.0, step=1.0, value=float(default or 0.0), key=wkey)
            else:
                values[f["name"]] = c.text_input(f["label"], str(default or ""), key=wkey)

        if editing:
            cs, cc = st.columns(2)
            do_save  = cs.form_submit_button("수정 저장", type="primary", use_container_width=True)
            do_clear = cc.form_submit_button("선택 해제", use_container_width=True)
            del_confirm = st.checkbox(f"이 {label}를 삭제합니다 (확인)")
            do_del = st.form_submit_button("삭제", use_container_width=True)
        else:
            do_save = st.form_submit_button(f"{label} 추가", type="primary", use_container_width=True)
            do_clear = do_del = del_confirm = False

    req = [f for f in fields if f.get("required")]
    missing = any(not str(values[f["name"]]).strip() for f in req)

    if do_clear:
        _reset_selection()
        st.rerun()

    if do_save:
        if missing:
            st.error("필수 항목(*)을 입력하세요.")
        else:
            session = get_session()
            try:
                obj = session.query(model).get(sel_id) if editing else model()
                if not editing:
                    session.add(obj)
                for f in fields:
                    setattr(obj, f["name"], values[f["name"]])
                session.commit()
                clear_cached_reference_data()
                st.success("수정 완료!" if editing else f"{label} 추가 완료!")
            finally:
                session.close()
            if not editing:
                _reset_selection()
            st.rerun()

    if do_del:
        if not del_confirm:
            st.warning("삭제하려면 '삭제 확인'을 체크하세요.")
        else:
            session = get_session()
            try:
                session.delete(session.query(model).get(sel_id))
                session.commit()
                clear_cached_reference_data()
            finally:
                session.close()
            _reset_selection()
            st.success("삭제 완료!")
            st.rerun()


tabs = st.tabs(["🏢 회사 정보", "👤 사용자 관리", "🏭 Customer", "🔧 Vendor", "🚢 선박", "📦 품목 마스터"])

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
        save_co = st.form_submit_button("저장", type="primary")

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
    st.subheader("Customer 관리")
    master_crud(
        model=Customer, order_by=Customer.name, label="Customer",
        key="cust",
        list_cols=[
            ("Customer명", lambda d: d["name"]),
            ("국가",       lambda d: d["country"] or "—"),
            ("담당자",     lambda d: d["contact"] or "—"),
            ("이메일",     lambda d: d["email"] or "—"),
        ],
        fields=[
            {"name": "name",    "label": "Customer명 *",          "col": 0, "required": True},
            {"name": "country", "label": "국가",                  "col": 1},
            {"name": "address", "label": "주소",                  "col": 0},
            {"name": "contact", "label": "담당자",                "col": 1},
            {"name": "email",   "label": "이메일",                "col": 0},
            {"name": "tax_id",  "label": "Tax ID / 사업자번호",   "col": 1},
        ],
    )

# ══════════════════════════════════════════════════════════════════════════════
# VENDORS
# ══════════════════════════════════════════════════════════════════════════════
with tabs[3]:
    st.subheader("Vendor 관리")
    master_crud(
        model=Vendor, order_by=Vendor.name, label="Vendor",
        key="vendor",
        list_cols=[
            ("Vendor명",  lambda d: d["name"]),
            ("국가",      lambda d: d["country"] or "—"),
            ("담당자",    lambda d: d["contact"] or "—"),
            ("이메일",    lambda d: d["email"] or "—"),
            ("전문분야",  lambda d: d["specialization"] or "—"),
        ],
        fields=[
            {"name": "name",           "label": "Vendor명 *",                       "col": 0, "required": True},
            {"name": "country",        "label": "국가",                             "col": 1},
            {"name": "address",        "label": "주소",                             "col": 0},
            {"name": "contact",        "label": "담당자",                           "col": 1},
            {"name": "email",          "label": "이메일",                           "col": 0},
            {"name": "specialization", "label": "전문분야 (ex. MAN B&W Engine OEM)", "col": 1},
        ],
    )

# ══════════════════════════════════════════════════════════════════════════════
# VESSELS
# ══════════════════════════════════════════════════════════════════════════════
with tabs[4]:
    st.subheader("선박 관리")
    _cust_opts = {"— 없음 —": None, **customer_options()}

    def _owner_name(cid):
        if not cid:
            return "—"
        c = get_customer(cid)
        return c.name if c else "—"

    master_crud(
        model=Vessel, order_by=Vessel.name, label="선박",
        key="vessel",
        list_cols=[
            ("선박명",   lambda d: d["name"]),
            ("IMO",      lambda d: d["imo"] or "—"),
            ("엔진",     lambda d: d["engine_type"] or "—"),
            ("Hull No.", lambda d: d["hull_no"] or "—"),
            ("선주",     lambda d: _owner_name(d["customer_id"])),
        ],
        fields=[
            {"name": "name",        "label": "선박명 *",                          "col": 0, "required": True},
            {"name": "imo",         "label": "IMO No.",                           "col": 1},
            {"name": "engine_type", "label": "Main Engine Type",                  "col": 0},
            {"name": "hull_no",     "label": "Hull No.",                          "col": 1},
            {"name": "customer_id", "label": "선주 (Customer)", "col": 0,
             "kind": "select", "options": _cust_opts},
        ],
    )

# ══════════════════════════════════════════════════════════════════════════════
# ITEM MASTER
# ══════════════════════════════════════════════════════════════════════════════
with tabs[5]:
    st.subheader("품목 마스터 DB")
    master_crud(
        model=ItemMaster, order_by=ItemMaster.part_no, label="품목",
        key="item",
        list_cols=[
            ("Part No.",    lambda d: d["part_no"]),
            ("Description", lambda d: d["description"] or "—"),
            ("Maker",       lambda d: d["maker"] or "—"),
            ("Origin",      lambda d: d["origin"] or "—"),
            ("Unit",        lambda d: d["unit"]),
            ("HS Code",     lambda d: d["hs_code"] or "—"),
            ("기준단가",    lambda d: f"{float(d['std_price'] or 0):,.2f}"),
        ],
        fields=[
            {"name": "part_no",     "label": "Part No. *",     "col": 0, "required": True},
            {"name": "description", "label": "Description",    "col": 1},
            {"name": "maker",       "label": "Maker",          "col": 0},
            {"name": "origin",      "label": "Origin",         "col": 1},
            {"name": "unit",        "label": "Unit",           "col": 0, "default": "PCS"},
            {"name": "hs_code",     "label": "HS Code",        "col": 1},
            {"name": "std_price",   "label": "기준단가 (USD)", "col": 0, "kind": "num", "default": 0.0},
        ],
    )
