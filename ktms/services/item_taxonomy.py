"""K-MARIS 품목 분류 전환 — 시드와 이관.

무엇을 바꾸는가
---------------
구 트리는 **위치**가 축이었다(Engine Room > Main Engine System > Piston). 트레이딩의
물음은 "배 어디에 있나"가 아니라 "무슨 품목이고 누가 만드나"라, 같은 케이블이 네 군데로
흩어지고 용역이 부품 노드에 얹혔다. 새 트리는 **품목**이 축이고 2단이다:

    대분류 15종(EN·AU·HT·VP·DK·EA·EV·SF·NC·AO·HW · TS·TR) > 부품 145종(EN-001 …)

SB(신조·도크 납품)·BU(벙커링·윤활유)는 품목군이 아니라 공급채널·상품라인이라 트리에
세우지 않는다(마스터플랜 §2-4).

어떻게 옮기는가
---------------
표를 새로 만들지 않는다. **있던 트리(item_categories)에 새 노드를 세우고 참조를 옮긴다** —
그 트리를 가리키는 곳이 품목만이 아니기 때문이다: 거래선·제조사의 취급 분류 태그
(JSON id 목록), RFQ·견적·오더·발주서의 라인 JSON 에도 category_id 가 박혀 있다. 표를
둘로 만들면 이 다섯 곳을 두 벌로 유지해야 한다.

구 노드는 지우지 않는다. `active=False` 로 내려 화면에서만 빠지고, 품목에는
`legacy_category`/`legacy_category_id` 로 옮기기 전 자리가 남는다 — 되돌릴 근거이자
"이 품목이 왜 여기로 갔나"의 유일한 기록이다.

짝은 어떻게 찾는가
------------------
매핑 시트의 `No.` 는 KTMS 의 식별자가 아니다(id 와 0/119 일치). 품명만으로도 32건이
동명이인이다. 그러나 **(품명 + 구 분류 경로)** 로 묶으면 DB 묶음과 시트 묶음의 키 집합이
정확히 같고, 한 묶음 안의 행들이 모두 같은 코드를 가리킨다 — 어느 행이 어느 행의 짝인지
몰라도 결과가 같다. 그래서 추측 없이 119건을 옮길 수 있다(docs/phase0-findings.md §4).
"""
from __future__ import annotations

import csv
import os
from dataclasses import dataclass, field

from db.models import ItemCategory, ItemMaster, Maker, Vendor
from services.item_taxonomy_data import MAJORS, PARTS

# 이 전환이 세우는 트리에는 속성(SB·BU)이 들어가지 않는다.
TREE_MAJORS = [m for m in MAJORS if m["tree_type"] in ("part", "service")]
MAJOR_BY_CODE = {m["code"]: m for m in MAJORS}
PART_BY_CODE = {p["code"]: p for p in PARTS}

MAP_CSV = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "scripts", "item_category_map.csv")


# 구 분류(계통) → 새 대분류. 거래선·제조사의 취급 분류 태그를 옮길 때 쓴다.
#
# 왜 표를 손으로 적는가. "그 노드에 있던 품목이 어디로 갔나"로 세어 봤더니 뜻이 어긋났다 —
# Deck Machinery > Crane 의 품목은 대부분 수리 용역비(TS)와 유압밸브(VP)였지만, 거기
# 태그가 붙은 회사는 **크레인을 대 주는 곳(DK)** 이다. 표본은 우리가 최근 무엇을 샀는가일
# 뿐이고, 태그는 그 회사가 무엇을 다루는가이다. 게다가 태그가 붙은 33개 노드 중 19개는
# 품목이 아예 없어 셀 것도 없다. 그래서 이름이 말하는 뜻을 적는다.
#
# 한 회사가 부품 하나만 다루는 일은 없으므로 **대분류로만** 옮긴다(부품 레벨까지 내리면
# "이 회사는 이 부품 하나만 다룬다"는 뜻이 된다).
LEGACY_TAG_MAJORS: dict[str, tuple[str, ...]] = {
    # 기관실
    "Engine Room": ("EN",),
    "Engine Room > Main Engine System": ("EN",),
    "Engine Room > Starting Air System": ("EN",),
    "Engine Room > Electrical Power System": ("EN",),
    "Engine Room > Fuel Oil System": ("EN", "AU"),
    "Engine Room > Lubricating Oil System": ("AU",),
    "Engine Room > Cooling Water System": ("HT",),
    "Engine Room > Hydraulic System": ("VP",),
    # 갑판·화물
    "Deck Machinery": ("DK",),
    "Deck Machinery > Crane": ("DK",),
    "Deck Machinery > Winch": ("DK",),
    "Deck Machinery > Windlass": ("DK",),
    "Deck Machinery > Mooring Equipment": ("DK",),
    "Deck Machinery > Liferaft & Davit": ("SF",),
    "Cargo & Tank System": ("DK",),
    "Cargo & Tank System > Cargo Pump": ("AU",),
    "Cargo & Tank System > Valve": ("VP",),
    "Cargo & Tank System > Pipe Line": ("VP",),
    "Cargo & Tank System > Tank": ("DK",),
    # 전장·선교
    "Electrical & Automation": ("EA",),
    "Electrical & Automation > Control Flow": ("EA",),
    "Electrical & Automation > Power Flow": ("EA",),
    "Bridge": ("NC",),
    "Bridge > Control": ("NC",),
    # 기타 기기 — 뿌리는 성격이 갈려 셋을 함께 단다(터보차저·보일러·환경설비).
    "Other Equipment": ("EN", "HT", "EV"),
    "Other Equipment > Turbocharger": ("EN",),
    "Other Equipment > Governor": ("EN",),
    "Other Equipment > Boiler": ("HT",),
    "Other Equipment > Incinerator": ("EV",),
    "Other Equipment > Scrubber": ("EV",),
    "Other Equipment > BWTS": ("EV",),
    "Other Equipment > OWS": ("EV",),
    "Other Equipment > Fire Fighting": ("SF",),
    "Other Equipment > Hatch Cover": ("DK",),
    "Other Equipment > Elevator": ("AO",),
    # 용역
    "Service": ("TS",),
    "Service > Technical Service": ("TS",),
    "Service > Labor & Travel": ("TS",),
    "Service > Workshop": ("TS",),
    "Service > Other Service": ("TS", "TR"),
}

# 위 표에 없는 노드는 뿌리 이름으로 떨어뜨린다 — 관리자가 만든 분류도 자리를 찾게.
LEGACY_ROOT_MAJORS: dict[str, tuple[str, ...]] = {
    "Engine Room": ("EN",),
    "Deck Machinery": ("DK",),
    "Cargo & Tank System": ("DK",),
    "Electrical & Automation": ("EA",),
    "Bridge": ("NC",),
    "Other Equipment": ("EN", "HT", "EV"),
    "Service": ("TS",),
}


def tag_majors(path: str) -> tuple[str, ...]:
    """구 분류 경로 → 그 태그가 뜻하는 대분류들. 모르면 빈 튜플(태그를 건드리지 않는다)."""
    p = " ".join((path or "").split())
    if p in LEGACY_TAG_MAJORS:
        return LEGACY_TAG_MAJORS[p]
    # 소분류까지 내려간 경로는 그 위(중분류)로 한 칸씩 올려 본다.
    parts = [x.strip() for x in p.split(">") if x.strip()]
    while len(parts) > 1:
        parts.pop()
        key = " > ".join(parts)
        if key in LEGACY_TAG_MAJORS:
            return LEGACY_TAG_MAJORS[key]
    return LEGACY_ROOT_MAJORS.get(parts[0] if parts else "", ())


def norm(v) -> str:
    """비교용 정규화 — 대소문자·군더더기 공백만 지운다(구두점은 뜻을 가른다)."""
    return " ".join(str(v or "").split()).strip().lower()


def category_path(cats: dict[int, ItemCategory], cid: int | None) -> str:
    """노드 id → '대 > 중 > 소' 경로. 순환이 있어도 멈춘다."""
    out: list[str] = []
    seen: set[int] = set()
    while cid and cid in cats and cid not in seen:
        seen.add(cid)
        out.append(cats[cid].name)
        cid = cats[cid].parent_id
    return " > ".join(reversed(out))


# ── Phase 2: 마스터 적재 ──────────────────────────────────────────────────────

def seed(s) -> dict:
    """대분류 13(품목 11 + 용역 2) · 부품 145 노드를 upsert 한다(재실행 안전).

    맞추는 열쇠는 `code` 다 — 이름은 사람이 고칠 수 있어도 코드는 그대로다. 이미 있는
    노드는 이름·정렬만 맞추고 id 는 그대로 둔다(품목·태그·문서가 그 id 를 가리킨다)."""
    by_code = {c.code: c for c in s.query(ItemCategory).filter(ItemCategory.code.isnot(None)).all()}
    out = {"major_new": 0, "major_same": 0, "part_new": 0, "part_same": 0}

    for m in TREE_MAJORS:
        node = by_code.get(m["code"])
        if node is None:
            node = ItemCategory(code=m["code"], parent_id=None, level=1)
            s.add(node)
            out["major_new"] += 1
        else:
            out["major_same"] += 1
        node.name = m["name_en"]
        node.name_ko = m["name_ko"]
        node.tree_type = m["tree_type"]
        node.sort_order = m["sort"]
        node.active = True
        node.parent_id = None
        node.level = 1
        by_code[m["code"]] = node
    s.flush()          # 부품이 대분류 id 를 가리켜야 하므로 먼저 확정한다

    for p in PARTS:
        parent = by_code.get(p["major"])
        if parent is None:      # 대분류가 없는 부품(있어선 안 되지만) — 건너뛴다
            continue
        node = by_code.get(p["code"])
        if node is None:
            node = ItemCategory(code=p["code"], level=2)
            s.add(node)
            out["part_new"] += 1
        else:
            out["part_same"] += 1
        node.name = p["name_en"]
        node.name_ko = p["name_ko"]
        node.tree_type = parent.tree_type
        node.hs_code = p["hs_code"]
        node.parent_id = parent.id
        node.sort_order = p["sort"]
        node.active = True
        node.level = 2
        by_code[p["code"]] = node
    s.flush()
    return out


# ── Phase 3: 119건 이관 ───────────────────────────────────────────────────────

@dataclass
class ItemMove:
    item: ItemMaster
    old_path: str
    new_code: str
    new_name: str
    verdict: str
    note: str
    to_service: bool = False


@dataclass
class TagMove:
    kind: str                 # vendor | maker
    row_id: int
    name: str
    old_ids: list[int]
    new_ids: list[int]
    basis: str                # items | name — 무엇을 근거로 옮겼나
    detail: str = ""


@dataclass
class Plan:
    items: list[ItemMove] = field(default_factory=list)
    missing: list[ItemMaster] = field(default_factory=list)   # 매핑에 없는 품목
    tags: list[TagMove] = field(default_factory=list)
    lines: int = 0            # 문서 JSON 에서 옮길 라인 수
    retire: list[ItemCategory] = field(default_factory=list)  # 내릴 구 노드


def load_map(path: str = MAP_CSV) -> list[dict]:
    with open(path, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def _target_code(row: dict) -> str:
    """그 행이 가리키는 노드 코드 — 부품코드가 있으면 그것, 없으면 대분류."""
    return (row.get("part_code") or "").strip() or (row.get("major") or "").strip()


def plan(s, rows: list[dict] | None = None) -> Plan:
    """무엇이 어디로 가는지 계산만 한다(쓰기 없음)."""
    rows = rows if rows is not None else load_map()
    cats = {c.id: c for c in s.query(ItemCategory).all()}
    by_code = {c.code: c for c in cats.values() if c.code}
    p = Plan()

    # ① 품목 — (품명 + 구 분류 경로) 묶음으로 짝을 찾는다.
    target: dict[tuple[str, str], dict] = {}
    for r in rows:
        target[(norm(r["description"]), norm(r["legacy_category"]))] = r

    for it in s.query(ItemMaster).order_by(ItemMaster.id).all():
        old_path = category_path(cats, it.category_id)
        row = target.get((norm(it.description), norm(old_path)))
        if row is None:
            p.missing.append(it)
            continue
        code = _target_code(row)
        node = by_code.get(code)
        if node is None:
            p.missing.append(it)
            continue
        major = MAJOR_BY_CODE.get(code.split("-")[0], {})
        p.items.append(ItemMove(
            item=it, old_path=old_path, new_code=code, new_name=node.name,
            verdict=(row.get("verdict") or "").strip(),
            note=(row.get("note") or "").strip(),
            # 용역인데 부품으로 서 있던 건(SVC) — 트리만 옮기면 통계는 그대로 오염된다.
            to_service=(major.get("tree_type") == "service" and (it.item_type or "part") != "service"),
        ))

    # ② 취급 분류 태그 — 구 분류 이름이 뜻하는 대분류로(LEGACY_TAG_MAJORS).
    for kind, Model in (("vendor", Vendor), ("maker", Maker)):
        for row in s.query(Model).all():
            old_ids = [int(x) for x in (getattr(row, "category_ids", None) or []) if str(x).isdigit()]
            if not old_ids:
                continue
            codes: list[str] = []
            unknown: list[str] = []
            for cid in old_ids:
                if cid in cats and cats[cid].code:
                    codes.append(cats[cid].code.split("-")[0])   # 이미 새 트리를 가리킴
                    continue
                path = category_path(cats, cid)
                got = tag_majors(path)
                if got:
                    codes += got
                else:
                    unknown.append(path or f"#{cid}")
            new_ids: list[int] = []
            for code in codes:
                node = by_code.get(code)
                if node and node.id not in new_ids:
                    new_ids.append(node.id)
            p.tags.append(TagMove(
                kind=kind, row_id=row.id, name=row.name or "",
                old_ids=old_ids, new_ids=new_ids,
                basis="name" if not unknown else ("name+unknown" if new_ids else "unknown"),
                detail=" / ".join(unknown[:4])))

    # ③ 문서 라인 JSON 의 category_id — 그 라인의 품목이 간 자리로 함께 보낸다.
    p.lines = _count_line_moves(s, line_key_map(p, by_code))

    # ④ 내릴 구 노드 — 새 트리에 속하지 않는 것 전부(지우지는 않는다).
    p.retire = [c for c in cats.values() if not c.code and c.active]
    return p


def line_key_map(p: Plan, by_code: dict[str, ItemCategory]) -> dict[str, int]:
    """문서 라인을 옮기는 열쇠 — 품번·품명으로 만든 식별키 → 그 품목의 새 노드 id.

    노드 단위로 옮기지 않는 이유: 구 노드는 뒤섞인 자루라(한 노드의 품목이 여섯 대분류로
    흩어진다) 노드만 보고는 어디로 보낼지 정할 수 없다. 라인은 결국 어떤 품목이므로,
    그 품목이 간 자리로 함께 보내면 추측이 없다.

    문서 라인을 고치는 것은 표시 때문만이 아니다. 라인의 category_id 는 문서를 저장할 때
    품목 마스터로 되돌아 반영되므로(services/item_ledger.apply_line_categories), 구 노드를
    남겨 두면 그 문서를 다시 저장하는 순간 품목이 옛 분류로 끌려간다."""
    from services.item_ledger import match_key
    out: dict[str, int] = {}
    for mv in p.items:
        node = by_code.get(mv.new_code)
        key = match_key(mv.item.part_no, mv.item.description)
        if node and key:
            out[key] = node.id
    return out


def _count_line_moves(s, keymap: dict[str, int]) -> int:
    from services.item_ledger import match_key
    if not keymap:
        return 0
    from db.models import RFQ, Order, PurchaseOrder, Quotation
    n = 0
    for Model in (RFQ, Quotation, Order, PurchaseOrder):
        for row in s.query(Model).all():
            for it in (row.items or []):
                if not isinstance(it, dict) or it.get("category_id") is None:
                    continue
                tgt = keymap.get(match_key(it.get("part_no"), it.get("description")) or "")
                if tgt and tgt != it.get("category_id"):
                    n += 1
    return n


def apply(s, p: Plan) -> dict:
    """계산해 둔 계획을 실제로 쓴다. 호출 전에 plan() 결과를 사람이 본 뒤에만."""
    out = {"items": 0, "to_service": 0, "tags": 0, "lines": 0, "retired": 0}
    by_code = {c.code: c for c in s.query(ItemCategory).all() if c.code}

    for mv in p.items:
        it = mv.item
        node = by_code[mv.new_code]
        # 구 자리를 먼저 남긴다 — 덮어쓴 뒤에는 어디 있었는지 알 길이 없다.
        it.legacy_category = mv.old_path[:300]
        it.legacy_category_id = it.category_id
        it.category_id = node.id
        it.migration_status = "REVIEW" if mv.verdict == "SVC" else "MIGRATED"
        it.migration_note = f"{mv.verdict}: {mv.note}"[:300] if mv.note else mv.verdict
        if mv.to_service:
            it.item_type = "service"
            out["to_service"] += 1
        out["items"] += 1
    s.flush()

    for t in p.tags:
        if not t.new_ids:
            continue        # 근거가 없으면 건드리지 않는다(구 태그를 그대로 둔다)
        Model = Vendor if t.kind == "vendor" else Maker
        row = s.query(Model).filter_by(id=t.row_id).first()
        if row:
            row.category_ids = list(t.new_ids)   # JSON 은 새 리스트로 갈아 끼운다
            out["tags"] += 1
    s.flush()

    out["lines"] = _apply_line_remap(s, line_key_map(p, by_code))

    for c in p.retire:
        c.active = False
        out["retired"] += 1
    s.flush()
    return out


def _apply_line_remap(s, keymap: dict[str, int]) -> int:
    """문서 JSON 안의 category_id 를 그 라인의 품목이 간 자리로 옮긴다.

    JSON 컬럼은 사본을 고쳐 통째로 대입해야 한다 — 읽어 온 값을 제자리에서 고치면
    flush 때 '바뀐 값'과 '읽어 온 값'이 같은 객체라 변경이 감지되지 않는다."""
    from services.item_ledger import match_key
    if not keymap:
        return 0
    from db.models import RFQ, Order, PurchaseOrder, Quotation
    n = 0
    for Model in (RFQ, Quotation, Order, PurchaseOrder):
        for row in s.query(Model).all():
            items = row.items or []
            changed = False
            fresh = []
            for it in items:
                if isinstance(it, dict) and it.get("category_id") is not None:
                    tgt = keymap.get(match_key(it.get("part_no"), it.get("description")) or "")
                    if tgt and tgt != it.get("category_id"):
                        it = {**it, "category_id": tgt}
                        changed = True
                        n += 1
                fresh.append(it)
            if changed:
                row.items = fresh
    return n
