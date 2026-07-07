"""견적서·발주서 Excel 생성 — make_pdf 와 동일한 payload 를 소비한다. openpyxl only.

내장 PDF(kmaris_docs.make_pdf)와 같은 데이터(payload)를 받아 Excel 로 렌더링해,
사용자가 문서를 PDF/Excel 중 선택해 내려받거나 이메일에 첨부할 수 있게 한다.
"""
from __future__ import annotations

import io
from typing import Any, Dict, Optional

from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
from openpyxl.utils import get_column_letter

from services.kmaris_docs import normalize_items, calc_totals, _num, DOC_TITLES


def make_document_xlsx(
    doc_type: str, data: Dict[str, Any], company: Optional[Dict[str, Any]] = None
) -> bytes:
    title = DOC_TITLES.get(doc_type, "DOCUMENT")
    is_po = doc_type == "purchase_order"
    currency = (data.get("currency") or "USD").upper()
    customer = data.get("customer", {})   # PO 면 공급사(Vendor)
    vessel = data.get("vessel", {})
    terms = data.get("terms", {})
    items = normalize_items(data.get("items", []))
    totals = calc_totals(
        data.get("items", []), _num(data.get("vat_rate", 0)), _num(data.get("discount_pct", 0))
    )
    num_fmt = "#,##0.00" if currency == "USD" else "#,##0"

    wb = Workbook()
    ws = wb.active
    ws.title = (title.title() or "Document")[:31]

    navy = PatternFill("solid", fgColor="0B1D3A")
    blue = PatternFill("solid", fgColor="0055A8")
    gray = PatternFill("solid", fgColor="F4F6F8")
    lightblue = PatternFill("solid", fgColor="EAF3FF")
    alt = PatternFill("solid", fgColor="FAFBFC")

    white_lg = Font(name="Calibri", color="FFFFFF", bold=True, size=14)
    white_sm = Font(name="Calibri", color="FFFFFF", size=9)
    white_hdr = Font(name="Calibri", color="FFFFFF", bold=True, size=9)
    bold = Font(name="Calibri", bold=True)
    boldsm = Font(name="Calibri", bold=True, size=9)

    thin = Side(style="thin", color="D8DEE6")
    bdr = Border(top=thin, bottom=thin, left=thin, right=thin)
    center = Alignment(horizontal="center", vertical="center", wrap_text=True)
    left = Alignment(horizontal="left", vertical="center", wrap_text=True)
    right = Alignment(horizontal="right", vertical="center")

    HEADERS = ["No.", "Part No.", "Description", "Maker", "Origin", "Qty", "Unit",
               "Unit Price", "Amount", "Lead Time / Remark"]
    WIDTHS = [5, 18, 40, 18, 12, 7, 7, 15, 16, 28]
    NUM_COLS = len(HEADERS)

    def merge(r1, c1, r2, c2):
        ws.merge_cells(start_row=r1, start_column=c1, end_row=r2, end_column=c2)

    # ── Title / sub-header ──────────────────────────────────────────────
    merge(1, 1, 1, NUM_COLS)
    c = ws.cell(1, 1, title); c.fill = navy; c.font = white_lg; c.alignment = center
    ws.row_dimensions[1].height = 28
    merge(2, 1, 2, NUM_COLS)
    c = ws.cell(2, 1, "K-MARIS Energy & Solutions Co., Ltd.  |  sales@k-maris.com  |  www.k-maris.com")
    c.fill = blue; c.font = white_sm; c.alignment = center
    ws.row_dimensions[2].height = 16

    # ── Meta (rows 4-7): 좌측 상대방/선박, 우측 문서정보 ─────────────────
    party = "Supplier / Seller" if is_po else "Customer / Buyer"
    meta = [
        (party, customer.get("name", ""), "Document No.", data.get("doc_no", "")),
        ("Address", customer.get("address", ""), "Date", data.get("date", "")),
        ("Vessel", vessel.get("name", ""), "Currency", currency),
        ("Contact", customer.get("contact", ""), "Incoterms", terms.get("incoterms", "")),
    ]
    for off, (k1, v1, k2, v2) in enumerate(meta, start=4):
        for col, val, is_label in [(1, k1, True), (2, v1, False), (7, k2, True), (8, v2, False)]:
            cell = ws.cell(off, col, val); cell.border = bdr; cell.alignment = left
            if is_label:
                cell.fill = gray; cell.font = boldsm
        merge(off, 2, off, 6); merge(off, 8, off, NUM_COLS)
        for col in range(2, 7):
            ws.cell(off, col).border = bdr
        for col in range(8, NUM_COLS + 1):
            ws.cell(off, col).border = bdr
        ws.row_dimensions[off].height = 15

    # ── Item table header (row 9) ───────────────────────────────────────
    HROW = 9
    for ci, (h, w) in enumerate(zip(HEADERS, WIDTHS), start=1):
        cell = ws.cell(HROW, ci, h); cell.fill = navy; cell.font = white_hdr
        cell.alignment = center; cell.border = bdr
        ws.column_dimensions[get_column_letter(ci)].width = w
    ws.row_dimensions[HROW].height = 26

    # ── Data rows ───────────────────────────────────────────────────────
    for ri, it in enumerate(items, start=1):
        r = HROW + ri
        lead_remark = f"{it.get('lead_time', '')} {it.get('remark', '')}".strip()
        vals = [it["item_no"], it["part_no"], it["description"], it["maker"], it["origin"],
                _num(it["qty"]), it["unit"], _num(it["unit_price"]), _num(it["amount"]), lead_remark]
        for ci, val in enumerate(vals, start=1):
            cell = ws.cell(r, ci, val); cell.border = bdr
            if ri % 2 == 0:
                cell.fill = alt
            if ci in (6, 8, 9):  # Qty · Unit Price · Amount → 우측, 숫자서식
                cell.alignment = right
                if ci in (8, 9):
                    cell.number_format = num_fmt
            elif ci in (1, 7):
                cell.alignment = center
            else:
                cell.alignment = left
        ws.row_dimensions[r].height = 18

    # ── Totals ──────────────────────────────────────────────────────────
    trow = HROW + len(items) + 1
    lines = [("Subtotal", totals.get("subtotal", 0))]
    if totals.get("discount_pct"):
        lines.append((f"Discount ({_num(totals['discount_pct']):g}%)", -totals.get("discount", 0)))
    lines.append(("VAT", totals.get("vat", 0)))
    lines.append(("Total", totals.get("total", 0)))
    for i, (lab, val) in enumerate(lines):
        r = trow + i
        lc = ws.cell(r, 8, lab); lc.fill = gray; lc.font = boldsm; lc.alignment = right; lc.border = bdr
        vc = ws.cell(r, 9, _num(val)); vc.border = bdr; vc.alignment = right; vc.number_format = num_fmt
        ws.cell(r, 10).border = bdr
        if lab == "Total":
            lc.fill = lightblue; vc.fill = lightblue; lc.font = bold; vc.font = bold

    # ── Terms & Conditions ──────────────────────────────────────────────
    tstart = trow + len(lines) + 2
    ws.cell(tstart, 1, "Terms & Conditions").font = bold
    term_rows = [
        ("Incoterms", terms.get("incoterms", "")),
        ("Place", terms.get("delivery_place", "")),
        ("Payment Terms", terms.get("payment_terms", "")),
        ("Packing", terms.get("packing", "")),
        ("Warranty", terms.get("warranty", "")),
        ("Remarks", terms.get("remarks", "")),
    ]
    for i, (k, v) in enumerate(term_rows, start=1):
        r = tstart + i
        kc = ws.cell(r, 1, k); kc.fill = gray; kc.font = boldsm; kc.alignment = left; kc.border = bdr
        merge(r, 2, r, NUM_COLS)
        vc = ws.cell(r, 2, v); vc.alignment = left; vc.border = bdr
        for col in range(2, NUM_COLS + 1):
            ws.cell(r, col).border = bdr

    ws.freeze_panes = f"A{HROW + 1}"

    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()
