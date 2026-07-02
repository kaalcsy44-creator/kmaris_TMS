"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  fetchDashboard,
  fetchQuotationOverview,
  fetchPipeline,
  fetchArOverview,
  fetchMarketingOverview,
  fetchSchedule,
  fetchCustomers,
  fetchStatistics,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  type ScheduleSave,
} from "@/lib/api";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import { can, canEditDeal } from "@/lib/auth";
import type {
  QtnRow, PipelineRow, ArRow, MarketingRow, MarketingOverview,
  ScheduleRow, CustomerOption, StatisticsData, StatAlertRow, CurrencyKey,
} from "@/lib/types";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend, Cell,
} from "recharts";
import { tr } from "@/lib/labels";
import FilterTable, { ColumnDef } from "@/components/common/FilterTable";
import CustomerName from "@/components/common/CustomerName";
import Modal from "@/components/common/Modal";
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
  pic: string;
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
  // 마케팅 요약 — 열람 권한이 있을 때만 로드(없으면 카드 미표시).
  const canMarketing = can("marketing", "view");
  const { data: marketing } = useCachedData(
    "home:marketing",
    () => (canMarketing ? fetchMarketingOverview() : Promise.resolve(null)),
  );
  const { data: schedule, refresh: refreshSchedule } = useCachedData("home:schedule", fetchSchedule);
  const { data: customers } = useCachedData("settings:customers", fetchCustomers);

  // 일정 등록/수정 모달 상태.
  const [schedAdding, setSchedAdding] = useState(false);
  const [schedEditing, setSchedEditing] = useState<ScheduleRow | null>(null);

  const qtnRows = useMemo(() => qtn?.rows ?? [], [qtn]);
  const arRows = useMemo(() => ar?.rows ?? [], [ar]);
  const schedRows = useMemo(() => schedule?.rows ?? [], [schedule]);

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
          pic: q.assignee || "",
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
          pic: a.assignee || "",
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
    { key: "customer", label: "Customer", text: (r) => r.customer || "", filter: "facet", render: (r) => <CustomerName name={r.customer || ""} /> },
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
    { key: "pic", label: "PIC", text: (r) => r.assignee || "", filter: "facet" },
  ];

  const activityCols: ColumnDef<ActivityRow>[] = [
    { key: "datetime", label: "Date / time", text: (r) => r.datetime || "", filter: "date", render: (r) => fmtDateTime(r.datetime) },
    { key: "owner", label: "PIC", text: (r) => r.owner || "", filter: "facet" },
    { key: "customer", label: "Customer", text: (r) => r.customer || "", filter: "facet", render: (r) => <CustomerName name={r.customer || ""} /> },
    { key: "party", label: "Party", text: (r) => r.party || "", filter: "facet" },
    { key: "channel", label: "Channel", text: (r) => r.channel || "", filter: "facet" },
    { key: "text", label: "Activity", text: (r) => r.text || "" },
  ];

  const salesCols: ColumnDef<ArRow>[] = [
    { key: "date", label: "Date", text: (r) => (r.tax_issued_date || r.due_date || "").slice(0, 10), filter: "date" },
    { key: "customer", label: "Customer", text: (r) => r.customer || "", filter: "facet", render: (r) => <CustomerName name={r.customer || ""} /> },
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
    { key: "pic", label: "PIC", text: (r) => r.assignee || "", filter: "facet" },
  ];

  const delayCols: ColumnDef<DelayRow>[] = [
    { key: "due", label: "Due date", text: (r) => r.due || "", filter: "date" },
    { key: "days", label: "Days late", numeric: true, text: (r) => `${r.days}d`, sortValue: (r) => r.days, render: (r) => <b className="home-late">{r.days}d</b> },
    { key: "kind", label: "Type", text: (r) => r.kind, filter: "facet" },
    { key: "ref", label: "Ref.", text: (r) => r.ref },
    { key: "customer", label: "Customer", text: (r) => r.customer || "", filter: "facet", render: (r) => <CustomerName name={r.customer || ""} /> },
    { key: "amount", label: "Amount", numeric: true, text: (r) => r.amount },
    { key: "pic", label: "PIC", text: (r) => r.pic || "", filter: "facet" },
  ];

  // 마케팅(잠정 고객사) — 최근 활동 목록 컬럼.
  const marketingCols: ColumnDef<MarketingRow>[] = [
    { key: "activity_date", label: "Date", text: (r) => r.activity_date || "", filter: "date" },
    { key: "customer", label: "Target", text: (r) => r.customer || "", filter: "facet", render: (r) => (r.is_prospect ? <span>{r.customer || "—"}</span> : <CustomerName name={r.customer || ""} />) },
    { key: "activity_type", label: "Activity", text: (r) => r.activity_type || "", filter: "facet" },
    { key: "channel", label: "Channel", text: (r) => r.channel || "", filter: "facet" },
    { key: "next_action_date", label: "Follow-up", text: (r) => r.next_action_date || "", filter: "date" },
    { key: "pic", label: "PIC", text: (r) => r.owner || "", filter: "facet" },
  ];

  // 일정 관리 — 대시보드 카드 내에서 직접 등록/수정.
  const scheduleCols: ColumnDef<ScheduleRow>[] = [
    { key: "date", label: "Date", text: (r) => r.date || "", filter: "date" },
    { key: "title", label: "Title", text: (r) => r.title || "" },
    { key: "event_type", label: "Type", text: (r) => r.event_type || "", filter: "facet" },
    { key: "customer", label: "Customer", text: (r) => r.customer || "", filter: "facet", render: (r) => (r.customer ? <CustomerName name={r.customer} /> : <>—</>) },
    { key: "notes", label: "Notes", text: (r) => r.notes || "" },
    { key: "pic", label: "PIC", text: (r) => r.owner || "", filter: "facet" },
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
      body: !schedule ? (
        <div className="state">Loading…</div>
      ) : (
        <FilterTable
          tableId="dash-schedule"
          rows={schedRows}
          columns={scheduleCols}
          getRowKey={(r) => r.id}
          defaultSortKey="date"
          defaultSortDir="asc"
          onRowClick={(r) => setSchedEditing(r)}
          empty="No schedule yet. Click + Add to create one."
          actions={
            <button className="btn" onClick={() => setSchedAdding(true)}>
              + Add
            </button>
          }
        />
      ),
    },
    ...(canMarketing
      ? {
          marketing: {
            title: "Marketing",
            sub: "Prospect outreach",
            body: !marketing ? (
              <div className="state">Loading…</div>
            ) : (
              <MarketingCardBody
                data={marketing}
                columns={marketingCols}
                onRowClick={(r) => router.push(`/marketing?id=${r.id}`)}
              />
            ),
          },
        }
      : {}),
  };

  const order = useHomeOrder(Object.keys(cards));
  const { ids, dragId, onDragStart, onDragOver, onDragEnd } = order;

  function reloadSchedule() {
    setSchedAdding(false);
    setSchedEditing(null);
    return refreshSchedule();
  }

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

      {schedAdding ? (
        <Modal title="Add schedule" onClose={() => setSchedAdding(false)} wide>
          <ScheduleForm customers={customers ?? []} canEdit onChanged={reloadSchedule} />
        </Modal>
      ) : null}
      {schedEditing ? (
        <Modal title="Schedule" onClose={() => setSchedEditing(null)} wide>
          <ScheduleForm
            row={schedEditing}
            customers={customers ?? []}
            canEdit={canEditDeal(schedEditing.owner_id)}
            onChanged={reloadSchedule}
          />
        </Modal>
      ) : null}
    </div>
  );
}

/* 일정 등록/수정 폼 — 대시보드 Schedule 카드의 모달 본문. */
const SCHEDULE_TYPES = ["Meeting", "Business trip", "Delivery", "Deadline", "Other"];

function ScheduleForm({
  row,
  customers,
  canEdit,
  onChanged,
}: {
  row?: ScheduleRow;
  customers: CustomerOption[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [date, setDate] = useState(row?.date || today());
  const [title, setTitle] = useState(row?.title ?? "");
  const [eventType, setEventType] = useState(row?.event_type || "Meeting");
  const [customerId, setCustomerId] = useState<number | "">(row?.customer_id ?? "");
  const [notes, setNotes] = useState(row?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const valid = title.trim() !== "" && date.trim() !== "";

  function body(): ScheduleSave {
    return {
      date,
      title: title.trim(),
      event_type: eventType,
      notes,
      customer_id: customerId === "" ? null : customerId,
    };
  }

  async function save() {
    if (!valid) {
      setErr("날짜와 제목을 입력하세요.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      if (row) await updateSchedule(row.id, body());
      else await createSchedule(body());
      invalidateCache("dashboard");
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!row) return;
    if (!confirm("Delete this schedule?")) return;
    setBusy(true);
    setErr("");
    try {
      await deleteSchedule(row.id);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <fieldset className="form-fieldset" disabled={!canEdit}>
        <div className="form-grid">
          <label className="form-field">
            <span>Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="form-field">
            <span>Type</span>
            <select value={eventType} onChange={(e) => setEventType(e.target.value)}>
              {SCHEDULE_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>Title</span>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="form-field">
            <span>Customer (optional)</span>
            <select
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">—</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="form-field" style={{ marginTop: 10 }}>
          <span>Notes</span>
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </fieldset>
      <div className="form-actions">
        {canEdit ? (
          <button className="btn primary" disabled={busy || !valid} onClick={save}>
            {busy ? "Working…" : row ? "Save" : "Add schedule"}
          </button>
        ) : (
          <span className="hint-inline">View only — created by another PIC</span>
        )}
        {row && canEdit ? (
          <button className="btn danger" disabled={busy} onClick={remove} style={{ marginLeft: "auto" }}>
            Delete
          </button>
        ) : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
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

/* 마케팅 카드 본문 — 이번 달 집계 + 후속 예정 요약을 상단에, 최근 활동표를 아래에. */
function MarketingCardBody({
  data,
  columns,
  onRowClick,
}: {
  data: MarketingOverview;
  columns: ColumnDef<MarketingRow>[];
  onRowClick: (r: MarketingRow) => void;
}) {
  const t = today();
  const dueFollowUps = data.follow_ups.filter((r) => r.next_action_date && r.next_action_date <= t).length;
  const topChannels = Object.entries(data.month.by_channel)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ");

  return (
    <>
      <div className="home-marketing-summary" style={{ display: "flex", gap: 16, flexWrap: "wrap", padding: "0 4px 8px", fontSize: 13 }}>
        <span>This month: <b>{data.month.total}</b></span>
        <span>Follow-ups: <b>{data.follow_ups.length}</b>{dueFollowUps > 0 ? <b className="home-late"> ({dueFollowUps} due)</b> : null}</span>
        {topChannels ? <span style={{ color: "#64748b" }}>{topChannels}</span> : null}
      </div>
      <FilterTable
        tableId="dash-marketing"
        rows={data.recent}
        columns={columns}
        getRowKey={(r) => r.id}
        defaultSortKey="activity_date"
        defaultSortDir="desc"
        onRowClick={onRowClick}
        empty="No marketing activities yet."
      />
    </>
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

/* 통화별 금액 포맷 — KRW 는 정수, USD 는 정수(대시보드 요약용). */
function fmtMoney(cur: CurrencyKey, n: number): string {
  return `${cur} ${Math.round(n).toLocaleString()}`;
}

/* 전월 대비 증감 배지. prev=0 이면 표시 안 함. */
function DeltaChip({ cur, prev }: { cur: number; prev: number }) {
  if (!prev) return null;
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  const up = pct >= 0;
  return (
    <span className={`kc-chip ${up ? "blue" : "red"}`}>
      {up ? "▲" : "▼"} {Math.abs(Math.round(pct))}% MoM
    </span>
  );
}

const CHART_COLORS = ["#0055a8", "#2e8b57", "#e8830c", "#8e44ad", "#16a085",
  "#c0392b", "#2980b9", "#d35400", "#27ae60", "#7f8c8d"];

function StatisticsTab() {
  const { data, error } = useCachedData("dashboard", fetchDashboard);
  const { data: stat } = useCachedData("statistics", () => fetchStatistics(12));
  const [cur, setCur] = useState<CurrencyKey>("USD");

  if (error && !data) {
    return <div className="state error">API error: {error.message}</div>;
  }
  if (!data || !stat) {
    return <div className="state">Loading…</div>;
  }

  const { ops, perf } = data;
  const k = stat.kpi[cur];

  // 차트 데이터 변환 ---------------------------------------------------------
  const monthLabel = (m: string) => m.slice(2); // "2026-07" → "26-07"
  const trendData = stat.months.map((m, i) => ({
    month: monthLabel(m),
    revenue: stat.series.revenue[cur][i],
  }));
  const quoteVsOrder = stat.months.map((m, i) => ({
    month: monthLabel(m),
    quote: stat.series.quote[cur][i],
    order: stat.series.order[cur][i],
  }));
  const custTop = stat.customer_top[cur].map((r) => ({ name: r.name, amount: r.amount }));
  const itemTop = stat.item_top[cur].map((r) => ({
    name: r.part_no + (r.description ? ` · ${r.description.slice(0, 20)}` : ""),
    amount: r.amount,
  }));

  const compact = (n: number) => {
    if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (Math.abs(n) >= 1_000) return `${Math.round(n / 1_000)}K`;
    return String(Math.round(n));
  };

  return (
    <>
      <div className="stat-toolbar">
        <div className="stat-cur-toggle">
          {(["USD", "KRW"] as CurrencyKey[]).map((c) => (
            <button key={c} className={cur === c ? "on" : ""} onClick={() => setCur(c)}>
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* ① 금액 KPI 스트립 ------------------------------------------------- */}
      <SubHead title="This Month" sub={`${stat.months[stat.months.length - 1]} · ${cur}`} />
      <div className="kpi-row">
        <Kpi label="Revenue" value={fmtMoney(cur, k.revenue)} sub="Tax-invoiced"
          chipNode={<DeltaChip cur={k.revenue} prev={k.revenue_prev} />} />
        <Kpi label="Orders Won" value={fmtMoney(cur, k.order)} sub="Order value" accent="#2e8b57"
          chipNode={<DeltaChip cur={k.order} prev={k.order_prev} />} />
        <Kpi label="Quoted" value={fmtMoney(cur, k.quote)} sub="Quote value" accent="#e8830c"
          chipNode={<DeltaChip cur={k.quote} prev={k.quote_prev} />} />
        <Kpi label="Hit Rate" value={`${perf.hit_rate}%`} sub="PO conversion" accent="#8e44ad" />
      </div>
      <div className="kpi-row">
        <Kpi label="Gross Margin" value={`${perf.gross_margin_pct}%`} sub="Gross margin %" accent="#1a7a4a" />
        <Kpi label="AR Outstanding" value={`USD ${num(Math.round(data.kpi.ar_outstanding_usd))}`} sub="Outstanding (USD)"
          accent={ops.overdue ? "#dc3545" : "#0055a8"}
          chip={{ text: `Overdue ${ops.overdue}`, tone: ops.overdue ? "red" : "gray" }} />
        <Kpi label="Delivery Delays" value={stat.delivery_delays} sub="Past promised date"
          accent={stat.delivery_delays ? "#dc3545" : "#0055a8"} />
        <Kpi label="Urgent" value={ops.urgent} sub="Level A · expiring"
          accent={ops.urgent ? "#e8830c" : "#0055a8"}
          chip={{ text: `Expiring ${ops.expiring}`, tone: ops.expiring ? "amber" : "gray" }} />
      </div>

      {/* ② 추이·구성 차트 (2×2) ------------------------------------------- */}
      <div className="stat-charts">
        <div className="stat-chart">
          <SubHead title="Monthly Revenue" sub="Tax-invoiced trend" />
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={trendData} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef1f5" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={compact} tick={{ fontSize: 11 }} width={44} />
              <Tooltip formatter={(v) => fmtMoney(cur, Number(v) || 0)} />
              <Line type="monotone" dataKey="revenue" stroke="#0055a8" strokeWidth={2} dot={{ r: 2 }} name="Revenue" />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="stat-chart">
          <SubHead title="Quote vs Order" sub="Monthly value" />
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={quoteVsOrder} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef1f5" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={compact} tick={{ fontSize: 11 }} width={44} />
              <Tooltip formatter={(v) => fmtMoney(cur, Number(v) || 0)} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="quote" fill="#e8830c" name="Quoted" radius={[3, 3, 0, 0]} />
              <Bar dataKey="order" fill="#2e8b57" name="Won" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="stat-chart">
          <SubHead title="Top 10 Customers" sub="By revenue" />
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={custTop} layout="vertical" margin={{ top: 4, right: 24, bottom: 0, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef1f5" />
              <XAxis type="number" tickFormatter={compact} tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => fmtMoney(cur, Number(v) || 0)} />
              <Bar dataKey="amount" name="Revenue" radius={[0, 3, 3, 0]}>
                {custTop.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="stat-chart">
          <SubHead title="Top 10 Items" sub="By invoiced amount" />
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={itemTop} layout="vertical" margin={{ top: 4, right: 24, bottom: 0, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef1f5" />
              <XAxis type="number" tickFormatter={compact} tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="name" width={160} tick={{ fontSize: 10 }} />
              <Tooltip formatter={(v) => fmtMoney(cur, Number(v) || 0)} />
              <Bar dataKey="amount" name="Revenue" radius={[0, 3, 3, 0]}>
                {itemTop.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ③ 파이프라인 12단계 분포 ----------------------------------------- */}
      <SubHead title="Pipeline Distribution" sub="Deals per internal stage" />
      <ResponsiveContainer width="100%" height={220}>
        <BarChart
          data={data.stage_distribution.map((c, i) => ({ stage: `${i + 1}`, count: c }))}
          margin={{ top: 8, right: 16, bottom: 0, left: 8 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#eef1f5" />
          <XAxis dataKey="stage" tick={{ fontSize: 11 }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={32} />
          <Tooltip formatter={(v, _n, p) => [`${Number(v) || 0} deals`, `Stage ${p?.payload?.stage ?? ""}`]} />
          <Bar dataKey="count" fill="#0055a8" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>

      {/* ④ 업무 알림 (6) --------------------------------------------------- */}
      <SubHead title="Action Items" sub="Follow-ups & exceptions" />
      <div className="stat-alerts">
        <AlertCard title="Due Today" rows={stat.alerts.today_delivery} kind="delivery" />
        <AlertCard title="Delivery This Week" rows={stat.alerts.week_delivery} kind="delivery" />
        <AlertCard title="Unanswered Quotes" rows={stat.alerts.unanswered_quotes} kind="quote" />
        <AlertCard title="Vendor PO Not Received" rows={stat.alerts.unreceived_po} kind="po" />
        <AlertCard title="Uninvoiced (Delivered)" rows={stat.alerts.uninvoiced} kind="doc" />
        <AlertCard title="Long Overdue AR" rows={stat.alerts.long_overdue_ar} kind="ar" danger />
      </div>
    </>
  );
}

/* 업무 알림 카드 — 행 클릭 시 관련 페이지로 이동. */
function AlertCard({
  title,
  rows,
  kind,
  danger,
}: {
  title: string;
  rows: StatAlertRow[];
  kind: "delivery" | "quote" | "po" | "doc" | "ar";
  danger?: boolean;
}) {
  const router = useRouter();
  function go(r: StatAlertRow) {
    if (kind === "quote" && r.rfq_id) router.push(`/rfq?rfq=${r.rfq_id}&tab=cquote`);
    else if (kind === "ar" && r.order_id) router.push(`/ar?order=${r.order_id}`);
    else if (kind === "po") router.push("/po");
    else router.push("/documents");
  }
  return (
    <div className="stat-alert">
      <div className="dash-subhead"><span className="t">{title}</span><span className="s">{rows.length}</span></div>
      {rows.length === 0 ? (
        <div className="alert-ok">Nothing here. 🎉</div>
      ) : (
        rows.slice(0, 6).map((r, i) => (
          <div
            className={`alert-card${danger ? " danger" : ""}`}
            key={i}
            role="button"
            onClick={() => go(r)}
          >
            <div>
              <div className="a-main">
                <CustomerName name={r.customer || "—"} />
              </div>
              <div className="a-sub">
                {r.project_no || r.qtn_no || r.ci_no || r.po_no || ""}
                {r.status ? ` · ${tr(r.status)}` : ""}
              </div>
            </div>
            <div className="a-right">
              {r.outstanding != null && r.currency
                ? <DualCurrencyAmount value={r.outstanding} currency={r.currency} />
                : (r.date ? r.date.slice(0, 10) : "")}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

type Chip = { text: string; tone: "red" | "amber" | "blue" | "gray" };

function Kpi({
  label,
  value,
  sub,
  accent = "#0055a8",
  chip,
  chipNode,
}: {
  label: string;
  value: string | number;
  sub: string;
  accent?: string;
  chip?: Chip;
  chipNode?: React.ReactNode;
}) {
  return (
    <div className="kpi-card" style={{ borderLeftColor: accent }}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{sub}</div>
      {chipNode ? (
        <div className="kc-foot">{chipNode}</div>
      ) : chip ? (
        <div className="kc-foot">
          <span className={`kc-chip ${chip.tone}`}>{chip.text}</span>
        </div>
      ) : null}
    </div>
  );
}
