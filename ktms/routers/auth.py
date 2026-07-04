"""K-Maris TMS — auth routes (split from admin_api.py; behavior unchanged)."""
from __future__ import annotations

from _core import (
    Depends,
    HTTPException,
    LoginRequest,
    PERM_ACTIONS,
    PERM_MODULES,
    PERM_VIEW_ONLY,
    PasswordChangeReq,
    User,
    _make_jwt,
    _perms_for,
    _scope_for,
    app,
    bcrypt,
    get_current_user,
    get_session,
    require_token,
)



@app.post("/api/admin/login")
def admin_login(body: LoginRequest):
    s = get_session()
    try:
        user = s.query(User).filter_by(username=body.username, is_active=True).first()
        ok = bool(user) and bcrypt.checkpw(
            body.password.encode(), user.password_hash.encode()
        )
        if not ok:
            raise HTTPException(status_code=401, detail="사용자명 또는 비밀번호가 올바르지 않습니다.")
        role = user.role.value
        u = {"id": user.id, "username": user.username,
             "role": role, "email": user.email or ""}
        return {"token": _make_jwt(u), "user": u,
                "permissions": _perms_for(role), "scope": _scope_for(role)}
    finally:
        s.close()


@app.get("/api/admin/me")
def me(user: dict = Depends(get_current_user)):
    return user


@app.get("/api/admin/me/permissions")
def my_permissions(user: dict = Depends(get_current_user)):
    """현재 사용자의 효과적 권한 그리드 + 데이터 범위 + 메타데이터."""
    role = user.get("role", "")
    return {
        "role": role,
        "permissions": _perms_for(role),
        "scope": _scope_for(role),
        "modules": PERM_MODULES,
        "actions": PERM_ACTIONS,
        "view_only": sorted(PERM_VIEW_ONLY),
    }


@app.post("/api/admin/me/password", dependencies=[Depends(require_token)])
def change_my_password(body: PasswordChangeReq, user: dict = Depends(get_current_user)):
    """로그인한 본인의 비밀번호 변경 — 현재 비밀번호 확인 후 교체
    (Streamlit 8_Settings.py 비밀번호 변경 패리티)."""
    if not body.new_password or len(body.new_password) < 4:
        raise HTTPException(status_code=400, detail="새 비밀번호는 4자 이상이어야 합니다.")
    uid = user.get("id")
    s = get_session()
    try:
        u = s.query(User).filter_by(id=uid).first()
        if not u:
            raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다.")
        if not bcrypt.checkpw(body.old_password.encode(), u.password_hash.encode()):
            raise HTTPException(status_code=400, detail="현재 비밀번호가 올바르지 않습니다.")
        u.password_hash = bcrypt.hashpw(body.new_password.encode(), bcrypt.gensalt()).decode()
        s.commit()
        return {"ok": True}
    finally:
        s.close()
