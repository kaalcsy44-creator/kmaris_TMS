"""라인 ID(lid) 일괄 보정 — 드라이런이 기본, `--apply` 를 줘야 쓴다.

    python scripts/backfill_line_ids.py            # 계산만, 딜별로 출력
    python scripts/backfill_line_ids.py --apply    # 실제 반영
    python scripts/backfill_line_ids.py --rfq 123  # 딜 하나만

lid 가 생기기 전에 만든 딜, 그리고 Auto-fill 로 읽어 저장한 벤더 견적은 줄 이름이 없어
개요·소싱 보드에서 품번 추측으로만 품목과 이어졌다. 여기서 빈 이름만 채운다:

  1. 1단계 RFQ 품목 줄 — 이름 없는 줄에 L01… (이미 있는 이름은 그대로, 쓴 이름은 재사용 안 함)
  2. 벤더 RFQ(보낸 줄)   — RFQ 줄에 짝지어 이름을 붙인다
  3. 벤더 견적(받은 줄)  — 그 벤더에게 보낸 줄 안에서 짝짓는다
  4. 고객 견적          — 딜 전체 줄 안에서 짝짓는다

짝짓기 규칙은 저장 때와 같다(_core.stamp_doc_line_ids): 확실할 때만 붙이고 애매한 줄은
비워 둔다. 이미 붙은 이름은 절대 바꾸지 않으므로 몇 번을 돌려도 결과가 같다.
"""
from __future__ import annotations

import argparse
import os
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]

if not os.environ.get("DATABASE_URL"):
    try:
        from dotenv import load_dotenv
        load_dotenv(ROOT / ".env")
    except ImportError:
        pass

from db.engine import get_session                                   # noqa: E402
from db.models import RFQ, Quotation, VendorQuote, VendorRFQ        # noqa: E402
from _core import (                                                  # noqa: E402
    assign_line_ids,
    is_option_row,
    line_id_of,
    stamp_doc_line_ids,
)


def _copy(items) -> list:
    return [dict(it) if isinstance(it, dict) else it for it in (items or [])]


def _unnamed(items) -> int:
    return sum(1 for it in (items or []) if isinstance(it, dict)
               and not is_option_row(it) and not line_id_of(it)
               and (str(it.get("part_no") or "").strip() or str(it.get("description") or "").strip()))


def _label(it: dict) -> str:
    return " · ".join(x for x in (str(it.get("part_no") or "").strip(),
                                  str(it.get("description") or "").strip()[:50]) if x)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--rfq", type=int, default=0)
    ap.add_argument("--quiet", action="store_true", help="딜별 상세 없이 합계만")
    args = ap.parse_args()

    s = get_session()
    tally: Counter = Counter()
    how: Counter = Counter()
    try:
        q = s.query(RFQ).order_by(RFQ.id.asc())
        if args.rfq:
            q = q.filter(RFQ.id == args.rfq)
        for rfq in q.all():
            vrfqs = s.query(VendorRFQ).filter_by(rfq_id=rfq.id).order_by(VendorRFQ.id).all()
            vqs = (s.query(VendorQuote).filter(VendorQuote.vendor_rfq_id.in_([v.id for v in vrfqs]))
                   .order_by(VendorQuote.id).all() if vrfqs else [])
            qtns = s.query(Quotation).filter_by(rfq_id=rfq.id).order_by(Quotation.id).all()
            if not (rfq.items or []):
                continue
            log: list[str] = []

            # 1) RFQ 줄 이름 — 딜이 어디서든 한 번 쓴 이름은 비켜 간다.
            base = _copy(rfq.items)
            n0 = _unnamed(base)
            if n0:
                used = {line_id_of(it) for doc in [rfq.items] + [v.items for v in vrfqs]
                        + [v.items for v in vqs] + [x.items for x in qtns]
                        for it in (doc or []) if line_id_of(it)}
                assign_line_ids(base, reserved=used)
                rfq.items = base
                tally["rfq_lines"] += n0
                log.append(f"  RFQ 품목 {n0}줄에 이름 부여")

            def stamp(kind: str, obj, scope=None, tag=""):
                items = _copy(obj.items)
                if not _unnamed(items):
                    return
                res = stamp_doc_line_ids(base, items, scope)
                if res["matches"]:
                    obj.items = items
                    tally[f"{kind}_lines"] += len(res["matches"])
                    tally[f"{kind}_docs"] += 1
                    how.update(m["how"] for m in res["matches"])
                tally[f"{kind}_unmatched"] += len(res["unmatched"])
                bits = [f"{m['lid']}←{_label(items[m['index']])[:40]}({m['how']})"
                        for m in res["matches"]]
                miss = [_label(items[i])[:40] for i in res["unmatched"]]
                if bits or miss:
                    log.append(f"  {kind} {tag}: +{len(bits)}"
                               + (f"  미지정 {len(miss)}: {' | '.join(miss)}" if miss else ""))
                    for b in bits:
                        log.append(f"      {b}")

            # 2) 벤더 RFQ — 보낸 줄
            for vr in vrfqs:
                stamp("vrfq", vr, None, f"#{vr.id} {vr.kmaris_rfq_no or ''}")
            scope_of = {vr.id: [line_id_of(it) for it in (vr.items or []) if line_id_of(it)]
                        for vr in vrfqs}
            # 3) 벤더 견적 — 그 벤더에게 보낸 줄 안에서
            for vq in vqs:
                stamp("vq", vq, scope_of.get(vq.vendor_rfq_id), f"#{vq.id} {vq.vendor_quote_no or ''}")
            # 4) 고객 견적 — 딜 전체 줄 안에서
            for qt in qtns:
                stamp("qtn", qt, None, f"#{qt.id} {qt.qtn_no or ''}")

            if log:
                tally["deals"] += 1
                if not args.quiet:
                    print(f"\n[RFQ #{rfq.id} {rfq.rfq_no}] {rfq.project_title or ''}")
                    print("\n".join(log))

        print("\n=== 합계 ===")
        print(f"  손댄 딜 {tally['deals']}건 · RFQ 줄 이름 부여 {tally['rfq_lines']}줄")
        for k, name in (("vrfq", "벤더 RFQ"), ("vq", "벤더 견적"), ("qtn", "고객 견적")):
            print(f"  {name}: {tally[k + '_docs']}건 {tally[k + '_lines']}줄 연결"
                  f" · 미지정 {tally[k + '_unmatched']}줄")
        print(f"  근거: {dict(how)}")
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
