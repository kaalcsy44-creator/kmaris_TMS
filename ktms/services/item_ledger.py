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
    ARRecord, CommercialInvoice, ItemMaster, ItemPriceHistory, Order,
    PurchaseOrder, Quotation, RFQ, VendorQuote, VendorRFQ,
)


def part_key(v) -> str:
    """part_no 정규화 키 — 내부 공백 정리 + 대문자. item_master 매칭·집계용."""
    return re.sub(r"\s+", " ", str(v or "").strip().upper())


def _num(v, default: float = 0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def build_master_index(session) -> dict[str, int]:
    """정규화 part_no → item_master.id. 같은 키가 여럿이면 가장 낮은 id(안정적)."""
    idx: dict[str, int] = {}
    for m in session.query(ItemMaster).order_by(ItemMaster.id).all():
        k = part_key(m.part_no)
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
        rows.append({
            "item_id": master.get(part_key(pn)),
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
    pk = part_key(m.part_no)
    if not pk:
        return 0
    n = 0
    for h in session.query(ItemPriceHistory).filter(ItemPriceHistory.item_id.is_(None)).all():
        if part_key(h.part_no) == pk:
            h.item_id = item_id
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
        return {"unit_price": x.unit_price, "currency": x.currency, "date": x.doc_date}

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
            unmatched.setdefault(part_key(h.part_no) or f"#{h.id}", []).append(h)

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
    un.sort(key=lambda r: r["part_no"])
    return {"items": items, "unmatched": un}


def item_history(session, *, item_id: int | None = None, part_no: str | None = None) -> list[dict]:
    """한 품목의 buy/sell 이력 행 전체(최신순). item_id 우선, 없으면 part_no 로 조회."""
    q = session.query(ItemPriceHistory)
    if item_id:
        q = q.filter(ItemPriceHistory.item_id == item_id)
    elif part_no is not None:
        pk = part_key(part_no)
        q = q.filter(ItemPriceHistory.item_id.is_(None))
        rows = [h for h in q.all() if part_key(h.part_no) == pk]
        return _history_out(sorted(rows, key=_sort_key, reverse=True))
    else:
        return []
    return _history_out(sorted(q.all(), key=_sort_key, reverse=True))


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
