"""Drop ONLY the KTMS tables from the old shared Neon project, leaving another
app's tables (properties, match_results, graded_list, batch_logs, law_mapping)
and the applied_migrations marker table fully intact.

Safety model:
  * Uses Base.metadata.drop_all — it can only touch the 24 tables defined in the
    KTMS ORM models. Anything not in the models is physically unreachable here.
  * No CASCADE: if an external table referenced a KTMS table, the drop errors out
    instead of silently cascading into the other app.
  * Snapshots every public table's row count before and after, and asserts the
    non-KTMS tables are unchanged.

Usage (from ktms/):
    OLD_DB_URL="postgresql://...old..." python drop_ktms_from_old_db.py            # dry-run
    OLD_DB_URL="postgresql://...old..." python drop_ktms_from_old_db.py --execute  # really drop
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from sqlalchemy import create_engine, text

from db.engine import Base
import db.models  # noqa: F401  (populate metadata)


def _norm(url: str) -> str:
    url = url.strip()
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql://", 1)
    # channel_binding sometimes trips psycopg2; sslmode=require is enough here.
    return url.split("&channel_binding")[0]


def _inventory(conn):
    rows = conn.execute(text(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema='public' ORDER BY table_name"
    )).scalars().all()
    out = {}
    for t in rows:
        out[t] = conn.execute(text(f'SELECT count(*) FROM "{t}"')).scalar()
    return out


def main() -> int:
    execute = "--execute" in sys.argv
    url = os.environ.get("OLD_DB_URL", "")
    if not url:
        print("ERROR: set OLD_DB_URL (the OLD shared project).")
        return 2

    ktms_tables = {t.name for t in Base.metadata.sorted_tables}  # 24 KTMS tables
    eng = create_engine(_norm(url), echo=False, pool_pre_ping=True)

    with eng.connect() as conn:
        before = _inventory(conn)

    to_drop = sorted(t for t in before if t in ktms_tables)
    preserve = sorted(t for t in before if t not in ktms_tables)

    print(f"OLD DB has {len(before)} public tables.\n")
    print(f"WILL DROP ({len(to_drop)} KTMS tables):")
    for t in to_drop:
        print(f"    - {t:<22} {before[t]:>6} rows")
    print(f"\nWILL PRESERVE ({len(preserve)} tables):")
    for t in preserve:
        print(f"    = {t:<22} {before[t]:>6} rows")

    if not execute:
        print("\n[DRY-RUN] nothing dropped. Re-run with --execute to apply.")
        return 0

    print("\n[EXECUTE] dropping KTMS tables (metadata.drop_all, no CASCADE)...")
    Base.metadata.drop_all(bind=eng)

    with eng.connect() as conn:
        after = _inventory(conn)

    # Verify: every KTMS table gone; every preserved table unchanged.
    still = [t for t in to_drop if t in after]
    changed = [t for t in preserve if after.get(t) != before[t]]
    lost = [t for t in preserve if t not in after]

    print(f"\n[after] {len(after)} public tables remain.")
    if still:
        print(f"[WARN] KTMS tables NOT dropped: {still}")
    if lost:
        print(f"[ALERT] preserved tables DISAPPEARED: {lost}  <-- investigate!")
    if changed:
        print(f"[ALERT] preserved table row counts CHANGED: {changed}  <-- investigate!")
    if not (still or lost or changed):
        print("[OK] all 24 KTMS tables dropped; every other-app table intact "
              "(same names + row counts).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
