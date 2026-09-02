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
import threading

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


# 이력·마스터가 실제로 담을 수 있는 길이(db.models 의 컬럼 정의와 같아야 한다).
# 키를 만들 때도 저장할 때도 이 길이로 자른 값을 쓴다 — 둘이 어긋나면 긴 설명을 가진
# 품목은 영영 마스터에 붙지 못한다(아래 fit_desc 주석 참고).
PART_MAX, DESC_MAX = 200, 400


def fit_part(v) -> str:
    """이력·마스터에 담을 수 있는 길이로 자른 품번."""
    return (v or "")[:PART_MAX]


def fit_desc(v) -> str:
    """이력·마스터에 담을 수 있는 길이로 자른 설명.

    자르는 것 자체보다 **어디서 자르느냐가 같아야 한다**는 것이 요점이다. 예전에는
    이력 행을 세울 때 키는 원문으로 만들고 저장은 400자로 잘라 넣었다. 그러면 설명이
    400자를 넘는 품목(품번 없는 용역이 흔히 그렇다)은:
      · 화면에는 잘린 설명이 보이고, 사람은 그것으로 분류를 배정한다
      · 마스터는 잘린 설명으로 만들어진다
      · 그런데 다음 재구축이 원문으로 키를 만들어 그 마스터를 못 찾는다
      · 배정한 품목이 미분류로 되돌아온다 — 몇 번을 배정해도 같다
    양쪽이 같은 값을 보게 해서 그 고리를 끊는다.
    """
    return (v or "")[:DESC_MAX]


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
        # 저장할 값 그대로 키를 만든다(자르기 전 원문으로 만들면 저장된 행과 어긋난다).
        desc = fit_desc(line.get("description"))
        pn = fit_part(pn)
        rows.append({
            "item_id": master.get(match_key(pn, desc)),
            "price_type": price_type,
            "source_type": source_type,
            "source_id": source_id,
            "source_line_idx": idx,
            "part_no": pn,
            "description": desc,
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


# 파생 테이블 최신성 — 마지막으로 다시 세운 '데이터 세대'. 세대는 쓰기 요청마다 오른다.
_FRESH_GEN: int | None = None
_FRESH_LOCK = threading.Lock()


def ensure_price_history_fresh(session, gen: int) -> bool:
    """데이터가 바뀌었으면(세대 상승) 가격 이력을 다시 세운다. 반환=재구축 여부.

    이 테이블은 문서에서 파생된다. 예전에는 관리자가 Rebuild 를 눌러야만 갱신돼서,
    마지막 재구축 이후에 만들어진 견적·발주의 가격이 품목 화면에 아예 나타나지 않았다
    ("고객사·공급사·가격이 왜 비어 있나"의 첫 번째 원인). 이제 읽는 쪽에서 세대를 보고
    필요할 때만 다시 세운다 — 읽기가 몰려도 세대당 한 번이다."""
    global _FRESH_GEN
    with _FRESH_LOCK:
        if _FRESH_GEN == gen:
            return False
        rebuild_price_history(session)
        _FRESH_GEN = gen
        return True


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
                part_no=fit_part((line.get("part_no") or "").strip()),
                description=fit_desc((line.get("description") or "").strip()),
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


# 가격 이력의 source_type → 사람이 읽는 문서 이름. 번호는 수동 입력이라 비어 있을 수
# 있으므로(문서 번호 정책), 번호가 없으면 이 이름만으로도 어느 문서인지는 남는다.
_DOC_KIND = {
    "vendor_quote": "Vendor quote",
    "po": "P/O",
    "quotation": "Quotation",
    "order": "Customer P/O",
    "ci": "Invoice",
    "ar": "Invoice (AR)",
}


def _doc_labels(session) -> dict[tuple[str, int], dict]:
    """(source_type, source_id) → {kind, no}. 가격이 실려 온 문서의 이름과 번호."""
    out: dict[tuple[str, int], dict] = {}

    def take(kind_key, rows, attr):
        kind = _DOC_KIND[kind_key]
        for r in rows:
            out[(kind_key, r.id)] = {"kind": kind, "no": (getattr(r, attr, "") or "").strip()}

    take("vendor_quote", session.query(VendorQuote).all(), "vendor_quote_no")
    take("po", session.query(PurchaseOrder).all(), "po_no")
    take("quotation", session.query(Quotation).all(), "qtn_no")
    take("order", session.query(Order).all(), "po_no")
    take("ci", session.query(CommercialInvoice).all(), "ci_no")
    take("ar", session.query(ARRecord).all(), "ci_no")
    return out


def _summarize(hs: list, docs: dict | None = None) -> dict:
    """이력 행 묶음 → 최근 구매가·판매가 + 최근 거래 상대 + 거래 카운트 + 최근일.

    거래 상대는 가격과 짝을 이룬다 — 판매가는 누구에게 팔았는지(고객), 구매가는 누구에게서
    샀는지(공급사). 견적·오더 원가처럼 공급사가 안 찍히는 구매 행도 있어, 짝이 비면
    그 상대가 찍힌 가장 최근 행으로 대신한다(master_price_summary 와 같은 규칙).

    docs 를 주면(=_doc_labels) 가격마다 '어느 문서에서 나온 값인가'를 함께 싣는다.
    금액과 마진은 프로젝트가 아니라 문서(견적·발주·인보이스)가 낳는 값이라, 프로젝트
    번호만으로는 그 숫자의 출처를 되짚을 수가 없다."""
    buys = sorted([h for h in hs if h.price_type == "buy"], key=_sort_key, reverse=True)
    sells = sorted([h for h in hs if h.price_type == "sell"], key=_sort_key, reverse=True)

    def one(x, kind: str):
        if not x:
            return None
        out = {
            "unit_price": x.unit_price, "currency": x.currency,
            "date": x.doc_date, "fx_rate": x.fx_rate,  # 딜 저장 환율(있으면 마진 환산에 우선 사용)
            # 이 가격을 만든 상대 — 산 값이면 공급사, 판 값이면 고객. 아래 vendor_id·
            # customer_id 는 품목 단위의 '가장 최근 상대'라 이 가격의 상대와 다를 수 있다
            # (그 행에 상대가 안 찍혀 있으면 다른 행으로 대신하므로). 화면이 금액 옆에
            # 붙여 읽는 값은 그 금액의 상대여야 하니 행에서 직접 가져온다.
            "party_id": (x.vendor_id if kind == "buy" else x.customer_id),
        }
        if docs is not None:
            out["doc"] = docs.get((x.source_type, x.source_id)) or {
                "kind": _DOC_KIND.get(x.source_type, x.source_type or ""), "no": "",
            }
        return out

    def newest(rows: list):
        return rows[0] if rows else None

    cust = (newest([h for h in sells if h.customer_id])
            or newest(sorted([h for h in hs if h.customer_id], key=_sort_key, reverse=True)))
    vend = (newest([h for h in buys if h.vendor_id])
            or newest(sorted([h for h in hs if h.vendor_id], key=_sort_key, reverse=True)))

    dates = [h.doc_date for h in hs if h.doc_date]
    return {
        "buy": one(buys[0] if buys else None, "buy"),
        "sell": one(sells[0] if sells else None, "sell"),
        "customer_id": cust.customer_id if cust else None,
        "vendor_id": vend.vendor_id if vend else None,
        "buy_count": len(buys),
        "sell_count": len(sells),
        "last_date": max(dates) if dates else None,
    }


def ledger_rows(session) -> dict:
    """분류별 품목 롤업. matched(마스터 연결) + unmatched(part_no 미연결) 로 분리.

    마스터에 있는 품목은 가격 이력이 아직 없어도 목록에 세운다. 예전에는 이력을 돌며
    묶었기 때문에 값이 한 번도 붙지 않은 품목은 이 화면에 아예 나타나지 않았다 —
    그런데 그런 품목이야말로 분류가 어긋나 있기 쉽고(단가 없는 줄에서 마스터만 생기는
    길이 있다), 여기 안 보이면 분류를 고칠 자리도 없었다. Ship View·품목 마스터는
    처음부터 마스터 전체를 보고 있어서, 같은 분류를 두고 화면마다 품목 수가 달랐다.
    """
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
    # 아직 값이 붙지 않은 품목 — 가격 칸은 비지만 이름과 분류는 여기서 다룰 수 있어야 한다.
    for m in masters.values():
        if m.id in matched:
            continue
        items.append({
            "item_id": m.id,
            "part_no": m.part_no or "",
            "description": m.description or "",
            "maker": m.maker or "",
            "category_id": m.category_id,
            **_summarize([]),
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


def _ids_newest_first(rows, attr: str) -> list[int]:
    """가격 이력 행 묶음 → 그 열의 id 목록(최근 문서 순, 중복 제거). 딜·선박에 쓴다."""
    out: list[int] = []
    for r in sorted(rows, key=lambda r: ((r.doc_date or ""), r.id), reverse=True):
        v = getattr(r, attr, None)
        if v and v not in out:
            out.append(v)
    return out


def master_price_summary(session) -> dict[int, dict]:
    """item_master.id → 최근 구매가·판매가 + 최근 거래 상대(고객·공급사).

    Item Master 목록의 Customer·Vendor·Purchase/Sales Price·Margin 열 값 원천.
    가격은 마스터에 연결된(item_id) 이력만 본다(미연결 이력은 Item > Category 화면 담당).
      · Customer = 가장 최근 '판매' 행의 고객(없으면 고객이 찍힌 가장 최근 행)
      · Vendor   = 가장 최근 '구매' 행의 공급사(견적·오더 원가처럼 공급사가 없는
                   구매 행도 있어, 공급사가 찍힌 가장 최근 행으로 대체)
    """
    cols = session.query(
        ItemPriceHistory.item_id, ItemPriceHistory.price_type, ItemPriceHistory.source_type,
        ItemPriceHistory.unit_price, ItemPriceHistory.currency, ItemPriceHistory.fx_rate,
        ItemPriceHistory.doc_date, ItemPriceHistory.customer_id, ItemPriceHistory.vendor_id,
        ItemPriceHistory.rfq_id, ItemPriceHistory.vessel_id, ItemPriceHistory.id,
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
        # 견적일 두 가지 — 공급사가 우리에게 준 견적(수신)과 우리가 고객에게 낸 견적(제출).
        vq = newest([r for r in buys if r.source_type == "vendor_quote"])
        cq = newest([r for r in sells if r.source_type == "quotation"])

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
            "vendor_quote_at": vq.doc_date if vq else None,
            "quoted_at": cq.doc_date if cq else None,
            # 이 품목이 값과 함께 등장한 딜들(최근 문서 순, 중복 제거) — Item 목록의
            # Project No. 열이 쓴다. 한 품목이 여러 딜에 걸치는 일은 흔하다(재발주).
            "rfq_ids": _ids_newest_first(rows, "rfq_id"),
            # 그 딜들이 다룬 선박 — 같은 부품이 여러 척에 들어가기도 한다(Vessel 열).
            "vessel_ids": _ids_newest_first(rows, "vessel_id"),
        }
    return out


def master_party_fallback(session) -> dict[int, dict]:
    """가격 이력이 아직 없는 품목의 거래 상대 — 문서에 등장한 사실만으로 채운다.

    가격 이력의 소스는 값이 붙는 문서뿐이다(벤더견적·발주·견적·오더·C/I·청구). 고객 RFQ 와
    벤더 RFQ 는 값이 없어 이력에 남지 않는데, 그렇다고 상대가 없는 건 아니다 — 견적 전
    단계의 품목도 "어느 고객이 물어봤고 어느 공급사에 의뢰했는지"는 문서에 분명히 적혀
    있다("고객사·공급사가 왜 비어 있나"의 두 번째 원인).

    반환 = item_master.id → {customer_id, vendor_id, rfq_at, rfq_ids, vessel_ids}. 가격
    이력이 있는 품목도 포함하되, 호출부는 이력 쪽 값이 없을 때만 이걸 쓴다."""
    idx = build_master_index(session)
    if not idx:
        return {}
    rfq_by_id = {r.id: r for r in session.query(RFQ).all()}
    seen: dict[int, dict] = {}

    def note(item_id: int, *, when: str | None, customer_id=None, vendor_id=None,
             rfq_id=None, vessel_id=None):
        cur = seen.setdefault(item_id, {"customer_id": None, "vendor_id": None,
                                        "_c_at": "", "_v_at": "", "rfq_at": None,
                                        "_rfqs": {}, "_vessels": {}})
        w = (when or "")[:10]
        if customer_id and w >= cur["_c_at"]:
            cur["customer_id"], cur["_c_at"] = customer_id, w
        if vendor_id and w >= cur["_v_at"]:
            cur["vendor_id"], cur["_v_at"] = vendor_id, w
        if w and (cur["rfq_at"] or "") < w:
            cur["rfq_at"] = w
        # 같은 딜(선박)이 여러 문서에 나오면 가장 늦은 날짜만 남긴다(최근 순 정렬용).
        if rfq_id:
            cur["_rfqs"][rfq_id] = max(cur["_rfqs"].get(rfq_id, ""), w)
        if vessel_id:
            cur["_vessels"][vessel_id] = max(cur["_vessels"].get(vessel_id, ""), w)

    def lines_of(items):
        for _, line in _iter_lines(items):
            item_id = idx.get(match_key(line.get("part_no"), line.get("description")))
            if item_id:
                yield item_id

    # 고객 RFQ — 물어본 고객.
    for r in rfq_by_id.values():
        for item_id in lines_of(r.items):
            note(item_id, when=(r.received_at or ""), customer_id=r.customer_id,
                 rfq_id=r.id, vessel_id=r.vessel_id)
    # 벤더 RFQ — 견적을 의뢰한 공급사(고객은 그 딜의 고객).
    for vr in session.query(VendorRFQ).all():
        rfq = rfq_by_id.get(vr.rfq_id)
        for item_id in lines_of(vr.items):
            note(item_id, when=(vr.sent_date or ""), vendor_id=vr.vendor_id,
                 customer_id=(rfq.customer_id if rfq else None), rfq_id=vr.rfq_id,
                 vessel_id=(rfq.vessel_id if rfq else None))
    for v in seen.values():
        v.pop("_c_at", None)
        v.pop("_v_at", None)
        # 값이 붙기 전(RFQ 단계)에도 이 품목이 어느 딜·어느 배에서 나왔는지는 안다.
        for src, dst in (("_rfqs", "rfq_ids"), ("_vessels", "vessel_ids")):
            v[dst] = [i for i, _ in
                      sorted(v.pop(src).items(), key=lambda kv: (kv[1], kv[0]), reverse=True)]
    return seen


# ── 분류 지도(선박 도면 보기) ───────────────────────────────────────────────────
def category_ship_map(session) -> dict:
    """분류 트리 + 각 품목이 어느 딜(프로젝트)에서 나왔는지. 선박 도면 화면의 원천.

    목록 화면은 분류를 하나 골라 그 안을 보지만, 이 화면은 배 한 척을 통째로 펼쳐
    어느 계통에 어느 프로젝트가 걸려 있는지를 한눈에 본다. 그래서 필요한 것이 목록과
    다르다 — 품목마다 '어느 딜에서 몇 줄로 나왔는가'가 붙어야 한다.
    이름(고객·선박·공급사)은 id 로 돌려주고 라우터가 붙인다(다른 엔드포인트와 같은 규칙)."""
    cats = session.query(ItemCategory).all()
    masters = session.query(ItemMaster).all()
    hist = [h for h in session.query(ItemPriceHistory).all() if h.item_id]
    rfqs = {r.id: r for r in session.query(RFQ).all()}

    by_item: dict[int, list] = {}
    for h in hist:
        by_item.setdefault(h.item_id, []).append(h)

    docs = _doc_labels(session)

    items = []
    for m in masters:
        hs = by_item.get(m.id, [])
        # 딜은 최근 문서 순 — 화면의 프로젝트 칩이 늘 최근 것부터 서게 된다.
        deals: dict[int, dict] = {}
        for h in sorted(hs, key=_sort_key, reverse=True):
            r = rfqs.get(h.rfq_id) if h.rfq_id else None
            if r is None:
                continue
            d = deals.setdefault(r.id, {
                "rfq_id": r.id,
                "rfq_no": r.rfq_no or "",
                "title": r.project_title or "",
                "customer_id": r.customer_id,
                "vessel_id": r.vessel_id,
                "date": r.date or "",
                "status": _enum_text(r.status),
                "_lines": set(),
                "amount": 0.0,
            })
            # 한 견적 줄은 매입가·매출가 두 이력으로 갈라져 저장된다 — 줄 수를 그대로
            # 세면 실제보다 두 배가 된다. 문서·줄번호로 묶어 사람이 세는 줄 수와 맞춘다.
            d["_lines"].add((h.source_type, h.source_id, h.source_line_idx))
            if h.price_type == "sell":
                d["amount"] += h.amount or 0.0
        for d in deals.values():
            d["lines"] = len(d.pop("_lines"))
        items.append({
            "item_id": m.id,
            "part_no": m.part_no or "",
            "description": m.description or "",
            "maker": m.maker or "",
            "unit": m.unit or "",
            "item_type": m.item_type or "part",
            "category_id": m.category_id,
            "deals": list(deals.values()),
            **_summarize(hs, docs),
        })
    items.sort(key=lambda r: (not r["deals"], r["part_no"], r["description"]))

    return {
        "categories": [{
            "id": c.id, "parent_id": c.parent_id, "level": c.level or 1,
            "name": c.name, "sort_order": c.sort_order or 0,
            "active": c.active is not False,
        } for c in sorted(cats, key=lambda c: (c.level or 1, c.sort_order or 0, c.id))],
        "items": items,
        # 마스터에 아직 연결되지 않은 이력 — 배에 실을 자리조차 없는 줄이라 수만 알린다.
        "unmatched": len(ledger_rows(session)["unmatched"]),
    }


def _enum_text(v) -> str:
    """Enum 컬럼 → 화면에 실을 문자열."""
    return getattr(v, "value", v) or "" if v is not None else ""


# ── 미분류 품목 자동 분류(제안) ────────────────────────────────────────────────
# 규칙을 새로 만들지 않는다. 이미 분류해 둔 품목과 분류 이름이 근거다 —
# 회사마다 다른 분류 체계를 코드에 박아 두면 트리를 고칠 때마다 코드가 따라 죽는다.
#
# 근거는 넷, 확신이 큰 순서대로 먼저 잡히는 하나를 쓴다:
#   1) same-desc  — 같은 품명이 이미 분류돼 있다(품번만 다른 같은 물건).
#   2) part-family— 같은 품번 계열(앞부분)의 분류가 하나로 모여 있다.
#   3) like-desc  — 품명이 이미 분류된 품목과 거의 같다(꼬리표만 다른 같은 물건).
#   4) name-word  — 품명이 분류 이름의 낱말을 품는다(Ball Bearing → Bearing & bushing).
#                   계열이 정해졌으면 그 계열 아래 소분류에서만 찾는다.

# 분류 이름에서 지워도 뜻이 남는 낱말 — 이런 낱말로 붙는 매칭은 근거가 되지 않는다.
_CAT_STOPWORDS = {
    "and", "or", "etc", "other", "others", "misc", "general", "parts", "part",
    "kit", "kits", "item", "items", "기타", "부품", "일반",
}

# 품명에만 있는 군더더기 — 어느 품목에나 붙는 말이라 둘이 닮았다는 근거가 못 된다.
# (분류 이름 쪽에는 쓰지 않는다 — 'Set'·'Type' 같은 분류가 생길 수 있으므로.)
_DESC_STOPWORDS = _CAT_STOPWORDS | {
    "for", "with", "the", "each", "per", "qty", "pcs", "set", "sets", "new", "old",
    "one", "two", "three", "same", "spec", "specification", "size", "type", "types",
    "required", "offered", "quoted", "including", "include", "incl", "available",
    "not", "non", "all", "any", "from", "into", "out", "off", "used", "use",
}

# 선박 부품 문서의 줄임말 — 사람은 'V/V'라 쓰고 분류 트리는 'Valve'라 적는다.
# 이 표가 없으면 그 둘은 영영 만나지 못한다(자동 분류가 늘 빈손인 가장 큰 까닭이었다).
# 왼쪽은 '/'·'.'로 끊어 쓰는 관용 표기만 잡는다 — 맨 낱말 FO·SW 까지 펴면
# 'FOR'·'SWITCH' 같은 멀쩡한 말이 엉뚱한 계통으로 끌려간다.
_ABBREV: tuple[tuple[str, str], ...] = (
    (r"\bV\s*[./]\s*V\b\.?", " VALVE "),
    (r"\bM\s*[./]\s*E\b\.?", " MAIN ENGINE "),
    (r"\bG\s*[./]\s*E\b\.?", " GENERATOR ENGINE "),
    (r"\bA\s*[./]\s*E\b\.?", " AUXILIARY ENGINE "),
    (r"\bT\s*[./]\s*C\b\.?", " TURBOCHARGER "),
    (r"\bE\s*[./]\s*R\b\.?", " ENGINE ROOM "),
    (r"\bP\s*[./]\s*P\b\.?", " PUMP "),
    (r"\bO\s*[./]\s*H\b\.?", " OVERHAUL "),
    (r"\bF\s*[./]\s*O\b\.?", " FUEL OIL "),
    (r"\bD\s*[./]\s*O\b\.?", " DIESEL OIL "),
    (r"\bL\s*[./]\s*O\b\.?", " LUBRICATING OIL "),
    (r"\bC\s*[./]\s*W\b\.?", " COOLING WATER "),
    (r"\bS\s*[./]\s*W\b\.?", " SEA WATER "),
    (r"\bF\s*[./]\s*W\b\.?", " FRESH WATER "),
    (r"\bH\s*[./]\s*T\b\.?", " HIGH TEMPERATURE "),
    (r"\bL\s*[./]\s*T\b\.?", " LOW TEMPERATURE "),
    (r"\bCYL\b\.?", " CYLINDER "),
    (r"\bGEN\b\.?", " GENERATOR "),
    (r"\bHYD\b\.?", " HYDRAULIC "),
    (r"\bCOMP\b\.?", " COMPRESSOR "),
    (r"\bT\s*/\s*G\b\.?", " TURBINE GENERATOR "),
)


def _expand(text) -> str:
    """품명의 관용 줄임말을 펴서 분류 이름과 같은 말로 만든다('BALL V/V' → 'BALL VALVE')."""
    t = _norm(text)
    for pat, rep in _ABBREV:
        t = re.sub(pat, rep, t)
    return _norm(t)


def _stem(w: str) -> str:
    """복수형 꼬리만 떼는 최소한의 어간('VALVES'→'VALVE'). 짧은 낱말은 건드리지 않는다."""
    return w[:-1] if len(w) > 3 and w.endswith("s") else w


def _tokens(text: str) -> set[str]:
    """글자 → 낱말 집합. 낱말 경계로 끊는다 — 이어붙은 조각으로는 맞다고 보지 않는다.

    예전에는 부분문자열로 봤다: 그래서 'REPAIR KIT'의 repair 안에 든 air 가 Starting Air
    System 을, 'GASKET'의 gas 가 Vent / Inert Gas 를 물어 왔다. 그렇게 붙은 근거는
    사람이 보면 바로 틀린 것이라 제안 전체의 신뢰를 깎는다."""
    return {_stem(w) for w in re.split(r"[^0-9a-zA-Z가-힣]+", text.lower()) if len(w) > 2}


def _cat_words(name: str) -> set[str]:
    """분류 이름 → 판정에 쓸 낱말 집합('Seal & gasket' → {seal, gasket})."""
    return {w for w in _tokens(name or "") if w not in _CAT_STOPWORDS}


def _desc_words(desc) -> set[str]:
    """품명 → 판정에 쓸 낱말 집합. 줄임말을 편 뒤 군더더기를 뺀다."""
    return {w for w in _tokens(_expand(desc)) if w not in _DESC_STOPWORDS}


def part_family(part_no) -> str:
    """품번의 계열 키 — 앞쪽 영숫자 덩어리('B6DS0939 101' → 'B6DS0939').

    같은 엔진·기기의 부품표는 앞부분을 공유하고 뒤가 도면번호로 갈린다. 그래서
    계열이 같으면 대·중분류(Engine Room > Main Engine System)가 같다고 보아도 어긋나는
    일이 드물다.
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
    같은 계열이 'Piston' 과 'Cylinder' 로 갈렸어도 'Engine Room > Main Engine System'
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


def _like(a: set[str], b: set[str]) -> float:
    """두 품명이 얼마나 같은 물건인지 — 0(남남)~1(같은 말).

    자카드만 쓰면 한쪽이 길 때 늘 0 에 가깝다: 견적서의 품명에는 규격·조건이 문장으로
    딸려 붙는 일이 흔해서(같은 케이블인데 한쪽만 세 줄), 짧은 쪽이 긴 쪽에 통째로
    들어앉는 경우를 따로 본다. 대신 그때는 겹친 낱말이 셋은 되어야 한다 — 둘이면
    'BALL' 'VALVE' 같은 흔한 말 둘로 남남이 닮아 보인다."""
    if not a or not b:
        return 0.0
    inter = len(a & b)
    if inter < 2:
        return 0.0
    jac = inter / len(a | b)
    cover = inter / min(len(a), len(b))
    return max(jac, cover if inter >= 3 else 0.0)


# 닮았다고 볼 최소선. 이보다 낮으면 근거로 치지 않는다.
_LIKE_MIN = 0.6


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
    learned: list[tuple[set[str], int, str]] = []   # (품명 낱말, 분류, 품명) — 닮은꼴 찾기용
    for m in masters:
        if not m.category_id or m.category_id not in cats:
            continue
        d = _norm(m.description)
        if d:
            by_desc.setdefault(d, []).append(m.category_id)
            w = _desc_words(m.description)
            if len(w) >= 2:
                learned.append((w, m.category_id, m.description or ""))
        fam = part_family(m.part_no)
        if fam:
            by_family.setdefault(fam, []).append(m.category_id)

    # 분류 이름 낱말 색인(잎 분류 우선 — 깊을수록 구체적이다).
    cat_words = {cid: _cat_words(c.name) for cid, c in cats.items() if c.active is not False}

    # 용역 가지 — 물건과 용역은 서로의 자리에 갈 수 없다. 이 울타리가 없으면
    # "Service Charge" 가 낱말 하나로 'Fuel Oil System > Service Tank' 에 꽂힌다.
    service_root = next((cid for cid, c in cats.items()
                         if (c.level or 1) == 1 and _norm(c.name) == "SERVICE"), None)

    def ancestors(cid: int | None) -> set[int]:
        out, cur, guard = set(), cats.get(cid) if cid else None, 0
        while cur is not None and guard < 5:
            out.add(cur.id)
            cur = cats.get(cur.parent_id) if cur.parent_id else None
            guard += 1
        return out

    def in_service_branch(cid: int) -> bool:
        return service_root is not None and service_root in ancestors(cid)

    def fenced(cids: list[int], want_service: bool) -> list[int]:
        """후보에서 반대편 가지를 걷어낸다 — 물건과 용역은 서로의 자리에 갈 수 없다.

        이 울타리는 아래 이름 짐작(ranked·like_desc)에만 걸려 있었다. 그런데 '같은 품명'과
        '같은 품번 계열'로 찾는 앞 두 갈래는 이미 분류된 품목을 그대로 따라가므로, 한 번
        잘못 들어간 품목이 같은 품명을 타고 계속 번졌다 — 'Traveling Charge' 하나가 배의
        계통에 꽂혀 있으면 그 뒤로 들어오는 같은 이름이 전부 그리로 따라갔다.
        걷어내고 남는 것이 없으면 그 갈래는 포기하고 다음 갈래로 간다. 근거가 끝내 없으면
        제안하지 않는 것이 이 함수의 규약이다(아무 데나 넣는 것보다 비워 두는 편이 낫다).
        """
        if service_root is None:
            return cids
        return [c for c in cids if in_service_branch(c) == want_service]

    def ranked(toks: set[str], within: int | None, want_service: bool,
               levels: set[int] | None = None) -> list[tuple[list[int], set[str]]]:
        """품명 낱말과 겹치는 분류들을 '맞은 정도'가 같은 것끼리 묶어 좋은 순으로.

        한 묶음 안이 갈리면(같은 이름이 여러 계통에 있는 경우) 그 묶음을 버리고 다음
        묶음으로 내려간다 — 예전에는 첫 묶음이 갈리면 거기서 끝나, 'Actuator' 가 두 계통에
        있다는 이유만으로 같은 품명이 들고 있던 'Valve' 까지 함께 버려졌다."""
        groups: dict[tuple, list[int]] = {}
        hits: dict[tuple, set[str]] = {}
        for cid, words in cat_words.items():
            hit = words & toks
            if not hit:
                continue
            c = cats[cid]
            if levels is not None and (c.level or 1) not in levels:
                continue
            if within is not None and within not in ancestors(cid) - {cid}:
                continue
            svc = in_service_branch(cid)
            # 용역이라고 품명이 말한 항목은 용역 가지 안에서만 찾는다(적극적 근거).
            # 반대로 '물품'은 용역이라는 증거가 없다는 뜻일 뿐이라 울타리를 세우지 않고
            # 순위만 뒤로 미룬다 — 그래야 품명이 용역을 가리키는데 낱말표에 없는 항목
            # ('T/C OVERHAUL SERVICE')이 갈 곳을 잃지 않는다.
            if want_service and service_root is not None and not svc:
                continue
            key = (
                0 if (svc and not want_service) else 1,   # 갈래가 맞는 쪽이 먼저
                len(hit),                                 # 많이 맞은 쪽
                1 if hit == words else 0,                 # 이름을 통째로 맞춘 쪽
                max(len(w) for w in hit),                 # 긴(구체적인) 낱말
                c.level or 0,                             # 깊은(구체적인) 분류
            )
            groups.setdefault(key, []).append(cid)
            hits.setdefault(key, set()).update(hit)
        return [(groups[k], hits[k]) for k in sorted(groups, reverse=True)]

    def resolve(groups: list[tuple[list[int], set[str]]]) -> tuple[int | None, str]:
        for cids, hit in groups:
            best = cids[0] if len(cids) == 1 else _pick(cats, cids)[0]
            if best is not None:
                return best, ", ".join(sorted(hit))
        return None, ""

    def by_name(desc: str, within: int | None, want_service: bool) -> tuple[int | None, str]:
        """품명이 품은 분류 이름 낱말로 찾기. within 이 있으면 그 하위에서만.

        계통(대·중분류)이 먼저 잡히면 그 안에서 한 번 더 내려간다 — 'L.O. PUMP' 는
        Lubricating Oil System 을 맞히고, 그 안에서 다시 LO Pump 를 맞힌다. 계통 밖에서
        고르면 같은 'Pump' 가 여섯 군데라 늘 갈려 아무것도 못 고른다."""
        toks = _desc_words(desc)
        if not toks:
            return None, ""
        best, hit = resolve(ranked(toks, within, want_service))
        if best is not None and within is None and (cats[best].level or 1) <= 2:
            deep, dhit = resolve(ranked(toks, best, want_service))
            if deep is not None:
                return deep, dhit
        return best, hit

    def like_desc(words: set[str], want_service: bool) -> tuple[int | None, str]:
        """이미 분류된 품목 중 품명이 가장 닮은 것들의 분류."""
        if len(words) < 2:
            return None, ""
        top, hits = 0.0, []
        for w, cid, d in learned:
            if service_root is not None and want_service and not in_service_branch(cid):
                continue
            sc = _like(words, w)
            if sc < _LIKE_MIN:
                continue
            if sc > top + 1e-9:
                top, hits = sc, [(cid, d)]
            elif sc > top - 1e-9:
                hits.append((cid, d))
        if not hits:
            return None, ""
        cid, why = _pick(cats, [c for c, _ in hits])
        if cid is None:
            return None, ""
        sample = hits[0][1]
        return cid, f"“{sample[:60]}”{why and ' — ' + why}"

    if rows is None:
        # 대상 = 분류가 빈 마스터 전체(거래 이력이 아직 없는 품목도 포함) + 마스터에
        # 없는 미연결 이력. 앞은 Item Master 목록의 빈칸, 뒤는 이 화면의 Unmatched 다.
        rows = [{
            "item_id": m.id, "part_no": m.part_no or "",
            "description": m.description or "", "maker": m.maker or "",
            "item_type": m.item_type or "",
        } for m in masters if not m.category_id]
        rows += ledger_rows(session)["unmatched"]

    out: list[dict] = []
    for r in rows:
        desc, pn = r.get("description") or "", r.get("part_no") or ""
        # 물품/용역 — 마스터에 적힌 값이 있으면 그것, 없으면(미연결 이력) 품명으로 짐작.
        is_service = (r.get("item_type") or guess_item_type(pn, desc)) == "service"
        cid: int | None = None
        reason = ""
        # 1) 같은 품명이 이미 분류돼 있다.
        c, why = _pick(cats, fenced(by_desc.get(_norm(desc)) or [], is_service))
        if c:
            cid, reason = c, f"same description — {why}"
        # 2) 같은 품번 계열이 한 분류(또는 한 상위)로 모여 있다.
        fam = part_family(pn)
        if cid is None and fam:
            c, why = _pick(cats, fenced(by_family.get(fam) or [], is_service))
            if c:
                # 계열이 정하는 건 보통 대·중분류다. 품명이 그 아래 소분류를 가리키면 더 깊게.
                deeper, hit = by_name(desc, c, is_service)
                if deeper:
                    cid, reason = deeper, f"part family {fam} — {why} + name “{hit}”"
                else:
                    cid, reason = c, f"part family {fam} — {why}"
        # 3) 품명이 이미 분류된 품목과 거의 같다 — 견적서 품명은 같은 물건도 꼬리표가
        #    달라(‘, KK’ / ‘, MT.H’) 글자 그대로는 좀처럼 맞지 않는다.
        if cid is None:
            c, why = like_desc(_desc_words(desc), is_service)
            if c:
                cid, reason = c, f"like {why}"
        # 4) 품명이 분류 이름을 품는다.
        if cid is None:
            c, hit = by_name(desc, None, is_service)
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
