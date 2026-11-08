"""고객사 약칭(Customer.short_name) 일괄 입력 + 회사명 오타 정정 — 2026-11-08 확정안.

약칭은 드라이브 프로젝트 폴더명의 고객사 칸에 쓴다. 회사 단위 값이라 같은 회사명의
담당자 레코드 전부에 같은 값이 들어간다.

    # 기본은 드라이런(바꿀 내용만 보여 준다)
    DATABASE_URL=postgresql://... python scripts/set_customer_short_names.py
    DATABASE_URL=postgresql://... python scripts/set_customer_short_names.py --apply

이미 약칭이 들어 있는 회사는 덮지 않는다(--force 로만 덮는다) — 사람이 화면에서 고친
값을 이 스크립트가 되돌리지 않게.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]

from db.engine import get_session  # noqa: E402
from db.models import Customer  # noqa: E402

# 회사명 오타 정정(옛 이름 → 새 이름). 약칭보다 먼저 적용한다.
RENAMES = {
    "Comlumbia Group": "Columbia Group",
}

# 회사명(정정 후) → 약칭. A: 드라이브 폴더에서 쓰던 표기, B: 업계 통칭 제안(확정).
SHORT_NAMES = {
    # A — 딜이 있는 고객사
    "EVERHONEST MARINE": "Everhonest",
    "SOLUNA MARINETECH": "Soluna",
    "XINYUN(Hongkong)": "XINYUN",
    "MR DIESEL": "MRDIESEL",
    "SYNERGY Marine Group": "SYNERGY",
    "ANGLO-EASTERN": "Angloeastern",
    "BLUEFERN Group": "Bluefern",
    "SENDA group": "SENDA",
    "MISC Group": "MISC",
    "Marine Services & Consultant (HK) Ltd": "MSACHKL",
    "Executive Ship Management (ESM)": "ESM",
    "GreenWake Marine": "GREENWAKE",
    "Integrated Maritime Management (SG) Pte Ltd": "IMM",
    "MMS BULKSHIP Management": "MMS",
    # B — 아직 딜이 없는 고객사
    "AET Tanker": "AET",
    "AMCL(Hong Kong)": "AMCL",
    "APOLLO Maritime": "APOLLO",
    "Anglo Ardmore Shipping": "Anglo Ardmore",
    "Asia Chemicals Shipping": "Asia Chemicals",
    "BELSHIPS": "BELSHIPS",
    "BSM Maritime": "BSM",
    "CMA CGM": "CMA CGM",
    "Columbia Group": "Columbia",
    "DHTankers": "DHT",
    "DRACO BUREN SHIPPING": "DRACO BUREN",
    "EASTAWAY": "EASTAWAY",
    "EASTERN PACIFIC shipping": "EPS",
    "FLEET Management Limited": "FLEET",
    "GOODWOOD Ship Management": "GOODWOOD",
    "Greatship Group": "Greatship",
    "ISHIMA ship": "ISHIMA",
    "KMSM": "KMSM",
    "KORIFI CORP": "KORIFI",
    "M.T.M SHIP MANAGEMENT PTE. LTD": "MTM",
    "MOL ship": "MOL",
    "MSC Group": "MSC",
    "MingBing Shipping Co., Limited": "MingBing",
    "NYK Shipmanagement Pte. Ltd.": "NYK",
    "OSM Thome": "OSM Thome",
    "Ocean Network Express": "ONE",
    "PACC Offshore Services": "PACC",
    "PACIFIC-GAS": "PACIFIC GAS",
    "PETREDEC Global": "PETREDEC",
    "PURUS": "PURUS",
    "Pacific International Lines": "PIL",
    "Petro Services": "Petro Services",
    "SEASPAN": "SEASPAN",
    "Sea Sourcing": "Sea Sourcing",
    "TEEKAY Marine": "TEEKAY",
    "Union Marine Management Services": "UMMS",
    "WAH KWONG (Hong Kong)": "WAH KWONG",
    "WESTERN Shipping": "WESTERN",
    "WILHELMSEN": "WILHELMSEN",
    "YUANTONG marine service": "YUANTONG",
}


def _key(name: str) -> str:
    return " ".join((name or "").split()).lower()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="실제로 저장한다(없으면 드라이런)")
    ap.add_argument("--force", action="store_true", help="이미 있는 약칭도 덮는다")
    args = ap.parse_args()
    url = os.environ.get("DATABASE_URL", "")
    print(f"DB: {url.split('@')[-1].split('/')[0] if '@' in url else url or '(sqlite 기본)'}")
    print("모드:", "적용" if args.apply else "드라이런 — 저장하지 않음")

    s = get_session()
    try:
        rows = s.query(Customer).all()
        renames = {_key(a): b for a, b in RENAMES.items()}
        shorts = {_key(a): b for a, b in SHORT_NAMES.items()}

        n_ren = 0
        for r in rows:
            new = renames.get(_key(r.name))
            if new and r.name != new:
                print(f"  회사명 정정  #{r.id}: {r.name!r} → {new!r}")
                r.name = new
                n_ren += 1

        n_set = n_keep = 0
        seen: set[str] = set()
        companies = sorted({r.name for r in rows}, key=str.lower)
        for name in companies:
            want = shorts.get(_key(name))
            mine = [r for r in rows if r.name == name]
            if want is None:
                print(f"  ⚠ 약칭 표에 없음: {name!r} ({len(mine)}건) — 그대로 둔다")
                continue
            seen.add(_key(name))
            for r in mine:
                cur = (r.short_name or "").strip()
                if cur == want:
                    continue
                if cur and not args.force:
                    print(f"  = 기존 약칭 유지 #{r.id} {name!r}: {cur!r} (제안 {want!r})")
                    n_keep += 1
                    continue
                r.short_name = want
                n_set += 1
            print(f"  {name:<45} → {want}  ({len(mine)}건)")
        missing = [a for a in SHORT_NAMES if _key(a) not in seen]
        for a in missing:
            print(f"  ⚠ DB 에 없는 회사: {a!r}")

        print(f"\n회사명 정정 {n_ren}건 · 약칭 입력 {n_set}건 · 기존 유지 {n_keep}건")
        if args.apply:
            s.commit()
            print("저장했습니다.")
        else:
            s.rollback()
            print("드라이런 — 저장하지 않았습니다. 적용하려면 --apply")
        return 0
    finally:
        s.close()


if __name__ == "__main__":
    sys.exit(main())
