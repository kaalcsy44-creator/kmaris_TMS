"""K-Maris TMS — claim routes (납품 후 클레임 · 크레딧 노트).

납품이 끝난 뒤 현장에서 하자·사고가 나면 공임·부품 같은 비용이 뒤늦게 붙는다. 이 비용은
누가 부담하느냐(고객이 자기 돈으로 처리 / 당사 부담 / 벤더 청구)와 어떻게 정산했느냐
(미수금 상계 / 현금 지급)가 따로 놀아서, 한 곳에 함께 적어 두지 않으면 같은 금액이
매출 차감과 비용 계상으로 두 번 잡힌다.

그래서 클레임 한 건(Claim)에 비용 라인을 담고, '미수금 상계'로 정산한 라인만 크레딧
노트(CreditNote)를 발행해 상계 대상 청구서(ARRecord)에 붙인다. 청구서의 credit_amount
는 이 표를 다시 합산해 채우므로(_sync_ar_credit) 잔액이 어긋날 자리가 없다.
"""
from __future__ import annotations

from _core import (
    ARRecord,
    Claim,
    ClaimSave,
    CreditNote,
    CreditNoteSave,
    Customer,
    Depends,
    HTTPException,
    Order,
    RFQ,
    User,
    _ar_outstanding,
    _enum_val,
    _manual_doc_no,
    _project_no_for_order,
    _rfq_for_order,
    _sync_ar_credit,
    app,
    build_payload,
    date,
    datetime,
    generate_pdf,
    get_current_user,
    get_session,
    require_token,
)
from _core import Vessel, _doc_file_response, _kst_iso, _project_no_map, generate_cn_xlsx


def _log_activity(s, rfq_id: int, text: str, pic: str = "") -> None:
    """딜의 활동기록(업무일지)에 한 줄 남긴다 — 11단계(수금 완료) 칸에 붙인다.

    클레임과 크레딧 노트는 돈의 흐름을 바꾸는 사건이라, 나중에 "이 청구서 잔액이 왜
    줄었지?"를 되짚는 자리는 단계 보드다. 그 자리에 자국이 없으면 클레임 탭을 열어 볼
    생각을 하지 못한다. 기록에 실패해도 본 작업(저장·발행)은 되돌리지 않는다 — 자국이
    남지 않는 것이 저장이 안 되는 것보다 낫다.
    """
    if not rfq_id or not (text or "").strip():
        return
    try:
        rfq = s.query(RFQ).filter_by(id=rfq_id).first()
        if not rfq:
            return
        notes = dict(getattr(rfq, "stage_notes", None) or {})
        log = list(notes.get("11", []))
        now = _kst_iso(datetime.utcnow())
        log.append({"text": text, "datetime": now, "party": "", "person": "",
                    "channel": "", "direction": "", "star": False, "pic": pic, "at": now})
        notes["11"] = log
        rfq.stage_notes = notes   # JSON 컬럼은 새 dict 재할당이 필요
    except Exception:
        pass


def _cn_items(raw) -> list[dict]:
    """크레딧 노트의 감액 내역 줄 — 문서 품목표에 그대로 찍힌다(금액은 청구서 통화).

    실제 발행 양식의 표는 No./Description/Reference/Qty/Unit Price/Amount 여섯 칸이다.
    금액이 비어 오면 수량×단가로 채운다 — 화면에서 단가만 고치고 금액을 안 고쳐도
    문서의 합이 어긋나지 않게.
    """
    out: list[dict] = []
    for i, r in enumerate(raw or [], start=1):
        if not isinstance(r, dict):
            continue
        qty = float(r.get("qty") or 0) or 1.0
        unit = float(r.get("unit_price") or 0)
        amt = r.get("amount")
        amt = float(amt) if amt not in (None, "", 0) else qty * unit
        if not (r.get("description") or "").strip() and not amt:
            continue
        out.append({
            "item_no": i,
            "description": (r.get("description") or "").strip(),
            "reference": (r.get("reference") or "").strip(),
            "qty": qty,
            "unit_price": unit if unit else (amt / qty if qty else amt),
            "amount": round(amt, 2),
        })
    for i, it in enumerate(out, start=1):
        it["item_no"] = i
    return out


def _cn_out(c: CreditNote, ar: ARRecord | None = None) -> dict:
    return {
        "id": c.id,
        "cn_no": c.cn_no or "",
        "claim_id": c.claim_id or 0,
        "ar_id": c.ar_id or 0,
        "order_id": c.order_id or 0,
        "customer_id": c.customer_id or 0,
        "issue_date": c.issue_date or "",
        "currency": c.currency or "USD",
        "amount": round(c.amount or 0, 2),
        "fx_rate": c.fx_rate or 1.0,
        "applied_amount": round(c.applied_amount or 0, 2),
        "vat_rate": c.vat_rate or 0.0,
        "vat_amount": round(c.vat_amount or 0, 2),
        "reason": c.reason or "",
        "status": c.status or "issued",
        # 발행 문서(CREDIT NOTE)에 찍히는 칸 — 목록에서 고른 노트를 그대로 다시 열어 고친다.
        "items": _cn_items(c.items),
        "vessel_name": c.vessel_name or "",
        "settlement_method": c.settlement_method or "",
        "cash_refund": c.cash_refund or "",
        "rate_basis": c.rate_basis or "",
        "fx_quotation": c.fx_quotation or "",
        "terms": list(c.terms or []),
        # 상계 대상 청구서 표시용 — 목록에서 "어느 청구서를 깎았나"가 번호로 보여야 한다.
        "invoice_no": (ar.invoice_no or ar.ci_no or "") if ar else "",
        "invoice_date": ((ar.invoice_date or "")[:10]) if ar else "",
        "invoice_currency": (ar.currency or "USD") if ar else "",
    }


def _claim_out(c: Claim, cns: list[dict], project_no: str = "", owner: str = "") -> dict:
    return {
        "id": c.id,
        "rfq_id": c.rfq_id or 0,
        "order_id": c.order_id or 0,
        "claim_no": c.claim_no or "",
        "occurred_date": c.occurred_date or "",
        "reported_date": c.reported_date or "",
        "site": c.site or "",
        "title": c.title or "",
        "description": c.description or "",
        "status": c.status or "open",
        "costs": c.costs or [],
        "owner_id": c.owner_id or 0,
        "owner": owner,
        "project_no": project_no,
        "credit_notes": cns,
    }


@app.get("/api/admin/claims", dependencies=[Depends(require_token)])
def list_claims(rfq_id: int = 0, order_id: int = 0):
    """클레임 목록 — 프로젝트(rfq_id) 또는 고객 P/O(order_id) 기준. 둘 다 없으면 전체.

    각 클레임에 그 클레임으로 발행한 크레딧 노트를 함께 실어 보낸다(화면이 상계 내역을
    따로 조회하지 않도록).
    """
    s = get_session()
    try:
        q = s.query(Claim)
        if rfq_id:
            q = q.filter(Claim.rfq_id == rfq_id)
        if order_id:
            q = q.filter(Claim.order_id == order_id)
        claims = q.order_by(Claim.id.desc()).all()
        ids = [c.id for c in claims]
        ar_map = {a.id: a for a in s.query(ARRecord).all()}
        cn_by_claim: dict[int, list[dict]] = {}
        if ids:
            for c in (s.query(CreditNote)
                      .filter(CreditNote.claim_id.in_(ids))
                      .order_by(CreditNote.id).all()):
                cn_by_claim.setdefault(c.claim_id, []).append(_cn_out(c, ar_map.get(c.ar_id)))
        user_names = {u.id: u.username for u in s.query(User).all()}
        ord_map = {o.id: o for o in s.query(Order).all()}
        rows = [
            _claim_out(
                c,
                cn_by_claim.get(c.id, []),
                _project_no_for_order(s, ord_map.get(c.order_id or 0)) if c.order_id else "",
                user_names.get(c.owner_id or 0, ""),
            )
            for c in claims
        ]
        return {"rows": rows}
    finally:
        s.close()


def _rfq_id_of_order(s, order_id: int | None) -> int:
    """오더가 속한 프로젝트 id — 활동기록을 붙일 딜을 찾는 데 쓴다."""
    o = s.query(Order).filter_by(id=order_id).first() if order_id else None
    rfq = _rfq_for_order(s, o) if o else None
    return rfq.id if rfq else 0


def _resolve_deal(s, body: ClaimSave) -> tuple[int, int]:
    """저장 본문의 order_id / rfq_id 를 채워 준다 — 오더만 오면 그 오더의 프로젝트를 찾는다."""
    order_id = body.order_id or 0
    rfq_id = body.rfq_id or 0
    if order_id:
        order = s.query(Order).filter_by(id=order_id).first()
        if not order:
            raise HTTPException(status_code=404, detail="Order를 찾을 수 없습니다.")
        if not rfq_id:
            rfq = _rfq_for_order(s, order)
            rfq_id = rfq.id if rfq else 0
    if rfq_id and not s.query(RFQ).filter_by(id=rfq_id).first():
        raise HTTPException(status_code=404, detail="프로젝트(RFQ)를 찾을 수 없습니다.")
    if not order_id and not rfq_id:
        raise HTTPException(status_code=400, detail="클레임은 프로젝트나 고객 P/O 에 붙어야 합니다.")
    return order_id, rfq_id


@app.post("/api/admin/claims", dependencies=[Depends(require_token)])
def create_claim(body: ClaimSave, user: dict = Depends(get_current_user)):
    s = get_session()
    try:
        order_id, rfq_id = _resolve_deal(s, body)
        c = Claim(
            rfq_id=rfq_id or None,
            order_id=order_id or None,
            claim_no=_manual_doc_no(s, Claim, "claim_no", body.claim_no, None) or "",
            occurred_date=body.occurred_date or "",
            reported_date=body.reported_date or "",
            site=body.site or "",
            title=body.title or "",
            description=body.description or "",
            status=body.status or "open",
            costs=body.costs or [],
            owner_id=body.owner_id or user.get("id") or None,
        )
        s.add(c)
        s.flush()
        _log_activity(s, rfq_id, f"클레임 등록 — {c.title or c.claim_no or '현장 클레임'}"
                                 + (f" ({c.site})" if c.site else ""),
                      user.get("username", ""))
        s.commit()
        return {"ok": True, "id": c.id}
    finally:
        s.close()


@app.put("/api/admin/claims/{claim_id}", dependencies=[Depends(require_token)])
def update_claim(claim_id: int, body: ClaimSave):
    s = get_session()
    try:
        c = s.query(Claim).filter_by(id=claim_id).first()
        if not c:
            raise HTTPException(status_code=404, detail="클레임을 찾을 수 없습니다.")
        order_id, rfq_id = _resolve_deal(s, body)
        c.order_id = order_id or None
        c.rfq_id = rfq_id or None
        c.claim_no = _manual_doc_no(s, Claim, "claim_no", body.claim_no, claim_id) or ""
        c.occurred_date = body.occurred_date or ""
        c.reported_date = body.reported_date or ""
        c.site = body.site or ""
        c.title = body.title or ""
        c.description = body.description or ""
        c.status = body.status or "open"
        if body.costs is not None:
            c.costs = body.costs
        if body.owner_id is not None:
            c.owner_id = body.owner_id or None
        s.commit()
        return {"ok": True, "id": c.id}
    finally:
        s.close()


@app.delete("/api/admin/claims/{claim_id}", dependencies=[Depends(require_token)])
def delete_claim(claim_id: int):
    """클레임 삭제 — 발행한 크레딧 노트가 있으면 막는다.

    지우면 상계가 사라져 청구서 잔액이 조용히 늘어난다. 크레딧 노트를 먼저 취소해
    잔액을 되돌린 다음 지우게 한다.
    """
    s = get_session()
    try:
        c = s.query(Claim).filter_by(id=claim_id).first()
        if not c:
            raise HTTPException(status_code=404, detail="클레임을 찾을 수 없습니다.")
        n = s.query(CreditNote).filter_by(claim_id=claim_id).count()
        if n:
            raise HTTPException(
                status_code=400,
                detail=f"이 클레임으로 발행한 크레딧 노트가 {n}건 있습니다. 먼저 취소해 주세요.")
        s.delete(c)
        s.commit()
        return {"ok": True}
    finally:
        s.close()


@app.get("/api/admin/claims/ar-candidates", dependencies=[Depends(require_token)])
def claim_ar_candidates(order_id: int = 0, customer_id: int = 0):
    """상계 대상이 될 수 있는 청구서 목록 — 그 고객의 청구서 전부(잔액 큰 순).

    이 딜의 청구서로 한정하지 않는다. 실무에서 상계할 미수는 다른 프로젝트 건일 때가
    많다(현장 비용은 이 딜에서 났는데 깎을 미수는 지난달 청구서에 남아 있는 식).
    같은 오더 건은 목록 맨 위로 올려 준다.
    """
    s = get_session()
    try:
        cid = customer_id or 0
        order = s.query(Order).filter_by(id=order_id).first() if order_id else None
        if not cid and order:
            cid = order.customer_id or 0
        if not cid:
            raise HTTPException(status_code=400,
                                detail="고객을 알 수 없습니다(order_id 또는 customer_id 필요).")
        ord_map = {o.id: o for o in s.query(Order).filter_by(customer_id=cid).all()}
        cust = s.query(Customer).filter_by(id=cid).first()
        cn_count: dict[int, int] = {}
        for c in s.query(CreditNote).all():
            cn_count[c.ar_id] = cn_count.get(c.ar_id, 0) + 1
        rows = []
        for r in s.query(ARRecord).filter(ARRecord.order_id.in_(list(ord_map) or [0])).all():
            o = ord_map.get(r.order_id)
            rows.append({
                "ar_id": r.id,
                "order_id": r.order_id,
                "po_no": (o.po_no or "") if o else "",
                "invoice_no": r.invoice_no or r.ci_no or "",
                "invoice_date": (r.invoice_date or "")[:10],
                "currency": r.currency or "USD",
                "invoice_amount": round(r.invoice_amount or 0, 2),
                "paid_amount": round(r.paid_amount or 0, 2),
                "credit_amount": round(float(getattr(r, "credit_amount", None) or 0), 2),
                "outstanding": _ar_outstanding(r),
                "status": _enum_val(r.status),
                "project_no": _project_no_for_order(s, o) if o else "",
                # 자동 번호 제안(<청구서번호>-CN, 2건째부터 -CN2)에 쓴다.
                "credit_count": cn_count.get(r.id, 0),
                "same_order": bool(order_id and r.order_id == order_id),
            })
        rows.sort(key=lambda x: (not x["same_order"], -x["outstanding"]))
        return {"rows": rows, "customer_id": cid, "customer": cust.name if cust else ""}
    finally:
        s.close()


def _apply_cn_fields(s, cn: CreditNote, body: CreditNoteSave, cn_id: int | None) -> None:
    """크레딧 노트 본문 → 레코드. 환산·부가세는 비어 오면 여기서 채운다."""
    ar = s.query(ARRecord).filter_by(id=body.ar_id).first()
    if not ar:
        raise HTTPException(status_code=404, detail="상계 대상 청구서를 찾을 수 없습니다.")
    amount = round(float(body.amount or 0), 2)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="크레딧 노트 금액은 0보다 커야 합니다.")
    currency = (body.currency or "USD").upper()
    inv_cur = (ar.currency or "USD").upper()
    # 환율은 청구서 통화가 다를 때만 뜻이 있다 — 같은 통화면 무조건 1(잘못 들어온 값 무시).
    fx = 1.0 if currency == inv_cur else float(body.fx_rate or 0)
    if fx <= 0:
        raise HTTPException(
            status_code=400,
            detail=f"환율이 필요합니다 — 크레딧 노트는 {currency}, 청구서는 {inv_cur} 입니다.")
    # 감액 내역 줄이 오면 그 합이 상계액이다 — 고객이 받는 종이의 TOTAL CREDIT 과
    # 장부에서 깎이는 금액이 다른 곳에서 계산되면 언젠가 반드시 어긋난다.
    items = _cn_items(body.items)
    items_total = round(sum(i["amount"] for i in items), 2)
    applied = round(
        items_total if items_total > 0
        else (float(body.applied_amount) if body.applied_amount else amount * fx), 2)
    vat_rate = float(body.vat_rate or 0)
    vat_amount = (round(float(body.vat_amount), 2) if body.vat_amount is not None
                  else round(applied - applied / (1 + vat_rate), 2) if vat_rate else 0.0)
    order = s.query(Order).filter_by(id=ar.order_id).first()
    # 번호를 비워 두면 None 으로 남긴다 — cn_no 는 unique 라 빈 문자열로 채우면 번호 없는
    # 두 번째 노트에서 제약을 어긴다(NULL 은 여러 개 허용된다).
    cn.cn_no = _manual_doc_no(s, CreditNote, "cn_no", body.cn_no, cn_id)
    cn.claim_id = body.claim_id or None
    cn.ar_id = ar.id
    cn.order_id = ar.order_id
    cn.customer_id = (order.customer_id if order else None)
    cn.issue_date = (body.issue_date or "")[:10] or date.today().isoformat()
    cn.currency = currency
    cn.amount = amount
    cn.fx_rate = fx
    cn.applied_amount = applied
    cn.vat_rate = vat_rate
    cn.vat_amount = vat_amount
    cn.reason = body.reason or ""
    cn.status = body.status or "issued"
    # 발행 문서의 칸. 비워 두면 문서를 만들 때 표준값으로 채운다(_cn_payload).
    cn.items = items
    cn.vessel_name = (body.vessel_name or "").strip()
    cn.settlement_method = (body.settlement_method or "").strip()
    cn.cash_refund = (body.cash_refund or "").strip()
    cn.rate_basis = (body.rate_basis or "").strip()
    cn.fx_quotation = (body.fx_quotation or "").strip()
    cn.terms = [t for t in ((body.terms or []) if body.terms is not None else []) if str(t).strip()]


@app.post("/api/admin/credit-notes", dependencies=[Depends(require_token)])
def create_credit_note(body: CreditNoteSave, user: dict = Depends(get_current_user)):
    """크레딧 노트 발행 — 대상 청구서의 미수를 그만큼 깎는다."""
    s = get_session()
    try:
        cn = CreditNote()
        _apply_cn_fields(s, cn, body, None)
        s.add(cn)
        s.flush()
        credit = _sync_ar_credit(s, cn.ar_id)
        ar = s.query(ARRecord).filter_by(id=cn.ar_id).first()
        inv_cur = (ar.currency or "") if ar else ""
        target = ((ar.invoice_no or ar.ci_no or "") if ar else "").strip()
        _log_activity(
            s, _rfq_id_of_order(s, cn.order_id),
            f"크레딧 노트 발행 {cn.cn_no or ''} — {cn.currency} {cn.amount:,.2f}"
            f" → {inv_cur} {cn.applied_amount:,.0f} 상계"
            + (f" (대상 {target})" if target else ""),
            user.get("username", ""))
        s.commit()
        return {"ok": True, "id": cn.id, "ar_credit_amount": credit}
    finally:
        s.close()


@app.put("/api/admin/credit-notes/{cn_id}", dependencies=[Depends(require_token)])
def update_credit_note(cn_id: int, body: CreditNoteSave):
    s = get_session()
    try:
        cn = s.query(CreditNote).filter_by(id=cn_id).first()
        if not cn:
            raise HTTPException(status_code=404, detail="크레딧 노트를 찾을 수 없습니다.")
        prev_ar = cn.ar_id
        _apply_cn_fields(s, cn, body, cn_id)
        s.flush()
        # 대상 청구서를 옮겼으면 옛 청구서의 상계액도 다시 세야 한다.
        if prev_ar and prev_ar != cn.ar_id:
            _sync_ar_credit(s, prev_ar)
        credit = _sync_ar_credit(s, cn.ar_id)
        s.commit()
        return {"ok": True, "id": cn.id, "ar_credit_amount": credit}
    finally:
        s.close()


def _cn_default_terms(d: dict) -> list[str]:
    """SET-OFF / OFFSET TERMS 표준 3조항 — 손으로 안 적었을 때 문서가 스스로 쓴다.

    실제 발행해 온 양식의 문구를 그대로 따른다: (1) 무엇을 얼마로 발행했는가,
    (2) 어느 청구서의 미수와 상계하는가, (3) 현금 환불은 없다. 이 세 줄이 빠지면
    고객 경리는 이 종이를 무엇으로 처리해야 할지 알 수 없다.
    """
    cur, inv_cur = d["currency"], d["invoice_currency"]
    dec = 0 if inv_cur == "KRW" else 2
    applied, amount = d["applied_amount"], d["amount"]
    vessel = (d.get("vessel_name") or "").strip()
    what = (d.get("reason") or "").strip() or (d.get("claim", {}) or {}).get("title", "") or "the claim costs"
    line1 = (f"Without prejudice and as a goodwill gesture, this Credit Note is issued for "
             f"{inv_cur} {applied:,.{dec}f}")
    if cur != inv_cur:
        line1 += f", equivalent to {what} of {cur} {amount:,.2f}"
    if vessel:
        line1 += f" incurred in connection with {vessel}"
    terms = [line1 + "."]
    if d.get("invoice_no"):
        who = (d.get("customer", {}) or {}).get("name", "") or "the customer"
        terms.append(f"The credit amount will be offset against the outstanding amount payable by "
                     f"{who} under Reference Invoice No. {d['invoice_no']}.")
    terms.append("A cash refund will be made separately."
                 if (d.get("cash_refund") or "No").strip().lower().startswith("y")
                 else "No separate cash refund will be made.")
    return terms


def _cn_payload(s, cn: CreditNote) -> tuple[dict, str]:
    """크레딧 노트 한 장의 문서 payload + 파일 이름 — PDF·Excel 이 같은 것을 받는다.

    금액은 두 통화로 적힌다: 발행 통화(현장 비용이 난 통화)와 청구서 통화의 상계액.
    환율은 발행 시점에 굳은 값이라 지금 다시 계산하지 않고 저장된 것을 그대로 쓴다.
    비워 둔 칸(감액 내역·정산 방식·조항)은 여기서 표준값으로 채운다 — 종이에 빈칸이
    남는 것보다, 늘 쓰는 문구가 찍히고 필요하면 화면에서 고치는 편이 낫다.
    """
    ar = s.query(ARRecord).filter_by(id=cn.ar_id).first()
    order = s.query(Order).filter_by(id=cn.order_id).first() if cn.order_id else None
    cust = s.query(Customer).filter_by(id=order.customer_id).first() if order else None
    vessel = (s.query(Vessel).filter_by(id=order.vessel_id).first()
              if order and order.vessel_id else None)
    claim = s.query(Claim).filter_by(id=cn.claim_id).first() if cn.claim_id else None
    rfq = _rfq_for_order(s, order) if order else None
    inv_cur = ((ar.currency or cn.currency) if ar else (cn.currency or "USD")).upper()
    applied = round(cn.applied_amount or 0, 2)
    payload = build_payload(
        doc_no=cn.cn_no or f"CN-{cn.id}",
        date=cn.issue_date or "",
        customer=cust, vessel=vessel, items=[], terms={},
        currency=cn.currency or "USD",
        vat_rate=cn.vat_rate or 0.0,
        po_no=(order.po_no or "") if order else "",
        export_ref=_project_no_map(s).get(rfq.id, "") if rfq else "",
        project_title=(getattr(rfq, "project_title", "") or "") if rfq else "",
    )
    vessel_name = (cn.vessel_name or "").strip() or (
        (claim.site or "") if claim else "") or (vessel.name if vessel else "")
    reason = cn.reason or ""
    items = _cn_items(cn.items)
    if not items:
        # 내역 줄을 안 적었으면 상계액 한 줄로 만든다 — 표가 빈 채로 나가는 일은 없어야 한다.
        items = [{"item_no": 1,
                  "description": reason or (claim.title if claim else "") or "Claim settlement credit",
                  "reference": (claim.claim_no or "") if claim else "",
                  "qty": 1.0, "unit_price": applied, "amount": applied}]
    payload.update({
        "amount": cn.amount or 0.0,
        "fx_rate": cn.fx_rate or 1.0,
        "applied_amount": applied,
        "vat_amount": cn.vat_amount or 0.0,
        "invoice_currency": inv_cur,
        "invoice_no": (ar.invoice_no or ar.ci_no or "") if ar else "",
        "invoice_date": (ar.invoice_date or "") if ar else "",
        "po_no": (order.po_no or "") if order else "",
        "reason": reason,
        "cn_items": items,
        "vessel_name": vessel_name,
        "settlement_method": (cn.settlement_method or "").strip() or "Set-off against outstanding balance",
        "cash_refund": (cn.cash_refund or "").strip() or "No",
        "rate_basis": (cn.rate_basis or "").strip(),
        "fx_quotation": (cn.fx_quotation or "").strip(),
        "claim": {
            "title": (claim.title or "") if claim else "",
            "claim_no": (claim.claim_no or "") if claim else "",
            "site": (claim.site or "") if claim else "",
            "occurred_date": (claim.occurred_date or "") if claim else "",
        },
    })
    payload["terms_lines"] = [str(t) for t in (cn.terms or []) if str(t).strip()] or _cn_default_terms(payload)
    return payload, (cn.cn_no or f"CN-{cn.id}").replace("/", "-")


@app.get("/api/admin/credit-notes/{cn_id}/pdf", dependencies=[Depends(require_token)])
def credit_note_pdf(cn_id: int):
    """크레딧 노트 PDF — 고객에게 보내는 감액 증서(미리보기도 이 파일을 그대로 쓴다)."""
    s = get_session()
    try:
        cn = s.query(CreditNote).filter_by(id=cn_id).first()
        if not cn:
            raise HTTPException(status_code=404, detail="크레딧 노트를 찾을 수 없습니다.")
        payload, name = _cn_payload(s, cn)
        return _doc_file_response(generate_pdf("credit_note", payload),
                                  f"{name}_CREDIT_NOTE.pdf", "application/pdf")
    finally:
        s.close()


@app.get("/api/admin/credit-notes/{cn_id}/xlsx", dependencies=[Depends(require_token)])
def credit_note_xlsx(cn_id: int):
    """크레딧 노트 Excel — PDF 와 같은 서식·같은 값(고객이 숫자를 옮겨 담아야 할 때)."""
    s = get_session()
    try:
        cn = s.query(CreditNote).filter_by(id=cn_id).first()
        if not cn:
            raise HTTPException(status_code=404, detail="크레딧 노트를 찾을 수 없습니다.")
        payload, name = _cn_payload(s, cn)
        return _doc_file_response(
            generate_cn_xlsx(payload), f"{name}_CREDIT_NOTE.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    finally:
        s.close()


@app.delete("/api/admin/credit-notes/{cn_id}", dependencies=[Depends(require_token)])
def delete_credit_note(cn_id: int):
    """크레딧 노트 취소 — 상계가 풀려 그만큼 미수가 되살아난다."""
    s = get_session()
    try:
        cn = s.query(CreditNote).filter_by(id=cn_id).first()
        if not cn:
            raise HTTPException(status_code=404, detail="크레딧 노트를 찾을 수 없습니다.")
        ar_id = cn.ar_id
        no, cur, amt, applied, order_id = (cn.cn_no or ""), cn.currency, cn.amount or 0, cn.applied_amount or 0, cn.order_id
        s.delete(cn)
        s.flush()
        credit = _sync_ar_credit(s, ar_id)
        _log_activity(s, _rfq_id_of_order(s, order_id),
                      f"크레딧 노트 취소 {no} — {cur} {amt:,.2f} 상계 해제(미수 {applied:,.0f} 복원)")
        s.commit()
        return {"ok": True, "ar_credit_amount": credit}
    finally:
        s.close()
