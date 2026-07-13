"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  fetchDashboard,
  fetchQuotationOverview,
  fetchPipeline,
  fetchArOverview,
  fetchPoOverview,
  fetchMarketingOverview,
  fetchSchedule,
  fetchCustomers,
  fetchSettingsVessels,
  fetchStatistics,
  fetchStatisticsDebug,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  type ScheduleSave,
} from "@/lib/api";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import { can, canEditDeal, getUser, isAdmin } from "@/lib/auth";
import type {
  QtnRow, PipelineRow, ArRow, PoRow, MarketingRow, MarketingOverview,
  ScheduleRow, CustomerOption, StatisticsData, StatAlertRow, CurrencyKey,
  StatDebugData,
} from "@/lib/types";
import { PipelineModal } from "@/components/screens/ProgressScreen";
import { MarketingForm, emptyForm as emptyMarketingForm } from "@/components/screens/MarketingScreen";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend, Cell, LabelList,
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
  project_title: string;
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
  project_title: string;
  pic: string;
  due: string;
  days: number;
  amount: string;
  href: string;
  rfq_id?: number;
  order_id?: number;
};

function HomeTab() {
  const router = useRouter();
  const { data: qtn, refresh: refreshQtn } = useCachedData("home:quotations", () => fetchQuotationOverview());
  const { data: pipeline, refresh: refreshPipeline } = useCachedData("pipeline", () => fetchPipeline());
  const { data: ar, refresh: refreshAr } = useCachedData("ar:overview", fetchArOverview);
  // 고객 P/O 수신 현황 — 열람 권한이 있을 때만 로드(없으면 카드 미표시).
  const canPo = can("po", "view");
  const { data: po } = useCachedData(
    "po:overview",
    () => (canPo ? fetchPoOverview() : Promise.resolve(null)),
  );
  // 프로젝트 상세 팝업(Progress 화면과 동일한 모달)용 — 편집 셀렉터에 쓰는 고객사·선박 목록.
  const { data: vessels } = useCachedData("settings:vessels", fetchSettingsVessels);
  // 마케팅 요약 — 열람 권한이 있을 때만 로드(없으면 카드 미표시).
  const canMarketing = can("marketing", "view");
  const { data: marketing, refresh: refreshMarketing } = useCachedData(
    "home:marketing",
    () => (canMarketing ? fetchMarketingOverview() : Promise.resolve(null)),
  );
  const { data: schedule, refresh: refreshSchedule } = useCachedData("home:schedule", fetchSchedule);
  const { data: customers } = useCachedData("settings:customers", fetchCustomers);

  // 일정 등록/수정 모달 상태.
  const [schedAdding, setSchedAdding] = useState(false);
  const [schedEditing, setSchedEditing] = useState<ScheduleRow | null>(null);

  // 마케팅 활동 등록 모달 상태 — 카드의 + Add 버튼으로 연다.
  const [mktAdding, setMktAdding] = useState(false);
  const canMarketingCreate = canMarketing && can("marketing", "create");

  const qtnRows = useMemo(() => qtn?.rows ?? [], [qtn]);
  const arRows = useMemo(() => ar?.rows ?? [], [ar]);
  // P/O 수신 = 주문(Order)이 생성된 건만(id>0). RFQ 단계뿐인 건은 제외.
  const poRows = useMemo(() => (po?.rows ?? []).filter((r) => r.id > 0), [po]);
  const schedRows = useMemo(() => schedule?.rows ?? [], [schedule]);

  // 대시보드 목록에서 프로젝트 행 클릭 → Progress 화면과 동일한 상세 팝업을 연다.
  // rfq_id 만 보관하고 최신 파이프라인에서 행을 다시 찾는다(모달 내 편집/삭제가
  // 저장 후 즉시 반영되고, 삭제되면 자동으로 닫히도록).
  const [openRfqId, setOpenRfqId] = useState<number | null>(null);
  const pipeRows = useMemo(() => pipeline?.rows ?? [], [pipeline]);
  const steps = useMemo(() => pipeline?.steps ?? [], [pipeline]);
  const byRfqId = useMemo(() => {
    const m = new Map<number, PipelineRow>();
    for (const r of pipeRows) m.set(r.rfq_id, r);
    return m;
  }, [pipeRows]);
  const byOrderId = useMemo(() => {
    const m = new Map<number, PipelineRow>();
    for (const r of pipeRows) if (r.order_id) m.set(r.order_id, r);
    return m;
  }, [pipeRows]);
  const openProject = openRfqId != null ? byRfqId.get(openRfqId) ?? null : null;

  // rfq_id/order_id 로 프로젝트를 찾아 팝업을 연다. 파이프라인에 없으면(권한/필터 등)
  // 기존처럼 해당 워크스페이스로 이동(fallback).
  function openByRfqId(rfqId: number | null | undefined, fallback: string) {
    if (rfqId && byRfqId.has(rfqId)) setOpenRfqId(rfqId);
    else router.push(fallback);
  }
  function openByOrderId(orderId: number | null | undefined, fallback: string) {
    const row = orderId ? byOrderId.get(orderId) : undefined;
    if (row) setOpenRfqId(row.rfq_id);
    else router.push(fallback);
  }

  async function reloadAfterProjectEdit() {
    invalidateCache("dashboard");
    await Promise.all([refreshPipeline(), refreshQtn(), refreshAr()]);
  }

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
            project_title: r.project_title || "",
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
          project_title: q.project_title || "",
          pic: q.assignee || "",
          due: q.valid_until,
          days: daysBetween(t, q.valid_until),
          amount: dualCurrencyText(q.amount, q.currency),
          href: q.rfq_id ? `/progress?rfq=${q.rfq_id}&stage=4` : "/progress",
          rfq_id: q.rfq_id || undefined,
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
          project_title: a.project_title || "",
          pic: a.assignee || "",
          due: a.due_date,
          days: daysBetween(t, a.due_date),
          amount: dualCurrencyText(a.outstanding, a.currency),
          href: `/progress?order=${a.order_id}&stage=11`,
          order_id: a.order_id || undefined,
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
    { key: "project", label: "Project", text: (r) => r.project_title || "" },
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
    { key: "project", label: "Project", text: (r) => r.project_title || "" },
    { key: "party", label: "Party", text: (r) => r.party || "", filter: "facet" },
    { key: "channel", label: "Channel", text: (r) => r.channel || "", filter: "facet" },
    { key: "text", label: "Activity", text: (r) => r.text || "" },
  ];

  const salesCols: ColumnDef<ArRow>[] = [
    { key: "date", label: "Date", text: (r) => (r.tax_issued_date || r.due_date || "").slice(0, 10), filter: "date" },
    { key: "customer", label: "Customer", text: (r) => r.customer || "", filter: "facet", render: (r) => <CustomerName name={r.customer || ""} /> },
    { key: "project", label: "Project", text: (r) => r.project_title || "" },
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

  // 고객 P/O 수신 — 대시보드 카드 컬럼(수신일·PO번호·고객·선박·품목수·단계).
  const poCols: ColumnDef<PoRow>[] = [
    { key: "customer_po_at", label: "Received", text: (r) => (r.customer_po_at || "").slice(0, 10), filter: "date" },
    { key: "customer_po_no", label: "PO No.", text: (r) => r.customer_po_no || "" },
    { key: "customer", label: "Customer", text: (r) => r.customer || "", filter: "facet", render: (r) => <CustomerName name={r.customer || ""} /> },
    { key: "project", label: "Project", text: (r) => r.project_title || "" },
    { key: "vessel", label: "Vessel", text: (r) => r.vessel || "" },
    { key: "items", label: "Items", numeric: true, text: (r) => String(r.item_count), sortValue: (r) => r.item_count },
    { key: "status", label: "Status", text: (r) => tr(r.status), filter: "facet", render: (r) => <span className="ar-badge">{tr(r.status)}</span> },
  ];

  const delayCols: ColumnDef<DelayRow>[] = [
    { key: "due", label: "Due date", text: (r) => r.due || "", filter: "date" },
    { key: "days", label: "Days late", numeric: true, text: (r) => `${r.days}d`, sortValue: (r) => r.days, render: (r) => <b className="home-late">{r.days}d</b> },
    { key: "kind", label: "Type", text: (r) => r.kind, filter: "facet" },
    { key: "project", label: "Project", text: (r) => r.project_title || "" },
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
          onRowClick={(r) => openByRfqId(r.rfq_id, r.rfq_id ? `/progress?rfq=${r.rfq_id}&stage=4` : "/progress")}
          empty="No quotations submitted yet."
        />
      ),
    },
    ...(canPo
      ? {
          po: {
            title: "P/O Received",
            sub: "Customer purchase orders",
            body: !po ? (
              <div className="state">Loading…</div>
            ) : (
              <FilterTable
                tableId="dash-po"
                rows={poRows}
                columns={poCols}
                getRowKey={(r) => r.id}
                defaultSortKey="customer_po_at"
                defaultSortDir="desc"
                onRowClick={(r) => openByOrderId(r.id, `/progress?order=${r.id}&stage=5`)}
                empty="No purchase orders received yet."
              />
            ),
          },
        }
      : {}),
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
          onRowClick={(r) => openByRfqId(r.rfq_id, `/progress?rfq=${r.rfq_id}`)}
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
          onRowClick={(r) => openByOrderId(r.order_id, `/progress?order=${r.order_id}&stage=11`)}
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
          onRowClick={(r) => (r.rfq_id ? openByRfqId(r.rfq_id, r.href) : openByOrderId(r.order_id, r.href))}
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
                onAdd={canMarketingCreate ? () => setMktAdding(true) : undefined}
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

  function reloadMarketing() {
    setMktAdding(false);
    // 마케팅 화면 목록 캐시도 무효화해 다음 방문 시 최신 활동이 보이도록.
    invalidateCache("marketing");
    invalidateCache("marketing-overview");
    return refreshMarketing();
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

      {mktAdding ? (
        <Modal title="Add marketing activity" onClose={() => setMktAdding(false)} form>
          <MarketingForm
            initial={{ ...emptyMarketingForm, owner_id: getUser()?.id ?? "" }}
            customers={customers ?? []}
            canEdit
            onChanged={reloadMarketing}
          />
        </Modal>
      ) : null}

      {openProject ? (
        <PipelineModal
          r={openProject}
          steps={steps}
          customers={customers ?? []}
          vessels={vessels ?? []}
          onChanged={reloadAfterProjectEdit}
          onClose={() => setOpenRfqId(null)}
        />
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
    // 저장된 순서를 유지하되, 저장 이후 새로 추가된 카드는 끝이 아니라
    // 기본 순서상의 자리(직전 카드 뒤)에 끼워 넣는다. 그래야 신규 카드가
    // 의도한 위치(예: P/O Received = Quote 다음)에 나타난다.
    const merged = saved.filter((id) => known.has(id));
    defaults.forEach((id, idx) => {
      if (merged.includes(id)) return;
      let insertAt = merged.length;
      for (let j = idx - 1; j >= 0; j--) {
        const pos = merged.indexOf(defaults[j]);
        if (pos !== -1) {
          insertAt = pos + 1;
          break;
        }
      }
      merged.splice(insertAt, 0, id);
    });
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
  onAdd,
}: {
  data: MarketingOverview;
  columns: ColumnDef<MarketingRow>[];
  onRowClick: (r: MarketingRow) => void;
  onAdd?: () => void;
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
        actions={
          onAdd ? (
            <button className="btn" onClick={onAdd}>
              + Add
            </button>
          ) : undefined
        }
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

// 프로젝트 단계별 색상 — hue=단계, 채도(진/연)=매출/매입.
const STAGE_KEYS = ["Quoted", "PO", "Invoiced"] as const;
type StageKey = (typeof STAGE_KEYS)[number];
const STAGE_COLORS: Record<StageKey, { sales: string; purchase: string }> = {
  Quoted:   { sales: "#e8830c", purchase: "#f6c489" },  // 주황
  PO:       { sales: "#0055a8", purchase: "#9cc0e6" },  // 파랑
  Invoiced: { sales: "#1a7a4a", purchase: "#96caae" },  // 초록
};

// 파이프라인 4개 중분류(phase) 순서형 파랑 램프(light→dark) — dataviz 검증 통과.
// 단계는 순서형이므로 임의 카테고리색이 아니라 단일 색조 심도로 진행감을 준다.
const PHASE_RAMP = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#0d366b"];
const PHASE_LABELS = ["RFQ", "Quote", "P/O", "Documents", "AR"];
const PHASE_BOUNDS = [2, 4, 6, 9, 11]; // 각 phase 의 단계 상한(누적): 1–2 / 3–4 / 5–6 / 7–9 / 10–11
/** 1-based 단계 번호 → phase 인덱스(0..3). */
function phaseOfStage(stage: number): number {
  const i = PHASE_BOUNDS.findIndex((b) => stage <= b);
  return i < 0 ? PHASE_BOUNDS.length - 1 : i;
}

function StatisticsTab() {
  const { data, error } = useCachedData("dashboard", fetchDashboard);
  const { data: stat } = useCachedData("statistics", () => fetchStatistics(12));
  const [cur, setCur] = useState<CurrencyKey>("USD");
  // 금액 KPI 월 이동 — null 이면 최신(이번 달). 절대 인덱스로 저장하고 로드 후 clamp.
  const [monthIdx, setMonthIdx] = useState<number | null>(null);
  // 프로젝트 Sales/Purchase 차트 단계 필터.
  const [marginStage, setMarginStage] = useState<"All" | StageKey>("All");
  // 관리자 전용 금액 KPI 감사 패널(행 단위 내역). 필요할 때만 온디맨드 로드.
  const [audit, setAudit] = useState<StatDebugData | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditErr, setAuditErr] = useState<string | null>(null);

  if (error && !data) {
    return <div className="state error">API error: {error.message}</div>;
  }
  if (!data || !stat) {
    return <div className="state">Loading…</div>;
  }

  const { ops, perf } = data;
  // 선택 월 인덱스(기본 최신월) — 금액 KPI 3종은 월별 시계열에서 직접 뽑는다.
  const lastIdx = stat.months.length - 1;
  const idx = monthIdx == null ? lastIdx : Math.min(Math.max(monthIdx, 0), lastIdx);
  const selMonth = stat.months[idx];
  const isCurMonth = idx === lastIdx;
  const mVal = (metric: "revenue" | "quote" | "order", i: number) =>
    stat.series[metric][cur][i] ?? 0;
  const mRevenue = mVal("revenue", idx), mRevenuePrev = idx > 0 ? mVal("revenue", idx - 1) : 0;
  const mOrder = mVal("order", idx), mOrderPrev = idx > 0 ? mVal("order", idx - 1) : 0;
  const mQuote = mVal("quote", idx), mQuotePrev = idx > 0 ? mVal("quote", idx - 1) : 0;

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

  const showAudit = isAdmin();
  async function loadAudit() {
    const nextOpen = !auditOpen;
    setAuditOpen(nextOpen);
    if (nextOpen && !audit) {
      setAuditBusy(true);
      setAuditErr(null);
      try {
        setAudit(await fetchStatisticsDebug(selMonth));
      } catch (e) {
        setAuditErr(e instanceof Error ? e.message : "Failed to load");
      } finally {
        setAuditBusy(false);
      }
    }
  }
  const money = (n: number) => Math.round(n).toLocaleString();

  // 신규 차트 데이터 -------------------------------------------------------
  const rfqData = stat.months.map((m, i) => ({
    month: monthLabel(m), count: stat.rfq_count[i] || 0, detail: stat.rfq_detail[i] || [],
  }));
  const toCur = (usd: number) => (cur === "KRW" ? usd * stat.usd_krw_rate : usd);
  const marginData = stat.project_margin.map((p) => ({
    ...p,
    name: p.project_no,
    sales: Math.round(toCur(p.sales_usd)),
    purchase: Math.round(toCur(p.purchase_usd)),
  }));
  const marginFiltered = marginStage === "All" ? marginData : marginData.filter((p) => p.stage === marginStage);
  const stageColor = (stg: string, kind: "sales" | "purchase") =>
    (STAGE_COLORS[stg as StageKey] ?? STAGE_COLORS.PO)[kind];
  const funnelData = [
    { stage: "RFQ", count: stat.funnel.rfq, rate: 100, label: "" },
    { stage: "Quote", count: stat.funnel.quote, rate: stat.funnel.quote_rate, label: "Quote / RFQ" },
    { stage: "Order (PO)", count: stat.funnel.order, rate: stat.funnel.order_rate, label: "PO / Quote" },
    { stage: "Revenue", count: stat.funnel.revenue, rate: stat.funnel.revenue_rate, label: "Revenue / PO" },
  ];
  const marginDisp = (usd: number) =>
    cur === "KRW" ? `KRW ${money(usd * stat.usd_krw_rate)}` : `USD ${money(usd)}`;

  // 커스텀 호버 툴팁(상세내역) --------------------------------------------
  function RfqTip({ active, payload }: { active?: boolean; payload?: { payload: typeof rfqData[number] }[] }) {
    if (!active || !payload?.length) return null;
    const p = payload[0].payload;
    return (
      <div className="stat-tip">
        <div className="stat-tip-h">{p.month} · RFQ {p.count}건</div>
        {p.detail.slice(0, 12).map((d, i) => (
          <div key={i} className="stat-tip-row"><b>{d.rfq_no}</b> {d.customer}{d.work_type ? ` · ${d.work_type}` : ""}</div>
        ))}
        {p.detail.length > 12 ? <div className="stat-tip-more">+{p.detail.length - 12} more…</div> : null}
        {p.count === 0 ? <div className="stat-tip-row muted">수신 없음</div> : null}
      </div>
    );
  }
  function MarginTip({ active, payload }: { active?: boolean; payload?: { payload: typeof marginData[number] }[] }) {
    if (!active || !payload?.length) return null;
    const p = payload[0].payload;
    return (
      <div className="stat-tip">
        <div className="stat-tip-h">{p.project_no} · {p.customer} <span className={`stat-tip-badge stage-${p.stage.toLowerCase()}`}>{p.stage}</span></div>
        <div className="stat-tip-row">Sales: {marginDisp(p.sales_usd)}</div>
        <div className="stat-tip-row">Purchase: {marginDisp(p.purchase_usd)}</div>
        <div className="stat-tip-row"><b>Margin: {marginDisp(p.margin_usd)} ({p.margin_pct}%)</b></div>
      </div>
    );
  }
  function FunnelTip({ active, payload }: { active?: boolean; payload?: { payload: typeof funnelData[number] }[] }) {
    if (!active || !payload?.length) return null;
    const p = payload[0].payload;
    return (
      <div className="stat-tip">
        <div className="stat-tip-h">{p.stage}: {p.count}건</div>
        {p.label ? <div className="stat-tip-row">{p.label} = <b>{p.rate}%</b></div> : <div className="stat-tip-row muted">기준(전체)</div>}
      </div>
    );
  }

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

      {/* ① 금액 KPI 스트립 — 월 앞뒤 이동으로 과거 실적 확인(월별 시계열 기반) ---- */}
      <div className="dash-subhead stat-monthhead">
        <span className="t">Monthly</span>
        <span className="stat-monthnav">
          <button
            type="button" className="stat-mnav-btn"
            onClick={() => setMonthIdx(idx - 1)} disabled={idx <= 0}
            aria-label="Previous month" title="Previous month"
          >‹</button>
          <span className="stat-mnav-label">
            {selMonth}{isCurMonth ? " · This month" : ""}
          </span>
          <button
            type="button" className="stat-mnav-btn"
            onClick={() => setMonthIdx(idx + 1)} disabled={idx >= lastIdx}
            aria-label="Next month" title="Next month"
          >›</button>
        </span>
        <span className="s">{cur}</span>
      </div>
      <div className="kpi-row">
        <Kpi label="Revenue" value={fmtMoney(cur, mRevenue)} sub="Tax-invoiced"
          chipNode={<DeltaChip cur={mRevenue} prev={mRevenuePrev} />} />
        <Kpi label="Orders Won" value={fmtMoney(cur, mOrder)} sub="Order value" accent="#2e8b57"
          chipNode={<DeltaChip cur={mOrder} prev={mOrderPrev} />} />
        <Kpi label="Quoted" value={fmtMoney(cur, mQuote)} sub="Quote value" accent="#e8830c"
          chipNode={<DeltaChip cur={mQuote} prev={mQuotePrev} />} />
      </div>

      {/* ② 운영 스냅샷 — 현재 상태(월 이동과 무관한 실시간 지표) ---------------- */}
      <SubHead title="Operations" sub="Current status" />
      <div className="kpi-row">
        <Kpi label="Hit Rate" value={`${perf.hit_rate}%`} sub="PO conversion" accent="#8e44ad" />
        <Kpi label="Gross Margin" value={`${perf.gross_margin_pct}%`} sub="Gross margin %" accent="#1a7a4a" />
        <Kpi label="AR Outstanding"
          value={`${cur} ${num(Math.round(data.kpi.ar_outstanding?.[cur] ?? (cur === "USD" ? data.kpi.ar_outstanding_usd : 0)))}`}
          sub={`Outstanding (${cur})`}
          accent={ops.overdue ? "#dc3545" : "#0055a8"}
          chip={{ text: `Overdue ${ops.overdue}`, tone: ops.overdue ? "red" : "gray" }} />
        <Kpi label="Delivery Delays" value={stat.delivery_delays} sub="Past promised date"
          accent={stat.delivery_delays ? "#dc3545" : "#0055a8"} />
        <Kpi label="Urgent" value={ops.urgent} sub="Level A · expiring"
          accent={ops.urgent ? "#e8830c" : "#0055a8"}
          chip={{ text: `Expiring ${ops.expiring}`, tone: ops.expiring ? "amber" : "gray" }} />
      </div>

      {/* 관리자 전용 감사 — 금액 KPI 가 어떤 오더·견적·AR 에서 왔는지 행 단위로 확인.
          통화 오염(예: KRW 금액이 USD 로 계상) 원인을 화면에서 바로 특정한다. */}
      {showAudit ? (
        <div className="stat-audit">
          <button type="button" className="stat-audit-toggle" onClick={loadAudit}>
            {auditOpen ? "▾" : "▸"} 🔍 Audit money KPIs — trace Orders Won / Quoted / Revenue rows
          </button>
          {auditOpen ? (
            auditBusy ? (
              <div className="state">Loading breakdown…</div>
            ) : auditErr ? (
              <div className="state error">{auditErr}</div>
            ) : audit ? (
              <div className="stat-audit-body">
                <p className="stat-audit-note">
                  Month <b>{audit.month}</b>. Amounts are shown in the currency bucket each row lands in.
                  Rows marked <span className="stat-audit-flag">⚠ suspect</span> are large amounts counted as USD —
                  the likely cross-currency contamination.
                </p>

                <div className="stat-audit-tbl">
                  <div className="stat-audit-h">
                    Orders Won → USD {money(audit.orders_won.total.USD)} · KRW {money(audit.orders_won.total.KRW)}
                  </div>
                  <table className="mini wide">
                    <thead><tr><th>Ref</th><th>Customer</th><th>Date</th><th>Bucket</th><th style={{ textAlign: "right" }}>Amount</th><th>Source</th></tr></thead>
                    <tbody>
                      {audit.orders_won.rows.length === 0 ? (
                        <tr><td colSpan={6} className="muted">No orders this month.</td></tr>
                      ) : audit.orders_won.rows.map((r, i) => (
                        <tr key={i} className={r.suspect ? "stat-audit-suspect" : ""}>
                          <td>{r.ref}</td><td>{r.customer}</td><td>{r.date || "—"}</td>
                          <td>{r.bucket}{r.suspect ? " ⚠" : ""}</td>
                          <td style={{ textAlign: "right" }}>{money(r.amount)}</td>
                          <td className="muted">{r.source}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="stat-audit-tbl">
                  <div className="stat-audit-h">
                    Quoted → USD {money(audit.quoted.total.USD)} · KRW {money(audit.quoted.total.KRW)}
                  </div>
                  <table className="mini wide">
                    <thead><tr><th>Ref</th><th>Bucket</th><th>Raw currency</th><th style={{ textAlign: "right" }}>Amount</th></tr></thead>
                    <tbody>
                      {audit.quoted.rows.length === 0 ? (
                        <tr><td colSpan={4} className="muted">No quotes this month.</td></tr>
                      ) : audit.quoted.rows.map((r, i) => (
                        <tr key={i}>
                          <td>{r.ref}</td><td>{r.bucket}</td>
                          <td className="muted">{r.raw_currency ?? "(null)"}</td>
                          <td style={{ textAlign: "right" }}>{money(r.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="stat-audit-tbl">
                  <div className="stat-audit-h">
                    Revenue → USD {money(audit.revenue.total.USD)} · KRW {money(audit.revenue.total.KRW)}
                    <span className="muted"> (only rows with a tax-invoice month = {audit.month} are counted)</span>
                  </div>
                  <table className="mini wide">
                    <thead><tr><th>Ref</th><th>Tax-invoice month</th><th>Bucket</th><th style={{ textAlign: "right" }}>Amount</th><th>Counted</th></tr></thead>
                    <tbody>
                      {audit.revenue.rows.length === 0 ? (
                        <tr><td colSpan={5} className="muted">No AR records.</td></tr>
                      ) : audit.revenue.rows.map((r, i) => (
                        <tr key={i} className={r.counted ? "" : "muted"}>
                          <td>{r.ref}</td><td>{r.issue_month}</td><td>{r.bucket}</td>
                          <td style={{ textAlign: "right" }}>{money(r.amount)}</td>
                          <td>{r.counted ? "✓" : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null
          ) : null}
        </div>
      ) : null}

      {/* ② 추이·구성 차트 (2열) ------------------------------------------- */}
      <div className="stat-charts">
        {/* 월간 RFQ 수신 건수 — 호버 시 해당 월 RFQ 목록 표시 */}
        <div className="stat-chart">
          <SubHead title="Monthly RFQ Received" sub="RFQ 수신 건수 · 호버 상세" />
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={rfqData} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef1f5" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={32} />
              <Tooltip content={<RfqTip />} />
              <Bar dataKey="count" fill="#0055a8" name="RFQ" radius={[3, 3, 0, 0]}>
                <LabelList dataKey="count" position="top" style={{ fontSize: 11, fill: "#45526a" }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Hit-rate 퍼널 — RFQ→Quote→PO→Revenue 전환. 호버 시 전환율 */}
        <div className="stat-chart">
          <SubHead title="Conversion Funnel" sub="RFQ → Quote → PO → Revenue" />
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={funnelData} layout="vertical" margin={{ top: 4, right: 40, bottom: 0, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef1f5" />
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="stage" width={92} tick={{ fontSize: 11 }} />
              <Tooltip content={<FunnelTip />} />
              <Bar dataKey="count" name="Count" radius={[0, 3, 3, 0]}>
                {funnelData.map((_, i) => <Cell key={i} fill={PHASE_RAMP[i % PHASE_RAMP.length]} />)}
                <LabelList dataKey="count" position="right" style={{ fontSize: 11, fill: "#45526a" }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* 프로젝트별 Sales/Purchase — 세로 그룹 막대. hue=단계, 채도=매출/매입. */}
        <div className="stat-chart stat-chart--wide">
          <SubHead title="Project Sales vs Purchase" sub={`프로젝트별 매출·매입 (${cur}) · 호버 상세`} />
          <div className="stat-margin-controls">
            <div className="stat-cur-toggle sm">
              {(["All", ...STAGE_KEYS] as const).map((sname) => (
                <button key={sname} className={marginStage === sname ? "on" : ""} onClick={() => setMarginStage(sname)}>
                  {sname === "All" ? "All" : sname}
                  {sname !== "All" ? ` (${marginData.filter((p) => p.stage === sname).length})` : ` (${marginData.length})`}
                </button>
              ))}
            </div>
            <div className="stat-margin-legend">
              {STAGE_KEYS.map((sname) => (
                <span key={sname} className="lg"><i style={{ background: STAGE_COLORS[sname].sales }} />{sname}</span>
              ))}
              <span className="muted">· 진한색 = Sales, 연한색 = Purchase</span>
            </div>
          </div>
          {marginFiltered.length === 0 ? (
            <div className="state">해당 단계의 프로젝트가 없습니다.</div>
          ) : (
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={marginFiltered} margin={{ top: 8, right: 16, bottom: 48, left: 8 }} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef1f5" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-30} textAnchor="end" height={60} />
                <YAxis tickFormatter={compact} tick={{ fontSize: 11 }} width={48} />
                <Tooltip content={<MarginTip />} cursor={{ fill: "rgba(0,85,168,0.05)" }} />
                <Bar dataKey="sales" name="Sales" radius={[3, 3, 0, 0]}>
                  {marginFiltered.map((p, i) => <Cell key={i} fill={stageColor(p.stage, "sales")} />)}
                </Bar>
                <Bar dataKey="purchase" name="Purchase" radius={[3, 3, 0, 0]}>
                  {marginFiltered.map((p, i) => <Cell key={i} fill={stageColor(p.stage, "purchase")} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

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

      {/* ③ 파이프라인 12단계 분포(퍼널) ------------------------------------ */}
      <SubHead title="Pipeline Distribution" sub="Deals currently at each stage" />
      {(() => {
        const steps = data.steps;
        const funnelData = data.stage_distribution.map((count, i) => ({
          name: `${i + 1}. ${steps[i] ?? ""}`,
          count,
          phase: phaseOfStage(i + 1),
        }));
        const rowH = 26;
        return (
          <>
            {/* phase 범례 — 색이 나타내는 4개 중분류 */}
            <div className="funnel-legend">
              {PHASE_LABELS.map((lb, i) => (
                <span key={lb} className="funnel-legend-item">
                  <span className="sw" style={{ background: PHASE_RAMP[i] }} />
                  {lb}
                </span>
              ))}
            </div>
            <ResponsiveContainer width="100%" height={funnelData.length * rowH + 36}>
              <BarChart
                data={funnelData}
                layout="vertical"
                margin={{ top: 4, right: 44, bottom: 4, left: 8 }}
                barCategoryGap={4}
              >
                <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="#eef1f5" />
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={176}
                  interval={0}
                  tick={{ fontSize: 11 }}
                />
                <Tooltip
                  cursor={{ fill: "rgba(42,120,214,0.06)" }}
                  formatter={(v) => [`${Number(v) || 0} deals`, "Count"]}
                />
                <Bar dataKey="count" radius={[0, 3, 3, 0]} background={{ fill: "#f1f5fb" }}>
                  {funnelData.map((d, i) => (
                    <Cell key={i} fill={PHASE_RAMP[d.phase]} />
                  ))}
                  <LabelList
                    dataKey="count"
                    position="right"
                    formatter={(v) => {
                      const n = Number(v) || 0;
                      return n ? String(n) : "";
                    }}
                    style={{ fontSize: 11, fontWeight: 700, fill: "#111827" }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </>
        );
      })()}

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
    // 모든 단계 작업은 진행현황(Progress) 프로젝트 팝업으로 통합됨 → 딥링크로 해당 단계를 연다.
    if (kind === "quote" && r.rfq_id) router.push(`/progress?rfq=${r.rfq_id}&stage=4`);
    else if (kind === "ar" && r.order_id) router.push(`/progress?order=${r.order_id}&stage=11`);
    else if (r.rfq_id) router.push(`/progress?rfq=${r.rfq_id}`);
    else if (r.order_id) router.push(`/progress?order=${r.order_id}`);
    else router.push("/progress");
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
