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
import threading
import time
from datetime import date, datetime, timedelta, timezone
from functools import wraps
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import bcrypt
import jwt
from typing import List, Optional
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import event as _sa_event, func, text
from sqlalchemy.orm import Session as _SASession

from db.engine import get_session, get_engine


@_sa_event.listens_for(_SASession, "after_flush")
def _invalidate_deal_progress_cache(session, flush_context):
    """세션에 변경이 flush 되면 스테이지 메모(_deal_progress_cache)를 폐기한다.
    읽기 요청은 flush 가 없어 요청 내내 메모가 유지되고, 쓰기가 반영되는 즉시(=flush)
    폐기돼 오래된 단계값이 남지 않는다. (autoflush=False 이므로 flush=커밋 시점)."""
    if getattr(session, "_deal_progress_cache", None):
        session._deal_progress_cache = {}
from services.tracking_status import (
    rfq_tracking_step, order_tracking_step, RFQ_STEPS, ORDER_STEPS,
)
from services.email_svc import (
    quotation_email_body, quotation_email_subject, send_email,
    shipping_advice_email_body, email_signature, default_from,
    intro_email_subject, intro_email_body, intro_email_body_tpl,
    render_marketing_tokens, intro_signature, text_to_html_fragment, html_document,
)
from services.email_sig import (
    signature_html, signature_text, default_fields as default_sig_fields,
    normalize_fields as normalize_sig_fields, has_content as sig_has_content,
)
from services.pdf_svc import (
    build_payload, build_po_payload, generate_pdf, generate_po_pdf,
    generate_tax_xlsx, generate_ci_xlsx, generate_pl_xlsx, generate_pi_xlsx,
)
from services.pdf_parser import (
    extract_text_from_pdf, parse_order_fields, parse_rfq_fields,
    parse_rfq_image, parse_order_image,
    parse_business_card_image, parse_business_card_pdf_document,
    parse_vendor_quote_text, parse_vendor_quote_image,
    parse_vendor_quote_pdf_document,
)
from services.vendor_xlsx import make_vendor_rfq_quote_xlsx
from services.doc_xlsx import make_document_xlsx
from services.quote_response_parser import parse_vendor_quote_bytes, excel_to_text
from db.models import (
    RFQ, Customer, CustomerContact, Vessel, Vendor, VendorContact, User, UserRole, RolePermission, ItemMaster, ItemCategory, DocSequence,
    EmailTemplate, EmailMessage, EmailSyncState,
    VendorRFQ, VendorQuote, Quotation, QuotationStatus, FollowUpLevel,
    Order, PurchaseOrder, ShippingAdvice, ProformaInvoice, CommercialInvoice,
    PackingList, TaxInvoiceData, ARRecord, APRecord, DeliveryProof,
    RFQStatus, OrderStatus, ARStatus, WorkType, MarketingActivity, ScheduleEvent,
    MarketingAsset, FinancePayable, FinanceIncome, Consultant,
    Claim, CreditNote,
)

# ── App / CORS ────────────────────────────────────────────────────────────────
app = FastAPI(title="KTMS Admin API", docs_url=None, redoc_url=None)

_ALLOWED_ORIGINS = {"http://localhost:3000", "http://127.0.0.1:3000"}
_ALLOWED_ORIGIN_RE = re.compile(r"https://.*\.vercel\.app$")
USD_KRW_RATE = 1543.41
API_BUILD = "all-docs-letterhead"


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


# ── 서버측 단기 캐시(무거운 집계 API의 Neon egress 절감) ─────────────────────────
# /dashboard·/statistics·/pipeline 은 매 요청마다 여러 테이블을 통째로(품목 items JSON
# 포함) 스캔한다. 홈 화면 1회 진입이 이런 풀스캔을 여러 번 유발하고, 잦은 새로고침·
# 다중 사용자까지 겹치면 Neon 네트워크 전송(egress)이 폭증한다(작은 DB인데 전송량만 GB).
# 같은 (인자, 데이터 세대) 결과를 짧게 재사용해 반복 전송을 없앤다. 쓰기 요청이 한 번
# 이라도 성공하면 데이터 세대가 올라가 캐시가 즉시 무효화되므로 오래된 값이 남지 않는다.
AGG_CACHE_TTL = float(os.environ.get("AGG_CACHE_TTL", "60"))  # 초. 0 이하면 캐시 비활성.
_AGG_CACHE: dict = {}
_AGG_CACHE_LOCK = threading.Lock()
_DATA_GEN = 0  # 성공한 쓰기(POST/PUT/PATCH/DELETE)마다 +1 → 모든 집계 캐시 무효화.


def bump_data_generation() -> None:
    global _DATA_GEN
    with _AGG_CACHE_LOCK:
        _DATA_GEN += 1


def cached_aggregate(ttl: float | None = None):
    """읽기 전용 집계 엔드포인트용 서버측 TTL 캐시 데코레이터.

    캐시 키 = (함수명, user 스코프(id·role), 나머지 쿼리 인자). 엔트리에 데이터 세대를
    함께 저장해, 쓰기가 발생하면(세대 상승) 즉시 무효 처리한다. ttl 초 안의 동일 요청은
    DB를 건드리지 않고 캐시된 결과를 돌려준다.
    반드시 @app.get(...) '아래'(=함수에 더 가깝게)에 붙여야 FastAPI 가 원본 시그니처를
    그대로 인식한다(functools.wraps 로 __wrapped__ 전파 → 의존성 주입·쿼리 파라미터 유지)."""
    def deco(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            eff_ttl = AGG_CACHE_TTL if ttl is None else ttl
            if eff_ttl <= 0:
                return fn(*args, **kwargs)
            u = kwargs.get("user")
            scope = (u.get("id"), u.get("role")) if isinstance(u, dict) else None
            try:
                rest = tuple(sorted((k, v) for k, v in kwargs.items() if k != "user"))
                key = (fn.__name__, scope, rest)
                hash(key)
            except TypeError:
                return fn(*args, **kwargs)  # 캐시 불가한 인자면 그냥 계산.
            now = time.time()
            with _AGG_CACHE_LOCK:
                gen = _DATA_GEN
                hit = _AGG_CACHE.get(key)
                if hit and hit[0] > now and hit[1] == gen:
                    return hit[2]
            result = fn(*args, **kwargs)
            with _AGG_CACHE_LOCK:
                # 계산 도중 쓰기가 있었으면(_DATA_GEN 상승) 저장하되 그 세대로 태그해,
                # 다음 조회에서 최신 세대와 불일치 → 자동 재계산되게 한다(오염 방지).
                _AGG_CACHE[key] = (now + eff_ttl, _DATA_GEN, result)
            return result
        return wrapper
    return deco


@app.middleware("http")
async def _bump_gen_on_write(request: Request, call_next):
    """성공한 변경 요청(POST/PUT/PATCH/DELETE) 뒤 데이터 세대를 올려 집계 캐시를
    무효화한다. 이로써 TTL 과 무관하게 쓰기 직후 대시보드/통계가 항상 최신을 반영한다."""
    response = await call_next(request)
    if request.method in ("POST", "PUT", "PATCH", "DELETE") and response.status_code < 400:
        bump_data_generation()
    return response


@app.on_event("startup")
def _sync_schema() -> None:
    """배포된 DB 스키마를 모델과 동기화한다.

    모델에 추가된 신규 컬럼(예: vendor_rfqs.sent_at / sent_to_email)이 운영 DB에
    누락되면 INSERT 시 500이 나고, CORSMiddleware가 500 응답에 CORS 헤더를 붙이지
    않아 프런트엔드에는 "Failed to fetch"로만 보인다. 시작 시 누락 컬럼을 자동
    추가해 스키마 드리프트를 방지한다."""
    try:
        from db.engine import Base
        from init_db import (
            migrate_columns, migrate_normalize_incoterms, migrate_backfill_price_history,
            migrate_reset_mail_sync_cursor, migrate_seed_mail_groups,
            migrate_split_stage_dates_to_orders,
        )

        Base.metadata.create_all(bind=get_engine())
        migrate_columns()
        migrate_normalize_incoterms()   # 'EXW Busan' 등 기존 incoterms 값 표준 라벨로 1회 정규화
        migrate_split_stage_dates_to_orders()  # 단계 완료 표시를 프로젝트 → 고객 P/O 단위로 이관
        migrate_backfill_price_history()  # 품목 구매/판매가 이력 초기 백필(마커 가드 1회)
        migrate_reset_mail_sync_cursor()  # 메일 동기화 커서 되감기(최신부터 읽도록 고친 뒤 1회)
        migrate_seed_mail_groups()  # 한 문의에서 갈라진 형제 딜을 메일 묶음으로 연결
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
    "Billing · Statement",        # 9  (구 10) — 매출 대금청구서·매입 거래명세서(금액 최종확인)
    "Tax Invoice (e-Tax)",        # 10 (구 11) — 전자세금계산서 발행(고객)/수취(벤더)
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
PERM_MODULES = ["dashboard", "progress", "rfq", "po", "documents", "ar", "finance", "marketing", "settings"]
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
    "/api/admin/marketing", "/api/admin/finance/payables",
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
    # /projects/{rfq_id}/... 는 딜 단위로 여는 문서(4단계 Proforma Invoice) —
    # 만지는 것이 문서이므로 7단계와 같은 documents 권한으로 지킨다.
    if path.startswith(("/api/admin/documents", "/api/admin/projects")):
        return "documents"
    if path.startswith("/api/admin/ar"):
        return "ar"
    if path.startswith("/api/admin/finance"):
        return "finance"
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
        elif res == "projects":
            # /projects/{rfq_id}/... — 경로의 id 가 곧 딜이다.
            rfq_id = rid
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
        # 문서에서 제외한 행은 발주서에 나가지 않으므로 원가에서도 뺀다(_total_amount 와 같은 규칙).
        if it.get("excluded"):
            continue
        try:
            tot += float(it.get("cost_price", 0) or 0) * float(it.get("qty", 1) or 1)
        except (TypeError, ValueError):
            pass
    return tot


def cheapest_vendor_quote(quotes) -> tuple[float | None, str]:
    """받은 벤더 견적 중 **가장 싼 것** → (USD 환산액, 표시 문자열). 없으면 (None, "").

    합산하지 않는다. 같은 품목을 여러 벤더에 물어 받는 경쟁 견적이 이 바닥의 기본이라,
    합치면 매입원가가 벤더 수만큼 부풀고 마진이 음수로 뒤집힌다(3사 견적을 더해 마진이
    -56.5% 로 찍히던 것이 이 때문이다). 발주가 나가면 그 P/O 가 실제 매입이므로, 이
    값은 그 전까지 쓰는 추정치다 — 우리가 살 값은 그중 제일 싼 것이다.

    통화는 **고른 그 견적의 것**을 그대로 쓴다. 합계를 '최신 견적의 통화'로 적던 예전
    방식은 원화 견적을 USD 로 적어 내보냈다."""
    priced: list[tuple[float, float, str]] = []
    for q in quotes or []:
        cur = (getattr(q, "currency", None) or "USD").upper()
        total = _items_cost_total(getattr(q, "items", None))
        if total:
            priced.append(((total / USD_KRW_RATE) if cur == "KRW" else total, total, cur))
    if not priced:
        return None, ""
    usd, raw, cur = min(priced, key=lambda t: t[0])
    return usd, _dual_money(raw, cur)


def _total_amount(items) -> float:
    # 문서에서 제외(excluded)한 행은 발행 문서에 나가지 않으므로 금액에서도 뺀다
    # (services.kmaris_docs.normalize_items 와 같은 규칙 — 화면 합계·PDF·청구액이 한 값이 되게).
    return sum(
        float(i.get("amount", 0) or 0) for i in (items or []) if not i.get("excluded")
    )


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

    # ── 세션 스코프 메모 ──────────────────────────────────────────────────────
    # 한 요청에서 같은 (rfq, order) 조합의 단계는 여러 번 필요하다(_pipeline_stage 가
    # dist·recent·snapshot 에서, _stage_auto_times 가 별도로 각각 _deal_progress 를 호출).
    # 매번 자식 테이블(Vendor RFQ/Quote·Quotation·PO·SA·CI·Tax·AR·POD)을 재조회하면
    # RFQ 1건당 수 회의 왕복이 발생한다. 결과를 세션에 캐시해 요청당 1회만 계산한다.
    # (쓰기가 flush 되면 _invalidate_deal_progress_cache 가 폐기 → 항상 최신.)
    order_id = order.id if order is not None else 0
    _dp_cache = getattr(s, "_deal_progress_cache", None)
    if _dp_cache is None:
        _dp_cache = s._deal_progress_cache = {}
    _dp_key = (rfq_id, order_id)
    if _dp_key in _dp_cache:
        return _dp_cache[_dp_key]

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
        # 프로포마 인보이스 — 10단계(세금계산서 발행)를 대신한다(아래 pi_covers_tax).
        pi = (s.query(ProformaInvoice).filter_by(order_id=order.id)
              .order_by(ProformaInvoice.created_at.asc()).first())
        tax = (s.query(TaxInvoiceData).filter_by(ci_id=ci.id)
               .order_by(TaxInvoiceData.created_at.asc()).first()) if ci else None
        ars = s.query(ARRecord).filter_by(order_id=order.id).all()
        # 매입측(AP) — 벤더 P/O 1건 = AP 1건. 9~11단계는 매출(AR)만이 아니라 이 매입까지
        # 끝나야 완료로 본다(벤더 청구서 수취·세금계산서 수취·지급).
        aps = s.query(APRecord).filter_by(order_id=order.id).all()
        pod = (s.query(DeliveryProof).filter_by(order_id=order.id)
               .order_by(DeliveryProof.created_at.asc()).first())
    else:
        pos, sa, ci, pi, tax, ars, aps, pod = [], None, None, None, None, [], [], None

    # ── 매입(AP) 완료 여부 — 이 오더의 벤더 P/O 전부가 각 단계를 통과했는지 ────────
    # 벤더 P/O 가 없으면(발주 없는 딜) 매입측은 따질 것이 없어 통과로 본다.
    _ap_by_po = {a.po_id: a for a in aps}
    _ap_of = lambda po: _ap_by_po.get(po.id)
    ap_all_billed = all(_ap_of(p) is not None for p in pos)
    ap_all_tax = all(getattr(_ap_of(p), "tax_received", False) for p in pos)
    ap_all_paid = all(_enum_val(getattr(_ap_of(p), "status", None)) == "완납" for p in pos)

    # ── (1) 단계 번호 ─────────────────────────────────────────────────────────
    stage = 1
    ar_billed = False   # 매출측 청구 근거 — AR 레코드 또는 CI 기반 세금계산서 데이터
    ar_paid = False     # 매출측 수금 완료 — AR 상태 '완납'
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
            # 9) 대금 청구 — 세금계산서 데이터(구 10) 도 매출측 근거로 본다.
            if ci and tax:
                ar_billed = True

        ar_billed = ar_billed or bool(ars)
        ar_paid = any(_enum_val(a.status) == "완납" for a in ars)
        # 9) 청구 — 고객 청구(AR)와 벤더 청구서 수취(AP)가 모두 잡혀야 이 단계로 본다.
        if ar_billed and ap_all_billed:
            stage = max(stage, 9)

    # 수동 완료(완료 버튼/POD)로 표시된 단계를 반영.
    # (자동 근거가 약하거나 없는 단계만 — 의도치 않은 점프 방지)
    # 표시는 이 고객 P/O(order) 것만 본다 — 같은 프로젝트의 다른 P/O 가 결제 완료라고
    # 이 P/O 까지 완료로 올라가면 안 된다.
    sd = manual_stage_dates(rfq, order)
    # 서비스 업무는 7·8단계(Service Readiness/Complete)도 수동 완료로 진행한다.
    for k in (("7", "8") if is_service else ("8",)):
        if sd.get(k):
            stage = max(stage, int(k))

    # 10) 프로포마 인보이스로 청구한 건은 국내 전자세금계산서를 따로 끊지 않는다 —
    # 발행할 세금계산서가 없으므로 PI 발행을 10단계 완료로 본다(수동 완료 버튼 불필요).
    # 다만 PI 존재만으로 10단계까지 끌어올리지는 않는다: PI 는 보통 7단계(선적 전)에 나가므로
    # 그랬다간 아직 출고도 안 한 건이 파이프라인에서 세금계산서 단계로 보인다.
    # 청구가 시작된 뒤(9단계 이상)에만 적용한다.
    pi_covers_tax = pi is not None and stage >= 9
    # 10·11 단계는 매출(AR)·매입(AP) 양쪽이 끝나야 완료다 — 고객에게 세금계산서를 끊고
    # 수금까지 마쳐도 벤더 세금계산서 수취·지급이 남아 있으면 그 P/O 는 아직 진행 중이다.
    if (bool(sd.get("10")) or pi_covers_tax) and ap_all_tax:
        stage = max(stage, 10)
    if (bool(sd.get("11")) or ar_paid) and ap_all_paid:
        stage = max(stage, 11)

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
            _set(3, min((r for r in (_vquote_recv_iso(q) for q in vquotes) if r), default=""))
    # 4) Customer Quot. 발신 — 발신 일시(sent_at, 시각 포함) 우선. 없으면 발신일(날짜만),
    #    그래도 없으면 레코드 생성시각. (sent_date 는 sent_at 의 날짜부 미러라 시각이 없다.)
    if quo:
        _set(4, (getattr(quo, "sent_at", None) or "").strip()
             or _date_iso(quo.sent_date) or _kst_iso(quo.created_at))
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
        # 10) 세금계산서 발행 — PI 로 갈음한 건은 PI 발행일이 완료 일시.
        #     그 외에는 근거 레코드가 없다(수동 완료 stage_dates 로만 표시).
        # 11) 대금 결제 완료 — 수동 완료(stage_dates)로만 표시
        if pi_covers_tax:
            _set(10, _date_iso(pi.date) or _kst_iso(pi.created_at))

    result = (stage, auto)
    _dp_cache[_dp_key] = result
    return result


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


# 종결 사유 코드 → 목록에 붙일 짧은 말. 사유 고르는 화면의 문장(CLOSE_REASONS)은
# 한 칸에 넣기엔 길다("Project delayed or cancelled").
_CLOSE_REASON_SHORT = {
    "schedule": "Project delayed",
    "slow_response": "Slow response",
    "no_quote": "Unable to quote",
    "other": "Other",
}


def _deal_state_map(s) -> dict[int, dict]:
    """딜(RFQ)별 성사 여부 한 줄 요약 — {rfq_id: {"state": ..., "note": ...}}.

    state 는 딜이 어디까지 갔는지다:
      open(문의만) · quoted(견적 보냄) · ordered(수주, 대금 미완) · paid(결제 완료)
      · closed(종결 — 취소/실주)
    note 는 그 상태를 설명하는 꼬리말이다. 종결이면 사유, 결제 완료면 완납일, 아직
    못 받았으면 왜 아직인지(청구 전 / 청구·미수 / 일부수금 / 연체 며칠). 수금 담당이
    적어 둔 메모(AR notes)가 있으면 그게 사유다 — 사람이 쓴 사정이 코드가 매기는
    분류보다 정확하기 때문.

    목록 한 장을 위해 딜마다 _deal_progress 를 돌리면 딜 수만큼 자식 조회가 나간다.
    여기서는 필요한 표만 통째로 읽어 메모리에서 맞춘다(조회 4회)."""
    orders_by_rfq: dict[int, list] = {}
    order_rfq: dict[int, int] = {}
    for o in s.query(Order.id, Order.rfq_id, Order.stage_dates).all():
        if o.rfq_id:
            orders_by_rfq.setdefault(o.rfq_id, []).append(o)
            order_rfq[o.id] = o.rfq_id
    ars_by_order: dict[int, list] = {}
    for a in s.query(ARRecord.order_id, ARRecord.status, ARRecord.due_date,
                     ARRecord.paid_date, ARRecord.notes).all():
        if a.order_id:
            ars_by_order.setdefault(a.order_id, []).append(a)
    quoted_rfqs = {q.rfq_id for q in
                   s.query(Quotation.rfq_id).filter(Quotation.status != QuotationStatus.DRAFT).all()}
    today_str = date.today().isoformat()

    def unpaid_note(ars: list) -> str:
        """아직 못 받은 대금의 사유 — 사람이 적어 둔 메모가 있으면 그것을 먼저."""
        memo = next((a.notes for a in ars if (a.notes or "").strip()), "")
        if memo:
            return " ".join(memo.split())[:60]
        if not ars:
            return "Not invoiced yet"
        overdue = [a for a in ars if a.due_date and a.due_date < today_str
                   and _enum_val(a.status) != "완납"]
        if overdue:
            oldest = min(a.due_date for a in overdue)
            days = (date.fromisoformat(today_str) - date.fromisoformat(oldest)).days
            return f"Overdue {days}d (due {oldest})"
        if any(_enum_val(a.status) == "일부수금" for a in ars):
            return "Partly collected"
        due = min((a.due_date for a in ars if a.due_date), default="")
        return f"Invoiced, due {due}" if due else "Invoiced, unpaid"

    out: dict[int, dict] = {}
    for r in s.query(RFQ.id, RFQ.status, RFQ.close_reason, RFQ.close_reason_note).all():
        # 종결(실주/취소)은 어디까지 갔든 그것이 결말이다 — 사유를 그대로 세운다.
        if _enum_val(r.status) == RFQStatus.LOST.value:
            note = (r.close_reason_note or "").strip() or _CLOSE_REASON_SHORT.get(
                (r.close_reason or "").strip(), "")
            out[r.id] = {"state": "closed", "note": " ".join(note.split())[:60]}
            continue
        orders = orders_by_rfq.get(r.id) or []
        if not orders:
            out[r.id] = {"state": "quoted" if r.id in quoted_rfqs else "open", "note": ""}
            continue
        ars = [a for o in orders for a in ars_by_order.get(o.id, [])]
        # 결제 완료 = 수금 레코드가 모두 완납이거나, 11단계(대금 결제 완료)를 손으로 표시한 것.
        # 오더가 여럿이면 전부 끝나야 이 딜이 끝난 것이다.
        marked_paid = all((o.stage_dates or {}).get("11") for o in orders)
        all_paid = bool(ars) and all(_enum_val(a.status) == "완납" for a in ars)
        if all_paid or marked_paid:
            when = max((a.paid_date or "" for a in ars), default="")
            out[r.id] = {"state": "paid", "note": when}
        else:
            out[r.id] = {"state": "ordered", "note": unpaid_note(ars)}
    return out


def vendor_usage_counts(s) -> dict[int, int]:
    """벤더별 거래 빈도 {vendor_id: 건수} — 보낸 Vendor RFQ + 발행한 Vendor P/O 합계.
    실제로 자주 거래하는 벤더를 드롭다운 위쪽에 모아 주는 데 쓴다(이름순 목록에서
    매번 스크롤해 찾지 않도록). 집계라 벤더 마스터 조회에서 한 번만 계산한다."""
    counts: dict[int, int] = {}
    for model in (VendorRFQ, PurchaseOrder):
        rows = (s.query(model.vendor_id, func.count(model.id))
                .filter(model.vendor_id.isnot(None))
                .group_by(model.vendor_id).all())
        for vid, n in rows:
            counts[vid] = counts.get(vid, 0) + int(n or 0)
    return counts


def vendor_options(s) -> list[dict]:
    """드롭다운용 벤더 마스터 — 이름순 + 거래 빈도(uses). 정렬(자주 거래 우선)은
    uses 를 보고 화면(VendorSelect)에서 그룹으로 나눠 처리한다."""
    uses = vendor_usage_counts(s)
    # contact/phone/address 는 발주서(6단계) "Supplier information" 칸을 채운다 —
    # 벤더 마스터가 원본이라 화면은 그 값을 읽기전용으로 비추기만 한다.
    return [{"id": v.id, "name": v.name, "email": v.email or "",
             "contact": v.contact or "",
             "phone": v.contact_phone or "",
             "address": v.address or "",
             "logo": getattr(v, "logo", None) or "",
             "uses": uses.get(v.id, 0)}
            for v in s.query(Vendor).order_by(Vendor.name).all()]


def customer_usage_counts(s) -> dict[int, int]:
    """고객사별 거래 빈도 {customer_id: 건수} — 받은 RFQ + 받은 고객 P/O 합계.
    벤더와 같은 이유다: 고객 레코드가 담당자 단위라 목록이 길고, 실제로 일이 오가는
    곳은 몇 곳뿐이라 이름순만으로는 매번 스크롤해 찾아야 한다."""
    counts: dict[int, int] = {}
    for model in (RFQ, Order):
        rows = (s.query(model.customer_id, func.count(model.id))
                .filter(model.customer_id.isnot(None))
                .group_by(model.customer_id).all())
        for cid, n in rows:
            counts[cid] = counts.get(cid, 0) + int(n or 0)
    return counts


def customer_options(s) -> list[dict]:
    """드롭다운용 고객 마스터 — 이름순 + 거래 빈도(uses). 정렬(자주 거래 우선)은
    uses 를 보고 화면(CustomerSelect)에서 그룹으로 나눠 처리한다."""
    uses = customer_usage_counts(s)
    return [{"id": c.id, "name": c.name, "contact": c.contact or "",
             "logo": getattr(c, "logo", None) or "",
             "uses": uses.get(c.id, 0)}
            for c in s.query(Customer).order_by(Customer.name).all()]


def _vrfq_sent_iso(v) -> str:
    """Vendor RFQ 발신 일시(iso) — 수동 입력(sent_at) 우선, 없으면 생성 시각."""
    return (getattr(v, "sent_at", None) or "") or _kst_iso(v.created_at)


def _vquote_recv_iso(q) -> str:
    """Vendor Quote 수신 일시(iso) — 수동 입력(received_at) 우선, 없으면 수신일, 없으면 생성 시각."""
    return ((getattr(q, "received_at", None) or "").strip()
            or _date_iso(getattr(q, "received_date", None))
            or _kst_iso(q.created_at))


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


def _last_activity_iso(stage_dates, stage_auto, stage_notes, extra_times=()) -> str:
    """거래의 마지막 활동 일시(iso 문자열) — 단계 완료 일시(수동/자동)와 단계 노트 중 최신.
    'YYYY-MM-DDTHH:MM' 포맷이 일관되어 문자열 비교(max)로 최신을 구한다. 없으면 ''.

    extra_times: 단계 일시에 잡히지 않는 반복 이벤트의 일시(추가 RFQ 발송·추가 견적 수신 등).
    단계 일시는 그 단계에 '처음 도달한' 시각(2·3단계는 min)이라, 같은 단계에서 벤더를 더
    추가해 보낸 건은 남지 않는다. 그것까지 활동으로 세어야 경과일이 실제 대응을 반영한다."""
    times: list[str] = [t for t in (extra_times or ()) if t]
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
        # 제조사 — 저장은 되는데 여기서 빠져 있어 편집기로 돌아오면 늘 빈 칸이었다.
        "maker": it.get("maker") or "",
        "qty": qty,
        "unit": it.get("unit") or "",
        "unit_price": unit,
        "amount": amount,
        "remark": it.get("remark") or "",
        # 입력 단계에서 고른 품목 분류(선택). 편집기에서 다시 보여주기 위해 그대로 실어 보낸다.
        "category_id": it.get("category_id"),
        # "문서에서 제외" 표식 — 다시 열었을 때도 제외 상태로 보여야 한다.
        "excluded": bool(it.get("excluded")),
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


def _vendor_po_email_body(po, vendor, order, vessel, notes: str, lang: str, project_no: str = "",
                          inline_signature: bool = True) -> str:
    """발주서 메일 본문. inline_signature=False 면 서명을 붙이지 않는다 — 발송 화면이 서명을
    별도 입력칸으로 다루고 발송 시 본문 뒤에 다시 합치기 때문(중복 방지).
    notes 도 발송 화면에서는 빈값으로 넘어온다(본문 뒤 Notes 칸으로 일원화)."""
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
        body += "영업일 기준 3일 이내 수령 확인 및 회신 부탁드립니다.\n"
        if not inline_signature:
            return body
        body += "\n" + email_signature(default=(
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
    body += "Kindly acknowledge receipt and confirm within 3 business days.\n"
    if not inline_signature:
        return body
    body += "\n" + email_signature(default=(
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


# 서명은 문서 종류와 무관하게 담당자당 하나다. 저장할 곳을 새로 만드는 대신 EmailTemplate 의
# 해석 순서(개인 → 회사 기본 → 내장 기본)를 그대로 쓰려고 doc_type="signature" 행에 얹는다.
# (설정 화면의 템플릿 편집기는 doc_type="vendor_rfq" 만 다루므로 이 행이 거기 섞이지 않는다.)
SIGNATURE_DOC_TYPE = "signature"


def resolve_signature(s, user_id, lang: str) -> str:
    """이메일 서명 — 담당자 개인 → 회사 기본(EmailTemplate) → Settings 공용(company.json)
    → 코드 내장 기본값 순으로 해석한다."""
    lang = "ko" if lang == "ko" else "en"
    tpl = _resolve_email_template(s, user_id, SIGNATURE_DOC_TYPE, lang)
    if tpl and (tpl.body_tpl or "").strip():
        return tpl.body_tpl.strip()
    return email_signature(default=_default_signature(lang))


def save_signature(s, user_id, lang: str, text: str, fields=None) -> None:
    """담당자 개인 서명 upsert. 빈 문자열로 저장하면 기본 서명으로 되돌아간다.

    fields 를 주면 구조화 서명(HTML)으로 저장한다 — options 에 필드를, body_tpl 에는
    같은 내용의 평문판을 넣어 둔다. text/plain 파트와 서명을 직접 손보는 발송 화면은
    계속 평문을 쓰기 때문에 둘을 나란히 들고 있어야 한다."""
    lang = "ko" if lang == "ko" else "en"
    t = (s.query(EmailTemplate)
         .filter_by(user_id=user_id, doc_type=SIGNATURE_DOC_TYPE, lang=lang).first())
    if not t:
        t = EmailTemplate(user_id=user_id, doc_type=SIGNATURE_DOC_TYPE, lang=lang)
        s.add(t)
    if fields is not None and sig_has_content(fields):
        norm = normalize_sig_fields(fields, lang)
        t.options = {"sig_fields": norm}
        t.body_tpl = signature_text(norm, lang)
    else:
        t.options = {}
        t.body_tpl = (text or "").strip()
    t.subject_tpl = ""
    t.updated_at = datetime.utcnow()
    s.commit()


def resolve_signature_fields(s, user_id, lang: str):
    """구조화 서명 필드 — 개인 → 회사 기본 순. 없으면 None(평문 서명만 있는 상태)."""
    lang = "ko" if lang == "ko" else "en"
    tpl = _resolve_email_template(s, user_id, SIGNATURE_DOC_TYPE, lang)
    fields = (tpl.options or {}).get("sig_fields") if tpl else None
    return fields if (fields and sig_has_content(fields)) else None


def signature_html_for(s, user_id, text: str):
    """발송 화면이 보낸 서명 평문에 대응하는 HTML 서명을 찾는다.

    발송 화면은 서명을 평문으로 들고 있어서, 저장된 구조화 서명을 그대로 쓰는지
    사용자가 손댔는지를 글자로 비교한다. 손댔으면 그 편집을 존중해 None 을 돌려주고
    (호출부가 평문을 그대로 HTML 로 렌더한다), 그대로면 표 서명을 쓴다.
    언어는 저장된 두 벌(en·ko) 중 일치하는 쪽으로 자동 판별한다.

    발송 화면에서 다른 담당자의 서명을 불러와 보낼 수 있으므로, 로그인 사용자 것이
    아니면 저장된 서명 전체에서 같은 글자를 찾는다 — 못 찾으면 표가 아니라 평문으로
    나갈 뿐이라, 남의 서명이 섞여 들어가는 위험은 없다(글자가 이미 일치해야 한다)."""
    body = " ".join((text or "").split())
    if not body:
        return None
    # 로그인 사용자 것부터 — 대개 자기 서명으로 나간다.
    for lang in ("en", "ko"):
        fields = resolve_signature_fields(s, user_id, lang)
        if fields and " ".join(signature_text(fields, lang).split()) == body:
            return signature_html(fields, lang)
    for t in (s.query(EmailTemplate)
              .filter(EmailTemplate.doc_type == SIGNATURE_DOC_TYPE).all()):
        fields = (t.options or {}).get("sig_fields")
        if not (fields and sig_has_content(fields)):
            continue
        lang = "ko" if t.lang == "ko" else "en"
        if " ".join(signature_text(fields, lang).split()) == body:
            return signature_html(fields, lang)
    return None


def build_vendor_rfq_email(s, user_id, rfq, cust, vessel, vendor, notes, lang,
                           items=None, rfq_no: str | None = None,
                           inline_signature: bool = True) -> tuple[str, str]:
    """(subject, body) 초안 생성 — 담당자 템플릿 우선, 없으면 회사/내장 기본.

    inline_signature=False 면 {{signature}} 토큰을 빈칸으로 렌더한다. 발송 화면은 서명을
    본문과 분리해 별도 입력칸으로 다루므로(본문 뒤에 다시 붙인다) 여기서 넣으면 두 번 들어간다.
    기본 템플릿은 {{signature}} 가 맨 끝이라 결과 메일은 동일하다."""
    lang = "ko" if lang == "ko" else "en"
    tpl = _resolve_email_template(s, user_id, "vendor_rfq", lang)
    subject_tpl = (tpl.subject_tpl if (tpl and tpl.subject_tpl) else vendor_rfq_default_subject_tpl(lang))
    body_tpl = (tpl.body_tpl if (tpl and tpl.body_tpl) else vendor_rfq_default_body_tpl(lang))
    item_cols = ((tpl.options or {}).get("item_cols") if tpl else None) or DEFAULT_VENDOR_RFQ_ITEM_COLS
    ctx = _vendor_rfq_token_ctx(rfq, cust, vessel, vendor, notes, lang, items, rfq_no, item_cols)
    if not inline_signature:
        ctx["signature"] = ""
    return _render_tokens(subject_tpl, ctx), _render_tokens(body_tpl, ctx).rstrip() + "\n"


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
    # 품목 분류(선택) — 입력 단계에서 고르면 저장 시 품목 마스터 분류로 반영된다.
    category_id: int | None = None
    # "문서에서 제외" 표식 — 행은 남기고 발행 P/O·합계에서만 뺀다(kmaris_docs.normalize_items).
    excluded: bool = False


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
    source_files: list[dict] = []      # Auto-fill 소스 파일 메타(영구 보관)


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
    source_files: list[dict] | None = None  # 보내면 소스 파일 메타 전체 교체


class PurchaseOrderCreate(BaseModel):
    order_id: int
    vendor_id: int
    po_no: str | None = None
    date: str | None = None
    currency: str | None = None
    items: list[PoWorkItem] = []
    terms: dict | None = None
    source_files: list[dict] = []      # Auto-fill 소스 파일 메타(영구 보관)


class PurchaseOrderUpdate(BaseModel):
    vendor_id: int | None = None
    po_no: str | None = None
    date: str | None = None
    sent_date: str | None = None
    currency: str | None = None
    status: str | None = None
    items: list[PoWorkItem] | None = None
    terms: dict | None = None
    source_files: list[dict] | None = None  # 보내면 소스 파일 메타 전체 교체


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
    # True = amount 를 '이 청구서로 지금까지 받은 총액'으로 그대로 설정(화면에서 쓰는 방식).
    # 같은 값을 다시 보내도 결과가 같아, 완료 버튼을 두 번 눌러도 수금이 겹쳐 쌓이지 않는다.
    # False(기본) = 기존 누적 방식 — 외부/구 호출 호환용.
    set_total: bool = False
    # 실제로 돈이 들어온 날. 비우면 오늘로 본다 — 지난 입금을 뒤늦게 적을 때 오늘로 밀리면
    # 그날 환율로 매기는 은행 수수료가 엉뚱한 값이 된다.
    paid_on: str | None = None
    # 외화 입금에서 은행이 수취수수료를 떼고 넣어 주었는가. 켜져 있으면 그만큼 모자란
    # 입금도 완납으로 보고(못 받은 것이 아니라 이미 비용으로 나간 것이므로), 그 수수료는
    # Outflow 에 비용 행으로 선다.
    bank_fee: bool = True


class ARSave(BaseModel):
    order_id: int
    ci_no: str | None = ""
    invoice_amount: float = 0.0
    paid_amount: float = 0.0
    currency: str = "USD"
    due_date: str | None = None
    status: str = ""
    notes: str | None = ""
    # 세금계산서(대금청구서) 문서 필드 — 선택. 미전달 시 서버가 기존값을 유지한다.
    invoice_no: str | None = None
    invoice_date: str | None = None
    vat_rate: float | None = None
    items: list[dict] | None = None
    # 부대비용 {"freight","packing","insurance"} — 미전달 시 기존값 유지.
    charges: dict | None = None
    remarks: str | None = None
    # 청구처(BILL TO) 오버라이드 — 미전달 시 기존값 유지.
    bill_to_tax_id: str | None = None
    bill_to_contact: str | None = None
    bill_to_email: str | None = None
    bill_to_phone: str | None = None


class APSave(BaseModel):
    """매입 청구(AP) 저장 — ARSave 의 매입측 대응. 각 행은 하나의 vendor P/O(po_id)."""
    po_id: int
    order_id: int
    vendor_id: int | None = None
    bill_no: str | None = ""
    bill_date: str | None = None
    invoice_amount: float = 0.0
    paid_amount: float = 0.0
    # 실제 지급일 — 미전달 시 기존값 유지(부분 저장이 지급 기록을 지우지 않도록).
    paid_date: str | None = None
    currency: str = "KRW"
    vat_rate: float | None = None
    due_date: str | None = None
    status: str = ""
    items: list[dict] | None = None
    charges: dict | None = None      # 부대비용 {"freight","packing","insurance"}
    notes: str | None = None
    # 전자세금계산서 수취(10단계) — 미전달 시 기존값 유지.
    tax_received: bool | None = None
    tax_received_date: str | None = None
    tax_invoice_no: str | None = None


class APPayment(BaseModel):
    amount: float
    due_date: str | None = None
    paid_date: str | None = None   # 실제 지급일(미전달이면 오늘)


class TaxInvoicePdfReq(BaseModel):
    # TAX INVOICE 미리보기 — 저장 없이 현재 편집값으로 PDF 렌더.
    invoice_no: str | None = ""
    invoice_date: str | None = ""
    due_date: str | None = ""
    currency: str = "KRW"
    vat_rate: float = 0.1
    items: list[dict] = []
    charges: dict = {}               # 부대비용 {"freight","packing","insurance"}
    remarks: str | None = ""
    # 청구처(BILL TO) 오버라이드 — 비우면 고객 마스터값 사용.
    bill_to_tax_id: str | None = ""
    bill_to_contact: str | None = ""
    bill_to_email: str | None = ""
    bill_to_phone: str | None = ""


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


# ── 클레임(납품 후 하자·사고) 과 크레딧 노트(감액 증서) ─────────────────────────
# 비용 라인의 부담 주체와 정산 방식. 한 라인은 이 둘을 함께 가져야 한다 — 같은 비용이
# 매출 차감(크레딧 노트)과 비용 계상(현금 지급)으로 두 번 잡히는 것을 막는 기준이다.
CLAIM_COST_KINDS = ["labor", "parts", "freight", "inspection", "other"]
CLAIM_BEARERS = ["us", "customer", "vendor", "shared"]
CLAIM_SETTLEMENTS = ["credit_note", "cash", "vendor_ap", "none"]
CLAIM_STATUSES = ["open", "settled", "closed"]


class ClaimSave(BaseModel):
    """클레임 저장 — 사건 헤더 + 비용 라인(costs). 라인 형식은 Claim 모델 주석 참고."""
    rfq_id: int | None = None
    order_id: int | None = None
    claim_no: str | None = ""
    occurred_date: str | None = ""
    reported_date: str | None = ""
    site: str | None = ""
    title: str | None = ""
    description: str | None = ""
    status: str | None = "open"
    costs: list[dict] | None = None
    owner_id: int | None = None


class CreditNoteSave(BaseModel):
    """크레딧 노트 발행/수정. ar_id(상계 대상 청구서)는 필수다 — 어느 청구서에서
    깎았는지가 없으면 미수 잔액과 맞출 수 없다.

    applied_amount(청구서 통화 상계액)를 비워 보내면 amount × fx_rate 로 채운다.
    vat_amount 를 비워 보내면 vat_rate 로 총액에서 갈라 낸다(내수 감액=수정세금계산서).
    """
    claim_id: int | None = None
    ar_id: int
    cn_no: str | None = ""
    issue_date: str | None = ""
    currency: str = "USD"
    amount: float = 0.0
    fx_rate: float | None = None
    applied_amount: float | None = None
    vat_rate: float | None = None
    vat_amount: float | None = None
    reason: str | None = ""
    status: str | None = "issued"


def _ar_outstanding(ar) -> float:
    """이 청구서로 아직 받을 돈 = 청구액 − 수금액 − 크레딧(상계)."""
    return round((ar.invoice_amount or 0) - (ar.paid_amount or 0)
                 - float(getattr(ar, "credit_amount", None) or 0), 2)


def _ar_recalc_status(ar) -> None:
    """수금·상계 후 청구서 상태를 다시 매긴다(완납/일부수금/미수).

    오차 1센트는 완납으로 본다 — 은행이 센트에서 반올림하고, 환산 상계액도 원 단위에서
    떨어지지 않는다. 완납일은 처음 잔액이 0 이 된 날을 유지한다(재수정으로 밀리지 않게).
    """
    settled = _ar_outstanding(ar) <= 0.01 and (ar.invoice_amount or 0) > 0
    received = (ar.paid_amount or 0) + float(getattr(ar, "credit_amount", None) or 0)
    if settled:
        ar.status = ARStatus.PAID
    elif received > 0:
        ar.status = ARStatus.PARTIAL
        ar.paid_date = None
    else:
        ar.status = ARStatus.OUTSTANDING
        ar.paid_date = None


def _sync_ar_credit(session, ar_id: int) -> float:
    """그 청구서에 붙은 유효한 크레딧 노트를 다시 합산해 ARRecord.credit_amount 를 채운다.

    합계를 증분으로 더하지 않고 매번 다시 세는 이유 — 발행·수정·삭제·무효(void)가 섞여도
    표 하나만 보면 답이 나오고, 어긋난 잔액이 남지 않는다.
    """
    ar = session.query(ARRecord).filter_by(id=ar_id).first()
    if not ar:
        return 0.0
    total = sum(
        float(c.applied_amount or 0)
        for c in session.query(CreditNote).filter_by(ar_id=ar_id).all()
        if (c.status or "issued") != "void"
    )
    ar.credit_amount = round(total, 2)
    _ar_recalc_status(ar)
    return ar.credit_amount


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


def _same_person(a: str, b: str) -> bool:
    return str(a or "").strip().casefold() == str(b or "").strip().casefold()


class _DealContactCustomer:
    """고객 레코드 + 이 거래의 담당자. 담당자 이름이 고객 마스터에 없는 사람일 때만 쓴다.

    Customer 와 같은 속성을 읽기 전용으로 흉내내므로 문서 생성·payload 가 그대로 쓸 수 있다.
    이메일은 비운다 — 등록된 사람이 아니라 주소를 모르는데, 다른 사람 주소를 문서에 찍는 것보다
    빈칸이 낫다(화면의 Buyer e-mail 칸에 직접 적으면 그 값이 인쇄된다)."""

    def __init__(self, base, contact: str):
        self.id = base.id
        self.name = base.name
        self.address = base.address
        self.contact = contact
        self.contact_phone = ""
        self.email = ""
        self.tax_id = base.tax_id
        # 회사 단위 값(청구서 Bill to 선택지 등)은 그대로 이어받는다.
        self.emails = getattr(base, "emails", None) or []
        self.phones = getattr(base, "phones", None) or []
        self.tax_invoice_email = getattr(base, "tax_invoice_email", "") or ""


def _customer_for_order(session, order: Order):
    """오더의 고객 — 담당자(contact·email)는 이 거래의 RFQ 에 적힌 담당자를 따른다.

    고객 마스터는 "레코드 1개 = 담당자 1명"이라 같은 회사라도 담당자마다 레코드가 다르다.
    그래서 오더에 붙은 레코드가 1단계 RFQ 에서 고른 담당자와 다르면(예: 오더를 회사의 다른
    담당자 레코드로 만든 경우) 문서 BUYER 칸과 발송 메일이 엉뚱한 사람으로 나간다.
    이 거래의 상대는 RFQ 에 기록된 담당자이므로 그쪽을 우선한다 — 단 같은 회사일 때만
    (회사가 아예 다르면 오더 쪽이 맞다)."""
    cust = session.query(Customer).filter_by(id=order.customer_id).first()
    rfq = _rfq_for_order(session, order)
    if not rfq or not cust:
        return cust
    rc = (session.query(Customer).filter_by(id=rfq.customer_id).first()
          if getattr(rfq, "customer_id", None) else None)
    if rc and not _same_person(rc.name, cust.name):
        # RFQ 와 오더의 고객사 자체가 다르다 — 이 오더의 상대는 오더 쪽이므로 담당자도 건드리지 않는다.
        return cust
    # 1) RFQ 가 고른 담당자 레코드(같은 회사)면 그 레코드를 통째로 쓴다 — 이메일·전화까지 그 사람 것.
    if rc and rc.id != cust.id:
        cust = rc
    name = str(getattr(rfq, "contact_person", "") or "").strip()
    if not name or _same_person(name, cust.contact):
        return cust
    # 2) RFQ 에 적힌 담당자 이름이 레코드와 다르면 같은 회사의 다른 담당자 레코드에서 찾는다.
    for c in session.query(Customer).filter(Customer.name == cust.name).all():
        if _same_person(name, c.contact):
            return c
    # 3) 등록된 담당자가 아니면(자동 추출로 이름만 적힌 경우) 이름만 RFQ 값을 쓴다.
    return _DealContactCustomer(cust, name)


def _customer_contacts_brief(session, customer_id: int) -> list[dict]:
    """고객사 담당자 요약 — 청구서 Bill to 선택용(대표 우선 정렬)."""
    rows = (session.query(CustomerContact)
            .filter_by(customer_id=customer_id)
            .order_by(CustomerContact.is_primary.desc(), CustomerContact.id).all())
    return [{"name": c.name or "", "email": c.email or "",
             "phone": c.phone or "", "position": c.position or ""} for c in rows]


def _vessel_for_order(session, order: Order):
    if not order.vessel_id:
        return None
    return session.query(Vessel).filter_by(id=order.vessel_id).first()


def _latest_pi(session, order_id: int):
    return (
        session.query(ProformaInvoice)
        .filter_by(order_id=order_id)
        .order_by(ProformaInvoice.id.desc())
        .first()
    )


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
        # "문서에서 제외"(excluded)한 행도 여기서는 처리된 것으로 센다 — 이 경고는 오더 품목을
        # 빠뜨렸는지 보는 장치이고, 제외는 (다른 항목에 합쳐 넣는 등) 의도한 선택이라
        # 품목표 머리의 "n excluded from this document" 안내로 이미 드러난다.
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


def manual_stage_dates(rfq, order) -> dict:
    """수동 완료 표시 {단계번호: 완료일시} — 고객 P/O(오더) 단위로 읽는다.

    청구(9)·세금계산서(10)·수금(11)은 P/O마다 시점이 다르다(A는 이번 달 입금, B는 다음 달).
    그래서 완료 표시를 오더에 두고, 오더가 아직 자기 기록을 갖기 전(NULL, 구 데이터)이면
    프로젝트 단위로 찍어 둔 값을 그대로 쓴다. 오더가 없으면(고객 P/O 이전) 프로젝트 값."""
    if order is not None:
        own = getattr(order, "stage_dates", None)
        if own is not None:
            return dict(own)
    return dict(getattr(rfq, "stage_dates", None) or {})


def set_manual_stage(rfq, order, stage: int, value: str | None) -> dict:
    """오더의 수동 완료 표시를 갱신(value 가 비면 해제)하고 갱신된 dict 를 돌려준다.

    첫 갱신 때는 프로젝트 값을 물려받은 상태에서 시작해, 이후로는 그 오더가 자기 기록을
    갖는다(해제도 그 오더에만 남는다 — 프로젝트 값이 되살아나지 않게).
    오더가 없으면 예전처럼 프로젝트(RFQ)에 기록한다. JSON 컬럼은 새 dict 로 재할당해야
    변경이 감지되므로 항상 복사본을 만들어 넣는다."""
    key = str(stage)
    val = (value or "").strip()
    dates = manual_stage_dates(rfq, order)
    if val:
        dates[key] = val
    else:
        dates.pop(key, None)
    if order is not None:
        order.stage_dates = dates
    elif rfq is not None:
        rfq.stage_dates = dates
    return dates


def _rfq_for_order(session, order: Order):
    """오더 → 연결된 RFQ(프로젝트). 단계 완료 표시는 오더별(Order.stage_dates)."""
    if getattr(order, "rfq_id", None):
        rfq = session.query(RFQ).filter_by(id=order.rfq_id).first()
        if rfq:
            return rfq
    if getattr(order, "quotation_id", None):
        q = session.query(Quotation).filter_by(id=order.quotation_id).first()
        if q and q.rfq_id:
            return session.query(RFQ).filter_by(id=q.rfq_id).first()
    return None


def _doc_defaults(session, order: Order) -> dict:
    """상위 단계에서 이미 입력한 값 — 새 문서(Proforma/Commercial Invoice)의 기본값.

    우선순위는 고객 P/O(5단계 Order) > 고객 견적(3·4단계 Quotation). 같은 거래에서
    나중에 확정된 값이 문서에 실려야 하므로 오더 값을 먼저 본다. 어느 단계에서 왔는지
    (sources)도 함께 내려보내 화면이 "어디서 채웠는지" 알려줄 수 있게 한다.
    값이 없으면 빈 문자열 — 화면은 기존 기본값을 그대로 쓴다."""
    q = None
    if getattr(order, "quotation_id", None):
        q = session.query(Quotation).filter_by(id=order.quotation_id).first()
    return _doc_defaults_from(getattr(order, "terms", None),
                              getattr(order, "currency", ""), q)


def _doc_defaults_from(order_terms, order_currency, q) -> dict:
    """`_doc_defaults` 의 본체 — 오더 쪽 값(terms·통화)과 견적을 합친다.

    오더가 아직 없는 단계(4단계 Proforma Invoice)에서는 오더 쪽을 비워 부르면
    견적 값만으로 같은 모양의 기본값이 나온다."""
    ot = order_terms if isinstance(order_terms, dict) else {}
    qt = (q.terms if (q and isinstance(q.terms, dict)) else {}) or {}
    out: dict = {}
    sources: dict = {}
    for k in ("payment_terms", "packing"):
        ov, qv = str(ot.get(k) or "").strip(), str(qt.get(k) or "").strip()
        out[k] = ov or qv
        if ov:
            sources[k] = "order"
        elif qv:
            sources[k] = "quotation"
    # Incoterms 와 Place 는 한 쌍으로 읽어야 한다 — "EXW Busan" 의 Busan 은 출발지지만
    # "CIF Rotterdam" 의 Rotterdam 은 도착지다. 둘을 다른 단계에서 섞어 오면 장소의 뜻이
    # 뒤바뀌므로, 오더가 둘 중 하나라도 채웠으면 오더 쪽 쌍을, 아니면 견적 쪽 쌍을 통째로 쓴다.
    pair_from_order = any(str(ot.get(k) or "").strip() for k in ("incoterms", "delivery_place"))
    pair = ot if pair_from_order else qt
    for k in ("incoterms", "delivery_place"):
        v = str(pair.get(k) or "").strip()
        out[k] = v
        if v:
            sources[k] = "order" if pair_from_order else "quotation"
    cur = str(order_currency or "").strip()
    if cur:
        sources["currency"] = "order"
    elif q and (q.currency or "").strip():
        cur = q.currency.strip()
        sources["currency"] = "quotation"
    out["currency"] = cur.upper()
    out["sources"] = sources
    return out


def _document_detail_payload(session, order: Order) -> dict:
    cust = _customer_for_order(session, order)
    vessel = _vessel_for_order(session, order)
    pi = _latest_pi(session, order.id)
    ci = _latest_ci(session, order.id)
    pl = _latest_pl(session, ci.id if ci else None)
    sa = _latest_sa(session, order.id)
    tax = _latest_tax(session, ci.id if ci else None)
    pod = (session.query(DeliveryProof).filter_by(order_id=order.id)
           .order_by(DeliveryProof.created_at.desc()).first())
    rfq = _rfq_for_order(session, order)
    sd = manual_stage_dates(rfq, order)
    # 발주된 Vendor(들) — 이 오더의 PurchaseOrder vendor_id → Vendor.name (중복 제거)
    pos = session.query(PurchaseOrder).filter_by(order_id=order.id).all()
    vendor_ids = [po.vendor_id for po in pos if po.vendor_id]
    # K-Maris (Vendor) P/O No.(KMS-ORD-yymm-nnn) — Shipping Marks Reference No. 자동입력용.
    kms_order_no = next((po.po_no for po in pos if po.po_no), "")
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
            "kms_order_no": kms_order_no,
            "date": order.date or "",
            "status": _enum_val(order.status),
            "customer": cust.name if cust else "",
            "customer_email": cust.email if cust else "",
            # 문서(CI/PL)의 BUYER 칸에 인쇄되는 주소 — 화면에서도 같은 값을 보여준다.
            "customer_address": (cust.address or "") if cust else "",
            # 본사·지사 주소 목록 — 문서에서 대표 주소 대신 다른 곳을 찍을 때 고른다.
            "customer_addresses": (cust.addresses or []) if cust else [],
            "customer_tax_id": cust.tax_id if cust else "",
            # 청구서(Bill to) 선택지 — 저장된 고객 정보에서 고르거나 직접 입력.
            # 담당자는 person-centric 모델이라 Customer.contact(대표 담당자명)를 기본으로 쓴다.
            # (구 customer_contacts 자식테이블은 폐기·미사용이지만, 데이터가 있으면 함께 제안.)
            "customer_contact": (cust.contact or "") if cust else "",
            "customer_tax_invoice_email": (getattr(cust, "tax_invoice_email", None) or "") if cust else "",
            "customer_emails": (cust.emails or []) if cust else [],
            "customer_phones": (cust.phones or []) if cust else [],
            "customer_contacts": _customer_contacts_brief(session, cust.id) if cust else [],
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
            "pod_notes": getattr(order, "pod_notes", None) or "",
            "items": order.items or [],
            # 상위 단계(고객 P/O·견적)에서 이미 입력한 거래조건·통화 — 문서 기본값으로 쓴다.
            "doc_defaults": _doc_defaults(session, order),
        },
        "pod": None if not pod else {
            "id": pod.id,
            "filename": pod.filename or "POD",
            "uploaded_at": pod.uploaded_at or "",
        },
        # 수동 완료(완료 버튼) 단계 상태 — 7·8(서비스) · 10 · 11
        "stage_done": {k: bool(sd.get(k)) for k in ("7", "8", "10", "11")},
        "pi": None if not pi else {
            "id": pi.id,
            "pi_no": pi.pi_no or "",
            "date": pi.date or "",
            "currency": pi.currency or "USD",
            "vat_rate": pi.vat_rate or 0.0,
            "items": pi.items or [],
            "shipping": pi.shipping or {},
            "terms": pi.terms or {},
            "missing": _missing_items(order.items or [], pi.items or []),
        },
        "ci": None if not ci else {
            "id": ci.id,
            "ci_no": ci.ci_no or "",
            "date": ci.date or "",
            "currency": ci.currency or "USD",
            "vat_rate": ci.vat_rate or 0.0,
            "items": ci.items or [],
            "shipping": ci.shipping or {},
            "terms": ci.terms or {},
            "missing": _missing_items(order.items or [], ci.items or []),
        },
        "pl": None if not pl else {
            "id": pl.id,
            "pl_no": pl.pl_no or "",
            "date": pl.date or "",
            "items": pl.items or [],
            "packing_info": pl.packing_info or "",
            "shipping": pl.shipping or {},
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


# ── 프로젝트 단위 Proforma Invoice — 4단계(견적 발송)와 7단계(선적 준비)의 같은 한 장 ──
#
# PI 는 원래 고객 P/O(오더)에 달린다. 그런데 고객이 선급금을 치르려면 P/O 를 내기 전에
# PI 부터 필요할 때가 있어(선불 거래·신규 거래처) 4단계에서도 같은 문서를 만든다.
# 그때는 오더가 없으므로 order_id 없이 rfq_id 만 달고 저장되고, 그 딜에 고객 P/O 가
# 등록되는 순간 오더에 붙는다(create_order). 두 단계가 한 장을 나눠 쓰는 방식이다.

def _project_pi(session, rfq_id: int):
    """이 프로젝트(딜)의 Proforma Invoice — 4·7단계가 같은 문서를 보게 하는 해석기.

    대표 오더에 달린 PI 가 있으면 그것, 없으면 오더 없이 이 딜에 달린 PI.
    (고객 P/O 가 여럿인 딜은 오더마다 PI 를 따로 둘 수 있는데, 4단계는 P/O 가 갈리기
    전의 자리라 대표 오더의 PI 를 그 딜의 PI 로 본다.)"""
    order = _order_for_rfq(session, rfq_id)
    if order:
        pi = _latest_pi(session, order.id)
        if pi:
            return pi
    return (session.query(ProformaInvoice)
            .filter(ProformaInvoice.rfq_id == rfq_id, ProformaInvoice.order_id.is_(None))
            .order_by(ProformaInvoice.id.desc()).first())


def adopt_project_pi(session, order: Order) -> None:
    """고객 P/O 등록 시, 오더보다 먼저 만들어 둔 PI 를 이 오더에 붙인다.

    이걸 하지 않으면 4단계에서 쓴 PI 가 7단계에서 안 보인다 — 7단계는 오더로만 찾기
    때문이다. 붙이고 나면 이후 조회·발행·단계 판정이 모두 기존 경로(order_id) 그대로
    같은 문서를 가리킨다."""
    rfq_id = getattr(order, "rfq_id", None)
    if not rfq_id:
        q = (session.query(Quotation).filter_by(id=order.quotation_id).first()
             if getattr(order, "quotation_id", None) else None)
        rfq_id = q.rfq_id if q else None
    if not rfq_id:
        return
    orphan = (session.query(ProformaInvoice)
              .filter(ProformaInvoice.rfq_id == rfq_id, ProformaInvoice.order_id.is_(None))
              .order_by(ProformaInvoice.id.desc()).first())
    if orphan is not None:
        orphan.order_id = order.id


def _project_quotation(session, rfq_id: int):
    """딜의 대표 고객 견적 — 발송된 것 중 최신, 없으면 초안까지 포함한 최신.
    4단계 PI 의 품목·거래조건·통화를 여기서 물려받는다(그 견적으로 청구하는 것이므로)."""
    base = session.query(Quotation).filter(Quotation.rfq_id == rfq_id)
    return (base.filter(Quotation.status != QuotationStatus.DRAFT)
            .order_by(Quotation.created_at.desc()).first()
            or base.order_by(Quotation.created_at.desc()).first())


def _doc_items_from_quotation(quo) -> list[dict]:
    """견적 품목 → 문서 품목. 판매가(단가·금액)만 넘긴다 — PI 는 고객에게 나가는 청구서라
    원가(cost_price)·마진은 실리지 않는다."""
    out: list[dict] = []
    for it in (quo.items or []) if quo else []:
        if not isinstance(it, dict):
            continue
        out.append({
            "part_no": it.get("part_no") or "",
            "description": it.get("description") or "",
            "qty": it.get("qty") or 0,
            "unit": it.get("unit") or "PCS",
            "unit_price": it.get("unit_price"),
            "amount": it.get("amount"),
            "remark": it.get("remark") or "",
            "excluded": bool(it.get("excluded")),
        })
    return out


def _project_doc_context(session, rfq: RFQ) -> dict:
    """4단계 Proforma Invoice 화면이 쓰는 문서 문맥 — `_document_detail_payload` 와 같은 모양.

    오더가 있으면 그 오더의 문맥을 그대로 돌려준다(7단계와 완전히 같은 값 = 한 장 공유).
    아직 없으면 오더 자리에 딜·견적에서 모은 값을 채운 '오더 없는 문맥'을 세운다:
    id 0, P/O 번호 없음, 품목은 고객 견적의 품목."""
    order = _order_for_rfq(session, rfq.id)
    if order is not None:
        return _document_detail_payload(session, order)

    cust = session.query(Customer).filter_by(id=rfq.customer_id).first() if rfq.customer_id else None
    vessel = session.query(Vessel).filter_by(id=rfq.vessel_id).first() if rfq.vessel_id else None
    quo = _project_quotation(session, rfq.id)
    pi = _project_pi(session, rfq.id)
    items = _doc_items_from_quotation(quo)
    return {
        "order": {
            "id": 0,
            "rfq_id": rfq.id,
            "assignee_id": rfq.created_by or 0,
            "po_no": "",
            "kms_order_no": "",
            # 이 딜의 고객 견적번호 — 오더가 없어 P/O 번호로 PI 번호를 못 만드는 4단계에서
            # "<견적번호>-PI" 로 자동 채번한다(7단계의 "<P/O 번호>-PI" 와 같은 규칙).
            "quotation_no": (quo.qtn_no or "") if quo else "",
            "date": (quo.date if quo else "") or rfq.date or "",
            "status": "",
            "customer": cust.name if cust else "",
            "customer_email": (cust.email or "") if cust else "",
            "customer_address": (cust.address or "") if cust else "",
            "customer_addresses": (cust.addresses or []) if cust else [],
            "customer_tax_id": (cust.tax_id or "") if cust else "",
            "customer_contact": (cust.contact or "") if cust else "",
            "customer_tax_invoice_email": (getattr(cust, "tax_invoice_email", None) or "") if cust else "",
            "customer_emails": (cust.emails or []) if cust else [],
            "customer_phones": (cust.phones or []) if cust else [],
            "customer_contacts": _customer_contacts_brief(session, cust.id) if cust else [],
            "vessel": vessel.name if vessel else "",
            "project_title": rfq.project_title or "",
            "project_no": _project_no_map(session).get(rfq.id, ""),
            "first_rfq_at": _first_rfq_iso(rfq),
            "work_type": _enum_val(rfq.work_type) if rfq.work_type else "부품공급",
            "vendor": "",
            # 거래구분은 고객 P/O 에서 정해진다 — 그전엔 기본값(수출)으로 서식만 맞춘다.
            "trade_type": "수출",
            "service_info": {},
            "tracking_token": rfq.tracking_token or "",
            "consignee_confirmed_date": "",
            "vendor_docs_sent_date": "",
            "pod_notes": "",
            "items": items,
            "doc_defaults": _doc_defaults_from(None, "", quo),
        },
        "pod": None,
        "stage_done": {k: False for k in ("7", "8", "10", "11")},
        "pi": None if not pi else {
            "id": pi.id,
            "pi_no": pi.pi_no or "",
            "date": pi.date or "",
            "currency": pi.currency or "USD",
            "vat_rate": pi.vat_rate or 0.0,
            "items": pi.items or [],
            "shipping": pi.shipping or {},
            "terms": pi.terms or {},
            "missing": _missing_items(items, pi.items or []),
        },
        # 나머지 문서는 오더가 생긴 뒤의 것들 — 이 문맥에선 언제나 비어 있다.
        "ci": None,
        "pl": None,
        "sa": None,
        "tax": None,
        "smtp_configured": bool(os.getenv("SMTP_USER") and os.getenv("SMTP_PASSWORD")),
    }


class DocumentMilestoneUpdate(BaseModel):
    field: str
    value: bool


class PodNotesSave(BaseModel):
    """8) Delivery Complete · POD 화면 메모 저장(파일 유무와 무관)."""
    notes: str = ""


class ProformaInvoiceSave(BaseModel):
    pi_no: str | None = None
    date: str | None = None
    currency: str = "USD"
    vat_rate: float = 0.0
    items: list[dict] = []
    shipping: dict = {}
    terms: dict = {}


class CommercialInvoiceSave(BaseModel):
    ci_no: str | None = None
    date: str | None = None
    currency: str = "USD"
    vat_rate: float = 0.0
    items: list[dict] = []
    shipping: dict = {}
    terms: dict = {}


class PackingListSave(BaseModel):
    pl_no: str | None = None
    date: str | None = None
    items: list[dict] = []
    packing_info: str | None = None
    shipping: dict | None = None


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


# ── 단계 완료 콜 — 그 고객 P/O(Order.stage_dates)에 완료 표시(7·8·10·11) ────────
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


# ── Finance: 지급대장(payables) + 수입대장(incomes) + 재무 집계 ────────────────
# 컨설팅비는 프로젝트 매출에서 산출되는 지급이라 나머지 운영비와 성격이 다르다 —
# Outflow 에서도 제 갈래(Consulting fee)를 따로 갖는다.
# 클레임 비용(당사 부담 + 현금 지급) 분류 — 손익의 운영비 줄과 지급대장에서 같은 이름으로
# 선다. 상계로 정산한 몫은 여기 오지 않는다(그건 매출 차감이다).
CLAIM_CATEGORY = "클레임"
FINANCE_CATEGORIES = ["거래선지급", "컨설팅비", "임차료", "급여", "공과금", "수수료", "세금",
                      CLAIM_CATEGORY, "기타"]
# 기타 수입 분류 — 프로젝트 매출(AR)이 아닌 입금.
# 투자금은 통장에 들어오지만 매출이 아니다(자본 유입) — 손익표는 이 분류를 수익에서 뺀다.
FINANCE_INCOME_CATEGORIES = ["이자수입", "환급", "투자금", "잡수입", "기타"]

# ── 해외 타발송금 수취수수료 ──────────────────────────────────────────────────
# 외화가 들어올 때 은행이 떼는 건당 정액. 원화로 매겨지므로 입금 통화로는 그날 환율만큼
# 달라진다($8,200 보내면 $8,193.18 이 들어오고, 그 차액이 이것이다).
# 수금 등록(ar)과 지출 집계(finance) 두 곳이 같은 값·같은 환율을 봐야 해서 여기 둔다.
INBOUND_FEE_KRW = 10_000.0
INBOUND_FEE_CATEGORY = "수수료"

_DAY_RATE_CACHE: dict[tuple[str, str], tuple[float, str]] = {}


def day_base_rate(day: str, cur: str) -> tuple[float, str]:
    """그날의 매매기준율(1 cur = ? KRW) → (환율, 실제 고시일). 실패하면 (고정환율, "")."""
    from services.fx import get_rates

    cur = (cur or "USD").upper()
    if cur == "KRW":
        return 1.0, ""
    key = (day, cur)
    if key in _DAY_RATE_CACHE:
        return _DAY_RATE_CACHE[key]
    row, used, _err = get_rates(day, cur)
    out = ((float(row["base"]) / float(row.get("unit") or 1), used) if row and row.get("base")
           else (USD_KRW_RATE if cur == "USD" else 1.0, ""))
    _DAY_RATE_CACHE[key] = out
    return out


def inbound_fee_in(cur: str, day: str) -> tuple[float, float, str]:
    """그날 그 통화로 환산한 수취수수료 → (수수료, 적용환율, 고시일). 원화면 (0, 1, "").

    금액이 건마다 다른 이유가 여기 다 들어 있다 — 정액은 원화 쪽이고, 외화 금액은 그날
    고시로 나눈 결과다. 그래서 호출부는 산출근거를 그대로 적어 둘 수 있다.
    """
    cur = (cur or "").upper()
    if not cur or cur == "KRW" or not day:
        return 0.0, 1.0, ""
    rate, used = day_base_rate(day, cur)
    return (round(INBOUND_FEE_KRW / rate, 2) if rate else 0.0), rate, used
FINANCE_RECURRENCES = {"none", "monthly", "quarterly", "yearly"}


class FinancePayableIn(BaseModel):
    category: str | None = "기타"
    counterparty: str | None = ""
    vendor_id: int | None = None
    # 이 지급이 걸린 프로젝트(RFQ) — 컨설팅 수수료가 어느 딜의 매출에서 나왔는지.
    rfq_id: int | None = None
    description: str | None = ""
    amount: float | None = 0.0          # 지급 총액(공급가액 + 부가세)
    vat_amount: float | None = 0.0      # 총액에 포함된 부가세(매입세액)
    currency: str | None = "KRW"
    # 외화 지급에 적용한 환율(1 외화 = ? KRW). 원화 건은 비운다.
    fx_rate: float | None = None
    bill_date: str | None = ""
    due_date: str | None = ""
    recurrence: str | None = "none"
    recur_until: str | None = ""
    # 이 비용이 걸리는 기간 'YYYY-MM' — 여러 달을 덮는 고지서를 그 달들에 나눠 싣는다.
    accrual_from: str | None = ""
    accrual_to: str | None = ""
    notes: str | None = ""


class FinancePayablePayIn(BaseModel):
    """납부 표시 토글. occurrence 를 주면(반복 항목의 특정 회차일) 그 회차만 토글."""
    paid: bool = True
    occurrence: str | None = None
    # 실제 납부일(YYYY-MM-DD). 예정일과 다를 수 있어 별도로 받는다. 미지정 시 오늘.
    paid_on: str | None = None


class FinanceIncomeIn(BaseModel):
    """기타 수입 등록/수정 — FinancePayableIn 의 수입측 대응."""
    category: str | None = "기타"
    counterparty: str | None = ""
    customer_id: int | None = None
    description: str | None = ""
    amount: float | None = 0.0
    currency: str | None = "KRW"
    due_date: str | None = ""
    recurrence: str | None = "none"
    recur_until: str | None = ""
    notes: str | None = ""


def _finance_payable_paid_on(p: FinancePayable, iso: str) -> bool:
    """해당 회차일(iso)이 납부 완료인지. 반복은 paid_dates, 일회성은 paid 플래그."""
    if (p.recurrence or "none") == "none":
        return bool(p.paid)
    return iso in (p.paid_dates or [])


def _finance_payable_row(p: FinancePayable, vendor_names: dict, user_names: dict) -> dict:
    return {
        "id": p.id,
        "category": p.category or "기타",
        "counterparty": p.counterparty or (vendor_names.get(p.vendor_id, "") if p.vendor_id else ""),
        "vendor_id": p.vendor_id,
        "description": p.description or "",
        "amount": round(p.amount or 0, 2),
        # 총액에 포함된 부가세와 그 나머지(공급가액) — 결산·부가세 화면이 쓰는 값.
        "vat_amount": round(getattr(p, "vat_amount", None) or 0, 2),
        "supply_amount": round((p.amount or 0) - (getattr(p, "vat_amount", None) or 0), 2),
        "currency": p.currency or "KRW",
        "bill_date": p.bill_date or "",
        "due_date": p.due_date or "",
        "recurrence": p.recurrence or "none",
        "recur_until": p.recur_until or "",
        # 이 비용이 걸리는 기간(YYYY-MM) — 비어 있으면 청구일 한 달에 통째로 선다.
        "accrual_from": getattr(p, "accrual_from", None) or "",
        "accrual_to": getattr(p, "accrual_to", None) or "",
        "paid": bool(p.paid),
        # 반복 항목의 paid_date 는 '가장 최근 실제 납부일'(회차일이 아님).
        "paid_date": (p.paid_date or "") if (p.recurrence or "none") == "none"
                     else max((getattr(p, "payments", None) or {}).values(), default=""),
        "paid_dates": list(p.paid_dates or []),
        # {회차일: 실제 납부일} — 예정일과 다른 날 납부한 이력.
        "payments": dict(getattr(p, "payments", None) or {}),
        # 이 지급이 걸린 프로젝트(컨설팅 수수료 등) — 목록에서 그 딜로 가는 링크용.
        "rfq_id": getattr(p, "rfq_id", None) or 0,
        # 외화 지급에 적용한 환율(1 외화 = ? KRW). 미입력이면 0 — 화면이 '아직 안 정해졌다'로 읽는다.
        "fx_rate": float(getattr(p, "fx_rate", None) or 0),
        "notes": p.notes or "",
        "owner_id": p.owner_id or 0,
        "owner": user_names.get(p.owner_id, "") if p.owner_id else "",
    }


def _finance_income_row(r, customer_names: dict, user_names: dict) -> dict:
    """FinanceIncome → 목록 행. 지급대장 행과 같은 키 구성(화면·집계 공용)."""
    amount = round(r.amount or 0, 2)
    settled = bool(r.paid) if (r.recurrence or "none") == "none" else (r.due_date in (r.paid_dates or []))
    who = r.counterparty or (customer_names.get(r.customer_id, "") if r.customer_id else "")
    today_str = date.today().isoformat()
    overdue = (not settled) and bool(r.due_date) and r.due_date < today_str
    return {
        "id": r.id,
        "source": "income",
        "category": r.category or "기타",
        "counterparty": who,
        # 미수 목록(ARRecord 행)과 같은 키도 함께 채운다 — 집계·표가 두 소스를 공용한다.
        "customer": who or "—",
        "ci_no": "",
        "invoice_no": r.description or "",
        "status": "완납" if settled else ("연체" if overdue else "미수"),
        "overdue": overdue,
        "customer_id": r.customer_id,
        "description": r.description or "",
        "amount": amount,
        # 미수 목록과 같은 3열 — 수령 완료면 전액 입금으로 본다.
        "invoice_amount": amount,
        "paid_amount": amount if settled else 0.0,
        "outstanding": 0.0 if settled else amount,
        "currency": r.currency or "KRW",
        "due_date": r.due_date or "",
        "recurrence": r.recurrence or "none",
        "recur_until": r.recur_until or "",
        "paid": bool(r.paid),
        "paid_date": (r.paid_date or "") if (r.recurrence or "none") == "none"
                     else max((getattr(r, "payments", None) or {}).values(), default=""),
        "paid_dates": list(r.paid_dates or []),
        "payments": dict(getattr(r, "payments", None) or {}),
        "notes": r.notes or "",
        "owner_id": r.owner_id or 0,
        "owner": user_names.get(r.owner_id, "") if r.owner_id else "",
    }


def _add_months(d: date, months: int) -> date:
    """월 단위 가산(월말 보정: 없는 날짜는 그 달 마지막 날로)."""
    m = d.month - 1 + months
    y = d.year + m // 12
    m = m % 12 + 1
    import calendar as _cal
    day = min(d.day, _cal.monthrange(y, m)[1])
    return date(y, m, day)


def _finance_occurrences(p: FinancePayable, start: date, end: date) -> list[str]:
    """반복 규칙을 [start, end] 구간에서 회차일(ISO) 목록으로 펼친다. 일회성이면 due_date 1건."""
    base_s = (p.due_date or "").strip()
    if not base_s:
        return []
    try:
        base = date.fromisoformat(base_s[:10])
    except ValueError:
        return []
    rec = p.recurrence or "none"
    if rec == "none":
        return [base.isoformat()] if start <= base <= end else []
    step = {"monthly": 1, "quarterly": 3, "yearly": 12}.get(rec)
    if not step:
        return [base.isoformat()] if start <= base <= end else []
    until = end
    if (p.recur_until or "").strip():
        try:
            until = min(end, date.fromisoformat(p.recur_until[:10]))
        except ValueError:
            pass
    out: list[str] = []
    cur = base
    # 최초 회차가 구간 뒤라도, base 부터 step 씩 전진하며 구간에 드는 회차만 수집(안전 상한).
    guard = 0
    while cur <= until and guard < 600:
        if cur >= start:
            out.append(cur.isoformat())
        cur = _add_months(cur, step)
        guard += 1
    return out


def _finance_receivable_rows(s) -> list[dict]:
    """미수(수금) 집계 — ARRecord 기준. 미수금·연체·거래선(고객)별 표시에 사용."""
    today_str = date.today().isoformat()
    ord_map = {o.id: o for o in s.query(Order).all()}
    cust_names = {c.id: c.name for c in s.query(Customer).all()}
    # 수금 완료일 = 이 P/O(오더)의 11단계 완료일. 오더 수만큼 재조회하지 않도록
    # RFQ 를 한 번에 읽어 매핑한다(견적 경유 연결도 함께 훑는다 — 구 데이터 폴백용).
    rfq_by_id = {q.id: q for q in s.query(RFQ).all()}
    qtn_rfq = {q.id: q.rfq_id for q in s.query(Quotation).all()}

    def _rfq_id_of(order) -> int:
        """오더가 속한 프로젝트(RFQ) id — 직접 연결이 없으면 견적 경유로 찾는다."""
        if not order:
            return 0
        rid = getattr(order, "rfq_id", None) or qtn_rfq.get(getattr(order, "quotation_id", None) or 0)
        return rid or 0

    def _stage11_date(order) -> str:
        rfq = rfq_by_id.get(_rfq_id_of(order))
        return (manual_stage_dates(rfq, order).get("11") or "")[:10]

    rows: list[dict] = []
    for r in s.query(ARRecord).all():
        o = ord_map.get(r.order_id)
        cust = cust_names.get(o.customer_id, "—") if o else "—"
        invoice = round(r.invoice_amount or 0, 2)
        paid = round(r.paid_amount or 0, 2)
        # 크레딧 노트로 깎아 준 금액도 받을 돈에서 빠진다 — 상계는 돈이 오가지 않았을
        # 뿐 이미 결제된 것이라, 미수로 남겨 두면 영영 못 받는 잔액으로 쌓인다.
        credit = round(float(getattr(r, "credit_amount", None) or 0), 2)
        outstanding = round(invoice - paid - credit, 2)
        # 상태는 저장된 enum 대신 금액·기일에서 매번 계산한다. 한 번 '연체'로 저장된 뒤
        # 기일을 미루면 옛 상태가 그대로 남는 문제가 있었다(표시가 실제와 어긋남).
        settled = invoice > 0 and outstanding <= 0
        overdue = not settled and bool(r.due_date) and r.due_date < today_str and outstanding > 0
        if settled:
            status = "완납"
        elif overdue:
            status = "연체"
        elif paid > 0:
            status = "일부수금"
        else:
            status = "미수"
        rows.append({
            "id": r.id,
            "order_id": r.order_id,
            # 이 청구서가 속한 프로젝트 — 목록에서 프로젝트 팝업으로 바로 가는 링크용.
            # 한 프로젝트에 고객 P/O(오더)가 여러 건이면 order_id 만으로는 목록에서
            # 프로젝트를 못 찾는다(파이프라인 행은 대표 오더 하나만 들고 있다).
            "rfq_id": _rfq_id_of(o),
            "customer": cust,
            "ci_no": r.ci_no or "",
            "invoice_no": r.invoice_no or "",
            "currency": r.currency or "USD",
            "invoice_amount": invoice,
            "paid_amount": paid,
            "outstanding": outstanding,
            # 청구서 발행일(9단계 대금청구서에 입력). 미입력이면 빈값.
            "invoice_date": (r.invoice_date or "")[:10],
            "due_date": r.due_date or "",
            # 완납일 — 레코드에 기록된 날짜 우선, 없으면 11단계(수금 완료) 일시로 폴백.
            "paid_date": ((r.paid_date or "")[:10] or _stage11_date(o)) if settled else "",
            # 이 입금에서 은행이 실제로 떼어간 수취수수료(입금 통화). 0 = 기록 없음.
            "bank_fee": round(float(getattr(r, "bank_fee", None) or 0), 2),
            # 크레딧 노트(클레임 상계)로 깎아 준 금액 — 0 이면 상계 없음.
            "credit_amount": credit,
            "status": status,
            "overdue": bool(overdue),
        })
    return rows


def _ap_record_rows(s) -> list[dict]:
    """매입(지급) 집계 — APRecord 기준. Finance 지급대장·미지급·캘린더에 사용.

    한 행 = vendor P/O 하나에 대한 우리의 지급 의무. outstanding = 청구액 − 지급액.
    """
    today_str = date.today().isoformat()
    ord_map = {o.id: o for o in s.query(Order).all()}
    cust_names = {c.id: c.name for c in s.query(Customer).all()}
    vendor_names = {v.id: v.name for v in s.query(Vendor).all()}
    po_map = {p.id: p for p in s.query(PurchaseOrder).all()}
    # 오더 → 프로젝트(RFQ). 미수 목록과 같은 이유로 필요하다(대표 오더가 아닌 건도
    # 목록에서 프로젝트를 찾을 수 있어야 한다). 견적 경유 연결도 함께 훑는다.
    qtn_rfq = {q.id: q.rfq_id for q in s.query(Quotation).all()}

    def _rfq_id_of(order) -> int:
        if not order:
            return 0
        return (getattr(order, "rfq_id", None)
                or qtn_rfq.get(getattr(order, "quotation_id", None) or 0) or 0)

    rows: list[dict] = []
    for r in s.query(APRecord).all():
        o = ord_map.get(r.order_id)
        cust = cust_names.get(o.customer_id, "—") if o else "—"
        vendor = vendor_names.get(r.vendor_id, "—")
        po = po_map.get(r.po_id)
        invoice = round(r.invoice_amount or 0, 2)
        paid = round(r.paid_amount or 0, 2)
        outstanding = round(invoice - paid, 2)
        status = _enum_val(r.status)
        overdue = status != ARStatus.PAID and bool(r.due_date) and r.due_date < today_str and outstanding > 0
        rows.append({
            "id": r.id,
            "po_id": r.po_id,
            "order_id": r.order_id,
            "rfq_id": _rfq_id_of(o),
            "po_no": (po.po_no or "") if po else "",
            "vendor": vendor,
            "customer": cust,
            "bill_no": r.bill_no or "",
            "bill_date": (r.bill_date or "")[:10],
            "currency": r.currency or "KRW",
            "invoice_amount": invoice,
            "paid_amount": paid,
            # 실제 지급일 — 예정일과 달리 '돈이 나간 날'. Finance 실적 집계가 이 날짜를 쓴다.
            "paid_date": (r.paid_date or "")[:10],
            "outstanding": outstanding,
            "due_date": r.due_date or "",
            "status": "연체" if overdue else status,
            "overdue": bool(overdue),
            "tax_received": bool(r.tax_received),
            "tax_received_date": r.tax_received_date or "",
            "tax_invoice_no": r.tax_invoice_no or "",
        })
    return rows


# ── Settings: master data (list + create) ─────────────────────────────────────
class ContactIn(BaseModel):
    """고객사·공급사 담당자 1명(회사 1:N). 다중 담당자 등록/수정에 사용."""
    name: str | None = ""
    email: str | None = ""
    phone: str | None = ""
    position: str | None = ""
    is_primary: bool = False


class CustomerCreate(BaseModel):
    name: str
    contact: str | None = ""
    contact_phone: str | None = ""
    email: str | None = ""
    country: str | None = ""
    address: str | None = ""
    tax_id: str | None = ""
    tax_invoice_email: str | None = ""   # 세금계산서 수신 전용 메일
    payment_terms: str | None = ""   # 기본 결제조건
    # 회사 소개 요약(회사 단위 — Company info 창에서 편집). None = 건드리지 않음.
    note: str | None = None
    logo: str | None = ""    # 회사 로고 data URL(붙여넣기). None=변경 안 함(수정 시)
    # 한 회사에 본사·지사가 여럿이고, 담당자 1명이 여러 이메일·연락처·지역을 가질 수 있어
    # 다중값. 첫 값=대표(문서·메일용).
    addresses: list[str] | None = None
    emails: list[str] | None = None
    phones: list[str] | None = None
    regions: list[str] | None = None


class VendorCreate(BaseModel):
    name: str
    contact: str | None = ""
    contact_phone: str | None = ""
    email: str | None = ""
    specialization: str | None = ""
    # 회사 소개 요약(회사 단위 — Company info 창에서 편집). None = 건드리지 않음:
    # 담당자 편집 폼처럼 이 칸을 보내지 않는 곳에서 기존 소개글이 지워지지 않게 한다.
    note: str | None = None
    country: str | None = ""
    address: str | None = ""
    payment_terms: str | None = ""   # 기본 결제조건
    logo: str | None = ""    # 회사 로고 data URL(붙여넣기). None=변경 안 함(수정 시)
    addresses: list[str] | None = None   # 다중 주소(본사·지사, 첫 값=대표)
    emails: list[str] | None = None
    phones: list[str] | None = None
    regions: list[str] | None = None


class ConsultantCreate(BaseModel):
    """소개자(컨설턴트) 등록·수정. 계좌는 수수료를 낼 때 그대로 쓰는 값이라 함께 받는다."""
    name: str
    company: str | None = ""
    phone: str | None = ""
    email: str | None = ""
    country: str | None = ""
    tax_id: str | None = ""
    bank_name: str | None = ""
    bank_account: str | None = ""
    bank_holder: str | None = ""
    swift: str | None = ""
    default_rate: float | None = 10.0   # 기본 수수료율(%)
    currency: str | None = "KRW"
    notes: str | None = ""


def _serialize_contacts(session, ChildModel, fk_attr: str, parent_id: int) -> list[dict]:
    """회사의 담당자 목록을 프론트 페이로드용 dict 리스트로 직렬화(대표 먼저)."""
    rows = (session.query(ChildModel)
            .filter(getattr(ChildModel, fk_attr) == parent_id)
            .order_by(ChildModel.is_primary.desc(), ChildModel.id).all())
    return [{"name": r.name or "", "email": r.email or "", "phone": r.phone or "",
             "position": r.position or "", "is_primary": bool(r.is_primary)} for r in rows]


def _sync_contacts(session, ChildModel, fk_attr: str, parent, contacts) -> None:
    """회사의 담당자 집합을 교체(delete-all + re-insert)하고, 대표 담당자를 회사의
    flat contact/email/contact_phone 로 미러링한다(기존 모든 소비처 호환).

    contacts=None 이면 변경하지 않는다. 이름·이메일·전화가 모두 빈 항목은 건너뛴다.
    대표 표시가 하나도 없으면 첫 항목을 대표로 삼는다."""
    if contacts is None:
        return
    clean = [c for c in contacts if (c.name or c.email or c.phone or "").strip()]
    session.query(ChildModel).filter(getattr(ChildModel, fk_attr) == parent.id).delete(
        synchronize_session=False)
    session.flush()
    primary = next((c for c in clean if c.is_primary), clean[0] if clean else None)
    for c in clean:
        session.add(ChildModel(**{fk_attr: parent.id}, name=(c.name or "").strip(),
                               email=(c.email or "").strip(), phone=(c.phone or "").strip(),
                               position=(c.position or "").strip(), is_primary=(c is primary)))
    # 대표 담당자를 회사 flat 필드로 미러링(대표 없으면 비운다).
    parent.contact = (primary.name or "").strip() if primary else ""
    parent.email = (primary.email or "").strip() if primary else ""
    parent.contact_phone = (primary.phone or "").strip() if primary else ""


def _mv_list(raw) -> list[str]:
    """다중값 입력(list)을 공백 제거·빈 값 제외한 문자열 리스트로 정규화."""
    return [str(x).strip() for x in (raw or []) if str(x).strip()]


def _apply_multi(obj, emails, phones, regions, addresses=None) -> None:
    """고객/공급사에 다중 주소·이메일·연락처·지역을 저장하고, 각 리스트의 첫 값(대표)을
    flat 컬럼(address/email/contact_phone/country)에 미러링한다.
    기존 소비처(PDF·메일·목록) 호환.

    리스트가 None(미전송)이면 현재 flat 값을 리스트로 승격해 보존한다(빠른등록 호환)."""
    ad = _mv_list(addresses) if addresses is not None else _mv_list([obj.address])
    em = _mv_list(emails) if emails is not None else _mv_list([obj.email])
    ph = _mv_list(phones) if phones is not None else _mv_list([obj.contact_phone])
    rg = _mv_list(regions) if regions is not None else _mv_list([obj.country])
    obj.addresses, obj.emails, obj.phones, obj.regions = ad, em, ph, rg
    obj.address = ad[0] if ad else ""
    obj.email = em[0] if em else ""
    obj.contact_phone = ph[0] if ph else ""
    obj.country = rg[0] if rg else ""


def _multi_out(raw, flat) -> list[str]:
    """GET 응답용 다중값 — JSON 리스트가 비었으면 flat 단일값으로 폴백(기존 레코드 표시)."""
    lst = _mv_list(raw)
    if not lst and (flat or "").strip():
        lst = [flat.strip()]
    return lst


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
    item_type: str | None = "part"   # 'part'=물품, 'service'=용역
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
    address: str | None = ""            # 국문 주소
    address_en: str | None = ""         # 영문 주소
    business_no: str | None = ""
    phone: str | None = ""
    general_email: str | None = ""
    sales_email: str | None = ""
    tax_email: str | None = ""
    website: str | None = ""
    bank_name: str | None = ""          # 국내계좌 은행명
    bank_account: str | None = ""       # 국내계좌 번호
    bank_holder: str | None = ""        # 국내계좌 예금주
    fx_bank_name: str | None = ""       # 외화계좌 은행명
    fx_bank_account: str | None = ""    # 외화계좌 번호
    fx_bank_holder: str | None = ""     # 외화계좌 예금주
    swift: str | None = ""              # 외화계좌 SWIFT
    tagline: str | None = ""
    email_signature: str | None = ""   # 이메일 본문 하단 공용 서명(비우면 기본 서명)


_COMPANY_CONFIG = ROOT / "config" / "company.json"


# 회사 프로필은 DB(app_settings)에 둔다 — services.company_profile 참고.
# 파일에 쓰던 시절에는 배포·재시작마다 저장한 값이 사라졌다(컨테이너 디스크는 임시).
def _read_company_profile() -> dict:
    from services.company_profile import read_company_profile
    return read_company_profile()


def _write_company_profile(data: dict) -> None:
    from services.company_profile import write_company_profile
    write_company_profile(data)


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
    fx_rate: float | None = None       # 적용 환율(1 USD = ? KRW). 매매기준율/직접입력
    source_files: list[dict] = []      # Auto-fill 소스 파일 메타(영구 보관)


class VendorQuoteUpdate(BaseModel):
    vendor_quote_no: str | None = None
    received_date: str | None = None
    received_at: str | None = None
    currency: str | None = None
    notes: str | None = None
    items: list[dict] | None = None
    terms: dict | None = None
    fx_rate: float | None = None
    source_files: list[dict] | None = None  # 보내면 소스 파일 메타 전체 교체




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
    # 품목 분류(선택) — 입력 단계에서 고르면 저장 시 품목 마스터 분류로 반영된다.
    category_id: int | None = None


class RfqSourceFileIn(BaseModel):
    """Auto-fill 로 업로드·추출한 소스 파일 메타(파일명·아이템수·시각)."""
    name: str = ""
    media_type: str | None = ""
    item_count: int = 0
    at: str | None = ""


def clean_source_files(src) -> list[dict]:
    """Auto-fill 소스 파일 메타 정규화(dict/Pydantic 객체 모두 허용).
    파일명 없는 항목은 제외하고, 시각이 비면 현재(KST)로 채운다.
    RFQ(1단계)·Vendor Quote(3단계)·P/O(5단계) 공용."""
    out: list[dict] = []
    for f in (src or []):
        if isinstance(f, dict):
            name = (f.get("name") or "").strip()
            media = (f.get("media_type") or "").strip()
            cnt = f.get("item_count", 0)
            at = (f.get("at") or "").strip()
        else:
            name = (getattr(f, "name", "") or "").strip()
            media = (getattr(f, "media_type", "") or "").strip()
            cnt = getattr(f, "item_count", 0)
            at = (getattr(f, "at", "") or "").strip()
        if not name:
            continue
        out.append({
            "name": name,
            "media_type": media,
            "item_count": int(cnt or 0),
            "at": at or _kst_iso(datetime.utcnow()),
        })
    return out


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
    consultant_id: int | None = None   # 소개자(컨설턴트). 0/None = 없음
    consultant_rate: float | None = None  # 이 딜만의 수수료율(%). 비우면 컨설턴트 기본율
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
    # 소개자(컨설턴트). 0 → 연결 해제. None → 변경 안 함(다른 필드와 같은 규약).
    consultant_id: int | None = None
    # 이 딜만의 수수료율(%). 음수 → 비우기(컨설턴트 기본율로 되돌림).
    consultant_rate: float | None = None
    notes: str | None = None            # 내부 메모(자유 서술)
    received_at: str | None = None      # "YYYY-MM-DDTHH:MM"
    assignee_id: int | None = None      # 담당자(PIC) = created_by. 0 → 미지정 해제
    items: list[RfqItemIn] | None = None  # 보내면 품목 전체 교체
    source_files: list[RfqSourceFileIn] | None = None  # 보내면 소스 파일 메타 전체 교체


class RfqLevelUpdate(BaseModel):
    follow_up_level: str


class RfqCancelUpdate(BaseModel):
    """딜 종결(취소/실주) 토글. True=종결(status→LOST), False=재활성(status→RECEIVED).
    단계(stage)는 레코드 기반으로 자동 산출되므로 여기서는 status 만 바꾼다.
    종결 시 사유(reason 코드 + 기타 직접입력 note)를 함께 저장한다."""
    cancelled: bool
    # schedule(일정 지연/취소) | slow_response(대응 지연) | no_quote(견적 불가) | other(기타)
    reason: Optional[str] = None
    reason_note: Optional[str] = None


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
    doc_type: str = "vendor_rfq"
    lang: str = "en"
    subject_tpl: str = ""
    body_tpl: str = ""
    options: dict | None = None


class EmailSignatureSave(BaseModel):
    """담당자 개인 이메일 서명 저장. 빈 문자열이면 개인 서명 해제(상위 기본값 사용).
    fields 가 있으면 표(HTML) 서명으로 저장하고 평문판은 자동 생성한다.
    user_id 는 남의 서명을 대신 편집할 때만 쓴다(관리자) — 없으면 본인."""
    lang: str = "en"
    signature: str = ""
    fields: dict | None = None
    user_id: int | None = None


class StageDateUpdate(BaseModel):
    stage: int                 # 1~11
    value: str | None = None   # "YYYY-MM-DDTHH:MM" (KST) 또는 빈값/None → 해제


class StageNoteAdd(BaseModel):
    stage: int                       # 1~11
    text: str
    datetime: str | None = None      # 활동 일시 "YYYY-MM-DDTHH:MM" (KST). 비우면 현재시각
    party: str | None = None         # 소통 상대(회사): 고객사명 / 벤더사명 / 기타
    person: str | None = None        # 소통 상대 담당자: 고객사 담당자 / 벤더사 담당자 / 기타
    channel: str | None = None       # 소통 수단: 이메일 / 통화 / 문자 / 방문 / 기타
    direction: str | None = None     # 방향: in(수신) / out(발신) / 빈값(해당없음)
    star: bool = False               # ★ 우선(회의/후속 표시)
    pic: str | None = None           # 담당자(작성자) username


class StageNoteUpdate(BaseModel):
    stage: int
    index: int                       # 해당 단계 로그 내 인덱스
    text: str
    datetime: str | None = None
    party: str | None = None
    person: str | None = None        # 소통 상대 담당자
    channel: str | None = None
    direction: str | None = None
    star: bool = False
    pic: str | None = None           # 담당자(작성자) username


class StageNoteDelete(BaseModel):
    stage: int
    index: int                 # 해당 단계 로그 내 인덱스


class VendorRfqDeclineBody(BaseModel):
    # '견적 불가(No quote)' 통보 표시 시 함께 받는 일시·사유. 활동로그에 자동 기록된다.
    datetime: str | None = None   # 통보 일시 "YYYY-MM-DDTHH:MM" (KST). 비우면 현재시각
    reason: str | None = None     # 사유(자유 입력)




class CustomerQuoteCreate(BaseModel):
    qtn_no: str | None = None
    currency: str = "USD"
    cost_currency: str | None = None
    round_digits: int | None = None
    margin_pct: float | None = None    # Pricing 밴드 기본 마진(%) — 재편집 시 그대로 복원
    discount_pct: float | None = None
    fx_rate: float | None = None       # 적용 환율(1 USD = ? KRW). 매매기준율/직접입력
    amount: float | None = None
    items: list[dict] | None = None
    sent_at: str | None = None
    valid_until: str | None = None
    remarks: str = ""
    terms: dict | None = None
    vendor_quote_id: int | None = None  # 원가 출처로 선택한 벤더 견적(선택)


class CustomerQuoteUpdate(BaseModel):
    qtn_no: str | None = None
    currency: str | None = None
    cost_currency: str | None = None
    round_digits: int | None = None
    margin_pct: float | None = None
    discount_pct: float | None = None
    fx_rate: float | None = None
    items: list[dict] | None = None
    sent_at: str | None = None
    valid_until: str | None = None
    status: str | None = None
    terms: dict | None = None
    # 원가 출처로 선택한 벤더 견적 id. 명시적으로 보내면(null 포함) 그 값으로 갱신 —
    # 수동입력 전환 시 null 로 링크 해제까지 되게, 갱신은 model_fields_set 로 판별한다.
    vendor_quote_id: int | None = None


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
    "APPayment",
    "APRecord",
    "APSave",
    "_ap_record_rows",
    "ARPayment",
    "ARRecord",
    "ARSave",
    "ARStatus",
    "CommercialInvoice",
    "CommercialInvoiceSave",
    "ContactIn",
    "CustomerContact",
    "VendorContact",
    "_serialize_contacts",
    "_sync_contacts",
    "_apply_multi",
    "_multi_out",
    "_mv_list",
    "ProformaInvoice",
    "ProformaInvoiceSave",
    "CompanyProfile",
    "Consultant",
    "ConsultantCreate",
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
    "MarketingAsset",
    "intro_email_subject",
    "intro_email_body",
    "intro_email_body_tpl",
    "render_marketing_tokens",
    "intro_signature",
    "Form",
    "List",
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
    "FinancePayable",
    "FinancePayableIn",
    "FinancePayablePayIn",
    "FinanceIncome",
    "FinanceIncomeIn",
    "FINANCE_CATEGORIES",
    "FINANCE_INCOME_CATEGORIES",
    "INBOUND_FEE_KRW",
    "INBOUND_FEE_CATEGORY",
    "day_base_rate",
    "inbound_fee_in",
    "FINANCE_RECURRENCES",
    "_finance_income_row",
    "_finance_payable_row",
    "_finance_payable_paid_on",
    "_finance_occurrences",
    "_finance_receivable_rows",
    "Claim",
    "ClaimSave",
    "CreditNote",
    "CreditNoteSave",
    "CLAIM_CATEGORY",
    "CLAIM_COST_KINDS",
    "CLAIM_BEARERS",
    "CLAIM_SETTLEMENTS",
    "CLAIM_STATUSES",
    "_ar_outstanding",
    "_ar_recalc_status",
    "_sync_ar_credit",
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
    "_doc_defaults_from",
    "_doc_items_from_quotation",
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
    "_latest_pi",
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
    "_project_doc_context",
    "_project_pi",
    "_project_quotation",
    "_perms_for",
    "_pipeline_stage",
    "adopt_project_pi",
    "_project_no_for_order",
    "_project_no_map",
    "_deal_state_map",
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
    "EmailMessage",
    "EmailSyncState",
    "EmailTemplateSave",
    "EmailSignatureSave",
    "SIGNATURE_DOC_TYPE",
    "resolve_signature",
    "resolve_signature_fields",
    "signature_html_for",
    "signature_html",
    "signature_text",
    "default_sig_fields",
    "normalize_sig_fields",
    "sig_has_content",
    "html_document",
    "save_signature",
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
    "generate_ci_xlsx",
    "generate_pl_xlsx",
    "generate_pi_xlsx",
    "get_current_user",
    "get_session",
    "io",
    "make_vendor_rfq_quote_xlsx",
    "make_document_xlsx",
    "order_tracking_step",
    "os",
    "parse_business_card_image",
    "parse_business_card_pdf_document",
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
