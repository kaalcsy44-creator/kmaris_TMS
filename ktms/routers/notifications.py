"""K-Maris TMS — 알림(상단바 종) 라우트.

따로 저장하는 알림 테이블은 없다. 조회할 때마다 이미 있는 데이터에서 '지금 손을 대야
하는 건'을 골라 세운다 — 파이프라인 행(단계·마지막 활동)과 Finance 의 수금/지급 예정일.
그래서 조치를 하면(견적을 보내고, 노트를 남기고, 입금을 기록하면) 알림은 저절로 사라진다.
읽음 표시는 사람마다 다르고 서버가 알 필요가 없어 브라우저(localStorage)에 둔다.
"""
from __future__ import annotations

from _core import (
    Customer,
    Depends,
    FinanceIncome,
    FinancePayable,
    Vendor,
    _ap_record_rows,
    _can,
    _finance_occurrences,
    _finance_payable_paid_on,
    _finance_receivable_rows,
    _project_no_map,
    app,
    cached_aggregate,
    date,
    datetime,
    get_current_user,
    get_session,
    require_token,
    timedelta,
)
from routers.dashboard import pipeline_overview

# 수금·지급 예정일을 며칠 전부터 알릴 것인가(D-3).
DUE_SOON_DAYS = 3
# 반복 지급·수입의 지난 회차는 이만큼만 거슬러 본다 — 그보다 오래된 미납은
# 알림이 아니라 장부 정리의 문제다.
RECUR_LOOKBACK_DAYS = 90

# 파이프라인 단계별 '대응 없이 이만큼 지나면 알린다'(warn 일수, urgent 일수, 문구).
# 경과일은 카드의 경과일 배지와 같은 기준 — 마지막 활동(단계 완료·추가 발송/수신·노트)
# 이후. 팔로업을 하고 노트를 남기면 시계가 다시 돈다.
STAGE_RULES: dict[int, tuple[int, int, str]] = {
    1: (2, 5, "RFQ received — not yet sent to vendors"),
    2: (5, 10, "Waiting for vendor quote"),
    3: (2, 5, "Vendor quote in — customer quote not sent"),
    4: (7, 14, "Quote sent — no customer response"),
    5: (2, 5, "Customer P/O in — vendor P/O not issued"),
}
# 6단계 이후(발주~세금계산서)는 원래 몇 주씩 걸린다 — 오래 멈췄을 때만 알린다.
LATE_STAGE_RULE = (14, 30, "No activity")


def _days_between(a: str, b: date) -> int | None:
    try:
        return (b - date.fromisoformat((a or "")[:10])).days
    except ValueError:
        return None


def _due_alert(kind: str, ref: str, due: str, today: date, *, title: str, amount: float,
               currency: str, href: str, project_no: str = "") -> dict | None:
    """예정일 기준 알림 1건 — 연체면 urgent, D-3 이내면 warn/info. 범위 밖이면 None."""
    d = _days_between(due, today)   # 양수 = 지남
    if d is None or d < -DUE_SOON_DAYS:
        return None
    word = "Payment due" if kind == "receivable" else "Payment to make"
    if d > 0:
        level, when = "urgent", f"overdue {d}d"
    elif d == 0:
        level, when = "warn", "due today"
    else:
        level, when = ("warn" if d >= -1 else "info"), f"D{d}"
    return {
        "id": f"{kind}:{ref}:{due[:10]}",
        "type": kind,
        "level": level,
        "title": f"{word} · {when}",
        "detail": title,
        "project_no": project_no,
        "amount": round(amount or 0, 2),
        "currency": currency or "",
        "date": due[:10],
        "days": d,
        "href": href,
    }


def _finance_alerts(s, today: date) -> list[dict]:
    out: list[dict] = []
    pno = _project_no_map(s)
    lo = today - timedelta(days=RECUR_LOOKBACK_DAYS)
    hi = today + timedelta(days=DUE_SOON_DAYS)

    # 받을 돈 — 프로젝트 매출(AR)
    for r in _finance_receivable_rows(s):
        if r["outstanding"] <= 0 or not r["due_date"]:
            continue
        a = _due_alert("receivable", f"ar{r['id']}", r["due_date"], today,
                       title=r["customer"] + (f" · {r['invoice_no']}" if r["invoice_no"] else ""),
                       amount=r["outstanding"], currency=r["currency"],
                       href="/finance?tab=inflow", project_no=pno.get(r["rfq_id"], ""))
        if a:
            out.append(a)
    # 받을 돈 — 기타 수입(수동 등록, 반복 회차 포함)
    cust = {c.id: c.name for c in s.query(Customer).all()}
    for r in s.query(FinanceIncome).all():
        who = r.counterparty or cust.get(r.customer_id, "") or r.description or "Income"
        for occ in _finance_occurrences(r, lo, hi):
            if _finance_payable_paid_on(r, occ):
                continue
            a = _due_alert("receivable", f"inc{r.id}", occ, today, title=who,
                           amount=r.amount or 0, currency=r.currency or "KRW",
                           href="/finance?tab=inflow")
            if a:
                out.append(a)

    # 낼 돈 — 수동 등록(임차료·급여 등 반복 회차 포함)
    vend = {v.id: v.name for v in s.query(Vendor).all()}
    for p in s.query(FinancePayable).all():
        who = p.counterparty or vend.get(p.vendor_id, "") or p.description or "Payable"
        for occ in _finance_occurrences(p, lo, hi):
            if _finance_payable_paid_on(p, occ):
                continue
            a = _due_alert("payable", f"pay{p.id}", occ, today,
                           title=f"{who} · {p.category}" if p.category else who,
                           amount=p.amount or 0, currency=p.currency or "KRW",
                           href="/finance?tab=outflow")
            if a:
                out.append(a)
    # 낼 돈 — 매입 청구(AP)
    for ap in _ap_record_rows(s):
        if ap["outstanding"] <= 0 or not ap["due_date"]:
            continue
        a = _due_alert("payable", f"ap{ap['id']}", ap["due_date"], today,
                       title=ap["vendor"] + (f" · {ap['po_no']}" if ap["po_no"] else ""),
                       amount=ap["outstanding"], currency=ap["currency"],
                       href="/finance?tab=outflow", project_no=pno.get(ap["rfq_id"], ""))
        if a:
            out.append(a)
    return out


def _pipeline_alerts(rows: list[dict], today: date) -> list[dict]:
    out: list[dict] = []
    for r in rows:
        stage = r.get("stage") or 0
        if r.get("cancelled") or stage < 1 or stage >= 11:
            continue
        warn, urgent, text = STAGE_RULES.get(stage, LATE_STAGE_RULE)
        # 마지막 활동 — 단계 일시(수동/자동)·추가 발송/수신·노트 중 가장 늦은 것.
        times = [v for d in (r.get("stage_dates") or {}, r.get("stage_auto") or {})
                 for v in d.values() if v]
        times += [e.get("sent_at") or "" for e in r.get("rfq_sends") or []]
        times += [e.get("received_at") or "" for e in r.get("quote_receipts") or []]
        for notes in (r.get("stage_notes") or {}).values():
            for n in notes or []:
                if isinstance(n, dict) and (n.get("datetime") or n.get("at")):
                    times.append(n.get("datetime") or n.get("at"))
        times = [t for t in times if t]
        if not times:
            continue
        last = max(times)
        days = _days_between(last, today)
        if days is None or days < warn:
            continue
        level = "urgent" if days >= urgent else "warn"
        stage_at = ((r.get("stage_dates") or {}).get(str(stage))
                    or (r.get("stage_auto") or {}).get(str(stage)) or "")
        label = r.get("project_title") or r.get("customer") or ""
        out.append({
            # 단계와 수준을 id 에 넣는다 — 단계가 바뀌거나 warn→urgent 로 오르면 다시 안 읽음.
            "id": f"deal:{r['rfq_id']}:{stage}:{level}",
            "type": "deal",
            "level": level,
            "title": f"{text} · {days}d",
            "detail": label,
            "customer": r.get("customer") or "",
            "project_no": r.get("project_no") or "",
            "assignee": r.get("assignee") or "",
            "amount": None,
            "currency": "",
            "date": stage_at[:10],
            "days": days,
            "href": f"/project?rfq={r['rfq_id']}&stage={stage}",
        })
    return out


_LEVEL_ORDER = {"urgent": 0, "warn": 1, "info": 2}


@app.get("/api/admin/notifications", dependencies=[Depends(require_token)])
@cached_aggregate()
def notifications(mine: int = 1, user: dict = Depends(get_current_user)):
    """상단바 알림 — 팔로업이 필요한 딜 + 다가오거나 지난 수금·지급 예정.

    mine=1 이면 본인 담당 딜만(기본). 'own' 권한 역할은 파이프라인 규칙대로 늘 본인 것만.
    Finance 알림은 finance 열람 권한이 있을 때만 싣는다."""
    role = user.get("role", "")
    today = (datetime.utcnow() + timedelta(hours=9)).date()  # KST — 카드 경과일과 같은 날짜
    items: list[dict] = []
    if _can(role, "progress", "view"):
        pl = pipeline_overview(customer_id=None, work_type=None, mine=mine,
                               assignee=None, user=user)
        items += _pipeline_alerts(pl.get("rows") or [], today)
    if _can(role, "finance", "view"):
        s = get_session()
        try:
            items += _finance_alerts(s, today)
        finally:
            s.close()
    items.sort(key=lambda a: (_LEVEL_ORDER.get(a["level"], 9), -(a.get("days") or 0)))
    return {"items": items, "today": today.isoformat()}
