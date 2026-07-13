from __future__ import annotations

import io
import json
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Dict, List, Optional

from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
from openpyxl.utils import get_column_letter

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    Image,
)

def _register_default_font() -> tuple[str, str]:
    bundled_fonts = Path(__file__).resolve().parent.parent / "config" / "fonts"
    candidates = [
        (str(bundled_fonts / "NotoSansKR-Regular.ttf"), str(bundled_fonts / "NotoSansKR-Bold.ttf")),
        ("/usr/share/fonts/truetype/nanum/NanumBarunGothic.ttf", "/usr/share/fonts/truetype/nanum/NanumBarunGothicBold.ttf"),
        ("/usr/share/fonts/truetype/nanum/NanumGothic.ttf", "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf"),
        ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"),
        ("C:/Windows/Fonts/malgun.ttf", "C:/Windows/Fonts/malgunbd.ttf"),
        ("/Library/Fonts/AppleGothic.ttf", "/Library/Fonts/AppleGothic.ttf"),
    ]
    for regular, bold in candidates:
        try:
            if Path(regular).exists():
                pdfmetrics.registerFont(TTFont("KMBaseFont", regular))
                if Path(bold).exists():
                    pdfmetrics.registerFont(TTFont("KMBoldFont", bold))
                    return "KMBaseFont", "KMBoldFont"
                return "KMBaseFont", "KMBaseFont"
        except Exception:
            continue
    try:
        pdfmetrics.registerFont(UnicodeCIDFont("HYGothic-Medium"))
        return "HYGothic-Medium", "HYGothic-Medium"
    except Exception:
        return "Helvetica", "Helvetica-Bold"


DEFAULT_FONT, DEFAULT_BOLD_FONT = _register_default_font()

NAVY = colors.HexColor("#0B1D3A")
BLUE = colors.HexColor("#0055A8")
LIGHT_BLUE = colors.HexColor("#EAF3FF")
LIGHT_GRAY = colors.HexColor("#F4F6F8")
MID_GRAY = colors.HexColor("#D8DEE6")
DARK_GRAY = colors.HexColor("#3A3F44")

DOC_TITLES = {
    "quotation": "QUOTATION",
    "vendor_rfq": "REQUEST FOR QUOTATION",
    "purchase_order": "PURCHASE ORDER",
    "proforma_invoice": "PROFORMA INVOICE",
    "commercial_invoice": "COMMERCIAL INVOICE",
    "packing_list": "PACKING LIST",
    "shipping_advice": "SHIPPING ADVICE",
}

DOC_PREFIX = {
    "quotation": "QTN",
    "purchase_order": "PO",
    "proforma_invoice": "PI",
    "commercial_invoice": "CI",
    "packing_list": "PL",
    "shipping_advice": "SA",
    "tax_invoice_data": "TAX",
}


def load_json(path: str | Path) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def make_doc_no(doc_type: str, sequence: int = 1, company_prefix: str = "KMS") -> str:
    year = date.today().year
    prefix = DOC_PREFIX.get(doc_type, "DOC")
    return f"{company_prefix}-{prefix}-{year}-{sequence:04d}"


def _money(value: Any, currency: str = "USD") -> str:
    try:
        q = Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        return f"{currency} {q:,.2f}"
    except Exception:
        return f"{currency} 0.00"


def _num(value: Any) -> float:
    try:
        return float(value)
    except Exception:
        return 0.0


def normalize_items(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    normalized: List[Dict[str, Any]] = []
    for i, raw in enumerate(items, start=1):
        qty = _num(raw.get("qty", 0))
        unit_price = _num(raw.get("unit_price", 0))
        amount = raw.get("amount")
        if amount in (None, "", 0):
            amount = qty * unit_price
        normalized.append(
            {
                "item_no": raw.get("item_no") or i,
                "part_no": raw.get("part_no", ""),
                "description": raw.get("description", ""),
                "maker": raw.get("maker", ""),
                "origin": raw.get("origin", ""),
                "qty": qty,
                "unit": raw.get("unit", "PCS"),
                "unit_price": unit_price,
                "amount": _num(amount),
                "lead_time": raw.get("lead_time", ""),
                "remark": raw.get("remark", ""),
                "gross_weight": raw.get("gross_weight", ""),
                "net_weight": raw.get("net_weight", ""),
                "package": raw.get("package", ""),
                "pkg_qty": raw.get("pkg_qty", ""),
                "pkg_kind": raw.get("pkg_kind", ""),
                "measurement": raw.get("measurement", ""),
                "dimension": raw.get("dimension", ""),
                "hs_code": raw.get("hs_code", ""),
            }
        )
    return normalized


def calc_totals(
    items: List[Dict[str, Any]], vat_rate: float = 0.0, discount_pct: float = 0.0
) -> Dict[str, float]:
    subtotal = sum(_num(item.get("amount", 0)) for item in normalize_items(items))
    discount = subtotal * (_num(discount_pct) / 100.0)
    discounted = subtotal - discount
    vat = discounted * _num(vat_rate)
    total = discounted + vat
    return {
        "subtotal": subtotal,
        "discount_pct": _num(discount_pct),
        "discount": discount,
        "discounted": discounted,
        "vat": vat,
        "total": total,
    }


def _styles() -> Dict[str, ParagraphStyle]:
    styles = getSampleStyleSheet()
    base = ParagraphStyle(
        "KMBase",
        parent=styles["Normal"],
        fontName=DEFAULT_FONT,
        fontSize=8.2,
        leading=10.2,
        textColor=colors.black,
    )
    return {
        "base": base,
        "small": ParagraphStyle("KMSmall", parent=base, fontSize=7.3, leading=9.0),
        "tiny": ParagraphStyle("KMTiny", parent=base, fontSize=6.6, leading=8.2),
        # 품목 표 헤더 — NAVY 배경 위 글자. tiny(검정)를 쓰면 검정 on 남색으로 안 보이므로
        # 반드시 흰색 볼드 스타일을 별도로 둔다.
        "th": ParagraphStyle(
            "KMTh",
            parent=base,
            fontName=DEFAULT_BOLD_FONT,
            fontSize=6.6,
            leading=8.2,
            textColor=colors.white,
        ),
        "title": ParagraphStyle(
            "KMTitle",
            parent=base,
            fontName=DEFAULT_BOLD_FONT,
            fontSize=20,
            leading=24,
            alignment=TA_RIGHT,
            textColor=NAVY,
        ),
        "subtitle": ParagraphStyle(
            "KMSubtitle",
            parent=base,
            fontSize=8.8,
            leading=11,
            alignment=TA_RIGHT,
            textColor=DARK_GRAY,
        ),
        "section": ParagraphStyle(
            "KMSection",
            parent=base,
            fontName=DEFAULT_BOLD_FONT,
            fontSize=9,
            leading=11,
            textColor=colors.white,
        ),
        "right": ParagraphStyle("KMRight", parent=base, alignment=TA_RIGHT),
        "center": ParagraphStyle("KMCenter", parent=base, alignment=TA_CENTER),
    }


def _p(text: Any, style: ParagraphStyle) -> Paragraph:
    safe = "" if text is None else str(text)
    safe = (
        safe.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\n", "<br/>")
    )
    # Allow only minimal internal markup used by this template.
    safe = safe.replace("&lt;b&gt;", "<b>").replace("&lt;/b&gt;", "</b>")
    return Paragraph(safe, style)


def _header(company: Dict[str, Any], doc_title: str, logo_path: Optional[str] = None):
    s = _styles()
    left_lines = [
        f"<b>{company.get('company_name_en', 'K-MARIS Energy & Solutions Co., Ltd.')}</b>",
        company.get("company_name_kr", ""),
        company.get("address", ""),
        f"Tel: {company.get('phone', '')} | Email: {company.get('general_email', '')}",
        f"Website: {company.get('website', '')}",
        f"{company.get('tagline', '')}",
    ]
    left = _p("\n".join([x for x in left_lines if x]), s["base"])
    if logo_path and Path(logo_path).exists():
        try:
            logo = Image(logo_path, width=32 * mm, height=18 * mm)
            left = Table([[logo, left]], colWidths=[36 * mm, 100 * mm])
            left.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
        except Exception:
            pass
    right = [
        _p(f"<b>{doc_title}</b>", s["title"]),
        _p("Marine Equipment | Engine Parts | Bunkering | Technical Solutions", s["subtitle"]),
    ]
    table = Table([[left, right]], colWidths=[160 * mm, 110 * mm])
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                ("LINEBELOW", (0, 0), (-1, -1), 1, BLUE),
            ]
        )
    )
    return table


def _info_tables(data: Dict[str, Any], doc_type: str):
    s = _styles()
    customer = data.get("customer", {})
    vessel = data.get("vessel", {})
    terms = data.get("terms", {})
    shipping = data.get("shipping", {})

    is_po = doc_type == "purchase_order"
    is_rfq = doc_type == "vendor_rfq"
    party_label = (
        "To (Vendor / Supplier)" if is_rfq
        else "Supplier / Seller" if is_po
        else "Customer / Buyer"
    )
    left_rows = [
        [_p(f"<b>{party_label}</b>", s["base"]), _p(customer.get("name", ""), s["base"])],
        [_p("Address", s["base"]), _p(customer.get("address", ""), s["base"])],
        [_p("Contact", s["base"]), _p(customer.get("contact", ""), s["base"])],
        [_p("Email", s["base"]), _p(customer.get("email", ""), s["base"])],
    ]
    mid_rows = [
        [_p("<b>Vessel</b>", s["base"]), _p(vessel.get("name", ""), s["base"])],
        [_p("IMO No.", s["base"]), _p(vessel.get("imo", ""), s["base"])],
        [_p("Engine Type", s["base"]), _p(vessel.get("engine_type", ""), s["base"])],
        [_p("Hull No.", s["base"]), _p(vessel.get("hull_no", ""), s["base"])],
    ]

    right_rows = [
        [_p("<b>Document No.</b>", s["base"]), _p(data.get("doc_no", ""), s["base"])],
        [_p("Date", s["base"]), _p(data.get("date", ""), s["base"])],
        [_p("Currency", s["base"]), _p(data.get("currency", "USD"), s["base"])],
        [_p("Incoterms", s["base"]), _p(terms.get("incoterms", ""), s["base"])],
    ]
    if doc_type == "quotation":
        right_rows.append([_p("Validity", s["base"]), _p(data.get("valid_until", ""), s["base"])])
    if doc_type in {"commercial_invoice", "packing_list", "shipping_advice"}:
        right_rows.extend(
            [
                [_p("PO No.", s["base"]), _p(shipping.get("po_no", ""), s["base"])],
                [_p("Export Ref.", s["base"]), _p(shipping.get("export_ref", ""), s["base"])],
            ]
        )

    def box(title, rows):
        table = Table(rows, colWidths=[28 * mm, 58 * mm])
        table.setStyle(
            TableStyle(
                [
                    ("GRID", (0, 0), (-1, -1), 0.3, MID_GRAY),
                    ("BACKGROUND", (0, 0), (0, -1), LIGHT_GRAY),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 4),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                    ("TOPPADDING", (0, 0), (-1, -1), 3),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ]
            )
        )
        return table

    outer = Table(
        [[box("Supplier" if is_po else "Customer", left_rows),
          box("Vessel", mid_rows), box("Doc", right_rows)]],
        colWidths=[90 * mm, 90 * mm, 90 * mm],
    )
    outer.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
    return outer


def _items_table(data: Dict[str, Any], doc_type: str):
    s = _styles()
    currency = data.get("currency", "USD")
    items = normalize_items(data.get("items", []))

    if doc_type == "packing_list":
        headers = ["No.", "Part No.", "Description", "Qty", "Unit", "Package", "N.W.", "G.W.", "Dimension", "Remark"]
        widths = [10, 30, 65, 15, 16, 28, 20, 20, 34, 32]
        rows = [[_p(h, s["th"]) for h in headers]]
        for item in items:
            rows.append(
                [
                    _p(item["item_no"], s["tiny"]),
                    _p(item["part_no"], s["tiny"]),
                    _p(item["description"], s["tiny"]),
                    _p(str(item["qty"]), s["tiny"]),
                    _p(item["unit"], s["tiny"]),
                    _p(item.get("package", ""), s["tiny"]),
                    _p(item.get("net_weight", ""), s["tiny"]),
                    _p(item.get("gross_weight", ""), s["tiny"]),
                    _p(item.get("dimension", ""), s["tiny"]),
                    _p(item.get("remark", ""), s["tiny"]),
                ]
            )
    elif doc_type == "vendor_rfq":
        # 견적요청서 — 단가/납기/원산지는 공급사가 채우도록 빈칸으로 둔다.
        headers = ["No.", "Part No.", "Description", "Maker", "Qty", "Unit",
                   "Unit Price\n(to quote)", "Lead Time", "Country\nof Origin", "Remark"]
        widths = [10, 30, 64, 32, 15, 16, 26, 24, 28, 43]
        rows = [[_p(h, s["th"]) for h in headers]]
        for item in items:
            rows.append(
                [
                    _p(item["item_no"], s["tiny"]),
                    _p(item["part_no"], s["tiny"]),
                    _p(item["description"], s["tiny"]),
                    _p(item["maker"], s["tiny"]),
                    _p(str(item["qty"]), s["tiny"]),
                    _p(item["unit"], s["tiny"]),
                    _p("", s["tiny"]),  # Unit Price — 공급사 입력
                    _p("", s["tiny"]),  # Lead Time — 공급사 입력
                    _p("", s["tiny"]),  # Origin — 공급사 입력
                    _p(item.get("remark", ""), s["tiny"]),
                ]
            )
    else:
        headers = ["No.", "Part No.", "Description", "Maker", "Origin", "Qty", "Unit", "Unit Price", "Amount", "Lead Time / Remark"]
        widths = [10, 30, 58, 35, 24, 15, 16, 25, 28, 47]
        rows = [[_p(h, s["th"]) for h in headers]]
        for item in items:
            lead_remark = f"{item.get('lead_time', '')}\n{item.get('remark', '')}".strip()
            rows.append(
                [
                    _p(item["item_no"], s["tiny"]),
                    _p(item["part_no"], s["tiny"]),
                    _p(item["description"], s["tiny"]),
                    _p(item["maker"], s["tiny"]),
                    _p(item["origin"], s["tiny"]),
                    _p(str(item["qty"]), s["tiny"]),
                    _p(item["unit"], s["tiny"]),
                    _p(_money(item["unit_price"], currency), s["tiny"]),
                    _p(_money(item["amount"], currency), s["tiny"]),
                    _p(lead_remark, s["tiny"]),
                ]
            )

    table = Table(rows, colWidths=[w * mm for w in widths], repeatRows=1)
    style_cmds = [
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.35, MID_GRAY),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ALIGN", (5, 1), (8, -1), "RIGHT"),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]
    for r in range(1, len(rows)):
        if r % 2 == 0:
            style_cmds.append(("BACKGROUND", (0, r), (-1, r), colors.HexColor("#FAFBFC")))
    table.setStyle(TableStyle(style_cmds))
    return table


def _totals_table(data: Dict[str, Any]):
    s = _styles()
    currency = data.get("currency", "USD")
    totals = calc_totals(
        data.get("items", []), _num(data.get("vat_rate", 0)), _num(data.get("discount_pct", 0))
    )
    rows = [
        [_p("Subtotal", s["base"]), _p(_money(totals["subtotal"], currency), s["right"])],
    ]
    if totals.get("discount_pct"):
        rows.append(
            [
                _p(f"Discount ({_num(totals['discount_pct']):g}%)", s["base"]),
                _p(f"-{_money(totals['discount'], currency)}", s["right"]),
            ]
        )
    rows.append([_p("VAT", s["base"]), _p(_money(totals["vat"], currency), s["right"])])
    rows.append(
        [_p("Total", s["base"]), _p(f"<b>{_money(totals['total'], currency)}</b>", s["right"])]
    )
    table = Table(rows, colWidths=[35 * mm, 45 * mm])
    table.setStyle(
        TableStyle(
            [
                ("GRID", (0, 0), (-1, -1), 0.4, MID_GRAY),
                ("BACKGROUND", (0, 0), (0, -1), LIGHT_GRAY),
                ("BACKGROUND", (0, -1), (-1, -1), LIGHT_BLUE),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    return Table([["", table]], colWidths=[190 * mm, 80 * mm])


def _terms_block(data: Dict[str, Any], doc_type: str):
    s = _styles()
    terms = data.get("terms", {})
    company = data.get("company", {})
    shipping = data.get("shipping", {})

    rows = []
    if doc_type in {"quotation", "proforma_invoice", "commercial_invoice"}:
        rows.extend(
            [
                ["Payment Terms", terms.get("payment_terms", "")],
                ["Delivery Place", terms.get("delivery_place", "")],
                ["Packing", terms.get("packing", "")],
                ["Warranty", terms.get("warranty", "")],
                ["Remarks", terms.get("remarks", "")],
            ]
        )
        if doc_type == "proforma_invoice":
            rows.extend(
                [
                    ["Bank", company.get("bank_name", "")],
                    ["Account", company.get("bank_account", "")],
                    ["Account Holder", company.get("bank_holder", "")],
                    ["SWIFT", company.get("swift", "")],
                ]
            )
    if doc_type == "vendor_rfq":
        rows.extend(
            [
                ["Requested Incoterms", terms.get("incoterms", "") or "CNF Busan port"],
                ["Instructions", "Please provide Unit Price, Lead Time and Country of Origin, then return this sheet to sales@k-maris.com."],
                ["Remarks", terms.get("remarks", "")],
            ]
        )
    if doc_type in {"packing_list", "shipping_advice"}:
        rows.extend(
            [
                ["Port of Loading", shipping.get("port_loading", "")],
                ["Port of Discharge", shipping.get("port_discharge", "")],
                ["Carrier", shipping.get("carrier", "")],
                ["B/L or AWB No.", shipping.get("bl_awb_no", "")],
                ["ETD", shipping.get("etd", "")],
                ["ETA", shipping.get("eta", "")],
                ["Shipping Marks", shipping.get("shipping_marks", "")],
            ]
        )

    if not rows:
        return Spacer(1, 1)

    table = Table([[_p("<b>Terms / Instructions</b>", s["section"]), ""]] + [[_p(a, s["small"]), _p(b, s["small"])] for a, b in rows], colWidths=[42 * mm, 228 * mm])
    table.setStyle(
        TableStyle(
            [
                ("SPAN", (0, 0), (-1, 0)),
                ("BACKGROUND", (0, 0), (-1, 0), BLUE),
                ("GRID", (0, 0), (-1, -1), 0.35, MID_GRAY),
                ("BACKGROUND", (0, 1), (0, -1), LIGHT_GRAY),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    return table


def _commercial_shipping_block(data: Dict[str, Any]):
    """Render the CI footer in the same section order and field grouping as the XLSX."""
    s = _styles()
    shipping = data.get("shipping", {})
    terms = data.get("terms", {})

    dim = " x ".join(str(shipping.get(k, "") or "-") for k in ("sm_dim_l", "sm_dim_w", "sm_dim_h"))
    marks = (shipping.get("shipping_marks") or "").strip()
    if not marks:
        mark_lines = []
        for value in (
            shipping.get("sm_type"),
            f"C/O {shipping.get('sm_consignee')}" if shipping.get("sm_consignee") else "",
            f"M/V {shipping.get('sm_vessel')}" if shipping.get("sm_vessel") else "",
            f"P.O. NO.: {shipping.get('sm_po_no')}" if shipping.get("sm_po_no") else "",
            f"REF. NO.: {shipping.get('sm_ref_no')}" if shipping.get("sm_ref_no") else "",
            shipping.get("sm_desc"),
            f"CASE NO.: {shipping.get('sm_case_no')}" if shipping.get("sm_case_no") else "",
        ):
            if value:
                mark_lines.append(str(value))
        marks = "\n".join(mark_lines)

    rows = [
        [_p("<b>SHIPPING INFORMATION</b>", s["section"]), "", _p("<b>SHIPPING INFORMATION</b>", s["section"]), ""],
        [_p("Vessel", s["small"]), _p(shipping.get("sm_vessel", ""), s["small"]), _p("Carrier", s["small"]), _p(shipping.get("carrier", ""), s["small"])],
        [_p("Port of Loading", s["small"]), _p(shipping.get("port_loading", ""), s["small"]), _p("Port of Discharge", s["small"]), _p(shipping.get("port_discharge", ""), s["small"])],
        [_p("B/L or AWB No.", s["small"]), _p(shipping.get("bl_awb_no", ""), s["small"]), _p("ETD / ETA", s["small"]), _p(f"{shipping.get('etd', '')} / {shipping.get('eta', '')}", s["small"])],
        [_p("Incoterms", s["small"]), _p(terms.get("incoterms", ""), s["small"]), _p("Payment Terms", s["small"]), _p(terms.get("payment_terms", ""), s["small"])],
        [_p("<b>SHIPPING MARKS</b>", s["section"]), "", "", ""],
        [_p(marks, s["small"]), "", "", ""],
        [_p("<b>PACKING &amp; DECLARATION</b>", s["section"]), "", "", ""],
        [_p("Total Packages", s["small"]), _p(shipping.get("sm_total_cases", ""), s["small"]), _p("N.W. / G.W. (kg)", s["small"]), _p(f"{shipping.get('sm_net_weight', '')} / {shipping.get('sm_gross_weight', '')}", s["small"])],
        [_p("Dimension (mm)", s["small"]), _p(dim if dim != "- x - x -" else "", s["small"]), _p("Country of Origin", s["small"]), _p(shipping.get("sm_origin", ""), s["small"])],
    ]
    table = Table(rows, colWidths=[38 * mm, 97 * mm, 38 * mm, 97 * mm])
    table.setStyle(TableStyle([
        ("SPAN", (0, 0), (1, 0)), ("SPAN", (2, 0), (3, 0)),
        ("SPAN", (0, 5), (3, 5)), ("SPAN", (0, 6), (3, 6)), ("SPAN", (0, 7), (3, 7)),
        ("BACKGROUND", (0, 0), (-1, 0), BLUE), ("BACKGROUND", (0, 5), (-1, 5), BLUE),
        ("BACKGROUND", (0, 7), (-1, 7), BLUE),
        ("BACKGROUND", (0, 1), (0, 4), LIGHT_GRAY), ("BACKGROUND", (2, 1), (2, 4), LIGHT_GRAY),
        ("BACKGROUND", (0, 8), (0, 9), LIGHT_GRAY), ("BACKGROUND", (2, 8), (2, 9), LIGHT_GRAY),
        ("GRID", (0, 0), (-1, -1), 0.35, MID_GRAY), ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    return table


def _footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(MID_GRAY)
    canvas.setLineWidth(0.5)
    canvas.line(12 * mm, 11 * mm, 285 * mm, 11 * mm)
    canvas.setFont(DEFAULT_FONT, 7)
    canvas.setFillColor(DARK_GRAY)
    canvas.drawString(12 * mm, 7 * mm, "K-MARIS Energy & Solutions Co., Ltd.")
    canvas.drawRightString(285 * mm, 7 * mm, f"Page {doc.page}")
    canvas.restoreState()


def _make_commercial_invoice_pdf(data: Dict[str, Any], company: Dict[str, Any]) -> bytes:
    """Commercial Invoice PDF whose visual structure mirrors the dedicated XLSX."""
    s = _styles()
    customer = data.get("customer", {}) or {}
    vessel = data.get("vessel", {}) or {}
    terms = data.get("terms", {}) or {}
    shipping = data.get("shipping", {}) or {}
    items = normalize_items(data.get("items", []))
    currency = (data.get("currency") or "USD").upper()
    totals = calc_totals(items, _num(data.get("vat_rate", 0)))
    buffer = io.BytesIO()
    page_width = 190 * mm
    doc = SimpleDocTemplate(buffer, pagesize=A4, leftMargin=10 * mm,
                            rightMargin=10 * mm, topMargin=7 * mm, bottomMargin=12 * mm,
                            title="COMMERCIAL INVOICE")

    # Keep every block on the same vertical grid. These are the PDF equivalents
    # of the eight Excel columns (6, 20, 16, 14, 12, 8, 14, 16).
    excel_units = [6, 14.5, 16, 13.5, 12, 8, 14, 18.28515625]
    col_widths = [page_width * unit / sum(excel_units) for unit in excel_units]
    half_widths = [sum(col_widths[:4]), sum(col_widths[4:])]

    asset_roots = [Path(__file__).resolve().parents[2], Path(__file__).resolve().parent.parent / "config"]

    def asset(*names):
        for root in asset_roots:
            for name in names:
                candidate = root / name
                if candidate.exists():
                    return candidate
        return None

    def image(path, max_width, max_height):
        if not path:
            return ""
        from PIL import Image as PILImage
        with PILImage.open(path) as source:
            width, height = source.size
        scale = min(max_width / width, max_height / height)
        return Image(str(path), width=width * scale, height=height * scale)

    def p(value, style="small"):
        text = str(value or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        return Paragraph(text.replace("\n", "<br/>"), s[style])

    def section(title):
        t = Table([[p(title, "section")]], colWidths=[page_width])
        t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#1F3B66")),
                               ("TEXTCOLOR", (0, 0), (-1, -1), colors.white),
                               ("FONTNAME", (0, 0), (-1, -1), DEFAULT_BOLD_FONT),
                               ("LEFTPADDING", (0, 0), (-1, -1), 4),
                               ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
        return t

    def grid(rows, widths, label_cols=()):
        t = Table(rows, colWidths=[w * mm for w in widths])
        cmds = [("GRID", (0, 0), (-1, -1), .35, MID_GRAY), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]
        for col in label_cols:
            cmds += [("BACKGROUND", (col, 0), (col, -1), LIGHT_GRAY),
                     ("FONTNAME", (col, 0), (col, -1), DEFAULT_BOLD_FONT)]
        t.setStyle(TableStyle(cmds))
        return t

    story = []
    title_style = ParagraphStyle("KMCITitle", parent=s["section"], fontName=DEFAULT_BOLD_FONT,
                                 fontSize=19, leading=22, alignment=TA_CENTER, textColor=NAVY)
    logo = image(asset("logo_K-maris.png", "logo.png", "logo.jpg"), 32 * mm, 11 * mm)
    title = Table([[logo, Paragraph("COMMERCIAL INVOICE", title_style), ""]],
                  colWidths=[38 * mm, 114 * mm, 38 * mm], rowHeights=[16 * mm])
    title.setStyle(TableStyle([("TEXTCOLOR", (0, 0), (-1, -1), NAVY),
                               ("ALIGN", (0, 0), (-1, -1), "CENTER"), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                               ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                               ("FONTNAME", (0, 0), (-1, -1), DEFAULT_BOLD_FONT),
                               ("FONTSIZE", (0, 0), (-1, -1), 17)]))
    story.append(title)
    banner_text = "   |   ".join(x for x in [company.get("company_name_en", "K-MARIS Energy & Solutions Co., Ltd."),
                                               company.get("sales_email", ""), company.get("website", "")] if x)
    banner_style = ParagraphStyle("KMCIBanner", parent=s["section"], fontName=DEFAULT_FONT,
                                  fontSize=8.2, leading=10, alignment=TA_CENTER,
                                  textColor=colors.white)
    banner = Table([[Paragraph(banner_text, banner_style)]], colWidths=[page_width], rowHeights=[6 * mm])
    banner.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), BLUE), ("TEXTCOLOR", (0, 0), (-1, -1), colors.white),
                                ("ALIGN", (0, 0), (-1, -1), "CENTER"), ("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    story += [banner, Spacer(1, 3 * mm)]

    address = company.get("address_en") or company.get("address", "")
    address_top, address_bottom = address, ""
    if " Seoul" in address:
        address_top, address_bottom = address.split(" Seoul", 1)
        address_bottom = "Seoul" + address_bottom
    exporter = [company.get("company_name_en", ""), address_top, address_bottom,
                f"Tel: {company.get('phone', '')}    Email: {company.get('sales_email', '')}",
                f"Business Reg. No.: {company.get('business_no', '')}"]
    invoice = [("Invoice No.", data.get("doc_no", "")), ("Invoice Date", data.get("date", "")),
               ("P.O. No.", shipping.get("po_no", "")),
               ("Quotation Ref.", data.get("quotation_ref") or shipping.get("export_ref", "")), ("", "")]
    rows = [[p("EXPORTER / SELLER", "section"), "", p("INVOICE INFORMATION", "section"), ""]]
    rows += [[p(exporter[i]), "", p(invoice[i][0]), p(invoice[i][1])] for i in range(5)]
    info = Table(rows, colWidths=[col_widths[0] + col_widths[1], col_widths[2] + col_widths[3],
                                 col_widths[4] + col_widths[5], col_widths[6] + col_widths[7]])
    info.setStyle(TableStyle([("SPAN", (0, 0), (1, 0)), ("SPAN", (2, 0), (3, 0)),
                              ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F3B66")),
                              ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                              ("FONTNAME", (0, 0), (-1, 0), DEFAULT_BOLD_FONT),
                              ("SPAN", (0, 1), (1, 1)), ("SPAN", (0, 2), (1, 2)), ("SPAN", (0, 3), (1, 3)),
                              ("SPAN", (0, 4), (1, 4)), ("SPAN", (0, 5), (1, 5)),
                              ("BACKGROUND", (2, 1), (2, -1), LIGHT_GRAY), ("FONTNAME", (2, 1), (2, -1), DEFAULT_BOLD_FONT),
                              ("GRID", (0, 0), (-1, -1), .35, MID_GRAY), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                              ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                              ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
    story.append(info)

    buyer = [customer.get("name", ""), customer.get("address", ""),
             f"Contact: {customer.get('contact', '')}    {customer.get('email', '')}"]
    ship = [("Ship Agent", shipping.get("sm_consignee", "")),
            ("Vessel / IMO", " / ".join(x for x in [shipping.get("sm_vessel") or vessel.get("name", ""), vessel.get("imo", "")] if x)),
            ("", "")]
    rows = [[p("CONSIGNEE / BUYER", "section"), "", p("SHIP TO / C/O", "section"), ""]]
    rows += [[p(buyer[i]), "", p(ship[i][0]), p(ship[i][1])] for i in range(3)]
    consignee = Table(rows, colWidths=[col_widths[0] + col_widths[1], col_widths[2] + col_widths[3],
                                      col_widths[4] + col_widths[5], col_widths[6] + col_widths[7]])
    consignee.setStyle(TableStyle([("SPAN", (0, 0), (1, 0)), ("SPAN", (2, 0), (3, 0)),
                                   ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F3B66")),
                                   ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                                   ("FONTNAME", (0, 0), (-1, 0), DEFAULT_BOLD_FONT),
                                   ("SPAN", (0, 1), (1, 1)), ("SPAN", (0, 2), (1, 2)), ("SPAN", (0, 3), (1, 3)),
                                   ("BACKGROUND", (2, 1), (2, -1), LIGHT_GRAY), ("FONTNAME", (2, 1), (2, -1), DEFAULT_BOLD_FONT),
                                   ("GRID", (0, 0), (-1, -1), .35, MID_GRAY), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                                   ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                                   ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
    story += [consignee, section("SHIPPING INFORMATION")]
    shipping_rows = [[p(a), p(b), p(c), p(d)] for a, b, c, d in [
        ("Vessel", shipping.get("sm_vessel") or vessel.get("name", ""), "Carrier", shipping.get("carrier", "")),
        ("Port of Loading", shipping.get("port_loading", ""), "Port of Discharge", shipping.get("port_discharge", "")),
        ("Incoterms", terms.get("incoterms", ""), "Payment Terms", terms.get("payment_terms", "")),
        ("ETD", shipping.get("etd", ""), "ETA", shipping.get("eta", "")),
        ("Currency", currency, "Country of Origin", shipping.get("sm_origin", ""))]]
    shipping_table = Table(shipping_rows, colWidths=[col_widths[0] + col_widths[1], col_widths[2] + col_widths[3],
                                                     col_widths[4] + col_widths[5], col_widths[6] + col_widths[7]])
    shipping_table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), .35, MID_GRAY),
        ("BACKGROUND", (0, 0), (0, -1), LIGHT_GRAY), ("BACKGROUND", (2, 0), (2, -1), LIGHT_GRAY),
        ("FONTNAME", (0, 0), (0, -1), DEFAULT_BOLD_FONT), ("FONTNAME", (2, 0), (2, -1), DEFAULT_BOLD_FONT),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4), ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
    story += [shipping_table, section("SHIPPING MARKS")]

    marks = (shipping.get("shipping_marks") or "").strip()
    if not marks:
        parts = [shipping.get("sm_type"), f"C/O {shipping.get('sm_consignee')}" if shipping.get("sm_consignee") else "",
                 f"M/V {str(shipping.get('sm_vessel')).upper()}" if shipping.get("sm_vessel") else "",
                 f"P.O. NO.: {shipping.get('sm_po_no')}" if shipping.get("sm_po_no") else "",
                 f"REF. NO.: {shipping.get('sm_ref_no')}" if shipping.get("sm_ref_no") else "", shipping.get("sm_desc"),
                 f"CASE NO.: {shipping.get('sm_case_no')}" if shipping.get("sm_case_no") else "",
                 f"TOTAL: {shipping.get('sm_total_cases')} CASE(S)" if shipping.get("sm_total_cases") else "",
                 f"N.W.: {shipping.get('sm_net_weight')} KG" if shipping.get("sm_net_weight") else "",
                 f"G.W.: {shipping.get('sm_gross_weight')} KG" if shipping.get("sm_gross_weight") else ""]
        dims = [shipping.get("sm_dim_l"), shipping.get("sm_dim_w"), shipping.get("sm_dim_h")]
        if any(dims): parts.append("DIM.: " + " x ".join(str(x or "-") for x in dims) + " MM")
        parts += [f"PORT OF DELIVERY: {shipping.get('sm_port_delivery')}" if shipping.get("sm_port_delivery") else "",
                  f"FINAL DESTINATION: {shipping.get('sm_final_dest')}" if shipping.get("sm_final_dest") else "",
                  shipping.get("sm_origin"), shipping.get("sm_handling")]
        marks = "\n".join(str(x) for x in parts if x)
    mark_lines = marks.splitlines()
    split_at = (len(mark_lines) + 1) // 2
    marks_table = Table([[p("\n".join(mark_lines[:split_at])), p("\n".join(mark_lines[split_at:]))]],
                        colWidths=half_widths)
    marks_table.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), .35, MID_GRAY), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                                     ("LINEBEFORE", (1, 0), (1, -1), .35, MID_GRAY),
                                     ("LEFTPADDING", (0, 0), (-1, -1), 4), ("TOPPADDING", (0, 0), (-1, -1), 4),
                                     ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
    story.append(marks_table)

    headers = ["No.", "Description", "Part No.", "HS Code", "Qty", "Unit Price", f"Amount ({currency})"]
    item_rows = [[p(h, "th") for h in headers]]
    for it in items:
        item_rows.append([p(it["item_no"], "tiny"), p(it["description"], "tiny"), p(it["part_no"], "tiny"),
                          p(it.get("hs_code") or shipping.get("hs_code", ""), "tiny"), p(f"{it['qty']:g}", "tiny"),
                          p(f"{it['unit_price']:,.2f}", "tiny"), p(f"{it['amount']:,.2f}", "tiny")])
    item_table = Table(item_rows, colWidths=[col_widths[0], col_widths[1] + col_widths[2], col_widths[3],
                                             col_widths[4], col_widths[5], col_widths[6], col_widths[7]], repeatRows=1)
    cmds = [("BACKGROUND", (0, 0), (-1, 0), NAVY), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("GRID", (0, 0), (-1, -1), .35, MID_GRAY), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("ALIGN", (4, 1), (-1, -1), "RIGHT"), ("LEFTPADDING", (0, 0), (-1, -1), 3),
            ("RIGHTPADDING", (0, 0), (-1, -1), 3), ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]
    for i in range(2, len(item_rows), 2): cmds.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#FAFBFC")))
    item_table.setStyle(TableStyle(cmds)); story.append(item_table)

    total_rows = [[p(label), p(f"{value:,.2f}")] for label, value in [
        ("Subtotal", totals["subtotal"]), ("Freight", 0), ("Packing", 0), ("Insurance", 0),
        ("VAT", totals["vat"]), ("TOTAL INVOICE VALUE", totals["total"])]]
    total_inner = Table(total_rows, colWidths=[col_widths[5] + col_widths[6], col_widths[7]])
    total_table = Table([["", total_inner]], colWidths=[sum(col_widths[:5]), col_widths[5] + col_widths[6] + col_widths[7]])
    total_inner.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), .35, MID_GRAY),
        ("BACKGROUND", (0, 0), (0, -1), LIGHT_GRAY), ("BACKGROUND", (0, -1), (-1, -1), LIGHT_BLUE),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"), ("FONTNAME", (0, -1), (-1, -1), DEFAULT_BOLD_FONT),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4)]))
    total_table.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    story += [total_table, Spacer(1, 2 * mm), section("PACKING & DECLARATION")]
    packing = [[p(a), p(b), p(c), p(d)] for a, b, c, d in [
        ("Total Packages", shipping.get("sm_total_cases", ""), "Net Weight (kg)", shipping.get("sm_net_weight", "")),
        ("Gross Weight (kg)", shipping.get("sm_gross_weight", ""), "Country of Origin", shipping.get("sm_origin", ""))]]
    packing_table = Table(packing, colWidths=[col_widths[0] + col_widths[1], col_widths[2] + col_widths[3],
                                              col_widths[4] + col_widths[5], col_widths[6] + col_widths[7]])
    packing_table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), .35, MID_GRAY),
        ("BACKGROUND", (0, 0), (0, -1), LIGHT_GRAY), ("BACKGROUND", (2, 0), (2, -1), LIGHT_GRAY),
        ("FONTNAME", (0, 0), (0, -1), DEFAULT_BOLD_FONT), ("FONTNAME", (2, 0), (2, -1), DEFAULT_BOLD_FONT),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4), ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
    declaration = Table([[p("We hereby certify that this Commercial Invoice is true and correct.")]],
                        colWidths=[page_width])
    declaration.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), .35, MID_GRAY),
                                      ("LEFTPADDING", (0, 0), (-1, -1), 4)]))
    story += [packing_table, declaration]
    signature_image = image(asset("Authorized signature_Sungyeon Cho.jpg", "signature.png", "signature.jpg"), 35 * mm, 11 * mm)
    stamp_image = image(asset("Company stamp_K-Maris Energy & Solutions.jpg", "stamp.png", "stamp.jpg"), 14 * mm, 14 * mm)
    left_sign = Table([[p("Authorized Signature", "base"), signature_image]], colWidths=[32 * mm, half_widths[0] - 32 * mm])
    right_sign = Table([[p(f"{company.get('company_name_en', '')}\n(Company Stamp)", "base"), stamp_image]],
                       colWidths=[half_widths[1] - 25 * mm, 25 * mm])
    inner_sign_style = TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ])
    left_sign.setStyle(inner_sign_style)
    right_sign.setStyle(inner_sign_style)
    sign = Table([[left_sign, right_sign]], colWidths=half_widths, rowHeights=[15 * mm])
    sign.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), .35, MID_GRAY),
                              ("VALIGN", (0, 0), (-1, -1), "TOP"),
                              ("FONTNAME", (0, 0), (-1, -1), DEFAULT_BOLD_FONT),
                              ("LEFTPADDING", (0, 0), (-1, -1), 0),
                              ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                              ("TOPPADDING", (0, 0), (-1, -1), 0),
                              ("BOTTOMPADDING", (0, 0), (-1, -1), 0)]))
    story.append(sign)
    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)
    return buffer.getvalue()


def compose_shipping_marks(sh: Dict[str, Any]) -> str:
    """구조화 Shipping Marks(sm_*)를 여러 줄 문자열로 재구성 — 프론트 composeShippingMarks·
    doc_xlsx._compose_marks 와 동일 규약. PL 은 CI 상속값+PL 수정값이 병합된 sh 를 받아
    저장된 shipping_marks 문자열 대신 항상 최신 sm_* 로 재구성한다."""
    lines: List[str] = []

    def push(v):
        if v and str(v).strip():
            lines.append(str(v).strip())

    push(sh.get("sm_type"))
    if sh.get("sm_consignee"): push(f"C/O {sh['sm_consignee']}")
    if sh.get("sm_vessel"): push(f"M/V {str(sh['sm_vessel']).upper()}")
    if sh.get("sm_po_no"): push(f"P.O. NO.: {sh['sm_po_no']}")
    if sh.get("sm_ref_no"): push(f"REF. NO.: {sh['sm_ref_no']}")
    push(sh.get("sm_desc"))
    if sh.get("sm_case_no"): push(f"CASE NO.: {sh['sm_case_no']}")
    if sh.get("sm_total_cases"): push(f"TOTAL: {sh['sm_total_cases']} CASE(S)")
    if sh.get("sm_net_weight"): push(f"N.W.: {sh['sm_net_weight']} KG")
    if sh.get("sm_gross_weight"): push(f"G.W.: {sh['sm_gross_weight']} KG")
    dim = [sh.get("sm_dim_l"), sh.get("sm_dim_w"), sh.get("sm_dim_h")]
    if any(d and str(d).strip() for d in dim):
        push("DIM.: " + " × ".join((str(d).strip() if d and str(d).strip() else "-") for d in dim) + " MM")
    if sh.get("sm_port_delivery"): push(f"PORT OF DELIVERY: {sh['sm_port_delivery']}")
    if sh.get("sm_final_dest"): push(f"FINAL DESTINATION: {sh['sm_final_dest']}")
    push(sh.get("sm_origin"))
    push(sh.get("sm_handling"))
    return "\n".join(lines)


def _pkg_text(it: Dict[str, Any]) -> str:
    """'No. & Kind of Packages' 셀 — 수량+종류 결합, 없으면 레거시 package 문자열."""
    q = str(it.get("pkg_qty") or "").strip()
    k = str(it.get("pkg_kind") or "").strip()
    combined = f"{q} {k}".strip()
    return combined or str(it.get("package") or "").strip()


def _make_packing_list_pdf(data: Dict[str, Any], company: Dict[str, Any]) -> bytes:
    """Packing List PDF — Commercial Invoice 와 동일한 섹션 구조. 가격 열은 없고
    포장(No.&Kind of Packages)·중량(N.W./G.W.)·용적(Measurement) 열과 합계행을 갖는다."""
    s = _styles()
    customer = data.get("customer", {}) or {}
    vessel = data.get("vessel", {}) or {}
    shipping = data.get("shipping", {}) or {}
    items = normalize_items(data.get("items", []))
    currency = (data.get("currency") or "USD").upper()
    buffer = io.BytesIO()
    page_width = 190 * mm
    doc = SimpleDocTemplate(buffer, pagesize=A4, leftMargin=10 * mm,
                            rightMargin=10 * mm, topMargin=7 * mm, bottomMargin=12 * mm,
                            title="PACKING LIST")

    # 상단 정보 블록은 CI 와 같은 8-단위 격자(4분할)를 그대로 쓴다.
    excel_units = [6, 14.5, 16, 13.5, 12, 8, 14, 18.28515625]
    col_widths = [page_width * unit / sum(excel_units) for unit in excel_units]
    half_widths = [sum(col_widths[:4]), sum(col_widths[4:])]

    asset_roots = [Path(__file__).resolve().parents[2], Path(__file__).resolve().parent.parent / "config"]

    def asset(*names):
        for root in asset_roots:
            for name in names:
                candidate = root / name
                if candidate.exists():
                    return candidate
        return None

    def image(path, max_width, max_height):
        if not path:
            return ""
        from PIL import Image as PILImage
        with PILImage.open(path) as source:
            width, height = source.size
        scale = min(max_width / width, max_height / height)
        return Image(str(path), width=width * scale, height=height * scale)

    def p(value, style="small"):
        text = str(value or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        return Paragraph(text.replace("\n", "<br/>"), s[style])

    def section(title):
        t = Table([[p(title, "section")]], colWidths=[page_width])
        t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#1F3B66")),
                               ("TEXTCOLOR", (0, 0), (-1, -1), colors.white),
                               ("FONTNAME", (0, 0), (-1, -1), DEFAULT_BOLD_FONT),
                               ("LEFTPADDING", (0, 0), (-1, -1), 4),
                               ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
        return t

    story = []
    title_style = ParagraphStyle("KMPLTitle", parent=s["section"], fontName=DEFAULT_BOLD_FONT,
                                 fontSize=19, leading=22, alignment=TA_CENTER, textColor=NAVY)
    logo = image(asset("logo_K-maris.png", "logo.png", "logo.jpg"), 32 * mm, 11 * mm)
    title = Table([[logo, Paragraph("PACKING LIST", title_style), ""]],
                  colWidths=[38 * mm, 114 * mm, 38 * mm], rowHeights=[16 * mm])
    title.setStyle(TableStyle([("TEXTCOLOR", (0, 0), (-1, -1), NAVY),
                               ("ALIGN", (0, 0), (-1, -1), "CENTER"), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                               ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                               ("FONTNAME", (0, 0), (-1, -1), DEFAULT_BOLD_FONT),
                               ("FONTSIZE", (0, 0), (-1, -1), 17)]))
    story.append(title)
    banner_text = "   |   ".join(x for x in [company.get("company_name_en", "K-MARIS Energy & Solutions Co., Ltd."),
                                               company.get("sales_email", ""), company.get("website", "")] if x)
    banner_style = ParagraphStyle("KMPLBanner", parent=s["section"], fontName=DEFAULT_FONT,
                                  fontSize=8.2, leading=10, alignment=TA_CENTER,
                                  textColor=colors.white)
    banner = Table([[Paragraph(banner_text, banner_style)]], colWidths=[page_width], rowHeights=[6 * mm])
    banner.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), BLUE), ("TEXTCOLOR", (0, 0), (-1, -1), colors.white),
                                ("ALIGN", (0, 0), (-1, -1), "CENTER"), ("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    story += [banner, Spacer(1, 3 * mm)]

    address = company.get("address_en") or company.get("address", "")
    address_top, address_bottom = address, ""
    if " Seoul" in address:
        address_top, address_bottom = address.split(" Seoul", 1)
        address_bottom = "Seoul" + address_bottom
    exporter = [company.get("company_name_en", ""), address_top, address_bottom,
                f"Tel: {company.get('phone', '')}    Email: {company.get('sales_email', '')}",
                f"Business Reg. No.: {company.get('business_no', '')}"]
    invoice = [("P/L No.", data.get("doc_no", "")), ("P/L Date", data.get("date", "")),
               ("Invoice No.", shipping.get("ci_no", "")),
               ("P.O. No.", shipping.get("po_no", "")), ("", "")]
    rows = [[p("EXPORTER / SELLER", "section"), "", p("PACKING LIST INFORMATION", "section"), ""]]
    rows += [[p(exporter[i]), "", p(invoice[i][0]), p(invoice[i][1])] for i in range(5)]
    info = Table(rows, colWidths=[col_widths[0] + col_widths[1], col_widths[2] + col_widths[3],
                                 col_widths[4] + col_widths[5], col_widths[6] + col_widths[7]])
    info.setStyle(TableStyle([("SPAN", (0, 0), (1, 0)), ("SPAN", (2, 0), (3, 0)),
                              ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F3B66")),
                              ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                              ("FONTNAME", (0, 0), (-1, 0), DEFAULT_BOLD_FONT),
                              ("SPAN", (0, 1), (1, 1)), ("SPAN", (0, 2), (1, 2)), ("SPAN", (0, 3), (1, 3)),
                              ("SPAN", (0, 4), (1, 4)), ("SPAN", (0, 5), (1, 5)),
                              ("BACKGROUND", (2, 1), (2, -1), LIGHT_GRAY), ("FONTNAME", (2, 1), (2, -1), DEFAULT_BOLD_FONT),
                              ("GRID", (0, 0), (-1, -1), .35, MID_GRAY), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                              ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                              ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
    story.append(info)

    buyer = [customer.get("name", ""), customer.get("address", ""),
             f"Contact: {customer.get('contact', '')}    {customer.get('email', '')}"]
    ship = [("Ship Agent", shipping.get("sm_consignee", "")),
            ("Vessel / IMO", " / ".join(x for x in [shipping.get("sm_vessel") or vessel.get("name", ""), vessel.get("imo", "")] if x)),
            ("B/L or AWB No.", shipping.get("bl_awb_no", ""))]
    rows = [[p("CONSIGNEE / BUYER", "section"), "", p("SHIP TO / C/O", "section"), ""]]
    rows += [[p(buyer[i]), "", p(ship[i][0]), p(ship[i][1])] for i in range(3)]
    consignee = Table(rows, colWidths=[col_widths[0] + col_widths[1], col_widths[2] + col_widths[3],
                                      col_widths[4] + col_widths[5], col_widths[6] + col_widths[7]])
    consignee.setStyle(TableStyle([("SPAN", (0, 0), (1, 0)), ("SPAN", (2, 0), (3, 0)),
                                   ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F3B66")),
                                   ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                                   ("FONTNAME", (0, 0), (-1, 0), DEFAULT_BOLD_FONT),
                                   ("SPAN", (0, 1), (1, 1)), ("SPAN", (0, 2), (1, 2)), ("SPAN", (0, 3), (1, 3)),
                                   ("BACKGROUND", (2, 1), (2, -1), LIGHT_GRAY), ("FONTNAME", (2, 1), (2, -1), DEFAULT_BOLD_FONT),
                                   ("GRID", (0, 0), (-1, -1), .35, MID_GRAY), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                                   ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                                   ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
    story += [consignee, section("SHIPPING INFORMATION")]
    shipping_rows = [[p(a), p(b), p(c), p(d)] for a, b, c, d in [
        ("Vessel", shipping.get("sm_vessel") or vessel.get("name", ""), "Carrier", shipping.get("carrier", "")),
        ("Port of Loading", shipping.get("port_loading", ""), "Port of Discharge", shipping.get("port_discharge", "")),
        ("ETD", shipping.get("etd", ""), "ETA", shipping.get("eta", "")),
        ("Country of Origin", shipping.get("sm_origin", ""), "Final Destination", shipping.get("sm_final_dest", ""))]]
    shipping_table = Table(shipping_rows, colWidths=[col_widths[0] + col_widths[1], col_widths[2] + col_widths[3],
                                                     col_widths[4] + col_widths[5], col_widths[6] + col_widths[7]])
    shipping_table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), .35, MID_GRAY),
        ("BACKGROUND", (0, 0), (0, -1), LIGHT_GRAY), ("BACKGROUND", (2, 0), (2, -1), LIGHT_GRAY),
        ("FONTNAME", (0, 0), (0, -1), DEFAULT_BOLD_FONT), ("FONTNAME", (2, 0), (2, -1), DEFAULT_BOLD_FONT),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4), ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
    story += [shipping_table, section("SHIPPING MARKS")]

    # 병합된 sm_*(CI 상속 + PL 수정) 로 항상 재구성. 없으면 저장된 문자열로 폴백.
    marks = compose_shipping_marks(shipping) or (shipping.get("shipping_marks") or "").strip()
    mark_lines = marks.splitlines()
    split_at = (len(mark_lines) + 1) // 2
    marks_table = Table([[p("\n".join(mark_lines[:split_at])), p("\n".join(mark_lines[split_at:]))]],
                        colWidths=half_widths)
    marks_table.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), .35, MID_GRAY), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                                     ("LINEBEFORE", (1, 0), (1, -1), .35, MID_GRAY),
                                     ("LEFTPADDING", (0, 0), (-1, -1), 4), ("TOPPADDING", (0, 0), (-1, -1), 4),
                                     ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
    story.append(marks_table)

    # ── 품목 표(가격 없음) ─────────────────────────────────────────────────
    # 9열: No · Description · Part No · Qty · Unit · No.&Kind of Pkgs · N.W.(kg) · G.W.(kg) · Meas.(m³)
    pl_units = [5, 22, 14, 7, 8, 15, 11, 11, 11]
    pl_w = [page_width * u / sum(pl_units) for u in pl_units]
    headers = ["No.", "Description", "Part No.", "Q'ty", "Unit", "No. & Kind\nof Packages",
               "N.W. (kg)", "G.W. (kg)", "Meas. (m³)"]
    item_rows = [[p(h, "th") for h in headers]]

    def _numtxt(v):
        return str(v).strip() if v not in (None, "", 0, 0.0) else ""

    for it in items:
        item_rows.append([p(it["item_no"], "tiny"), p(it["description"], "tiny"), p(it["part_no"], "tiny"),
                          p(f"{it['qty']:g}", "tiny"), p(it["unit"], "tiny"), p(_pkg_text(it), "tiny"),
                          p(_numtxt(it.get("net_weight")), "tiny"), p(_numtxt(it.get("gross_weight")), "tiny"),
                          p(_numtxt(it.get("measurement")), "tiny")])
    # 합계행 — 포장 수량/중량/용적 자동합산.
    tot_pkgs = sum(_num(it.get("pkg_qty")) for it in items)
    tot_nw = sum(_num(it.get("net_weight")) for it in items)
    tot_gw = sum(_num(it.get("gross_weight")) for it in items)
    tot_meas = sum(_num(it.get("measurement")) for it in items)

    def _tot(v):
        return f"{v:g}" if v else ""
    item_rows.append([p("", "th"), p("TOTAL", "th"), p("", "th"), p("", "th"), p("", "th"),
                      p(_tot(tot_pkgs), "th"), p(_tot(tot_nw), "th"), p(_tot(tot_gw), "th"), p(_tot(tot_meas), "th")])
    item_table = Table(item_rows, colWidths=pl_w, repeatRows=1)
    last = len(item_rows) - 1
    cmds = [("BACKGROUND", (0, 0), (-1, 0), NAVY), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("GRID", (0, 0), (-1, -1), .35, MID_GRAY), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("ALIGN", (3, 1), (4, -1), "CENTER"), ("ALIGN", (6, 1), (-1, -1), "RIGHT"),
            ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            # 합계행 강조.
            ("BACKGROUND", (0, last), (-1, last), LIGHT_BLUE),
            ("TEXTCOLOR", (0, last), (-1, last), colors.black),
            ("FONTNAME", (0, last), (-1, last), DEFAULT_BOLD_FONT),
            ("SPAN", (1, last), (4, last))]
    for i in range(2, len(item_rows) - 1, 2):
        cmds.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#FAFBFC")))
    item_table.setStyle(TableStyle(cmds))
    story.append(item_table)

    # ── Packing Information(자유 메모) + 선언 ─────────────────────────────
    packing_info = (data.get("packing_info") or "").strip()
    if packing_info:
        story += [Spacer(1, 2 * mm), section("PACKING INFORMATION")]
        note = Table([[p(packing_info)]], colWidths=[page_width])
        note.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), .35, MID_GRAY),
                                  ("VALIGN", (0, 0), (-1, -1), "TOP"),
                                  ("LEFTPADDING", (0, 0), (-1, -1), 4), ("TOPPADDING", (0, 0), (-1, -1), 4),
                                  ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
        story.append(note)
    story.append(Spacer(1, 2 * mm))
    declaration = Table([[p("We hereby certify that this Packing List is true and correct.")]],
                        colWidths=[page_width])
    declaration.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), .35, MID_GRAY),
                                      ("LEFTPADDING", (0, 0), (-1, -1), 4)]))
    story.append(declaration)

    signature_image = image(asset("Authorized signature_Sungyeon Cho.jpg", "signature.png", "signature.jpg"), 35 * mm, 11 * mm)
    stamp_image = image(asset("Company stamp_K-Maris Energy & Solutions.jpg", "stamp.png", "stamp.jpg"), 14 * mm, 14 * mm)
    left_sign = Table([[p("Authorized Signature", "base"), signature_image]], colWidths=[32 * mm, half_widths[0] - 32 * mm])
    right_sign = Table([[p(f"{company.get('company_name_en', '')}\n(Company Stamp)", "base"), stamp_image]],
                       colWidths=[half_widths[1] - 25 * mm, 25 * mm])
    inner_sign_style = TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ])
    left_sign.setStyle(inner_sign_style)
    right_sign.setStyle(inner_sign_style)
    sign = Table([[left_sign, right_sign]], colWidths=half_widths, rowHeights=[15 * mm])
    sign.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), .35, MID_GRAY),
                              ("VALIGN", (0, 0), (-1, -1), "TOP"),
                              ("FONTNAME", (0, 0), (-1, -1), DEFAULT_BOLD_FONT),
                              ("LEFTPADDING", (0, 0), (-1, -1), 0),
                              ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                              ("TOPPADDING", (0, 0), (-1, -1), 0),
                              ("BOTTOMPADDING", (0, 0), (-1, -1), 0)]))
    story += [Spacer(1, 2 * mm), sign]
    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)
    return buffer.getvalue()


def make_pdf(doc_type: str, data: Dict[str, Any], company: Optional[Dict[str, Any]] = None, logo_path: Optional[str] = None) -> bytes:
    if doc_type not in DOC_TITLES:
        raise ValueError(f"Unsupported document type: {doc_type}")
    payload = dict(data)
    payload["company"] = company or data.get("company", {})
    if doc_type == "commercial_invoice":
        return _make_commercial_invoice_pdf(payload, payload["company"])
    if doc_type == "packing_list":
        return _make_packing_list_pdf(payload, payload["company"])
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=landscape(A4),
        leftMargin=12 * mm,
        rightMargin=12 * mm,
        topMargin=12 * mm,
        bottomMargin=15 * mm,
        title=DOC_TITLES[doc_type],
        author="K-MARIS Energy & Solutions Co., Ltd.",
    )
    s = _styles()
    story = []
    story.append(_header(payload["company"], DOC_TITLES[doc_type], logo_path))
    story.append(Spacer(1, 5 * mm))
    story.append(_info_tables(payload, doc_type))
    story.append(Spacer(1, 5 * mm))
    story.append(_items_table(payload, doc_type))
    if doc_type not in {"packing_list", "shipping_advice", "vendor_rfq"}:
        story.append(Spacer(1, 4 * mm))
        story.append(_totals_table(payload))
    story.append(Spacer(1, 5 * mm))
    story.append(_commercial_shipping_block(payload) if doc_type == "commercial_invoice" else _terms_block(payload, doc_type))
    story.append(Spacer(1, 2 * mm))
    sign = Table(
        [[
            _p("Prepared by\n\n________________", s["base"]),
            _p("Approved by\n\n________________", s["base"]),
            _p("For and on behalf of K-MARIS Energy & Solutions Co., Ltd.\n\nAuthorized Signature", s["base"]),
        ]],
        colWidths=[70 * mm, 70 * mm, 130 * mm],
        rowHeights=[12 * mm],
    )
    sign.setStyle(
        TableStyle(
            [
                ("GRID", (0, 0), (-1, -1), 0.35, MID_GRAY),
                ("BACKGROUND", (0, 0), (-1, 0), LIGHT_GRAY),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
        )
    )
    story.append(sign)
    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)
    return buffer.getvalue()


def make_tax_invoice_xlsx(data: Dict[str, Any], company: Dict[str, Any]) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Tax Invoice Data"
    currency = data.get("currency", "KRW")
    items = normalize_items(data.get("items", []))
    vat_rate = _num(data.get("vat_rate", 0.1))
    totals = calc_totals(items, vat_rate)
    customer = data.get("customer", {})
    tax = data.get("tax_invoice", {})

    title_fill = PatternFill("solid", fgColor="0B1D3A")
    section_fill = PatternFill("solid", fgColor="EAF3FF")
    header_fill = PatternFill("solid", fgColor="D8DEE6")
    white_font = Font(color="FFFFFF", bold=True)
    bold = Font(bold=True)
    thin = Side(style="thin", color="D8DEE6")
    border = Border(top=thin, bottom=thin, left=thin, right=thin)

    ws.merge_cells("A1:J1")
    ws["A1"] = "K-MARIS TAX INVOICE DATA SHEET / 세금계산서 발행용 데이터"
    ws["A1"].fill = title_fill
    ws["A1"].font = white_font
    ws["A1"].alignment = Alignment(horizontal="center")

    rows = [
        ("Issue Date / 작성일자", tax.get("issue_date", data.get("date", "")), "Document No.", data.get("doc_no", "")),
        ("Supply Type / 공급유형", tax.get("supply_type", ""), "Currency", currency),
        ("Supplier / 공급자", company.get("company_name_kr", ""), "Supplier Business No.", tax.get("supplier_business_no", company.get("business_no", ""))),
        ("Supplier Email", company.get("tax_email", company.get("general_email", "")), "Supplier Address", company.get("address", "")),
        ("Buyer / 공급받는 자", customer.get("name", ""), "Buyer Business No.", tax.get("buyer_business_no", customer.get("tax_id", ""))),
        ("Buyer Email", customer.get("email", ""), "Buyer Address", customer.get("address", "")),
    ]
    start = 3
    for r_idx, row in enumerate(rows, start=start):
        for c_idx, value in enumerate(row, start=1):
            cell = ws.cell(r_idx, c_idx, value)
            cell.border = border
            cell.alignment = Alignment(vertical="top", wrap_text=True)
            if c_idx in [1, 3]:
                cell.fill = section_fill
                cell.font = bold
    item_start = start + len(rows) + 2
    headers = ["No.", "Part No.", "Description", "Maker", "Qty", "Unit", "Unit Price", "Amount", "HS Code", "Remark"]
    for c_idx, h in enumerate(headers, start=1):
        cell = ws.cell(item_start, c_idx, h)
        cell.fill = header_fill
        cell.font = bold
        cell.border = border
        cell.alignment = Alignment(horizontal="center")
    for r_offset, item in enumerate(items, start=1):
        values = [
            item["item_no"],
            item["part_no"],
            item["description"],
            item["maker"],
            item["qty"],
            item["unit"],
            item["unit_price"],
            item["amount"],
            item.get("hs_code", ""),
            item.get("remark", ""),
        ]
        for c_idx, value in enumerate(values, start=1):
            cell = ws.cell(item_start + r_offset, c_idx, value)
            cell.border = border
            cell.alignment = Alignment(vertical="top", wrap_text=True)
            if c_idx in [7, 8]:
                cell.number_format = "#,##0.00"

    total_row = item_start + len(items) + 2
    total_values = [
        ("Supply Amount / 공급가액", totals["subtotal"]),
        ("VAT / 부가세", totals["vat"]),
        ("Total / 합계", totals["total"]),
    ]
    for i, (label, value) in enumerate(total_values):
        r = total_row + i
        ws.cell(r, 7, label).fill = section_fill
        ws.cell(r, 7).font = bold
        ws.cell(r, 7).border = border
        ws.cell(r, 8, value).border = border
        ws.cell(r, 8).number_format = "#,##0.00"

    note_row = total_row + 5
    ws.merge_cells(start_row=note_row, start_column=1, end_row=note_row + 2, end_column=10)
    ws.cell(note_row, 1).value = (
        "Note: This sheet is a data-preparation document only. Actual electronic tax invoice issuance must be processed "
        "through Hometax or an authorized e-tax invoice provider/ERP after tax review. / 본 시트는 발행용 데이터이며 실제 전자세금계산서 발행은 홈택스 또는 공인 발급 시스템에서 세무 검토 후 진행하십시오."
    )
    ws.cell(note_row, 1).alignment = Alignment(wrap_text=True, vertical="top")
    ws.cell(note_row, 1).border = border

    widths = [10, 20, 35, 24, 10, 10, 16, 18, 16, 35]
    for idx, width in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(idx)].width = width
    for row in ws.iter_rows():
        for cell in row:
            cell.alignment = cell.alignment.copy(wrap_text=True, vertical="top")
    output = io.BytesIO()
    wb.save(output)
    return output.getvalue()
