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
from db.models import (
    User, UserRole, DocSequence, Customer, Vendor, RFQ, Quotation, VendorQuote, Order, ItemCategory,
)


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
        "source_files": "JSON",
        "received_at": "VARCHAR(16)",
        "contact_person": "VARCHAR(100)",
        "request_channel": "VARCHAR(40)",
        "created_by": "INTEGER",
    },
    "quotations": {
        "created_by": "INTEGER",
        "sent_at": "VARCHAR(16)",
        "cost_currency": "VARCHAR(10)",
        "round_digits": "INTEGER",
        "discount_pct": "FLOAT",
        "fx_rate": "FLOAT",
    },
    "customers": {
        "contact_phone": "VARCHAR(50)",
        "payment_terms": "VARCHAR(200)",
        "logo": "TEXT",
    },
    "vendors": {
        "contact_phone": "VARCHAR(50)",
        "payment_terms": "VARCHAR(200)",
        "logo": "TEXT",
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
        "source_files": "JSON",
        "fx_rate": "FLOAT",
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
        # DEFAULT 없이 추가 → 기존 오더는 NULL 로 남아 연결 견적 통화를 그대로 상속(회귀 방지).
        # 신규 오더는 create_order 에서 통화를 명시 저장한다.
        "currency":          "VARCHAR(10)",
        "terms":             "JSON",
        "source_files":      "JSON",
    },
    "vendor_rfqs": {
        "sent_to_email": "VARCHAR(200)",
        "sent_at": "VARCHAR(16)",
        "kmaris_rfq_no": "VARCHAR(40)",
    },
    "purchase_orders": {
        "sent_to_email": "VARCHAR(200)",
        "terms": "JSON",
        # DEFAULT 없이 추가 → 기존 발주서는 NULL 로 남아 오더/견적 통화를 상속(회귀 방지).
        "currency": "VARCHAR(10)",
        "source_files": "JSON",
    },
    "marketing_activities": {
        "contact_person": "VARCHAR(100)",
        "recipient_email": "VARCHAR(200)",
    },
    "item_master": {
        # 품목 분류 연결(대>중>소 트리의 가장 깊은 노드 id). FK 는 신규 DB 모델에서만 강제.
        "category_id": "INTEGER",
    },
    "packing_lists": {
        # Packing List 자유 메모(예: "Cartons in 5 pallets"). DEFAULT 없이 추가.
        "packing_info": "VARCHAR",
        # 선적정보·Shipping Marks 오버라이드(비우면 CI 상속).
        "shipping": "JSON",
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
            # work_type 은 신규 DB에서 네이티브 PG enum(worktype)이라 빈문자·한글값을
            # enum 리터럴로 직접 비교하면 InvalidTextRepresentation 으로 죽는다.
            # ::text 캐스팅으로 varchar(구 DB)·enum(신 DB) 스키마 양쪽에서 안전하게 비교.
            conn.execute(text(
                "UPDATE rfqs SET work_type='PARTS' "
                "WHERE work_type IS NULL OR work_type::text='' OR work_type::text='부품공급'"
            ))
            conn.execute(text("UPDATE rfqs SET work_type='SERVICE' WHERE work_type::text='서비스'"))


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


def seed_item_categories():
    """Seed the default item category tree (Main>Sub>Detail). Idempotent — skips
    if any category already exists.

    Default: Service/Parts > Engine·Other > 2·4 stroke / BWTS·Incinerator·…
    Bunkering·Provisions and others are added later by admins in Settings."""
    session = get_session()
    try:
        if session.query(ItemCategory).count() > 0:
            print("[SKIP] Item categories already exist.")
            return
        equipment = ["BWTS", "Incinerator", "Elevator", "Life boat", "Crane", "ETC"]
        tree = {
            "Service": {"Engine": ["2 stroke", "4 stroke"], "Other Equipment": list(equipment)},
            "Parts":   {"Engine": ["2 stroke", "4 stroke"], "Other":           list(equipment)},
        }
        for i, (l1, mids) in enumerate(tree.items()):
            n1 = ItemCategory(name=l1, parent_id=None, level=1, sort_order=i)
            session.add(n1)
            session.flush()
            for j, (l2, subs) in enumerate(mids.items()):
                n2 = ItemCategory(name=l2, parent_id=n1.id, level=2, sort_order=j)
                session.add(n2)
                session.flush()
                for k, l3 in enumerate(subs):
                    session.add(ItemCategory(name=l3, parent_id=n2.id, level=3, sort_order=k))
        session.commit()
        print("[OK] Item categories seeded (Service/Parts > Engine·Other > …).")
    finally:
        session.close()


# 기존(seed 후) 한글 분류명 → 영문 변환용 매핑. 이름 정확 일치로만 변환한다.
# L3(2 stroke·BWTS 등)는 이미 영문이라 대상 아님.
_CATEGORY_RENAME = {
    "서비스": "Service",
    "부품": "Parts",
    "부품공급": "Parts",
    "엔진": "Engine",
    "기타장비": "Other Equipment",
    "기타 기자재": "Other Equipment",
    "기타기자재": "Other Equipment",
    "기타": "Other",
    "벙커링": "Bunkering",
    "선용품": "Provisions",
}


def migrate_widen_activity_type():
    """marketing_activities.activity_type 를 VARCHAR(200)으로 확장(복수 선택 join 대비).

    Postgres 만 VARCHAR 길이를 강제하므로 대상. SQLite 는 길이 무시라 no-op.
    applied_migrations 마커로 1회만 실행."""
    eng = get_engine()
    insp = inspect(eng)
    if not insp.has_table("marketing_activities"):
        return
    if eng.dialect.name != "postgresql":
        return
    with eng.begin() as conn:
        conn.execute(text(
            "CREATE TABLE IF NOT EXISTS applied_migrations (name VARCHAR(100) PRIMARY KEY)"))
        if conn.execute(text(
                "SELECT 1 FROM applied_migrations WHERE name='widen_activity_type'")).first():
            return
        conn.execute(text(
            "ALTER TABLE marketing_activities ALTER COLUMN activity_type TYPE VARCHAR(200)"))
        conn.execute(text(
            "INSERT INTO applied_migrations (name) VALUES ('widen_activity_type')"))
    print("[OK] marketing_activities.activity_type widened to VARCHAR(200).")


def migrate_translate_categories():
    """1회성: 기존 한글 품목 분류명을 영문으로 변환. applied_migrations 마커로 가드.

    이름 정확 일치로만 변환하므로 트리 구조·사용자 편집(가지치기 등)은 보존된다.
    매핑에 없는(관리자가 새로 만든) 이름은 손대지 않는다. 재실행 안전."""
    eng = get_engine()
    with eng.begin() as conn:
        conn.execute(text(
            "CREATE TABLE IF NOT EXISTS applied_migrations (name VARCHAR(100) PRIMARY KEY)"))
        if conn.execute(text(
                "SELECT 1 FROM applied_migrations WHERE name='translate_item_categories'")).first():
            return  # 이미 적용됨

    s = get_session()
    n = 0
    try:
        for c in s.query(ItemCategory).all():
            new = _CATEGORY_RENAME.get((c.name or "").strip())
            if new and new != c.name:
                c.name = new
                n += 1
        s.commit()
    finally:
        s.close()
    with eng.begin() as conn:
        conn.execute(text(
            "INSERT INTO applied_migrations (name) VALUES ('translate_item_categories')"))
    print(f"[OK] translate_item_categories applied: {n} categories renamed.")


def migrate_remove_stage_8():
    """1회성: '단계 8'(Delivery/Service Arrangement) 제거에 따른 저장 데이터 재번호.

    구 8(Arrangement) → 7(Readiness)로 흡수, 9→8·10→9·11→10·12→11.
    대상: RFQ.stage_dates, RFQ.stage_notes, Order.service_info (모두 단계번호 키).
    applied_migrations 마커로 가드 → 매 부팅 실행돼도 1회만 적용(재실행 안전)."""
    eng = get_engine()
    with eng.begin() as conn:
        conn.execute(text(
            "CREATE TABLE IF NOT EXISTS applied_migrations (name VARCHAR(100) PRIMARY KEY)"))
        if conn.execute(text(
                "SELECT 1 FROM applied_migrations WHERE name='remove_stage_8'")).first():
            return  # 이미 적용됨

    def target(n: int) -> int:
        return n if n <= 7 else (7 if n == 8 else n - 1)

    def renum(d, kind: str):
        """d(단계키 dict)를 재번호. kind: 'date'|'notes'|'info'. (변경여부, 결과) 반환."""
        if not isinstance(d, dict) or not d:
            return d, False
        out: dict = {}
        changed = False
        for k in sorted(d.keys(), key=lambda x: int(x) if str(x).isdigit() else 999):
            v = d[k]
            if not str(k).isdigit():
                out[k] = v
                continue
            tk = str(target(int(k)))
            if tk != str(k):
                changed = True
            if tk in out:  # 7·8이 모두 7로 → 병합
                changed = True
                if kind == "notes":
                    out[tk] = (out[tk] or []) + (v or [])
                elif kind == "info":
                    out[tk] = {**(v or {}), **(out[tk] or {})}  # 7(Readiness) 우선
                else:  # date: 먼저 처리된 7 값 유지
                    out[tk] = out[tk] or v
            else:
                out[tk] = v
        return out, changed

    s = get_session()
    n_rfq = n_ord = 0
    try:
        for r in s.query(RFQ).all():
            sd, c1 = renum(getattr(r, "stage_dates", None) or {}, "date")
            sn, c2 = renum(getattr(r, "stage_notes", None) or {}, "notes")
            if c1:
                r.stage_dates = sd
            if c2:
                r.stage_notes = sn
            if c1 or c2:
                n_rfq += 1
        for o in s.query(Order).all():
            si, c = renum(getattr(o, "service_info", None) or {}, "info")
            if c:
                o.service_info = si
                n_ord += 1
        s.commit()
    finally:
        s.close()
    with eng.begin() as conn:
        conn.execute(text("INSERT INTO applied_migrations (name) VALUES ('remove_stage_8')"))
    print(f"[OK] remove_stage_8 migration applied: {n_rfq} RFQs, {n_ord} orders renumbered.")


_INCOTERM_LABELS = {
    "EXW": "EXW (Ex Works)",
    "FCA": "FCA (Free Carrier)",
    "FOB": "FOB (Free On Board)",
    "CFR": "CFR (Cost and Freight)",
    "CIF": "CIF (Cost, Insurance and Freight)",
    "DAP": "DAP (Delivered at Place)",
}


def _normalize_incoterm(val):
    """'EXW Busan' 처럼 코드로 시작하는 값을 지역/약어 없는 표준 라벨로 정규화.
    코드로 시작하지 않거나 이미 표준 라벨이면 None(변경 없음)."""
    if not isinstance(val, str):
        return None
    v = val.strip()
    if not v:
        return None
    up = v.upper()
    for code, label in _INCOTERM_LABELS.items():
        if up == code or up.startswith(code + " ") or up.startswith(code + "("):
            return label if label != v else None
    return None


def migrate_normalize_incoterms():
    """1회성: 저장된 견적 terms.incoterms 를 지역 없는 표준 라벨로 정규화.
    예) 'EXW Busan' → 'EXW (Ex Works)'. applied_migrations 가드로 재실행 안전."""
    eng = get_engine()
    with eng.begin() as conn:
        conn.execute(text(
            "CREATE TABLE IF NOT EXISTS applied_migrations (name VARCHAR(100) PRIMARY KEY)"))
        if conn.execute(text(
                "SELECT 1 FROM applied_migrations WHERE name='normalize_incoterms'")).first():
            return  # 이미 적용됨
    s = get_session()
    n = 0
    try:
        for model in (Quotation, VendorQuote):
            for row in s.query(model).all():
                terms = getattr(row, "terms", None)
                if not isinstance(terms, dict):
                    continue
                new_ic = _normalize_incoterm(terms.get("incoterms"))
                if new_ic:
                    row.terms = {**terms, "incoterms": new_ic}  # 재할당해야 JSON 변경 감지
                    n += 1
        s.commit()
    finally:
        s.close()
    with eng.begin() as conn:
        conn.execute(text("INSERT INTO applied_migrations (name) VALUES ('normalize_incoterms')"))
    print(f"[OK] normalize_incoterms applied: {n} quote(s) updated.")


if __name__ == "__main__":
    print("Initializing KTMS database...")
    create_tables()
    migrate_columns()
    migrate_relax_not_null()
    migrate_drop_columns()
    migrate_rfq_numbers()
    migrate_quotation_numbers()
    migrate_remove_stage_8()
    seed_admin()
    seed_sample_data()
    seed_item_categories()
    migrate_translate_categories()
    migrate_widen_activity_type()
    migrate_normalize_incoterms()
    print("Done.")
