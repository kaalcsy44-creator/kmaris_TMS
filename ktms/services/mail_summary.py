"""메일 요약 — Claude Haiku 로 메일 1통을 한두 줄로, 프로젝트 전체를 몇 줄로.

목적은 "읽지 않고도 무슨 일이 오갔는지 아는 것"이다. 그래서 인사말·서명·인용문은
버리고 값(가격·납기·수량·요청·확답)만 남긴다. 요약은 DB(EmailMessage.summary)에
넣어 두고 다시 부르지 않는다 — 메일 원문은 바뀌지 않으므로 한 번이면 된다.

키는 pdf_parser 와 같은 ANTHROPIC_API_KEY 를 쓴다(같은 클라이언트를 빌려 온다).
"""
from __future__ import annotations

import re
from datetime import datetime

from db.models import AppSetting, Customer, EmailMessage, RFQ, Vendor
from services.mail_sync import mail_group_of
from services.pdf_parser import _anthropic_client

MODEL = "claude-haiku-4-5-20251001"
# 딜별 롤업 저장 키(AppSetting). 화면·자동 실행·수동 버튼이 같은 자리를 본다.
ROLLUP_KEY = "mail_rollup"
# 요약에 넣을 본문 길이 — 메일의 용건은 거의 앞머리에 있고, 뒤는 인용된 이전 대화다.
BODY_CHARS = 3_000

# 인용된 이전 대화가 시작되는 자리 — 여기서부터는 이미 요약한 옛 메일이라 잘라 낸다.
# 줄 첫머리에서만 찾는다. 본문 한가운데의 "From:" 같은 낱말에 걸려 새 내용을 잘라내면
# 요약이 통째로 비어 버린다("On …wrote:" 도 그 꼴을 갖춘 줄만 인용으로 본다).
_QUOTE_RE = re.compile(
    r"^(?:>|-{2,}\s*Original Message|_{10,}|From:\s|Sent:\s|보낸\s*사람:|On\s.{0,120}\bwrote:)",
    re.M,
)


def strip_quoted(body: str) -> str:
    """새로 쓴 부분만 남긴다 — 인용 구분선 이후를 버린다.
    잘랐더니 아무것도 안 남으면(인용으로 시작하는 메일) 원문 앞머리를 그대로 쓴다."""
    text = body or ""
    hit = _QUOTE_RE.search(text, 1)
    head = text[: hit.start()].strip() if hit else text.strip()
    return head or text[:BODY_CHARS].strip()


def _fallback(msg: EmailMessage) -> str:
    """AI 없이 쓰는 발췌 — 요약 호출이 실패해도 화면이 비지 않게."""
    body = re.sub(r"\s+", " ", strip_quoted(msg.body_text or "")).strip()
    return body[:180] + ("…" if len(body) > 180 else "")


def summarize_message(msg: EmailMessage) -> str:
    """메일 1통 → 한두 줄 요약(한국어). 실패하면 본문 발췌로 대신한다."""
    body = strip_quoted(msg.body_text or "")[:BODY_CHARS]
    if not body.strip() and not (msg.subject or "").strip():
        return ""
    direction = ("우리가 거래처에 보낸 메일" if msg.direction == "out"
                 else "거래처에서 받은 메일")
    files = ", ".join(a.get("name", "") for a in (msg.attachments or [])[:5])
    prompt = f"""다음은 선박 기자재 무역회사가 거래처와 주고받은 {direction}입니다.
용건만 한국어 한두 문장으로 요약하세요.

규칙:
- 인사말·서명 같은 겉치레는 뺍니다. 다만 "무엇을 요청했는가/무엇을 보냈는가"는 그 자체가
  용건이므로 반드시 남깁니다(예: 견적 요청, 발주서 송부, 납기 확인 요청).
- 값이 있으면 원문 그대로 옮깁니다(가격·납기·수량·모델: USD 1,250 / 4주 / 3 SET).
- 40자 안팎 한 문장이 기본, 꼭 필요하면 두 문장까지.
- 요약문만 출력합니다. "요약하면", "정보가 부족하지만" 같은 군말, 별표(**)·목록 기호·
  따옴표는 쓰지 않습니다.
- 본문에 없는 내용은 지어내지 않되, 없는 것을 굳이 언급하지도 않습니다
  (수량·사양·첨부가 안 적혀 있으면 그냥 빼고 씁니다).
- 본문이 정말 비어 있을 때만 "내용 없음"이라고 씁니다.

제목: {msg.subject or "(제목 없음)"}
{f"첨부: {files}" if files else ""}
본문:
{body}"""
    try:
        client = _anthropic_client()
        res = client.messages.create(
            model=MODEL, max_tokens=300,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(getattr(b, "text", "") for b in res.content).strip()
        return re.sub(r"\s+", " ", text)[:400] or _fallback(msg)
    except Exception:
        return _fallback(msg)


def ensure_summaries(s, messages: list[EmailMessage], limit: int = 20) -> int:
    """아직 요약이 없는 메일을 채운다(한 번에 limit 통까지). 반환: 새로 만든 개수."""
    todo = [m for m in messages if not (m.summary or "").strip()][:limit]
    for m in todo:
        m.summary = summarize_message(m)
        m.summarized_at = datetime.utcnow()
    if todo:
        s.commit()
    return len(todo)


def summarize_project(rows: list[dict], project: str) -> str:
    """프로젝트 전체 메일 흐름 → 몇 줄 요약. rows = [{sent_at, direction, party, summary}]

    개별 요약을 이미 갖고 있으므로 원문 대신 그것들을 재료로 쓴다(호출 1회, 짧은 입력)."""
    if not rows:
        return ""
    lines = "\n".join(
        f"{r.get('sent_at','')} {'→' if r.get('direction') == 'out' else '←'} "
        f"{r.get('party') or '?'}: {r.get('summary') or ''}"
        for r in rows[-60:]
    )
    prompt = f"""아래는 '{project}' 건으로 거래처와 주고받은 메일을 시간순으로 한 줄씩 적은 것입니다
(→ 우리가 보냄, ← 받음).

이 건이 지금 어떤 상태인지, 아래 라벨을 그대로 써서 한국어로 정리하세요.
한 줄에 하나씩, "라벨: 내용" 꼴로만 씁니다.

진행: 무슨 일이 있었는지 시간 순서로 한 줄. 날짜(8/02)와 상대 이름을 넣고 "→" 로 잇습니다.
쟁점: 지금 걸려 있는 것(이견·미확답·요구사항). 걸린 게 없으면 이 줄을 쓰지 않습니다.
금액·납기: 오간 숫자를 원문 그대로(USD 1,350 / 3주 / 5 SET). 숫자가 없으면 이 줄을 쓰지 않습니다.
다음: 다음에 무엇을 해야 하는지. "우리 → …" 또는 "상대 대기 — …" 또는 "종료"로 시작합니다.

규칙:
- '진행'과 '다음'은 반드시 씁니다. '쟁점'과 '금액·납기'는 내용이 있을 때만 씁니다.
- 네 줄을 넘기지 않습니다. 라벨은 위 네 개 말고는 쓰지 않습니다.
- 메일에 없는 내용은 지어내지 않습니다. 별표(**)·목록 기호는 쓰지 않습니다.

{lines}"""
    try:
        client = _anthropic_client()
        res = client.messages.create(
            model=MODEL, max_tokens=600,
            messages=[{"role": "user", "content": prompt}],
        )
        return "".join(getattr(b, "text", "") for b in res.content).strip()[:2000]
    except Exception as exc:
        return f"(요약을 만들지 못했습니다: {exc})"


def build_project_rollup(s, rfq_id: int, title: str = "") -> str:
    """이 딜의 메일 흐름을 3~5줄로 만들어 AppSetting 에 저장하고 그 글을 돌려준다.

    title 은 프롬프트에 얹을 딜 이름이다. 화면에 보이는 번호(P-024)를 쓰고 싶으면
    호출부가 넘긴다 — 그 번호를 매기는 계산이 RFQ 전수 조회라, 딜을 여러 개 도는
    쪽에서 한 번만 계산해 나눠 쓰게 하려는 것이다. 비우면 rfq_no 로 대신한다.

    딜 화면의 "AI digest" 버튼, 대시보드의 일괄 생성, 매일 도는 자동 실행이 모두
    이것을 부른다 — 저장 모양(last_id 로 낡음을 가리는 것)이 세 곳에서 어긋나면
    화면이 낡은 요약을 새것처럼 보여 주게 된다.

    재료는 통별 요약이라 AI 호출은 1회다(요약이 아직 없는 메일은 먼저 채운다)."""
    # 한 문의에서 갈라진 형제 딜은 대화가 하나뿐이다 — 묶음 전체를 재료로 쓴다.
    # (읽기만 함께 하고, 롤업 글은 딜마다 따로 저장한다: 딜 이름이 다르므로.)
    group = mail_group_of(s, rfq_id)
    msgs = (s.query(EmailMessage).filter(EmailMessage.rfq_id.in_(group))
            .order_by(EmailMessage.sent_at).all())
    if not msgs:
        return ""
    ensure_summaries(s, msgs, limit=30)
    names = {
        "customer": {c.id: c.name for c in s.query(Customer.id, Customer.name).all()},
        "vendor": {v.id: v.name for v in s.query(Vendor.id, Vendor.name).all()},
    }

    def party(m: EmailMessage) -> str:
        if m.customer_id:
            return names["customer"].get(m.customer_id, "") or m.from_addr or ""
        if m.vendor_id:
            return names["vendor"].get(m.vendor_id, "") or m.from_addr or ""
        return m.from_addr if m.direction == "in" else ", ".join(m.to_addrs or [])

    rfq = s.query(RFQ.id, RFQ.rfq_no, RFQ.project_title).filter_by(id=rfq_id).first()
    label = " · ".join(x for x in [title or (rfq.rfq_no if rfq else ""),
                                   (rfq.project_title if rfq else "")] if x)
    text = summarize_project(
        [{"sent_at": m.sent_at, "direction": m.direction,
          "party": party(m), "summary": m.summary} for m in msgs],
        label or f"RFQ {rfq_id}")

    key = f"{ROLLUP_KEY}:{rfq_id}"
    row = s.query(AppSetting).filter_by(key=key).first()
    value = {"text": text, "last_id": max(m.id for m in msgs),
             "at": datetime.utcnow().isoformat(timespec="seconds")}
    if row:
        row.value, row.updated_at = value, datetime.utcnow()
    else:
        s.add(AppSetting(key=key, value=value, updated_at=datetime.utcnow()))
    s.commit()
    return text
