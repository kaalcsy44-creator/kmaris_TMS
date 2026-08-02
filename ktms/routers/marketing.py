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
    _resolve_email_template,
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
    SIGNATURE_DOC_TYPE,
    signature_html_for,
    text_to_html_fragment,
    html_document,
    timedelta,
)
from fastapi import Body



@app.get("/api/admin/marketing", dependencies=[Depends(require_token)])
def marketing_list(user: dict = Depends(get_current_user)):
    """잠정 고객사 마케팅 활동 목록."""
    s = get_session()
    try:
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        user_names = {u.id: u.username for u in s.query(User).all()}
        rows = [_marketing_row(m, cust_names, user_names)
                for m in _marketing_scoped(s, user).all()]
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
            # 담당자(PIC): 지정값 우선, 없으면 작성자 본인.
            owner_id=body.owner_id or user.get("id") or None,
        )
        s.add(m)
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
        m.owner_id = body.owner_id or None   # 담당자(PIC) 재지정(미지정 허용)
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
        s.delete(m)
        s.commit()
        return {"ok": True}
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

        return {
            "recent": rows[:20],
            "follow_ups": follow_ups[:20],
            "month": {
                "period": month,
                "total": len(this_month),
                "by_channel": by_channel,
                "by_type": by_type,
            },
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
    kind: str = "intro", lang: str = "en",
    user: dict = Depends(get_current_user),
):
    """작성 화면 기본값 — 저장된 사용자/회사 템플릿이 있으면 그 제목·본문을 우선 사용하고,
    없으면 코드 내장 기본값을 쓴다. 수신자 이름은 {{contact}} 토큰으로 남긴 '원본'을
    그대로 내려주고, 실제 이름 치환은 작성 화면(과 발송 직전)에서 한다."""
    lang_n = "kr" if lang in ("ko", "kr") else "en"
    lang_db = "ko" if lang_n == "kr" else "en"
    s = get_session()
    try:
        tpl = _resolve_email_template(s, user.get("id"), _marketing_doc_type(kind), lang_db)
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
        "smtp_configured": bool(os.getenv("SMTP_USER") and os.getenv("SMTP_PASSWORD")),
    }


@app.put("/api/admin/marketing/compose-template", dependencies=[Depends(require_token)])
def save_marketing_template(
    kind: str = Body("intro", embed=True),
    lang: str = Body("en", embed=True),
    subject: str = Body("", embed=True),
    body: str = Body("", embed=True),
    user: dict = Depends(get_current_user),
):
    """홍보 메일 제목·본문을 사용자 템플릿으로 저장(종류 intro/brochure × 언어 en/ko)."""
    lang_db = "ko" if lang in ("ko", "kr") else "en"
    doc_type = _marketing_doc_type(kind)
    uid = user.get("id")
    s = get_session()
    try:
        t = (s.query(EmailTemplate)
             .filter_by(user_id=uid, doc_type=doc_type, lang=lang_db).first())
        if not t:
            t = EmailTemplate(user_id=uid, doc_type=doc_type, lang=lang_db)
            s.add(t)
        t.subject_tpl = subject or ""
        t.body_tpl = body or ""
        t.updated_at = datetime.utcnow()
        s.commit()
        return {"ok": True, "kind": kind, "lang": lang_db}
    finally:
        s.close()


@app.delete("/api/admin/marketing/compose-template", dependencies=[Depends(require_token)])
def reset_marketing_template(
    kind: str = "intro", lang: str = "en", user: dict = Depends(get_current_user),
):
    """저장한 홍보 메일 템플릿 삭제 → 코드 내장 기본값으로 복귀."""
    lang_db = "ko" if lang in ("ko", "kr") else "en"
    s = get_session()
    try:
        t = (s.query(EmailTemplate)
             .filter_by(user_id=user.get("id"), doc_type=_marketing_doc_type(kind), lang=lang_db).first())
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
