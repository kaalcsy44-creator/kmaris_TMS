"""품목별 구매가·판매가 이력(item_price_history) 구축·집계.

각 딜 문서의 JSON 라인아이템을 part_no 로 item_master 에 매칭해 정규화한다.
파생(materialized) 테이블이라 소스 문서를 수정/삭제하면 즉시 반영되지 않으므로,
rebuild_price_history() 로 전체를 재구축한다(관리자 Rebuild / 배포 시 백필).

가격 소스(사용자 확정: 계약가·확정가 모두 포함):
  buy(구매가)  = vendor_quote(cost_price) · po(unit_price) · quotation(cost_price) · order(cost_price)
  sell(판매가) = quotation(unit_price) · order(unit_price) · ci(unit_price) · ar(unit_price)
"""
from __future__ import annotations

import re

from db.models import (
    ARRecord, CommercialInvoice, ItemCategory, ItemMaster, ItemPriceHistory, Order,
    PurchaseOrder, Quotation, RFQ, VendorQuote, VendorRFQ,
)


def _norm(v) -> str:
    """내부 공백 정리 + 대문자. 정규화 키 공용."""
    return re.sub(r"\s+", " ", str(v or "").strip().upper())


def part_key(v) -> str:
    """part_no 정규화 키."""
    return _norm(v)


def match_key(part_no, description) -> str:
    """품목 식별 키 — part_no 있으면 'P:'+part_no, 없으면 'D:'+description.

    서비스 항목(Service Charge·Travelling Charge 등)은 part_no 가 없고 description 으로
    식별되므로 description 을 대체 키로 쓴다. 둘 다 비면 '' (식별 불가)."""
    pk = _norm(part_no)
    if pk:
        return "P:" + pk
    dk = _norm(description)
    return ("D:" + dk) if dk else ""


# 용역(service)으로 볼 만한 낱말 — 배송할 물건이 없는 청구 항목.
# 부품명에도 흔한 낱말(repair kit, service tank 등)에 걸리지 않도록,
# 품번이 없는 항목에만 적용한다(guess_item_type 참고).
_SERVICE_WORDS = (
    "charge", "fee", "labor", "labour", "accommodation", "traveling", "travelling",
    "travel", "transportation", "attendance", "supervision", "supervisor", "technician",
    "engineer dispatch", "man-day", "manday", "overtime", "commissioning", "inspection",
    "출장", "숙박", "기술료", "인건비", "용역", "수수료", "운임",
)


def guess_item_type(part_no, description) -> str:
    """새 품목의 물품/용역 초기 구분. 확실할 때만 'service', 나머지는 'part'.

    품번이 있으면 물품으로 본다 — 'Repair Kit'·'Service Tank Valve' 처럼 부품명에
    용역 낱말이 섞이는 일이 흔해서, 품번 없는 항목에만 낱말 판정을 건다."""
    if _norm(part_no):
        return "part"
    d = str(description or "").lower()
    return "service" if any(w in d for w in _SERVICE_WORDS) else "part"


def _num(v, default: float = 0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def build_master_index(session) -> dict[str, int]:
    """식별키(part_no 또는 description) → item_master.id. 중복 시 가장 낮은 id."""
    idx: dict[str, int] = {}
    for m in session.query(ItemMaster).order_by(ItemMaster.id).all():
        k = match_key(m.part_no, m.description)
        if k and k not in idx:
            idx[k] = m.id
    return idx


def _iter_lines(items):
    """JSON items 배열을 (idx, line) 로 순회. 비정상값 방어."""
    if not isinstance(items, list):
        return
    for i, it in enumerate(items):
        if isinstance(it, dict):
            yield i, it


def rebuild_price_history(session) -> int:
    """item_price_history 전체 재구축(멱등). 반환=생성 행수."""
    master = build_master_index(session)
    rfq_by_id = {r.id: r for r in session.query(RFQ).all()}
    order_by_id = {o.id: o for o in session.query(Order).all()}
    vrfq_by_id = {v.id: v for v in session.query(VendorRFQ).all()}

    rows: list[dict] = []

    def emit(price_type, source_type, source_id, idx, line, price_field, *,
             currency, fx_rate=None, date=None, rfq_id=None,
             customer_id=None, vendor_id=None, vessel_id=None):
        pn = (line.get("part_no") or "").strip()
        unit = _num(line.get(price_field))
        # 문서별로 매입/판매 단가 필드명이 섞일 수 있어(예: PO는 unit_price에 매입가) 보정.
        if unit == 0.0:
            alt = "unit_price" if price_field == "cost_price" else "cost_price"
            unit = _num(line.get(alt))
        if not pn and unit == 0.0:
            return  # 빈 라인 스킵
        qty = _num(line.get("qty"), 1.0)
        amt = line.get("amount")
        amount = _num(amt) if amt not in (None, "") else unit * qty
        desc = (line.get("description") or "")
        rows.append({
            "item_id": master.get(match_key(pn, desc)),
            "price_type": price_type,
            "source_type": source_type,
            "source_id": source_id,
            "source_line_idx": idx,
            "part_no": pn[:200],
            "description": (line.get("description") or "")[:400],
            "rfq_id": rfq_id,
            "customer_id": customer_id,
            "vendor_id": vendor_id,
            "vessel_id": vessel_id,
            "currency": currency or "USD",
            "fx_rate": fx_rate,
            "unit_price": unit,
            "qty": qty,
            "amount": amount,
            "doc_date": (date or "")[:10] or None,
        })

    # ── buy: vendor_quote (공급사 수신 견적, cost_price) ──────────────────
    for vq in session.query(VendorQuote).all():
        vr = vrfq_by_id.get(vq.vendor_rfq_id)
        rfq = rfq_by_id.get(vr.rfq_id) if vr else None
        for idx, line in _iter_lines(vq.items):
            emit("buy", "vendor_quote", vq.id, idx, line, "cost_price",
                 currency=vq.currency, fx_rate=vq.fx_rate, date=vq.received_date,
                 rfq_id=(vr.rfq_id if vr else None),
                 customer_id=(rfq.customer_id if rfq else None),
                 vendor_id=(vr.vendor_id if vr else None),
                 vessel_id=(rfq.vessel_id if rfq else None))

    # ── buy: purchase_order (발주, unit_price=매입단가) ───────────────────
    for po in session.query(PurchaseOrder).all():
        o = order_by_id.get(po.order_id)
        for idx, line in _iter_lines(po.items):
            emit("buy", "po", po.id, idx, line, "unit_price",
                 currency=(po.currency or (o.currency if o else None)), date=po.date,
                 rfq_id=(o.rfq_id if o else None),
                 customer_id=(o.customer_id if o else None),
                 vendor_id=po.vendor_id,
                 vessel_id=(o.vessel_id if o else None))

    # ── quotation: sell(unit_price) + buy(cost_price, 견적 시점 원가) ─────
    for q in session.query(Quotation).all():
        for idx, line in _iter_lines(q.items):
            emit("sell", "quotation", q.id, idx, line, "unit_price",
                 currency=q.currency, fx_rate=q.fx_rate, date=q.date,
                 rfq_id=q.rfq_id, customer_id=q.customer_id, vessel_id=q.vessel_id)
            if _num(line.get("cost_price")) > 0:
                emit("buy", "quotation", q.id, idx, line, "cost_price",
                     currency=(q.cost_currency or q.currency), fx_rate=q.fx_rate, date=q.date,
                     rfq_id=q.rfq_id, customer_id=q.customer_id, vessel_id=q.vessel_id)

    # ── order: sell(unit_price) + buy(cost_price) ─────────────────────────
    for o in session.query(Order).all():
        for idx, line in _iter_lines(o.items):
            emit("sell", "order", o.id, idx, line, "unit_price",
                 currency=o.currency, date=o.date,
                 rfq_id=o.rfq_id, customer_id=o.customer_id, vessel_id=o.vessel_id)
            if _num(line.get("cost_price")) > 0:
                emit("buy", "order", o.id, idx, line, "cost_price",
                     currency=o.currency, date=o.date,
                     rfq_id=o.rfq_id, customer_id=o.customer_id, vessel_id=o.vessel_id)

    # ── sell: commercial_invoice ──────────────────────────────────────────
    for ci in session.query(CommercialInvoice).all():
        o = order_by_id.get(ci.order_id)
        for idx, line in _iter_lines(ci.items):
            emit("sell", "ci", ci.id, idx, line, "unit_price",
                 currency=ci.currency, date=ci.date,
                 rfq_id=(o.rfq_id if o else None),
                 customer_id=(o.customer_id if o else None),
                 vessel_id=(o.vessel_id if o else None))

    # ── sell: ar_record (대금청구서/세금계산서) ────────────────────────────
    for ar in session.query(ARRecord).all():
        o = order_by_id.get(ar.order_id)
        for idx, line in _iter_lines(ar.items):
            emit("sell", "ar", ar.id, idx, line, "unit_price",
                 currency=ar.currency, date=(ar.invoice_date or ar.due_date),
                 rfq_id=(o.rfq_id if o else None),
                 customer_id=(o.customer_id if o else None),
                 vessel_id=(o.vessel_id if o else None))

    # 전체 교체(파생 테이블이라 delete+insert 가 가장 단순하고 일관적).
    session.query(ItemPriceHistory).delete()
    session.flush()
    if rows:
        session.bulk_insert_mappings(ItemPriceHistory, rows)
    session.commit()
    return len(rows)


def stamp_history_item(session, item_id: int) -> int:
    """해당 item_master 의 part_no 와 정규화 일치하는 '미연결' 이력 행을 item_id 로 연결.

    분류 화면에서 미연결 품목에 분류를 배정할 때 호출 — 전체 rebuild 없이 즉시 매칭.
    반환=갱신 행수. commit 은 호출자 책임."""
    m = session.query(ItemMaster).filter_by(id=item_id).first()
    if not m:
        return 0
    key = match_key(m.part_no, m.description)
    if not key:
        return 0
    n = 0
    for h in session.query(ItemPriceHistory).filter(ItemPriceHistory.item_id.is_(None)).all():
        if match_key(h.part_no, h.description) == key:
            h.item_id = item_id
            n += 1
    return n


def apply_line_categories(session, items) -> int:
    """문서 라인아이템에 담긴 category_id 를 품목 마스터 분류로 반영한다.

    RFQ·견적·오더·발주서 저장 시 호출 — 입력 단계에서 고른 분류(선택 사항)를 그 자리에서
    마스터에 세워, 나중에 Item > Category 화면에서 다시 배정할 일을 없앤다.
      · 식별키(part_no, 없으면 description) 로 마스터를 찾고 없으면 새로 만든다.
      · 이미 같은 분류면 건드리지 않는다(불필요한 쓰기 방지).
      · 그 뒤 같은 키의 미연결 가격이력을 이 마스터로 스탬프.
    반환 = 분류를 반영한 라인 수. commit 은 호출자 책임."""
    lines = [
        (match_key(it.get("part_no"), it.get("description")), it)
        for _, it in _iter_lines(items)
        if it.get("category_id") is not None
    ]
    lines = [(k, it) for k, it in lines if k]
    if not lines:
        return 0

    masters = session.query(ItemMaster).order_by(ItemMaster.id).all()
    by_key: dict[str, ItemMaster] = {}
    for m in masters:
        k = match_key(m.part_no, m.description)
        if k and k not in by_key:
            by_key[k] = m

    n = 0
    for key, line in lines:
        try:
            cat_id = int(line["category_id"])
        except (TypeError, ValueError):
            continue
        master = by_key.get(key)
        if master is None:
            master = ItemMaster(
                part_no=(line.get("part_no") or "").strip(),
                description=(line.get("description") or "").strip(),
                maker=(line.get("maker") or ""),
                unit=(line.get("unit") or "PCS"),
                item_type=guess_item_type(line.get("part_no"), line.get("description")),
                category_id=cat_id,
            )
            session.add(master)
            session.flush()
            by_key[key] = master
        elif master.category_id != cat_id:
            master.category_id = cat_id
        else:
            continue   # 이미 같은 분류 — 스탬프만 필요하면 아래 rebuild 가 처리
        stamp_history_item(session, master.id)
        n += 1
    return n


def _sort_key(h):
    """최신순 정렬 키 — 거래일(없으면 빈문자=가장 과거) 그다음 id."""
    return (h.doc_date or "", h.id)


def _summarize(hs: list) -> dict:
    """이력 행 묶음 → 최근 구매가·판매가 + 거래 카운트 + 최근일."""
    buys = sorted([h for h in hs if h.price_type == "buy"], key=_sort_key, reverse=True)
    sells = sorted([h for h in hs if h.price_type == "sell"], key=_sort_key, reverse=True)

    def one(x):
        if not x:
            return None
        return {
            "unit_price": x.unit_price, "currency": x.currency,
            "date": x.doc_date, "fx_rate": x.fx_rate,  # 딜 저장 환율(있으면 마진 환산에 우선 사용)
        }

    dates = [h.doc_date for h in hs if h.doc_date]
    return {
        "buy": one(buys[0] if buys else None),
        "sell": one(sells[0] if sells else None),
        "buy_count": len(buys),
        "sell_count": len(sells),
        "last_date": max(dates) if dates else None,
    }


def ledger_rows(session) -> dict:
    """분류별 품목 롤업. matched(마스터 연결) + unmatched(part_no 미연결) 로 분리."""
    masters = {m.id: m for m in session.query(ItemMaster).all()}
    matched: dict[int, list] = {}
    unmatched: dict[str, list] = {}
    for h in session.query(ItemPriceHistory).all():
        if h.item_id:
            matched.setdefault(h.item_id, []).append(h)
        else:
            # part_no 없으면 description 으로 묶는다(서비스 항목). 둘 다 없으면 행 단위.
            unmatched.setdefault(match_key(h.part_no, h.description) or f"#{h.id}", []).append(h)

    items = []
    for item_id, hs in matched.items():
        m = masters.get(item_id)
        items.append({
            "item_id": item_id,
            "part_no": (m.part_no if m else hs[0].part_no) or "",
            "description": (m.description if m else hs[0].description) or "",
            "maker": (m.maker if m else "") or "",
            "category_id": (m.category_id if m else None),
            **_summarize(hs),
        })
    items.sort(key=lambda r: r["part_no"])

    un = []
    for hs in unmatched.values():
        un.append({
            "part_no": hs[0].part_no or "",
            "description": hs[0].description or "",
            **_summarize(hs),
        })
    un.sort(key=lambda r: (r["part_no"], r["description"]))
    return {"items": items, "unmatched": un}


def item_history(
    session, *, item_id: int | None = None,
    part_no: str | None = None, description: str | None = None,
) -> list[dict]:
    """한 품목의 buy/sell 이력 행 전체(최신순).

    item_id 있으면 그 마스터 이력. 없으면 (part_no, description) 식별키로 미연결 이력 조회."""
    if item_id:
        rows = session.query(ItemPriceHistory).filter(ItemPriceHistory.item_id == item_id).all()
        return _history_out(sorted(rows, key=_sort_key, reverse=True))
    key = match_key(part_no, description)
    if not key:
        return []
    rows = [
        h for h in session.query(ItemPriceHistory).filter(ItemPriceHistory.item_id.is_(None)).all()
        if match_key(h.part_no, h.description) == key
    ]
    return _history_out(sorted(rows, key=_sort_key, reverse=True))


def _history_out(rows: list) -> list[dict]:
    return [{
        "id": h.id,
        "price_type": h.price_type,
        "source_type": h.source_type,
        "source_id": h.source_id,
        "rfq_id": h.rfq_id,
        "customer_id": h.customer_id,
        "vendor_id": h.vendor_id,
        "vessel_id": h.vessel_id,
        "part_no": h.part_no or "",
        "description": h.description or "",
        "currency": h.currency or "USD",
        "fx_rate": h.fx_rate,
        "unit_price": h.unit_price or 0.0,
        "qty": h.qty or 0.0,
        "amount": h.amount or 0.0,
        "doc_date": h.doc_date,
    } for h in rows]


def master_price_summary(session) -> dict[int, dict]:
    """item_master.id → 최근 구매가·판매가 + 최근 거래 상대(고객·공급사).

    Item Master 목록의 Customer·Vendor·Purchase/Sales Price·Margin 열 값 원천.
    가격은 마스터에 연결된(item_id) 이력만 본다(미연결 이력은 Item > Category 화면 담당).
      · Customer = 가장 최근 '판매' 행의 고객(없으면 고객이 찍힌 가장 최근 행)
      · Vendor   = 가장 최근 '구매' 행의 공급사(견적·오더 원가처럼 공급사가 없는
                   구매 행도 있어, 공급사가 찍힌 가장 최근 행으로 대체)
    """
    cols = session.query(
        ItemPriceHistory.item_id, ItemPriceHistory.price_type,
        ItemPriceHistory.unit_price, ItemPriceHistory.currency, ItemPriceHistory.fx_rate,
        ItemPriceHistory.doc_date, ItemPriceHistory.customer_id, ItemPriceHistory.vendor_id,
        ItemPriceHistory.id,
    ).filter(ItemPriceHistory.item_id.isnot(None)).all()

    by_item: dict[int, list] = {}
    for r in cols:
        by_item.setdefault(r.item_id, []).append(r)

    def newest(rows: list):
        return max(rows, key=lambda r: (r.doc_date or "", r.id)) if rows else None

    out: dict[int, dict] = {}
    for item_id, rows in by_item.items():
        buys = [r for r in rows if r.price_type == "buy"]
        sells = [r for r in rows if r.price_type == "sell"]
        b, sl = newest(buys), newest(sells)
        cust = newest([r for r in sells if r.customer_id]) or newest([r for r in rows if r.customer_id])
        vend = newest([r for r in buys if r.vendor_id]) or newest([r for r in rows if r.vendor_id])

        def price(r):
            if r is None:
                return None
            return {
                "unit_price": r.unit_price or 0.0, "currency": r.currency or "USD",
                "date": r.doc_date, "fx_rate": r.fx_rate,
            }

        out[item_id] = {
            "buy": price(b),
            "sell": price(sl),
            "customer_id": cust.customer_id if cust else None,
            "vendor_id": vend.vendor_id if vend else None,
        }
    return out


# ── 미분류 품목 자동 분류(제안) ────────────────────────────────────────────────
# 규칙을 새로 만들지 않는다. 이미 분류해 둔 품목과 분류 이름이 근거다 —
# 회사마다 다른 분류 체계를 코드에 박아 두면 트리를 고칠 때마다 코드가 따라 죽는다.
#
# 근거는 셋, 확신이 큰 순서대로 먼저 잡히는 하나를 쓴다:
#   1) same-desc  — 같은 품명이 이미 분류돼 있다(품번만 다른 같은 물건).
#   2) part-family— 같은 품번 계열(앞부분)의 분류가 하나로 모여 있다.
#   3) name-word  — 품명이 분류 이름의 낱말을 품는다(Ball Bearing → Bearing & bushing).
#                   계열이 정해졌으면 그 계열 아래 소분류에서만 찾는다.

# 분류 이름에서 지워도 뜻이 남는 낱말 — 이런 낱말로 붙는 매칭은 근거가 되지 않는다.
_CAT_STOPWORDS = {
    "and", "or", "etc", "other", "others", "misc", "general", "parts", "part",
    "kit", "kits", "item", "items", "기타", "부품", "일반",
}


def _cat_words(name: str) -> set[str]:
    """분류 이름 → 판정에 쓸 낱말 집합('Seal & gasket' → {seal, gasket})."""
    words = re.split(r"[^0-9a-zA-Z가-힣]+", (name or "").lower())
    return {w for w in words if len(w) > 2 and w not in _CAT_STOPWORDS}


def part_family(part_no) -> str:
    """품번의 계열 키 — 앞쪽 영숫자 덩어리('B6DS0939 101' → 'B6DS0939').

    같은 엔진·기기의 부품표는 앞부분을 공유하고 뒤가 도면번호로 갈린다. 그래서
    계열이 같으면 대·중분류(Engine > 4-stroke)가 같다고 보아도 어긋나는 일이 드물다.
    구분자가 없는 품번은 통째로 하나의 계열이 된다(길이 4 미만이면 계열로 안 본다)."""
    pk = part_key(part_no)
    if not pk:
        return ""
    head = re.split(r"[ \-_/]", pk)[0]
    return head if len(head) >= 4 else ""


def _majority(cids: list[int]) -> tuple[int | None, int, int]:
    """가장 많이 나온 분류 id 와 (그 개수, 전체 개수). 비어 있으면 (None, 0, 0)."""
    if not cids:
        return None, 0, 0
    best, n = None, 0
    for c in set(cids):
        k = cids.count(c)
        if k > n:
            best, n = c, k
    return best, n, len(cids)


def _chain(cats: dict, cid: int) -> list[int]:
    """분류 id → 뿌리부터 그 노드까지의 id 사슬([대, 중, 소])."""
    out, cur, guard = [], cats.get(cid), 0
    while cur is not None and guard < 5:
        out.append(cur.id)
        cur = cats.get(cur.parent_id) if cur.parent_id else None
        guard += 1
    return list(reversed(out))


def _pick(cats: dict, cids: list[int]) -> tuple[int | None, str]:
    """분류 후보 묶음 → (고른 분류, 근거 꼬리말).

    과반이면 그 분류를 쓰고, 갈리면 모두가 공유하는 가장 깊은 상위로 물러선다 —
    같은 계열이 'Bearing & bushing' 과 'Seal & gasket' 로 갈렸어도 'Engine > 4-stroke'
    까지는 확실하다. 뿌리부터 갈리면 근거가 없는 것으로 본다."""
    if not cids:
        return None, ""
    best, n, tot = _majority(cids)
    if best and n * 2 > tot:
        return best, f"{n} item(s)"
    prefix = _chain(cats, cids[0])
    for c in cids[1:]:
        ch = _chain(cats, c)
        i = 0
        while i < len(prefix) and i < len(ch) and prefix[i] == ch[i]:
            i += 1
        prefix = prefix[:i]
        if not prefix:
            return None, ""
    return (prefix[-1], f"{len(cids)} item(s), common parent") if prefix else (None, "")


def suggest_categories(session, *, rows: list[dict] | None = None) -> list[dict]:
    """미분류 품목별 분류 제안 목록.

    대상 = (1) 마스터에 있으나 분류가 빈 품목, (2) 마스터에 없는 미연결 품목.
    반환 행은 assign 엔드포인트가 그대로 먹을 수 있는 모양(item_id 또는 part_no)에
    제안 분류와 근거를 붙인 것. 근거를 못 찾은 품목은 목록에서 뺀다 —
    아무 데나 넣는 것보다 비워 두는 편이 낫다."""
    cats = {c.id: c for c in session.query(ItemCategory).all()}
    masters = session.query(ItemMaster).all()

    # 이미 분류된 품목에서 배운다.
    by_desc: dict[str, list[int]] = {}
    by_family: dict[str, list[int]] = {}
    for m in masters:
        if not m.category_id or m.category_id not in cats:
            continue
        d = _norm(m.description)
        if d:
            by_desc.setdefault(d, []).append(m.category_id)
        fam = part_family(m.part_no)
        if fam:
            by_family.setdefault(fam, []).append(m.category_id)

    # 분류 이름 낱말 색인(잎 분류 우선 — 깊을수록 구체적이다).
    cat_words = {cid: _cat_words(c.name) for cid, c in cats.items() if c.active is not False}

    def ancestors(cid: int | None) -> set[int]:
        out, cur, guard = set(), cats.get(cid) if cid else None, 0
        while cur is not None and guard < 5:
            out.add(cur.id)
            cur = cats.get(cur.parent_id) if cur.parent_id else None
            guard += 1
        return out

    def by_name(desc: str, within: int | None) -> tuple[int | None, str]:
        """품명이 품은 분류 이름 낱말로 찾기. within 이 있으면 그 하위에서만."""
        d = _norm(desc).lower()
        if not d:
            return None, ""
        best, best_key = None, ()
        for cid, words in cat_words.items():
            hit = {w for w in words if w in d}
            if not hit:
                continue
            if within is not None and within not in ancestors(cid) - {cid}:
                continue
            c = cats[cid]
            # 더 깊은(구체적인) 분류, 더 많이 맞은 낱말, 더 긴 낱말 순.
            key = (c.level or 0, len(hit), max(len(w) for w in hit))
            if best is None or key > best_key:
                best, best_key = cid, key
        return best, (", ".join(sorted(w for w in cat_words[best] if w in d)) if best else "")

    if rows is None:
        # 대상 = 분류가 빈 마스터 전체(거래 이력이 아직 없는 품목도 포함) + 마스터에
        # 없는 미연결 이력. 앞은 Item Master 목록의 빈칸, 뒤는 이 화면의 Unmatched 다.
        rows = [{
            "item_id": m.id, "part_no": m.part_no or "",
            "description": m.description or "", "maker": m.maker or "",
        } for m in masters if not m.category_id]
        rows += ledger_rows(session)["unmatched"]

    out: list[dict] = []
    for r in rows:
        desc, pn = r.get("description") or "", r.get("part_no") or ""
        cid: int | None = None
        reason = ""
        # 1) 같은 품명이 이미 분류돼 있다.
        c, why = _pick(cats, by_desc.get(_norm(desc)) or [])
        if c:
            cid, reason = c, f"same description — {why}"
        # 2) 같은 품번 계열이 한 분류(또는 한 상위)로 모여 있다.
        fam = part_family(pn)
        if cid is None and fam:
            c, why = _pick(cats, by_family.get(fam) or [])
            if c:
                # 계열이 정하는 건 보통 대·중분류다. 품명이 그 아래 소분류를 가리키면 더 깊게.
                deeper, hit = by_name(desc, c)
                if deeper:
                    cid, reason = deeper, f"part family {fam} — {why} + name “{hit}”"
                else:
                    cid, reason = c, f"part family {fam} — {why}"
        # 3) 품명이 분류 이름을 품는다.
        if cid is None:
            c, hit = by_name(desc, None)
            if c:
                cid, reason = c, f"name contains “{hit}”"
        if cid is None:
            continue
        out.append({
            "item_id": r.get("item_id"),
            "part_no": pn,
            "description": desc,
            "maker": r.get("maker") or "",
            "category_id": cid,
            "reason": reason,
        })
    out.sort(key=lambda r: (r["part_no"], r["description"]))
    return out
