"""RFQ 판정(rfq_detect) 백테스트 — 지난 실적을 정답지로 재현율·오탐률·추출 정확도를 잰다.

DB·드라이브는 읽기만 한다(RfqCandidate 에 쓰지 않는다). Claude 호출 비용이 든다(통당 약 1센트).

정답지
  양성: 7/10 이후 Email 로 접수된 딜의 첫 받은 메일(딜 수신일 ±2일 안에서 가장 이른 것)
        — 그 딜의 고객·선박·드라이브 폴더명이 추출값의 정답이다
  음성: ① 같은 딜에 붙은 그 뒤의 받은 메일(회신·발주·독촉 — 새 RFQ 가 아니다)
        ② 미분류 함의 메일  ③ 홍보 메일 답장(미등록 주소의 잡음 대용)
        ①에는 "같은 딜에 품목을 더 묻는" 진짜 RFQ 가 섞일 수 있다 — 오탐 목록을 사람이 본다

    DATABASE_URL=... python scripts/rfq_detect_backtest.py --out 결과.xlsx [--neg 45] [--workers 6]
"""
from __future__ import annotations

import argparse
import random
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]

from db.engine import get_session  # noqa: E402
from db.models import RFQ, Customer, EmailMessage, Vessel  # noqa: E402
from services import drive_svc, rfq_detect  # noqa: E402


def _d(s: str) -> date | None:
    try:
        return date.fromisoformat((s or "")[:10])
    except ValueError:
        return None


def build_set(s, n_neg: int, seed: int = 7) -> list[dict]:
    rows = []
    first_ids = set()
    for r in s.query(RFQ).filter(RFQ.date >= "2026-07-10").all():
        if (r.request_channel or "").lower() != "email":
            continue
        rd = _d(r.date)
        mails = (s.query(EmailMessage).filter_by(rfq_id=r.id, direction="in")
                 .order_by(EmailMessage.sent_at).all())
        first = next((m for m in mails if rd and _d(m.sent_at)
                      and rd - timedelta(days=2) <= _d(m.sent_at) <= rd + timedelta(days=2)), None)
        if not first:
            continue
        first_ids.add(first.id)
        cust = s.query(Customer).filter_by(id=r.customer_id).first() if r.customer_id else None
        ves = s.query(Vessel).filter_by(id=r.vessel_id).first() if r.vessel_id else None
        rows.append({"label": 1, "kind": "첫 RFQ 메일", "email_id": first.id, "rfq_no": r.rfq_no,
                     "true_customer": cust.name if cust else "", "true_vessel_id": r.vessel_id,
                     "true_vessel": ves.name if ves else "", "folder_id": r.drive_folder_id or ""})
    rnd = random.Random(seed)
    later = [m.id for m in s.query(EmailMessage.id).filter(
        EmailMessage.direction == "in", EmailMessage.rfq_id.isnot(None),
        EmailMessage.customer_id.isnot(None)).all() if m.id not in first_ids]
    unmatched = [m.id for m in s.query(EmailMessage.id).filter(
        EmailMessage.direction == "in", EmailMessage.rfq_id.is_(None),
        EmailMessage.vendor_id.is_(None),
        (EmailMessage.match_by.is_(None)) | (EmailMessage.match_by != "marketing")).all()]
    promo = [m.id for m in s.query(EmailMessage.id).filter(
        EmailMessage.direction == "in", EmailMessage.match_by == "marketing").all()]
    for kind, pool, k in (("같은 딜의 후속 메일", later, n_neg), ("미분류 메일", unmatched, 15),
                          ("홍보 답장", promo, 12)):
        for eid in rnd.sample(pool, min(k, len(pool))):
            rows.append({"label": 0, "kind": kind, "email_id": eid})
    return rows


def run_one(row: dict) -> dict:
    s = get_session()
    try:
        m = s.query(EmailMessage).filter_by(id=row["email_id"]).first()
        r = rfq_detect.judge(s, m)
        out = {**row, "sent_at": m.sent_at, "from": m.from_addr, "subject": m.subject or ""}
        if r is None:
            return {**out, "error": "판정 실패"}
        out.update({f"p_{k}": v for k, v in r.items()})
        return out
    finally:
        s.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--neg", type=int, default=45)
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    s = get_session()
    try:
        rows = build_set(s, a.neg)
    finally:
        s.close()
    print(f"정답지: 양성 {sum(r['label'] for r in rows)} · 음성 {sum(1 - r['label'] for r in rows)}")
    with ThreadPoolExecutor(a.workers) as ex:
        res = list(ex.map(run_one, rows))

    th = rfq_detect.THRESHOLD
    pos = [r for r in res if r["label"] == 1 and "error" not in r]
    neg = [r for r in res if r["label"] == 0 and "error" not in r]
    hit = lambda r: bool(r.get("p_is_rfq")) and r.get("p_confidence", 0) >= th  # noqa: E731
    tp = [r for r in pos if hit(r)]
    fp = [r for r in neg if hit(r)]
    for r in pos:
        r["cust_ok"] = (r.get("p_customer_name") or "").strip().lower() == r["true_customer"].strip().lower()
        r["vessel_ok"] = (r["true_vessel_id"] is None) or (r.get("p_vessel_id") == r["true_vessel_id"])
        if r["folder_id"]:
            meta = drive_svc.try_call(drive_svc.get_folder, r["folder_id"])
            r["true_folder"] = meta["name"] if meta else ""
    with_v = [r for r in pos if r["true_vessel_id"]]
    print(f"\n재현율(RFQ 를 RFQ 로): {len(tp)}/{len(pos)} = {len(tp) / max(1, len(pos)):.0%}")
    print(f"오탐률(아닌 것을 RFQ 로): {len(fp)}/{len(neg)} = {len(fp) / max(1, len(neg)):.0%}")
    for kind in ("같은 딜의 후속 메일", "미분류 메일", "홍보 답장"):
        ks = [r for r in neg if r["kind"] == kind]
        print(f"   - {kind}: {sum(hit(r) for r in ks)}/{len(ks)}")
    print(f"고객사 일치: {sum(r['cust_ok'] for r in pos)}/{len(pos)}")
    print(f"선박 일치(선박 있는 딜): {sum(r['vessel_ok'] for r in with_v)}/{len(with_v)}")
    print(f"판정 실패: {sum('error' in r for r in res)}")

    import openpyxl
    from openpyxl.styles import Font
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "판정"
    cols = ["label", "kind", "rfq_no", "sent_at", "from", "subject", "p_is_rfq", "p_confidence",
            "p_reason", "p_customer_name", "true_customer", "cust_ok", "p_vessel", "true_vessel",
            "vessel_ok", "p_item_title", "p_work_type", "p_folder_name", "true_folder", "error"]
    head = ["정답(1=RFQ)", "구분", "딜", "수신", "보낸 주소", "제목", "판정 RFQ", "신뢰도", "판정 근거",
            "추출 고객", "실제 고객", "고객 일치", "추출 선박", "실제 선박", "선박 일치", "품목 제목",
            "타입", "제안 폴더명", "실제 폴더명", "오류"]
    ws.append(head)
    for c in ws[1]:
        c.font = Font(bold=True)
    order = sorted(res, key=lambda r: (-(r["label"]), hit(r) == bool(r["label"]), r.get("sent_at") or ""))
    for r in order:
        ws.append([r.get(k, "") if not isinstance(r.get(k), bool) else ("O" if r[k] else "X")
                   for k in cols])
    for i, w in enumerate([9, 16, 17, 16, 28, 50, 8, 7, 50, 24, 24, 8, 20, 20, 8, 36, 8, 52, 52, 12], 1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(i)].width = w
    ws.freeze_panes = "G2"
    wb.save(a.out)
    print(f"\n저장: {a.out}  (틀린 줄이 위로 온다)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
