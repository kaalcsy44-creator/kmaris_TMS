"""거래선 추천 — 딜 품목에 맞는 벤더를 취급품목(specialization)과 거래이력에서 고른다.

2단계(RFQ Sent)에서 "이 품목은 어디에 물어볼까"는 지금까지 사람 기억에 기댔다.
회사마다 취급 품목이 정해져 있고(Settings > Vendor > Specialization·회사소개), 우리가
어떤 품목을 어디에 물어보고 어디서 샀는지도 이미 쌓여 있다. 그 둘을 근거로 후보를
추려 준다. 고르는 건 여전히 사람이 하므로 점수만이 아니라 '왜'를 함께 돌려준다.

근거는 센 것부터:
  1) 같은 품번을 이미 산 곳 > 견적을 준 곳 > 물어본 곳
  2) 같은 분류(대>중>소)에서 거래한 이력이 있는 곳
  3) 취급품목·회사소개 글귀가 품목 낱말(제조사명 포함)과 겹치는 곳

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
    ItemCategory, ItemMaster, ItemPriceHistory, Vendor, VendorQuote, VendorRFQ,
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
_PART_MAX = 2          # 품번 근거는 두 건까지만 점수에 센다(한 벤더가 독식하지 않도록)
_CAT_MAX = 2
_TEXT_CAP = 40.0       # 글귀 매칭 상한 — 글로만 1등이 되지는 않게
_TEXT_UNIT = 14.0      # 한 벤더만 적어 둔 낱말(브랜드명 등)이 취급품목에서 맞았을 때의 값
_SPEC_W = 1.0          # 취급품목 한 줄은 회사소개 문단보다 무겁게 본다
_NOTE_W = 0.5
_MIN_SCORE = 6.0       # 이보다 약한 근거는 추천하지 않는다(빈칸이 헛다리보다 낫다)

_KIND_VERB = {"bought": "Supplied", "quoted": "Quoted", "asked": "Asked for"}


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


def _vendor_experience(session, cats: dict, idx: dict, masters: dict) -> dict[int, dict]:
    """벤더별 거래 경험 색인 — 어떤 품번을, 어떤 분류를, 어떤 세기로 다뤄 봤는가.

    출처는 셋이다: 구매 이력(item_price_history 의 buy 행) = 실제로 산 것,
    벤더 견적(vendor_quotes) = 값을 준 것, 벤더 RFQ(vendor_rfqs) = 물어본 것."""
    cat_of = {mid: m.category_id for mid, m in masters.items()}
    exp: dict[int, dict] = defaultdict(
        lambda: {"parts": {}, "cats": {}, "docs": set(), "deals": 0, "last": ""})

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
        touch(h.vendor_id, key, cid, "bought", h.doc_date or "")
        if h.vendor_id:
            exp[h.vendor_id]["docs"].add((h.source_type, h.source_id))

    quoted = {row[0] for row in session.query(VendorQuote.vendor_rfq_id).all()}
    for v in session.query(VendorRFQ).all():
        kind = "quoted" if v.id in quoted else "asked"
        when = (v.sent_at or "")[:10] or (v.sent_date or "")
        if v.vendor_id:
            exp[v.vendor_id]["docs"].add(("vrfq", v.id))
        for it in (v.items if isinstance(v.items, list) else []):
            if not isinstance(it, dict):
                continue
            key = match_key(it.get("part_no"), it.get("description"))
            cid = cat_of.get(idx.get(key, 0))
            touch(v.vendor_id, key, cid, kind, when)
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


def suggest_vendors(session, items, *, limit: int = 6, exclude_ids=()) -> dict:
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
    exp = _vendor_experience(session, cats, idx, masters)
    per_tokens, idf = _text_index(all_vendors)

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
        if v.id in excluded:
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

        # 3) 취급품목·회사소개 글귀가 품목 낱말과 겹친다.
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
            "id": v.id, "name": v.name, "email": v.email or "",
            "logo": getattr(v, "logo", None) or "",
            "specialization": v.specialization or "",
            "score": round(score, 1),
            "deals": (e["deals"] if e else 0),
            "last_date": last or "",
            "reasons": reasons,
        })

    out.sort(key=lambda r: (-r["score"], -r["deals"], r["name"]))
    top = out[:limit]
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
