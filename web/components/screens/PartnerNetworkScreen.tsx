"use client";

// Partners › Network — 고객 · K-MARIS · 거래선 · 메이커 네 줄 관계망.
//
// 옵시디언식 자유 배치(force graph)가 아니라 줄이 고정된 흐름도다: 회사가 150곳을 넘으면
// 자유 배치는 실뭉치가 되고, 열 때마다 자리가 바뀌어 지난달과 견줄 수 없다. 이 화면의
// 일은 "어디가 약한가"를 찾는 것이라 자리가 고정돼야 한다.
//
//   선 굵기 = 오가는 양(문의·메일·수주·금액 토글)   선 색 = 건강(규칙 판정, 서버가 정함)
//   점선    = 식어 가는 관계(마지막 접촉 90일+) 또는 명부상 공급 가능하나 물어본 적 없음
//
// 줄마다 상위 N 곳만 세우고 나머지는 "+n more" 로 접는다. 노드를 고르면 그 노드와 이어진
// 길(고객 → 찾은 메이커 → 그 메이커를 대 주는 거래선)만 밝히고, 접혀 있던 연결 상대도
// 함께 꺼내 세운다. 오른쪽 패널은 고른 것이 없으면 '개선 필요' 목록, 고르면 상세다.

import { useEffect, useMemo, useRef, useState } from "react";
import { fetchPartnerNetwork, closeReasonLabel } from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";
import type {
  NetCustomer,
  NetHealth,
  NetIssue,
  NetMaker,
  NetVendor,
  PartnerNetwork,
} from "@/lib/types";

type Metric = "activity" | "mail" | "orders" | "amount";
type Node = NetCustomer | NetVendor | NetMaker;

const METRICS: { key: Metric; label: string; hint: string }[] = [
  { key: "activity", label: "Inquiries", hint: "Customer inquiries · projects asked to vendor" },
  { key: "mail", label: "Mail", hint: "Mails exchanged (in + out)" },
  { key: "orders", label: "Orders", hint: "Customer P/Os won · vendor P/Os issued" },
  { key: "amount", label: "Amount", hint: "Customer orders · vendor P/Os (USD)" },
];

const PERIODS = [3, 6, 12, 24];

const HEALTH_COLOR: Record<NetHealth, string> = {
  green: "#16a34a",
  amber: "#e08a00",
  red: "#dc2626",
  early: "#8aa0bd",
  idle: "#c9d3e0",
};
const HEALTH_LABEL: Record<NetHealth, string> = {
  green: "Healthy",
  amber: "Needs attention",
  red: "Weak",
  early: "Too early to judge",
  idle: "No activity in period",
};

// 노드 치수
const ROW = 30;
const BOX_H = 22;
const COL_W = { c: 200, k: 104, v: 200, m: 196 };
const LIMIT = { c: 14, v: 16, m: 16 };
const TOP = 34; // 열 제목 자리

const usd = (n: number) =>
  "$" + Math.round(n).toLocaleString("en-US");
const pct = (n: number | null | undefined) =>
  n == null ? "—" : `${Math.round(n * 100)}%`;
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function custValue(c: NetCustomer, m: Metric) {
  return m === "activity" ? c.inquiries : m === "mail" ? c.mail : m === "orders" ? c.won : c.revenue_usd;
}
function vendValue(v: NetVendor, m: Metric) {
  return m === "activity" ? v.asked : m === "mail" ? v.mail : m === "orders" ? v.pos : v.po_usd;
}
function valueText(n: number, m: Metric) {
  return m === "amount" ? (n ? usd(n) : "") : n ? String(n) : "";
}

const isWeak = (h: NetHealth) => h === "red" || h === "amber";

// ── 개선 필요 문구 ──────────────────────────────────────────────────────────
function issueText(i: NetIssue): { what: string; todo: string } {
  const reason = i.reason ? ` · mostly “${closeReasonLabel(i.reason).split(" — ")[0]}”` : "";
  switch (i.type) {
    case "no_win":
      return { what: `${i.inquiries} inquiries, none won${reason}`, todo: "Review lost deals — price, lead time or sourcing?" };
    case "low_conv":
      return { what: `${i.won}/${i.inquiries} won (${pct((i.won ?? 0) / (i.inquiries || 1))})${reason}`, todo: "Find why most inquiries don't convert" };
    case "cooling":
      return { what: `No contact for ${i.idle_days} days (last ${i.last_contact})`, todo: "Send a follow-up / promo mail" };
    case "low_reply":
    case "mid_reply":
      return { what: `Quoted back ${i.answered}/${i.asked} projects (${pct((i.answered ?? 0) / (i.asked || 1))})`, todo: "Secure an alternative vendor for these items" };
    case "slow_reply":
      return { what: `Slow reply — avg ${i.avg_reply_days} days`, todo: "Agree a reply-time target or add a backup vendor" };
    case "no_po":
      return { what: `${i.answered} quotes received, no P/O yet`, todo: "Check price competitiveness" };
    case "no_supplier":
      return { what: `Requested in ${i.demand} deals — no vendor supplies it`, todo: "Find & register vendors for this maker" };
    case "no_registry":
      return { what: `Requested in ${i.demand} deals — not in Maker registry`, todo: "Register the maker and find vendors" };
    case "single_supplier":
      return { what: `Requested in ${i.demand} deals — only 1 supplier`, todo: "Add a second supplier (single dependency)" };
    case "no_response":
      return { what: `Requested in ${i.demand} deals — ${i.suppliers} suppliers, none quoted back`, todo: "Ask suppliers directly or find new ones" };
    default:
      return { what: i.type, todo: "" };
  }
}

const KIND_LABEL = { customer: "Customer", vendor: "Vendor", maker: "Maker" } as const;

function partnerHref(n: Node) {
  const side = n.kind === "customer" ? "customers" : n.kind === "vendor" ? "vendors" : "makers";
  if (n.kind === "maker" && !n.registered) return "/partners?side=makers";
  return `/partners?side=${side}&company=${encodeURIComponent(n.name)}`;
}

// ── 화면 ───────────────────────────────────────────────────────────────────
export default function PartnerNetworkScreen() {
  const [months, setMonths] = useState(12);
  const [metric, setMetric] = useState<Metric>("activity");
  const [weakOnly, setWeakOnly] = useState(false);
  const [expand, setExpand] = useState({ c: false, v: false, m: false });
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [showAllIssues, setShowAllIssues] = useState(false);
  const { data, error, loading } = useCachedData<PartnerNetwork>(
    `partners:network:${months}`,
    () => fetchPartnerNetwork(months),
    60_000,
  );

  // 그래프 폭 — 패널 폭을 따라간다(최소 폭 아래면 가로 스크롤).
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(900, el.clientWidth - 34)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);

  const byId = useMemo(() => {
    const m = new Map<string, Node>();
    if (!data) return m;
    for (const n of [...data.customers, ...data.vendors, ...data.makers]) m.set(n.id, n);
    return m;
  }, [data]);

  // 고른 노드와 이어진 노드 집합(고객 → 메이커 → 거래선, 또는 그 반대).
  const related = useMemo(() => {
    if (!data || !sel) return null;
    const out = new Set<string>([sel, "k"]);
    const n = byId.get(sel);
    if (!n) return null;
    const vendorsOf = (mk: string) => data.vendors.filter((v) => v.makers.includes(mk));
    if (n.kind === "customer") {
      for (const mk of Object.keys(n.makers)) {
        out.add("m:" + mk);
        vendorsOf(mk).forEach((v) => out.add(v.id));
      }
    } else if (n.kind === "vendor") {
      for (const mk of n.makers) out.add("m:" + mk);
      for (const c of data.customers)
        if (Object.keys(c.makers).some((mk) => n.makers.includes(mk))) out.add(c.id);
    } else {
      const mk = n.id.slice(2);
      vendorsOf(mk).forEach((v) => out.add(v.id));
      n.customers.forEach((ck) => out.add("c:" + ck));
    }
    return out;
  }, [data, sel, byId]);

  const layout = useMemo(() => {
    if (!data) return null;
    const pick = <T extends Node>(
      list: T[], score: (x: T) => number, limit: number, open: boolean,
    ) => {
      let pool = list.filter((x) => x.health !== "idle" || (related?.has(x.id) ?? false));
      if (weakOnly) pool = pool.filter((x) => isWeak(x.health) || (related?.has(x.id) ?? false));
      pool = [...pool].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
      let shown = open ? pool : pool.slice(0, limit);
      if (related) {
        const extra = pool.filter((x) => related.has(x.id) && !shown.includes(x));
        shown = [...shown, ...extra];
      }
      return { shown, hidden: pool.length - shown.length, idle: list.filter((x) => x.health === "idle").length };
    };
    const cs = pick(data.customers, (c) => custValue(c, metric) * 1000 + c.inquiries, LIMIT.c, expand.c);
    const vs = pick(data.vendors, (v) => vendValue(v, metric) * 1000 + v.asked, LIMIT.v, expand.v);
    const ms = pick(data.makers, (m) => m.demand * 1000 + m.suppliers, LIMIT.m, expand.m);

    const W = width;
    const xC = 0;
    const xM = W - COL_W.m;
    const xK = Math.round(W * 0.3);
    const xV = Math.round(W * 0.53);
    const rows = (n: number, more: number) => n + (more > 0 ? 1 : 0);
    const H = TOP + Math.max(rows(cs.shown.length, cs.hidden), rows(vs.shown.length, vs.hidden),
      rows(ms.shown.length, ms.hidden), 6) * ROW + 10;
    const pos = new Map<string, { x: number; y: number; w: number }>();
    const place = (list: Node[], x: number, w: number) =>
      list.forEach((n, i) => pos.set(n.id, { x, y: TOP + i * ROW, w }));
    place(cs.shown, xC, COL_W.c);
    place(vs.shown, xV, COL_W.v);
    place(ms.shown, xM, COL_W.m);
    const kTop = TOP;
    const kH = H - TOP - 14;
    return { cs, vs, ms, pos, W, H, xC, xK, xV, xM, kTop, kH };
  }, [data, metric, weakOnly, expand, width, related]);

  if (error) return <div className="state error">Failed to load: {error.message}</div>;
  if (!data || !layout) return <div className="state">{loading ? "Loading network…" : "No data"}</div>;

  const { kpi } = data;
  const { cs, vs, ms, pos, W, H, xK, xV, kTop, kH } = layout;

  const maxC = Math.max(1, ...cs.shown.map((c) => custValue(c, metric)));
  const maxV = Math.max(1, ...vs.shown.map((v) => vendValue(v, metric)));
  const vmShown = data.vendor_maker.filter((e) => pos.has(e.source) && pos.has(e.target));
  const maxVM = Math.max(1, ...vmShown.map((e) => e.asked));
  const stroke = (v: number, max: number) => (v > 0 ? 1.2 + 7 * Math.sqrt(v / max) : 1);

  const dim = (id: string) => (related ? !related.has(id) : hover ? hover !== id : false);
  const edgeOpacity = (a: string, b: string) => {
    if (related) return related.has(a) && related.has(b) ? 0.9 : 0.06;
    if (hover) return hover === a || hover === b ? 0.95 : 0.18;
    return 0.55;
  };

  // K-MARIS 상자 왼·오른쪽 위의 접점 — 상대 노드의 높이를 상자 높이에 비례해 옮겨,
  // 선이 한 점으로 모이지 않고 부채꼴로 펴지게 한다.
  const colH = (n: number) => Math.max(ROW, n * ROW);
  const kY = (y: number, n: number) => kTop + 8 + ((y - TOP) / colH(n)) * (kH - 16);
  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = (x2 - x1) * 0.5;
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  };

  const issues = data.issues;
  const issueList = showAllIssues ? issues : issues.slice(0, 12);
  const selNode = sel ? byId.get(sel) : undefined;

  const box = (n: Node, right: string) => {
    const p = pos.get(n.id)!;
    const col = HEALTH_COLOR[n.health];
    const unreg = n.kind === "maker" && !n.registered;
    return (
      <g
        key={n.id}
        className={`net-node${sel === n.id ? " on" : ""}`}
        transform={`translate(${p.x},${p.y})`}
        opacity={dim(n.id) ? 0.28 : 1}
        onMouseEnter={() => setHover(n.id)}
        onMouseLeave={() => setHover(null)}
        onClick={() => setSel(sel === n.id ? null : n.id)}
      >
        <title>{`${n.name} — ${HEALTH_LABEL[n.health]}`}</title>
        <rect width={p.w} height={BOX_H} rx={5} className="net-box"
          strokeDasharray={unreg ? "3 2" : undefined} />
        <rect width={4} height={BOX_H} rx={2} fill={col} />
        <text x={10} y={15} className="net-name">{trunc(n.name, n.kind === "maker" ? 17 : 23)}</text>
        {right && <text x={p.w - 7} y={15} textAnchor="end" className="net-val">{right}</text>}
        {isWeak(n.health) && (
          <circle cx={p.w - 2} cy={2} r={4} fill={col} stroke="#fff" strokeWidth={1.5} />
        )}
      </g>
    );
  };

  const moreRow = (key: "c" | "v" | "m", x: number, w: number, n: number, hidden: number) =>
    hidden > 0 || expand[key] ? (
      <g key={"more-" + key} className="net-more" transform={`translate(${x},${TOP + n * ROW})`}
        onClick={() => setExpand((e) => ({ ...e, [key]: !e[key] }))}>
        <rect width={w} height={BOX_H} rx={5} />
        <text x={w / 2} y={15} textAnchor="middle">
          {expand[key] ? "Show fewer" : `+ ${hidden} more`}
        </text>
      </g>
    ) : null;

  return (
    <div className="net-screen">
      {/* 머리 지표 */}
      <div className="kpi-row net-kpis">
        <Kpi label="Active customers" value={`${kpi.customers_active} / ${kpi.customers_total}`}
          sub={`sent at least one inquiry in ${data.months} mo`} />
        <Kpi label="Inquiry → Order" value={pct(kpi.conv)} sub={`${kpi.won} of ${kpi.inquiries} inquiries won`}
          tone={kpi.conv != null && kpi.conv < 0.15 ? "amber" : undefined} />
        <Kpi label="Vendor quote-back" value={pct(kpi.reply_rate)}
          sub={`${kpi.answered}/${kpi.asked} projects${kpi.avg_reply_days != null ? ` · avg ${kpi.avg_reply_days} d` : ""}`}
          tone={kpi.reply_rate != null && kpi.reply_rate < 0.5 ? "amber" : undefined} />
        <Kpi label="Maker coverage" value={pct(kpi.coverage)}
          sub={`${kpi.makers_covered}/${kpi.makers_demanded} requested makers have a supplier · ${kpi.unregistered_makers} unregistered`}
          tone={kpi.coverage != null && kpi.coverage < 0.7 ? "amber" : undefined} />
        <Kpi label="Top-3 customer share" value={pct(kpi.top3_share)}
          sub={`of ${usd(kpi.revenue_usd)} orders in ${data.months} mo`}
          tone={kpi.top3_share != null && kpi.top3_share > 0.7 ? "amber" : undefined} />
      </div>

      {/* 도구 줄 */}
      <div className="net-toolbar">
        <div className="net-seg" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button key={p} className={months === p ? "on" : ""} onClick={() => { setMonths(p); setSel(null); }}>
              {p} mo
            </button>
          ))}
        </div>
        <div className="net-seg" role="group" aria-label="Line thickness">
          <span className="net-seg-lbl">Thickness</span>
          {METRICS.map((m) => (
            <button key={m.key} title={m.hint} className={metric === m.key ? "on" : ""} onClick={() => setMetric(m.key)}>
              {m.label}
            </button>
          ))}
        </div>
        <label className="net-check">
          <input type="checkbox" checked={weakOnly} onChange={(e) => setWeakOnly(e.target.checked)} />
          Weak spots only
        </label>
        <div className="net-legend">
          {(["green", "amber", "red", "early"] as NetHealth[]).map((h) => (
            <span key={h}><i style={{ background: HEALTH_COLOR[h] }} />{HEALTH_LABEL[h]}</span>
          ))}
          <span><i className="dash" />No contact {data.thresholds.cooling_days}d+ / never asked</span>
        </div>
      </div>

      <div className="net-body">
        {/* 그래프 */}
        <div className="panel net-graph" ref={wrapRef} onClick={(e) => { if (e.target === e.currentTarget) setSel(null); }}>
          <svg width={W} height={H} className="net-svg"
            onClick={(e) => { if ((e.target as Element).tagName === "svg") setSel(null); }}>
            {/* 열 제목 */}
            <text x={0} y={16} className="net-col">CUSTOMER <tspan>{cs.shown.length + cs.hidden}</tspan></text>
            <text x={xK} y={16} className="net-col">K-MARIS</text>
            <text x={xV} y={16} className="net-col">VENDOR <tspan>{vs.shown.length + vs.hidden}</tspan></text>
            <text x={W - COL_W.m} y={16} className="net-col">MAKER <tspan>{ms.shown.length + ms.hidden}</tspan></text>

            {/* 고객 → K-MARIS */}
            {cs.shown.map((c) => {
              const p = pos.get(c.id)!;
              const v = custValue(c, metric);
              return (
                <path key={"e" + c.id} d={curve(p.x + p.w, p.y + BOX_H / 2, xK, kY(p.y, cs.shown.length))}
                  stroke={HEALTH_COLOR[c.health]} strokeWidth={stroke(v, maxC)} fill="none"
                  strokeDasharray={c.cooling ? "5 4" : undefined} opacity={edgeOpacity(c.id, "k")} />
              );
            })}
            {/* K-MARIS → 거래선 */}
            {vs.shown.map((vn) => {
              const p = pos.get(vn.id)!;
              const v = vendValue(vn, metric);
              const cool = (vn.idle_days ?? 0) > data.thresholds.cooling_days && vn.asked > 0;
              return (
                <path key={"e" + vn.id} d={curve(xK + COL_W.k, kY(p.y, vs.shown.length), p.x, p.y + BOX_H / 2)}
                  stroke={HEALTH_COLOR[vn.health]} strokeWidth={stroke(v, maxV)} fill="none"
                  strokeDasharray={cool ? "5 4" : undefined} opacity={edgeOpacity("k", vn.id)} />
              );
            })}
            {/* 거래선 → 메이커 */}
            {vmShown.map((e) => {
              const a = pos.get(e.source)!;
              const b = pos.get(e.target)!;
              const col = e.answered > 0 ? HEALTH_COLOR.green : e.asked > 0 ? HEALTH_COLOR.red : HEALTH_COLOR.idle;
              return (
                <path key={e.source + e.target} d={curve(a.x + a.w, a.y + BOX_H / 2, b.x, b.y + BOX_H / 2)}
                  stroke={col} strokeWidth={stroke(e.asked, maxVM)} fill="none"
                  strokeDasharray={e.asked === 0 ? "3 3" : undefined}
                  opacity={edgeOpacity(e.source, e.target) * (related || hover ? 1 : 0.6) * (e.asked === 0 ? 0.8 : 1)}>
                  <title>{`${byId.get(e.source)?.name} → ${byId.get(e.target)?.name}: asked ${e.asked}, quoted ${e.answered}${e.capable ? " · listed as supplier" : ""}`}</title>
                </path>
              );
            })}

            {/* K-MARIS */}
            <g className="net-hub" onClick={() => setSel(null)}>
              <rect x={xK} y={kTop} width={COL_W.k} height={kH} rx={10} />
              {/* 열이 길어져도 첫 화면 안에 보이도록 글자는 위쪽 200px 안에 둔다. */}
              <text x={xK + COL_W.k / 2} y={kTop + Math.min(kH / 2, 200)} textAnchor="middle" className="net-hub-t">K-MARIS</text>
              <text x={xK + COL_W.k / 2} y={kTop + Math.min(kH / 2, 200) + 18} textAnchor="middle" className="net-hub-s">
                {kpi.inquiries} inq · {kpi.asked} RFQs
              </text>
            </g>

            {/* 노드 */}
            {cs.shown.map((c) => box(c, valueText(custValue(c, metric), metric)))}
            {vs.shown.map((v) => box(v, valueText(vendValue(v, metric), metric)))}
            {ms.shown.map((m) => box(m, m.demand ? `${m.demand}×·${m.suppliers}v` : `${m.suppliers}v`))}
            {moreRow("c", 0, COL_W.c, cs.shown.length, cs.hidden)}
            {moreRow("v", xV, COL_W.v, vs.shown.length, vs.hidden)}
            {moreRow("m", W - COL_W.m, COL_W.m, ms.shown.length, ms.hidden)}
          </svg>
          <div className="net-foot">
            Maker label: <b>n×</b> = requested in n deals · <b>nv</b> = vendors that supply it. Idle partners
            (no activity in {data.months} mo) are hidden: {cs.idle} customers · {vs.idle} vendors · {ms.idle} makers.
            Click a box to trace its chain.
          </div>
        </div>

        {/* 오른쪽 패널 */}
        <aside className="panel net-side">
          {selNode ? (
            <NodeDetail n={selNode} data={data} onClose={() => setSel(null)} />
          ) : (
            <>
              <div className="net-side-h">
                Needs improvement <span className="net-count">{issues.length}</span>
              </div>
              {issues.length === 0 && <div className="net-empty">No weak spots found in this period.</div>}
              <ol className="net-issues">
                {issueList.map((i) => {
                  const t = issueText(i);
                  const n = byId.get(i.node);
                  return (
                    <li key={i.node + i.type} onClick={() => setSel(i.node)}>
                      <span className="net-dot" style={{ background: HEALTH_COLOR[n?.health ?? "amber"] }} />
                      <div>
                        <div className="net-i-name">
                          {i.name} <span className="net-kind">{KIND_LABEL[i.kind]}</span>
                        </div>
                        <div className="net-i-what">{t.what}</div>
                        <div className="net-i-todo">→ {t.todo}</div>
                      </div>
                    </li>
                  );
                })}
              </ol>
              {issues.length > 12 && (
                <button className="btn sm net-all" onClick={() => setShowAllIssues((v) => !v)}>
                  {showAllIssues ? "Show top 12" : `Show all ${issues.length}`}
                </button>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "amber" }) {
  return (
    <div className={`kpi-card${tone ? " net-kpi-" + tone : ""}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{sub}</div>
    </div>
  );
}

const FLAG_TEXT: Record<string, string> = {
  no_win: "Inquiries but no order won",
  low_conv: "Low inquiry → order conversion",
  cooling: "Relationship cooling — no recent contact",
  one_way: "Mostly one-way mail (we send, they rarely reply)",
  low_reply: "Low quote-back rate",
  mid_reply: "Quote-back rate below target",
  slow_reply: "Slow to quote back",
  no_po: "Quotes received but never ordered",
  no_supplier: "No vendor supplies this maker",
  no_registry: "Not in Maker registry — no supplier",
  single_supplier: "Only one supplier (single dependency)",
  no_response: "Suppliers exist but none quoted back",
};

function NodeDetail({ n, data, onClose }: { n: Node; data: PartnerNetwork; onClose: () => void }) {
  const rows: [string, string][] = [];
  if (n.kind === "customer") {
    rows.push(
      ["Inquiries", String(n.inquiries)],
      ["Won / Lost", `${n.won} / ${n.lost}`],
      ["Conversion", pct(n.conv)],
      ["Orders (USD)", n.revenue_usd ? usd(n.revenue_usd) : "—"],
      ["Mail in / out", `${n.mail_in} / ${n.mail_out}`],
      ["Last contact", n.last_contact ? `${n.last_contact} (${n.idle_days} d ago)` : "—"],
    );
  } else if (n.kind === "vendor") {
    rows.push(
      ["Projects asked", String(n.asked)],
      ["Quoted back", `${n.answered} (${pct(n.reply_rate)})`],
      ["Avg reply", n.avg_reply_days != null ? `${n.avg_reply_days} days` : "—"],
      ["P/Os issued", `${n.pos}${n.po_usd ? ` · ${usd(n.po_usd)}` : ""}`],
      ["Mail in / out", `${n.mail_in} / ${n.mail_out}`],
      ["Last contact", n.last_contact ? `${n.last_contact} (${n.idle_days} d ago)` : "—"],
    );
  } else {
    rows.push(
      ["In registry", n.registered ? "Yes" : "No"],
      ["Requested in", `${n.demand} deals`],
      ["Requesting customers", String(n.customers.length)],
      ["Suppliers", String(n.suppliers)],
      ["Quoted back", `${n.responders} vendors`],
    );
  }
  const reasons = n.kind === "customer" ? Object.entries(n.lost_reasons).sort((a, b) => b[1] - a[1]) : [];
  const makerNames = (keys: string[]) =>
    keys.map((k) => data.makers.find((m) => m.id === "m:" + k)?.name).filter(Boolean).slice(0, 10) as string[];
  const linkedMakers =
    n.kind === "customer" ? makerNames(Object.keys(n.makers)) : n.kind === "vendor" ? makerNames(n.makers) : [];
  const supplierNames =
    n.kind === "maker" ? data.vendors.filter((v) => v.makers.includes(n.id.slice(2))).map((v) => v.name).slice(0, 10) : [];

  return (
    <div className="net-detail">
      <div className="net-side-h">
        <span className="net-dot" style={{ background: HEALTH_COLOR[n.health] }} />
        {n.name}
        <button className="net-x" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="net-d-sub">{KIND_LABEL[n.kind]} · {HEALTH_LABEL[n.health]}</div>
      <table className="net-d-tbl">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}><th>{k}</th><td>{v}</td></tr>
          ))}
        </tbody>
      </table>
      {n.flags.length > 0 && (
        <ul className="net-flags">
          {n.flags.map((f) => <li key={f}>{FLAG_TEXT[f] ?? f}</li>)}
        </ul>
      )}
      {reasons.length > 0 && (
        <div className="net-d-block">
          <div className="net-d-h">Lost reasons</div>
          {reasons.map(([code, cnt]) => (
            <div key={code} className="net-d-line">{closeReasonLabel(code).split(" — ")[0]} <b>{cnt}</b></div>
          ))}
        </div>
      )}
      {linkedMakers.length > 0 && (
        <div className="net-d-block">
          <div className="net-d-h">{n.kind === "customer" ? "Makers requested" : "Makers handled"}</div>
          <div className="net-d-tags">{linkedMakers.map((m) => <span key={m}>{m}</span>)}</div>
        </div>
      )}
      {n.kind === "maker" && (
        <div className="net-d-block">
          <div className="net-d-h">Suppliers</div>
          {supplierNames.length ? (
            <div className="net-d-tags">{supplierNames.map((m) => <span key={m}>{m}</span>)}</div>
          ) : (
            <div className="net-d-line warn">No vendor on record supplies this maker.</div>
          )}
        </div>
      )}
      <div className="net-d-actions">
        <a className="btn sm" href={partnerHref(n)}>
          {n.kind === "maker" && !n.registered ? "Open Maker list" : `Open ${KIND_LABEL[n.kind]} card`}
        </a>
        {n.kind === "maker" && (
          <a className="btn sm" href="/partners?side=vendors">Find vendors</a>
        )}
      </div>
    </div>
  );
}
