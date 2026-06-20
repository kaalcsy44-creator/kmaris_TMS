"""테스트용 샘플 오더 1건 생성 — Order 트랙(4~7단계) 상태 전이 테스트용.

사용법:
    python seed_sample_order.py

생성 내용:
  - Customer: 기존 첫 고객(없으면 'ABC Ship Management Pte. Ltd.' 생성)
  - Vessel  : 해당 고객의 'SAMPLE VESSEL'(없으면 생성)
  - Order   : 상태 '오더 수주'(= Order Confirmed). 품목 2건 포함.

재실행 시 po_no='SAMPLE-PO-001' 오더가 이미 있으면 건너뜁니다(중복 방지).
생성 후 'P/O → Customer P/O 목록 → 오더 상세 → 상태 변경'으로 5~7단계를 테스트하세요.
"""
from __future__ import annotations
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from db.engine import get_session
from db.models import Customer, Vessel, Order, OrderStatus
from app.utils.helpers import next_doc_no, tracking_url

SAMPLE_PO_NO = "SAMPLE-PO-001"


def _get_or_create_customer(session) -> Customer:
    cust = session.query(Customer).first()
    if cust:
        return cust
    cust = Customer(
        name="ABC Ship Management Pte. Ltd.",
        address="10 Anson Road, Singapore",
        contact="Mr. John Lee",
        email="purchase@example.com",
        tax_id="SG-000000",
        country="Singapore",
    )
    session.add(cust)
    session.commit()
    return cust


def _get_or_create_vessel(session, customer_id: int) -> Vessel:
    vsl = (
        session.query(Vessel)
        .filter_by(customer_id=customer_id, name="SAMPLE VESSEL")
        .first()
    )
    if vsl:
        return vsl
    vsl = Vessel(
        name="SAMPLE VESSEL",
        imo="9999999",
        engine_type="MAN B&W 6S60MC-C",
        hull_no="HULL-0001",
        customer_id=customer_id,
    )
    session.add(vsl)
    session.commit()
    return vsl


def seed_sample_order() -> None:
    session = get_session()
    try:
        existing = session.query(Order).filter_by(po_no=SAMPLE_PO_NO).first()
        if existing:
            print(f"[SKIP] 샘플 오더가 이미 있습니다: {existing.ord_no} (po_no={SAMPLE_PO_NO})")
            print(f"       트래킹: {tracking_url('order', existing.tracking_token)}")
            return

        cust = _get_or_create_customer(session)
        vsl = _get_or_create_vessel(session, cust.id)

        ord_no = next_doc_no("order")
        order = Order(
            ord_no=ord_no,
            customer_id=cust.id,
            vessel_id=vsl.id,
            po_no=SAMPLE_PO_NO,
            date=date.today().isoformat(),
            promised_delivery=(date.today() + timedelta(days=21)).isoformat(),
            status=OrderStatus.RECEIVED,  # = Order Confirmed (4단계)
            items=[
                {
                    "item_no": 1, "part_no": "MAN-6S60-001",
                    "description": "Cylinder Cover Assy", "maker": "MAN Energy Solutions",
                    "qty": 2, "unit": "PCS", "unit_price": 12500.0,
                },
                {
                    "item_no": 2, "part_no": "MAN-6S60-002",
                    "description": "Exhaust Valve Spindle", "maker": "MAN Energy Solutions",
                    "qty": 4, "unit": "PCS", "unit_price": 3800.0,
                },
            ],
        )
        session.add(order)
        session.commit()

        print(f"[OK] 샘플 오더 생성 완료: {ord_no}")
        print(f"     Customer : {cust.name}")
        print(f"     Vessel   : {vsl.name}")
        print(f"     상태     : {order.status.value}  (= Order Confirmed)")
        print(f"     트래킹   : {tracking_url('order', order.tracking_token)}")
        print()
        print("다음 단계: 'P/O → Customer P/O 목록 → 오더 선택 → 상태 변경'으로")
        print("  제조/준비중 → 출고완료 → 운송중 → 목적지 하차 완료 순서로 테스트하세요.")
        print("  (또는 'P/O → Vendor P/O 생성'으로 '발주 완료' 전이 테스트)")
    finally:
        session.close()


if __name__ == "__main__":
    print("샘플 오더를 생성합니다...")
    seed_sample_order()
    print("Done.")
