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
from db.models import User, UserRole, DocSequence, Customer, Vendor, RFQ, Quotation


def create_tables():
    Base.metadata.create_all(bind=get_engine())
    print("[OK] Tables created.")


# New columns added after the initial release. Idempotent for existing DBs.
_MIGRATIONS = {
    "rfqs": {
        "customer_rfq_no": "VARCHAR(100)",
        "project_title": "VARCHAR(200)",
        "stage_dates": "JSON",
        "work_type": "VARCHAR(20)",
        "stage_notes": "JSON",
        "received_at": "VARCHAR(16)",
        "contact_person": "VARCHAR(100)",
        "created_by": "INTEGER",
    },
    "quotations": {
        "created_by": "INTEGER",
        "sent_at": "VARCHAR(16)",
        "cost_currency": "VARCHAR(10)",
    },
    "customers": {
        "contact_phone": "VARCHAR(50)",
    },
    "vendors": {
        "contact_phone": "VARCHAR(50)",
    },
    "vessels": {
        "vessel_type": "VARCHAR(60)",
        "ais_flag": "VARCHAR(60)",
    },
    "vendor_quotes": {
        "vendor_quote_no": "VARCHAR(100)",
        "received_at": "VARCHAR(16)",
        "currency": "VARCHAR(10) DEFAULT 'USD'",
        "terms": "JSON",
    },
    "orders": {
        "promised_delivery": "VARCHAR(10)",
        "shipped_date":      "VARCHAR(10)",
        "delivered_date":    "VARCHAR(10)",
        "rfq_id":            "INTEGER",
        "consignee_confirmed_date": "VARCHAR(10)",
        "vendor_docs_sent_date":    "VARCHAR(10)",
        "trade_type":        "VARCHAR(10) DEFAULT '수출'",
        "service_info":      "JSON",
    },
    "vendor_rfqs": {
        "sent_to_email": "VARCHAR(200)",
        "sent_at": "VARCHAR(16)",
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
    # 신규 work_type 컬럼 백필: 기존 RFQ는 모두 부품공급으로 간주.
    # SQLAlchemy Enum 은 멤버 '이름'(PARTS/SERVICE)을 저장하므로 값(한글)이 아닌 이름으로 채운다.
    if insp.has_table("rfqs"):
        with engine.begin() as conn:
            conn.execute(text(
                "UPDATE rfqs SET work_type='PARTS' "
                "WHERE work_type IS NULL OR work_type='' OR work_type='부품공급'"
            ))
            conn.execute(text("UPDATE rfqs SET work_type='SERVICE' WHERE work_type='서비스'"))


def migrate_relax_not_null():
    """수동·선택 입력으로 전환된 번호 컬럼의 NOT NULL 제약 해제. 멱등.
    신규 DB는 모델에서 이미 nullable 이라 ALTER 가 필요 없다."""
    engine = get_engine()
    insp = inspect(engine)
    targets = [("quotations", "qtn_no")]
    with engine.begin() as conn:
        for table, col in targets:
            if not insp.has_table(table):
                continue
            info = {c["name"]: c for c in insp.get_columns(table)}.get(col)
            if info is None or info.get("nullable", True):
                continue
            if engine.dialect.name == "postgresql":
                conn.execute(text(f"ALTER TABLE {table} ALTER COLUMN {col} DROP NOT NULL"))
                print(f"[OK] {table}.{col} NOT NULL dropped.")
            else:
                print(f"[SKIP] {table}.{col} NOT NULL (sqlite — 모델 재생성 시 반영).")


def migrate_drop_columns():
    """수동입력 전환 과정에서 폐지된 번호 컬럼 제거. 멱등(이미 없으면 건너뜀).
      - orders.ord_no      (K-Maris Order No. — Project No.로 대체)
      - vendor_rfqs.vrfq_no (Vendor RFQ No. — 폐지)
    Postgres 는 DROP COLUMN 이 제약까지 함께 제거한다. SQLite 는 best-effort."""
    engine = get_engine()
    insp = inspect(engine)
    targets = [("orders", "ord_no"), ("vendor_rfqs", "vrfq_no")]
    with engine.begin() as conn:
        for table, col in targets:
            if not insp.has_table(table):
                continue
            if col not in {c["name"] for c in insp.get_columns(table)}:
                continue
            try:
                conn.execute(text(f"ALTER TABLE {table} DROP COLUMN {col}"))
                print(f"[OK] {table}.{col} dropped.")
            except Exception as e:  # noqa: BLE001
                print(f"[WARN] {table}.{col} drop skipped: {e}")


def migrate_rfq_numbers():
    """기존 KMS-CRFQ-YYYY-NNNN 형식의 RFQ 번호를 KMS-RFQ-yymm-NNN 형식으로 변환.

    이미 신규 형식(KMS-RFQ-)인 RFQ는 건너뛰므로 반복 실행해도 안전하다.
    기간(yymm)은 RFQ 수신일(date) 기준, 없으면 생성일(created_at)을 사용한다.
    """
    session = get_session()
    try:
        all_rfqs = session.query(RFQ).order_by(RFQ.id).all()
        # 레거시 자동형식(KMS-CRFQ-…) 만 변환한다. 수동 입력값·신규형식(KMS-RFQ-)·
        # 미발급(TMP-) 은 손대지 않는다(수동 채번 전환 후 임의 번호 보존).
        old = [
            r for r in all_rfqs
            if (r.rfq_no or "").startswith("KMS-CRFQ-")
        ]
        if not old:
            print("[SKIP] No RFQ numbers to migrate.")
            return

        # 이미 사용 중인 번호(변환 대상 제외) — 충돌 방지용.
        used = {r.rfq_no for r in all_rfqs if r not in old and r.rfq_no}
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
            # 이미 존재하는 번호는 건너뛰며 채번(UniqueViolation 방지).
            while True:
                seq.last_seq += 1
                cand = f"KMS-RFQ-{period_date:%y%m}-{seq.last_seq:03d}"
                if cand not in used:
                    break
            r.rfq_no = cand
            used.add(cand)
            renamed += 1
        session.commit()
        print(f"[OK] {renamed} RFQ number(s) migrated to KMS-RFQ-yymm-NNN.")
    finally:
        session.close()


def migrate_quotation_numbers():
    """기존 KMS-QTN-YYYY-NNNN 형식의 견적 번호를 KMS-QUO-yymm-NNN 형식으로 변환.

    이미 신규 형식(KMS-QUO-)인 견적은 건너뛰므로 반복 실행해도 안전하다.
    기간(yymm)은 견적일(date) 기준, 없으면 생성일(created_at)을 사용한다.
    """
    session = get_session()
    try:
        all_qtns = session.query(Quotation).order_by(Quotation.id).all()
        # 레거시 자동형식(KMS-QTN-…) 만 변환. 수동 입력값·빈값·신규형식은 보존.
        old = [q for q in all_qtns if (q.qtn_no or "").startswith("KMS-QTN-")]
        if not old:
            print("[SKIP] No quotation numbers to migrate.")
            return

        used = {q.qtn_no for q in all_qtns if q not in old and q.qtn_no}
        period_seq = {
            s.year: s
            for s in session.query(DocSequence).filter_by(doc_type="quotation_internal").all()
        }
        renamed = 0
        for q in old:
            period_date = None
            if q.date:
                try:
                    period_date = datetime.strptime(q.date, "%Y-%m-%d").date()
                except ValueError:
                    period_date = None
            if period_date is None:
                period_date = q.created_at.date() if q.created_at else _date.today()

            period = period_date.year * 100 + period_date.month
            seq = period_seq.get(period)
            if seq is None:
                seq = DocSequence(doc_type="quotation_internal", year=period, last_seq=0)
                session.add(seq)
                session.flush()
                period_seq[period] = seq
            # 이미 존재하는 번호는 건너뛰며 채번(UniqueViolation 방지).
            while True:
                seq.last_seq += 1
                cand = f"KMS-QUO-{period_date:%y%m}-{seq.last_seq:03d}"
                if cand not in used:
                    break
            q.qtn_no = cand
            used.add(cand)
            renamed += 1
        session.commit()
        print(f"[OK] {renamed} quotation number(s) migrated to KMS-QUO-yymm-NNN.")
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
    migrate_relax_not_null()
    migrate_drop_columns()
    migrate_rfq_numbers()
    migrate_quotation_numbers()
    seed_admin()
    seed_sample_data()
    print("Done.")
