"""거래선 ↔ 메이커 담당자 줄 맞추기 — 드라이런이 기본, `--apply` 를 줘야 쓴다.

    python scripts/backfill_contact_twins.py            # 무엇이 더해질지만 출력
    python scripts/backfill_contact_twins.py --apply    # 실제 반영

명부 사이 복사는 회사 값만 이어 두어서, 복사한 뒤 한쪽에 더한 담당자는 저쪽에 나타나지
않았다(예: Alfa Laval 메이커 쪽에만 있던 Spares 창구). 이제는 저장할 때 서버가 옮겨 주지만
(_sync_contact_twins), 그 전에 벌어진 틈은 여기서 메운다.

**더하기만 한다.** 한쪽에만 있는 사람을 저쪽에 세울 뿐, 양쪽에 다 있는 사람의 값을 맞추거나
지우지는 않는다 — 어느 쪽 값이 맞는지는 기록만 봐서는 알 수 없다. 같은 사람인지는 저장 때와
같은 규칙(_find_contact_twin: 담당자 이름, 겹치면 대표 메일)으로 가린다. 몇 번을 돌려도 같다.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]

# 접속 대상은 DATABASE_URL 로만 받는다(backfill_line_ids.py 와 같은 이유).
from db.engine import get_session                                    # noqa: E402
from db.models import Maker, Vendor                                  # noqa: E402
from routers.settings import (                                       # noqa: E402
    _find_contact_twin,
    _new_contact_like,
    _contact_snap,
    _norm_company,
)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    s = get_session()
    try:
        books = {"vendors": Vendor, "makers": Maker}
        by_co: dict[str, dict[str, list]] = {}
        for kind, Model in books.items():
            for r in s.query(Model).order_by(Model.id).all():
                key = _norm_company(r.name or "")
                if key:
                    by_co.setdefault(key, {}).setdefault(kind, []).append(r)

        n = 0
        for key, sides in sorted(by_co.items()):
            if len(sides) < 2:
                continue
            for src_kind, dst_kind in (("vendors", "makers"), ("makers", "vendors")):
                dst_rows = sides[dst_kind]
                for r in sides[src_kind]:
                    # 이름 없는 줄은 사람이 아니라 회사 대표 줄(빈 자리표·대표 메일)이다 —
                    # 저쪽에도 저마다 그런 줄이 있어, 옮기면 같은 회사에 빈 줄만 늘어난다.
                    if not (r.contact or "").strip():
                        continue
                    if _find_contact_twin(dst_rows, _contact_snap(r)) is not None:
                        continue
                    print(f"[{dst_kind:7}] + {r.name} — {r.contact or '(no name)'}"
                          f" <{r.email or ''}>  (from {src_kind} #{r.id})")
                    new = _new_contact_like(books[dst_kind], dst_rows[0], r)
                    s.add(new)
                    dst_rows.append(new)     # 같은 사람이 두 번 세워지지 않게
                    n += 1

        print(f"\n{n} contact row(s) to add.")
        if args.apply and n:
            s.commit()
            print("applied.")
        else:
            s.rollback()
            if n:
                print("dry-run — rerun with --apply to write.")
    finally:
        s.close()


if __name__ == "__main__":
    main()
