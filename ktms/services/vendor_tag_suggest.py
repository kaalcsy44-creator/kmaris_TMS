"""거래선 태그 제안 — 명부에 안 적혔지만 거래 기록에서 드러난 '취급 분류'와 '대 주는 메이커'.

Company info 의 두 태그(Vendor.category_ids · Vendor.maker_ids)는 손으로 채우게 두면
채워지지 않는다. 그런데 그 답은 이미 거래 기록에 있다:

  · 견적·발주 줄의 Maker 칸 — 벤더가 "이 메이커 것을 이 값에 준다"고 적어 보낸 것.
  · 벤더가 보낸 메일 본문 — "We are agent for …", 취급 품목 나열, 견적 회신의 품명.
  · 값을 준·산 품목의 분류 — settings.vendor_category_suggestions 가 이미 세는 실적.

**쓰지 않고 묻는다.** 메일에 이름이 나왔다고 그걸 대 준다는 뜻은 아니다(우리 질문을
되풀이했을 수도, 못 한다고 답했을 수도 있다). 그래서 근거를 붙여 '추가할까요?'로
내밀고, 사람이 Add 하면 그때 태그에 넣는다. Dismiss 한 것은 다시 묻지 않는다
(AppSetting DISMISS_KEY 에 회사별로 남긴다).

AI 를 부르지 않는다 — 명부의 메이커 이름과 분류 이름을 글에서 찾는 결정적 대조다.
알림(종)이 몇 분마다 부르는 자리라 호출 비용·지연이 붙으면 안 된다.
"""
from __future__ import annotations

import re
from datetime import date, timedelta

from db.models import (AppSetting, EmailMessage, ItemCategory, Maker, PurchaseOrder, RFQ,
                       VendorQuote, VendorRFQ, Vendor, Order)

DISMISS_KEY = "vendor_tag_dismissed"
# 이만큼 지난 근거는 제안하지 않는다 — 명부를 처음 여는 날 수년 치 백로그가 한꺼번에
# 알림으로 쏟아지면 아무도 안 본다. 지난 것은 Company info 의 '실적에서 채우기'가 있다.
LOOKBACK_DAYS = 180
EMAIL_CHARS = 6_000

# 인용된 이전 대화가 시작되는 자리. 메일 동기화가 줄바꿈을 잃은 채 담는 경우가 많아
# ("…Emailsales@x.com ----- Original Message -----From : Sungyeon Cho <…@k-maris.com>…")
# 줄 첫머리가 아니라 글 어디서든 찾는다. 우리 주소가 적힌 From 줄 = 우리가 보낸 글.
_QUOTE_RE = re.compile(
    r"-{2,}\s*Original Message|Original Message\s*-{2,}|원본\s*메일|보낸\s*사람\s*:|"
    r"From\s*:[^\n]{0,120}?k-maris|^>|On\s[^\n]{0,120}\bwrote:|_{10,}",
    re.I | re.M,
)
# 회사명 끝의 법인 표기 — 같은 메이커가 'SHIN SHIN MACHINERY CO., LTD.' 와
# 'Shin Shin Machinery' 로 갈려 적히는 것을 한 이름으로 접는다.
_LEGAL = re.compile(
    r"\b(co|ltd|limited|inc|corp|corporation|company|gmbh|ag|as|a/s|sa|s\.a|llc|plc|bv|kk|"
    r"pte|pvt|jsc)\b\.?|\(주\)|주식회사|㈜",
    re.I,
)


def norm_name(name: str) -> str:
    t = _LEGAL.sub(" ", (name or "").lower())
    t = re.sub(r"[^0-9a-z가-힣&+]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    # 한국 법인 표기('… Korea')는 같은 브랜드의 지사일 뿐이다.
    t = re.sub(r"\s+korea$", "", t)
    return t


def _fresh_text(body: str) -> str:
    """인용된 이전 대화(우리가 보낸 RFQ 가 대개 여기 딸려 온다)를 잘라 낸 새 본문."""
    text = body or ""
    hit = _QUOTE_RE.search(text)
    return (text[: hit.start()] if hit else text)[:EMAIL_CHARS]


_SUBJ_PREFIX = re.compile(r"^(?:\s*(?:\[[^\]]*\]|re\s*:|fw\s*:|fwd\s*:|회신\s*:|전달\s*:))+", re.I)


def _drop_subject(text: str, subject: str) -> str:
    """본문에 되풀이된 제목(국내 메일 도구는 본문 첫머리에 제목을 다시 적는다)을 걷어 낸다.
    제목은 우리가 보낸 RFQ 제목의 회신이라, 거기 나온 이름은 그 회사의 근거가 아니다."""
    core = _SUBJ_PREFIX.sub("", subject or "").strip()
    if len(core) < 10:
        return text
    return re.sub(re.escape(core), " ", text, flags=re.I)


def _load_dismissed(s) -> dict[str, list[str]]:
    row = s.query(AppSetting).filter_by(key=DISMISS_KEY).first()
    return dict(row.value or {}) if row and isinstance(row.value, dict) else {}


def dismiss(s, company: str, kind: str, ref_id: int) -> None:
    row = s.query(AppSetting).filter_by(key=DISMISS_KEY).first()
    if row is None:
        row = AppSetting(key=DISMISS_KEY, value={})
        s.add(row)
    val = dict(row.value or {})
    key = company.strip().lower()
    lst = list(val.get(key) or [])
    tag = f"{kind}:{ref_id}"
    if tag not in lst:
        lst.append(tag)
    val[key] = lst
    row.value = val   # JSON 칼럼은 새 dict 로 갈아 끼워야 변경이 잡힌다


def accept(s, company: str, kind: str, ref_id: int) -> int:
    """같은 회사(이름) 전 레코드의 태그에 더한다 — 태그는 회사 단위 값이다."""
    key = company.strip().lower()
    rows = [v for v in s.query(Vendor).all() if (v.name or "").strip().lower() == key]
    field = "maker_ids" if kind == "maker" else "category_ids"
    for v in rows:
        ids = [int(x) for x in (getattr(v, field, None) or []) if str(x).isdigit()]
        if ref_id not in ids:
            setattr(v, field, ids + [ref_id])
    return len(rows)


class _MakerIndex:
    """메이커 명부 → 회사 단위(이름) 사전. id 는 그 회사의 첫 레코드(가장 작은 id)."""

    def __init__(self, s):
        self.by_norm: dict[str, tuple[int, str]] = {}
        self.name_of_id: dict[int, str] = {}
        for m in s.query(Maker.id, Maker.name).order_by(Maker.id).all():
            nm = (m.name or "").strip()
            if not nm:
                continue
            self.name_of_id[m.id] = nm
            k = norm_name(nm)
            if k and k not in self.by_norm:
                self.by_norm[k] = (m.id, nm)
        # 글에서 찾을 패턴 — 긴 이름부터(‘HYUNDAI MARINE MACHINERY’가 ‘HYUNDAI’보다 먼저).
        self._pats: list[tuple[re.Pattern, int, str]] = []
        for k, (mid, nm) in sorted(self.by_norm.items(), key=lambda kv: -len(kv[0])):
            if len(k) < 3 or (len(k) < 4 and not nm.isupper()):
                continue
            words = [re.escape(w) for w in k.split(" ")]
            body = r"[\s\-_.,/]*".join(words)
            flags = 0 if len(k) < 4 else re.I   # 3글자 약칭(ABB·GPC)은 대문자 그대로만
            src = body.upper() if flags == 0 else body
            self._pats.append((re.compile(rf"(?<![0-9A-Za-z]){src}(?![0-9A-Za-z])", flags), mid, nm))

    def match_field(self, text: str) -> tuple[int, str] | None:
        """Maker 칸 한 칸 → 명부의 메이커. 같거나, 한쪽이 다른 쪽의 앞머리(5자 이상)."""
        k = norm_name(text)
        if not k:
            return None
        if k in self.by_norm:
            return self.by_norm[k]
        for nk, hit in self.by_norm.items():
            if len(nk) >= 5 and len(k) >= 5 and (k.startswith(nk + " ") or nk.startswith(k + " ")):
                return hit
        return None

    def find_in(self, text: str) -> list[tuple[int, str, str, str]]:
        """(메이커 id, 이름, 앞뒤 한 줄, 글에 실제로 적힌 낱말)."""
        out, seen = [], set()
        for pat, mid, nm in self._pats:
            m = pat.search(text)
            if m and mid not in seen:
                seen.add(mid)
                out.append((mid, nm, _snippet(text, m.start(), m.end()), m.group(0)))
        return out


def _snippet(text: str, a: int, b: int, pad: int = 50) -> str:
    s0 = max(0, a - pad)
    s1 = min(len(text), b + pad)
    frag = re.sub(r"\s+", " ", text[s0:s1]).strip()
    return ("…" if s0 else "") + frag + ("…" if s1 < len(text) else "")


# 분류 이름 갈래 중 혼자서는 뜻을 못 싣는 말 — 'Head Office'의 Head, 'Main Contactor'의
# Main 처럼 아무 메일에나 나온다. 이런 갈래는 짝과 함께(여러 낱말로) 나올 때만 센다.
_WEAK = {"head", "main", "module", "element", "kit", "seal", "ring", "unit", "parts", "part",
         "spare", "spares", "system", "systems", "service", "general", "other", "misc",
         "cover", "body", "set", "assembly", "assy", "pipe", "tube", "hose", "valve", "pump",
         "motor", "cable", "filter", "sensor", "control", "panel", "board", "plate", "actuator",
         "bearing", "bush", "bushing", "safety", "complete"}


def _category_patterns(s) -> list[tuple[re.Pattern, int, str]]:
    """부품 분류(코드 'EN-001' 꼴, 활성) 이름 → 글에서 찾을 패턴.
    'Nozzle / Nozzle Tip' 처럼 빗금으로 묶인 이름은 갈래마다 따로 찾되, 한 낱말 갈래는
    6자 이상이고 흔한 말(_WEAK)이 아닐 때만. 국문명은 4자 이상일 때만."""
    out = []
    for c in (s.query(ItemCategory)
              .filter(ItemCategory.active.is_(True), ItemCategory.code.isnot(None)).all()):
        if "-" not in (c.code or ""):
            continue
        label = c.name
        alts = [a.strip() for a in re.split(r"\s*/\s*", c.name or "") if a.strip()]
        for a in alts:
            words = a.split()
            if len(words) == 1 and (len(a) < 6 or a.lower() in _WEAK):
                continue
            pat = r"[\s\-]*".join(re.escape(w) for w in words) + r"(?:e?s)?"
            out.append((re.compile(rf"(?<![0-9A-Za-z]){pat}(?![0-9A-Za-z])", re.I), c.id, label))
        for a in re.split(r"\s*/\s*", c.name_ko or ""):
            a = a.strip()
            if len(a.replace(" ", "")) >= 4:
                out.append((re.compile(re.escape(a)), c.id, label))
    return out


def compute(s, company: str | None = None, category_rows: list[dict] | None = None) -> list[dict]:
    """회사별 제안 목록. category_rows = settings.vendor_category_suggestions()['rows']
    (실적 기반 분류 — 넘기면 함께 싣는다).

    반환: [{company, vendor_id, items: [{kind, ref_id, label, sources: [...]}]}]"""
    since = (date.today() - timedelta(days=LOOKBACK_DAYS)).isoformat()
    want = (company or "").strip().lower()

    vendors = s.query(Vendor.id, Vendor.name, Vendor.maker_ids, Vendor.category_ids,
                      Vendor.maker_id).all()
    co_of: dict[int, str] = {}
    have_makers: dict[str, set[str]] = {}
    have_cats: dict[str, set[int]] = {}
    anchor: dict[str, int] = {}
    display: dict[str, str] = {}
    self_maker: dict[str, set[str]] = {}
    mk = _MakerIndex(s)
    for v in vendors:
        co = (v.name or "").strip().lower()
        if not co:
            continue
        co_of[v.id] = co
        display.setdefault(co, (v.name or "").strip())
        anchor[co] = min(anchor.get(co, v.id), v.id)
        hm = have_makers.setdefault(co, set())
        for x in (v.maker_ids or []):
            if str(x).isdigit() and int(x) in mk.name_of_id:
                hm.add(norm_name(mk.name_of_id[int(x)]))
        have_cats.setdefault(co, set()).update(int(x) for x in (v.category_ids or []) if str(x).isdigit())
        me = self_maker.setdefault(co, {norm_name(v.name or "")})
        if v.maker_id and v.maker_id in mk.name_of_id:
            me.add(norm_name(mk.name_of_id[v.maker_id]))

    dismissed = _load_dismissed(s)
    found: dict[str, dict[tuple[str, int], dict]] = {}

    def add(co: str, kind: str, ref_id: int, label: str, src: dict):
        if not co or (want and co != want):
            return
        if kind == "maker":
            k = norm_name(mk.name_of_id.get(ref_id, label))
            if k in have_makers.get(co, set()) or k in self_maker.get(co, set()):
                return
        elif ref_id in have_cats.get(co, set()):
            return
        if f"{kind}:{ref_id}" in (dismissed.get(co) or []):
            return
        slot = found.setdefault(co, {}).setdefault(
            (kind, ref_id), {"kind": kind, "ref_id": ref_id, "label": label, "sources": []})
        # 근거는 종류마다 몇 개만 — 같은 메이커가 견적 스무 줄에 나와도 한두 줄이면 족하다.
        same = [x for x in slot["sources"] if x["type"] == src["type"]]
        if len(same) < 3 and not any(x.get("ref") == src.get("ref") for x in same):
            slot["sources"].append(src)

    from _core import _project_no_map   # 순환 import 피하려고 늦게 읽는다
    pno = _project_no_map(s)

    # 1) 벤더 견적 줄의 Maker 칸
    vrfq = {v.id: v for v in s.query(VendorRFQ.id, VendorRFQ.vendor_id, VendorRFQ.rfq_id).all()}
    for q in s.query(VendorQuote).all():
        v = vrfq.get(q.vendor_rfq_id)
        if v is None or not v.vendor_id:
            continue
        when = ((q.received_at or "") or (q.received_date or "")
                or (q.created_at.isoformat() if q.created_at else ""))[:10]
        if when and when < since:
            continue
        for it in (q.items or []):
            if not isinstance(it, dict) or not (it.get("maker") or "").strip():
                continue
            hit = mk.match_field(it["maker"])
            if hit:
                add(co_of.get(v.vendor_id, ""), "maker", hit[0], hit[1], {
                    "type": "quote", "ref": f"vq{q.id}", "date": when,
                    "rfq_id": v.rfq_id or 0, "project_no": pno.get(v.rfq_id or 0, ""),
                    "text": f"Quote {q.vendor_quote_no or ''} · {it.get('description') or it.get('part_no') or ''}".strip()[:160],
                })

    # 2) 발주서 줄의 Maker 칸 — 실제로 사 온 것
    ord_rfq = {o.id: o.rfq_id for o in s.query(Order.id, Order.rfq_id).all()}
    for po in s.query(PurchaseOrder).all():
        when = (po.date or (po.created_at.isoformat() if po.created_at else ""))[:10]
        if not po.vendor_id or (when and when < since):
            continue
        rid = ord_rfq.get(po.order_id or 0) or 0
        for it in (po.items or []):
            if not isinstance(it, dict) or not (it.get("maker") or "").strip():
                continue
            hit = mk.match_field(it["maker"])
            if hit:
                add(co_of.get(po.vendor_id, ""), "maker", hit[0], hit[1], {
                    "type": "po", "ref": f"po{po.id}", "date": when,
                    "rfq_id": rid, "project_no": pno.get(rid, ""),
                    "text": f"P/O {po.po_no or ''} · {it.get('description') or it.get('part_no') or ''}".strip()[:160],
                })

    # 3) 벤더가 보낸 메일(받은 메일만 — 우리가 보낸 글은 그 회사에 대한 근거가 아니다)
    cat_pats = _category_patterns(s)
    mails = (s.query(EmailMessage.id, EmailMessage.vendor_id, EmailMessage.subject,
                     EmailMessage.body_text, EmailMessage.sent_at, EmailMessage.rfq_id)
             .filter(EmailMessage.direction == "in", EmailMessage.vendor_id.isnot(None),
                     EmailMessage.sent_at >= since)
             .all())
    for m in mails:
        co = co_of.get(m.vendor_id or 0, "")
        if not co or (want and co != want):
            continue
        text = f"{m.subject or ''}\n{_fresh_text(m.body_text or '')}"
        base = {"type": "email", "ref": f"mail{m.id}", "date": (m.sent_at or "")[:10],
                "rfq_id": m.rfq_id or 0, "project_no": pno.get(m.rfq_id or 0, ""),
                "subject": (m.subject or "")[:120], "email_id": m.id}
        # term = 글에 적힌 그대로의 낱말 — 메일 전문을 펼쳤을 때 그 자리를 짚어 준다.
        for mid, nm, snip, term in mk.find_in(text):
            add(co, "maker", mid, nm, {**base, "text": snip, "term": term})
        seen: set[int] = set()
        for pat, cid, label in cat_pats:
            if cid in seen:
                continue
            hit = pat.search(text)
            if hit:
                seen.add(cid)
                add(co, "category", cid, label, {**base, "text": _snippet(text, hit.start(), hit.end()),
                                                 "term": hit.group(0)})

    # 4) 값을 준·산 품목의 분류(실적) — 이미 세어 둔 것을 들여온다.
    for row in category_rows or []:
        co = (row.get("company") or "").strip().lower()
        for c in row.get("categories") or []:
            if (c.get("last") or "") and c["last"] < since:
                continue
            add(co, "category", int(c["id"]), (c.get("path") or "").split(" > ")[-1], {
                "type": "bought" if c.get("kind") == "bought" else "quote",
                "ref": f"cat{c['id']}", "date": c.get("last") or "",
                "text": f"{'Bought' if c.get('kind') == 'bought' else 'Quoted'} {c.get('count', 0)}× in this category",
            })

    out = []
    for co, items in found.items():
        lst = list(items.values())
        for it in lst:
            it["sources"].sort(key=lambda x: x.get("date") or "", reverse=True)
        # 메이커 먼저, 그다음 근거가 많은 것
        lst.sort(key=lambda it: (it["kind"] != "maker", -len(it["sources"]), it["label"]))
        out.append({"company": display.get(co, co), "vendor_id": anchor.get(co, 0), "items": lst,
                    "last": max((x.get("date") or "" for it in lst for x in it["sources"]), default="")})
    out.sort(key=lambda r: r["last"], reverse=True)
    return out
