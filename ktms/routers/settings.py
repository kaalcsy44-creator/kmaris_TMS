"""K-Maris TMS — settings routes (split from admin_api.py; behavior unchanged)."""
from __future__ import annotations

from _core import (
    CompanyProfile,
    Customer,
    CustomerCreate,
    Depends,
    HTTPException,
    ItemCategory,
    ItemCategorySave,
    ItemMaster,
    ItemMasterSave,
    PERM_ACTIONS,
    PERM_MODULES,
    PERM_VIEW_ONLY,
    RolePermSave,
    RolePermission,
    User,
    UserRole,
    UserSave,
    Vendor,
    VendorCreate,
    Vessel,
    VesselCreate,
    _enum_val,
    _full_perms,
    _normalize_perms,
    _perms_for,
    _read_company_profile,
    _reload_perms,
    _scope_for,
    _write_company_profile,
    app,
    bcrypt,
    datetime,
    get_current_user,
    get_session,
    require_token,
)



@app.get("/api/admin/customers", dependencies=[Depends(require_token)])
def customers():
    s = get_session()
    try:
        return [{"id": c.id, "name": c.name, "contact": c.contact or "",
                 "logo": getattr(c, "logo", None) or ""}
                for c in s.query(Customer).order_by(Customer.name).all()]
    finally:
        s.close()


@app.get("/api/admin/vendors", dependencies=[Depends(require_token)])
def vendors():
    s = get_session()
    try:
        return [{"id": v.id, "name": v.name, "email": v.email or "",
                 "logo": getattr(v, "logo", None) or ""}
                for v in s.query(Vendor).order_by(Vendor.name).all()]
    finally:
        s.close()


@app.get("/api/admin/settings/customers", dependencies=[Depends(require_token)])
def settings_customers():
    s = get_session()
    try:
        return [{"id": c.id, "name": c.name, "contact": c.contact or "",
                 "contact_phone": getattr(c, "contact_phone", None) or "",
                 "email": c.email or "", "country": c.country or "",
                 "address": c.address or "", "tax_id": c.tax_id or "",
                 "payment_terms": getattr(c, "payment_terms", None) or "",
                 "logo": getattr(c, "logo", None) or ""}
                for c in s.query(Customer).order_by(Customer.name).all()]
    finally:
        s.close()


@app.post("/api/admin/settings/customers", dependencies=[Depends(require_token)])
def create_customer(body: CustomerCreate):
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="이름을 입력하세요.")
    s = get_session()
    try:
        c = Customer(name=body.name.strip(), contact=body.contact or "",
                     contact_phone=body.contact_phone or "",
                     email=body.email or "", country=body.country or "",
                     address=body.address or "", tax_id=body.tax_id or "",
                     payment_terms=body.payment_terms or "",
                     logo=body.logo or "")
        s.add(c)
        s.commit()
        return {"ok": True, "id": c.id}
    finally:
        s.close()


@app.put("/api/admin/settings/customers/{row_id}", dependencies=[Depends(require_token)])
def update_customer(row_id: int, body: CustomerCreate):
    s = get_session()
    try:
        c = s.query(Customer).filter_by(id=row_id).first()
        if not c:
            raise HTTPException(status_code=404, detail="Customer를 찾을 수 없습니다.")
        c.name = body.name.strip()
        c.contact = body.contact or ""
        c.contact_phone = body.contact_phone or ""
        c.email = body.email or ""
        c.country = body.country or ""
        c.address = body.address or ""
        c.tax_id = body.tax_id or ""
        c.payment_terms = body.payment_terms or ""
        if body.logo is not None:
            c.logo = body.logo
        s.commit()
        return {"ok": True, "id": c.id}
    finally:
        s.close()


@app.delete("/api/admin/settings/customers/{row_id}", dependencies=[Depends(require_token)])
def delete_customer(row_id: int):
    s = get_session()
    try:
        c = s.query(Customer).filter_by(id=row_id).first()
        if not c:
            raise HTTPException(status_code=404, detail="Customer를 찾을 수 없습니다.")
        s.delete(c)
        s.commit()
        return {"ok": True}
    finally:
        s.close()


@app.get("/api/admin/settings/vendors", dependencies=[Depends(require_token)])
def settings_vendors():
    s = get_session()
    try:
        return [{"id": v.id, "name": v.name, "contact": v.contact or "",
                 "contact_phone": getattr(v, "contact_phone", None) or "",
                 "email": v.email or "", "specialization": v.specialization or "",
                 "country": v.country or "", "address": v.address or "",
                 "payment_terms": getattr(v, "payment_terms", None) or "",
                 "logo": getattr(v, "logo", None) or ""}
                for v in s.query(Vendor).order_by(Vendor.name).all()]
    finally:
        s.close()


@app.post("/api/admin/settings/vendors", dependencies=[Depends(require_token)])
def create_vendor(body: VendorCreate):
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="이름을 입력하세요.")
    s = get_session()
    try:
        v = Vendor(name=body.name.strip(), contact=body.contact or "",
                   contact_phone=body.contact_phone or "",
                   email=body.email or "", specialization=body.specialization or "",
                   country=body.country or "", address=body.address or "",
                   payment_terms=body.payment_terms or "",
                   logo=body.logo or "")
        s.add(v)
        s.commit()
        return {"ok": True, "id": v.id}
    finally:
        s.close()


@app.put("/api/admin/settings/vendors/{row_id}", dependencies=[Depends(require_token)])
def update_vendor(row_id: int, body: VendorCreate):
    s = get_session()
    try:
        v = s.query(Vendor).filter_by(id=row_id).first()
        if not v:
            raise HTTPException(status_code=404, detail="Vendor를 찾을 수 없습니다.")
        v.name = body.name.strip()
        v.contact = body.contact or ""
        v.contact_phone = body.contact_phone or ""
        v.email = body.email or ""
        v.specialization = body.specialization or ""
        v.country = body.country or ""
        v.address = body.address or ""
        v.payment_terms = body.payment_terms or ""
        if body.logo is not None:
            v.logo = body.logo
        s.commit()
        return {"ok": True, "id": v.id}
    finally:
        s.close()


@app.delete("/api/admin/settings/vendors/{row_id}", dependencies=[Depends(require_token)])
def delete_vendor(row_id: int):
    s = get_session()
    try:
        v = s.query(Vendor).filter_by(id=row_id).first()
        if not v:
            raise HTTPException(status_code=404, detail="Vendor를 찾을 수 없습니다.")
        s.delete(v)
        s.commit()
        return {"ok": True}
    finally:
        s.close()


@app.get("/api/admin/settings/vessels", dependencies=[Depends(require_token)])
def settings_vessels():
    s = get_session()
    try:
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        return [{"id": v.id, "name": v.name, "imo": v.imo or "",
                 "vessel_type": getattr(v, "vessel_type", None) or "",
                 "ais_flag": getattr(v, "ais_flag", None) or "",
                 "engine_type": v.engine_type or "", "hull_no": v.hull_no or "",
                 "customer_id": v.customer_id, "customer": cust_names.get(v.customer_id, "") if v.customer_id else ""}
                for v in s.query(Vessel).order_by(Vessel.name).all()]
    finally:
        s.close()


@app.post("/api/admin/settings/vessels", dependencies=[Depends(require_token)])
def create_vessel(body: VesselCreate):
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="선박명을 입력하세요.")
    s = get_session()
    try:
        v = Vessel(name=body.name.strip(), imo=body.imo or "",
                   vessel_type=body.vessel_type or "",
                   ais_flag=body.ais_flag or "",
                   customer_id=body.customer_id,
                   engine_type=body.engine_type or "",
                   hull_no=body.hull_no or "")
        s.add(v)
        s.commit()
        return {"ok": True, "id": v.id}
    finally:
        s.close()


@app.put("/api/admin/settings/vessels/{row_id}", dependencies=[Depends(require_token)])
def update_vessel(row_id: int, body: VesselCreate):
    s = get_session()
    try:
        v = s.query(Vessel).filter_by(id=row_id).first()
        if not v:
            raise HTTPException(status_code=404, detail="Vessel을 찾을 수 없습니다.")
        v.name = body.name.strip()
        v.imo = body.imo or ""
        v.vessel_type = body.vessel_type or ""
        v.ais_flag = body.ais_flag or ""
        v.customer_id = body.customer_id
        v.engine_type = body.engine_type or ""
        v.hull_no = body.hull_no or ""
        s.commit()
        return {"ok": True, "id": v.id}
    finally:
        s.close()


@app.delete("/api/admin/settings/vessels/{row_id}", dependencies=[Depends(require_token)])
def delete_vessel(row_id: int):
    s = get_session()
    try:
        v = s.query(Vessel).filter_by(id=row_id).first()
        if not v:
            raise HTTPException(status_code=404, detail="Vessel을 찾을 수 없습니다.")
        s.delete(v)
        s.commit()
        return {"ok": True}
    finally:
        s.close()


# ── Item categories (품목 분류 트리: 대>중>소) ─────────────────────────────────

def _category_maps(s):
    """(cat_by_id, path_str) 헬퍼용 원천. cat_by_id: {id: ItemCategory}."""
    cats = s.query(ItemCategory).all()
    return {c.id: c for c in cats}


def _category_path(cat_by_id, cid):
    """분류 id → '대 > 중 > 소' 문자열. 없으면 ''. 순환 방어(최대 5뎁스)."""
    if not cid or cid not in cat_by_id:
        return ""
    names = []
    cur = cat_by_id.get(cid)
    seen = set()
    while cur is not None and cur.id not in seen and len(names) < 5:
        seen.add(cur.id)
        names.append(cur.name)
        cur = cat_by_id.get(cur.parent_id) if cur.parent_id else None
    return " > ".join(reversed(names))


@app.get("/api/admin/settings/item-categories", dependencies=[Depends(require_token)])
def settings_item_categories():
    """분류 트리 전체를 flat 리스트로 반환(프론트에서 parent_id 로 트리 구성)."""
    s = get_session()
    try:
        cats = (s.query(ItemCategory)
                .order_by(ItemCategory.level, ItemCategory.sort_order, ItemCategory.name)
                .all())
        cat_by_id = {c.id: c for c in cats}
        return [{
            "id": c.id, "parent_id": c.parent_id, "level": c.level or 1,
            "name": c.name or "", "sort_order": c.sort_order or 0,
            "active": bool(c.active), "path": _category_path(cat_by_id, c.id),
        } for c in cats]
    finally:
        s.close()


@app.post("/api/admin/settings/item-categories", dependencies=[Depends(require_token)])
def create_item_category(body: ItemCategorySave):
    if not (body.name or "").strip():
        raise HTTPException(status_code=400, detail="분류명을 입력하세요.")
    s = get_session()
    try:
        level = 1
        if body.parent_id:
            parent = s.query(ItemCategory).filter_by(id=body.parent_id).first()
            if not parent:
                raise HTTPException(status_code=400, detail="상위 분류를 찾을 수 없습니다.")
            level = (parent.level or 1) + 1
            if level > 3:
                raise HTTPException(status_code=400, detail="분류는 최대 3단계(대>중>소)까지입니다.")
        c = ItemCategory(
            name=body.name.strip(), parent_id=body.parent_id,
            level=level, sort_order=body.sort_order or 0,
            active=True if body.active is None else bool(body.active),
        )
        s.add(c)
        s.commit()
        return {"ok": True, "id": c.id}
    finally:
        s.close()


@app.put("/api/admin/settings/item-categories/{row_id}", dependencies=[Depends(require_token)])
def update_item_category(row_id: int, body: ItemCategorySave):
    s = get_session()
    try:
        c = s.query(ItemCategory).filter_by(id=row_id).first()
        if not c:
            raise HTTPException(status_code=404, detail="분류를 찾을 수 없습니다.")
        if (body.name or "").strip():
            c.name = body.name.strip()
        if body.sort_order is not None:
            c.sort_order = body.sort_order
        if body.active is not None:
            c.active = bool(body.active)
        s.commit()
        return {"ok": True, "id": c.id}
    finally:
        s.close()


@app.delete("/api/admin/settings/item-categories/{row_id}", dependencies=[Depends(require_token)])
def delete_item_category(row_id: int):
    """분류 삭제. 하위 분류나 이 분류를 참조하는 품목이 있으면 막는다(데이터 보호)."""
    s = get_session()
    try:
        c = s.query(ItemCategory).filter_by(id=row_id).first()
        if not c:
            raise HTTPException(status_code=404, detail="분류를 찾을 수 없습니다.")
        if s.query(ItemCategory).filter_by(parent_id=row_id).count() > 0:
            raise HTTPException(status_code=400, detail="하위 분류가 있어 삭제할 수 없습니다. 먼저 하위 분류를 삭제하세요.")
        if s.query(ItemMaster).filter_by(category_id=row_id).count() > 0:
            raise HTTPException(status_code=400, detail="이 분류를 사용하는 품목이 있어 삭제할 수 없습니다.")
        s.delete(c)
        s.commit()
        return {"ok": True}
    finally:
        s.close()


@app.get("/api/admin/settings/items", dependencies=[Depends(require_token)])
def settings_items():
    s = get_session()
    try:
        cat_by_id = _category_maps(s)
        return [{
            "id": i.id, "part_no": i.part_no or "",
            "description": i.description or "", "maker": i.maker or "",
            "origin": i.origin or "", "unit": i.unit or "PCS",
            "hs_code": i.hs_code or "", "std_price": i.std_price or 0.0,
            "category_id": i.category_id,
            "category_path": _category_path(cat_by_id, i.category_id),
        } for i in s.query(ItemMaster).order_by(ItemMaster.part_no).all()]
    finally:
        s.close()


@app.post("/api/admin/settings/items", dependencies=[Depends(require_token)])
def create_item(body: ItemMasterSave):
    if not body.part_no.strip():
        raise HTTPException(status_code=400, detail="Part No.를 입력하세요.")
    s = get_session()
    try:
        item = ItemMaster(
            part_no=body.part_no.strip(), description=body.description or "",
            maker=body.maker or "", origin=body.origin or "",
            unit=body.unit or "PCS", hs_code=body.hs_code or "",
            std_price=body.std_price or 0.0, category_id=body.category_id,
        )
        s.add(item)
        s.commit()
        return {"ok": True, "id": item.id}
    finally:
        s.close()


@app.put("/api/admin/settings/items/{row_id}", dependencies=[Depends(require_token)])
def update_item(row_id: int, body: ItemMasterSave):
    s = get_session()
    try:
        item = s.query(ItemMaster).filter_by(id=row_id).first()
        if not item:
            raise HTTPException(status_code=404, detail="Item을 찾을 수 없습니다.")
        item.part_no = body.part_no.strip()
        item.description = body.description or ""
        item.maker = body.maker or ""
        item.origin = body.origin or ""
        item.unit = body.unit or "PCS"
        item.hs_code = body.hs_code or ""
        item.std_price = body.std_price or 0.0
        item.category_id = body.category_id
        s.commit()
        return {"ok": True, "id": item.id}
    finally:
        s.close()


@app.delete("/api/admin/settings/items/{row_id}", dependencies=[Depends(require_token)])
def delete_item(row_id: int):
    s = get_session()
    try:
        item = s.query(ItemMaster).filter_by(id=row_id).first()
        if not item:
            raise HTTPException(status_code=404, detail="Item을 찾을 수 없습니다.")
        s.delete(item)
        s.commit()
        return {"ok": True}
    finally:
        s.close()


@app.get("/api/admin/settings/company", dependencies=[Depends(require_token)])
def settings_company():
    return _read_company_profile()


@app.put("/api/admin/settings/company", dependencies=[Depends(require_token)])
def update_company(body: CompanyProfile):
    data = body.dict()
    _write_company_profile(data)
    return {"ok": True}


@app.get("/api/admin/settings/permissions", dependencies=[Depends(require_token)])
def settings_permissions(user: dict = Depends(get_current_user)):
    """역할별 권한 매트릭스(admin 전용 조회). admin 행은 전체 고정(편집 불가)."""
    if user.get("role") != UserRole.ADMIN.value:
        raise HTTPException(status_code=403, detail="Admin only")
    editable = [UserRole.SALES.value, UserRole.VIEWER.value]
    roles = [{
        "role": UserRole.ADMIN.value, "perms": _full_perms(True),
        "scope": "all", "editable": False,
    }]
    for r in editable:
        roles.append({
            "role": r, "perms": _perms_for(r), "scope": _scope_for(r), "editable": True,
        })
    return {
        "roles": roles,
        "modules": PERM_MODULES,
        "actions": PERM_ACTIONS,
        "view_only": sorted(PERM_VIEW_ONLY),
    }


@app.put("/api/admin/settings/permissions", dependencies=[Depends(require_token)])
def update_permissions(body: RolePermSave, user: dict = Depends(get_current_user)):
    """역할 권한 저장(admin 전용). admin 역할은 변경 불가(잠금 방지)."""
    if user.get("role") != UserRole.ADMIN.value:
        raise HTTPException(status_code=403, detail="Admin only")
    role = (body.role or "").strip()
    if role == UserRole.ADMIN.value:
        raise HTTPException(status_code=400, detail="admin 역할의 권한은 변경할 수 없습니다.")
    if role not in (UserRole.SALES.value, UserRole.VIEWER.value):
        raise HTTPException(status_code=400, detail=f"알 수 없는 역할: {role}")
    scope = "own" if body.scope == "own" else "all"
    perms = _normalize_perms(body.perms)
    s = get_session()
    try:
        rp = s.query(RolePermission).filter_by(role=role).first()
        if rp:
            rp.perms = perms
            rp.scope = scope
            rp.updated_at = datetime.utcnow()
        else:
            s.add(RolePermission(role=role, perms=perms, scope=scope))
        s.commit()
    finally:
        s.close()
    _reload_perms()
    return {"ok": True, "role": role, "perms": _perms_for(role), "scope": _scope_for(role)}


@app.get("/api/admin/assignable-users", dependencies=[Depends(require_token)])
def assignable_users():
    """담당자(PIC) 지정용 직원 목록 — id/username 만. (admin 외 편집자도 사용)"""
    s = get_session()
    try:
        return [{"id": u.id, "username": u.username}
                for u in s.query(User).filter_by(is_active=True)
                .order_by(User.username).all()]
    finally:
        s.close()


@app.get("/api/admin/settings/users", dependencies=[Depends(require_token)])
def settings_users(user: dict = Depends(get_current_user)):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    s = get_session()
    try:
        return [{
            "id": u.id, "username": u.username,
            "email": u.email or "", "role": _enum_val(u.role),
            "is_active": bool(u.is_active),
        } for u in s.query(User).order_by(User.username).all()]
    finally:
        s.close()


@app.post("/api/admin/settings/users", dependencies=[Depends(require_token)])
def create_user(body: UserSave, user: dict = Depends(get_current_user)):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    if not body.username.strip() or not body.password:
        raise HTTPException(status_code=400, detail="사용자명과 비밀번호를 입력하세요.")
    s = get_session()
    try:
        u = User(
            username=body.username.strip(),
            email=body.email or "",
            password_hash=bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode(),
            role=UserRole(body.role),
            is_active=body.is_active,
        )
        s.add(u)
        s.commit()
        return {"ok": True, "id": u.id}
    finally:
        s.close()


@app.put("/api/admin/settings/users/{row_id}", dependencies=[Depends(require_token)])
def update_user(row_id: int, body: UserSave, user: dict = Depends(get_current_user)):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    s = get_session()
    try:
        u = s.query(User).filter_by(id=row_id).first()
        if not u:
            raise HTTPException(status_code=404, detail="User를 찾을 수 없습니다.")
        u.username = body.username.strip()
        u.email = body.email or ""
        u.role = UserRole(body.role)
        u.is_active = body.is_active
        if body.password:
            u.password_hash = bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode()
        s.commit()
        return {"ok": True, "id": u.id}
    finally:
        s.close()


@app.delete("/api/admin/settings/users/{row_id}", dependencies=[Depends(require_token)])
def delete_user(row_id: int, user: dict = Depends(get_current_user)):
    """사용자 삭제(admin 전용). 본인 계정과 마지막 활성 관리자 계정은 lockout
    방지를 위해 삭제를 막는다. 비활성화는 update_user 의 is_active 로 가능."""
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    if row_id == user.get("id"):
        raise HTTPException(status_code=400, detail="본인 계정은 삭제할 수 없습니다.")
    s = get_session()
    try:
        u = s.query(User).filter_by(id=row_id).first()
        if not u:
            raise HTTPException(status_code=404, detail="User를 찾을 수 없습니다.")
        if _enum_val(u.role) == "admin" and u.is_active:
            active_admins = (s.query(User)
                             .filter(User.role == UserRole.ADMIN, User.is_active.is_(True))
                             .count())
            if active_admins <= 1:
                raise HTTPException(status_code=400,
                    detail="마지막 활성 관리자 계정은 삭제할 수 없습니다.")
        s.delete(u)
        s.commit()
        return {"ok": True}
    finally:
        s.close()
