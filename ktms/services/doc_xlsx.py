"""견적서·발주서 Excel 생성 — make_pdf 와 동일한 payload 를 소비한다. openpyxl only.

내장 PDF(kmaris_docs.make_pdf)와 같은 데이터(payload)를 받아 Excel 로 렌더링해,
사용자가 문서를 PDF/Excel 중 선택해 내려받거나 이메일에 첨부할 수 있게 한다.
"""
from __future__ import annotations

import io
from pathlib import Path
from typing import Any, Dict, Optional

from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
from openpyxl.utils import get_column_letter

from services.kmaris_docs import normalize_items, calc_totals, _num, DOC_TITLES

_CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"
_REPO_DIR = Path(__file__).resolve().parents[2]


def _find_asset(*names: str) -> Optional[str]:
    """config/ 에서 자산 이미지(로고·서명·직인)를 찾는다. 없으면 None(선택 자산)."""
    for root in (_REPO_DIR, _CONFIG_DIR):
        for n in names:
            p = root / n
            if p.exists():
                return str(p)
    return None


def _compose_marks(sh: Dict[str, Any]) -> str:
    """구조화 Shipping Marks(sm_*)를 여러 줄 문자열로 합성 — 프론트 composeShippingMarks 와
    동일 규약(무게·치수 포함). 저장된 shipping_marks 문자열이 없거나 비어도 항상 재구성한다."""
    lines = []
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


def make_commercial_invoice_xlsx(
    data: Dict[str, Any], company: Optional[Dict[str, Any]] = None
) -> bytes:
    """Commercial Invoice 전용 Excel — 편집 페이지(CI 탭)의 모든 입력을 그대로 반영한다.
    레이아웃: 타이틀 → Exporter/Invoice info → Consignee/Ship-to → Shipping info →
    Shipping marks → 품목표(금액=수식) → 합계(Freight/Packing/Insurance 편집가능) → 포장/선언/서명.
    """
    company = company or {}
    currency = (data.get("currency") or "USD").upper()
    customer = data.get("customer", {}) or {}
    vessel = data.get("vessel", {}) or {}
    terms = data.get("terms", {}) or {}
    shipping = data.get("shipping", {}) or {}
    items = normalize_items(data.get("items", []))
    num_fmt = "#,##0.00" if currency == "USD" else "#,##0"

    wb = Workbook()
    ws = wb.active
    ws.title = "Commercial Invoice"
    ws.sheet_view.showGridLines = False

    navy = PatternFill("solid", fgColor="0B1D3A")
    blue = PatternFill("solid", fgColor="0055A8")
    section = PatternFill("solid", fgColor="1F3B66")
    gray = PatternFill("solid", fgColor="F4F6F8")
    lightblue = PatternFill("solid", fgColor="EAF3FF")
    alt = PatternFill("solid", fgColor="FAFBFC")

    white_lg = Font(name="Noto Sans KR", color="0B1D3A", bold=True, size=19)
    white_sm = Font(name="Noto Sans KR", color="FFFFFF", size=9)
    white_sec = Font(name="Noto Sans KR", color="FFFFFF", bold=True, size=10)
    white_hdr = Font(name="Noto Sans KR", color="FFFFFF", bold=True, size=9)
    bold = Font(name="Noto Sans KR", bold=True)
    boldsm = Font(name="Noto Sans KR", bold=True, size=9)
    normal = Font(name="Noto Sans KR", size=9)

    thin = Side(style="thin", color="C8D2E0")
    bdr = Border(top=thin, bottom=thin, left=thin, right=thin)
    center = Alignment(horizontal="center", vertical="center", wrap_text=True)
    left = Alignment(horizontal="left", vertical="center", wrap_text=True)
    right = Alignment(horizontal="right", vertical="center")
    left_top = Alignment(horizontal="left", vertical="top", wrap_text=True)

    NCOL = 8
    widths = [6, 14.5, 16, 13.5, 12, 8, 14, 18.28515625]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w

    def merge(r1, c1, r2, c2):
        ws.merge_cells(start_row=r1, start_column=c1, end_row=r2, end_column=c2)

    def bd(r1, c1, r2, c2, fill=None):
        for rr in range(r1, r2 + 1):
            for cc in range(c1, c2 + 1):
                ws.cell(rr, cc).border = bdr
                if fill:
                    ws.cell(rr, cc).fill = fill

    def put(r, c, v="", *, fill=None, font=None, align=None, fmt=None):
        x = ws.cell(r, c, v)
        if fill:
            x.fill = fill
        if font:
            x.font = font
        if align:
            x.alignment = align
        if fmt:
            x.number_format = fmt
        return x

    def pairs_block(rows, start_row):
        """label:value 쌍 리스트를 한 행에 2쌍씩(좌: 1-4, 우: 5-8) 배치."""
        r = start_row
        for i in range(0, len(rows), 2):
            chunk = rows[i:i + 2]
            k, v = chunk[0]
            merge(r, 1, r, 2); put(r, 1, k, fill=gray, font=boldsm, align=left)
            merge(r, 3, r, 4); put(r, 3, v, font=normal, align=left)
            bd(r, 1, r, 4)
            if len(chunk) > 1:
                k2, v2 = chunk[1]
                merge(r, 5, r, 6); put(r, 5, k2, fill=gray, font=boldsm, align=left)
                merge(r, 7, r, 8); put(r, 7, v2, font=normal, align=left)
            else:
                merge(r, 5, r, 8)
            bd(r, 5, r, 8)
            r += 1
        return r

    def add_image(path, anchor, w, h):
        try:
            from openpyxl.drawing.image import Image as XLImage
            img = XLImage(path); img.width = w; img.height = h
            ws.add_image(img, anchor)
            return True
        except Exception:
            return False

    r = 1
    # ── 회사 로고(선택: config/logo.png) — 맨 상단 좌측에 얹는다 ─────────────
    logo = _find_asset("logo_K-maris.png", "logo.png", "logo.jpg", "logo.jpeg")
    if logo:
        add_image(logo, f"A{r}", 105, 35)
    # ── 타이틀 + 회사 배너 ────────────────────────────────────────────────
    merge(r, 1, r, NCOL); put(r, 1, "COMMERCIAL INVOICE", font=white_lg, align=center)
    bd(r, 1, r, NCOL); ws.row_dimensions[r].height = 53.6; r += 1
    banner = "   |   ".join(x for x in [
        company.get("company_name_en", "K-MARIS Energy & Solutions Co., Ltd."),
        company.get("sales_email", ""), company.get("website", ""),
    ] if x)
    merge(r, 1, r, NCOL); put(r, 1, banner, fill=blue, font=white_sm, align=center)
    bd(r, 1, r, NCOL, blue); ws.row_dimensions[r].height = 16; r += 2

    # ── Exporter / Invoice information ───────────────────────────────────
    merge(r, 1, r, 4); put(r, 1, "EXPORTER / SELLER", fill=section, font=white_sec, align=left)
    merge(r, 5, r, 8); put(r, 5, "INVOICE INFORMATION", fill=section, font=white_sec, align=left)
    bd(r, 1, r, 4, section); bd(r, 5, r, 8, section); r += 1
    address = company.get("address_en") or company.get("address", "")
    address_top, address_bottom = address, ""
    if " Seoul" in address:
        address_top, address_bottom = address.split(" Seoul", 1)
        address_bottom = "Seoul" + address_bottom
    exporter = [
        company.get("company_name_en", ""),
        address_top,
        address_bottom,
        f"Tel: {company.get('phone', '')}    Email: {company.get('sales_email', '')}",
        f"Business Reg. No.: {company.get('business_no', '')}",
    ]
    inv_info = [
        ("Invoice No.", data.get("doc_no", "")),
        ("Invoice Date", data.get("date", "")),
        ("P.O. No.", shipping.get("po_no", "")),
        ("Quotation Ref.", data.get("quotation_ref") or shipping.get("export_ref", "")),
        ("", ""),
    ]
    for i in range(5):
        merge(r, 1, r, 4); put(r, 1, exporter[i], font=normal, align=left); bd(r, 1, r, 4)
        merge(r, 5, r, 6); put(r, 5, inv_info[i][0], fill=gray, font=boldsm, align=left)
        merge(r, 7, r, 8); put(r, 7, inv_info[i][1], font=normal, align=left); bd(r, 5, r, 8)
        if i == 3:
            ws.row_dimensions[r].height = 17.6
        r += 1

    # ── Consignee / Ship-to ──────────────────────────────────────────────
    merge(r, 1, r, 4); put(r, 1, "CONSIGNEE / BUYER", fill=section, font=white_sec, align=left)
    merge(r, 5, r, 8); put(r, 5, "SHIP TO / C/O", fill=section, font=white_sec, align=left)
    bd(r, 1, r, 4, section); bd(r, 5, r, 8, section); r += 1
    buyer = [
        customer.get("name", ""),
        customer.get("address", ""),
        f"Contact: {customer.get('contact', '')}    {customer.get('email', '')}",
    ]
    ship_to = [
        ("Ship Agent", shipping.get("sm_consignee", "")),
        ("Vessel / IMO", " / ".join(x for x in [shipping.get("sm_vessel", "") or vessel.get("name", ""), vessel.get("imo", "")] if x)),
        ("B/L or AWB No.", shipping.get("bl_awb_no", "")),
    ]
    for i in range(3):
        merge(r, 1, r, 4); put(r, 1, buyer[i], font=normal, align=left); bd(r, 1, r, 4)
        merge(r, 5, r, 6); put(r, 5, ship_to[i][0], fill=gray, font=boldsm, align=left)
        merge(r, 7, r, 8); put(r, 7, ship_to[i][1], font=normal, align=left); bd(r, 5, r, 8)
        r += 1

    # ── Shipping information ─────────────────────────────────────────────
    merge(r, 1, r, NCOL); put(r, 1, "SHIPPING INFORMATION", fill=section, font=white_sec, align=left)
    bd(r, 1, r, NCOL, section); r += 1
    r = pairs_block([
        ("Vessel", shipping.get("sm_vessel", "") or vessel.get("name", "")),
        ("Carrier", shipping.get("carrier", "")),
        ("Port of Loading", shipping.get("port_loading", "")),
        ("Port of Discharge", shipping.get("port_discharge", "")),
        ("Incoterms", terms.get("incoterms", "")),
        ("Payment Terms", terms.get("payment_terms", "")),
        ("ETD", shipping.get("etd", "")),
        ("ETA", shipping.get("eta", "")),
        ("Currency", currency),
        ("Country of Origin", shipping.get("sm_origin", "")),
    ], r)

    # ── Shipping marks ───────────────────────────────────────────────────
    merge(r, 1, r, NCOL); put(r, 1, "SHIPPING MARKS", fill=section, font=white_sec, align=left)
    bd(r, 1, r, NCOL, section); r += 1
    # sm_* 로 항상 재구성(무게 N.W./G.W. · 치수 DIM. 포함). 없으면 저장된 문자열로 폴백.
    marks = _compose_marks(shipping) or (shipping.get("shipping_marks") or "").strip()
    mark_lines = marks.splitlines()
    split_at = (len(mark_lines) + 1) // 2
    marks_h = max(4, len(marks.splitlines()))  # 줄 수만큼 블록 높이 확보
    marks_h = 5
    merge(r, 1, r + marks_h - 1, 4)
    put(r, 1, "\n".join(mark_lines[:split_at]), font=normal, align=left_top)
    merge(r, 5, r + marks_h - 1, 8)
    put(r, 5, "\n".join(mark_lines[split_at:]), font=normal, align=left_top)
    bd(r, 1, r + marks_h - 1, 4)
    bd(r, 5, r + marks_h - 1, 8)
    r += marks_h

    # ── 품목 표 ───────────────────────────────────────────────────────────
    hrow = r
    put(hrow, 1, "No.", fill=navy, font=white_hdr, align=center)
    merge(hrow, 2, hrow, 3); put(hrow, 2, "Description", fill=navy, font=white_hdr, align=center)
    put(hrow, 4, "Part No.", fill=navy, font=white_hdr, align=center)
    put(hrow, 5, "HS Code", fill=navy, font=white_hdr, align=center)
    put(hrow, 6, "Qty", fill=navy, font=white_hdr, align=center)
    put(hrow, 7, "Unit Price", fill=navy, font=white_hdr, align=center)
    put(hrow, 8, f"Amount ({currency})", fill=navy, font=white_hdr, align=center)
    bd(hrow, 1, hrow, NCOL, navy); ws.row_dimensions[hrow].height = 24
    r = hrow + 1
    first_data = r
    for i, it in enumerate(items):
        put(r, 1, it["item_no"], align=center)
        merge(r, 2, r, 3); put(r, 2, it["description"], align=left)
        put(r, 4, it["part_no"], align=left)
        put(r, 5, it.get("hs_code", "") or shipping.get("hs_code", ""), align=center)
        put(r, 6, _num(it["qty"]), align=center)
        put(r, 7, _num(it["unit_price"]), align=right, fmt=num_fmt)
        put(r, 8, f"=F{r}*G{r}", align=right, fmt=num_fmt)  # 금액 = 수량 × 단가(수식)
        if i % 2 == 1:
            for cc in range(1, NCOL + 1):
                ws.cell(r, cc).fill = alt
        bd(r, 1, r, NCOL); ws.row_dimensions[r].height = 18
        r += 1
    last_data = r - 1 if items else first_data

    # ── 합계(수식) — Freight/Packing/Insurance 는 사용자가 채우면 TOTAL 자동합산 ──
    def total_line(label, value, is_total=False):
        nonlocal r
        merge(r, 6, r, 7)
        lc = put(r, 6, label, fill=(lightblue if is_total else gray),
                 font=(bold if is_total else boldsm), align=right)
        vc = put(r, 8, value, align=right, fmt=num_fmt)
        if is_total:
            vc.fill = lightblue; vc.font = bold
            ws.row_dimensions[r].height = 18
        bd(r, 6, r, 8)
        ref = f"H{r}"
        r += 1
        return ref
    sref = total_line("Subtotal", f"=SUM(H{first_data}:H{last_data})" if items else 0)
    fref = total_line("Freight", 0)
    pref = total_line("Packing", 0)
    iref = total_line("Insurance", 0)
    vref = total_line("VAT", f"={sref}*{_num(data.get('vat_rate', 0))}")
    total_line("TOTAL INVOICE VALUE", f"={sref}+{fref}+{pref}+{iref}+{vref}", is_total=True)

    # ── 포장 정보 / 선언 / 서명 ───────────────────────────────────────────
    r += 1
    merge(r, 1, r, NCOL); put(r, 1, "PACKING & DECLARATION", fill=section, font=white_sec, align=left)
    bd(r, 1, r, NCOL, section); r += 1
    r = pairs_block([
        ("Total Packages", shipping.get("sm_total_cases", "")),
        ("Net Weight (kg)", shipping.get("sm_net_weight", "")),
        ("Gross Weight (kg)", shipping.get("sm_gross_weight", "")),
        ("Country of Origin", shipping.get("sm_origin", "")),
    ], r)
    merge(r, 1, r, NCOL)
    put(r, 1, "We hereby certify that this Commercial Invoice is true and correct.",
        font=normal, align=left); bd(r, 1, r, NCOL); r += 2
    sig_row = r
    ws.row_dimensions[sig_row].height = 28
    ws.row_dimensions[sig_row + 1].height = 20.15
    ws.row_dimensions[sig_row + 2].height = 21
    merge(sig_row, 1, sig_row + 2, 4)
    put(sig_row, 1, "Authorized Signature", font=boldsm, align=left_top); bd(sig_row, 1, sig_row + 2, 4)
    merge(sig_row, 5, sig_row + 2, 8)
    put(sig_row, 5, f"{company.get('company_name_en', '')}\n(Company Stamp)", font=boldsm, align=left_top)
    bd(sig_row, 5, sig_row + 2, 8)
    # 서명·직인 이미지(선택: config/signature.png, config/stamp.png) — 라벨 아래에 얹는다.
    sign = _find_asset("Authorized signature_Sungyeon Cho.jpg", "signature.png", "signature.jpg", "sign.png")
    stamp = _find_asset("Company stamp_K-Maris Energy & Solutions.jpg", "stamp.png", "stamp.jpg", "seal.png")
    if sign:
        add_image(sign, f"B{sig_row + 1}", 130, 44)
    if stamp:
        add_image(stamp, f"F{sig_row + 1}", 78, 78)

    final_row = sig_row + 2
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.orientation = ws.ORIENTATION_PORTRAIT
    ws.page_setup.scale = 90
    ws.page_setup.fitToWidth = None
    ws.page_setup.fitToHeight = None
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.print_area = f"A1:H{final_row}"
    ws.sheet_view.zoomScale = 75
    ws.page_margins.left = 0.25
    ws.page_margins.right = 0.25
    ws.page_margins.top = 0.3
    ws.page_margins.bottom = 0.3

    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


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
