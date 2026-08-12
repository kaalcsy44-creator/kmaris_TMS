"""K-Maris TMS — mail routes: 프로젝트별 메일 이력(수신·발신)과 요약.

메일은 services/mail_sync.py 가 회사 메일함(IMAP)에서 가져와 EmailMessage 로 담고,
여기서는 그것을 딜 단위로 묶어 보여주고(스레드), 못 붙은 메일을 사람이 배정하고,
Claude 요약을 채운다.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from pydantic import BaseModel
from sqlalchemy import func

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
from services.mail_summary import ensure_summaries, summarize_project
from services import mail_sync

# 프로젝트 롤업 요약 캐시 키 — 마지막 메일이 그대로면 다시 만들지 않는다.
_ROLLUP_KEY = "mail_rollup"
# 한 번의 동기화 뒤 자동으로 요약할 메일 수 상한(프로젝트에 붙은 것 우선).
_AUTO_SUMMARY_LIMIT = 30
# 요약 카드에 실을 최근 메일 줄 수 / 한 번에 내보낼 카드 상한.
_DIGEST_RECENT = 3
_DIGEST_MAX_CARDS = 60
# 마지막 메일이 '수신'인 채로 이만큼 지나면 "우리 차례"로 보고 카드를 위로 올린다.
WAITING_DAYS = 2


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
    """메일 연동 상태 — 설정 여부, 폴더별 마지막 동기화, 미분류 통수."""
    s = get_session()
    try:
        return {
            "configured": mail_sync.is_configured(),
            "host": mail_sync.mail_config()["host"],
            "account": mail_sync.mail_config()["user"],
            "total": s.query(EmailMessage.id).count(),
            "unmatched": s.query(EmailMessage.id).filter(EmailMessage.rfq_id.is_(None)).count(),
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


@app.post("/api/admin/mail/sync", dependencies=[Depends(require_token)])
def mail_sync_now(summarize: bool = True):
    """지금 메일함을 읽어 새 메일을 담는다. 새로 담은 메일 중 프로젝트에 붙은 것부터
    요약을 채운다(상한까지 — 나머지는 화면에서 열 때 채워진다)."""
    s = get_session()
    try:
        try:
            result = mail_sync.sync_mailbox(s)
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


def _build_rollup(s, rfq_id: int) -> str:
    """이 딜의 메일 흐름을 3~5줄로 만들어 저장하고 그 글을 돌려준다.

    재료는 통별 요약이라 AI 호출은 1회다(요약이 아직 없는 메일은 먼저 채운다).
    딜 화면의 "AI digest" 버튼과 대시보드의 일괄 생성이 같은 이 함수를 쓴다 —
    캐시 모양(last_id 로 낡음을 가리는 것)이 두 곳에서 어긋나면 안 된다."""
    msgs = (s.query(EmailMessage).filter_by(rfq_id=rfq_id)
            .order_by(EmailMessage.sent_at).all())
    if not msgs:
        return ""
    ensure_summaries(s, msgs, limit=_AUTO_SUMMARY_LIMIT)
    rfq = s.query(RFQ).filter_by(id=rfq_id).first()
    title = " · ".join(x for x in [_project_no_map(s).get(rfq_id, ""),
                                   (rfq.project_title if rfq else "")] if x)
    text = summarize_project(
        [{"sent_at": m.sent_at, "direction": m.direction,
          "party": _party_name(s, m), "summary": m.summary} for m in msgs],
        title or f"RFQ {rfq_id}")
    key = f"{_ROLLUP_KEY}:{rfq_id}"
    row = s.query(AppSetting).filter_by(key=key).first()
    value = {"text": text, "last_id": max(m.id for m in msgs),
             "at": datetime.utcnow().isoformat(timespec="seconds")}
    if row:
        row.value, row.updated_at = value, datetime.utcnow()
    else:
        s.add(AppSetting(key=key, value=value, updated_at=datetime.utcnow()))
    s.commit()
    return text


@app.post("/api/admin/mail/project/{rfq_id}/rollup", dependencies=[Depends(require_token)])
def project_mail_rollup(rfq_id: int):
    """이 딜의 메일 흐름을 3~5줄로 — 개별 요약을 재료로 한 번만 만들고 캐시한다."""
    s = get_session()
    try:
        return {"ok": True, "rollup": _build_rollup(s, rfq_id)}
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


def _cutoff(window: int) -> str:
    """조회 창의 시작 시각 — sent_at 과 같은 'YYYY-MM-DDTHH:MM'(KST) 꼴이라 문자열로 견준다."""
    return (datetime.now(mail_sync.KST) - timedelta(days=window)).strftime("%Y-%m-%dT%H:%M")


def _live_deals(s, window: int) -> dict[int, tuple[int, str, int]]:
    """카드가 될 딜 → (전체 통수, 마지막 메일 시각, 마지막 메일 id).

    집계만 받아 온다 — 행을 끌어오면 딜 수십 개의 본문이 통째로 따라온다.
    최근 window 일 안에 메일이 오갔고 종결되지 않은 딜만 남긴다(끝난 딜의 메일을
    아침마다 다시 읽을 이유가 없다)."""
    cutoff = _cutoff(window)
    totals = (s.query(EmailMessage.rfq_id,
                      func.count(EmailMessage.id),
                      func.max(EmailMessage.sent_at),
                      func.max(EmailMessage.id))
              .filter(EmailMessage.rfq_id.isnot(None))
              .group_by(EmailMessage.rfq_id).all())
    closed = {r.id for r in s.query(RFQ.id, RFQ.closed_at).all() if (r.closed_at or "").strip()}
    return {rid: (cnt, last_at or "", last_id)
            for rid, cnt, last_at, last_id in totals
            if rid not in closed and (last_at or "") >= cutoff}


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
    최근 메일 요약으로 대신한다(생성은 /digest/refresh 가 따로 맡는다)."""
    s = get_session()
    try:
        window = max(1, min(days, 365))
        live = _live_deals(s, window)
        unmatched = s.query(EmailMessage.id).filter(EmailMessage.rfq_id.is_(None)).count()
        if not live:
            return {"days": window, "waiting_after": WAITING_DAYS,
                    "rows": [], "unmatched": unmatched}

        # 카드에 쓰는 열만 — body_text 는 건드리지 않는다.
        rows = (s.query(EmailMessage.id, EmailMessage.rfq_id, EmailMessage.sent_at,
                        EmailMessage.direction, EmailMessage.subject, EmailMessage.summary,
                        EmailMessage.from_addr, EmailMessage.to_addrs,
                        EmailMessage.customer_id, EmailMessage.vendor_id)
                .filter(EmailMessage.rfq_id.in_(list(live)),
                        EmailMessage.sent_at >= _cutoff(window))
                .order_by(EmailMessage.sent_at).all())
        groups: dict[int, list] = {}
        for m in rows:
            groups.setdefault(m.rfq_id, []).append(m)

        names = _party_names(s)
        cache = _rollup_cache(s, live)
        out = []
        for rid, msgs in groups.items():
            count, _, last_id = live[rid]
            last = msgs[-1]
            # 상대는 최근에 등장한 순서로 — 카드 머리에 두어 곳만 보여 준다.
            parties: list[str] = []
            for m in reversed(msgs):
                p = _party_name(s, m, names)
                if p and p not in parties:
                    parties.append(p)
            cached = cache.get(rid) or {}
            fresh = cached.get("last_id") == last_id
            out.append({
                "rfq_id": rid,
                "count": count,
                "recent_count": len(msgs),
                "parties": parties[:4],
                "last_at": last.sent_at or "",
                "last_dir": last.direction or "in",
                "waiting_days": _waiting_days(last.sent_at or "", last.direction or ""),
                # 낡은 롤업은 아예 내보내지 않는다 — 지난주 상황을 오늘 일로 읽는 게
                # 제일 나쁘다. 대신 낡았다는 사실(rollup_stale)만 알린다.
                "rollup": cached.get("text", "") if fresh else "",
                "rollup_stale": bool(cached.get("text")) and not fresh,
                "recent": [{
                    "sent_at": m.sent_at or "",
                    "direction": m.direction or "in",
                    "party": _party_name(s, m, names),
                    "summary": (m.summary or "").strip() or (m.subject or ""),
                } for m in reversed(msgs[-_DIGEST_RECENT:])],
            })

        # 정렬은 두 덩이다. 파이썬 정렬이 안정적이라 뒤 정렬이 앞 정렬을 보존한다.
        out.sort(key=lambda r: r["last_at"], reverse=True)          # ② 최근에 움직인 순
        out.sort(key=lambda r: (0 if r["waiting_days"] >= WAITING_DAYS else 1,
                                -r["waiting_days"]))                # ① 우리가 오래 쥔 것부터
        return {"days": window, "waiting_after": WAITING_DAYS,
                "rows": out[:_DIGEST_MAX_CARDS], "unmatched": unmatched}
    finally:
        s.close()


@app.post("/api/admin/mail/digest/refresh", dependencies=[Depends(require_token)])
def mail_digest_refresh(days: int = 14, limit: int = 10):
    """요약이 없거나 낡은 카드의 AI 롤업을 채운다(한 번에 limit 건까지).

    화면을 여는 길목에서 딜 수만큼 AI 를 부를 수는 없어서 생성을 이 버튼으로 떼어
    놓았다. 최근에 움직인 딜부터 채우고 남은 건수를 돌려준다 — 다시 누르면 이어서
    채운다(딜 하나당 AI 호출 1회)."""
    s = get_session()
    try:
        window = max(1, min(days, 365))
        live = _live_deals(s, window)
        cache = _rollup_cache(s, live)
        todo = [rid for rid, (_, _, last_id) in live.items()
                if (cache.get(rid) or {}).get("last_id") != last_id]
        todo.sort(key=lambda rid: live[rid][1], reverse=True)
        picked = todo[:max(1, min(limit, 30))]
        for rid in picked:
            _build_rollup(s, rid)
        return {"ok": True, "written": len(picked), "remaining": len(todo) - len(picked)}
    finally:
        s.close()


def _group_key(m: EmailMessage) -> str:
    """미분류 목록에서 한 대화로 묶는 열쇠 — 제목(답장 표시를 걷어낸 것)이 우선이다.
    회신 헤더가 끊긴 메일이 많아 thread_key 로만 묶으면 같은 대화가 열 줄로 흩어진다."""
    return mail_sync.subject_key(m.subject or "") or (m.thread_key or f"id:{m.id}")


@app.get("/api/admin/mail/unmatched", dependencies=[Depends(require_token)])
def unmatched_mail(limit: int = 200):
    """어느 딜에도 붙지 못한 메일 — 대화 단위로 묶어 돌려준다.

    한 통씩 늘어놓으면 수백 줄이 되지만, 실제로 사람이 판단할 단위는 '대화'다.
    묶어 두면 한 번 고르는 것으로 그 대화 전체가 같은 딜로 간다. 근거가 없어 자동
    배정을 못 한 대화에는 추천 딜(suggest)을 달아 주되, 붙이지는 않는다."""
    s = get_session()
    try:
        msgs = (s.query(EmailMessage).filter(EmailMessage.rfq_id.is_(None))
                .order_by(EmailMessage.sent_at.desc()).limit(max(1, min(limit, 500))).all())
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
        return {"count": len(msgs), "groups": out}
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
                "unmatched": s.query(EmailMessage.id).filter(EmailMessage.rfq_id.is_(None)).count()}
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
