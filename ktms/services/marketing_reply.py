"""회사소개 메일에 돌아온 답장을 메일함에서 찾아 마케팅 활동에 붙인다.

홍보 메일은 한 번에 수십 통씩 나가고, 답은 며칠에 걸쳐 흩어져 들어온다. 그걸
사람이 받은편지함과 마케팅 표를 오가며 맞춰 적으면, 바쁜 주에는 그냥 안 적힌다.
그래서 IMAP 동기화가 담아 둔 수신 메일(EmailMessage)에서 "홍보 메일을 보낸 그
주소에서 그 뒤에 온 첫 메일"을 찾아 활동에 붙이고, 문면을 보고 종류까지 골라 둔다.

  inquiry     문의를 바로 보내옴          later      지금은 건이 없다/생기면 주겠다
  auto_reply  부재중 자동응답(대체 담당자)  invalid   폐기된 주소(반송·퇴사 통지)
  no_reply    한참을 기다렸는데 답이 없다

**기계는 제안만 한다.** 자동으로 넣은 값은 reply_auto=True 로 표시되고, 사람이 그
행을 한 번 저장하면(=확인하면) reply_auto 가 False 가 되어 그 뒤로는 자동 감지가
그 행을 건드리지 않는다. 문면이 어느 쪽인지 또렷하지 않으면 분류를 비워 둔 채
답장이 왔다는 사실(reply_email_id)만 남긴다 — 틀린 분류는 빈칸보다 나쁘다.

환경변수
  MARKETING_NO_REPLY_DAYS(21)  이 날수가 지나도록 답이 없으면 '무응답'으로 적는다.
    (메일함을 읽어 둔 기간 IMAP_SINCE_DAYS 안의 발송만 대상으로 한다 — 보지도 않은
     기간을 두고 '답이 없었다'고 적을 수는 없다.)
"""
from __future__ import annotations

import os
import re
from datetime import datetime, timedelta

from sqlalchemy import func

from db.models import EmailMessage, MarketingActivity
from services import mail_sync

# 답장 종류 → 다시 두드릴 때까지의 날수. None = 후속 없음(주소가 죽었다).
# web/lib/marketing.ts 의 followUpDays 와 같은 값이어야 한다 — 화면에서 손으로 고를
# 때와 여기서 자동으로 붙일 때가 다른 날을 잡으면 설명할 수 없는 표가 된다.
FOLLOW_UP_DAYS: dict[str, int | None] = {
    "inquiry": 0,
    "later": 90,
    "auto_reply": 7,
    "invalid": None,
    "no_reply": 14,
}


def no_reply_days() -> int:
    try:
        return max(1, int(os.getenv("MARKETING_NO_REPLY_DAYS", "21") or 21))
    except ValueError:
        return 21


def _today() -> str:
    return datetime.now(mail_sync.KST).strftime("%Y-%m-%d")


def _shift(date: str, days: int) -> str:
    try:
        return (datetime.strptime(date[:10], "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        return ""


def follow_up_for(status: str, base: str) -> str:
    """그 답장이 정하는 후속일. 기준일이 이상하면 오늘로 센다."""
    days = FOLLOW_UP_DAYS.get(status)
    if days is None:
        return ""
    return _shift(base if re.match(r"^\d{4}-\d{2}-\d{2}$", base or "") else _today(), days)


# ── 문면 읽기 ─────────────────────────────────────────────────────────────────
#
# 규칙은 좁게 잡는다. "inquiry" 같은 낱말은 서명이나 안내문에도 흔해서, 넓게 잡으면
# 답장 전부가 문의로 찍힌다. 여기서 못 가린 건 사람이 보게 남기는 편이 낫다.

_DAEMON = re.compile(
    r"(mailer-daemon|postmaster|mail\.?delivery|delivery-?(status|subsystem)"
    r"|no-?reply@.*(google|outlook|microsoft))", re.I)

# 반송 통지 — 메일 서버가 되돌려 보낸 것.
_BOUNCE = re.compile(
    r"(undeliverable|undelivered mail|delivery (status notification|has failed|failure)"
    r"|failure notice|returned to sender|mail delivery (failed|subsystem)"
    r"|address not found|recipient address rejected|user unknown"
    r"|does ?n(o|')t exist|no such (user|address|mailbox)|mailbox (is )?unavailable"
    r"|550[ -]?5\.[01]\.[01])", re.I)

# 사람이 알려 주는 폐기 주소 — 퇴사·부서 이동으로 그 주소를 더는 쓰지 않는다.
_RETIRED = re.compile(
    r"(no longer (with|works?|employed|at|in use|valid|monitored|active)"
    r"|has left (the company|us)|left the company|is not (with us|working)"
    r"|this (mailbox|address|account) (is )?(no longer|will be) "
    r"|discontinued|deactivated"
    r"|퇴사|더 이상 사용하지|사용하지 않는 (메일|이메일|주소))", re.I)

# 부재중 자동응답.
_AUTO = re.compile(
    r"(auto(matic)?[- ]?(reply|response|reply:)|automatische|out of (the )?office"
    r"|away from (the )?office|on (annual |sick |maternity )?leave"
    r"|on (vacation|holiday|business trip)|currently (out|away|unavailable)"
    r"|will (be )?back|i am out|absence|자동 ?(회신|응답)|부재중)", re.I)

# 문의가 왔다 — 견적을 달라는 말, 또는 문의서를 붙여 보낸 것.
_INQUIRY = re.compile(
    r"((please|kindly|pls) (quote|send|submit|offer|advise)"
    r"|request for quotation|\brfq\b|\bmto\b"
    r"|quot(e|ation) (for|request|us|please)|send (us )?your (best )?(offer|price|quotation)"
    r"|attached (is )?(our |the )?(inquiry|enquiry|rfq|requisition|list)"
    r"|(inquiry|enquiry) attached|we (need|require|would like to) (a )?(quot|price|offer)"
    r"|best (price|offer) for|urgent requirement)", re.I)
_INQUIRY_FILE = re.compile(r"(inquiry|enquiry|rfq|requisition|quotation|item ?list)", re.I)

# 지금은 건이 없다 — 나중에 생기면 주겠다는 답.
_LATER = re.compile(
    r"(no (current |immediate |urgent )?(requirement|enquiry|inquiry|demand|need)"
    r"|not? (require|need) (anything|any)|nothing at (the )?moment|at the moment we"
    r"|keep (your|you) (details|information|company|contact).{0,20}(on file|in mind|our record)"
    r"|(add|added|register|registered|include) (you|your company).{0,30}"
    r"(vendor|supplier|approved|list|database|record)"
    r"|(will|shall) (contact|revert|get back|come back|reach out|approach) (to )?you"
    r"|when(ever)? (we have|there is|the need|a requirement)|in (due course|the future)"
    r"|future (requirement|enquir|inquir|business|reference))", re.I)

_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")


def _alt_contact(text: str, exclude: set[str]) -> str:
    """자동응답이 가리킨 다른 담당자 주소 — 본문에서 첫 번째로 나오는 남의 주소."""
    for hit in _EMAIL_RE.findall(text or "")[:20]:
        a = hit.strip().lower()
        if a not in exclude and not _DAEMON.search(a):
            return a
    return ""


# 답장에 딸려 온 원문 인용이 시작되는 자리. 여기부터는 상대가 쓴 말이 아니라
# 우리가 보낸 홍보 메일이다 — 그걸 같이 읽으면 우리 문면("quotation", "inquiry")에
# 걸려 모든 답장이 문의로 찍힌다.
_QUOTE_START = re.compile(
    r"^\s*(-{2,}\s*original message|_{5,}|-{5,}"
    r"|on .{0,120}\bwrote:|from:\s*.+@|sent:\s|보낸 ?사람\s*:|원본 메시지"
    r"|de\s*:\s*.+@|von:\s*.+@)", re.I | re.M)


def _own_words(body: str) -> str:
    """상대가 실제로 쓴 대목만 남긴다 — 인용 기호(>) 줄과 원문 블록을 걷어낸다."""
    text = body or ""
    cut = _QUOTE_START.search(text)
    if cut and cut.start() > 0:
        text = text[:cut.start()]
    lines = [ln for ln in text.splitlines() if not ln.lstrip().startswith((">", "|"))]
    return "\n".join(lines).strip()


def classify(subject: str, body: str, from_addr: str = "",
             attachments: list | None = None, exclude: set[str] | None = None) -> tuple[str, str]:
    """답장 한 통 → (분류, 메모). 분류가 빈 문자열이면 '사람이 봐야 한다'는 뜻."""
    subj = subject or ""
    own_text = _own_words(body or "")
    # 답장이 인용뿐이면(본문 없이 원문만) 제목만 가지고 본다 — 그래야 자동응답 제목은
    # 여전히 걸리고, 인용문에 있던 우리 말은 걸리지 않는다.
    head = f"{subj}\n{own_text}"[:4000]
    names = " ".join(str((a or {}).get("name", "")) for a in (attachments or []))

    if _DAEMON.search(from_addr or "") or _BOUNCE.search(head):
        return "invalid", _first_line(head, _BOUNCE)
    if _RETIRED.search(head):
        return "invalid", _alt_contact(head, exclude or set()) or _first_line(head, _RETIRED)
    if _AUTO.search(subj) or _AUTO.search(head[:1200]):
        return "auto_reply", _alt_contact(head, exclude or set())
    if _INQUIRY.search(head) or _INQUIRY_FILE.search(names):
        return "inquiry", ""
    if _LATER.search(head):
        return "later", _first_line(head, _LATER)
    return "", ""


def _first_line(text: str, pattern: re.Pattern) -> str:
    """규칙에 걸린 대목을 한 줄로 — 왜 그렇게 분류했는지 사람이 바로 보게."""
    m = pattern.search(text or "")
    if not m:
        return ""
    line = (text[max(0, m.start() - 60): m.end() + 60] or "").replace("\r", " ")
    return re.sub(r"\s+", " ", line).strip()[:200]


# ── 활동에 붙이기 ─────────────────────────────────────────────────────────────

def _owned_by_machine(a: MarketingActivity) -> bool:
    """자동 감지가 손대도 되는 행인가 — 아직 아무도 적지 않았거나, 기계가 적은 값뿐."""
    return not (a.reply_status or "") or bool(a.reply_auto)


def detect_replies(s, mark_no_reply: bool = True) -> dict:
    """메일함에 담긴 수신 메일을 훑어 마케팅 활동의 답장 칸을 채운다.

    반환: {"linked": 붙인 건, "classified": {분류: 건수}, "unclassified": 분류 못한 건,
           "no_reply": 무응답으로 적은 건, "checked": 살펴본 활동 수}"""
    acts = [a for a in s.query(MarketingActivity).all()
            if (a.recipient_email or "").strip() and _owned_by_machine(a)]
    out = {"checked": len(acts), "linked": 0, "classified": {}, "unclassified": 0, "no_reply": 0}
    if not acts:
        return out

    by_addr: dict[str, list[MarketingActivity]] = {}
    for a in acts:
        by_addr.setdefault(a.recipient_email.strip().lower(), []).append(a)

    own = mail_sync.own_addresses(s)
    # 가장 이른 발송보다 앞선 메일은 어느 발송의 답장도 될 수 없다 — 거기서부터만 본다.
    since = min((a.activity_date or "9999")[:10] for a in acts)
    msgs = _candidate_messages(s, set(by_addr), since)
    # 우리가 보낸 주소 전부 — 자동응답이 "이 사람 말고 저 사람에게" 하고 알려 준
    # 주소를 고를 때, 우리 주소와 그 사람 자신의 주소는 후보에서 뺀다.
    all_marketing = set(by_addr)

    for msg in msgs:
        addr = _subject_address(msg, all_marketing)
        targets = by_addr.get(addr) or []
        if not targets:
            continue
        day = (msg.sent_at or "")[:10]
        status, note = classify(msg.subject or "", msg.body_text or "", msg.from_addr or "",
                                msg.attachments or [], own | {addr})
        for a in targets:
            if not _owned_by_machine(a):
                continue
            if (a.activity_date or "") > day:
                continue        # 그 발송보다 먼저 온 메일은 이 발송의 답장이 아니다
            if a.reply_email_id and (a.reply_date or "") <= day:
                continue        # 이미 더 이른 답장을 붙여 뒀다
            _apply(s, a, msg, day, status, note)
            out["linked"] += 1
            if status:
                out["classified"][status] = out["classified"].get(status, 0) + 1
            else:
                out["unclassified"] += 1

    if mark_no_reply:
        out["no_reply"] = _mark_no_reply(s, acts)
    s.commit()
    return out


def _apply(s, a: MarketingActivity, msg: "_Msg", day: str, status: str, note: str) -> None:
    a.reply_email_id = msg.id
    a.reply_date = day
    a.reply_auto = True
    if note and not (a.reply_note or "").strip():
        a.reply_note = note[:200]
    if status:
        a.reply_status = status
        a.next_action_date = follow_up_for(status, day)
        if status == "invalid":
            # 폐기된 주소는 반송과 같은 사실 — 고객 담당자 명부까지 표시가 닿아야
            # 다음에 누가 그 사람에게 보내려 할 때 보인다.
            a.email_bounced = True
            try:
                from _core import sync_bounced_email
                sync_bounced_email(s, a.recipient_email or "")
            except Exception:       # 명부 반영이 막혀도 답장 기록은 남긴다
                pass
    else:
        # 분류는 사람 몫으로 남기되, 답장이 온 날을 후속일로 세워 표에서 눈에 띄게 한다.
        a.reply_status = ""
        if not (a.next_action_date or ""):
            a.next_action_date = day


def _mark_no_reply(s, acts: list[MarketingActivity]) -> int:
    """기다릴 만큼 기다렸는데 답이 없는 발송을 '무응답'으로 적는다.

    메일함을 읽어 둔 기간(IMAP_SINCE_DAYS) 안의 발송만 본다 — 그보다 오래된 건은
    답장이 왔는지 아닌지를 알 방법이 애초에 없다."""
    if not s.query(EmailMessage.id).first():
        return 0        # 메일함을 한 번도 못 읽었다 — 무응답이라 말할 근거가 없다
    today = _today()
    wait_until = _shift(today, -no_reply_days())
    window_from = _shift(today, -int(mail_sync.mail_config()["since_days"]))
    n = 0
    for a in acts:
        if a.reply_email_id or (a.reply_status or ""):
            continue
        day = (a.activity_date or "")[:10]
        if not day or day > wait_until or day < window_from:
            continue
        a.reply_status = "no_reply"
        a.reply_auto = True
        a.reply_date = ""
        a.next_action_date = follow_up_for("no_reply", today)
        n += 1
    return n


class _Msg:
    """분류에 필요한 것만 담은 메일 한 통(본문은 앞부분만).

    이 일은 동기화가 끝날 때마다 돌아서, 메일 행을 통째로 끌어오면 같은 본문을 하루에
    몇 번씩 다시 내려받게 된다. Neon 요금은 깨어 있는 시간과 전송량으로 매겨지므로,
    읽는 칸과 길이를 여기서 줄인다(분류는 앞 4천 자면 충분하다)."""
    __slots__ = ("id", "from_addr", "subject", "body_text", "sent_at", "attachments")

    def __init__(self, mid, frm, subject, body, sent_at, attachments):
        self.id = mid
        self.from_addr = frm or ""
        self.subject = subject or ""
        self.body_text = body or ""
        self.sent_at = sent_at or ""
        self.attachments = attachments or []


def _candidate_messages(s, addrs: set[str], since: str = "") -> list[_Msg]:
    """살펴볼 수신 메일 — 홍보 메일을 보낸 주소에서 온 것과, 반송 통지.

    오래된 것부터 본다. 같은 주소에서 여러 통이 왔다면 첫 답장이 그 발송의 답이다."""
    if not addrs:
        return []
    cols = (EmailMessage.id, EmailMessage.from_addr, EmailMessage.subject,
            # 본문은 앞부분만 내려받는다 — 분류도 반송 주소 찾기도 여기서 끝난다.
            func.substr(EmailMessage.body_text, 1, 4000), EmailMessage.sent_at,
            EmailMessage.attachments)
    q = s.query(*cols).filter(EmailMessage.direction == "in")
    if since:
        q = q.filter(EmailMessage.sent_at >= since)
    rows: list[tuple] = []
    addr_list = sorted(addrs)
    for i in range(0, len(addr_list), 200):     # IN 절이 너무 길어지지 않게 나눠 묻는다
        rows += q.filter(func.lower(EmailMessage.from_addr).in_(addr_list[i:i + 200])).all()
    # 반송 통지는 보낸 사람이 메일 서버라 주소로는 못 걸린다 — 동기화가 홍보용으로
    # 담아 둔 것(match_by="marketing")을 함께 본다(겹치는 통은 아래에서 걸러진다).
    rows += q.filter(EmailMessage.match_by == "marketing").all()
    seen: set[int] = set()
    uniq = [_Msg(*r) for r in rows if not (r[0] in seen or seen.add(r[0]))]
    uniq.sort(key=lambda m: (m.sent_at, m.id))
    return uniq


def _subject_address(msg: "_Msg", addrs: set[str]) -> str:
    """이 메일이 말하고 있는 홍보 수신 주소 — 보낸 사람, 아니면 본문에 적힌 주소."""
    frm = (msg.from_addr or "").strip().lower()
    if frm in addrs:
        return frm
    # 반송 통지: 어느 주소가 되돌아왔는지는 제목·본문에 적혀 있다.
    for hit in _EMAIL_RE.findall(f"{msg.subject or ''}\n{(msg.body_text or '')[:4000]}")[:40]:
        a = hit.strip().lower()
        if a in addrs:
            return a
    return ""
