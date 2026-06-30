"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  fetchDashboard,
  fetchQuotationOverview,
  fetchPipeline,
  fetchArOverview,
} from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";
import type { QtnRow, PipelineRow, ArRow } from "@/lib/types";
import { tr } from "@/lib/labels";
import FilterTable, { ColumnDef } from "@/components/common/FilterTable";
import { DualCurrencyAmount, dualCurrencyText } from "@/components/common/itemTable";

function num(n: number) {
  return n.toLocaleString();
}
function money(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const today = () => new Date().toISOString().slice(0, 10);

/** "YYYY-MM-DD…" 두 문자열의 일 수 차(a - b). 비교 불가 시 0. */
function daysBetween(a: string, b: string): number {
  const da = Date.parse((a || "").slice(0, 10));
  const db = Date.parse((b || "").slice(0, 10));
  if (Number.isNaN(da) || Number.isNaN(db)) return 0;
  return Math.round((da - db) / 86_400_000);
}

type Tab = "home" | "stats";

export default function DashboardScreen() {
  const [tab, setTab] = useState<Tab>("home");

  return (
    <>
      <div className="page-tabs">
        <button className={tab === "home" ? "on" : ""} onClick={() => setTab("home")}>
          Home
        </button>
        <button className={tab === "stats" ? "on" : ""} onClick={() => setTab("stats")}>
          Statistics
        </button>
      </div>

      {tab === "home" ? <HomeTab /> : <StatisticsTab />}
    </>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Home 탭 — 업무 핵심 목록을 박스(카드) 그리드로. 각 박스는 날짜순 정렬 +
 * 다른 페이지와 동일한 FilterTable(헤더 정렬/필터) 형식.
 * ────────────────────────────────────────────────────────────────────────── */

function HomeCard({
  title,
  sub,
  dragging,
  onDragStart,
  onDragOver,
  onDragEnd,
  children,
}: {
  title: string;
  sub?: string;
  dragging?: boolean;
  onDragStart?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`home-card${dragging ? " dragging" : ""}`}
      onDragOver={onDragOver}
    >
      <div
        className="home-card-head"
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        title="Drag to reorder"
      >
        <span className="home-card-grip" aria-hidden>⠿</span>
        <h3>{title}</h3>
        {sub ? <span className="home-card-sub">{sub}</span> : null}
      </div>
      <div className="home-card-body">{children}</div>
    </section>
  );
}

type ActivityRow = {
  id: string;
  datetime: string;
  owner: string;
  customer: string;
  party: string;
  channel: string;
  text: string;
  rfq_id: number;
};

type DelayRow = {
  id: string;
  kind: string;
  ref: string;
  customer: string;
  due: string;
  days: number;
  amount: string;
  href: string;
};

function HomeTab() {
  const router = useRouter();
  const { data: qtn } = useCachedData("home:quotations", () => fetchQuotationOverview());
  const { data: pipeline } = useCachedData("pipeline", () => fetchPipeline());
  const { data: ar } = useCachedData("ar:overview", fetchArOverview);

  const qtnRows = useMemo(() => qtn?.rows ?? [], [qtn]);
  const arRows = useMemo(() => ar?.rows ?? [], [ar]);

  // 담당자 활동 기록 — 파이프라인 단계별 stage_notes 를 한 줄씩 펼친다.
  const activityRows = useMemo<ActivityRow[]>(() => {
    const out: ActivityRow[] = [];
    for (const r of pipeline?.rows ?? []) {
      const notes = r.stage_notes ?? {};
      for (const [stage, list] of Object.entries(notes)) {
        (list ?? []).forEach((n, i) => {
          out.push({
            id: `${r.rfq_id}-${stage}-${i}`,
            datetime: n.datetime || n.at || "",
            owner: r.assignee || "",
            customer: r.customer || "",
            party: n.party || "",
            channel: n.channel || "",
            text: n.text || "",
            rfq_id: r.rfq_id,
          });
        });
      }
    }
    return out;
  }, [pipeline]);

  // 지연 리스트 — 유효기한 지난 견적 + 연체 AR 을 한 표로 모은다.
  const delayRows = useMemo<DelayRow[]>(() => {
    const t = today();
    const out: DelayRow[] = [];
    const openQuote = new Set(["초안", "발송완료", "협상중"]); // 미확정 상태만 지연 대상
    for (const q of qtnRows) {
      if (q.valid_until && q.valid_until.slice(0, 10) < t && openQuote.has(q.status)) {
        out.push({
          id: `q-${q.id}`,
          kind: "Quote expired",
          ref: q.qtn_no || "—",
          customer: q.customer || "",
          due: q.valid_until,
          days: daysBetween(t, q.valid_until),
          amount: dualCurrencyText(q.amount, q.currency),
          href: q.rfq_id ? `/rfq?rfq=${q.rfq_id}&tab=cquote` : "/rfq",
        });
      }
    }
    for (const a of arRows) {
      if (a.overdue) {
        out.push({
          id: `ar-${a.id}`,
          kind: "AR overdue",
          ref: a.ci_no || a.project_no || "—",
          customer: a.customer || "",
          due: a.due_date,
          days: daysBetween(t, a.due_date),
          amount: dualCurrencyText(a.outstanding, a.currency),
          href: `/ar?order=${a.order_id}`,
        });
      }
    }
    return out;
  }, [qtnRows, arRows]);

  // ── 컬럼 정의 ──────────────────────────────────────────────────────────
  const quoteCols: ColumnDef<QtnRow>[] = [
    { key: "date", label: "Date", text: (r) => (r.sent_date || r.date || "").slice(0, 10), filter: "date" },
    { key: "qtn_no", label: "Quote No.", text: (r) => r.qtn_no || "" },
    { key: "customer", label: "Customer", text: (r) => r.customer || "", filter: "facet" },
    { key: "vessel", label: "Vessel", text: (r) => r.vessel || "" },
    {
      key: "amount",
      label: "Amount",
      numeric: true,
      text: (r) => dualCurrencyText(r.amount, r.currency),
      render: (r) => <DualCurrencyAmount value={r.amount} currency={r.currency} />,
      sortValue: (r) => r.amount,
    },
    { key: "valid_until", label: "Valid until", text: (r) => r.valid_until || "", filter: "date" },
    { key: "status", label: "Status", text: (r) => tr(r.status), filter: "facet" },
  ];

  const activityCols: ColumnDef<ActivityRow>[] = [
    { key: "datetime", label: "Date / time", text: (r) => r.datetime || "", filter: "date", render: (r) => fmtDateTime(r.datetime) },
    { key: "owner", label: "PIC", text: (r) => r.owner || "", filter: "facet" },
    { key: "customer", label: "Customer", text: (r) => r.customer || "", filter: "facet" },
    { key: "party", label: "Party", text: (r) => r.party || "", filter: "facet" },
    { key: "channel", label: "Channel", text: (r) => r.channel || "", filter: "facet" },
    { key: "text", label: "Activity", text: (r) => r.text || "" },
  ];

  const salesCols: ColumnDef<ArRow>[] = [
    { key: "date", label: "Date", text: (r) => (r.tax_issued_date || r.due_date || "").slice(0, 10), filter: "date" },
    { key: "customer", label: "Customer", text: (r) => r.customer || "", filter: "facet" },
    {
      key: "amount",
      label: "Invoice",
      numeric: true,
      text: (r) => dualCurrencyText(r.invoice_amount, r.currency),
      render: (r) => <DualCurrencyAmount value={r.invoice_amount} currency={r.currency} />,
      sortValue: (r) => r.invoice_amount,
    },
    {
      key: "paid",
      label: "Paid",
      numeric: true,
      text: (r) => dualCurrencyText(r.paid_amount, r.currency),
      render: (r) => <DualCurrencyAmount value={r.paid_amount} currency={r.currency} />,
      sortValue: (r) => r.paid_amount,
    },
    { key: "status", label: "Status", text: (r) => tr(r.status), filter: "facet", render: (r) => <span className={`ar-badge${r.overdue ? " overdue" : ""}`}>{tr(r.status)}</span> },
  ];

  const delayCols: ColumnDef<DelayRow>[] = [
    { key: "due", label: "Due date", text: (r) => r.due || "", filter: "date" },
    { key: "days", label: "Days late", numeric: true, text: (r) => `${r.days}d`, sortValue: (r) => r.days, render: (r) => <b className="home-late">{r.days}d</b> },
    { key: "kind", label: "Type", text: (r) => r.kind, filter: "facet" },
    { key: "ref", label: "Ref.", text: (r) => r.ref },
    { key: "customer", label: "Customer", text: (r) => r.customer || "", filter: "facet" },
    { key: "amount", label: "Amount", numeric: true, text: (r) => r.amount },
  ];

  // 일정 관리 — 백엔드 일정 데이터 미구현. 자리(빈 표)만 둔다.
  const scheduleCols: ColumnDef<never>[] = [
    { key: "date", label: "Date", text: () => "", filter: "date" },
    { key: "title", label: "Title", text: () => "" },
    { key: "type", label: "Type", text: () => "", filter: "facet" },
    { key: "notes", label: "Notes", text: () => "" },
  ];

  // ── 박스(카드) 정의 — id 별 제목/내용. 순서는 order 상태가 정한다. ───────
  const cards: Record<string, { title: string; sub: string; body: React.ReactNode }> = {
    quotes: {
      title: "Quote Submissions",
      sub: "Submitted quotes",
      body: !qtn ? (
        <div className="state">Loading…</div>
      ) : (
        <FilterTable
          tableId="dash-quotes"
          rows={qtnRows}
          columns={quoteCols}
          getRowKey={(r) => r.id}
          defaultSortKey="date"
          defaultSortDir="desc"
          onRowClick={(r) => router.push(r.rfq_id ? `/rfq?rfq=${r.rfq_id}&tab=cquote` : "/rfq")}
          empty="No quotations submitted yet."
        />
      ),
    },
    activity: {
      title: "Activity Log",
      sub: "PIC activity log",
      body: !pipeline ? (
        <div className="state">Loading…</div>
      ) : (
        <FilterTable
          tableId="dash-activity"
          rows={activityRows}
          columns={activityCols}
          getRowKey={(r) => r.id}
          defaultSortKey="datetime"
          defaultSortDir="desc"
          onRowClick={(r) => router.push(`/rfq?rfq=${r.rfq_id}`)}
          empty="No activity recorded yet."
        />
      ),
    },
    sales: {
      title: "Sales",
      sub: "Sales list",
      body: !ar ? (
        <div className="state">Loading…</div>
      ) : (
        <FilterTable
          tableId="dash-sales"
          rows={arRows}
          columns={salesCols}
          getRowKey={(r) => r.id}
          defaultSortKey="date"
          defaultSortDir="desc"
          onRowClick={(r) => router.push(`/ar?order=${r.order_id}`)}
          empty="No sales records yet."
        />
      ),
    },
    delays: {
      title: "Delays",
      sub: "Overdue items (quotes, delivery)",
      body: !qtn || !ar ? (
        <div className="state">Loading…</div>
      ) : (
        <FilterTable
          tableId="dash-delays"
          rows={delayRows}
          columns={delayCols}
          getRowKey={(r) => r.id}
          defaultSortKey="due"
          defaultSortDir="asc"
          rowClassName={() => "danger"}
          onRowClick={(r) => router.push(r.href)}
          empty="No delayed items. 🎉"
        />
      ),
    },
    schedule: {
      title: "Schedule",
      sub: "Schedule",
      body: (
        <FilterTable
          rows={[] as never[]}
          columns={scheduleCols}
          getRowKey={() => 0}
          empty="No schedule data yet — coming soon."
        />
      ),
    },
  };

  const order = useHomeOrder(Object.keys(cards));
  const { ids, dragId, onDragStart, onDragOver, onDragEnd } = order;

  return (
    <div className="home-grid">
      {ids.map((id) => {
        const c = cards[id];
        if (!c) return null;
        return (
          <HomeCard
            key={id}
            title={c.title}
            sub={c.sub}
            dragging={dragId === id}
            onDragStart={() => onDragStart(id)}
            onDragOver={(e) => onDragOver(e, id)}
            onDragEnd={onDragEnd}
          >
            {c.body}
          </HomeCard>
        );
      })}
    </div>
  );
}

/* 박스 순서를 드래그앤드롭으로 바꾸고 localStorage 에 보존하는 훅. */
const HOME_ORDER_KEY = "ktms:home-order";

function useHomeOrder(defaults: string[]) {
  const [ids, setIds] = useState<string[]>(defaults);
  const [dragId, setDragId] = useState<string | null>(null);

  // 최초 마운트 시 저장된 순서를 불러와 현재 카드 목록과 정합성을 맞춘다.
  useEffect(() => {
    let saved: string[] = [];
    try {
      saved = JSON.parse(localStorage.getItem(HOME_ORDER_KEY) || "[]");
    } catch {
      saved = [];
    }
    const known = new Set(defaults);
    const merged = [
      ...saved.filter((id) => known.has(id)),
      ...defaults.filter((id) => !saved.includes(id)),
    ];
    setIds(merged);
    // defaults 는 매 렌더 새 배열이라 의존성에서 제외(키 집합은 고정).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onDragStart(id: string) {
    setDragId(id);
  }
  function onDragOver(e: React.DragEvent, overId: string) {
    e.preventDefault();
    if (!dragId || dragId === overId) return;
    setIds((prev) => {
      const from = prev.indexOf(dragId);
      const to = prev.indexOf(overId);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      next.splice(from, 1);
      next.splice(to, 0, dragId);
      return next;
    });
  }
  function onDragEnd() {
    setDragId(null);
    setIds((prev) => {
      try {
        localStorage.setItem(HOME_ORDER_KEY, JSON.stringify(prev));
      } catch {
        /* ignore */
      }
      return prev;
    });
  }

  return { ids, dragId, onDragStart, onDragOver, onDragEnd };
}

/** "YYYY-MM-DDTHH:MM" → "yy-mm-dd HH:MM". 시각 없으면 날짜만. */
function fmtDateTime(iso: string): string {
  if (!iso) return "—";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return iso;
  const [, y, mo, d, h, mi] = m;
  return `${y.slice(2)}-${mo}-${d}${h ? ` ${h}:${mi}` : ""}`;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Statistics 탭 — 기존 대시보드(KPI/실적/알림) 내용.
 * ────────────────────────────────────────────────────────────────────────── */

/** 탭(대제목) 아래 한 단계 낮은 섹션 소제목 (작은 회색 라벨). */
function SubHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="dash-subhead">
      <span className="t">{title}</span>
      {sub ? <span className="s">{sub}</span> : null}
    </div>
  );
}

function StatisticsTab() {
  const { data, error } = useCachedData("dashboard", fetchDashboard);

  if (error && !data) {
    return <div className="state error">API error: {error.message}</div>;
  }
  if (!data) {
    return <div className="state">Loading…</div>;
  }

  const { kpi, ops, perf, alerts } = data;
  const tat = perf.quotation_tat_h;

  return (
    <>
      <SubHead title="Operational Status" sub="Operational status" />
      <div className="kpi-row">
        <Kpi
          label="Open RFQ"
          value={kpi.open_rfq}
          sub="In progress"
          chip={{ text: `Urgent ${ops.urgent}`, tone: ops.urgent ? "red" : "gray" }}
        />
        <Kpi
          label="Active Orders"
          value={kpi.active_orders}
          sub="Preparing/in progress"
          chip={{
            text: `PO pending ${ops.pending_po}`,
            tone: ops.pending_po ? "amber" : "gray",
          }}
        />
        <Kpi
          label="AR Outstanding"
          value={`USD ${num(Math.round(kpi.ar_outstanding_usd))}`}
          sub="Outstanding"
          accent={ops.overdue ? "#dc3545" : "#0055a8"}
          chip={{ text: `Overdue ${ops.overdue}`, tone: ops.overdue ? "red" : "gray" }}
        />
        <Kpi
          label="This Month Quotes"
          value={kpi.monthly_quotes}
          sub="Quotes"
          chip={{
            text: `Expiring ${ops.expiring}`,
            tone: ops.expiring ? "amber" : "gray",
          }}
        />
      </div>

      <SubHead title="Sales Performance KPIs" sub="Sales performance" />
      <div className="kpi-row">
        <Kpi
          label="RFQ Handling Rate"
          value={`${perf.handling_rate}%`}
          sub="Quote submission rate"
        />
        <Kpi
          label="Quotation TAT"
          value={tat === null ? "—" : `${num(tat)}h`}
          sub="Avg. response time"
          accent="#2e8b57"
        />
        <Kpi
          label="Hit Rate"
          value={`${perf.hit_rate}%`}
          sub="PO conversion rate"
          accent="#e8830c"
          chip={{
            text: `Negotiating USD ${num(Math.round(perf.negotiating_value_usd))}`,
            tone: "blue",
          }}
        />
        <Kpi
          label="Gross Margin"
          value={`${perf.gross_margin_pct}%`}
          sub="Gross margin %"
          accent="#1a7a4a"
        />
      </div>

      <div className="dash-two">
        <div>
          <SubHead title="Urgent Follow-up · Level A Quotes" />
          {alerts.urgent_quotes.length === 0 ? (
            <div className="alert-ok">No urgent follow-up quotes.</div>
          ) : (
            alerts.urgent_quotes.map((q) => (
              <div className="alert-card" key={q.qtn_no}>
                <div>
                  <div className="a-main">{q.qtn_no}</div>
                  <div className="a-sub">Status: {tr(q.status)}</div>
                </div>
                <div className="a-right">Valid until: {q.valid_until || "—"}</div>
              </div>
            ))
          )}
        </div>

        <div>
          <SubHead title="Overdue AR" />
          {alerts.overdue_ar.length === 0 ? (
            <div className="alert-ok">No overdue AR.</div>
          ) : (
            alerts.overdue_ar.map((ar, i) => (
              <div className="alert-card danger" key={`${ar.ci_no}-${i}`}>
                <div>
                  <div className="a-main">{ar.ci_no || "N/A"}</div>
                  <div className="a-sub">Due: {ar.due_date || "—"}</div>
                </div>
                <div className="a-right"><DualCurrencyAmount value={ar.outstanding} currency={ar.currency} /></div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

type Chip = { text: string; tone: "red" | "amber" | "blue" | "gray" };

function Kpi({
  label,
  value,
  sub,
  accent = "#0055a8",
  chip,
}: {
  label: string;
  value: string | number;
  sub: string;
  accent?: string;
  chip?: Chip;
}) {
  return (
    <div className="kpi-card" style={{ borderLeftColor: accent }}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{sub}</div>
      {chip ? (
        <div className="kc-foot">
          <span className={`kc-chip ${chip.tone}`}>{chip.text}</span>
        </div>
      ) : null}
    </div>
  );
}
