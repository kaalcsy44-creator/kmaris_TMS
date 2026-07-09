"""
KTMS Admin API — internal RFQ/Quotation overview for the Next.js admin UI.

This is the backend for the Vercel(Next.js) migration pilot. It reuses the
existing SQLAlchemy models/engine and re-implements the 12-step pipeline logic
WITHOUT Streamlit's cache decorator so it can run under FastAPI/uvicorn.

Run (dev):    uvicorn admin_api:app --reload --port 8001
Auth:         send  Authorization: Bearer <ADMIN_API_TOKEN>
              (set env ADMIN_API_TOKEN; defaults to "dev-token" for local dev)
"""
from __future__ import annotations

import io
import os
import re
import secrets
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import bcrypt
import jwt
from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import text

from db.engine import get_session, get_engine
from services.tracking_status import (
    rfq_tracking_step, order_tracking_step, RFQ_STEPS, ORDER_STEPS,
)
from services.email_svc import (
    quotation_email_body, quotation_email_subject, send_email,
    shipping_advice_email_body, email_signature, default_from,
)
from services.pdf_svc import (
    build_payload, build_po_payload, generate_pdf, generate_po_pdf,
    generate_tax_xlsx,
)
from services.pdf_parser import (
    extract_text_from_pdf, parse_order_fields, parse_rfq_fields,
    parse_rfq_image, parse_order_image,
    parse_vendor_quote_text, parse_vendor_quote_image,
    parse_vendor_quote_pdf_document,
)
from services.vendor_xlsx import make_vendor_rfq_quote_xlsx
from services.doc_xlsx import make_document_xlsx
from services.quote_response_parser import parse_vendor_quote_bytes, excel_to_text
from db.models import (
    RFQ, Customer, Vessel, Vendor, User, UserRole, RolePermission, ItemMaster, ItemCategory, DocSequence,
    EmailTemplate,
    VendorRFQ, VendorQuote, Quotation, QuotationStatus, FollowUpLevel,
    Order, PurchaseOrder, ShippingAdvice, CommercialInvoice,
    PackingList, TaxInvoiceData, ARRecord, DeliveryProof,
    RFQStatus, OrderStatus, ARStatus, WorkType, MarketingActivity, ScheduleEvent,
)

# ── App / CORS ────────────────────────────────────────────────────────────────
app = FastAPI(title="KTMS Admin API", docs_url=None, redoc_url=None)

_ALLOWED_ORIGINS = {"http://localhost:3000", "http://127.0.0.1:3000"}
_ALLOWED_ORIGIN_RE = re.compile(r"https://.*\.vercel\.app$")
USD_KRW_RATE = 1543.41
API_BUILD = "vendor-quote-currency-sql-update"


def _allow_origin(origin: str | None) -> str | None:
    """요청 Origin 이 허용 대상이면 그대로 돌려준다(에러 응답에 CORS 헤더용)."""
    if not origin:
        return None
    if origin in _ALLOWED_ORIGINS or _ALLOWED_ORIGIN_RE.match(origin):
        return origin
    return None


def _dual_money(value, currency: str = "USD") -> str:
    try:
        amount = float(value or 0)
    except Exception:
        amount = 0.0
    cur = (currency or "USD").upper()
    if cur == "KRW":
        return f"KRW {amount:,.0f} USD {amount / USD_KRW_RATE:,.0f}"
    if cur == "USD":
        return f"USD {amount:,.0f} KRW {round(amount * USD_KRW_RATE):,}"
    return f"{cur} {amount:,.0f}"


app.add_middleware(
    CORSMiddleware,
    allow_origins=list(_ALLOWED_ORIGINS),
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _sync_schema() -> None:
    """배포된 DB 스키마를 모델과 동기화한다.

    모델에 추가된 신규 컬럼(예: vendor_rfqs.sent_at / sent_to_email)이 운영 DB에
    누락되면 INSERT 시 500이 나고, CORSMiddleware가 500 응답에 CORS 헤더를 붙이지
    않아 프런트엔드에는 "Failed to fetch"로만 보인다. 시작 시 누락 컬럼을 자동
    추가해 스키마 드리프트를 방지한다."""
    try:
        from db.engine import Base
        from init_db import migrate_columns, migrate_normalize_incoterms

        Base.metadata.create_all(bind=get_engine())
        migrate_columns()
        migrate_normalize_incoterms()   # 'EXW Busan' 등 기존 incoterms 값 표준 라벨로 1회 정규화
    except Exception as exc:  # 스키마 동기화 실패가 앱 기동을 막지 않도록 로그만 남긴다.
        print(f"[WARN] startup schema sync skipped: {exc}", file=sys.stderr)
    try:
        _seed_perms()   # 역할 권한 기본값 시드 + 캐시 로드
    except Exception as exc:
        print(f"[WARN] permission seed skipped: {exc}", file=sys.stderr)


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception):
    """처리되지 않은 예외를 JSON 500으로 변환한다.

    catch-all 예외 핸들러의 응답은 CORSMiddleware 바깥(ServerErrorMiddleware)에서
    생성되어 Access-Control-Allow-Origin 헤더가 자동으로 붙지 않는다. 그러면
    프런트엔드는 진짜 500 메시지 대신 "Failed to fetch"만 보게 되므로, 여기서
    Origin 을 검증해 CORS 헤더를 직접 부착한다."""
    print(f"[ERROR] {request.method} {request.url.path}: {exc!r}", file=sys.stderr)
    headers = {}
    origin = _allow_origin(request.headers.get("origin"))
    if origin:
        headers["Access-Control-Allow-Origin"] = origin
        headers["Vary"] = "Origin"
    return JSONResponse(
        status_code=500, content={"detail": f"서버 오류: {exc}"}, headers=headers
    )


ADMIN_API_TOKEN = os.environ.get("ADMIN_API_TOKEN", "dev-token")
SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-change-me")
JWT_ALGO = "HS256"
TOKEN_TTL_HOURS = 12

INTERNAL_STEPS = [
    "RFQ Received",               # 1  (from Customer)
    "RFQ Sent",                   # 2  (to Vendor)
    "Quote Received",             # 3  (from Vendor)
    "Quote Sent",                 # 4  (to Customer)
    "P/O Received",               # 5  (from Customer)
    "P/O Sent",                   # 6  (to Vendor)
    "Delivery Readiness",         # 7  (구 'Delivery Arrangement'(구 8)를 흡수)
    "Delivery Complete · POD",    # 8  (구 9)
    "Tax Invoice · Billing",      # 9  (구 10)
    "Tax Invoice Issued",         # 10 (구 11)
    "Payment Completed",          # 11 (구 12)
]

# 업무타입 "서비스"는 7·8단계를 서비스 관점 명칭으로 별도 관리한다.
SERVICE_STEP_OVERRIDES = {
    7: "Service Readiness",
    8: "Service Complete · Report",   # 구 9
}


def steps_for(work_type) -> list[str]:
    """업무타입에 맞는 11단계 명칭. 서비스면 7·8단계를 서비스 명칭으로 치환."""
    wt = _enum_val(work_type) if work_type else WorkType.PARTS.value
    if wt == WorkType.SERVICE.value:
        return [SERVICE_STEP_OVERRIDES.get(i, name)
                for i, name in enumerate(INTERNAL_STEPS, start=1)]
    return list(INTERNAL_STEPS)


# ── Auth ──────────────────────────────────────────────────────────────────────
class LoginRequest(BaseModel):
    username: str
    password: str


def _bearer(authorization: str | None) -> str:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return ""


def _make_jwt(user: dict) -> str:
    payload = {
        "sub": str(user["id"]),
        "username": user["username"],
        "role": user["role"],
        "exp": datetime.now(timezone.utc) + timedelta(hours=TOKEN_TTL_HOURS),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=JWT_ALGO)


def _decode_jwt(token: str) -> dict | None:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[JWT_ALGO])
    except jwt.PyJWTError:
        return None


def _user_from_auth(authorization: str | None) -> dict | None:
    """Authorization 헤더에서 사용자(dict) 또는 None 을 돌려준다.
    - 유효한 JWT → 토큰 claims 기반 사용자
    - 파일럿 정적 ADMIN_API_TOKEN → admin 권한의 'dev' 사용자(id=0)
    예외를 던지지 않으므로 미들웨어에서 안전하게 쓸 수 있다."""
    token = _bearer(authorization)
    if not token:
        return None
    claims = _decode_jwt(token)
    if claims:
        return {
            "id": int(claims.get("sub", 0)),
            "username": claims.get("username", ""),
            "role": claims.get("role", ""),
        }
    if token == ADMIN_API_TOKEN:
        return {"id": 0, "username": "dev", "role": UserRole.ADMIN.value}
    return None


def require_token(authorization: str | None = Header(default=None)) -> None:
    """Guard: accept a valid JWT, or the pilot static ADMIN_API_TOKEN."""
    if _user_from_auth(authorization) is not None:
        return
    raise HTTPException(status_code=401, detail="Unauthorized")


def get_current_user(authorization: str | None = Header(default=None)) -> dict:
    user = _user_from_auth(authorization)
    if user is not None:
        return user
    raise HTTPException(status_code=401, detail="Unauthorized")


def _authz_error(request: Request, status: int, detail: str) -> JSONResponse:
    """권한 오류 응답에 CORS 헤더를 직접 부착해 돌려준다.
    (role 가드 미들웨어는 CORSMiddleware 바깥에서 동작하므로 수동 부착이 필요하다.)"""
    headers: dict[str, str] = {}
    origin = _allow_origin(request.headers.get("origin"))
    if origin:
        headers["Access-Control-Allow-Origin"] = origin
        headers["Vary"] = "Origin"
    return JSONResponse(status_code=status, content={"detail": detail}, headers=headers)


# ── 권한 매트릭스 (역할 × 페이지 × 동작) ───────────────────────────────────────
# 페이지(모듈)와 동작의 정본. 프런트 매트릭스 UI와 동일한 순서.
PERM_MODULES = ["dashboard", "progress", "rfq", "po", "documents", "ar", "marketing", "settings"]
PERM_ACTIONS = ["view", "create", "edit", "delete"]
# dashboard 는 열람만 의미가 있다(입력/수정/삭제 없음) — UI에서 view만 노출.
PERM_VIEW_ONLY = {"dashboard"}


def _perm_grid(value_map) -> dict:
    """{module: {action: bool}} 전체 그리드 생성. value_map(module,action)->bool."""
    return {m: {a: bool(value_map(m, a)) for a in PERM_ACTIONS} for m in PERM_MODULES}


def _full_perms(value: bool = True) -> dict:
    return _perm_grid(lambda m, a: value)


# 기본 권한(시드) — 기존 동작과 동일하게 맞춘다.
def _default_perms(role: str) -> dict:
    biz = ["progress", "rfq", "po", "documents", "ar", "marketing"]
    if role == UserRole.SALES.value:
        return _perm_grid(lambda m, a: (
            (m == "dashboard" and a == "view") or
            (m in biz)  # 거래 모듈 전체(열람·입력·수정·삭제)
        ))
    if role == UserRole.VIEWER.value:
        return _perm_grid(lambda m, a: (
            a == "view" and (m == "dashboard" or m in biz)  # 읽기 전용
        ))
    # 알 수 없는 역할: 대시보드 열람만.
    return _perm_grid(lambda m, a: (m == "dashboard" and a == "view"))


def _default_scope(role: str) -> str:
    return "own" if role == UserRole.SALES.value else "all"


def _normalize_perms(perms: dict | None) -> dict:
    """저장값을 전체 그리드로 정규화(누락 키는 False, dashboard 는 view만)."""
    perms = perms or {}
    def val(m, a):
        if m in PERM_VIEW_ONLY and a != "view":
            return False
        return bool((perms.get(m) or {}).get(a, False))
    return _perm_grid(val)


# 역할별 권한 캐시(요청마다 DB 조회를 피한다). PUT 시 _reload_perms() 로 갱신.
_PERM_CACHE: dict[str, dict] = {}


def _reload_perms() -> None:
    """DB(role_permissions)에서 sales/viewer 등 편집 가능한 역할 권한을 캐시에 로드."""
    cache: dict[str, dict] = {}
    try:
        s = get_session()
        try:
            for rp in s.query(RolePermission).all():
                cache[rp.role] = {
                    "perms": _normalize_perms(rp.perms),
                    "scope": rp.scope or _default_scope(rp.role),
                }
        finally:
            s.close()
    except Exception as exc:  # DB 미준비 시 기본값으로 동작.
        print(f"[WARN] permission cache load failed: {exc}", file=sys.stderr)
    _PERM_CACHE.clear()
    _PERM_CACHE.update(cache)


def _seed_perms() -> None:
    """sales/viewer 기본 권한 행이 없으면 시드(관리자가 편집할 베이스라인)."""
    s = get_session()
    try:
        for role in (UserRole.SALES.value, UserRole.VIEWER.value):
            if not s.query(RolePermission).filter_by(role=role).first():
                s.add(RolePermission(role=role, perms=_default_perms(role),
                                     scope=_default_scope(role)))
        s.commit()
    finally:
        s.close()
    _reload_perms()


def _perms_for(role: str) -> dict:
    """역할의 효과적 권한 그리드. admin 은 항상 전체 권한."""
    if role == UserRole.ADMIN.value:
        return _full_perms(True)
    entry = _PERM_CACHE.get(role)
    if entry:
        return entry["perms"]
    return _default_perms(role)


def _scope_for(role: str) -> str:
    if role == UserRole.ADMIN.value:
        return "all"
    entry = _PERM_CACHE.get(role)
    return entry["scope"] if entry else _default_scope(role)


def _can(role: str, module: str, action: str) -> bool:
    if role == UserRole.ADMIN.value:
        return True
    return bool(_perms_for(role).get(module, {}).get(action, False))


# ── 엔드포인트 → (모듈, 동작) 매핑 ─────────────────────────────────────────────
# 권한 검사에서 제외(공개/공통 참조). 로그인·본인정보·드롭다운용 마스터 조회 등.
_PERM_EXEMPT = {
    "/api/admin/login", "/api/admin/me", "/api/admin/me/permissions",
    "/api/admin/me/password", "/api/admin/customers", "/api/admin/vendors",
    "/api/admin/po-work-options", "/api/admin/health",
}
# 항상 admin 전용(권한 부여 대상 아님 — 권한 상승 방지).
_ADMIN_ONLY_PREFIXES = ("/api/admin/settings/users", "/api/admin/settings/permissions")
# 신규 레코드 생성(POST) — 그 외 POST 는 edit 으로 본다.
_CREATE_POST_EXACT = {
    "/api/admin/rfq", "/api/admin/orders", "/api/admin/vendor-pos", "/api/admin/ar",
    "/api/admin/marketing",
}
_CREATE_POST_SUFFIX = ("/vendor-rfq", "/customer-quote", "/vendor-quote",
                       "/ci", "/pl", "/sa", "/tax")


def _route_module(path: str) -> str | None:
    if path == "/api/admin/dashboard":
        return "dashboard"
    if path == "/api/admin/pipeline":
        return "progress"
    if path.startswith(("/api/admin/rfq", "/api/admin/quotation", "/api/admin/vrfq",
                        "/api/admin/vendor-rfq", "/api/admin/vendor-quote")):
        return "rfq"
    if path.startswith(("/api/admin/po-", "/api/admin/orders", "/api/admin/order/",
                        "/api/admin/vendor-po")):
        return "po"
    if path.startswith("/api/admin/documents"):
        return "documents"
    if path.startswith("/api/admin/ar"):
        return "ar"
    if path.startswith("/api/admin/marketing"):
        return "marketing"
    if path.startswith("/api/admin/settings"):
        return "settings"
    return None


def _route_action(method: str, path: str) -> str:
    if method == "GET":
        return "view"
    if method in ("PUT", "PATCH"):
        return "edit"
    if method == "DELETE":
        return "delete"
    if method == "POST":
        if path in _CREATE_POST_EXACT or path.endswith(_CREATE_POST_SUFFIX):
            return "create"
        if path.startswith("/api/admin/settings/"):
            rest = path[len("/api/admin/settings/"):]
            return "create" if "/" not in rest else "edit"
        return "edit"
    return "view"


def _route_perm(method: str, path: str):
    """요청에 필요한 (module, action) 반환. None=검사 제외, ('__admin__','')=admin 전용."""
    if method == "OPTIONS":
        return None
    if path in _PERM_EXEMPT or not path.startswith("/api/admin/"):
        return None
    if path.startswith(_ADMIN_ONLY_PREFIXES):
        return ("__admin__", "")
    module = _route_module(path)
    if module is None:
        return None
    # 설정 페이지의 마스터 데이터 조회(GET)는 화면 공통 참조이므로 열람 검사 제외.
    if module == "settings" and method == "GET":
        return None
    return (module, _route_action(method, path))


_PERM_DENY_MSG = {
    "view": "이 페이지를 열람할 권한이 없습니다.",
    "create": "등록(입력) 권한이 없습니다.",
    "edit": "수정 권한이 없습니다.",
    "delete": "삭제 권한이 없습니다.",
}

# 경로 첫 리소스/ID → 그 딜의 담당자(PIC=RFQ.created_by) 조회용. (소유권 게이트)
_DEAL_PATH_RE = re.compile(r"^/api/admin/([a-z-]+)/(\d+)")


def _deal_owner_from_path(path: str) -> int | None:
    """요청 경로가 가리키는 딜의 담당자(PIC=RFQ.created_by)를 반환. 판별 불가 시 None.

    모든 하위 문서(Vendor RFQ/Quote·Quotation·Order·Vendor PO·Documents·AR)는
    rfq_id/order_id 로 RFQ 에 연결되므로 소유권은 항상 RFQ.created_by 로 귀결된다.
    None(신규 등록처럼 대상 딜이 없거나, PIC 미지정)이면 소유권 검사를 건너뛴다.
    """
    m = _DEAL_PATH_RE.match(path)
    if not m:
        return None
    res, rid = m.group(1), int(m.group(2))
    s = get_session()
    try:
        rfq_id: int | None = None
        if res == "rfq":
            r = s.query(RFQ).filter_by(id=rid).first()
            return r.created_by if r else None
        if res == "marketing":
            # 마케팅 활동은 RFQ 딜이 아니라 owner_id(작성 담당자)로 소유권을 판별한다.
            m = s.query(MarketingActivity).filter_by(id=rid).first()
            return m.owner_id if m else None
        if res == "vendor-rfq":
            v = s.query(VendorRFQ).filter_by(id=rid).first()
            rfq_id = v.rfq_id if v else None
        elif res == "vendor-quote":
            vq = s.query(VendorQuote).filter_by(id=rid).first()
            if vq:
                vr = s.query(VendorRFQ).filter_by(id=vq.vendor_rfq_id).first()
                rfq_id = vr.rfq_id if vr else None
        elif res == "quotation":
            q = s.query(Quotation).filter_by(id=rid).first()
            rfq_id = q.rfq_id if q else None
        elif res in ("orders", "order", "documents"):
            o = s.query(Order).filter_by(id=rid).first()
            rfq_id = o.rfq_id if o else None
        elif res == "vendor-pos":
            vp = s.query(PurchaseOrder).filter_by(id=rid).first()
            if vp:
                o = s.query(Order).filter_by(id=vp.order_id).first()
                rfq_id = o.rfq_id if o else None
        elif res == "ar":
            ar = s.query(ARRecord).filter_by(id=rid).first()
            if ar:
                o = s.query(Order).filter_by(id=ar.order_id).first()
                rfq_id = o.rfq_id if o else None
        else:
            return None
        if rfq_id is None:
            return None
        r = s.query(RFQ).filter_by(id=rfq_id).first()
        return r.created_by if r else None
    finally:
        s.close()


@app.middleware("http")
async def _perm_guard(request: Request, call_next):
    """역할×페이지×동작 권한 매트릭스를 모든 /api/admin 요청에 적용한다.

    admin 은 항상 전체 허용(잠금 방지). 정적 ADMIN_API_TOKEN 도 admin 으로 취급.
    settings/users·settings/permissions 는 매트릭스와 무관하게 admin 전용.
    인증(토큰 유효성)은 별도로 각 엔드포인트의 require_token 도 검사한다."""
    need = _route_perm(request.method, request.url.path)
    if need is None:
        return await call_next(request)
    user = _user_from_auth(request.headers.get("authorization"))
    if user is None:
        return _authz_error(request, 401, "Unauthorized")
    role = user.get("role", "")
    if role == UserRole.ADMIN.value:
        return await call_next(request)
    module, action = need
    if module == "__admin__":
        return _authz_error(request, 403, "관리자 권한이 필요합니다.")
    if not _can(role, module, action):
        return _authz_error(request, 403, _PERM_DENY_MSG.get(action, "권한이 없습니다."))
    # 담당(PIC) 소유권 게이트: 비관리자는 본인이 담당인 딜만 편집/삭제(및 하위 등록) 가능.
    # 조회(view)는 기존 데이터 범위 그대로. 대상 딜이 없거나 PIC 미지정이면 통과.
    if action != "view" and module in ("rfq", "po", "documents", "ar", "marketing"):
        owner = _deal_owner_from_path(request.url.path)
        if owner is not None and owner != (user.get("id") or 0):
            return _authz_error(request, 403, "담당자(PIC)만 이 건을 수정·삭제할 수 있습니다.")
    return await call_next(request)


def _apply_owner_filter(q, model, user: dict, mine: int, assignee: int | None):
    """담당자(소유자=created_by) 필터.
    - 데이터 범위가 'own' 인 역할: 항상 본인 담당 건으로 강제 제한(파라미터 무시).
    - 'all' 역할(admin 포함): assignee 지정 시 해당 담당자, mine=1 이면 본인, 아니면 전체.
    """
    role = user.get("role", "")
    uid = user.get("id") or 0
    if role != UserRole.ADMIN.value and _scope_for(role) == "own":
        return q.filter(model.created_by == uid)
    if assignee:
        return q.filter(model.created_by == assignee)
    if mine:
        return q.filter(model.created_by == uid)
    return q


# ── Helpers (decoupled from Streamlit) ────────────────────────────────────────
def _kst(dt) -> str:
    if not dt:
        return ""
    return (dt + timedelta(hours=9)).strftime("%y-%m-%d %H:%M")


def _items_cost_total(items) -> float:
    tot = 0.0
    for it in (items or []):
        try:
            tot += float(it.get("cost_price", 0) or 0) * float(it.get("qty", 1) or 1)
        except (TypeError, ValueError):
            pass
    return tot


def _total_amount(items) -> float:
    return sum(float(i.get("amount", 0) or 0) for i in (items or []))


def _enum_val(v) -> str:
    return v.value if hasattr(v, "value") else str(v)


def _coerce_work_type(v) -> WorkType | None:
    """필터 파라미터(한글 값 '부품공급'/'서비스' 또는 이름 'PARTS'/'SERVICE')를 WorkType 으로.
    빈값/전체/미인식은 None(필터 없음)."""
    if not v or v == "전체":
        return None
    try:
        return WorkType(v)            # 값('부품공급')으로 조회
    except ValueError:
        try:
            return WorkType[v]        # 이름('PARTS')으로 조회
        except KeyError:
            return None


def _deal_progress(s, rfq, order) -> tuple[int, dict[str, str]]:
    """거래(RFQ) 1건의 내부 12단계 진행 — 단일 진실원(single source of truth).

    자식 레코드(Vendor RFQ/Quote, Quotation, PO, SA, CI, Tax, AR, POD)를 **한 번만**
    조회하고, 그 동일한 데이터로부터 (1) 단계 번호(1~11)와 (2) 단계별 자동 완료 일시를
    함께 산출한다. `_pipeline_stage`·`_stage_auto_times` 는 이 함수의 얇은 래퍼다.

    번호·일시 규칙을 한 함수에 나란히 두어 차이가 한눈에 보이도록 했다.
    P2b에서 8·10단계의 번호-일시 드리프트를 정리했다(CI 증거는 8단계 일시로,
    10단계는 Tax/AR 근거만). 6·9단계는 상태/수동으로만 도달 시 자동 일시 근거가
    없어 공란일 수 있으나(누락일 뿐 오기가 아님) 그대로 둔다.

    (오더당 CI는 upsert로 유일하므로 번호·일시 경로가 같은 CI를 공유해도 안전하다.)
    """
    if rfq is None:
        return 1, {}
    rfq_id = rfq.id
    is_service = _enum_val(rfq.work_type) == "서비스"

    # ── 자식 레코드 1회 조회(번호·일시 공용) ──────────────────────────────────
    vrfqs = s.query(VendorRFQ).filter_by(rfq_id=rfq_id).all()
    vrfq_ids = [v.id for v in vrfqs]
    vquotes = (s.query(VendorQuote).filter(VendorQuote.vendor_rfq_id.in_(vrfq_ids)).all()
               if vrfq_ids else [])
    quo = (s.query(Quotation)
           .filter(Quotation.rfq_id == rfq_id, Quotation.status != QuotationStatus.DRAFT)
           .order_by(Quotation.created_at.asc()).first())
    if order:
        pos = (s.query(PurchaseOrder).filter_by(order_id=order.id)
               .order_by(PurchaseOrder.created_at.asc()).all())
        sa = (s.query(ShippingAdvice).filter_by(order_id=order.id)
              .order_by(ShippingAdvice.created_at.asc()).first())
        ci = (s.query(CommercialInvoice).filter_by(order_id=order.id)
              .order_by(CommercialInvoice.created_at.asc()).first())
        tax = (s.query(TaxInvoiceData).filter_by(ci_id=ci.id)
               .order_by(TaxInvoiceData.created_at.asc()).first()) if ci else None
        ars = s.query(ARRecord).filter_by(order_id=order.id).all()
        pod = (s.query(DeliveryProof).filter_by(order_id=order.id)
               .order_by(DeliveryProof.created_at.asc()).first())
    else:
        pos, sa, ci, tax, ars, pod = [], None, None, None, [], None

    # ── (1) 단계 번호 ─────────────────────────────────────────────────────────
    stage = 1
    if vrfqs:
        stage = max(stage, 2)
        if vquotes:
            stage = max(stage, 3)
    if quo:
        stage = max(stage, 4)
    if order:
        stage = max(stage, 5)
        if pos:
            stage = max(stage, 6)
        ost = _enum_val(order.status)
        stage = max(stage, {
            "오더 수주": 5,
            "발주 완료": 6,
            "제조/준비중": 7,
            "출고완료": 7,        # 구 8(Arrangement)를 7(Readiness)로 흡수
            "운송중": 7,
            "목적지 하차 완료": 8,  # 구 9
        }.get(ost, 5))

        is_domestic = (getattr(order, "trade_type", "수출") == "내수")
        if is_domestic and not is_service:
            # 내수 부품공급: 7·8단계(CI/PL/SA/POD)는 해당 없음 → 건너뛴다.
            # 발주(6) 이후에는 곧바로 대금청구(9) 준비 단계로 본다.
            # (서비스는 7·8이 실제 작업 단계이므로 수동 완료로만 진행)
            if stage >= 6:
                stage = max(stage, 8)
        else:
            # 7) Delivery Readiness — 운송통지·수하인 확인·벤더서류·CI 준비 근거(구 8 흡수)
            if getattr(order, "consignee_confirmed_date", None):
                stage = max(stage, 7)
            if sa:
                stage = max(stage, 7)
            if getattr(order, "vendor_docs_sent_date", None):
                stage = max(stage, 7)
            if ci:
                stage = max(stage, 7)
            # 8) 운송 완료 · POD 수취 — POD 파일 업로드 시 완료 (구 9)
            if pod:
                stage = max(stage, 8)
            # 9) Tax Invoice 작성 · 대금 청구 — Tax Invoice Data 생성 시 (구 10)
            if ci and tax:
                stage = max(stage, 9)

        if ars:
            stage = max(stage, 9)
            if any(_enum_val(a.status) == "완납" for a in ars):
                stage = max(stage, 11)

    # 수동 완료(완료 버튼/POD)로 stage_dates 에 표시된 단계를 반영.
    # (자동 근거가 약하거나 없는 단계만 — 의도치 않은 점프 방지)
    sd = getattr(rfq, "stage_dates", None) or {}
    # 서비스 업무는 7·8단계(Service Readiness/Complete)도 수동 완료로 진행한다.
    manual_keys = ("7", "8", "10", "11") if is_service else ("8", "10", "11")
    for k in manual_keys:
        if sd.get(k):
            stage = max(stage, int(k))

    # ── (2) 단계별 자동 완료 일시 ─────────────────────────────────────────────
    # 근거 레코드가 존재하는 단계만 채운다(수동 stage_dates 미입력 시 표시·기본값).
    # 10·11단계는 근거 레코드가 없어 자동값 없음(수동 완료로만 표시).
    auto: dict[str, str] = {}

    def _set(stg: int, val: str):
        if val:
            auto[str(stg)] = val

    # 1) Customer RFQ 수신 — 수신 일시(received_at) 우선, 없으면 생성 시각
    _set(1, (getattr(rfq, "received_at", None) or "") or _kst_iso(rfq.created_at))
    # 2) Vendor RFQ 발신 · 3) Vendor Quot. 수신
    if vrfqs:
        _set(2, min((_vrfq_sent_iso(v) for v in vrfqs), default=""))
        if vquotes:
            # 3단계 일시 = 실제 견적 수신일시(received_at 수동입력) 우선,
            # 없으면 수신일(received_date), 그래도 없으면 레코드 생성시각.
            def _vq_recv(q) -> str:
                return ((getattr(q, "received_at", None) or "").strip()
                        or _date_iso(q.received_date)
                        or _kst_iso(q.created_at))
            _set(3, min((r for r in (_vq_recv(q) for q in vquotes) if r), default=""))
    # 4) Customer Quot. 발신
    if quo:
        _set(4, _date_iso(quo.sent_date) or _kst_iso(quo.created_at))
    if order:
        # 5) Customer P/O 수신
        _set(5, _kst_iso(order.created_at))
        # 6) Vendor P/O 발신
        if pos:
            _set(6, _date_iso(pos[0].sent_date) or _kst_iso(pos[0].created_at))
        # 7) Delivery Readiness — 운송통지·수하인 확인·벤더서류·출고일·CI 생성이 근거
        #    (구 8 'Arrangement' 흡수. CI 존재는 번호를 7로 올리므로 CI 생성시각을 폴백으로.)
        _set(7, (_kst_iso(sa.created_at) if sa else "")
             or _date_iso(getattr(order, "consignee_confirmed_date", None))
             or _date_iso(getattr(order, "vendor_docs_sent_date", None))
             or _date_iso(getattr(order, "shipped_date", None))
             or (_kst_iso(ci.created_at) if ci else ""))
        # 8) 운송 완료 · POD 수취 — POD 업로드 일시 우선, 없으면 인도일 (구 9)
        _set(8, (getattr(pod, "uploaded_at", "") if pod else "")
             or _date_iso(getattr(order, "delivered_date", None)))
        # 9) Tax Invoice 작성 · 대금 청구 — Tax/AR 근거만 (구 10)
        _set(9, (_date_iso(tax.date) or _kst_iso(tax.created_at) if tax else "")
             or _kst_iso(min((a.created_at for a in ars if a.created_at), default=None)))
        # 10) 세금계산서 발행 · 11) 대금 결제 완료 — 수동 완료(stage_dates)로만 표시

    return stage, auto


def _pipeline_stage(s, rfq_id: int) -> int:
    """RFQ 1건의 내부 진행 단계(1~11). `_deal_progress` 위임(단일 소스).
    고객 P/O(오더)가 여러 건이면 '가장 앞선(최고 단계)' 오더 기준으로 표시한다."""
    rfq = s.query(RFQ).filter_by(id=rfq_id).first()
    if rfq is None:
        return 1
    orders = _orders_for_rfq(s, rfq_id)
    if not orders:
        return _deal_progress(s, rfq, None)[0]
    return max(_deal_progress(s, rfq, o)[0] for o in orders)


def _kst_iso(dt) -> str:
    """UTC datetime → KST 'YYYY-MM-DDTHH:MM' (datetime-local 입력과 호환)."""
    if not dt:
        return ""
    return (dt + timedelta(hours=9)).strftime("%Y-%m-%dT%H:%M")


def _fmt_received(iso: str) -> str:
    """'YYYY-MM-DDTHH:MM' → 'yy-mm-dd HH:MM' (목록 표시용). 빈값이면 ''."""
    if not iso or len(iso) < 16:
        return ""
    return f"{iso[2:10]} {iso[11:16]}"


def _first_rfq_iso(rfq) -> str:
    """RFQ 최초 수신 일시(iso 'YYYY-MM-DDTHH:MM') — 수동 received_at 우선, 없으면 생성시각.
    모든 단계 목록의 공통 식별 컬럼('First RFQ at')에서 정렬·필터·표시에 쓴다."""
    if not rfq:
        return ""
    return (getattr(rfq, "received_at", None) or "") or _kst_iso(rfq.created_at)


def _project_no_map(s) -> dict[int, str]:
    """프로젝트(=RFQ)별 내부 관리번호 {rfq_id: 'P-001(yymmdd)'}.
    최초 RFQ 수신 순서대로 업무 타입별 전역 일련번호를 부여한다.
      · Parts(부품공급) → P-001(yymmdd), P-002(yymmdd), …
      · Service(서비스) → S-001(yymmdd), S-002(yymmdd), …
    (yymmdd = 해당 RFQ 수신일. 수신 일시 동률은 RFQ id 순. 저장값이 아니라 매 조회 시
    결정적으로 산출한다.) 같은 세션 안에서는 한 번만 계산하고 캐시한다."""
    cached = getattr(s, "_proj_no_cache", None)
    if cached is not None:
        return cached
    rows = [(_first_rfq_iso(r), r.id,
             "S" if _enum_val(r.work_type) == WorkType.SERVICE.value else "P")
            for r in s.query(RFQ).all()]
    rows.sort(key=lambda t: (t[0] or "9999-99-99T99:99", t[1]))
    counters: dict[str, int] = {"P": 0, "S": 0}
    out: dict[int, str] = {}
    for iso, rid, prefix in rows:
        counters[prefix] += 1
        yymmdd = (iso[2:4] + iso[5:7] + iso[8:10]) if len(iso) >= 10 else "000000"
        out[rid] = f"{prefix}-{counters[prefix]:03d}({yymmdd})"
    try:
        s._proj_no_cache = out
    except Exception:
        pass
    return out


def _vrfq_sent_iso(v) -> str:
    """Vendor RFQ 발신 일시(iso) — 수동 입력(sent_at) 우선, 없으면 생성 시각."""
    return (getattr(v, "sent_at", None) or "") or _kst_iso(v.created_at)


def _date_iso(d: str | None) -> str:
    """'YYYY-MM-DD' 문자열 → 'YYYY-MM-DDT00:00' (시각 정보가 없는 단계용)."""
    if not d:
        return ""
    d = d.strip()
    return f"{d}T00:00" if len(d) == 10 else ""


def _stage_auto_times(s, rfq, order) -> dict[str, str]:
    """내부 12단계 중, 근거 레코드가 존재하는 단계의 완료 일시. `_deal_progress` 위임."""
    return _deal_progress(s, rfq, order)[1]


def _status_label(stage: int, work_type=None) -> str:
    steps = steps_for(work_type)
    return f"{stage}/{len(steps)} {steps[stage - 1]}"


# ── 다음 액션(Next action) 도출 — stage 단일 소스 기반(P3) ────────────────────
# 정체(stalled) 기준: 마지막 활동 이후 경과일. warn=7일↑, urgent=14일↑.
STALL_WARN_DAYS = 7
STALL_URGENT_DAYS = 14


def _last_activity_iso(stage_dates, stage_auto, stage_notes) -> str:
    """거래의 마지막 활동 일시(iso 문자열) — 단계 완료 일시(수동/자동)와 단계 노트 중 최신.
    'YYYY-MM-DDTHH:MM' 포맷이 일관되어 문자열 비교(max)로 최신을 구한다. 없으면 ''."""
    times: list[str] = []
    for d in (stage_dates or {}, stage_auto or {}):
        times.extend(v for v in d.values() if v)
    for notes in (stage_notes or {}).values():
        for n in notes or []:
            v = ((n.get("datetime") or n.get("at") or "") if isinstance(n, dict) else "")
            if v:
                times.append(v)
    return max(times) if times else ""


def _days_since_iso(iso: str, today_iso: str) -> int | None:
    """iso('YYYY-MM-DD…')와 오늘('YYYY-MM-DD') 사이 경과 일수(≥0). 파싱 불가면 None."""
    d, t = (iso or "")[:10], (today_iso or "")[:10]
    if len(d) < 10 or len(t) < 10:
        return None
    try:
        return max(0, (date.fromisoformat(t) - date.fromisoformat(d)).days)
    except Exception:
        return None


def _next_action(stage: int, steps: list[str], *, lost: bool = False,
                 stalled_days: int | None = None) -> dict:
    """거래의 '다음 액션' 도출 — stage(단일 소스) 기준 + 실주/정체 예외.

    반환 {"text": str, "level": "normal"|"warn"|"urgent"}.
      · 실주 → 종결   · 마지막 단계 → 완료
      · 그 외 → 'Next: N+1. 다음단계명'
      · 현재 단계에서 STALL_WARN_DAYS 이상 정체 시 팔로업 권고(경과일에 따라 warn/urgent)"""
    total = len(steps)
    if lost:
        return {"text": "Closed — lost", "level": "normal"}
    if stage >= total:
        return {"text": "Complete", "level": "normal"}
    if stalled_days is not None and stalled_days >= STALL_WARN_DAYS:
        level = "urgent" if stalled_days >= STALL_URGENT_DAYS else "warn"
        return {"text": f"Follow up · stalled {stalled_days}d", "level": level}
    nxt = steps[stage] if 0 <= stage < total else ""  # steps[stage] = (stage+1)번째 단계명
    return {"text": (f"Next: {stage + 1}. {nxt}" if nxt else "Next step"), "level": "normal"}


# ── Endpoints ─────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    # DB 백엔드 종류만 노출(자격증명 X). sqlite 면 임시 디스크일 수 있어 재배포 시
    # 데이터가 사라질 수 있으므로 persistent=false 로 경고.
    backend = get_engine().url.get_backend_name()
    # 가벼운 SELECT 1 으로 DB를 함께 깨운다(Neon 은 유휴 시 컴퓨트를 잠재우므로,
    # keep-alive 핑이 백엔드뿐 아니라 DB 콜드 스타트까지 예방하게 한다).
    # DB 장애가 서버 liveness(=Render health check)를 깨뜨리지 않도록 예외는 삼킨다.
    db_ok = False
    try:
        s = get_session()
        try:
            s.execute(text("SELECT 1"))
            db_ok = True
        finally:
            s.close()
    except Exception:
        db_ok = False
    return {
        "status": "ok",
        "db": backend,
        "db_ok": db_ok,
        "persistent": backend != "sqlite",
        "build": API_BUILD,
    }


def _search_href(stage: int, rfq_id: int, order_id: int, is_service: bool) -> str:
    """검색 결과 클릭 시 이동할 화면. 모든 단계 작업이 진행현황(Progress) 프로젝트 팝업으로
    통합되었으므로, rfq_id(우선) 또는 order_id + 단계를 딥링크로 넘겨 해당 단계로 연다."""
    st = stage if stage and stage > 0 else 1
    if rfq_id and rfq_id > 0:
        return f"/progress?rfq={rfq_id}&stage={st}"
    if order_id and order_id > 0:
        return f"/progress?order={order_id}&stage={st}"
    return "/progress"


def _item_view(it: dict) -> dict:
    qty = it.get("qty", 1) or 1
    amount = it.get("amount")
    unit = it.get("unit_price", it.get("price"))
    if unit is None and amount is not None:
        try:
            unit = float(amount) / float(qty or 1)
        except (TypeError, ValueError, ZeroDivisionError):
            unit = None
    return {
        "part_no": it.get("part_no") or "",
        "description": it.get("description") or "",
        "type": it.get("type") or "",
        "serial_no": it.get("serial_no") or "",
        "qty": qty,
        "unit": it.get("unit") or "",
        "unit_price": unit,
        "amount": amount,
        "remark": it.get("remark") or "",
    }


def _po_item_lines(items, korean: bool) -> str:
    qty_label = "수량" if korean else "Qty"
    desc_label = "품명" if korean else "Desc"
    return "\n".join(
        f"  {i+1:>2}. Part No.: {str(it.get('part_no','—')):<20s}"
        f"  {qty_label}: {it.get('qty','—')} {str(it.get('unit','')):<5s}"
        f"  Maker: {it.get('maker','—')}\n"
        f"       {desc_label}: {it.get('description','—')}"
        for i, it in enumerate(items or [])
    )


def _vendor_po_email_body(po, vendor, order, vessel, notes: str, lang: str, project_no: str = "") -> str:
    vendor_name = vendor.name if vendor else "Vendor"
    vessel_str = vessel.name if vessel else "—"
    if lang == "ko":
        body = f"""{vendor_name} 귀중

안녕하세요,
항상 협조해 주셔서 감사드립니다.

아래 선박용 부품에 대한 발주서를 첨부와 같이 송부드립니다.

발주번호 : {po.po_no}
프로젝트 : {project_no or '—'}
선박명   : {vessel_str}
발주일   : {po.date or date.today().isoformat()}

──────────────────────── 품목 리스트 ────────────────────────
{_po_item_lines(po.items, korean=True)}
──────────────────────────────────────────────────────────────

수령 후 아래 사항을 확인·회신해 주시기 바랍니다:
  • 본 발주 수락 여부
  • 확정 납기 (출고 예정일)
  • 품번·수량·단가 상이 여부

"""
        if notes:
            body += f"추가 사항:\n{notes}\n\n"
        body += "영업일 기준 3일 이내 수령 확인 및 회신 부탁드립니다.\n\n"
        body += email_signature(default=(
            "감사합니다.\n"
            "K-MARIS Energy & Solutions Co., Ltd.\n"
            "Email: sales@k-maris.com  |  www.k-maris.com\n"
            "Engineering Reliability. Supplying Performance."
        )) + "\n"
        return body

    body = f"""Dear {vendor_name},

Please find attached our official Purchase Order for the following marine spare parts.

PO No.        : {po.po_no}
Project No.   : {project_no or '—'}
Vessel        : {vessel_str}
Order Date    : {po.date or date.today().isoformat()}

──────────────────────── ITEM LIST ────────────────────────
{_po_item_lines(po.items, korean=False)}
────────────────────────────────────────────────────────────

Please confirm the following upon receipt:
  • Acceptance of this Purchase Order
  • Confirmed delivery schedule (ex-works / shipment date)
  • Any discrepancy in part number, quantity, or price

"""
    if notes:
        body += f"Additional Notes:\n{notes}\n\n"
    body += "Kindly acknowledge receipt and confirm within 3 business days.\n\n"
    body += email_signature(default=(
        "Best regards,\n"
        "K-MARIS Energy & Solutions Co., Ltd.\n"
        "Email: sales@k-maris.com  |  www.k-maris.com\n"
        "Engineering Reliability. Supplying Performance."
    )) + "\n"
    return body


def _sanitize_vendor_rfq_items(raw) -> list[dict]:
    """발신 화면에서 넘어온 품목(선택·편집본)을 저장/문서용 dict 리스트로 정규화.
    빈 행(부품번호·품명·수량이 모두 비어 있음)은 제거한다."""
    out: list[dict] = []
    for it in (raw or []):
        part_no = str(it.get("part_no", "") or "").strip()
        desc = str(it.get("description", "") or "").strip()
        unit = str(it.get("unit", "") or "").strip()
        remark = str(it.get("remark", "") or "").strip()
        try:
            qty = float(it.get("qty") or 0)
        except (TypeError, ValueError):
            qty = 0
        if not part_no and not desc and not qty:
            continue
        row = {"part_no": part_no, "description": desc, "qty": qty, "unit": unit}
        if remark:
            row["remark"] = remark
        out.append(row)
    return out


# ── 이메일 템플릿 엔진(담당자별 초안) ─────────────────────────────────────────
# 발송 화면 초안(제목·본문)을 토큰 치환으로 생성한다. 해석 순서는
# 개인(user_id) → 회사 기본(user_id=NULL) → 아래 코드 내장 기본값.

# ITEM LIST 에서 선택 가능한 컬럼과 (EN, KO) 라벨. 순서는 사용자 설정을 따른다.
VENDOR_RFQ_ITEM_COLS: dict[str, tuple[str, str]] = {
    "part_no":     ("Part No.", "Part No."),
    "description": ("Desc",     "품명"),
    "qty":         ("Qty",      "수량"),
    "unit":        ("Unit",     "단위"),
    "maker":       ("Maker",    "Maker"),
    "serial_no":   ("Serial",   "Serial"),
    "remark":      ("Remark",   "비고"),
}
# 한 줄에 붙는 짧은 컬럼(그 외 description·remark 는 아래 줄에 별도 표기).
_ITEM_INLINE_COLS = ("part_no", "qty", "unit", "maker", "serial_no")
DEFAULT_VENDOR_RFQ_ITEM_COLS = ["part_no", "qty", "maker", "description"]

# 본문에서 쓸 수 있는 토큰(설정 UI 팔레트/검증용).
VENDOR_RFQ_TOKENS = [
    "vendor_name", "rfq_no", "vessel", "customer",
    "enquiry_date", "item_list", "notes", "signature",
]


def _item_field(item: dict, col: str) -> str:
    v = item.get(col, "")
    s = "" if v is None else str(v)
    return s if s.strip() else "—"


def _render_item_list(items, cols, lang: str) -> str:
    """선택된 컬럼(cols, 순서 포함)으로 ITEM LIST 블록을 렌더한다."""
    li = 1 if lang == "ko" else 0
    cols = [c for c in (cols or DEFAULT_VENDOR_RFQ_ITEM_COLS) if c in VENDOR_RFQ_ITEM_COLS]
    if not cols:
        cols = DEFAULT_VENDOR_RFQ_ITEM_COLS
    inline = [c for c in cols if c in _ITEM_INLINE_COLS]
    block = [c for c in cols if c not in _ITEM_INLINE_COLS]
    lines: list[str] = []
    for i, item in enumerate(items or [], 1):
        head = "   ".join(f"{VENDOR_RFQ_ITEM_COLS[c][li]}: {_item_field(item, c)}" for c in inline)
        lines.append(f"  {i:>2}. {head}".rstrip())
        for c in block:
            lines.append(f"       {VENDOR_RFQ_ITEM_COLS[c][li]}: {_item_field(item, c)}")
    return "\n".join(lines)


def _default_signature(lang: str) -> str:
    if lang == "ko":
        return (
            "감사합니다.\n"
            "K-MARIS Energy & Solutions Co., Ltd.\n"
            "Email: sales@k-maris.com  |  www.k-maris.com\n"
            "Engineering Reliability. Supplying Performance."
        )
    return (
        "Best regards,\n"
        "K-MARIS Energy & Solutions Co., Ltd.\n"
        "Email: sales@k-maris.com  |  www.k-maris.com\n"
        "Engineering Reliability. Supplying Performance."
    )


def vendor_rfq_default_subject_tpl(lang: str) -> str:
    return ("[K-MARIS] 견적 요청 — {{rfq_no}} / {{vessel}}" if lang == "ko"
            else "[K-MARIS] Inquiry — {{rfq_no}} / {{vessel}}")


def vendor_rfq_default_body_tpl(lang: str) -> str:
    if lang == "ko":
        return (
            "{{vendor_name}} 귀중\n\n"
            "안녕하세요,\n"
            "항상 협조해 주셔서 감사드립니다.\n\n"
            "아래 선박용 부품에 대한 견적을 요청드립니다.\n\n"
            "RFQ 번호 : {{rfq_no}}\n"
            "선박명    : {{vessel}}\n"
            "발주처    : {{customer}}\n"
            "문의일    : {{enquiry_date}}\n\n"
            "──────────────────────── 품목 리스트 ────────────────────────\n"
            "{{item_list}}\n"
            "──────────────────────────────────────────────────────────────\n\n"
            "각 품목에 대해 아래 사항을 포함하여 견적을 회신해 주시기 바랍니다:\n"
            "  • 단가 (USD, CNF 부산항 기준)\n"
            "  • 납기\n"
            "  • 원산지 / 제조사\n"
            "  • 기술적 비고 또는 대체품 (해당 시)\n\n"
            "{{notes}}영업일 기준 5일 이내 회신 부탁드립니다.\n\n"
            "{{signature}}\n"
        )
    return (
        "Dear {{vendor_name}},\n\n"
        "We would like to request your best quotation for the following marine spare parts.\n\n"
        "RFQ Reference : {{rfq_no}}\n"
        "Vessel        : {{vessel}}\n"
        "End Customer  : {{customer}}\n"
        "Enquiry Date  : {{enquiry_date}}\n\n"
        "──────────────────────── ITEM LIST ────────────────────────\n"
        "{{item_list}}\n"
        "────────────────────────────────────────────────────────────\n\n"
        "Please quote for each item:\n"
        "  • Unit price (USD, CNF Busan port)\n"
        "  • Lead time\n"
        "  • Country of origin / Manufacturer\n"
        "  • Technical remarks or alternatives (if any)\n\n"
        "{{notes}}Kindly reply within 5 business days.\n\n"
        "{{signature}}\n"
    )


def _vendor_rfq_token_ctx(rfq, cust, vessel, vendor, notes, lang, items, rfq_no, item_cols) -> dict:
    items = (rfq.items if items is None else items) or []
    notes = (notes or "").strip()
    if notes:
        notes_block = (f"추가 사항:\n{notes}\n\n" if lang == "ko" else f"Additional Notes:\n{notes}\n\n")
    else:
        notes_block = ""
    return {
        "vendor_name": (vendor.name if vendor else "Vendor"),
        "rfq_no": rfq_no or rfq.rfq_no or "—",
        "vessel": (vessel.name if vessel else "—"),
        "customer": (cust.name if cust else "—"),
        "enquiry_date": (rfq.date or date.today().isoformat()),
        "item_list": _render_item_list(items, item_cols, lang),
        "notes": notes_block,
        "signature": email_signature(default=_default_signature(lang)),
    }


def _render_tokens(tpl: str, ctx: dict) -> str:
    """{{key}} 토큰을 안전하게 치환(str.replace). 미정의 토큰은 원문 그대로 둔다."""
    out = tpl or ""
    for k, v in ctx.items():
        out = out.replace("{{" + k + "}}", str(v))
    return out


def _resolve_email_template(s, user_id, doc_type: str, lang: str):
    """개인(user_id) → 회사 기본(NULL) 순으로 EmailTemplate 조회. 없으면 None."""
    for uid in (([user_id] if user_id else []) + [None]):
        t = (s.query(EmailTemplate)
             .filter_by(user_id=uid, doc_type=doc_type, lang=lang).first())
        if t:
            return t
    return None


def build_vendor_rfq_email(s, user_id, rfq, cust, vessel, vendor, notes, lang,
                           items=None, rfq_no: str | None = None) -> tuple[str, str]:
    """(subject, body) 초안 생성 — 담당자 템플릿 우선, 없으면 회사/내장 기본."""
    lang = "ko" if lang == "ko" else "en"
    tpl = _resolve_email_template(s, user_id, "vendor_rfq", lang)
    subject_tpl = (tpl.subject_tpl if (tpl and tpl.subject_tpl) else vendor_rfq_default_subject_tpl(lang))
    body_tpl = (tpl.body_tpl if (tpl and tpl.body_tpl) else vendor_rfq_default_body_tpl(lang))
    item_cols = ((tpl.options or {}).get("item_cols") if tpl else None) or DEFAULT_VENDOR_RFQ_ITEM_COLS
    ctx = _vendor_rfq_token_ctx(rfq, cust, vessel, vendor, notes, lang, items, rfq_no, item_cols)
    return _render_tokens(subject_tpl, ctx), _render_tokens(body_tpl, ctx)


def _vendor_rfq_email_body(rfq, cust, vessel, vendor, notes: str, lang: str,
                           items=None, rfq_no: str | None = None) -> str:
    """하위호환 래퍼 — 사용자 템플릿 없이 내장 기본 템플릿으로 본문만 생성."""
    lang = "ko" if lang == "ko" else "en"
    ctx = _vendor_rfq_token_ctx(rfq, cust, vessel, vendor, notes, lang, items, rfq_no,
                                DEFAULT_VENDOR_RFQ_ITEM_COLS)
    return _render_tokens(vendor_rfq_default_body_tpl(lang), ctx)


def preview_vendor_rfq_template(subject_tpl: str, body_tpl: str,
                                options: dict | None, lang: str) -> tuple[str, str]:
    """설정 화면 미리보기 — (미저장) 템플릿을 샘플 데이터로 렌더한다."""
    from types import SimpleNamespace
    lang = "ko" if lang == "ko" else "en"
    rfq = SimpleNamespace(rfq_no="KMS-RFQ-SAMPLE", date=date.today().isoformat(), items=[
        {"part_no": "L53000-211", "description": "Accumulator", "qty": 2,
         "unit": "pcs", "maker": "Parker", "serial_no": "SN-2207", "remark": "urgent"},
        {"part_no": "AB-77-9", "description": "Cylinder head gasket", "qty": 10,
         "unit": "ea", "maker": "MAN", "serial_no": "", "remark": ""},
    ])
    cust = SimpleNamespace(name="SENDA group")
    vessel = SimpleNamespace(name="MV SAMPLE")
    vendor = SimpleNamespace(name="Global Marine Service")
    cols = (options or {}).get("item_cols") or DEFAULT_VENDOR_RFQ_ITEM_COLS
    sample_notes = ("재고 여부 회신 부탁드립니다." if lang == "ko"
                    else "Please advise stock availability.")
    ctx = _vendor_rfq_token_ctx(rfq, cust, vessel, vendor, sample_notes, lang, None, None, cols)
    st = subject_tpl or vendor_rfq_default_subject_tpl(lang)
    bt = body_tpl or vendor_rfq_default_body_tpl(lang)
    return _render_tokens(st, ctx), _render_tokens(bt, ctx)


def _cur2(c: str | None) -> str:
    """통계 집계용 통화 정규화 — USD/KRW 만 구분, 그 외는 USD 로 취급."""
    return c if c in ("USD", "KRW") else "USD"


def _month_key(v: str | None) -> str:
    """'YYYY-MM-DD…' 또는 'YYYY-MM…' → 'YYYY-MM'. 비정상값이면 ''."""
    if not v or len(v) < 7:
        return ""
    return v[:7]


def _order_for_rfq(s, rfq_id: int):
    """RFQ에 연결된 대표 Order(단건) — 직접 연결 우선, 없으면 Quotation 경유(최신)."""
    order = (s.query(Order).filter(Order.rfq_id == rfq_id)
             .order_by(Order.created_at.desc()).first())
    if not order:
        order = (s.query(Order).join(Quotation, Order.quotation_id == Quotation.id)
                 .filter(Quotation.rfq_id == rfq_id)
                 .order_by(Order.created_at.desc()).first())
    return order


def _orders_for_rfq(s, rfq_id: int) -> list:
    """RFQ에 연결된 모든 Order — 직접 연결 + Quotation 경유(중복 제거, 생성순).
    한 프로젝트가 여러 고객 P/O(오더)로 분기하는 경우(선박별 등)를 지원한다."""
    orders = list(
        s.query(Order).filter(Order.rfq_id == rfq_id)
        .order_by(Order.created_at.asc()).all()
    )
    seen = {o.id for o in orders}
    for o in (s.query(Order).join(Quotation, Order.quotation_id == Quotation.id)
              .filter(Quotation.rfq_id == rfq_id)
              .order_by(Order.created_at.asc()).all()):
        if o.id not in seen:
            orders.append(o)
            seen.add(o.id)
    return orders


def _rfq_for_order(s, order: Order):
    """Order에 연결된 RFQ — 직접 연결 우선, 없으면 Quotation 경유."""
    if order.rfq_id:
        return s.query(RFQ).filter_by(id=order.rfq_id).first()
    if order.quotation_id:
        qtn = s.query(Quotation).filter_by(id=order.quotation_id).first()
        if qtn and qtn.rfq_id:
            return s.query(RFQ).filter_by(id=qtn.rfq_id).first()
    return None


def _project_no_for_order(s, order) -> str:
    """오더의 Project No.(yymmdd-nn). 연결 RFQ 기준, 없으면 ''. (ord_no 대체)"""
    rfq = _rfq_for_order(s, order) if order else None
    return _project_no_map(s).get(rfq.id, "") if rfq else ""


def _deal_identity(s, rfq, *, cust_names, vessel_names, user_names) -> dict:
    """목록(overview) 행 공통 'Deal 식별' 블록 — 여러 엔드포인트에 반복되던 필드를 통합.

    이름은 미리 로드한 맵(cust_names/vessel_names/user_names)에서 조회해 N+1을 피한다.
    rfq 가 없으면 각 필드의 기본값을 돌려준다. (customer/vessel 소스가 RFQ 아닌 Order
    기준인 일부 목록은 현행대로 별도 처리 — 이 헬퍼는 RFQ 기준 식별에 한정.)

    반환 키: customer·project_title·contact_person·assignee·assignee_id·level·
    vessel·work_type·first_rfq_at·project_no."""
    return {
        "customer": cust_names.get(rfq.customer_id, "—") if rfq else "—",
        "project_title": (getattr(rfq, "project_title", None) or "") if rfq else "",
        "contact_person": (getattr(rfq, "contact_person", None) or "") if rfq else "",
        "assignee": (user_names.get(rfq.created_by, "") or "") if rfq else "",
        "assignee_id": (rfq.created_by or 0) if rfq else 0,
        "level": (_enum_val(rfq.follow_up_level) if rfq and rfq.follow_up_level else "B"),
        "vessel": (vessel_names.get(rfq.vessel_id, "") if rfq and rfq.vessel_id else ""),
        "work_type": (_enum_val(rfq.work_type) if rfq and rfq.work_type else "부품공급"),
        "first_rfq_at": _first_rfq_iso(rfq) if rfq else "",
        "project_no": _project_no_map(s).get(rfq.id, "") if rfq else "",
    }


def _base_meta(s, rfq, order=None) -> dict:
    """모든 상세 팝업 공통 기본정보.
    Project No.·최초 RFQ 수신일시·고객·선박·업무타입·거래구분(오더 있을 때만)."""
    customer = vessel = None
    if rfq and rfq.customer_id:
        customer = s.query(Customer).filter_by(id=rfq.customer_id).first()
    if order and not customer and getattr(order, "customer_id", None):
        customer = s.query(Customer).filter_by(id=order.customer_id).first()
    vid = (rfq.vessel_id if rfq else None) or (getattr(order, "vessel_id", None) if order else None)
    if vid:
        vessel = s.query(Vessel).filter_by(id=vid).first()
    return {
        "project_no": _project_no_map(s).get(rfq.id, "") if rfq else "",
        "first_rfq_at": _first_rfq_iso(rfq) if rfq else "",
        "customer": customer.name if customer else "—",
        "vessel": vessel.name if vessel else "",
        "work_type": _enum_val(rfq.work_type) if (rfq and rfq.work_type) else "부품공급",
        "trade_type": (getattr(order, "trade_type", "") or "") if order else "",
        "project_title": (rfq.project_title or "") if rfq else "",
    }


_IMAGE_MEDIA = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif",
}


def _ocr_image_media_type(file: UploadFile) -> str | None:
    """업로드가 이미지면 Claude 비전용 media_type 반환, 아니면 None."""
    fname = (file.filename or "").lower()
    for ext, mt in _IMAGE_MEDIA.items():
        if fname.endswith(ext):
            return mt
    ct = (file.content_type or "").lower()
    if ct.startswith("image/") and ct in _IMAGE_MEDIA.values():
        return ct
    return None



class PoWorkItem(BaseModel):
    part_no: str = ""
    description: str = ""
    type: str | None = ""        # 엔진/부품 타입(예: H35DF)
    serial_no: str | None = ""   # 시리얼 번호
    maker: str = ""
    qty: float = 1
    unit: str = "PCS"
    unit_price: float | None = 0
    amount: float | None = None
    remark: str | None = ""


class OrderCreate(BaseModel):
    customer_id: int
    vessel_id: int | None = None
    quotation_id: int | None = None
    rfq_id: int | None = None
    po_no: str = ""
    date: str | None = None
    currency: str | None = "USD"
    trade_type: str = "수출"
    promised_delivery: str | None = None
    items: list[PoWorkItem] = []
    terms: dict | None = None


class OrderUpdate(BaseModel):
    customer_id: int | None = None
    vessel_id: int | None = None       # 0 = 선박 미지정 해제
    po_no: str | None = None
    date: str | None = None
    currency: str | None = None
    trade_type: str | None = None
    promised_delivery: str | None = None
    items: list[PoWorkItem] | None = None
    terms: dict | None = None


class PurchaseOrderCreate(BaseModel):
    order_id: int
    vendor_id: int
    po_no: str | None = None
    date: str | None = None
    currency: str | None = None
    items: list[PoWorkItem] = []
    terms: dict | None = None


class PurchaseOrderUpdate(BaseModel):
    vendor_id: int | None = None
    po_no: str | None = None
    date: str | None = None
    sent_date: str | None = None
    currency: str | None = None
    status: str | None = None
    items: list[PoWorkItem] | None = None
    terms: dict | None = None


class VendorPoPreview(BaseModel):
    lang: str = "en"
    notes: str = ""


class VendorPoSend(BaseModel):
    to: str
    subject: str
    body: str
    format: str = "pdf"   # 첨부 포맷: pdf | xlsx
    cc: str = ""            # 참조(CC) 수신자(쉼표 구분)
    from_email: str = ""    # 발신자 override(빈값이면 SMTP_FROM)


class ARPayment(BaseModel):
    amount: float
    due_date: str | None = None


class ARSave(BaseModel):
    order_id: int
    ci_no: str | None = ""
    invoice_amount: float = 0.0
    paid_amount: float = 0.0
    currency: str = "USD"
    due_date: str | None = None
    status: str = ""
    notes: str | None = ""


def _ar_status_from_text(value: str | None, paid: float, invoice: float) -> ARStatus:
    if paid >= invoice and invoice > 0:
        return ARStatus.PAID
    if paid > 0:
        return ARStatus.PARTIAL
    if value:
        for status in ARStatus:
            if value in {status.value, status.name}:
                return status
    return ARStatus.OUTSTANDING


def _quotation_total(items, discount_pct: float = 0.0) -> float:
    """견적 최종 총액 — amount 합계(없으면 unit_price*qty 보정)에 할인율 적용."""
    amt = _total_amount(items)
    if not amt:
        tot = 0.0
        for it in (items or []):
            try:
                tot += float(it.get("unit_price", 0) or 0) * float(it.get("qty", 1) or 1)
            except (TypeError, ValueError):
                pass
        amt = tot
    try:
        disc = float(discount_pct or 0)
    except (TypeError, ValueError):
        disc = 0.0
    return amt * (1 - disc / 100.0)


def _customer_for_order(session, order: Order):
    return session.query(Customer).filter_by(id=order.customer_id).first()


def _vessel_for_order(session, order: Order):
    if not order.vessel_id:
        return None
    return session.query(Vessel).filter_by(id=order.vessel_id).first()


def _latest_ci(session, order_id: int):
    return (
        session.query(CommercialInvoice)
        .filter_by(order_id=order_id)
        .order_by(CommercialInvoice.id.desc())
        .first()
    )


def _latest_pl(session, ci_id: int | None):
    if not ci_id:
        return None
    return (
        session.query(PackingList)
        .filter_by(ci_id=ci_id)
        .order_by(PackingList.id.desc())
        .first()
    )


def _latest_sa(session, order_id: int):
    return (
        session.query(ShippingAdvice)
        .filter_by(order_id=order_id)
        .order_by(ShippingAdvice.id.desc())
        .first()
    )


def _latest_tax(session, ci_id: int | None):
    if not ci_id:
        return None
    return (
        session.query(TaxInvoiceData)
        .filter_by(ci_id=ci_id)
        .order_by(TaxInvoiceData.id.desc())
        .first()
    )


def _missing_items(order_items: list[dict], doc_items: list[dict]) -> list[dict]:
    def key(item: dict) -> str:
        return (
            str(item.get("part_no") or "").strip().upper()
            or str(item.get("description") or "").strip().upper()
        )

    def qty(item: dict) -> float:
        try:
            return float(item.get("qty", 0) or 0)
        except (TypeError, ValueError):
            return 0.0

    doc_qty: dict[str, float] = {}
    for item in doc_items or []:
        k = key(item)
        if k:
            doc_qty[k] = doc_qty.get(k, 0.0) + qty(item)

    missing: list[dict] = []
    for item in order_items or []:
        k = key(item)
        if not k:
            continue
        oq = qty(item)
        dq = doc_qty.get(k, 0.0)
        if dq < oq:
            missing.append({
                "part_no": item.get("part_no", ""),
                "description": item.get("description", ""),
                "order_qty": oq,
                "doc_qty": dq,
            })
    return missing


def _doc_file_response(data: bytes, filename: str, media_type: str) -> Response:
    return Response(
        content=data,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _tracking_url(kind: str, token: str | None) -> str:
    if not token:
        return ""
    base = os.getenv("TRACKING_BASE_URL", "https://www.k-maris.com/track")
    return f"{base}?type={kind}&token={token}"


def _rfq_for_order(session, order: Order):
    """오더 → 연결된 RFQ(단계 완료 표시는 RFQ.stage_dates 에 저장됨)."""
    if getattr(order, "rfq_id", None):
        rfq = session.query(RFQ).filter_by(id=order.rfq_id).first()
        if rfq:
            return rfq
    if getattr(order, "quotation_id", None):
        q = session.query(Quotation).filter_by(id=order.quotation_id).first()
        if q and q.rfq_id:
            return session.query(RFQ).filter_by(id=q.rfq_id).first()
    return None


def _document_detail_payload(session, order: Order) -> dict:
    cust = _customer_for_order(session, order)
    vessel = _vessel_for_order(session, order)
    ci = _latest_ci(session, order.id)
    pl = _latest_pl(session, ci.id if ci else None)
    sa = _latest_sa(session, order.id)
    tax = _latest_tax(session, ci.id if ci else None)
    pod = (session.query(DeliveryProof).filter_by(order_id=order.id)
           .order_by(DeliveryProof.created_at.desc()).first())
    rfq = _rfq_for_order(session, order)
    sd = (getattr(rfq, "stage_dates", None) or {}) if rfq else {}
    # 발주된 Vendor(들) — 이 오더의 PurchaseOrder vendor_id → Vendor.name (중복 제거)
    vendor_ids = [
        po.vendor_id
        for po in session.query(PurchaseOrder).filter_by(order_id=order.id).all()
        if po.vendor_id
    ]
    vendor_names: list[str] = []
    if vendor_ids:
        name_by_id = {
            v.id: v.name
            for v in session.query(Vendor).filter(Vendor.id.in_(set(vendor_ids))).all()
        }
        seen = set()
        for vid in vendor_ids:
            nm = name_by_id.get(vid)
            if nm and nm not in seen:
                seen.add(nm)
                vendor_names.append(nm)
    return {
        "order": {
            "id": order.id,
            "rfq_id": rfq.id if rfq else 0,
            "assignee_id": (rfq.created_by or 0) if rfq else 0,
            "po_no": order.po_no or "",
            "date": order.date or "",
            "status": _enum_val(order.status),
            "customer": cust.name if cust else "",
            "customer_email": cust.email if cust else "",
            "customer_tax_id": cust.tax_id if cust else "",
            "vessel": vessel.name if vessel else "",
            "project_title": (rfq.project_title or "") if rfq else "",
            "project_no": _project_no_map(session).get(rfq.id, "") if rfq else "",
            "first_rfq_at": _first_rfq_iso(rfq),
            "work_type": _enum_val(rfq.work_type) if (rfq and rfq.work_type) else "부품공급",
            "vendor": ", ".join(vendor_names),
            "trade_type": order.trade_type or "수출",
            "service_info": getattr(order, "service_info", None) or {},
            "tracking_token": order.tracking_token or "",
            "consignee_confirmed_date": order.consignee_confirmed_date or "",
            "vendor_docs_sent_date": order.vendor_docs_sent_date or "",
            "items": order.items or [],
        },
        "pod": None if not pod else {
            "id": pod.id,
            "filename": pod.filename or "POD",
            "uploaded_at": pod.uploaded_at or "",
        },
        # 수동 완료(완료 버튼) 단계 상태 — 7·8(서비스) · 10 · 11
        "stage_done": {k: bool(sd.get(k)) for k in ("7", "8", "10", "11")},
        "ci": None if not ci else {
            "id": ci.id,
            "ci_no": ci.ci_no or "",
            "date": ci.date or "",
            "currency": ci.currency or "USD",
            "vat_rate": ci.vat_rate or 0.0,
            "items": ci.items or [],
            "shipping": ci.shipping or {},
            "missing": _missing_items(order.items or [], ci.items or []),
        },
        "pl": None if not pl else {
            "id": pl.id,
            "pl_no": pl.pl_no or "",
            "date": pl.date or "",
            "items": pl.items or [],
            "missing": _missing_items(order.items or [], pl.items or []),
        },
        "sa": None if not sa else {
            "id": sa.id,
            "sa_no": sa.sa_no or "",
            "date": sa.date or "",
            "shipping": sa.shipping or {},
            "sent_date": sa.sent_date or "",
        },
        "tax": None if not tax else {
            "id": tax.id,
            "tax_no": tax.tax_no or "",
            "date": tax.date or "",
            "items": tax.items or [],
        },
        "smtp_configured": bool(os.getenv("SMTP_USER") and os.getenv("SMTP_PASSWORD")),
    }


class DocumentMilestoneUpdate(BaseModel):
    field: str
    value: bool


class CommercialInvoiceSave(BaseModel):
    ci_no: str | None = None
    date: str | None = None
    currency: str = "USD"
    vat_rate: float = 0.0
    items: list[dict] = []
    shipping: dict = {}


class PackingListSave(BaseModel):
    pl_no: str | None = None
    date: str | None = None
    items: list[dict] = []


class ShippingAdviceSave(BaseModel):
    sa_no: str | None = None
    date: str | None = None
    shipping: dict = {}


class ShippingAdviceSend(BaseModel):
    to: str
    subject: str | None = None
    body: str | None = None


class TaxInvoiceSave(BaseModel):
    tax_no: str | None = None
    date: str | None = None
    supply_type: str = "Export / Zero-rated"
    buyer_business_no: str = ""
    vat_rate: float = 0.0
    items: list[dict] = []


class ServiceStageSave(BaseModel):
    stage: int                      # 7~10
    data: dict = {}
    complete: bool = True


def _manual_doc_no(session, Model, col, body_val, current_id):
    """수동 문서번호 처리. 비우면 None(번호 없음), 입력 시 중복 검사."""
    no = (body_val or "").strip() or None
    if no:
        dup = session.query(Model).filter(
            getattr(Model, col) == no, Model.id != (current_id or 0)).first()
        if dup:
            raise HTTPException(status_code=400, detail=f"이미 존재하는 번호입니다: {no}")
    return no


# ── 단계 완료 콜 — 오더 기준으로 RFQ.stage_dates 에 완료 표시(8·10·11) ──────────
class StageCompleteBody(BaseModel):
    done: bool = True
    at: str | None = None  # 'YYYY-MM-DDTHH:MM' (KST 벽시계) — 생략 시 현재시각


# ── 마케팅 활동 (잠정 고객사 대상) ───────────────────────────────────────────
class MarketingActivityCreate(BaseModel):
    customer_id: int | None = None
    prospect_name: str | None = ""
    contact_person: str | None = ""
    recipient_email: str | None = ""
    activity_date: str | None = ""
    channel: str | None = ""
    activity_type: str | None = ""   # 복수 선택 시 ", " 로 join된 문자열
    subject: str | None = ""
    notes: str | None = ""
    next_action_date: str | None = ""
    owner_id: int | None = None      # 담당자(PIC). None/0=미지정(생성 시 작성자로 대체)


def _marketing_target_name(m: MarketingActivity, cust_names: dict) -> str:
    """활동 대상 표기명 — 연결 고객사가 있으면 그 이름, 없으면 잠정사 자유입력."""
    if m.customer_id and m.customer_id in cust_names:
        return cust_names[m.customer_id]
    return m.prospect_name or "—"


def _marketing_row(m: MarketingActivity, cust_names: dict, user_names: dict) -> dict:
    return {
        "id": m.id,
        "customer_id": m.customer_id,
        "customer": _marketing_target_name(m, cust_names),
        "prospect_name": m.prospect_name or "",
        "is_prospect": not bool(m.customer_id),
        "contact_person": m.contact_person or "",
        "recipient_email": m.recipient_email or "",
        "activity_date": m.activity_date or "",
        "channel": m.channel or "",
        "activity_type": m.activity_type or "",
        "subject": m.subject or "",
        "notes": m.notes or "",
        "next_action_date": m.next_action_date or "",
        "owner_id": m.owner_id or 0,
        "owner": user_names.get(m.owner_id, "") if m.owner_id else "",
    }


def _marketing_scoped(s, user: dict):
    """조회 범위 적용된 MarketingActivity 쿼리. 'own' 역할은 본인 담당 건만."""
    q = s.query(MarketingActivity).order_by(MarketingActivity.id.desc())
    role = user.get("role", "")
    if role != UserRole.ADMIN.value and _scope_for(role) == "own":
        q = q.filter(MarketingActivity.owner_id == (user.get("id") or 0))
    return q


# ── 일정(Schedule) — 대시보드 카드 내에서 직접 관리 ──────────────────────────
class ScheduleEventCreate(BaseModel):
    date: str | None = ""
    title: str | None = ""
    event_type: str | None = ""
    notes: str | None = ""
    customer_id: int | None = None


def _schedule_row(e: ScheduleEvent, cust_names: dict, user_names: dict) -> dict:
    return {
        "id": e.id,
        "date": e.date or "",
        "title": e.title or "",
        "event_type": e.event_type or "",
        "notes": e.notes or "",
        "customer_id": e.customer_id,
        "customer": cust_names.get(e.customer_id, "") if e.customer_id else "",
        "owner_id": e.owner_id or 0,
        "owner": user_names.get(e.owner_id, "") if e.owner_id else "",
    }


def _schedule_guard(e: ScheduleEvent, user: dict) -> None:
    """작성자(owner) 또는 admin 만 수정·삭제 가능."""
    if user.get("role") == UserRole.ADMIN.value:
        return
    if (e.owner_id or 0) != (user.get("id") or 0):
        raise HTTPException(status_code=403, detail="작성자(PIC)만 이 일정을 수정·삭제할 수 있습니다.")


# ── Settings: master data (list + create) ─────────────────────────────────────
class CustomerCreate(BaseModel):
    name: str
    contact: str | None = ""
    contact_phone: str | None = ""
    email: str | None = ""
    country: str | None = ""
    address: str | None = ""
    tax_id: str | None = ""
    payment_terms: str | None = ""   # 기본 결제조건
    logo: str | None = ""    # 회사 로고 data URL(붙여넣기). None=변경 안 함(수정 시)


class VendorCreate(BaseModel):
    name: str
    contact: str | None = ""
    contact_phone: str | None = ""
    email: str | None = ""
    specialization: str | None = ""
    country: str | None = ""
    address: str | None = ""
    payment_terms: str | None = ""   # 기본 결제조건
    logo: str | None = ""    # 회사 로고 data URL(붙여넣기). None=변경 안 함(수정 시)


class VesselCreate(BaseModel):
    name: str
    imo: str | None = ""
    vessel_type: str | None = ""
    ais_flag: str | None = ""
    customer_id: int | None = None
    engine_type: str | None = ""
    hull_no: str | None = ""


class ItemMasterSave(BaseModel):
    part_no: str
    description: str | None = ""
    maker: str | None = ""
    origin: str | None = ""
    unit: str | None = "PCS"
    hs_code: str | None = ""
    std_price: float | None = 0.0
    category_id: int | None = None   # 분류 노드 id(가장 깊은 선택). None=미분류


class ItemCategorySave(BaseModel):
    name: str
    parent_id: int | None = None     # None=대분류(level 1)
    sort_order: int | None = 0
    active: bool | None = True


class UserSave(BaseModel):
    username: str
    email: str | None = ""
    password: str | None = None
    role: str = "sales"
    is_active: bool = True


class CompanyProfile(BaseModel):
    company_name_en: str | None = ""
    company_name_kr: str | None = ""
    address: str | None = ""
    business_no: str | None = ""
    phone: str | None = ""
    general_email: str | None = ""
    sales_email: str | None = ""
    tax_email: str | None = ""
    website: str | None = ""
    bank_name: str | None = ""
    bank_account: str | None = ""
    bank_holder: str | None = ""
    swift: str | None = ""
    tagline: str | None = ""
    email_signature: str | None = ""   # 이메일 본문 하단 공용 서명(비우면 기본 서명)


_COMPANY_CONFIG = ROOT / "config" / "company.json"


def _read_company_profile() -> dict:
    try:
        import json
        return json.loads(_COMPANY_CONFIG.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_company_profile(data: dict) -> None:
    import json
    _COMPANY_CONFIG.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


class RolePermSave(BaseModel):
    role: str
    perms: dict
    scope: str = "all"


class PasswordChangeReq(BaseModel):
    old_password: str
    new_password: str


# ── Write actions ─────────────────────────────────────────────────────────────




class VendorRfqCreate(BaseModel):
    vendor_id: int


class VendorRfqPreviewRequest(BaseModel):
    vendor_ids: list[int]
    lang: str = "en"
    notes: str = ""
    rfq_no_mode: str = "auto"   # 케이마리스 RFQ No. 발번: auto/manual
    rfq_no: str = ""            # manual 일 때 직접 입력값
    items: list[dict] | None = None   # 발신 화면에서 선택·편집한 품목(없으면 RFQ 원본)


class VendorRfqXlsxRequest(BaseModel):
    items: list[dict] | None = None   # 선택·편집한 품목(없으면 RFQ 원본)


class VendorRfqSendItem(BaseModel):
    vendor_id: int
    to: str = ""
    subject: str
    body: str


class VendorRfqSendRequest(BaseModel):
    items: list[VendorRfqSendItem]
    rfq_no_mode: str = "auto"
    rfq_no: str = ""
    sent_at: str = ""        # 발신 일시 "YYYY-MM-DDTHH:MM"(비우면 현재)
    rfq_items: list[dict] | None = None   # 선택·편집한 품목(없으면 RFQ 원본을 그대로 저장)


class VendorRfqUpdate(BaseModel):
    vendor_id: int | None = None
    sent_date: str | None = None
    sent_at: str | None = None
    sent_to_email: str | None = None
    status: str | None = None
    items: list[dict] | None = None


class VendorRfqEmailPreviewReq(BaseModel):
    lang: str = "en"


class VendorRfqEmailSendReq(BaseModel):
    to: str
    subject: str
    body: str
    format: str = "xlsx"   # 첨부 포맷: xlsx | pdf
    lang: str = "en"
    note: str = ""
    cc: str = ""            # 참조(CC) 수신자(쉼표 구분)
    from_email: str = ""    # 발신자 override(빈값이면 SMTP_FROM)


class VendorQuoteCreate(BaseModel):
    vendor_rfq_id: int
    vendor_quote_no: str
    amount: float | None = None
    currency: str = "USD"
    received_date: str | None = None
    received_at: str | None = None     # 견적 수신 일시 "YYYY-MM-DDTHH:MM"(비우면 현재)
    notes: str = ""
    items: list[dict] | None = None
    terms: dict | None = None


class VendorQuoteUpdate(BaseModel):
    vendor_quote_no: str | None = None
    received_date: str | None = None
    received_at: str | None = None
    currency: str | None = None
    notes: str | None = None
    items: list[dict] | None = None
    terms: dict | None = None




# ── K-Maris RFQ No. 이연 발번 ──────────────────────────────────────────────
# 케이마리스 RFQ No.는 Vendor RFQ 발신 시점에 부여한다. 그 전까지는 임시 토큰
# (TMP-...)을 보유하며, 사용자에게는 "미발급"으로 표시된다.
_RFQ_TMP_PREFIX = "TMP-"


def _rfq_unassigned(rfq_no) -> bool:
    return (not rfq_no) or str(rfq_no).startswith(_RFQ_TMP_PREFIX)


def _rfq_no_disp(rfq_no) -> str:
    """사용자 표시용: 미발급(임시 토큰/빈값)이면 '-'."""
    return "-" if _rfq_unassigned(rfq_no) else rfq_no


def _new_tmp_rfq_no(session) -> str:
    while True:
        cand = _RFQ_TMP_PREFIX + secrets.token_hex(5)
        if not session.query(RFQ).filter_by(rfq_no=cand).first():
            return cand


def _next_kmaris_rfq_no(session) -> str:
    """자동 채번 K-Maris RFQ No. — 'KMS-RFQ-yymm-nnn'. 이번 달(KST) 마지막 순번 +1.
    RFQ.rfq_no 와 VendorRFQ.kmaris_rfq_no(벤더별 고유 번호) 양쪽을 모두 세어 충돌을 막는다."""
    yymm = (datetime.utcnow() + timedelta(hours=9)).strftime("%y%m")
    prefix = f"KMS-RFQ-{yymm}-"
    mx = 0
    rows = list(session.query(RFQ.rfq_no).filter(RFQ.rfq_no.like(prefix + "%")).all())
    rows += list(session.query(VendorRFQ.kmaris_rfq_no)
                 .filter(VendorRFQ.kmaris_rfq_no.like(prefix + "%")).all())
    for (no,) in rows:
        tail = str(no or "")[len(prefix):]
        if tail.isdigit():
            mx = max(mx, int(tail))
    return f"{prefix}{mx + 1:03d}"


def _kmaris_rfq_no_taken(session, no: str) -> bool:
    """RFQ.rfq_no 또는 VendorRFQ.kmaris_rfq_no 로 이미 사용 중인 번호인지."""
    if session.query(RFQ).filter_by(rfq_no=no).first():
        return True
    if session.query(VendorRFQ).filter_by(kmaris_rfq_no=no).first():
        return True
    return False


def _assign_vrfq_no(session, mode: str = "auto", manual: str = "") -> str:
    """Vendor RFQ 1건에 부여할 K-Maris RFQ No. 를 계산한다(레코드에 직접 저장은 호출측에서).
    - manual: 입력값이 있으면 그 값(중복 검사). 비우면 자동 채번으로 폴백.
    - auto: 다음 순번 자동 생성."""
    manual = (manual or "").strip()
    if mode == "manual" and manual:
        if _kmaris_rfq_no_taken(session, manual):
            raise HTTPException(status_code=400, detail=f"이미 존재하는 RFQ No.입니다: {manual}")
        return manual
    return _next_kmaris_rfq_no(session)


def _next_kmaris_quotation_no(session) -> str:
    """자동 채번 Quotation No. — 'KMS-QUO-yymm-nnn'. 이번 달(KST) 마지막 순번 +1."""
    yymm = (datetime.utcnow() + timedelta(hours=9)).strftime("%y%m")
    prefix = f"KMS-QUO-{yymm}-"
    mx = 0
    for (no,) in session.query(Quotation.qtn_no).filter(Quotation.qtn_no.like(prefix + "%")).all():
        tail = str(no or "")[len(prefix):]
        if tail.isdigit():
            mx = max(mx, int(tail))
    return f"{prefix}{mx + 1:03d}"


def _next_kmaris_po_no(session) -> str:
    """자동 채번 K-Maris (Vendor) P/O No. — 'KMS-ORD-yymm-nnn'. 이번 달(KST) 마지막 순번 +1.
    (벤더에 발주하는 우리 주문서라 ORD 프리픽스 사용.)"""
    yymm = (datetime.utcnow() + timedelta(hours=9)).strftime("%y%m")
    prefix = f"KMS-ORD-{yymm}-"
    mx = 0
    for (no,) in session.query(PurchaseOrder.po_no).filter(PurchaseOrder.po_no.like(prefix + "%")).all():
        tail = str(no or "")[len(prefix):]
        if tail.isdigit():
            mx = max(mx, int(tail))
    return f"{prefix}{mx + 1:03d}"


def _assign_rfq_no(session, rfq, mode: str = "auto", manual: str = "") -> str:
    """미발급 RFQ 에 K-Maris RFQ No. 를 부여한다.
    - manual: 입력값이 있으면 그 값(중복 검사). 비우면 그대로 미발급 유지.
    - auto: 'KMS-RFQ-yymm-nnn' 다음 순번을 자동 생성."""
    if not _rfq_unassigned(rfq.rfq_no):
        return rfq.rfq_no
    manual = (manual or "").strip()
    if mode == "manual":
        if manual:
            if session.query(RFQ).filter_by(rfq_no=manual).first():
                raise HTTPException(status_code=400, detail=f"이미 존재하는 RFQ No.입니다: {manual}")
            rfq.rfq_no = manual
    else:  # auto
        rfq.rfq_no = _next_kmaris_rfq_no(session)
    return rfq.rfq_no


class RfqItemIn(BaseModel):
    part_no: str = ""
    description: str = ""
    type: str | None = ""        # 엔진/부품 타입(예: H35DF)
    serial_no: str | None = ""   # 시리얼 번호
    qty: float = 1
    remark: str | None = ""


class RfqSourceFileIn(BaseModel):
    """Auto-fill 로 업로드·추출한 소스 파일 메타(파일명·아이템수·시각)."""
    name: str = ""
    media_type: str | None = ""
    item_count: int = 0
    at: str | None = ""


class RfqCreate(BaseModel):
    customer_id: int
    vessel_id: int | None = None
    customer_rfq_no: str | None = ""
    contact_person: str | None = ""    # 고객 담당자
    rfq_no: str | None = None          # K-Maris RFQ No. 수동 지정(비우면 자동 채번)
    received_at: str | None = None     # RFQ 수신 일시 "YYYY-MM-DDTHH:MM"(비우면 현재)
    project_title: str | None = ""
    work_type: str | None = "부품공급"
    request_channel: str | None = ""   # 고객 요청 수단: Email/Phone/SMS/WhatsApp/WeChat 등
    notes: str | None = ""             # 내부 메모(자유 서술)
    items: list[RfqItemIn] = []
    source_files: list[RfqSourceFileIn] = []   # Auto-fill 소스 파일 메타(영구 보관)


class RfqAssignNo(BaseModel):
    mode: str = "auto"     # auto/manual
    rfq_no: str = ""       # manual 일 때 직접 입력값


class RfqUpdate(BaseModel):
    """RFQ 헤더 필드 부분 수정. 보낸 필드만 반영(None=변경 안 함)."""
    customer_id: int | None = None
    vessel_id: int | None = None        # 0 → 선박 미지정으로 해제
    customer_rfq_no: str | None = None
    rfq_no: str | None = None           # K-Maris RFQ No. 수동 수정(빈값이면 변경 안 함)
    contact_person: str | None = None
    project_title: str | None = None
    work_type: str | None = None
    request_channel: str | None = None  # 고객 요청 수단
    notes: str | None = None            # 내부 메모(자유 서술)
    received_at: str | None = None      # "YYYY-MM-DDTHH:MM"
    assignee_id: int | None = None      # 담당자(PIC) = created_by. 0 → 미지정 해제
    items: list[RfqItemIn] | None = None  # 보내면 품목 전체 교체
    source_files: list[RfqSourceFileIn] | None = None  # 보내면 소스 파일 메타 전체 교체


class RfqLevelUpdate(BaseModel):
    follow_up_level: str


class RfqCancelUpdate(BaseModel):
    """딜 종결(취소/실주) 토글. True=종결(status→LOST), False=재활성(status→RECEIVED).
    단계(stage)는 레코드 기반으로 자동 산출되므로 여기서는 status 만 바꾼다."""
    cancelled: bool


class EmailTemplateSave(BaseModel):
    """이메일 템플릿 저장(upsert). scope=user(개인) | company(회사 기본, admin)."""
    scope: str = "user"
    doc_type: str = "vendor_rfq"
    lang: str = "en"
    subject_tpl: str = ""
    body_tpl: str = ""
    options: dict | None = None   # {"item_cols": [...]}


class EmailTemplatePreviewReq(BaseModel):
    """미저장 템플릿을 샘플 데이터로 렌더해 미리보기."""
    lang: str = "en"
    subject_tpl: str = ""
    body_tpl: str = ""
    options: dict | None = None


class StageDateUpdate(BaseModel):
    stage: int                 # 1~11
    value: str | None = None   # "YYYY-MM-DDTHH:MM" (KST) 또는 빈값/None → 해제


class StageNoteAdd(BaseModel):
    stage: int                       # 1~11
    text: str
    datetime: str | None = None      # 활동 일시 "YYYY-MM-DDTHH:MM" (KST). 비우면 현재시각
    party: str | None = None         # 소통 상대: Customer / Vendor / 기타
    channel: str | None = None       # 소통 수단: 이메일 / 통화 / 문자 / 방문 / 기타


class StageNoteUpdate(BaseModel):
    stage: int
    index: int                       # 해당 단계 로그 내 인덱스
    text: str
    datetime: str | None = None
    party: str | None = None
    channel: str | None = None


class StageNoteDelete(BaseModel):
    stage: int
    index: int                 # 해당 단계 로그 내 인덱스




class CustomerQuoteCreate(BaseModel):
    qtn_no: str | None = None
    currency: str = "USD"
    cost_currency: str | None = None
    round_digits: int | None = None
    discount_pct: float | None = None
    amount: float | None = None
    items: list[dict] | None = None
    sent_at: str | None = None
    valid_until: str | None = None
    remarks: str = ""
    terms: dict | None = None


class CustomerQuoteUpdate(BaseModel):
    qtn_no: str | None = None
    currency: str | None = None
    cost_currency: str | None = None
    round_digits: int | None = None
    discount_pct: float | None = None
    items: list[dict] | None = None
    sent_at: str | None = None
    valid_until: str | None = None
    status: str | None = None
    terms: dict | None = None


class QuotationEmailPreviewReq(BaseModel):
    lang: str = "en"


class QuotationSendReq(BaseModel):
    to: str
    subject: str
    body: str
    doc_type: str = "quotation"
    format: str = "pdf"   # 첨부 포맷: pdf | xlsx
    cc: str = ""            # 참조(CC) 수신자(쉼표 구분)
    from_email: str = ""    # 발신자 override(빈값이면 SMTP_FROM)


# Public surface consumed by routers/*.py (split from this file).
__all__ = [
    "ARPayment",
    "ARRecord",
    "ARSave",
    "ARStatus",
    "CommercialInvoice",
    "CommercialInvoiceSave",
    "CompanyProfile",
    "Customer",
    "CustomerCreate",
    "CustomerQuoteCreate",
    "CustomerQuoteUpdate",
    "DeliveryProof",
    "Depends",
    "DocumentMilestoneUpdate",
    "File",
    "FollowUpLevel",
    "HTTPException",
    "INTERNAL_STEPS",
    "ItemCategory",
    "ItemCategorySave",
    "ItemMaster",
    "ItemMasterSave",
    "LoginRequest",
    "MarketingActivity",
    "MarketingActivityCreate",
    "ORDER_STEPS",
    "Order",
    "OrderCreate",
    "OrderStatus",
    "OrderUpdate",
    "PERM_ACTIONS",
    "PERM_MODULES",
    "PERM_VIEW_ONLY",
    "PackingList",
    "PackingListSave",
    "PasswordChangeReq",
    "PurchaseOrder",
    "PurchaseOrderCreate",
    "PurchaseOrderUpdate",
    "Quotation",
    "QuotationEmailPreviewReq",
    "QuotationSendReq",
    "QuotationStatus",
    "RFQ",
    "RFQStatus",
    "RFQ_STEPS",
    "Response",
    "RfqAssignNo",
    "RfqCreate",
    "RfqLevelUpdate",
    "RfqUpdate",
    "RolePermSave",
    "RolePermission",
    "ScheduleEvent",
    "ScheduleEventCreate",
    "ServiceStageSave",
    "ShippingAdvice",
    "ShippingAdviceSave",
    "ShippingAdviceSend",
    "StageCompleteBody",
    "StageDateUpdate",
    "StageNoteAdd",
    "StageNoteDelete",
    "StageNoteUpdate",
    "TaxInvoiceData",
    "TaxInvoiceSave",
    "UploadFile",
    "User",
    "UserRole",
    "UserSave",
    "Vendor",
    "VendorCreate",
    "VendorPoPreview",
    "VendorPoSend",
    "VendorQuote",
    "VendorQuoteCreate",
    "VendorQuoteUpdate",
    "VendorRFQ",
    "VendorRfqCreate",
    "VendorRfqPreviewRequest",
    "VendorRfqSendRequest",
    "VendorRfqUpdate",
    "VendorRfqEmailPreviewReq",
    "VendorRfqEmailSendReq",
    "VendorRfqXlsxRequest",
    "Vessel",
    "VesselCreate",
    "WorkType",
    "_apply_owner_filter",
    "_ar_status_from_text",
    "_assign_rfq_no",
    "_next_kmaris_rfq_no",
    "_next_kmaris_quotation_no",
    "_next_kmaris_po_no",
    "_base_meta",
    "_coerce_work_type",
    "_cur2",
    "_customer_for_order",
    "_date_iso",
    "_doc_file_response",
    "_document_detail_payload",
    "_dual_money",
    "_enum_val",
    "_first_rfq_iso",
    "_fmt_received",
    "_full_perms",
    "_item_view",
    "_items_cost_total",
    "_kst",
    "_kst_iso",
    "_latest_ci",
    "_latest_pl",
    "_latest_sa",
    "_latest_tax",
    "_make_jwt",
    "_manual_doc_no",
    "_marketing_row",
    "_marketing_scoped",
    "_month_key",
    "_new_tmp_rfq_no",
    "_normalize_perms",
    "_ocr_image_media_type",
    "_order_for_rfq",
    "_perms_for",
    "_pipeline_stage",
    "_project_no_for_order",
    "_project_no_map",
    "_quotation_total",
    "_read_company_profile",
    "_reload_perms",
    "_rfq_for_order",
    "_rfq_no_disp",
    "_sanitize_vendor_rfq_items",
    "_schedule_guard",
    "_schedule_row",
    "_scope_for",
    "_search_href",
    "_stage_auto_times",
    "_status_label",
    "_total_amount",
    "_tracking_url",
    "_vendor_po_email_body",
    "_vendor_rfq_email_body",
    "EmailTemplate",
    "EmailTemplateSave",
    "EmailTemplatePreviewReq",
    "build_vendor_rfq_email",
    "preview_vendor_rfq_template",
    "vendor_rfq_default_subject_tpl",
    "vendor_rfq_default_body_tpl",
    "VENDOR_RFQ_ITEM_COLS",
    "VENDOR_RFQ_TOKENS",
    "DEFAULT_VENDOR_RFQ_ITEM_COLS",
    "_vessel_for_order",
    "_vrfq_sent_iso",
    "_write_company_profile",
    "app",
    "bcrypt",
    "build_payload",
    "build_po_payload",
    "date",
    "datetime",
    "excel_to_text",
    "extract_text_from_pdf",
    "generate_pdf",
    "generate_po_pdf",
    "generate_tax_xlsx",
    "get_current_user",
    "get_session",
    "io",
    "make_vendor_rfq_quote_xlsx",
    "make_document_xlsx",
    "order_tracking_step",
    "os",
    "parse_order_fields",
    "parse_order_image",
    "parse_rfq_fields",
    "parse_rfq_image",
    "parse_vendor_quote_bytes",
    "parse_vendor_quote_image",
    "parse_vendor_quote_pdf_document",
    "parse_vendor_quote_text",
    "quotation_email_body",
    "quotation_email_subject",
    "require_token",
    "rfq_tracking_step",
    "send_email",
    "default_from",
    "shipping_advice_email_body",
    "steps_for",
    "text",
    "timedelta",
    "timezone",
]
