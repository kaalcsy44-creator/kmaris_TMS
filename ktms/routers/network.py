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
COOLING_DAYS = 90          # 마지막 접촉 후 이만큼 지나면 '식어 가는 관계'
MIN_INQ_FOR_JUDGE = 3      # 고객: 문의가 이만큼은 돼야 전환율로 판정한다(적으면 '이르다')
LOW_CONV = 0.15            # 고객: 문의→수주 이 아래면 저조
MIN_ASK_FOR_JUDGE = 3      # 거래선: 물어본 프로젝트가 이만큼은 돼야 회신률로 판정
LOW_REPLY = 0.4            # 거래선: 회신률 이 아래면 빨강
MID_REPLY = 0.7            # 거래선: 회신률 이 아래면 주황
SLOW_REPLY_DAYS = 5.0      # 거래선: 평균 회신 일수가 이보다 길면 주황
NO_PO_AFTER_QUOTES = 3     # 거래선: 견적은 이만큼 받았는데 발주 0 → 가격 경쟁력 확인
MIN_DEMAND = 2             # 메이커: 이만큼 찾았어야 공급 공백을 문제 삼는다


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
    cool_cut = (today - _td(days=COOLING_DAYS)).isoformat()
    rate = usd_krw_rate() or 1.0

    def usd(amount: float, cur: str | None) -> float:
        return amount / rate if (cur or "USD").upper() == "KRW" else amount

    s = get_session()
    try:
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
        "thresholds": {"cooling_days": COOLING_DAYS, "min_inq": MIN_INQ_FOR_JUDGE,
                       "low_conv": LOW_CONV, "min_ask": MIN_ASK_FOR_JUDGE,
                       "low_reply": LOW_REPLY, "mid_reply": MID_REPLY,
                       "slow_reply_days": SLOW_REPLY_DAYS, "min_demand": MIN_DEMAND},
        "kpi": kpi,
        "customers": customers, "vendors": vendors, "makers": makers,
        "vendor_maker": vm_edges, "issues": issues,
    }
