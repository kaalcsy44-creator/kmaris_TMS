"""One-shot data migration: copy an entire KTMS Postgres DB to a fresh one.

Used to move off a quota-blocked Neon project onto a new (free) Neon project
WITHOUT pg_dump/pg_restore binaries — it rebuilds the schema from the SQLAlchemy
models and copies every table row-by-row, then fixes the id sequences.

Usage (from the ktms/ directory):
    SRC_DB_URL="postgresql://...old..."  \
    DST_DB_URL="postgresql://...new..."  \
    python migrate_to_new_db.py

Add --dry-run to only print row counts from the source without writing anything.
Re-running is safe only against an EMPTY target (it does not upsert).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from sqlalchemy import create_engine, select, insert, text

# Importing models registers every table on Base.metadata.
from db.engine import Base
import db.models  # noqa: F401  (side effect: populate metadata)


def _norm(url: str) -> str:
    url = url.strip()
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql://", 1)
    return url


def _copy_applied_migrations(src, dst, dry: bool) -> None:
    """Copy the applied_migrations marker table (not an ORM model) so the app's
    idempotency guards stay intact on the new DB."""
    with src.connect() as sconn:
        if not sconn.dialect.has_table(sconn, "applied_migrations"):
            print("  applied_migrations       (none on source, skip)")
            return
        names = [r[0] for r in sconn.execute(text("SELECT name FROM applied_migrations"))]
    print(f"  applied_migrations     {len(names):>6} markers -> {names}")
    if dry or not names:
        return
    with dst.begin() as dconn:
        dconn.execute(text(
            "CREATE TABLE IF NOT EXISTS applied_migrations (name VARCHAR(100) PRIMARY KEY)"))
        for nm in names:
            dconn.execute(
                text("INSERT INTO applied_migrations (name) VALUES (:n) "
                     "ON CONFLICT (name) DO NOTHING"),
                {"n": nm},
            )


def main() -> int:
    dry = "--dry-run" in sys.argv
    src_url = os.environ.get("SRC_DB_URL", "")
    dst_url = os.environ.get("DST_DB_URL", "")
    if not src_url:
        print("ERROR: set SRC_DB_URL (old/source DB).")
        return 2
    if not dry and not dst_url:
        print("ERROR: set DST_DB_URL (new/target DB), or pass --dry-run.")
        return 2

    src = create_engine(_norm(src_url), echo=False, pool_pre_ping=True)
    dst = create_engine(_norm(dst_url), echo=False, pool_pre_ping=True) if dst_url else None

    tables = list(Base.metadata.sorted_tables)  # FK-safe (parents first)

    # 1) Build the schema on the fresh target from the current models.
    if not dry:
        Base.metadata.create_all(bind=dst)
        print(f"[OK] schema created on target ({len(tables)} tables).")

    total = 0
    with src.connect() as sconn:
        for tbl in tables:
            rows = [dict(r._mapping) for r in sconn.execute(select(tbl))]
            n = len(rows)
            total += n
            print(f"  {tbl.name:<22} {n:>6} rows")
            if dry or n == 0:
                continue
            with dst.begin() as dconn:
                dconn.execute(insert(tbl), rows)

    print(f"[OK] copied {total} rows across {len(tables)} tables." if not dry
          else f"[DRY] source has {total} rows across {len(tables)} tables.")

    # 1b) Carry over applied_migrations (not an ORM model). Without it, the
    # one-shot boot migrations (remove_stage_8, translate_categories, ...) would
    # re-run on the fresh DB and CORRUPT already-migrated data.
    _copy_applied_migrations(src, dst, dry)

    # 2) Realign id sequences so new inserts don't collide with copied PKs.
    if not dry:
        fixed = 0
        with dst.begin() as dconn:
            for tbl in tables:
                if "id" not in tbl.c:
                    continue
                seq = dconn.execute(
                    text("SELECT pg_get_serial_sequence(:t, 'id')"),
                    {"t": tbl.name},
                ).scalar()
                if not seq:
                    continue
                dconn.execute(text(
                    f"SELECT setval('{seq}', "
                    f"(SELECT COALESCE(MAX(id), 1) FROM {tbl.name}), true)"
                ))
                fixed += 1
        print(f"[OK] realigned {fixed} id sequence(s).")

    # 3) Sanity: compare row counts.
    if not dry:
        print("[verify] target row counts:")
        mismatch = 0
        with src.connect() as sconn, dst.connect() as dconn:
            for tbl in tables:
                a = sconn.execute(text(f"SELECT COUNT(*) FROM {tbl.name}")).scalar()
                b = dconn.execute(text(f"SELECT COUNT(*) FROM {tbl.name}")).scalar()
                flag = "" if a == b else "  <-- MISMATCH"
                if a != b:
                    mismatch += 1
                print(f"  {tbl.name:<22} src={a:>6} dst={b:>6}{flag}")
        print("[OK] all table counts match." if mismatch == 0
              else f"[WARN] {mismatch} table(s) mismatched — investigate before cutover.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
