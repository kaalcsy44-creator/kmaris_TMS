"""거래선 추천 — 딜 품목에 맞는 벤더를 취급품목(specialization)과 거래이력에서 고른다.

2단계(RFQ Sent)에서 "이 품목은 어디에 물어볼까"는 지금까지 사람 기억에 기댔다.
회사마다 취급 품목이 정해져 있고(Settings > Vendor > Specialization·회사소개), 우리가
어떤 품목을 어디에 물어보고 어디서 샀는지도 이미 쌓여 있다. 그 둘을 근거로 후보를
추려 준다. 고르는 건 여전히 사람이 하므로 점수만이 아니라 '왜'를 함께 돌려준다.

근거는 센 것부터:
  1) 같은 품번을 이미 산 곳 > 견적을 준 곳 > 물어본 곳
  2) 같은 분류(대>중>소)에서 거래한 이력이 있는 곳
  2-a) 같은 제조사 품목을 다뤄 본 곳(품번은 달라도 그 브랜드 것을 견적해 본 곳)
  3) 그 분류를 취급한다고 **밝혀 둔** 곳(Settings > Vendor 의 Item categories)
  3-a) 그것을 만드는 제조사의 **대리점**인 곳(Vendor 의 Makers supplied → Maker 의 분류)
  4) 취급품목·회사소개 글귀가 품목 낱말(제조사명 포함)과 겹치는 곳

3) 이 없으면 아직 거래가 없는 곳은 오직 글귀로만 걸린다 — 새로 등록한 벤더는 우리가
그 회사 소개에 무슨 낱말을 적어 두었는지에 운을 맡기게 된다. 태그는 그 회사가 스스로
말한 것이라 글귀보다 세지만, 실제로 거래해 본 것보다는 약하다.

낱말 매칭에서 '흔한 말'은 미리 적어 두지 않고 df(그 낱말이 등장하는 벤더 수)로 걸러
낸다 — 우리 벤더 목록에서 무엇이 흔한 말인지는 그 목록 자신이 안다. 거의 모든 벤더가
'marine·spare'를 적어 두었다면 그 낱말은 아무것도 가려내지 못한다.
"""
from __future__ import annotations

import math
import re
from collections import defaultdict
from datetime import date, timedelta

from db.models import (
    RFQ, ItemCategory, ItemMaster, ItemPriceHistory, Maker, Vendor, VendorQuote, VendorRFQ,
)
from services.item_ledger import build_master_index, match_key, suggest_categories

# 뜻을 담지 않는 말 — 문서 상투어·회사 형태, 그리고 어느 품목에나 붙는 뼈대 낱말.
# 흔한 업계 용어(marine·engine·spare…)는 여기 적지 않고 df 로 거른다. 다만 'system·unit'
# 처럼 몇 곳만 적어 두어 df 를 빠져나가면서도 아무것도 가리지 못하는 말은 손으로 뺀다.
# (낱말은 _stem 을 거친 뒤 대조되므로 단수형만 있어도 복수형이 함께 걸린다.)
_STOP = {
    "the", "and", "for", "with", "from", "that", "this", "not", "are", "its", "our",
    "all", "any", "has", "have", "was", "were", "also", "such", "into", "over",
    "co", "ltd", "inc", "corp", "corporation", "company", "gmbh", "pte", "llc",
    "www", "com", "net", "http", "https", "tel", "fax", "email", "mail",
    "system", "unit", "type", "model", "size", "assembly", "part", "item", "spare",
    "genuine", "equipment", "product", "supplier", "supply", "solution", "total",
    "global", "group", "office", "branch", "worldwide", "quality", "general", "other",
    "및", "등", "있는", "하는", "한다", "위한", "대한", "그리고", "또는", "이다",
    "공급", "제품", "기자재", "회사", "소재", "취급", "부품", "선박", "해양",
}

_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9&+]{2,}|[가-힣]{2,}")

# 근거 종류별 가중치. 같은 품번은 분류보다 세고, 실제 구매는 문의보다 세다.
_W_PART = {"bought": 45.0, "quoted": 30.0, "asked": 16.0}
_W_CAT = {"bought": 18.0, "quoted": 12.0, "asked": 7.0}
# 취급한다고 밝혀 둔 분류. 실제로 사 본 것(18)·값을 받아 본 것(12)보다는 약하고,
# 우리가 한 번 물어본 것(7)보다는 세다 — 물어본 것은 우리 짐작이지만 태그는 그 회사가
# 스스로 밝힌 것이라서다. 상위 분류만 맞으면 거래 이력과 같은 규칙으로 절반만 센다.
_W_DECLARED = 10.0
# 같은 제조사의 다른 품목을 다뤄 본 곳. 품번이 같지 않아도 그 브랜드 물건을 대 본
# 곳은 이번 것도 댈 공산이 크다 — 분류 이력(18/12/7)보다 세게 둔다. 분류는 '무엇'만
# 맞히지만 제조사는 '누구 것'까지 맞힌다(MAN B&W 피스톤과 Yanmar 피스톤은 다른 거래선).
# 품목 마스터에 분류가 아직 안 선 품목이 많아, 분류만으로는 이 이력이 아예 안 걸렸다.
_W_MAKER = {"bought": 24.0, "quoted": 18.0, "asked": 9.0}
_MAKER_MAX = 2
# 그 제조사의 대리점이라고 밝혀 둔 곳(Makers supplied 에 그 제조사가 바로 있다).
# 분류를 건너 추론하는 _W_AGENT 와 달리 이름이 곧장 맞으므로 태그보다 세다.
_W_AGENT_DIRECT = 14.0
# 그것을 만드는 제조사의 대리점이라고 밝혀 둔 곳(Makers supplied → 그 제조사의 분류).
# 태그(10)보다 약하다 — 한 다리 건넌 추론이라서다: 대리점이라고 그 브랜드의 모든
# 품목을 다 대는 것은 아니다. 그래도 우리가 한 번 물어본 이력(7)과 비슷하게는 둔다.
# 이 값 하나로도 추천에 설 수 있게 _MIN_SCORE(6.0) 와 같은 자리에 맞춘다 — 대리점이
# 그 브랜드 건으로 안 불려 나오면 이 칸을 적어 둔 뜻이 없다.
_W_AGENT = 6.0
_PART_MAX = 2          # 품번 근거는 두 건까지만 점수에 센다(한 벤더가 독식하지 않도록)
_CAT_MAX = 2
_DECLARED_MAX = 2      # 태그 근거도 두 개까지 — 널리 태그한 벤더가 독식하지 않도록
_AGENT_MAX = 2         # 대리점 근거도 두 개까지(같은 이유)
_TEXT_CAP = 40.0       # 글귀 매칭 상한 — 글로만 1등이 되지는 않게
_TEXT_UNIT = 14.0      # 한 벤더만 적어 둔 낱말(브랜드명 등)이 취급품목에서 맞았을 때의 값
_SPEC_W = 1.0          # 취급품목 한 줄은 회사소개 문단보다 무겁게 본다
_NOTE_W = 0.5
_MIN_SCORE = 6.0       # 이보다 약한 근거는 추천하지 않는다(빈칸이 헛다리보다 낫다)

_KIND_VERB = {"bought": "Supplied", "quoted": "Quoted", "asked": "Asked for"}


def _maker_key(name) -> str:
    """제조사 이름 대조용 키 — 'YUMYUNG Electric Co., Ltd.' -> 'yumyung electric'.
    회사 형태(co·ltd…)를 걷어 내야 같은 회사가 표기 차이로 갈리지 않는다."""
    return " ".join(_tokens(name))


def _maker_same(a: str, b: str) -> bool:
    """두 제조사 키가 같은 회사를 가리키는가. 한쪽 낱말이 다른 쪽에 다 들어 있으면
    같다고 본다 — 'yumyung' 과 'yumyung electric' 은 같은 회사다."""
    if not a or not b:
        return False
    if a == b:
        return True
    sa, sb = set(a.split()), set(b.split())
    return sa <= sb or sb <= sa


def _makers_in_text(text, known: dict) -> set[str]:
    """글귀(딜 제목 등)에 이름이 통째로 들어 있는 제조사 키. 품목 줄의 maker 칸을
    비워 두고 제목에만 'YUMYUNG Main Control Unit' 처럼 적는 일이 흔해서다."""
    words = set(_tokens(text))
    # 이름 첫 낱말(브랜드)만 맞으면 된다 — 제목에는 'YUMYUNG' 만 적고 명부에는
    # 'YUMYUNG Electric' 으로 올라 있는 식이 흔하다. 세 글자 브랜드(ABB·MAN 등)는
    # 품명 낱말과 우연히 겹치기 쉬워 글귀에서는 찾지 않는다 — 품목 줄의 maker 칸으로만 걸린다.
    out = set()
    for k in known:
        head = k.split()[0] if k else ""
        if len(head) >= 4 and head in words:
            out.add(k)
    return out


def _stem(word: str) -> str:
    """복수형만 걷어 낸다 — 'UNITS' 와 'unit' 이 서로를 못 알아보면 매칭이 헛돈다.
    영어 낱말의 뒤 s 하나면 충분하다(spares/valves/units). 'ss' 로 끝나면 둔다."""
    w = word.lower()
    if len(w) > 4 and w.endswith("s") and not w.endswith("ss"):
        return w[:-1]
    return w


def _tokens(text) -> list[str]:
    """매칭에 쓸 낱말 목록(소문자·복수형 정리). 'MAN B&W' -> ['man', 'b&w']."""
    out = []
    for t in _TOKEN_RE.findall(str(text or "")):
        w = _stem(t)
        if w not in _STOP:
            out.append(w)
    return out


def _chain(cats: dict, cid) -> list[int]:
    """분류 id -> 뿌리부터 그 노드까지의 id 사슬. 순환 방어(최대 5뎁스)."""
    out, cur, seen = [], (cats.get(cid) if cid else None), set()
    while cur is not None and cur.id not in seen and len(out) < 5:
        seen.add(cur.id)
        out.append(cur.id)
        cur = cats.get(cur.parent_id) if cur.parent_id else None
    return list(reversed(out))


def _path(cats: dict, cid) -> str:
    return " > ".join(cats[c].name for c in _chain(cats, cid) if c in cats)


def _best(a: str, b: str) -> str:
    """두 근거 종류 중 센 쪽. bought > quoted > asked."""
    order = {"asked": 1, "quoted": 2, "bought": 3}
    return a if order.get(a, 0) >= order.get(b, 0) else b


def _resolve_categories(session, lines: list[dict], cats: dict,
                        idx: dict, masters: dict) -> tuple[dict, list[dict]]:
    """딜 품목 -> {줄 식별키: 분류 id} 와 화면에 보여 줄 분류 요약.

    마스터에 분류가 서 있으면 그것을 쓰고, 없으면 item_ledger 의 추론(같은 품명·
    같은 품번 계열·품명 낱말)을 빌린다. 추론분은 guessed 로 표시해 근거의 세기를
    사람이 알아볼 수 있게 한다."""
    by_key: dict[str, int] = {}
    guessed: set[str] = set()
    unknown: list[dict] = []
    for ln in lines:
        key = ln["key"]
        if not key or key in by_key:
            continue
        m = masters.get(idx.get(key, 0))
        if m is not None and m.category_id:
            by_key[key] = m.category_id
        else:
            unknown.append({
                "item_id": m.id if m is not None else None,
                "part_no": ln["part_no"], "description": ln["description"],
                "maker": (m.maker if m is not None else "") or "",
                "item_type": (m.item_type if m is not None else "") or "",
            })
    if unknown:
        for r in suggest_categories(session, rows=unknown):
            key = match_key(r.get("part_no"), r.get("description"))
            if key and key not in by_key and r.get("category_id"):
                by_key[key] = r["category_id"]
                guessed.add(key)

    counts: dict[int, dict] = {}
    for ln in lines:
        cid = by_key.get(ln["key"])
        if not cid or cid not in cats:
            continue
        c = counts.setdefault(cid, {"id": cid, "name": cats[cid].name,
                                    "path": _path(cats, cid), "items": 0, "guessed": True})
        c["items"] += 1
        if ln["key"] not in guessed:
            c["guessed"] = False
    summary = sorted(counts.values(), key=lambda c: (-c["items"], c["path"]))
    return by_key, summary


def _rfq_makers(session) -> tuple[dict, dict, dict, dict]:
    """딜(고객 RFQ)별 품목 제조사 — 벤더 RFQ·매입 이력 줄에 maker 칸이 비어 있어도
    그 딜의 1단계 품목표에는 적혀 있는 일이 많다. 줄 키로 먼저, 안 되면 딜 전체로 쓴다.

    반환: ({rfq_id: {줄 키: 제조사 키}}, {rfq_id: {제조사 키}}, {rfq_id: 딜 제목},
           {제조사 키: 원래 표기}) — 마지막 것은 딜 제목에서 이름을 찾는 사전이 된다."""
    by_rfq_key: dict[int, dict[str, str]] = {}
    by_rfq: dict[int, set[str]] = {}
    titles: dict[int, str] = {}
    names: dict[str, str] = {}
    for rid, title, items in session.query(RFQ.id, RFQ.project_title, RFQ.items).all():
        by_key, allm = {}, set()
        for it in (items if isinstance(items, list) else []):
            if not isinstance(it, dict):
                continue
            mk = _maker_key(it.get("maker"))
            if mk:
                k = match_key(it.get("part_no"), it.get("description"))
                if k:
                    by_key.setdefault(k, mk)
                allm.add(mk)
                names.setdefault(mk, str(it.get("maker")).strip())
        by_rfq_key[rid], by_rfq[rid], titles[rid] = by_key, allm, title or ""
    return by_rfq_key, by_rfq, titles, names


def _vendor_experience(session, cats: dict, idx: dict, masters: dict,
                       known_makers: dict, rfq_makers: tuple) -> dict[int, dict]:
    """벤더별 거래 경험 색인 — 어떤 품번을, 어떤 분류를, 어떤 세기로 다뤄 봤는가.

    출처는 셋이다: 구매 이력(item_price_history 의 buy 행) = 실제로 산 것,
    벤더 견적(vendor_quotes) = 값을 준 것, 벤더 RFQ(vendor_rfqs) = 물어본 것.
    품번·분류와 함께 '어느 제조사 물건이었나'도 모은다(makers)."""
    cat_of = {mid: m.category_id for mid, m in masters.items()}
    maker_of = {mid: _maker_key(m.maker) for mid, m in masters.items()}
    exp: dict[int, dict] = defaultdict(
        lambda: {"parts": {}, "cats": {}, "makers": {}, "docs": set(), "deals": 0, "last": ""})

    rfq_mk_by_key, rfq_mk_all, rfq_title = rfq_makers

    def line_maker(raw_maker, key, item_id, rfq_id) -> str:
        return (_maker_key(raw_maker)
                or (rfq_mk_by_key.get(rfq_id) or {}).get(key, "")
                or maker_of.get(item_id or idx.get(key, 0), ""))

    def touch_maker(vid, mk, kind, when):
        if not (vid and mk):
            return
        m = exp[vid]["makers"]
        got = m.get(mk)
        m[mk] = ((_best(got[0], kind), got[1] + 1, max(got[2], when or ""))
                 if got else (kind, 1, when or ""))

    def touch(vid, key, cid, kind, when):
        if not vid:
            return
        e = exp[vid]
        when = when or ""
        if key:
            p = e["parts"].get(key)
            e["parts"][key] = (_best(p[0], kind), max(p[1], when)) if p else (kind, when)
        if cid and cid in cats:
            c = e["cats"].get(cid)
            if c:
                e["cats"][cid] = (_best(c[0], kind), c[1] + 1, max(c[2], when))
            else:
                e["cats"][cid] = (kind, 1, when)
        if when > e["last"]:
            e["last"] = when

    for h in (session.query(ItemPriceHistory)
              .filter(ItemPriceHistory.price_type == "buy",
                      ItemPriceHistory.vendor_id.isnot(None)).all()):
        key = match_key(h.part_no, h.description)
        cid = cat_of.get(h.item_id) if h.item_id else cat_of.get(idx.get(key, 0))
        # 매입 이력에는 발주(po)와 벤더 견적(vendor_quote)이 함께 들어 있다
        # (services/item_ledger). 둘을 안 가르면 견적만 주고 끝난 거래선이 근거란에
        # "Supplied …" 로 서고, bought(45)·quoted(30)의 점수 차이도 뜻을 잃는다.
        kind = "bought" if h.source_type == "po" else "quoted"
        touch(h.vendor_id, key, cid, kind, h.doc_date or "")
        touch_maker(h.vendor_id, line_maker("", key, h.item_id, h.rfq_id),
                    kind, h.doc_date or "")
        if h.vendor_id:
            exp[h.vendor_id]["docs"].add((h.source_type, h.source_id))

    quoted = {row[0] for row in session.query(VendorQuote.vendor_rfq_id).all()}
    for v in session.query(VendorRFQ).all():
        kind = "quoted" if v.id in quoted else "asked"
        when = (v.sent_at or "")[:10] or (v.sent_date or "")
        if v.vendor_id:
            exp[v.vendor_id]["docs"].add(("vrfq", v.id))
        found: set[str] = set()
        for it in (v.items if isinstance(v.items, list) else []):
            if not isinstance(it, dict):
                continue
            key = match_key(it.get("part_no"), it.get("description"))
            cid = cat_of.get(idx.get(key, 0))
            touch(v.vendor_id, key, cid, kind, when)
            mk = line_maker(it.get("maker"), key, None, v.rfq_id)
            if mk:
                found.add(mk)
        # 줄마다 제조사를 못 찾았으면 그 딜이 다룬 제조사로 갈음한다(품목표 → 딜 제목).
        if not found and v.rfq_id:
            found = set(rfq_mk_all.get(v.rfq_id) or ())
            if not found:
                found = _makers_in_text(rfq_title.get(v.rfq_id), known_makers)
        for mk in found:
            touch_maker(v.vendor_id, mk, kind, when)
    for e in exp.values():
        # 거래 건수 = 그 벤더가 얽힌 문서 수(발주·견적요청). 화면에 "몇 번 거래한 곳"으로 보인다.
        e["deals"] = len(e["docs"])
    return exp


def _text_index(vendors: list) -> tuple[dict, dict]:
    """벤더 글귀 색인 — {vendor_id: {낱말: 무게}} 와 {낱말: idf}.

    취급품목은 회사가 스스로 좁혀 적은 한 줄이라 회사소개 문단보다 무겁게 센다."""
    per: dict[int, dict[str, float]] = {}
    df: dict[str, int] = defaultdict(int)
    for v in vendors:
        w: dict[str, float] = {}
        for t in _tokens(v.specialization):
            w[t] = _SPEC_W
        for t in _tokens(v.note):
            w.setdefault(t, _NOTE_W)
        per[v.id] = w
        for t in w:
            df[t] += 1
    n = max(len(vendors), 1)
    ceiling = math.log(1.0 + n)     # 한 벤더만 적어 둔 낱말의 값 = 1.0 이 되도록 정규화한다.
    idf: dict[str, float] = {}
    for t, k in df.items():
        # 벤더 셋 중 하나꼴로 적어 둔 말은 아무도 가려내지 못한다 — 아예 뺀다.
        if k > max(2, n * 0.35):
            continue
        # 정규화해 두면 벤더 수가 늘어도 점수의 뜻(브랜드 하나 = 몇 점)이 흔들리지 않는다.
        idf[t] = math.log(1.0 + n / k) / ceiling if ceiling else 0.0
    return per, idf


def _maker_index(session) -> dict[int, tuple[str, set[int]]]:
    """메이커 줄 id → (회사 이름, 그 **회사**가 만든다고 적어 둔 분류 전부).

    makers.id 는 회사가 아니라 담당자 한 줄을 가리킨다. 거래선이 'Makers supplied' 에
    담아 둔 것도 그중 아무 줄의 id 라, 그 줄 하나만 보면 분류가 비어 있기 십상이다 —
    회사 단위 값(분류·소개)은 담당자 줄 어디에 적혀 있어도 되기 때문이다. 그래서 이름으로
    접어 그 회사의 모든 줄에서 분류를 모으고, 어느 줄의 id 로 물어도 같은 답을 준다."""
    by_name: dict[str, set[int]] = {}
    rows = session.query(Maker.id, Maker.name, Maker.category_ids).all()
    for _mid, name, cids in rows:
        key = " ".join((name or "").split()).lower()
        if not key:
            continue
        slot = by_name.setdefault(key, set())
        for x in (cids or []):
            try:
                slot.add(int(x))
            except (TypeError, ValueError):
                continue
    out: dict[int, tuple[str, set[int]]] = {}
    for mid, name, _cids in rows:
        key = " ".join((name or "").split()).lower()
        if key:
            out[mid] = ((name or "").strip(), by_name.get(key) or set())
    return out


def _company_key(name) -> str:
    """같은 회사인지 가릴 이름 키 — 대소문자·공백·문장부호 차이는 무시한다."""
    return re.sub(r"[^0-9a-z가-힣]+", "", (name or "").lower())


def suggest_vendors(session, items, *, limit: int = 6, exclude_ids=(),
                    title: str = "") -> dict:
    """딜 품목(1단계 Item list) -> 추천 벤더 목록과 그 근거."""
    lines = []
    for it in (items if isinstance(items, list) else []):
        if not isinstance(it, dict):
            continue
        pn = str(it.get("part_no") or "").strip()
        desc = str(it.get("description") or "").strip()
        if not (pn or desc):
            continue
        lines.append({
            "key": match_key(pn, desc), "part_no": pn, "description": desc,
            "text": " ".join([pn, desc, str(it.get("type") or ""), str(it.get("remark") or "")]),
        })
    if not lines:
        return {"categories": [], "vendors": [], "items": 0, "already_sent": 0}

    cats = {c.id: c for c in session.query(ItemCategory).all()}
    # 품목 마스터는 분류 판정과 거래이력 양쪽이 함께 쓴다 — 한 번만 읽어 돌려 쓴다.
    masters = {m.id: m for m in session.query(ItemMaster).all()}
    idx = build_master_index(session)
    cat_by_key, cat_summary = _resolve_categories(session, lines, cats, idx, masters)
    # 품목이 속한 분류와 그 조상 — 조상까지 보면 "같은 계통을 다뤄 본 곳"도 걸린다.
    want: set[int] = set()
    for cid in set(cat_by_key.values()):
        want.update(_chain(cats, cid))
    want_leaf = {cid for cid in cat_by_key.values() if cid in cats}

    excluded = {int(x) for x in exclude_ids}
    all_vendors = session.query(Vendor).order_by(Vendor.name).all()
    # 거래선은 레코드 하나가 담당자 한 명이다 — 같은 회사가 담당자 수만큼 줄지어 선다.
    # 추천은 "어느 회사에 물을까"이므로 회사(이름) 단위로 묶고, 이미 이 딜에서 그 회사의
    # 누군가에게 물었으면 다른 담당자도 뺀다.
    company_of = {v.id: _company_key(v.name) for v in all_vendors}
    asked = {company_of[i] for i in excluded if company_of.get(i)}
    makers = _maker_index(session)
    # 알려진 제조사 이름 — 명부(makers)와 품목 마스터의 maker 칸. 딜 제목에서 이름을
    # 찾아낼 때 쓴다. 키 -> 화면에 보일 원래 표기.
    known: dict[str, str] = {}
    for nm, _c in makers.values():
        known.setdefault(_maker_key(nm), nm)
    for m in masters.values():
        if m.maker:
            known.setdefault(_maker_key(m.maker), m.maker.strip())
    rfq_mk = _rfq_makers(session)
    for k, nm in rfq_mk[3].items():
        known.setdefault(k, nm)
    known.pop("", None)
    exp = _vendor_experience(session, cats, idx, masters, known, rfq_mk[:3])
    per_tokens, idf = _text_index(all_vendors)

    # 이 딜 품목의 제조사 — 품목 줄의 maker 칸, 마스터의 maker, 그리고 딜 제목·품명에
    # 이름이 통째로 적힌 제조사.
    deal_makers: dict[str, str] = {}
    for it in (items if isinstance(items, list) else []):
        if isinstance(it, dict) and _maker_key(it.get("maker")):
            deal_makers.setdefault(_maker_key(it.get("maker")), str(it.get("maker")).strip())
    for ln in lines:
        m = masters.get(idx.get(ln["key"], 0))
        if m is not None and _maker_key(m.maker):
            deal_makers.setdefault(_maker_key(m.maker), m.maker.strip())
    for mk in _makers_in_text(" ".join([title or ""] + [ln["text"] for ln in lines]), known):
        deal_makers.setdefault(mk, known[mk])

    # 품목 쪽 낱말 — 품명·품번·비고 + 분류 이름. 원래 대소문자는 근거 문구에 쓴다.
    query_w: dict[str, float] = defaultdict(float)
    display: dict[str, str] = {}
    for ln in lines:
        for t in _TOKEN_RE.findall(ln["text"]):
            w = _stem(t)
            if w in _STOP:
                continue
            query_w[w] = max(query_w[w], 1.0)
            display.setdefault(w, t)
    for c in cat_summary:
        for t in _TOKEN_RE.findall(c["path"]):
            w = _stem(t)
            if w in _STOP:
                continue
            # 분류 이름은 사람이 정리해 둔 말이라 품명 원문보다 믿을 만하다.
            query_w[w] = max(query_w[w], 1.5)
            display.setdefault(w, t)

    fresh = (date.today() - timedelta(days=365)).isoformat()
    out = []
    for v in all_vendors:
        if v.id in excluded or company_of.get(v.id) in asked:
            continue
        e = exp.get(v.id)
        score, reasons = 0.0, []

        # 1) 같은 품번을 다뤄 본 적이 있다.
        hits = []
        if e:
            seen_key = set()
            for ln in lines:
                got = e["parts"].get(ln["key"])
                if got and ln["key"] not in seen_key:
                    seen_key.add(ln["key"])
                    hits.append((got[0], got[1], ln["part_no"] or ln["description"]))
        # 센 근거 먼저, 같은 세기면 최근 것 먼저(문자열 날짜라 두 번에 나눠 정렬).
        hits.sort(key=lambda h: h[1], reverse=True)
        hits.sort(key=lambda h: -_W_PART[h[0]])
        for kind, when, label in hits[:_PART_MAX]:
            score += _W_PART[kind]
            tail = f" ({when[:7]})" if when else ""
            reasons.append({"kind": "part", "text": f"{_KIND_VERB[kind]} {label[:40]}{tail}"})
        if len(hits) > _PART_MAX:
            reasons.append({"kind": "part",
                            "text": f"+{len(hits) - _PART_MAX} more matching item(s)"})

        # 2) 같은 분류에서 거래한 적이 있다(잎이 맞으면 온전히, 상위만 맞으면 절반).
        cat_hits = []
        if e:
            for cid, (kind, n, _when) in e["cats"].items():
                if cid in want_leaf:
                    cat_hits.append((_W_CAT[kind], kind, n, cid, False))
                elif any(c in want for c in _chain(cats, cid)):
                    cat_hits.append((_W_CAT[kind] * 0.5, kind, n, cid, True))
        cat_hits.sort(key=lambda c: (-c[0], -c[2]))
        for w, _kind, n, cid, indirect in cat_hits[:_CAT_MAX]:
            score += w
            name = cats[cid].name if cid in cats else ""
            near = "related to " if indirect else ""
            reasons.append({"kind": "category", "text": f"{n} deal(s) in {near}{name}"})

        # 2-a) 같은 제조사의 물건을 다뤄 본 적이 있다(품번은 달라도).
        mk_hits = []
        if e and deal_makers:
            for mk, (kind, n, when) in e["makers"].items():
                label = next((deal_makers[d] for d in deal_makers if _maker_same(d, mk)), None)
                if label:
                    mk_hits.append((_W_MAKER[kind], kind, n, when, label))
        mk_hits.sort(key=lambda h: (-h[0], -h[2]))
        seen_mk: set[str] = set()
        for w, kind, n, when, label in mk_hits:
            if label in seen_mk or len(seen_mk) >= _MAKER_MAX:
                continue
            seen_mk.add(label)
            score += w
            tail = f" ({when[:7]})" if when else ""
            times = f" ×{n}" if n > 1 else ""
            reasons.append({"kind": "maker",
                            "text": f"{_KIND_VERB[kind]} {label} items{times}{tail}"})

        # 3) 그 분류를 취급한다고 밝혀 둔 곳. 거래 이력이 있으면 그쪽이 이미 세었으므로
        #    여기서는 아직 안 세어진 분류만 본다 — 같은 계통을 두 번 세면 태그만 널리
        #    달아 둔 벤더가 실제로 납품해 본 벤더를 앞지른다.
        counted = {c[3] for c in cat_hits[:_CAT_MAX]}
        dec_hits = []
        for cid in (getattr(v, "category_ids", None) or []):
            try:
                cid = int(cid)
            except (TypeError, ValueError):
                continue
            if cid in counted or cid not in cats:
                continue
            # 거래 이력과 판정이 다르다. 이력의 분류는 '그 벤더가 실제로 다룬 그 물건'
            # 이라 잎이 어긋나면 옆 가지일 뿐이지만, 태그는 중분류까지만 달기로 한
            # 값이다(VENDOR_TAG_LEVEL) — 'Main Engine System' 을 달아 둔 회사에게
            # 그 밑 'Piston' 은 옆 가지가 아니라 정확히 제 물건이다. 그래서 태그가
            # 품목 분류의 **조상이거나 그 자신**이면(= 품목의 뿌리→잎 사슬 위에 있으면)
            # 온전히 세고, 같은 계통의 다른 가지일 때만 절반으로 깎는다.
            if cid in want:
                dec_hits.append((_W_DECLARED, cid, False))
            elif any(c in want for c in _chain(cats, cid)):
                dec_hits.append((_W_DECLARED * 0.5, cid, True))
        dec_hits.sort(key=lambda d: -d[0])
        counted_dec = set(counted)
        for w, cid, indirect in dec_hits[:_DECLARED_MAX]:
            score += w
            counted_dec.add(cid)
            near = "related to " if indirect else ""
            reasons.append({"kind": "declared",
                            "text": f"Lists {near}{cats[cid].name} as their category"})

        # 3-a) 그것을 만드는 제조사의 대리점이다.
        #
        # 거래선의 'Makers supplied' 와 제조사의 분류를 잇는다 — "이 회사는 PANASIA 를
        # 대 주고, PANASIA 는 BWTS 를 만든다". 두 값 다 이미 적혀 있었는데 아무도 잇지
        # 않아, 대리점이라고 적어 둔 것이 추천에서는 아무 일도 하지 않았다.
        #
        # 베껴 두지 않고 물을 때마다 따라간다. 제조사의 분류를 고치면 그 대리점 전부가
        # 곧바로 따라오고, 같은 사실이 두 군데 적혀 어긋나는 일도 없다.
        ag_hits = []
        direct_ag: set[str] = set()
        for raw in (getattr(v, "maker_ids", None) or []):
            try:
                hit = makers.get(int(raw))
            except (TypeError, ValueError):
                continue
            if not hit:
                continue
            mk_name, mk_cats = hit
            mkk = _maker_key(mk_name)
            if mkk and any(_maker_same(d, mkk) for d in deal_makers):
                # 이름이 곧장 맞았으면 분류를 건넌 추론은 덧세지 않는다.
                if mkk not in direct_ag:
                    direct_ag.add(mkk)
                    score += _W_AGENT_DIRECT
                    reasons.append({"kind": "agent", "text": f"Agent for {mk_name}"})
                continue
            for cid in mk_cats:
                # 태그·이력이 이미 센 분류는 다시 세지 않는다(태그 쪽과 같은 규칙).
                if cid in counted_dec or cid not in cats:
                    continue
                if cid in want:
                    ag_hits.append((_W_AGENT, cid, mk_name, False))
                elif any(c in want for c in _chain(cats, cid)):
                    ag_hits.append((_W_AGENT * 0.5, cid, mk_name, True))
        ag_hits.sort(key=lambda a: -a[0])
        seen_ag: set[int] = set()
        for w, cid, mk_name, indirect in ag_hits:
            if cid in seen_ag:
                continue      # 같은 분류를 만드는 제조사를 둘 대 주어도 한 번만 센다
            seen_ag.add(cid)
            if len(seen_ag) > _AGENT_MAX:
                break
            score += w
            near = "related to " if indirect else ""
            reasons.append({"kind": "agent",
                            "text": f"Agent for {mk_name} — makes {near}{cats[cid].name}"})

        # 4) 취급품목·회사소개 글귀가 품목 낱말과 겹친다.
        tw = per_tokens.get(v.id) or {}
        matched = []
        text_score = 0.0
        for t, qw in query_w.items():
            if t in tw and t in idf:
                gain = _TEXT_UNIT * tw[t] * idf[t] * qw
                text_score += gain
                matched.append((gain, len(t), t))
        if matched:
            score += min(text_score, _TEXT_CAP)
            # 값이 같으면 긴 낱말이 먼저 — 'KOMECO' 가 'unit' 보다 근거로 읽힌다.
            matched.sort(reverse=True)
            top_words = matched[:3]
            words = ", ".join(display.get(t, t) for *_, t in top_words)
            where = "Specialization" if any(tw.get(t) == _SPEC_W for *_, t in top_words) else "Profile"
            reasons.append({"kind": "spec", "text": f"{where}: {words}"})

        if score < _MIN_SCORE or not reasons:
            continue
        last = e["last"] if e else ""
        if last >= fresh:
            score += 5.0     # 최근에도 거래가 이어지는 곳을 앞에 둔다.
        out.append({
            "id": v.id, "name": v.name, "contact": v.contact or "", "email": v.email or "",
            "logo": getattr(v, "logo", None) or "",
            "specialization": v.specialization or "",
            "score": round(score, 1),
            "deals": (e["deals"] if e else 0),
            "last_date": last or "",
            "reasons": reasons,
        })

    out.sort(key=lambda r: (-r["score"], -r["deals"], r["name"]))
    # 같은 회사의 담당자 레코드를 한 장으로 접는다. 대표는 점수가 가장 높은 레코드,
    # 근거는 담당자별로 갈라 쌓인 이력·태그를 합친다(문구가 같으면 한 번만).
    merged: dict[str, dict] = {}
    for r in out:
        key = company_of.get(r["id"]) or f"#{r['id']}"
        head = merged.get(key)
        if head is None:
            r["contact_ids"] = [r["id"]]
            r["contacts"] = [{"id": r["id"], "contact": r["contact"], "email": r["email"]}]
            merged[key] = r
            continue
        head["contact_ids"].append(r["id"])
        head["contacts"].append({"id": r["id"], "contact": r["contact"], "email": r["email"]})
        head["deals"] = max(head["deals"], r["deals"])
        head["last_date"] = max(head["last_date"], r["last_date"])
        head["logo"] = head["logo"] or r["logo"]
        seen = {x["text"] for x in head["reasons"]}
        head["reasons"] += [x for x in r["reasons"] if x["text"] not in seen]
    top = list(merged.values())[:limit]
    # 세기 표시는 절대 기준이다 — 1등 대비 상대값으로 매기면 약한 후보 하나뿐일 때
    # 그 하나가 ●●● 로 보인다. 값의 뜻: 산 적 있음 45, 같은 분류 거래 18, 브랜드 한 곳 14.
    for r in top:
        r["strength"] = ("high" if r["score"] >= 40 else
                         "medium" if r["score"] >= 14 else "low")
    return {
        "categories": cat_summary,
        "vendors": top,
        "items": len(lines),
        "already_sent": len(excluded),
    }
