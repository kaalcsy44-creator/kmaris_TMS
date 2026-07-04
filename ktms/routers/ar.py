"""K-Maris TMS — ar routes (split from admin_api.py; behavior unchanged)."""
from __future__ import annotations

from _core import (
    ARPayment,
    ARRecord,
    ARSave,
    ARStatus,
    Customer,
    Depends,
    HTTPException,
    Order,
    PurchaseOrder,
    Response,
    User,
    Vendor,
    Vessel,
    _ar_status_from_text,
    _enum_val,
    _first_rfq_iso,
    _project_no_for_order,
    _project_no_map,
    _rfq_for_order,
    app,
    date,
    get_session,
    io,
    require_token,
)



@app.get("/api/admin/ar-overview", dependencies=[Depends(require_token)])
def ar_overview():
    """미수금(AR) 현황 — 청구/수금/연체."""
    s = get_session()
    try:
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        vessel_names = {v.id: v.name for v in s.query(Vessel).all()}
        vendor_names = {v.id: v.name for v in s.query(Vendor).all()}
        user_names = {u.id: u.username for u in s.query(User).all()}
        ord_map = {o.id: o for o in s.query(Order).all()}
        # order_id → 발주 Vendor 이름들(중복 제거, 발주 순)
        po_vendors_by_order: dict[int, list[str]] = {}
        for po in s.query(PurchaseOrder).order_by(PurchaseOrder.id).all():
            nm = vendor_names.get(po.vendor_id)
            if not nm:
                continue
            lst = po_vendors_by_order.setdefault(po.order_id, [])
            if nm not in lst:
                lst.append(nm)
        today_str = date.today().isoformat()

        rows = []
        out_usd = 0.0
        overdue_usd = 0.0
        for r in s.query(ARRecord).order_by(ARRecord.id.desc()).all():
            o = ord_map.get(r.order_id)
            cust = cust_names.get(o.customer_id, "—") if o else "—"
            outstanding = (r.invoice_amount or 0) - (r.paid_amount or 0)
            overdue = (r.status != ARStatus.PAID and r.due_date
                       and r.due_date < today_str)
            status = "연체" if overdue else _enum_val(r.status)
            if (r.currency or "USD") == "USD" and r.status != ARStatus.PAID:
                out_usd += outstanding
                if overdue:
                    overdue_usd += outstanding
            # 11) 세금계산서 발행 · 12) 대금 결제 완료 — RFQ.stage_dates 의 수동 완료 표시
            rfq = _rfq_for_order(s, o) if o else None
            sd = (getattr(rfq, "stage_dates", None) or {}) if rfq else {}
            rows.append({
                "id": r.id,
                "order_id": r.order_id,
                "assignee_id": (rfq.created_by or 0) if rfq else 0,
                "assignee": (user_names.get(rfq.created_by, "") or "") if rfq else "",
                "project_title": (getattr(rfq, "project_title", None) or "") if rfq else "",
                "contact_person": (getattr(rfq, "contact_person", None) or "") if rfq else "",
                "ci_no": r.ci_no or "",
                "customer": cust,
                "currency": r.currency or "USD",
                "invoice_amount": round(r.invoice_amount or 0, 2),
                "paid_amount": round(r.paid_amount or 0, 2),
                "outstanding": round(outstanding, 2),
                "due_date": r.due_date or "",
                "status": status,
                "overdue": bool(overdue),
                "notes": r.notes or "",
                "tax_issued": bool(sd.get("11")),
                "tax_issued_date": sd.get("11", "") or "",
                "paid_done": bool(sd.get("12")),
                "paid_date": sd.get("12", "") or "",
                # 공통 식별 컬럼
                "vessel": (vessel_names.get(o.vessel_id, "") if o and o.vessel_id else ""),
                "trade_type": (o.trade_type or "수출") if o else "수출",
                "work_type": (_enum_val(rfq.work_type) if rfq and rfq.work_type else "부품공급"),
                "vendor": (lambda v: (v[0] + (f"  (외 {len(v) - 1}곳)" if len(v) > 1 else "")) if v else "")(po_vendors_by_order.get(r.order_id, [])),
                "first_rfq_at": _first_rfq_iso(rfq),
                "project_no": _project_no_map(s).get(rfq.id, "") if rfq else "",
            })
        return {
            "kpi": {
                "outstanding_usd": round(out_usd, 2),
                "overdue_usd": round(overdue_usd, 2),
                "count": len(rows),
            },
            "rows": rows,
        }
    finally:
        s.close()


@app.get("/api/admin/ar/soa.xlsx", dependencies=[Depends(require_token)])
def ar_soa_xlsx(status: str | None = None, currency: str | None = None):
    """Statement of Account (SOA) XLSX 내보내기 — AR 현황을 엑셀로 추출한다.
    AR 페이지의 status/currency 필터를 그대로 적용하고 통화별 합계를 덧붙인다."""
    import io
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill

    s = get_session()
    try:
        cust_names = {c.id: c.name for c in s.query(Customer).all()}
        ord_map = {o.id: o for o in s.query(Order).all()}
        today_str = date.today().isoformat()

        wb = Workbook()
        ws = wb.active
        ws.title = "SOA"
        ws.append(["Statement of Account (Accounts Receivable)"])
        ws.append([f"Generated: {today_str}"])
        active_filters = []
        if status:
            active_filters.append(f"Status={status}")
        if currency:
            active_filters.append(f"Currency={currency}")
        ws.append(["Filter: " + (", ".join(active_filters) if active_filters else "All")])
        ws.append([])

        headers = ["CI No.", "Customer", "Project No.", "Currency", "Invoice",
                   "Paid", "Outstanding", "Due Date", "Status"]
        ws.append(headers)
        head_row = ws.max_row
        for c in range(1, len(headers) + 1):
            cell = ws.cell(row=head_row, column=c)
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = PatternFill("solid", fgColor="1F3A5F")

        totals: dict[str, list[float]] = {}
        for r in s.query(ARRecord).order_by(ARRecord.id.desc()).all():
            o = ord_map.get(r.order_id)
            cust = cust_names.get(o.customer_id, "—") if o else "—"
            cur = r.currency or "USD"
            overdue = (r.status != ARStatus.PAID and r.due_date and r.due_date < today_str)
            st_label = "연체" if overdue else _enum_val(r.status)
            if status and status not in (st_label, _enum_val(r.status)):
                continue
            if currency and cur != currency:
                continue
            invoice = round(r.invoice_amount or 0, 2)
            paid = round(r.paid_amount or 0, 2)
            outstanding = round(invoice - paid, 2)
            ws.append([r.ci_no or "—", cust, _project_no_for_order(s, o) if o else "—", cur,
                       invoice, paid, outstanding, r.due_date or "—", st_label])
            t = totals.setdefault(cur, [0.0, 0.0, 0.0])
            t[0] += invoice
            t[1] += paid
            t[2] += outstanding

        ws.append([])
        for cur, (inv, paid, out) in sorted(totals.items()):
            ws.append([f"TOTAL ({cur})", "", "", cur, round(inv, 2),
                       round(paid, 2), round(out, 2), "", ""])
            total_row = ws.max_row
            for c in range(1, len(headers) + 1):
                ws.cell(row=total_row, column=c).font = Font(bold=True)

        for col, width in zip("ABCDEFGHI", [16, 22, 14, 9, 14, 14, 14, 12, 10]):
            ws.column_dimensions[col].width = width

        buf = io.BytesIO()
        wb.save(buf)
        return Response(
            content=buf.getvalue(),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="SOA_{today_str}.xlsx"'},
        )
    finally:
        s.close()


@app.post("/api/admin/ar", dependencies=[Depends(require_token)])
def create_ar(body: ARSave):
    s = get_session()
    try:
        order = s.query(Order).filter_by(id=body.order_id).first()
        if not order:
            raise HTTPException(status_code=404, detail="Order를 찾을 수 없습니다.")
        ar = ARRecord(
            order_id=body.order_id,
            ci_no=body.ci_no or "",
            invoice_amount=body.invoice_amount or 0.0,
            paid_amount=body.paid_amount or 0.0,
            currency=body.currency or "USD",
            due_date=body.due_date,
            status=_ar_status_from_text(body.status, body.paid_amount or 0.0, body.invoice_amount or 0.0),
            notes=body.notes or "",
        )
        s.add(ar)
        s.commit()
        return {"ok": True, "id": ar.id}
    finally:
        s.close()


@app.put("/api/admin/ar/{ar_id}", dependencies=[Depends(require_token)])
def update_ar(ar_id: int, body: ARSave):
    s = get_session()
    try:
        ar = s.query(ARRecord).filter_by(id=ar_id).first()
        if not ar:
            raise HTTPException(status_code=404, detail="AR 레코드를 찾을 수 없습니다.")
        if not s.query(Order).filter_by(id=body.order_id).first():
            raise HTTPException(status_code=404, detail="Order를 찾을 수 없습니다.")
        ar.order_id = body.order_id
        ar.ci_no = body.ci_no or ""
        ar.invoice_amount = body.invoice_amount or 0.0
        ar.paid_amount = body.paid_amount or 0.0
        ar.currency = body.currency or "USD"
        ar.due_date = body.due_date
        ar.status = _ar_status_from_text(body.status, ar.paid_amount or 0.0, ar.invoice_amount or 0.0)
        ar.notes = body.notes or ""
        s.commit()
        return {"ok": True, "id": ar.id, "status": _enum_val(ar.status)}
    finally:
        s.close()


@app.delete("/api/admin/ar/{ar_id}", dependencies=[Depends(require_token)])
def delete_ar(ar_id: int):
    s = get_session()
    try:
        ar = s.query(ARRecord).filter_by(id=ar_id).first()
        if not ar:
            raise HTTPException(status_code=404, detail="AR 레코드를 찾을 수 없습니다.")
        s.delete(ar)
        s.commit()
        return {"ok": True}
    finally:
        s.close()


@app.post("/api/admin/ar/{ar_id}/payment", dependencies=[Depends(require_token)])
def ar_payment(ar_id: int, body: ARPayment):
    """수금 등록 — paid_amount 누적 후 상태 자동 갱신."""
    s = get_session()
    try:
        ar = s.query(ARRecord).filter_by(id=ar_id).first()
        if not ar:
            raise HTTPException(status_code=404, detail="AR 레코드를 찾을 수 없습니다.")
        if body.amount <= 0:
            raise HTTPException(status_code=400, detail="수금액은 0보다 커야 합니다.")
        ar.paid_amount = (ar.paid_amount or 0) + body.amount
        if body.due_date:
            ar.due_date = body.due_date
        if ar.paid_amount >= (ar.invoice_amount or 0):
            ar.status = ARStatus.PAID
        elif ar.paid_amount > 0:
            ar.status = ARStatus.PARTIAL
        else:
            ar.status = ARStatus.OUTSTANDING
        s.commit()
        return {"ok": True, "paid_amount": ar.paid_amount, "status": _enum_val(ar.status)}
    finally:
        s.close()
