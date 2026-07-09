"""Simple SMTP email sender with PDF attachment support."""
from __future__ import annotations
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


def send_email(
    to: str,
    subject: str,
    body: str,
    attachments: Optional[List[Tuple[str, bytes]]] = None,
    cc: str = "",
    from_addr: str = "",
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

    msg = MIMEMultipart()
    msg["From"] = sender
    msg["To"] = ", ".join(to_list)
    msg["Subject"] = subject
    if cc_list:
        msg["Cc"] = ", ".join(cc_list)

    msg.attach(MIMEText(body, "plain", "utf-8"))

    for filename, data in (attachments or []):
        part = MIMEApplication(data, Name=filename)
        part["Content-Disposition"] = f'attachment; filename="{filename}"'
        msg.attach(part)

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


def quotation_email_body(customer_name: str, doc_no: str, tracking_url: str = "", lang: str = "en") -> str:
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


def intro_email_body(contact_person: str = "", customer_name: str = "",
                     kind: str = "intro", lang: str = "en") -> str:
    """홍보/회사소개 메일 기본 본문(서명 제외 — 서명은 별도 필드로 관리).
    담당자·고객사명이 있으면 인사말에 반영, 없으면 일반 인사말로 대체한다."""
    greet_name = (contact_person or "").strip() or ((customer_name or "").strip())
    if lang in ("ko", "kr"):
        hello = f"{greet_name} 담당자님께," if greet_name else "안녕하십니까,"
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

    hello = f"Dear {greet_name}," if greet_name else "Dear Sir/Madam,"
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
