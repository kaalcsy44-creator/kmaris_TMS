"""Thin wrapper around kmaris_docs that builds the payload dict from DB objects."""
from __future__ import annotations
import json
from pathlib import Path
from typing import Any, Dict, Optional

from services.kmaris_docs import make_pdf, make_tax_invoice_xlsx  # type: ignore

_config_path = Path(__file__).resolve().parent.parent / "config" / "company.json"


def _load_company() -> Dict[str, Any]:
    with open(_config_path, encoding="utf-8") as f:
        return json.load(f)


def _customer_dict(customer) -> Dict[str, Any]:
    if customer is None:
        return {}
    return {
        "name": customer.name,
        "address": customer.address or "",
        "contact": customer.contact or "",
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
) -> Dict[str, Any]:
    return {
        "doc_no": doc_no,
        "date": date,
        "valid_until": valid_until,
        "currency": currency,
        "vat_rate": vat_rate,
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


def generate_pdf(doc_type: str, payload: Dict[str, Any]) -> bytes:
    company = _load_company()
    return make_pdf(doc_type, payload, company=company)


def generate_tax_xlsx(payload: Dict[str, Any]) -> bytes:
    company = _load_company()
    return make_tax_invoice_xlsx(payload, company)
