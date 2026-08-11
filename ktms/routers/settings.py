"""K-Maris TMS — settings routes (split from admin_api.py; behavior unchanged)."""
from __future__ import annotations

from _core import (
    CompanyProfile,
    Customer,
    CustomerContact,
    CustomerCreate,
    MarketingActivity,
    Order,
    PurchaseOrder,
    Quotation,
    RFQ,
    ScheduleEvent,
    VendorContact,
    VendorRFQ,
    _apply_multi,
    _multi_out,
    _mv_list,
    Depends,
    EmailTemplate,
    EmailTemplateSave,
    EmailTemplatePreviewReq,
    EmailSignatureSave,
    File,
    UploadFile,
    _ocr_image_media_type,
    parse_business_card_image,
    parse_business_card_pdf_document,
    SIGNATURE_DOC_TYPE,
    resolve_signature,
    save_signature,
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
    USD_KRW_RATE,
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
    cached_aggregate,
    customer_options,
    datetime,
    get_current_user,
    get_session,
    require_token,
    vendor_options,
    VENDOR_RFQ_ITEM_COLS,
    VENDOR_RFQ_TOKENS,
    DEFAULT_VENDOR_RFQ_ITEM_COLS,
    vendor_rfq_default_subject_tpl,
    vendor_rfq_default_body_tpl,
    preview_vendor_rfq_template,
    intro_email_subject,
    intro_email_body_tpl,
    render_marketing_tokens,
    text_to_html_fragment,
    resolve_signature_fields,
    signature_html,
    signature_html_for,
    signature_text,
    default_sig_fields,
    normalize_sig_fields,
    html_document,
)
from pydantic import BaseModel
from sqlalchemy import func
from db.models import ItemPriceHistory
from services.item_ledger import (
    ledger_rows, item_history, rebuild_price_history, stamp_history_item, match_key,
)



@app.get("/api/admin/customers", dependencies=[Depends(require_token)])
@cached_aggregate()
def customers():
    # 이름순 + 거래 빈도(uses). 빈도 집계가 붙어 매 드롭다운마다 재계산하지 않도록 캐시한다.
    s = get_session()
    try:
        return customer_options(s)
    finally:
        s.close()


@app.get("/api/admin/vendors", dependencies=[Depends(require_token)])
@cached_aggregate()
def vendors():
    # 이름순 + 거래 빈도(uses). 빈도 집계가 붙어 매 드롭다운마다 재계산하지 않도록 캐시한다.
    s = get_session()
    try:
        return vendor_options(s)
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
                 "tax_invoice_email": getattr(c, "tax_invoice_email", None) or "",
                 "payment_terms": getattr(c, "payment_terms", None) or "",
                 "logo": getattr(c, "logo", None) or "",
                 "addresses": _multi_out(getattr(c, "addresses", None), c.address),
                 "emails": _multi_out(getattr(c, "emails", None), c.email),
                 "phones": _multi_out(getattr(c, "phones", None), getattr(c, "contact_phone", None)),
                 "regions": _multi_out(getattr(c, "regions", None), c.country)}
                for c in s.query(Customer).order_by(Customer.name).all()]
    finally:
        s.close()


@app.post("/api/admin/ocr/business-card", dependencies=[Depends(require_token)])
def ocr_business_card(file: UploadFile = File(...)):
    """명함 자동 입력 — 사진·캡쳐(이미지) 또는 PDF 스캔본을 Claude 비전으로 읽어
    회사·담당자·주소·사업자번호·이메일·연락처를 뽑아 준다(Customer/Vendor 등록 폼용)."""
    fname = (file.filename or "").lower()
    img_media = _ocr_image_media_type(file)
    try:
        file.file.seek(0)
        if img_media:
            data = parse_business_card_image(file.file.read(), img_media)
        elif fname.endswith(".pdf"):
            data = parse_business_card_pdf_document(file.file.read())
        else:
            raise HTTPException(status_code=400, detail="이미지(PNG·JPG·WEBP) 또는 PDF 파일만 업로드할 수 있습니다.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"명함 인식 실패: {exc}") from exc

    def _text(key: str) -> str:
        v = data.get(key)
        return str(v).strip() if v not in (None, "") else ""

    def _list(key: str) -> list[str]:
        raw = data.get(key)
        if isinstance(raw, str):
            raw = [raw]
        out, seen = [], set()
        for v in (raw or []):
            t = str(v).strip()
            if t and t.lower() not in seen:
                seen.add(t.lower())
                out.append(t)
        return out

    return {
        "company": _text("company"),
        "contact_name": _text("contact_name"),
        "job_title": _text("job_title"),
        "address": _text("address"),
        "tax_id": _text("tax_id"),
        "website": _text("website"),
        "emails": _list("emails"),
        "phones": _list("phones"),
        "regions": _list("regions"),
    }


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
                     tax_invoice_email=body.tax_invoice_email or "",
                     payment_terms=body.payment_terms or "",
                     logo=body.logo or "")
        s.add(c)
        # 다중 주소·이메일·연락처·지역 저장 + 첫 값(대표)을 flat 컬럼에 미러링.
        _apply_multi(c, body.emails, body.phones, body.regions, body.addresses)
        s.commit()
        return {"ok": True, "id": c.id}
    finally:
        s.close()


class CompanyInfoSave(BaseModel):
    """회사 공통정보 일괄 수정 — 레코드 1건 = 담당자 1명이라 주소·사업자번호 같은
    회사 단위 정보가 담당자 수만큼 복제돼 있다. 같은 회사명의 모든 레코드에 한 번에 반영한다.
    None 인 필드는 건드리지 않는다(빈 문자열 = 지우기)."""
    name: str
    rename: str | None = None            # 회사명 변경(같은 회사 전 레코드 일괄)
    # 본사·지사 주소 목록(첫 값=대표). flat address 는 여기서 파생된다.
    addresses: list[str] | None = None
    tax_id: str | None = None
    tax_invoice_email: str | None = None
    payment_terms: str | None = None
    specialization: str | None = None    # Vendor 전용(고객사에서는 무시)
    logo: str | None = None


def _company_rows(session, Model, name: str) -> list:
    """같은 회사명(대소문자·앞뒤 공백 무시)으로 등록된 레코드 전체."""
    key = (name or "").strip().lower()
    if not key:
        return []
    return [r for r in session.query(Model).all() if (r.name or "").strip().lower() == key]


def _apply_company_info(rows: list, body: CompanyInfoSave, fields: tuple[str, ...]) -> str:
    """회사 공통 필드를 rows 전체에 반영하고, 최종 회사명을 돌려준다.
    주소는 본사·지사 목록이라 리스트로 넣고 첫 값(대표)을 flat address 에 미러링한다."""
    new_name = (body.rename or "").strip()
    addrs = None if body.addresses is None else _mv_list(body.addresses)
    for r in rows:
        for f in fields:
            v = getattr(body, f)
            if v is not None:
                setattr(r, f, v)
        if addrs is not None:
            r.addresses = list(addrs)
            r.address = addrs[0] if addrs else ""
        if new_name:
            r.name = new_name
    return new_name or (body.name or "").strip()


@app.put("/api/admin/settings/customers/company-info", dependencies=[Depends(require_token)])
def update_customer_company(body: CompanyInfoSave):
    s = get_session()
    try:
        rows = _company_rows(s, Customer, body.name)
        if not rows:
            raise HTTPException(status_code=404, detail="해당 회사로 등록된 고객사가 없습니다.")
        name = _apply_company_info(
            rows, body, ("tax_id", "tax_invoice_email", "payment_terms", "logo"))
        s.commit()
        return {"ok": True, "updated": len(rows), "name": name}
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
        c.tax_invoice_email = body.tax_invoice_email or ""
        c.payment_terms = body.payment_terms or ""
        if body.logo is not None:
            c.logo = body.logo
        # 다중 주소·이메일·연락처·지역 갱신 + 첫 값(대표)을 flat 컬럼에 미러링.
        _apply_multi(c, body.emails, body.phones, body.regions, body.addresses)
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
        # 거래 기록(RFQ·견적·오더)이 있으면 삭제 불가 — 데이터 손상 방지, 명확히 안내.
        n_rfq = s.query(RFQ).filter_by(customer_id=c.id).count()
        n_qtn = s.query(Quotation).filter_by(customer_id=c.id).count()
        n_ord = s.query(Order).filter_by(customer_id=c.id).count()
        if n_rfq or n_qtn or n_ord:
            parts = []
            if n_rfq: parts.append(f"RFQ {n_rfq}건")
            if n_qtn: parts.append(f"견적 {n_qtn}건")
            if n_ord: parts.append(f"오더 {n_ord}건")
            raise HTTPException(status_code=400,
                detail=f"이 고객사에 연결된 {' · '.join(parts)}이(가) 있어 삭제할 수 없습니다. 거래 기록이 있는 고객사는 삭제 대신 보관하세요.")
        # 소프트 링크(선택 참조: 선박·마케팅·일정)는 연결만 해제하고 고객사를 삭제한다.
        s.query(Vessel).filter_by(customer_id=c.id).update({Vessel.customer_id: None}, synchronize_session=False)
        s.query(MarketingActivity).filter_by(customer_id=c.id).update({MarketingActivity.customer_id: None}, synchronize_session=False)
        s.query(ScheduleEvent).filter_by(customer_id=c.id).update({ScheduleEvent.customer_id: None}, synchronize_session=False)
        # 자식 담당자 삭제(FK 제약 회피) 후 고객사 삭제.
        s.query(CustomerContact).filter_by(customer_id=c.id).delete(synchronize_session=False)
        s.flush()
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
                 "logo": getattr(v, "logo", None) or "",
                 "addresses": _multi_out(getattr(v, "addresses", None), v.address),
                 "emails": _multi_out(getattr(v, "emails", None), v.email),
                 "phones": _multi_out(getattr(v, "phones", None), getattr(v, "contact_phone", None)),
                 "regions": _multi_out(getattr(v, "regions", None), v.country)}
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
        _apply_multi(v, body.emails, body.phones, body.regions, body.addresses)
        s.commit()
        return {"ok": True, "id": v.id}
    finally:
        s.close()


@app.put("/api/admin/settings/vendors/company-info", dependencies=[Depends(require_token)])
def update_vendor_company(body: CompanyInfoSave):
    s = get_session()
    try:
        rows = _company_rows(s, Vendor, body.name)
        if not rows:
            raise HTTPException(status_code=404, detail="해당 회사로 등록된 공급사가 없습니다.")
        name = _apply_company_info(
            rows, body, ("specialization", "payment_terms", "logo"))
        s.commit()
        return {"ok": True, "updated": len(rows), "name": name}
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
        _apply_multi(v, body.emails, body.phones, body.regions, body.addresses)
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
        # 거래 기록(발주 RFQ·발주서)이 있으면 삭제 불가.
        n_vrfq = s.query(VendorRFQ).filter_by(vendor_id=v.id).count()
        n_po = s.query(PurchaseOrder).filter_by(vendor_id=v.id).count()
        if n_vrfq or n_po:
            parts = []
            if n_vrfq: parts.append(f"발주 RFQ {n_vrfq}건")
            if n_po: parts.append(f"발주서 {n_po}건")
            raise HTTPException(status_code=400,
                detail=f"이 공급사에 연결된 {' · '.join(parts)}이(가) 있어 삭제할 수 없습니다. 거래 기록이 있는 공급사는 삭제 대신 보관하세요.")
        s.query(VendorContact).filter_by(vendor_id=v.id).delete(synchronize_session=False)
        s.flush()
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


@app.get("/api/admin/settings/item-ledger", dependencies=[Depends(require_token)])
def settings_item_ledger():
    """분류별 품목 구매가·판매가 롤업. matched(마스터 연결)+unmatched(미연결) 반환.

    프론트에서 분류 트리 선택으로 필터링하도록 category_id/category_path 를 함께 준다."""
    s = get_session()
    try:
        cat_by_id = _category_maps(s)
        data = ledger_rows(s)
        for it in data["items"]:
            it["category_path"] = _category_path(cat_by_id, it.get("category_id"))
        # 매입(buy)·매출(sell) 통화가 달라도 마진을 보이도록 USD 로 환산해 margin_pct 산출
        # (국내매입 KRW·수출 USD 케이스가 흔함). 환율은 앱 공통 상수(대시보드와 동일).
        for it in data["items"] + data["unmatched"]:
            _annotate_margin(it)
        built = s.query(func.max(ItemPriceHistory.created_at)).scalar()
        data["built_at"] = built.isoformat() if built else None
        return data
    finally:
        s.close()


@app.get("/api/admin/settings/item-category-map", dependencies=[Depends(require_token)])
def settings_item_category_map():
    """품목 식별키 → 현재 마스터 분류. 품목표(RFQ·견적·발주)의 Category 셀이
    라인에 저장된 값이 없을 때 마스터 분류를 그대로 보여주기 위해 쓴다.

    키 규칙은 services.item_ledger.match_key 와 동일('P:'+part_no 또는 'D:'+설명).
    분류는 마스터가 정본이므로, Item > Category 에서 배정한 결과가 이 맵을 통해
    프로젝트 품목표에도 그대로 나타난다."""
    s = get_session()
    try:
        cat_by_id = _category_maps(s)
        out: dict[str, dict] = {}
        for m in s.query(ItemMaster).order_by(ItemMaster.id).all():
            k = match_key(m.part_no, m.description)
            if not k or k in out:   # 중복 키는 가장 낮은 id 우선(build_master_index 와 동일)
                continue
            out[k] = {
                "item_id": m.id,
                "category_id": m.category_id,
                "category_path": _category_path(cat_by_id, m.category_id),
            }
        return out
    finally:
        s.close()


def _to_usd(price: float, cur: str | None, fx_rate: float | None) -> float:
    """KRW→USD 는 그 딜에 저장된 fx_rate(1 USD=? KRW) 우선, 없으면 앱 공통 환율."""
    if (cur or "USD") != "KRW":
        return price
    rate = fx_rate if (fx_rate and fx_rate > 0) else USD_KRW_RATE
    return price / rate


def _annotate_margin(it: dict) -> None:
    """ledger 행에 margin_pct(USD 환산 %)와 margin_cross(통화 상이 여부) 부착.

    통화가 다르면 각 가격의 저장 fx_rate 로 USD 환산 후 마진 계산(딜 실제 환율 반영).
    fx_rate 가 없는 소스(PO/오더 등)만 공통 환율로 대체."""
    b, sell = it.get("buy"), it.get("sell")
    it["margin_pct"] = None
    it["margin_cross"] = False
    if b and sell and sell.get("unit_price"):
        su = _to_usd(sell["unit_price"], sell.get("currency"), sell.get("fx_rate"))
        if su:
            bu = _to_usd(b["unit_price"], b.get("currency"), b.get("fx_rate"))
            it["margin_pct"] = round((su - bu) / su * 100, 1)
            it["margin_cross"] = (b.get("currency") or "USD") != (sell.get("currency") or "USD")


@app.get("/api/admin/settings/item-ledger/history", dependencies=[Depends(require_token)])
def settings_item_ledger_history(
    item_id: int | None = None, part_no: str | None = None, description: str | None = None,
):
    """한 품목의 buy/sell 이력(최신순). 고객·공급사·선박 이름을 해석해 붙인다."""
    s = get_session()
    try:
        rows = item_history(s, item_id=item_id, part_no=part_no, description=description)
        cust = {c.id: c.name for c in s.query(Customer).all()}
        vend = {v.id: v.name for v in s.query(Vendor).all()}
        vess = {v.id: v.name for v in s.query(Vessel).all()}
        for r in rows:
            r["customer"] = cust.get(r.get("customer_id")) or ""
            r["vendor"] = vend.get(r.get("vendor_id")) or ""
            r["vessel"] = vess.get(r.get("vessel_id")) or ""
        return rows
    finally:
        s.close()


@app.post("/api/admin/settings/item-ledger/rebuild", dependencies=[Depends(require_token)])
def rebuild_item_ledger():
    """품목 구매/판매가 이력을 소스 문서에서 전체 재구축(관리자). 반환=생성 행수."""
    s = get_session()
    try:
        n = rebuild_price_history(s)
        return {"ok": True, "rows": n}
    finally:
        s.close()


class ItemLedgerAssign(BaseModel):
    category_id: int | None = None   # 배정할 분류(가장 깊은 노드). None=미분류로도 가능
    item_id: int | None = None       # 이미 마스터 연결된 품목 재분류 시
    part_no: str | None = None       # 미연결 품목 배정 시(마스터 신규 생성/연결 키)
    description: str | None = ""
    maker: str | None = ""


def _assign_one_category(s, target: "ItemLedgerAssign") -> tuple[int, int]:
    """품목 1건에 분류를 배정하고 (item_id, 스탬프된 이력 행수) 반환. commit 은 호출자 책임.

    - item_id 있으면: 해당 마스터의 category_id 갱신(재분류).
    - 없으면 part_no(없으면 description) 로: 정규화 일치하는 기존 마스터가 있으면
      연결·분류, 없으면 신규 생성. 이후 같은 키의 미연결 이력 행을 즉시 스탬프."""
    if target.item_id:
        master = s.query(ItemMaster).filter_by(id=target.item_id).first()
        if not master:
            raise HTTPException(status_code=404, detail="Item을 찾을 수 없습니다.")
        master.category_id = target.category_id
    else:
        pn = (target.part_no or "").strip()
        desc = (target.description or "").strip()
        key = match_key(pn, desc)   # part_no 없으면 description 으로 식별(서비스 항목)
        if not key:
            raise HTTPException(status_code=400, detail="Part No.·설명이 모두 없는 품목은 분류할 수 없습니다.")
        master = next((m for m in s.query(ItemMaster).all()
                       if match_key(m.part_no, m.description) == key), None)
        if master:
            master.category_id = target.category_id
        else:
            master = ItemMaster(
                part_no=pn, description=desc, maker=(target.maker or ""),
                unit="PCS", category_id=target.category_id,
            )
            s.add(master)
    s.flush()
    return master.id, stamp_history_item(s, master.id)


@app.post("/api/admin/settings/item-ledger/assign", dependencies=[Depends(require_token)])
def assign_item_ledger_category(body: ItemLedgerAssign):
    """가격 이력 화면에서 품목 1건에 분류를 배정한다(전체 rebuild 불필요)."""
    s = get_session()
    try:
        item_id, stamped = _assign_one_category(s, body)
        s.commit()
        return {"ok": True, "item_id": item_id, "stamped": stamped}
    finally:
        s.close()


class ItemLedgerAssignBulk(BaseModel):
    """여러 품목을 한 분류로 일괄 배정(목록에서 체크박스로 고른 행들)."""
    category_id: int | None = None
    targets: list[ItemLedgerAssign] = []


@app.post("/api/admin/settings/item-ledger/assign-bulk", dependencies=[Depends(require_token)])
def assign_item_ledger_category_bulk(body: ItemLedgerAssignBulk):
    """선택한 품목들을 한 분류로 일괄 배정. 한 트랜잭션으로 처리한다.

    분류할 수 없는 행(Part No.·설명이 모두 없음)은 실패로 세고 건너뛴다 —
    한 행 때문에 나머지 배정이 통째로 무효가 되지 않도록."""
    s = get_session()
    try:
        done = 0
        stamped = 0
        skipped = 0
        for t in body.targets:
            # 목록에서 온 각 행의 category_id 는 무시하고 일괄 지정값을 쓴다.
            t.category_id = body.category_id
            try:
                _, n = _assign_one_category(s, t)
            except HTTPException:
                skipped += 1
                continue
            done += 1
            stamped += n
        s.commit()
        return {"ok": True, "assigned": done, "stamped": stamped, "skipped": skipped}
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


# ── 이메일 템플릿(담당자별 초안) ────────────────────────────────────────────
# 설정 화면에서 편집할 수 있는 이메일 종류. key = EmailTemplate.doc_type 이며,
# 발송 화면들이 같은 doc_type 으로 템플릿을 찾아 쓴다(개인 → 회사 기본 → 내장 기본).
#   item_cols=True  : {{item_list}} 컬럼 선택이 있는 종류(Vendor RFQ)
EMAIL_DOC_TYPES: dict[str, dict] = {
    "vendor_rfq": {
        "label": "Vendor RFQ",
        "tokens": VENDOR_RFQ_TOKENS,
        "item_cols": True,
    },
    "marketing_intro": {
        "label": "Company Introduction",
        "tokens": ["contact", "customer"],
        "item_cols": False,
        "marketing_kind": "intro",
    },
}
# 브로슈어는 별도 템플릿 없이 회사소개 메일에 파일만 첨부하는 방식으로 정리해서,
# 편집 대상 종류에서 뺐다. 저장된 marketing_brochure 행은 건드리지 않는다(무해).


def _email_doc_spec(doc_type: str) -> dict:
    spec = EMAIL_DOC_TYPES.get(doc_type)
    if not spec:
        raise HTTPException(status_code=400, detail=f"알 수 없는 이메일 종류입니다: {doc_type}")
    return spec


def _email_tpl_defaults(doc_type: str, lang: str) -> dict:
    """코드 내장 기본 템플릿(저장된 게 없을 때 편집기에 채워지는 값)."""
    spec = _email_doc_spec(doc_type)
    kind = spec.get("marketing_kind")
    if kind:
        lang_n = "kr" if lang == "ko" else "en"
        return {"subject_tpl": intro_email_subject(kind, lang_n),
                "body_tpl": intro_email_body_tpl(kind, lang_n)}
    return {"subject_tpl": vendor_rfq_default_subject_tpl(lang),
            "body_tpl": vendor_rfq_default_body_tpl(lang)}


def _email_tpl_row(s, user_id, doc_type: str, lang: str):
    t = (s.query(EmailTemplate)
         .filter_by(user_id=user_id, doc_type=doc_type, lang=lang).first())
    if not t:
        return None
    return {"subject_tpl": t.subject_tpl or "", "body_tpl": t.body_tpl or "",
            "options": t.options or {}}


@app.get("/api/admin/settings/email-templates", dependencies=[Depends(require_token)])
def get_email_templates(doc_type: str = "vendor_rfq",
                        user: dict = Depends(get_current_user)):
    """현재 사용자 개인 템플릿 + 회사 기본값 + 코드 내장 기본값/토큰·컬럼 카탈로그."""
    spec = _email_doc_spec(doc_type)
    has_cols = bool(spec["item_cols"])
    s = get_session()
    try:
        uid = user.get("id")
        langs = ("en", "ko")
        return {
            "doc_type": doc_type,
            "is_admin": user.get("role") == "admin",
            # 편집 가능한 이메일 종류 탭 목록(설정 화면이 그대로 그린다).
            "doc_types": [{"key": k, "label": v["label"]} for k, v in EMAIL_DOC_TYPES.items()],
            "tokens": spec["tokens"],
            "item_cols": ([{"key": k, "label_en": v[0], "label_ko": v[1]}
                           for k, v in VENDOR_RFQ_ITEM_COLS.items()] if has_cols else []),
            "default_item_cols": DEFAULT_VENDOR_RFQ_ITEM_COLS if has_cols else [],
            "defaults": {lang: _email_tpl_defaults(doc_type, lang) for lang in langs},
            "user": {lang: _email_tpl_row(s, uid, doc_type, lang) for lang in langs},
            "company": {lang: _email_tpl_row(s, None, doc_type, lang) for lang in langs},
        }
    finally:
        s.close()


@app.put("/api/admin/settings/email-templates", dependencies=[Depends(require_token)])
def save_email_template(body: EmailTemplateSave, user: dict = Depends(get_current_user)):
    """개인/회사 이메일 템플릿 upsert. 회사(company) 편집은 admin 만."""
    spec = _email_doc_spec(body.doc_type)
    scope = "company" if body.scope == "company" else "user"
    if scope == "company" and user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="회사 기본 템플릿은 admin만 편집할 수 있습니다.")
    lang = "ko" if body.lang == "ko" else "en"
    user_id = None if scope == "company" else user.get("id")
    if spec["item_cols"]:
        cols = [c for c in ((body.options or {}).get("item_cols") or [])
                if c in VENDOR_RFQ_ITEM_COLS]
        opts = {"item_cols": cols or DEFAULT_VENDOR_RFQ_ITEM_COLS}
    else:
        opts = {}
    s = get_session()
    try:
        t = (s.query(EmailTemplate)
             .filter_by(user_id=user_id, doc_type=body.doc_type, lang=lang).first())
        if not t:
            t = EmailTemplate(user_id=user_id, doc_type=body.doc_type, lang=lang)
            s.add(t)
        t.subject_tpl = body.subject_tpl or ""
        t.body_tpl = body.body_tpl or ""
        t.options = opts
        t.updated_at = datetime.utcnow()
        s.commit()
        return {"ok": True, "scope": scope, "lang": lang}
    finally:
        s.close()


@app.delete("/api/admin/settings/email-templates", dependencies=[Depends(require_token)])
def delete_email_template(scope: str = "user", doc_type: str = "vendor_rfq",
                          lang: str = "en", user: dict = Depends(get_current_user)):
    """템플릿 삭제(= 상위 기본값으로 초기화). 회사(company)는 admin 만."""
    scope = "company" if scope == "company" else "user"
    if scope == "company" and user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="회사 기본 템플릿은 admin만 편집할 수 있습니다.")
    lang = "ko" if lang == "ko" else "en"
    user_id = None if scope == "company" else user.get("id")
    s = get_session()
    try:
        t = (s.query(EmailTemplate)
             .filter_by(user_id=user_id, doc_type=doc_type, lang=lang).first())
        if t:
            s.delete(t)
            s.commit()
        return {"ok": True}
    finally:
        s.close()


@app.get("/api/admin/settings/email-signature", dependencies=[Depends(require_token)])
def get_email_signature(lang: str = "en", user_id: int | None = None,
                        user: dict = Depends(get_current_user)):
    """발송 화면에 채울 담당자 서명 — 개인 → 회사 기본 → 내장 기본 순으로 해석한 값과,
    개인 서명을 따로 저장해 뒀는지 여부(is_personal)를 함께 준다.

    user_id 를 주면 그 담당자의 서명을 본다(발송 화면의 '서명 불러오기', 관리자의 대리
    편집). 서명은 메일에 그대로 실려 나가는 공개 정보라 읽기는 막지 않는다."""
    lang = "ko" if lang == "ko" else "en"
    s = get_session()
    try:
        uid = user_id or user.get("id")
        own = (s.query(EmailTemplate)
               .filter_by(user_id=uid, doc_type=SIGNATURE_DOC_TYPE, lang=lang).first())
        fields = resolve_signature_fields(s, uid, lang)
        return {
            "lang": lang,
            "user_id": uid,
            "signature": resolve_signature(s, uid, lang),
            "is_personal": bool(own and (own.body_tpl or "").strip()),
            # 구조화(표) 서명 — 없으면 편집 폼을 채울 출발값을 대신 준다.
            "fields": fields or default_sig_fields(lang, _sig_user_seed(s, uid, user)),
            "has_fields": bool(fields),
            "html": signature_html(fields, lang) if fields else "",
        }
    finally:
        s.close()


def _sig_user_seed(s, uid, user: dict) -> dict:
    """서명 폼 첫 입력값에 쓸 담당자 정보(이름·이메일). 로그인 사용자 본인이면
    토큰에 담긴 이름도 대비책으로 쓴다."""
    u = s.query(User).filter_by(id=uid).first() if uid else None
    fallback = (user.get("username") or "") if uid == user.get("id") else ""
    return {
        "name": (getattr(u, "name", "") or getattr(u, "username", "") or fallback or ""),
        "email": (getattr(u, "email", "") or ""),
    }


@app.get("/api/admin/email/signatures", dependencies=[Depends(require_token)])
def list_email_signatures(lang: str = "en", user: dict = Depends(get_current_user)):
    """담당자별 서명 목록 — 발송 화면에서 "누구 이름으로 서명할지" 고르는 선택지.

    개인 서명을 저장해 둔 담당자 전원 + (없더라도) 로그인 사용자를 준다. 평문까지 함께
    내려 화면에서 고르는 즉시 서명칸이 바뀌게 한다(추가 왕복 없음)."""
    lang = "ko" if lang == "ko" else "en"
    s = get_session()
    try:
        me = user.get("id")
        rows = []
        for t, u in (s.query(EmailTemplate, User)
                     .join(User, User.id == EmailTemplate.user_id)
                     .filter(EmailTemplate.doc_type == SIGNATURE_DOC_TYPE,
                             EmailTemplate.lang == lang)
                     .all()):
            text = (t.body_tpl or "").strip()
            if not text or not u.is_active:
                continue
            rows.append({
                "user_id": u.id,
                "username": u.username,
                "name": getattr(u, "name", "") or u.username,
                "signature": text,
                "is_default": False,
            })
        if not any(r["user_id"] == me for r in rows):
            # 아직 개인 서명을 안 만든 사용자 — 회사/내장 기본이 그의 서명이다.
            rows.append({
                "user_id": me,
                "username": user.get("username") or user.get("name") or "me",
                "name": _sig_user_seed(s, me, user)["name"] or "Me",
                "signature": resolve_signature(s, me, lang),
                "is_default": True,
            })
        # 본인 먼저, 그다음 이름순 — 자기 서명이 늘 첫 선택지가 되게.
        rows.sort(key=lambda r: (r["user_id"] != me, (r["name"] or "").lower()))
        return {"lang": lang, "me": me, "rows": rows}
    finally:
        s.close()


@app.put("/api/admin/settings/email-signature", dependencies=[Depends(require_token)])
def put_email_signature(body: EmailSignatureSave, user: dict = Depends(get_current_user)):
    """담당자 개인 서명 저장 — 이후 모든 단계 발송 화면의 기본 서명이 된다.
    fields 를 주면 표 서명(HTML), 없으면 평문 서명으로 저장한다.
    빈 값으로 저장하면 개인 서명을 지우고 회사/내장 기본으로 되돌아간다.
    남의 서명을 대신 만들어 두는 건 관리자만 할 수 있다."""
    lang = "ko" if body.lang == "ko" else "en"
    uid = body.user_id or user.get("id")
    if uid != user.get("id") and user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="다른 담당자의 서명은 관리자만 편집할 수 있습니다.")
    s = get_session()
    try:
        save_signature(s, uid, lang, body.signature, getattr(body, "fields", None))
        fields = resolve_signature_fields(s, uid, lang)
        return {
            "ok": True,
            "user_id": uid,
            "signature": resolve_signature(s, uid, lang),
            "html": signature_html(fields, lang) if fields else "",
        }
    finally:
        s.close()


@app.post("/api/admin/settings/email-signature/preview", dependencies=[Depends(require_token)])
def preview_email_signature(body: EmailSignatureSave):
    """편집 중인 서명 필드 → 발송에 쓰일 HTML/평문 그대로. 저장 전 미리보기용."""
    lang = "ko" if body.lang == "ko" else "en"
    fields = normalize_sig_fields(getattr(body, "fields", None) or {}, lang)
    return {"html": signature_html(fields, lang), "text": signature_text(fields, lang)}


@app.post("/api/admin/settings/email-templates/preview", dependencies=[Depends(require_token)])
def preview_email_template(body: EmailTemplatePreviewReq):
    """미저장 템플릿을 샘플 데이터로 렌더 — 편집 중 실시간 미리보기용.
    body_html 은 실제 발송 HTML 파트와 같은 렌더러를 태운 결과라, 미리보기가 곧
    수신자가 보게 될 모습이다."""
    spec = _email_doc_spec(body.doc_type)
    kind = spec.get("marketing_kind")
    if kind:
        lang = "ko" if body.lang == "ko" else "en"
        lang_n = "kr" if lang == "ko" else "en"
        d = _email_tpl_defaults(body.doc_type, lang)
        contact = "조예빈 부장" if lang == "ko" else "Wu Sheng"
        customer = "SENDA group"
        subject = render_marketing_tokens(
            body.subject_tpl or d["subject_tpl"], contact, customer, lang_n)
        mail_body = render_marketing_tokens(
            body.body_tpl or d["body_tpl"], contact, customer, lang_n)
    else:
        subject, mail_body = preview_vendor_rfq_template(
            body.subject_tpl, body.body_tpl, body.options, body.lang)
    return {
        "subject": subject,
        "body": mail_body,
        "body_html": text_to_html_fragment(mail_body),
    }


class EmailRenderReq(BaseModel):
    """작성 화면에서 편집 중인 본문(토큰 치환 끝난 평문)과 서명."""
    text: str = ""
    signature: str = ""
    include_signature: bool = True


@app.post("/api/admin/email/render-preview", dependencies=[Depends(require_token)])
def render_email_preview(body: EmailRenderReq, user: dict = Depends(get_current_user)):
    """평문 본문(+서명) → 발송 HTML 파트와 똑같은 조각. 발송 화면 미리보기가 클라이언트
    에서 따로 렌더하면 실제 메일과 어긋나므로, 서버의 렌더러 하나만 쓴다.
    서명 처리도 발송과 같은 규칙이다 — 저장된 표 서명 그대로면 표로, 손댔으면 평문으로."""
    text = body.text or ""
    sig = (body.signature or "").strip()
    if not (body.include_signature and sig):
        return {"html": text_to_html_fragment(text)}
    s = get_session()
    try:
        sig_html = signature_html_for(s, user.get("id"), sig)
    finally:
        s.close()
    if sig_html:
        return {"html": text_to_html_fragment(text) + sig_html}
    return {"html": text_to_html_fragment(f"{text.rstrip()}\n\n{sig}\n")}


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
