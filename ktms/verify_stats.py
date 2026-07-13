"""읽기 전용 통계 검증 — Statistics 탭의 금액 KPI(Orders Won / Quoted / Revenue)가
어떤 레코드에서 산출되는지 '행 단위'로 풀어서 보여준다. SELECT 만 수행하므로
프로덕션 DB 에 그대로 실행해도 안전하다.

routers/dashboard.py 의 statistics() 집계 로직을 그대로 재현하되, 최종 합계뿐
아니라 각 오더/견적/AR 이 어떤 통화 버킷에 얼마로 들어갔는지 출력한다.
'Orders Won 4,394,340 USD 가 맞는가?' 같은 질문을 이 출력으로 즉시 검증할 수 있다.

사용법 (ktms/ 디렉터리에서):
    DATABASE_URL="postgresql://...neon..." python verify_stats.py
    DATABASE_URL="postgresql://...neon..." python verify_stats.py 2026-07   # 특정 월만
"""
from __future__ import annotations

import sys
from pathlib import Path
from datetime import datetime, timezone, timedelta

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

# Windows 콘솔(cp949)에서도 한글·em-dash 가 깨지지 않도록 UTF-8 출력 강제.
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:
    pass

# 앱과 '완전히 동일한' 집계 함수를 재사용해 로직 차이가 없도록 한다.
from _core import (  # noqa: E402
    get_session, _quotation_total, _total_amount, _cur2, _month_key,
    _rfq_for_order,
)
from db.models import (  # noqa: E402
    Order, Quotation, ARRecord, RFQ, Customer,
)


def month_buckets(n: int = 12) -> list[str]:
    now_kst = datetime.now(timezone.utc) + timedelta(hours=9)
    y, m, out = now_kst.year, now_kst.month, []
    for _ in range(n):
        out.append(f"{y:04d}-{m:02d}")
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    out.reverse()
    return out


def _issue_month(rfq) -> str:
    sd = (getattr(rfq, "stage_dates", None) or {}) if rfq else {}
    return _month_key(sd.get("11") or "")


def main() -> None:
    target = sys.argv[1] if len(sys.argv) > 1 else None
    s = get_session()
    try:
        months = month_buckets(12)
        month_set = set(months)
        cur_month = target or months[-1]
        cust = {c.id: c.name for c in s.query(Customer).all()}
        order_map = {o.id: o for o in s.query(Order).all()}
        print(f"=== 검증 대상 월: {cur_month} (버킷 {months[0]}~{months[-1]}) ===\n")

        # ── Orders Won (수주) ────────────────────────────────────────────────
        print("── Orders Won (order_series) — 오더 수주월 기준 ──")
        won = {"USD": 0.0, "KRW": 0.0}
        rows = []
        for o in order_map.values():
            mo = _month_key(o.date or (o.created_at.isoformat() if o.created_at else ""))
            if mo != cur_month:
                continue
            qtn = s.query(Quotation).filter_by(id=o.quotation_id).first() if o.quotation_id else None
            if qtn:
                bucket = _cur2(qtn.currency)
                amt = _quotation_total(qtn.items or [], getattr(qtn, "discount_pct", 0) or 0)
                src = f"qtn#{qtn.id} currency={qtn.currency!r}"
            else:
                bucket = "USD"
                amt = _total_amount(o.items or [])
                src = "NO-QUOTATION → 강제 USD, order.items amount 합"
            won[bucket] += amt
            rfq = _rfq_for_order(s, o)
            rows.append((o.po_no or f"order#{o.id}", cust.get(o.customer_id, "—"),
                         o.date, bucket, amt, src))
        for po, cn, dt, bucket, amt, src in sorted(rows, key=lambda x: -x[4]):
            flag = "  ⚠️" if (bucket == "USD" and amt > 100000) else ""
            print(f"  {po:<16} {cn:<22} {dt or '—':<12} {bucket} {amt:>14,.0f}  [{src}]{flag}")
        print(f"  → 합계  USD {won['USD']:,.0f} · KRW {won['KRW']:,.0f}\n")

        # ── Quoted (견적) ────────────────────────────────────────────────────
        print("── Quoted (quote_series) — 견적 발송월 기준 ──")
        quoted = {"USD": 0.0, "KRW": 0.0}
        qrows = []
        for q in s.query(Quotation).all():
            mo = _month_key(getattr(q, "sent_at", None) or q.sent_date or q.date or "")
            if mo != cur_month:
                continue
            bucket = _cur2(q.currency)
            amt = _quotation_total(q.items or [], getattr(q, "discount_pct", 0) or 0)
            quoted[bucket] += amt
            qrows.append((q.qtn_no or f"qtn#{q.id}", bucket, q.currency, amt))
        for qn, bucket, rawcur, amt in sorted(qrows, key=lambda x: -x[3]):
            print(f"  {qn:<24} {bucket} (raw={rawcur!r}) {amt:>14,.0f}")
        print(f"  → 합계  USD {quoted['USD']:,.0f} · KRW {quoted['KRW']:,.0f}\n")

        # ── Revenue (매출) — 세금계산서 발행(11단계)월 기준 ──────────────────
        print("── Revenue (rev_series) — 세금계산서(11단계 stage_dates['11'])월 기준 ──")
        rev = {"USD": 0.0, "KRW": 0.0}
        rrows = []
        for a in s.query(ARRecord).all():
            o = order_map.get(a.order_id)
            rfq = _rfq_for_order(s, o) if o else None
            mo = _issue_month(rfq)
            bucket = _cur2(a.currency)
            in_month = (mo == cur_month)
            if in_month:
                rev[bucket] += float(a.invoice_amount or 0)
            rrows.append((a.ci_no or f"ar#{a.id}", mo or "(11단계 미입력)",
                          bucket, float(a.invoice_amount or 0), in_month))
        for ci, mo, bucket, amt, inm in sorted(rrows, key=lambda x: -x[3]):
            mark = "✓" if inm else " "
            print(f"  {mark} {ci:<20} 발행월={mo:<18} {bucket} {amt:>14,.0f}")
        print(f"  → 합계  USD {rev['USD']:,.0f} · KRW {rev['KRW']:,.0f}")
        print("    (11단계 미입력 AR 은 Revenue 에서 제외됨 — Sales 위젯과 불일치의 원인)\n")
    finally:
        s.close()


if __name__ == "__main__":
    main()
