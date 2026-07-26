"""K-Maris TMS — finance routes (지급대장·수금/미수·재무 집계·캘린더).

수금(ARRecord 기반 미수)과 지급(FinancePayable: 거래선 지급 + 임차료·급여 등 운영비)을
한데 모아 재무 현황·거래선별 통계·캘린더를 제공한다. 프로젝트 파이프라인과 독립적으로
회사의 재무 활동을 담는 모듈이다.
"""
from __future__ import annotations

from _core import (
    APRecord,
    ARRecord,
    Customer,
    Depends,
    FINANCE_CATEGORIES,
    FINANCE_INCOME_CATEGORIES,
    FINANCE_RECURRENCES,
    FinanceIncome,
    FinanceIncomeIn,
    FinancePayable,
    FinancePayableIn,
    FinancePayablePayIn,
    HTTPException,
    Order,
    PurchaseOrder,
    USD_KRW_RATE,
    User,
    Vendor,
    _ap_record_rows,
    _finance_income_row,
    _finance_occurrences,
    _finance_payable_paid_on,
    _finance_payable_row,
    _finance_receivable_rows,
    _items_cost_total,
    _total_amount,
    app,
    date,
    get_current_user,
    get_session,
    require_token,
    timedelta,
)
from services.fx import get_deal_base_rate


def _to_krw(amount: float, currency: str) -> float:
    """단일 헤드라인 집계용 KRW 환산(USD만 환산, 그 외 원값)."""
    return amount * USD_KRW_RATE if (currency or "").upper() == "USD" else amount


def _sum_by_currency(pairs) -> dict:
    """[(amount, currency)] → {currency: sum}."""
    out: dict[str, float] = {}
    for amt, cur in pairs:
        cur = (cur or "KRW").upper()
        out[cur] = round(out.get(cur, 0.0) + (amt or 0.0), 2)
    return out


def _add_by_currency(bucket: dict, key: str, amount: float, currency: str) -> None:
    """bucket[key][통화] 에 금액을 누적한다(환산 없이 통화별로 분리 보관)."""
    cur = (currency or "KRW").upper()
    per = bucket.setdefault(key, {})
    per[cur] = round(per.get(cur, 0.0) + (amount or 0.0), 2)


def _today_usd_krw() -> dict:
    """오늘자 USD 매매기준율(수출입은행). 실패하면 고정환율로 폴백한다."""
    rate, used = get_deal_base_rate(date.today().isoformat(), "USD")
    if rate is not None:
        return {"rate": round(rate, 4), "date": used, "source": "exim"}
    return {"rate": USD_KRW_RATE, "date": "", "source": "fixed"}


def _month_bounds(d: date) -> tuple[date, date]:
    """d 가 속한 달의 [1일, 말일]."""
    start = d.replace(day=1)
    nm, ny = (1, d.year + 1) if d.month == 12 else (d.month + 1, d.year)
    return start, date.fromordinal(date(ny, nm, 1).toordinal() - 1)


def _settled_occurrences(p, d0: date, d1: date) -> list[tuple[str, float]]:
    """지급대장/기타수입 한 건에서 [d0,d1] 안에 '실제로 돈이 오간' (날짜, 금액) 목록.

    예정(회차일)이 아니라 실제 결제일 기준이다 — 7/20 예정을 7/25 에 냈으면 7/25 에 잡힌다.
    일회성은 paid_date(미입력이면 예정일로 폴백), 반복은 payments{회차일: 실제일} 을 쓰되
    실제일 기록이 없는 옛 회차는 회차일을 결제일로 본다(paid_dates).
    FinanceIncome 도 같은 필드 구성이라 그대로 통한다.
    """
    amount = round(p.amount or 0.0, 2)
    lo, hi = d0.isoformat(), d1.isoformat()
    out: list[tuple[str, float]] = []
    if (p.recurrence or "none") == "none":
        if p.paid:
            when = ((p.paid_date or "")[:10] or (p.due_date or "")[:10])
            if when and lo <= when <= hi:
                out.append((when, amount))
        return out
    payments = dict(getattr(p, "payments", None) or {})
    for occ in (p.paid_dates or []):
        when = (payments.get(occ) or occ)[:10]
        if when and lo <= when <= hi:
            out.append((when, amount))
    return out


def _ar_receipts(ar_rows: list[dict], d0: date, d1: date) -> list[tuple[str, float, str]]:
    """[d0,d1] 안에 실제로 입금된 매출채권 (입금일, 금액, 통화) 목록.

    완납 건만 잡힌다 — 부분수금은 ARRecord 에 입금일을 남기는 자리가 없어 날짜를 못 매긴다.
    """
    lo, hi = d0.isoformat(), d1.isoformat()
    return [(r["paid_date"], r["paid_amount"], r["currency"]) for r in ar_rows
            if r["paid_amount"] > 0 and r["paid_date"] and lo <= r["paid_date"] <= hi]


def _ap_payments(ap_rows: list[dict], d0: date, d1: date) -> list[tuple[str, float, str]]:
    """[d0,d1] 안에 실제로 지급한 벤더 청구 (지급일, 금액, 통화) 목록.

    지급일은 9·10단계 AP 편집기의 Payment 칸에서 들어온다 — 비어 있으면 어느 달에 나갔는지
    알 수 없으므로 실적에서 뺀다(잔액 쪽에는 미지급으로 그대로 남는다).
    """
    lo, hi = d0.isoformat(), d1.isoformat()
    return [(r["paid_date"], r["paid_amount"], r["currency"]) for r in ap_rows
            if r["paid_amount"] > 0 and r["paid_date"] and lo <= r["paid_date"] <= hi]


def _by_currency_sort_key(per: dict) -> tuple:
    """통화별 합계 정렬 기준 — 환산 없이 KRW, USD, 그 외 최대값 순으로 비교."""
    rest = max([v for c, v in per.items() if c not in ("KRW", "USD")] or [0.0])
    return (per.get("KRW", 0.0), per.get("USD", 0.0), rest)


@app.get("/api/admin/finance/meta", dependencies=[Depends(require_token)])
def finance_meta():
    """지급 분류·반복 옵션 등 폼 구성용 메타."""
    return {
        "categories": FINANCE_CATEGORIES,
        "income_categories": FINANCE_INCOME_CATEGORIES,
        "recurrences": sorted(FINANCE_RECURRENCES),
    }


@app.get("/api/admin/finance/summary", dependencies=[Depends(require_token)])
def finance_summary():
    """재무 현황 요약 — 잔액(미수·미지급) KPI + 이번 달 실제 입출금 + 거래선별 통계.

    통화는 환산하지 않고 통화별로 분리해 합계를 낸다(임의 환율로 뭉치면 실제 잔액과
    어긋나기 때문). 정렬만 KRW→USD→기타 순으로 비교한다.
    """
    s = get_session()
    try:
        today = date.today()
        today_str = today.isoformat()
        horizon = (date.fromordinal(today.toordinal() + 30)).isoformat()
        month_start, month_end = _month_bounds(today)

        # ── 수금(미수) — ARRecord + 기타 수입(수동 등록) ──
        ar_rows = _finance_receivable_rows(s)
        rec = ar_rows + _finance_income_rows(s)
        rec_open = [r for r in rec if r["outstanding"] > 0]
        receivable_outstanding = _sum_by_currency((r["outstanding"], r["currency"]) for r in rec_open)
        receivable_overdue = _sum_by_currency(
            (r["outstanding"], r["currency"]) for r in rec_open if r["overdue"]
        )
        # 거래선(고객)별 미수 합계 — 통화별 분리.
        by_cust: dict[str, dict] = {}
        for r in rec_open:
            _add_by_currency(by_cust, r["customer"], r["outstanding"], r["currency"])
        by_customer = [
            {"name": k, "outstanding": v}
            for k, v in sorted(by_cust.items(), key=lambda kv: _by_currency_sort_key(kv[1]), reverse=True)
        ]

        # ── 지급 — FinancePayable 기준(향후 30일 예정 + 연체 미납) ──
        payables = s.query(FinancePayable).all()
        upcoming: list[tuple[float, str]] = []
        overdue_pay: list[tuple[float, str]] = []
        by_cat: dict[str, dict] = {}
        # 지난 1년~향후 1년 구간에서 회차를 펼쳐 예정/연체를 계산.
        win_start = (date.fromordinal(today.toordinal() - 365)).isoformat()
        win_end = (date.fromordinal(today.toordinal() + 365)).isoformat()
        for p in payables:
            for occ in _finance_occurrences(p, date.fromisoformat(win_start), date.fromisoformat(win_end)):
                if _finance_payable_paid_on(p, occ):
                    continue
                amt, cur = (p.amount or 0.0), (p.currency or "KRW")
                if occ < today_str:
                    overdue_pay.append((amt, cur))
                    _add_by_currency(by_cat, p.category or "기타", amt, cur)
                elif occ <= horizon:
                    upcoming.append((amt, cur))
                    _add_by_currency(by_cat, p.category or "기타", amt, cur)
        # ── 지급 — 매입 청구(APRecord) 미지급분(벤더 P/O별) 추가 반영 ──
        ap_rows = _ap_record_rows(s)
        for ap in ap_rows:
            if ap["outstanding"] <= 0:
                continue
            amt, cur, due = ap["outstanding"], ap["currency"], ap["due_date"]
            if due and due < today_str:
                overdue_pay.append((amt, cur))
                _add_by_currency(by_cat, "거래선지급", amt, cur)
            elif not due or due <= horizon:
                upcoming.append((amt, cur))
                _add_by_currency(by_cat, "거래선지급", amt, cur)
        # ── 이번 달 실제 입출금 — 잔액 KPI 는 '아직 안 오간 돈'만 보므로, 완납된 건은
        # 어느 타일에도 남지 않는다. 이미 들어오고 나간 돈을 볼 자리를 따로 둔다. ──
        collected = [(amt, cur) for _, amt, cur in _ar_receipts(ar_rows, month_start, month_end)]
        for inc in s.query(FinanceIncome).all():
            collected += [(amt, inc.currency or "KRW")
                          for _, amt in _settled_occurrences(inc, month_start, month_end)]
        paid_out: list[tuple[float, str]] = []
        for p in payables:
            paid_out += [(amt, p.currency or "KRW")
                         for _, amt in _settled_occurrences(p, month_start, month_end)]
        # 매입 청구(APRecord) — 9·10단계 Payment 에서 기록한 실제 지급일 기준.
        paid_out += [(amt, cur) for _, amt, cur in _ap_payments(ap_rows, month_start, month_end)]

        payable_upcoming = _sum_by_currency(upcoming)
        payable_overdue = _sum_by_currency(overdue_pay)
        payable_total = _sum_by_currency(upcoming + overdue_pay)
        by_category = [
            {"name": k, "amount": v}
            for k, v in sorted(by_cat.items(), key=lambda kv: _by_currency_sort_key(kv[1]), reverse=True)
        ]

        return {
            "receivable": {
                "outstanding": receivable_outstanding,
                "overdue": receivable_overdue,
                "count": len(rec_open),
            },
            "payable": {
                "upcoming_30d": payable_upcoming,
                "overdue": payable_overdue,
                "total": payable_total,
            },
            # 이번 달 실적(예정이 아니라 실제 오간 돈).
            "month": month_start.strftime("%Y-%m"),
            "collected_month": {"amount": _sum_by_currency(collected), "count": len(collected)},
            "paid_month": {"amount": _sum_by_currency(paid_out), "count": len(paid_out)},
            "by_customer": by_customer[:12],
            "by_category": by_category,
        }
    finally:
        s.close()


@app.get("/api/admin/finance/receivables", dependencies=[Depends(require_token)])
def finance_receivables():
    """수입 목록 — 프로젝트 매출(ARRecord) + 기타 수입(FinanceIncome, 수동 등록).

    지급 목록이 AP+수동을 함께 보여주는 것과 대칭. 합계는 통화별로 내되, 참고용 KRW
    환산에 쓰라고 오늘자 매매기준율을 함께 준다(조회 실패 시 고정환율 폴백).
    """
    s = get_session()
    try:
        rows = [{**r, "source": "ar"} for r in _finance_receivable_rows(s)]
        rows += _finance_income_rows(s)
        rows.sort(key=lambda r: (r["due_date"] or "9999", -r["outstanding"]))
        return {"rows": rows, "fx": _today_usd_krw()}
    finally:
        s.close()


def _finance_income_rows(s) -> list[dict]:
    """기타 수입(수동 등록) 행 — 목록·집계 공용."""
    customer_names = {c.id: c.name for c in s.query(Customer).all()}
    user_names = {u.id: u.username for u in s.query(User).all()}
    return [
        _finance_income_row(r, customer_names, user_names)
        for r in s.query(FinanceIncome).order_by(FinanceIncome.due_date, FinanceIncome.id).all()
    ]


# ── 기타 수입(수동 등록) CRUD — 지급대장(payables)과 같은 규약 ──────────────────
@app.get("/api/admin/finance/incomes", dependencies=[Depends(require_token)])
def finance_incomes():
    s = get_session()
    try:
        return {"rows": _finance_income_rows(s), "fx": _today_usd_krw()}
    finally:
        s.close()


@app.post("/api/admin/finance/incomes", dependencies=[Depends(require_token)])
def create_finance_income(body: FinanceIncomeIn, user: dict = Depends(get_current_user)):
    if not (body.description or "").strip() and not (body.counterparty or "").strip():
        raise HTTPException(status_code=400, detail="Enter a description or counterparty.")
    if not (body.due_date or "").strip():
        raise HTTPException(status_code=400, detail="Enter an expected date.")
    rec = body.recurrence if (body.recurrence or "none") in FINANCE_RECURRENCES else "none"
    s = get_session()
    try:
        row = FinanceIncome(
            category=body.category or "기타",
            counterparty=(body.counterparty or "").strip(),
            customer_id=body.customer_id,
            description=(body.description or "").strip(),
            amount=body.amount or 0.0,
            currency=body.currency or "KRW",
            due_date=(body.due_date or "").strip()[:10],
            recurrence=rec,
            recur_until=(body.recur_until or "").strip()[:10],
            notes=(body.notes or "").strip(),
            owner_id=(user or {}).get("id"),
        )
        s.add(row)
        s.commit()
        return {"ok": True, "id": row.id}
    finally:
        s.close()


@app.put("/api/admin/finance/incomes/{row_id}", dependencies=[Depends(require_token)])
def update_finance_income(row_id: int, body: FinanceIncomeIn):
    s = get_session()
    try:
        row = s.query(FinanceIncome).filter_by(id=row_id).first()
        if not row:
            raise HTTPException(status_code=404, detail="Income not found.")
        row.category = body.category or "기타"
        row.counterparty = (body.counterparty or "").strip()
        row.customer_id = body.customer_id
        row.description = (body.description or "").strip()
        row.amount = body.amount or 0.0
        row.currency = body.currency or "KRW"
        row.due_date = (body.due_date or "").strip()[:10]
        row.recurrence = body.recurrence if (body.recurrence or "none") in FINANCE_RECURRENCES else "none"
        row.recur_until = (body.recur_until or "").strip()[:10]
        row.notes = (body.notes or "").strip()
        s.commit()
        return {"ok": True, "id": row.id}
    finally:
        s.close()


@app.delete("/api/admin/finance/incomes/{row_id}", dependencies=[Depends(require_token)])
def delete_finance_income(row_id: int):
    s = get_session()
    try:
        row = s.query(FinanceIncome).filter_by(id=row_id).first()
        if not row:
            raise HTTPException(status_code=404, detail="Income not found.")
        s.delete(row)
        s.commit()
        return {"ok": True}
    finally:
        s.close()


@app.post("/api/admin/finance/incomes/{row_id}/receive", dependencies=[Depends(require_token)])
def receive_finance_income(row_id: int, body: FinancePayablePayIn):
    """입금 표시 토글 — 지급대장의 납부 처리와 같은 규약(실제 입금일을 받는다)."""
    s = get_session()
    try:
        row = s.query(FinanceIncome).filter_by(id=row_id).first()
        if not row:
            raise HTTPException(status_code=404, detail="Income not found.")
        paid_on = (body.paid_on or "").strip()[:10] or date.today().isoformat()
        if (row.recurrence or "none") == "none":
            row.paid = bool(body.paid)
            row.paid_date = paid_on if body.paid else ""
        else:
            occ = (body.occurrence or "").strip()
            if not occ:
                raise HTTPException(status_code=400, detail="반복 항목은 회차일(occurrence)이 필요합니다.")
            dates = list(row.paid_dates or [])
            pays = dict(getattr(row, "payments", None) or {})
            if body.paid and occ not in dates:
                dates.append(occ)
            elif not body.paid and occ in dates:
                dates.remove(occ)
            if body.paid:
                pays[occ] = paid_on
            else:
                pays.pop(occ, None)
            row.paid_dates = sorted(dates)
            row.payments = pays
        s.commit()
        return {"ok": True}
    finally:
        s.close()


@app.get("/api/admin/finance/payables", dependencies=[Depends(require_token)])
def finance_payables():
    """지급대장 목록 — 수동 등록(FinancePayable) + 매입 청구(APRecord, 읽기전용).

    AP 행은 프로젝트 9·10단계에서 편집하므로 여기서는 읽기전용으로 함께 보여준다.
    반복 항목은 캘린더에서 회차로 펼쳐진다.
    """
    s = get_session()
    try:
        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}
        user_names = {u.id: u.username for u in s.query(User).all()}
        rows = s.query(FinancePayable).order_by(FinancePayable.due_date, FinancePayable.id).all()
        # 청구/지급/미지급 3열은 미수 목록과 같은 뜻으로 채운다.
        # 수동 등록은 지급 여부가 불리언이라 지급액 = (지급 완료면 전액), 반복 항목은
        # 표시 금액이 1회차분이므로 그 회차(due_date)의 지급 여부로 판단한다.
        out = []
        for p in rows:
            row = {**_finance_payable_row(p, vendor_names, user_names), "source": "manual"}
            amount = row["amount"]
            settled = row["paid"] if row["recurrence"] == "none" else (row["due_date"] in row["paid_dates"])
            row["invoice_amount"] = amount
            row["paid_amount"] = amount if settled else 0.0
            row["outstanding"] = 0.0 if settled else amount
            out.append(row)
        # 매입 청구(AP) — vendor P/O별 청구를 읽기전용 지급 행으로 합류.
        # 지급 완료분도 남긴다(기타 지출 표와 같은 규칙) — 냈다는 사실이 목록에서 사라지면
        # 지급 확인을 어디서 했는지 되짚을 수가 없다.
        for ap in _ap_record_rows(s):
            settled = ap["invoice_amount"] > 0 and ap["outstanding"] <= 0
            out.append({
                "id": ap["id"],
                "source": "ap",
                "category": "거래선지급",
                "counterparty": ap["vendor"],
                "vendor_id": None,
                "description": ap["bill_no"] or ap["po_no"] or "",
                "po_no": ap["po_no"],
                # 이 청구의 벤더 P/O — 9단계 AP 탭에서 그 P/O 를 바로 선택하는 딥링크용.
                "po_id": ap["po_id"],
                # 청구서 발행일 — 미수 목록의 invoice_date(대금청구서 발행일)와 대칭.
                "bill_date": ap["bill_date"],
                # 이 청구가 속한 프로젝트(오더·RFQ) — 목록에서 해당 단계로 바로 들어가는 링크용.
                "order_id": ap["order_id"],
                "rfq_id": ap["rfq_id"],
                "amount": ap["invoice_amount"],
                "invoice_amount": ap["invoice_amount"],
                "paid_amount": ap["paid_amount"],
                "outstanding": ap["outstanding"],
                "currency": ap["currency"],
                "due_date": ap["due_date"],
                "recurrence": "none",
                "recur_until": "",
                "paid": settled,
                "paid_date": ap["paid_date"],
                "paid_dates": [],
                "notes": "",
                "owner_id": 0,
                "owner": "",
            })
        out.sort(key=lambda r: (r["due_date"] or "9999", r["source"] != "manual"))
        return {"rows": out, "fx": _today_usd_krw()}
    finally:
        s.close()


@app.post("/api/admin/finance/payables", dependencies=[Depends(require_token)])
def create_finance_payable(body: FinancePayableIn, user: dict = Depends(get_current_user)):
    if not (body.description or "").strip() and not (body.counterparty or "").strip():
        raise HTTPException(status_code=400, detail="Enter a description or counterparty.")
    if not (body.due_date or "").strip():
        raise HTTPException(status_code=400, detail="Enter a due date.")
    rec = (body.recurrence or "none")
    if rec not in FINANCE_RECURRENCES:
        rec = "none"
    s = get_session()
    try:
        p = FinancePayable(
            category=body.category or "기타",
            counterparty=(body.counterparty or "").strip(),
            vendor_id=body.vendor_id or None,
            description=(body.description or "").strip(),
            amount=body.amount or 0.0,
            currency=body.currency or "KRW",
            bill_date=(body.bill_date or "").strip()[:10],
            due_date=body.due_date or "",
            recurrence=rec,
            recur_until=(body.recur_until or "") or None,
            paid=False,
            paid_dates=[],
            notes=body.notes or "",
            owner_id=user.get("id") or None,
        )
        s.add(p)
        s.commit()
        return {"ok": True, "id": p.id}
    finally:
        s.close()


@app.put("/api/admin/finance/payables/{row_id}", dependencies=[Depends(require_token)])
def update_finance_payable(row_id: int, body: FinancePayableIn):
    rec = (body.recurrence or "none")
    if rec not in FINANCE_RECURRENCES:
        rec = "none"
    s = get_session()
    try:
        p = s.query(FinancePayable).filter_by(id=row_id).first()
        if not p:
            raise HTTPException(status_code=404, detail="Payable not found.")
        p.category = body.category or "기타"
        p.counterparty = (body.counterparty or "").strip()
        p.vendor_id = body.vendor_id or None
        p.description = (body.description or "").strip()
        p.amount = body.amount or 0.0
        p.currency = body.currency or "KRW"
        p.bill_date = (body.bill_date or "").strip()[:10]
        p.due_date = body.due_date or ""
        p.recurrence = rec
        p.recur_until = (body.recur_until or "") or None
        p.notes = body.notes or ""
        s.commit()
        return {"ok": True, "id": p.id}
    finally:
        s.close()


@app.post("/api/admin/finance/payables/{row_id}/pay", dependencies=[Depends(require_token)])
def pay_finance_payable(row_id: int, body: FinancePayablePayIn):
    """납부 표시 토글. 반복 항목은 occurrence(회차일)를 주면 그 회차만, 일회성은 전체."""
    s = get_session()
    try:
        p = s.query(FinancePayable).filter_by(id=row_id).first()
        if not p:
            raise HTTPException(status_code=404, detail="Payable not found.")
        # 실제 납부일 — 미지정이면 오늘. 예정일과 달라도 그대로 기록한다.
        paid_on = (body.paid_on or "").strip()[:10] or date.today().isoformat()
        if (p.recurrence or "none") == "none":
            p.paid = bool(body.paid)
            p.paid_date = paid_on if body.paid else ""
        else:
            occ = (body.occurrence or "").strip()
            if not occ:
                raise HTTPException(status_code=400, detail="반복 항목은 회차일(occurrence)이 필요합니다.")
            dates = list(p.paid_dates or [])
            pays = dict(getattr(p, "payments", None) or {})
            if body.paid and occ not in dates:
                dates.append(occ)
            elif not body.paid and occ in dates:
                dates.remove(occ)
            if body.paid:
                pays[occ] = paid_on
            else:
                pays.pop(occ, None)
            p.paid_dates = sorted(dates)
            p.payments = pays
        s.commit()
        return {"ok": True}
    finally:
        s.close()


@app.delete("/api/admin/finance/payables/{row_id}", dependencies=[Depends(require_token)])
def delete_finance_payable(row_id: int):
    s = get_session()
    try:
        p = s.query(FinancePayable).filter_by(id=row_id).first()
        if not p:
            raise HTTPException(status_code=404, detail="Payable not found.")
        s.delete(p)
        s.commit()
        return {"ok": True}
    finally:
        s.close()


def _ar_period_date(r) -> str:
    """매출 인식일 — 송장일 우선, 없으면 만기일, 그래도 없으면 생성일(KST)."""
    for v in (r.invoice_date, r.due_date):
        if (v or "").strip():
            return v[:10]
    if r.created_at:
        return (r.created_at + timedelta(hours=9)).date().isoformat()
    return ""


def _po_period_date(po) -> str:
    for v in (po.date, po.sent_date):
        if (v or "").strip():
            return v[:10]
    if po.created_at:
        return (po.created_at + timedelta(hours=9)).date().isoformat()
    return ""


def _po_cost(po) -> float:
    """벤더 발주 원가 — 품목 amount 합계, 없으면 cost_price×qty 폴백."""
    return _total_amount(po.items) or _items_cost_total(po.items)


@app.get("/api/admin/finance/closing", dependencies=[Depends(require_token)])
def finance_closing(start: str = "", end: str = "", year: int = 0):
    """기간 결산 — 매출(공급가액·매출세액)·매입(원가·추정 매입세액)·마진·부가세(납부/환급).

    통화 혼재는 USD_KRW_RATE 로 KRW 환산해 집계한다. 수출(영세율)은 매출세액 0으로 본다.
    매입세액은 내수 매입 원가의 10% 로 추정(매입 세액 별도 저장이 없음)한다.
    year 를 주면 그 해 12개월 매출/매입 추이(KRW)도 반환한다.
    """
    try:
        d0 = date.fromisoformat(start[:10]) if start else date.today().replace(month=1, day=1)
        d1 = date.fromisoformat(end[:10]) if end else date.today().replace(month=12, day=31)
    except ValueError:
        raise HTTPException(status_code=400, detail="start/end 날짜 형식 오류(YYYY-MM-DD).")
    if not year:
        year = d0.year
    ys, ye = f"{year}-01-01", f"{year}-12-31"
    s0, s1 = d0.isoformat(), d1.isoformat()

    s = get_session()
    try:
        ord_map = {o.id: o for o in s.query(Order).all()}
        cust_names = {c.id: c.name for c in s.query(Customer).all()}

        sales_supply = output_vat = sales_total = 0.0
        by_cust: dict[str, float] = {}
        monthly_sales = [0.0] * 12
        monthly_purchase = [0.0] * 12
        sales_count = 0

        for r in s.query(ARRecord).all():
            pd = _ar_period_date(r)
            if not pd:
                continue
            o = ord_map.get(r.order_id)
            trade = (o.trade_type if o else "수출") or "수출"
            inv_krw = _to_krw(r.invoice_amount or 0, r.currency or "USD")
            vat_rate = 0.0 if trade == "수출" else (r.vat_rate if r.vat_rate is not None else 0.1)
            supply_krw = inv_krw / (1 + vat_rate) if vat_rate else inv_krw
            vat_krw = inv_krw - supply_krw
            if s0 <= pd <= s1:
                sales_supply += supply_krw
                output_vat += vat_krw
                sales_total += inv_krw
                sales_count += 1
                cname = cust_names.get(o.customer_id, "—") if o else "—"
                by_cust[cname] = by_cust.get(cname, 0.0) + supply_krw
            if ys <= pd <= ye:
                monthly_sales[int(pd[5:7]) - 1] += supply_krw

        purchase_cost = input_vat = 0.0
        purchase_count = 0
        for po in s.query(PurchaseOrder).all():
            pd = _po_period_date(po)
            if not pd:
                continue
            o = ord_map.get(po.order_id)
            trade = (o.trade_type if o else "수출") or "수출"
            cur = po.currency or (o.currency if o else "USD") or "USD"
            cost_krw = _to_krw(_po_cost(po), cur)
            vat_krw = cost_krw * 0.1 if trade == "내수" else 0.0
            if s0 <= pd <= s1:
                purchase_cost += cost_krw
                input_vat += vat_krw
                purchase_count += 1
            if ys <= pd <= ye:
                monthly_purchase[int(pd[5:7]) - 1] += cost_krw

        by_customer = [
            {"name": k, "sales_krw": round(v)}
            for k, v in sorted(by_cust.items(), key=lambda kv: kv[1], reverse=True)
        ][:12]

        return {
            "period": {"start": s0, "end": s1, "year": year},
            "sales": {
                "supply_krw": round(sales_supply),
                "vat_krw": round(output_vat),
                "total_krw": round(sales_total),
                "count": sales_count,
            },
            "purchase": {
                "cost_krw": round(purchase_cost),
                "vat_krw": round(input_vat),
                "count": purchase_count,
            },
            "margin_krw": round(sales_supply - purchase_cost),
            "margin_pct": round((sales_supply - purchase_cost) / sales_supply * 100, 1) if sales_supply else 0.0,
            "vat": {
                "output_krw": round(output_vat),
                "input_krw": round(input_vat),
                "payable_krw": round(output_vat - input_vat),  # 양수=납부, 음수=환급
            },
            "by_customer": by_customer,
            "monthly": {
                "labels": ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                           "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
                "sales": [round(x) for x in monthly_sales],
                "purchase": [round(x) for x in monthly_purchase],
            },
            "usd_krw": USD_KRW_RATE,
        }
    finally:
        s.close()


def _cashflow_buckets(unit: str, count: int) -> list[dict]:
    """오늘부터 count개 구간(월/주)의 [start, end, label]. 첫 구간은 과거(연체)를 흡수한다."""
    today = date.today()
    out: list[dict] = []
    if unit == "week":
        for i in range(count):
            start = date.fromordinal(today.toordinal() + i * 7)
            end = date.fromordinal(start.toordinal() + 6)
            out.append({"start": start, "end": end,
                        "label": f"{start.month}/{start.day}~{end.month}/{end.day}"})
    else:  # month
        for i in range(count):
            mm = today.month - 1 + i
            y = today.year + mm // 12
            m = mm % 12 + 1
            start = date(y, m, 1)
            nm, ny = (1, y + 1) if m == 12 else (m + 1, y)
            end = date.fromordinal(date(ny, nm, 1).toordinal() - 1)
            out.append({"start": start, "end": end, "label": f"{y}-{m:02d}"})
    return out


@app.get("/api/admin/finance/cashflow", dependencies=[Depends(require_token)])
def finance_cashflow(unit: str = "month", count: int = 6, opening: float = 0.0,
                     include_po: int = 0, currency: str = "KRW"):
    """현금흐름 — 유입(수금)·유출(지급 + 선택적 벤더 PO)·순증감·누적잔고.

    구간(월/주)별로 유입/유출을 집계하고 opening(기초잔고)부터 누적잔고를 굴린다.
    각 구간은 '아직 안 온 예정'과 '이미 오간 실적'을 함께 담는다 — 이번 달에 이미 받은
    돈이 어디에도 안 보이면 그 달 유입이 0 으로 읽히기 때문이다. 따라서 opening 은
    '오늘 잔고'가 아니라 **첫 구간 시작일 기준 잔고**(월 단위면 이번 달 1일)여야 한다.
    과거(연체)로 이미 지난 예정은 첫 구간에 흡수한다.
    잔고는 한 통화 안에서만 의미가 있으므로 환산하지 않고 `currency` 통화 건만 집계한다.
    include_po=1 이면 벤더 발주(PurchaseOrder) 원가를 발주일 기준 유출로 추정 반영한다.
    """
    unit = "week" if unit == "week" else "month"
    cur_sel = (currency or "KRW").upper()
    count = max(1, min(count, 24))
    buckets = _cashflow_buckets(unit, count)
    ends = [b["end"].isoformat() for b in buckets]

    def bucket_index(iso: str) -> int:
        """날짜가 속한 구간 index — 마지막 구간보다 뒤면 -1, 첫 구간보다 앞(연체)이면 0."""
        for i, e in enumerate(ends):
            if iso <= e:
                return i
        return -1

    s = get_session()
    try:
        inflow = [0.0] * count
        outflow = [0.0] * count
        # 실적(이미 오간 돈)은 따로 세어 행에 같이 실어 준다 — 표에서 '예정이 아니라
        # 이미 들어온 금액'을 구분해 볼 수 있게.
        act_in = [0.0] * count
        act_out = [0.0] * count
        win_start = buckets[0]["start"]
        win_end = buckets[-1]["end"]

        # 유입(예정) — 미수 잔액이 있는 AR + 미수령 기타 수입의 due_date.
        ar_rows = _finance_receivable_rows(s)
        for r in ar_rows + _finance_income_rows(s):
            if r["outstanding"] <= 0 or not r["due_date"]:
                continue
            if (r["currency"] or "KRW").upper() != cur_sel:
                continue
            idx = bucket_index(r["due_date"])
            if idx >= 0:
                inflow[idx] += r["outstanding"]
        # 유입(실적) — 이 구간 안에 실제로 입금된 매출채권·기타 수입.
        # 완납 건은 위 예정 루프에서 outstanding=0 으로 빠지므로 이중계상이 없다.
        for when, amt, cur in _ar_receipts(ar_rows, win_start, win_end):
            if (cur or "KRW").upper() != cur_sel:
                continue
            idx = bucket_index(when)
            if idx >= 0:
                inflow[idx] += amt
                act_in[idx] += amt
        for inc in s.query(FinanceIncome).all():
            if (inc.currency or "KRW").upper() != cur_sel:
                continue
            for when, amt in _settled_occurrences(inc, win_start, win_end):
                idx = bucket_index(when)
                if idx >= 0:
                    inflow[idx] += amt
                    act_in[idx] += amt
        # 유출 — 지급대장. 미납 회차는 예정일에, 납부된 회차는 실제 납부일에 담는다.
        # 첫 구간이 연체를 흡수하도록 과거 1년까지 회차를 펼쳐 담는다.
        scan_start = date.fromordinal(win_start.toordinal() - 400)
        for p in s.query(FinancePayable).all():
            if (p.currency or "KRW").upper() != cur_sel:
                continue
            for occ in _finance_occurrences(p, scan_start, win_end):
                if _finance_payable_paid_on(p, occ):
                    continue
                idx = bucket_index(occ)
                if idx >= 0:
                    outflow[idx] += p.amount or 0
            for when, amt in _settled_occurrences(p, win_start, win_end):
                idx = bucket_index(when)
                if idx >= 0:
                    outflow[idx] += amt
                    act_out[idx] += amt
        # 유출 — 매입 청구(AP). 미지급 잔액은 지급 예정일에, 지급한 금액은 실제 지급일에.
        ap_rows = _ap_record_rows(s)
        ap_po_ids = {ap["po_id"] for ap in ap_rows}
        for ap in ap_rows:
            if ap["outstanding"] <= 0 or not ap["due_date"]:
                continue
            if (ap["currency"] or "KRW").upper() != cur_sel:
                continue
            idx = bucket_index(ap["due_date"])
            if idx >= 0:
                outflow[idx] += ap["outstanding"]
        for when, amt, cur in _ap_payments(ap_rows, win_start, win_end):
            if (cur or "KRW").upper() != cur_sel:
                continue
            idx = bucket_index(when)
            if idx >= 0:
                outflow[idx] += amt
                act_out[idx] += amt
        # 선택: 벤더 발주 원가를 발주일 기준 유출로 추정(AP 청구가 있는 P/O는 중복 방지 위해 제외).
        if include_po:
            ord_map = {o.id: o for o in s.query(Order).all()}
            for po in s.query(PurchaseOrder).all():
                if po.id in ap_po_ids:
                    continue
                pd = _po_period_date(po)
                if not pd:
                    continue
                idx = bucket_index(pd)
                if idx >= 0:
                    o = ord_map.get(po.order_id)
                    cur = po.currency or (o.currency if o else "USD") or "USD"
                    if cur.upper() == cur_sel:
                        outflow[idx] += _po_cost(po)

        rows = []
        cumulative = opening
        for i, b in enumerate(buckets):
            net = inflow[i] - outflow[i]
            cumulative += net
            rows.append({
                "label": b["label"],
                "start": b["start"].isoformat(),
                "end": b["end"].isoformat(),
                "inflow": round(inflow[i]),
                "outflow": round(outflow[i]),
                # 위 금액 중 이미 오간 부분(나머지가 아직 안 온 예정).
                "actual_inflow": round(act_in[i]),
                "actual_outflow": round(act_out[i]),
                "net": round(net),
                "cumulative": round(cumulative),
            })
        return {
            "unit": unit,
            "currency": cur_sel,
            "opening": round(opening),
            # 기초잔고 기준일 — 화면이 '언제 기준으로 넣어야 하는 값'인지 안내한다.
            "opening_as_of": buckets[0]["start"].isoformat(),
            "rows": rows,
            "total_inflow": round(sum(inflow)),
            "total_outflow": round(sum(outflow)),
            "actual_inflow": round(sum(act_in)),
            "actual_outflow": round(sum(act_out)),
            "ending": round(cumulative),
        }
    finally:
        s.close()


@app.get("/api/admin/finance/calendar", dependencies=[Depends(require_token)])
def finance_calendar(start: str = "", end: str = ""):
    """캘린더용 이벤트 — 구간 [start, end] 의 수금 예정(미수 due)·지급 예정(회차) 목록."""
    try:
        d0 = date.fromisoformat(start[:10]) if start else date.today().replace(day=1)
        d1 = date.fromisoformat(end[:10]) if end else date.fromordinal(d0.toordinal() + 62)
    except ValueError:
        raise HTTPException(status_code=400, detail="start/end 날짜 형식이 올바르지 않습니다(YYYY-MM-DD).")
    s = get_session()
    try:
        events: list[dict] = []
        # 수금 — 미수 잔액이 있으면 예정일(due_date)에, 완납이면 실제 입금일에 표시한다.
        # (완납분을 빼면 캘린더가 '실제 들어온 돈'을 안 보여줘서 지급측과 어긋난다.)
        for r in _finance_receivable_rows(s):
            due = r["due_date"]
            if r["outstanding"] > 0 and due and d0.isoformat() <= due <= d1.isoformat():
                events.append({
                    "kind": "receivable",
                    "date": due,
                    "title": r["customer"],
                    "amount": r["outstanding"],
                    "currency": r["currency"],
                    "overdue": r["overdue"],
                    "ref_id": r["id"],
                    "source": "ar",
                })
            # 완납 — 입금일(없으면 11단계 완료일. _finance_receivable_rows 가 폴백까지 계산).
            got = r["paid_date"]
            if r["paid_amount"] > 0 and got and d0.isoformat() <= got <= d1.isoformat():
                events.append({
                    "kind": "receivable",
                    "date": got,
                    "title": r["customer"],
                    "amount": r["paid_amount"],
                    "currency": r["currency"],
                    "paid": True,
                    "paid_on": got,
                    "scheduled": due,
                    "actual": True,   # 예정일이 아니라 '실제 입금일' 자리 → ✓ 표시
                    "ref_id": r["id"],
                    "source": "ar",
                })
        # 수입 예정 — 기타 수입(수동 등록). 반복 회차 포함, 실제 입금일에도 표시.
        customer_names = {c.id: c.name for c in s.query(Customer).all()}
        for r in s.query(FinanceIncome).all():
            who = r.counterparty or customer_names.get(r.customer_id, "") or r.description or "Income"
            for occ in _finance_occurrences(r, d0, d1):
                events.append({
                    "kind": "receivable",
                    "date": occ,
                    "title": who,
                    "category": r.category or "기타",
                    "amount": round(r.amount or 0, 2),
                    "currency": r.currency or "KRW",
                    "paid": _finance_payable_paid_on(r, occ),
                    "paid_on": ((r.paid_date or "") if (r.recurrence or "none") == "none"
                                else (getattr(r, "payments", None) or {}).get(occ, "")),
                    "ref_id": r.id,
                    "occurrence": occ,
                    "source": "income",
                })
            if (r.recurrence or "none") == "none":
                pay_map = {(r.due_date or ""): (r.paid_date or "")} if r.paid else {}
            else:
                pay_map = dict(getattr(r, "payments", None) or {})
            for sched, paid_on in pay_map.items():
                if not paid_on or paid_on == sched or not (d0.isoformat() <= paid_on <= d1.isoformat()):
                    continue
                events.append({
                    "kind": "receivable",
                    "date": paid_on,
                    "title": who,
                    "category": r.category or "기타",
                    "amount": round(r.amount or 0, 2),
                    "currency": r.currency or "KRW",
                    "paid": True,
                    "paid_on": paid_on,
                    "scheduled": sched,
                    "actual": True,
                    "ref_id": r.id,
                    "occurrence": sched,
                    "source": "income",
                })
        # 지급 예정 — 반복 회차 포함.
        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}
        for p in s.query(FinancePayable).all():
            for occ in _finance_occurrences(p, d0, d1):
                events.append({
                    "kind": "payable",
                    "date": occ,
                    "title": (p.counterparty or vendor_names.get(p.vendor_id, "") or p.description or "Payable"),
                    "category": p.category or "기타",
                    "amount": round(p.amount or 0, 2),
                    "currency": p.currency or "KRW",
                    "paid": _finance_payable_paid_on(p, occ),
                    # 실제 납부일(예정일과 다를 수 있음). 일회성은 paid_date.
                    "paid_on": ((p.paid_date or "") if (p.recurrence or "none") == "none"
                                else (getattr(p, "payments", None) or {}).get(occ, "")),
                    "ref_id": p.id,
                    "occurrence": occ,
                })
            # 실제 납부일이 예정일과 다르면 그 날짜에도 한 번 더 표시한다(actual=True).
            # 예정 회차가 이 달 밖이어도 납부가 이 달이면 보이도록 payments 를 직접 훑는다.
            if (p.recurrence or "none") == "none":
                pay_map = {(p.due_date or ""): (p.paid_date or "")} if p.paid else {}
            else:
                pay_map = dict(getattr(p, "payments", None) or {})
            for sched, paid_on in pay_map.items():
                if not paid_on or paid_on == sched:
                    continue
                if not (d0.isoformat() <= paid_on <= d1.isoformat()):
                    continue
                events.append({
                    "kind": "payable",
                    "date": paid_on,
                    "title": (p.counterparty or vendor_names.get(p.vendor_id, "") or p.description or "Payable"),
                    "category": p.category or "기타",
                    "amount": round(p.amount or 0, 2),
                    "currency": p.currency or "KRW",
                    "paid": True,
                    "paid_on": paid_on,
                    "scheduled": sched,
                    "actual": True,
                    "ref_id": p.id,
                    "occurrence": sched,
                })
        # 지급 예정 — 매입 청구(AP) 미지급분(읽기전용, 프로젝트 단계에서 관리).
        for ap in _ap_record_rows(s):
            due = ap["due_date"]
            if ap["outstanding"] > 0 and due and d0.isoformat() <= due <= d1.isoformat():
                events.append({
                    "kind": "payable",
                    "date": due,
                    "title": ap["vendor"] or ap["po_no"] or "Payable",
                    "category": "거래선지급",
                    "amount": ap["outstanding"],
                    "currency": ap["currency"],
                    "paid": False,
                    "ref_id": ap["id"],
                    "occurrence": None,
                    "source": "ap",
                })
        events.sort(key=lambda e: (e["date"], e["kind"]))
        return {"rows": events, "start": d0.isoformat(), "end": d1.isoformat()}
    finally:
        s.close()
