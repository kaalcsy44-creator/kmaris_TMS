"""KTMS 밖에서 보낸 홍보 메일을 메일함에서 찾아 마케팅 발송 이력으로 옮긴다.

홍보 메일이 늘 KTMS 의 발송 창(routers/marketing.py)에서 나가는 것은 아니다. 메일
프로그램에서 바로 쓰기도 하고, 한 사람에게 공들여 따로 쓰기도 한다. 그런 메일도
IMAP 동기화가 보낸편지함에서 담아 오지만, 딜이 없으니 Mail 화면의 미분류·딜 아님
함에 쌓일 뿐 마케팅 표에는 오르지 않는다 — 답장 감지(marketing_reply)도 그래서
그 메일들에는 돌지 않는다.

여기서 하는 일은 둘이다.
  candidates()  담긴 발신 메일 중 홍보로 보이는 것을 고른다(제안만 한다).
  log_as_promo() 사람이 고른 메일을 수신자 한 명당 한 줄씩 MarketingActivity 로 만든다.

**기계는 제안만 한다** — marketing_reply 와 같은 원칙이다. 후보는 화면에 세워 두고,
마케팅 표에 오르는 것은 사람이 Log 를 눌렀을 때뿐이다. 홍보가 아니라고 내린 메일은
다시 후보로 올리지 않는다(DISMISS_KEY).
"""
from __future__ import annotations

import re

from sqlalchemy import func

from db.models import Customer, EmailMessage, MarketingActivity, User
from services import mail_sync

# 홍보가 아니라고 내린 발신 메일 id — 다음 판별에서 다시 세우지 않는다.
DISMISS_KEY = "mail_promo_dismissed"

# 판별 근거. 좁게 잡는다 — "introduction" 은 견적 메일에도 나오지만, 첫 메일의
# **제목**에 서는 일은 드물다. 본문은 앞머리만 본다(인사 다음 두어 줄에 회사 소개가 온다).
_SUBJECT_RE = re.compile(
    r"introduc|supplier registration|vendor registration|potential supplier"
    r"|reliable (?:vendor|supplier|supply)|supply partner|sourcing support"
    r"|company (?:profile|catalog|catalogue|brochure)|greetings from k-?maris",
    re.I)
_ATTACH_RE = re.compile(r"catalog|catalogue|brochure|company[ _-]?profile|introduc|소개서", re.I)
_BODY_RE = re.compile(
    r"(?:introduce|introducing|introduction of)\s+(?:\*?k-?maris|our company|ourselves|myself)"
    r"|greetings from \*?k-?maris|my name is .{2,40} from \*?k-?maris"
    r"|company catalog(?:ue)?",
    re.I)
# 답장·전달 표시(앞머리 [태그] 뒤에 붙어도). mail_sync._REPLY_MARK_RE 는 [태그] 자체도
# 걷어내는 규칙이라 그대로 쓰면 "[K-MARIS] Introduction" 까지 답장으로 읽는다.
_REPLY_RE = re.compile(
    r"^\s*(?:\[[^\]\r\n]{1,40}\]\s*)*"
    r"(?:re|ref|reply|fw|fwd|forward(?:ed)?|답장|회신|전달|回复|回覆|答复|回信|轉發|转发|轉寄|转寄)"
    r"\s*(?:\[\d+\])?\s*[:：]", re.I)
# 본문은 이만큼만 읽는다 — 수백 통을 훑을 때 DB 전송량을 아끼려고(앞머리면 충분하다).
_BODY_HEAD = 800

# 개인 메일 도메인 — 잠정사 이름을 주소에서 지을 때 도메인 대신 주소를 쓴다.
_FREEMAIL = {"gmail.com", "naver.com", "daum.net", "hanmail.net", "yahoo.com", "hotmail.com",
             "outlook.com", "live.com", "icloud.com", "qq.com", "163.com", "126.com"}


def _is_reply(subject: str, in_reply_to: str) -> bool:
    """답장·전달은 홍보의 '첫 발송'이 아니다 — 그건 대화의 이음매다."""
    if (in_reply_to or "").strip():
        return True
    return bool(_REPLY_RE.match(subject or ""))


def _own_domain() -> str:
    user = (mail_sync.mail_config().get("user") or "").strip().lower()
    return user.split("@", 1)[1] if "@" in user else ""


def external_recipients(to_addrs, cc_addrs, own: set[str], own_domain: str) -> list[str]:
    """받는 사람 중 바깥 사람. 받는 사람(To)이 우선이고, To 가 전부 우리 쪽이면(나에게
    보내고 숨은참조로 돌린 경우 등) 참조(Cc)에서 찾는다. 같은 주소는 한 번만."""
    def ext(addrs) -> list[str]:
        out = []
        for a in addrs or []:
            a = str(a or "").strip().lower()
            if not a or "@" not in a or a in own or a in out:
                continue
            if own_domain and a.endswith("@" + own_domain):
                continue
            out.append(a)
        return out
    return ext(to_addrs) or ext(cc_addrs)


def looks_promo(subject: str, attachments, body_head: str) -> str:
    """홍보로 보이는 근거 한 마디(화면에 그대로 보인다). 없으면 빈 문자열."""
    if _SUBJECT_RE.search(subject or ""):
        return "subject"
    if any(_ATTACH_RE.search(str((a or {}).get("name") or "")) for a in (attachments or [])):
        return "attachment"
    if _BODY_RE.search(body_head or ""):
        return "body"
    return ""


def _logged_pairs(s) -> tuple[set[int], set[tuple[str, str]]]:
    """이미 마케팅 표에 오른 것 — (원본 메일 id들, (수신 주소, 발송일) 쌍).

    KTMS 발송 창에서 보낸 메일도 보낸편지함에 남아 메일함으로 돌아온다. 그건 이미
    발송할 때 활동이 만들어졌으니, 같은 주소·같은 날의 활동이 있으면 등록된 것으로 본다."""
    ids, pairs = set(), set()
    for mid, addr, day in s.query(MarketingActivity.sent_email_id,
                                  MarketingActivity.recipient_email,
                                  MarketingActivity.activity_date).all():
        if mid:
            ids.add(int(mid))
        a = (addr or "").strip().lower()
        if a and day:
            pairs.add((a, day[:10]))
    return ids, pairs


def dismissed(s) -> set[int]:
    return {int(x) for x in (mail_sync._setting(s, DISMISS_KEY, []) or []) if str(x).isdigit()}


def candidates(s) -> list[dict]:
    """홍보로 보이는데 아직 마케팅 표에 없는 발신 메일.

    대상: 우리가 보낸(out) 대화의 첫 메일, 어느 딜에도 붙지 않은 것(미분류든 딜
    아님이든), 바깥 수신자가 있는 것. 반환은 메일 단위
    [{id, why, recipients}] — 묶음은 화면 쪽(라우터)에서 제목으로 짓는다."""
    own = mail_sync.own_addresses(s)
    own_domain = _own_domain()
    logged_ids, logged = _logged_pairs(s)
    skip = logged_ids | dismissed(s)
    rows = (s.query(EmailMessage.id, EmailMessage.subject, EmailMessage.in_reply_to,
                    EmailMessage.to_addrs, EmailMessage.cc_addrs, EmailMessage.attachments,
                    EmailMessage.sent_at,
                    func.substr(EmailMessage.body_text, 1, _BODY_HEAD))
            .filter(EmailMessage.direction == "out", EmailMessage.rfq_id.is_(None))
            .all())
    out = []
    for mid, subject, irt, to_addrs, cc_addrs, attachments, sent_at, body_head in rows:
        if mid in skip or _is_reply(subject or "", irt or ""):
            continue
        recips = external_recipients(to_addrs, cc_addrs, own, own_domain)
        day = (sent_at or "")[:10]
        recips = [a for a in recips if (a, day) not in logged]
        if not recips:
            continue
        why = looks_promo(subject or "", attachments, body_head or "")
        if why:
            out.append({"id": mid, "why": why, "recipients": recips})
    return out


def _prospect_name(addr: str) -> str:
    """미등록 상대의 잠정사 이름 — 회사 도메인(예: seasourcing.com). 개인 메일이면 주소."""
    domain = addr.split("@", 1)[1] if "@" in addr else ""
    return addr if (not domain or domain in _FREEMAIL) else domain


def log_as_promo(s, ids: list[int], user_id: int | None = None) -> dict:
    """고른 메일(대화 묶음 전체가 와도 된다) 중 우리가 보낸 첫 메일을 홍보 발송으로 등록한다.

    수신자 한 명당 한 줄 — KTMS 발송 창이 받는 사람마다 따로 보내고 따로 적는 것과
    같은 모양이어야 답장 감지·후속일이 똑같이 돈다. 담당자는 보낸 주소의 사용자,
    없으면 누른 사람. 같은 주소·같은 날의 활동이 이미 있으면 건너뛴다.

    등록한 대화는 미분류 함에서 내린다(딜 아님) — 홍보 메일은 딜이 아니다."""
    picked = {int(i) for i in ids or []}
    msgs = (s.query(EmailMessage).filter(EmailMessage.id.in_(picked)).all() if picked else [])
    own = mail_sync.own_addresses(s)
    own_domain = _own_domain()
    _, logged = _logged_pairs(s)
    parties = mail_sync.party_index(s)
    users = {(e or "").strip().lower(): uid for uid, e in s.query(User.id, User.email).all() if e}
    contacts = {cid: (name or "") for cid, name in s.query(Customer.id, Customer.contact).all()}

    outs = [m for m in sorted(msgs, key=lambda x: (x.sent_at or "", x.id))
            if m.direction == "out" and not m.rfq_id
            and external_recipients(m.to_addrs, m.cc_addrs, own, own_domain)]
    firsts = [m for m in outs if not _is_reply(m.subject or "", m.in_reply_to or "")]
    # 사람이 직접 고른 대화인데 우리 발신이 전부 답장이면(상대가 먼저 인사해 와 그
    # 답장으로 회사를 소개한 경우) 그 첫 답장을 발송으로 삼는다 — 고른 뜻을 따른다.
    sends = firsts or outs[:1]

    created, skipped, sources = 0, 0, 0
    for m in sends:
        recips = external_recipients(m.to_addrs, m.cc_addrs, own, own_domain)
        sources += 1
        day = (m.sent_at or "")[:10]
        for addr in recips:
            if (addr, day) in logged:
                skipped += 1
                continue
            kind, pid, pname = parties.get(addr, ("", 0, ""))
            s.add(MarketingActivity(
                customer_id=pid if kind == "customer" else None,
                prospect_name="" if kind == "customer" else (pname or _prospect_name(addr)),
                contact_person=contacts.get(pid, "") if kind == "customer" else "",
                recipient_email=addr,
                activity_date=day,
                channel="Email",
                activity_type="Intro email",
                subject=(m.subject or "")[:200],
                notes="메일함에서 등록(KTMS 밖에서 발송)",
                sent_email_id=m.id,
                owner_id=users.get((m.from_addr or "").strip().lower()) or user_id or None,
            ))
            logged.add((addr, day))
            created += 1
        # 대화째 미분류 함에서 내린다(딜에 붙은 메일은 건드리지 않는다).
        if m.thread_key:
            for t in s.query(EmailMessage).filter(EmailMessage.thread_key == m.thread_key,
                                                  EmailMessage.rfq_id.is_(None)).all():
                t.not_deal = True
        m.not_deal = True
    # 고른 묶음의 나머지(받은 답장 등)도 같은 대화이므로 함께 내린다.
    if sources:
        for m in msgs:
            if m.rfq_id is None:
                m.not_deal = True
    s.flush()
    return {"created": created, "skipped": skipped, "mails": sources}


def dismiss(s, ids: list[int], value: bool = True) -> int:
    """홍보가 아니라고 내린다(value=False 면 되돌린다). 메일 자체는 건드리지 않는다."""
    cur = dismissed(s)
    picked = {int(i) for i in ids or []}
    cur = (cur | picked) if value else (cur - picked)
    mail_sync._save_setting(s, DISMISS_KEY, sorted(cur))
    return len(picked)
