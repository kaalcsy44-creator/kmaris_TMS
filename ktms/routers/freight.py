"""K-Maris TMS — freight routes (딜의 배송비: 견적 · 실제 비용 · 고객 청구).

배송비는 buyer 가 직접 낼 때도 있고 우리가 낼 때도 있다. 우리가 내는 딜에서는 돈이 두 갈래로
오간다 — 운송사에 내는 실제 배송비(매입)와, 그것을 고객에게 얹어 받는 청구(PI·CI 의 Freight
또는 별도 청구서). 예전에는 청구한 배송비만 매출에 남고 실제 운송비는 적을 자리가 없어, 딜의
이익이 배송비만큼 부풀어 보였다.

여기서는 새 장부를 만들지 않는다.
  · 견적(FreightQuote) — 운송사별 견적을 견주는 자리. 돈이 아니다.
  · 실제 비용 — 고른 견적을 Finance 지급대장(FinancePayable: 거래선지급 + 이 딜)에 등록한다.
    지급 예정·지급 여부는 그 한 줄에서 읽고, 손익·결산·현금흐름도 그 줄을 이 딜의 매입 원가로
    센다(finance._is_deal_purchase). Finance 에서 고치면 여기에도 그대로 보인다.
  · 고객 청구 — PI·CI 의 terms.freight, 또는 추가 청구서(ARRecord kind="extra").
"""
from __future__ import annotations

from pydantic import BaseModel

from _core import (
    ARRecord,
    ARStatus,
    APRecord,
    Depends,
    File,
    FinancePayable,
    HTTPException,
    RFQ,
    Response,
    UploadFile,
    Vendor,
    _ar_outstanding,
    _doc_disposition,
    _enum_val,
    _latest_pi,
    _ocr_image_media_type,
    _order_cis,
    _orders_for_rfq,
    _pi_charges,
    _project_pi,
    app,
    ar_from_pi,
    date,
    get_current_user,
    get_session,
    require_token,
)
from db.models import CommercialInvoice, FreightQuote, ProformaInvoice
from routers.finance import (VENDOR_CATEGORY, _bank_of, _krw_in, _payable_krw, _payable_overdue, _same_name,
                             _vat_within, _vendor_company)

PAYERS = ("", "buyer", "rebill", "included")
# 배송비만 따로 청구한 추가 청구서의 표식(ARRecord.notes) — 다른 추가 청구와 가린다.
FREIGHT_AR_MARK = "Freight charge"
MAX_FILE = 15 * 1024 * 1024


def _rfq(s, rfq_id: int) -> RFQ:
    r = s.query(RFQ).filter_by(id=rfq_id).first()
    if not r:
        raise HTTPException(status_code=404, detail="프로젝트를 찾을 수 없습니다.")
    return r


def _row(s, rfq_id: int, row_id: int) -> FreightQuote:
    r = s.query(FreightQuote).filter_by(id=row_id, rfq_id=rfq_id).first()
    if not r:
        raise HTTPException(status_code=404, detail="배송비 견적을 찾을 수 없습니다.")
    return r


def _payable_of(s, row: FreightQuote) -> FinancePayable | None:
    """이 견적이 걸린 지급 — Finance 에서 지워졌으면 None(등록 안 한 것으로 본다)."""
    return s.query(FinancePayable).filter_by(id=row.payable_id).first() if row.payable_id else None


def _num(v) -> float:
    try:
        return float(str(v).replace(",", "")) if v not in (None, "") else 0.0
    except (TypeError, ValueError):
        return 0.0


def _payable_out(p: FinancePayable | None) -> dict | None:
    if p is None:
        return None
    vat = float(p.vat_amount or 0)
    return {"id": p.id, "counterparty": p.counterparty or "", "description": p.description or "",
            "amount": round(p.amount or 0, 2), "vat_amount": round(vat, 2),
            "supply_amount": round((p.amount or 0) - vat, 2), "currency": p.currency or "KRW",
            "bill_date": p.bill_date or "", "due_date": p.due_date or "",
            "paid": bool(p.paid), "paid_date": p.paid_date or "",
            "overdue": _payable_overdue(p, bool(p.paid), date.today().isoformat())}


def _payable_bank(s, p: FinancePayable) -> dict | None:
    """이 지급을 보낼 계좌 — 지급 건에 적힌 계좌가 먼저, 없으면 연결 거래선의 계좌
    (Finance 지급 상세와 같은 규칙)."""
    own = _bank_of(p, swift_attr="__none__")
    if own:
        return {**own, "from": "payable"}
    bank = _vendor_company(s, vendor_id=p.vendor_id)[1] if p.vendor_id else None
    return {**bank, "from": "vendor"} if bank else None


def _bank_hint(s, row: FreightQuote) -> dict | None:
    """아직 계좌가 없는 청구서에 미리 채울 계좌 — 연결 거래선, 없으면 같은 운송사에 같은
    통화로 지난번 보낸 계좌."""
    if row.vendor_id:
        bank = _vendor_company(s, vendor_id=row.vendor_id)[1]
        if bank:
            return {**bank, "from": "vendor"}
    if not (row.carrier or "").strip():
        return None
    for p in (s.query(FinancePayable)
              .filter(FinancePayable.category == VENDOR_CATEGORY,
                      FinancePayable.currency == (row.currency or "KRW"),
                      FinancePayable.bank_account.isnot(None), FinancePayable.bank_account != "")
              .order_by(FinancePayable.id.desc()).all()):
        if _same_name(p.counterparty, row.carrier):
            return {**_bank_of(p, swift_attr="__none__"), "from": "previous"}
    return None


def _ym(*dates) -> str:
    return next((d[:7] for d in dates if d and len(d) >= 7), date.today().isoformat()[:7])


def _cost_krw(row: FreightQuote, p: FinancePayable | None) -> float:
    """이 배송의 실제(또는 예정) 비용 — 등록한 지급의 공급가액, 아직이면 견적 금액(원화)."""
    if p is not None:
        return _payable_krw(p, (p.amount or 0) - float(p.vat_amount or 0),
                            _ym(p.paid_date, p.bill_date, p.due_date))
    return _krw_in(row.amount or 0, row.currency or "KRW", _ym(row.quote_date))


def _row_out(row: FreightQuote, p, vendor_names: dict, order_id: int) -> dict:
    return {"id": row.id, "order_id": order_id, "ci_id": row.ci_id or 0,
            "carrier": row.carrier or "", "vendor_id": row.vendor_id,
            "vendor": vendor_names.get(row.vendor_id, "") if row.vendor_id else "",
            "service": row.service or "", "quote_no": row.quote_no or "",
            "quote_date": row.quote_date or "", "valid_until": row.valid_until or "",
            "transit": row.transit or "", "weight": row.weight or "",
            "tracking_no": row.tracking_no or "", "bill_no": row.bill_no or "",
            "currency": row.currency or "KRW", "amount": round(row.amount or 0, 2),
            "vat_amount": round(row.vat_amount or 0, 2),
            "awarded": bool(row.awarded), "notes": row.notes or "",
            "filename": row.filename or "", "cost_krw": round(_cost_krw(row, p)),
            "payable": _payable_out(p)}


def _doc_charges(terms) -> dict:
    t = terms or {}
    return {k: round(_num(t.get(k)), 2) for k in ("freight", "packing", "insurance")}


def _charge_docs(pi, cis, pick: dict) -> tuple[bool, set]:
    """청구액으로 읽을 문서 — (PI 를 읽나, 읽을 CI id 들). PI 와 CI 는 같은 돈이라 한쪽만 읽는다.

    기본은 CI 다(나중에 나온 문서이고, PI 뒤에 운임을 더하는 일이 있다). 운임이 적힌 CI 가 없으면
    PI 를 읽는다. 사람이 화면에서 고른 것(pick: {"pi:8": True, "ci:9": False})이 있으면 그것을 따른다."""
    with_freight = {c.id for c in cis if _doc_charges(c.terms)["freight"]}
    chosen = pick.get(f"pi:{pi.id}") if pi is not None else False
    use_pi = chosen if chosen is not None else not with_freight
    if use_pi:
        return True, set()
    return False, {i for i in with_freight if pick.get(f"ci:{i}", True)}


def _charge_split(doc_freight: float, doc_total: float, pi, ars, cur: str) -> dict:
    """고른 문서의 운임(doc_freight)이 매출채권에 얼마나 서 있나 — 같은 통화의 청구만 견준다.

    main = 본 청구에 들어 있는 몫, extra = 배송비 청구서가 덮은 몫, unbilled = 아직 아무 청구에도 없는 몫.
    PI 를 EXW 로 끊어 선입금까지 받은 뒤 CI 를 DAP 로 바꾸며 운임을 더하면 그만큼이 unbilled 다.
    CI 는 운임·포장·보험을 한 줄로 받기도 해서 본 청구와는 셋의 합으로 견준다."""
    same = [a for a in ars if (a.currency or "USD").upper() == cur]
    mains = [a for a in ars if (a.kind or "main") != "extra"]
    extras = sum((a.invoice_amount or 0) / (1 + (a.vat_rate or 0)) for a in same if _freight_only(a))
    need = 0.0
    # 본 청구가 아직 없거나 통화가 다르면 빠진 몫을 따지지 않는다(앞으로 설 본 청구에 실린다).
    if mains and all((a.currency or "USD").upper() == cur for a in mains):
        on_main = sum(sum(_doc_charges(a.charges).values()) for a in mains)
        if pi is not None and (pi.currency or "USD").upper() == cur:
            on_main = max(on_main, sum(_doc_charges(pi.terms).values()))
        need = min(max(doc_total - on_main, 0.0), doc_freight)
    extra = min(extras, need)
    unbilled = round(need - extra, 2)
    return {"main": round(doc_freight - need, 2), "extra": round(extra, 2),
            "unbilled": unbilled if unbilled >= 0.01 else 0.0}


def _freight_only(a) -> bool:
    return (a.kind or "") == "extra" and (a.notes or "").startswith(FREIGHT_AR_MARK)


def planned_freight_krw(s, rfq_id: int) -> float:
    """고르기만 하고 아직 Finance 에 올리지 않은 배송비(원화) — 딜 요약의 마진이 쓴다.
    (올린 것은 지급대장에서 세고, buyer 가 직접 내는 딜은 우리 원가가 아니다.)"""
    r = s.query(RFQ).filter_by(id=rfq_id).first()
    if not r or ((getattr(r, "freight_info", None) or {}).get("payer") or "") == "buyer":
        return 0.0
    return sum(_cost_krw(row, None) for row in _light(s, rfq_id)
               if row.awarded and _payable_of(s, row) is None)


def _light(s, rfq_id: int):
    """견적 줄들 — 첨부 파일 본문(BLOB)은 읽지 않는다."""
    from sqlalchemy.orm import defer
    return (s.query(FreightQuote).options(defer(FreightQuote.data))
            .filter(FreightQuote.rfq_id == rfq_id).order_by(FreightQuote.id.asc()).all())


@app.get("/api/admin/projects/{rfq_id}/freight", dependencies=[Depends(require_token)])
def project_freight(rfq_id: int):
    """딜의 배송비 한 화면 — 부담 주체 · 견적 · 실제 비용(지급) · 고객 청구 · 수금."""
    s = get_session()
    try:
        rfq = _rfq(s, rfq_id)
        info = dict(getattr(rfq, "freight_info", None) or {})
        payer = info.get("payer") or ""
        orders = _orders_for_rfq(s, rfq_id)
        vendor_names = {v.id: v.name for v in s.query(Vendor.id, Vendor.name).all()}
        only = orders[0].id if len(orders) == 1 else 0

        rows, cost_krw, paid_krw, linked = [], 0.0, 0.0, set()
        for row in _light(s, rfq_id):
            p = _payable_of(s, row)
            if p is not None:
                linked.add(p.id)
            out = _row_out(row, p, vendor_names, row.order_id or only)
            if p is not None:
                out["payable"].update(bank=_payable_bank(s, p), notes=p.notes or "")
            out["bank_hint"] = (_bank_hint(s, row) if (row.awarded or p is not None)
                                and not (p is not None and out["payable"]["bank"]) else None)
            rows.append(out)
            if p is not None or (row.awarded and payer != "buyer"):
                cost_krw += out["cost_krw"]
                if p is not None and p.paid:
                    paid_krw += out["cost_krw"]

        # ── 고객에게 청구한 배송비 — 문서마다 ──
        docs, charged_krw, collected_krw, billing = [], 0.0, 0.0, []
        pick = info.get("charge_docs") or {}
        pis = [(o, _latest_pi(s, o.id)) for o in orders]
        if not any(pi for _, pi in pis):
            pis = [(None, _project_pi(s, rfq_id))]
        ar_rows = []
        for o, pi in pis:
            cis = _order_cis(s, o.id) if o else []
            ars = s.query(ARRecord).filter_by(order_id=o.id).all() if o else []
            mains = [a for a in ars if (a.kind or "main") != "extra"]
            paid_main = bool(mains) and all(_enum_val(a.status) == "완납" for a in mains)
            use_pi, use_cis = _charge_docs(pi, cis, pick)
            picked = ([pi] if use_pi and pi is not None else []) + [c for c in cis if c.id in use_cis]
            if pi is not None:
                docs.append({"kind": "pi", "id": pi.id, "order_id": o.id if o else 0, "no": pi.pi_no or "PI",
                             "date": pi.date or "", "currency": (pi.currency or "USD").upper(),
                             "counted": use_pi, **_doc_charges(pi.terms)})
            for i, ci in enumerate(cis):
                docs.append({"kind": "ci", "id": ci.id, "order_id": o.id, "no": ci.ci_no or f"CI #{i + 1}",
                             "date": ci.date or "", "currency": (ci.currency or "USD").upper(),
                             "counted": ci.id in use_cis, **_doc_charges(ci.terms)})
            for dcur in sorted({(x.currency or "USD").upper() for x in picked}):
                mine = [x for x in picked if (x.currency or "USD").upper() == dcur]
                ch = [_doc_charges(x.terms) for x in mine]
                total = round(sum(c["freight"] for c in ch), 2)
                if not total:
                    continue
                sp = _charge_split(total, sum(sum(c.values()) for c in ch), pi, ars, dcur)
                ym = _ym(mine[0].date)
                charged_krw += _krw_in(sp["main"] + sp["unbilled"], dcur, ym)
                collected_krw += _krw_in(sp["main"], dcur, ym) if paid_main else 0.0
                billing.append({"order_id": o.id if o else 0, "currency": dcur, "amount": total, **sp,
                                "has_main": bool(mains), "main_paid": paid_main})
            for a in ars:
                freight_only = _freight_only(a)
                if (a.kind or "main") == "extra" and not freight_only:
                    continue
                ar_rows.append({"id": a.id, "order_id": o.id, "kind": a.kind or "main",
                                "freight_only": freight_only, "invoice_no": a.invoice_no or a.ci_no or "",
                                "date": a.invoice_date or "", "due_date": a.due_date or "",
                                "currency": (a.currency or "USD").upper(),
                                "amount": round(a.invoice_amount or 0, 2),
                                "freight": round(a.invoice_amount or 0, 2) if freight_only
                                else round(_num((a.charges or {}).get("freight")), 2),
                                "paid_amount": round(a.paid_amount or 0, 2),
                                "outstanding": round(_ar_outstanding(a), 2),
                                "paid": _enum_val(a.status) == "완납", "paid_date": a.paid_date or ""})
                if freight_only:
                    # 배송비 청구서는 전부 청구액이다 — 고른 문서의 운임 중 이것이 덮은 몫(sp["extra"])은
                    # 위에서 더하지 않았다.
                    k = _krw_in(a.invoice_amount or 0, a.currency or "USD", _ym(a.invoice_date))
                    charged_krw += k
                    collected_krw += k if _enum_val(a.status) == "완납" else 0.0

        cur = next((d["currency"] for d in docs), "") or next(
            ((o.currency or "").upper() for o in orders if o.currency), "") or "USD"
        per = _krw_in(1.0, cur, _ym("")) or 1.0

        # 이미 이 딜에 직접 등록된 지급 중 배송비 줄에 안 걸린 것 — 같은 비용을 두 번 적지 않게.
        others = [_payable_out(p) for p in s.query(FinancePayable)
                  .filter(FinancePayable.rfq_id == rfq_id, FinancePayable.category == VENDOR_CATEGORY)
                  .order_by(FinancePayable.id).all() if p.id not in linked]
        # 벤더 청구서에 얹혀 온 운임 — 여기 적지 않아도 이미 매입 원가다.
        vendor_freight = []
        if orders:
            for a in s.query(APRecord).filter(APRecord.order_id.in_([o.id for o in orders])).all():
                f = _num((a.charges or {}).get("freight"))
                if f:
                    vendor_freight.append({"vendor": vendor_names.get(a.vendor_id, ""), "bill_no": a.bill_no or "",
                                           "currency": a.currency or "KRW", "freight": round(f, 2)})
        return {
            "rfq_id": rfq_id,
            "info": {"payer": payer, "account_no": info.get("account_no") or "", "note": info.get("note") or ""},
            "orders": [{"id": o.id, "po_no": o.po_no or "",
                        # 선적 조건은 CI 가 최신이다 — P/O 는 EXW 인데 CI 에서 DAP 로 바뀐 딜이 있다.
                        "incoterms": next((t for t in ((c.terms or {}).get("incoterms") for c in _order_cis(s, o.id)) if t), "")
                                     or (o.terms or {}).get("incoterms") or "",
                        "packages": [{"ci_id": c.id, "ci_no": c.ci_no or ""} for c in _order_cis(s, o.id)]}
                       for o in orders],
            "rows": rows, "docs": docs, "ar": ar_rows, "billing": billing, "other_payables": others,
            "vendor_freight": vendor_freight,
            "currency": cur, "krw_per": round(per, 4),
            "totals": {"cost_krw": round(cost_krw), "paid_krw": round(paid_krw),
                       "charged_krw": round(charged_krw), "collected_krw": round(collected_krw)},
        }
    finally:
        s.close()


class FreightInfoIn(BaseModel):
    payer: str = ""
    account_no: str = ""
    note: str = ""


@app.put("/api/admin/projects/{rfq_id}/freight-info", dependencies=[Depends(require_token)])
def save_freight_info(rfq_id: int, body: FreightInfoIn):
    if body.payer not in PAYERS:
        raise HTTPException(status_code=400, detail="payer 값이 올바르지 않습니다.")
    s = get_session()
    try:
        r = _rfq(s, rfq_id)
        # 청구에 넣을 문서 고르기(charge_docs)는 따로 저장한다 — 여기서 지우지 않는다.
        keep = (getattr(r, "freight_info", None) or {}).get("charge_docs")
        info = {k: v for k, v in {"charge_docs": keep, "payer": body.payer, "account_no": body.account_no.strip()[:80],
                                  "note": body.note.strip()[:500]}.items() if v}
        r.freight_info = info or None
        s.commit()
        return {"ok": True}
    finally:
        s.close()


class FreightRowIn(BaseModel):
    order_id: int | None = None
    ci_id: int | None = None       # 포장(CI). 비우면 이 선적 전체.
    carrier: str = ""
    vendor_id: int | None = None
    service: str = ""
    quote_no: str = ""
    quote_date: str = ""
    valid_until: str = ""
    transit: str = ""
    weight: str = ""
    tracking_no: str = ""
    bill_no: str = ""
    currency: str = "KRW"
    amount: float = 0.0            # 공급가액(부가세 별도)
    vat_amount: float = 0.0
    awarded: bool = False
    notes: str = ""


def _apply_row(s, row: FreightQuote, body: FreightRowIn) -> None:
    if not (body.carrier.strip() or body.vendor_id):
        raise HTTPException(status_code=400, detail="Enter the carrier or forwarder.")
    order_ids = {o.id for o in _orders_for_rfq(s, row.rfq_id)}
    was = (row.ci_id or 0, row.order_id or 0)
    row.order_id = body.order_id if body.order_id in order_ids else None
    ci = s.query(CommercialInvoice).filter_by(id=body.ci_id).first() if body.ci_id else None
    row.ci_id = ci.id if ci and ci.order_id in order_ids else None
    for k, n in (("carrier", 120), ("service", 120), ("quote_no", 80), ("transit", 80), ("weight", 80),
                 ("tracking_no", 80), ("bill_no", 80)):
        setattr(row, k, (getattr(body, k) or "").strip()[:n])
    for k in ("quote_date", "valid_until"):
        setattr(row, k, (getattr(body, k) or "").strip()[:10])
    row.vendor_id = body.vendor_id or None
    if not row.carrier and row.vendor_id:
        v = s.query(Vendor).filter_by(id=row.vendor_id).first()
        row.carrier = (v.name or "")[:120] if v else ""
    row.currency = (body.currency or "KRW").upper()[:10]
    row.amount = round(body.amount or 0, 2)
    row.vat_amount = round(body.vat_amount or 0, 2)
    row.notes = (body.notes or "").strip()
    if body.awarded and (not row.awarded or was != (row.ci_id or 0, row.order_id or 0)):
        # 같은 자리(같은 포장)의 다른 견적은 고른 것에서 빠진다 — 이미 지급에 등록한 것은 남긴다.
        for other in _light(s, row.rfq_id):
            if (other.id != row.id and other.awarded and not other.payable_id
                    and (other.ci_id or 0) == (row.ci_id or 0) and (other.order_id or 0) == (row.order_id or 0)):
                other.awarded = False
    row.awarded = bool(body.awarded)


@app.post("/api/admin/projects/{rfq_id}/freight", dependencies=[Depends(require_token)])
def create_freight(rfq_id: int, body: FreightRowIn):
    s = get_session()
    try:
        _rfq(s, rfq_id)
        row = FreightQuote(rfq_id=rfq_id, awarded=False)
        s.add(row)
        s.flush()
        _apply_row(s, row, body)
        s.commit()
        return {"ok": True, "id": row.id}
    finally:
        s.close()


@app.put("/api/admin/projects/{rfq_id}/freight/{row_id}", dependencies=[Depends(require_token)])
def update_freight(rfq_id: int, row_id: int, body: FreightRowIn):
    s = get_session()
    try:
        row = _row(s, rfq_id, row_id)
        _apply_row(s, row, body)
        s.commit()
        return {"ok": True, "id": row.id}
    finally:
        s.close()


@app.delete("/api/admin/projects/{rfq_id}/freight/{row_id}", dependencies=[Depends(require_token)])
def delete_freight(rfq_id: int, row_id: int):
    s = get_session()
    try:
        row = _row(s, rfq_id, row_id)
        if _payable_of(s, row) is not None:
            raise HTTPException(status_code=400,
                detail="Finance 지급에 등록된 배송비입니다. 먼저 'Remove from Finance' 로 등록을 푸세요.")
        s.delete(row)
        s.commit()
        return {"ok": True}
    finally:
        s.close()


# ── 견적서·청구서 파일 ────────────────────────────────────────────────────────
@app.post("/api/admin/documents-freight/parse", dependencies=[Depends(require_token)])
def parse_freight(file: UploadFile = File(...)):
    """운송사 견적서·청구서(PDF·이미지) → 운송사·금액·번호 등. 저장하지 않는다."""
    from services.pdf_parser import parse_freight_image, parse_freight_pdf_document
    media = _ocr_image_media_type(file)
    try:
        file.file.seek(0)
        if media:
            data = parse_freight_image(file.file.read(), media)
        elif (file.filename or "").lower().endswith(".pdf"):
            data = parse_freight_pdf_document(file.file.read())
        else:
            raise HTTPException(status_code=400, detail="PDF 또는 이미지 파일만 읽을 수 있습니다.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"배송비 문서 인식 실패: {exc}") from exc
    import re
    out = {}
    for k, v in data.items():
        if k in ("amount", "vat_amount"):
            out[k] = round(_num(v), 2)
        elif k == "accounts":
            out[k] = [a for a in ({f: " ".join(str(x.get(f) or "").split())[:120]
                                   for f in ("bank_name", "bank_account", "bank_holder")}
                                  for x in (v or [])) if a["bank_account"]]
        elif k != "truncated":
            out[k] = " ".join(str(v or "").split())[:400 if k == "pay_ref" else 200]
    for k in ("quote_date", "valid_until", "bill_date", "due_date"):
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", out.get(k, "")):
            out[k] = ""
    out["currency"] = (out.get("currency") or "").upper()[:3]
    return out


@app.post("/api/admin/projects/{rfq_id}/freight/{row_id}/file", dependencies=[Depends(require_token)])
def upload_freight_file(rfq_id: int, row_id: int, file: UploadFile = File(...)):
    s = get_session()
    try:
        row = _row(s, rfq_id, row_id)
        file.file.seek(0)
        data = file.file.read()
        if not data:
            raise HTTPException(status_code=400, detail="빈 파일입니다.")
        if len(data) > MAX_FILE:
            raise HTTPException(status_code=400, detail="파일이 15MB 를 넘습니다.")
        row.filename, row.mime, row.data = ((file.filename or "freight")[:255],
                                            (file.content_type or "application/octet-stream")[:120], data)
        s.commit()
        return {"ok": True, "filename": row.filename}
    finally:
        s.close()


@app.get("/api/admin/projects/{rfq_id}/freight/{row_id}/file", dependencies=[Depends(require_token)])
def download_freight_file(rfq_id: int, row_id: int):
    s = get_session()
    try:
        row = _row(s, rfq_id, row_id)
        if not row.data:
            raise HTTPException(status_code=404, detail="첨부 파일이 없습니다.")
        return Response(content=row.data, media_type=row.mime or "application/octet-stream",
                        headers={"Content-Disposition": _doc_disposition(row.filename or "freight")})
    finally:
        s.close()


# ── 실제 비용 = Finance 지급 ──────────────────────────────────────────────────
class FreightPayableIn(BaseModel):
    # 이미 이 딜에 등록된 지급을 잇는 경우(새로 만들지 않는다).
    payable_id: int | None = None
    supply_amount: float = 0.0
    vat_amount: float = 0.0
    currency: str = "KRW"
    bill_no: str = ""
    bill_date: str = ""
    due_date: str = ""
    # 입금 계좌·납부 참고(입금자명·지로번호…) — 보내지 않은 칸(None)은 저장된 값을 지킨다.
    bank_name: str | None = None
    bank_account: str | None = None
    bank_holder: str | None = None
    pay_ref: str | None = None


def _apply_bank(s, p: FinancePayable, body: FreightPayableIn) -> None:
    given = {k: (getattr(body, k) or "").strip()[:120] for k in ("bank_name", "bank_account", "bank_holder")
             if getattr(body, k) is not None}
    if given:
        # 거래선 명부의 계좌 그대로면 지급 건에는 베끼지 않는다 — 명부에서 바뀌면 함께 바뀌게.
        vendor = _vendor_company(s, vendor_id=p.vendor_id)[1] if p.vendor_id else None
        same = bool(vendor) and all(vendor[k] == v for k, v in given.items())
        for k, v in given.items():
            setattr(p, k, "" if same else v)
    if body.pay_ref is not None:
        p.notes = body.pay_ref.strip()


def _payable_desc(s, row: FreightQuote) -> str:
    bits = ["Freight", row.carrier or ""]
    if row.ci_id:
        ci = s.query(CommercialInvoice).filter_by(id=row.ci_id).first()
        if ci and ci.ci_no:
            bits.append(ci.ci_no)
    if row.tracking_no:
        bits.append(row.tracking_no)
    if row.bill_no:
        bits.append(f"Bill {row.bill_no}")
    return " · ".join(b for b in bits if b)[:200]


@app.post("/api/admin/projects/{rfq_id}/freight/{row_id}/payable", dependencies=[Depends(require_token)])
def save_freight_payable(rfq_id: int, row_id: int, body: FreightPayableIn,
                         user: dict = Depends(get_current_user)):
    """실제 배송비를 Finance 지급대장에 등록·수정한다(거래선지급 + 이 딜). 납부 여부는 Finance 규약."""
    s = get_session()
    try:
        row = _row(s, rfq_id, row_id)
        p = _payable_of(s, row)
        if body.payable_id:
            if p is not None:
                raise HTTPException(status_code=400, detail="이미 Finance 지급에 등록된 배송비입니다.")
            p = (s.query(FinancePayable)
                 .filter_by(id=body.payable_id, rfq_id=rfq_id, category=VENDOR_CATEGORY).first())
            if p is None:
                raise HTTPException(status_code=404, detail="이 딜의 지급이 아닙니다.")
            if s.query(FreightQuote.id).filter(FreightQuote.payable_id == p.id, FreightQuote.id != row.id).first():
                raise HTTPException(status_code=400, detail="다른 배송비에 이미 이어진 지급입니다.")
        else:
            if not (body.due_date or "").strip():
                raise HTTPException(status_code=400, detail="Enter a due date.")
            if (body.supply_amount or 0) <= 0:
                raise HTTPException(status_code=400, detail="Enter the actual freight amount.")
            if p is not None and p.paid and (
                    round(p.amount or 0, 2) != round((body.supply_amount or 0) + (body.vat_amount or 0), 2)
                    or (p.currency or "KRW") != (body.currency or "KRW").upper()):
                raise HTTPException(status_code=400,
                    detail="이미 지급 처리된 배송비입니다. 금액을 고치려면 Finance 에서 지급을 먼저 취소하세요.")
            row.bill_no = (body.bill_no or "").strip()[:80]
            if p is None:
                p = FinancePayable(category=VENDOR_CATEGORY, rfq_id=rfq_id, recurrence="none", paid=False,
                                   paid_dates=[], notes="", owner_id=user.get("id") or None)
                s.add(p)
            total = round((body.supply_amount or 0) + (body.vat_amount or 0), 2)
            p.counterparty = row.carrier or p.counterparty or ""
            p.vendor_id = row.vendor_id
            p.description = _payable_desc(s, row)
            p.amount = total
            p.vat_amount = _vat_within(total, body.vat_amount)
            p.currency = (body.currency or "KRW").upper()
            p.bill_date = (body.bill_date or "").strip()[:10]
            p.due_date = (body.due_date or "").strip()[:10]
            _apply_bank(s, p, body)
        s.flush()
        row.payable_id = p.id
        row.awarded = True
        s.commit()
        return {"ok": True, "payable_id": p.id}
    finally:
        s.close()


@app.delete("/api/admin/projects/{rfq_id}/freight/{row_id}/payable", dependencies=[Depends(require_token)])
def remove_freight_payable(rfq_id: int, row_id: int):
    """Finance 등록 취소 — 아직 안 낸 지급만 지운다(이미 나간 돈의 기록은 남긴다)."""
    s = get_session()
    try:
        row = _row(s, rfq_id, row_id)
        p = _payable_of(s, row)
        if p is not None and p.paid:
            raise HTTPException(status_code=400,
                detail="이미 지급 처리된 배송비입니다. Finance 에서 지급을 먼저 취소하세요.")
        if p is not None:
            s.delete(p)
        row.payable_id = None
        s.commit()
        return {"ok": True}
    finally:
        s.close()


# ── 고객 청구 ────────────────────────────────────────────────────────────────
class FreightChargeDocIn(BaseModel):
    kind: str                   # pi | ci
    doc_id: int
    include: bool = True


@app.put("/api/admin/projects/{rfq_id}/freight-charge-doc", dependencies=[Depends(require_token)])
def pick_charge_doc(rfq_id: int, body: FreightChargeDocIn):
    """이 문서의 운임을 청구액에 넣을지 — PI 와 CI 는 같은 돈이라 한 P/O 에서 한쪽만 켜진다."""
    s = get_session()
    try:
        r = _rfq(s, rfq_id)
        order_ids = {o.id for o in _orders_for_rfq(s, rfq_id)}
        model = {"pi": ProformaInvoice, "ci": CommercialInvoice}.get(body.kind)
        doc = s.query(model).filter_by(id=body.doc_id).first() if model else None
        if not doc or not (doc.order_id in order_ids
                           or (body.kind == "pi" and doc.order_id is None and doc.rfq_id == rfq_id)):
            raise HTTPException(status_code=404, detail="이 딜의 문서가 아닙니다.")
        info = dict(getattr(r, "freight_info", None) or {})
        pick = dict(info.get("charge_docs") or {})
        pick[f"{body.kind}:{doc.id}"] = bool(body.include)
        if body.include and doc.order_id:
            if body.kind == "ci":
                for p in s.query(ProformaInvoice.id).filter_by(order_id=doc.order_id).all():
                    pick[f"pi:{p.id}"] = False
            else:
                # PI 로 읽는 동안 CI 는 꺼진다 — 나중에 PI 를 끄고 CI 를 켤 수 있게 선택은 비운다.
                for c in s.query(CommercialInvoice.id).filter_by(order_id=doc.order_id).all():
                    pick.pop(f"ci:{c.id}", None)
        elif body.kind == "pi" and doc.order_id:
            # PI 를 끄면 청구 없음 — CI 가 저절로 켜지지 않게 적어 둔다.
            for c in s.query(CommercialInvoice.id).filter_by(order_id=doc.order_id).all():
                pick[f"ci:{c.id}"] = False
        elif body.kind == "ci" and doc.order_id:
            for p in s.query(ProformaInvoice.id).filter_by(order_id=doc.order_id).all():
                pick[f"pi:{p.id}"] = False
        r.freight_info = {**info, "charge_docs": pick}
        s.commit()
        return {"ok": True}
    finally:
        s.close()


class FreightChargeIn(BaseModel):
    target: str                 # pi | ci | invoice(배송비만 별도 청구서)
    doc_id: int = 0             # pi·ci 의 id
    order_id: int = 0           # invoice 일 때 이 오더
    amount: float = 0.0
    currency: str = ""
    due_date: str = ""
    description: str = ""


@app.post("/api/admin/projects/{rfq_id}/freight-charge", dependencies=[Depends(require_token)])
def charge_freight(rfq_id: int, body: FreightChargeIn):
    """배송비를 고객에게 청구한다 — PI·CI 의 Freight 칸에 적거나, 배송비만 별도 청구서(AR)로."""
    if (body.amount or 0) < 0:
        raise HTTPException(status_code=400, detail="금액이 올바르지 않습니다.")
    s = get_session()
    try:
        _rfq(s, rfq_id)
        orders = {o.id: o for o in _orders_for_rfq(s, rfq_id)}
        amount = round(body.amount or 0, 2)
        text = str(int(amount)) if amount == int(amount) else str(amount)

        def main_paid(order_id: int) -> bool:
            return any((a.paid_amount or 0) > 0 for a in s.query(ARRecord).filter_by(order_id=order_id).all()
                       if (a.kind or "main") != "extra")

        if body.target == "pi":
            pi = s.query(ProformaInvoice).filter_by(id=body.doc_id).first()
            if not pi or not (pi.order_id in orders or (pi.order_id is None and pi.rfq_id == rfq_id)):
                raise HTTPException(status_code=404, detail="이 딜의 Proforma Invoice 가 아닙니다.")
            if pi.order_id and main_paid(pi.order_id):
                raise HTTPException(status_code=409,
                    detail="이미 수금된 청구입니다 — PI 금액을 바꾸면 받은 돈과 어긋납니다. 배송비는 별도 청구서(Separate invoice)로 청구하세요.")
            pi.terms = {**(pi.terms or {}), "freight": text}
            s.flush()
            ar = ar_from_pi(s, orders[pi.order_id], pi) if pi.order_id else None
            # 자동 청구(AR)가 아닌 본 청구가 이미 있으면 그쪽은 사람이 고쳐야 한다.
            manual = bool(pi.order_id) and ar is None and bool(
                [a for a in s.query(ARRecord).filter_by(order_id=pi.order_id).all() if (a.kind or "main") != "extra"])
            s.commit()
            return {"ok": True, "ar_updated": ar is not None, "ar_manual": manual,
                    "charges": _pi_charges(pi)}
        if body.target == "ci":
            ci = s.query(CommercialInvoice).filter_by(id=body.doc_id).first()
            if not ci or ci.order_id not in orders:
                raise HTTPException(status_code=404, detail="이 딜의 Commercial Invoice 가 아닙니다.")
            ci.terms = {**(ci.terms or {}), "freight": text}
            s.commit()
            return {"ok": True, "ar_updated": False, "ar_manual": False}
        if body.target == "invoice":
            order = orders.get(body.order_id) or (next(iter(orders.values())) if len(orders) == 1 else None)
            if order is None:
                raise HTTPException(status_code=400, detail="고객 P/O 가 있어야 별도 청구서를 만들 수 있습니다.")
            if amount <= 0:
                raise HTTPException(status_code=400, detail="Enter the freight amount to charge.")
            rate = 0.1 if (order.trade_type or "수출") == "내수" else 0.0
            used = {a.invoice_no for a in s.query(ARRecord).filter_by(order_id=order.id).all()}
            base = f"{order.po_no or f'ORD{order.id}'}-FRT"
            no, n = base, 2
            while no in used:
                no, n = f"{base}-{n}", n + 1
            desc = (body.description or "").strip()[:200] or "Freight charge"
            today = date.today().isoformat()
            ar = ARRecord(order_id=order.id, kind="extra", invoice_no=no, invoice_date=today,
                          due_date=(body.due_date or "").strip()[:10] or today,
                          currency=(body.currency or order.currency or "USD").upper(),
                          vat_rate=rate, paid_amount=0.0, status=ARStatus.OUTSTANDING,
                          invoice_amount=round(amount * (1 + rate), 2), charges={},
                          items=[{"part_no": "", "description": desc, "qty": 1, "unit": "LOT",
                                  "unit_price": amount, "amount": amount, "remark": ""}],
                          notes=FREIGHT_AR_MARK)
            s.add(ar)
            s.commit()
            return {"ok": True, "ar_id": ar.id, "invoice_no": no}
        raise HTTPException(status_code=400, detail="target 이 올바르지 않습니다.")
    finally:
        s.close()
