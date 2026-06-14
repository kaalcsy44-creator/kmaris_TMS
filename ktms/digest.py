"""
KTMS Daily Follow-up Digest
Emails a summary of urgent Level-A quotes (valid_until D-3) and overdue AR to
the sales/admin team, so follow-ups are not missed without logging in.

Run manually:   python digest.py
Schedule (Windows Task Scheduler / cron), e.g. every weekday 08:30:
    schtasks /create /tn "KTMS Digest" /tr "python C:\\...\\ktms\\digest.py" /sc daily /st 08:30

Recipients (first match wins):
    1. env  KTMS_DIGEST_TO  — comma-separated emails
    2. all active users with an email address
"""
from __future__ import annotations
import os
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from db.engine import get_session
from db.models import User
from app.utils.helpers import dashboard_stats, get_customer, get_order
from services.email_svc import send_email


def _recipients() -> list[str]:
    env = os.getenv("KTMS_DIGEST_TO", "").strip()
    if env:
        return [e.strip() for e in env.split(",") if e.strip()]
    s = get_session()
    try:
        users = s.query(User).filter(User.is_active.is_(True)).all()
        return [u.email for u in users if u.email]
    finally:
        s.close()


def build_body(stats: dict) -> tuple[str, bool]:
    """Returns (body_text, has_content)."""
    lines: list[str] = [f"K-MARIS KTMS — 일일 Follow-up 요약 ({date.today().isoformat()})", ""]

    urgent = stats["urgent_quotes"]
    lines.append(f"■ 긴급 견적 Follow-up (Level A · 만료 임박): {len(urgent)}건")
    if urgent:
        for q in urgent:
            cust = get_customer(q.customer_id)
            lines.append(f"  - {q.qtn_no} | {cust.name if cust else '—'} | 만료 {q.valid_until} | {q.status.value}")
    else:
        lines.append("  (없음)")
    lines.append("")

    overdue = stats["overdue_ar"]
    lines.append(f"■ 연체 AR (미수금 초과): {len(overdue)}건")
    if overdue:
        for ar in overdue:
            order = get_order(ar.order_id)
            outstanding = (ar.invoice_amount or 0) - (ar.paid_amount or 0)
            ord_no = order.ord_no if order else "—"
            lines.append(f"  - {ar.ci_no or 'N/A'} | 오더 {ord_no} | {ar.currency} {outstanding:,.2f} | 만기 {ar.due_date}")
    else:
        lines.append("  (없음)")
    lines.append("")
    lines.append("— KTMS 자동 발송")

    has_content = bool(urgent or overdue)
    return "\n".join(lines), has_content


def main() -> int:
    stats = dashboard_stats()
    body, has_content = build_body(stats)

    if not has_content:
        print("[SKIP] No urgent follow-ups or overdue AR today.")
        return 0

    recipients = _recipients()
    if not recipients:
        print("[ERROR] No recipients (set KTMS_DIGEST_TO or add user emails).")
        print(body)
        return 1

    subject = f"[KTMS] 일일 Follow-up 요약 — {date.today().isoformat()}"
    sent = 0
    for to in recipients:
        if send_email(to=to, subject=subject, body=body):
            sent += 1
            print(f"[OK] sent → {to}")
        else:
            print(f"[FAIL] {to} (SMTP 설정 확인)")
    return 0 if sent else 1


if __name__ == "__main__":
    raise SystemExit(main())
