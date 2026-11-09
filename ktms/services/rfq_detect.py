"""받은 메일 → "새 RFQ 인가" 판정 + 프로젝트 등록에 쓸 값 추출.

입력은 딜에 붙지 않은 받은 메일이다(스레드·문서번호·선박으로 이미 기존 딜에 붙은 메일은
새 RFQ 가 아니다). Claude 에게 한 번 묻고, 답에서 고객사·선박·품목 제목·업무 타입을 받아
KTMS 명부와 맞춘 뒤 제안 폴더명까지 만든다.

첨부 OCR 은 여기서 하지 않는다 — 판정은 가볍게. OCR 은 사람이 승인해 프로젝트를 만들 때 돈다.
결과는 RfqCandidate 로 남고, 자동 승인은 없다(사람이 누른다).
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime

from db.models import Customer, EmailMessage, RfqCandidate, Vessel
from services import drive_svc
from services.mail_summary import strip_quoted
from services.pdf_parser import _anthropic_client

log = logging.getLogger(__name__)

MODEL = "claude-opus-5-5"
BODY_CHARS = 6000
THRESHOLD = 0.5          # 이 신뢰도 이상이고 is_rfq 면 후보 목록에 올린다

# 공용 메일 도메인 — 도메인만으로 고객사를 짐작하면 안 되는 곳.
_FREE_DOMAINS = {"gmail.com", "hotmail.com", "outlook.com", "yahoo.com", "naver.com", "daum.net",
                 "163.com", "126.com", "qq.com", "icloud.com", "live.com", "hanmail.net"}

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["is_rfq", "confidence", "customer_company", "vessel_name", "item_title",
                 "work_type", "reason"],
    "properties": {
        "is_rfq": {"type": "boolean"},
        "confidence": {"type": "number"},
        "customer_company": {"type": "string"},
        "vessel_name": {"type": "string"},
        "item_title": {"type": "string"},
        "work_type": {"type": "string", "enum": ["PARTS", "SERVICE"]},
        "reason": {"type": "string"},
    },
}

PROMPT = """You screen the inbox of K-MARIS, a Korean trader that supplies marine spare parts \
and onboard technical services to ship owners and ship managers. Decide whether this email is \
a NEW request for quotation (RFQ) from a customer — someone asking K-MARIS to quote price/delivery \
for parts, equipment or a service job.

Count as RFQ: a customer's first inquiry for parts/equipment/service, including short ones like \
"please quote attached list", requisitions forwarded by a ship manager, and an existing customer \
asking for a quote on a NEW item or vessel.

NOT an RFQ: a supplier/maker sending a quotation or offer TO K-MARIS; follow-ups, reminders or \
questions about an inquiry already quoted; purchase orders, order confirmations; invoices, \
payments, shipping/logistics notices; newsletters, promotions, cold sales pitches; auto-replies, \
bounces; internal or personal mail.

Extract (use "" when the email does not say):
- customer_company: the requesting company as written in the signature or sender domain
- vessel_name: ship name only, without "MV"/"M/V"/"MT" prefixes
- item_title: 3-8 word project title in English — maker + equipment + what is asked, \
e.g. "HYUNDAI HiMSEN AE CW Pump Spares", "Alfa Laval EPC50B IO Board"
- work_type: SERVICE for repair/inspection/overhaul/onboard work, otherwise PARTS
- confidence: 0.0-1.0 that this is a new RFQ
- reason: one short sentence in Korean explaining the decision

Email
From: {sender}
Known customer in our records: {known}
To/Cc: {recipients}
Date: {sent_at}
Subject: {subject}
Attachments: {attachments}
Body:
{body}"""


def _ask(prompt: str) -> tuple[dict | None, str]:
    """Claude 한 번. (답 dict | None, 사유). 거절·형식 오류는 None — 판정 보류로 남긴다."""
    client = _anthropic_client()
    resp = client.messages.create(
        model=MODEL,
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}],
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
        # 안전 분류기가 잘못 거절해도 같은 요청을 다른 모델로 이어 가게(서버 측 폴백).
        extra_headers={"anthropic-beta": "server-side-fallback-2026-07-01"},
        extra_body={"fallbacks": "default"},
    )
    if resp.stop_reason == "refusal":
        return None, "refusal"
    text = "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", "") == "text")
    try:
        return json.loads(text), ""
    except ValueError:
        return None, "bad json"


# ── KTMS 명부와 맞추기 ─────────────────────────────────────────────────────────

def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def _vessel_core(name: str) -> str:
    return _norm(re.sub(r"^\s*(m/?v|m/?t|mv\.|mt\.)\s+", "", name or "", flags=re.I))


def match_customer(s, msg: EmailMessage, guess: str) -> tuple[Customer | None, str]:
    """(명부의 고객 레코드 | None, 표시용 이름). 메일이 이미 고객에 붙어 있으면 그것,
    아니면 보낸 주소의 회사 도메인, 그다음 메일에서 읽은 회사명으로 찾는다."""
    if msg.customer_id:
        c = s.query(Customer).filter_by(id=msg.customer_id).first()
        if c:
            return c, c.name
    dom = (msg.from_addr or "").rsplit("@", 1)[-1].lower()
    if dom and dom not in _FREE_DOMAINS:
        for c in s.query(Customer).all():
            addrs = [c.email or ""] + list(c.emails or [])
            if any(str(a).lower().endswith("@" + dom) for a in addrs if a):
                return c, c.name
    g = _norm(guess)
    if len(g) >= 4:
        for c in s.query(Customer).all():
            for nm in (c.name, getattr(c, "short_name", None)):
                n = _norm(nm or "")
                if n and len(n) >= 4 and (n in g or g in n):
                    return c, c.name
    return None, guess.strip()


def _pick_vessel(s, hits: list[Vessel], customer_id: int | None) -> Vessel:
    """이름이 같은 선박 레코드가 여럿일 때(같은 배가 두 번 등록됨) — 이 고객의 딜이 가장
    최근에 쓴 것, 없으면 아무 딜이든 가장 최근에 쓴 것, 그것도 없으면 나중에 등록된 것.
    사람이 지금 고르는 레코드가 최근 딜에 남아 있다."""
    from sqlalchemy import func
    from db.models import RFQ
    ids = [v.id for v in hits]
    def last_use(cust):
        q = s.query(RFQ.vessel_id, func.max(RFQ.id)).filter(RFQ.vessel_id.in_(ids))
        if cust:
            q = q.filter(RFQ.customer_id == cust)
        return dict(q.group_by(RFQ.vessel_id).all())
    by_cust, overall = (last_use(customer_id) if customer_id else {}), last_use(None)
    return max(hits, key=lambda v: (by_cust.get(v.id, 0), overall.get(v.id, 0), v.id))


def match_vessel(s, msg: EmailMessage, guess: str,
                 customer_id: int | None = None) -> tuple[Vessel | None, str]:
    """(선박 레코드 | None, 표시용 이름). 메일에서 읽은 이름, 없으면 제목·본문에 적힌 선박."""
    core = _vessel_core(guess)
    vessels = s.query(Vessel).all()
    if len(core) >= 3:
        same = [v for v in vessels if _vessel_core(v.name) == core]
        if same:
            v = _pick_vessel(s, same, customer_id)
            return v, v.name
    hay = _norm(f"{msg.subject or ''} {(msg.body_text or '')[:3000]}")
    hits = [v for v in vessels if len(_vessel_core(v.name)) >= 5 and _vessel_core(v.name) in hay]
    if hits and len({_vessel_core(v.name) for v in hits}) == 1:
        v = _pick_vessel(s, hits, customer_id)
        return v, v.name
    return None, re.sub(r"^\s*(m/?v|m/?t)\.?\s+", "", guess or "", flags=re.I).strip()


# ── 판정 ──────────────────────────────────────────────────────────────────────

def judge(s, msg: EmailMessage) -> dict | None:
    """메일 한 통을 판정한다(DB 에 쓰지 않는다). 실패하면 None."""
    known = ""
    if msg.customer_id:
        c = s.query(Customer).filter_by(id=msg.customer_id).first()
        known = c.name if c else ""
    files = ", ".join(str(a.get("name", "")) for a in (msg.attachments or [])[:15]) or "(none)"
    prompt = PROMPT.format(
        sender=f"{msg.from_name or ''} <{msg.from_addr or ''}>".strip(),
        known=known or "(not registered)",
        recipients=", ".join((msg.to_addrs or [])[:6] + (msg.cc_addrs or [])[:6]) or "-",
        sent_at=msg.sent_at or "-",
        subject=msg.subject or "(no subject)",
        attachments=files,
        body=strip_quoted(msg.body_text or "")[:BODY_CHARS] or "(empty)",
    )
    try:
        ans, why = _ask(prompt)
    except Exception as exc:
        log.warning("rfq_detect: email %s 판정 실패 — %s", msg.id, exc)
        return None
    if ans is None:
        log.info("rfq_detect: email %s 판정 보류 — %s", msg.id, why)
        return None
    cust, cust_name = match_customer(s, msg, ans.get("customer_company") or "")
    ves, ves_name = match_vessel(s, msg, ans.get("vessel_name") or "", cust.id if cust else None)
    label = ((getattr(cust, "short_name", None) or cust.name) if cust else cust_name) or ""
    title = (ans.get("item_title") or "").strip()
    return {
        "is_rfq": bool(ans.get("is_rfq")),
        "confidence": max(0.0, min(1.0, float(ans.get("confidence") or 0))),
        "customer_id": cust.id if cust else None,
        "customer_guess": "" if cust else cust_name[:200],
        "customer_name": cust.name if cust else cust_name,
        "vessel_id": ves.id if ves else None,
        "vessel": ves_name[:120],
        "item_title": title[:200],
        "work_type": ans.get("work_type") if ans.get("work_type") in ("PARTS", "SERVICE") else "PARTS",
        "folder_name": drive_svc.project_folder_name((msg.sent_at or "")[:10], label, ves_name, title),
        "reason": (ans.get("reason") or "")[:400],
    }


def pending_emails(s, since: str = "", limit: int = 30) -> list[EmailMessage]:
    """판정할 메일 — 받은 메일 중 딜에 안 붙었고, 홍보 대화가 아니며, 거래선(벤더)이 보낸
    것이 아니고, 아직 판정하지 않은 것. 최근 것부터."""
    judged = {eid for (eid,) in s.query(RfqCandidate.email_id).all()}
    q = (s.query(EmailMessage)
         .filter(EmailMessage.direction == "in", EmailMessage.rfq_id.is_(None),
                 EmailMessage.vendor_id.is_(None))
         .filter((EmailMessage.match_by.is_(None)) | (EmailMessage.match_by != "marketing")))
    if since:
        q = q.filter(EmailMessage.sent_at >= since)
    out = []
    for m in q.order_by(EmailMessage.sent_at.desc()).all():
        if m.id in judged:
            continue
        out.append(m)
        if len(out) >= limit:
            break
    return out


def run(s, since: str = "", limit: int = 30) -> dict:
    """아직 판정하지 않은 메일을 판정해 RfqCandidate 로 남긴다. 반환: {judged, candidates}."""
    n = c = 0
    for m in pending_emails(s, since, limit):
        r = judge(s, m)
        if r is None:
            continue
        s.add(RfqCandidate(
            email_id=m.id, is_rfq=r["is_rfq"], confidence=r["confidence"],
            customer_id=r["customer_id"], customer_guess=r["customer_guess"] or None,
            vessel_id=r["vessel_id"], vessel=r["vessel"] or None, item_title=r["item_title"] or None,
            work_type=r["work_type"], folder_name=r["folder_name"], reason=r["reason"] or None,
            status="pending", model=MODEL, created_at=datetime.utcnow()))
        s.commit()
        n += 1
        c += int(r["is_rfq"] and r["confidence"] >= THRESHOLD)
    return {"judged": n, "candidates": c}
