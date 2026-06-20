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

import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import bcrypt
import jwt
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from db.engine import get_session
from db.models import (
    RFQ, Customer, Vessel, Vendor, User, DocSequence,
    VendorRFQ, VendorQuote, Quotation, QuotationStatus,
    Order, PurchaseOrder, ShippingAdvice, CommercialInvoice,
    PackingList, TaxInvoiceData, ARRecord,
    RFQStatus, OrderStatus, ARStatus,
)

# ── App / CORS ────────────────────────────────────────────────────────────────
app = FastAPI(title="KTMS Admin API", docs_url=None, redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_methods=["*"],
    allow_headers=["*"],
)

ADMIN_API_TOKEN = os.environ.get("ADMIN_API_TOKEN", "dev-token")
SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-change-me")
JWT_ALGO = "HS256"
TOKEN_TTL_HOURS = 12

INTERNAL_STEPS = [
    "Customer RFQ 수신",
    "Vendor RFQ 발신",
    "Vendor Quot. 수신",
    "Customer Quot. 발신",
    "Customer P/O 수신",
    "Vendor P/O 발신",
    "Delivery Readiness",
    "Delivery arrangement",
    "운송 완료 · POD 수취",
    "Tax Invoice 작성 · 대금 청구",
    "세금계산서 발행",
    "대금 결제 완료",
]


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


def require_token(authorization: str | None = Header(default=None)) -> None:
    """Guard: accept a valid JWT, or the pilot static ADMIN_API_TOKEN."""
    token = _bearer(authorization)
    if token and (token == ADMIN_API_TOKEN or _decode_jwt(token)):
        return
    raise HTTPException(status_code=401, detail="Unauthorized")


def get_current_user(authorization: str | None = Header(default=None)) -> dict:
    token = _bearer(authorization)
    claims = _decode_jwt(token) if token else None
    if claims:
        return {
            "id": int(claims.get("sub", 0)),
            "username": claims.get("username", ""),
            "role": claims.get("role", ""),
        }
    if token and token == ADMIN_API_TOKEN:
        return {"id": 0, "username": "dev", "role": "admin"}
    raise HTTPException(status_code=401, detail="Unauthorized")


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
        u = {"id": user.id, "username": user.username,
             "role": user.role.value, "email": user.email or ""}
        return {"token": _make_jwt(u), "user": u}
    finally:
        s.close()


@app.get("/api/admin/me")
def me(user: dict = Depends(get_current_user)):
    return user


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


def _pipeline_stage(s, rfq_id: int) -> int:
    """RFQ 1건의 내부 진행 단계(1~12) — helpers.internal_pipeline_stage 와 동일 로직.
    (FastAPI에서 돌도록 st.cache_data 제거, 세션은 호출측에서 공유)"""
    stage = 1

    vrfqs = s.query(VendorRFQ).filter_by(rfq_id=rfq_id).all()
    if vrfqs:
        stage = max(stage, 2)
        vrfq_ids = [v.id for v in vrfqs]
        if s.query(VendorQuote).filter(VendorQuote.vendor_rfq_id.in_(vrfq_ids)).first():
            stage = max(stage, 3)

    if (s.query(Quotation)
            .filter(Quotation.rfq_id == rfq_id, Quotation.status != QuotationStatus.DRAFT)
            .first()):
        stage = max(stage, 4)

    order = (s.query(Order).filter(Order.rfq_id == rfq_id)
             .order_by(Order.created_at.desc()).first())
    if not order:
        order = (s.query(Order).join(Quotation, Order.quotation_id == Quotation.id)
                 .filter(Quotation.rfq_id == rfq_id)
                 .order_by(Order.created_at.desc()).first())

    if order:
        stage = max(stage, 5)
        if s.query(PurchaseOrder).filter_by(order_id=order.id).first():
            stage = max(stage, 6)

        ost = _enum_val(order.status)
        stage = max(stage, {
            "오더 수주": 5,
            "발주 완료": 6,
            "제조/준비중": 7,
            "출고완료": 8,
            "운송중": 8,
            "목적지 하차 완료": 9,
        }.get(ost, 5))

        if getattr(order, "consignee_confirmed_date", None):
            stage = max(stage, 8)
        if s.query(ShippingAdvice).filter_by(order_id=order.id).first():
            stage = max(stage, 8)
        if getattr(order, "vendor_docs_sent_date", None):
            stage = max(stage, 8)
        ci = s.query(CommercialInvoice).filter_by(order_id=order.id).first()
        if ci:
            stage = max(stage, 8)
            if s.query(TaxInvoiceData).filter_by(ci_id=ci.id).first():
                stage = max(stage, 11)

        ars = s.query(ARRecord).filter_by(order_id=order.id).all()
        if ars:
            stage = max(stage, 10)
            if any(_enum_val(a.status) == "완납" for a in ars):
                stage = max(stage, 12)
    return stage


def _status_label(stage: int) -> str:
    return f"{stage}/{len(INTERNAL_STEPS)} {INTERNAL_STEPS[stage - 1]}"


# ── Endpoints ─────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/admin/rfq-overview", dependencies=[Depends(require_token)])
def rfq_overview(customer_id: int | None = None):
    """RFQ 거래별 통합 현황 — Streamlit render_overview 와 동일한 행 데이터를 JSON으로."""
    s = get_session()
    try:
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        vessel_names = {v.id: v.name for v in s.query(Vessel).all()}

        q = s.query(RFQ).order_by(RFQ.id.desc())
        if customer_id:
            q = q.filter(RFQ.customer_id == customer_id)
        rfqs = q.all()

        rows = []
        for r in rfqs:
            stage = _pipeline_stage(s, r.id)

            vrfqs = (s.query(VendorRFQ).filter_by(rfq_id=r.id)
                     .order_by(VendorRFQ.id.desc()).all())
            if vrfqs:
                vr0 = vrfqs[0]
                vrfq_main = vr0.vrfq_no + (f"  (외 {len(vrfqs) - 1}건)" if len(vrfqs) > 1 else "")
                vrfq_at = _kst(vr0.created_at)
            else:
                vrfq_main, vrfq_at = "", ""

            vrfq_ids = [x.id for x in vrfqs]
            vqs = (s.query(VendorQuote)
                   .filter(VendorQuote.vendor_rfq_id.in_(vrfq_ids))
                   .order_by(VendorQuote.id.desc()).all()
                   if vrfq_ids else [])
            if vqs:
                vq0 = vqs[0]
                _vq_no = getattr(vq0, "vendor_quote_no", None) or "—"
                vq_main = str(_vq_no) + (f"  (외 {len(vqs) - 1}건)" if len(vqs) > 1 else "")
                vq_at = _kst(vq0.created_at)
                _cur = getattr(vq0, "currency", None) or "USD"
                vendor_amount = f"{_cur} {_items_cost_total(vq0.items):,.2f}"
            else:
                vq_main, vq_at, vendor_amount = "", "", ""

            qtn = (s.query(Quotation).filter_by(rfq_id=r.id)
                   .order_by(Quotation.id.desc()).first())
            if qtn:
                qtn_main, qtn_at = qtn.qtn_no, _kst(qtn.created_at)
                customer_amount = f"{qtn.currency} {_total_amount(qtn.items or []):,.2f}"
            else:
                qtn_main, qtn_at, customer_amount = "", "", ""

            rows.append({
                "id": r.id,
                "customer_rfq_no": r.customer_rfq_no or "",
                "customer": cust_names.get(r.customer_id, "—"),
                "vessel": vessel_names.get(r.vessel_id, "") if r.vessel_id else "",
                "item_count": len(r.items or []),
                "crfq_no": r.rfq_no,
                "crfq_at": _kst(r.created_at),
                "vrfq_no": vrfq_main,
                "vrfq_at": vrfq_at,
                "vquote_no": vq_main,
                "vquote_at": vq_at,
                "vendor_amount": vendor_amount,
                "cquote_no": qtn_main,
                "cquote_at": qtn_at,
                "customer_amount": customer_amount,
                "stage": stage,
                "status": _status_label(stage),
            })

        return {"steps": INTERNAL_STEPS, "rows": rows}
    finally:
        s.close()


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
        "qty": qty,
        "unit": it.get("unit") or "",
        "unit_price": unit,
        "amount": amount,
    }


@app.get("/api/admin/rfq/{rfq_id}", dependencies=[Depends(require_token)])
def rfq_detail(rfq_id: int):
    """RFQ 1건 상세 — 품목, 12단계 진행, 연결 문서(Vendor RFQ/Quote/Quotation)."""
    s = get_session()
    try:
        r = s.query(RFQ).filter_by(id=rfq_id).first()
        if not r:
            raise HTTPException(status_code=404, detail="RFQ not found")

        cust = s.query(Customer).filter_by(id=r.customer_id).first()
        vessel = s.query(Vessel).filter_by(id=r.vessel_id).first() if r.vessel_id else None
        stage = _pipeline_stage(s, r.id)

        vrfqs = (s.query(VendorRFQ).filter_by(rfq_id=r.id)
                 .order_by(VendorRFQ.id.desc()).all())
        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}
        vrfq_view = [{
            "id": v.id,
            "vrfq_no": v.vrfq_no,
            "vendor": vendor_names.get(v.vendor_id, "—"),
            "at": _kst(v.created_at),
        } for v in vrfqs]

        vrfq_ids = [v.id for v in vrfqs]
        vqs = (s.query(VendorQuote)
               .filter(VendorQuote.vendor_rfq_id.in_(vrfq_ids))
               .order_by(VendorQuote.id.desc()).all() if vrfq_ids else [])
        vquote_view = [{
            "vendor_quote_no": getattr(q, "vendor_quote_no", None) or "—",
            "amount": f"{getattr(q, 'currency', None) or 'USD'} {_items_cost_total(q.items):,.2f}",
            "at": _kst(q.created_at),
        } for q in vqs]

        qtn = (s.query(Quotation).filter_by(rfq_id=r.id)
               .order_by(Quotation.id.desc()).first())
        qtn_view = None
        if qtn:
            qtn_view = {
                "qtn_no": qtn.qtn_no,
                "amount": f"{qtn.currency} {_total_amount(qtn.items or []):,.2f}",
                "status": _enum_val(qtn.status),
                "at": _kst(qtn.created_at),
            }

        steps = [{
            "no": i,
            "name": name,
            "state": ("done" if i < stage else "current" if i == stage else "todo"),
        } for i, name in enumerate(INTERNAL_STEPS, start=1)]

        return {
            "id": r.id,
            "rfq_no": r.rfq_no,
            "customer_rfq_no": r.customer_rfq_no or "",
            "customer": cust.name if cust else "—",
            "customer_contact": (cust.contact if cust else "") or "",
            "customer_email": (cust.email if cust else "") or "",
            "vessel": vessel.name if vessel else "",
            "date": r.date or "",
            "notes": r.notes or "",
            "stage": stage,
            "status": _status_label(stage),
            "steps": steps,
            "items": [_item_view(it) for it in (r.items or [])],
            "vendor_rfqs": vrfq_view,
            "vendor_quotes": vquote_view,
            "quotation": qtn_view,
        }
    finally:
        s.close()


@app.get("/api/admin/dashboard", dependencies=[Depends(require_token)])
def dashboard():
    """운영 현황 요약 — 핵심 KPI + 12단계 분포 + 최근 RFQ."""
    s = get_session()
    try:
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        rfqs = s.query(RFQ).all()
        orders = s.query(Order).all()
        quotes = s.query(Quotation).all()
        ars = s.query(ARRecord).all()

        open_statuses = {RFQStatus.RECEIVED, RFQStatus.SOURCING,
                         RFQStatus.QUOTING, RFQStatus.SENT}
        open_rfq = sum(1 for r in rfqs if r.status in open_statuses)
        active_orders = sum(1 for o in orders if o.status != OrderStatus.DELIVERED)

        now = datetime.now(timezone.utc)
        monthly_quotes = sum(
            1 for q in quotes
            if q.created_at and q.created_at.year == now.year
            and q.created_at.month == now.month
        )
        ar_outstanding = sum(
            (a.invoice_amount or 0) - (a.paid_amount or 0)
            for a in ars if a.status != ARStatus.PAID
        )

        dist = [0] * len(INTERNAL_STEPS)
        for r in rfqs:
            dist[_pipeline_stage(s, r.id) - 1] += 1

        recent = []
        for r in sorted(rfqs, key=lambda x: x.id, reverse=True)[:8]:
            stage = _pipeline_stage(s, r.id)
            recent.append({
                "rfq_no": r.rfq_no,
                "customer": cust_names.get(r.customer_id, "—"),
                "stage": stage,
                "status": _status_label(stage),
                "at": _kst(r.created_at),
            })

        return {
            "kpi": {
                "open_rfq": open_rfq,
                "total_rfq": len(rfqs),
                "active_orders": active_orders,
                "monthly_quotes": monthly_quotes,
                "ar_outstanding_usd": round(ar_outstanding, 2),
            },
            "steps": INTERNAL_STEPS,
            "stage_distribution": dist,
            "recent": recent,
        }
    finally:
        s.close()


def _order_for_rfq(s, rfq_id: int):
    """RFQ에 연결된 Order — 직접 연결 우선, 없으면 Quotation 경유."""
    order = (s.query(Order).filter(Order.rfq_id == rfq_id)
             .order_by(Order.created_at.desc()).first())
    if not order:
        order = (s.query(Order).join(Quotation, Order.quotation_id == Quotation.id)
                 .filter(Quotation.rfq_id == rfq_id)
                 .order_by(Order.created_at.desc()).first())
    return order


@app.get("/api/admin/po-overview", dependencies=[Depends(require_token)])
def po_overview():
    """고객 P/O · Vendor P/O 현황 — RFQ → Order → PurchaseOrder 체인."""
    s = get_session()
    try:
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        vessel_names = {v.id: v.name for v in s.query(Vessel).all()}
        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}

        rows = []
        for r in s.query(RFQ).order_by(RFQ.id.desc()).all():
            o = _order_for_rfq(s, r.id)
            vpos = (s.query(PurchaseOrder).filter_by(order_id=o.id)
                    .order_by(PurchaseOrder.id.desc()).all()) if o else []
            if vpos:
                vp0 = vpos[0]
                vendor_po_no = (vp0.po_no or "—") + (
                    f"  (외 {len(vpos) - 1}건)" if len(vpos) > 1 else "")
                vendor_nm = vendor_names.get(vp0.vendor_id, "—")
                vendor_email = vp0.sent_to_email or "—"
                vendor_po_at = vp0.sent_date or "미발신"
            else:
                vendor_po_no = vendor_nm = vendor_email = vendor_po_at = ""

            stage = _pipeline_stage(s, r.id)
            rows.append({
                "id": o.id if o else 0,
                "customer_rfq_no": r.customer_rfq_no or r.rfq_no,
                "customer": cust_names.get(r.customer_id, "—"),
                "vessel": vessel_names.get(r.vessel_id, "") if r.vessel_id else "",
                "customer_po_no": (o.po_no if o else "") or "",
                "customer_po_at": (o.date if o else "") or "",
                "ord_no": (o.ord_no if o else "") or "",
                "item_count": len((o.items if o else None) or r.items or []),
                "vendor_po_no": vendor_po_no,
                "vendor_po_at": vendor_po_at,
                "vendor": vendor_nm,
                "vendor_email": vendor_email,
                "stage": stage,
                "status": _status_label(stage),
            })
        return {"rows": rows}
    finally:
        s.close()


@app.get("/api/admin/ar-overview", dependencies=[Depends(require_token)])
def ar_overview():
    """미수금(AR) 현황 — 청구/수금/연체."""
    s = get_session()
    try:
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        ord_map = {o.id: o for o in s.query(Order).all()}
        today_str = date.today().isoformat()

        rows = []
        out_usd = 0.0
        overdue_usd = 0.0
        for r in s.query(ARRecord).order_by(ARRecord.id.desc()).all():
            o = ord_map.get(r.order_id)
            cust = cust_names.get(o.customer_id, "—") if o else "—"
            outstanding = (r.invoice_amount or 0) - (r.paid_amount or 0)
            overdue = (r.status != ARStatus.PAID and r.due_date
                       and r.due_date < today_str)
            status = "연체" if overdue else _enum_val(r.status)
            if (r.currency or "USD") == "USD" and r.status != ARStatus.PAID:
                out_usd += outstanding
                if overdue:
                    overdue_usd += outstanding
            rows.append({
                "id": r.id,
                "ci_no": r.ci_no or "",
                "customer": cust,
                "ord_no": o.ord_no if o else "",
                "currency": r.currency or "USD",
                "invoice_amount": round(r.invoice_amount or 0, 2),
                "paid_amount": round(r.paid_amount or 0, 2),
                "outstanding": round(outstanding, 2),
                "due_date": r.due_date or "",
                "status": status,
                "overdue": bool(overdue),
            })
        return {
            "kpi": {
                "outstanding_usd": round(out_usd, 2),
                "overdue_usd": round(overdue_usd, 2),
                "count": len(rows),
            },
            "rows": rows,
        }
    finally:
        s.close()


class ARPayment(BaseModel):
    amount: float
    due_date: str | None = None


@app.post("/api/admin/ar/{ar_id}/payment", dependencies=[Depends(require_token)])
def ar_payment(ar_id: int, body: ARPayment):
    """수금 등록 — paid_amount 누적 후 상태 자동 갱신."""
    s = get_session()
    try:
        ar = s.query(ARRecord).filter_by(id=ar_id).first()
        if not ar:
            raise HTTPException(status_code=404, detail="AR 레코드를 찾을 수 없습니다.")
        if body.amount <= 0:
            raise HTTPException(status_code=400, detail="수금액은 0보다 커야 합니다.")
        ar.paid_amount = (ar.paid_amount or 0) + body.amount
        if body.due_date:
            ar.due_date = body.due_date
        if ar.paid_amount >= (ar.invoice_amount or 0):
            ar.status = ARStatus.PAID
        elif ar.paid_amount > 0:
            ar.status = ARStatus.PARTIAL
        else:
            ar.status = ARStatus.OUTSTANDING
        s.commit()
        return {"ok": True, "paid_amount": ar.paid_amount, "status": _enum_val(ar.status)}
    finally:
        s.close()


def _quotation_total(items) -> float:
    """견적 총액 — amount 합계, 없으면 unit_price*qty 로 보정."""
    amt = _total_amount(items)
    if amt:
        return amt
    tot = 0.0
    for it in (items or []):
        try:
            tot += float(it.get("unit_price", 0) or 0) * float(it.get("qty", 1) or 1)
        except (TypeError, ValueError):
            pass
    return tot


@app.get("/api/admin/quotation-overview", dependencies=[Depends(require_token)])
def quotation_overview(customer_id: int | None = None):
    """Customer Quotation 현황 — 견적 목록(고객/선박/금액/상태/파이프라인)."""
    s = get_session()
    try:
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        vessel_names = {v.id: v.name for v in s.query(Vessel).all()}
        rfq_nos = {r.id: (r.rfq_no or "") for r in s.query(RFQ).all()}

        q = s.query(Quotation)
        if customer_id:
            q = q.filter(Quotation.customer_id == customer_id)

        rows = []
        for qt in q.order_by(Quotation.id.desc()).all():
            stage = _pipeline_stage(s, qt.rfq_id) if qt.rfq_id else 0
            rows.append({
                "id": qt.id,
                "qtn_no": qt.qtn_no,
                "rfq_no": rfq_nos.get(qt.rfq_id, "") if qt.rfq_id else "",
                "customer": cust_names.get(qt.customer_id, "—"),
                "vessel": vessel_names.get(qt.vessel_id, "") if qt.vessel_id else "",
                "currency": qt.currency or "USD",
                "amount": round(_quotation_total(qt.items or []), 2),
                "item_count": len(qt.items or []),
                "status": _enum_val(qt.status),
                "level": _enum_val(qt.follow_up_level) if qt.follow_up_level else "",
                "valid_until": qt.valid_until or "",
                "sent_date": qt.sent_date or "",
                "date": qt.date or "",
                "stage": stage,
                "pipeline": _status_label(stage) if stage else "",
            })
        return {"rows": rows}
    finally:
        s.close()


@app.get("/api/admin/vrfq-overview", dependencies=[Depends(require_token)])
def vrfq_overview():
    """Vendor RFQ 발신 내역 — VendorRFQ 1건당 1행(고객 RFQ·Vendor·수신 견적 수)."""
    s = get_session()
    try:
        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}
        vendor_emails = {v.id: (v.email or "") for v in s.query(Vendor).all()}
        rfq_nos = {r.id: (r.rfq_no or "") for r in s.query(RFQ).all()}

        quote_counts: dict[int, int] = {}
        for vq in s.query(VendorQuote).all():
            quote_counts[vq.vendor_rfq_id] = quote_counts.get(vq.vendor_rfq_id, 0) + 1

        rows = []
        for vr in s.query(VendorRFQ).order_by(VendorRFQ.id.desc()).all():
            rows.append({
                "id": vr.id,
                "vrfq_no": vr.vrfq_no,
                "customer_rfq_no": rfq_nos.get(vr.rfq_id, "—"),
                "vendor": vendor_names.get(vr.vendor_id, "—"),
                "vendor_email": vr.sent_to_email or vendor_emails.get(vr.vendor_id, "") or "",
                "sent_date": vr.sent_date or "",
                "status": vr.status or "",
                "item_count": len(vr.items or []),
                "quote_count": quote_counts.get(vr.id, 0),
            })
        return {"rows": rows}
    finally:
        s.close()


@app.get("/api/admin/documents-overview", dependencies=[Depends(require_token)])
def documents_overview():
    """문서 현황 — 오더별 CI/PL/SA/Tax 생성 여부와 문서번호."""
    s = get_session()
    try:
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        vessel_names = {v.id: v.name for v in s.query(Vessel).all()}

        # ci_id → pl/tax 존재 매핑
        ci_by_order: dict[int, CommercialInvoice] = {}
        for ci in s.query(CommercialInvoice).all():
            # 오더당 최신 CI 1건
            if ci.order_id not in ci_by_order or ci.id > ci_by_order[ci.order_id].id:
                ci_by_order[ci.order_id] = ci
        pl_ci_ids = {pl.ci_id for pl in s.query(PackingList).all()}
        pl_no_by_ci = {pl.ci_id: pl.pl_no for pl in s.query(PackingList).all()}
        tax_ci_ids = {tx.ci_id for tx in s.query(TaxInvoiceData).all()}
        tax_no_by_ci = {tx.ci_id: tx.tax_no for tx in s.query(TaxInvoiceData).all()}
        sa_by_order: dict[int, ShippingAdvice] = {}
        for sa in s.query(ShippingAdvice).all():
            if sa.order_id not in sa_by_order or sa.id > sa_by_order[sa.order_id].id:
                sa_by_order[sa.order_id] = sa

        rows = []
        for o in s.query(Order).order_by(Order.id.desc()).all():
            ci = ci_by_order.get(o.id)
            sa = sa_by_order.get(o.id)
            ci_id = ci.id if ci else None
            rows.append({
                "id": o.id,
                "ord_no": o.ord_no,
                "customer": cust_names.get(o.customer_id, "—"),
                "vessel": vessel_names.get(o.vessel_id, "") if o.vessel_id else "",
                "po_no": o.po_no or "",
                "ci_no": ci.ci_no if ci else "",
                "pl_no": pl_no_by_ci.get(ci_id, "") if ci_id else "",
                "sa_no": sa.sa_no if sa else "",
                "tax_no": tax_no_by_ci.get(ci_id, "") if ci_id else "",
                "has_ci": bool(ci),
                "has_pl": bool(ci_id and ci_id in pl_ci_ids),
                "has_sa": bool(sa),
                "has_tax": bool(ci_id and ci_id in tax_ci_ids),
            })
        return {"rows": rows}
    finally:
        s.close()


@app.get("/api/admin/vendor-po-overview", dependencies=[Depends(require_token)])
def vendor_po_overview():
    """Vendor P/O 발신 내역 — PurchaseOrder 1건당 1행(생성·발송 포함 전체)."""
    s = get_session()
    try:
        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}
        ord_map = {o.id: o for o in s.query(Order).all()}
        cust_names = {c.id: c.name for c in s.query(Customer).all()}

        rows = []
        for po in s.query(PurchaseOrder).order_by(PurchaseOrder.id.desc()).all():
            o = ord_map.get(po.order_id)
            rows.append({
                "id": po.id,
                "po_no": po.po_no or "",
                "ord_no": o.ord_no if o else "—",
                "customer": cust_names.get(o.customer_id, "—") if o else "—",
                "vendor": vendor_names.get(po.vendor_id, "—"),
                "vendor_email": po.sent_to_email or "",
                "date": po.date or "",
                "sent_date": po.sent_date or "",
                "status": po.status or "",
                "item_count": len(po.items or []),
                "sent": (po.status == "이메일 발송완료"),
            })
        return {"rows": rows}
    finally:
        s.close()


@app.get("/api/admin/customers", dependencies=[Depends(require_token)])
def customers():
    s = get_session()
    try:
        return [{"id": c.id, "name": c.name}
                for c in s.query(Customer).order_by(Customer.name).all()]
    finally:
        s.close()


@app.get("/api/admin/vendors", dependencies=[Depends(require_token)])
def vendors():
    s = get_session()
    try:
        return [{"id": v.id, "name": v.name, "email": v.email or ""}
                for v in s.query(Vendor).order_by(Vendor.name).all()]
    finally:
        s.close()


# ── Settings: master data (list + create) ─────────────────────────────────────
class CustomerCreate(BaseModel):
    name: str
    contact: str | None = ""
    email: str | None = ""
    country: str | None = ""


class VendorCreate(BaseModel):
    name: str
    contact: str | None = ""
    email: str | None = ""
    specialization: str | None = ""


class VesselCreate(BaseModel):
    name: str
    imo: str | None = ""
    customer_id: int | None = None


@app.get("/api/admin/settings/customers", dependencies=[Depends(require_token)])
def settings_customers():
    s = get_session()
    try:
        return [{"id": c.id, "name": c.name, "contact": c.contact or "",
                 "email": c.email or "", "country": c.country or ""}
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
                     email=body.email or "", country=body.country or "")
        s.add(c)
        s.commit()
        return {"ok": True, "id": c.id}
    finally:
        s.close()


@app.get("/api/admin/settings/vendors", dependencies=[Depends(require_token)])
def settings_vendors():
    s = get_session()
    try:
        return [{"id": v.id, "name": v.name, "contact": v.contact or "",
                 "email": v.email or "", "specialization": v.specialization or ""}
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
                   email=body.email or "", specialization=body.specialization or "")
        s.add(v)
        s.commit()
        return {"ok": True, "id": v.id}
    finally:
        s.close()


@app.get("/api/admin/settings/vessels", dependencies=[Depends(require_token)])
def settings_vessels():
    s = get_session()
    try:
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        return [{"id": v.id, "name": v.name, "imo": v.imo or "",
                 "customer": cust_names.get(v.customer_id, "") if v.customer_id else ""}
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
                   customer_id=body.customer_id)
        s.add(v)
        s.commit()
        return {"ok": True, "id": v.id}
    finally:
        s.close()


# ── Write actions ─────────────────────────────────────────────────────────────
_DOC_PREFIX = {"vendor_rfq": "VRFQ", "quotation": "QTN"}


def _next_doc_no(session, doc_type: str, company_prefix: str = "KMS") -> str:
    """연단위 시퀀스 채번. 시퀀스가 기존 번호와 어긋나도 충돌 번호는 건너뛴다."""
    yr = date.today().year
    seq = session.query(DocSequence).filter_by(doc_type=doc_type, year=yr).first()
    if not seq:
        seq = DocSequence(doc_type=doc_type, year=yr, last_seq=0)
        session.add(seq)
    while True:
        seq.last_seq += 1
        no = f"{company_prefix}-{_DOC_PREFIX.get(doc_type, 'DOC')}-{yr}-{seq.last_seq:04d}"
        if doc_type == "vendor_rfq" and \
                session.query(VendorRFQ).filter_by(vrfq_no=no).first():
            continue
        session.flush()
        return no


class VendorRfqCreate(BaseModel):
    vendor_id: int


@app.post("/api/admin/rfq/{rfq_id}/vendor-rfq",
          dependencies=[Depends(require_token)])
def create_vendor_rfq(rfq_id: int, body: VendorRfqCreate):
    """RFQ로부터 Vendor RFQ 발신(생성). 품목은 RFQ 품목을 그대로 이관한다."""
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            raise HTTPException(status_code=404, detail="RFQ를 찾을 수 없습니다.")
        vendor = s.query(Vendor).filter_by(id=body.vendor_id).first()
        if not vendor:
            raise HTTPException(status_code=400, detail="Vendor를 선택하세요.")

        # 요청 품목(가격 제외)만 이관
        req_items = [{
            "part_no": it.get("part_no", ""),
            "description": it.get("description", ""),
            "qty": it.get("qty", 1),
        } for it in (rfq.items or [])]

        vrfq_no = _next_doc_no(s, "vendor_rfq")
        vrfq = VendorRFQ(
            vrfq_no=vrfq_no,
            rfq_id=rfq.id,
            vendor_id=vendor.id,
            sent_date=date.today().strftime("%Y-%m-%d"),
            sent_to_email=vendor.email or "",
            status="발송됨",
            items=req_items,
        )
        s.add(vrfq)
        s.commit()
        return {"ok": True, "vrfq_no": vrfq_no, "vendor": vendor.name}
    finally:
        s.close()


class VendorQuoteCreate(BaseModel):
    vendor_rfq_id: int
    vendor_quote_no: str
    amount: float


@app.post("/api/admin/rfq/{rfq_id}/vendor-quote",
          dependencies=[Depends(require_token)])
def create_vendor_quote(rfq_id: int, body: VendorQuoteCreate):
    """Vendor Quote 수신 등록. amount는 견적 총액(USD)으로 단일 품목에 기록한다."""
    s = get_session()
    try:
        vrfq = s.query(VendorRFQ).filter_by(id=body.vendor_rfq_id, rfq_id=rfq_id).first()
        if not vrfq:
            raise HTTPException(status_code=400, detail="해당 RFQ의 Vendor RFQ를 선택하세요.")
        if not body.vendor_quote_no.strip():
            raise HTTPException(status_code=400, detail="Vendor 견적번호를 입력하세요.")

        vq = VendorQuote(
            vendor_rfq_id=vrfq.id,
            vendor_quote_no=body.vendor_quote_no.strip(),
            received_date=date.today().strftime("%Y-%m-%d"),
            items=[{"cost_price": body.amount, "qty": 1, "amount": body.amount}],
        )
        s.add(vq)
        s.commit()
        return {"ok": True, "vendor_quote_no": vq.vendor_quote_no}
    finally:
        s.close()


def _next_rfq_no(session, company_prefix: str = "KMS") -> str:
    """helpers.next_rfq_no 와 동일: KMS-RFQ-yymm-NNN (월 단위, 충돌 번호 건너뜀)."""
    today = date.today()
    period = today.year * 100 + today.month
    seq = session.query(DocSequence).filter_by(
        doc_type="rfq_internal", year=period).first()
    if not seq:
        seq = DocSequence(doc_type="rfq_internal", year=period, last_seq=0)
        session.add(seq)
    while True:
        seq.last_seq += 1
        no = f"{company_prefix}-RFQ-{today:%y%m}-{seq.last_seq:03d}"
        if not session.query(RFQ).filter_by(rfq_no=no).first():
            session.flush()
            return no


class RfqItemIn(BaseModel):
    part_no: str = ""
    description: str = ""
    qty: float = 1


class RfqCreate(BaseModel):
    customer_id: int
    vessel_id: int | None = None
    customer_rfq_no: str | None = ""
    items: list[RfqItemIn] = []


@app.post("/api/admin/rfq", dependencies=[Depends(require_token)])
def create_rfq(body: RfqCreate):
    """Customer RFQ 신규 등록. 내부 관리번호(KMS-RFQ-yymm-NNN)는 자동 채번."""
    s = get_session()
    try:
        cust = s.query(Customer).filter_by(id=body.customer_id).first()
        if not cust:
            raise HTTPException(status_code=400, detail="Customer를 선택하세요.")
        items = [{
            "part_no": (it.part_no or "").strip(),
            "description": (it.description or "").strip(),
            "qty": it.qty or 1,
        } for it in body.items if (it.part_no or it.description)]

        rfq_no = _next_rfq_no(s)
        rfq = RFQ(
            rfq_no=rfq_no,
            customer_rfq_no=(body.customer_rfq_no or "").strip() or None,
            customer_id=cust.id,
            vessel_id=body.vessel_id,
            date=date.today().strftime("%Y-%m-%d"),
            status=RFQStatus.RECEIVED,
            items=items,
        )
        s.add(rfq)
        s.commit()
        return {"ok": True, "id": rfq.id, "rfq_no": rfq_no}
    finally:
        s.close()


def _next_quotation_no(session, company_prefix: str = "KMS") -> str:
    """helpers.next_quotation_no 와 동일: KMS-QUO-yymm-NNN (월 단위 시퀀스)."""
    today = date.today()
    period = today.year * 100 + today.month
    seq = session.query(DocSequence).filter_by(
        doc_type="quotation_internal", year=period).first()
    if not seq:
        seq = DocSequence(doc_type="quotation_internal", year=period, last_seq=0)
        session.add(seq)
    while True:
        seq.last_seq += 1
        no = f"{company_prefix}-QUO-{today:%y%m}-{seq.last_seq:03d}"
        if not session.query(Quotation).filter_by(qtn_no=no).first():
            session.flush()
            return no


class CustomerQuoteCreate(BaseModel):
    currency: str = "USD"
    amount: float


@app.post("/api/admin/rfq/{rfq_id}/customer-quote",
          dependencies=[Depends(require_token)])
def create_customer_quote(rfq_id: int, body: CustomerQuoteCreate):
    """Customer Quote 발신. 견적 총액을 단일 품목에 기록하고 상태는 발송완료."""
    s = get_session()
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            raise HTTPException(status_code=404, detail="RFQ를 찾을 수 없습니다.")

        qtn_no = _next_quotation_no(s)
        qtn = Quotation(
            qtn_no=qtn_no,
            rfq_id=rfq.id,
            customer_id=rfq.customer_id,
            currency=(body.currency or "USD"),
            status=QuotationStatus.SENT,
            items=[{"amount": body.amount}],
            date=date.today().strftime("%Y-%m-%d"),
        )
        s.add(qtn)
        s.commit()
        return {"ok": True, "qtn_no": qtn_no}
    finally:
        s.close()
