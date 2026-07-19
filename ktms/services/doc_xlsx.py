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
_TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates"
_REPO_DIR = Path(__file__).resolve().parents[2]


def _find_asset(*names: str) -> Optional[str]:
    """자산 이미지(로고·서명·직인)를 config/ · templates/ · 저장소 루트에서 찾는다.
    templates/ 는 git 에 커밋되므로 커밋된 아이콘 로고(logo_icon.jpg 등)를 여기 두면 배포에 반영된다.
    이름 우선순위가 폴더보다 우선 — 앞선 이름(아이콘)이 있으면 배포본 텍스트 로고보다 먼저 선택된다."""
    for n in names:
        for root in (_TEMPLATES_DIR, _CONFIG_DIR, _REPO_DIR):
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
        ("", ""),
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

    # Shipping Marks(케이스 마킹)는 별도 문서로 분리 — CI Excel 에는 출력하지 않는다.

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


def _pkg_text_xlsx(it: Dict[str, Any]) -> str:
    """'No. & Kind of Packages' 셀 — 수량+종류 결합, 없으면 레거시 package."""
    q = str(it.get("pkg_qty") or "").strip()
    k = str(it.get("pkg_kind") or "").strip()
    combined = f"{q} {k}".strip()
    return combined or str(it.get("package") or "").strip()


def make_packing_list_xlsx(
    data: Dict[str, Any], company: Optional[Dict[str, Any]] = None
) -> bytes:
    """Packing List 전용 Excel — Commercial Invoice 와 같은 섹션 구조. 가격 열은 없고
    포장(No.&Kind of Packages)·중량(N.W./G.W.)·용적(Measurement) 열과 합계행을 갖는다."""
    company = company or {}
    customer = data.get("customer", {}) or {}
    vessel = data.get("vessel", {}) or {}
    shipping = data.get("shipping", {}) or {}
    items = normalize_items(data.get("items", []))
    num_fmt = "#,##0.###"

    wb = Workbook()
    ws = wb.active
    ws.title = "Packing List"
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

    NCOL = 9
    widths = [6, 20, 14, 7, 8, 13, 11, 11, 12]
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

    def add_image(path, anchor, w, h):
        try:
            from openpyxl.drawing.image import Image as XLImage
            img = XLImage(path); img.width = w; img.height = h
            ws.add_image(img, anchor)
            return True
        except Exception:
            return False

    def pairs_block(rows, start_row):
        """label:value 쌍을 한 행에 2쌍씩(좌: 1-5, 우: 6-9) 배치."""
        r = start_row
        for i in range(0, len(rows), 2):
            chunk = rows[i:i + 2]
            k, v = chunk[0]
            merge(r, 1, r, 2); put(r, 1, k, fill=gray, font=boldsm, align=left)
            merge(r, 3, r, 5); put(r, 3, v, font=normal, align=left)
            bd(r, 1, r, 5)
            if len(chunk) > 1:
                k2, v2 = chunk[1]
                merge(r, 6, r, 7); put(r, 6, k2, fill=gray, font=boldsm, align=left)
                merge(r, 8, r, 9); put(r, 8, v2, font=normal, align=left)
            else:
                merge(r, 6, r, 9)
            bd(r, 6, r, 9)
            r += 1
        return r

    r = 1
    logo = _find_asset("logo_K-maris.png", "logo.png", "logo.jpg", "logo.jpeg")
    if logo:
        add_image(logo, f"A{r}", 105, 35)
    merge(r, 1, r, NCOL); put(r, 1, "PACKING LIST", font=white_lg, align=center)
    bd(r, 1, r, NCOL); ws.row_dimensions[r].height = 53.6; r += 1
    banner = "   |   ".join(x for x in [
        company.get("company_name_en", "K-MARIS Energy & Solutions Co., Ltd."),
        company.get("sales_email", ""), company.get("website", ""),
    ] if x)
    merge(r, 1, r, NCOL); put(r, 1, banner, fill=blue, font=white_sm, align=center)
    bd(r, 1, r, NCOL, blue); ws.row_dimensions[r].height = 16; r += 2

    # ── Exporter / Packing list information ──────────────────────────────
    merge(r, 1, r, 5); put(r, 1, "EXPORTER / SELLER", fill=section, font=white_sec, align=left)
    merge(r, 6, r, 9); put(r, 6, "PACKING LIST INFORMATION", fill=section, font=white_sec, align=left)
    bd(r, 1, r, 5, section); bd(r, 6, r, 9, section); r += 1
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
    pl_info = [
        ("P/L No.", data.get("doc_no", "")),
        ("P/L Date", data.get("date", "")),
        ("Invoice No.", shipping.get("ci_no", "")),
        ("P.O. No.", shipping.get("po_no", "")),
        ("", ""),
    ]
    for i in range(5):
        merge(r, 1, r, 5); put(r, 1, exporter[i], font=normal, align=left); bd(r, 1, r, 5)
        merge(r, 6, r, 7); put(r, 6, pl_info[i][0], fill=gray, font=boldsm, align=left)
        merge(r, 8, r, 9); put(r, 8, pl_info[i][1], font=normal, align=left); bd(r, 6, r, 9)
        if i == 3:
            ws.row_dimensions[r].height = 17.6
        r += 1

    # ── Consignee / Ship-to ──────────────────────────────────────────────
    merge(r, 1, r, 5); put(r, 1, "CONSIGNEE / BUYER", fill=section, font=white_sec, align=left)
    merge(r, 6, r, 9); put(r, 6, "SHIP TO / C/O", fill=section, font=white_sec, align=left)
    bd(r, 1, r, 5, section); bd(r, 6, r, 9, section); r += 1
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
        merge(r, 1, r, 5); put(r, 1, buyer[i], font=normal, align=left); bd(r, 1, r, 5)
        merge(r, 6, r, 7); put(r, 6, ship_to[i][0], fill=gray, font=boldsm, align=left)
        merge(r, 8, r, 9); put(r, 8, ship_to[i][1], font=normal, align=left); bd(r, 6, r, 9)
        r += 1

    # ── Shipping information ─────────────────────────────────────────────
    merge(r, 1, r, NCOL); put(r, 1, "SHIPPING INFORMATION", fill=section, font=white_sec, align=left)
    bd(r, 1, r, NCOL, section); r += 1
    r = pairs_block([
        ("Vessel", shipping.get("sm_vessel", "") or vessel.get("name", "")),
        ("Carrier", shipping.get("carrier", "")),
        ("Port of Loading", shipping.get("port_loading", "")),
        ("Port of Discharge", shipping.get("port_discharge", "")),
        ("ETD", shipping.get("etd", "")),
        ("ETA", shipping.get("eta", "")),
        ("Country of Origin", shipping.get("sm_origin", "")),
        ("Final Destination", shipping.get("sm_final_dest", "")),
    ], r)

    # ── Shipping marks ───────────────────────────────────────────────────
    merge(r, 1, r, NCOL); put(r, 1, "SHIPPING MARKS", fill=section, font=white_sec, align=left)
    bd(r, 1, r, NCOL, section); r += 1
    marks = _compose_marks(shipping) or (shipping.get("shipping_marks") or "").strip()
    mark_lines = marks.splitlines()
    split_at = (len(mark_lines) + 1) // 2
    marks_h = 5
    merge(r, 1, r + marks_h - 1, 5)
    put(r, 1, "\n".join(mark_lines[:split_at]), font=normal, align=left_top)
    merge(r, 6, r + marks_h - 1, 9)
    put(r, 6, "\n".join(mark_lines[split_at:]), font=normal, align=left_top)
    bd(r, 1, r + marks_h - 1, 5)
    bd(r, 6, r + marks_h - 1, 9)
    r += marks_h

    # ── 품목 표(가격 없음) ─────────────────────────────────────────────────
    hrow = r
    heads = ["No.", "Description", "Part No.", "Q'ty", "Unit", "No. & Kind of Packages",
             "N.W. (kg)", "G.W. (kg)", "Meas. (m³)"]
    for c, h in enumerate(heads, start=1):
        put(hrow, c, h, fill=navy, font=white_hdr, align=center)
    bd(hrow, 1, hrow, NCOL, navy); ws.row_dimensions[hrow].height = 26
    r = hrow + 1
    first_data = r

    def _numval(v):
        try:
            f = float(v)
            return f if f else ""
        except (TypeError, ValueError):
            return str(v).strip() if v not in (None, "") else ""

    for i, it in enumerate(items):
        put(r, 1, it["item_no"], align=center)
        put(r, 2, it["description"], align=left)
        put(r, 3, it["part_no"], align=left)
        put(r, 4, _num(it["qty"]), align=center)
        put(r, 5, it["unit"], align=center)
        put(r, 6, _pkg_text_xlsx(it), align=left)
        put(r, 7, _numval(it.get("net_weight")), align=right, fmt=num_fmt)
        put(r, 8, _numval(it.get("gross_weight")), align=right, fmt=num_fmt)
        put(r, 9, _numval(it.get("measurement")), align=right, fmt=num_fmt)
        if i % 2 == 1:
            for cc in range(1, NCOL + 1):
                ws.cell(r, cc).fill = alt
        bd(r, 1, r, NCOL); ws.row_dimensions[r].height = 18
        r += 1
    last_data = r - 1 if items else first_data

    # ── 합계행 — 포장 수량/중량/용적 자동합산(수식) ──────────────────────
    tot_pkgs = sum(_num(it.get("pkg_qty")) for it in items)
    merge(r, 1, r, 5); put(r, 1, "TOTAL", fill=lightblue, font=bold, align=right)
    put(r, 6, (tot_pkgs or ""), fill=lightblue, font=bold, align=right)
    for c in (7, 8, 9):
        col = get_column_letter(c)
        formula = f"=SUM({col}{first_data}:{col}{last_data})" if items else 0
        put(r, c, formula, fill=lightblue, font=bold, align=right, fmt=num_fmt)
    bd(r, 1, r, NCOL); ws.row_dimensions[r].height = 18
    r += 2

    # ── Packing Information(자유 메모) ────────────────────────────────────
    packing_info = (data.get("packing_info") or "").strip()
    if packing_info:
        merge(r, 1, r, NCOL); put(r, 1, "PACKING INFORMATION", fill=section, font=white_sec, align=left)
        bd(r, 1, r, NCOL, section); r += 1
        merge(r, 1, r + 1, NCOL); put(r, 1, packing_info, font=normal, align=left_top)
        bd(r, 1, r + 1, NCOL); r += 2

    merge(r, 1, r, NCOL)
    put(r, 1, "We hereby certify that this Packing List is true and correct.",
        font=normal, align=left); bd(r, 1, r, NCOL); r += 2

    # ── 서명 / 직인 ───────────────────────────────────────────────────────
    sig_row = r
    ws.row_dimensions[sig_row].height = 28
    ws.row_dimensions[sig_row + 1].height = 20.15
    ws.row_dimensions[sig_row + 2].height = 21
    merge(sig_row, 1, sig_row + 2, 5)
    put(sig_row, 1, "Authorized Signature", font=boldsm, align=left_top); bd(sig_row, 1, sig_row + 2, 5)
    merge(sig_row, 6, sig_row + 2, 9)
    put(sig_row, 6, f"{company.get('company_name_en', '')}\n(Company Stamp)", font=boldsm, align=left_top)
    bd(sig_row, 6, sig_row + 2, 9)
    sign = _find_asset("Authorized signature_Sungyeon Cho.jpg", "signature.png", "signature.jpg", "sign.png")
    stamp = _find_asset("Company stamp_K-Maris Energy & Solutions.jpg", "stamp.png", "stamp.jpg", "seal.png")
    if sign:
        add_image(sign, f"B{sig_row + 1}", 130, 44)
    if stamp:
        add_image(stamp, f"G{sig_row + 1}", 78, 78)

    final_row = sig_row + 2
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.orientation = ws.ORIENTATION_PORTRAIT
    ws.page_setup.scale = 90
    ws.page_setup.fitToWidth = None
    ws.page_setup.fitToHeight = None
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.print_area = f"A1:I{final_row}"
    ws.sheet_view.zoomScale = 75
    ws.page_margins.left = 0.25
    ws.page_margins.right = 0.25
    ws.page_margins.top = 0.3
    ws.page_margins.bottom = 0.3

    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def make_shipping_mark_xlsx(
    data: Dict[str, Any], company: Optional[Dict[str, Any]] = None
) -> bytes:
    """Shipping Mark(케이스 마킹) Excel — PDF(_make_shipping_mark_pdf)와 같은 구성:
    타이틀·배너 → 참조 스트립(REF/P.O./DATE) → 주 마크 박스 → 실측표 → 취급주의.

    범용 make_document_xlsx 를 쓰지 않는 이유: 그쪽은 품목표 문서(CI/PL/PO)용이고
    Shipping Mark 은 품목이 없는 마킹 라벨이라 형태가 전혀 다르다.
    마크 박스는 스텐실로 옮겨 적는 원본이므로 PDF 와 같은 줄·같은 순서로 유지한다.
    """
    company = company or {}
    vessel = data.get("vessel", {}) or {}
    shipping = data.get("shipping", {}) or {}

    wb = Workbook()
    ws = wb.active
    ws.title = "Shipping Mark"
    ws.sheet_view.showGridLines = False

    navy = PatternFill("solid", fgColor="0B1D3A")
    blue = PatternFill("solid", fgColor="0055A8")

    title_font = Font(name="Noto Sans KR", color="0B1D3A", bold=True, size=19)
    white_sm = Font(name="Noto Sans KR", color="FFFFFF", size=9)
    white_lbl = Font(name="Noto Sans KR", color="FFFFFF", bold=True, size=9)
    normal = Font(name="Noto Sans KR", size=9)
    mark_font = Font(name="Noto Sans KR", bold=True, size=13)

    thin = Side(style="thin", color="C8D2E0")
    bdr = Border(top=thin, bottom=thin, left=thin, right=thin)
    thick = Side(style="medium", color="000000")
    center = Alignment(horizontal="center", vertical="center", wrap_text=True)
    left = Alignment(horizontal="left", vertical="center", wrap_text=True)

    NCOL = 6
    for i, w in enumerate([13, 20, 12, 18, 10, 16], start=1):
        ws.column_dimensions[get_column_letter(i)].width = w

    def merge(r1, c1, r2, c2):
        ws.merge_cells(start_row=r1, start_column=c1, end_row=r2, end_column=c2)

    def bd(r1, c1, r2, c2, fill=None, border=bdr):
        for rr in range(r1, r2 + 1):
            for cc in range(c1, c2 + 1):
                ws.cell(rr, cc).border = border
                if fill:
                    ws.cell(rr, cc).fill = fill

    def put(r, c, v="", *, fill=None, font=None, align=None):
        x = ws.cell(r, c, v)
        if fill:
            x.fill = fill
        if font:
            x.font = font
        if align:
            x.alignment = align
        return x

    r = 1
    logo = _find_asset("logo_K-maris.png", "logo.png", "logo.jpg", "logo.jpeg")
    if logo:
        try:
            from openpyxl.drawing.image import Image as XLImage
            img = XLImage(logo)
            img.width, img.height = 105, 35
            ws.add_image(img, f"A{r}")
        except Exception:
            pass   # 로고는 장식 — 없거나 실패해도 문서는 나와야 한다.
    merge(r, 1, r, NCOL); put(r, 1, "SHIPPING MARK", font=title_font, align=center)
    bd(r, 1, r, NCOL); ws.row_dimensions[r].height = 53.6; r += 1

    banner = "   |   ".join(x for x in [
        company.get("company_name_en", "K-MARIS Energy & Solutions Co., Ltd."),
        company.get("sales_email", ""), company.get("website", ""),
    ] if x)
    merge(r, 1, r, NCOL); put(r, 1, banner, fill=blue, font=white_sm, align=center)
    bd(r, 1, r, NCOL, blue); ws.row_dimensions[r].height = 16; r += 2

    # ── 참조 스트립 ──────────────────────────────────────────────────────
    for c, (label, value) in enumerate([
        ("REF. NO.", shipping.get("sm_ref_no", "")),
        ("P.O. NO.", shipping.get("sm_po_no", "")),
        ("DATE", data.get("date", "")),
    ]):
        lc = c * 2 + 1
        put(r, lc, label, fill=navy, font=white_lbl, align=left)
        put(r, lc + 1, value, font=normal, align=left)
    bd(r, 1, r, NCOL); ws.row_dimensions[r].height = 20; r += 2

    # ── 주 마크 박스 — PDF 와 같은 줄 구성. 한 셀에 줄바꿈으로 넣어야 스텐실용으로
    #    그대로 복사된다(줄마다 행을 쓰면 붙여넣을 때 셀이 쪼개진다).
    lines = []
    if shipping.get("sm_type"):
        lines.append(str(shipping["sm_type"]).upper())
    if shipping.get("sm_consignee"):
        lines.append(f"C/O {shipping['sm_consignee']}")
    if shipping.get("sm_vessel"):
        lines.append(f"M/V {str(shipping['sm_vessel']).upper()}")
    elif vessel.get("name"):
        lines.append(f"M/V {str(vessel['name']).upper()}")
    if shipping.get("sm_po_no"):
        lines.append(f"P.O. NO. : {shipping['sm_po_no']}")
    if shipping.get("sm_ref_no"):
        lines.append(f"REF. NO. : {shipping['sm_ref_no']}")
    if shipping.get("sm_desc"):
        lines.append(str(shipping["sm_desc"]).upper())
    if shipping.get("sm_port_delivery"):
        lines.append(f"PORT OF DELIVERY : {str(shipping['sm_port_delivery']).upper()}")
    if shipping.get("sm_final_dest"):
        lines.append(f"FINAL DESTINATION : {str(shipping['sm_final_dest']).upper()}")
    if shipping.get("sm_case_no"):
        lines.append(f"CASE NO. : {shipping['sm_case_no']}")
    if shipping.get("sm_origin"):
        lines.append(str(shipping["sm_origin"]).upper())
    if not lines:
        lines.append("(NO SHIPPING MARK DATA)")

    box_top = r
    box_bottom = r + 15
    merge(box_top, 1, box_bottom, NCOL)
    put(box_top, 1, "\n".join(lines), font=mark_font, align=center)
    bd(box_top, 1, box_bottom, NCOL,
       border=Border(top=thick, bottom=thick, left=thick, right=thick))
    for rr in range(box_top, box_bottom + 1):
        ws.row_dimensions[rr].height = 18
    r = box_bottom + 2

    # ── 실측(중량·치수·케이스) ────────────────────────────────────────────
    dim = [shipping.get("sm_dim_l"), shipping.get("sm_dim_w"), shipping.get("sm_dim_h")]
    dim_txt = (" × ".join((str(d).strip() if d and str(d).strip() else "-") for d in dim) + " MM"
               if any(d and str(d).strip() for d in dim) else "")
    metrics = [
        [("N.W.", f"{shipping['sm_net_weight']} KG" if shipping.get("sm_net_weight") else ""),
         ("G.W.", f"{shipping['sm_gross_weight']} KG" if shipping.get("sm_gross_weight") else "")],
        [("DIMENSION", dim_txt),
         ("TOTAL CASES", f"{shipping['sm_total_cases']} CASE(S)" if shipping.get("sm_total_cases") else "")],
    ]
    for row in metrics:
        (k1, v1), (k2, v2) = row
        put(r, 1, k1, fill=navy, font=white_lbl, align=left)
        merge(r, 2, r, 3); put(r, 2, v1, font=normal, align=left)
        put(r, 4, k2, fill=navy, font=white_lbl, align=left)
        merge(r, 5, r, 6); put(r, 5, v2, font=normal, align=left)
        bd(r, 1, r, NCOL); ws.row_dimensions[r].height = 20; r += 1

    # ── 취급 주의 ────────────────────────────────────────────────────────
    handling = str(shipping.get("sm_handling") or "").strip()
    if handling:
        put(r, 1, "HANDLING", fill=navy, font=white_lbl, align=left)
        merge(r, 2, r, NCOL)
        put(r, 2, " · ".join(h.strip() for h in handling.split(",") if h.strip()),
            font=normal, align=left)
        bd(r, 1, r, NCOL); ws.row_dimensions[r].height = 20

    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def make_document_xlsx(
    doc_type: str, data: Dict[str, Any], company: Optional[Dict[str, Any]] = None
) -> bytes:
    # 라우트가 company 를 안 넘기면(대부분) 설정(company.json)에서 로드 — PDF 경로와 동일.
    if company is None:
        try:
            from services.pdf_svc import _load_company
            company = _load_company()
        except Exception:
            company = {}
    if doc_type == "quotation":
        return make_quotation_costing_xlsx(data, company)
    if doc_type == "shipping_mark":
        return make_shipping_mark_xlsx(data, company)
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


def make_quotation_costing_xlsx(
    data: Dict[str, Any], company: Optional[Dict[str, Any]] = None
) -> bytes:
    """고객 견적서(COSTING SHEET) Excel — sales + PURCHASE(원가) + MARGIN 포함(내부용)."""
    from services.kmaris_docs import quotation_standard_terms

    company = company or {}
    customer = data.get("customer", {}) or {}
    vessel = data.get("vessel", {}) or {}
    terms = data.get("terms", {}) or {}
    currency = (data.get("currency") or "USD").upper()
    raw_items = data.get("items", []) or []
    num_fmt = "#,##0.00" if currency == "USD" else "#,##0"

    wb = Workbook()
    ws = wb.active
    ws.title = "Quotation"
    ws.sheet_view.showGridLines = False

    navy = PatternFill("solid", fgColor="0B1D3A")
    blue = PatternFill("solid", fgColor="0055A8")
    gray = PatternFill("solid", fgColor="F4F6F8")
    lightblue = PatternFill("solid", fgColor="EAF3FF")
    cost_fill = PatternFill("solid", fgColor="FFFFCC")   # PURCHASE 열 톤(샘플: 연노랑)
    alt = PatternFill("solid", fgColor="FAFBFC")

    white_lg = Font(name="Calibri", color="FFFFFF", bold=True, size=15)
    white_sm = Font(name="Calibri", color="FFFFFF", size=9)
    white_hdr = Font(name="Calibri", color="FFFFFF", bold=True, size=11)
    bold = Font(name="Calibri", bold=True)
    boldsm = Font(name="Calibri", bold=True, size=9)

    thin = Side(style="thin", color="D8DEE6")
    bdr = Border(top=thin, bottom=thin, left=thin, right=thin)
    center = Alignment(horizontal="center", vertical="center", wrap_text=True)
    left = Alignment(horizontal="left", vertical="center", wrap_text=True)
    right = Alignment(horizontal="right", vertical="center")

    # No | Part No | Description | Qty | Unit | Cost U/P | Cost Amount | Margin% | U/Price | Amount | Lead Time | Remark
    HEADERS = ["No.", "Part No.", "Description", "Qty", "Unit",
               "Cost U/P", "Cost Amount", "Margin %", "U/Price", "Amount", "Lead Time", "Remark"]
    WIDTHS = [5, 18, 34, 7, 7, 13, 14, 9, 13, 15, 14, 20]
    NCOL = len(HEADERS)

    def merge(r1, c1, r2, c2):
        ws.merge_cells(start_row=r1, start_column=c1, end_row=r2, end_column=c2)

    def add_image(path, anchor, w, h):
        try:
            from openpyxl.drawing.image import Image as XLImage
            img = XLImage(path); img.width = w; img.height = h
            ws.add_image(img, anchor)
        except Exception:
            pass

    # ── 레터헤드: 아이콘 로고(좌, 텍스트 없는 심볼 우선) + 회사정보(중) + 태그라인(우) ──
    # 텍스트가 빠진 아이콘 로고를 쓰려면 config/ 또는 저장소 루트에 logo_icon.png(또는
    # logo_mark/logo_symbol) 파일을 두면 그것을 우선 사용한다. 없으면 기존 로고로 대체.
    logo = _find_asset("logo_icon.jpg", "logo_icon.png", "logo_mark.png", "logo_symbol.png",
                       "logo_K-maris.png", "logo.png", "logo.jpg")
    if logo:
        add_image(logo, "A1", 96, 85)
    hd_name = Font(name="Calibri", bold=True, size=14, color="0B1D3A")
    hd_addr = Font(name="Calibri", size=8, color="555555")
    hd_tag = Font(name="Calibri", italic=True, size=10, color="0055A8")
    addr = company.get("address_en") or company.get("address") or ""
    bits = []
    if company.get("phone"): bits.append(f"Tel: {company['phone']}")
    if company.get("sales_email"): bits.append(company["sales_email"])
    if company.get("website"): bits.append(company["website"])
    contact = "   |   ".join(bits)
    merge(1, 3, 1, 9); cc = ws.cell(1, 3, company.get("company_name_en", "K-MARIS Energy & Solutions Co., Ltd.")); cc.font = hd_name; cc.alignment = left
    merge(2, 3, 2, 9); cc = ws.cell(2, 3, addr); cc.font = hd_addr; cc.alignment = left
    merge(3, 3, 3, 9); cc = ws.cell(3, 3, contact); cc.font = hd_addr; cc.alignment = left
    merge(1, 10, 3, NCOL); cc = ws.cell(1, 10, company.get("tagline", "")); cc.font = hd_tag; cc.alignment = Alignment(horizontal="right", vertical="center", wrap_text=True)
    for rr in (1, 2, 3):
        ws.row_dimensions[rr].height = 23
    for col in range(1, NCOL + 1):
        ws.cell(3, col).border = Border(bottom=Side(style="medium", color="0055A8"))
    ws.row_dimensions[4].height = 6
    # ── 타이틀 (샘플처럼 크게) ─────────────────────────────────────────────
    merge(5, 1, 5, NCOL)
    c = ws.cell(5, 1, "QUOTATION / COSTING SHEET"); c.font = Font(name="Calibri", bold=True, size=24, color="0B1D3A"); c.alignment = center
    ws.row_dimensions[5].height = 34
    ws.row_dimensions[6].height = 4

    # 원가(cost) 통화 → 판매 통화 환산계수. Margin 수식에서 통화가 섞일 때 사용.
    cost_cur = (data.get("cost_currency") or currency).upper()
    fx = _num(data.get("fx_rate")) or 0.0
    if cost_cur == currency or fx <= 0:
        factor = 1.0
    elif cost_cur == "KRW" and currency == "USD":
        factor = 1.0 / fx
    elif cost_cur == "USD" and currency == "KRW":
        factor = fx
    else:
        factor = 1.0
    fx_str = f"{factor:.10g}"
    cost_fmt = "#,##0.00" if cost_cur == "USD" else "#,##0"

    # ── Meta (rows 4-8) — 미리보기(PDF) 와 동일한 순서·구성 ────────────
    vat_label = "VAT excluded" if _num(data.get("vat_rate", 0)) == 0 else f"VAT {int(_num(data.get('vat_rate', 0)) * 100)}%"
    meta = [
        ("User", customer.get("name", ""), "Quotation No.", data.get("doc_no", "")),
        ("Messrs", data.get("messrs", ""), "Ref. No.", data.get("ref_no", "")),
        ("Attn.", data.get("attn", "") or customer.get("contact", ""), "Date", data.get("date", "")),
        ("Ship Name", vessel.get("name", ""), "Currency", currency),
        ("Project", data.get("project_title", ""), "VAT", vat_label),
    ]
    # 원가열(F·G·H)은 기본 숨김이므로 메타는 그 열을 피해 좌(1-5)·우(9-12)에 배치.
    for off, (k1, v1, k2, v2) in enumerate(meta, start=7):
        merge(off, 1, off, 2); merge(off, 3, off, 5)
        merge(off, 9, off, 10); merge(off, 11, off, NCOL)
        for col, val, is_label in [(1, k1, True), (3, v1, False), (9, k2, True), (11, v2, False)]:
            cell = ws.cell(off, col, val); cell.alignment = left
            if is_label:
                cell.fill = gray; cell.font = boldsm
        for col in (1, 2, 3, 4, 5, 9, 10, 11, 12):
            ws.cell(off, col).border = bdr
        ws.row_dimensions[off].height = 15

    # ── PURCHASE 그룹 라벨(원가 열 위) ─────────────────────────────────
    GROUP_ROW = 12
    merge(GROUP_ROW, 6, GROUP_ROW, 8)
    gc = ws.cell(GROUP_ROW, 6, f"PURCHASE (internal, {cost_cur})"); gc.fill = cost_fill; gc.font = boldsm; gc.alignment = center
    for col in range(1, NCOL + 1):
        ws.cell(GROUP_ROW, col).border = bdr
        if col < 6 or col > 8:
            ws.cell(GROUP_ROW, col).fill = gray
    ws.row_dimensions[GROUP_ROW].height = 14

    # ── Item header (row 13) ───────────────────────────────────────────
    HROW = 13
    for ci, (h, w) in enumerate(zip(HEADERS, WIDTHS), start=1):
        cell = ws.cell(HROW, ci, h); cell.fill = navy; cell.font = white_hdr
        cell.alignment = center; cell.border = bdr
        ws.column_dimensions[get_column_letter(ci)].width = w
    ws.row_dimensions[HROW].height = 24

    # 컬럼: A No · B Part · C Desc · D Qty · E Unit · F Cost U/P · G Cost Amount
    #       · H Margin% · I U/Price · J Amount · K Lead · L Remark
    first = HROW + 1
    for ri, it in enumerate(raw_items, start=1):
        r = HROW + ri
        qty = _num(it.get("qty", 0))
        unit_price = _num(it.get("unit_price", 0))
        cost = _num(it.get("cost_price", 0))
        # 마진(H)은 입력값(분수), U/Price(I)는 원가·마진으로 계산하는 수식 — 샘플과 동일.
        # margin_pct(예: 35 또는 0.35)를 분수로 정규화. 없으면 원가·판매가에서 유도.
        mp = _num(it.get("margin_pct", 0))
        if mp:
            margin_frac = mp / 100.0 if mp > 1 else mp
        else:
            csell = cost * factor
            margin_frac = (1 - csell / unit_price) if unit_price else 0.0
        cells = {
            1: ri, 2: it.get("part_no", ""), 3: it.get("description", ""),
            4: qty, 5: it.get("unit", ""),
            6: cost,                                   # Cost U/P (입력, 원가통화)
            7: f"=D{r}*F{r}",                          # Cost Amount = Qty × Cost
            8: margin_frac,                            # Margin % (입력, 분수)
            # U/Price = 원가(판매통화 환산) ÷ (1−마진), 100단위 올림 — 샘플 수식.
            9: f"=IF(OR(F{r}=0,H{r}>=1),0,ROUNDUP(F{r}*{fx_str}/(1-H{r}),-2))",
            10: f"=D{r}*I{r}",                         # Amount = Qty × U/Price
            11: str(it.get("lead_time", "") or ""), 12: it.get("remark", ""),
        }
        for ci, val in cells.items():
            cell = ws.cell(r, ci, val); cell.border = bdr
            if ci in (6, 7, 8):   # 원가열만 연노랑 음영(샘플엔 판매열 zebra 없음)
                cell.fill = cost_fill
            if ci in (4, 9, 10):
                cell.alignment = right
                if ci in (9, 10):
                    cell.number_format = num_fmt
            elif ci in (6, 7):
                cell.alignment = right; cell.number_format = cost_fmt
            elif ci == 8:
                cell.alignment = right; cell.number_format = '0.0%'
            elif ci in (1, 5):
                cell.alignment = center
            else:
                cell.alignment = left
        # 줄바꿈 텍스트가 잘리지 않도록 Description(C, ~40자/줄)·Remark(L, ~26자/줄)
        # 내용에 맞춰 행 높이를 늘린다(고정 18은 2줄 이상에서 겹침).
        _desc = str(it.get("description", "") or ""); _rmk = str(it.get("remark", "") or "")
        _dl = sum(max(1, (len(x) + 39) // 40) for x in _desc.split("\n")) if _desc else 1
        _rl = sum(max(1, (len(x) + 25) // 26) for x in _rmk.split("\n")) if _rmk else 1
        ws.row_dimensions[r].height = 14 * max(_dl, _rl, 1) + 5
    # 샘플처럼 최소 5줄의 폼 형태 — 품목이 적어도 빈 줄로 표 높이를 유지(Total 위치 고정).
    MIN_ITEM_ROWS = 5
    for ri in range(len(raw_items) + 1, MIN_ITEM_ROWS + 1):
        r = HROW + ri
        for ci in range(1, NCOL + 1):
            cell = ws.cell(r, ci); cell.border = bdr
            if ci in (6, 7, 8):
                cell.fill = cost_fill
        ws.row_dimensions[r].height = 18
    last = HROW + max(len(raw_items), MIN_ITEM_ROWS)

    # ── Totals (수식) ──────────────────────────────────────────────────
    trow = last + 1
    has_rows = len(raw_items) > 0
    tc = ws.cell(trow, 3, "Total"); tc.font = bold; tc.alignment = right; tc.border = bdr
    for col in (1, 2, 4, 5, 11, 12):
        ws.cell(trow, col).border = bdr
    cost_sum = f"=SUM(G{first}:G{last})" if has_rows else 0
    amt_sum = f"=SUM(J{first}:J{last})" if has_rows else 0
    margin_tot = f"=IF(J{trow}=0,0,(J{trow}-G{trow}*{fx_str})/J{trow})" if has_rows else 0
    for col, val, fill in [(6, "", cost_fill), (7, cost_sum, cost_fill), (8, margin_tot, cost_fill),
                           (9, "", lightblue), (10, amt_sum, lightblue)]:
        cell = ws.cell(trow, col, val); cell.border = bdr; cell.fill = fill; cell.font = bold; cell.alignment = right
        if col == 7:
            cell.number_format = cost_fmt
        if col == 10:
            cell.number_format = num_fmt
        if col == 8:
            cell.number_format = '0.0%'

    # 섹션 헤더(네이비 바) 헬퍼.
    def section_bar(r, title):
        merge(r, 1, r, NCOL)
        c = ws.cell(r, 1, title); c.fill = navy; c.font = white_hdr; c.alignment = left
        for col in range(1, NCOL + 1):
            ws.cell(r, col).fill = navy
        ws.row_dimensions[r].height = 16

    # ── Terms & Conditions ─────────────────────────────────────────────
    r = trow + 2
    section_bar(r, "Terms & Conditions"); r += 1
    for line in quotation_standard_terms(terms):
        merge(r, 1, r, NCOL)
        ws.cell(r, 1, f"• {line}").alignment = left
        ws.row_dimensions[r].height = 13
        r += 1

    # ── Payment ────────────────────────────────────────────────────────
    r += 1
    section_bar(r, "Payment"); r += 1
    for line in (terms.get("payment_terms") or "T/T in advance",
                 "Once order is confirmed by the supplier, the order is unable to be cancelled without "
                 "cancellation charge of 100% of the ordered amount."):
        merge(r, 1, r, NCOL)
        ws.cell(r, 1, f"• {line}").alignment = left
        ws.row_dimensions[r].height = 13
        r += 1
    r += 1
    merge(r, 1, r, NCOL)
    ws.cell(r, 1, "We hope this quotation meets your requirement and to receive your order "
            "confirmation at your earliest convenience.").alignment = left
    r += 2

    # ── 서명 ───────────────────────────────────────────────────────────
    merge(r, 1, r, NCOL); ws.cell(r, 1, "Your sincerely").alignment = left
    sig = _find_asset("Authorized signature_Sungyeon Cho.jpg", "signature.png", "signature.jpg")
    if sig:
        try:
            from openpyxl.drawing.image import Image as XLImage
            img = XLImage(sig); img.width = 150; img.height = 52
            ws.add_image(img, f"A{r + 1}")
        except Exception:
            pass
    r += 4
    ws.cell(r, 1, "________________________").alignment = left; r += 1
    ws.cell(r, 1, "Sam Cho, Managing Director").font = bold; r += 1
    ws.cell(r, 1, "K-MARIS Energy & Solutions | Seoul, Korea | www.k-maris.com").font = Font(name="Calibri", size=9)
    last_row = r

    # ── 원가/마진 열(F·G·H)은 기본 숨김(내부 코스팅용) — 필요시 사용자가 펼침 ──
    for col in ("F", "G", "H"):
        ws.column_dimensions[col].hidden = True

    ws.freeze_panes = f"A{HROW + 1}"
    # A4 세로 1페이지 폭에 맞춰 인쇄(PDF 미리보기와 동일한 세로 규격).
    # 숨긴 원가열은 인쇄 폭 계산에서 제외되어 판매 열만 세로로 깔끔히 맞는다.
    ws.print_area = f"A1:{get_column_letter(NCOL)}{last_row}"
    ws.page_setup.orientation = ws.ORIENTATION_PORTRAIT
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_margins.left = 0.3
    ws.page_margins.right = 0.3
    ws.page_margins.top = 0.4
    ws.page_margins.bottom = 0.4

    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()
