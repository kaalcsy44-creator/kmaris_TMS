"""품목 분류 전환 실행기 — 드라이런이 기본, `--apply` 를 줘야 쓴다.

    python scripts/migrate_item_taxonomy.py            # 계산만, 표로 출력
    python scripts/migrate_item_taxonomy.py --apply    # 실제 반영
    python scripts/migrate_item_taxonomy.py --verify   # 반영 뒤 검증만

마스터플랜 §2-6("마이그레이션 스크립트 + 드라이런 + 검증 + 적용")의 그 스크립트다.
재실행해도 안전하다 — 시드는 code 로 upsert 하고, 이관은 이미 옮긴 품목을 다시 옮기지
않는다(옮긴 품목은 새 트리 노드를 가리키므로 구 경로로 짝을 찾지 못한다).
"""
from __future__ import annotations

import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]

from db.engine import get_session                     # noqa: E402
from db.models import ItemCategory, ItemMaster        # noqa: E402
from services import item_taxonomy as tax             # noqa: E402


def show_plan(s, p: tax.Plan) -> None:
    print(f"\n[1] 품목 {len(p.items)}건 이동 · 매핑 못 찾음 {len(p.missing)}건")
    print("   판정별:", dict(sorted(Counter(m.verdict for m in p.items).items())))
    print("   대분류별:", dict(sorted(Counter(m.new_code.split('-')[0] for m in p.items).items())))
    svc = [m for m in p.items if m.to_service]
    print(f"   부품→용역으로 성격이 바뀌는 건: {len(svc)}")
    for m in svc:
        print(f"      {(m.item.description or '')[:52]:<52} → {m.new_code}")
    print("\n   (앞 12건)")
    for m in p.items[:12]:
        print(f"      {m.verdict:<4} {(m.item.description or '')[:44]:<44} "
              f"{m.old_path[:34]:<34} → {m.new_code} {m.new_name[:26]}")
    for it in p.missing:
        print(f"   ✗ 매핑 없음: #{it.id} {(it.description or '')[:60]}")

    moved = sum(1 for t in p.tags if t.new_ids)
    kept = [t for t in p.tags if not t.new_ids]
    print(f"\n[2] 취급 분류 태그 {len(p.tags)}줄 중 {moved}줄 이동 · 근거 없어 그대로 둘 줄 {len(kept)}")
    for t in p.tags[:10]:
        codes = [tax.MAJOR_BY_CODE.get(c, {}).get("code", "?") for c in []]
        print(f"      [{t.kind}] {t.name[:26]:<26} {len(t.old_ids)}개 → {len(t.new_ids)}개 ({t.basis})"
              + (f"  미확인: {t.detail[:40]}" if t.detail else ""))
    for t in kept[:6]:
        print(f"      · 유지: [{t.kind}] {t.name[:30]} — {t.detail[:50]}")

    print(f"\n[3] 문서 라인(RFQ·견적·오더·발주서) JSON 이동: {p.lines}줄")
    print(f"[4] 내릴 구 노드(active=false, 삭제 아님): {len(p.retire)}개")


def verify(s) -> None:
    cats = {c.id: c for c in s.query(ItemCategory).all()}
    new_nodes = [c for c in cats.values() if c.code]
    majors = [c for c in new_nodes if c.level == 1]
    parts = [c for c in new_nodes if c.level == 2]
    print(f"\n=== 검증 ===")
    print(f"  새 트리: 대분류 {len(majors)} · 부품 {len(parts)}")
    print("  대분류별 부품 수:",
          dict(sorted(Counter(cats[c.parent_id].code for c in parts if c.parent_id in cats).items())))

    items = s.query(ItemMaster).all()
    on_new = [i for i in items if i.category_id in cats and cats[i.category_id].code]
    print(f"  품목 {len(items)}건 중 새 분류: {len(on_new)} · 구 분류: {len(items) - len(on_new)}")
    print("  migration_status:", dict(sorted(Counter(i.migration_status or "(none)" for i in items).items())))
    print("  category_id NULL:", sum(1 for i in items if not i.category_id))
    print("  legacy_category 빈 건:", sum(1 for i in items if not (i.legacy_category or "").strip()))
    print("  item_type:", dict(sorted(Counter(i.item_type or "(none)" for i in items).items())))
    # 마스터플랜 §6 검증 기준
    bad = [i for i in items if not i.category_id or not i.migration_status]
    print(f"  ✗ 미분류·미이관: {len(bad)}")


def main() -> int:
    do_apply = "--apply" in sys.argv
    only_verify = "--verify" in sys.argv
    s = get_session()
    try:
        if only_verify:
            verify(s)
            return 0

        print("=== Phase 2: 마스터 적재(시드) ===")
        seeded = tax.seed(s)
        print("  ", seeded)
        if not do_apply:
            s.flush()      # 계획 계산이 새 노드를 볼 수 있게 flush 만(커밋 없음)

        print("\n=== Phase 3: 이관 계획 ===")
        p = tax.plan(s)
        show_plan(s, p)

        if not do_apply:
            s.rollback()
            print("\n(드라이런 — 아무것도 쓰지 않았다. 반영하려면 --apply)")
            return 0

        out = tax.apply(s, p)
        s.commit()
        print("\n=== 반영 완료 ===")
        print("  ", out)
        verify(s)
        return 0
    finally:
        s.close()


if __name__ == "__main__":
    raise SystemExit(main())
