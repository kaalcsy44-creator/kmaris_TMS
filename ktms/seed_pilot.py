"""
Seed the LOCAL sqlite DB with a few RFQs so the Next.js pilot has data to show.

Idempotent-ish: skips RFQs whose rfq_no already exists. Safe for local dev only
(does nothing meaningful against the production Postgres if you point at it, but
intended for the bundled sqlite at ktms/data/ktms.db).

Run:  python seed_pilot.py
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from db.engine import Base, get_engine, get_session
from db.models import (
    Customer, Vessel, Vendor, RFQ, RFQStatus,
    VendorRFQ, VendorQuote, Quotation, QuotationStatus,
    Order, OrderStatus, PurchaseOrder, ARRecord, ARStatus,
)

Base.metadata.create_all(get_engine())


def _get_or_create_customer(s, name: str) -> Customer:
    c = s.query(Customer).filter_by(name=name).first()
    if not c:
        c = Customer(name=name)
        s.add(c)
        s.flush()
    return c


def _get_or_create_vessel(s, name: str) -> Vessel:
    v = s.query(Vessel).filter_by(name=name).first()
    if not v:
        v = Vessel(name=name)
        s.add(v)
        s.flush()
    return v


# (customer, vessel, rfq_no, item_count, days_ago) — mirrors the screenshot
SAMPLES = [
    ("SOLUNA MARINETECH", None, "KMS-RFQ-2606-002", 0, 2),
    ("M.T.M SHIP MANAGEMENT PTE. LTD", "Strategic Alliance", "KMS-RFQ-2405-003", 1, 3),
    ("NYK Shipmanagement Pte. Ltd.", "IKIGAI(TECH)", "KMS-RFQ-2405-002", 3, 12),
    ("Anglo-Eastern Shipmanagement (Singapore) Pte. Ltd.", "HUMORIST 9922782",
     "KMS-RFQ-2405-001", 22, 13),
    ("ABC Ship Management Pte. Ltd.", None, "KMS-RFQ-2606-001", 0, 13),
]


def _items(n: int):
    return [{"part_no": f"P-{i:03d}", "description": f"Sample item {i}",
             "qty": 1, "cost_price": 1000, "amount": 1200} for i in range(n)]


def main() -> None:
    s = get_session()
    created = 0
    try:
        for cust_name, vessel_name, rfq_no, n_items, days_ago in SAMPLES:
            if s.query(RFQ).filter_by(rfq_no=rfq_no).first():
                continue
            cust = _get_or_create_customer(s, cust_name)
            vessel = _get_or_create_vessel(s, vessel_name) if vessel_name else None
            created_at = datetime.utcnow() - timedelta(days=days_ago)

            rfq = RFQ(
                rfq_no=rfq_no,
                customer_id=cust.id,
                vessel_id=vessel.id if vessel else None,
                date=created_at.strftime("%Y-%m-%d"),
                status=RFQStatus.RECEIVED,
                items=_items(n_items),
                created_at=created_at,
            )
            s.add(rfq)
            s.flush()

            # Anglo-Eastern row → exercise vendor RFQ / quote / customer quote columns
            if rfq_no == "KMS-RFQ-2405-001":
                vrfq = VendorRFQ(
                    vrfq_no="KMS-VRFQ-2026-0005", rfq_id=rfq.id,
                    items=_items(5), created_at=created_at + timedelta(days=4),
                )
                s.add(vrfq)
                s.flush()
                s.add(VendorQuote(
                    vendor_rfq_id=vrfq.id, vendor_quote_no="VQ-2026-0005",
                    items=[{"cost_price": 98000, "qty": 1, "amount": 98000}],
                    created_at=created_at + timedelta(days=4, hours=5),
                ))
                s.add(Quotation(
                    qtn_no="KMS-QUO-2606-001", rfq_id=rfq.id, customer_id=cust.id,
                    currency="USD", status=QuotationStatus.SENT,
                    items=[{"amount": 117600}],
                    created_at=created_at + timedelta(days=4, hours=8),
                ))
            created += 1

        # Order + Vendor PO — PO 화면 데모용 (없을 때 1건만)
        now = datetime.utcnow()
        order = s.query(Order).first()
        if order is None:
            anglo = s.query(RFQ).filter_by(rfq_no="KMS-RFQ-2405-001").first()
            vendor = s.query(Vendor).first()
            if anglo:
                order = Order(
                    ord_no="KMS-ORD-2606-001", rfq_id=anglo.id,
                    customer_id=anglo.customer_id, vessel_id=anglo.vessel_id,
                    po_no="PO-AE-77231", date=now.strftime("%Y-%m-%d"),
                    status=OrderStatus.PO_SENT, items=_items(22), created_at=now,
                )
                s.add(order)
                s.flush()
                if vendor:
                    s.add(PurchaseOrder(
                        po_no="KMS-PO-2606-001", order_id=order.id,
                        vendor_id=vendor.id, date=now.strftime("%Y-%m-%d"),
                        sent_date=now.strftime("%Y-%m-%d"),
                        sent_to_email=vendor.email or "", status="발주완료",
                        items=_items(22),
                    ))
                created += 1

        # AR — 미수금 화면 데모용 (없을 때 1건만, 과거 만기 → 연체)
        if order is not None and s.query(ARRecord).count() == 0:
            s.add(ARRecord(
                order_id=order.id, ci_no="KMS-CI-2606-001",
                invoice_amount=117600.0, paid_amount=40000.0,
                currency="USD", due_date="2026-05-31",
                status=ARStatus.PARTIAL,
            ))
            created += 1

        s.commit()
        print(f"Seeded {created} new record group(s). "
              f"RFQs: {s.query(RFQ).count()}, Orders: {s.query(Order).count()}, "
              f"AR: {s.query(ARRecord).count()}")
    finally:
        s.close()


if __name__ == "__main__":
    main()
