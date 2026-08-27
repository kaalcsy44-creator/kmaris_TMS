"""Thin wrapper around kmaris_docs that builds the payload dict from DB objects."""
from __future__ import annotations
import json
from pathlib import Path
from typing import Any, Dict, Optional

from services.kmaris_docs import make_pdf, make_tax_invoice_xlsx  # type: ignore
from services.doc_xlsx import (  # type: ignore
    make_commercial_invoice_xlsx, make_packing_list_xlsx, make_proforma_invoice_xlsx,
)

_config_path = Path(__file__).resolve().parent.parent / "config" / "company.json"


def _load_company() -> Dict[str, Any]:
    """문서에 찍히는 회사 정보(레터헤드·계좌). 설정 화면이 저장하는 값과 같은 곳에서 읽는다
    — 예전에는 여기만 파일을 읽어, 화면에서 계좌를 고쳐도 인쇄물은 그대로였다."""
    try:
        from services.company_profile import read_company_profile
        data = read_company_profile()
        if data:
            return data
    except Exception:
        pass
    try:
        with open(_config_path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _customer_dict(customer) -> Dict[str, Any]:
    if customer is None:
        return {}
    return {
        "name": customer.name,
        "address": customer.address or "",
        "contact": customer.contact or "",
        "phone": getattr(customer, "contact_phone", "") or "",
        "email": customer.email or "",
        "tax_id": customer.tax_id or "",
    }


def _vessel_dict(vessel) -> Dict[str, Any]:
    if vessel is None:
        return {}
    return {
        "name": vessel.name,
        "imo": vessel.imo or "",
        "engine_type": vessel.engine_type or "",
        "hull_no": vessel.hull_no or "",
    }


def build_payload(
    doc_no: str,
    date: str,
    customer,
    vessel,
    items: list,
    terms: dict,
    currency: str = "USD",
    vat_rate: float = 0.0,
    valid_until: str = "",
    shipping: Optional[dict] = None,
    po_no: str = "",
    export_ref: str = "",
    tax_invoice: Optional[dict] = None,
    discount_pct: float = 0.0,
    project_title: str = "",
    ref_no: str = "",
    attn: str = "",
    messrs: str = "",
    cost_currency: str = "",
    fx_rate: float = 0.0,
    round_digits: Optional[int] = None,
) -> Dict[str, Any]:
    return {
        "doc_no": doc_no,
        "date": date,
        "valid_until": valid_until,
        "currency": currency,
        "cost_currency": cost_currency or currency,
        "fx_rate": fx_rate,
        "round_digits": round_digits,
        "vat_rate": vat_rate,
        "discount_pct": discount_pct,
        "project_title": project_title,
        "ref_no": ref_no,
        "attn": attn,
        "messrs": messrs,
        "customer": _customer_dict(customer),
        "vessel": _vessel_dict(vessel),
        "items": items,
        "terms": terms or {},
        "shipping": {
            **(shipping or {}),
            "po_no": po_no,
            "export_ref": export_ref,
        },
        "tax_invoice": tax_invoice or {},
    }


def _vendor_party_dict(vendor) -> Dict[str, Any]:
    """Vendor를 PDF의 Supplier/Seller 박스에 넣기 위한 dict (Vendor엔 tax_id 없음)."""
    if vendor is None:
        return {}
    return {
        "name": vendor.name,
        "address": vendor.address or "",
        "contact": vendor.contact or "",
        "phone": getattr(vendor, "contact_phone", "") or "",
        "email": vendor.email or "",
    }


def build_po_payload(
    po_no: str,
    date: str,
    vendor,
    vessel,
    items: list,
    currency: str = "USD",
    terms: Optional[dict] = None,
    project_title: str = "",
) -> Dict[str, Any]:
    """Vendor 발주서(Purchase Order) PDF payload. Supplier 박스에 Vendor 정보가 들어간다.

    발주서 양식의 "1. Order information" 에 프로젝트명이 들어가므로 딜에서 받아 싣는다
    (Vendor RFQ 도 같은 payload 를 쓰지만 그 문서엔 이 칸이 없어 기본값은 빈 문자열)."""
    return {
        "doc_no": po_no,
        "date": date,
        "currency": currency,
        "vat_rate": 0.0,
        "project_title": project_title or "",
        "customer": _vendor_party_dict(vendor),  # rendered as 'Supplier / Seller'
        "vessel": _vessel_dict(vessel),
        "items": items,
        "terms": terms or {},
        "shipping": {},
    }


def generate_pdf(doc_type: str, payload: Dict[str, Any]) -> bytes:
    company = _load_company()
    return make_pdf(doc_type, payload, company=company)


def generate_po_pdf(payload: Dict[str, Any]) -> bytes:
    company = _load_company()
    return make_pdf("purchase_order", payload, company=company)


def generate_tax_xlsx(payload: Dict[str, Any]) -> bytes:
    company = _load_company()
    return make_tax_invoice_xlsx(payload, company)


def generate_pi_xlsx(payload: Dict[str, Any]) -> bytes:
    """Proforma Invoice 전용 Excel(회사 정보 로딩 포함) — PI PDF 와 같은 서식."""
    company = _load_company()
    return make_proforma_invoice_xlsx(payload, company)


def generate_ci_xlsx(payload: Dict[str, Any]) -> bytes:
    """Commercial Invoice 전용 Excel(회사 정보 로딩 포함)."""
    company = _load_company()
    return make_commercial_invoice_xlsx(payload, company)


def generate_pl_xlsx(payload: Dict[str, Any]) -> bytes:
    """Packing List 전용 Excel(회사 정보 로딩 포함)."""
    company = _load_company()
    return make_packing_list_xlsx(payload, company)
