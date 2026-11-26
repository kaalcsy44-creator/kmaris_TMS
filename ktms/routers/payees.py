"""지급처 명부(Payees) — 딜 밖의 돈을 받는 곳과 그 계좌. Finance › Inflow · Outflow › Payees.

규칙
  · 지급(FinancePayable)과는 이름(counterparty)으로 잇는다 — 거래선·소개자 명부와 같은 방식.
    지급처 이름을 바꾸면 같은 이름의 지급 기록도 함께 바꾼다.
  · 계좌는 지급처 한 곳에 둔다. 지급 건의 계좌 칸은 '이번 지급만 다른 계좌'일 때만 남는다.
    (sync_payee_from_payable 이 지급 건에 적힌 계좌를 지급처로 옮긴다 — 지급처 계좌가 비었거나 같을 때.)
  · 거래선(Vendor)·소개자(Consultant)와 이름이 같은 수취인, 거래선지급·소개 수수료 분류는
    여기 들이지 않는다 — 그쪽 명부가 계좌를 갖는다.
"""
from __future__ import annotations

from pydantic import BaseModel

from _core import (
    Consultant,
    Depends,
    FinancePayable,
    HTTPException,
    Vendor,
    app,
    get_session,
    require_token,
)
from db.models import FinancePayee

# 그쪽 명부가 따로 있는 분류 — 거래선지급(Vendor), 소개 수수료(Consultant).
_OTHER_BOOK = {"거래선지급", "컨설팅비"}
_BANK = ("bank_name", "bank_account", "bank_holder")


def _key(name: str | None) -> str:
    return " ".join((name or "").split()).lower()


def payee_by_name(s, name: str | None) -> FinancePayee | None:
    k = _key(name)
    if not k:
        return None
    return next((p for p in s.query(FinancePayee).all() if _key(p.name) == k), None)


def _bank_of(obj) -> tuple[str, str, str]:
    return tuple((getattr(obj, f, None) or "").strip() for f in _BANK)  # type: ignore[return-value]


def _has_other_book(s, name: str) -> bool:
    k = _key(name)
    return (any(_key(v.name) == k for v in s.query(Vendor.name).all())
            or any(_key(c.name) == k for c in s.query(Consultant.name).all()))


def sync_payee_from_payable(s, p: FinancePayable) -> FinancePayee | None:
    """지급 건 → 지급처. 없으면 만들고, 지급 건에 적힌 계좌를 지급처로 옮긴다.
    지급처 계좌가 이미 있고 다르면 지급 건의 계좌는 '이번만 다른 계좌'로 남긴다."""
    name = (p.counterparty or "").strip()
    if not name or p.vendor_id or (p.category or "") in _OTHER_BOOK or _has_other_book(s, name):
        return None
    py = payee_by_name(s, name)
    if py is None:
        py = FinancePayee(name=name, category=p.category or "기타")
        s.add(py)
        s.flush()
    own = _bank_of(p)
    if any(own):
        mine = _bank_of(py)
        if not any(mine) or mine == own:
            for f, v in zip(_BANK, own):
                setattr(py, f, v)
            for f in _BANK:
                setattr(p, f, "")
    return py


def payee_account(s, name: str | None) -> tuple[FinancePayee | None, dict | None]:
    """이름 → (지급처, 계좌 dict 또는 None)."""
    py = payee_by_name(s, name)
    if py is None:
        return None, None
    b = {"bank_name": (py.bank_name or "").strip(), "bank_account": (py.bank_account or "").strip(),
         "bank_holder": (py.bank_holder or "").strip(), "swift": (py.swift or "").strip()}
    return py, (b if (b["bank_account"] or b["bank_name"]) else None)


def _out(py: FinancePayee, stats: dict) -> dict:
    st = stats.get(_key(py.name), {})
    return {
        "id": py.id, "name": py.name or "", "category": py.category or "",
        "bank_name": py.bank_name or "", "bank_account": py.bank_account or "",
        "bank_holder": py.bank_holder or "", "swift": py.swift or "",
        "biz_no": py.biz_no or "", "contact": py.contact or "", "notes": py.notes or "",
        # 이 지급처로 등록된 지급 — 건수와 가장 최근 예정일.
        "payments": st.get("n", 0), "last_due": st.get("last", ""),
        # 이번만 다른 계좌를 적은 지급 수(지급처 계좌를 바꿔도 그 건들은 따라가지 않는다).
        "overrides": st.get("own", 0),
    }


def _stats(s) -> dict:
    out: dict[str, dict] = {}
    for p in s.query(FinancePayable).all():
        k = _key(p.counterparty)
        if not k:
            continue
        st = out.setdefault(k, {"n": 0, "last": "", "own": 0})
        st["n"] += 1
        st["last"] = max(st["last"], (p.due_date or "")[:10])
        if any(_bank_of(p)):
            st["own"] += 1
    return out


class PayeeIn(BaseModel):
    name: str
    category: str = ""
    bank_name: str = ""
    bank_account: str = ""
    bank_holder: str = ""
    swift: str = ""
    biz_no: str = ""
    contact: str = ""
    notes: str = ""


def _apply(py: FinancePayee, body: PayeeIn) -> None:
    for f in ("category", "bank_name", "bank_account", "bank_holder", "swift", "biz_no", "contact", "notes"):
        setattr(py, f, (getattr(body, f) or "").strip())


@app.get("/api/admin/finance/payees", dependencies=[Depends(require_token)])
def list_payees():
    s = get_session()
    try:
        st = _stats(s)
        rows = sorted(s.query(FinancePayee).all(), key=lambda p: _key(p.name))
        return {"rows": [_out(p, st) for p in rows]}
    finally:
        s.close()


@app.post("/api/admin/finance/payees", dependencies=[Depends(require_token)])
def create_payee(body: PayeeIn):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Enter the payee name.")
    s = get_session()
    try:
        if payee_by_name(s, name):
            raise HTTPException(status_code=409, detail=f"“{name}” is already in Payees.")
        py = FinancePayee(name=name)
        _apply(py, body)
        s.add(py)
        s.commit()
        return {"ok": True, "id": py.id}
    finally:
        s.close()


@app.put("/api/admin/finance/payees/{payee_id}", dependencies=[Depends(require_token)])
def update_payee(payee_id: int, body: PayeeIn):
    """고친다. 이름을 바꾸면 같은 이름으로 적힌 지급 기록의 수취인도 함께 바꾼다."""
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Enter the payee name.")
    s = get_session()
    try:
        py = s.query(FinancePayee).filter_by(id=payee_id).first()
        if not py:
            raise HTTPException(status_code=404, detail="Payee not found.")
        other = payee_by_name(s, name)
        if other is not None and other.id != py.id:
            raise HTTPException(status_code=409, detail=f"“{name}” is already in Payees.")
        renamed = 0
        if _key(name) != _key(py.name):
            for p in s.query(FinancePayable).all():
                if _key(p.counterparty) == _key(py.name):
                    p.counterparty = name
                    renamed += 1
        py.name = name
        _apply(py, body)
        s.commit()
        return {"ok": True, "renamed_payments": renamed}
    finally:
        s.close()


@app.delete("/api/admin/finance/payees/{payee_id}", dependencies=[Depends(require_token)])
def delete_payee(payee_id: int):
    """명부에서만 지운다 — 지급 기록은 그대로(이름만 남는다). 계좌는 함께 사라지므로,
    지급 기록이 있는 지급처는 그 기록들에 계좌를 되돌려 적어 둔다."""
    s = get_session()
    try:
        py = s.query(FinancePayee).filter_by(id=payee_id).first()
        if not py:
            raise HTTPException(status_code=404, detail="Payee not found.")
        bank = _bank_of(py)
        if any(bank):
            for p in s.query(FinancePayable).all():
                if _key(p.counterparty) == _key(py.name) and not any(_bank_of(p)):
                    for f, v in zip(_BANK, bank):
                        setattr(p, f, v)
        s.delete(py)
        s.commit()
        return {"ok": True}
    finally:
        s.close()


class PayeeBankIn(BaseModel):
    bank_name: str | None = ""
    bank_account: str | None = ""
    bank_holder: str | None = ""
    swift: str | None = ""


@app.put("/api/admin/finance/payees/{payee_id}/bank", dependencies=[Depends(require_token)])
def save_payee_bank(payee_id: int, body: PayeeBankIn):
    """지급처 계좌만 고친다 — 지급 상세 창의 Pay to 에서. 이 이름의 모든 지급이 따라온다."""
    s = get_session()
    try:
        py = s.query(FinancePayee).filter_by(id=payee_id).first()
        if not py:
            raise HTTPException(status_code=404, detail="Payee not found.")
        py.bank_name = (body.bank_name or "").strip()
        py.bank_account = (body.bank_account or "").strip()
        py.bank_holder = (body.bank_holder or "").strip()
        py.swift = (body.swift or "").strip()
        s.commit()
        return {"ok": True}
    finally:
        s.close()
