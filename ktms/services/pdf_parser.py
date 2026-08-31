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

    # Third try: 답이 상한에 걸려 중간에서 끊긴 경우 — 온전한 부분만 살린다.
    # 120줄짜리 부품표에서 마지막 두어 줄이 잘렸다고 118줄까지 버리는 것은 손해다.
    salvaged = _salvage_truncated(fixed)
    if salvaged is not None:
        return salvaged

    raise ValueError(
        "AI 응답을 JSON으로 파싱할 수 없습니다. PDF 내용이 복잡하거나 형식이 비정형일 수 있습니다."
    )


def _close_open_json(text: str) -> str:
    """열린 채 끝난 문자열·배열·객체를 닫아 준다(끊긴 JSON 복구용)."""
    stack: list[str] = []
    in_str = esc = False
    for ch in text:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            stack.append("}")
        elif ch == "[":
            stack.append("]")
        elif ch in "}]" and stack:
            stack.pop()
    if in_str:
        text += '"'
    return text + "".join(reversed(stack))


def _salvage_truncated(raw: str):
    """끊긴 JSON에서 온전한 항목까지만 건져 낸다. 못 건지면 None.

    마지막 쉼표(문자열 밖)에서 자르고 열린 괄호를 닫아 보기를 되풀이한다 — 잘린 마지막
    항목 하나를 버리면 그 앞은 대개 온전한 JSON이다.
    """
    text = raw
    for _ in range(400):
        try:
            data = json.loads(_close_open_json(text))
        except json.JSONDecodeError:
            pass
        else:
            return data if isinstance(data, dict) else None
        cut = _last_comma_outside_string(text)
        if cut is None:
            return None
        text = text[:cut]
    return None


def _last_comma_outside_string(text: str) -> int | None:
    in_str = esc = False
    last = None
    for i, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == ",":
            last = i
    return last


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


# ── Claude 호출 공통부 ────────────────────────────────────────────────────────
# 문서 한 장이 표 여섯 쪽·품목 120줄인 일이 흔하다(엔진 오버홀 부품표). 그런 문서에서
# 옛 설정은 세 군데서 한꺼번에 무너졌다:
#   · 본문을 4,000자에서 잘라 보냈다 — 뒤쪽 페이지의 품목은 애초에 모델에게 가지 않았다.
#   · max_tokens 가 4,096 이었다 — 120줄짜리 JSON은 그 두 배가 넘어 답이 중간에서 끊겼고,
#     끊긴 JSON은 파싱에 실패해 "AI 응답을 JSON으로 파싱할 수 없습니다"로 끝났다.
#   · pdfplumber 로 뽑은 평문만 보냈다 — 표의 열 구분과 구역 제목이 뭉개져, 어느 숫자가
#     수량인지조차 본문만으로는 알기 어려웠다.
# 그래서 이제 PDF는 파일 그대로(document 블록) 보내고, 답은 스트리밍으로 받으며,
# 형식은 JSON 스키마로 강제한다(모델이 형식을 어길 수가 없다).
_MODEL = "claude-opus-5"
# 스트리밍이라 크게 잡아도 요청이 타임아웃되지 않는다. 실제로 쓴 만큼만 과금되므로
# 상한을 넉넉히 두는 쪽이 답이 잘리는 것보다 언제나 낫다.
_MAX_TOKENS = 64000
# 이보다 큰 PDF는 파일째 보내지 않는다(요청 본문 32MB 한도 — base64 는 4/3 로 불어난다).
# 그런 파일은 텍스트만 뽑아 보내는 길로 넘긴다.
PDF_DOC_MAX_BYTES = 20 * 1024 * 1024


def _pdf_document_block(pdf_bytes: bytes) -> dict:
    """PDF 원본을 그대로 넘기는 content 블록 — 표·레이아웃·스캔 이미지까지 모델이 본다."""
    import base64
    return {
        "type": "document",
        "source": {
            "type": "base64",
            "media_type": "application/pdf",
            "data": base64.standard_b64encode(pdf_bytes).decode(),
        },
    }


def _ask_claude(content, schema: dict | None = None, max_tokens: int = _MAX_TOKENS) -> dict:
    """추출 요청 한 번 — 검증된 JSON(dict)을 돌려준다.

    schema 를 주면 output_config 로 그 형식을 강제한다. 모델이 마크다운 울타리를 두르거나
    설명을 덧붙이거나 필드를 빠뜨릴 수 없게 되어, 파싱 실패라는 실패 유형 자체가 사라진다.
    (구버전 SDK 에는 output_config 인자가 없다 — 그때는 형식 지시문만으로 굴러가도록
    같은 요청을 스키마 없이 한 번 더 보낸다.)
    """
    client = _anthropic_client()
    messages = [{"role": "user", "content": content}]
    # effort=low — 이 일은 추론이 아니라 옮겨 적기다. 문서에 적힌 것을 그대로 읽어
    # 표로 옮기는 작업이라 깊게 생각할 것이 없고, 높은 effort 는 답을 좋게 만들지 않으면서
    # 응답만 느려진다(6쪽 표에서 1분 이상 차이 났다 — 그동안 사용자는 업로드 창을 보고 있다).
    output_config: dict = {"effort": "low"}
    if schema:
        output_config["format"] = {"type": "json_schema", "schema": schema}
    kwargs = {"model": _MODEL, "max_tokens": max_tokens, "messages": messages,
              "output_config": output_config}
    try:
        try:
            with client.messages.stream(**kwargs) as stream:
                msg = stream.get_final_message()
        except TypeError:   # 구버전 SDK — output_config 인자 자체가 없다
            kwargs.pop("output_config", None)
            with client.messages.stream(**kwargs) as stream:
                msg = stream.get_final_message()
    except Exception as exc:
        raise ValueError(_api_error_message(exc)) from exc
    text = next((b.text for b in msg.content if b.type == "text"), "")
    data = _fill_item_defaults(_parse_response(text), schema)
    # 상한에 걸려 답이 끊긴 경우 — 읽어낸 만큼은 살리되(_parse_response 가 복구한다)
    # 잘렸다는 사실을 함께 돌려준다. 조용히 넘기면 빠진 품목을 아무도 눈치채지 못한다.
    if msg.stop_reason == "max_tokens":
        data["truncated"] = True
    return data


def _api_error_message(exc: Exception) -> str:
    """API 오류를 화면에 그대로 띄울 수 있는 한 줄로 옮긴다.

    화면에는 이 문구가 "OCR 추출 실패: …" 뒤에 붙는다. 영문 JSON 오류 본문을 그대로
    내보내면 무엇을 해야 하는지 알 수 없다 — 크레딧이 떨어진 것과 파일이 잘못된 것은
    사용자가 할 일이 전혀 다르다.
    """
    text = str(exc)
    low = text.lower()
    if "credit balance" in low or "insufficient" in low:
        return ("Anthropic API 크레딧이 부족합니다. 콘솔(Plans & Billing)에서 충전한 뒤 "
                "다시 시도하세요.")
    if "authentication" in low or "invalid x-api-key" in low or "401" in low:
        return "ANTHROPIC_API_KEY가 유효하지 않습니다. 키를 다시 확인하세요."
    if "rate limit" in low or "429" in low:
        return "요청이 잠시 몰렸습니다(rate limit). 1~2분 뒤 다시 시도하세요."
    if "overloaded" in low or "529" in low:
        return "AI 서버가 혼잡합니다(overloaded). 잠시 뒤 다시 시도하세요."
    if "too many pages" in low or "page limit" in low or "exceeds" in low and "page" in low:
        return "PDF 페이지 수가 한도를 넘습니다. 파일을 나눠서 올려 주세요."
    return text


def _nullable_str(*names: str) -> dict:
    return {n: {"type": ["string", "null"]} for n in names}


def _item_schema(fields: dict) -> dict:
    """품목 배열 한 줄의 스키마 — 모든 칸을 필수로 둔다.

    빈 칸까지 적어 보내느라 답이 길어지긴 하지만, 그 대신 모델이 칸을 건너뛸 수가 없다.
    (칸을 선택으로 두면 답은 짧아지고 빨라진다 — 6쪽 표에서 실측으로 검증한 조합은
    '전부 필수'쪽이라 그쪽을 쓴다.)
    """
    return {
        "type": "array",
        "items": {
            "type": "object",
            "properties": fields,
            "required": list(fields),
            "additionalProperties": False,
        },
    }


def _fill_item_defaults(data: dict, schema: dict | None) -> dict:
    """스키마에 있는데 답에서 빠진 품목 칸을 기본값(문자열 "" · 숫자 0)으로 채운다."""
    if not schema or not isinstance(data.get("items"), list):
        return data
    props = (((schema.get("properties") or {}).get("items") or {})
             .get("items", {}).get("properties") or {})
    if not props:
        return data
    blanks = {k: (0 if (v.get("type") == "number") else "") for k, v in props.items()}
    data["items"] = [{**blanks, **(it if isinstance(it, dict) else {})} for it in data["items"]]
    return data


_TEXT = {"type": "string"}
_NUM = {"type": "number"}

_RFQ_ITEM_FIELDS = {
    "part_no": _TEXT, "description": _TEXT, "type": _TEXT, "serial_no": _TEXT,
    "maker": _TEXT, "qty": _NUM, "unit": _TEXT, "lead_time_req": _TEXT, "remark": _TEXT,
}
_ORDER_ITEM_FIELDS = {
    "part_no": _TEXT, "description": _TEXT, "maker": _TEXT, "qty": _NUM,
    "unit": _TEXT, "unit_price": _NUM, "remark": _TEXT,
}
_VQ_ITEM_FIELDS = {
    "part_no": _TEXT, "description": _TEXT, "maker": _TEXT, "origin": _TEXT, "qty": _NUM,
    "unit": _TEXT, "cost_price": _NUM, "lead_time": _TEXT, "remark": _TEXT,
}


def _doc_schema(head: dict, item_fields: dict) -> dict:
    props = {**head, "items": _item_schema(item_fields)}
    return {"type": "object", "properties": props, "required": list(props),
            "additionalProperties": False}


_RFQ_JSON_SCHEMA = _doc_schema(
    _nullable_str("vessel_name", "rfq_date", "customer_rfq_no", "customer_hint",
                  "contact_person", "notes"),
    _RFQ_ITEM_FIELDS,
)
_ORDER_JSON_SCHEMA = _doc_schema(
    _nullable_str("customer_hint", "po_no", "order_date", "vessel_name", "promised_delivery"),
    _ORDER_ITEM_FIELDS,
)
_VQ_JSON_SCHEMA = _doc_schema({}, _VQ_ITEM_FIELDS)

# 여러 쪽에 걸친 부품표에서 한 줄도 흘리지 않게 하는 지시. 구역 제목(예: CYLINDER BLOCK)이
# 품목 행으로 둔갑하던 것과, 뒤쪽 페이지를 "이하 동일"로 요약해 버리던 것을 함께 막는다.
_LONG_TABLE_RULES = (
    "The document may run to several pages and hold many table sections (e.g. CYLINDER BLOCK, "
    "CYLINDER HEAD, FUEL FILTER). Read EVERY page and copy EVERY row of EVERY table in the "
    "order printed - never stop early, never summarize, never merge or de-duplicate rows that "
    "repeat the same description with a different part number. A section heading is not an item: "
    "skip heading-only rows and repeated column headers (No / Part No / Description / Qty / UOM). "
    "Map the UOM column to `unit` and the Qty column to `qty`. Put the section/assembly heading "
    "a row sits under into that row's `remark` (keep the row's own remark if it has one) - it is "
    "what tells a supplier which assembly the part belongs to."
)


def parse_rfq_fields(text: str, customer_names: list[str] | None = None) -> dict:
    """RFQ 평문(텍스트로 뽑아낸 PDF·붙여넣은 본문)에서 필드를 추출.

    PDF 파일이 있으면 parse_rfq_pdf_document 를 먼저 쓴다 — 표는 평문으로 옮기는 순간
    열 구분이 사라져, 같은 문서라도 이 길로 오면 읽어내는 정확도가 떨어진다.
    본문은 자르지 않는다(옛 4,000자 제한이 뒤쪽 페이지의 품목을 통째로 버렸다).
    """
    prompt = f"""Extract RFQ information from the document text below.{_customer_hint_line(customer_names)}
{_STRICT_EXTRACTION}
{_LONG_TABLE_RULES}

Document:
{_sanitize_text(text)}"""
    return _ask_claude(prompt, _RFQ_JSON_SCHEMA)


def parse_rfq_pdf_document(pdf_bytes: bytes, customer_names: list[str] | None = None) -> dict:
    """RFQ PDF 를 파일 그대로 넘겨 필드·품목을 추출한다(표·레이아웃·스캔본까지 그대로 본다).

    평문 추출을 거치지 않는 것이 요점이다 — 여러 쪽에 걸친 부품표는 열이 뭉개지는 순간
    수량과 품번의 짝이 어긋난다. 모델은 페이지 이미지를 함께 보므로 표를 표로 읽는다.
    """
    prompt = f"""Extract RFQ information from the attached PDF.{_customer_hint_line(customer_names)}
{_STRICT_EXTRACTION}
{_LONG_TABLE_RULES}"""
    return _ask_claude([_pdf_document_block(pdf_bytes), {"type": "text", "text": prompt}],
                       _RFQ_JSON_SCHEMA)

# 문서에 실제로 적힌 값만 뽑도록 강제(IMO/선체번호/외부지식 기반 추측 금지).
_STRICT_EXTRACTION = (
    "STRICT RULES: Extract ONLY values that appear verbatim in the document. "
    "If a field is not explicitly written in the text, output null (empty string for "
    "item text fields). Do NOT guess or infer customer_hint or vessel_name from IMO "
    "numbers, hull numbers, engine numbers, part numbers, or any outside/world knowledge. "
    "The known-customers list is ONLY to normalize the spelling of a customer name that "
    "actually appears in the document — never pick one from it when no customer/manager "
    "name is present in the text."
)


def _customer_hint_line(customer_names: list[str] | None) -> str:
    if customer_names:
        return f"\nKnown customers (for matching): {', '.join(customer_names[:30])}"
    return ""


def _parse_image(image_bytes: bytes, media_type: str, prompt: str, schema: dict | None = None) -> dict:
    """첨부 이미지(스크린샷/사진)를 Claude 비전으로 읽어 구조화 JSON 추출."""
    import base64
    b64 = base64.standard_b64encode(image_bytes).decode()
    return _ask_claude(
        [
            {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}},
            {"type": "text", "text": prompt},
        ],
        schema,
    )


def parse_rfq_image(image_bytes: bytes, media_type: str, customer_names: list[str] | None = None) -> dict:
    """RFQ 이미지(스크린샷/사진)에서 필드를 추출."""
    prompt = f"""Extract RFQ information from the attached image (a screenshot or photo of an RFQ document).{_customer_hint_line(customer_names)}
{_STRICT_EXTRACTION}
{_LONG_TABLE_RULES}"""
    return _parse_image(image_bytes, media_type, prompt, _RFQ_JSON_SCHEMA)


def parse_order_image(image_bytes: bytes, media_type: str, customer_names: list[str] | None = None) -> dict:
    """고객 P/O 이미지에서 필드를 추출."""
    prompt = f"""Extract Purchase Order (customer order) information from the attached image (a screenshot or photo).{_customer_hint_line(customer_names)}
{_STRICT_EXTRACTION}
{_LONG_TABLE_RULES}
Dates are YYYY-MM-DD or null."""
    return _parse_image(image_bytes, media_type, prompt, _ORDER_JSON_SCHEMA)


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
    prompt = f"""{_VQ_INSTRUCTIONS}
{_LONG_TABLE_RULES}

Document:
{_sanitize_text(text)}"""
    return _ask_claude(prompt, _VQ_JSON_SCHEMA)


def parse_vendor_quote_image(image_bytes: bytes, media_type: str) -> dict:
    """Vendor 견적 이미지(스크린샷/사진)에서 품목 리스트를 Claude 비전으로 추출."""
    prompt = f"""{_VQ_INSTRUCTIONS}
The attached file is a screenshot or photo of a vendor quotation.
{_LONG_TABLE_RULES}"""
    return _parse_image(image_bytes, media_type, prompt, _VQ_JSON_SCHEMA)


def parse_vendor_quote_pdf_document(pdf_bytes: bytes) -> dict:
    """Vendor 견적 PDF 전체를 Claude에 document(비전)로 넘겨 품목을 추출.

    스캔본(텍스트 없음)이나 표 파서·텍스트 파서가 실패하는 비정형 PDF 대비 폴백.
    """
    prompt = f"""{_VQ_INSTRUCTIONS}
The attached file is a vendor quotation PDF (it may be scanned or non-standard).
{_LONG_TABLE_RULES}"""
    return _ask_claude([_pdf_document_block(pdf_bytes), {"type": "text", "text": prompt}],
                       _VQ_JSON_SCHEMA)


_CARD_SCHEMA = """{
  "company": string|null,
  "contact_name": string|null,
  "job_title": string|null,
  "address": string|null,
  "tax_id": string|null,
  "website": string|null,
  "emails": [string],
  "phones": [string],
  "regions": [string]
}"""

_CARD_INSTRUCTIONS = (
    "Read the attached business card (name card) and extract the contact's details. "
    "company = the organization name (drop legal-form noise only if it is not printed). "
    "contact_name = the person's name in the language it is printed in (Latin spelling if both "
    "are shown). job_title = the person's title/department. address = the full street address as "
    "printed, on one line, comma separated, including postal code and country when printed, but "
    "WITHOUT the company name. tax_id = business/company registration "
    "or VAT/GST/UEN number if printed (labels such as 'Business No.', 'BRN', 'UEN', 'VAT', "
    "'Tax ID', '사업자등록번호'); null otherwise. emails = every email address on the card. "
    "phones = every phone/mobile/fax number, keeping the printed formatting and any extension "
    "(prefix fax numbers with 'Fax '). regions = the country (or city-state such as Hong Kong / "
    "Singapore) the address belongs to, in English. "
    "Use null for missing single values and [] for missing lists. Do NOT invent anything that is "
    "not printed on the card, and do NOT infer the address or tax id from outside knowledge."
)


def parse_business_card_image(image_bytes: bytes, media_type: str) -> dict:
    """명함 이미지(사진/캡쳐)에서 회사·담당자·주소·연락처를 추출."""
    prompt = f"""{_CARD_INSTRUCTIONS}
Output ONLY a single-line compact JSON object (no newlines, no markdown).

JSON schema (all strings on one line, no embedded newlines):
{_CARD_SCHEMA}"""
    return _parse_image(image_bytes, media_type, prompt)


def parse_business_card_pdf_document(pdf_bytes: bytes) -> dict:
    """명함 PDF(스캔본 포함)를 Claude 비전으로 읽어 필드를 추출."""
    prompt = f"""{_CARD_INSTRUCTIONS}
The attached file is a scan or export of a business card.
Output ONLY a single-line compact JSON object (no newlines, no markdown).

JSON schema (all strings on one line, no embedded newlines):
{_CARD_SCHEMA}"""
    return _ask_claude([_pdf_document_block(pdf_bytes), {"type": "text", "text": prompt}])


def parse_order_fields(text: str, customer_names: list[str] | None = None) -> dict:
    """고객 P/O 평문에서 필드를 추출. PDF 파일이 있으면 parse_order_pdf_document 를 먼저 쓴다."""
    prompt = f"""Extract Purchase Order (customer order) information from the document text below.{_customer_hint_line(customer_names)}
{_STRICT_EXTRACTION}
{_LONG_TABLE_RULES}
Dates are YYYY-MM-DD or null.

Document:
{_sanitize_text(text)}"""
    return _ask_claude(prompt, _ORDER_JSON_SCHEMA)


def parse_order_pdf_document(pdf_bytes: bytes, customer_names: list[str] | None = None) -> dict:
    """고객 P/O PDF 를 파일 그대로 넘겨 필드·품목을 추출(표·레이아웃·스캔본 포함)."""
    prompt = f"""Extract Purchase Order (customer order) information from the attached PDF.{_customer_hint_line(customer_names)}
{_STRICT_EXTRACTION}
{_LONG_TABLE_RULES}
Dates are YYYY-MM-DD or null."""
    return _ask_claude([_pdf_document_block(pdf_bytes), {"type": "text", "text": prompt}],
                       _ORDER_JSON_SCHEMA)
