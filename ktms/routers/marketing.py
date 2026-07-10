"""K-Maris TMS — marketing routes (split from admin_api.py; behavior unchanged)."""
from __future__ import annotations

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
    intro_email_body,
    intro_email_subject,
    intro_signature,
    os,
    require_token,
    send_email,
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


@app.put("/api/admin/marketing/{row_id}", dependencies=[Depends(require_token)])
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


@app.delete("/api/admin/marketing/{row_id}", dependencies=[Depends(require_token)])
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
    kind: str = "intro", lang: str = "en", contact: str = "", customer: str = "",
    user: dict = Depends(get_current_user),
):
    """작성 화면 기본값 — 저장된 사용자/회사 템플릿이 있으면 그 제목·본문을 우선 사용하고,
    없으면 코드 내장 기본값(수신자 인사말 반영)으로 생성한다."""
    lang_n = "kr" if lang in ("ko", "kr") else "en"
    lang_db = "ko" if lang_n == "kr" else "en"
    s = get_session()
    try:
        tpl = _resolve_email_template(s, user.get("id"), _marketing_doc_type(kind), lang_db)
        saved_subject = tpl.subject_tpl if (tpl and tpl.subject_tpl) else ""
        saved_body = tpl.body_tpl if (tpl and tpl.body_tpl) else ""
    finally:
        s.close()
    return {
        "from": default_from(),
        "subject": saved_subject or intro_email_subject(kind, lang_n),
        "body": saved_body or intro_email_body(contact, customer, kind, lang_n),
        "signature": intro_signature(lang_n),
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


@app.post("/api/admin/marketing/send", dependencies=[Depends(require_token)])
def marketing_email_send(
    to: str = Form(...),
    subject: str = Form(""),
    body: str = Form(""),
    signature: str = Form(""),
    include_signature: bool = Form(True),
    cc: str = Form(""),
    from_email: str = Form(""),
    customer_id: str = Form(""),
    prospect_name: str = Form(""),
    contact_person: str = Form(""),
    asset_ids: str = Form(""),      # 라이브러리 첨부 id들(쉼표 구분)
    files: List[UploadFile] = File(default=[]),   # 즉석 업로드 첨부
    user: dict = Depends(get_current_user),
):
    """홍보 이메일 발송 — 라이브러리 자료 + 즉석 업로드 첨부. 발송 성공 시
    MarketingActivity 로그를 자동 생성해 활동 목록에 남긴다."""
    to = (to or "").strip()
    if not to:
        raise HTTPException(status_code=400, detail="수신자 이메일을 입력하세요.")

    s = get_session()
    try:
        # 최종 본문 = 본문 + (서명 포함 시 서명)
        final_body = body or ""
        if include_signature and (signature or "").strip():
            final_body = f"{final_body.rstrip()}\n\n{signature.strip()}\n"

        # 첨부 조립: 라이브러리 자료 → 즉석 업로드 순
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

        sent = send_email(
            to=to,
            subject=subject or "",
            body=final_body,
            attachments=attachments,
            cc=(cc or "").strip(),
            from_addr=(from_email or "").strip(),
        )
        if not sent:
            raise HTTPException(status_code=400, detail="이메일 발송 실패 — SMTP 설정 또는 서버 상태를 확인하세요.")

        # 발송 성공 → 마케팅 활동 로그 자동 생성(표에 즉시 반영)
        cid = int(customer_id) if (customer_id or "").strip().isdigit() else None
        today = (datetime.utcnow() + timedelta(hours=9)).strftime("%Y-%m-%d")
        activity = MarketingActivity(
            customer_id=cid,
            prospect_name=(prospect_name or "").strip(),
            contact_person=(contact_person or "").strip(),
            recipient_email=to,
            activity_date=today,
            channel="Email",
            activity_type="Intro email",
            subject=subject or "",
            notes="홍보 이메일 발송" + (f" (첨부 {len(attachments)}건)" if attachments else ""),
            owner_id=user.get("id") or None,
        )
        s.add(activity)
        s.commit()
        return {"ok": True, "id": activity.id, "sent_date": today}
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
