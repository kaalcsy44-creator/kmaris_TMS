"""공급역량 카탈로그(Supply Capability) 생성기 — 내부 마스터 xlsx + 고객용 PDF.

"우리가 무엇을 대 줄 수 있나"를 분류(대분류 13 > 부품 145) 축으로 세우고, 각 자리에
메이커를 근거 등급과 함께 앉힌다. 근거는 거래선과 실제로 오간 기록에서만 나온다:

    A  발주(P/O)·지급까지 간 거래
    B  공급사 견적을 받은 거래
    C  메일·RFQ 가 오간 거래
    D  명부에 등록만 됨  → 카탈로그에 싣지 않는다

메이커 등급은 세 갈래 근거 중 가장 높은 것이다:
  ① 딜 근거(supply_capability_data.DEAL_EVIDENCE) — 그 딜의 등급 그대로
  ② 거래선이 곧 그 메이커(vendors.maker_id) — 그 거래선 등급 그대로
  ③ 거래선이 '대 줄 수 있다'고 등록한 메이커(vendors.maker_ids) — 거래선 등급, 단 B 가
     상한이다. 그 거래선과 발주까지 갔어도 그 메이커 물건을 발주한 것은 아니기 때문이다.
  ④ 거래선과 오간 메일 제목·요약에 이름이 나온 메이커 — C

고객용 PDF 에는 거래선(공급사) 이름을 싣지 않는다 — 중개 구조에서 그 이름이 곧 우회로다.

    DATABASE_URL=postgresql://... python scripts/build_supply_capability.py [--out DIR]
"""
from __future__ import annotations

import argparse
import base64
import html
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

from sqlalchemy import create_engine, text

sys.path.insert(0, str(Path(__file__).resolve().parent))
import supply_capability_data as CUR  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
GRADES = "ABC"
# 고객용 표기. B 를 "Quoted" 라 적지 않는다 — B 의 대부분은 견적을 준 거래선이 '대 줄 수
# 있다'고 등록한 메이커라, 그 메이커 물건을 견적받은 것은 아니다.
LABEL = {"A": "Supplied", "B": "Available", "C": "On request"}


def best(*gs):
    gs = [g for g in gs if g]
    return min(gs) if gs else None


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip()).upper()


def ids(v):
    if not v:
        return []
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except Exception:
            return []
    return [int(x) for x in v if str(x).isdigit()]


# ── 읽기 ─────────────────────────────────────────────────────────────────────
def load(url: str) -> dict:
    e = create_engine(url)
    q = {
        "vendors": "select id,name,country,category_ids,maker_ids,maker_id from vendors",
        "makers": "select id,name,country,category_ids from makers",
        "cats": "select id,parent_id,level,code,name,tree_type,sort_order,active from item_categories",
        "mails": "select vendor_id,subject,summary from email_messages where vendor_id is not null",
        "vrfqs": "select rfq_id,vendor_id from vendor_rfqs",
        "vquotes": "select vr.rfq_id,vr.vendor_id from vendor_quotes q join vendor_rfqs vr on vr.id=q.vendor_rfq_id",
        "pos": "select p.vendor_id,o.rfq_id from purchase_orders p left join orders o on o.id=p.order_id",
        "aps": "select a.vendor_id,o.rfq_id from ap_records a left join orders o on o.id=a.order_id",
        "rfqs": "select id,rfq_no,project_title,work_type from rfqs",
    }
    with e.connect() as c:
        return {k: [dict(r) for r in c.execute(text(s)).mappings()] for k, s in q.items()}


# ── 계산 ─────────────────────────────────────────────────────────────────────
def compute(d: dict) -> dict:
    cats = {c["id"]: c for c in d["cats"] if c["active"] and c["code"]}
    by_code = {c["code"]: c for c in cats.values()}
    majors = sorted([c for c in cats.values() if c["level"] == 1],
                    key=lambda c: (c["tree_type"] == "service", c["sort_order"] or 0))  # 용역은 뒤로
    parts = {m["code"]: sorted([c for c in cats.values() if c["parent_id"] == m["id"]], key=lambda c: c["code"])
             for m in majors}

    # 거래선 등급 — 회사 단위(레코드 1 = 담당자 1 이라 같은 회사가 여러 줄)
    vname = {v["id"]: v["name"].strip() for v in d["vendors"]}
    vgrade = defaultdict(lambda: None)

    def up(vid, g):
        if vid in vname:
            n = vname[vid]
            vgrade[n] = best(vgrade[n], g)

    for r in d["pos"] + d["aps"]:
        up(r["vendor_id"], "A")
    for r in d["vquotes"]:
        up(r["vendor_id"], "B")
    for r in d["vrfqs"] + d["mails"]:
        up(r["vendor_id"], "C")

    # 딜 등급 — 그 딜에 붙은 거래선 가운데 가장 멀리 간 것
    deal_g = defaultdict(lambda: None)
    deal_vendors = defaultdict(dict)
    for src, g in (("pos", "A"), ("aps", "A"), ("vquotes", "B"), ("vrfqs", "C")):
        for r in d[src]:
            if r.get("rfq_id") is None or r["vendor_id"] not in vname:
                continue
            deal_g[r["rfq_id"]] = best(deal_g[r["rfq_id"]], g)
            n = vname[r["vendor_id"]]
            deal_vendors[r["rfq_id"]][n] = best(deal_vendors[r["rfq_id"]].get(n), g)

    # 메이커 명부 — 회사 이름 단위
    mk = {}
    rec2name = {}
    reg_alias = {norm(a): t for a, t in CUR.MAKER_ALIASES.items()}
    for m in d["makers"]:
        n = m["name"].strip()
        n = reg_alias.get(norm(n), n)        # 명부 안 중복(같은 회사 두 이름)을 한 줄로
        rec2name[m["id"]] = n
        e = mk.setdefault(n, {"name": n, "country": "", "cats": set(), "ev": [], "in_registry": True})
        e["country"] = e["country"] or (m["country"] or "")
        e["cats"] |= {cats[i]["code"] for i in ids(m["category_ids"]) if i in cats}
    for n, country in CUR.EXTRA_MAKERS.items():
        mk.setdefault(n, {"name": n, "country": country, "cats": set(), "ev": [], "in_registry": False})
    upper = {norm(n): n for n in mk}

    def canon(s):
        if not s:
            return None
        k = norm(s)
        alias = {norm(a): t for a, t in CUR.MAKER_ALIASES.items()}
        return upper.get(norm(alias.get(k, ""))) or upper.get(k)

    part_ev = defaultdict(list)          # 부품 코드 → [(등급, 딜 id, 메이커)]

    # ① 딜 근거
    rfq = {r["id"]: r for r in d["rfqs"]}
    for rid, rows in CUR.DEAL_EVIDENCE.items():
        g0 = deal_g[rid]
        for maker, codes, g_over in rows:
            g = g_over or g0
            if not g:
                continue
            codes = [c for c in codes if c in by_code]
            n = canon(maker) if maker else None
            if maker and not n:
                raise SystemExit(f"DEAL_EVIDENCE[{rid}]: unknown maker {maker!r}")
            for c in codes:
                part_ev[c].append((g, rid, n))
            if n:
                mk[n]["ev"].append({"grade": g, "src": "deal", "ref": rfq.get(rid, {}).get("rfq_no") or str(rid),
                                    "detail": rfq.get(rid, {}).get("project_title") or "", "codes": codes,
                                    "vendors": sorted(deal_vendors[rid])})

    # ②③ 거래선 등록
    seen = set()
    for v in d["vendors"]:
        n = vname[v["id"]]
        g = vgrade[n]
        if not g:
            continue
        if v["maker_id"] in rec2name and (n, v["maker_id"], "direct") not in seen:
            seen.add((n, v["maker_id"], "direct"))
            mk[rec2name[v["maker_id"]]]["ev"].append({"grade": g, "src": "direct", "ref": n, "detail": "maker is the supplier",
                                                     "codes": [], "vendors": [n]})
        for mid in ids(v["maker_ids"]):
            if mid in rec2name and (n, rec2name[mid]) not in seen:
                seen.add((n, rec2name[mid]))
                mk[rec2name[mid]]["ev"].append({"grade": max(g, "B"), "src": "carried", "ref": n,
                                                "detail": f"supplier carries this maker (supplier grade {g})",
                                                "codes": [], "vendors": [n]})

    # ④ 메일 언급 — 짧은 이름은 오검출이 잦아 5자 이상만 본다
    pats = []
    for n in mk:
        keys = {n} | {a for a, t in CUR.MAKER_ALIASES.items() if t == n}
        for k in keys:
            k2 = re.sub(r"\s*\(.*?\)", "", k).strip()
            if len(k2) >= 5:
                pats.append((re.compile(r"(?<![A-Za-z])" + re.escape(k2) + r"(?![A-Za-z])", re.I), n))
    mail_hits = defaultdict(set)
    for m in d["mails"]:
        t = f"{m['subject'] or ''} {m['summary'] or ''}"
        for p, n in pats:
            if p.search(t):
                mail_hits[n].add(vname.get(m["vendor_id"], "?"))
    for n, vs in mail_hits.items():
        mk[n]["ev"].append({"grade": "C", "src": "mail", "ref": f"{len(vs)} supplier(s)", "detail": "named in supplier mail",
                            "codes": [], "vendors": sorted(vs)})

    # 메이커 확정 — 등급·자리
    makers = []
    for n, e in mk.items():
        g = best(*[x["grade"] for x in e["ev"]])
        if not g:
            continue
        codes = set(e["cats"])
        proposed = set()
        for x in e["ev"]:
            codes |= set(x["codes"])
        if not codes and n in CUR.PROPOSED_TAGS:
            proposed = {c for c in CUR.PROPOSED_TAGS[n] if c in by_code}
            codes = set(proposed)
        # 부품 자리 등급 — 그 부품에서 딜 근거가 있으면 그것, 없으면 메이커 전체 등급(단 A 는 딜로만)
        place = {}
        for c in codes:
            dg = best(*[x["grade"] for x in e["ev"] if c in x["codes"]])
            place[c] = best(dg, max(g, "B"))   # 메이커 자체가 B 면 C 딜 자리도 B, A 는 딜로만
        makers.append({"name": n, "display": CUR.DISPLAY_NAMES.get(n, n), "country": e["country"], "grade": g,
                       "place": place, "proposed": sorted(proposed), "ev": e["ev"],
                       "in_registry": e["in_registry"]})
    makers.sort(key=lambda m: m["display"].lower())

    return {"majors": majors, "parts": parts, "by_code": by_code, "makers": makers, "part_ev": part_ev,
            "vgrade": dict(vgrade), "deal_g": dict(deal_g), "deal_vendors": deal_vendors, "rfq": rfq,
            "vendors": d["vendors"]}


# ── 고객용 문장 ───────────────────────────────────────────────────────────────
MAJOR_BLURB = {
    "EN": "Two- and four-stroke main & auxiliary engines — fuel injection, cylinder components, running gear, "
          "turbochargers, starting air, governors, generators and propulsion.",
    "AU": "Engine-room auxiliaries — pumps, air compressors, purifiers and filtration.",
    "HT": "Heat exchangers and coolers, boilers and burners, refrigeration, HVAC and fans.",
    "VP": "Valves and actuators, piping components, seals and packing, and hydraulic systems.",
    "DK": "Deck cranes and hoists, mooring and anchoring, steering gear, hatch covers and cargo pumps.",
    "EA": "Switchboards and breakers, motors and drives, automation and control, sensors, cables and lighting.",
    "EV": "Ballast water treatment, emission control, oily water separation, sewage and incineration.",
    "SF": "Fire fighting and detection, gas detection, lifeboats, liferafts, davits and personal life-saving appliances.",
    "NC": "Navigation, radio and communication equipment.",
    "AO": "Accommodation and outfitting — lifts, galley, furniture and interior equipment.",
    "HW": "Standard hardware — bolts, nuts, retaining rings, keys, pins and standard bearings.",
}
TR_POINTS = [
    "Consolidation of multi-supplier orders into a single shipment",
    "Export packing, commercial invoice, packing list and shipping advice",
    "Air and sea freight arranged to the vessel's next port or forwarder",
    "Delivery on board at Korean ports",
    "One contract, one invoice and one point of contact per order",
]
HOW_WE_SUPPLY = [
    ("Genuine & OEM", "Maker-genuine parts through maker channels and authorised distributors, and OEM parts "
                      "from the licensee or sub-supplier that builds them."),
    ("Quality equivalents", "Proven equivalent or reconditioned parts where genuine supply is slow, "
                            "discontinued or uneconomic — always offered as an option, never substituted silently."),
    ("One point of contact", "One inquiry covers engine, deck, electrical and safety items: we split the lines "
                             "across our network and return one consolidated quotation."),
    ("Technical service", "Service engineers coordinated for onboard attendance and workshop overhaul, "
                          "in Korea and abroad."),
]


def _e(s) -> str:
    return html.escape(str(s or ""))


def _chip(m: dict, g: str) -> str:
    cls = {"A": "a", "B": "b", "C": "c"}[g]
    mark = '<i class="tick">✔</i>' if g == "A" else ""
    return f'<span class="mk {cls}">{mark}{_e(m["display"])}</span>'


def _ordered(entries):
    return sorted(entries, key=lambda t: (t[1], t[0]["display"].lower()))


def build_html(m: dict, logo_uri: str, font_dir: Path, today: date) -> str:
    makers = m["makers"]
    placed = [x for x in makers if x["place"]]
    by_code = m["by_code"]
    at = defaultdict(list)                       # 코드 → [(메이커, 등급)]
    for x in placed:
        for c, g in x["place"].items():
            at[c].append((x, g))
    part_g = {c: best(*[e[0] for e in evs]) for c, evs in m["part_ev"].items()}
    majors = m["majors"]
    n_parts = sum(len(v) for v in m["parts"].values())
    n_suppliers = sum(1 for g in m["vgrade"].values() if g)
    n_supplied = sum(1 for g in part_g.values() if g == "A")
    n_quoted = sum(1 for g in part_g.values() if g == "B")

    def makers_of_major(code):
        codes = {code} | {p["code"] for p in m["parts"].get(code, [])}
        seen = {}
        for c in codes:
            for x, g in at.get(c, []):
                seen[x["name"]] = (x, best(seen.get(x["name"], (x, None))[1], g))
        return list(seen.values())

    def key_makers(code, k=7):
        ms = makers_of_major(code)
        ms.sort(key=lambda t: (t[1], -sum(1 for e in t[0]["ev"] if e["src"] == "deal"), t[0]["display"].lower()))
        return ms[:k]

    out = []
    w = out.append
    font = (font_dir / "NotoSansKR-Variable.ttf").as_uri()
    w(f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>K-MARIS Supply Capability</title>
<style>
@font-face {{ font-family: "Noto Sans KR"; src: url("{font}"); font-weight: 100 900; }}
@page {{ size: A4; margin: 16mm 14mm 16mm 14mm;
  @bottom-left {{ content: "K-MARIS Energy & Solutions  ·  Supply Capability  ·  {today:%B %Y}"; font: 7pt "Noto Sans KR"; color: #8a94a3; }}
  @bottom-right {{ content: counter(page); font: 7pt "Noto Sans KR"; color: #8a94a3; }} }}
@page cover {{ margin: 0; @bottom-left {{ content: none; }} @bottom-right {{ content: none; }} }}
:root {{ --navy:#0b1d3a; --blue:#0055a8; --lb:#eaf3ff; --line:#d8dee6; --mut:#6b7684; --soft:#f4f6f8; }}
* {{ box-sizing: border-box; }}
body {{ margin:0; font-family:"Noto Sans KR", sans-serif; color:#1d2530; font-size:8.6pt; line-height:1.45; background:#fff; }}
h1,h2,h3 {{ margin:0; color:var(--navy); }}
.cover {{ page: cover; height:297mm; position:relative; background:var(--navy); color:#fff; overflow:hidden; }}
.cover .band {{ position:absolute; left:0; right:0; top:0; height:112mm; background:#fff; }}
.cover .logo {{ position:absolute; left:20mm; top:38mm; width:92mm; mix-blend-mode:multiply; }}
.cover .t {{ position:absolute; left:22mm; top:132mm; right:22mm; }}
.cover .t .k {{ font-size:10pt; letter-spacing:.28em; color:#9fc3ee; font-weight:600; }}
.cover .t h1 {{ color:#fff; font-size:38pt; font-weight:800; line-height:1.1; margin-top:5mm; }}
.cover .t p {{ font-size:12pt; color:#c9d6e8; margin-top:6mm; max-width:150mm; }}
.cover .stats {{ position:absolute; left:22mm; right:22mm; top:222mm; display:flex; gap:10mm; }}
.cover .stats div {{ border-top:1.5px solid #3f6aa6; padding-top:3mm; flex:1; }}
.cover .stats b {{ display:block; font-size:22pt; font-weight:800; color:#fff; }}
.cover .stats span {{ font-size:8pt; color:#9fb3cf; }}
.cover .foot {{ position:absolute; left:22mm; right:22mm; bottom:18mm; font-size:8.5pt; color:#9fb3cf;
  display:flex; justify-content:space-between; }}
.cover .foot b {{ color:#fff; font-weight:600; }}
section {{ break-before: page; }}
section.flow {{ break-before: auto; margin-top: 6mm; }}
.kick {{ font-size:7.5pt; letter-spacing:.2em; color:var(--blue); font-weight:700; text-transform:uppercase; }}
.h {{ font-size:19pt; font-weight:800; margin:1.5mm 0 4mm; }}
.lead {{ font-size:10pt; color:#3a4452; max-width:170mm; margin:0 0 6mm; }}
.grid4 {{ display:grid; grid-template-columns:1fr 1fr; gap:4mm 6mm; margin-bottom:7mm; }}
.card {{ border:1px solid var(--line); border-left:3px solid var(--blue); padding:3.5mm 4mm; border-radius:1.5mm; }}
.card h3 {{ font-size:10pt; margin-bottom:1mm; }}
.card p {{ margin:0; color:#3a4452; }}
.legend {{ display:flex; gap:6mm; align-items:center; background:var(--soft); padding:3mm 4mm; border-radius:1.5mm;
  margin:0 0 6mm; font-size:8pt; color:#3a4452; flex-wrap:wrap; }}
.mk {{ display:inline-block; padding:.2mm 1.8mm; margin:.4mm .8mm .4mm 0; border-radius:1mm; white-space:nowrap; }}
.mk.a {{ background:var(--navy); color:#fff; font-weight:600; }}
.mk.b {{ background:var(--lb); color:#0b2c57; }}
.mk.c {{ background:#fff; color:#7c8693; border:1px dashed #c3cad3; }}
.tick {{ font-style:normal; margin-right:1mm; color:#7fd3a0; }}
.badge {{ display:inline-block; font-size:6.8pt; font-weight:700; padding:0 1.5mm; border-radius:.8mm; margin-left:1.5mm;
  vertical-align:1px; letter-spacing:.03em; }}
.badge.a {{ background:#e3f5ea; color:#146c3a; }}
.badge.b {{ background:#fff3dc; color:#8a5a00; }}
table {{ width:100%; border-collapse:collapse; }}
.mx th {{ text-align:left; font-size:7.2pt; color:var(--mut); font-weight:600; border-bottom:1.5px solid var(--navy);
  padding:1.6mm 2mm; text-transform:uppercase; letter-spacing:.05em; }}
.mx td {{ border-bottom:1px solid var(--line); padding:1.5mm 2mm; vertical-align:top; }}
.mx td.code {{ font-weight:800; color:var(--blue); width:11mm; }}
.mx td.num {{ text-align:right; width:15mm; font-variant-numeric:tabular-nums; }}
.mx td.cat b {{ color:var(--navy); }}
.sec-head {{ break-after:avoid; display:flex; align-items:flex-end; gap:5mm; border-bottom:2px solid var(--navy); padding-bottom:3mm; margin-bottom:3mm; }}
.sec-head .code {{ font-size:28pt; font-weight:800; color:var(--blue); line-height:1; }}
.sec-head h2 {{ font-size:17pt; font-weight:800; }}
.sec-head p {{ margin:1mm 0 0; color:#4a5563; font-size:9pt; }}
.across {{ background:var(--soft); border-radius:1.5mm; padding:2.5mm 3.5mm; margin:0 0 3mm; }}
.across .l {{ font-size:7pt; font-weight:700; color:var(--mut); text-transform:uppercase; letter-spacing:.08em; margin-bottom:1mm; }}
.parts td {{ border-bottom:1px solid var(--line); padding:1.6mm 1.5mm; vertical-align:top; }}
.parts tr {{ break-inside: avoid; }}
.parts td.pc {{ width:15mm; color:var(--mut); font-size:7.4pt; padding-top:2mm; }}
.parts td.pn {{ width:58mm; font-weight:600; color:var(--navy); }}
.parts td.none {{ color:#9aa3ae; font-style:italic; }}
.svc li {{ margin-bottom:2mm; }}
.rec td {{ border-bottom:1px solid var(--line); padding:2mm; vertical-align:top; }}
.idx {{ column-count:3; column-gap:7mm; font-size:8pt; }}
.idx div {{ break-inside:avoid; padding:.8mm 0; border-bottom:1px dotted var(--line); display:flex; justify-content:space-between; gap:2mm; }}
.idx .n.a {{ font-weight:700; color:var(--navy); }}
.idx .n.c {{ color:#7c8693; }}
.idx .cs {{ color:var(--blue); font-size:7pt; white-space:nowrap; }}
.letter {{ column-span:all; font-weight:800; color:var(--blue); font-size:10pt; margin:2mm 0 .5mm; }}
.note {{ color:var(--mut); font-size:7.4pt; margin-top:5mm; }}
.contact {{ display:grid; grid-template-columns:1fr 1fr; gap:6mm; margin-top:6mm; }}
.contact div {{ border-top:2px solid var(--navy); padding-top:3mm; }}
.contact b {{ display:block; color:var(--navy); font-size:9.5pt; margin-bottom:1mm; }}
</style></head><body>""")

    # 표지
    n_mk = len(placed)
    w(f"""<div class="cover"><div class="band"></div><img class="logo" src="{logo_uri}">
<div class="t"><div class="k">SUPPLY CAPABILITY</div><h1>Marine parts &amp; equipment,<br>by category.</h1>
<p>What K-MARIS can source and supply for your fleet — {len(majors)} equipment groups, {n_parts} part categories
and {n_mk} makers, backed by our partner network in Korea and across Asia.</p></div>
<div class="stats"><div><b>{n_parts}</b><span>part categories</span></div><div><b>{n_mk}</b><span>makers covered</span></div>
<div><b>{n_suppliers}</b><span>suppliers in our network</span></div><div><b>{n_supplied + n_quoted}</b><span>part categories with K-MARIS quotes or supplies</span></div></div>
<div class="foot"><span><b>K-MARIS Energy &amp; Solutions Co., Ltd.</b><br>Engineering Reliability. Supplying Performance.</span>
<span style="text-align:right">sales@k-maris.com<br>www.k-maris.com</span></div></div>""")

    # 공급 방식 + 읽는 법
    w('<section><div class="kick">How we supply</div><div class="h">One inquiry. The whole vessel.</div>')
    w('<p class="lead">K-MARIS Energy &amp; Solutions supplies spare parts, equipment and technical service to ship owners '
      'and managers. Each request is matched to the makers and partner suppliers that fit it, and returned as one '
      'consolidated quotation.</p><div class="grid4">')
    for t, p in HOW_WE_SUPPLY:
        w(f'<div class="card"><h3>{_e(t)}</h3><p>{_e(p)}</p></div>')
    w('</div><div class="kick">Reading this catalogue</div><div class="legend">'
      '<span><span class="mk a"><i class="tick">✔</i>Maker</span> supplied by K-MARIS</span>'
      '<span><span class="mk b">Maker</span> available through our partner network</span>'
      '<span><span class="mk c">Maker</span> available on request</span>'
      '<span>Part <span class="badge a">SUPPLIED</span> / <span class="badge b">QUOTED</span> recent K-MARIS track record</span></div>')

    # 개요 표
    w('<div class="kick">Capability overview</div><table class="mx"><thead><tr><th></th><th>Equipment group</th>'
      '<th style="text-align:right">Parts</th><th style="text-align:right">Makers</th><th>Key makers</th></tr></thead><tbody>')
    for mj in majors:
        c = mj["code"]
        np_ = len(m["parts"].get(c, []))
        nm = len(makers_of_major(c))
        if mj["tree_type"] == "service":
            km = '<span style="color:#4a5563">Service — see section</span>'
        else:
            km = "".join(_chip(x, g) for x, g in key_makers(c, 5)) or "—"
        w(f'<tr><td class="code">{c}</td><td class="cat"><b>{_e(mj["name"])}</b></td><td class="num">{np_ or "—"}</td>'
          f'<td class="num">{nm or "—"}</td><td>{km}</td></tr>')
    w("</tbody></table></section>")

    # 대분류별
    prev_small = False
    for mj in majors:
        c = mj["code"]
        if mj["tree_type"] == "service":
            continue
        small = len(m["parts"].get(c, [])) < 10 and prev_small     # 작은 분류는 앞 분류에 이어 싣는다
        prev_small = len(m["parts"].get(c, [])) < 10
        w(f'<section class="{"flow" if small else ""}"><div class="sec-head"><div class="code">{c}</div><div><h2>{_e(mj["name"])}</h2>'
          f'<p>{_e(MAJOR_BLURB.get(c, ""))}</p></div></div>')
        across = _ordered(at.get(c, []))
        if across:
            w('<div class="across"><div class="l">Makers across this group</div>'
              + "".join(_chip(x, g) for x, g in across) + "</div>")
        plist = m["parts"].get(c, [])
        if plist:
            w('<table class="parts"><tbody>')
            for p in plist:
                pg = part_g.get(p["code"])
                badge = {"A": '<span class="badge a">SUPPLIED</span>', "B": '<span class="badge b">QUOTED</span>'}.get(pg, "")
                chips = "".join(_chip(x, g) for x, g in _ordered(at.get(p["code"], [])))
                cell = f"<td>{chips}</td>" if chips else '<td class="none">Multi-brand sourcing on request</td>'
                w(f'<tr><td class="pc">{p["code"]}</td><td class="pn">{_e(p["name"])}{badge}</td>{cell}</tr>')
            w("</tbody></table>")
        w("</section>")

    # 서비스
    ts = next((x for x in majors if x["code"] == "TS"), None)
    tr = next((x for x in majors if x["code"] == "TR"), None)
    w('<section><div class="sec-head"><div class="code">TS</div><div><h2>'
      + _e(ts["name"] if ts else "Technical service coordination")
      + '</h2><p>Service engineers and workshops coordinated by K-MARIS — onboard attendance, troubleshooting '
        'and overhaul, in Korea and abroad.</p></div></div>')
    w('<table class="rec mx"><thead><tr><th>Recent service work</th><th style="width:28mm">Status</th></tr></thead><tbody>')
    recs = []
    for rid, txt in CUR.SERVICE_RECORDS.items():
        g = m["deal_g"].get(rid)
        if g:
            recs.append((g, txt))
    for g, txt in sorted(recs):
        st = {"A": '<span class="badge a">COMPLETED</span>', "B": '<span class="badge b">QUOTED</span>'}.get(g, "Inquiry handled")
        w(f"<tr><td>{_e(txt)}</td><td>{st}</td></tr>")
    w("</tbody></table>")
    w('<div style="height:8mm"></div><div class="sec-head"><div class="code">TR</div><div><h2>'
      + _e(tr["name"] if tr else "Trading & delivery support")
      + '</h2><p>From quotation to delivery on board — handled as one order.</p></div></div><ul class="svc">'
      + "".join(f"<li>{_e(t)}</li>" for t in TR_POINTS) + "</ul></section>")

    # 메이커 색인
    w('<section><div class="kick">Maker index</div><div class="h">Makers A–Z</div><div class="idx">')
    last = ""
    for x in sorted(placed, key=lambda x: x["display"].lower()):
        L = x["display"][0].upper()
        L = L if L.isalpha() else "#"
        if L != last:
            w(f'<div class="letter">{L}</div>')
            last = L
        groups = sorted({(by_code[c]["code"].split("-")[0]) for c in x["place"]})
        g = x["grade"]
        w(f'<div><span class="n {g.lower()}">{"✔ " if g == "A" else ""}{_e(x["display"])}</span>'
          f'<span class="cs">{" ".join(groups)}</span></div>')
    w('</div><p class="note">Maker names and trademarks belong to their respective owners and are used here only to '
      'identify the equipment for which K-MARIS can source parts. Unless stated otherwise, K-MARIS is not an authorised '
      'agent of the makers listed. Availability, origin and lead time are confirmed per inquiry.</p>')
    w('<div class="contact"><div><b>Send us your inquiry</b>sales@k-maris.com<br>+82-10-2957-2359<br>www.k-maris.com</div>'
      '<div><b>K-MARIS Energy &amp; Solutions Co., Ltd.</b>Rm S09, #018, 11F Metro Tower, 856 Tongil-ro,<br>'
      'Eunpyeong-gu, Seoul 03163, Republic of Korea</div></div></section>')
    w("</body></html>")
    return "".join(out)


def render_pdf(html_path: Path, pdf_path: Path) -> None:
    for exe in (r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"):
        if Path(exe).exists():
            subprocess.run([exe, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
                            "--allow-file-access-from-files", f"--print-to-pdf={pdf_path}", html_path.as_uri()],
                           check=True, capture_output=True, timeout=180)
            return
    raise SystemExit("Chrome/Edge not found — open the HTML and print to PDF")


# ── 내부 마스터 xlsx ──────────────────────────────────────────────────────────
def build_xlsx(m: dict, path: Path) -> None:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    sys.path.insert(0, str(ROOT / "ktms"))
    from services.doc_xlsx import _apply_noto_font  # type: ignore

    wb = Workbook()
    head = PatternFill("solid", fgColor="0B1D3A")
    fills = {"A": PatternFill("solid", fgColor="E3F5EA"), "B": PatternFill("solid", fgColor="EAF3FF"),
             "C": PatternFill("solid", fgColor="F4F6F8")}

    def sheet(title, cols, rows, widths, grade_col=None):
        ws = wb.create_sheet(title)
        ws.append(cols)
        for c in ws[1]:
            c.font = Font(bold=True, color="FFFFFF")
            c.fill = head
            c.alignment = Alignment(vertical="center", wrap_text=True)
        for r in rows:
            ws.append(r)
            if grade_col is not None and r[grade_col] in fills:
                for c in ws[ws.max_row]:
                    c.fill = fills[r[grade_col]]
        for i, wdt in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(i)].width = wdt
        for row in ws.iter_rows(min_row=2):
            for c in row:
                c.alignment = Alignment(vertical="top", wrap_text=True)
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = ws.dimensions
        return ws

    wb.remove(wb.active)
    by_code = m["by_code"]
    at = defaultdict(list)
    for x in m["makers"]:
        for c, g in x["place"].items():
            at[c].append((x, g))
    part_g = {c: best(*[e[0] for e in evs]) for c, evs in m["part_ev"].items()}

    ws = wb.create_sheet("기준")
    for r in [
        ["K-MARIS 공급역량 마스터 (내부용 — 공급사 이름 포함, 외부 배포 금지)"],
        [f"생성일 {date.today():%Y-%m-%d} · 원천: KTMS 라이브 DB + scripts/supply_capability_data.py"],
        [],
        ["등급", "기준", "고객용 표기"],
        ["A", "발주(P/O)·지급까지 간 거래. 메이커 A 는 그 메이커 물건이 실제 발주된 딜이 있을 때만.", "✔ Supplied"],
        ["B", "공급사 견적을 받은 거래 / 견적을 준 공급사가 '대 줄 수 있다'고 등록한 메이커(상한 B)", "Available"],
        ["C", "메일·RFQ 만 오간 공급사 / 공급사 메일에 이름이 나온 메이커", "On request(흐린 표시)"],
        ["D", "명부 등록만 — 카탈로그 제외", "—"],
        [],
        ["부품 실적 배지: 그 부품이 들어간 딜의 등급 — A=SUPPLIED, B=QUOTED (고객용 PDF)"],
        ["'분류 제안' 시트: 명부에 분류가 비어 있던 메이커에 붙인 추정 분류. 확정되면 KTMS 메이커 명부에 반영."],
    ]:
        ws.append(r)
    ws["A1"].font = Font(bold=True, size=13)
    ws.column_dimensions["A"].width = 10
    ws.column_dimensions["B"].width = 90
    ws.column_dimensions["C"].width = 22

    rows = []
    for mj in m["majors"]:
        for p in [mj] + m["parts"].get(mj["code"], []):
            ent = _ordered(at.get(p["code"], []))
            deals = sorted({m["rfq"].get(rid, {}).get("rfq_no") or str(rid) for g, rid, n in m["part_ev"].get(p["code"], [])})
            rows.append([mj["code"], p["code"], p["name"], "(대분류 전체)" if p is mj else "", part_g.get(p["code"]) or "",
                         ", ".join(x["display"] for x, g in ent if g == "A"),
                         ", ".join(x["display"] for x, g in ent if g == "B"),
                         ", ".join(x["display"] for x, g in ent if g == "C"),
                         len(ent), ", ".join(deals)])
    sheet("부품별", ["대분류", "코드", "부품", "비고", "부품 실적", "메이커 A", "메이커 B", "메이커 C", "메이커 수", "근거 딜"],
          rows, [7, 9, 30, 12, 9, 28, 60, 40, 9, 30], grade_col=4)

    rows = []
    for x in m["makers"]:
        srcs = sorted({e["src"] for e in x["ev"]})
        vend = sorted({v for e in x["ev"] for v in e["vendors"]})
        det = " / ".join(f'{e["grade"]} {e["src"]}:{e["ref"]}' for e in sorted(x["ev"], key=lambda e: e["grade"]))
        rows.append([x["display"], x["name"], x["grade"], ", ".join(srcs),
                     ", ".join(sorted(x["place"])) or "(분류 없음 — PDF 제외)",
                     "제안" if x["proposed"] else "", x["country"], ", ".join(vend), det[:1000]])
    sheet("메이커별", ["표시명", "명부명", "등급", "근거 종류", "배치 분류", "분류 출처", "국가(명부)", "공급사(내부)", "근거 상세"],
          rows, [28, 28, 6, 22, 40, 9, 16, 50, 80], grade_col=2)

    # 공급사
    cnt = defaultdict(lambda: defaultdict(int))
    vn = {v["id"]: v["name"].strip() for v in m["vendors"]}
    tags = defaultdict(lambda: [set(), set()])
    for v in m["vendors"]:
        tags[vn[v["id"]]][0] |= set(ids(v["category_ids"]))
        tags[vn[v["id"]]][1] |= set(ids(v["maker_ids"]))
    rows = []
    for n, g in sorted(m["vgrade"].items(), key=lambda t: (t[1] or "Z", t[0].lower())):
        if not g:
            continue
        deals = sorted(m["rfq"][rid]["rfq_no"] or str(rid) for rid, vs in m["deal_vendors"].items()
                       if n in vs and rid in m["rfq"])
        rows.append([n, g, len(tags[n][0]), len(tags[n][1]), len(deals), ", ".join(deals)[:600],
                     "분류·메이커 태그 보완 필요" if not tags[n][0] or not tags[n][1] else ""])
    sheet("공급사별(내부)", ["공급사", "등급", "분류 태그 수", "메이커 태그 수", "딜 수", "딜", "비고"],
          rows, [34, 6, 12, 13, 8, 60, 26], grade_col=1)

    rows = [[x["display"], x["name"], x["grade"], ", ".join(x["proposed"]),
             ", ".join(by_code[c]["name"] for c in x["proposed"]), "Y"] for x in m["makers"] if x["proposed"]]
    sheet("분류 제안(검토)", ["표시명", "명부명", "등급", "제안 코드", "제안 분류", "채택(Y/N)"],
          rows, [28, 30, 6, 22, 50, 10], grade_col=2)

    rows = [[x["display"], x["name"], x["grade"], ", ".join(sorted({v for e in x["ev"] for v in e["vendors"]}))]
            for x in m["makers"] if not x["place"]]
    sheet("미배치 메이커", ["표시명", "명부명", "등급", "공급사(내부)"], rows, [28, 30, 6, 60], grade_col=2)

    rows = []
    for rid, r in sorted(m["rfq"].items()):
        ev = CUR.DEAL_EVIDENCE.get(rid, [])
        rows.append([r["rfq_no"], r["project_title"], r["work_type"], m["deal_g"].get(rid) or "",
                     ", ".join(f"{k}:{v}" for k, v in sorted(m["deal_vendors"].get(rid, {}).items(), key=lambda t: t[1])),
                     "; ".join(f"{mk or '-'} → {','.join(cs)}{' (' + go + ')' if go else ''}" for mk, cs, go in ev)])
    sheet("딜 근거", ["딜", "제목", "구분", "딜 등급", "공급사:등급", "메이커 → 부품 매핑"],
          rows, [18, 44, 9, 8, 60, 80], grade_col=3)

    _apply_noto_font(wb)
    wb.save(path)


def report(m: dict) -> None:
    from collections import Counter
    print("makers included:", len(m["makers"]), Counter(x["grade"] for x in m["makers"]))
    for x in m["makers"]:
        print(f"{x['grade']} {x['display'][:34]:34} cats={','.join(sorted(x['place']))[:70] or '-- NONE --'}"
              f"  src={sorted({e['src'] for e in x['ev']})}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT))
    ap.add_argument("--report", action="store_true")
    a = ap.parse_args()
    model = compute(load(os.environ["DATABASE_URL"]))
    if a.report:
        report(model)
        sys.exit(0)
    out = Path(a.out)
    today = date.today()
    stamp = f"{today:%Y-%m}"
    from io import BytesIO
    from PIL import Image
    im = Image.open(ROOT / "logo_K-maris.png").convert("RGBA")
    im.thumbnail((900, 300))
    # 원본 바탕(옅은 회색)을 투명으로 — 표지 흰 띠 위에 회색 상자가 뜨지 않게
    im.putdata([(r, g, b, 0) if min(r, g, b) > 232 else (r, g, b, a) for r, g, b, a in im.get_flattened_data()])
    buf = BytesIO()
    im.save(buf, "PNG", optimize=True)
    logo = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    html_path = out / f"K-MARIS_Supply_Capability_{stamp}.html"
    html_path.write_text(build_html(model, logo, ROOT / "ktms" / "config" / "fonts", today), encoding="utf-8")
    pdf_path = html_path.with_suffix(".pdf")
    render_pdf(html_path, pdf_path)
    html_path.unlink()          # 글꼴을 로컬 경로로 물고 있어 다른 PC 에선 못 연다 — PDF 만 남긴다
    xlsx_path = out / f"KTMS_공급역량_마스터_{stamp}.xlsx"
    build_xlsx(model, xlsx_path)
    print(pdf_path, xlsx_path, sep="\n")
