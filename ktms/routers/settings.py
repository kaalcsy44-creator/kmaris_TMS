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
    VendorQuote,
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
    Consultant,
    ConsultantCreate,
    Maker,
    MakerCreate,
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
import re as _re
from pydantic import BaseModel
from sqlalchemy import func
from db.models import ItemPriceHistory
from services.item_ledger import (
    build_master_index,
    ledger_rows, item_history, rebuild_price_history, stamp_history_item, match_key,
    master_price_summary, master_party_fallback, ensure_price_history_fresh,
    guess_item_type, category_item_type, suggest_categories, category_ship_map,
    fit_part, fit_desc,
)
import _core



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
        deals = _customer_deal_counts(s)
        return [{"id": c.id, "name": c.name, "contact": c.contact or "",
                 "contact_phone": getattr(c, "contact_phone", None) or "",
                 "email": c.email or "", "country": c.country or "",
                 "address": c.address or "", "tax_id": c.tax_id or "",
                 "specialization": c.specialization or "",
                 "website": getattr(c, "website", None) or "",
                 "tax_invoice_email": getattr(c, "tax_invoice_email", None) or "",
                 "note": getattr(c, "note", None) or "",
                 "payment_terms": getattr(c, "payment_terms", None) or "",
                 "logo": getattr(c, "logo", None) or "",
                 "addresses": _multi_out(getattr(c, "addresses", None), c.address),
                 "emails": _multi_out(getattr(c, "emails", None), c.email),
                 "phones": _multi_out(getattr(c, "phones", None), getattr(c, "contact_phone", None)),
                 "regions": _multi_out(getattr(c, "regions", None), c.country),
                 # 이 담당자가 준 문의와 그 결과. 회사 줄의 합계는 화면에서 더한다 —
                 # RFQ 는 고객 담당자 하나에만 매이므로 담당자별 수를 더해도 겹치지 않는다
                 # (벤더 쪽은 한 프로젝트가 담당자 둘에 걸릴 수 있어 서버에서 합집합을 센다).
                 **deals.get(c.id, _EMPTY_DEALS)}
                for c in s.query(Customer).order_by(Customer.name).all()]
    finally:
        s.close()


_EMPTY_DEALS = {"inquiries": 0, "won": 0, "lost": 0}


def _customer_deal_counts(s) -> dict:
    """고객 담당자별 {문의 수, 성사, 실주}. 문의는 RFQ 1건이 1건이다.

    성사는 그 RFQ 에 오더(고객 P/O)가 등록됐는지로 본다. RFQ.status 로도 알 수 있지만
    그 값은 사람이 단계를 밟는 사이 뒤늦게 바뀌곤 해서, 실제로 P/O 를 받았다는 증거인
    orders 행을 기준으로 삼는다 — 벤더 쪽에서 답변을 VendorQuote 존재로 본 것과 같다.
    실주는 상태가 '실주'인 것만 세고, 성사도 실주도 아닌 것은 아직 진행 중이다(그래서
    성사/문의 는 지금까지의 결과일 뿐, 최종 승률이 아니다 — 화면 설명도 그렇게 적는다).
    """
    ordered = {r[0] for r in s.query(Order.rfq_id).all() if r[0]}
    out: dict[int, dict] = {}
    for rid, cid, status in s.query(RFQ.id, RFQ.customer_id, RFQ.status).all():
        if not cid:
            continue
        d = out.setdefault(cid, {"inquiries": 0, "won": 0, "lost": 0})
        d["inquiries"] += 1
        if rid in ordered:
            d["won"] += 1
        elif _enum_val(status) == "실주":
            d["lost"] += 1
    return out


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
                     specialization=body.specialization or "",
                     note=body.note or "",
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
    specialization: str | None = None    # 취급품목(벤더) · 주로 사는 것(고객사)
    # 취급 분류(item_categories.id 목록) — 벤더 전용. 회사 단위라 여기서 함께 받는다.
    category_ids: list[int] | None = None
    website: str | None = None           # 회사 홈페이지
    note: str | None = None              # 회사 소개 요약(고객사·거래선 공통)
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
            rows, body,
            ("tax_id", "tax_invoice_email", "specialization", "website", "note",
             "payment_terms", "logo"))
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
        c.specialization = body.specialization or ""
        if body.note is not None:
            c.note = body.note
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
        asked, answered = _vendor_deal_counts(s)
        vendors = s.query(Vendor).order_by(Vendor.name).all()
        # 회사 단위 합계 — 목록이 회사로 묶여 보이는데, 한 회사의 담당자 둘에게 같은
        # 프로젝트를 물었으면 담당자별 수를 더한 값은 그 프로젝트를 두 번 센다. 그래서
        # 회사 칸은 더하지 않고 프로젝트 id 를 합집합으로 모아 다시 센다.
        co_asked: dict[str, set] = {}
        co_answered: dict[str, set] = {}
        for v in vendors:
            key = (v.name or "").strip()
            co_asked.setdefault(key, set()).update(asked.get(v.id, ()))
            co_answered.setdefault(key, set()).update(answered.get(v.id, ()))

        return [{"id": v.id, "name": v.name, "contact": v.contact or "",
                 "contact_phone": getattr(v, "contact_phone", None) or "",
                 "email": v.email or "", "specialization": v.specialization or "",
                 "website": getattr(v, "website", None) or "",
                 "note": getattr(v, "note", None) or "",
                 # 취급 분류 — 화면이 배지로 세운다. 트리에 없는 id(분류를 지운 뒤 남은
                 # 값)는 화면이 무시한다: 태그를 지우자고 삭제 경로를 만들 일이 아니다.
                 "category_ids": [int(x) for x in (getattr(v, "category_ids", None) or [])
                                  if isinstance(x, (int, float, str)) and str(x).isdigit()],
                 "country": v.country or "", "address": v.address or "",
                 "payment_terms": getattr(v, "payment_terms", None) or "",
                 "logo": getattr(v, "logo", None) or "",
                 "addresses": _multi_out(getattr(v, "addresses", None), v.address),
                 "emails": _multi_out(getattr(v, "emails", None), v.email),
                 "phones": _multi_out(getattr(v, "phones", None), getattr(v, "contact_phone", None)),
                 "regions": _multi_out(getattr(v, "regions", None), v.country),
                 # 이 담당자에게 물은 프로젝트 수와 그중 견적이 돌아온 수.
                 "deals": len(asked.get(v.id, ())),
                 "deals_answered": len(answered.get(v.id, ())),
                 # 같은 회사 전체의 값(위 합집합) — 목록의 회사 줄이 쓴다.
                 "co_deals": len(co_asked.get((v.name or "").strip(), ())),
                 "co_deals_answered": len(co_answered.get((v.name or "").strip(), ()))}
                for v in vendors]
    finally:
        s.close()


def _vendor_deal_counts(s) -> tuple[dict, dict]:
    """벤더별 {물어본 프로젝트}, {답이 온 프로젝트}. 값은 rfq_id 집합이다.

    같은 프로젝트에 같은 벤더로 RFQ 가 두 번 나가는 일이 있어(품목이 갈리거나 다시
    물어서) 건수가 아니라 프로젝트로 센다 — 목록이 답하려는 질문이 "이 벤더와 몇 건
    해 봤나"이지 "메일을 몇 번 보냈나"가 아니라서다. 답변은 그 Vendor RFQ 에 견적이
    한 건이라도 달렸는지로 본다(_core 의 벤더 견적 저장과 같은 기준).
    """
    quoted = {r[0] for r in s.query(VendorQuote.vendor_rfq_id).all() if r[0]}
    asked: dict[int, set] = {}
    answered: dict[int, set] = {}
    for vid, rfq_id, vendor_id in s.query(
            VendorRFQ.id, VendorRFQ.rfq_id, VendorRFQ.vendor_id).all():
        if not vendor_id or not rfq_id:
            continue
        asked.setdefault(vendor_id, set()).add(rfq_id)
        if vid in quoted:
            answered.setdefault(vendor_id, set()).add(rfq_id)
    return asked, answered


# 배지로 세울 분류의 깊이 — 중분류까지다. 소분류(3단계)까지 태그하면 벤더 하나가
# 스무 개를 달게 되어 배지가 이름을 덮고, 정작 "이 회사는 무엇을 하는가"가 안 읽힌다.
# 소분류의 실적은 그 중분류로 접어 올린다(아래 _up_to_level2).
VENDOR_TAG_LEVEL = 2


def _up_to_level2(cats: dict, cid: int | None) -> int | None:
    """분류 id → 그것이 속한 중분류(2단계) id. 이미 1·2단계면 그대로.

    품목 마스터는 가장 깊은 노드(보통 소분류)를 들고 있는데, 벤더 태그는 중분류까지만
    쓴다. 부모를 타고 올라가 접는다 — 트리가 망가져 부모가 끊긴 값은 버린다(무한히
    돌지 않도록 깊이도 함께 막는다)."""
    hop = 0
    while cid and hop < 8:
        c = cats.get(cid)
        if c is None:
            return None
        if (c.level or 1) <= VENDOR_TAG_LEVEL:
            return c.id
        cid = c.parent_id
        hop += 1
    return None


# 취급품목 글귀에서 분류 이름을 알아볼 때 뜻을 담지 않는 말 — vendor_match 의 것을
# 그대로 쓴다(같은 글을 두 곳이 서로 다른 기준으로 읽으면 안 된다).
from services.vendor_match import _STOP as _SPEC_STOP   # noqa: E402

_WORD_RE = _re.compile(r"[A-Za-z][A-Za-z0-9&+]{1,}|[가-힣]{2,}")


def _words(text: str) -> set[str]:
    return {w.lower() for w in _WORD_RE.findall(text or "")}


def _spec_hits_category(spec_words: set[str], cat_name: str) -> bool:
    """취급품목 글귀가 이 분류를 가리키는가.

    분류 이름에서 뜻 없는 말(system·part·equipment…)을 뺀 낱말이 **전부** 글귀에
    들어 있어야 한다. 하나만 겹쳐도 맞다고 하면 'Main Engine System' 이 'Marine
    engine spares' 를 적어 둔 거의 모든 벤더에게 걸려, 기관실이 로고로 뒤덮인다.
    전부를 요구하면 'Crane'·'Winch'·'Boiler' 처럼 한 낱말로 서는 분류가 정확히
    걸리고 — 그것이 이 규칙에서 실제로 쓸모 있는 몫이다.
    """
    need = {w for w in _words(cat_name) if w not in _SPEC_STOP}
    return bool(need) and need <= spec_words


def _vendor_marks(s) -> list[dict]:
    """분류 → 그 분류를 다루는 거래선. Ship View 가 계통마다 세우는 마크의 원천.

    지금까지 이 판은 "이 계통에 품목이 몇 개 걸려 있나"만 말했다. 그런데 계통이 비어
    있다는 사실은 두 가지 중 하나다 — 아직 일이 없었거나, **물어볼 데가 없거나**.
    둘은 전혀 다른 문제인데 숫자 0 으로는 갈리지 않는다. 거래선을 함께 세우면 갈린다.

    세기가 셋이다. 섞지 않고 각자의 이름으로 돌려준다:
      supplied  그 계통의 품목을 실제로 발주(P/O)한 곳.
      quoted    값을 준 곳. 사지 않았어도 — 실주한 딜이라도 — 그 회사가 그것을 다룬다는
                사실은 남는다. 다음에 물어볼 곳을 찾는 것이 이 화면의 쓸모라서다.
      listed    거래 이력은 없고 다룬다고 밝혀 둔 곳. 분류 태그(category_ids)이거나,
                취급품목 글귀가 그 분류 이름을 그대로 담고 있는 경우다.

    **발주와 견적은 소스 문서로 갈린다.** 매입(buy) 가격 이력에는 발주(po)와 벤더
    견적(vendor_quote)이 함께 들어 있어서(services/item_ledger), price_type 만 보고
    세면 견적만 주고 끝난 거래선이 공급한 곳으로 찍힌다.

    회사명으로 묶는다 — 레코드 1건 = 담당자 1명이라 담당자 수만큼 같은 마크가 서면
    한 회사가 계통 하나를 혼자 덮는다."""
    cats = {c.id: c for c in s.query(ItemCategory).all()}
    cat_of_item = {m.id: m.category_id for m in s.query(ItemMaster).all()}
    vendors = s.query(Vendor).all()
    name_of = {v.id: (v.name or "").strip() for v in vendors}

    # 센 것이 이긴다 — 한 회사가 같은 계통에서 사기도 하고 견적도 줬으면 '샀다'로 선다.
    _RANK = {"listed": 0, "quoted": 1, "supplied": 2}
    # {분류 id: {회사명: (tier, 근거 한 줄)}}
    marks: dict[int, dict[str, tuple[str, str]]] = {}

    def put(cid, company: str, tier: str, why: str):
        if not cid or not company or cid not in cats:
            return
        slot = marks.setdefault(cid, {})
        cur = slot.get(company)
        if cur is None or _RANK[tier] > _RANK[cur[0]]:
            slot[company] = (tier, why)

    # ── listed: 밝혀 둔 것 ────────────────────────────────────────────────
    for v in vendors:
        co = (v.name or "").strip()
        for cid in (getattr(v, "category_ids", None) or []):
            try:
                put(int(cid), co, "listed", "Listed as their category")
            except (TypeError, ValueError):
                continue
        # 태그를 아직 안 단 회사가 대부분이라, 취급품목 글귀도 함께 읽는다. 태그가 정본이고
        # 이쪽은 그때까지의 다리다 — 그래서 같은 'listed' 지만 근거 문구가 다르다.
        spec = _words(f"{v.specialization or ''} ")
        if spec:
            for c in cats.values():
                if (c.level or 1) <= VENDOR_TAG_LEVEL and _spec_hits_category(spec, c.name):
                    put(c.id, co, "listed", f"Specialization mentions {c.name}")

    # ── quoted / supplied: 실제 거래 ──────────────────────────────────────
    for h in (s.query(ItemPriceHistory)
              .filter(ItemPriceHistory.price_type == "buy",
                      ItemPriceHistory.vendor_id.isnot(None)).all()):
        if not h.item_id:
            continue
        supplied = h.source_type == "po"
        put(_up_to_level2(cats, cat_of_item.get(h.item_id)),
            name_of.get(h.vendor_id, ""),
            "supplied" if supplied else "quoted",
            "Supplied on this system" if supplied else "Quoted on this system")

    out: list[dict] = []
    for cid, companies in marks.items():
        # 센 근거부터 — 잘려 나가는 쪽은 늘 약한 쪽이어야 한다.
        for co, (tier, why) in sorted(companies.items(),
                                      key=lambda kv: (-_RANK[kv[1][0]], kv[0].lower())):
            out.append({"category_id": cid, "name": co, "tier": tier, "why": why})
    return out


@app.get("/api/admin/settings/vendors/category-suggestions",
         dependencies=[Depends(require_token)])
def vendor_category_suggestions():
    """거래 실적에서 뽑은 취급 분류 제안 — 회사명 → 그 회사가 다뤄 본 중분류 목록.

    태그를 처음부터 손으로 채우게 하면 아무도 안 채운다. 그런데 "이 회사가 무엇을
    다루는가"는 이미 장부에 있다 — 우리가 무엇을 샀고, 무엇에 값을 받아 봤는지.
    그것을 첫 값으로 내밀고 사람은 확인·보정만 하게 한다.

    근거는 둘뿐이다. 실제로 산 것(bought)과 값을 준 것(quoted). '물어본 것'은 넣지
    않는다 — 우리가 물었다는 사실은 그 회사가 그걸 다룬다는 뜻이 아니라서, 넣으면
    한 번 두루 물어본 벤더가 배 전체를 태그로 뒤덮는다.

    산 것과 값을 준 것은 **소스 문서로 갈린다**. 매입(buy) 가격 이력에는 발주(po)와
    벤더 견적(vendor_quote)이 함께 들어 있어서(services/item_ledger), price_type 만
    보고 세면 견적만 주고 끝난 거래선이 '공급한 곳'이 된다.

    회사명으로 묶는다. 레코드 1건 = 담당자 1명이라 vendor_id 로 묶으면 같은 회사가
    담당자별로 갈려, 담당자 A 에게 산 분류가 담당자 B 에는 없는 것이 된다."""
    s = get_session()
    try:
        cats = {c.id: c for c in s.query(ItemCategory).all()}
        cat_of_item = {m.id: m.category_id for m in s.query(ItemMaster).all()}
        name_of = {v.id: (v.name or "").strip() for v in s.query(Vendor).all()}

        # {회사명: {중분류 id: [kind, 건수, 최근일]}} — kind 는 센 근거가 이긴다.
        found: dict[str, dict[int, list]] = {}

        def touch(vendor_id, cid, kind: str, when: str):
            co = name_of.get(vendor_id or 0, "")
            node = _up_to_level2(cats, cid)
            if not co or not node:
                return
            slot = found.setdefault(co, {}).setdefault(node, ["quoted", 0, ""])
            if kind == "bought":
                slot[0] = "bought"
            slot[1] += 1
            if (when or "") > slot[2]:
                slot[2] = when or ""

        for h in (s.query(ItemPriceHistory)
                  .filter(ItemPriceHistory.price_type == "buy",
                          ItemPriceHistory.vendor_id.isnot(None)).all()):
            if h.item_id:
                touch(h.vendor_id, cat_of_item.get(h.item_id),
                      "bought" if h.source_type == "po" else "quoted", h.doc_date or "")

        # 벤더 견적 — 값을 줬다는 것은 그것을 다룬다는 뜻이다. 품목은 견적 줄이 아니라
        # 그 견적이 답한 Vendor RFQ 의 줄에서 읽는다(견적 줄에는 분류가 안 붙어 있다).
        vrfq = {v.id: v for v in s.query(VendorRFQ).all()}
        idx = build_master_index(s)
        for q in s.query(VendorQuote).all():
            v = vrfq.get(q.vendor_rfq_id)
            if v is None or not v.vendor_id:
                continue
            when = (getattr(q, "received_at", "") or "")[:10]
            for it in (v.items if isinstance(v.items, list) else []):
                if not isinstance(it, dict):
                    continue
                mid = idx.get(match_key(it.get("part_no"), it.get("description")))
                if mid:
                    touch(v.vendor_id, cat_of_item.get(mid), "quoted", when)

        def path_of(cid: int) -> str:
            c = cats.get(cid)
            if c is None:
                return ""
            top = cats.get(c.parent_id) if c.parent_id else None
            return f"{top.name} > {c.name}" if top else c.name

        return {"rows": [{
            "company": co,
            "categories": [{
                "id": cid, "path": path_of(cid),
                "kind": v[0], "count": v[1], "last": v[2],
            } for cid, v in sorted(nodes.items(), key=lambda kv: (-kv[1][1], kv[0]))],
        } for co, nodes in sorted(found.items())]}
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
                   note=body.note or "",
                   country=body.country or "", address=body.address or "",
                   payment_terms=body.payment_terms or "",
                   category_ids=list(body.category_ids or []),
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
            rows, body,
            ("specialization", "category_ids", "website", "note", "payment_terms", "logo"))
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
        if body.note is not None:
            v.note = body.note
        v.country = body.country or ""
        v.address = body.address or ""
        v.payment_terms = body.payment_terms or ""
        if body.category_ids is not None:
            v.category_ids = list(body.category_ids)
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


# ── Maker(제조사) ─────────────────────────────────────────────────────────────
# 거래선과 나란한 또 하나의 상대처지만 담당자를 두지 않는다 — 부품은 거래선을 통해 사고
# 메이커에는 우리가 직접 두드리는 창구가 없다. 회사 한 곳 = 한 줄이라, 고객·거래선 쪽의
# 회사 단위 일괄편집(company-info)도 여기엔 없다.


def _maker_item_counts(s) -> dict[str, int]:
    """메이커 이름 → 그 이름으로 등록된 품목 수.

    품목 마스터의 maker 칸은 자유 텍스트라 대소문자·앞뒤 공백이 제각각이다. 명부와
    맞춰 세려면 양쪽을 같은 방식으로 눕혀야 한다 — 이 숫자가 목록에서 "이 회사 물건을
    우리가 몇 개나 다뤄 봤나"를 답하는 유일한 칸이라서다."""
    out: dict[str, int] = {}
    for (mk,) in s.query(ItemMaster.maker).all():
        k = " ".join((mk or "").split()).lower()
        if k:
            out[k] = out.get(k, 0) + 1
    return out


def _maker_row(m, counts: dict[str, int]) -> dict:
    return {
        "id": m.id, "name": m.name,
        "email": m.email or "",
        "contact_phone": getattr(m, "contact_phone", None) or "",
        "country": m.country or "", "address": m.address or "",
        "website": getattr(m, "website", None) or "",
        "specialization": m.specialization or "",
        "note": getattr(m, "note", None) or "",
        "logo": getattr(m, "logo", None) or "",
        "addresses": _multi_out(getattr(m, "addresses", None), m.address),
        "emails": _multi_out(getattr(m, "emails", None), m.email),
        "phones": _multi_out(getattr(m, "phones", None), getattr(m, "contact_phone", None)),
        "regions": _multi_out(getattr(m, "regions", None), m.country),
        "category_ids": [int(x) for x in (getattr(m, "category_ids", None) or [])
                         if isinstance(x, (int, float, str)) and str(x).isdigit()],
        # 이 회사가 만든 것으로 등록된 품목 수 — 거래선 목록의 'Projects' 자리에 선다.
        "items": counts.get(" ".join((m.name or "").split()).lower(), 0),
    }


@app.get("/api/admin/settings/makers", dependencies=[Depends(require_token)])
def settings_makers():
    s = get_session()
    try:
        counts = _maker_item_counts(s)
        return [_maker_row(m, counts) for m in s.query(Maker).order_by(Maker.name).all()]
    finally:
        s.close()


@app.post("/api/admin/settings/makers", dependencies=[Depends(require_token)])
def create_maker(body: MakerCreate):
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="이름을 입력하세요.")
    s = get_session()
    try:
        m = Maker(name=body.name.strip(), email=body.email or "",
                  contact_phone=body.contact_phone or "",
                  country=body.country or "", address=body.address or "",
                  website=body.website or "", specialization=body.specialization or "",
                  note=body.note or "", logo=body.logo or "",
                  category_ids=list(body.category_ids or []))
        s.add(m)
        _apply_multi(m, body.emails, body.phones, body.regions, body.addresses)
        s.commit()
        return {"ok": True, "id": m.id}
    finally:
        s.close()


@app.put("/api/admin/settings/makers/{row_id}", dependencies=[Depends(require_token)])
def update_maker(row_id: int, body: MakerCreate):
    s = get_session()
    try:
        m = s.query(Maker).filter_by(id=row_id).first()
        if not m:
            raise HTTPException(status_code=404, detail="Maker를 찾을 수 없습니다.")
        m.name = body.name.strip()
        m.email = body.email or ""
        m.contact_phone = body.contact_phone or ""
        m.country = body.country or ""
        m.address = body.address or ""
        m.website = body.website or ""
        m.specialization = body.specialization or ""
        if body.note is not None:
            m.note = body.note
        if body.logo is not None:
            m.logo = body.logo
        if body.category_ids is not None:
            m.category_ids = list(body.category_ids)
        _apply_multi(m, body.emails, body.phones, body.regions, body.addresses)
        s.commit()
        return {"ok": True, "id": m.id}
    finally:
        s.close()


@app.delete("/api/admin/settings/makers/{row_id}", dependencies=[Depends(require_token)])
def delete_maker(row_id: int):
    """명부에서만 지운다 — 품목의 maker 칸(자유 텍스트)은 그대로 남는다.

    지운다고 그 부품을 그 회사가 만들지 않은 것이 되지는 않는다. 명부는 '아는 회사의
    목록'이고 품목에 적힌 이름은 그 부품의 사실이라, 둘의 수명이 다르다."""
    s = get_session()
    try:
        m = s.query(Maker).filter_by(id=row_id).first()
        if not m:
            raise HTTPException(status_code=404, detail="Maker를 찾을 수 없습니다.")
        s.delete(m)
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


# ── Consultants (소개자 마스터) ───────────────────────────────────────────────
# 고객·거래선과 같은 모양의 CRUD 다. 다른 점은 담는 것이 계좌라는 것 — 이 마스터가
# 답하는 질문은 "누구에게 연락하나"가 아니라 "수수료를 어디로 보내나"이다.

def _consultant_row(c) -> dict:
    return {
        "id": c.id,
        "name": c.name or "",
        "company": c.company or "",
        "phone": c.phone or "",
        "email": c.email or "",
        "country": c.country or "",
        "tax_id": c.tax_id or "",
        "bank_name": c.bank_name or "",
        "bank_account": c.bank_account or "",
        "bank_holder": c.bank_holder or "",
        "swift": c.swift or "",
        # 미지정(NULL)은 0 이 아니라 기본 10% 로 읽는다 — 화면·수수료 계산이 같은 규칙.
        "default_rate": c.default_rate if c.default_rate is not None else 10.0,
        # 계좌 통화 — 기록용이다. 수수료는 그 딜을 판 통화 그대로 지급하므로(달러로 받은
        # 돈에서 떼어 달러로 보낸다) 지급 통화를 여기서 정하지 않는다. 다만 달러 계좌가
        # 있는지는 송금 전에 알아야 하는 사실이라 남긴다.
        "currency": c.currency or "KRW",
        "notes": c.notes or "",
    }


def _apply_consultant(c, body: ConsultantCreate) -> None:
    c.name = body.name.strip()
    c.company = (body.company or "").strip()
    c.phone = (body.phone or "").strip()
    c.email = (body.email or "").strip()
    c.country = (body.country or "").strip()
    c.tax_id = (body.tax_id or "").strip()
    c.bank_name = (body.bank_name or "").strip()
    c.bank_account = (body.bank_account or "").strip()
    c.bank_holder = (body.bank_holder or "").strip()
    c.swift = (body.swift or "").strip()
    c.default_rate = 10.0 if body.default_rate is None else float(body.default_rate)
    c.currency = (body.currency or "KRW").upper()
    c.notes = (body.notes or "").strip()


@app.get("/api/admin/settings/consultants", dependencies=[Depends(require_token)])
def settings_consultants():
    s = get_session()
    try:
        return [_consultant_row(c) for c in s.query(Consultant).order_by(Consultant.name).all()]
    finally:
        s.close()


@app.post("/api/admin/settings/consultants", dependencies=[Depends(require_token)])
def create_consultant(body: ConsultantCreate):
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="컨설턴트 이름을 입력하세요.")
    s = get_session()
    try:
        c = Consultant()
        _apply_consultant(c, body)
        s.add(c)
        s.commit()
        return {"ok": True, "id": c.id}
    finally:
        s.close()


@app.put("/api/admin/settings/consultants/{row_id}", dependencies=[Depends(require_token)])
def update_consultant(row_id: int, body: ConsultantCreate):
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="컨설턴트 이름을 입력하세요.")
    s = get_session()
    try:
        c = s.query(Consultant).filter_by(id=row_id).first()
        if not c:
            raise HTTPException(status_code=404, detail="Consultant을 찾을 수 없습니다.")
        _apply_consultant(c, body)
        s.commit()
        return {"ok": True, "id": c.id}
    finally:
        s.close()


@app.delete("/api/admin/settings/consultants/{row_id}", dependencies=[Depends(require_token)])
def delete_consultant(row_id: int):
    s = get_session()
    try:
        c = s.query(Consultant).filter_by(id=row_id).first()
        if not c:
            raise HTTPException(status_code=404, detail="Consultant을 찾을 수 없습니다.")
        # 이 사람을 소개자로 걸어 둔 딜은 남는다 — 연결만 끊어 프로젝트가 깨지지 않게 한다
        # (이미 등록한 수수료 지급 건은 상대처 이름을 제 안에 들고 있어 그대로 남는다).
        s.query(RFQ).filter_by(consultant_id=row_id).update({"consultant_id": None})
        s.delete(c)
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


def _category_parents(s):
    """{분류 id: (parent_id, name)} — category_item_type 에 넘길 트리 한 벌."""
    return {c.id: (c.parent_id, c.name) for c in s.query(ItemCategory).all()}


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
@cached_aggregate()
def settings_items():
    """품목 마스터 목록. 정적 속성에 더해 거래 실적(가격 이력)에서 뽑은
    최근 고객·공급사·구매가·판매가·마진을 함께 준다(읽기 전용 파생값).
    이력 전체를 훑으므로 쓰기 전까지 짧게 캐시한다."""
    s = get_session()
    try:
        # 문서가 바뀐 뒤 처음 읽는 참이면 파생 이력을 다시 세운다 — 손으로 Rebuild 를
        # 누르기 전까지 새 견적·발주의 가격이 안 보이던 문제.
        ensure_price_history_fresh(s, _core._DATA_GEN)
        cat_by_id = _category_maps(s)
        summary = master_price_summary(s)
        # 아직 값이 붙는 문서가 없는 품목(RFQ 단계)은 상대만이라도 채운다.
        parties = master_party_fallback(s)
        # 프로젝트 번호 — 품목이 등장한 딜의 관리번호("P-024(260622)"). 한 품목이 여러
        # 딜에 걸치므로 전부 주고(project_nos), 목록은 가장 최근 것만 세운다.
        proj_no = _core._project_no_map(s)
        # 딜별 성사 여부(수주·결제·종결 사유) — 품목이 붙은 가장 최근 딜의 것을 세운다.
        deal_states = _core._deal_state_map(s)
        cust = dict(s.query(Customer.id, Customer.name).all())
        vend = dict(s.query(Vendor.id, Vendor.name).all())
        vess = dict(s.query(Vessel.id, Vessel.name).all())
        # 같은 식별키를 가진 마스터들. 품번이 없으면 품명이 키라(match_key), 메이커만
        # 다른 두 줄을 시스템은 같은 품목으로 본다. 그런데 이력은 그중 한 줄(가장 낮은
        # id)에만 붙어서(build_master_index) 나머지는 프로젝트·상대처·가격이 통째로 빈
        # 채로 남았다 — 화면에서는 "저장했더니 프로젝트와 연결이 끊긴" 것으로 보인다.
        #
        # 이력이 어느 줄에 붙었는지는 이 줄들 사이에서 아무 뜻이 없다(우연히 먼저 만들어진
        # 쪽이다). 같은 품목으로 취급하는 이상 거래 기록도 같아야 하므로, 키를 공유하는
        # 줄들은 그 기록을 함께 본다. 대신 '함께 보고 있다'는 사실을 twin_ids 로 밝힌다 —
        # 구별하고 싶으면 품번을 넣어야 한다는 것이 그 다음 질문의 답이라서다.
        twins: dict[str, list[int]] = {}
        for i in s.query(ItemMaster).order_by(ItemMaster.id).all():
            k = match_key(i.part_no, i.description)
            if k:
                twins.setdefault(k, []).append(i.id)

        out = []
        for i in s.query(ItemMaster).order_by(ItemMaster.part_no).all():
            mates = twins.get(match_key(i.part_no, i.description) or "", [i.id])
            # 기록이 실제로 붙은 줄 — 없으면 제 id 로 두어 빈 값을 그대로 쓴다.
            src = next((x for x in mates if x in summary or x in parties), i.id)
            sm = summary.get(src) or {}
            fb = parties.get(src) or {}
            row = {
                "id": i.id, "part_no": i.part_no or "",
                "description": i.description or "", "maker": i.maker or "",
                "origin": i.origin or "", "unit": i.unit or "PCS",
                "hs_code": i.hs_code or "", "std_price": i.std_price or 0.0,
                "item_type": i.item_type or "part",
                "category_id": i.category_id,
                "category_path": _category_path(cat_by_id, i.category_id),
                "customer": cust.get(sm.get("customer_id") or fb.get("customer_id")) or "",
                "vendor": vend.get(sm.get("vendor_id") or fb.get("vendor_id")) or "",
                "buy": sm.get("buy"), "sell": sm.get("sell"),
                # 견적일 — 공급사 견적 수신일 / 고객 견적 제출일.
                "vendor_quote_at": sm.get("vendor_quote_at") or "",
                "quoted_at": sm.get("quoted_at") or "",
            }
            _annotate_margin(row)   # margin_pct(USD 환산) + margin_cross
            deal_ids = _deal_ids_recent_first(proj_no, sm.get("rfq_ids"), fb.get("rfq_ids"))
            row["project_nos"] = [proj_no[rid] for rid in deal_ids]
            row["project_no"] = row["project_nos"][0] if deal_ids else ""
            # 딜이 성사됐는지 — 세우는 건 가장 최근 딜 하나다(번호와 같은 딜).
            st = deal_states.get(deal_ids[0]) if deal_ids else None
            row["deal_state"] = st["state"] if st else ""
            row["deal_note"] = st["note"] if st else ""
            # 이 품목이 들어간 배 — 같은 부품이 여러 척에 쓰이므로 전부 주고(vessels),
            # 목록은 가장 최근 것만 세운다(문서 있는 쪽 먼저, 그 다음 RFQ 등장분).
            row["vessels"] = _names(vess, sm.get("vessel_ids"), fb.get("vessel_ids"))
            row["vessel"] = row["vessels"][0] if row["vessels"] else ""
            # 이 줄과 식별키가 같은 다른 줄들 — 있으면 위 거래 기록은 그들과 공유한 것이다.
            row["twin_ids"] = [x for x in mates if x != i.id]
            out.append(row)
        return out
    finally:
        s.close()


def _names(by_id: dict[int, str], *id_lists) -> list[str]:
    """id 목록들 → 이름 목록(넘어온 순서 그대로, 빈 이름·중복 제외)."""
    out: list[str] = []
    for ids in id_lists:
        for i in (ids or []):
            name = (by_id.get(i) or "").strip()
            if name and name not in out:
                out.append(name)
    return out


def _deal_ids_recent_first(proj_no: dict[int, str], *id_lists) -> list[int]:
    """딜 id 목록들 → 최근 딜 먼저(중복 제거, 번호 없는 딜 제외).

    번호는 최초 RFQ 수신 순서로 매겨지므로("P-001(260101)" → "P-024(260622)"), 괄호 안
    수신일 + 번호를 내림차순으로 세우면 그대로 '최근 딜 순'이 된다. 문서 날짜(가격 이력)와
    RFQ 등장분을 한 자리에서 섞어야 해서, 두 갈래의 날짜를 견주는 대신 번호로 줄 세운다."""
    seen: list[int] = []
    for ids in id_lists:
        for rid in (ids or []):
            if (proj_no.get(rid) or "") and rid not in seen:
                seen.append(rid)
    def key(rid: int):
        n = proj_no[rid]
        return (n[n.find("(") + 1:-1] if "(" in n else "", n)
    return sorted(seen, key=key, reverse=True)


def _item_type(v: str | None) -> str:
    """물품/용역 값 정규화 — 아는 값만 통과시키고 나머지는 물품으로 둔다."""
    return "service" if (v or "").strip().lower() == "service" else "part"


@app.post("/api/admin/settings/items", dependencies=[Depends(require_token)])
def create_item(body: ItemMasterSave):
    # 용역(Service)은 품번이 없다 — 대신 용역명(description)을 필수로 받는다.
    if _item_type(body.item_type) == "service":
        if not (body.description or "").strip():
            raise HTTPException(status_code=400, detail="Service 이름(Description)을 입력하세요.")
    # 물품도 품번을 홀로 요구하지 않는다 — 식별키가 '품번이 있으면 P:품번, 없으면
    # D:품명'이라(item_ledger.match_key) 둘 중 하나면 그 품목을 되찾을 수 있다.
    elif not body.part_no.strip() and not (body.description or "").strip():
        raise HTTPException(status_code=400, detail="Part No. 또는 Description 을 입력하세요.")
    s = get_session()
    try:
        item = ItemMaster(
            part_no=body.part_no.strip(), description=body.description or "",
            maker=body.maker or "", origin=body.origin or "",
            unit=body.unit or "PCS", hs_code=body.hs_code or "",
            std_price=body.std_price or 0.0, category_id=body.category_id,
            item_type=_item_type(body.item_type),
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
        item.item_type = _item_type(body.item_type)
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
        ensure_price_history_fresh(s, _core._DATA_GEN)
        cat_by_id = _category_maps(s)
        data = ledger_rows(s)
        # 거래 상대는 id 로 굴러온다 — 화면이 읽는 건 이름이라 여기서 한 번에 붙인다.
        cust = dict(s.query(Customer.id, Customer.name).all())
        vend = dict(s.query(Vendor.id, Vendor.name).all())
        for it in data["items"]:
            it["category_path"] = _category_path(cat_by_id, it.get("category_id"))
        for it in data["items"] + data["unmatched"]:
            it["customer"] = cust.get(it.pop("customer_id", None)) or ""
            it["vendor"] = vend.get(it.pop("vendor_id", None)) or ""
            _attach_price_party(it, cust, vend)
        # 매입(buy)·매출(sell) 통화가 달라도 마진을 보이도록 USD 로 환산해 margin_pct 산출
        # (국내매입 KRW·수출 USD 케이스가 흔함). 환율은 앱 공통 상수(대시보드와 동일).
        for it in data["items"] + data["unmatched"]:
            _annotate_margin(it)
        built = s.query(func.max(ItemPriceHistory.created_at)).scalar()
        data["built_at"] = built.isoformat() if built else None
        return data
    finally:
        s.close()


def _attach_price_party(it: dict, cust: dict, vend: dict) -> None:
    """구매가·판매가 옆에 그 가격의 상대 이름을 붙인다(buy=공급사, sell=고객).

    그 이력 행에 상대가 안 찍혀 있으면(견적 원가처럼 공급사가 없는 행) 품목 단위의
    가장 최근 상대로 대신한다 — 비워 두는 것보다 낫고, 그 규칙은 _summarize 가 이미
    품목 단위 값을 고를 때 쓰던 것과 같다. it["customer"]·it["vendor"] 가 이미
    이름으로 채워진 뒤에 부른다.
    """
    for side, names, fallback in (("buy", vend, it.get("vendor")),
                                  ("sell", cust, it.get("customer"))):
        price = it.get(side)
        if not price:
            continue
        pid = price.pop("party_id", None)
        price["party"] = (names.get(pid) if pid else "") or (fallback or "")

@app.get("/api/admin/settings/item-ledger/ship-map", dependencies=[Depends(require_token)])
@cached_aggregate()
def settings_item_ship_map():
    """선박 도면 보기의 원천 — 분류 트리 전체 + 품목 + 품목이 나온 딜(프로젝트).

    목록 엔드포인트와 달리 한 번에 전부 준다. 이 화면의 요점이 '한 페이지에 배 한 척'
    이라 분류를 골라 받아 오는 방식으로는 그릴 수가 없다. 대신 읽기 전용 집계라
    캐시에 얹는다(쓰기가 있으면 세대가 올라 즉시 무효)."""
    s = get_session()
    try:
        ensure_price_history_fresh(s, _core._DATA_GEN)
        data = category_ship_map(s)
        # 화면이 프로젝트를 부르는 이름 — 다른 모든 목록(진행현황·대시보드·전역검색·
        # 문서·미수)이 쓰는 P-001/S-001 과 같아야 한다. 저장값이 아니라 산출값이라
        # 이름(고객·선박)과 같은 자리에서 붙인다.
        pno = _core._project_no_map(s)
        cust = dict(s.query(Customer.id, Customer.name).all())
        vend = dict(s.query(Vendor.id, Vendor.name).all())
        vess = dict(s.query(Vessel.id, Vessel.name).all())
        for it in data["items"]:
            it["customer"] = cust.get(it.pop("customer_id", None)) or ""
            it["vendor"] = vend.get(it.pop("vendor_id", None)) or ""
            _attach_price_party(it, cust, vend)
            _annotate_margin(it)
            for d in it["deals"]:
                d["customer"] = cust.get(d.pop("customer_id", None)) or ""
                d["vessel"] = vess.get(d.pop("vessel_id", None)) or ""
                d["project_no"] = pno.get(d["rfq_id"], "")
        # 계통마다 '누구에게 물어볼 수 있나' — 품목 수만으로는 빈 계통이 조용한
        # 것인지 물어볼 데가 없는 것인지 갈리지 않는다.
        data["vendor_marks"] = _vendor_marks(s)
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
      연결·분류, 없으면 신규 생성. 이후 같은 키의 미연결 이력 행을 즉시 스탬프.

    분류를 배정하면 물품/용역 구분(item_type)도 그 분류를 따라간다 — 여기가 분류가
    정해지는 유일한 길목이라(단건·일괄 모두 이 함수를 지난다) 한 곳만 고치면 된다.
    구분을 손으로 바로잡고 싶을 때는 품목 편집 폼의 Type 이 그대로 남아 있다."""
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
                part_no=fit_part(pn), description=fit_desc(desc), maker=(target.maker or ""),
                unit="PCS", item_type=guess_item_type(pn, desc),
                category_id=target.category_id,
            )
            s.add(master)
    kind = category_item_type(_category_parents(s), target.category_id)
    if kind:
        master.item_type = kind
    s.flush()
    return master.id, stamp_history_item(s, master.id)


@app.post("/api/admin/settings/items/purge-unused", dependencies=[Depends(require_token)])
def purge_unused_items():
    """거래 이력이 한 번도 없는 품목 마스터를 지운다.

    금액도 거래선도 없는 품목은 어느 문서에서도 값이 잡힌 적이 없다는 뜻이다. 그런
    행이 남는 길은 둘이다 — 분류만 골라 둔 초기 단계의 줄, 그리고 나중에 품명·품번이
    고쳐지면서 뒤에 남겨진 옛 마스터. 뒤엣것은 아무도 다시 찾지 않으면서 목록과 계통별
    개수에만 얹혀, 있지도 않은 품목이 배 위에 실려 있는 것처럼 보이게 한다.

    지우기 전에 이력을 먼저 다시 세운다. 문서가 바뀐 뒤 아직 재구축이 안 된 참이라면
    '이력이 없는' 것이 아니라 '아직 안 세운' 것이라, 그대로 지우면 멀쩡한 품목이
    사라진다. 이력이 가리키는 마스터는 어느 것도 지우지 않으므로 끊어지는 연결은 없다
    (item_master 를 참조하는 곳은 item_price_history.item_id 하나뿐이다).
    """
    s = get_session()
    try:
        ensure_price_history_fresh(s, _core._DATA_GEN)
        used = {r[0] for r in s.query(ItemPriceHistory.item_id)
                .filter(ItemPriceHistory.item_id.isnot(None)).all()}
        doomed = [m for m in s.query(ItemMaster).all() if m.id not in used]
        for m in doomed:
            s.delete(m)
        s.commit()
        return {"ok": True, "removed": len(doomed)}
    finally:
        s.close()


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


class ItemLedgerAutoApply(BaseModel):
    """자동 분류 제안 중 사용자가 고른 것들. 행마다 분류가 다르므로 일괄값을 쓰지 않는다."""
    targets: list[ItemLedgerAssign] = []


@app.get("/api/admin/settings/item-ledger/auto-classify", dependencies=[Depends(require_token)])
def preview_auto_classify():
    """미분류 품목에 대한 분류 제안(미적용). 화면에서 확인·수정 후 apply 로 반영한다."""
    s = get_session()
    try:
        cat_by_id = {c.id: c for c in s.query(ItemCategory).all()}
        rows = suggest_categories(s)
        for r in rows:
            r["category_path"] = _category_path(cat_by_id, r["category_id"])
        # 아직 분류가 빈 품목 수 — 제안 대상과 같은 기준(마스터의 빈 분류 + 미연결 이력).
        pending = (s.query(ItemMaster).filter(ItemMaster.category_id.is_(None)).count()
                   + len(ledger_rows(s)["unmatched"]))
        return {"proposals": rows, "pending": pending}
    finally:
        s.close()


@app.post("/api/admin/settings/item-ledger/auto-classify", dependencies=[Depends(require_token)])
def apply_auto_classify(body: ItemLedgerAutoApply):
    """고른 제안을 그대로 반영한다 — 행마다 제 분류로. 마스터에 없던 품목은 등록된다.

    분류할 수 없는 행(Part No.·설명이 모두 없음)은 건너뛰고 수만 센다."""
    s = get_session()
    try:
        done = stamped = skipped = 0
        for t in body.targets:
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
