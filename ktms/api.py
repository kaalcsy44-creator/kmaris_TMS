"""
KTMS Public Tracking API
Exposes read-only RFQ/Order status for the k-maris.com website.

Run (dev):    uvicorn api:app --reload --port 8000
Run (prod):   uvicorn api:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from db.engine import get_session
from db.models import RFQ, Order, Customer, Vessel, RFQStatus, OrderStatus

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="KTMS Tracking API", docs_url=None, redoc_url=None)

# ── CORS ──────────────────────────────────────────────────────────────────────
_ALLOW_ORIGINS = [
    "https://www.k-maris.com",
    "https://k-maris.com",
    "http://localhost:8743",
    "http://localhost:3000",
    "http://127.0.0.1:8743",
]
# Allow any Vercel preview URL (e.g. k-maris-website-*.vercel.app)
_ALLOW_ORIGIN_REGEX = r"https://.*\.vercel\.app"

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOW_ORIGINS,
    allow_origin_regex=_ALLOW_ORIGIN_REGEX,
    allow_methods=["GET"],
    allow_headers=["*"],
)

# ── Status maps ───────────────────────────────────────────────────────────────
RFQ_STEPS = [
    "RFQ Received",
    "Sourcing & Quoting",
    "Quotation Sent",
    "Order Confirmed",
    "Completed",
]
ORD_STEPS = [
    "Order Confirmed",
    "Procurement",
    "Shipped",
    "In Transit",
    "Delivered",
]

_RFQ_MAP = {
    RFQStatus.RECEIVED: (0, "received"),
    RFQStatus.SOURCING: (1, "quoting"),
    RFQStatus.QUOTING:  (1, "quoting"),
    RFQStatus.SENT:     (2, "quoted"),
    RFQStatus.ORDERED:  (3, "confirmed"),
    RFQStatus.LOST:     (None, "lost"),
}
_ORD_MAP = {
    OrderStatus.RECEIVED:    (0, "confirmed"),
    OrderStatus.PO_SENT:     (1, "procurement"),
    OrderStatus.PREPARING:   (1, "procurement"),
    OrderStatus.SHIPPED:     (2, "shipped"),
    OrderStatus.IN_TRANSIT:  (3, "transit"),
    OrderStatus.DELIVERED:   (4, "delivered"),
}

NOT_FOUND = {"found": False}


# ── Serializers ───────────────────────────────────────────────────────────────

def _lookup(session, Model, **kwargs):
    return session.query(Model).filter_by(**kwargs).first()


def _rfq_payload(rfq: RFQ) -> dict:
    s = get_session()
    try:
        cust   = _lookup(s, Customer, id=rfq.customer_id)
        vessel = _lookup(s, Vessel,   id=rfq.vessel_id) if rfq.vessel_id else None
    finally:
        s.close()

    step, key = _RFQ_MAP.get(rfq.status, (0, "received"))
    items = rfq.items or []
    n = len(items)

    # Customer-safe item summary (no pricing/vendor info)
    def _desc(it):
        return it.get("description") or it.get("part_no") or "—"

    if n == 0:
        summary = "—"
    elif n == 1:
        summary = _desc(items[0])
    else:
        summary = f"{_desc(items[0])} (+{n - 1} more items)"

    return {
        "found":        True,
        "type":         "rfq",
        "number":       rfq.rfq_no,
        "company":      cust.name   if cust   else "—",
        "vessel":       vessel.name if vessel else "—",
        "item_summary": summary,
        "item_count":   n,
        "date":         rfq.date or "—",
        "status_raw":   rfq.status.value,
        "status_key":   key,
        "status_step":  step,
        "steps":        RFQ_STEPS,
        "note":         rfq.notes or "",
    }


def _order_payload(order: Order) -> dict:
    s = get_session()
    try:
        cust   = _lookup(s, Customer, id=order.customer_id)
        vessel = _lookup(s, Vessel,   id=order.vessel_id) if order.vessel_id else None
    finally:
        s.close()

    step, key = _ORD_MAP.get(order.status, (0, "confirmed"))
    items = order.items or []
    n = len(items)

    def _desc(it):
        return it.get("description") or it.get("part_no") or "—"

    if n == 0:
        summary = "—"
    elif n == 1:
        summary = _desc(items[0])
    else:
        summary = f"{_desc(items[0])} (+{n - 1} more items)"

    return {
        "found":        True,
        "type":         "order",
        "number":       order.ord_no,
        "company":      cust.name   if cust   else "—",
        "vessel":       vessel.name if vessel else "—",
        "item_summary": summary,
        "item_count":   n,
        "date":         order.date or "—",
        "po_no":        order.po_no or "",
        "status_raw":   order.status.value,
        "status_key":   key,
        "status_step":  step,
        "steps":        ORD_STEPS,
        "note":         "",
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/api/track")
def track(
    type:  str = Query(..., pattern="^(rfq|order)$"),
    token: str | None = Query(None),
    no:    str | None = Query(None),
):
    """
    Query by tracking token (from email link) or doc number (from search box).

    ?type=rfq&token={tracking_token}
    ?type=rfq&no={rfq_no}            e.g. KMS-CRFQ-2026-0001
    ?type=order&token={tracking_token}
    ?type=order&no={ord_no}          e.g. KMS-ORD-2026-0001
    """
    if not token and not no:
        return NOT_FOUND

    s = get_session()
    try:
        if type == "rfq":
            rfq = (
                _lookup(s, RFQ, tracking_token=token) if token
                else _lookup(s, RFQ, rfq_no=no.upper())
            )
            return _rfq_payload(rfq) if rfq else NOT_FOUND

        else:  # order
            order = (
                _lookup(s, Order, tracking_token=token) if token
                else _lookup(s, Order, ord_no=no.upper())
            )
            return _order_payload(order) if order else NOT_FOUND
    finally:
        s.close()


@app.get("/health")
def health():
    return {"status": "ok"}
