"""K-Maris TMS — mail routes: 프로젝트별 메일 이력(수신·발신)과 요약.

메일은 services/mail_sync.py 가 회사 메일함(IMAP)에서 가져와 EmailMessage 로 담고,
여기서는 그것을 딜 단위로 묶어 보여주고(스레드), 못 붙은 메일을 사람이 배정하고,
Claude 요약을 채운다.
"""
from __future__ import annotations

import sys
from datetime import datetime

from pydantic import BaseModel

from db.models import AppSetting
from _core import (
    Customer,
    Depends,
    EmailMessage,
    EmailSyncState,
    HTTPException,
    RFQ,
    Vendor,
    _project_no_map,
    app,
    cached_aggregate,
    get_current_user,
    get_session,
    require_token,
)
from services.mail_summary import ROLLUP_KEY as _ROLLUP_KEY, build_project_rollup, ensure_summaries
from services import mail_auto, mail_sync

# 한 번의 동기화 뒤 자동으로 요약할 메일 수 상한(프로젝트에 붙은 것 우선).
_AUTO_SUMMARY_LIMIT = 30
# 카드에 실을 최근 메일 줄 수 / 한 번에 내보낼 카드 상한.
# 화면이 이 메일들을 단계 이벤트와 한 시간축에 섞은 뒤 사용자가 고른 줄 수(Show 1~8)
# 만큼 자른다 — 그래서 서버는 가장 많이 볼 만큼을 넉넉히 실어 보낸다.
_DIGEST_RECENT = 8
_DIGEST_MAX_CARDS = 80
# 카드에 실을 메일을 찾을 때 거슬러 올라가는 한계. 조회 기간(days)과 달리 이건
# "얼마나 옛 대화까지 카드에 실을까"이지 "어느 딜을 보여줄까"가 아니다. IMAP 이 애초에
# 120일까지만 읽어 오므로 이보다 옛 메일은 거의 없고, 스캔 행 수에 상한이 생긴다.
_HISTORY_DAYS = 180
# 마지막 메일이 '수신'인 채로 이만큼 지나면 "우리 차례"로 보고 카드를 위로 올린다.
WAITING_DAYS = 2


def _unmatched(q):
    """'아직 딜을 못 정한 메일' 조건 — 딜이 없고, 딜이 있을 수 없다고 표시하지도 않은 것.

    회사 소개·인사·자동회신처럼 애초에 딜이 없는 메일까지 미분류 함에 섞이면, 처리할
    수 없는 줄만 남아 함 자체를 아무도 안 보게 된다. not_deal 은 그 줄을 내리는 표시다."""
    return q.filter(EmailMessage.rfq_id.is_(None),
                    (EmailMessage.not_deal.is_(None)) | (EmailMessage.not_deal.is_(False)))


def _unmatched_count(s) -> int:
    return _unmatched(s.query(EmailMessage.id)).count()


def _party_name(s, m: EmailMessage, names: dict | None = None) -> str:
    """메일 상대 회사명 — 등록된 고객·벤더면 그 이름, 아니면 주소.
    수백 통을 한 번에 내보낼 때는 names(미리 읽어 둔 이름표)를 넘겨 통마다 DB 를
    두드리지 않게 한다."""
    if m.customer_id:
        if names is not None:
            return names["customer"].get(m.customer_id, "") or m.from_addr or ""
        c = s.query(Customer.name).filter_by(id=m.customer_id).first()
        if c:
            return c[0]
    if m.vendor_id:
        if names is not None:
            return names["vendor"].get(m.vendor_id, "") or m.from_addr or ""
        v = s.query(Vendor.name).filter_by(id=m.vendor_id).first()
        if v:
            return v[0]
    return m.from_addr if m.direction == "in" else ", ".join(m.to_addrs or [])


def _party_names(s) -> dict:
    """{kind: {id: name}} — 목록 화면에서 상대 이름을 한 번에 붙이기 위한 이름표."""
    return {
        "customer": {c.id: c.name for c in s.query(Customer.id, Customer.name).all()},
        "vendor": {v.id: v.name for v in s.query(Vendor.id, Vendor.name).all()},
    }


# 목록에 실어 보내는 본문 미리보기 길이. 미분류 목록은 수백 통이라 본문을 통째로
# 보내면 응답이 메가바이트 단위가 된다 — 화면은 두어 줄만 보여 준다.
_PREVIEW_CHARS = 300


def _msg_out(s, m: EmailMessage, names: dict | None = None, brief: bool = False) -> dict:
    if brief:
        return {
            "id": m.id,
            "direction": m.direction or "in",
            "sent_at": m.sent_at or "",
            "subject": m.subject or "",
            "from_addr": m.from_addr or "",
            "from_name": m.from_name or "",
            "to_addrs": m.to_addrs or [],
            "cc_addrs": [],
            "party": _party_name(s, m, names),
            "party_kind": "customer" if m.customer_id else ("vendor" if m.vendor_id else ""),
            "summary": m.summary or "",
            "body_text": (m.body_text or "")[:_PREVIEW_CHARS],
            "truncated": bool(m.truncated),
            "attachments": m.attachments or [],
            "match_by": m.match_by or "",
            "thread_key": m.thread_key or "",
            "rfq_id": m.rfq_id,
        }
    return {
        "id": m.id,
        "direction": m.direction or "in",
        "sent_at": m.sent_at or "",
        "subject": m.subject or "",
        "from_addr": m.from_addr or "",
        "from_name": m.from_name or "",
        "to_addrs": m.to_addrs or [],
        "cc_addrs": m.cc_addrs or [],
        "party": _party_name(s, m),
        "party_kind": "customer" if m.customer_id else ("vendor" if m.vendor_id else ""),
        "summary": m.summary or "",
        "body_text": m.body_text or "",
        "truncated": bool(m.truncated),
        "attachments": m.attachments or [],
        "match_by": m.match_by or "",
        "thread_key": m.thread_key or "",
        "rfq_id": m.rfq_id,
    }


def _threads(s, msgs: list[EmailMessage]) -> list[dict]:
    """메일을 스레드로 묶어 최신 대화가 위에 오게 정렬한다."""
    groups: dict[str, list[EmailMessage]] = {}
    for m in msgs:
        groups.setdefault(m.thread_key or f"id:{m.id}", []).append(m)
    out = []
    for key, items in groups.items():
        items.sort(key=lambda x: (x.sent_at or "", x.id))
        last = items[-1]
        out.append({
            "thread_key": key,
            "subject": next((i.subject for i in items if i.subject), ""),
            "party": _party_name(s, last),
            "party_kind": "customer" if last.customer_id else ("vendor" if last.vendor_id else ""),
            "first_at": items[0].sent_at or "",
            "last_at": last.sent_at or "",
            "count": len(items),
            "messages": [_msg_out(s, i) for i in items],
        })
    out.sort(key=lambda t: t["last_at"], reverse=True)
    return out


@app.get("/api/admin/mail/status", dependencies=[Depends(require_token)])
def mail_status():
    """메일 연동 상태 — 설정 여부, 자동 실행 예정·결과, 폴더별 마지막 동기화, 미분류 통수."""
    s = get_session()
    try:
        cfg = mail_auto.config()
        last = mail_auto.state(s)
        return {
            "configured": mail_sync.is_configured(),
            "host": mail_sync.mail_config()["host"],
            "account": mail_sync.mail_config()["user"],
            "total": s.query(EmailMessage.id).count(),
            "unmatched": _unmatched_count(s),
            # 등록되지 않은 상대가 몇 곳인지 — 대시보드가 회사 메일의 얼마를 담고
            # 있는지 가늠하는 유일한 단서다.
            "unknown": len(mail_sync.unknown_addresses(s)),
            "auto": {
                "enabled": cfg["enabled"],
                "at": cfg["at"],
                "next_run": mail_auto.next_run_at(s),
                "last_run_at": last.get("last_run_at", ""),
                "last_result": last.get("result", {}),
                # 지금 돌고 있으면 시작 시각. 아침 자동 실행은 몇 분씩 걸리는데 그동안
                # "아직 안 돌았음"으로 보이면, 사람은 버튼을 눌러 거절만 당한다.
                "running_since": mail_sync.is_syncing(),
            },
            "folders": [
                {"folder": st.folder,
                 "last_uid": st.last_uid or 0,
                 "last_synced_at": st.last_synced_at.isoformat(timespec="seconds") if st.last_synced_at else "",
                 "last_error": st.last_error or ""}
                for st in s.query(EmailSyncState).all()
            ],
        }
    finally:
        s.close()


@app.get("/api/admin/mail/unknown-addresses", dependencies=[Depends(require_token)])
def mail_unknown_addresses():
    """메일은 오갔지만 Settings 에 등록되지 않은 상대 — 많이 온 순.

    저장 범위를 등록된 거래처로 좁힌 대가로 이 주소들의 메일은 통째로 버려진다.
    여기서 진짜 거래처를 골라 고객·벤더로 등록하면 다음 동기화부터 들어온다."""
    s = get_session()
    try:
        return {"rows": mail_sync.unknown_addresses(s)}
    finally:
        s.close()


class MailIgnoreAddr(BaseModel):
    addr: str


@app.post("/api/admin/mail/unknown-addresses/ignore", dependencies=[Depends(require_token)])
def mail_ignore_unknown(body: MailIgnoreAddr):
    """이 주소는 거래처가 아니다 — 목록에서 내리고 다음 동기화에서도 세지 않는다.
    (거르지 않으면 뉴스레터·알림이 목록을 채워 정작 볼 것을 덮는다.)"""
    s = get_session()
    try:
        mail_sync.ignore_unknown_address(s, body.addr)
        return {"ok": True, "rows": mail_sync.unknown_addresses(s)}
    finally:
        s.close()


@app.post("/api/admin/mail/sync", dependencies=[Depends(require_token)])
def mail_sync_now(summarize: bool = True):
    """지금 메일함을 읽어 새 메일을 담는다. 새로 담은 메일 중 프로젝트에 붙은 것부터
    요약을 채운다(상한까지 — 나머지는 화면에서 열 때 채워진다)."""
    s = get_session()
    try:
        try:
            result = mail_sync.sync_mailbox(s)
        except mail_sync.SyncBusy as busy:
            # 실패가 아니라 '지금은 아니다' — 아침 자동 실행이 도는 중일 때가 대부분이다.
            # 409 로 갈라 두면 화면이 이것만 다르게(오류 빨간 줄이 아니라 안내로) 다룬다.
            raise HTTPException(
                status_code=409,
                detail=f"A sync is already running{f' (since {busy.started_at})' if busy.started_at else ''}"
                       " — it will finish on its own.") from busy
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"메일 동기화 실패: {exc}") from exc
        # 방금 담은 메일이 옛 메일의 근거가 되기도 한다(끊긴 스레드의 뒷부분이 먼저
        # 들어오는 일이 흔하다) — 담은 뒤 한 번 돌려 붙일 수 있는 것을 붙인다.
        result["auto_matched"] = mail_sync.auto_match(s)["total"]
        if summarize and result.get("stored"):
            fresh = (s.query(EmailMessage)
                     .filter(EmailMessage.summary.is_(None), EmailMessage.rfq_id.isnot(None))
                     .order_by(EmailMessage.id.desc()).limit(_AUTO_SUMMARY_LIMIT).all())
            result["summarized"] = ensure_summaries(s, fresh, limit=_AUTO_SUMMARY_LIMIT)
        return {"ok": True, **result}
    finally:
        s.close()


@app.get("/api/admin/mail/project/{rfq_id}", dependencies=[Depends(require_token)])
def project_mail(rfq_id: int, summarize: bool = False):
    """이 딜에서 오간 메일 — 스레드별로 묶어 최신순.

    요약은 기본적으로 만들지 않는다 — 화면을 여는 길목에서 AI 호출 수십 번을 기다리게
    할 수는 없다. 새 메일 요약은 동기화 때 채워지고, 그때 놓친 것(나중에 손으로 배정한
    메일 등)은 summarize=1 로 이 화면에서 채운다."""
    s = get_session()
    try:
        msgs = (s.query(EmailMessage).filter_by(rfq_id=rfq_id)
                .order_by(EmailMessage.sent_at).all())
        if summarize and msgs:
            ensure_summaries(s, msgs, limit=_AUTO_SUMMARY_LIMIT)
        rollup = (s.query(AppSetting).filter_by(key=f"{_ROLLUP_KEY}:{rfq_id}").first())
        last_id = max((m.id for m in msgs), default=0)
        cached = (rollup.value or {}) if rollup else {}
        return {
            "rfq_id": rfq_id,
            "count": len(msgs),
            "threads": _threads(s, msgs),
            # 롤업은 마지막 메일 id 가 같을 때만 유효 — 새 메일이 오면 다시 만들어야 한다.
            "rollup": cached.get("text", "") if cached.get("last_id") == last_id else "",
            "rollup_stale": bool(cached.get("text")) and cached.get("last_id") != last_id,
        }
    finally:
        s.close()


@app.post("/api/admin/mail/project/{rfq_id}/rollup", dependencies=[Depends(require_token)])
def project_mail_rollup(rfq_id: int):
    """이 딜의 메일 흐름을 3~5줄로 — 개별 요약을 재료로 한 번만 만들고 캐시한다."""
    s = get_session()
    try:
        title = _project_no_map(s).get(rfq_id, "")
        return {"ok": True, "rollup": build_project_rollup(s, rfq_id, title)}
    finally:
        s.close()


# ── 프로젝트별 요약 카드(대시보드 Mail 탭) ────────────────────────────────────

def _waiting_days(last_at: str, direction: str) -> int:
    """마지막 메일이 '수신'인 채로 며칠이 지났는지 — 우리가 공을 쥐고 있는 날수.
    우리가 마지막으로 보냈으면 0이다(공은 상대에게 있다)."""
    if direction != "in" or not last_at:
        return 0
    try:
        day = datetime.strptime(last_at[:10], "%Y-%m-%d").date()
    except ValueError:
        return 0
    return max(0, (datetime.now(mail_sync.KST).date() - day).days)


def _rollup_cache(s, rfq_ids) -> dict[int, dict]:
    """딜별 저장된 롤업 — 카드 수만큼 조회하지 않고 한 번에 읽는다."""
    ids = list(rfq_ids)
    if not ids:
        return {}
    keys = {f"{_ROLLUP_KEY}:{rid}": rid for rid in ids}
    rows = s.query(AppSetting.key, AppSetting.value).filter(AppSetting.key.in_(list(keys))).all()
    return {keys[r.key]: (r.value or {}) for r in rows if r.key in keys}


@app.get("/api/admin/mail/digest", dependencies=[Depends(require_token)])
@cached_aggregate()
def mail_digest(days: int = 14):
    """프로젝트별 메일 요약 카드 — 대시보드 Mail 탭이 한 번에 읽는 집계.

    카드마다 /mail/project/{id} 를 부르면 요청이 딜 수만큼 늘고, 그 응답에는 본문
    원문이 통째로 들어 있다. 여기서는 본문을 아예 읽지 않고(요약 열만) 한 번에 묶어
    돌려준다. 프로젝트 이름·단계·담당자는 넣지 않는다 — 화면이 이미 갖고 있는
    파이프라인 목록과 rfq_id 로 맞추면 되고, 같은 계산을 두 번 할 이유가 없다.

    AI 는 부르지 않는다. 롤업은 이미 만들어 둔 것만 실어 보내고, 없는 카드는
    최근 메일 요약으로 대신한다(생성은 /digest/refresh 가 따로 맡는다).

    days 는 **어느 딜이 '최근에 움직였나'를 세는 자**일 뿐, 메일 이력을 자르는 칼이
    아니다(recent_count 로 알려 준다). 마지막 메일이 3주 전이어도 이번 주에 단계가
    움직인 딜은 화면에 오르고, 그 카드에는 그 딜의 마지막 메일들이 그대로 실려야 한다."""
    s = get_session()
    try:
        window = max(1, min(days, 365))
        # 기간과 무관하게 '메일이 있는 열린 딜' 전부를 후보로 두고, 마지막 메일이
        # 최신인 순으로 상한까지만 싣는다.
        live = mail_sync.live_deals(s, None)
        unmatched = _unmatched_count(s)
        if not live:
            return {"days": window, "waiting_after": WAITING_DAYS,
                    "rows": [], "unmatched": unmatched}
        picked = sorted(live, key=lambda rid: live[rid][1], reverse=True)[:_DIGEST_MAX_CARDS]

        # 카드에 쓰는 열만 — body_text 는 건드리지 않는다. 조회 기간(days)이 아니라
        # 훨씬 넓은 _HISTORY_DAYS 로 읽는다: 기간은 어느 딜을 보여줄지 정할 뿐이고,
        # 카드에 실릴 대화는 그 딜의 마지막 것이어야 하기 때문이다.
        rows = (s.query(EmailMessage.id, EmailMessage.rfq_id, EmailMessage.sent_at,
                        EmailMessage.direction, EmailMessage.subject, EmailMessage.summary,
                        EmailMessage.from_addr, EmailMessage.to_addrs,
                        EmailMessage.customer_id, EmailMessage.vendor_id)
                .filter(EmailMessage.rfq_id.in_(picked),
                        EmailMessage.sent_at >= mail_sync.cutoff_at(_HISTORY_DAYS))
                .order_by(EmailMessage.sent_at).all())
        groups: dict[int, list] = {}
        for m in rows:
            groups.setdefault(m.rfq_id, []).append(m)

        names = _party_names(s)
        cache = _rollup_cache(s, picked)
        cutoff = mail_sync.cutoff_at(window)
        out = []
        # groups 가 아니라 picked 를 돈다. 고른 딜인데 _HISTORY_DAYS 안에 메일이 한 통도
        # 없으면 groups 에는 자리가 없는데, 그때 행을 빼 버리면 화면은 그것을 "메일이
        # 없는 딜"로 읽는다 — P-007 을 잃었던 것과 똑같은 실수다. 통수와 마지막 시각은
        # 집계에서 이미 알고 있으니, 줄만 비운 채로 내보낸다.
        for rid in picked:
            msgs = groups.get(rid, [])
            count, last_at, last_id = live[rid]
            last = msgs[-1] if msgs else None
            tail = msgs[-_DIGEST_RECENT:]
            # 상대는 최근에 등장한 순서로 — 카드 머리에 두어 곳만 보여 준다.
            parties: list[str] = []
            for m in reversed(tail):
                p = _party_name(s, m, names)
                if p and p not in parties:
                    parties.append(p)
            cached = cache.get(rid) or {}
            fresh = cached.get("last_id") == last_id
            # 요약을 만든 뒤 들어온 메일 수. 낡은 요약을 감추는 대신 이 숫자를 달아
            # 함께 보여 준다 — 아래에 그 새 메일들이 줄로 붙으므로, "지난 요약 + 그
            # 뒤로 온 것"을 나란히 읽는 편이 아무것도 없는 것보다 훨씬 빠르다.
            new_since = (len([m for m in msgs if m.id > (cached.get("last_id") or 0)])
                         if cached.get("text") and not fresh else 0)
            out.append({
                "rfq_id": rid,
                "count": count,
                # 조회 기간 안에 오간 통수. 0 이면 "이 딜은 요즘 조용하다"는 뜻이고,
                # 화면은 그래도 아래 recent 로 마지막 대화를 보여 준다.
                "recent_count": len([m for m in msgs if (m.sent_at or "") >= cutoff]),
                "parties": parties[:4],
                "last_at": last_at,
                "last_dir": (last.direction or "in") if last else "",
                "waiting_days": _waiting_days(last.sent_at or "", last.direction or "") if last else 0,
                "rollup": cached.get("text", ""),
                "rollup_stale": bool(cached.get("text")) and not fresh,
                "new_since": new_since,
                "recent": [{
                    "sent_at": m.sent_at or "",
                    "direction": m.direction or "in",
                    "party": _party_name(s, m, names),
                    "summary": (m.summary or "").strip() or (m.subject or ""),
                } for m in reversed(tail)],
            })

        # 정렬은 두 덩이다. 파이썬 정렬이 안정적이라 뒤 정렬이 앞 정렬을 보존한다.
        out.sort(key=lambda r: r["last_at"], reverse=True)          # ② 최근에 움직인 순
        out.sort(key=lambda r: (0 if r["waiting_days"] >= WAITING_DAYS else 1,
                                -r["waiting_days"]))                # ① 우리가 오래 쥔 것부터
        return {
            "days": window,
            "waiting_after": WAITING_DAYS,
            "rows": out,
            "unmatched": unmatched,
            # 메일이 한 통이라도 있는 열린 딜 전부 → 통수. 상한(_DIGEST_MAX_CARDS)에
            # 걸려 rows 에 못 실린 딜을 화면이 "메일 없는 딜"로 오해하지 않게 하는
            # 안전줄이다. 딜당 정수 하나라 상한을 아무리 늘려도 응답이 무거워지지 않는다.
            "has_mail": {str(rid): live[rid][0] for rid in live},
        }
    finally:
        s.close()


class MailDigestRefresh(BaseModel):
    # 화면이 "이 카드들의 요약이 비었다"고 짚어 준 딜. 비우면 서버가 최근 순으로 고른다.
    rfq_ids: list[int] = []
    limit: int = 10


@app.post("/api/admin/mail/digest/refresh", dependencies=[Depends(require_token)])
def mail_digest_refresh(body: MailDigestRefresh | None = None, days: int = 14, limit: int = 10):
    """요약이 없거나 낡은 카드의 AI 롤업을 채운다(한 번에 limit 건까지).

    화면을 여는 길목에서 딜 수만큼 AI 를 부를 수는 없어서 생성을 이 버튼으로 떼어
    놓았다. 최근에 움직인 딜부터 채우고 남은 건수를 돌려준다 — 다시 누르면 이어서
    채운다(딜 하나당 AI 호출 1회).

    대상은 화면에 오르는 딜과 같아야 한다 — 기간으로 좁히면, 메일은 3주 전이 마지막
    이지만 단계는 이번 주에 움직인 딜이 카드로는 보이면서 요약만 영영 비어 있게 된다.
    그래서 화면이 rfq_ids 로 "지금 보이는데 요약이 빈 카드"를 직접 짚어 준다. 카드가
    될 자격에는 메일뿐 아니라 단계 이벤트도 걸리는데, 그건 화면만 아는 사실이다."""
    s = get_session()
    try:
        window = max(1, min(days, 365))
        live = mail_sync.live_deals(s, None)
        cache = _rollup_cache(s, live)
        asked = [rid for rid in (body.rfq_ids if body else []) if rid in live]
        pool = asked or list(live)
        todo = [rid for rid in pool
                if (cache.get(rid) or {}).get("last_id") != live[rid][2]]
        todo.sort(key=lambda rid: live[rid][1], reverse=True)
        if body and body.limit:
            limit = body.limit
        picked = todo[:max(1, min(limit, 30))]
        # 번호(P-024)는 RFQ 전수 조회라 한 번만 세어 딜마다 나눠 쓴다.
        nos = _project_no_map(s) if picked else {}
        for rid in picked:
            build_project_rollup(s, rid, nos.get(rid, ""))
        return {"ok": True, "written": len(picked), "remaining": len(todo) - len(picked)}
    finally:
        s.close()


def _group_key(m: EmailMessage) -> str:
    """미분류 목록에서 한 대화로 묶는 열쇠 — 제목(답장 표시를 걷어낸 것)이 우선이다.
    회신 헤더가 끊긴 메일이 많아 thread_key 로만 묶으면 같은 대화가 열 줄로 흩어진다."""
    return mail_sync.subject_key(m.subject or "") or (m.thread_key or f"id:{m.id}")


@app.get("/api/admin/mail/unmatched", dependencies=[Depends(require_token)])
def unmatched_mail(limit: int = 200, filed: int = 0):
    """어느 딜에도 붙지 못한 메일 — 대화 단위로 묶어 돌려준다.

    한 통씩 늘어놓으면 수백 줄이 되지만, 실제로 사람이 판단할 단위는 '대화'다.
    묶어 두면 한 번 고르는 것으로 그 대화 전체가 같은 딜로 간다. 근거가 없어 자동
    배정을 못 한 대화에는 추천 딜(suggest)을 달아 주되, 붙이지는 않는다.

    filed=1 이면 '딜 아님'으로 내려 둔 대화를 대신 보여 준다 — 되돌릴 수 있어야
    사람이 마음 놓고 내릴 수 있다."""
    s = get_session()
    try:
        base = s.query(EmailMessage)
        base = (base.filter(EmailMessage.rfq_id.is_(None), EmailMessage.not_deal.is_(True))
                if filed else _unmatched(base))
        msgs = (base.order_by(EmailMessage.sent_at.desc())
                .limit(max(1, min(limit, 500))).all())
        names = _party_names(s)
        hints = mail_sync.suggest_projects(s, msgs)
        groups: dict[str, list[EmailMessage]] = {}
        for m in msgs:
            groups.setdefault(_group_key(m), []).append(m)

        out = []
        for key, items in groups.items():
            items.sort(key=lambda x: (x.sent_at or "", x.id))
            last = items[-1]
            # 대화 안에서 가장 많이 지목된 딜을 그 대화의 추천으로 삼는다(동수면 최신 메일 것).
            votes: dict[int, int] = {}
            for i in items:
                hit = hints.get(i.id)
                if hit:
                    votes[hit["rfq_id"]] = votes.get(hit["rfq_id"], 0) + 1
            suggest = None
            if votes:
                best = max(votes, key=lambda r: (votes[r], r == (hints.get(last.id) or {}).get("rfq_id")))
                why = next(h["why"] for h in (hints[i.id] for i in items if i.id in hints)
                           if h["rfq_id"] == best)
                suggest = {"rfq_id": best, "why": why}
            parties, seen = [], set()
            for i in reversed(items):
                p = _party_name(s, i, names)
                if p and p not in seen:
                    seen.add(p)
                    parties.append(p)
            out.append({
                "key": key,
                "subject": mail_sync.normalize_subject(last.subject or "") or "(제목 없음)",
                "parties": parties[:3],
                "party_kind": "customer" if last.customer_id else ("vendor" if last.vendor_id else ""),
                "first_at": items[0].sent_at or "",
                "last_at": last.sent_at or "",
                "count": len(items),
                "ids": [i.id for i in items],
                "messages": [_msg_out(s, i, names, brief=True) for i in items],
                "suggest": suggest,
            })
        out.sort(key=lambda g: g["last_at"], reverse=True)
        filed_count = (s.query(EmailMessage.id)
                       .filter(EmailMessage.rfq_id.is_(None),
                               EmailMessage.not_deal.is_(True)).count())
        return {"count": len(msgs), "groups": out, "filed": filed_count}
    finally:
        s.close()


class MailNotDeal(BaseModel):
    ids: list[int] = []         # 화면이 묶어 보낸 대화 전체
    whole_thread: bool = True   # 같은 스레드의 메일도 함께
    value: bool = True          # False = 되돌리기(다시 미분류로)


@app.put("/api/admin/mail/not-deal", dependencies=[Depends(require_token)])
def mark_not_deal(body: MailNotDeal):
    """이 대화는 어느 딜에도 속하지 않는다 — 미분류 함에서 내린다.

    회사 소개·인사·자동회신처럼 딜이 있을 수 없는 메일이 미분류 함에 쌓이면, 아무리
    눌러도 줄어들지 않는 목록이 되어 함 자체가 방치된다. 지우지는 않는다 — 거래처와
    오간 기록이고, value=False 로 언제든 되돌릴 수 있다."""
    s = get_session()
    try:
        picked = set(body.ids or [])
        if not picked:
            raise HTTPException(status_code=400, detail="대상 메일이 없습니다.")
        targets = {t.id: t for t in s.query(EmailMessage).filter(EmailMessage.id.in_(picked)).all()}
        if body.whole_thread:
            keys = {t.thread_key for t in targets.values() if t.thread_key}
            if keys:
                for t in s.query(EmailMessage).filter(EmailMessage.thread_key.in_(keys)).all():
                    targets[t.id] = t
        for t in targets.values():
            # 이미 딜에 붙은 메일은 건드리지 않는다 — 그건 딜의 이력이다.
            if t.rfq_id is None:
                t.not_deal = bool(body.value)
        s.commit()
        return {"ok": True, "updated": len(targets), "unmatched": _unmatched_count(s)}
    finally:
        s.close()


@app.post("/api/admin/mail/auto-match", dependencies=[Depends(require_token)])
def auto_match_mail():
    """미분류 메일을 근거가 분명한 것만 자동으로 딜에 붙인다(스레드·문서번호·같은 제목).
    사람이 한 통을 배정하면 그 근거가 퍼져 나가므로, 배정 뒤에 다시 눌러도 좋다."""
    s = get_session()
    try:
        counts = mail_sync.auto_match(s)
        return {"ok": True, **counts,
                "unmatched": _unmatched_count(s)}
    finally:
        s.close()


class MailAssign(BaseModel):
    rfq_id: int | None = None   # None = 연결 해제(미분류로 되돌리기)
    whole_thread: bool = True   # 같은 스레드의 메일을 함께 옮긴다
    ids: list[int] = []         # 함께 옮길 메일(미분류 화면에서 묶어 보낸 대화 전체)


@app.put("/api/admin/mail/{msg_id}/assign", dependencies=[Depends(require_token)])
def assign_mail(msg_id: int, body: MailAssign, user: dict = Depends(get_current_user)):
    """메일을 딜에 붙이거나 뗀다. 기본은 같은 스레드 전체 — 한 대화는 한 딜의 것이다.

    붙인 뒤에는 자동 배정을 한 번 돌린다. 방금 붙인 메일이 근거가 되어 같은 대화·같은
    제목의 다른 메일이 따라 들어오므로, 사람이 같은 판단을 여러 번 반복하지 않는다."""
    s = get_session()
    try:
        m = s.query(EmailMessage).filter_by(id=msg_id).first()
        if not m:
            raise HTTPException(status_code=404, detail="메일을 찾을 수 없습니다.")
        if body.rfq_id and not s.query(RFQ.id).filter_by(id=body.rfq_id).first():
            raise HTTPException(status_code=404, detail="프로젝트를 찾을 수 없습니다.")
        picked = {m.id, *(body.ids or [])}
        targets = {t.id: t for t in s.query(EmailMessage).filter(EmailMessage.id.in_(picked)).all()}
        if body.whole_thread:
            keys = {t.thread_key for t in targets.values() if t.thread_key}
            if keys:
                for t in s.query(EmailMessage).filter(EmailMessage.thread_key.in_(keys)).all():
                    targets[t.id] = t
        for t in targets.values():
            t.rfq_id = body.rfq_id
            t.match_by = "manual" if body.rfq_id else ""
        s.commit()
        spread = mail_sync.auto_match(s)["total"] if body.rfq_id else 0
        return {"ok": True, "updated": len(targets), "spread": spread}
    finally:
        s.close()


@app.post("/api/admin/mail/{msg_id}/summarize", dependencies=[Depends(require_token)])
def summarize_one(msg_id: int, force: bool = False):
    """메일 1통 요약 — 이미 있으면 그대로 돌려주고, force 면 다시 만든다."""
    s = get_session()
    try:
        m = s.query(EmailMessage).filter_by(id=msg_id).first()
        if not m:
            raise HTTPException(status_code=404, detail="메일을 찾을 수 없습니다.")
        if force:
            m.summary = None
        ensure_summaries(s, [m], limit=1)
        return {"ok": True, "summary": m.summary or ""}
    finally:
        s.close()


@app.on_event("startup")
def _start_mail_auto_sync() -> None:
    """매일 도는 메일 정리를 띄운다(services/mail_auto.py).

    _core 의 스키마 동기화 startup 뒤에 등록되므로 표는 이미 만들어져 있다.
    스레드를 못 띄워도 앱은 떠야 한다 — 수동 Sync 버튼은 그대로 동작한다."""
    try:
        mail_auto.start()
    except Exception as exc:
        print(f"[WARN] mail auto-sync not started: {exc}", file=sys.stderr)
