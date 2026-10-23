"""IMO 번호로 선종(Vessel type)·기국(AIS Flag)·등록 선주·ISM 관리사를 찾는다 — Claude 웹 검색.

선주·관리사의 정본은 Equasis 지만 약관상 자동 수집이 안 된다 — 공개 선박 페이지가 옮겨
적은 값을 읽는다. 그래서 틀리거나 옛 값일 수 있고, 사람이 확인하는 것을 전제로 한다.

IMO 로 선박 정보를 무료로 정확히 주는 공식 창구가 없다(MarineTraffic 같은 곳은 유료 API).
그래서 Claude 에게 웹 검색으로 그 IMO 의 공개 선박 페이지를 찾아 읽게 하고, 찾은 출처를
함께 돌려준다. 가끔 틀릴 수 있으므로 화면은 결과를 칸에 채우기만 하고 저장은 사람이 한다
(일괄 채우기도 빈칸만 채운다 — 사람이 적은 값은 덮지 않는다).
"""
from __future__ import annotations

from services.pdf_parser import _anthropic_client, _api_error_message, _parse_response

_MODEL = "claude-opus-5-5"

# 설정 화면의 선종 목록(web VESSEL_TYPES)과 같은 이름 — 맞는 것이 있으면 이 이름으로 받는다.
VESSEL_TYPES = [
    "Container Ship", "Crude Oil Tanker", "Product Tanker", "Chemical Tanker", "Bulk Carrier",
    "Bunkering Tanker", "LNG Carrier", "LPG Carrier", "General Cargo", "Car Carrier (PCTC)",
    "Reefer", "Passenger / Ro-Pax", "Tug / Offshore",
]


def _prompt(imo: str, name: str) -> str:
    return f"""Find the merchant ship with IMO number {imo}{f' (our records call it "{name}")' if name else ''}.
Search the web for this exact IMO number (ship-tracking and registry pages such as VesselFinder,
MarineTraffic, MyShipTracking, BalticShipping, Equasis summaries) and read what they say.

Report the ship's CURRENT details:
- name: the current ship name
- vessel_type: use one of {VESSEL_TYPES} when one fits; otherwise a short English ship type
- flag: the current flag state as an English country name (e.g. "Liberia", "Marshall Islands", "Hong Kong")
- registered_owner: the current registered owner company (often a one-ship company)
- ism_manager: the current ISM manager / technical manager (the company that runs the ship day to day).
  If a page only gives one "Manager", use it here. Give company names as written, without the address.

Only report facts found for IMO {imo} itself. If a page is about a different IMO, ignore it.
If you cannot find the ship, use null for the fields you could not confirm.

Reply with ONLY this JSON object, no other text:
{{"name": string|null, "vessel_type": string|null, "flag": string|null,
  "registered_owner": string|null, "ism_manager": string|null,
  "confidence": "high"|"medium"|"low", "note": string}}
"note" is one short English sentence (e.g. which sites agreed, or why nothing was found)."""


def lookup_vessel(imo: str, name: str = "") -> dict:
    """{name, vessel_type, flag, registered_owner, ism_manager, confidence, note, sources:[{title,url}]}."""
    client = _anthropic_client()
    messages: list = [{"role": "user", "content": _prompt(imo, name)}]
    tools = [{"type": "web_search_20260209", "name": "web_search", "max_uses": 6}]
    sources: list[dict] = []
    seen: set[str] = set()
    resp = None
    try:
        # 서버 도구는 한 번에 끝나지 않으면 pause_turn 으로 멈춘다 — 받은 내용을 붙여 이어 간다.
        for _ in range(4):
            resp = client.messages.create(
                model=_MODEL, max_tokens=8000, messages=messages, tools=tools,
                output_config={"effort": "low"},
            )
            for block in resp.content:
                if block.type == "web_search_tool_result" and isinstance(block.content, list):
                    for r in block.content:
                        url = getattr(r, "url", "")
                        if url and url not in seen:
                            seen.add(url)
                            sources.append({"title": getattr(r, "title", "") or url, "url": url})
            if resp.stop_reason != "pause_turn":
                break
            messages.append({"role": "assistant", "content": resp.content})
    except Exception as exc:
        raise ValueError(_api_error_message(exc)) from exc

    if resp is None or resp.stop_reason == "refusal":
        return {"name": None, "vessel_type": None, "flag": None,
                "registered_owner": None, "ism_manager": None, "confidence": "low",
                "note": "The lookup was declined.", "sources": []}
    # 답(JSON)은 마지막 텍스트 블록들에 있다 — 검색 중간의 짧은 말과 섞이지 않게 끝에서부터 잇는다.
    text = "".join(b.text for b in resp.content if b.type == "text")
    try:
        data = _parse_response(text[text.rfind("{\"name\""):] if "{\"name\"" in text else text)
    except Exception:
        data = {}
    # 인용(citations)에 쓴 페이지를 앞으로 — 실제로 근거가 된 곳이다.
    cited: list[str] = []
    for b in resp.content:
        for c in (getattr(b, "citations", None) or []):
            u = getattr(c, "url", "")
            if u and u not in cited:
                cited.append(u)
    sources.sort(key=lambda s: (s["url"] not in cited, cited.index(s["url"]) if s["url"] in cited else 0))
    clean = lambda v: (str(v).strip() or None) if v not in (None, "") else None
    return {
        "name": clean(data.get("name")),
        "vessel_type": clean(data.get("vessel_type")),
        "flag": clean(data.get("flag")),
        "registered_owner": clean(data.get("registered_owner")),
        "ism_manager": clean(data.get("ism_manager")),
        "confidence": data.get("confidence") if data.get("confidence") in ("high", "medium", "low") else "low",
        "note": clean(data.get("note")) or "",
        "sources": sources[:4],
    }
