"""Simple SMTP email sender with PDF attachment support."""
from __future__ import annotations
import os
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


def send_email(
    to: str,
    subject: str,
    body: str,
    attachments: Optional[List[Tuple[str, bytes]]] = None,
    cc: str = "",
) -> bool:
    """
    Send an email via SMTP.
    attachments: list of (filename, bytes) tuples.
    Returns True on success, False on failure.
    """
    cfg = _cfg()
    if not cfg["user"] or not cfg["password"]:
        return False

    msg = MIMEMultipart()
    msg["From"] = cfg["from"]
    msg["To"] = to
    msg["Subject"] = subject
    if cc:
        msg["Cc"] = cc

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
            recipients = [to] + ([cc] if cc else [])
            server.sendmail(cfg["from"], recipients, msg.as_bytes())
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
        body += """
감사합니다.

케이마리스 에너지 앤 솔루션 주식회사
sales@k-maris.com | www.k-maris.com
Engineering Reliability. Supplying Performance.
"""
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
    body += """
Best regards,
K-MARIS Energy & Solutions Co., Ltd.
sales@k-maris.com | www.k-maris.com
Engineering Reliability. Supplying Performance.
"""
    return body


def shipping_advice_email_body(customer_name: str, doc_no: str, tracking_url: str = "") -> str:
    body = f"""Dear {customer_name},

Please find attached our Shipping Advice {doc_no} along with the Commercial Invoice and Packing List.
"""
    if tracking_url:
        body += f"""
Track your shipment in real time:
{tracking_url}
"""
    body += """
Best regards,
K-MARIS Energy & Solutions Co., Ltd.
sales@k-maris.com | www.k-maris.com
"""
    return body
