"""이메일 서명 — 구조화 필드 → HTML/평문 렌더.

서명을 통이미지 한 장으로 붙이면 수신자가 이미지를 차단했을 때(Outlook 기본값)
연락처가 통째로 사라지고, 링크도 클릭할 수 없다. 그래서 로고까지 전부 텍스트로
그린다 — 이미지 없는 서명은 어디서나 똑같이 보이고 링크가 살아 있다.

레이아웃은 <table> 이다. Outlook 은 Word 렌더링 엔진을 써서 flex/grid 를 무시하므로
2단 구성은 표로 짜야 한다. 스타일도 전부 인라인이다(<style> 블록은 흔히 제거된다).
"""
from __future__ import annotations
import html as html_mod
import json
import os
from typing import Any, Dict, List

from services.email_svc import EMAIL_FONT_STACK

# 로고 자리의 브랜드 블록 — 첫 글자만 짙은 남색, 나머지는 파랑으로 그려 로고 모양을
# 텍스트로 재현한다.
BRAND = "K-MARIS"
BRAND_SUB = "Energy & Solutions"
_INK = "#16306b"        # 로고 남색(왼쪽 굵은 바)
_BLUE = "#2f5fc0"       # 로고 파랑
_DARK = "#0f172a"
_TEXT = "#3b4658"
_MUTED = "#8a94a3"
_LINE = "#d6dbe3"
_FONT = "Arial, Helvetica, 'Malgun Gothic', 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif"

_LABELS = {
    "en": {"mobile": "Mobile", "email": "Email", "website": "Website", "address": "Address"},
    "ko": {"mobile": "휴대폰", "email": "이메일", "website": "웹사이트", "address": "주소"},
}
_DEFAULT_CLOSING = {"en": "Best regards,", "ko": "감사합니다."}
_DEFAULT_SERVICES = ["Marine Spares  |  Bunkering", "Technical Services"]
_DEFAULT_DISCLAIMER = {
    "en": "This email and any attachments may contain confidential information "
          "intended solely for the recipient.",
    "ko": "본 메일과 첨부 파일에는 수신인만을 위한 기밀 정보가 포함될 수 있습니다.",
}

# 사용자가 채우는 칸(나머지 — 브랜드·태그라인·서비스·고지문 — 은 회사 공통).
PERSONAL_KEYS = ("name", "title", "mobile_label", "mobile", "emails", "website", "address")


def _company() -> Dict[str, Any]:
    path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "config", "company.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh) or {}
    except (OSError, ValueError):
        return {}


def _as_lines(v: Any) -> List[str]:
    """문자열(줄바꿈 구분) 또는 리스트 → 빈 줄 제거한 리스트."""
    if isinstance(v, (list, tuple)):
        items = [str(x) for x in v]
    else:
        items = str(v or "").replace("\r\n", "\n").split("\n")
    return [x.strip() for x in items if str(x).strip()]


def default_fields(lang: str = "en", user: Dict[str, Any] | None = None) -> Dict[str, Any]:
    """새 서명의 출발값 — 회사 프로필과 로그인 사용자 정보에서 끌어온다."""
    lang = "ko" if lang == "ko" else "en"
    c = _company()
    u = user or {}
    addr = c.get("address" if lang == "ko" else "address_en") or c.get("address_en") or ""
    return {
        "closing": _DEFAULT_CLOSING[lang],
        "name": (u.get("name") or "").strip(),
        "title": (u.get("title") or "").strip(),
        "mobile_label": "휴대폰" if lang == "ko" else "Mobile",
        "mobile": (u.get("phone") or c.get("phone") or "").strip(),
        "emails": [e for e in [(u.get("email") or "").strip(),
                               (c.get("sales_email") or "").strip()] if e][:2],
        "website": (c.get("website") or "").strip(),
        "address": _as_lines(addr),
        "tagline": _as_lines(c.get("tagline") or "Engineering Reliability. Supplying Performance."),
        "services": list(_DEFAULT_SERVICES),
        "disclaimer": _DEFAULT_DISCLAIMER[lang],
    }


def normalize_fields(raw: Any, lang: str = "en") -> Dict[str, Any]:
    """저장/렌더 전에 형태를 맞춘다 — 여러 줄 칸은 리스트로."""
    lang = "ko" if lang == "ko" else "en"
    d = dict(raw or {})
    out: Dict[str, Any] = {
        "closing": str(d.get("closing") or "").strip(),
        "name": str(d.get("name") or "").strip(),
        "title": str(d.get("title") or "").strip(),
        "mobile_label": str(d.get("mobile_label") or "").strip(),
        "mobile": str(d.get("mobile") or "").strip(),
        "website": str(d.get("website") or "").strip(),
        "disclaimer": str(d.get("disclaimer") or "").strip(),
        "emails": _as_lines(d.get("emails")),
        "address": _as_lines(d.get("address")),
        "tagline": _as_lines(d.get("tagline")),
        "services": _as_lines(d.get("services")),
    }
    if not out["mobile_label"]:
        out["mobile_label"] = _LABELS[lang]["mobile"]
    return out


def has_content(fields: Any) -> bool:
    """이름조차 없으면 서명으로 쓰지 않는다(빈 표가 나가는 것을 막는다)."""
    f = normalize_fields(fields)
    return bool(f["name"] or f["emails"] or f["mobile"])


def _e(s: str) -> str:
    return html_mod.escape(str(s or ""), quote=True)


def _row(label: str, value_html: str) -> str:
    return (
        f'<tr><td style="font-size:12.5px;font-weight:700;color:{_DARK};'
        f'padding:3px 16px 3px 0;white-space:nowrap;vertical-align:top;">{_e(label)}</td>'
        f'<td style="font-size:12.5px;color:{_TEXT};padding:3px 0;vertical-align:top;">'
        f"{value_html}</td></tr>"
    )


def _link(href: str, text: str) -> str:
    return f'<a href="{_e(href)}" style="color:{_BLUE};text-decoration:underline;">{_e(text)}</a>'


def signature_html(fields: Any, lang: str = "en") -> str:
    """구조화 필드 → 서명 HTML 조각. 본문 HTML 뒤에 그대로 이어 붙인다."""
    lang = "ko" if lang == "ko" else "en"
    f = normalize_fields(fields, lang)
    lb = _LABELS[lang]

    # ── 좌: 브랜드 블록(로고를 텍스트로) ──────────────────────────────────────
    head, rest = (BRAND[:1], BRAND[1:]) if BRAND else ("", "")
    brand = (
        f'<div style="font-size:30px;font-weight:800;line-height:1.05;'
        f'letter-spacing:-0.5px;"><span style="color:{_DARK};">{_e(head)}</span>'
        f'<span style="color:{_BLUE};">{_e(rest)}</span></div>'
        f'<div style="font-size:15px;font-weight:700;color:{_BLUE};margin-top:5px;">'
        f"{_e(BRAND_SUB)}</div>"
    )
    if f["tagline"]:
        brand += (
            f'<div style="font-size:11.5px;font-style:italic;color:#5b6675;'
            f'line-height:1.45;margin-top:12px;">'
            + "<br>".join(_e(t) for t in f["tagline"])
            + "</div>"
        )
    if f["services"]:
        brand += (
            f'<div style="font-size:11.5px;font-weight:700;color:{_INK};'
            f'line-height:1.5;margin-top:12px;">'
            + "<br>".join(_e(t) for t in f["services"])
            + "</div>"
        )

    # ── 우: 담당자 + 연락처 ──────────────────────────────────────────────────
    person = ""
    if f["name"]:
        person += (
            f'<div style="font-size:21px;font-weight:800;color:{_DARK};'
            f'line-height:1.2;">{_e(f["name"])}</div>'
        )
    if f["title"]:
        person += (
            f'<div style="font-size:12.5px;font-weight:700;color:{_BLUE};'
            f'margin-top:2px;">{_e(f["title"])}</div>'
        )

    rows = ""
    if f["mobile"]:
        rows += _row(f["mobile_label"], _e(f["mobile"]))
    if f["emails"]:
        rows += _row(
            lb["email"],
            "<br>".join(_link("mailto:" + m, m) for m in f["emails"]),
        )
    if f["website"]:
        w = f["website"]
        href = w if w.startswith("http") else "https://" + w
        rows += _row(lb["website"], _link(href, w))
    if f["address"]:
        rows += _row(lb["address"], "<br>".join(_e(a) for a in f["address"]))
    if rows:
        person += (
            '<table cellpadding="0" cellspacing="0" border="0" '
            f'style="border-collapse:collapse;margin-top:12px;">{rows}</table>'
        )

    disclaimer = ""
    if f["disclaimer"]:
        disclaimer = (
            f'<tr><td colspan="2" style="padding:10px 0 0;border-top:1px solid {_LINE};'
            f'font-size:10.5px;color:{_MUTED};line-height:1.4;">'
            f'{_e(f["disclaimer"])}</td></tr>'
        )

    closing = ""
    if f["closing"]:
        # 맺음말은 서명 카드가 아니라 본문의 마지막 줄로 읽히므로 본문 글꼴을 쓴다.
        closing = (
            f'<div style="font-family:{EMAIL_FONT_STACK};font-size:15px;color:#222222;'
            f'margin:0 0 12px;">{_e(f["closing"])}</div>'
        )

    return (
        f'<div style="margin-top:18px;">{closing}'
        '<table cellpadding="0" cellspacing="0" border="0" '
        f'style="border-collapse:collapse;font-family:{_FONT};max-width:640px;">'
        "<tr>"
        f'<td style="border-left:5px solid {_INK};padding:2px 24px 16px 14px;'
        'vertical-align:top;">' + brand + "</td>"
        f'<td style="border-left:1px solid {_LINE};padding:2px 0 16px 24px;'
        'vertical-align:top;">' + person + "</td>"
        "</tr>" + disclaimer + "</table></div>"
    )


def signature_text(fields: Any, lang: str = "en") -> str:
    """같은 서명의 평문판 — text/plain 파트와 편집 화면에 쓴다."""
    lang = "ko" if lang == "ko" else "en"
    f = normalize_fields(fields, lang)
    lb = _LABELS[lang]
    lines: List[str] = []
    if f["closing"]:
        lines += [f["closing"], ""]
    who = " | ".join(x for x in (f["name"], f["title"]) if x)
    if who:
        lines.append(who)
    lines.append(f"{BRAND} {BRAND_SUB}")
    if f["mobile"]:
        lines.append(f'{f["mobile_label"]}: {f["mobile"]}')
    if f["emails"]:
        lines.append(f'{lb["email"]}: ' + "  |  ".join(f["emails"]))
    if f["website"]:
        lines.append(f'{lb["website"]}: {f["website"]}')
    for a in f["address"]:
        lines.append(a)
    for t in f["tagline"]:
        lines.append(t)
    return "\n".join(lines)
