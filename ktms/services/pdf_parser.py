"""PDF text extraction + Claude-powered field parsing for RFQ auto-fill."""
from __future__ import annotations
import json
import os
import re


def extract_text_from_pdf(uploaded_file) -> str:
    import pdfplumber
    with pdfplumber.open(uploaded_file) as pdf:
        pages = [page.extract_text() or "" for page in pdf.pages]
    return "\n".join(pages).strip()


def _sanitize_text(text: str) -> str:
    """Remove control chars and collapse whitespace for safe JSON embedding."""
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    text = re.sub(r"\r\n|\r", "\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _fix_unescaped_newlines(raw: str) -> str:
    """Replace literal newlines inside JSON string values with \\n."""
    result = []
    in_str = False
    esc = False
    for ch in raw:
        if esc:
            result.append(ch)
            esc = False
            continue
        if ch == "\\" and in_str:
            result.append(ch)
            esc = True
            continue
        if ch == '"':
            in_str = not in_str
            result.append(ch)
            continue
        if in_str and ch in "\n\r":
            result.append("\\n")
            continue
        if in_str and ch == "\t":
            result.append("\\t")
            continue
        result.append(ch)
    return "".join(result)


def _parse_response(raw: str) -> dict:
    raw = raw.strip()

    # Strip markdown fences
    raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.MULTILINE)
    raw = re.sub(r"\s*```\s*$", "", raw, flags=re.MULTILINE)
    raw = raw.strip()

    # Locate outermost JSON object
    start = raw.find("{")
    if start == -1:
        raise ValueError("응답에서 JSON 객체를 찾을 수 없습니다.")
    end = raw.rfind("}") + 1
    raw = raw[start:end]

    # First try: direct parse
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    # Second try: fix unescaped control characters inside strings
    fixed = _fix_unescaped_newlines(raw)
    try:
        return json.loads(fixed)
    except json.JSONDecodeError:
        pass

    # Last resort: return empty structure rather than crashing
    raise ValueError(
        "AI 응답을 JSON으로 파싱할 수 없습니다. PDF 내용이 복잡하거나 형식이 비정형일 수 있습니다."
    )


def _secret_from_toml(key: str) -> str:
    """로컬 ktms/secrets.toml에서 키를 직접 읽는다(env var 미설정 로컬 dev 대비)."""
    try:
        import tomllib  # Python 3.11+
    except ModuleNotFoundError:
        return ""
    # services/pdf_parser.py → ktms/secrets.toml
    path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "secrets.toml")
    try:
        with open(path, "rb") as fh:
            return str(tomllib.load(fh).get(key, "") or "")
    except (OSError, ValueError):
        return ""


def _anthropic_client():
    """Build an Anthropic client. Key resolution order:
    1) ANTHROPIC_API_KEY env var (production / Render)
    2) local secrets.toml read directly (local FastAPI dev)
    """
    import anthropic

    api_key = os.environ.get("ANTHROPIC_API_KEY", "") or _secret_from_toml("ANTHROPIC_API_KEY")
    if not api_key:
        raise ValueError(
            "ANTHROPIC_API_KEY가 설정되지 않았습니다. 환경변수 또는 ktms/secrets.toml을 확인하세요."
        )
    return anthropic.Anthropic(api_key=api_key)


def parse_rfq_fields(text: str, customer_names: list[str] | None = None) -> dict:
    """Use Claude Haiku to extract structured RFQ fields from raw PDF text."""
    client = _anthropic_client()
    clean_text = _sanitize_text(text)[:4000]

    customer_hint_line = ""
    if customer_names:
        customer_hint_line = (
            f"\nKnown customers (for matching): {', '.join(customer_names[:30])}"
        )

    prompt = f"""Extract RFQ information from the document text below.
Output ONLY a single-line compact JSON object (no newlines, no markdown).{customer_hint_line}

JSON schema (all strings must be on one line, no embedded newlines):
{{
  "vessel_name": string|null,
  "rfq_date": "YYYY-MM-DD"|null,
  "customer_rfq_no": string|null,
  "customer_hint": string|null,
  "notes": string|null,
  "items": [
    {{"part_no":string,"description":string,"maker":string,"qty":number,"unit":string,"lead_time_req":string,"remark":string}}
  ]
}}

Document:
{clean_text}"""

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )
    return _parse_response(response.content[0].text)


_RFQ_SCHEMA = """{
  "vessel_name": string|null,
  "rfq_date": "YYYY-MM-DD"|null,
  "customer_rfq_no": string|null,
  "customer_hint": string|null,
  "contact_person": string|null,
  "notes": string|null,
  "items": [
    {"part_no":string,"description":string,"maker":string,"qty":number,"unit":string,"lead_time_req":string,"remark":string}
  ]
}"""

_ORDER_SCHEMA = """{
  "customer_hint": string|null,
  "po_no": string|null,
  "order_date": "YYYY-MM-DD"|null,
  "vessel_name": string|null,
  "promised_delivery": "YYYY-MM-DD"|null,
  "items": [
    {"part_no":string,"description":string,"maker":string,"qty":number,"unit":string,"unit_price":number,"remark":string}
  ]
}"""


def _customer_hint_line(customer_names: list[str] | None) -> str:
    if customer_names:
        return f"\nKnown customers (for matching): {', '.join(customer_names[:30])}"
    return ""


def _parse_image(image_bytes: bytes, media_type: str, prompt: str) -> dict:
    """첨부 이미지(스크린샷/사진)를 Claude 비전으로 읽어 구조화 JSON 추출."""
    import base64
    client = _anthropic_client()
    b64 = base64.standard_b64encode(image_bytes).decode()
    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=4096,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}},
                {"type": "text", "text": prompt},
            ],
        }],
    )
    return _parse_response(response.content[0].text)


def parse_rfq_image(image_bytes: bytes, media_type: str, customer_names: list[str] | None = None) -> dict:
    """RFQ 이미지(스크린샷/사진)에서 필드를 추출."""
    prompt = f"""Extract RFQ information from the attached image (a screenshot or photo of an RFQ document).
Output ONLY a single-line compact JSON object (no newlines, no markdown).{_customer_hint_line(customer_names)}

JSON schema (all strings on one line, no embedded newlines):
{_RFQ_SCHEMA}"""
    return _parse_image(image_bytes, media_type, prompt)


def parse_order_image(image_bytes: bytes, media_type: str, customer_names: list[str] | None = None) -> dict:
    """고객 P/O 이미지에서 필드를 추출."""
    prompt = f"""Extract Purchase Order (customer order) information from the attached image (a screenshot or photo).
Output ONLY a single-line compact JSON object (no newlines, no markdown).{_customer_hint_line(customer_names)}

JSON schema (all strings on one line; dates as YYYY-MM-DD or null):
{_ORDER_SCHEMA}"""
    return _parse_image(image_bytes, media_type, prompt)


_VQ_SCHEMA = """{
  "items": [
    {"part_no":string,"description":string,"maker":string,"origin":string,"qty":number,"unit":string,"cost_price":number,"lead_time":string,"remark":string}
  ]
}"""

_VQ_INSTRUCTIONS = (
    "Extract the quoted line items from a vendor's quotation. "
    "For each item capture: part_no (part/model number), description (item name), "
    "maker (manufacturer/brand), origin (country of origin), qty (quantity, default 1), "
    "unit (e.g. PCS/SET, default PCS), cost_price (unit price as a number, no currency "
    "symbols or thousands separators; 0 if missing), lead_time (delivery lead time text), "
    "remark (technical remarks or alternatives). Use empty string for missing text fields "
    "and 0 for missing numbers. Do NOT invent rows that are not in the document."
)


def parse_vendor_quote_text(text: str) -> dict:
    """Vendor 견적 PDF 텍스트에서 품목 리스트를 Claude로 추출."""
    client = _anthropic_client()
    clean_text = _sanitize_text(text)[:8000]
    prompt = f"""{_VQ_INSTRUCTIONS}
Output ONLY a single-line compact JSON object (no newlines, no markdown).

JSON schema (all strings on one line, no embedded newlines):
{_VQ_SCHEMA}

Document:
{clean_text}"""
    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )
    return _parse_response(response.content[0].text)


def parse_vendor_quote_image(image_bytes: bytes, media_type: str) -> dict:
    """Vendor 견적 이미지(스크린샷/사진)에서 품목 리스트를 Claude 비전으로 추출."""
    prompt = f"""{_VQ_INSTRUCTIONS}
The attached file is a screenshot or photo of a vendor quotation.
Output ONLY a single-line compact JSON object (no newlines, no markdown).

JSON schema (all strings on one line, no embedded newlines):
{_VQ_SCHEMA}"""
    return _parse_image(image_bytes, media_type, prompt)


def parse_order_fields(text: str, customer_names: list[str] | None = None) -> dict:
    """Use Claude Haiku to extract structured Order (customer P/O) fields from PDF text."""
    client = _anthropic_client()
    clean_text = _sanitize_text(text)[:4000]

    customer_hint_line = ""
    if customer_names:
        customer_hint_line = (
            f"\nKnown customers (for matching): {', '.join(customer_names[:30])}"
        )

    prompt = f"""Extract Purchase Order (customer order) information from the document text below.
Output ONLY a single-line compact JSON object (no newlines, no markdown).{customer_hint_line}

JSON schema (all strings on one line, no embedded newlines; dates as YYYY-MM-DD or null):
{{
  "customer_hint": string|null,
  "po_no": string|null,
  "order_date": "YYYY-MM-DD"|null,
  "vessel_name": string|null,
  "promised_delivery": "YYYY-MM-DD"|null,
  "items": [
    {{"part_no":string,"description":string,"maker":string,"qty":number,"unit":string,"unit_price":number,"remark":string}}
  ]
}}

Document:
{clean_text}"""

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )
    return _parse_response(response.content[0].text)
