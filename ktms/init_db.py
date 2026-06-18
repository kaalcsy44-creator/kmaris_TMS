"""Create all tables and seed the default admin user."""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from datetime import datetime, date as _date

import bcrypt
from sqlalchemy import text, inspect
from db.engine import Base, get_engine, get_session
from db.models import User, UserRole, DocSequence, Customer, Vendor, RFQ


def create_tables():
    Base.metadata.create_all(bind=get_engine())
    print("[OK] Tables created.")


# New columns added after the initial release. Idempotent for existing DBs.
_MIGRATIONS = {
    "rfqs": {
        "customer_rfq_no": "VARCHAR(100)",
    },
    "orders": {
        "promised_delivery": "VARCHAR(10)",
        "shipped_date":      "VARCHAR(10)",
        "delivered_date":    "VARCHAR(10)",
        "rfq_id":            "INTEGER",
    },
    "vendor_rfqs": {
        "sent_to_email": "VARCHAR(200)",
    },
    "purchase_orders": {
        "sent_to_email": "VARCHAR(200)",
    },
}


def migrate_columns():
    """Add any missing columns to existing tables (SQLite/PostgreSQL safe)."""
    engine = get_engine()
    insp = inspect(engine)
    added = 0
    with engine.begin() as conn:
        for table, cols in _MIGRATIONS.items():
            if not insp.has_table(table):
                continue
            existing = {c["name"] for c in insp.get_columns(table)}
            for name, ddl in cols.items():
                if name not in existing:
                    conn.execute(text(f'ALTER TABLE {table} ADD COLUMN {name} {ddl}'))
                    added += 1
                    print(f"[OK] {table}.{name} added.")
    if added == 0:
        print("[SKIP] No column migrations needed.")


def migrate_rfq_numbers():
    """기존 KMS-CRFQ-YYYY-NNNN 형식의 RFQ 번호를 KMS-RFQ-yymm-NNN 형식으로 변환.

    이미 신규 형식(KMS-RFQ-)인 RFQ는 건너뛰므로 반복 실행해도 안전하다.
    기간(yymm)은 RFQ 수신일(date) 기준, 없으면 생성일(created_at)을 사용한다.
    """
    session = get_session()
    try:
        old = [
            r for r in session.query(RFQ).order_by(RFQ.id).all()
            if not (r.rfq_no or "").startswith("KMS-RFQ-")
        ]
        if not old:
            print("[SKIP] No RFQ numbers to migrate.")
            return

        # 기간별 마지막 시퀀스를 DocSequence에서 로드(신규 형식과 연속되도록).
        period_seq = {
            s.year: s
            for s in session.query(DocSequence).filter_by(doc_type="rfq_internal").all()
        }
        renamed = 0
        for r in old:
            period_date = None
            if r.date:
                try:
                    period_date = datetime.strptime(r.date, "%Y-%m-%d").date()
                except ValueError:
                    period_date = None
            if period_date is None:
                period_date = r.created_at.date() if r.created_at else _date.today()

            period = period_date.year * 100 + period_date.month
            seq = period_seq.get(period)
            if seq is None:
                seq = DocSequence(doc_type="rfq_internal", year=period, last_seq=0)
                session.add(seq)
                session.flush()
                period_seq[period] = seq
            seq.last_seq += 1
            r.rfq_no = f"KMS-RFQ-{period_date:%y%m}-{seq.last_seq:03d}"
            renamed += 1
        session.commit()
        print(f"[OK] {renamed} RFQ number(s) migrated to KMS-RFQ-yymm-NNN.")
    finally:
        session.close()


def seed_admin():
    session = get_session()
    try:
        existing = session.query(User).filter_by(username="admin").first()
        if existing:
            print("[SKIP] Admin user already exists.")
            return
        pw_hash = bcrypt.hashpw(b"admin1234", bcrypt.gensalt()).decode()
        admin = User(
            username="admin",
            email="admin@k-maris.com",
            password_hash=pw_hash,
            role=UserRole.ADMIN,
        )
        session.add(admin)
        session.commit()
        print("[OK] Admin user created. (username: admin / password: admin1234)")
        print("     !! Change the password immediately after first login !!")
    finally:
        session.close()


def seed_sample_data():
    """Optional: seed one sample customer and vendor for demo."""
    session = get_session()
    try:
        if session.query(Customer).count() > 0:
            return
        customer = Customer(
            name="ABC Ship Management Pte. Ltd.",
            address="10 Anson Road, Singapore",
            contact="Mr. John Lee",
            email="purchase@example.com",
            tax_id="SG-000000",
            country="Singapore",
        )
        vendor = Vendor(
            name="MAN Energy Solutions",
            address="Teglholmsgade 41, Copenhagen, Denmark",
            contact="Mr. Klaus Schmidt",
            email="spares@man-es.com",
            country="Denmark",
            specialization="MAN B&W Engine OEM Parts",
        )
        session.add_all([customer, vendor])
        session.commit()
        print("[OK] Sample customer and vendor seeded.")
    finally:
        session.close()


if __name__ == "__main__":
    print("Initializing KTMS database...")
    create_tables()
    migrate_columns()
    migrate_rfq_numbers()
    seed_admin()
    seed_sample_data()
    print("Done.")
