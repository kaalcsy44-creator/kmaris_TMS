"use client";

import { useMemo, useState } from "react";
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
  children,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="home-card">
      <div className="home-card-head">
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
          amount: `${q.currency} ${money(q.amount)}`,
          href: q.rfq_id ? `/rfq?rfq=${q.rfq_id}&tab=cquote` : "/rfq",
        });
      }
    }
    for (const a of arRows) {
      if (a.overdue) {
        out.push({
          id: `ar-${a.id}`,
          kind: "AR overdue",
          ref: a.ci_no || a.ord_no || "—",
          customer: a.customer || "",
          due: a.due_date,
          days: daysBetween(t, a.due_date),
          amount: `${a.currency} ${money(a.outstanding)}`,
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
    { key: "amount", label: "Amount", numeric: true, text: (r) => `${r.currency} ${money(r.amount)}`, sortValue: (r) => r.amount },
    { key: "valid_until", label: "Valid until", text: (r) => r.valid_until || "", filter: "date" },
    { key: "status", label: "Status", text: (r) => tr(r.status), filter: "facet" },
  ];

  const activityCols: ColumnDef<ActivityRow>[] = [
    { key: "datetime", label: "Date / time", text: (r) => r.datetime || "", filter: "date", render: (r) => fmtDateTime(r.datetime) },
    { key: "owner", label: "Owner", text: (r) => r.owner || "", filter: "facet" },
    { key: "customer", label: "Customer", text: (r) => r.customer || "", filter: "facet" },
    { key: "party", label: "Party", text: (r) => r.party || "", filter: "facet" },
    { key: "channel", label: "Channel", text: (r) => r.channel || "", filter: "facet" },
    { key: "text", label: "Activity", text: (r) => r.text || "" },
  ];

  const salesCols: ColumnDef<ArRow>[] = [
    { key: "date", label: "Date", text: (r) => (r.tax_issued_date || r.due_date || "").slice(0, 10), filter: "date" },
    { key: "ci_no", label: "CI No.", text: (r) => r.ci_no || "" },
    { key: "customer", label: "Customer", text: (r) => r.customer || "", filter: "facet" },
    { key: "amount", label: "Invoice", numeric: true, text: (r) => `${r.currency} ${money(r.invoice_amount)}`, sortValue: (r) => r.invoice_amount },
    { key: "paid", label: "Paid", numeric: true, text: (r) => money(r.paid_amount), sortValue: (r) => r.paid_amount },
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

  return (
    <div className="home-grid">
      <HomeCard title="Quote Submissions" sub="견적제출 리스트">
        {!qtn ? (
          <div className="state">Loading…</div>
        ) : (
          <FilterTable
            rows={qtnRows}
            columns={quoteCols}
            getRowKey={(r) => r.id}
            defaultSortKey="date"
            defaultSortDir="desc"
            onRowClick={(r) => router.push(r.rfq_id ? `/rfq?rfq=${r.rfq_id}&tab=cquote` : "/rfq")}
            empty="No quotations submitted yet."
          />
        )}
      </HomeCard>

      <HomeCard title="Activity Log" sub="담당자 활동 기록">
        {!pipeline ? (
          <div className="state">Loading…</div>
        ) : (
          <FilterTable
            rows={activityRows}
            columns={activityCols}
            getRowKey={(r) => r.id}
            defaultSortKey="datetime"
            defaultSortDir="desc"
            onRowClick={(r) => router.push(`/rfq?rfq=${r.rfq_id}`)}
            empty="No activity recorded yet."
          />
        )}
      </HomeCard>

      <HomeCard title="Sales" sub="매출리스트">
        {!ar ? (
          <div className="state">Loading…</div>
        ) : (
          <FilterTable
            rows={arRows}
            columns={salesCols}
            getRowKey={(r) => r.id}
            defaultSortKey="date"
            defaultSortDir="desc"
            onRowClick={(r) => router.push(`/ar?order=${r.order_id}`)}
            empty="No sales records yet."
          />
        )}
      </HomeCard>

      <HomeCard title="Delays" sub="지연 리스트 (견적·배송 등)">
        {!qtn || !ar ? (
          <div className="state">Loading…</div>
        ) : (
          <FilterTable
            rows={delayRows}
            columns={delayCols}
            getRowKey={(r) => r.id}
            defaultSortKey="due"
            defaultSortDir="asc"
            rowClassName={() => "danger"}
            onRowClick={(r) => router.push(r.href)}
            empty="No delayed items. 🎉"
          />
        )}
      </HomeCard>

      <HomeCard title="Schedule" sub="일정 관리">
        <FilterTable
          rows={[] as never[]}
          columns={scheduleCols}
          getRowKey={() => 0}
          empty="No schedule data yet — coming soon."
        />
      </HomeCard>
    </div>
  );
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
                <div className="a-right">
                  {ar.currency} {ar.outstanding.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </div>
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
