"""회사 메일함(IMAP) → KTMS 메일 이력 동기화.

받은편지함과 보낸편지함을 읽어 EmailMessage 로 남긴다. 프로젝트 화면이 "이 딜에서
누구와 언제 무슨 메일이 오갔는지"를 그대로 보여줄 수 있게 하는 것이 목적이다.

들이는 범위는 좁게 잡는다 — Settings 에 등록된 고객·벤더 주소와 오간 메일, 그리고
이미 담아 둔 메일의 답장(스레드)뿐이다. 사내 공지·개인 메일·광고는 애초에 저장하지
않는다(보관 범위를 설명할 수 있어야 하고, DB 전송량도 아껴야 한다).

프로젝트 연결은 근거가 또렷한 순서로 시도한다.
  1) 스레드 — In-Reply-To·References 가 이미 저장된 메일을 가리키면 그 프로젝트.
     회신 메일은 이 경로로 거의 다 붙는다(제목이 바뀌어도 따라간다).
  2) 문서번호 — 제목·**첨부 파일이름**·본문에 그 딜의 번호(P-024 / KMS-RFQ-2608-017 /
     견적·P/O 번호)가 있으면 그 프로젝트. 첨부 이름을 보는 게 값싸고 잘 맞는다 —
     견적서·발주서는 번호를 파일 이름에 달고 오는데 본문은 "첨부 참조"뿐인 일이 흔하다.
  3) 선박 — 그 배가 걸린 딜이 하나뿐이고 배 이름이 제목·본문에 있으면 그 프로젝트.
붙지 못한 메일은 rfq_id 없이 남아 '미분류' 목록에서 사람이 한 번에 배정한다.
(추측으로 붙이면 틀린 딜의 이력이 되는데, 그건 비어 있는 것보다 나쁘다. 그래서 어느
 근거든 후보 딜이 둘 이상이면 붙이지 않는다 — 다만 그 후보들이 한 문의에서 갈라진
 형제 딜이면 어차피 같은 이력을 함께 보므로 대표 딜에 붙인다. mail_group_map 참고.)

환경변수
  IMAP_HOST(기본 imap.gmail.com) · IMAP_PORT(993) · IMAP_USER · IMAP_PASSWORD
    비우면 SMTP_USER / SMTP_PASSWORD 를 그대로 쓴다(같은 계정이면 추가 설정이 없다).
  IMAP_FOLDERS  쉼표 구분 폴더 이름. 비우면 INBOX + 서버가 \\Sent 로 표시한 폴더.
  IMAP_SINCE_DAYS(120)  읽어 들일 기간(이보다 오래된 메일은 보지 않는다).
  IMAP_MAX_PER_SYNC(200)  한 번의 동기화에서 가져올 최대 통수(폴더 수로 나눠 쓴다).
    한 번에 다 못 읽으면 남은 통수를 알려 준다 — Sync 를 다시 누르면 이어 읽는다.
"""
from __future__ import annotations

import email
import imaplib
import os
import re
import threading
from datetime import datetime, timedelta, timezone
from email.header import decode_header, make_header
from email.message import Message
from email.utils import getaddresses, parsedate_to_datetime
from typing import Iterable

from sqlalchemy import func

from db.models import (
    AppSetting, Customer, CustomerContact, EmailMessage, EmailSyncState, Order,
    PurchaseOrder, Quotation, RFQ, User, Vendor, VendorContact, VendorRFQ, Vessel, WorkType,
)

# 본문 보관 상한 — 요약과 원문 확인에는 충분하고, 첨부 인용문이 통째로 들어오는
# 메일에 DB 를 내주지 않을 만큼. 넘으면 잘라 두고 truncated 로 표시한다.
MAX_BODY_CHARS = 20_000
KST = timezone(timedelta(hours=9))


class SyncBusy(RuntimeError):
    """이미 동기화가 돌고 있다 — 실패가 아니라 '지금은 아니다'. 화면은 이것을 오류로
    보여 주지 말고, 돌고 있다는 사실로 보여 줘야 한다."""

    def __init__(self, started_at: str = ""):
        super().__init__("A sync is already running.")
        self.started_at = started_at

# 동기화는 한 번에 하나만. 매일 도는 자동 실행과 사람이 누른 Sync 가 겹치면 같은
# 메일을 두 번 집어 message_id 유일 제약에서 터지고, IMAP 연결도 둘로 늘어난다.
_SYNC_LOCK = threading.Lock()
_SYNC_STARTED_AT = ""      # 지금 도는 동기화가 시작한 시각(KST). 안 돌면 빈 문자열.


def is_syncing() -> str:
    """동기화가 돌고 있으면 시작 시각, 아니면 빈 문자열.

    화면이 "지금 돌고 있다"를 말할 수 있어야 한다 — 아침 자동 실행은 몇 분씩 걸리는데,
    그동안 상태가 '아직 안 돌았음'으로 보이면 사람은 버튼을 누르고 거절만 당한다."""
    return _SYNC_STARTED_AT


# ── 설정 ──────────────────────────────────────────────────────────────────────

def mail_config() -> dict:
    return {
        "host": os.getenv("IMAP_HOST", "imap.gmail.com"),
        "port": int(os.getenv("IMAP_PORT", "993")),
        "user": os.getenv("IMAP_USER", "") or os.getenv("SMTP_USER", ""),
        "password": os.getenv("IMAP_PASSWORD", "") or os.getenv("SMTP_PASSWORD", ""),
        "folders": [f.strip() for f in (os.getenv("IMAP_FOLDERS", "") or "").split(",") if f.strip()],
        "since_days": int(os.getenv("IMAP_SINCE_DAYS", "120")),
        "max_per_sync": int(os.getenv("IMAP_MAX_PER_SYNC", "200")),
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


# ── 등록되지 않은 상대 주소 ───────────────────────────────────────────────────
#
# 저장 범위를 "등록된 거래처와 오간 메일"로 좁힌 대가가 있다. 아직 Settings 에 넣지
# 않은 거래처의 메일은 통째로 버려지고, 남는 건 skipped 통수뿐이라 무엇을 놓쳤는지
# 알 길이 없다. 그러면 "이 대시보드가 우리 메일의 얼마를 담고 있나"에 답할 수 없다.
# 그래서 버릴 때 상대 주소만 세어 둔다(본문·제목 전문은 담지 않는다 — 저장하지 않기로
# 한 메일이다). 사람은 이 목록을 보고 진짜 거래처만 골라 등록하면 된다.
UNKNOWN_KEY = "mail_unknown_addrs"     # {addr: {count, last_at, name, subject}}
UNKNOWN_IGNORE_KEY = "mail_unknown_ignored"   # [addr] — 다시 보지 않기로 한 주소
UNKNOWN_MAX = 60                       # 보관할 주소 수(많이 온 순으로 자른다)


def _setting(s, key: str, default):
    row = s.query(AppSetting).filter_by(key=key).first()
    return row.value if row and row.value is not None else default


def _save_setting(s, key: str, value) -> None:
    row = s.query(AppSetting).filter_by(key=key).first()
    if row:
        row.value, row.updated_at = value, datetime.utcnow()
    else:
        s.add(AppSetting(key=key, value=value, updated_at=datetime.utcnow()))


def unknown_addresses(s) -> list[dict]:
    """등록되지 않은 상대 주소 — 많이 온 순. 무시하기로 한 주소는 빼고 돌려준다."""
    seen = _setting(s, UNKNOWN_KEY, {}) or {}
    ignored = set(_setting(s, UNKNOWN_IGNORE_KEY, []) or [])
    known = set(party_index(s)) | set(_setting(s, ADDR_LINK_KEY, {}) or {})
    out = [{"addr": a, **v} for a, v in seen.items()
           if a not in ignored and a not in known]
    out.sort(key=lambda r: (-int(r.get("count") or 0), r.get("addr", "")))
    return out


def ignore_unknown_address(s, addr: str) -> None:
    """이 주소는 거래처가 아니다 — 목록에서 내리고 다음 동기화에서도 세지 않는다."""
    a = (addr or "").strip().lower()
    if not a:
        return
    ignored = list(_setting(s, UNKNOWN_IGNORE_KEY, []) or [])
    if a not in ignored:
        ignored.append(a)
    _save_setting(s, UNKNOWN_IGNORE_KEY, ignored[-500:])
    seen = dict(_setting(s, UNKNOWN_KEY, {}) or {})
    seen.pop(a, None)
    _save_setting(s, UNKNOWN_KEY, seen)
    s.commit()


# ── 주소를 딜에 붙이기 ────────────────────────────────────────────────────────
#
# 위 목록에서 골라낸 주소가 늘 '등록해야 할 거래처'인 것은 아니다. 선급 검사관, 선주
# 대리인, 조선소 담당자처럼 **한 딜에서만 만나는 상대**가 있다 — 이들을 고객·벤더로
# 등록하면 거래처 목록이 한 번 쓰고 버릴 이름으로 불어난다. 그렇다고 버리면 그 딜의
# 대화 절반이 시스템 밖에 남는다.
#
# 그래서 세 번째 길을 둔다: **주소를 딜에 직접 붙인다.** 붙이는 순간 그 주소와 오간
# 메일을 메일함에서 찾아 담고(과거분), 앞으로 오는 메일도 담는다. 딜은 근거가 있으면
# (스레드·문서번호·선박) 그 근거를 따르고, 없을 때만 붙여 둔 딜로 간다 — 붙였다는
# 사실이 다른 증거를 덮지는 않는다.
ADDR_LINK_KEY = "mail_addr_links"   # {addr: {"rfq_id": int, "name": str, "at": str}}


def _clean_addr(addr: str) -> str:
    return (addr or "").strip().lower()


def address_links(s) -> dict[str, dict]:
    """딜에 붙여 둔 주소 → {rfq_id, name, at}. 딜이 사라진 줄은 걸러 낸다."""
    raw = _setting(s, ADDR_LINK_KEY, {}) or {}
    if not raw:
        return {}
    alive = {r.id for r in s.query(RFQ.id).filter(
        RFQ.id.in_([int(v.get("rfq_id") or 0) for v in raw.values()])).all()}
    return {a: v for a, v in raw.items() if int(v.get("rfq_id") or 0) in alive}


def address_link_map(s) -> dict[str, int]:
    """{주소: rfq_id} — 저장 판단과 딜 지정에 쓰는 가벼운 형태."""
    return {a: int(v["rfq_id"]) for a, v in address_links(s).items()}


def link_address(s, addr: str, rfq_id: int, name: str = "") -> None:
    """이 주소의 메일은 이 딜의 것으로 담는다(이미 붙어 있으면 딜만 바꾼다)."""
    a = _clean_addr(addr)
    if not a or "@" not in a:
        raise ValueError("메일 주소가 아닙니다.")
    links = dict(_setting(s, ADDR_LINK_KEY, {}) or {})
    seen = dict(_setting(s, UNKNOWN_KEY, {}) or {})
    links[a] = {
        "rfq_id": int(rfq_id),
        # 이름은 미등록 목록에 세어 둔 표시이름을 물려받는다 — 주소만 남으면 나중에
        # 이 줄이 누구였는지 알 수 없다.
        "name": (name or (seen.get(a) or {}).get("name") or "")[:120],
        "at": datetime.now(KST).strftime("%Y-%m-%d %H:%M"),
    }
    _save_setting(s, ADDR_LINK_KEY, links)
    s.commit()


def unlink_address(s, addr: str) -> None:
    """붙여 둔 것을 뗀다. 이미 담은 메일은 그대로 둔다 — 그건 딜의 이력이고,
    잘못 붙었다면 미분류 화면에서 한 통씩 옮기면 된다."""
    a = _clean_addr(addr)
    links = dict(_setting(s, ADDR_LINK_KEY, {}) or {})
    if links.pop(a, None) is not None:
        _save_setting(s, ADDR_LINK_KEY, links)
        s.commit()


def adopt_stored_mail(s, addr: str, rfq_id: int) -> int:
    """이미 담겨 있지만 딜을 못 정한 메일 중 이 주소 것을 그 딜로 옮긴다.

    주소를 붙이기 전에도 스레드를 타고 들어온 메일이 있을 수 있다(우리가 먼저 보낸
    메일의 답장 등). 그것들이 미분류 함에 남아 있으면 사람은 같은 판단을 두 번 한다."""
    a = _clean_addr(addr)
    if not a:
        return 0
    rows = (s.query(EmailMessage)
            .filter(EmailMessage.rfq_id.is_(None), func.lower(EmailMessage.from_addr) == a).all())
    for m in rows:
        m.rfq_id = rfq_id
        m.match_by = "address"
        m.not_deal = False
    if rows:
        s.commit()
    return len(rows)


# IMAP 검색어에 그대로 넣어도 안전한 주소만 통과시킨다(따옴표·괄호 주입 방지).
_ADDR_SAFE = re.compile(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+$")


def fetch_address(s, addr: str, rfq_id: int | None = None, limit: int = 300) -> dict:
    """이 주소와 오간 메일을 지금 메일함에서 찾아 담는다(과거분 채우기).

    보통의 동기화는 폴더를 UID 순서로 훑기 때문에, 이미 지나친 구간에 있는 메일은
    주소를 붙이거나 거래처로 등록했다고 다시 읽히지 않는다. 그래서 여기서는 주소로
    직접 검색한다 — IMAP_SINCE_DAYS 안의 메일 중 그 주소가 From·To·Cc 에 있는 것 전부.

    rfq_id 를 주면 근거가 없는 메일을 그 딜에 붙인다(주소를 딜에 맨 경우). 비우면
    거래처로 등록된 주소라는 뜻이라, 담기만 하고 딜은 근거대로만 정한다.

    반환: {scanned, stored, dup, skipped}"""
    a = _clean_addr(addr)
    if not _ADDR_SAFE.match(a):
        raise ValueError("메일 주소가 아닙니다.")
    cfg = mail_config()
    if not cfg["user"] or not cfg["password"]:
        raise RuntimeError("IMAP 계정이 설정되지 않았습니다.")
    own = own_addresses(s)
    parties = party_index(s)
    docs = doc_no_index(s)
    vessels = vessel_index(s)
    linked = {a: int(rfq_id)} if rfq_id else {}
    since = (datetime.now(timezone.utc) - timedelta(days=cfg["since_days"])).strftime("%d-%b-%Y")
    crit = f'(SINCE {since} OR OR FROM "{a}" TO "{a}" CC "{a}")'
    out = {"scanned": 0, "stored": 0, "dup": 0, "skipped": 0}

    conn = _connect(cfg)
    try:
        for folder in _folders(conn, cfg):
            typ, _ = conn.select(f'"{folder}"', readonly=True)
            if typ != "OK":
                continue
            typ, data = conn.uid("SEARCH", None, crit)
            if typ != "OK" or not data or not data[0]:
                continue
            uids = sorted(int(x) for x in data[0].split())[-max(1, limit):]
            for uid in uids:
                typ, raw = conn.uid("FETCH", str(uid), "(RFC822)")
                if typ != "OK" or not raw or not isinstance(raw[0], tuple):
                    continue
                out["scanned"] += 1
                out[_store_message(s, email.message_from_bytes(raw[0][1]), folder, own,
                                   parties, docs, None, vessels, linked)] += 1
            s.commit()
    finally:
        try:
            conn.logout()
        except Exception:
            pass
    return out


def _merge_unknown(s, found: dict[str, dict]) -> None:
    """이번 동기화에서 만난 미등록 주소를 기존 집계에 합친다(통수는 누적)."""
    if not found:
        return
    seen = dict(_setting(s, UNKNOWN_KEY, {}) or {})
    ignored = set(_setting(s, UNKNOWN_IGNORE_KEY, []) or [])
    for addr, hit in found.items():
        if addr in ignored:
            continue
        cur = dict(seen.get(addr) or {})
        cur["count"] = int(cur.get("count") or 0) + hit["count"]
        # 이름·제목은 가장 최근 것으로 — 무엇을 놓치고 있는지 가늠할 단서다.
        if (hit.get("last_at") or "") >= (cur.get("last_at") or ""):
            cur["last_at"] = hit.get("last_at") or cur.get("last_at") or ""
            cur["name"] = hit.get("name") or cur.get("name") or ""
            cur["subject"] = hit.get("subject") or cur.get("subject") or ""
        seen[addr] = cur
    top = sorted(seen.items(), key=lambda kv: -int(kv[1].get("count") or 0))[:UNKNOWN_MAX]
    _save_setting(s, UNKNOWN_KEY, dict(top))


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
            for r in s.query(RFQ.id, RFQ.received_at, RFQ.date, RFQ.work_type).all()]
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
    메일이 붙는다. 문서마다 번호 열만 읽는다(품목 JSON 까지 끌어올 이유가 없다)."""
    idx: dict[str, int] = {}

    def put(no: str, rfq_id: int | None) -> None:
        t = (no or "").strip().upper()
        if rfq_id and len(t) >= 5 and not t.isdigit():
            idx.setdefault(t, rfq_id)

    for rid, pno in _project_no_map(s).items():
        put(pno, rid)
    for r in s.query(RFQ.id, RFQ.rfq_no, RFQ.customer_rfq_no).all():
        put(r.rfq_no or "", r.id)
        put(r.customer_rfq_no or "", r.id)
    for vr in s.query(VendorRFQ.rfq_id, VendorRFQ.kmaris_rfq_no).all():
        put(vr.kmaris_rfq_no or "", vr.rfq_id)
    for q in s.query(Quotation.rfq_id, Quotation.qtn_no).all():
        put(q.qtn_no or "", q.rfq_id)
    order_rfq = {o.id: o.rfq_id for o in s.query(Order.id, Order.rfq_id).all()}
    for o in s.query(Order.rfq_id, Order.po_no).all():
        put(o.po_no or "", o.rfq_id)
    # Vendor P/O 는 딜에 바로 매달려 있지 않고 오더를 거친다.
    for p in s.query(PurchaseOrder.order_id, PurchaseOrder.po_no).all():
        put(p.po_no or "", order_rfq.get(p.order_id))
    return idx


# 선박 이름으로 알아보기 — 이 바닥에서 배 이름만큼 딜을 정확히 가리키는 낱말은 없다.
# 다만 같은 배로 딜이 여러 건 도는 일이 흔하므로, 후보가 하나일 때만 쓴다.
# 너무 짧거나 흔한 이름(MV, STAR 한 낱말짜리)은 우연히 걸리므로 아예 넣지 않는다.
_VESSEL_STOP = {"MV", "MT", "MS", "SS", "HULL", "NEW", "NO", "THE", "VESSEL", "SHIP"}


def _vessel_token(name: str) -> str:
    """선박 이름을 견줄 꼴로 — 접두어(M/V, MT)를 떼고 대문자·단일 공백."""
    t = re.sub(r"^\s*(?:M\s*[./]?\s*[VT]|MV|MT|MS|SS)\b[\s.:-]*", "", (name or "").upper())
    t = re.sub(r"[^0-9A-Z ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def vessel_index(s) -> dict[str, set[int]]:
    """선박 이름 → 그 배가 걸린 딜들. 후보가 둘 이상인 이름은 호출부가 걸러 쓴다."""
    names = {v.id: _vessel_token(v.name or "") for v in s.query(Vessel.id, Vessel.name).all()}
    idx: dict[str, set[int]] = {}
    for r in s.query(RFQ.id, RFQ.vessel_id).all():
        token = names.get(r.vessel_id or 0, "")
        # 한 낱말짜리 흔한 이름은 본문에서 우연히 걸린다 — 두 낱말이거나 6자 이상만.
        if not token or token in _VESSEL_STOP:
            continue
        if len(token) < 6 and " " not in token:
            continue
        idx.setdefault(token, set()).add(r.id)
    return idx


def _haystack(subject: str, body: str, attachments: list | None = None) -> str:
    """문서번호·선박 이름을 찾을 본문 — 제목 + 본문 앞부분 + 첨부 파일이름.

    첨부 이름을 넣는 게 값싸고 정확하다. 견적서·발주서는 거의 늘 문서번호를 파일
    이름에 달고 오는데(KMS-QTN-2608-017.pdf), 정작 본문에는 "첨부 참조"만 있는
    메일이 흔하다 — 그런 메일이 그동안 통째로 미분류로 남았다."""
    files = " ".join(str((a or {}).get("name", "")) for a in (attachments or [])[:20])
    return f"{subject}\n{files}\n{body[:DOC_SCAN_CHARS]}".upper()


# 문서번호를 찾을 본문 길이. 인용된 지난 대화에 번호가 있는 일이 잦아 앞머리만으로는
# 놓친다. 미분류 한 통당 이만큼 읽어도 수백 통 기준 몇 백 KB 다.
DOC_SCAN_CHARS = 8_000


def match_project(s, msg_ids: Iterable[str], subject: str, body: str,
                  docs: dict[str, int], attachments: list | None = None,
                  vessels: dict[str, set[int]] | None = None) -> tuple[int | None, str]:
    """(rfq_id, 연결 근거). 스레드 → 문서번호 → 선박 순. 못 찾으면 (None, '')."""
    parents = [m for m in msg_ids if m]
    if parents:
        hit = (s.query(EmailMessage)
               .filter(EmailMessage.message_id.in_(parents), EmailMessage.rfq_id.isnot(None))
               .order_by(EmailMessage.id.desc()).first())
        if hit:
            return hit.rfq_id, "thread"
    haystack = _haystack(subject, body, attachments)
    for token, rfq_id in docs.items():
        if token in haystack:
            return rfq_id, "docno"
    for token, rids in (vessels or {}).items():
        if len(rids) == 1 and token in haystack:
            return next(iter(rids)), "vessel"
    return None, ""


def thread_key_of(msg_ids: list[str], message_id: str) -> str:
    """스레드 묶음 키 — References 의 맨 앞(뿌리)이 있으면 그것, 없으면 자기 자신."""
    return (msg_ids[0] if msg_ids else "") or message_id


# ── 제목으로 같은 대화 알아보기 ───────────────────────────────────────────────
#
# 회신 헤더(In-Reply-To·References)는 생각보다 자주 끊긴다 — 전달(FW), 웹메일에서
# 새로 쓴 답장, 중국·한국 클라이언트의 제목 접두어("回复:", "답장:") 등. 그래서
# 스레드만으로는 절반도 못 붙는다. 답장 표시를 걷어낸 제목이 같으면 사실상 같은
# 대화라는 걸 사람은 한눈에 알아보므로, 그 판단을 그대로 규칙으로 쓴다.
_REPLY_MARK_RE = re.compile(
    r"^\s*(?:\[[^\]\r\n]{1,40}\]"
    r"|(?:re|ref|reply|fw|fwd|forward(?:ed)?|답장|회신|전달|回复|回覆|答复|回信|轉發|转发|轉寄|转寄)"
    r"\s*(?:\[\d+\])?\s*[:：])\s*",
    re.I,
)
# 제목 열쇠로 쓰기에 너무 흔한 낱말 — 이것만 남는 제목("RE: RFQ")은 열쇠가 못 된다.
_SUBJ_STOP = {
    "RE", "FW", "FWD", "RFQ", "REQUEST", "QUOTATION", "QUOTE", "QUOTE.", "INQUIRY", "ENQUIRY",
    "OFFER", "ORDER", "MAIL", "EMAIL", "FOR", "AND", "THE", "OF", "AT", "TO", "ON", "IN",
    "YOUR", "OUR", "PLS", "PLEASE", "DEAR", "견적", "문의", "요청", "회신", "안녕하세요",
}


def normalize_subject(subject: str) -> str:
    """답장·전달 표시와 앞머리 [태그] 를 걷어낸 제목(대문자·공백 정리)."""
    s = subject or ""
    for _ in range(8):                     # "RE: FW: [K-MARIS] …" 처럼 겹쳐 붙는다
        t = _REPLY_MARK_RE.sub("", s)
        if t == s:
            break
        s = t
    return re.sub(r"\s+", " ", s).strip().upper()


def subject_key(subject: str) -> str:
    """같은 대화를 가르는 제목 열쇠. 너무 짧거나 흔한 제목이면 빈 문자열 —
    "RE: RFQ" 같은 제목으로 묶으면 남의 딜 메일이 섞인다."""
    norm = normalize_subject(subject)
    strong = [w for w in re.split(r"[^0-9A-Z가-힣/._-]+", norm)
              if len(w) >= 3 and w not in _SUBJ_STOP]
    return norm if len(norm) >= 12 and len(strong) >= 2 else ""


def _day(sent_at: str) -> str:
    return (sent_at or "")[:10]


def _gap_days(a: str, b: str) -> int | None:
    """a - b (일). 둘 중 하나라도 날짜로 읽히지 않으면 None."""
    try:
        return (datetime.strptime(_day(a), "%Y-%m-%d")
                - datetime.strptime(_day(b), "%Y-%m-%d")).days
    except ValueError:
        return None


def _days_apart(a: str, b: str) -> int:
    """두 'YYYY-MM-DD' 사이의 일수. 한쪽이라도 비면 아주 멀다고 본다."""
    gap = _gap_days(a, b)
    return 10_000 if gap is None else abs(gap)


# 같은 제목이라도 이만큼 떨어져 있으면 다른 건으로 본다 — 같은 배·같은 부품으로
# 반년 뒤 다시 문의가 오면 그건 새 딜이다.
SUBJECT_WINDOW_DAYS = 150


# ── 자동 배정 ─────────────────────────────────────────────────────────────────

def auto_match(s, max_passes: int = 5) -> dict:
    """미분류 메일 중 근거가 분명한 것만 딜에 붙인다. 반환 {thread, docno, vessel, subject, total}.

    근거는 네 가지고, 어느 것도 추측이 아니다.
      thread  — 같은 대화(스레드 뿌리·References·Message-ID)의 메일이 이미 그 딜에 있다
      docno   — 제목·첨부 이름·본문에 그 딜의 문서번호(P-024 / KMS-RFQ-… / 견적·P/O)가 있다
      vessel  — 그 배가 걸린 딜이 하나뿐이고, 배 이름이 제목·본문에 있다
      subject — 답장 표시를 걷어낸 제목이 그 딜의 메일과 같다(같은 기간, 후보 딜이 하나)
    후보 딜이 둘 이상이면 붙이지 않는다 — 틀린 딜의 이력은 비어 있는 것보다 나쁘다.
    예외는 후보가 모두 한 문의에서 갈라진 형제 딜일 때뿐이다(대표에 붙인다).
    한 통이 붙으면 그 대화의 나머지가 다시 근거가 되므로 더 붙일 게 없을 때까지 돈다."""
    counts = {"thread": 0, "docno": 0, "vessel": 0, "subject": 0, "total": 0}
    docs = doc_no_index(s)
    vessels = vessel_index(s)
    groups = mail_group_map(s)

    def only_deal(cands: set[int]) -> int | None:
        """후보가 하나면 그 딜. 여럿이면 붙이지 않는다 — 다만 후보가 모두 한 문의에서
        갈라진 형제 딜이면 그 묶음의 대표에 붙인다(어차피 함께 보는 이력이라 어느
        쪽에 담기든 세 딜 모두에 보인다). 그래도 대표 하나에만 담아 원본이 하나임을
        지킨다."""
        if len(cands) == 1:
            return next(iter(cands))
        if len(cands) > 1:
            mates = groups.get(next(iter(cands)), [])
            if len(mates) > 1 and cands <= set(mates):
                return min(cands)
        return None
    # 판단에 쓰는 열만 읽는다 — 본문까지 통째로 끌어오면 메일 수백 통이 그대로
    # DB 전송량이 된다. 첨부는 이름만 든 짧은 JSON 이라 함께 읽어도 가볍고,
    # 견적서·발주서의 문서번호가 거기 붙어 오는 일이 아주 많다.
    keys = (EmailMessage.id, EmailMessage.thread_key, EmailMessage.message_id,
            EmailMessage.in_reply_to, EmailMessage.refs, EmailMessage.subject,
            EmailMessage.sent_at, EmailMessage.rfq_id, EmailMessage.attachments)
    head = func.substr(EmailMessage.body_text, 1, DOC_SCAN_CHARS).label("body_head")
    for _ in range(max(1, max_passes)):
        # '딜 아님'으로 내려 둔 메일(회사 소개·인사·자동회신)은 후보에서 뺀다 — 붙일
        # 딜이 없다고 사람이 이미 판단한 것을 제목이 비슷하다고 되살리면 안 된다.
        unmatched = (s.query(*keys, head)
                     .filter(EmailMessage.rfq_id.is_(None),
                             (EmailMessage.not_deal.is_(None))
                             | (EmailMessage.not_deal.is_(False))).all())
        if not unmatched:
            break
        matched = (s.query(*keys[:-1])   # 첨부는 색인에 쓰지 않는다
                   .filter(EmailMessage.rfq_id.isnot(None)).all())

        # 이미 붙은 메일에서 '이 열쇠는 이 딜' 색인을 만든다. 값이 두 개 이상이면
        # 그 열쇠는 쓰지 않는다(어느 딜인지 정할 수 없다).
        threads: dict[str, set[int]] = {}
        ids: dict[str, set[int]] = {}
        subjects: dict[str, set[int]] = {}
        subject_days: dict[tuple[str, int], list[str]] = {}
        for m in matched:
            if m.thread_key:
                threads.setdefault(m.thread_key, set()).add(m.rfq_id)
            for key in [m.message_id, m.in_reply_to, *(m.refs or [])]:
                if key:
                    ids.setdefault(key, set()).add(m.rfq_id)
            sk = subject_key(m.subject or "")
            if sk:
                subjects.setdefault(sk, set()).add(m.rfq_id)
                subject_days.setdefault((sk, m.rfq_id), []).append(m.sent_at or "")

        # 같은 (딜, 근거) 로 정해진 메일은 한 번의 UPDATE 로 묶어 옮긴다.
        decided: dict[tuple[int, str], list[int]] = {}
        for m in unmatched:
            rfq_id, why = None, ""
            chain = [k for k in [m.thread_key, m.message_id, m.in_reply_to, *(m.refs or [])] if k]
            for key in chain:
                hit = only_deal(threads.get(key) or ids.get(key) or set())
                if hit:
                    rfq_id, why = hit, "thread"
                    break
            # 제목 + 첨부 이름 + 본문 앞부분. 견적서·발주서는 문서번호를 파일 이름에
            # 달고 오는데 본문에는 "첨부 참조"만 있는 일이 흔하다 — 그런 메일이
            # 그동안 통째로 미분류에 남았다.
            haystack = _haystack(m.subject or "", m.body_head or "", m.attachments)
            if not rfq_id:
                for token, rid in docs.items():
                    if token in haystack:
                        rfq_id, why = rid, "docno"
                        break
            if not rfq_id:
                # 배 이름은 이 바닥에서 가장 또렷한 단서다. 다만 같은 배로 딜이 여러 건
                # 도는 일이 흔하므로 후보가 하나일 때만 쓴다.
                for token, rids in vessels.items():
                    hit = only_deal(rids) if token in haystack else None
                    if hit:
                        rfq_id, why = hit, "vessel"
                        break
            if not rfq_id:
                sk = subject_key(m.subject or "")
                near = {rid for rid in subjects.get(sk, set())
                        if any(_days_apart(m.sent_at or "", d) <= SUBJECT_WINDOW_DAYS
                               for d in subject_days.get((sk, rid), []))} if sk else set()
                hit = only_deal(near)
                if hit:
                    rfq_id, why = hit, "subject"
            if rfq_id:
                decided.setdefault((rfq_id, why), []).append(m.id)
                counts[why] += 1
                counts["total"] += 1
        for (rfq_id, why), mail_ids in decided.items():
            (s.query(EmailMessage).filter(EmailMessage.id.in_(mail_ids))
             .update({EmailMessage.rfq_id: rfq_id, EmailMessage.match_by: why},
                     synchronize_session=False))
        s.commit()
        if not decided:
            break
    return counts


# ── 한 문의에서 갈라진 딜(형제 딜) ────────────────────────────────────────────
#
# 고객이 메일 한 통으로 품목 여럿을 물어 오면 제조사별로 딜을 나눠 세운다
# (P-024 MURR / P-025 PARKER / P-026 HONEYWELL). 그런데 오가는 대화는 여전히
# **하나**다. EmailMessage.rfq_id 는 하나뿐이라 그 대화는 먼저 붙은 딜에만 남고,
# 나머지 형제 딜은 화면에서 통째로 "메일 없음"이 된다 — 정작 그 딜의 사연이
# 전부 담긴 대화가 옆 딜에 있는데도. 그래서 묶인 딜은 메일 이력을 함께 본다.
#
# 메일을 여러 딜에 복사하지 않는다(원본은 한 통뿐이고, 복사하면 어느 것이 진짜인지
# 알 수 없어진다). 저장은 그대로 두고 **읽을 때만** 묶음을 펼친다.

def mail_group_map(s) -> dict[int, list[int]]:
    """rfq_id → 메일을 함께 보는 딜들(자기 포함, 오름차순). 혼자면 [자기 자신]."""
    rows = s.query(RFQ.id, RFQ.mail_group_id).all()
    groups: dict[int, list[int]] = {}
    for r in rows:
        if r.mail_group_id:
            groups.setdefault(r.mail_group_id, []).append(r.id)
    out: dict[int, list[int]] = {}
    for r in rows:
        mates = groups.get(r.mail_group_id or 0) or []
        out[r.id] = sorted(mates) if len(mates) > 1 else [r.id]
    return out


def mail_group_of(s, rfq_id: int) -> list[int]:
    """이 딜이 메일을 함께 보는 딜들(자기 포함). 딜 하나만 볼 때 쓰는 가벼운 길."""
    row = s.query(RFQ.mail_group_id).filter_by(id=rfq_id).first()
    gid = row[0] if row else None
    if not gid:
        return [rfq_id]
    mates = [r.id for r in s.query(RFQ.id).filter_by(mail_group_id=gid).all()]
    return sorted(mates) if len(mates) > 1 else [rfq_id]


def group_siblings(s, customer_id: int | None, received_at: str) -> list[int]:
    """같은 고객·같은 수신일시(분까지)로 이미 서 있는 딜 — 새 딜을 세울 때 묶을 상대.

    사람이 한 통의 문의를 품목별로 나눠 세울 때 수신일시를 그대로 옮겨 적는다.
    서로 다른 문의가 고객까지 같으면서 분까지 겹치는 일은 사실상 없다."""
    at = (received_at or "").strip()
    if not customer_id or "T" not in at:
        return []
    return [r.id for r in s.query(RFQ.id)
            .filter(RFQ.customer_id == customer_id, RFQ.received_at == at).all()]


# ── 최근에 움직인 딜 ──────────────────────────────────────────────────────────

def cutoff_at(days: int) -> str:
    """조회 창의 시작 시각 — sent_at 과 같은 'YYYY-MM-DDTHH:MM'(KST) 꼴이라 문자열로 견준다."""
    return (datetime.now(KST) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M")


def live_deals(s, days: int | None = 14) -> dict[int, tuple[int, str, int]]:
    """메일이 있는 열린 딜 → (전체 통수, 마지막 메일 시각, 마지막 메일 id).

    days 를 주면 그 기간 안에 메일이 오간 딜만, None 이면 메일이 있는 열린 딜 전부.
    **기간은 '어느 딜을 화면에 올릴까'를 정할 때만 쓴다.** 딜의 메일 이력 자체를
    기간으로 자르면 안 된다 — 마지막 메일이 3주 전이어도 단계는 이번 주에 움직이는
    딜이 흔하고(P-007 처럼), 그 카드에서 정작 사연을 담은 44통이 통째로 사라진다.

    한 문의에서 갈라진 형제 딜은 묶음 전체의 집계를 나눠 갖는다 — 대화가 하나뿐인데
    딜만 셋이면, 메일이 붙은 한 딜만 살아 있고 나머지는 '조용한 딜'로 보이기 때문이다.

    집계만 받아 온다 — 행을 끌어오면 딜 수십 개의 본문이 통째로 따라온다."""
    totals = (s.query(EmailMessage.rfq_id,
                      func.count(EmailMessage.id),
                      func.max(EmailMessage.sent_at),
                      func.max(EmailMessage.id))
              .filter(EmailMessage.rfq_id.isnot(None))
              .group_by(EmailMessage.rfq_id).all())
    closed = {r.id for r in s.query(RFQ.id, RFQ.closed_at).all() if (r.closed_at or "").strip()}
    stats = {rid: (cnt, last_at or "", last_id) for rid, cnt, last_at, last_id in totals}

    # 형제 딜에 묶음 합계를 나눠 준다. 메일이 한 통도 안 붙은 형제도 여기서 자리를 얻는다.
    groups = mail_group_map(s)
    shared: dict[int, tuple[int, str, int]] = {}
    for rid, mates in groups.items():
        if len(mates) < 2:
            continue
        rows = [stats[m] for m in mates if m in stats]
        if rows:
            shared[rid] = (sum(r[0] for r in rows), max(r[1] for r in rows),
                           max(r[2] for r in rows))
    merged = {**stats, **shared}

    cutoff = cutoff_at(days) if days else ""
    return {rid: v for rid, v in merged.items()
            if rid not in closed and (v[1] or "") >= cutoff}


# ── 후보 추천(자동으로 붙이지는 않는다) ───────────────────────────────────────

def _words(text: str) -> set[str]:
    """낱말 집합 — 3자 이상, 흔한 낱말 제외. 제목과 딜 이름을 견주는 데 쓴다."""
    return {w for w in re.split(r"[^0-9A-Za-z가-힣]+", (text or "").upper())
            if len(w) >= 3 and w not in _SUBJ_STOP}


def _deal_profiles(s) -> list[dict]:
    """딜별 대조표 — 이름 낱말·상대 거래처·시작일. 추천 점수를 매기는 재료."""
    vendors: dict[int, set[int]] = {}
    for vr in s.query(VendorRFQ.rfq_id, VendorRFQ.vendor_id).all():
        if vr.rfq_id and vr.vendor_id:
            vendors.setdefault(vr.rfq_id, set()).add(vr.vendor_id)
    vessel_names = {v.id: v.name or "" for v in s.query(Vessel.id, Vessel.name).all()}
    out = []
    for r in s.query(RFQ.id, RFQ.project_title, RFQ.customer_rfq_no, RFQ.vessel_id,
                     RFQ.customer_id, RFQ.received_at, RFQ.date).all():
        out.append({
            "rfq_id": r.id,
            "words": _words(" ".join([r.project_title or "", r.customer_rfq_no or "",
                                      vessel_names.get(r.vessel_id, "")])),
            "customer_id": r.customer_id,
            "vendor_ids": vendors.get(r.id, set()),
            "start": _day(r.received_at or r.date or ""),
        })
    return out


# 메일이 딜의 시작일보다 이만큼 앞서거나(문의 전 사전 연락) 뒤처지면 후보에서 뺀다.
SUGGEST_BEFORE_DAYS = 21
SUGGEST_AFTER_DAYS = 240


def suggest_projects(s, msgs: list[EmailMessage]) -> dict[int, dict]:
    """붙일 근거가 없는 메일에 '아마 이 딜' 후보를 하나씩 달아 준다 — 자동으로 붙이지는
    않는다. 제목과 딜 이름이 겹치는지, 상대가 그 딜의 고객·벤더인지, 시기가 맞는지를
    보고 1등이 2등보다 확실할 때만 내놓는다. 확정은 화면에서 사람이 누른다."""
    deals = _deal_profiles(s)
    names = {rid: no for rid, no in _project_no_map(s).items()}
    out: dict[int, dict] = {}
    for m in msgs:
        day = _day(m.sent_at or "")
        subj = _words(normalize_subject(m.subject or ""))
        scored: list[tuple[float, str, int]] = []
        for d in deals:
            gap = _gap_days(day, d["start"])
            if gap is None or gap < -SUGGEST_BEFORE_DAYS or gap > SUGGEST_AFTER_DAYS:
                continue
            shared = subj & d["words"]
            party = ((m.customer_id and m.customer_id == d["customer_id"])
                     or (m.vendor_id and m.vendor_id in d["vendor_ids"]))
            score = (2.0 if len(shared) >= 2 else 1.0 if shared else 0.0) + (1.0 if party else 0.0)
            if not score:
                continue
            # why 는 화면에 그대로 찍히는 문구다 — 나머지 화면과 같이 영문으로 쓴다.
            why = ("subject shares " + " · ".join(sorted(shared)[:3])) if shared \
                else "the only deal with this counterpart at the time"
            if shared and party:
                why += " · same counterpart"
            scored.append((score, why, d["rfq_id"]))
        if not scored:
            continue
        scored.sort(key=lambda t: (-t[0], t[2]))
        best = scored[0]
        runner = scored[1][0] if len(scored) > 1 else 0.0
        # 1등이 2등과 같은 점수면 고르지 않는다 — 그건 추천이 아니라 동전 던지기다.
        if best[0] < 1.5 or best[0] <= runner:
            continue
        out[m.id] = {"rfq_id": best[2], "why": best[1], "label": names.get(best[2], "")}
    return out


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


def _window_uids(conn: imaplib.IMAP4_SSL, since_days: int) -> list[int]:
    """최근 since_days 일 안의 UID 전부(오름차순). 번호만 받아 오므로 가볍다."""
    since = (datetime.now(timezone.utc) - timedelta(days=since_days)).strftime("%d-%b-%Y")
    typ, data = conn.uid("SEARCH", None, "SINCE", since)
    if typ != "OK" or not data or not data[0]:
        return []
    return sorted(int(x) for x in data[0].split())


def _pick_uids(window: list[int], state: EmailSyncState, budget: int) -> tuple[list[int], list[int]]:
    """이번에 읽을 UID → (새 메일, 거슬러 읽을 옛 메일).

    읽은 구간을 [backfill_uid, last_uid] 로 기억하고 그 양끝을 넓혀 간다.
      · 첫 동기화는 창의 **최신** 쪽부터 집는다. 옛것부터 집으면 한도(max_per_sync)가
        몇 달 전 메일로 다 소진돼, 정작 지금 진행 중인 딜의 메일이 한 통도 안 들어온다.
      · 그 뒤로는 새 메일을 오래된 순서로 이어 붙여 읽는다(구간이 끊기지 않게).
      · 예산이 남으면 창 안의 못 읽은 옛 메일을 최신 쪽부터 거슬러 채운다.
    """
    if not window or budget <= 0:
        return [], []
    if not state.last_uid:
        return window[-budget:], []
    fresh = [u for u in window if u > state.last_uid][:budget]
    remaining = budget - len(fresh)
    older: list[int] = []
    floor = state.backfill_uid or 0
    if remaining > 0 and floor > window[0]:
        older = [u for u in window if u < floor][-remaining:]
    return fresh, older


def _note_unknown(found: dict[str, dict], addrs: list[str], msg: Message, sent_at: str) -> None:
    """저장하지 않은 메일의 상대 주소를 세어 둔다 — 주소·표시이름·제목 한 줄까지만."""
    for addr in addrs[:2]:      # 수신자가 여럿이면 앞의 둘만(참조까지 세면 잡음이 된다)
        hit = found.setdefault(addr, {"count": 0, "last_at": "", "name": "", "subject": ""})
        hit["count"] += 1
        if sent_at >= (hit["last_at"] or ""):
            hit["last_at"] = sent_at
            hit["name"] = (getaddresses([msg.get("From") or ""])[0][0] or "")[:120]
            hit["subject"] = _hdr(msg, "Subject")[:120]


def _store_message(s, msg: Message, folder: str, own: set[str],
                   parties: dict[str, tuple[str, int, str]], docs: dict[str, int],
                   unknown: dict[str, dict] | None = None,
                   vessels: dict[str, set[int]] | None = None,
                   linked: dict[str, int] | None = None) -> str:
    """메일 1통 저장. 반환: stored | skipped(관계없는 메일) | dup(이미 있음).

    unknown 을 넘기면 저장하지 않은 메일의 상대 주소를 거기에 세어 둔다 — 아직
    등록하지 않은 거래처를 나중에 화면에서 찾아낼 수 있게.
    linked 는 사람이 딜에 붙여 둔 주소({주소: rfq_id}) — 거래처로 등록하지 않았어도
    담고, 다른 근거가 없을 때 그 딜로 붙인다."""
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
    # 사람이 딜에 붙여 둔 주소면 거래처로 등록되지 않았어도 담는다.
    link_rfq = next((linked[a] for a in counterparts if a in (linked or {})), None)
    if not party and not known_thread and link_rfq is None:
        # 등록된 거래처와도, 담아 둔 스레드와도 무관한 메일. 버리되 상대는 세어 둔다 —
        # 받은 메일이면 보낸 사람이, 보낸 메일이면 받는 사람이 '아직 모르는 거래처'다.
        if unknown is not None:
            addrs = ([from_addr] if direction == "in" else to_addrs)
            _note_unknown(unknown, [a for a in addrs if a and a not in own],
                          msg, sent_at_kst(msg))
        return "skipped"

    subject = _hdr(msg, "Subject")
    body, attachments = body_and_attachments(msg)
    truncated = len(body) > MAX_BODY_CHARS
    rfq_id, match_by = match_project(s, parents, subject, body, docs, attachments, vessels)
    # 붙여 둔 딜은 마지막 수단이다 — 스레드·문서번호·선박이 다른 딜을 가리키면 그쪽이 옳다.
    if rfq_id is None and link_rfq is not None:
        rfq_id, match_by = link_rfq, "address"

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
    남긴다(다음 호출이 그다음부터 이어 읽는다).

    이미 동기화가 돌고 있으면 기다리지 않고 곧장 알린다 — 자동 실행이 도는 중에
    사람이 Sync 를 눌렀을 때, 말없이 멈춰 있는 것보다 이유를 듣는 편이 낫다."""
    global _SYNC_STARTED_AT
    if not _SYNC_LOCK.acquire(blocking=False):
        raise SyncBusy(_SYNC_STARTED_AT)
    _SYNC_STARTED_AT = datetime.now(KST).strftime("%Y-%m-%d %H:%M")
    try:
        return _sync_mailbox(s, folder_limit)
    finally:
        _SYNC_STARTED_AT = ""
        _SYNC_LOCK.release()


def _sync_mailbox(s, folder_limit: int | None = None) -> dict:
    cfg = mail_config()
    if not cfg["user"] or not cfg["password"]:
        raise RuntimeError("IMAP 계정이 설정되지 않았습니다 — IMAP_USER/IMAP_PASSWORD "
                           "(또는 SMTP_USER/SMTP_PASSWORD) 환경변수를 확인하세요.")
    own = own_addresses(s)
    parties = party_index(s)
    docs = doc_no_index(s)
    vessels = vessel_index(s)
    linked = address_link_map(s)
    budget = folder_limit or cfg["max_per_sync"]
    # scanned = 훑은 통수. stored 가 0 일 때 "메일함을 못 읽은 것"인지 "읽었지만 등록된
    # 거래처와 오간 게 없던 것"인지 화면이 구분해 말할 수 있어야 한다.
    result = {"scanned": 0, "stored": 0, "skipped": 0, "dup": 0, "pending": 0, "folders": {}}
    # 이번에 버린 메일의 상대 주소 — 폴더를 다 돌고 나서 한 번에 합친다.
    unknown: dict[str, dict] = {}

    conn = _connect(cfg)
    try:
        folders = _folders(conn, cfg)
        # 한도는 폴더마다 나눠 준다. 통째로 쓰게 두면 받은편지함이 다 먹어 보낸편지함은
        # 한 통도 못 읽는다 — 그러면 발신 이력이 통째로 비어 보인다.
        budget = max(1, budget // max(1, len(folders)))
        for folder in folders:
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
                    state.backfill_uid = 0
                state.uid_validity = validity or state.uid_validity

                window = _window_uids(conn, cfg["since_days"])
                fresh, older = _pick_uids(window, state, budget)
                uids = sorted(set(fresh) | set(older))
                counts = {"scanned": len(uids), "stored": 0, "skipped": 0, "dup": 0}
                for uid in uids:
                    typ, data = conn.uid("FETCH", str(uid), "(RFC822)")
                    if typ != "OK" or not data or not isinstance(data[0], tuple):
                        continue
                    outcome = _store_message(
                        s, email.message_from_bytes(data[0][1]), folder, own, parties, docs,
                        unknown, vessels, linked)
                    counts[outcome] += 1
                    result[outcome] += 1
                # 읽은 구간 [backfill_uid, last_uid] 를 이번에 집은 만큼 넓힌다.
                if uids:
                    state.last_uid = max(state.last_uid or 0, max(uids))
                    state.backfill_uid = (min(uids) if not state.backfill_uid
                                          else min(state.backfill_uid, min(uids)))
                # 창 안에 아직 안 읽은 옛 메일이 몇 통 남았는지 — Sync 를 더 눌러야 하는지 알린다.
                counts["pending"] = len([u for u in window if u < (state.backfill_uid or 0)])
                result["pending"] += counts["pending"]
                result["scanned"] += counts["scanned"]
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
    try:
        _merge_unknown(s, unknown)
        s.commit()
    except Exception:          # 집계는 부수적인 것 — 실패해도 동기화 결과는 살린다
        s.rollback()
    return result
