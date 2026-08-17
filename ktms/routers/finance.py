"""K-Maris TMS — finance routes (지급대장·수금/미수·재무 집계·캘린더).

수금(ARRecord 기반 미수)과 지급(FinancePayable: 거래선 지급 + 임차료·급여 등 운영비)을
한데 모아 재무 현황·거래선별 통계·캘린더를 제공한다. 프로젝트 파이프라인과 독립적으로
회사의 재무 활동을 담는 모듈이다.
"""
from __future__ import annotations

from _core import (
    APRecord,
    ARRecord,
    Consultant,
    INBOUND_FEE_CATEGORY,
    INBOUND_FEE_KRW,
    inbound_fee_in,
    Customer,
    Depends,
    Quotation,
    RFQ,
    _project_no_map,
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
from calendar import monthrange

from services.fx import get_deal_base_rate, get_rates


def _to_krw(amount: float, currency: str) -> float:
    """단일 헤드라인 집계용 KRW 환산(USD만 환산, 그 외 원값)."""
    return amount * USD_KRW_RATE if (currency or "").upper() == "USD" else amount


# ('YYYY-MM-DD 조회일', 통화) → (환율, 실제 고시일). 프로세스 메모리 캐시.
_MONTH_RATE_CACHE: dict[tuple[str, str], tuple[float, str]] = {}


def _month_end_rate(ym: str, cur: str) -> tuple[float, str]:
    """그 달 **말일** 기준 매매기준율(1 cur = ? KRW) → (환율, 실제 고시일).

    외화 거래를 원화 손익으로 옮길 때 쓰는 한 가지 규칙이다. 건별로 그날 고시를 쓰면 같은
    달 안에 환율이 여러 개가 되어 '이 달 매출'을 손으로 검산할 수 없고, 고정환율은 해가
    바뀌어도 그대로라 실제와 벌어진다. 달의 마지막 고시 하나로 그 달을 통일한다 — 그래서
    한 달의 모든 줄(매출·매입·수수료)이 같은 환율 위에 서고, 비율이 그대로 읽힌다.

    아직 오지 않은 달(이번 달 포함)은 말일 고시가 없으므로 오늘까지 당겨 조회한다.
    조회 실패(EXIM_API_KEY 미설정·연휴 등)면 고정환율로 폴백하고 고시일을 빈값으로 둔다 —
    화면이 '지금 보는 숫자가 고시 기준인가 고정환율인가'를 밝힐 수 있게.
    """
    cur = (cur or "USD").upper()
    if cur == "KRW":
        return 1.0, ""
    y, m = int(ym[:4]), int(ym[5:7])
    ask = min(date(y, m, monthrange(y, m)[1]), date.today())
    key = (ask.isoformat(), cur)
    if key in _MONTH_RATE_CACHE:
        return _MONTH_RATE_CACHE[key]
    row, used, _err = get_rates(ask.isoformat(), cur)
    if row and row.get("base"):
        out = (float(row["base"]) / float(row.get("unit") or 1), used)
    else:
        # 폴백은 USD 고정환율뿐 — 그 밖의 통화는 환산하지 않는다(_to_krw 와 같은 규약).
        out = (USD_KRW_RATE if cur == "USD" else 1.0, "")
    _MONTH_RATE_CACHE[key] = out
    return out


def _payable_krw(p, amount: float, ym: str, seen: dict | None = None) -> float:
    """지급 한 건의 원화 환산 — 이 건에 적어 둔 적용환율이 있으면 그것을 먼저 쓴다.

    외화 지급은 실제로 송금한 날의 은행 환율로 통장에서 빠져나간다. 그 값을 입력해 두었다면
    그것이 이 지출의 진짜 원화 금액이고, 달의 대표 환율보다 정확하다. 비어 있는 건(아직 안
    낸 예정분 등)만 그 달 말일 고시로 옮긴다.
    """
    cur = (p.currency or "KRW").upper()
    if not amount or cur == "KRW":
        return amount or 0.0
    rate = getattr(p, "fx_rate", None)
    if rate and rate > 0:
        if seen is not None:
            seen[f"{ym}:{cur}:entered"] = {"month": ym, "cur": cur, "rate": round(float(rate), 4),
                                           "date": "", "entered": True}
        return amount * float(rate)
    return _krw_in(amount, cur, ym, seen)


def _krw_in(amount: float, currency: str, ym: str, seen: dict | None = None) -> float:
    """ym('YYYY-MM') 달의 말일 고시로 환산한 원화액. seen 에 쓴 환율을 적어 둔다.

    seen 은 화면에 '무슨 환율로 옮겼는지'를 밝히기 위한 것 — 실제로 환산이 일어난 달만
    담기므로, 원화 거래뿐인 달은 각주에 나타나지 않는다.
    """
    cur = (currency or "KRW").upper()
    if not amount or cur == "KRW":
        return amount or 0.0
    rate, used = _month_end_rate(ym, cur)
    if seen is not None:
        seen[f"{ym}:{cur}"] = {"month": ym, "cur": cur, "rate": round(rate, 4), "date": used}
    return amount * rate


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


def _fx_rate_in(body) -> float | None:
    """저장할 적용환율 — 원화 지급이나 0 이하 입력은 비운다(환산할 것이 없다)."""
    if (body.currency or "KRW").upper() == "KRW":
        return None
    rate = float(body.fx_rate or 0)
    return rate if rate > 0 else None


def _vat_within(amount: float | None, vat: float | None) -> float:
    """총액에 포함시킬 부가세 — 음수와 총액 초과를 막는다(공급가액이 음수가 되지 않도록)."""
    total = round(float(amount or 0.0), 2)
    v = round(float(vat or 0.0), 2)
    if v <= 0:
        return 0.0
    return min(v, abs(total)) if total else 0.0


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

    지급일은 11단계 AP 편집기의 Payment 칸에서 들어온다 — 비어 있으면 어느 달에 나갔는지
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
def finance_summary(month: str = ""):
    """재무 현황 요약 — 잔액(미수·미지급) KPI + 그 달 실제 입출금 + 거래선별 통계.

    통화는 환산하지 않고 통화별로 분리해 합계를 낸다(임의 환율로 뭉치면 실제 잔액과
    어긋나기 때문). 정렬만 KRW→USD→기타 순으로 비교한다.
    month(YYYY-MM)는 '실제로 오간 돈' 집계에만 걸린다 — 미수·미지급 잔액은 특정 달의
    몫이 아니라 오늘 기준 잔액이라 달을 바꿔도 같은 값이어야 한다.
    """
    s = get_session()
    try:
        today = date.today()
        today_str = today.isoformat()
        horizon = (date.fromordinal(today.toordinal() + 30)).isoformat()
        try:
            anchor = date.fromisoformat(f"{month[:7]}-01") if month else today
        except ValueError:
            raise HTTPException(status_code=400, detail="month 형식이 올바르지 않습니다(YYYY-MM).")
        month_start, month_end = _month_bounds(anchor)

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
            # 그 달 실적(예정이 아니라 실제 오간 돈) + 화면이 기간을 링크로 넘길 때 쓸 경계.
            "month": month_start.strftime("%Y-%m"),
            "month_start": month_start.isoformat(),
            "month_end": month_end.isoformat(),
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


def _payable_overdue(p, settled: bool, today_str: str) -> bool:
    """이 지급 건이 연체인가 — 아직 안 낸 채로 지급 예정일이 지났는가.

    반복 항목은 표시 금액이 1회차분이라 '그 회차'만 보면 옛날에 낸 회차 하나로 계속
    정상으로 보인다. 그래서 오늘까지 도래한 회차 중 미납이 하나라도 있으면 연체로 본다
    — Overview 의 Overdue 타일이 세는 것과 같은 규칙이다."""
    if (p.recurrence or "none") == "none":
        return (not settled) and bool(p.due_date) and p.due_date < today_str
    today = date.fromisoformat(today_str)
    start = today - timedelta(days=365)
    return any(
        occ < today_str and not _finance_payable_paid_on(p, occ)
        for occ in _finance_occurrences(p, start, today)
    )


def _inbound_fee_rows(s) -> list[dict]:
    """외화 수금마다 붙는 은행 수취수수료 — 계산해서 세우는 행이다(등록하지 않는다).

    이 비용은 청구서가 오지 않는다. 입금되는 순간 은행이 떼고 나머지만 통장에 꽂히므로,
    아무도 등록하지 않으면 장부에서 영영 빠진다 — 그런데 우리 AR 은 '청구액이 다 들어왔다'로
    기록되니(받은 금액이 아니라) 그 차액만큼 손익이 부풀어 있었다.

    금액은 원화 정액(₩10,000)을 그날 매매기준율로 입금 통화에 옮긴 값이다. 그래서 건마다
    외화 금액이 다르다 — 산출근거를 행마다 함께 적어 두는 이유다(notes).
    원화 수금은 이 수수료가 없으므로 세우지 않는다.
    """
    out: list[dict] = []
    for r in _finance_receivable_rows(s):
        cur = (r["currency"] or "").upper()
        day = (r["paid_date"] or "")[:10]
        # 실제로 들어온 건에만 붙는다 — 입금일을 모르면 어느 날 환율인지도 정할 수 없다.
        if cur in ("", "KRW") or r["paid_amount"] <= 0 or not day:
            continue
        est, rate, used = inbound_fee_in(cur, day)
        quote = (f"₩{rate:,.2f}/{cur}" + (f" · 매매기준율 {used}" if used else " · fixed rate"))
        # 수금할 때 통장 금액과 청구액의 차이로 실제 떼인 금액을 적어 두었으면 그것이 참값이다.
        # 옛 수금(그 기록이 없는 건)은 정액 ₩10,000 을 그날 환율로 옮겨 추정한다.
        actual = round(float(r.get("bank_fee") or 0), 2)
        if actual > 0:
            fee = actual
            basis = f"invoiced {r['invoice_amount']:,.2f} − received {r['invoice_amount'] - actual:,.2f} · {quote}"
        else:
            fee = est
            basis = f"₩{INBOUND_FEE_KRW:,.0f} ÷ {quote}"
        if not fee:
            continue
        out.append({
            # 파생 행이라 실제 지급 id 와 겹치지 않게 음수로 둔다(화면 key 전용).
            "id": -r["id"],
            "source": "bankfee",
            "category": INBOUND_FEE_CATEGORY,
            "counterparty": r["customer"],
            "vendor_id": None,
            "description": f"Receiving fee · {r['invoice_no'] or r['ci_no'] or 'remittance'}",
            "notes": basis,
            "amount": fee,
            "vat_amount": 0.0,
            "invoice_amount": fee,
            # 입금되는 순간 떼인 돈이라 미지급이 남지 않는다 — 언제나 정산 완료다.
            "paid_amount": fee,
            "outstanding": 0.0,
            "currency": cur,
            "fx_rate": rate,
            # 추정이 아니라 통장에서 확인된 금액인가 — 화면·집계가 둘을 가릴 수 있게.
            "actual": actual > 0,
            "bill_date": day,
            "due_date": day,
            "recurrence": "none",
            "recur_until": "",
            "paid": True,
            "overdue": False,
            "paid_date": day,
            "paid_dates": [],
            "payments": {},
            "order_id": r["order_id"],
            "rfq_id": r.get("rfq_id") or 0,
            "owner_id": 0,
            "owner": "",
        })
    return out


@app.get("/api/admin/finance/payables", dependencies=[Depends(require_token)])
def finance_payables():
    """지급대장 목록 — 수동 등록(FinancePayable) + 매입 청구(APRecord, 읽기전용).

    AP 행은 프로젝트 9·10단계에서 편집하므로 여기서는 읽기전용으로 함께 보여준다.
    반복 항목은 캘린더에서 회차로 펼쳐진다.
    외화 수금의 은행 수취수수료(_inbound_fee_rows)도 읽기전용 행으로 합류한다 — 청구서가
    오지 않는 비용이라 계산해 세우지 않으면 장부에서 통째로 빠진다.
    """
    s = get_session()
    try:
        today_str = date.today().isoformat()
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
            row["overdue"] = _payable_overdue(p, settled, today_str)
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
                # 미수 목록과 같은 뜻 — 잔액이 남은 채 지급 예정일이 지난 건.
                "overdue": ap["overdue"],
                "paid_date": ap["paid_date"],
                "paid_dates": [],
                "notes": "",
                "owner_id": 0,
                "owner": "",
            })
        # 외화 수금마다 붙는 은행 수취수수료 — 계산해 세우는 읽기전용 행.
        out.extend(_inbound_fee_rows(s))
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
            vat_amount=_vat_within(body.amount, body.vat_amount),
            currency=body.currency or "KRW",
            fx_rate=_fx_rate_in(body),
            rfq_id=body.rfq_id or None,
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
        p.vat_amount = _vat_within(body.amount, body.vat_amount)
        p.currency = body.currency or "KRW"
        p.fx_rate = _fx_rate_in(body)
        p.rfq_id = body.rfq_id or None
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


def _ar_vat_rate(r, order) -> float:
    """이 청구에 붙은 부가세율 — 수출(영세율)은 0, 내수는 저장값(기본 10%)."""
    trade = (order.trade_type if order else "수출") or "수출"
    if trade == "수출":
        return 0.0
    return r.vat_rate if r.vat_rate is not None else 0.1


def _charges_total(charges) -> float:
    """부대비용 합계 — 운임·포장·보험. 청구서 합계에서 품목 소계 다음에 붙는 세 줄."""
    c = charges or {}
    return sum(float(c.get(k) or 0) for k in ("freight", "packing", "insurance"))


def _ar_supply(r, order) -> float:
    """청구서의 공급가액 = 품목 소계 + 부대비용. 통화는 그대로 둔다(환산하지 않는다).

    '매출'을 말하는 자리는 전부 이 값을 쓴다. 부가세는 고객에게 받아 국가에 내는 돈이라
    우리 매출이 아니고 — 소개 수수료의 근거도 같은 값이어야 한다.

    **총액을 세율로 되나누지 않는다.** 그 세율은 오더의 거래구분(수출/내수)에서 오는데,
    청구서에 실제로 적힌 세금과 어긋날 수 있다: 수출 오더로 잡힌 딜이 국내 고객에게
    부가세 10% 를 붙여 청구하면, 되나누기는 세율을 0 으로 보고 총액을 통째로 매출로
    세운다(₩471,438 짜리 청구서가 공급가액 ₩428,580 이 아니라 ₩471,438 로 서던 이유).
    품목과 부대비용은 서류에 찍힌 값 그대로라 그런 어긋남이 없다.

    품목이 비어 있는 옛 기록만 총액에서 되나눈다. 품목이 있어도 총액과 아귀가 맞지
    않으면(총액을 손으로 고쳐 둔 건 등) 같은 폴백을 쓴다 — 차액이 부가세로 볼 수 있는
    범위(0~30%)를 벗어나면 품목 합계를 그 청구서의 공급가액이라 할 수 없다.
    """
    amount = float(r.invoice_amount or 0.0)
    base = _total_amount(r.items) + _charges_total(getattr(r, "charges", None))
    if base > 0 and 0 <= amount - base <= base * 0.3:
        return base
    rate = _ar_vat_rate(r, order)
    return amount / (1 + rate) if rate else amount


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


def _ap_period_date(ap) -> str:
    """매입 인식일 — 청구서 발행일 우선, 없으면 지급 예정일, 그래도 없으면 생성일(KST).

    매출이 송장일에 서는 것(_ar_period_date)과 짝이다. 발주일이 아니라 청구일인 이유:
    발주는 '사겠다'는 약속이고 비용은 청구서가 와야 확정된다. 발주일로 세면 아직 오지도
    않은 청구가 그 달의 비용이 되고, 견적만 하고 발주로 이어지지 않은 건까지 매입에
    섞인다.
    """
    for v in (ap.bill_date, ap.due_date):
        if (v or "").strip():
            return v[:10]
    if ap.created_at:
        return (ap.created_at + timedelta(hours=9)).date().isoformat()
    return ""


def _ap_amounts(ap) -> tuple[float, float]:
    """벤더 청구 한 건의 (공급가액, 매입세액). 환산 전 — 그 청구서의 통화 그대로.

    총액에서 청구서에 적힌 세율로 부가세를 가른다. 발주 품목 합계가 아니라 청구액을
    쓰므로 운임·포장·보험 같은 부대비용이 원가에 그대로 들어오고, 매입세액도 추정이
    아니라 청구서의 세율이 된다(내수라고 무조건 10% 로 어림하던 것을 없앤다).
    """
    amount = float(ap.invoice_amount or 0.0)
    rate = ap.vat_rate if ap.vat_rate is not None else 0.0
    supply = amount / (1 + rate) if rate else amount
    return supply, amount - supply


@app.get("/api/admin/finance/closing", dependencies=[Depends(require_token)])
def finance_closing(start: str = "", end: str = "", year: int = 0):
    """기간 결산 — 매출(공급가액·매출세액)·매입(원가·추정 매입세액)·마진·부가세(납부/환급).

    외화는 그 거래가 속한 **달의 말일 매매기준율**로 환산한다(_month_end_rate). 수출(영세율)은
    매출세액 0으로 본다.
    프로젝트 매입세액은 내수 매입 원가의 10% 로 추정(매입 세액 별도 저장이 없음)하고,
    기타 지출은 등록 시 공급가액과 나눠 받은 부가세를 그대로 매입세액에 더한다.
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
        # 실제로 환산에 쓴 환율 — 화면 각주가 '무슨 환율로 옮겼는지'를 밝히는 데 쓴다.
        fx_seen: dict[str, dict] = {}

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
            cur = r.currency or "USD"
            ym = pd[:7]
            inv_krw = _krw_in(r.invoice_amount or 0, cur, ym, fx_seen)
            supply_krw = _krw_in(_ar_supply(r, o), cur, ym, fx_seen)
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

        # 매입은 벤더 청구(AP) 기준 — 발주가 아니라 청구서가 비용을 만든다(_ap_period_date).
        purchase_cost = purchase_vat = 0.0
        purchase_count = 0
        for ap in s.query(APRecord).all():
            pd = _ap_period_date(ap)
            if not pd:
                continue
            o = ord_map.get(ap.order_id)
            cur = ap.currency or (o.currency if o else "KRW") or "KRW"
            supply, vat = _ap_amounts(ap)
            cost_krw = _krw_in(supply, cur, pd[:7], fx_seen)
            vat_krw = _krw_in(vat, cur, pd[:7], fx_seen)
            if s0 <= pd <= s1:
                purchase_cost += cost_krw
                purchase_vat += vat_krw
                purchase_count += 1
            if ys <= pd <= ye:
                monthly_purchase[int(pd[5:7]) - 1] += cost_krw

        # 기타 지출(수동 등록 지급대장)의 매입세액 — 임차료·공과금처럼 프로젝트와 무관한
        # 비용도 세금계산서를 받으면 매입세액이 된다. 등록할 때 공급가액과 나눠 받은
        # 부가세를 추정 없이 그대로 쓴다(부가세 0으로 넣은 급여·면세 건은 자연히 빠진다).
        other_supply = other_vat = 0.0
        other_count = 0
        for p in s.query(FinancePayable).all():
            vat = float(getattr(p, "vat_amount", None) or 0.0)
            if vat <= 0:
                continue
            supply = float(p.amount or 0.0) - vat
            cur = p.currency or "KRW"
            if (p.recurrence or "none") == "none":
                # 세금계산서를 받은 날 기준 — 없으면 지급 예정일로 본다.
                pdt = (p.bill_date or "")[:10] or (p.due_date or "")[:10]
                hits = [pdt] if pdt and s0 <= pdt <= s1 else []
            else:
                # 반복 항목(월 임차료 등)은 구간에 든 회차 수만큼 잡는다.
                hits = _finance_occurrences(p, d0, d1)
            # 회차마다 그 달의 환율로 옮긴다 — 여러 달에 걸친 반복 외화 건이 한 환율로
            # 뭉치지 않게(원화 건은 어느 쪽이든 같은 값이라 달라지는 것이 없다).
            for occ in hits:
                other_vat += _payable_krw(p, vat, occ[:7], fx_seen)
                other_supply += _payable_krw(p, supply, occ[:7], fx_seen)
                other_count += 1
        input_vat = purchase_vat + other_vat

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
                "vat_krw": round(purchase_vat),
                "count": purchase_count,
            },
            # 기타 지출 — 마진(매출-매입원가)에는 넣지 않고 부가세 계산에만 쓰는 값.
            "other_costs": {
                "supply_krw": round(other_supply),
                "vat_krw": round(other_vat),
                "count": other_count,
            },
            "margin_krw": round(sales_supply - purchase_cost),
            "margin_pct": round((sales_supply - purchase_cost) / sales_supply * 100, 1) if sales_supply else 0.0,
            "vat": {
                "output_krw": round(output_vat),
                "input_krw": round(input_vat),
                # 매입세액의 출처 — 프로젝트 매입(10% 추정) / 기타 지출(입력값 그대로).
                "input_purchase_krw": round(purchase_vat),
                "input_other_krw": round(other_vat),
                "payable_krw": round(output_vat - input_vat),  # 양수=납부, 음수=환급
            },
            "by_customer": by_customer,
            "monthly": {
                "labels": ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                           "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
                "sales": [round(x) for x in monthly_sales],
                "purchase": [round(x) for x in monthly_purchase],
            },
            "fx": _fx_note(fx_seen),
            "usd_krw": USD_KRW_RATE,
        }
    finally:
        s.close()


def _fx_note(seen: dict) -> dict:
    """환산에 실제로 쓴 환율 목록 — 화면 각주용. 원화뿐인 기간이면 빈 목록이다.

    fallback=True 는 고시를 못 받아 고정환율로 옮긴 건이 섞여 있다는 뜻이다(EXIM_API_KEY
    미설정 등). 숫자만 보면 알 수 없는 사실이라 화면이 그렇다고 말할 수 있어야 한다.
    """
    rows = sorted(seen.values(), key=lambda r: (r["month"], r["cur"]))
    return {
        "basis": "month_end",
        "rates": rows,
        "fallback": any(not r.get("date") and not r.get("entered") for r in rows),
        "fixed": USD_KRW_RATE,
    }


CONSULTING_CATEGORY = "컨설팅비"
DEFAULT_CONSULTING_RATE = 10.0   # 소개 수수료 기본율(%) — 딜·컨설턴트에 값이 없을 때.
INVESTMENT_CATEGORY = "투자금"   # 기타수입 중 자본 유입 — 매출이 아니라 손익에서 뺀다.

# 법인세 과세표준 구간(2023년 개정, 2024 사업연도~) — (구간 상한, 세율).
# 지방소득세(법인분)는 산출 법인세액의 10% 를 따로 더한다.
CORPORATE_BRACKETS: list[tuple[float, float]] = [
    (2e8, 0.09),        # 2억 이하 9%
    (200e8, 0.19),      # 2억 초과 ~ 200억 19%
    (3000e8, 0.21),     # 200억 초과 ~ 3,000억 21%
    (float("inf"), 0.24),  # 3,000억 초과 24%
]


def _corporate_tax(base: float) -> tuple[float, float]:
    """과세표준 → (법인세, 지방소득세). 결손이면 둘 다 0.

    어디까지나 **시뮬레이션**이다. 실제 과세표준은 세무조정(감가상각 한도·접대비 한도·
    이월결손금 공제·세액공제 등)을 거쳐 정해지므로 여기 값과 다르다. 이 숫자의 쓸모는
    '지금 흐름대로 가면 연말에 이만큼을 떼어 둬야 한다'를 매달 눈에 보이게 하는 데 있다.
    """
    if base <= 0:
        return 0.0, 0.0
    tax, lower = 0.0, 0.0
    for upper, rate in CORPORATE_BRACKETS:
        if base <= lower:
            break
        tax += (min(base, upper) - lower) * rate
        lower = upper
    return tax, tax * 0.1


@app.get("/api/admin/finance/consulting", dependencies=[Depends(require_token)])
def finance_consulting():
    """소개 수수료 산출 — 소개자가 걸린 프로젝트마다 '매출 × 수수료율'.

    지급대장의 다른 줄들과 달리 이 금액은 우리가 정하는 값이 아니라 **계산되는** 값이다:
    그 딜이 얼마에 팔렸는지가 정해지면 수수료도 정해진다. 그래서 여기서는 등록된 지급을
    나열하는 대신 근거를 먼저 세운다 — 프로젝트, 매출액, 요율, 그래서 얼마.

    매출액은 그 프로젝트의 고객 청구(AR) **공급가액** 합계다(통화별) — 부가세는 받아서
    국가에 내는 돈이라 우리 매출이 아니고, 손익 화면의 매출줄도 같은 값이라 두 화면을
    나란히 놓고 검산할 수 있어야 한다. 수출(영세율) 건은 총액과 공급가액이 같다.
    아직 청구 전이면 고객 P/O 금액을 임시 근거로 쓰고 basis='order' 로 알린다 — 확정 전
    숫자임을 화면이 밝힐 수 있게. 이미 등록한 컨설팅비 지급은 rfq_id 로 되찾아 같은 줄에
    붙인다(중복 등록 방지).
    """
    s = get_session()
    try:
        consultants = {c.id: c for c in s.query(Consultant).all()}
        rfqs = [r for r in s.query(RFQ).all() if getattr(r, "consultant_id", None)]
        if not rfqs:
            return {"rows": [], "usd_krw": USD_KRW_RATE}
        rfq_ids = {r.id for r in rfqs}
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        qtn_rfq = {q.id: q.rfq_id for q in s.query(Quotation).all()}
        proj_no = _project_no_map(s)

        def rfq_of(o) -> int:
            return (getattr(o, "rfq_id", None)
                    or qtn_rfq.get(getattr(o, "quotation_id", None) or 0) or 0)

        # 프로젝트별 매출 — 청구(AR)가 있으면 그것이 매출이고, 없으면 오더 금액으로 대신한다.
        orders = s.query(Order).all()
        ord_map = {o.id: o for o in orders}
        ord_rfq = {o.id: rfq_of(o) for o in orders}
        invoiced: dict[int, dict[str, float]] = {}
        last_invoice: dict[int, str] = {}
        for r in s.query(ARRecord).all():
            rid = ord_rfq.get(r.order_id) or 0
            if rid not in rfq_ids:
                continue
            cur = (r.currency or "USD").upper()
            supply = _ar_supply(r, ord_map.get(r.order_id))
            invoiced.setdefault(rid, {})[cur] = invoiced.get(rid, {}).get(cur, 0.0) + supply
            when = _ar_period_date(r)
            if when > last_invoice.get(rid, ""):
                last_invoice[rid] = when
        ordered: dict[int, dict[str, float]] = {}
        for o in orders:
            rid = ord_rfq.get(o.id) or 0
            if rid not in rfq_ids or rid in invoiced:
                continue
            cur = (o.currency or "USD").upper()
            ordered.setdefault(rid, {})[cur] = ordered.get(rid, {}).get(cur, 0.0) + _total_amount(o.items)

        # 매출이 실제로 들어왔는가 — 수수료를 언제 내보낼지가 여기서 정해진다. 소개비는
        # 받은 돈에서 떼어 주는 것이라, 고객 돈이 통장에 들어오기 전에는 지급 예정일이
        # 있을 수 없다. 청구가 여러 건이면 마지막 한 건까지 들어와야 '입금 완료'이고,
        # 완납일 판정·폴백(11단계 완료일)은 미수 목록과 같은 규칙을 쓴다.
        collected: dict[int, str] = {}
        pending: set[int] = set()
        for row in _finance_receivable_rows(s):
            rid = row.get("rfq_id") or 0
            # 금액이 서지 않은 청구서(9단계에서 자리만 만들어 둔 것)는 매출에도 들지
            # 않으므로 여기서도 세지 않는다 — 그것 하나 때문에 '아직 미입금'이 되면
            # 다 들어온 딜의 예정일까지 막힌다.
            if rid not in rfq_ids or row["invoice_amount"] <= 0:
                continue
            when = row.get("paid_date") or ""
            # 덜 들어온 건, 그리고 들어왔다지만 날짜를 모르는 건 — 둘 다 '아직'으로 둔다.
            if row["outstanding"] > 0 or not when:
                pending.add(rid)
            elif when > collected.get(rid, ""):
                collected[rid] = when

        # 이미 등록한 수수료 지급 — 프로젝트별로 모아 둔다(한 딜에 분할 지급이 있을 수 있다).
        booked: dict[int, list] = {}
        for p in s.query(FinancePayable).filter_by(category=CONSULTING_CATEGORY).all():
            rid = getattr(p, "rfq_id", None) or 0
            if rid:
                booked.setdefault(rid, []).append(p)

        rows = []
        for r in sorted(rfqs, key=lambda x: proj_no.get(x.id, ""), reverse=True):
            c = consultants.get(r.consultant_id)
            rate = r.consultant_rate
            if rate is None:
                rate = (c.default_rate if c and c.default_rate is not None else DEFAULT_CONSULTING_RATE)
            sales = invoiced.get(r.id) or ordered.get(r.id) or {}
            basis = "invoiced" if r.id in invoiced else ("order" if r.id in ordered else "none")
            # 통화가 섞이면 KRW 로 모아 한 줄로 만든다 — 한 딜의 수수료를 통화별로 쪼개
            # 두 번 지급하지는 않기 때문이다. 단일 통화면 그 통화 그대로 둔다.
            if len(sales) == 1:
                currency, amount = next(iter(sales.items()))
            else:
                currency = "KRW"
                amount = sum(_to_krw(v, k) for k, v in sales.items())
            fee = round(amount * rate / 100.0, 2)
            # 수수료는 **판 통화 그대로** 낸다 — 달러로 받은 돈에서 떼어 달러로 보내는 것이
            # 실제 흐름이라, 여기서 원화로 바꿔 두면 환전 손익이 없는 자리에 환율이 끼어든다.
            # (환율은 실제로 송금하는 순간에만 정해지고, 그 값은 지급 등록 화면에서 받는다.)
            pay_cur, pay_amount = currency, fee
            paid_rows = booked.get(r.id) or []
            rows.append({
                "rfq_id": r.id,
                "project_no": proj_no.get(r.id, ""),
                "rfq_no": r.rfq_no or "",
                "project_title": r.project_title or "",
                "customer": cust_names.get(r.customer_id, "—"),
                "consultant_id": r.consultant_id,
                "consultant": (c.name if c else ""),
                "bank": (f"{c.bank_name} {c.bank_account}".strip() if c and c.bank_account else ""),
                "rate": round(float(rate), 2),
                "currency": currency,
                "sales_amount": round(amount, 2),
                "basis": basis,
                "fee": fee,
                "pay_currency": pay_cur,
                "pay_amount": pay_amount,
                # 마지막 청구일 — 언제 청구가 섰는지를 보여줄 때만 쓴다.
                "invoice_date": last_invoice.get(r.id, ""),
                # 이 프로젝트의 매출이 전액 입금된 날. 아직 덜 들어왔으면 빈값이고,
                # 그때는 지급 예정일도 비워 둔다(화면이 이 날짜 + 1주일로 채운다).
                "collected_date": "" if r.id in pending else collected.get(r.id, ""),
                # 등록된 지급(있으면). 금액은 통화별로 나눠 담아 표에서 그대로 견준다.
                "registered": _sum_by_currency([(p.amount or 0.0, p.currency) for p in paid_rows]),
                "registered_count": len(paid_rows),
            })
        return {"rows": rows, "usd_krw": USD_KRW_RATE}
    finally:
        s.close()


def _payable_occurrences_in_year(p, y0: date, y1: date) -> list[str]:
    """그 해에 이 지급/수입 건이 비용(수입)으로 잡히는 날짜들.

    일회성은 세금계산서를 받은 날(없으면 지급 예정일) 하루, 반복은 그 해에 든 회차일
    전부 — 결산·부가세 화면의 기타 지출 집계와 같은 규약이다. FinanceIncome 도 같은
    필드 구성이라 그대로 통한다(다만 수입에는 bill_date 가 없어 예정일로 떨어진다).
    """
    if (p.recurrence or "none") == "none":
        d = (getattr(p, "bill_date", "") or "")[:10] or (p.due_date or "")[:10]
        return [d] if d and y0.isoformat() <= d <= y1.isoformat() else []
    return _finance_occurrences(p, y0, y1)


@app.get("/api/admin/finance/profit", dependencies=[Depends(require_token)])
def finance_profit(year: int = 0):
    """월별 순수익 — 매출 − 비용 − 세금.

    Closing · VAT 와 같은 발생 기준·같은 환산(그 달 말일 매매기준율)을 쓰되, 거기서 마진 밖에
    세워 두었던 것들(운영비·기타수입·세금)까지 한 장의 손익계산서로 모은다.
    각 줄은 12개월 배열로 돌려주고, 합계와 순수익은 화면에서 더한다 — 세금(추정 부가세)을
    넣고 빼는 스위치가 화면에 있어, 그 계산을 서버가 미리 굳혀 두면 스위치가 무의미해진다.

    - 매출: AR 공급가액(부가세 제외, 송장일 기준). 매입: 벤더 청구(AP) 공급가액(청구일 기준).
      둘 다 '청구서가 선 날'에 잡는다 — 발주일로 세면 아직 청구도 오지 않은 돈이 비용이 되고,
      견적·발주에서 멈춘 딜까지 매입에 섞인다.
    - 소개 수수료: **매출이 선 달에** 그 매출의 요율만큼 잡는다(발생주의). 언제 송금했는지가
      아니라 어느 달의 매출에서 생긴 의무인지가 이 비용의 자리다 — 지급을 미루면 그 달만
      이익이 부풀고 낸 달이 갑자기 적자로 보이던 것을 없앤다. 그래서 등록된 지급 건은
      같은 의무를 또 세지 않도록 합계 밖(consulting_booked)에 정산분으로 따로 둔다.
    - 운영비: 수동 지급대장의 공급가액(부가세 제외 — 매입세액은 세금 줄에서 환급된다).
      '거래선지급' 분류는 벤더 P/O 원가와 겹치므로 합계 밖에 따로 세운다.
    - 투자금: 통장에는 들어오지만 매출이 아니다(자본 유입) — 수익에서 빼고 따로 보인다.
    - 세금: 그 달의 추정 부가세(매출세액 − 매입세액), '세금' 분류 지급액, 그리고 연간
      법인세 추정액을 이익이 난 달에 나눠 실은 값.

    details 는 칸마다의 내역(거래선/금액)이다 — 표는 한 칸에 한 숫자만 보여줄 수 있는데,
    "6월 매입 806만"이 한 건인지 열 건인지가 대개 다음 질문이라 마우스만 올리면 답이 나오게 한다.
    """
    year = year or date.today().year
    y0, y1 = date(year, 1, 1), date(year, 12, 31)
    ys, ye = y0.isoformat(), y1.isoformat()

    def z() -> list[float]:
        return [0.0] * 12

    # 칸별 내역 — {줄 key: {월: {이름: 금액}}}. 같은 상대처의 여러 건은 한 줄로 합친다
    # (툴팁은 '무엇이 들어 있나'를 훑는 자리지 원장이 아니다).
    detail: dict[str, dict[int, dict[str, float]]] = {}

    def note(key: str, i: int, name: str, amount: float) -> None:
        if not amount:
            return
        cell = detail.setdefault(key, {}).setdefault(i, {})
        nm = (name or "—").strip() or "—"
        cell[nm] = cell.get(nm, 0.0) + amount

    s = get_session()
    try:
        orders = s.query(Order).all()
        ord_map = {o.id: o for o in orders}
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}
        # 소개 수수료를 매출과 같은 자리에 붙이기 위한 준비 — 오더가 속한 딜과 그 딜의 요율.
        # 요율이 정해진 딜(소개자가 걸린 딜)만 담는다: 나머지는 곱할 것이 없다.
        qtn_rfq = {q.id: q.rfq_id for q in s.query(Quotation).all()}
        consultants = {c.id: c for c in s.query(Consultant).all()}
        consultant_rate: dict[int, float] = {}
        consultant_name: dict[int, str] = {}
        for r in s.query(RFQ).all():
            cid = getattr(r, "consultant_id", None)
            if not cid:
                continue
            c = consultants.get(cid)
            rate = getattr(r, "consultant_rate", None)
            if rate is None:
                rate = (c.default_rate if c and c.default_rate is not None else DEFAULT_CONSULTING_RATE)
            consultant_rate[r.id] = float(rate)
            consultant_name[r.id] = (c.name if c else "")
        ord_rfq = {o.id: (getattr(o, "rfq_id", None)
                          or qtn_rfq.get(getattr(o, "quotation_id", None) or 0) or 0)
                   for o in orders}

        # 내역에 붙일 프로젝트 번호 — 거래선 이름만으로는 '어느 건인가'가 안 갈린다
        # (한 고객과 여러 딜을 하고, 벤더는 더 그렇다). 번호가 앞에 서면 툴팁의 한 줄이
        # 곧바로 그 프로젝트를 가리킨다.
        proj_no = _project_no_map(s)

        def named_rfq(rfq_id: int, party: str) -> str:
            # 번호만 — 뒤의 수신일(P-011(260714) 의 괄호)은 여기서 가릴 것이 아니다.
            # 툴팁은 한 줄이 좁고, 어느 딜인지는 번호만으로 이미 갈린다.
            no = proj_no.get(rfq_id or 0, "").split("(")[0]
            return f"{no} · {party}" if no else party

        def named(order_id: int, party: str) -> str:
            return named_rfq(ord_rfq.get(order_id or 0) or 0, party)

        fx_seen: dict[str, dict] = {}
        sales, output_vat, consulting = z(), z(), z()
        for r in s.query(ARRecord).all():
            pd = _ar_period_date(r)
            if not pd or not (ys <= pd <= ye):
                continue
            o = ord_map.get(r.order_id)
            cur = r.currency or "USD"
            inv_krw = _krw_in(r.invoice_amount or 0, cur, pd[:7], fx_seen)
            supply_krw = _krw_in(_ar_supply(r, o), cur, pd[:7], fx_seen)
            i = int(pd[5:7]) - 1
            sales[i] += supply_krw
            output_vat[i] += inv_krw - supply_krw
            who = cust_names.get(o.customer_id, "—") if o else "—"
            note("sales", i, named(r.order_id, who), supply_krw)
            # 부가세 내역도 건별로 — 그 달의 세액이 어느 청구서에서 나왔는지가 답이다.
            note("vat", i, named(r.order_id, who), inv_krw - supply_krw)
            # 이 청구가 소개자 있는 딜의 것이면, 같은 달에 수수료도 함께 선다.
            rid = ord_rfq.get(r.order_id) or 0
            rate = consultant_rate.get(rid)
            if rate:
                fee = supply_krw * rate / 100.0
                consulting[i] += fee
                note("consulting", i, named_rfq(rid, f"{consultant_name.get(rid) or '—'} · {who} {rate:g}%"), fee)

        # 매입은 벤더 청구(AP) 기준 — 발주가 아니라 청구서가 비용을 만든다. 발주만 있고
        # 청구가 오지 않은 건은 아직 비용이 아니므로 여기 서지 않는다(견적·발주 단계에서
        # 멈춘 딜이 매입으로 잡히던 것을 없앤다). 예정 지출은 현금흐름 화면이 따로 센다.
        purchase, input_vat_purchase = z(), z()
        for ap in s.query(APRecord).all():
            pd = _ap_period_date(ap)
            if not pd or not (ys <= pd <= ye):
                continue
            o = ord_map.get(ap.order_id)
            cur = ap.currency or (o.currency if o else "KRW") or "KRW"
            supply, vat = _ap_amounts(ap)
            cost_krw = _krw_in(supply, cur, pd[:7], fx_seen)
            vat_krw = _krw_in(vat, cur, pd[:7], fx_seen)
            i = int(pd[5:7]) - 1
            purchase[i] += cost_krw
            who = named(ap.order_id, vendor_names.get(ap.vendor_id, "—"))
            note("purchase", i, who, cost_krw)
            input_vat_purchase[i] += vat_krw
            # 매입세액은 부호를 뒤집어 적는다 — 받은 세액에서 빼는 몫이라, 툴팁의 줄들을
            # 그대로 더하면 그 칸의 값이 나온다.
            note("vat", i, who, -vat_krw)

        # 수동 지급대장 — 분류별로 나눈다. 세금은 세금 줄로, 거래선지급은 합계 밖으로.
        operating: dict[str, list[float]] = {}
        tax_payments, input_vat_other, vendor_manual, consulting_booked = z(), z(), z(), z()
        for p in s.query(FinancePayable).all():
            amount = float(p.amount or 0.0)
            vat = float(getattr(p, "vat_amount", None) or 0.0)
            cat = p.category or "기타"
            # 요율이 걸린 딜의 수수료 지급은 위에서 이미 매출월에 세었다 — 여기서는
            # 정산분으로만 적는다. 근거가 될 딜이 없는 수수료(소개자를 지운 뒤 등록한 건 등)는
            # 아무 데서도 안 세게 되므로 그때만 제 날짜로 비용에 넣는다.
            accrued = cat == CONSULTING_CATEGORY and bool(consultant_rate.get(getattr(p, "rfq_id", None) or 0))
            for occ in _payable_occurrences_in_year(p, y0, y1):
                i = int(occ[5:7]) - 1
                # 환산은 회차마다 — 외화 반복 건이 한 환율로 뭉치지 않게. 적용환율을 적어
                # 둔 건은 그 값이 쓰인다(_payable_krw).
                supply_krw = _payable_krw(p, amount - vat, occ[:7], fx_seen)
                vat_krw = _payable_krw(p, vat, occ[:7], fx_seen)
                input_vat_other[i] += vat_krw
                # 딜에 매인 지급(수수료·거래선지급)은 그 프로젝트 번호를 앞에 세운다 —
                # 위 매출·매입 줄과 같은 규칙이라, 같은 딜의 줄들이 툴팁에서 서로 짝지어진다.
                who = named_rfq(
                    getattr(p, "rfq_id", None) or 0,
                    (p.counterparty or "").strip() or (p.description or "").strip() or "—",
                )
                # 기타 지출의 매입세액도 그 항목 이름으로 — 임차료·공과금이 각자 제 이름으로
                # 부가세 줄에 선다(무엇을 사면서 낸 세금인지가 곧 답이라서).
                note("vat", i, who, -vat_krw)
                if cat == "세금":
                    paid = _payable_krw(p, amount, occ[:7], fx_seen)
                    tax_payments[i] += paid
                    note("tax_payments", i, who, paid)
                elif cat == "거래선지급":
                    vendor_manual[i] += supply_krw
                    note("vendor_manual", i, who, supply_krw)
                elif cat == CONSULTING_CATEGORY:
                    (consulting_booked if accrued else consulting)[i] += supply_krw
                    note("consulting_booked" if accrued else "consulting", i, who, supply_krw)
                else:
                    operating.setdefault(cat, z())[i] += supply_krw
                    note(f"op:{cat}", i, who, supply_krw)

        # 은행 수취수수료 — 외화가 들어오는 순간 떼인 돈이라 등록될 일이 없다. 계산해서
        # 그 입금이 있던 달의 비용으로 세운다(원화로는 건당 정액이라 늘 ₩10,000 이다).
        for f in _inbound_fee_rows(s):
            day = f["due_date"]
            if not (ys <= day <= ye):
                continue
            i = int(day[5:7]) - 1
            # 실제로 떼인 금액이 기록돼 있으면 그것을 그날 환율로 옮긴다. 없으면 정액
            # ₩10,000 을 그대로 쓴다 — 추정 외화 금액을 되곱하면 ₩1 씩 어긋나기 때문이다.
            krw = round(f["amount"] * f["fx_rate"]) if f.get("actual") else INBOUND_FEE_KRW
            operating.setdefault(INBOUND_FEE_CATEGORY, z())[i] += krw
            # 다른 줄들과 같은 형식으로 — 프로젝트 번호와 거래선까지. 송장번호·입금일까지
            # 적으면 한 줄이 길어지기만 한다(그 건의 산출근거 전문은 Outflow 목록에 있다).
            note(f"op:{INBOUND_FEE_CATEGORY}", i, named_rfq(f.get("rfq_id") or 0, f["counterparty"]), krw)

        # 기타수입과 투자금 — 통장에는 나란히 들어오지만 손익에서는 갈린다. 투자금은 판 것이
        # 아니라 넣은 것이라(자본 유입) 수익이 아니고, 여기 섞이면 매출 없는 달이 흑자로 보인다.
        other_income, investment = z(), z()
        for r in s.query(FinanceIncome).all():
            amount = float(r.amount or 0.0)
            cat = r.category or "기타"
            who = (r.counterparty or "").strip() or (r.description or "").strip() or "—"
            for occ in _payable_occurrences_in_year(r, y0, y1):
                i = int(occ[5:7]) - 1
                krw = _krw_in(amount, r.currency or "KRW", occ[:7], fx_seen)
                if cat == INVESTMENT_CATEGORY:
                    investment[i] += krw
                    note("investment", i, who, krw)
                else:
                    other_income[i] += krw
                    note("other_income", i, who, krw)

        input_vat = [input_vat_purchase[i] + input_vat_other[i] for i in range(12)]
        vat = [output_vat[i] - input_vat[i] for i in range(12)]
        # 부가세 줄의 내역은 위 세 곳(매출 청구·벤더 청구·기타 지출)에서 건별로 적어 두었다.
        # 매출세액은 그대로, 매입세액은 부호를 뒤집어 — 줄들을 더하면 그 칸의 값이 된다.

        # 법인세 시뮬레이션 — 연간 세전이익 하나로 세액을 내고, 그것을 이익이 난 달에
        # 그 달 이익의 비중대로 나눠 싣는다. 12로 균등히 나누면 매출이 없던 달까지 세금을
        # 지고 적자로 찍혀, 달을 견주어 보는 이 표에서 오히려 사실을 가린다.
        # (실제 납부는 3월 신고·8월 중간예납이라 현금 시점과는 다르다 — 여기 값은 '떼어 둘 몫'이다.)
        pretax = [sales[i] + other_income[i] - purchase[i] - consulting[i]
                  - sum(v[i] for v in operating.values()) for i in range(12)]
        base = sum(pretax)
        nat_tax, local_tax = _corporate_tax(base)
        total_tax = nat_tax + local_tax
        gains = [x if x > 0 else 0.0 for x in pretax]
        gain_sum = sum(gains)
        corporate = [total_tax * (g / gain_sum) if gain_sum else 0.0 for g in gains]

        def r12(xs: list[float]) -> list[int]:
            return [round(x) for x in xs]

        return {
            "year": year,
            "labels": ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                       "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
            "revenue": {
                "sales": r12(sales),
                "other_income": r12(other_income),
                # 자본 유입 — 수익이 아니라 합계 밖에 세운다.
                "investment": r12(investment),
            },
            "costs": {
                "purchase": r12(purchase),
                # 소개 수수료 — 매출월에 잡은 발생분(합계에 든다).
                "consulting": r12(consulting),
                # 그 의무를 실제로 등록한 지급 건 — 같은 돈이라 합계 밖에 세운다.
                "consulting_booked": r12(consulting_booked),
                # 분류 순서는 등록 폼과 같게 — 표에서 줄이 매달 자리를 바꾸지 않도록.
                "operating": [
                    {"key": cat, "values": r12(operating[cat])}
                    for cat in FINANCE_CATEGORIES if cat in operating
                ],
                "vendor_manual": r12(vendor_manual),
            },
            "taxes": {
                "vat": r12(vat),
                "payments": r12(tax_payments),
                # 연간 추정 법인세를 이익 난 달에 나눠 실은 값(화면 스위치로 켜고 끈다).
                "corporate": r12(corporate),
            },
            "corporate_tax": {
                "base": round(base),               # 세전이익(= 수익 − 비용)
                "national": round(nat_tax),        # 법인세
                "local": round(local_tax),         # 지방소득세(법인세액의 10%)
                "total": round(total_tax),
                # 이 과세표준에 실제로 걸린 최고 구간 — 화면이 근거를 한 줄로 밝히는 데 쓴다.
                "top_rate": next((r for u, r in CORPORATE_BRACKETS if base <= u), CORPORATE_BRACKETS[-1][1]) if base > 0 else 0.0,
            },
            "vat_detail": {"output": r12(output_vat), "input": r12(input_vat)},
            # 칸별 내역 — {줄 key: {월(문자열): {"rows": [{name, amount}], "more": n}}}.
            # 큰 것부터 몇 개만 남긴다: 툴팁은 훑어보는 자리라 다 적으면 오히려 안 읽힌다.
            "details": {
                key: {
                    str(i): _detail_cell(cell)
                    for i, cell in months.items()
                }
                for key, months in detail.items()
            },
            "fx": _fx_note(fx_seen),
            "usd_krw": USD_KRW_RATE,
        }
    finally:
        s.close()


def _detail_cell(cell: dict[str, float], limit: int = 6) -> dict:
    """한 칸의 내역 → 큰 것부터 limit 개 + 나머지 건수. 툴팁 한 화면에 들어갈 만큼만."""
    rows = sorted(cell.items(), key=lambda kv: abs(kv[1]), reverse=True)
    head = [{"name": n, "amount": round(v)} for n, v in rows[:limit]]
    rest = rows[limit:]
    return {"rows": head, "more": len(rest), "more_amount": round(sum(v for _, v in rest))}


def _cashflow_buckets(unit: str, count: int, anchor: date | None = None) -> list[dict]:
    """anchor(기본 오늘)부터 count개 구간(월/주)의 [start, end, label].

    첫 구간은 그 앞의 과거(연체·이미 지난 예정)를 흡수한다. anchor 를 과거로 주면
    올해 1월부터처럼 지난 달을 포함해 되짚어 볼 수 있다.
    """
    today = anchor or date.today()
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
                     include_po: int = 0, currency: str = "KRW", start: str = "",
                     include_overdue: int = 0, include_expected: int = 1):
    """현금흐름 — 유입(수금)·유출(지급 + 선택적 벤더 PO)·순증감·누적잔고.

    아직 오지 않은 돈(예정)을 잔고에 태울지는 두 손잡이로 정한다.

    include_expected=0 이면 **예정은 하나도 잔고를 움직이지 않는다** — 유입·유출·잔고는
    실제로 오간 돈만으로 굴러가고, 예정분은 expected_in/expected_out 으로 따로 실려
    나간다(내역은 그대로 보이되 잔고 밖). 통장을 그대로 비추는 값이라 앞으로의 부족을
    미리 보지는 못한다. include_expected=1(기본)이면 예정을 굴려 앞을 내다본다.

    연체(예정일이 이미 지났는데 아직 안 오간 건)는 그 예정 중에서도 따로 센다. 예정을
    굴릴 때에도 연체는 기본적으로 **잔고에서 뺀다** — 오지 않은 돈으로 굴린 잔고는 그 뒤
    모든 구간을 함께 틀리게 만들기 때문이다. 대신 어느 구간에 얼마가 묶여 있는지를
    overdue_in/overdue_out 으로 따로 실어 보내, 화면이 잔고 옆에 나란히 적을 수 있게
    한다. include_overdue=1 이면 예전처럼 흐름에 넣어 굴린다(그때도 overdue_in/out 은
    '그중 연체분'으로 그대로 온다). 연체는 예정의 부분집합이므로 include_expected=0 이면
    이 손잡이는 뜻을 잃는다 — 아래에서 함께 꺼 버린다.

    구간(월/주)별로 유입/유출을 집계하고 opening(기초잔고)부터 누적잔고를 굴린다.
    각 구간은 '아직 안 온 예정'과 '이미 오간 실적'을 함께 담는다 — 이번 달에 이미 받은
    돈이 어디에도 안 보이면 그 달 유입이 0 으로 읽히기 때문이다. 따라서 opening 은
    '오늘 잔고'가 아니라 **첫 구간 시작일 기준 잔고**(월 단위면 이번 달 1일)여야 한다.
    과거(연체)로 이미 지난 예정은 첫 구간에 흡수한다.
    잔고는 한 통화 안에서만 의미가 있으므로 환산하지 않고 `currency` 통화 건만 집계한다.
    include_po=1 이면 벤더 발주(PurchaseOrder) 원가를 발주일 기준 유출로 추정 반영한다.
    start(YYYY-MM 또는 YYYY-MM-DD)를 주면 그 시점부터 창을 연다 — 올해 1월처럼 지나간
    달을 앞에 붙여 실적을 함께 볼 수 있다. 비우면 오늘부터.
    """
    unit = "week" if unit == "week" else "month"
    # 연체는 예정의 부분집합 — 예정을 통째로 잔고 밖에 세워 두면 연체만 골라 넣을 수 없다.
    include_overdue = int(include_overdue) and int(include_expected)
    cur_sel = (currency or "KRW").upper()
    count = max(1, min(count, 24))
    anchor = None
    if start:
        try:
            anchor = date.fromisoformat(start[:10] if len(start) > 7 else f"{start[:7]}-01")
        except ValueError:
            raise HTTPException(status_code=400, detail="start 날짜 형식이 올바르지 않습니다(YYYY-MM 또는 YYYY-MM-DD).")
    buckets = _cashflow_buckets(unit, count, anchor)
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
        # 그 실적을 출처별로 한 번 더 — 화면의 세 기둥이 '미수·실적 × 매출·기타' 격자라,
        # 실적도 예정과 같은 갈래로 갈라져야 격자의 아래 줄이 채워진다.
        # act_in_ar + act_in_income = act_in (유출도 같다).
        act_in_ar = [0.0] * count
        act_in_income = [0.0] * count
        act_out_ap = [0.0] * count
        act_out_other = [0.0] * count
        # 예정분을 출처별로 한 번 더 나눠 담는다 — 화면이 '수금 예정 / 기타수입 / 지급 예정 /
        # 기타비용' 네 갈래로 보여 주기 때문. 예정과 실적은 서로 겹치지 않으므로
        # in_ar + in_income + actual_inflow = inflow 가 그대로 성립한다(유출도 같다).
        # 단 include_expected=0 이면 예정이 inflow 밖으로 나가므로 이 등식은 깨지고,
        # 네 갈래는 '잔고 밖에 세워 둔 예정'이라는 뜻이 된다(화면이 그렇게 적는다).
        in_ar = [0.0] * count
        in_income = [0.0] * count
        out_ap = [0.0] * count
        out_other = [0.0] * count
        # 연체분 — 예정일이 지났는데 아직 안 오간 돈. 기본은 흐름 밖에 세워 두고(잔고를
        # 굴리지 않는다) 여기에만 담는다. include_overdue=1 이면 흐름에도 함께 담기므로
        # 그때 이 값은 '그중 연체분'이라는 뜻이 된다.
        odue_in = [0.0] * count
        odue_out = [0.0] * count
        # 아직 예정일이 오지 않은 미정산 — 연체와 겹치지 않는 '앞으로 올 예정'이다.
        # include_expected=0 이면 이 돈도 흐름 밖에 서고, 화면은 잔고 옆에 따로 적는다.
        exp_in = [0.0] * count
        exp_out = [0.0] * count
        today_iso = date.today().isoformat()

        def listed(overdue: bool) -> bool:
            """출처별 갈래(in_ar·in_income·out_ap·out_other)에 담을 예정인가.

            잔고에 태우지 않기로 했어도 '무엇이 얼마나 예정되어 있나'는 그대로 보여 준다 —
            화면은 이 갈래들을 잔고 밖 금액으로 적는다. 그래서 여기서는 연체만 가른다.
            """
            return bool(include_overdue) or not overdue

        def flows(overdue: bool) -> bool:
            """흐름(유입·유출·잔고)에 태울 예정인가 — 잔고를 실제로 움직일 건만."""
            return bool(include_expected) and listed(overdue)
        win_start = buckets[0]["start"]
        win_end = buckets[-1]["end"]

        # 유입(예정) — 미수 잔액이 있는 AR + 미수령 기타 수입의 due_date.
        ar_rows = _finance_receivable_rows(s)
        for r, is_ar in [(r, True) for r in ar_rows] + [(r, False) for r in _finance_income_rows(s)]:
            if r["outstanding"] <= 0 or not r["due_date"]:
                continue
            if (r["currency"] or "KRW").upper() != cur_sel:
                continue
            idx = bucket_index(r["due_date"])
            if idx >= 0:
                if r["overdue"]:
                    odue_in[idx] += r["outstanding"]
                else:
                    exp_in[idx] += r["outstanding"]
                if listed(r["overdue"]):
                    (in_ar if is_ar else in_income)[idx] += r["outstanding"]
                if flows(r["overdue"]):
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
                act_in_ar[idx] += amt
        for inc in s.query(FinanceIncome).all():
            if (inc.currency or "KRW").upper() != cur_sel:
                continue
            for when, amt in _settled_occurrences(inc, win_start, win_end):
                idx = bucket_index(when)
                if idx >= 0:
                    inflow[idx] += amt
                    act_in[idx] += amt
                    act_in_income[idx] += amt
        # 유출 — 지급대장. 미납 회차는 예정일에, 납부된 회차는 실제 납부일에 담는다.
        # 첫 구간이 연체를 흡수하도록 과거 1년까지 회차를 펼쳐 담는다.
        scan_start = date.fromordinal(win_start.toordinal() - 400)
        for p in s.query(FinancePayable).all():
            if (p.currency or "KRW").upper() != cur_sel:
                continue
            # 지급대장의 '거래선지급'은 벤더 청구(AP)와 같은 성격이라 지급 예정 쪽에,
            # 임차료·급여·공과금·세금 등은 기타비용 쪽에 담는다.
            is_vendor = (p.category or "기타") == "거래선지급"
            for occ in _finance_occurrences(p, scan_start, win_end):
                if _finance_payable_paid_on(p, occ):
                    continue
                idx = bucket_index(occ)
                if idx >= 0:
                    # 지급대장은 회차마다 예정일이 따로라, 연체 여부도 그 회차 날짜로 본다
                    # (건별 목록 /cashflow/items 와 같은 규칙).
                    od = occ < today_iso
                    if od:
                        odue_out[idx] += p.amount or 0
                    else:
                        exp_out[idx] += p.amount or 0
                    if listed(od):
                        (out_ap if is_vendor else out_other)[idx] += p.amount or 0
                    if flows(od):
                        outflow[idx] += p.amount or 0
            for when, amt in _settled_occurrences(p, win_start, win_end):
                idx = bucket_index(when)
                if idx >= 0:
                    outflow[idx] += amt
                    act_out[idx] += amt
                    (act_out_ap if is_vendor else act_out_other)[idx] += amt
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
                if ap["overdue"]:
                    odue_out[idx] += ap["outstanding"]
                else:
                    exp_out[idx] += ap["outstanding"]
                if listed(ap["overdue"]):
                    out_ap[idx] += ap["outstanding"]
                if flows(ap["overdue"]):
                    outflow[idx] += ap["outstanding"]
        for when, amt, cur in _ap_payments(ap_rows, win_start, win_end):
            if (cur or "KRW").upper() != cur_sel:
                continue
            idx = bucket_index(when)
            if idx >= 0:
                outflow[idx] += amt
                act_out[idx] += amt
                act_out_ap[idx] += amt
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
                        # 청구가 오기 전의 추정치라 늘 '예정' 쪽 — 연체로 세지 않는다.
                        exp_out[idx] += _po_cost(po)
                        out_ap[idx] += _po_cost(po)
                        if include_expected:
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
                # 그 실적의 출처별 내역 — 예정 쪽 in_ar·in_income·out_ap·out_other 와 같은 갈래.
                "actual_in_ar": round(act_in_ar[i]),
                "actual_in_income": round(act_in_income[i]),
                "actual_out_ap": round(act_out_ap[i]),
                "actual_out_other": round(act_out_other[i]),
                # 예정분의 출처별 내역. 실적과 합하면 위 inflow/outflow 가 된다.
                "in_ar": round(in_ar[i]),
                "in_income": round(in_income[i]),
                "out_ap": round(out_ap[i]),
                "out_other": round(out_other[i]),
                # 예정일이 지났는데 아직 안 오간 돈. include_overdue=0 이면 위 inflow/
                # outflow 밖에 있고, 1 이면 그 안에 든 금액 중 연체분이다.
                "overdue_in": round(odue_in[i]),
                "overdue_out": round(odue_out[i]),
                # 아직 예정일이 오지 않은 미정산(연체와 겹치지 않는다). include_expected=0
                # 이면 위 inflow/outflow 밖에 있고, 1 이면 그 안에 든 금액 중 예정분이다.
                "expected_in": round(exp_in[i]),
                "expected_out": round(exp_out[i]),
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
            # 창 전체에 묶여 있는 연체 — 화면이 기말잔고 옆에 '이 잔고 밖의 돈'으로 적는다.
            "overdue_in": round(sum(odue_in)),
            "overdue_out": round(sum(odue_out)),
            "overdue_included": bool(include_overdue),
            # 창 전체의 예정(아직 예정일 전) — 잔고 밖에 세워 두었을 때 그 크기.
            "expected_in": round(sum(exp_in)),
            "expected_out": round(sum(exp_out)),
            # 화면이 '이 집계가 예정을 굴렸나'를 스위치가 아니라 응답으로 보고 정하게 한다
            # (배포 시차 — 옛 백엔드는 이 필드가 없고, 그때는 늘 굴린 값이다).
            "expected_included": bool(include_expected),
            "ending": round(cumulative),
        }
    finally:
        s.close()


# 현금흐름 한 칸을 이루는 여섯 갈래. /cashflow 행의 in_ar·in_income·actual_inflow /
# out_ap·out_other·actual_outflow 와 1:1 로 맞물린다(예정과 실적은 겹치지 않는다).
# 지급대장의 '거래선지급'은 벤더 청구와 같은 성격이라 payables 쪽에서 센다.
_INFLOW_BUCKETS = {"receivables", "income", "collected"}
_CASHFLOW_BUCKETS = {
    "receivables": lambda x: x["kind"] == "ar" and not x["actual"],
    "income": lambda x: x["kind"] == "income" and not x["actual"],
    "collected": lambda x: x["actual"],
    "payables": lambda x: not x["actual"] and (
        x["kind"] in ("ap", "po") or (x["kind"] == "payable" and x["memo"] == "거래선지급")
    ),
    "other": lambda x: not x["actual"] and x["kind"] == "payable" and x["memo"] != "거래선지급",
    "paid": lambda x: x["actual"],
}


@app.get("/api/admin/finance/cashflow/items", dependencies=[Depends(require_token)])
def finance_cashflow_items(start: str = "", end: str = "", currency: str = "KRW",
                           include_po: int = 0, first: int = 0, bucket: str = ""):
    """한 구간의 유입·유출을 건별로 펼친다 — 현금흐름 표의 한 칸을 열어 보는 화면용.

    합계가 /cashflow 의 그 행과 정확히 맞아야 하므로 같은 규칙으로 담는다: 예정은
    예정일(수금 due·지급 회차일), 실적은 실제로 오간 날. first=1 이면 그 구간이 창의
    첫 칸이라는 뜻이고, 앞선 과거(연체·지난 회차)를 여기로 흡수한다.
    bucket 을 주면 그 갈래만 남긴다 — 화면의 여섯 줄(receivables/income/collected/
    payables/other/paid)이 각각 자기 몫만 열어 볼 수 있도록. 남은 합계는 /cashflow 행의
    같은 이름 필드(in_ar·in_income·actual_inflow·out_ap·out_other·actual_outflow)와 맞는다.
    """
    try:
        d0 = date.fromisoformat(start[:10])
        d1 = date.fromisoformat(end[:10])
    except ValueError:
        raise HTTPException(status_code=400, detail="start/end 날짜 형식이 올바르지 않습니다(YYYY-MM-DD).")
    if d1 < d0:
        raise HTTPException(status_code=400, detail="end 는 start 보다 앞설 수 없습니다.")
    cur_sel = (currency or "KRW").upper()
    lo, hi = d0.isoformat(), d1.isoformat()
    # 첫 칸이면 그 앞의 예정분까지 끌어온다(집계의 '연체 흡수'와 같은 규칙).
    sched_lo = "" if first else lo

    def scheduled_in(when: str) -> bool:
        return bool(when) and when <= hi and when >= sched_lo

    inflow: list[dict] = []
    outflow: list[dict] = []
    s = get_session()
    try:
        # 유입 — 미수 잔액(예정)과 실제 입금(실적).
        ar_rows = _finance_receivable_rows(s)
        for r in ar_rows:
            if (r["currency"] or "KRW").upper() != cur_sel:
                continue
            if r["outstanding"] > 0 and scheduled_in(r["due_date"]):
                inflow.append({
                    "kind": "ar", "date": r["due_date"], "party": r["customer"],
                    "ref": r["invoice_no"] or r["ci_no"] or "", "memo": "Receivable",
                    "amount": r["outstanding"], "actual": False, "overdue": bool(r["overdue"]),
                    "row_id": r["id"], "order_id": r["order_id"], "rfq_id": r["rfq_id"], "po_id": 0,
                })
            if r["paid_amount"] > 0 and r["paid_date"] and lo <= r["paid_date"] <= hi:
                inflow.append({
                    "kind": "ar", "date": r["paid_date"], "party": r["customer"],
                    "ref": r["invoice_no"] or r["ci_no"] or "", "memo": "Receipt",
                    "amount": r["paid_amount"], "actual": True, "overdue": False,
                    "row_id": r["id"], "order_id": r["order_id"], "rfq_id": r["rfq_id"], "po_id": 0,
                })
        for r in _finance_income_rows(s):
            if (r["currency"] or "KRW").upper() != cur_sel:
                continue
            if r["outstanding"] > 0 and scheduled_in(r["due_date"]):
                inflow.append({
                    "kind": "income", "date": r["due_date"], "party": r["counterparty"] or "—",
                    "ref": r["description"], "memo": r["category"],
                    "amount": r["outstanding"], "actual": False, "overdue": bool(r["overdue"]),
                    "row_id": r["id"], "order_id": 0, "rfq_id": 0, "po_id": 0,
                })
        for inc in s.query(FinanceIncome).all():
            if (inc.currency or "KRW").upper() != cur_sel:
                continue
            for when, amt in _settled_occurrences(inc, d0, d1):
                inflow.append({
                    "kind": "income", "date": when, "party": inc.counterparty or "—",
                    "ref": inc.description or "", "memo": inc.category or "기타",
                    "amount": amt, "actual": True, "overdue": False,
                    "row_id": inc.id, "order_id": 0, "rfq_id": 0, "po_id": 0,
                })

        # 유출 — 지급대장(예정 회차 + 실제 납부), 매입 청구(AP), 선택적 벤더 P/O 추정.
        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}
        scan_start = date.fromordinal(d0.toordinal() - 400) if first else d0
        for p in s.query(FinancePayable).all():
            if (p.currency or "KRW").upper() != cur_sel:
                continue
            who = p.counterparty or (vendor_names.get(p.vendor_id, "") if p.vendor_id else "") or "—"
            for occ in _finance_occurrences(p, scan_start, d1):
                if _finance_payable_paid_on(p, occ):
                    continue
                outflow.append({
                    "kind": "payable", "date": occ, "party": who,
                    "ref": p.description or "", "memo": p.category or "기타",
                    "amount": round(p.amount or 0, 2), "actual": False,
                    "overdue": occ < date.today().isoformat(),
                    "row_id": p.id, "order_id": 0, "rfq_id": 0, "po_id": 0,
                })
            for when, amt in _settled_occurrences(p, d0, d1):
                outflow.append({
                    "kind": "payable", "date": when, "party": who,
                    "ref": p.description or "", "memo": p.category or "기타",
                    "amount": amt, "actual": True, "overdue": False,
                    "row_id": p.id, "order_id": 0, "rfq_id": 0, "po_id": 0,
                })
        ap_rows = _ap_record_rows(s)
        ap_po_ids = {ap["po_id"] for ap in ap_rows}
        for ap in ap_rows:
            if (ap["currency"] or "KRW").upper() != cur_sel:
                continue
            if ap["outstanding"] > 0 and scheduled_in(ap["due_date"]):
                outflow.append({
                    "kind": "ap", "date": ap["due_date"], "party": ap["vendor"],
                    "ref": ap["bill_no"] or ap["po_no"] or "", "memo": "Vendor bill",
                    "amount": ap["outstanding"], "actual": False, "overdue": bool(ap["overdue"]),
                    "row_id": ap["id"], "order_id": ap["order_id"], "rfq_id": ap["rfq_id"], "po_id": ap["po_id"],
                })
            if ap["paid_amount"] > 0 and ap["paid_date"] and lo <= ap["paid_date"] <= hi:
                outflow.append({
                    "kind": "ap", "date": ap["paid_date"], "party": ap["vendor"],
                    "ref": ap["bill_no"] or ap["po_no"] or "", "memo": "Payment",
                    "amount": ap["paid_amount"], "actual": True, "overdue": False,
                    "row_id": ap["id"], "order_id": ap["order_id"], "rfq_id": ap["rfq_id"], "po_id": ap["po_id"],
                })
        if include_po:
            ord_map = {o.id: o for o in s.query(Order).all()}
            for po in s.query(PurchaseOrder).all():
                if po.id in ap_po_ids:
                    continue
                pd = _po_period_date(po)
                if not scheduled_in(pd):
                    continue
                o = ord_map.get(po.order_id)
                cur = (po.currency or (o.currency if o else "USD") or "USD").upper()
                if cur != cur_sel:
                    continue
                outflow.append({
                    "kind": "po", "date": pd, "party": vendor_names.get(po.vendor_id, "—"),
                    "ref": po.po_no or "", "memo": "P/O cost (est.)",
                    "amount": round(_po_cost(po), 2), "actual": False, "overdue": False,
                    "row_id": po.id, "order_id": po.order_id or 0,
                    "rfq_id": getattr(o, "rfq_id", 0) or 0, "po_id": po.id,
                })

        inflow.sort(key=lambda x: (x["date"], -x["amount"]))
        outflow.sort(key=lambda x: (x["date"], -x["amount"]))
        if bucket:
            if bucket not in _CASHFLOW_BUCKETS:
                raise HTTPException(status_code=400, detail=f"bucket 값이 올바르지 않습니다({', '.join(_CASHFLOW_BUCKETS)}).")
            keep = _CASHFLOW_BUCKETS[bucket]
            inflow = [x for x in inflow if keep(x)] if bucket in _INFLOW_BUCKETS else []
            outflow = [] if bucket in _INFLOW_BUCKETS else [x for x in outflow if keep(x)]
        return {
            "start": lo, "end": hi, "currency": cur_sel, "bucket": bucket,
            "inflow": inflow,
            "outflow": outflow,
            "total_inflow": round(sum(x["amount"] for x in inflow)),
            "total_outflow": round(sum(x["amount"] for x in outflow)),
            "actual_inflow": round(sum(x["amount"] for x in inflow if x["actual"])),
            "actual_outflow": round(sum(x["amount"] for x in outflow if x["actual"])),
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
        # 매입 청구(AP) — 미지급 잔액은 지급 예정일에, 지급한 금액은 실제 지급일에.
        # 수금(AR)과 같은 규칙이라 캘린더에서 예정과 실적이 나란히 읽힌다.
        # 지급 기록은 프로젝트 11단계 AP 탭에서 하므로 여기서는 읽기전용(source="ap").
        for ap in _ap_record_rows(s):
            due = ap["due_date"]
            who = ap["vendor"] or ap["bill_no"] or ap["po_no"] or "Payable"
            if ap["outstanding"] > 0 and due and d0.isoformat() <= due <= d1.isoformat():
                events.append({
                    "kind": "payable",
                    "date": due,
                    "title": who,
                    "category": "거래선지급",
                    "amount": ap["outstanding"],
                    "currency": ap["currency"],
                    "overdue": ap["overdue"],
                    "paid": False,
                    "ref_id": ap["id"],
                    "occurrence": None,
                    "source": "ap",
                })
            # 지급분 — 실제 지급일 자리에 ✓ 로. 부분지급이면 예정일 쪽에 잔액이 함께 남는다.
            got = ap["paid_date"]
            if ap["paid_amount"] > 0 and got and d0.isoformat() <= got <= d1.isoformat():
                events.append({
                    "kind": "payable",
                    "date": got,
                    "title": who,
                    "category": "거래선지급",
                    "amount": ap["paid_amount"],
                    "currency": ap["currency"],
                    "paid": True,
                    "paid_on": got,
                    "scheduled": due,
                    "actual": True,
                    "ref_id": ap["id"],
                    "occurrence": None,
                    "source": "ap",
                })
        events.sort(key=lambda e: (e["date"], e["kind"]))
        return {"rows": events, "start": d0.isoformat(), "end": d1.isoformat()}
    finally:
        s.close()
