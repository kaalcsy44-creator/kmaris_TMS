"""K-Maris TMS — 관계망(Partners › Network) 집계.

고객 ─ K-MARIS ─ 거래선 ─ 메이커 네 줄을 한 장에 세우고, 줄 사이 관계의 굵기(얼마나
오가는가)와 건강(그 왕래가 결과로 이어지는가)을 함께 돌려준다. 새로 적는 값은 없다 —
문의(rfqs)·오더(orders)·거래선 RFQ/견적·발주·메일함·홍보 이력이 이미 다 말해 주고 있다.

이 화면의 핵심은 맨 오른쪽 줄이다. 고객이 찾는 메이커(rfqs.items[].maker = 수요)와 그
메이커를 대 줄 거래선(vendors.maker_ids = 공급)을 나란히 놓으면 "자주 찾는데 대 줄 곳이
한 곳뿐이거나 없는" 메이커가 드러난다 — 개선 행동(거래선 발굴)이 가장 분명한 자리다.

회사 단위로 센다: 명부는 레코드 1 = 담당자 1 이라 같은 회사가 여러 줄이다(목록 화면이
회사 이름으로 묶는 것과 같은 규칙, 대소문자·앞뒤 공백 무시).

건강 판정은 점수 하나로 뭉치지 않고 규칙으로 정한다 — 화면이 "왜 빨간가"를 근거 수치로
보여 줄 수 있어야 사람이 무엇을 할지 정한다. 임계값은 아래 상수에 모아 둔다.
"""
from __future__ import annotations

import re
from datetime import date as _date, datetime as _dt, timedelta as _td

from sqlalchemy import func

from fastapi import Body, HTTPException

from db.models import AppSetting
from _core import (
    Customer,
    Depends,
    EmailMessage,
    Maker,
    MarketingActivity,
    Order,
    PurchaseOrder,
    RFQ,
    Vendor,
    VendorQuote,
    VendorRFQ,
    _enum_val,
    _total_amount,
    _vquote_recv_iso,
    _vrfq_sent_iso,
    app,
    cached_aggregate,
    get_session,
    require_token,
    usd_krw_rate,
)

# ── 판정 임계값 ──────────────────────────────────────────────────────────────
# 기본값이다. 화면(Network › Thresholds)에서 바꾸면 app_settings 의 THRESHOLD_KEY 에
# 저장되고, 집계는 매번 기본값 위에 저장값을 덮어 쓴다(빠진 키는 기본값 그대로).
THRESHOLD_KEY = "partner_network_thresholds"
DEFAULT_THRESHOLDS = {
    "cooling_days": 90,        # 마지막 접촉 후 이만큼 지나면 '식어 가는 관계'
    "min_inq": 3,              # 고객: 문의가 이만큼은 돼야 전환율로 판정한다(적으면 '이르다')
    "low_conv": 0.15,          # 고객: 문의→수주 이 아래면 저조
    "min_ask": 3,              # 거래선: 물어본 프로젝트가 이만큼은 돼야 회신률로 판정
    "low_reply": 0.4,          # 거래선: 회신률 이 아래면 빨강
    "mid_reply": 0.7,          # 거래선: 회신률 이 아래면 주황
    "slow_reply_days": 5.0,    # 거래선: 평균 회신 일수가 이보다 길면 주황
    "no_po_after_quotes": 3,   # 거래선: 견적은 이만큼 받았는데 발주 0 → 가격 경쟁력 확인
    "min_demand": 2,           # 메이커: 이만큼 찾았어야 공급 공백을 문제 삼는다
}
# 받아 줄 수 있는 범위(min, max) — 엉뚱한 값(음수·100% 초과)이 판정을 망가뜨리지 않게.
_THRESHOLD_RANGE = {
    "cooling_days": (7, 730), "min_inq": (1, 50), "low_conv": (0.0, 1.0),
    "min_ask": (1, 50), "low_reply": (0.0, 1.0), "mid_reply": (0.0, 1.0),
    "slow_reply_days": (0.5, 60.0), "no_po_after_quotes": (1, 50), "min_demand": (1, 50),
}


def _clean_thresholds(raw) -> dict:
    out = dict(DEFAULT_THRESHOLDS)
    for k, dv in DEFAULT_THRESHOLDS.items():
        v = (raw or {}).get(k) if isinstance(raw, dict) else None
        if v is None or v == "":
            continue
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        lo, hi = _THRESHOLD_RANGE[k]
        v = min(max(v, lo), hi)
        out[k] = int(round(v)) if isinstance(dv, int) else round(v, 3)
    if out["mid_reply"] < out["low_reply"]:
        out["mid_reply"] = out["low_reply"]
    return out


def load_thresholds(s) -> dict:
    row = s.query(AppSetting).filter_by(key=THRESHOLD_KEY).first()
    return _clean_thresholds(row.value if row else None)


def _ckey(name) -> str:
    """명부의 회사 묶음 키 — 목록 화면과 같은 규칙(대소문자·앞뒤 공백)."""
    return " ".join((name or "").split()).lower()


def _mkey(name) -> str:
    """메이커 이름 대조 키 — 표기 흔들림(MAN B&W / MAN-B&W)을 걷어낸다."""
    return re.sub(r"[^0-9a-z가-힣]+", "", (name or "").lower())


def _day(*vals) -> str:
    """첫 번째로 비어 있지 않은 날짜 값의 'YYYY-MM-DD'."""
    for v in vals:
        if not v:
            continue
        if isinstance(v, _dt):
            return (v + _td(hours=9)).date().isoformat()
        t = str(v).strip()
        if len(t) >= 10:
            return t[:10]
    return ""


def _days_between(a: str, b: str) -> float | None:
    """iso 일시 두 개('YYYY-MM-DD' 또는 'YYYY-MM-DDTHH:MM') 사이 일수."""
    def p(x):
        x = (x or "").strip()
        try:
            return _dt.fromisoformat(x[:16]) if len(x) >= 16 else _dt.fromisoformat(x[:10])
        except ValueError:
            return None
    da, db = p(a), p(b)
    if not da or not db:
        return None
    return (db - da).total_seconds() / 86400.0


class _MakerMatcher:
    """자유 입력 메이커 글자 → 메이커 명부의 회사 키.

    정확히 같은 키가 먼저고, 없으면 한쪽이 다른 쪽의 앞부분인 경우(‘MAN’ ↔ ‘MAN B&W’,
    ‘Alfa Laval Korea’ ↔ ‘Alfa Laval’) 가장 긴 것을 고른다. 세 글자 미만은 앞부분 대조를
    하지 않는다 — 'AB' 같은 글자가 아무 데나 붙지 않게."""

    def __init__(self, names: dict[str, str]):
        self.names = names                      # mkey → 표시 이름
        self.keys = sorted(names, key=len, reverse=True)
        self.memo: dict[str, str | None] = {}

    def match(self, text: str) -> str | None:
        k = _mkey(text)
        if not k:
            return None
        if k in self.memo:
            return self.memo[k]
        hit = k if k in self.names else None
        if hit is None and len(k) >= 3:
            for mk in self.keys:
                if len(mk) >= 3 and (k.startswith(mk) or mk.startswith(k)):
                    hit = mk
                    break
        self.memo[k] = hit
        return hit


# 메이커 칸에 도면번호·항목번호가 들어간 줄(‘DWG N25-V10-0052 ITEM 3’)이 있다 — 메이커가
# 아니므로 수요로 세지 않는다. 명부에 있는 이름은 이 거름과 무관하게 그대로 센다.
_NOT_MAKER = re.compile(r"\b(item|dwg|drawing|n/?a|tbc|tba|unknown|various)\b|\d{4,}", re.I)


def _item_makers(items) -> list[tuple[str, str]]:
    """품목표의 (라인ID, 메이커 글자) 목록."""
    out = []
    for it in (items if isinstance(items, list) else []):
        if isinstance(it, dict):
            m = str(it.get("maker") or "").strip()
            if m and m not in ("-", "—"):
                out.append((str(it.get("lid") or ""), m))
    return out


@app.get("/api/admin/partners/network", dependencies=[Depends(require_token)])
@cached_aggregate()
def partners_network(months: int = 12):
    months = max(1, min(int(months or 12), 60))
    today = (_dt.utcnow() + _td(hours=9)).date()
    cutoff = (today - _td(days=round(months * 30.44))).isoformat()
    rate = usd_krw_rate() or 1.0

    def usd(amount: float, cur: str | None) -> float:
        return amount / rate if (cur or "USD").upper() == "KRW" else amount

    s = get_session()
    try:
        T = load_thresholds(s)
        COOLING_DAYS = T["cooling_days"]
        MIN_INQ_FOR_JUDGE = T["min_inq"]
        LOW_CONV = T["low_conv"]
        MIN_ASK_FOR_JUDGE = T["min_ask"]
        LOW_REPLY = T["low_reply"]
        MID_REPLY = T["mid_reply"]
        SLOW_REPLY_DAYS = T["slow_reply_days"]
        NO_PO_AFTER_QUOTES = T["no_po_after_quotes"]
        MIN_DEMAND = T["min_demand"]
        # ── 명부: id → 회사 키 ────────────────────────────────────────────────
        cust_key: dict[int, str] = {}
        cust_name: dict[str, str] = {}
        for cid, name in s.query(Customer.id, Customer.name).all():
            k = _ckey(name)
            if k:
                cust_key[cid] = k
                cust_name.setdefault(k, (name or "").strip())
        ven_key: dict[int, str] = {}
        ven_name: dict[str, str] = {}
        ven_caps: dict[str, set] = {}      # 거래선 회사 → 대 줄 수 있는 메이커 키
        maker_rows = s.query(Maker.id, Maker.name).all()
        maker_key_of_id: dict[int, str] = {}
        maker_names: dict[str, str] = {}
        for mid, name in maker_rows:
            k = _mkey(name)
            if k:
                maker_key_of_id[mid] = k
                maker_names.setdefault(k, (name or "").strip())
        for vid, name, mids, direct in s.query(
                Vendor.id, Vendor.name, Vendor.maker_ids, Vendor.maker_id).all():
            k = _ckey(name)
            if not k:
                continue
            ven_key[vid] = k
            ven_name.setdefault(k, (name or "").strip())
            caps = ven_caps.setdefault(k, set())
            for m in (mids or []):
                try:
                    mk = maker_key_of_id.get(int(m))
                except (TypeError, ValueError):
                    mk = None
                if mk:
                    caps.add(mk)
            if direct and maker_key_of_id.get(direct):
                caps.add(maker_key_of_id[direct])
        matcher = _MakerMatcher(maker_names)

        # ── 고객 쪽: 문의·수주·실주·매출 ─────────────────────────────────────
        C: dict[str, dict] = {k: {"inquiries": 0, "won": 0, "lost": 0, "revenue_usd": 0.0,
                                  "orders": 0, "mail_in": 0, "mail_out": 0,
                                  "last_contact": "", "last_inquiry": "",
                                  "lost_reasons": {}, "makers": {}}
                              for k in cust_name}
        ordered_rfqs = {r[0] for r in s.query(Order.rfq_id).all() if r[0]}
        rfq_cust: dict[int, str] = {}
        rfq_lid_maker: dict[int, dict] = {}
        M: dict[str, dict] = {}                 # 메이커 키(또는 'raw:'+글자) → 수요

        def mnode(key: str, label: str, registered: bool) -> dict:
            return M.setdefault(key, {"label": label, "registered": registered,
                                      "demand": 0, "customers": set()})

        for rid, cid, d, recv, created, status, reasons, items in s.query(
                RFQ.id, RFQ.customer_id, RFQ.date, RFQ.received_at, RFQ.created_at,
                RFQ.status, RFQ.close_reason, RFQ.items).all():
            ck = cust_key.get(cid)
            if not ck:
                continue
            rfq_cust[rid] = ck
            # 이 딜 품목의 라인ID → 메이커 키. 거래선 RFQ 품목에는 메이커 칸이 없어(라인ID만
            # 안고 간다) 어느 메이커를 물었는지를 이것으로 되짚는다.
            lm: dict[str, str] = {}
            for lid, raw in _item_makers(items):
                mk = matcher.match(raw)
                if mk:
                    lm[lid or "_"] = mk
            rfq_lid_maker[rid] = lm
            day = _day(d, recv, created)
            c = C[ck]
            if day > c["last_contact"]:
                c["last_contact"] = day
            if not day or day < cutoff:
                continue
            c["inquiries"] += 1
            c["last_inquiry"] = max(c["last_inquiry"], day)
            if rid in ordered_rfqs:
                c["won"] += 1
            elif _enum_val(status) == "실주":
                c["lost"] += 1
                for code in [x.strip() for x in (reasons or "").split(",") if x.strip()]:
                    c["lost_reasons"][code] = c["lost_reasons"].get(code, 0) + 1
            seen = set()
            for _lid, raw in _item_makers(items):
                mk = matcher.match(raw)
                if not mk and _NOT_MAKER.search(raw):
                    continue
                key = mk if mk else "raw:" + (_mkey(raw) or raw.lower())
                if key in seen:
                    continue
                seen.add(key)
                n = mnode(key, maker_names[mk] if mk else raw, bool(mk))
                n["demand"] += 1
                n["customers"].add(ck)
                c["makers"][key] = c["makers"].get(key, 0) + 1

        for oid, rid, cid, d, cur, items, created in s.query(
                Order.id, Order.rfq_id, Order.customer_id, Order.date, Order.currency,
                Order.items, Order.created_at).all():
            ck = cust_key.get(cid) or rfq_cust.get(rid)
            if not ck:
                continue
            day = _day(d, created)
            if not day or day < cutoff:
                continue
            C[ck]["orders"] += 1
            C[ck]["revenue_usd"] += usd(_total_amount(items), cur)

        # ── 거래선 쪽: 물음·회신·회신 속도·발주 ───────────────────────────────
        V: dict[str, dict] = {k: {"asked": set(), "answered": set(), "reply_days": [],
                                  "pos": 0, "po_usd": 0.0, "mail_in": 0, "mail_out": 0,
                                  "last_contact": "", "maker_asked": {}, "maker_answered": {}}
                              for k in ven_name}
        first_quote: dict[int, str] = {}
        for q in s.query(VendorQuote.vendor_rfq_id, VendorQuote.received_at,
                         VendorQuote.received_date, VendorQuote.created_at).all():
            if not q[0]:
                continue
            iso = _vquote_recv_iso(q)
            if q[0] not in first_quote or (iso and iso < first_quote[q[0]]):
                first_quote[q[0]] = iso
        for vr in s.query(VendorRFQ.id, VendorRFQ.rfq_id, VendorRFQ.vendor_id,
                          VendorRFQ.sent_at, VendorRFQ.created_at, VendorRFQ.items,
                          VendorRFQ.sent_date).all():
            vk = ven_key.get(vr.vendor_id)
            if not vk or not vr.rfq_id:
                continue
            sent = _vrfq_sent_iso(vr) or _day(vr.sent_date)
            v = V[vk]
            if sent[:10] > v["last_contact"]:
                v["last_contact"] = sent[:10]
            if not sent or sent[:10] < cutoff:
                continue
            v["asked"].add(vr.rfq_id)
            got = vr.id in first_quote
            if got:
                v["answered"].add(vr.rfq_id)
                dd = _days_between(sent, first_quote[vr.id])
                if dd is not None and dd >= 0:
                    v["reply_days"].append(dd)
            lm = rfq_lid_maker.get(vr.rfq_id) or {}
            lids = {str(it.get("lid") or "") for it in (vr.items or []) if isinstance(it, dict)}
            # 라인ID 로 짚이면 그 줄들의 메이커, 못 짚으면(옛 RFQ) 딜의 메이커 전부.
            asked_makers = {lm[x] for x in lids if x in lm} or set(lm.values())
            for mk in asked_makers:
                v["maker_asked"].setdefault(mk, set()).add(vr.rfq_id)
                if got:
                    v["maker_answered"].setdefault(mk, set()).add(vr.rfq_id)

        for vid, d, cur, items, created in s.query(
                PurchaseOrder.vendor_id, PurchaseOrder.date, PurchaseOrder.currency,
                PurchaseOrder.items, PurchaseOrder.created_at).all():
            vk = ven_key.get(vid)
            day = _day(d, created)
            if not vk or not day or day < cutoff:
                continue
            V[vk]["pos"] += 1
            V[vk]["po_usd"] += usd(_total_amount(items), cur)
            V[vk]["last_contact"] = max(V[vk]["last_contact"], day)

        # ── 메일: 기간 안의 건수(방향별)와 기간 무관 마지막 접촉 ─────────────────
        for col, keymap, bucket in ((EmailMessage.customer_id, cust_key, C),
                                    (EmailMessage.vendor_id, ven_key, V)):
            for pid, direction, n, last in (
                    s.query(col, EmailMessage.direction, func.count(EmailMessage.id),
                            func.max(EmailMessage.sent_at))
                    .filter(col.isnot(None), EmailMessage.sent_at >= cutoff)
                    .group_by(col, EmailMessage.direction).all()):
                k = keymap.get(pid)
                if not k:
                    continue
                b = bucket[k]
                b["mail_in" if direction == "in" else "mail_out"] += int(n or 0)
            for pid, last in (s.query(col, func.max(EmailMessage.sent_at))
                              .filter(col.isnot(None)).group_by(col).all()):
                k = keymap.get(pid)
                if k and last and last[:10] > bucket[k]["last_contact"]:
                    bucket[k]["last_contact"] = last[:10]
        for cid, last in (s.query(MarketingActivity.customer_id,
                                  func.max(MarketingActivity.activity_date))
                          .filter(MarketingActivity.customer_id.isnot(None))
                          .group_by(MarketingActivity.customer_id).all()):
            k = cust_key.get(cid)
            if k and last and last[:10] > C[k]["last_contact"]:
                C[k]["last_contact"] = last[:10]
    finally:
        s.close()

    def days_since(day: str) -> int | None:
        if not day:
            return None
        try:
            return (today - _date.fromisoformat(day[:10])).days
        except ValueError:
            return None

    issues: list[dict] = []

    # ── 고객 노드 + 판정 ─────────────────────────────────────────────────────
    customers = []
    for k, c in C.items():
        inq, won = c["inquiries"], c["won"]
        conv = won / inq if inq else None
        idle = days_since(c["last_contact"])
        cooling = bool(inq and idle is not None and idle > COOLING_DAYS)
        flags = []
        if inq == 0:
            health = "idle"
        elif inq >= MIN_INQ_FOR_JUDGE and won == 0:
            health = "red"
            flags.append("no_win")
        elif inq >= MIN_INQ_FOR_JUDGE and conv is not None and conv < LOW_CONV:
            health = "amber"
            flags.append("low_conv")
        elif won > 0:
            health = "green"
        else:
            health = "early"
        if cooling:
            flags.append("cooling")
            if health == "green":
                health = "amber"
        mail = c["mail_in"] + c["mail_out"]
        if c["mail_out"] >= 5 and c["mail_in"] * 3 < c["mail_out"]:
            flags.append("one_way")
        top_reason = max(c["lost_reasons"].items(), key=lambda x: x[1])[0] if c["lost_reasons"] else ""
        node = {
            "id": "c:" + k, "kind": "customer", "name": cust_name[k],
            "inquiries": inq, "won": won, "lost": c["lost"], "conv": conv,
            "orders": c["orders"], "revenue_usd": round(c["revenue_usd"], 2),
            "mail_in": c["mail_in"], "mail_out": c["mail_out"], "mail": mail,
            "last_contact": c["last_contact"], "idle_days": idle,
            "health": health, "flags": flags, "cooling": cooling,
            "lost_reasons": c["lost_reasons"], "top_lost_reason": top_reason,
            "makers": c["makers"],
        }
        customers.append(node)
        sev_base = min(inq, 40)
        if "no_win" in flags:
            issues.append({"node": node["id"], "kind": "customer", "type": "no_win",
                           "severity": 60 + sev_base, "name": node["name"],
                           "inquiries": inq, "won": won, "reason": top_reason})
        elif "low_conv" in flags:
            issues.append({"node": node["id"], "kind": "customer", "type": "low_conv",
                           "severity": 40 + sev_base, "name": node["name"],
                           "inquiries": inq, "won": won, "reason": top_reason})
        if cooling:
            issues.append({"node": node["id"], "kind": "customer", "type": "cooling",
                           "severity": 35 + min(inq, 20) + min((idle or 0) // 30, 10),
                           "name": node["name"], "idle_days": idle,
                           "last_contact": c["last_contact"], "inquiries": inq})

    # ── 메이커 노드: 수요 vs 공급 ────────────────────────────────────────────
    suppliers: dict[str, set] = {}
    for vk, caps in ven_caps.items():
        for mk in caps:
            suppliers.setdefault(mk, set()).add(vk)
    responders: dict[str, set] = {}
    for vk, v in V.items():
        for mk in v["maker_answered"]:
            responders.setdefault(mk, set()).add(vk)
    # 수요가 없어도 공급 거래선이 붙은 메이커는 노드로 세운다(관계가 있으므로).
    for mk in suppliers:
        if mk in maker_names:
            mnode(mk, maker_names[mk], True)
    makers = []
    for key, m in M.items():
        # 공급처 = 명부에 '대 줄 수 있다'고 적힌 거래선 ∪ 실제로 그 메이커 견적을 보내 온 거래선.
        # 명부 태그가 비어 있어도 견적을 준 곳은 이미 공급처다.
        resp = sorted(responders.get(key, set()))
        sup = sorted(suppliers.get(key, set()) | set(resp))
        demand = m["demand"]
        flags = []
        if demand >= MIN_DEMAND and not sup:
            health = "red"
            flags.append("no_registry" if not m["registered"] else "no_supplier")
        elif demand >= MIN_DEMAND and len(sup) == 1:
            health = "amber"
            flags.append("single_supplier")
        elif demand >= MIN_DEMAND and sup and not resp:
            health = "amber"
            flags.append("no_response")
        elif demand == 0:
            health = "idle"
        else:
            health = "green" if sup else "early"
        node = {"id": "m:" + key, "kind": "maker", "name": m["label"],
                "registered": m["registered"], "demand": demand,
                "customers": sorted(m["customers"]), "suppliers": len(sup),
                "responders": len(resp), "health": health, "flags": flags}
        makers.append(node)
        if flags:
            base = {"no_registry": 55, "no_supplier": 70, "single_supplier": 45,
                    "no_response": 40}[flags[0]]
            issues.append({"node": node["id"], "kind": "maker", "type": flags[0],
                           "severity": base + min(demand * 4, 40), "name": node["name"],
                           "demand": demand, "suppliers": len(sup),
                           "customers": len(m["customers"])})

    # ── 거래선 노드 + 판정 ───────────────────────────────────────────────────
    vendors = []
    vm_edges = []
    for k, v in V.items():
        asked, answered = len(v["asked"]), len(v["answered"])
        rr = answered / asked if asked else None
        avg_days = (sum(v["reply_days"]) / len(v["reply_days"])) if v["reply_days"] else None
        flags = []
        if asked == 0:
            health = "idle"
        elif asked >= MIN_ASK_FOR_JUDGE and rr is not None and rr < LOW_REPLY:
            health = "red"
            flags.append("low_reply")
        elif (asked >= MIN_ASK_FOR_JUDGE and rr is not None and rr < MID_REPLY) or \
                (avg_days is not None and avg_days > SLOW_REPLY_DAYS and answered >= 2):
            health = "amber"
            flags.append("slow_reply" if (rr or 0) >= MID_REPLY else "mid_reply")
        elif answered > 0:
            health = "green"
        else:
            health = "early"
        if answered >= NO_PO_AFTER_QUOTES and v["pos"] == 0:
            flags.append("no_po")
            if health == "green":
                health = "amber"
        node = {
            "id": "v:" + k, "kind": "vendor", "name": ven_name[k],
            "asked": asked, "answered": answered, "reply_rate": rr,
            "avg_reply_days": round(avg_days, 1) if avg_days is not None else None,
            "pos": v["pos"], "po_usd": round(v["po_usd"], 2),
            "mail_in": v["mail_in"], "mail_out": v["mail_out"],
            "mail": v["mail_in"] + v["mail_out"],
            "last_contact": v["last_contact"], "idle_days": days_since(v["last_contact"]),
            "health": health, "flags": flags,
            "makers": sorted(ven_caps.get(k, set()) | set(v["maker_asked"])),
        }
        vendors.append(node)
        if "low_reply" in flags:
            issues.append({"node": node["id"], "kind": "vendor", "type": "low_reply",
                           "severity": 40 + min(asked * 3, 30), "name": node["name"],
                           "asked": asked, "answered": answered})
        elif "mid_reply" in flags or "slow_reply" in flags:
            issues.append({"node": node["id"], "kind": "vendor", "type": flags[0],
                           "severity": 20 + min(asked * 2, 20), "name": node["name"],
                           "asked": asked, "answered": answered,
                           "avg_reply_days": node["avg_reply_days"]})
        if "no_po" in flags:
            issues.append({"node": node["id"], "kind": "vendor", "type": "no_po",
                           "severity": 25 + min(answered * 2, 20), "name": node["name"],
                           "answered": answered})
        for mk in node["makers"]:
            a = len(v["maker_asked"].get(mk, ()))
            b = len(v["maker_answered"].get(mk, ()))
            vm_edges.append({"source": node["id"], "target": "m:" + mk,
                             "capable": mk in ven_caps.get(k, set()),
                             "asked": a, "answered": b})

    # ── 머리 지표 ────────────────────────────────────────────────────────────
    tot_inq = sum(c["inquiries"] for c in customers)
    tot_won = sum(c["won"] for c in customers)
    tot_ask = sum(v["asked"] for v in vendors)
    tot_ans = sum(v["answered"] for v in vendors)
    all_days = [d for v in V.values() for d in v["reply_days"]]
    demanded = [m for m in makers if m["demand"] > 0]
    covered = [m for m in demanded if m["suppliers"] > 0]
    multi = [m for m in demanded if m["suppliers"] >= 2]
    revs = sorted((c["revenue_usd"] for c in customers), reverse=True)
    tot_rev = sum(revs)
    kpi = {
        "customers_total": len(customers),
        "customers_active": sum(1 for c in customers if c["inquiries"] > 0),
        "inquiries": tot_inq, "won": tot_won,
        "conv": (tot_won / tot_inq) if tot_inq else None,
        "vendors_total": len(vendors),
        "vendors_active": sum(1 for v in vendors if v["asked"] > 0),
        "asked": tot_ask, "answered": tot_ans,
        "reply_rate": (tot_ans / tot_ask) if tot_ask else None,
        "avg_reply_days": round(sum(all_days) / len(all_days), 1) if all_days else None,
        "makers_demanded": len(demanded), "makers_covered": len(covered),
        "makers_multi": len(multi),
        "coverage": (len(covered) / len(demanded)) if demanded else None,
        "unregistered_makers": sum(1 for m in demanded if not m["registered"]),
        "revenue_usd": round(tot_rev, 2),
        "top3_share": (sum(revs[:3]) / tot_rev) if tot_rev else None,
    }
    issues.sort(key=lambda x: -x["severity"])
    return {
        "months": months, "cutoff": cutoff, "today": today.isoformat(), "fx": rate,
        "thresholds": T, "threshold_defaults": DEFAULT_THRESHOLDS,
        "kpi": kpi,
        "customers": customers, "vendors": vendors, "makers": makers,
        "vendor_maker": vm_edges, "issues": issues,
    }


# ── 판정 기준값(Thresholds) ──────────────────────────────────────────────────
@app.get("/api/admin/partners/network/thresholds", dependencies=[Depends(require_token)])
def partners_network_thresholds():
    s = get_session()
    try:
        return {"values": load_thresholds(s), "defaults": DEFAULT_THRESHOLDS,
                "ranges": _THRESHOLD_RANGE}
    finally:
        s.close()


@app.put("/api/admin/partners/network/thresholds", dependencies=[Depends(require_token)])
def save_partners_network_thresholds(body: dict = Body(...)):
    """저장값은 범위로 잘라 넣는다. 빈 몸통({})이면 기본값으로 되돌린 것과 같다."""
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="JSON object expected")
    values = _clean_thresholds(body)
    s = get_session()
    try:
        row = s.query(AppSetting).filter_by(key=THRESHOLD_KEY).first()
        if row:
            row.value = values
            row.updated_at = _dt.utcnow()
        else:
            s.add(AppSetting(key=THRESHOLD_KEY, value=values, updated_at=_dt.utcnow()))
        s.commit()
        return {"values": values}
    finally:
        s.close()


# ── 노드 하나의 월별 추이 ────────────────────────────────────────────────────
def _month_list(months: int, today: _date) -> list[str]:
    y, m = today.year, today.month
    out = []
    for _ in range(months):
        out.append(f"{y:04d}-{m:02d}")
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return out[::-1]


@app.get("/api/admin/partners/network/trend", dependencies=[Depends(require_token)])
@cached_aggregate()
def partners_network_trend(node: str, months: int = 12):
    """관계망 노드 하나(c:/v:/m: + 회사 키)의 달별 왕래 — 상세 패널의 추이 그래프.

    달은 이번 달을 끝으로 한 달력 달 months 개다(관계망의 '최근 N개월'과 같은 길이).
    날짜를 고르는 규칙은 관계망 집계와 같다(_day·_vrfq_sent_iso·_vquote_recv_iso)."""
    months = max(3, min(int(months or 12), 36))
    kind, _, key = (node or "").partition(":")
    if kind not in ("c", "v", "m") or not key:
        raise HTTPException(status_code=400, detail="bad node id")
    today = (_dt.utcnow() + _td(hours=9)).date()
    keys = _month_list(months, today)
    first = keys[0] + "-01"
    rows = {k: {"month": k} for k in keys}
    rate = usd_krw_rate() or 1.0

    def bump(day: str, field: str, n: float = 1):
        mk = (day or "")[:7]
        if mk in rows:
            rows[mk][field] = rows[mk].get(field, 0) + n

    def to_usd(amount: float, cur: str | None) -> float:
        return amount / rate if (cur or "USD").upper() == "KRW" else amount

    def mail(s, col, ids):
        for sent, direction in (s.query(EmailMessage.sent_at, EmailMessage.direction)
                                .filter(col.in_(ids), EmailMessage.sent_at >= first).all()):
            bump(sent, "mail_in" if direction == "in" else "mail_out")

    s = get_session()
    try:
        if kind == "c":
            fields = ["inquiries", "won", "lost", "mail_in", "mail_out", "revenue_usd"]
            ids = [i for i, n in s.query(Customer.id, Customer.name).all() if _ckey(n) == key]
            if ids:
                rfqs = s.query(RFQ.id, RFQ.date, RFQ.received_at, RFQ.created_at, RFQ.status).filter(
                    RFQ.customer_id.in_(ids)).all()
                rids = [r[0] for r in rfqs]
                ordered = ({r[0] for r in s.query(Order.rfq_id).filter(Order.rfq_id.in_(rids)).all()}
                           if rids else set())
                for rid, d, recv, created, status in rfqs:
                    day = _day(d, recv, created)
                    bump(day, "inquiries")
                    if rid in ordered:
                        bump(day, "won")
                    elif _enum_val(status) == "실주":
                        bump(day, "lost")
                for d, created, cur, items in s.query(
                        Order.date, Order.created_at, Order.currency, Order.items).filter(
                        Order.customer_id.in_(ids)).all():
                    bump(_day(d, created), "revenue_usd", to_usd(_total_amount(items), cur))
                mail(s, EmailMessage.customer_id, ids)
        elif kind == "v":
            fields = ["asked", "answered", "pos", "mail_in", "mail_out", "po_usd"]
            ids = [i for i, n in s.query(Vendor.id, Vendor.name).all() if _ckey(n) == key]
            if ids:
                vrs = s.query(VendorRFQ.id, VendorRFQ.rfq_id, VendorRFQ.sent_at,
                              VendorRFQ.created_at, VendorRFQ.sent_date).filter(
                    VendorRFQ.vendor_id.in_(ids)).all()
                quoted = ({q[0] for q in s.query(VendorQuote.vendor_rfq_id).filter(
                    VendorQuote.vendor_rfq_id.in_([v.id for v in vrs])).all()} if vrs else set())
                # 관계망과 같은 기준 — 건수가 아니라 프로젝트 수로 센다.
                asked: dict[str, set] = {}
                answered: dict[str, set] = {}
                for vr in vrs:
                    if not vr.rfq_id:
                        continue
                    mk = (_vrfq_sent_iso(vr) or _day(vr.sent_date))[:7]
                    asked.setdefault(mk, set()).add(vr.rfq_id)
                    if vr.id in quoted:
                        answered.setdefault(mk, set()).add(vr.rfq_id)
                for mk in rows:
                    rows[mk]["asked"] = len(asked.get(mk, ()))
                    rows[mk]["answered"] = len(answered.get(mk, ()))
                for d, created, cur, items in s.query(
                        PurchaseOrder.date, PurchaseOrder.created_at, PurchaseOrder.currency,
                        PurchaseOrder.items).filter(PurchaseOrder.vendor_id.in_(ids)).all():
                    day = _day(d, created)
                    bump(day, "pos")
                    bump(day, "po_usd", to_usd(_total_amount(items), cur))
                mail(s, EmailMessage.vendor_id, ids)
        else:
            fields = ["demand", "asked", "quoted"]
            names: dict[str, str] = {}
            for _mid, n in s.query(Maker.id, Maker.name).all():
                k = _mkey(n)
                if k:
                    names.setdefault(k, (n or "").strip())
            matcher = _MakerMatcher(names)

            def is_this(raw: str) -> bool:
                hit = matcher.match(raw)
                if hit:
                    return hit == key
                return key.startswith("raw:") and "raw:" + (_mkey(raw) or raw.lower()) == key

            lids_of: dict[int, set] = {}
            for rid, d, recv, created, items in s.query(
                    RFQ.id, RFQ.date, RFQ.received_at, RFQ.created_at, RFQ.items).all():
                mine = {lid or "_" for lid, raw in _item_makers(items) if is_this(raw)}
                if mine:
                    lids_of[rid] = mine
                    bump(_day(d, recv, created), "demand")
            if lids_of:
                vrs = s.query(VendorRFQ.id, VendorRFQ.rfq_id, VendorRFQ.sent_at,
                              VendorRFQ.created_at, VendorRFQ.sent_date, VendorRFQ.items).filter(
                    VendorRFQ.rfq_id.in_(list(lids_of))).all()
                quoted = ({q[0] for q in s.query(VendorQuote.vendor_rfq_id).filter(
                    VendorQuote.vendor_rfq_id.in_([v.id for v in vrs])).all()} if vrs else set())
                for vr in vrs:
                    lids = {str(it.get("lid") or "") for it in (vr.items or []) if isinstance(it, dict)}
                    lids.discard("")
                    want = lids_of[vr.rfq_id]
                    # 라인ID 로 그 메이커 줄을 물었는지 본다. 라인ID 가 없는 옛 RFQ 는 딜 단위로 센다.
                    if lids and want != {"_"} and not (lids & want):
                        continue
                    day = _vrfq_sent_iso(vr) or _day(vr.sent_date)
                    bump(day, "asked")
                    if vr.id in quoted:
                        bump(day, "quoted")
    finally:
        s.close()

    series = [{"month": k, **{f: round(rows[k].get(f, 0), 2) for f in fields}} for k in keys]
    return {"node": node, "kind": {"c": "customer", "v": "vendor", "m": "maker"}[kind],
            "fields": fields, "series": series}
