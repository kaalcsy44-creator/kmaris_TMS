"""거래선 홈페이지를 읽어 '무엇을 다루고 누구 것을 대 주는가'를 뽑는다.

명부의 두 태그 — 취급 분류(Vendor.category_ids)와 대 줄 수 있는 제조사
(Vendor.maker_ids) — 는 RFQ 를 어디로 보낼지 정하는 축인데, 손으로 채우게 두면
채워지지 않는다(거래선 65곳 중 메이커가 달린 곳은 30곳이었다). 실적에서 뽑는 제안은
이미 있지만(settings.vendor_category_suggestions) 아직 거래해 본 적 없는 곳은 비어
있다. 홈페이지는 그 빈자리를 메울 수 있는 유일한 근거다 — 대개 첫 화면에 취급
브랜드를 늘어놓는다.

**제안만 한다. 쓰지는 않는다.** 홈페이지에 로고가 걸렸다고 그 메이커를 대 준다는
뜻은 아니다 — 한 번 납품한 실적일 수도, 호환품을 만든다는 뜻일 수도 있다. 메이커를
잘못 달면 2단계에서 엉뚱한 곳으로 물어보게 되므로, 고르는 것은 사람이 한다.

첫 화면만 읽어서는 절반이 안 된다(메뉴 글자만 잡히는 곳이 많다). 그래서 메뉴에서
제품·사업·취급품목으로 보이는 링크를 몇 개 따라 들어간다. 자바스크립트로만 그리는
사이트는 본문이 통째로 비는데, 그때는 조용히 빈 답을 주지 말고 그 사실을 말한다 —
"아무것도 못 찾았다"와 "읽을 수가 없었다"는 사람이 할 일이 전혀 다르다.
"""
from __future__ import annotations

import html
import json
import re
from urllib.parse import urljoin, urlparse

import httpx

from db.models import ItemCategory, Maker
from services.pdf_parser import _anthropic_client, _api_error_message, _parse_response

MODEL = "claude-opus-5"
_UA = "Mozilla/5.0 (compatible; KTMS/1.0; +vendor catalogue scan)"

MAX_PAGES = 5          # 첫 화면 + 따라 들어갈 링크 4개
PAGE_CHARS = 6_000     # 한 쪽에서 가져갈 글자 수 — 뒤쪽은 대개 주소·저작권 문구다
TOTAL_CHARS = 20_000   # 모델에 보낼 전체 상한
THIN_CHARS = 400       # 이보다 짧으면 사람이 볼 내용이 없는 쪽으로 친다
TIMEOUT = 15.0

# 따라 들어갈 만한 링크 — 취급 브랜드와 품목은 거의 이 이름의 쪽에 있다.
_WORTH = re.compile(
    r"(product|business|brand|item|supply|range|catalog|lineup|line-up|"
    r"partner|agency|maker|service|solution|about|company|"
    r"제품|품목|취급|사업|브랜드|제조사|공급|서비스|회사소개)",
    re.I,
)
# 따라가면 안 되는 곳 — 글은 많은데 취급품목과는 상관없다.
_SKIP = re.compile(
    r"(login|join|member|privacy|terms|sitemap|board|bbs|news|notice|blog|gallery|"
    r"recruit|career|[.]pdf$|[.]jpg$|[.]png$|[.]zip$|mailto:|tel:|javascript:)",
    re.I,
)


def site_url(website: str) -> str:
    """명부에 적힌 주소를 실제로 열 수 있는 URL 로. 앞머리를 빼먹고 적는 일이 흔하다."""
    w = (website or "").strip()
    if not w:
        return ""
    return w if w.startswith(("http://", "https://")) else "https://" + w


def _text_of(raw: str) -> str:
    """태그를 걷어낸 본문. 스크립트·스타일은 글자 수만 부풀리므로 통째로 버린다."""
    t = re.sub(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", raw)
    t = re.sub(r"(?is)<!--.*?-->", " ", t)
    t = re.sub(r"(?s)<[^>]+>", " ", t)
    return re.sub(r"\s+", " ", html.unescape(t)).strip()


def _links(raw: str, base: str) -> list[str]:
    """따라 들어갈 만한 같은 사이트 링크 — 메뉴 이름과 주소 양쪽을 보고 고른다."""
    host = urlparse(base).netloc.lower()
    out: list[str] = []
    seen = {base.rstrip("/")}
    for m in re.finditer(r'(?is)<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', raw):
        href, label = m.group(1).strip(), _text_of(m.group(2))[:60]
        if not href or _SKIP.search(href):
            continue
        url = urljoin(base, href)
        if urlparse(url).netloc.lower() != host:
            continue
        url = url.split("#")[0].rstrip("/")
        if url in seen or not _WORTH.search(href + " " + label):
            continue
        seen.add(url)
        out.append(url)
    return out


def fetch_site(website: str) -> dict:
    """홈페이지와 그 안의 몇 쪽을 읽어 본문을 모은다.

    반환: {"pages": [{"url", "chars"}], "text": str, "error": str, "thin": bool}
    error 는 아예 못 연 경우, thin 은 열렸는데 읽을 글이 없는 경우(JS 전용 사이트)다.
    """
    home = site_url(website)
    if not home:
        return {"pages": [], "text": "", "error": "홈페이지 주소가 없습니다.", "thin": False}

    pages: list[dict] = []
    chunks: list[str] = []
    with httpx.Client(timeout=TIMEOUT, follow_redirects=True,
                      headers={"User-Agent": _UA}) as cli:
        try:
            r = cli.get(home)
        except Exception as exc:
            return {"pages": [], "text": "",
                    "error": f"열 수 없습니다 — {type(exc).__name__}", "thin": False}
        if r.status_code >= 400:
            return {"pages": [], "text": "",
                    "error": f"열 수 없습니다 — HTTP {r.status_code}", "thin": False}

        body = r.text
        text = _text_of(body)[:PAGE_CHARS]
        pages.append({"url": str(r.url), "chars": len(text)})
        chunks.append(f"### {r.url}\n{text}")

        for url in _links(body, str(r.url))[: MAX_PAGES - 1]:
            if sum(len(c) for c in chunks) >= TOTAL_CHARS:
                break
            try:
                sub = cli.get(url)
                if sub.status_code >= 400:
                    continue
                t = _text_of(sub.text)[:PAGE_CHARS]
            except Exception:
                continue
            if len(t) < 80:            # 빈 쪽은 자리만 차지한다
                continue
            pages.append({"url": url, "chars": len(t)})
            chunks.append(f"### {url}\n{t}")

    text = "\n\n".join(chunks)[:TOTAL_CHARS]
    # 첫 화면이 얇아도 안쪽 쪽에서 건졌으면 얇은 것이 아니다 — 전체로 판단한다.
    body_only = re.sub(r"### \S+", "", text).strip()
    return {"pages": pages, "text": text, "error": "",
            "thin": len(body_only) < THIN_CHARS}


def _menus(s) -> tuple[list[dict], list[dict], dict, dict]:
    """고를 수 있는 것들 — 제조사 명부와 부품 분류 2단.

    제조사는 회사 단위로 접는다(레코드 1 = 담당자 1 이라 같은 회사가 여러 줄이다).
    어느 줄의 id 를 돌려줘도 태그 칸이 대표 줄로 정리하므로, 가장 앞선 줄을 쓴다.
    """
    makers: list[dict] = []
    seen: set[str] = set()
    for m in s.query(Maker).order_by(Maker.id).all():
        name = (m.name or "").strip()
        key = re.sub(r"[^a-z0-9가-힣]", "", name.lower())
        if not key or key in seen:
            continue
        seen.add(key)
        makers.append({"id": m.id, "name": name, "country": (m.country or "").strip()})

    cats = {c.id: c for c in s.query(ItemCategory).all()}
    rows: list[dict] = []
    for c in sorted(cats.values(), key=lambda x: (x.code or "", x.name or "")):
        if c.level != 2 or not c.active or c.tree_type not in ("part", "service"):
            continue
        top = cats.get(c.parent_id) if c.parent_id else None
        rows.append({
            "id": c.id,
            "code": c.code or "",
            "path": f"{top.name} > {c.name}" if top else (c.name or ""),
        })
    return makers, rows, {m["id"]: m for m in makers}, {r["id"]: r for r in rows}


_SCHEMA = {
    "type": "object",
    "properties": {
        "maker_ids": {"type": "array", "items": {"type": "integer"}},
        "category_ids": {"type": "array", "items": {"type": "integer"}},
        "evidence": {"type": "string"},
        "unlisted_brands": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
    "required": ["maker_ids", "category_ids", "evidence", "unlisted_brands", "summary"],
    "additionalProperties": False,
}


def _prompt(name: str, text: str, makers: list[dict], cats: list[dict],
            kind: str = "vendor") -> str:
    cat_menu = "\n".join(f"{c['id']}\t{c['code']}\t{c['path']}" for c in cats)
    # 제조사 명부는 거래선에만 낸다 — 제조사 자신은 '누구 것을 대 주나'라는 칸이 없다
    # (그 회사가 곧 그 브랜드다). 물어봐야 할 것은 '무엇을 만드는가' 하나뿐이다.
    if kind == "maker":
        head = (f"아래는 선박 기자재 **제조사** '{name}' 의 홈페이지에서 긁어 온 글입니다.\n"
                "이 회사가 **무엇을 만드는지**를 우리 분류표의 번호로 골라 주세요.")
        maker_block = ""
    else:
        maker_menu = "\n".join(
            f"{m['id']}\t{m['name']}" + (f" ({m['country']})" if m["country"] else "")
            for m in makers)
        head = (f"아래는 선박 기자재 **거래선** '{name}' 의 홈페이지에서 긁어 온 글입니다.\n"
                "이 회사가 **무엇을 다루고 누구 것을 대 주는지**를 우리 명부의 번호로 "
                "골라 주세요.")
        maker_block = (f"\n[제조사 명부] — 이 회사가 대 줄 수 있어 보이는 제조사의 번호를 "
                       f"maker_ids 에\n{maker_menu}\n")
    return f"""{head}
{maker_block}
[부품 분류] — 이 회사가 {"만드는" if kind == "maker" else "다루는"} 품목의 번호를 category_ids 에
{cat_menu}

규칙:
- **명부에 있는 번호만** 씁니다. 목록에 없는 브랜드는 번호를 지어내지 말고
  unlisted_brands 에 이름 그대로 적습니다(우리가 나중에 명부에 올릴 거리입니다).
  **많아야 20개까지**, 홈페이지가 대표로 내세우는 것부터 적습니다 — 협력사 목록을
  통째로 옮겨 적으면 답이 길어져 중간에서 잘립니다.{
  "" if kind != "maker" else chr(10) + "- maker_ids 는 쓰지 않습니다(빈 배열)."}
- 홈페이지에 적힌 근거가 있는 것만 고릅니다. 선박 기자재 회사라는 이유로 으레
  있을 법한 것을 채우지 않습니다 — 틀린 태그는 없는 것만 못합니다(엉뚱한 곳에
  견적을 물어보게 됩니다).
- 브랜드 이름이 적혀 있어도 "우리가 만든다/판다/대리점이다"가 아니라 단순 실적
  자랑이나 호환품 언급으로 보이면 넣지 않습니다. 애매하면 빼고, 그 사정을
  evidence 에 적습니다.
- 분류는 넓게 잡지 말고 글에 실제로 나온 품목에 맞춥니다. 대분류 전체를 덮는
  선택은 하지 않습니다.
- evidence: 무엇을 근거로 골랐는지 한국어 두세 문장. 홈페이지에 적힌 표현을
  그대로 인용해 주세요("취급 브랜드: AUTONICS, LSIS" 같은 식으로).
- summary: 이 회사가 무슨 회사인지 한국어 한 문장(명부의 회사 소개 칸에 쓸 것).
- 고를 것이 없으면 빈 배열로 두고 evidence 에 왜 없는지 적습니다.

홈페이지 본문:
{text}"""


def scan_partner(s, name: str, website: str, kind: str = "vendor") -> dict:
    """거래처 한 곳 — 홈페이지를 읽어 태그 후보를 낸다. DB 는 건드리지 않는다.

    kind="vendor" 는 취급 분류와 대 줄 수 있는 제조사를, kind="maker" 는 분류만
    낸다(제조사에는 '누구 것을 대 주나'라는 칸이 없다 — 그 회사가 곧 그 브랜드다).

    반환: {"pages", "makers", "categories", "unlisted_brands", "evidence",
           "summary", "error"}
    """
    site = fetch_site(website)
    base = {"pages": site["pages"], "makers": [], "categories": [],
            "unlisted_brands": [], "evidence": "", "summary": "", "error": ""}
    if site["error"]:
        return {**base, "error": site["error"]}
    if site["thin"]:
        return {**base, "error": (
            "홈페이지에서 읽을 수 있는 글이 거의 없습니다 — 자바스크립트로만 그리는 "
            "사이트일 수 있습니다. 취급품목 쪽 주소를 직접 넣어 다시 시도해 보세요.")}

    makers, cats, maker_by_id, cat_by_id = _menus(s)
    prompt = _prompt(name, site["text"], makers, cats, kind)
    client = _anthropic_client()
    kwargs = {
        # 상한을 넉넉히 — 4,000 이었을 때 협력사를 70곳 늘어놓은 답이 중간에서 잘려
        # JSON 이 깨졌다(AJIN Trading). 스트리밍이라 크게 잡아도 요청은 안 끊기고,
        # 과금은 실제로 쓴 만큼만이라 넉넉한 쪽이 언제나 낫다.
        "model": MODEL, "max_tokens": 16_000,
        "messages": [{"role": "user", "content": prompt}],
        # effort=low — 목록에서 고르는 일이라 깊게 생각할 것이 없다(pdf_parser 와 같다).
        "output_config": {"effort": "low",
                          "format": {"type": "json_schema", "schema": _SCHEMA}},
    }
    try:
        try:
            with client.messages.stream(**kwargs) as stream:
                msg = stream.get_final_message()
        except TypeError:       # 구버전 SDK — output_config 인자가 없다
            kwargs.pop("output_config", None)
            with client.messages.stream(**kwargs) as stream:
                msg = stream.get_final_message()
    except Exception as exc:
        return {**base, "error": _api_error_message(exc)}

    raw = next((b.text for b in msg.content if b.type == "text"), "")
    try:
        # 형식을 스키마로 강제했으므로 평범한 JSON 이다. 그래도 한 겹 더 두는 것은
        # 구버전 SDK 로 떨어졌을 때(스키마 없이 재요청) 울타리가 붙어 올 수 있어서다.
        data = json.loads(raw)
    except ValueError:
        try:
            data = _parse_response(raw)
        except Exception:
            cut = msg.stop_reason == "max_tokens"
            return {**base, "error": (
                "홈페이지는 읽었지만 답이 너무 길어 중간에서 잘렸습니다. 다시 시도해 주세요."
                if cut else "홈페이지는 읽었지만 결과를 해석하지 못했습니다.")}

    # 모델이 없는 번호를 냈으면 조용히 버린다 — 명부에 없는 id 는 태그로 붙을 수 없다.
    picked_makers = [] if kind == "maker" else [
        maker_by_id[i] for i in dict.fromkeys(data.get("maker_ids") or [])
        if isinstance(i, int) and i in maker_by_id]
    picked_cats = [cat_by_id[i] for i in dict.fromkeys(data.get("category_ids") or [])
                   if isinstance(i, int) and i in cat_by_id]
    return {
        "pages": site["pages"],
        "makers": picked_makers,
        "categories": picked_cats,
        "unlisted_brands": [str(b).strip() for b in (data.get("unlisted_brands") or [])
                            if str(b).strip()][:20],
        "evidence": str(data.get("evidence") or "").strip()[:1_000],
        "summary": str(data.get("summary") or "").strip()[:400],
        "error": "",
    }
