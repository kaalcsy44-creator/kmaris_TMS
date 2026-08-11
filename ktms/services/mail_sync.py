"""회사 메일함(IMAP) → KTMS 메일 이력 동기화.

받은편지함과 보낸편지함을 읽어 EmailMessage 로 남긴다. 프로젝트 화면이 "이 딜에서
누구와 언제 무슨 메일이 오갔는지"를 그대로 보여줄 수 있게 하는 것이 목적이다.

들이는 범위는 좁게 잡는다 — Settings 에 등록된 고객·벤더 주소와 오간 메일, 그리고
이미 담아 둔 메일의 답장(스레드)뿐이다. 사내 공지·개인 메일·광고는 애초에 저장하지
않는다(보관 범위를 설명할 수 있어야 하고, DB 전송량도 아껴야 한다).

프로젝트 연결은 두 단계로 시도한다.
  1) 스레드 — In-Reply-To·References 가 이미 저장된 메일을 가리키면 그 프로젝트.
     회신 메일은 이 경로로 거의 다 붙는다(제목이 바뀌어도 따라간다).
  2) 문서번호 — 제목·본문에 그 딜의 번호(P-024 / KMS-RFQ-2608-017 / 견적·P/O 번호)가
     있으면 그 프로젝트.
붙지 못한 메일은 rfq_id 없이 남아 '미분류' 목록에서 사람이 한 번에 배정한다.
(추측으로 붙이면 틀린 딜의 이력이 되는데, 그건 비어 있는 것보다 나쁘다.)

환경변수
  IMAP_HOST(기본 imap.gmail.com) · IMAP_PORT(993) · IMAP_USER · IMAP_PASSWORD
    비우면 SMTP_USER / SMTP_PASSWORD 를 그대로 쓴다(같은 계정이면 추가 설정이 없다).
  IMAP_FOLDERS  쉼표 구분 폴더 이름. 비우면 INBOX + 서버가 \\Sent 로 표시한 폴더.
  IMAP_SINCE_DAYS(120)  폴더를 처음 읽을 때 거슬러 올라갈 기간.
  IMAP_MAX_PER_SYNC(300)  한 번의 동기화에서 가져올 최대 통수(폴더 합계).
"""
from __future__ import annotations

import email
import imaplib
import os
import re
from datetime import datetime, timedelta, timezone
from email.header import decode_header, make_header
from email.message import Message
from email.utils import getaddresses, parsedate_to_datetime
from typing import Iterable

from db.models import (
    Customer, CustomerContact, EmailMessage, EmailSyncState, Order,
    PurchaseOrder, Quotation, RFQ, User, Vendor, VendorContact, VendorRFQ, WorkType,
)

# 본문 보관 상한 — 요약과 원문 확인에는 충분하고, 첨부 인용문이 통째로 들어오는
# 메일에 DB 를 내주지 않을 만큼. 넘으면 잘라 두고 truncated 로 표시한다.
MAX_BODY_CHARS = 20_000
KST = timezone(timedelta(hours=9))


# ── 설정 ──────────────────────────────────────────────────────────────────────

def mail_config() -> dict:
    return {
        "host": os.getenv("IMAP_HOST", "imap.gmail.com"),
        "port": int(os.getenv("IMAP_PORT", "993")),
        "user": os.getenv("IMAP_USER", "") or os.getenv("SMTP_USER", ""),
        "password": os.getenv("IMAP_PASSWORD", "") or os.getenv("SMTP_PASSWORD", ""),
        "folders": [f.strip() for f in (os.getenv("IMAP_FOLDERS", "") or "").split(",") if f.strip()],
        "since_days": int(os.getenv("IMAP_SINCE_DAYS", "120")),
        "max_per_sync": int(os.getenv("IMAP_MAX_PER_SYNC", "300")),
    }


def is_configured() -> bool:
    cfg = mail_config()
    return bool(cfg["user"] and cfg["password"])


# ── 헤더·본문 읽기 ────────────────────────────────────────────────────────────

def _hdr(msg: Message, name: str) -> str:
    """헤더 한 줄을 사람이 읽는 문자열로. 인코딩 워드(=?utf-8?B?…)를 푼다."""
    raw = msg.get(name)
    if not raw:
        return ""
    try:
        return str(make_header(decode_header(raw))).strip()
    except Exception:
        return str(raw).strip()


def _addr_list(msg: Message, *names: str) -> list[str]:
    """To·Cc 등 주소 헤더 → 소문자 주소 목록(표시 이름은 버린다)."""
    raw = [(n, v) for n in names for v in msg.get_all(n, [])]
    out, seen = [], set()
    for _, addr in getaddresses([v for _, v in raw]):
        a = (addr or "").strip().lower()
        if a and a not in seen:
            seen.add(a)
            out.append(a)
    return out


def _msg_ids(value: str) -> list[str]:
    """Message-ID 형태(<...>)를 골라낸다. References 는 여러 개가 공백으로 붙어 온다."""
    return re.findall(r"<[^<>\s]+>", value or "")


def _decode_part(part: Message) -> str:
    payload = part.get_payload(decode=True)
    if payload is None:
        return ""
    charset = part.get_content_charset() or "utf-8"
    for enc in (charset, "utf-8", "cp949", "latin-1"):
        try:
            return payload.decode(enc, errors="strict")
        except (UnicodeDecodeError, LookupError):
            continue
    return payload.decode("utf-8", errors="replace")


_TAG_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.S | re.I)
_BR_RE = re.compile(r"<(br|/p|/div|/tr)[^>]*>", re.I)


def _html_to_text(html: str) -> str:
    """HTML 본문만 온 메일용 — 태그를 걷어 읽을 수 있는 평문으로."""
    s = _TAG_RE.sub(" ", html)
    s = _BR_RE.sub("\n", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = (s.replace("&nbsp;", " ").replace("&amp;", "&")
          .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"'))
    return re.sub(r"\n{3,}", "\n\n", s)


def body_and_attachments(msg: Message) -> tuple[str, list[dict]]:
    """평문 본문 + 첨부 메타([{name,size}]). 첨부 원본은 담지 않는다(메일함에 있다)."""
    text_parts: list[str] = []
    html_parts: list[str] = []
    attachments: list[dict] = []
    for part in msg.walk() if msg.is_multipart() else [msg]:
        if part.get_content_maintype() == "multipart":
            continue
        disp = (part.get("Content-Disposition") or "").lower()
        filename = part.get_filename()
        if "attachment" in disp or filename:
            try:
                name = str(make_header(decode_header(filename))) if filename else "(unnamed)"
            except Exception:
                name = str(filename or "(unnamed)")
            raw = part.get_payload(decode=True) or b""
            attachments.append({"name": name, "size": len(raw)})
            continue
        ctype = part.get_content_type()
        if ctype == "text/plain":
            text_parts.append(_decode_part(part))
        elif ctype == "text/html":
            html_parts.append(_decode_part(part))
    body = "\n".join(t for t in text_parts if t.strip())
    if not body.strip():
        body = _html_to_text("\n".join(html_parts))
    return body.replace("\r\n", "\n").strip(), attachments


def sent_at_kst(msg: Message) -> str:
    """Date 헤더 → KST 'YYYY-MM-DDTHH:MM'. 못 읽으면 빈 문자열."""
    raw = msg.get("Date")
    if not raw:
        return ""
    try:
        dt = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return ""
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(KST).strftime("%Y-%m-%dT%H:%M")


# ── 상대편 찾기 ───────────────────────────────────────────────────────────────

def own_addresses(s) -> set[str]:
    """우리 쪽 주소 — 발신/수신 방향과 '상대'가 누구인지 가르는 기준.
    메일 계정 + 로그인 사용자들의 주소."""
    cfg = mail_config()
    out = {a.strip().lower() for a in (cfg["user"], os.getenv("SMTP_FROM", "")) if a}
    # SMTP_FROM 은 "이름 <주소>" 형태일 수 있다 — 주소만 남긴다.
    out = {re.sub(r"^.*<|>.*$", "", a).strip() for a in out}
    for (mail,) in s.query(User.email).all():
        if mail and mail.strip():
            out.add(mail.strip().lower())
    return {a for a in out if "@" in a}


def party_index(s) -> dict[str, tuple[str, int, str]]:
    """등록된 거래처 이메일 → (kind, id, name). kind = customer | vendor.

    회사 대표 주소·다중 주소·(구) 담당자 테이블을 모두 훑는다. 같은 주소가 여러 곳에
    등록돼 있으면 먼저 만난 쪽을 쓴다 — 어차피 같은 회사를 가리키는 중복이다."""
    idx: dict[str, tuple[str, int, str]] = {}

    def put(addr: str, kind: str, rid: int, name: str) -> None:
        a = (addr or "").strip().lower()
        if a and "@" in a and a not in idx:
            idx[a] = (kind, rid, name or "")

    for c in s.query(Customer).all():
        for a in [c.email or ""] + list(c.emails or []):
            put(a, "customer", c.id, c.name)
    for v in s.query(Vendor).all():
        for a in [v.email or ""] + list(v.emails or []):
            put(a, "vendor", v.id, v.name)
    for cc in s.query(CustomerContact).all():
        put(cc.email or "", "customer", cc.customer_id, "")
    for vc in s.query(VendorContact).all():
        put(vc.email or "", "vendor", vc.vendor_id, "")
    return idx


# ── 프로젝트 찾기 ─────────────────────────────────────────────────────────────

def _project_no_map(s) -> dict[int, str]:
    """{rfq_id: 'P-024'} — _core._project_no_map 과 같은 규칙의 번호 부분만.
    (services 는 _core 를 import 할 수 없어 여기서 같은 순서로 다시 센다.)"""
    rows = [((r.received_at or r.date or ""), r.id,
             "S" if getattr(r.work_type, "value", r.work_type) == WorkType.SERVICE.value else "P")
            for r in s.query(RFQ).all()]
    rows.sort(key=lambda t: (t[0] or "9999-99-99", t[1]))
    counters = {"P": 0, "S": 0}
    out: dict[int, str] = {}
    for _, rid, prefix in rows:
        counters[prefix] += 1
        out[rid] = f"{prefix}-{counters[prefix]:03d}"
    return out


def doc_no_index(s) -> dict[str, int]:
    """딜을 가리키는 문서번호 → rfq_id. 제목·본문에서 이 토큰을 찾아 연결한다.

    너무 짧거나 흔한 번호(숫자만, 3자 미만)는 넣지 않는다 — 우연히 걸리면 남의 딜에
    메일이 붙는다."""
    idx: dict[str, int] = {}

    def put(no: str, rfq_id: int | None) -> None:
        t = (no or "").strip().upper()
        if rfq_id and len(t) >= 5 and not t.isdigit():
            idx.setdefault(t, rfq_id)

    for rid, pno in _project_no_map(s).items():
        put(pno, rid)
    for r in s.query(RFQ).all():
        put(r.rfq_no or "", r.id)
        put(r.customer_rfq_no or "", r.id)
    for vr in s.query(VendorRFQ).all():
        put(getattr(vr, "kmaris_rfq_no", "") or "", vr.rfq_id)
    for q in s.query(Quotation).all():
        put(q.qtn_no or "", q.rfq_id)
    for o in s.query(Order).all():
        put(o.po_no or "", o.rfq_id)
    for p in s.query(PurchaseOrder).all():
        put(getattr(p, "po_no", "") or "", _po_rfq_id(s, p))
    return idx


def _po_rfq_id(s, po) -> int | None:
    """Vendor P/O → 딜(RFQ) id. P/O 는 오더에 매달려 있다."""
    if not getattr(po, "order_id", None):
        return None
    order = s.query(Order).filter_by(id=po.order_id).first()
    return order.rfq_id if order else None


def match_project(s, msg_ids: Iterable[str], subject: str, body: str,
                  docs: dict[str, int]) -> tuple[int | None, str]:
    """(rfq_id, 연결 근거). 스레드 → 문서번호 순으로 본다. 못 찾으면 (None, '')."""
    parents = [m for m in msg_ids if m]
    if parents:
        hit = (s.query(EmailMessage)
               .filter(EmailMessage.message_id.in_(parents), EmailMessage.rfq_id.isnot(None))
               .order_by(EmailMessage.id.desc()).first())
        if hit:
            return hit.rfq_id, "thread"
    haystack = f"{subject}\n{body[:4000]}".upper()
    for token, rfq_id in docs.items():
        if token in haystack:
            return rfq_id, "subject"
    return None, ""


def thread_key_of(msg_ids: list[str], message_id: str) -> str:
    """스레드 묶음 키 — References 의 맨 앞(뿌리)이 있으면 그것, 없으면 자기 자신."""
    return (msg_ids[0] if msg_ids else "") or message_id


# ── IMAP 동기화 ───────────────────────────────────────────────────────────────

def _connect(cfg: dict) -> imaplib.IMAP4_SSL:
    conn = imaplib.IMAP4_SSL(cfg["host"], cfg["port"])
    conn.login(cfg["user"], cfg["password"])
    return conn


def _folders(conn: imaplib.IMAP4_SSL, cfg: dict) -> list[str]:
    """읽을 폴더 — 지정이 없으면 INBOX + 서버가 \\Sent 로 표시한 폴더.
    (보낸편지함 이름은 Gmail 언어 설정에 따라 달라서 이름으로 찍지 않는다.)"""
    if cfg["folders"]:
        return cfg["folders"]
    out = ["INBOX"]
    try:
        typ, data = conn.list()
        if typ == "OK":
            for raw in data or []:
                line = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
                if "\\Sent" in line:
                    name = line.split(' "/" ')[-1].strip().strip('"')
                    if name:
                        out.append(name)
    except Exception:
        pass
    return out


def _search_uids(conn: imaplib.IMAP4_SSL, last_uid: int, since_days: int) -> list[int]:
    """이어 읽기 — 지난번 UID 다음부터. 처음이면 최근 since_days 일치만."""
    if last_uid:
        criteria = ["UID", f"{last_uid + 1}:*"]
    else:
        since = (datetime.now(timezone.utc) - timedelta(days=since_days)).strftime("%d-%b-%Y")
        criteria = ["SINCE", since]
    typ, data = conn.uid("SEARCH", None, *criteria)
    if typ != "OK" or not data or not data[0]:
        return []
    uids = [int(x) for x in data[0].split()]
    # UID n:* 는 일치가 없어도 마지막 통을 돌려준다 — 이미 읽은 것은 걸러낸다.
    return sorted(u for u in uids if u > last_uid)


def _store_message(s, msg: Message, folder: str, own: set[str],
                   parties: dict[str, tuple[str, int, str]], docs: dict[str, int]) -> str:
    """메일 1통 저장. 반환: stored | skipped(관계없는 메일) | dup(이미 있음)."""
    message_id = (_hdr(msg, "Message-ID") or "").strip()
    if not message_id:
        # Message-ID 없는 메일은 중복 판별을 할 수 없다 — 발신시각+제목으로 대신 만든다.
        message_id = f"<no-id-{sent_at_kst(msg)}-{abs(hash(_hdr(msg, 'Subject')))}@ktms>"
    if s.query(EmailMessage.id).filter_by(message_id=message_id).first():
        return "dup"

    from_addrs = _addr_list(msg, "From")
    from_addr = from_addrs[0] if from_addrs else ""
    to_addrs = _addr_list(msg, "To")
    cc_addrs = _addr_list(msg, "Cc")
    in_reply_to = (_msg_ids(msg.get("In-Reply-To") or "") or [""])[0]
    refs = _msg_ids(msg.get("References") or "")
    parents = [m for m in ([in_reply_to] + refs) if m]

    direction = "out" if from_addr in own else "in"
    counterparts = [a for a in ([from_addr] + to_addrs + cc_addrs) if a and a not in own]
    party = next((parties[a] for a in counterparts if a in parties), None)
    known_thread = bool(parents) and bool(
        s.query(EmailMessage.id).filter(EmailMessage.message_id.in_(parents)).first())
    if not party and not known_thread:
        return "skipped"   # 등록된 거래처와도, 담아 둔 스레드와도 무관한 메일

    subject = _hdr(msg, "Subject")
    body, attachments = body_and_attachments(msg)
    truncated = len(body) > MAX_BODY_CHARS
    rfq_id, match_by = match_project(s, parents, subject, body, docs)

    s.add(EmailMessage(
        message_id=message_id[:400],
        in_reply_to=in_reply_to[:400],
        refs=refs[:20],
        thread_key=thread_key_of(parents, message_id)[:400],
        direction=direction,
        from_addr=from_addr[:320],
        from_name=(getaddresses([msg.get("From") or ""])[0][0] or "")[:200],
        to_addrs=to_addrs[:20],
        cc_addrs=cc_addrs[:20],
        subject=subject[:500],
        body_text=body[:MAX_BODY_CHARS],
        truncated=truncated,
        attachments=attachments[:30],
        sent_at=sent_at_kst(msg),
        rfq_id=rfq_id,
        customer_id=party[1] if party and party[0] == "customer" else None,
        vendor_id=party[1] if party and party[0] == "vendor" else None,
        match_by=match_by,
    ))
    return "stored"


def sync_mailbox(s, folder_limit: int | None = None) -> dict:
    """메일함을 읽어 새 메일을 저장한다. 반환: 폴더별 처리 건수 요약.

    한 번에 max_per_sync 통까지만 가져오고, 어디까지 읽었는지 EmailSyncState 에
    남긴다(다음 호출이 그다음부터 이어 읽는다)."""
    cfg = mail_config()
    if not cfg["user"] or not cfg["password"]:
        raise RuntimeError("IMAP 계정이 설정되지 않았습니다 — IMAP_USER/IMAP_PASSWORD "
                           "(또는 SMTP_USER/SMTP_PASSWORD) 환경변수를 확인하세요.")
    own = own_addresses(s)
    parties = party_index(s)
    docs = doc_no_index(s)
    budget = folder_limit or cfg["max_per_sync"]
    result = {"stored": 0, "skipped": 0, "dup": 0, "folders": {}}

    conn = _connect(cfg)
    try:
        for folder in _folders(conn, cfg):
            if budget <= 0:
                break
            state = s.query(EmailSyncState).filter_by(folder=folder).first()
            if not state:
                state = EmailSyncState(folder=folder, last_uid=0)
                s.add(state)
            try:
                typ, _ = conn.select(f'"{folder}"', readonly=True)
                if typ != "OK":
                    state.last_error = f"select failed: {typ}"
                    continue
                validity = (conn.response("UIDVALIDITY")[1] or [b""])[0]
                validity = validity.decode() if isinstance(validity, bytes) else str(validity or "")
                # UIDVALIDITY 가 바뀌면 예전 UID 는 뜻을 잃는다 — 처음부터 다시 읽는다
                # (이미 담은 메일은 message_id 유일 제약이 dup 으로 걸러 준다).
                if validity and state.uid_validity and validity != state.uid_validity:
                    state.last_uid = 0
                state.uid_validity = validity or state.uid_validity

                uids = _search_uids(conn, state.last_uid or 0, cfg["since_days"])[:budget]
                counts = {"stored": 0, "skipped": 0, "dup": 0}
                for uid in uids:
                    typ, data = conn.uid("FETCH", str(uid), "(RFC822)")
                    if typ != "OK" or not data or not isinstance(data[0], tuple):
                        continue
                    outcome = _store_message(
                        s, email.message_from_bytes(data[0][1]), folder, own, parties, docs)
                    counts[outcome] += 1
                    result[outcome] += 1
                    state.last_uid = max(state.last_uid or 0, uid)
                budget -= len(uids)
                state.last_synced_at = datetime.utcnow()
                state.last_error = ""
                result["folders"][folder] = counts
                s.commit()
            except Exception as exc:       # 한 폴더가 막혀도 나머지는 읽는다
                s.rollback()
                state = s.query(EmailSyncState).filter_by(folder=folder).first()
                if state:
                    state.last_error = str(exc)[:500]
                    s.commit()
                result["folders"][folder] = {"error": str(exc)[:200]}
    finally:
        try:
            conn.logout()
        except Exception:
            pass
    return result
