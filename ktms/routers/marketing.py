"""K-Maris TMS — marketing routes (split from admin_api.py; behavior unchanged)."""
from __future__ import annotations

import json
import re

from _core import (
    Customer,
    Depends,
    EmailTemplate,
    File,
    Form,
    HTTPException,
    List,
    MARKETING_REPLY_STATUSES,
    MarketingActivity,
    MarketingActivityCreate,
    MarketingAsset,
    Response,
    ScheduleEvent,
    ScheduleEventCreate,
    UploadFile,
    User,
    _kst_iso,
    _marketing_row,
    _marketing_scoped,
    _norm_reply_status,
    _resolve_email_template,
    email_template_names,
    _schedule_guard,
    _schedule_row,
    app,
    datetime,
    default_from,
    get_current_user,
    get_session,
    intro_email_body_tpl,
    intro_email_subject,
    intro_signature,
    os,
    render_marketing_tokens,
    require_token,
    send_email,
    sync_bounced_email,
    SIGNATURE_DOC_TYPE,
    signature_html_for,
    text_to_html_fragment,
    html_document,
    timedelta,
)
from fastapi import Body

from sqlalchemy import Text, and_, cast, func, or_

from db.models import EmailMessage
from services import mail_sync, marketing_reply



# 목록의 Follow-up 칸에 세우는 메일 이력 줄 수. 넘치면 옛 것부터 접고 "+N earlier".
_LOG_MAX = 3


def _mail_logs(s, acts: list) -> dict[int, dict]:
    """활동 id → 그 주소와 오간 메일의 날짜·방향(최근 몇 줄)과 전체 통수.

    편집창의 대화(marketing_thread)와 같은 것을 목록 크기로 줄인 값이다. 표에서
    알고 싶은 것은 문면이 아니라 **박자**다 — 언제 두드렸고, 언제 답이 왔고, 그
    뒤로 우리가 한 번 더 갔는가. 날짜와 화살표만으로 그게 보인다.

    한 줄씩 메일함에 물으면 205번 묻게 되므로 한 번에 가져와 주소로 나눈다. 가져오는
    칸은 날짜·방향·주소뿐이다(본문은 손대지 않는다) — 목록은 자주 열리는 화면이라
    통마다 본문을 끌어오면 그것만으로 전송량이 는다.

    반송 통지는 보낸 사람이 메일 서버라 주소로는 걸리지 않는다. 그래서 자동 감지가
    붙여 둔 그 한 통(reply_email_id)을 id 로 따로 집어넣는다 — 'Invalid' 로 찍힌
    줄에서 정작 보고 싶은 것이 그 되돌아온 날이다.
    """
    by_addr: dict[str, list[int]] = {}
    dates: dict[int, str] = {}
    detected: dict[int, int] = {}      # email_messages.id → 활동 id
    for a in acts:
        dates[a.id] = (a.activity_date or "")[:10]
        addr = (a.recipient_email or "").strip().lower()
        if addr:
            by_addr.setdefault(addr, []).append(a.id)
        mid = int(getattr(a, "reply_email_id", None) or 0)
        if mid:
            detected[mid] = a.id
    if not by_addr and not detected:
        return {}

    since = min((d or "9999") for d in dates.values())
    # 홍보 주소에서 온 것, 우리가 보낸 것, 그리고 감지가 붙여 둔 통. 이 셋 밖은
    # 이 표와 무관한 메일이라 아예 가져오지 않는다.
    want = [EmailMessage.direction == "out"]
    if by_addr:
        want.append(func.lower(EmailMessage.from_addr).in_(sorted(by_addr)))
    if detected:
        want.append(EmailMessage.id.in_(sorted(detected)))
    rows = (s.query(EmailMessage.id, EmailMessage.direction, EmailMessage.from_addr,
                    EmailMessage.to_addrs, EmailMessage.cc_addrs, EmailMessage.sent_at)
            .filter(EmailMessage.sent_at >= since)
            .filter(or_(*want))
            .all())

    hits: dict[int, list[dict]] = {}

    def put(act_id: int, mid: int, at: str, direction: str, bounce: bool) -> None:
        slot = hits.setdefault(act_id, [])
        if any(h["id"] == mid for h in slot):
            return
        # 그 발송보다 앞선 메일은 이 활동의 이력이 아니다(편집창의 대화와 같은 규칙).
        if at and dates.get(act_id) and at[:10] < dates[act_id]:
            return
        # 시각까지 들고 있다가 화면에 낼 때 날짜만 남긴다 — 하루에 몇 번씩 오가는
        # 대화가 흔해서(문의는 그날 안에 두세 번 왕복한다), 날짜로만 세우면 순서가
        # 뒤집힌다. 보낸 것 다음에 답이 온 것을 답 다음에 보낸 것으로 읽게 된다.
        slot.append({"id": mid, "t": at, "dir": direction,
                     **({"bounce": True} if bounce else {})})

    for mid, direction, frm, to_addrs, cc_addrs, sent_at in rows:
        at = sent_at or ""
        low = (frm or "").lower()
        bounce = marketing_reply.is_daemon(low)
        for act_id in by_addr.get(low, []):
            put(act_id, mid, at, direction or "in", bounce)
        if direction == "out":
            for a in {str(x).lower() for x in ((to_addrs or []) + (cc_addrs or [])) if x}:
                for act_id in by_addr.get(a, []):
                    put(act_id, mid, at, "out", False)
        if mid in detected:
            put(detected[mid], mid, at, direction or "in", bounce)

    out: dict[int, dict] = {}
    for act_id, log in hits.items():
        log.sort(key=lambda h: (h["t"], h["id"]))
        out[act_id] = {
            "log": [{"d": h["t"][:10], "dir": h["dir"],
                     **({"bounce": True} if h.get("bounce") else {})}
                    for h in log[-_LOG_MAX:]],
            "total": len(log),
        }
    return out


@app.get("/api/admin/marketing", dependencies=[Depends(require_token)])
def marketing_list(user: dict = Depends(get_current_user)):
    """잠정 고객사 마케팅 활동 목록."""
    s = get_session()
    try:
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        user_names = {u.id: u.username for u in s.query(User).all()}
        acts = _marketing_scoped(s, user).all()
        logs = _mail_logs(s, acts)
        rows = []
        for m in acts:
            row = _marketing_row(m, cust_names, user_names)
            hit = logs.get(m.id) or {}
            # 오간 메일의 박자 — 표의 Follow-up 칸이 후속예정일 아래에 세운다.
            row["mail_log"] = hit.get("log", [])
            row["mail_total"] = hit.get("total", 0)
            rows.append(row)
        return {"rows": rows}
    finally:
        s.close()


@app.post("/api/admin/marketing", dependencies=[Depends(require_token)])
def create_marketing(body: MarketingActivityCreate, user: dict = Depends(get_current_user)):
    if not (body.customer_id or (body.prospect_name or "").strip()):
        raise HTTPException(status_code=400, detail="대상 고객사(선택) 또는 잠정사 이름을 입력하세요.")
    s = get_session()
    try:
        m = MarketingActivity(
            customer_id=body.customer_id or None,
            prospect_name=(body.prospect_name or "").strip(),
            contact_person=body.contact_person or "",
            recipient_email=body.recipient_email or "",
            activity_date=body.activity_date or "",
            channel=body.channel or "",
            activity_type=body.activity_type or "",
            subject=body.subject or "",
            notes=body.notes or "",
            next_action_date=body.next_action_date or "",
            email_bounced=bool(body.email_bounced),
            reply_status=_norm_reply_status(body.reply_status),
            reply_date=(body.reply_date or "").strip(),
            reply_note=(body.reply_note or "").strip()[:200],
            reply_email_id=body.reply_email_id or None,
            reply_auto=False,      # 사람이 적은 값 — 자동 감지가 덮지 않는다
            # 담당자(PIC): 지정값 우선, 없으면 작성자 본인.
            owner_id=body.owner_id or user.get("id") or None,
        )
        # "더는 쓰지 않는 주소"라는 답장은 반송과 같은 사실을 말한다 — 그 주소로는
        # 다시 보내지 말라는 것. 명부에도 닿도록 반송 표시를 함께 세운다.
        if m.reply_status == "invalid":
            m.email_bounced = True
        s.add(m)
        s.flush()
        # 반송 표시는 고객 담당자 명부(customers.bad_emails)에도 옮겨 붙는다.
        sync_bounced_email(s, m.recipient_email)
        s.commit()
        return {"ok": True, "id": m.id}
    finally:
        s.close()


@app.put("/api/admin/marketing/{row_id:int}", dependencies=[Depends(require_token)])
def update_marketing(row_id: int, body: MarketingActivityCreate):
    if not (body.customer_id or (body.prospect_name or "").strip()):
        raise HTTPException(status_code=400, detail="대상 고객사(선택) 또는 잠정사 이름을 입력하세요.")
    s = get_session()
    try:
        m = s.query(MarketingActivity).filter_by(id=row_id).first()
        if not m:
            raise HTTPException(status_code=404, detail="마케팅 활동을 찾을 수 없습니다.")
        prev_email = m.recipient_email or ""
        m.customer_id = body.customer_id or None
        m.prospect_name = (body.prospect_name or "").strip()
        m.contact_person = body.contact_person or ""
        m.recipient_email = body.recipient_email or ""
        m.activity_date = body.activity_date or ""
        m.channel = body.channel or ""
        m.activity_type = body.activity_type or ""
        m.subject = body.subject or ""
        m.notes = body.notes or ""
        m.next_action_date = body.next_action_date or ""
        m.email_bounced = bool(body.email_bounced)
        m.reply_status = _norm_reply_status(body.reply_status)
        m.reply_date = (body.reply_date or "").strip()
        m.reply_note = (body.reply_note or "").strip()[:200]
        m.reply_email_id = body.reply_email_id or None
        # 사람이 한 번 저장하면 그 행의 분류는 사람 것이다 — 다음 자동 감지가
        # 제 판단으로 덮어쓰지 않는다(services/marketing_reply.py 참고).
        m.reply_auto = False
        if m.reply_status == "invalid":
            m.email_bounced = True   # 폐기된 주소 → 반송과 같이 명부까지 표시
        m.owner_id = body.owner_id or None   # 담당자(PIC) 재지정(미지정 허용)
        s.flush()
        # 주소를 바꿔 적었다면 옛 주소도 다시 셈한다 — 그 주소에 걸려 있던 반송 표시가
        # 이 활동 하나뿐이었다면 이제 풀려야 한다.
        for addr in {(prev_email or "").strip(), (m.recipient_email or "").strip()}:
            sync_bounced_email(s, addr)
        s.commit()
        return {"ok": True, "id": m.id}
    finally:
        s.close()


@app.delete("/api/admin/marketing/{row_id:int}", dependencies=[Depends(require_token)])
def delete_marketing(row_id: int):
    s = get_session()
    try:
        m = s.query(MarketingActivity).filter_by(id=row_id).first()
        if not m:
            raise HTTPException(status_code=404, detail="마케팅 활동을 찾을 수 없습니다.")
        addr = m.recipient_email or ""
        s.delete(m)
        s.flush()
        # 지운 활동이 그 주소의 유일한 반송 표시였다면 명부에서도 함께 풀린다.
        sync_bounced_email(s, addr)
        s.commit()
        return {"ok": True}
    finally:
        s.close()


@app.post("/api/admin/marketing/detect-replies", dependencies=[Depends(require_token)])
def marketing_detect_replies(mark_no_reply: bool = True, scan: bool = True):
    """홍보 메일의 답장을 찾아 활동에 붙인다 — 메일함까지 직접 뒤진다.

    두 단계다. ① scan: 메일함에서 홍보 주소의 답장과 반송 통지를 직접 찾아 담는다.
    정기 동기화는 이미 읽은 UID 구간을 다시 보지 않으므로, 홍보 주소를 저장 범위에
    넣기 전에 지나간 반송은 이 길로만 들어온다. ② 담긴 메일을 훑어 분류한다.

    메일함을 못 열어도 ②는 돈다 — 이미 담아 둔 것에서 찾는 일은 메일서버와 무관하다."""
    s = get_session()
    try:
        scanned = None
        if scan:
            try:
                scanned = mail_sync.scan_marketing_inbox(s)
            except Exception as exc:      # 계정 미설정·연결 실패 — 분류는 그대로 진행
                s.rollback()
                scanned = {"error": str(exc)[:200]}
        try:
            result = marketing_reply.detect_replies(s, mark_no_reply=mark_no_reply)
        except Exception as exc:
            s.rollback()
            raise HTTPException(status_code=400, detail=f"답장 감지 실패: {exc}") from exc
        return {"ok": True, **result, "scanned": scanned}
    finally:
        s.close()


# 한 통에서 실어 보내는 본문 길이. 대화 전체를 한 번에 내리므로 통당 상한을 둔다 —
# 답장은 대개 첫 몇 줄이 전부이고, 그 아래는 우리가 보낸 원문의 인용이다.
_THREAD_BODY = 2000
# 한 대화에서 보여 주는 최대 통수(넘치면 최근 것부터 남기고 몇 통을 접었는지 알린다).
_THREAD_MAX = 30


@app.get("/api/admin/marketing/{row_id:int}/thread", dependencies=[Depends(require_token)])
def marketing_thread(row_id: int):
    """그 수신 주소와 오간 메일 전부 — 홍보 발송일 그 뒤로, 양방향.

    활동 한 건이 들고 있는 reply_email_id 는 **첫 답장 한 통**이다. 자동 분류의 근거가
    그 한 통이면 충분해서 그렇게 두었는데, 화면에서 보고 싶은 것은 대개 그 다음이다 —
    우리가 뭐라고 답했고, 상대가 또 뭐라고 했는지. 그 왕복은 이미 메일함에 담겨 있다
    (보낸 메일도 담는다: _store_message 가 홍보 주소를 상대로 둔 통을 모두 들인다).
    여기서는 그것을 시간순으로 세워 줄 뿐, 활동에 새로 붙이지 않는다.

    고르는 규칙은 둘이다. ① 그 주소에서 온 것, ② 그 주소에게 보낸 것. 여기에 자동
    감지가 붙여 둔 그 한 통을 반드시 더한다 — 반송 통지는 보낸 사람이 메일 서버라
    주소로는 걸리지 않는데, 그게 바로 그 활동이 'Invalid' 로 찍힌 근거다.
    """
    s = get_session()
    try:
        m = s.query(MarketingActivity).filter_by(id=row_id).first()
        if not m:
            raise HTTPException(status_code=404, detail="마케팅 활동을 찾을 수 없습니다.")
        addr = (m.recipient_email or "").strip().lower()
        detected = int(getattr(m, "reply_email_id", None) or 0)
        out = {"address": addr, "since": (m.activity_date or "")[:10],
               "detected_id": detected, "counts": {"in": 0, "out": 0},
               "omitted": 0, "messages": []}
        if not addr and not detected:
            return out

        cols = (EmailMessage.id, EmailMessage.direction, EmailMessage.from_addr,
                EmailMessage.from_name, EmailMessage.to_addrs, EmailMessage.cc_addrs,
                EmailMessage.subject,
                # 본문은 앞부분만 — 통마다 전문을 실으면 대화 하나가 수십 KB가 된다.
                func.substr(EmailMessage.body_text, 1, _THREAD_BODY), EmailMessage.sent_at,
                EmailMessage.attachments, EmailMessage.truncated,
                func.length(EmailMessage.body_text))
        rows: list = []
        if addr:
            q = s.query(*cols)
            # 발송보다 앞선 메일은 이 대화의 일부가 아니다 — 그 전에 오간 것이 있다면
            # 그건 이 홍보 발송이 아니라 다른 일의 이력이다.
            if out["since"]:
                q = q.filter(EmailMessage.sent_at >= out["since"])
            like = f"%{addr}%"
            rows += q.filter(or_(
                func.lower(EmailMessage.from_addr) == addr,
                # 보낸 메일은 받는 사람 목록 안에 있다. JSON 칸이라 글자로 눕혀 거르고,
                # 주소가 정말 그 목록에 있는지는 아래에서 한 번 더 본다(부분일치 배제).
                and_(EmailMessage.direction == "out",
                     or_(cast(EmailMessage.to_addrs, Text).ilike(like),
                         cast(EmailMessage.cc_addrs, Text).ilike(like))),
            )).all()
        if detected and not any(r[0] == detected for r in rows):
            rows += s.query(*cols).filter(EmailMessage.id == detected).all()

        seen: set[int] = set()
        msgs = []
        for r in rows:
            (mid, direction, frm, frm_name, to_addrs, cc_addrs, subject,
             body, sent_at, attachments, truncated, body_len) = r
            if mid in seen:
                continue
            seen.add(mid)
            party = [str(a).lower() for a in ((to_addrs or []) + (cc_addrs or [])) if a]
            # 글자로 건져 온 것 중 정말 그 주소와 오간 통만 남긴다 — LIKE 는 주소의
            # 일부만 겹쳐도 걸린다(a@b.com 이 xa@b.com 에 든다). 자동 감지가 붙여 둔
            # 통만은 이 규칙 밖이라도 남긴다: 반송 통지는 보낸 사람이 메일 서버다.
            if mid != detected and addr and (frm or "").lower() != addr and addr not in party:
                continue
            msgs.append({
                "id": mid,
                "direction": direction or "in",
                "subject": subject or "",
                "from_addr": frm or "",
                "from_name": frm_name or "",
                "to": [str(a) for a in (to_addrs or [])][:10],
                "sent_at": sent_at or "",
                "body": body or "",
                "truncated": bool(truncated) or int(body_len or 0) > _THREAD_BODY,
                "attachments": [a.get("name", "") for a in (attachments or [])][:10],
                "detected": mid == detected,
            })
        msgs.sort(key=lambda x: (x["sent_at"], x["id"]))
        if len(msgs) > _THREAD_MAX:
            out["omitted"] = len(msgs) - _THREAD_MAX
            msgs = msgs[-_THREAD_MAX:]
        out["messages"] = msgs
        out["counts"] = {"in": sum(1 for x in msgs if x["direction"] != "out"),
                         "out": sum(1 for x in msgs if x["direction"] == "out")}
        return out
    finally:
        s.close()


@app.get("/api/admin/marketing-overview", dependencies=[Depends(require_token)])
def marketing_overview(user: dict = Depends(get_current_user)):
    """대시보드 마케팅 카드용 요약.
      - recent:      최근 활동 목록(최신순)
      - follow_ups:  후속 예정(next_action_date 있는 건, 예정일 오름차순)
      - month:       이번 달 활동 집계(총건수 + 채널별·유형별)
    """
    s = get_session()
    try:
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        user_names = {u.id: u.username for u in s.query(User).all()}
        items = _marketing_scoped(s, user).all()
        rows = [_marketing_row(m, cust_names, user_names) for m in items]

        today = (datetime.utcnow() + timedelta(hours=9)).strftime("%Y-%m-%d")
        month = today[:7]

        follow_ups = sorted(
            (r for r in rows if r["next_action_date"]),
            key=lambda r: r["next_action_date"],
        )
        this_month = [r for r in rows if (r["activity_date"] or "")[:7] == month]
        by_channel: dict[str, int] = {}
        by_type: dict[str, int] = {}
        for r in this_month:
            if r["channel"]:
                by_channel[r["channel"]] = by_channel.get(r["channel"], 0) + 1
            if r["activity_type"]:
                by_type[r["activity_type"]] = by_type.get(r["activity_type"], 0) + 1

        # 답장 집계는 보낸 달과 무관하게 전체 기준 — 지난달에 보낸 메일의 답장도
        # 이번 달에 들어오기 때문이다. unclassified = 아직 어느 쪽인지 적지 않은 건.
        by_reply = {k: 0 for k in MARKETING_REPLY_STATUSES}
        unclassified = 0
        needs_review = 0
        for r in rows:
            st = r.get("reply_status") or ""
            if st in by_reply:
                by_reply[st] += 1
            else:
                unclassified += 1
                # 답장은 왔는데 어느 쪽인지 기계가 못 가른 건 — 사람이 봐야 하는 줄.
                if r.get("reply_email_id"):
                    needs_review += 1

        return {
            "recent": rows[:20],
            "follow_ups": follow_ups[:20],
            "month": {
                "period": month,
                "total": len(this_month),
                "by_channel": by_channel,
                "by_type": by_type,
            },
            "replies": {"by_status": by_reply, "unclassified": unclassified,
                        "needs_review": needs_review},
        }
    finally:
        s.close()


# ── 홍보 이메일 첨부 자료 라이브러리(회사소개서·브로슈어) ─────────────────────────
@app.get("/api/admin/marketing-assets", dependencies=[Depends(require_token)])
def marketing_assets_list():
    """첨부 자료 목록(바이너리 제외). 홍보 메일 작성 시 라이브러리에서 선택."""
    s = get_session()
    try:
        rows = s.query(MarketingAsset).order_by(MarketingAsset.id.desc()).all()
        return {"rows": [
            {
                "id": a.id,
                "label": a.label or a.filename or "",
                "filename": a.filename or "",
                "mime": a.mime or "",
                "size": a.size or 0,
                "created_at": _kst_iso(a.created_at),
            }
            for a in rows
        ]}
    finally:
        s.close()


@app.post("/api/admin/marketing-assets", dependencies=[Depends(require_token)])
def marketing_asset_upload(
    file: UploadFile = File(...),
    label: str = Form(""),
    user: dict = Depends(get_current_user),
):
    """첨부 자료 업로드 — DB BLOB 저장(Render 파일시스템 휘발 회피)."""
    s = get_session()
    try:
        file.file.seek(0)
        data = file.file.read()
        if not data:
            raise HTTPException(status_code=400, detail="빈 파일입니다.")
        asset = MarketingAsset(
            label=(label or "").strip() or (file.filename or "자료"),
            filename=file.filename or "asset",
            mime=file.content_type or "application/octet-stream",
            size=len(data),
            data=data,
            owner_id=user.get("id") or None,
        )
        s.add(asset)
        s.commit()
        return {"ok": True, "id": asset.id}
    finally:
        s.close()


@app.patch("/api/admin/marketing-assets/{asset_id}", dependencies=[Depends(require_token)])
def marketing_asset_rename(asset_id: int, label: str = Body(..., embed=True)):
    """첨부 자료 표시 이름(label) 변경. 파일 자체(filename/데이터)는 그대로."""
    name = (label or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="이름을 입력하세요.")
    s = get_session()
    try:
        a = s.query(MarketingAsset).filter_by(id=asset_id).first()
        if not a:
            raise HTTPException(status_code=404, detail="자료를 찾을 수 없습니다.")
        a.label = name
        s.commit()
        return {"ok": True, "id": a.id, "label": a.label}
    finally:
        s.close()


@app.get("/api/admin/marketing-assets/{asset_id}/file", dependencies=[Depends(require_token)])
def marketing_asset_download(asset_id: int):
    s = get_session()
    try:
        a = s.query(MarketingAsset).filter_by(id=asset_id).first()
        if not a or not a.data:
            raise HTTPException(status_code=404, detail="자료를 찾을 수 없습니다.")
        return Response(
            content=a.data,
            media_type=a.mime or "application/octet-stream",
            headers={"Content-Disposition": f'attachment; filename="{a.filename or "asset"}"'},
        )
    finally:
        s.close()


@app.delete("/api/admin/marketing-assets/{asset_id}", dependencies=[Depends(require_token)])
def marketing_asset_delete(asset_id: int):
    s = get_session()
    try:
        n = s.query(MarketingAsset).filter_by(id=asset_id).delete()
        s.commit()
        return {"ok": True, "deleted": n}
    finally:
        s.close()


# ── 홍보 이메일 작성 기본값 + 발송 ────────────────────────────────────────────────
def _marketing_doc_type(kind: str) -> str:
    return f"marketing_{kind if kind in ('intro', 'brochure') else 'intro'}"


@app.get("/api/admin/marketing/compose-defaults", dependencies=[Depends(require_token)])
def marketing_compose_defaults(
    kind: str = "intro", lang: str = "en", name: str = "",
    user: dict = Depends(get_current_user),
):
    """작성 화면 기본값 — 저장된 사용자/회사 템플릿이 있으면 그 제목·본문을 우선 사용하고,
    없으면 코드 내장 기본값을 쓴다. 수신자 이름은 {{contact}} 토큰으로 남긴 '원본'을
    그대로 내려주고, 실제 이름 치환은 작성 화면(과 발송 직전)에서 한다."""
    lang_n = "kr" if lang in ("ko", "kr") else "en"
    lang_db = "ko" if lang_n == "kr" else "en"
    s = get_session()
    try:
        doc_type = _marketing_doc_type(kind)
        tpl = _resolve_email_template(s, user.get("id"), doc_type, lang_db, name)
        # 이 사람이 저장해 둔 판 이름들 — 작성 화면이 고르는 칸을 그린다.
        versions = email_template_names(s, user.get("id"), doc_type, lang_db)
        saved_subject = tpl.subject_tpl if (tpl and tpl.subject_tpl) else ""
        saved_body = tpl.body_tpl if (tpl and tpl.body_tpl) else ""
        # 서명은 다른 발송 화면(견적·PO·RFQ)과 같은 것을 쓴다 — Settings 에 저장한
        # 담당자 서명이 있으면 그것, 없을 때만 홍보 메일 기본 서명.
        sig_row = _resolve_email_template(s, user.get("id"), SIGNATURE_DOC_TYPE, lang_db)
        saved_sig = (sig_row.body_tpl or "").strip() if sig_row else ""
    finally:
        s.close()
    return {
        "from": default_from(),
        "subject": saved_subject or intro_email_subject(kind, lang_n),
        "body": saved_body or intro_email_body_tpl(kind, lang_n),
        "signature": saved_sig or intro_signature(lang_n),
        # 저장된 사용자 템플릿이 있으면 True — 프론트에서 'Reset to default' 노출용.
        "saved": bool(tpl and tpl.user_id and (tpl.subject_tpl or tpl.body_tpl)),
        # 지금 불러온 판과 고를 수 있는 판 목록(기본 판은 빈 이름이라 목록에 없다).
        "name": (tpl.name or "") if tpl else "",
        "versions": versions,
        "smtp_configured": bool(os.getenv("SMTP_USER") and os.getenv("SMTP_PASSWORD")),
    }


@app.put("/api/admin/marketing/compose-template", dependencies=[Depends(require_token)])
def save_marketing_template(
    kind: str = Body("intro", embed=True),
    lang: str = Body("en", embed=True),
    subject: str = Body("", embed=True),
    body: str = Body("", embed=True),
    name: str = Body("", embed=True),
    user: dict = Depends(get_current_user),
):
    """홍보 메일 제목·본문을 사용자 템플릿으로 저장(종류 intro/brochure × 언어 en/ko).

    name 을 주면 그 이름의 판으로 저장한다(빈 이름 = 기본 판). 같은 종류라도 상대에
    따라 할 말이 달라 여러 판을 두고 골라 쓴다.
    """
    lang_db = "ko" if lang in ("ko", "kr") else "en"
    doc_type = _marketing_doc_type(kind)
    uid = user.get("id")
    s = get_session()
    try:
        nm = (name or "").strip()[:60]
        t = (s.query(EmailTemplate)
             .filter_by(user_id=uid, doc_type=doc_type, lang=lang_db, name=nm).first())
        if not t:
            t = EmailTemplate(user_id=uid, doc_type=doc_type, lang=lang_db, name=nm)
            s.add(t)
        t.subject_tpl = subject or ""
        t.body_tpl = body or ""
        t.updated_at = datetime.utcnow()
        s.commit()
        return {"ok": True, "kind": kind, "lang": lang_db, "name": nm}
    finally:
        s.close()


@app.delete("/api/admin/marketing/compose-template", dependencies=[Depends(require_token)])
def reset_marketing_template(
    kind: str = "intro", lang: str = "en", name: str = "",
    user: dict = Depends(get_current_user),
):
    """저장한 홍보 메일 템플릿 삭제 → 코드 내장 기본값으로 복귀."""
    lang_db = "ko" if lang in ("ko", "kr") else "en"
    s = get_session()
    try:
        t = (s.query(EmailTemplate)
             .filter_by(user_id=user.get("id"), doc_type=_marketing_doc_type(kind),
                        lang=lang_db, name=(name or "").strip()).first())
        if t:
            s.delete(t)
            s.commit()
        return {"ok": True}
    finally:
        s.close()


# 한 번에 보낼 수 있는 수신자 수. 같은 메일을 인사말만 바꿔 한 통씩 보내므로
# SMTP 계정의 시간당 한도에 걸리지 않을 만큼만 허용한다.
MAX_BULK_RECIPIENTS = 50


def _parse_recipients(raw: str) -> list[dict]:
    """작성 화면이 보내는 수신자 목록(JSON) → 정규화. 같은 주소는 한 번만 남긴다."""
    try:
        data = json.loads(raw or "[]")
    except ValueError:
        raise HTTPException(status_code=400, detail="Could not read the recipient list.")
    if not isinstance(data, list):
        raise HTTPException(status_code=400, detail="The recipient list format is invalid.")
    out: list[dict] = []
    seen: set[str] = set()
    for r in data:
        if not isinstance(r, dict):
            continue
        email = (r.get("email") or "").strip()
        if not email or email.lower() in seen:
            continue
        seen.add(email.lower())
        cid = str(r.get("customer_id") or "").strip()
        out.append({
            "email": email,
            "customer_id": int(cid) if cid.isdigit() else None,
            "prospect_name": (r.get("prospect_name") or "").strip(),
            "contact_person": (r.get("contact_person") or "").strip(),
        })
    return out


@app.post("/api/admin/marketing/send", dependencies=[Depends(require_token)])
def marketing_email_send(
    to: str = Form(""),
    subject: str = Form(""),
    body: str = Form(""),
    signature: str = Form(""),
    include_signature: bool = Form(True),
    cc: str = Form(""),
    from_email: str = Form(""),
    customer_id: str = Form(""),
    prospect_name: str = Form(""),
    contact_person: str = Form(""),
    # 여러 고객에게 한 번에 — [{email, customer_id, prospect_name, contact_person}, …].
    # 비어 있으면 아래 단건 필드(to/customer_id/…)를 수신자 한 명으로 본다.
    recipients: str = Form(""),
    lang: str = Form("en"),
    asset_ids: str = Form(""),      # 라이브러리 첨부 id들(쉼표 구분)
    files: List[UploadFile] = File(default=[]),   # 즉석 업로드 첨부
    user: dict = Depends(get_current_user),
):
    """홍보 이메일 발송 — 라이브러리 자료 + 즉석 업로드 첨부.

    수신자가 여러 명이면 한 통에 몰아 넣지 않고 각자에게 따로 보낸다 — 인사말의
    {{contact}}·{{customer}} 를 그 사람 이름으로 치환해야 하고, 서로의 주소가
    수신함에 노출되어서도 안 되기 때문이다. 발송 성공한 수신자마다
    MarketingActivity 로그를 남긴다(한 명이 실패해도 나머지는 그대로 발송)."""
    recips = _parse_recipients(recipients)
    if not recips:
        to = (to or "").strip()
        if not to:
            raise HTTPException(status_code=400, detail="Enter a recipient email.")
        cid = (customer_id or "").strip()
        recips = [{
            "email": to,
            "customer_id": int(cid) if cid.isdigit() else None,
            "prospect_name": (prospect_name or "").strip(),
            "contact_person": (contact_person or "").strip(),
        }]
    if len(recips) > MAX_BULK_RECIPIENTS:
        raise HTTPException(
            status_code=400,
            detail=f"Up to {MAX_BULK_RECIPIENTS} recipients per send (got {len(recips)}).",
        )

    s = get_session()
    try:
        # 첨부 조립: 라이브러리 자료 → 즉석 업로드 순. 수신자마다 다시 읽지 않도록
        # 한 번만 만들어 두고 모든 메일에 같은 바이트를 붙인다.
        attachments: list[tuple[str, bytes]] = []
        wanted_ids = [int(x) for x in (asset_ids or "").split(",") if x.strip().isdigit()]
        if wanted_ids:
            for a in s.query(MarketingAsset).filter(MarketingAsset.id.in_(wanted_ids)).all():
                if a.data:
                    attachments.append((a.filename or f"asset-{a.id}", a.data))
        for f in files or []:
            f.file.seek(0)
            data = f.file.read()
            if data:
                attachments.append((f.filename or "attachment", data))

        # 표 서명 HTML 은 수신자와 무관하므로 한 번만 만든다(서명을 손댔으면 None).
        sig_html = (signature_html_for(s, user.get("id"), signature)
                    if include_signature and (signature or "").strip() else None)

        today = (datetime.utcnow() + timedelta(hours=9)).strftime("%Y-%m-%d")
        cc_addrs = (cc or "").strip()
        from_addr = (from_email or "").strip()
        note = "홍보 이메일 발송" + (f" (첨부 {len(attachments)}건)" if attachments else "")
        first_id = None
        sent_emails: list[str] = []
        failed: list[str] = []

        for r in recips:
            # 템플릿 토큰 치환 — 작성 화면이 이미 치환해 보내지만, 저장된 템플릿을 그대로
            # 실어 보내는 경로가 생겨도 {{contact}} 가 고객에게 나가지 않도록 여기서 한 번 더.
            cust_name = r["prospect_name"]
            if r["customer_id"]:
                c = s.query(Customer).filter_by(id=r["customer_id"]).first()
                if c:
                    cust_name = c.name or cust_name
            subj_r = render_marketing_tokens(subject, r["contact_person"], cust_name, lang)
            body_r = render_marketing_tokens(body, r["contact_person"], cust_name, lang)

            # 최종 본문 = 본문 + (서명 포함 시 서명). HTML 파트는 저장된 표 서명을 그대로
            # 쓰는 경우에만 따로 조립하고, 서명을 손댔으면 평문 그대로 렌더되게 둔다.
            final_body = body_r or ""
            if include_signature and (signature or "").strip():
                final_body = f"{final_body.rstrip()}\n\n{signature.strip()}\n"
            final_html = (
                html_document(text_to_html_fragment(body_r or "") + sig_html) if sig_html else None
            )

            ok = send_email(
                to=r["email"],
                subject=subj_r or "",
                body=final_body,
                html_body=final_html,
                attachments=attachments,
                cc=cc_addrs,
                from_addr=from_addr,
            )
            if not ok:
                failed.append(r["email"])
                continue

            # 발송 성공 → 마케팅 활동 로그 자동 생성(표에 즉시 반영)
            activity = MarketingActivity(
                customer_id=r["customer_id"],
                prospect_name=r["prospect_name"],
                contact_person=r["contact_person"],
                recipient_email=r["email"],
                activity_date=today,
                channel="Email",
                activity_type="Intro email",
                subject=subj_r or "",
                notes=note,
                owner_id=user.get("id") or None,
            )
            s.add(activity)
            s.flush()
            first_id = first_id or activity.id
            sent_emails.append(r["email"])

        s.commit()
        if not sent_emails:
            raise HTTPException(
                status_code=400,
                detail="Email sending failed - check the SMTP settings or the server status.",
            )
        return {
            "ok": True,
            "id": first_id,
            "sent_date": today,
            "sent": sent_emails,
            "failed": failed,
        }
    finally:
        s.close()


# ── CC 주소록(자주 쓰는 참조 주소) ──────────────────────────────────────────────
# 참조로 늘 넣는 주소(내부 영업 계정·대표 메일 등)를 미리 등록해 두고 작성 화면에서
# 클릭으로 고른다. 팀이 함께 쓰는 한 벌이라 회사 공용 행(user_id=NULL)에 담는다 —
# 목록 하나 때문에 테이블을 새로 만들 이유가 없어 EmailTemplate.options 를 재사용한다.
CC_PRESET_DOC_TYPE = "cc_presets"
_CC_EMAIL_RE = re.compile(r"^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$")
_CC_PRESET_MAX = 50


def _cc_preset_rows(s) -> list[dict]:
    t = (s.query(EmailTemplate)
         .filter_by(user_id=None, doc_type=CC_PRESET_DOC_TYPE, lang="en").first())
    out: list[dict] = []
    for r in ((t.options or {}).get("rows") if t else None) or []:
        if not isinstance(r, dict):
            continue
        email = (r.get("email") or "").strip()
        if email:
            out.append({"email": email, "label": (r.get("label") or "").strip()})
    return out


@app.get("/api/admin/marketing/cc-presets", dependencies=[Depends(require_token)])
def marketing_cc_presets():
    s = get_session()
    try:
        return {"rows": _cc_preset_rows(s)}
    finally:
        s.close()


@app.put("/api/admin/marketing/cc-presets", dependencies=[Depends(require_token)])
def save_marketing_cc_presets(rows: List[dict] = Body(default=[], embed=True)):
    """CC 주소록 저장 — 목록 전체를 통째로 교체한다(추가·삭제 모두 이 경로)."""
    clean: list[dict] = []
    seen: set[str] = set()
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        email = (r.get("email") or "").strip()
        if not email or email.lower() in seen:
            continue
        if not _CC_EMAIL_RE.match(email):
            raise HTTPException(status_code=400, detail=f"Not a valid email address: {email}")
        seen.add(email.lower())
        clean.append({"email": email, "label": (r.get("label") or "").strip()[:60]})
    if len(clean) > _CC_PRESET_MAX:
        raise HTTPException(status_code=400, detail=f"You can register at most {_CC_PRESET_MAX} CC addresses.")
    s = get_session()
    try:
        t = (s.query(EmailTemplate)
             .filter_by(user_id=None, doc_type=CC_PRESET_DOC_TYPE, lang="en").first())
        if not t:
            t = EmailTemplate(user_id=None, doc_type=CC_PRESET_DOC_TYPE, lang="en")
            s.add(t)
        # JSON 컬럼은 새 dict 로 갈아 끼워야 변경이 감지된다(제자리 수정 금지).
        t.options = {**(t.options or {}), "rows": clean}
        t.updated_at = datetime.utcnow()
        s.commit()
        return {"ok": True, "rows": clean}
    finally:
        s.close()


@app.get("/api/admin/schedule", dependencies=[Depends(require_token)])
def schedule_list():
    """일정 목록 — 팀 공용(전체), 날짜 오름차순."""
    s = get_session()
    try:
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        user_names = {u.id: u.username for u in s.query(User).all()}
        events = s.query(ScheduleEvent).order_by(ScheduleEvent.date, ScheduleEvent.id).all()
        return {"rows": [_schedule_row(e, cust_names, user_names) for e in events]}
    finally:
        s.close()


@app.post("/api/admin/schedule", dependencies=[Depends(require_token)])
def create_schedule(body: ScheduleEventCreate, user: dict = Depends(get_current_user)):
    if not (body.title or "").strip():
        raise HTTPException(status_code=400, detail="일정 제목을 입력하세요.")
    if not (body.date or "").strip():
        raise HTTPException(status_code=400, detail="일정 날짜를 입력하세요.")
    s = get_session()
    try:
        e = ScheduleEvent(
            date=body.date or "",
            title=(body.title or "").strip(),
            event_type=body.event_type or "",
            notes=body.notes or "",
            customer_id=body.customer_id or None,
            owner_id=user.get("id") or None,
        )
        s.add(e)
        s.commit()
        return {"ok": True, "id": e.id}
    finally:
        s.close()


@app.put("/api/admin/schedule/{row_id}", dependencies=[Depends(require_token)])
def update_schedule(row_id: int, body: ScheduleEventCreate, user: dict = Depends(get_current_user)):
    if not (body.title or "").strip():
        raise HTTPException(status_code=400, detail="일정 제목을 입력하세요.")
    s = get_session()
    try:
        e = s.query(ScheduleEvent).filter_by(id=row_id).first()
        if not e:
            raise HTTPException(status_code=404, detail="일정을 찾을 수 없습니다.")
        _schedule_guard(e, user)
        e.date = body.date or ""
        e.title = (body.title or "").strip()
        e.event_type = body.event_type or ""
        e.notes = body.notes or ""
        e.customer_id = body.customer_id or None
        s.commit()
        return {"ok": True, "id": e.id}
    finally:
        s.close()


@app.delete("/api/admin/schedule/{row_id}", dependencies=[Depends(require_token)])
def delete_schedule(row_id: int, user: dict = Depends(get_current_user)):
    s = get_session()
    try:
        e = s.query(ScheduleEvent).filter_by(id=row_id).first()
        if not e:
            raise HTTPException(status_code=404, detail="일정을 찾을 수 없습니다.")
        _schedule_guard(e, user)
        s.delete(e)
        s.commit()
        return {"ok": True}
    finally:
        s.close()
