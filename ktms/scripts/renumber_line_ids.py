"""딜 하나의 라인 ID(lid)를 1단계 품목 순서대로 L01… 로 다시 매긴다 — 드라이런이 기본.

    python scripts/renumber_line_ids.py --rfq-no P-057           # 계산만
    python scripts/renumber_line_ids.py --rfq-no P-057 --apply   # 실제 반영

품목을 통째로 다시 넣어 이름이 L51… 부터 서게 된 딜을 정리하려고 쓴다. 이름은 딜의
모든 문서(벤더 RFQ·벤더 견적·고객 견적·오더·발주서·PI·CI·PL·미수/미지급)와 채택 기록
(DealLineAward)이 함께 안고 있으므로 전부 같은 표로 한꺼번에 바꾼다 — 하나라도 빠지면
그 문서의 줄이 딜의 줄과 끊어진다.

1단계 품목에 없는 이름(지운 줄)을 다른 문서가 들고 있으면 그 이름도 새 번호 뒤쪽으로
옮겨 겹치지 않게 한다. 다시 돌려도 이미 L01… 이면 바꿀 게 없다.

접속 대상은 DATABASE_URL 로만 받는다(backfill_line_ids.py 와 같은 규약).
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]

from db.engine import get_engine, get_session                       # noqa: E402
from db.models import RFQ, DealLineAward                            # noqa: E402
from _core import LINE_ID_KEY, deal_line_docs, is_option_row, line_id_of  # noqa: E402


def _remap(items, table: dict) -> tuple[list, int]:
    out, n = [], 0
    for it in (items or []):
        if isinstance(it, dict):
            it = dict(it)
            old = line_id_of(it)
            if old and old in table and table[old] != old:
                it[LINE_ID_KEY] = table[old]
                n += 1
        out.append(it)
    return out, n


def main() -> None:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--rfq", type=int)
    g.add_argument("--rfq-no")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    url = get_engine().url
    print(f"DB: {url.get_backend_name()} {url.host or url.database}"
          f"  ({'APPLY' if args.apply else 'dry-run'})")
    s = get_session()
    try:
        q = s.query(RFQ)
        rfq = (q.filter_by(id=args.rfq) if args.rfq else q.filter_by(rfq_no=args.rfq_no)).first()
        if not rfq:
            sys.exit("RFQ 를 찾을 수 없습니다.")
        print(f"[RFQ #{rfq.id} {rfq.rfq_no}] {rfq.project_title or ''}")

        base = [it for it in (rfq.items or []) if isinstance(it, dict) and not is_option_row(it)]
        unnamed = [it for it in base if not line_id_of(it)]
        if unnamed:
            sys.exit(f"이름 없는 품목 줄이 {len(unnamed)}개 있습니다 — backfill_line_ids.py 를 먼저 돌리세요.")
        olds = [line_id_of(it) for it in base]
        if len(set(olds)) != len(olds):
            sys.exit("1단계 품목에 같은 이름이 두 번 나옵니다 — 손으로 확인이 필요합니다.")

        table = {old: f"L{i + 1:02d}" for i, old in enumerate(olds)}
        docs = deal_line_docs(s, rfq.id)
        awards = s.query(DealLineAward).filter_by(rfq_id=rfq.id).all()
        elsewhere = {line_id_of(it) for d in docs for it in (d.items or []) if line_id_of(it)}
        elsewhere |= {a.lid for a in awards if a.lid}
        orphans = sorted(elsewhere - set(table), key=lambda x: (len(x), x))
        nxt = len(olds)
        for o in orphans:
            nxt += 1
            table[o] = f"L{nxt:02d}"
        if orphans:
            print(f"  1단계에 없는 이름(지운 줄) {len(orphans)}개도 뒤로 옮김: "
                  + ", ".join(f"{o}→{table[o]}" for o in orphans))

        changed = {k: v for k, v in table.items() if k != v}
        if not changed:
            print("  이미 L01… 순서입니다. 바꿀 것이 없습니다.")
            return
        print(f"  이름 변경 {len(changed)}개: {olds[0]}→{table[olds[0]]} … {olds[-1]}→{table[olds[-1]]}")

        tally: Counter = Counter()
        rfq.items, n = _remap(rfq.items, table)
        tally["RFQ(1단계)"] += n
        for d in docs:
            new, n = _remap(d.items, table)
            if n:
                d.items = new
                tally[type(d).__name__] += n
                print(f"    {type(d).__name__} #{d.id}: {n}줄")
        # 채택 기록은 (rfq_id, lid) 유일 — 옛 이름과 새 이름이 겹칠 수 있으니 임시 이름을 거친다.
        moving = [(a, a.lid) for a in awards if a.lid in changed]
        for a, _ in moving:
            a.lid = f"~{a.id}"
        s.flush()
        for a, old in moving:
            a.lid = changed[old]
        s.flush()
        tally["DealLineAward"] = len(moving)
        print("  합계: " + ", ".join(f"{k} {v}" for k, v in tally.items()))

        if args.apply:
            s.commit()
            print("\n반영했습니다.")
        else:
            s.rollback()
            print("\n드라이런 — 아무것도 쓰지 않았습니다. 반영하려면 --apply")
    finally:
        s.close()


if __name__ == "__main__":
    main()
