"""홈페이지 주소 하나로 거래처 등록 폼을 채운다 — 회사명·주소·연락처·소개·취급품목·로고.

명함 스캔(ocr/business-card)과 같은 자리에서 같은 규칙으로 쓰인다: **읽기만 한다.**
돌려준 값은 화면이 비어 있는 칸에만 채우고, 저장은 사람이 Add 를 눌러 평소 경로로 한다.

읽는 범위
- 홈페이지는 vendor_scan.fetch_site 가 읽는다(인트로·프레임 넘기기, 제품·회사소개 쪽
  따라가기, 자바스크립트 전용 사이트는 읽기 서비스로 우회까지 — 같은 고생을 두 번 하지 않는다).
- 그런데 그 수집기는 '무엇을 다루나'를 보려고 만든 것이라 각 쪽의 **앞머리**만 잘라 온다.
  주소·전화·이메일은 대개 맨 아래 꼬리말과 '오시는 길·Contact' 쪽에 있다. 그래서 여기서는
  첫 화면의 꼬리말을 따로 떼어 붙이고, 연락처 쪽을 두 장까지 더 읽는다.

로고는 모델이 그림을 보고 고르는 게 아니라, 첫 화면 HTML 에서 로고일 법한 주소를 추려
번호를 매겨 보여 주고 고르게 한다(JSON-LD logo → 이름에 logo 가 든 img → 아이콘 순).
그림을 받아 보는 건 고른 뒤 한 번뿐이다.
"""
from __future__ import annotations

import base64
import html
import ipaddress
import json
import re
import socket
from urllib.parse import urljoin, urlparse

import httpx

from services.pdf_parser import _ask_claude, _nullable_str, _sanitize_text
from services.vendor_scan import (
    _SKIP, _UA, TIMEOUT, _text_of, fetch_site, fetch_via_reader, site_url,
)

# 연락처가 적혀 있을 법한 쪽 — 메뉴 이름과 주소 양쪽을 본다.
_CONTACT = re.compile(
    r"(contact|location|map|address|find-?us|reach|office|"
    r"오시는|찾아오시는|연락처|위치|문의|会社概要|联系)",
    re.I,
)
CONTACT_PAGES = 2
TAIL_CHARS = 3_000       # 첫 화면 꼬리말 — 주소·전화·사업자번호가 모이는 자리
CONTACT_CHARS = 4_000
TOTAL_CHARS = 24_000
MAX_LOGO_BYTES = 1_500_000
LOGO_CANDIDATES = 8


class SiteProfileError(Exception):
    """사용자에게 그대로 보여 줄 실패 사유."""


# ── 안전장치 — 서버가 대신 여는 주소다. 사내망·클라우드 메타데이터 주소는 열지 않는다. ──
def _public_host(url: str) -> bool:
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        return False
    if p.port not in (None, 80, 443):
        return False
    try:
        infos = socket.getaddrinfo(p.hostname, None)
    except OSError:
        return True          # 이름을 못 찾으면 어차피 못 연다 — 그 오류는 fetch 가 알려 준다
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
                or ip.is_multicast or ip.is_unspecified):
            return False
    return True


# ── 첫 화면 HTML 에서 뽑는 것들 ───────────────────────────────────────────────
def _attr(tag: str, name: str) -> str:
    m = re.search(rf'(?is)\b{name}\s*=\s*["\']([^"\']*)["\']', tag)
    return html.unescape(m.group(1)).strip() if m else ""


def _jsonld(raw: str) -> list[dict]:
    out: list[dict] = []
    for m in re.finditer(r'(?is)<script[^>]+application/ld\+json[^>]*>(.*?)</script>', raw):
        try:
            data = json.loads(m.group(1).strip())
        except ValueError:
            continue
        items = data if isinstance(data, list) else data.get("@graph", [data]) if isinstance(data, dict) else []
        out.extend(d for d in items if isinstance(d, dict))
    return out


def _logo_candidates(raw: str, base: str) -> list[dict]:
    """로고일 법한 그림 주소 — 믿을 만한 순서로. 각 항목 {url, how}."""
    found: list[dict] = []
    seen: set[str] = set()

    def add(src: str, how: str):
        src = (src or "").strip()
        if not src or src.startswith("data:") and len(src) > 200_000:
            return
        url = src if src.startswith("data:") else urljoin(base, src).split("#")[0]
        if url in seen:
            return
        seen.add(url)
        found.append({"url": url, "how": how})

    for d in _jsonld(raw):
        logo = d.get("logo")
        if isinstance(logo, dict):
            logo = logo.get("url") or logo.get("contentUrl")
        if isinstance(logo, str):
            add(logo, "JSON-LD Organization.logo")
    for m in re.finditer(r"(?is)<img\b[^>]*>", raw):
        tag = m.group(0)
        src = _attr(tag, "src") or _attr(tag, "data-src")
        hint = " ".join([src.rsplit("/", 1)[-1], _attr(tag, "alt"), _attr(tag, "class"), _attr(tag, "id")])
        if re.search(r"logo|\bci\b|brand", hint, re.I):
            add(src, f'img alt="{_attr(tag, "alt")[:40]}" file={src.rsplit("/", 1)[-1][:60]}')
    # 인라인 SVG 로고(<svg class="logo">)는 그림 주소가 없다 — 그대로 data URL 로.
    for m in re.finditer(r'(?is)<svg\b[^>]*(?:logo|brand)[^>]*>.*?</svg>', raw):
        svg = m.group(0)
        if len(svg) < 60_000:
            add("data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode(), "inline svg (logo)")
    for m in re.finditer(r"(?is)<link\b[^>]*>", raw):
        tag = m.group(0)
        rel = _attr(tag, "rel").lower()
        if "apple-touch-icon" in rel:
            add(_attr(tag, "href"), "apple-touch-icon")
    for m in re.finditer(r"(?is)<link\b[^>]*>", raw):
        tag = m.group(0)
        rel = _attr(tag, "rel").lower()
        if "icon" in rel and "apple" not in rel:
            add(_attr(tag, "href"), f'favicon sizes={_attr(tag, "sizes") or "?"}')
    for m in re.finditer(r"(?is)<meta\b[^>]*>", raw):
        tag = m.group(0)
        if _attr(tag, "property").lower() == "og:image":
            add(_attr(tag, "content"), "og:image (often a banner, not a logo)")
    return found[:LOGO_CANDIDATES]


def _reader_logo_candidates(text: str) -> list[dict]:
    """읽기 서비스(마크다운)로 읽은 경우 — ![alt](url) 중 logo 가 든 것."""
    out = []
    for m in re.finditer(r"!\[([^\]]{0,80})\]\((https?://[^)\s]+)\)", text):
        if re.search(r"logo|\bci\b", m.group(1) + " " + m.group(2), re.I):
            out.append({"url": m.group(2), "how": f'image alt="{m.group(1)[:40]}"'})
    return out[:LOGO_CANDIDATES]


def _meta_lines(raw: str) -> str:
    """제목·설명·og:site_name·JSON-LD 조직 정보·mailto/tel 링크 — 본문 글보다 정확한 단서."""
    lines: list[str] = []
    t = re.search(r"(?is)<title[^>]*>(.*?)</title>", raw)
    if t:
        lines.append("title: " + _text_of(t.group(1))[:200])
    for m in re.finditer(r"(?is)<meta\b[^>]*>", raw):
        tag = m.group(0)
        key = (_attr(tag, "property") or _attr(tag, "name")).lower()
        if key in ("og:site_name", "og:title", "description", "og:description", "author"):
            lines.append(f"{key}: {_attr(tag, 'content')[:300]}")
    for d in _jsonld(raw):
        if str(d.get("@type", "")).lower() in ("organization", "corporation", "localbusiness"):
            keep = {k: d.get(k) for k in ("name", "legalName", "address", "telephone", "email",
                                           "faxNumber", "taxID", "vatID", "description") if d.get(k)}
            if keep:
                lines.append("JSON-LD: " + json.dumps(keep, ensure_ascii=False)[:1_500])
    mails = dict.fromkeys(m.group(1) for m in re.finditer(r'(?i)href=["\']mailto:([^"\'?]+)', raw))
    tels = dict.fromkeys(m.group(1) for m in re.finditer(r'(?i)href=["\']tel:([^"\']+)', raw))
    if mails:
        lines.append("mailto links: " + ", ".join(list(mails)[:10]))
    if tels:
        lines.append("tel links: " + ", ".join(list(tels)[:10]))
    return "\n".join(lines)


def _contact_links(raw: str, base: str, already: set[str]) -> list[str]:
    host = urlparse(base).netloc.lower()
    out: list[str] = []
    for m in re.finditer(r'(?is)<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', raw):
        href, label = m.group(1).strip(), _text_of(m.group(2))[:60]
        if not href or _SKIP.search(href):
            continue
        url = urljoin(base, href).split("#")[0].rstrip("/")
        if urlparse(url).netloc.lower() != host or url in already or url in out:
            continue
        if _CONTACT.search(href + " " + label):
            out.append(url)
    return out[:CONTACT_PAGES]


def _fetch_logo(cands: list[dict], pick: int | None) -> str:
    """고른 로고(없으면 앞 순서대로)를 받아 data URL 로. 못 받으면 빈 문자열."""
    order = list(range(len(cands)))
    if isinstance(pick, int) and 0 <= pick < len(cands):
        order.remove(pick)
        order.insert(0, pick)
    elif pick is None:
        return ""            # 모델이 "로고 없음"이라 했으면 아이콘으로 억지로 채우지 않는다
    with httpx.Client(timeout=TIMEOUT, follow_redirects=True, headers={"User-Agent": _UA}) as cli:
        for i in order[:3]:
            url = cands[i]["url"]
            if url.startswith("data:"):
                return url
            if not _public_host(url):
                continue
            try:
                r = cli.get(url)
            except Exception:
                continue
            if r.status_code >= 400 or not r.content or len(r.content) > MAX_LOGO_BYTES:
                continue
            ctype = r.headers.get("content-type", "").split(";")[0].strip().lower()
            if not ctype.startswith("image/"):
                if url.lower().endswith(".svg") or r.content.lstrip()[:5] in (b"<svg ", b"<?xml"):
                    ctype = "image/svg+xml"
                else:
                    continue
            return f"data:{ctype};base64," + base64.b64encode(r.content).decode()
    return ""


_SCHEMA = {
    "type": "object",
    "properties": {
        **_nullable_str("company", "tax_id", "about", "specialization"),
        "addresses": {"type": "array", "items": {"type": "string"}},
        "phones": {"type": "array", "items": {"type": "string"}},
        "emails": {"type": "array", "items": {"type": "string"}},
        "regions": {"type": "array", "items": {"type": "string"}},
        "logo": {"type": ["integer", "null"]},
    },
    "required": ["company", "tax_id", "about", "specialization",
                 "addresses", "phones", "emails", "regions", "logo"],
    "additionalProperties": False,
}


def _prompt(url: str, meta: str, text: str, logos: list[dict], kind: str) -> str:
    logo_menu = "\n".join(f"{i}\t{c['how']}\t{c['url'][:160]}" for i, c in enumerate(logos)) or "(none)"
    role = {"customer": "customer (ship owner / manager / shipyard)",
            "maker": "manufacturer", "vendor": "supplier / trading company"}.get(kind, "company")
    return f"""Below is text scraped from the website of a marine-industry {role}: {url}
Fill in our partner registration form from it.

Rules:
- Use ONLY what the website states. Do not guess, and do not use outside knowledge. Use null / [] when absent.
- company: the company's own name as written on the site (official name if shown, e.g. "(주)동명베아링" or
  "Alfa Laval Korea Ltd."). Not a slogan, not the page title boilerplate.
- addresses: head office first, then branches/plants/warehouses — each the full street address on one line,
  comma separated, including postal code and country when printed, WITHOUT the company name. Max 4.
- phones: main phone/fax numbers as printed (prefix fax numbers with "Fax "). Max 6.
- emails: company email addresses shown on the site (not web-form placeholders). Max 6.
- regions: country (or city-state such as Singapore / Hong Kong) of the head office, in English.
- tax_id: business registration / VAT / UEN number if printed (e.g. "사업자등록번호 123-45-67890" → "123-45-67890").
- about: 2–3 sentences in Korean describing what the company is and does (for the "About this company" field).
- specialization: short comma-separated English keywords of what they {"make" if kind == "maker" else "supply / handle"}
  (product types, services, brands they represent) — max ~12 items, most prominent first.
- logo: index of the image below that is the company's own logo (prefer a real logo image over a favicon;
  an og:image banner is usually NOT a logo). null if none of them looks like the company logo.

Logo candidates (index, where found, url):
{logo_menu}

Page metadata:
{meta}

Website text:
{text}"""


def profile_from_site(website: str, kind: str = "vendor") -> dict:
    """홈페이지 → 등록 폼 값. 실패하면 SiteProfileError(사용자에게 보일 문장)."""
    home = site_url(website)
    if not home:
        raise SiteProfileError("홈페이지 주소를 입력하세요.")
    if not _public_host(home):
        raise SiteProfileError("열 수 없는 주소입니다(공개 웹 주소만 읽습니다).")

    site = fetch_site(home)
    raw, base = site.get("home_html") or "", site.get("home_url") or home
    if site["error"] or site["thin"]:
        alt = fetch_via_reader(home)
        if not alt["thin"]:
            site = alt
    if site["error"] and not site["text"]:
        raise SiteProfileError(f"홈페이지를 {site['error']}")
    if not site["text"].strip() and not raw:
        raise SiteProfileError("홈페이지에서 읽을 수 있는 글이 없습니다.")

    chunks = [site["text"]]
    if raw:
        tail = _text_of(raw)[-TAIL_CHARS:]
        if tail and tail not in site["text"]:
            chunks.append(f"### {base} (footer)\n{tail}")
        seen = {p["url"].rstrip("/") for p in site["pages"]}
        with httpx.Client(timeout=TIMEOUT, follow_redirects=True, headers={"User-Agent": _UA}) as cli:
            for url in _contact_links(raw, base, seen):
                try:
                    r = cli.get(url)
                except Exception:
                    continue
                if r.status_code < 400:
                    t = _text_of(r.text)
                    if len(t) > 80:
                        chunks.append(f"### {url}\n{t[:CONTACT_CHARS]}")
    text = _sanitize_text("\n\n".join(chunks))[:TOTAL_CHARS]
    logos = _logo_candidates(raw, base) if raw else _reader_logo_candidates(site["text"])
    meta = _meta_lines(raw) if raw else "(not available)"

    data = _ask_claude(_prompt(base, meta, text, logos, kind), _SCHEMA, max_tokens=4_000)

    def _s(k: str) -> str:
        v = data.get(k)
        return str(v).strip() if v not in (None, "") else ""

    def _l(k: str, n: int) -> list[str]:
        out: list[str] = []
        for v in data.get(k) or []:
            t = str(v).strip()
            if t and t.lower() not in (o.lower() for o in out):
                out.append(t)
        return out[:n]

    return {
        # 사용자가 적은 주소를 열 수 있는 꼴로(앞머리 보충)만 — 인트로를 넘어간 안쪽 주소
        # (/english/ 등)는 회사 홈페이지 칸에 적을 값이 아니다.
        "website": home,
        "company": _s("company"),
        "addresses": _l("addresses", 4),
        "phones": _l("phones", 6),
        "emails": _l("emails", 6),
        "regions": _l("regions", 3),
        "tax_id": _s("tax_id"),
        "about": _s("about")[:1_000],
        "specialization": _s("specialization")[:500],
        "logo": _fetch_logo(logos, data.get("logo")) if logos else "",
        "pages": [p["url"] for p in site["pages"]],
    }
