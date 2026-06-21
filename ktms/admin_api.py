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
from fastapi import Depends, FastAPI, File, Header, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from db.engine import get_session
from services.tracking_status import (
    rfq_tracking_step, order_tracking_step, RFQ_STEPS, ORDER_STEPS,
)
from services.email_svc import send_email
from services.pdf_svc import build_po_payload, generate_po_pdf
from services.pdf_parser import (
    extract_text_from_pdf, parse_order_fields, parse_rfq_fields,
)
from db.models import (
    RFQ, Customer, Vessel, Vendor, User, DocSequence,
    VendorRFQ, VendorQuote, Quotation, QuotationStatus, FollowUpLevel,
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


def _vendor_po_email_body(po, vendor, order, vessel, notes: str, lang: str) -> str:
    vendor_name = vendor.name if vendor else "Vendor"
    vessel_str = vessel.name if vessel else "—"
    if lang == "ko":
        body = f"""{vendor_name} 귀중

안녕하세요,
항상 협조해 주셔서 감사드립니다.

아래 선박용 부품에 대한 발주서를 첨부와 같이 송부드립니다.

발주번호 : {po.po_no}
오더참조 : {order.ord_no if order else '—'}
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
        body += """영업일 기준 3일 이내 수령 확인 및 회신 부탁드립니다.

감사합니다.
K-MARIS Energy & Solutions Co., Ltd.
Email: sales@k-maris.com  |  www.k-maris.com
Engineering Reliability. Supplying Performance.
"""
        return body

    body = f"""Dear {vendor_name},

Please find attached our official Purchase Order for the following marine spare parts.

PO No.        : {po.po_no}
Order Ref.    : {order.ord_no if order else '—'}
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
    body += """Kindly acknowledge receipt and confirm within 3 business days.

Best regards,
K-MARIS Energy & Solutions Co., Ltd.
Email: sales@k-maris.com  |  www.k-maris.com
Engineering Reliability. Supplying Performance.
"""
    return body


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
        vessel_names = {v.id: v.name for v in s.query(Vessel).all()}
        rfqs = s.query(RFQ).all()
        orders = s.query(Order).all()
        quotes = s.query(Quotation).all()
        ars = s.query(ARRecord).all()

        today_iso = date.today().isoformat()
        soon_iso = (date.today() + timedelta(days=7)).isoformat()
        urgent_cutoff = (date.today() + timedelta(days=3)).isoformat()

        # ── 운영 KPI ──────────────────────────────────────────────────────────
        open_rfq = sum(1 for r in rfqs if r.status in
                       {RFQStatus.RECEIVED, RFQStatus.SOURCING, RFQStatus.QUOTING})
        active_orders = sum(1 for o in orders if o.status in
                            {OrderStatus.RECEIVED, OrderStatus.PO_SENT, OrderStatus.PREPARING,
                             OrderStatus.SHIPPED, OrderStatus.IN_TRANSIT})

        now = datetime.now(timezone.utc)
        monthly_quotes = sum(
            1 for q in quotes
            if q.created_at and q.created_at.year == now.year
            and q.created_at.month == now.month
        )
        ar_outstanding = sum(
            (a.invoice_amount or 0) - (a.paid_amount or 0)
            for a in ars
            if a.status in {ARStatus.OUTSTANDING, ARStatus.PARTIAL, ARStatus.OVERDUE}
            and (a.currency or "USD") == "USD"
        )

        urgent = [q for q in quotes
                  if q.status == QuotationStatus.SENT
                  and q.follow_up_level == FollowUpLevel.A
                  and q.valid_until and q.valid_until <= urgent_cutoff]
        overdue = [a for a in ars if a.status == ARStatus.OVERDUE]
        pending_po = sum(1 for o in orders if o.status == OrderStatus.RECEIVED)
        expiring = sum(
            1 for q in quotes
            if q.status in (QuotationStatus.SENT, QuotationStatus.NEGOTIATING)
            and q.valid_until and today_iso <= q.valid_until <= soon_iso
        )

        # ── 영업 성과 KPI ─────────────────────────────────────────────────────
        total_rfq = len(rfqs)
        sent_quote_rfq_ids = {q.rfq_id for q in quotes
                              if q.rfq_id and q.status != QuotationStatus.DRAFT}
        handling_rate = (len(sent_quote_rfq_ids) / total_rfq * 100) if total_rfq else 0.0

        rfq_created = {r.id: r.created_at for r in rfqs}
        _tat = []
        for q in quotes:
            base = rfq_created.get(q.rfq_id) if q.rfq_id else None
            if base and q.created_at and q.status != QuotationStatus.DRAFT:
                h = (q.created_at - base).total_seconds() / 3600
                if h >= 0:
                    _tat.append(h)
        quotation_tat_h = (sum(_tat) / len(_tat)) if _tat else None

        _sent_like = {QuotationStatus.SENT, QuotationStatus.NEGOTIATING,
                      QuotationStatus.WON, QuotationStatus.LOST, QuotationStatus.EXPIRED}
        sent_quotes = [q for q in quotes if q.status in _sent_like]
        won_quotes = [q for q in quotes if q.status == QuotationStatus.WON]
        hit_rate = (len(won_quotes) / len(sent_quotes) * 100) if sent_quotes else 0.0

        margin_basis = won_quotes or sent_quotes
        _rev = _cost = 0.0
        for q in margin_basis:
            for it in (q.items or []):
                qty = float(it.get("qty", 1) or 1)
                _rev += float(it.get("unit_price", 0) or 0) * qty
                _cost += float(it.get("cost_price", 0) or 0) * qty
        gross_margin_pct = ((_rev - _cost) / _rev * 100) if _rev else 0.0

        negotiating_value_usd = 0.0
        for q in quotes:
            if q.status == QuotationStatus.NEGOTIATING and (q.currency or "USD") == "USD":
                for it in (q.items or []):
                    amt = it.get("amount")
                    if amt in (None, ""):
                        amt = float(it.get("unit_price", 0) or 0) * float(it.get("qty", 1) or 1)
                    negotiating_value_usd += float(amt or 0)

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

        # ── Snapshot: 고객 추적(RFQ/Order) + 내부 12단계 (per-RFQ) ───────────────
        def _cv(cid, vid) -> str:
            nm = cust_names.get(cid, "—")
            vn = vessel_names.get(vid) if vid else None
            return f"{nm} · {vn}" if vn else nm

        snapshot = []
        for r in sorted(rfqs, key=lambda x: x.id, reverse=True)[:20]:
            o = _order_for_rfq(s, r.id)
            order_row = None
            if o:
                order_row = {
                    "ord_no": o.ord_no,
                    "customer_vessel": _cv(o.customer_id, o.vessel_id),
                    "status": _enum_val(o.status),
                    "item_count": len(o.items or []),
                    "date": o.date or "—",
                    "step": order_tracking_step(_enum_val(o.status))[0],
                }
            _lvl = getattr(r, "follow_up_level", None)
            snapshot.append({
                "rfq_no": r.rfq_no,
                "customer_rfq_no": r.customer_rfq_no or "",
                "customer_vessel": _cv(r.customer_id, r.vessel_id),
                "status": _enum_val(r.status),
                "item_count": len(r.items or []),
                "follow_up_level": _enum_val(_lvl) if _lvl else "—",
                "date": r.date or "—",
                "step": rfq_tracking_step(_enum_val(r.status))[0],
                "stage": _pipeline_stage(s, r.id),
                "order": order_row,
            })

        return {
            "kpi": {
                "open_rfq": open_rfq,
                "total_rfq": len(rfqs),
                "active_orders": active_orders,
                "monthly_quotes": monthly_quotes,
                "ar_outstanding_usd": round(ar_outstanding, 2),
            },
            "ops": {
                "urgent": len(urgent),
                "pending_po": pending_po,
                "overdue": len(overdue),
                "expiring": expiring,
            },
            "perf": {
                "handling_rate": round(handling_rate, 0),
                "quotation_tat_h": round(quotation_tat_h, 0) if quotation_tat_h is not None else None,
                "hit_rate": round(hit_rate, 0),
                "gross_margin_pct": round(gross_margin_pct, 1),
                "negotiating_value_usd": round(negotiating_value_usd, 0),
            },
            "alerts": {
                "urgent_quotes": [
                    {"qtn_no": q.qtn_no, "valid_until": q.valid_until or "",
                     "status": _enum_val(q.status)} for q in urgent
                ],
                "overdue_ar": [
                    {"ci_no": a.ci_no or "", "currency": a.currency or "USD",
                     "outstanding": round((a.invoice_amount or 0) - (a.paid_amount or 0), 2),
                     "due_date": a.due_date or ""} for a in overdue
                ],
            },
            "steps": INTERNAL_STEPS,
            "stage_distribution": dist,
            "recent": recent,
            "snapshot": snapshot,
            "rfq_steps": RFQ_STEPS,
            "order_steps": ORDER_STEPS,
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


def _rfq_for_order(s, order: Order):
    """Order에 연결된 RFQ — 직접 연결 우선, 없으면 Quotation 경유."""
    if order.rfq_id:
        return s.query(RFQ).filter_by(id=order.rfq_id).first()
    if order.quotation_id:
        qtn = s.query(Quotation).filter_by(id=order.quotation_id).first()
        if qtn and qtn.rfq_id:
            return s.query(RFQ).filter_by(id=qtn.rfq_id).first()
    return None


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


@app.get("/api/admin/order/{order_id}", dependencies=[Depends(require_token)])
def order_detail(order_id: int):
    """Order 1건 상세 — 고객 P/O, Vendor P/O, 품목, 연결 문서."""
    s = get_session()
    try:
        o = s.query(Order).filter_by(id=order_id).first()
        if not o:
            raise HTTPException(status_code=404, detail="Order not found")

        cust = s.query(Customer).filter_by(id=o.customer_id).first()
        vessel = s.query(Vessel).filter_by(id=o.vessel_id).first() if o.vessel_id else None
        rfq = _rfq_for_order(s, o)
        qtn = s.query(Quotation).filter_by(id=o.quotation_id).first() if o.quotation_id else None
        stage = _pipeline_stage(s, rfq.id) if rfq else 5

        steps = [{
            "no": i,
            "name": name,
            "state": ("done" if i < stage else "current" if i == stage else "todo"),
        } for i, name in enumerate(INTERNAL_STEPS, start=1)]

        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}
        vendor_emails = {v.id: v.email for v in s.query(Vendor).all()}
        vpos = (s.query(PurchaseOrder).filter_by(order_id=o.id)
                .order_by(PurchaseOrder.id.desc()).all())
        vendor_po_view = [{
            "id": po.id,
            "po_no": po.po_no or "",
            "vendor": vendor_names.get(po.vendor_id, "—"),
            "vendor_email": po.sent_to_email or vendor_emails.get(po.vendor_id, "") or "",
            "date": po.date or "",
            "sent_date": po.sent_date or "",
            "status": po.status or "",
            "item_count": len(po.items or []),
        } for po in vpos]

        ci = s.query(CommercialInvoice).filter_by(order_id=o.id).order_by(CommercialInvoice.id.desc()).first()
        sa = s.query(ShippingAdvice).filter_by(order_id=o.id).order_by(ShippingAdvice.id.desc()).first()
        pl = (s.query(PackingList).filter_by(ci_id=ci.id).order_by(PackingList.id.desc()).first()
              if ci else None)
        tax = (s.query(TaxInvoiceData).filter_by(ci_id=ci.id).order_by(TaxInvoiceData.id.desc()).first()
               if ci else None)
        ars = s.query(ARRecord).filter_by(order_id=o.id).order_by(ARRecord.id.desc()).all()

        return {
            "id": o.id,
            "ord_no": o.ord_no,
            "customer_po_no": o.po_no or "",
            "customer_po_at": o.date or "",
            "rfq_no": rfq.rfq_no if rfq else "",
            "customer_rfq_no": (rfq.customer_rfq_no or rfq.rfq_no) if rfq else "",
            "quotation_no": qtn.qtn_no if qtn else "",
            "customer": cust.name if cust else "—",
            "customer_contact": (cust.contact if cust else "") or "",
            "customer_email": (cust.email if cust else "") or "",
            "vessel": vessel.name if vessel else "",
            "status": _status_label(stage) if rfq else _enum_val(o.status),
            "order_status": _enum_val(o.status),
            "stage": stage,
            "promised_delivery": o.promised_delivery or "",
            "shipped_date": o.shipped_date or "",
            "delivered_date": o.delivered_date or "",
            "tracking_token": o.tracking_token or "",
            "steps": steps,
            "items": [_item_view(it) for it in (o.items or [])],
            "vendor_pos": vendor_po_view,
            "documents": {
                "ci_no": ci.ci_no if ci else "",
                "pl_no": pl.pl_no if pl else "",
                "sa_no": sa.sa_no if sa else "",
                "tax_no": tax.tax_no if tax else "",
                "ar": [{
                    "ci_no": ar.ci_no or "",
                    "currency": ar.currency or "USD",
                    "invoice_amount": round(ar.invoice_amount or 0, 2),
                    "paid_amount": round(ar.paid_amount or 0, 2),
                    "due_date": ar.due_date or "",
                    "status": _enum_val(ar.status),
                } for ar in ars],
            },
        }
    finally:
        s.close()


@app.get("/api/admin/po-work-options", dependencies=[Depends(require_token)])
def po_work_options():
    """P/O 작업 탭용 옵션 — Streamlit Customer P/O / Vendor P/O 탭 데이터."""
    s = get_session()
    try:
        customers = [{"id": c.id, "name": c.name} for c in s.query(Customer).order_by(Customer.name).all()]
        vessels = [{
            "id": v.id,
            "name": v.name,
            "customer_id": v.customer_id,
        } for v in s.query(Vessel).order_by(Vessel.name).all()]
        vendors = [{
            "id": v.id,
            "name": v.name,
            "email": v.email or "",
        } for v in s.query(Vendor).order_by(Vendor.name).all()]

        cust_names = {c["id"]: c["name"] for c in customers}
        vessel_names = {v["id"]: v["name"] for v in vessels}

        rfqs = []
        for r in s.query(RFQ).order_by(RFQ.id.desc()).all():
            stage = _pipeline_stage(s, r.id)
            rfqs.append({
                "id": r.id,
                "rfq_no": r.rfq_no,
                "customer_rfq_no": r.customer_rfq_no or "",
                "customer_id": r.customer_id,
                "customer": cust_names.get(r.customer_id, "—"),
                "vessel_id": r.vessel_id,
                "vessel": vessel_names.get(r.vessel_id, "") if r.vessel_id else "",
                "status": _status_label(stage),
                "items": [_item_view(it) for it in (r.items or [])],
            })

        quotations = []
        for q in s.query(Quotation).order_by(Quotation.id.desc()).all():
            quotations.append({
                "id": q.id,
                "qtn_no": q.qtn_no,
                "rfq_id": q.rfq_id,
                "customer_id": q.customer_id,
                "customer": cust_names.get(q.customer_id, "—"),
                "vessel_id": q.vessel_id,
                "vessel": vessel_names.get(q.vessel_id, "") if q.vessel_id else "",
                "status": _enum_val(q.status),
                "currency": q.currency or "USD",
                "amount": round(_total_amount(q.items or []), 2),
                "items": [_item_view(it) for it in (q.items or [])],
            })

        orders = []
        for o in s.query(Order).order_by(Order.id.desc()).all():
            rfq = _rfq_for_order(s, o)
            stage = _pipeline_stage(s, rfq.id) if rfq else 5
            orders.append({
                "id": o.id,
                "ord_no": o.ord_no,
                "customer_id": o.customer_id,
                "customer": cust_names.get(o.customer_id, "—"),
                "vessel_id": o.vessel_id,
                "vessel": vessel_names.get(o.vessel_id, "") if o.vessel_id else "",
                "po_no": o.po_no or "",
                "date": o.date or "",
                "status": _status_label(stage) if rfq else _enum_val(o.status),
                "items": [_item_view(it) for it in (o.items or [])],
            })

        purchase_orders = []
        for po in s.query(PurchaseOrder).order_by(PurchaseOrder.id.desc()).all():
            o = s.query(Order).filter_by(id=po.order_id).first()
            vendor = s.query(Vendor).filter_by(id=po.vendor_id).first()
            purchase_orders.append({
                "id": po.id,
                "po_no": po.po_no or "",
                "order_id": po.order_id,
                "ord_no": o.ord_no if o else "",
                "vendor_id": po.vendor_id,
                "vendor": vendor.name if vendor else "—",
                "vendor_email": po.sent_to_email or (vendor.email if vendor else "") or "",
                "date": po.date or "",
                "sent_date": po.sent_date or "",
                "status": po.status or "",
                "sent": po.status == "이메일 발송완료",
                "items": [_item_view(it) for it in (po.items or [])],
            })

        return {
            "customers": customers,
            "vessels": vessels,
            "vendors": vendors,
            "rfqs": rfqs,
            "quotations": quotations,
            "orders": orders,
            "purchase_orders": purchase_orders,
            "smtp_configured": bool(os.getenv("SMTP_USER") and os.getenv("SMTP_PASSWORD")),
        }
    finally:
        s.close()


@app.post("/api/admin/ocr/rfq", dependencies=[Depends(require_token)])
def ocr_rfq_pdf(file: UploadFile = File(...)):
    """Customer RFQ PDF OCR — Streamlit 'PDF로 자동 입력'과 동일 파서."""
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="PDF 파일만 업로드할 수 있습니다.")
    s = get_session()
    try:
        customer_names = [c.name for c in s.query(Customer).order_by(Customer.name).all()]
    finally:
        s.close()
    try:
        file.file.seek(0)
        raw_text = extract_text_from_pdf(file.file)
        if not raw_text:
            raise HTTPException(status_code=400, detail="PDF에서 텍스트를 추출할 수 없습니다.")
        return parse_rfq_fields(raw_text, customer_names)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"OCR 추출 실패: {exc}") from exc


@app.post("/api/admin/ocr/order", dependencies=[Depends(require_token)])
def ocr_order_pdf(file: UploadFile = File(...)):
    """Customer P/O PDF OCR — Streamlit '오더 PDF 자동 입력'과 동일 파서."""
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="PDF 파일만 업로드할 수 있습니다.")
    s = get_session()
    try:
        customer_names = [c.name for c in s.query(Customer).order_by(Customer.name).all()]
    finally:
        s.close()
    try:
        file.file.seek(0)
        raw_text = extract_text_from_pdf(file.file)
        if not raw_text:
            raise HTTPException(status_code=400, detail="PDF에서 텍스트를 추출할 수 없습니다.")
        return parse_order_fields(raw_text, customer_names)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"OCR 추출 실패: {exc}") from exc


def _next_order_no(session, company_prefix: str = "KMS") -> str:
    today = date.today()
    period = today.year * 100 + today.month
    seq = session.query(DocSequence).filter_by(doc_type="order_internal", year=period).first()
    if not seq:
        seq = DocSequence(doc_type="order_internal", year=period, last_seq=0)
        session.add(seq)
    while True:
        seq.last_seq += 1
        no = f"{company_prefix}-ORD-{today:%y%m}-{seq.last_seq:03d}"
        if not session.query(Order).filter_by(ord_no=no).first():
            session.flush()
            return no


def _next_po_no(session, company_prefix: str = "KMS") -> str:
    today = date.today()
    period = today.year * 100 + today.month
    seq = session.query(DocSequence).filter_by(doc_type="po_internal", year=period).first()
    if not seq:
        seq = DocSequence(doc_type="po_internal", year=period, last_seq=0)
        session.add(seq)
    while True:
        seq.last_seq += 1
        no = f"{company_prefix}-PO-{today:%y%m}-{seq.last_seq:03d}"
        if not session.query(PurchaseOrder).filter_by(po_no=no).first():
            session.flush()
            return no


class PoWorkItem(BaseModel):
    part_no: str = ""
    description: str = ""
    maker: str = ""
    qty: float = 1
    unit: str = "PCS"
    unit_price: float | None = 0
    amount: float | None = None


class OrderCreate(BaseModel):
    customer_id: int
    vessel_id: int | None = None
    quotation_id: int | None = None
    rfq_id: int | None = None
    po_no: str = ""
    date: str | None = None
    promised_delivery: str | None = None
    items: list[PoWorkItem] = []


@app.post("/api/admin/orders", dependencies=[Depends(require_token)])
def create_order(body: OrderCreate):
    """Customer P/O 수신 탭 — 신규 오더 등록."""
    s = get_session()
    try:
        cust = s.query(Customer).filter_by(id=body.customer_id).first()
        if not cust:
            raise HTTPException(status_code=400, detail="Customer를 선택하세요.")
        qtn = s.query(Quotation).filter_by(id=body.quotation_id).first() if body.quotation_id else None
        rfq_id = body.rfq_id or (qtn.rfq_id if qtn else None)
        items = []
        for it in body.items:
            if not (it.part_no or it.description):
                continue
            qty = it.qty or 1
            unit_price = it.unit_price or 0
            items.append({
                "part_no": it.part_no.strip(),
                "description": it.description.strip(),
                "maker": it.maker.strip(),
                "qty": qty,
                "unit": it.unit or "PCS",
                "unit_price": unit_price,
                "amount": it.amount if it.amount is not None else qty * unit_price,
            })

        ord_no = _next_order_no(s)
        order = Order(
            ord_no=ord_no,
            quotation_id=qtn.id if qtn else None,
            rfq_id=rfq_id,
            customer_id=cust.id,
            vessel_id=body.vessel_id,
            po_no=(body.po_no or "").strip(),
            date=body.date or date.today().isoformat(),
            promised_delivery=body.promised_delivery or None,
            status=OrderStatus.RECEIVED,
            items=items,
        )
        s.add(order)
        if qtn:
            qtn.status = QuotationStatus.WON
        s.commit()
        return {"ok": True, "id": order.id, "ord_no": order.ord_no}
    finally:
        s.close()


class PurchaseOrderCreate(BaseModel):
    order_id: int
    vendor_id: int
    date: str | None = None
    items: list[PoWorkItem] = []


@app.post("/api/admin/vendor-pos", dependencies=[Depends(require_token)])
def create_purchase_order(body: PurchaseOrderCreate):
    """Vendor P/O 발신 탭 — 발주서 생성."""
    s = get_session()
    try:
        order = s.query(Order).filter_by(id=body.order_id).first()
        if not order:
            raise HTTPException(status_code=404, detail="오더를 찾을 수 없습니다.")
        vendor = s.query(Vendor).filter_by(id=body.vendor_id).first()
        if not vendor:
            raise HTTPException(status_code=400, detail="Vendor를 선택하세요.")

        items = []
        for it in body.items:
            if not (it.part_no or it.description):
                continue
            qty = it.qty or 1
            unit_price = it.unit_price or 0
            items.append({
                "part_no": it.part_no.strip(),
                "description": it.description.strip(),
                "maker": it.maker.strip(),
                "qty": qty,
                "unit": it.unit or "PCS",
                "unit_price": unit_price,
                "amount": it.amount if it.amount is not None else qty * unit_price,
            })

        po_no = _next_po_no(s)
        po = PurchaseOrder(
            po_no=po_no,
            order_id=order.id,
            vendor_id=vendor.id,
            date=body.date or date.today().isoformat(),
            items=items,
            status="발주완료",
        )
        s.add(po)
        order.status = OrderStatus.PO_SENT
        s.commit()
        return {"ok": True, "id": po.id, "po_no": po.po_no}
    finally:
        s.close()


class VendorPoPreview(BaseModel):
    lang: str = "en"
    notes: str = ""


@app.post("/api/admin/vendor-pos/{po_id}/preview", dependencies=[Depends(require_token)])
def vendor_po_preview(po_id: int, body: VendorPoPreview):
    s = get_session()
    try:
        po = s.query(PurchaseOrder).filter_by(id=po_id).first()
        if not po:
            raise HTTPException(status_code=404, detail="발주서를 찾을 수 없습니다.")
        vendor = s.query(Vendor).filter_by(id=po.vendor_id).first()
        order = s.query(Order).filter_by(id=po.order_id).first()
        vessel = s.query(Vessel).filter_by(id=order.vessel_id).first() if order and order.vessel_id else None
        lang = "ko" if body.lang == "ko" else "en"
        subject = (
            f"[K-MARIS] 발주서 송부 — {po.po_no} / {vessel.name if vessel else po.po_no}"
            if lang == "ko"
            else f"[K-MARIS] Purchase Order — {po.po_no} / {vessel.name if vessel else po.po_no}"
        )
        return {
            "to": (vendor.email if vendor else "") or "",
            "subject": subject,
            "body": _vendor_po_email_body(po, vendor, order, vessel, body.notes, lang),
            "pdf_filename": f"{po.po_no}_PurchaseOrder.pdf",
            "smtp_configured": bool(os.getenv("SMTP_USER") and os.getenv("SMTP_PASSWORD")),
        }
    finally:
        s.close()


@app.get("/api/admin/vendor-pos/{po_id}/pdf", dependencies=[Depends(require_token)])
def vendor_po_pdf(po_id: int):
    s = get_session()
    try:
        po = s.query(PurchaseOrder).filter_by(id=po_id).first()
        if not po:
            raise HTTPException(status_code=404, detail="발주서를 찾을 수 없습니다.")
        vendor = s.query(Vendor).filter_by(id=po.vendor_id).first()
        order = s.query(Order).filter_by(id=po.order_id).first()
        vessel = s.query(Vessel).filter_by(id=order.vessel_id).first() if order and order.vessel_id else None
        payload = build_po_payload(
            po_no=po.po_no,
            date=po.date or date.today().isoformat(),
            vendor=vendor,
            vessel=vessel,
            items=po.items or [],
        )
        pdf = generate_po_pdf(payload)
        return Response(
            content=pdf,
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{po.po_no}_PurchaseOrder.pdf"'},
        )
    finally:
        s.close()


class VendorPoSend(BaseModel):
    to: str
    subject: str
    body: str


@app.post("/api/admin/vendor-pos/{po_id}/send", dependencies=[Depends(require_token)])
def vendor_po_send(po_id: int, body: VendorPoSend):
    s = get_session()
    try:
        po = s.query(PurchaseOrder).filter_by(id=po_id).first()
        if not po:
            raise HTTPException(status_code=404, detail="발주서를 찾을 수 없습니다.")
        if not body.to.strip():
            raise HTTPException(status_code=400, detail="수신자 이메일을 입력하세요.")
        vendor = s.query(Vendor).filter_by(id=po.vendor_id).first()
        order = s.query(Order).filter_by(id=po.order_id).first()
        vessel = s.query(Vessel).filter_by(id=order.vessel_id).first() if order and order.vessel_id else None
        payload = build_po_payload(
            po_no=po.po_no,
            date=po.date or date.today().isoformat(),
            vendor=vendor,
            vessel=vessel,
            items=po.items or [],
        )
        pdf = generate_po_pdf(payload)
        sent = send_email(
            to=body.to.strip(),
            subject=body.subject,
            body=body.body,
            attachments=[(f"{po.po_no}_PurchaseOrder.pdf", pdf)],
        )
        if not sent:
            raise HTTPException(status_code=400, detail="이메일 발송 실패 — SMTP 설정 또는 서버 상태를 확인하세요.")
        po.status = "이메일 발송완료"
        po.sent_to_email = body.to.strip()
        po.sent_date = date.today().isoformat()
        s.commit()
        return {"ok": True, "sent_date": po.sent_date}
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
