"""Create all tables and seed the default admin user."""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import bcrypt
from sqlalchemy import text, inspect
from db.engine import Base, get_engine, get_session
from db.models import User, UserRole, DocSequence, Customer, Vendor


def create_tables():
    Base.metadata.create_all(bind=get_engine())
    print("[OK] Tables created.")


# New columns added after the initial release. Idempotent for existing DBs.
_MIGRATIONS = {
    "orders": {
        "promised_delivery": "VARCHAR(10)",
        "shipped_date":      "VARCHAR(10)",
        "delivered_date":    "VARCHAR(10)",
    },
    "vendor_rfqs": {
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
    seed_admin()
    seed_sample_data()
    print("Done.")
