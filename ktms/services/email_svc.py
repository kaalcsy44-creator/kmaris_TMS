"""Simple SMTP email sender with PDF attachment support."""
from __future__ import annotations
import html as html_mod
import json
import os
import re
import smtplib
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import List, Optional, Tuple


def _cfg():
    return {
        "host": os.getenv("SMTP_HOST", "smtp.gmail.com"),
        "port": int(os.getenv("SMTP_PORT", "587")),
        "user": os.getenv("SMTP_USER", ""),
        "password": os.getenv("SMTP_PASSWORD", ""),
        "from": os.getenv("SMTP_FROM", "K-MARIS Sales <sales@k-maris.com>"),
    }


def default_from() -> str:
    """UI 의 From 기본값으로 노출할 발신 주소(SMTP_FROM)."""
    return _cfg()["from"]


def email_signature(default: str = "") -> str:
    """Settings 에 등록된 공용 이메일 서명(config/company.json 의 email_signature).
    비어 있으면 default(각 이메일의 기존 기본 서명)를 반환한다.
    _core 와 순환 참조를 피하려 여기서 JSON 을 직접 읽는다."""
    path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "config", "company.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            sig = (json.load(fh).get("email_signature") or "").strip()
        return sig if sig else default
    except (OSError, ValueError):
        return default


# ── 본문 텍스트 → HTML 렌더 ──────────────────────────────────────────────────
# 메일을 text/plain 으로만 보내면 글꼴·크기를 수신 클라이언트가 제 설정대로 그린다
# (Outlook 은 '일반 텍스트 글꼴' 설정을 쓰기 때문에 작고 고정폭으로 보인다). 발신자가
# 타이포를 지정하려면 HTML 파트가 필요해서, 저장된 평문 본문을 발송 직전에 감싼다.
# 본문 저장 포맷은 계속 평문이고, text/plain 파트도 그대로 함께 보낸다.
EMAIL_FONT_STACK = (
    "Arial, Helvetica, 'Malgun Gothic', 'Apple SD Gothic Neo', "
    "'Noto Sans KR', sans-serif"
)
EMAIL_BODY_STYLE = (
    f"font-family:{EMAIL_FONT_STACK};font-size:15px;line-height:1.6;"
    "color:#222222;max-width:640px;"
)
_LINK_STYLE = "color:#1a5fb4;"
# 링크 인식: URL(https://, www.) 과 메일주소. 이미 escape 된 텍스트 위에서 돌린다.
_LINK_RE = re.compile(
    r"(https?://[^\s<>\"']+|www\.[^\s<>\"']+|[\w.+-]+@[\w-]+\.[\w.-]*\w)"
)
# 목록으로 볼 글머리표. 대시(–, —)는 문장 첫머리 강조로도 쓰여서 제외한다
# (예: "— KTMS 자동 발송" 같은 꼬리말이 목록으로 잡히지 않게).
_BULLET_RE = re.compile(r"^\s*[-•*]\s+(.*)$")
# 공백을 여러 개 넣어 열을 맞췄거나(예: "Vessel        : MV SAMPLE") 괘선을 그린
# 블록(Vendor RFQ 의 ITEM LIST)은 비례 글꼴로 옮기면 정렬이 무너진다. 이런 블록만
# 고정폭으로 남겨 원래 모양을 지킨다.
_PREFORMATTED_RE = re.compile(r"\S {3,}\S|[─-╿]")  # 정렬 공백 | 괘선
_PRE_STYLE = (
    "margin:0 0 14px;font-family:Consolas,'Courier New',monospace;"
    "font-size:14px;line-height:1.5;white-space:pre-wrap;"
)


def _linkify(text: str) -> str:
    def repl(m: "re.Match[str]") -> str:
        token = m.group(0)
        # 문장 끝 부호가 링크에 딸려 들어가지 않게 뒤로 뺀다. ';' 는 &amp; 같은
        # escape 시퀀스를 깨뜨리므로 대상에서 제외한다.
        trail = ""
        while token and token[-1] in ".,)]}!?":
            trail = token[-1] + trail
            token = token[:-1]
        if not token:
            return trail
        if token.startswith("www."):
            href = "https://" + token
        elif "@" in token and not token.startswith("http"):
            href = "mailto:" + token
        else:
            href = token
        return f'<a href="{href}" style="{_LINK_STYLE}">{token}</a>{trail}'

    return _LINK_RE.sub(repl, text)


# 굵게: **텍스트**. 본문 저장 포맷을 평문으로 유지하려고 마크다운 표기를 쓴다.
# 별표 하나(*)는 목록 기호·각주로도 쓰여서 기울임까지 넓히지 않는다 — 오인식이 더 손해다.
_BOLD_RE = re.compile(r"\*\*(?=\S)(.+?)(?<=\S)\*\*", re.DOTALL)


def _bold(text: str) -> str:
    return _BOLD_RE.sub(r"<strong>\1</strong>", text)


def strip_markup(text: str) -> str:
    """평문 파트용 — 굵게 표기를 걷어낸다. HTML 을 못 읽는 수신자에게 별표가
    그대로 보이지 않도록, text/plain 에는 표기를 지운 문장을 싣는다."""
    return _BOLD_RE.sub(r"\1", text or "")


def _inline_html(line: str) -> str:
    """한 줄을 HTML 로 — escape 후 굵게·링크 처리, 들여쓰기 공백 보존."""
    esc = html_mod.escape(line.rstrip(), quote=False)
    indent = len(esc) - len(esc.lstrip(" "))
    return "&nbsp;" * indent + _linkify(_bold(esc.lstrip(" ")))


def text_to_html_fragment(text: str) -> str:
    """평문 본문 → HTML 조각(<div>). 빈 줄은 문단 구분, '- ' 로 시작하는 줄은
    목록으로 묶는다. 미리보기와 실제 발송이 같은 결과를 내도록 이 함수 하나만 쓴다."""
    lines = (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    blocks: List[str] = []
    para: List[str] = []
    items: List[str] = []

    def flush_para() -> None:
        if not para:
            return
        if any(_PREFORMATTED_RE.search(ln) for ln in para):
            joined = "<br>".join(
                _linkify(_bold(html_mod.escape(ln.rstrip(), quote=False))) for ln in para
            )
            blocks.append(f'<pre style="{_PRE_STYLE}">{joined}</pre>')
        else:
            blocks.append(
                '<p style="margin:0 0 14px;">'
                + "<br>".join(_inline_html(ln) for ln in para)
                + "</p>"
            )
        para.clear()

    def flush_items() -> None:
        if items:
            lis = "".join(
                f'<li style="margin:0 0 4px;">{it}</li>' for it in items
            )
            blocks.append(
                '<ul style="margin:0 0 14px;padding-left:22px;">' + lis + "</ul>"
            )
            items.clear()

    for raw in lines:
        if not raw.strip():
            flush_para()
            flush_items()
            continue
        m = _BULLET_RE.match(raw)
        if m:
            flush_para()
            items.append(_inline_html(m.group(1)))
        else:
            flush_items()
            para.append(raw)   # 블록 전체를 보고 고정폭 여부를 정하므로 원문 그대로 모은다
    flush_para()
    flush_items()

    return f'<div style="{EMAIL_BODY_STYLE}">' + "".join(blocks) + "</div>"


def html_document(fragment: str) -> str:
    """HTML 조각(본문 + 서명) → 발송용 문서 전체."""
    return (
        "<!DOCTYPE html><html><head>"
        '<meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        "</head>"
        '<body style="margin:0;padding:0;background:#ffffff;'
        '-webkit-text-size-adjust:100%;">'
        + (fragment or "")
        + "</body></html>"
    )


def text_to_html(text: str) -> str:
    """평문 본문 → 발송용 HTML 문서 전체."""
    return html_document(text_to_html_fragment(text))


def send_email(
    to: str,
    subject: str,
    body: str,
    attachments: Optional[List[Tuple[str, bytes]]] = None,
    cc: str = "",
    from_addr: str = "",
    html_body: Optional[str] = None,
) -> bool:
    """
    Send an email via SMTP.
    attachments: list of (filename, bytes) tuples.
    from_addr: 발신자 override(빈값이면 SMTP_FROM). 실제 반영 여부는 SMTP 계정의
    'send-as alias' 등록에 따름(미등록 시 provider 가 인증 계정으로 재작성할 수 있음).
    Returns True on success, False on failure.
    """
    cfg = _cfg()
    if not cfg["user"] or not cfg["password"]:
        return False

    sender = (from_addr or "").strip() or cfg["from"]
    # To·Cc 는 쉼표(또는 세미콜론)로 여러 주소를 받을 수 있다. 헤더엔 쉼표 결합
    # 문자열을 쓰되, SMTP 봉투(envelope) 수신자는 반드시 개별 주소 리스트로 넘겨야 한다.
    def _addrs(s: str) -> List[str]:
        return [a.strip() for a in re.split(r"[,;]", s or "") if a.strip()]

    to_list = _addrs(to)
    cc_list = _addrs(cc)

    # 본문은 text/plain + text/html 두 벌(multipart/alternative)로 보낸다. 첨부가
    # 있으면 그 alternative 를 multipart/mixed 안에 넣어야 한다 — 평평하게 붙이면
    # 일부 클라이언트가 본문을 첨부로 취급한다.
    alt = MIMEMultipart("alternative")
    alt.attach(MIMEText(strip_markup(body), "plain", "utf-8"))
    alt.attach(MIMEText(html_body or text_to_html(body), "html", "utf-8"))

    if attachments:
        msg: MIMEMultipart = MIMEMultipart("mixed")
        msg.attach(alt)
        for filename, data in attachments:
            part = MIMEApplication(data, Name=filename)
            part["Content-Disposition"] = f'attachment; filename="{filename}"'
            msg.attach(part)
    else:
        msg = alt

    msg["From"] = sender
    msg["To"] = ", ".join(to_list)
    msg["Subject"] = subject
    if cc_list:
        msg["Cc"] = ", ".join(cc_list)

    try:
        with smtplib.SMTP(cfg["host"], cfg["port"]) as server:
            server.ehlo()
            server.starttls()
            server.login(cfg["user"], cfg["password"])
            recipients = to_list + cc_list
            server.sendmail(sender, recipients, msg.as_bytes())
        return True
    except Exception:
        return False


def quotation_email_subject(doc_no: str, lang: str = "en") -> str:
    if lang == "kr":
        return f"[K-MARIS] 견적서 발송 - {doc_no}"
    return f"[K-MARIS] Quotation {doc_no}"


def quotation_email_body(customer_name: str, doc_no: str, tracking_url: str = "",
                         lang: str = "en", inline_signature: bool = True) -> str:
    """견적서 메일 본문. inline_signature=False 면 서명을 붙이지 않는다 — 발송 화면이
    서명을 별도 입력칸으로 다루고 발송 시 본문 뒤에 다시 합치기 때문(중복 방지)."""
    if lang == "kr":
        body = f"""{customer_name} 담당자님께,

요청하신 견적서({doc_no})를 첨부 파일로 보내드립니다.

추가 문의사항이나 협의가 필요하시면 언제든지 회신 부탁드립니다.
"""
        if tracking_url:
            body += f"""
아래 링크를 통해 진행 상황을 확인하실 수 있습니다:
{tracking_url}
"""
        if not inline_signature:
            return body
        body += "\n" + email_signature(default=(
            "감사합니다.\n\n"
            "케이마리스 에너지 앤 솔루션 주식회사\n"
            "sales@k-maris.com | www.k-maris.com\n"
            "Engineering Reliability. Supplying Performance."
        )) + "\n"
        return body

    body = f"""Dear {customer_name},

Please find attached our Quotation {doc_no} as requested.

Should you have any questions or require further clarification, please do not hesitate to contact us.
"""
    if tracking_url:
        body += f"""
You can track the status of your inquiry at any time:
{tracking_url}
"""
    if not inline_signature:
        return body
    body += "\n" + email_signature(default=(
        "Best regards,\n"
        "K-MARIS Energy & Solutions Co., Ltd.\n"
        "sales@k-maris.com | www.k-maris.com\n"
        "Engineering Reliability. Supplying Performance."
    )) + "\n"
    return body


def intro_email_subject(kind: str = "intro", lang: str = "en") -> str:
    """홍보/회사소개 메일 기본 제목. kind: intro(회사소개) | brochure(제품 브로슈어 안내)."""
    if lang in ("ko", "kr"):
        return "케이마리스 회사소개" if kind == "brochure" else "케이마리스 회사소개 및 협력 제안"
    if kind == "brochure":
        return "K-MARIS — Product Brochure"
    return "Introducing K-MARIS Energy & Solutions"


def intro_signature(lang: str = "en") -> str:
    """홍보 메일 기본 서명 — Settings 공용 서명 우선, 없으면 언어별 기본값."""
    if lang in ("ko", "kr"):
        return email_signature(default=(
            "감사합니다.\n\n"
            "케이마리스 에너지 앤 솔루션 주식회사\n"
            "sales@k-maris.com | www.k-maris.com\n"
            "Engineering Reliability. Supplying Performance."
        ))
    return email_signature(default=(
        "Best regards,\n"
        "K-MARIS Energy & Solutions Co., Ltd.\n"
        "sales@k-maris.com | www.k-maris.com\n"
        "Engineering Reliability. Supplying Performance."
    ))


# 홍보 메일 템플릿에 쓰는 치환 토큰 — 저장된 템플릿에 수신자 이름을 박아두지 않고
# 토큰으로 남겨야, 다음에 다른 사람에게 보낼 때 이름이 자동으로 바뀐다.
# 값이 비면 fallback(담당자/Sir/Madam)으로 치환돼 인사말이 어색해지지 않는다.
MARKETING_CONTACT_FALLBACK = {"en": "Sir/Madam", "kr": "담당자"}


def render_marketing_tokens(text: str, contact_person: str = "",
                            customer_name: str = "", lang: str = "en") -> str:
    """홍보 메일 제목·본문의 {{contact}}·{{customer}} 토큰을 실제 수신자 값으로 치환."""
    lang_n = "kr" if lang in ("ko", "kr") else "en"
    contact = (contact_person or "").strip() or MARKETING_CONTACT_FALLBACK[lang_n]
    return (text or "").replace("{{contact}}", contact) \
                       .replace("{{customer}}", (customer_name or "").strip())


def intro_email_body_tpl(kind: str = "intro", lang: str = "en") -> str:
    """홍보/회사소개 메일 기본 본문 '원본'(수신자 이름 자리에 {{contact}} 토큰)."""
    return _intro_email_body_raw(kind=kind, lang=lang)


def intro_email_body(contact_person: str = "", customer_name: str = "",
                     kind: str = "intro", lang: str = "en") -> str:
    """홍보/회사소개 메일 기본 본문(서명 제외 — 서명은 별도 필드로 관리).
    담당자·고객사명이 있으면 인사말에 반영, 없으면 일반 인사말로 대체한다."""
    return render_marketing_tokens(
        _intro_email_body_raw(kind=kind, lang=lang), contact_person, customer_name, lang
    )


def _intro_email_body_raw(kind: str = "intro", lang: str = "en") -> str:
    if lang in ("ko", "kr"):
        hello = "{{contact}}님께,"
        if kind == "brochure":
            intro = (
                "요청하신 제품 브로슈어를 첨부해 드립니다.\n\n"
                "선박용 부품 공급 및 정비 서비스 관련하여 견적이나 협의가 필요하시면 "
                "언제든지 편하게 회신 주시기 바랍니다."
            )
        else:
            intro = (
                "케이마리스 에너지 앤 솔루션을 소개드리고자 연락드립니다. 당사는 선박용 부품 공급과 "
                "정비 서비스를 전문으로 하는 회사입니다.\n\n"
                "회사소개 자료를 첨부해 드리오니 검토 부탁드리며, 협력 기회가 있으면 언제든지 회신 주시기 바랍니다."
            )
        return f"{hello}\n\n{intro}\n"

    hello = "Dear {{contact}},"
    if kind == "brochure":
        intro = (
            "Please find attached our product brochure as requested.\n\n"
            "Should you require a quotation or wish to discuss your marine parts and "
            "service needs, please do not hesitate to reply to this email."
        )
    else:
        intro = (
            "We would like to introduce K-MARIS Energy & Solutions, a specialist supplier of "
            "marine parts and repair services.\n\n"
            "Our company profile is attached for your review. We would welcome the opportunity "
            "to support your operations — please feel free to reply at any time."
        )
    return f"{hello}\n\n{intro}\n"


def shipping_advice_email_body(customer_name: str, doc_no: str, tracking_url: str = "") -> str:
    body = f"""Dear {customer_name},

Please find attached our Shipping Advice {doc_no} along with the Commercial Invoice and Packing List.
"""
    if tracking_url:
        body += f"""
Track your shipment in real time:
{tracking_url}
"""
    body += "\n" + email_signature(default=(
        "Best regards,\n"
        "K-MARIS Energy & Solutions Co., Ltd.\n"
        "sales@k-maris.com | www.k-maris.com"
    )) + "\n"
    return body
