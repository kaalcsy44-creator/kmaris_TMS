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


def _anthropic_client():
    """Build an Anthropic client from env or Streamlit secrets."""
    import anthropic

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        try:
            import streamlit as st
            api_key = st.secrets.get("ANTHROPIC_API_KEY", "")
        except Exception:
            pass
    if not api_key:
        raise ValueError(
            "ANTHROPIC_API_KEY가 설정되지 않았습니다. ktms/.streamlit/secrets.toml을 확인하세요."
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
