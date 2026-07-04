"""K-Maris TMS — marketing routes (split from admin_api.py; behavior unchanged)."""
from __future__ import annotations

from _core import (
    Customer,
    Depends,
    HTTPException,
    MarketingActivity,
    MarketingActivityCreate,
    ScheduleEvent,
    ScheduleEventCreate,
    User,
    _marketing_row,
    _marketing_scoped,
    _schedule_guard,
    _schedule_row,
    app,
    datetime,
    get_current_user,
    get_session,
    require_token,
    timedelta,
)



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
            owner_id=user.get("id") or None,
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
