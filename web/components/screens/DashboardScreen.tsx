"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  fetchDashboard,
  fetchQuotationOverview,
  fetchPipeline,
  fetchPoOverview,
  fetchDocumentsRegistry,
  documentDownloadUrl,
  quotationPdfUrl,
  fetchCustomers,
  fetchSettingsVessels,
  fetchStatistics,
  fetchStatisticsDebug,
  closeReasonCodes,
  closeReasonBadge,
  CLOSE_REASONS,
} from "@/lib/api";
import { stageDateOf } from "@/lib/deal";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import { can, getToken, isAdmin, canDownload } from "@/lib/auth";
import type {
  PipelineRow, StatisticsData, CurrencyKey, StatCurKey,
  StatDebugData,
} from "@/lib/types";
import { PipelineModal, byProjectNo } from "@/components/screens/ProjectsScreen";
import BriefingTab from "@/components/screens/BriefingTab";
import {
  ResponsiveContainer, ComposedChart, Line, LineChart, BarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend, Cell, LabelList, ReferenceArea,
} from "recharts";
import { tr } from "@/lib/labels";
import FilterTable, { ColumnDef } from "@/components/common/FilterTable";
import CustomerName from "@/components/common/CustomerName";
import { DualCurrencyAmount, dualCurrencyText } from "@/components/common/itemTable";
import { filenameFromDisposition } from "@/lib/download";

function num(n: number) {
  return n.toLocaleString();
}
function money(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const today = () => new Date().toISOString().slice(0, 10);

type Tab = "briefing" | "stats";

export default function DashboardScreen() {
  // 첫 화면은 Briefing — 로그인해서 가장 먼저 보는 것은 "지금 무슨 일이 벌어지고
  // 있고 다음 차례가 누구인가"여야 한다. Home 의 목록들은 그다음이다.
  const [tab, setTab] = useState<Tab>("briefing");

  return (
    <>
      <div className="page-tabs">
        {/* Briefing — 딜별 사건(단계 이벤트)과 메일을 한 카드에 합친 아침 화면.
            Home 과 pipeline 캐시를 공유하므로 탭 전환에 드는 조회는 /mail/digest 뿐이다. */}
        <button className={tab === "briefing" ? "on" : ""} onClick={() => setTab("briefing")}>
          Briefing
        </button>
        <button className={tab === "stats" ? "on" : ""} onClick={() => setTab("stats")}>
          Statistics
        </button>
      </div>

      {tab === "briefing" ? <BriefingTab /> : <StatisticsTab />}
    </>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Documents 탭 — 발행·수신 문서(Quotation·고객 P/O·PI·CI·PL)를 한 장의 큰 표로.
 * 위 버튼(All / Quotation / P/O / PI / CI / PL)으로 종류를 고른다. 기본 All.
 * 견적서·P/O 는 기존 overview 캐시를 그대로 쓰고, PI·CI·PL 은 documents-registry.
 * ────────────────────────────────────────────────────────────────────────── */

type DocKind = "QTN" | "PO" | "PI" | "CI" | "PL";
type DocFilter = "ALL" | DocKind;

const DOC_FILTERS: { key: DocFilter; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "QTN", label: "Quotation" },
  { key: "PO", label: "P/O" },
  { key: "PI", label: "PI" },
  { key: "CI", label: "CI" },
  { key: "PL", label: "PL" },
];
const DOC_KIND_LABEL: Record<DocKind, string> = { QTN: "Quotation", PO: "P/O", PI: "PI", CI: "CI", PL: "PL" };
const DOC_FILTER_KEY = "ktms:home-doc-filter";

type DocListRow = {
  key: string;
  kind: DocKind;
  date: string; // YYYY-MM-DD
  doc_no: string;
  customer: string;
  project_title: string;
  vessel: string;
  amount: number | null;
  currency: string;
  item_count: number | null;
  valid_until: string;
  status: string;
  expired: boolean;
  pic: string;
  rfq_id: number | null;
  order_id: number | null;
  /** PDF 받기 — 없으면 버튼 없음(P/O 는 고객이 보낸 문서라 우리 PDF 가 없다). */
  pdfUrl: string | null;
  fallback: string;
};

/** "26-08-03 12:00" / "2026-08-03T…" → "2026-08-03". */
function normDate(s: string): string {
  const v = (s || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const m = v.match(/^(\d{2})-(\d{2})-(\d{2})/);
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : v.slice(0, 10);
}

async function downloadPdf(url: string, fallback: string) {
  const token = getToken();
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { detail?: unknown };
    alert(typeof e.detail === "string" ? e.detail : `Download failed (${res.status})`);
    return;
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filenameFromDisposition(res, fallback);
  a.click();
  URL.revokeObjectURL(href);
}

// Documents 탭 — 2026-11 메뉴 재편으로 Projects 화면(/project?tab=documents)으로 옮겼다.
export function HomeTab() {
  const router = useRouter();
  // 프로젝트 개요 페이지도 같은 목록으로 견적 id 를 찾으므로 캐시 키를 공유한다.
  const { data: qtn, refresh: refreshQtn } = useCachedData("quotations:overview", () => fetchQuotationOverview());
  const { data: pipeline, refresh: refreshPipeline } = useCachedData("pipeline", () => fetchPipeline());
  // 고객 P/O 수신 현황 — 열람 권한이 있을 때만 로드(없으면 버튼 미표시).
  const canPo = can("po", "view");
  const { data: po } = useCachedData(
    "po:overview",
    () => (canPo ? fetchPoOverview() : Promise.resolve(null)),
  );
  const { data: reg, error: regError, refresh: refreshReg } = useCachedData("documents:registry", fetchDocumentsRegistry);
  // 프로젝트 상세 팝업(Progress 화면과 동일한 모달)용 — 편집 셀렉터에 쓰는 고객사·선박 목록.
  const { data: vessels } = useCachedData("settings:vessels", fetchSettingsVessels);
  const { data: customers } = useCachedData("settings:customers", fetchCustomers);

  // 고른 문서 종류 — 기본 All, 마지막 선택은 브라우저에 기억.
  const [filter, setFilter] = useState<DocFilter>("ALL");
  useEffect(() => {
    try {
      const v = localStorage.getItem(DOC_FILTER_KEY) as DocFilter | null;
      if (v && DOC_FILTERS.some((f) => f.key === v)) setFilter(v);
    } catch {
      /* ignore */
    }
  }, []);
  function pick(f: DocFilter) {
    setFilter(f);
    try {
      localStorage.setItem(DOC_FILTER_KEY, f);
    } catch {
      /* ignore */
    }
  }

  // 목록 행 클릭 → Progress 화면과 동일한 상세 팝업. rfq_id 만 보관하고 최신
  // 파이프라인에서 행을 다시 찾는다(모달 내 편집/삭제가 즉시 반영되도록).
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

  function openRow(r: DocListRow) {
    const viaOrder = r.order_id ? byOrderId.get(r.order_id) : undefined;
    if (viaOrder) setOpenRfqId(viaOrder.rfq_id);
    else if (r.rfq_id && byRfqId.has(r.rfq_id)) setOpenRfqId(r.rfq_id);
    else router.push(r.fallback);
  }

  // 팝업의 ← → — Projects 화면과 같은 프로젝트 번호순으로 넘긴다(양 끝에서 순환).
  const navOrder = useMemo(() => [...pipeRows].sort(byProjectNo).map((r) => r.rfq_id), [pipeRows]);
  function navigateProject(dir: -1 | 1) {
    setOpenRfqId((cur) => {
      if (cur == null || !navOrder.length) return cur;
      const idx = navOrder.indexOf(cur);
      if (idx < 0) return cur;
      const n = navOrder.length;
      return navOrder[(((idx + dir) % n) + n) % n];
    });
  }

  async function reloadAfterProjectEdit() {
    invalidateCache("dashboard");
    await Promise.all([refreshPipeline(), refreshQtn(), refreshReg()]);
  }

  // ── 문서 종류별 행을 한 모양으로 ───────────────────────────────────────
  const allRows = useMemo<DocListRow[]>(() => {
    const t = today();
    const openQuote = new Set(["초안", "발송완료", "협상중"]); // 미확정 상태만 만료 대상
    const out: DocListRow[] = [];
    for (const q of qtn?.rows ?? []) {
      const expired = !!q.valid_until && q.valid_until.slice(0, 10) < t && openQuote.has(q.status);
      out.push({
        key: `qtn-${q.id}`,
        kind: "QTN",
        date: normDate(q.sent_date || q.date || ""),
        doc_no: q.qtn_no || "",
        customer: q.customer || "",
        project_title: q.project_title || "",
        vessel: q.vessel || "",
        amount: q.amount,
        currency: q.currency,
        item_count: q.item_count ?? null,
        valid_until: (q.valid_until || "").slice(0, 10),
        status: expired ? "Expired" : tr(q.status),
        expired,
        pic: q.assignee || "",
        rfq_id: q.rfq_id || null,
        order_id: null,
        pdfUrl: quotationPdfUrl(q.id, "quotation"),
        fallback: q.rfq_id ? `/project?rfq=${q.rfq_id}&stage=4` : "/project",
      });
    }
    if (canPo) {
      // P/O 수신 = 주문(Order)이 생성된 건만(id>0). RFQ 단계뿐인 건은 제외.
      for (const p of (po?.rows ?? []).filter((r) => r.id > 0)) {
        const pr = byOrderId.get(p.id);
        out.push({
          key: `po-${p.id}`,
          kind: "PO",
          date: normDate(p.customer_po_at || ""),
          doc_no: p.customer_po_no || "",
          customer: p.customer || "",
          project_title: p.project_title || "",
          vessel: p.vessel || "",
          amount: null,
          currency: "",
          item_count: p.item_count,
          valid_until: "",
          status: tr(p.status),
          expired: false,
          pic: pr?.assignee || "",
          rfq_id: pr?.rfq_id ?? null,
          order_id: p.id,
          pdfUrl: null,
          fallback: `/project?order=${p.id}&stage=5`,
        });
      }
    }
    for (const d of reg?.rows ?? []) {
      const kind = d.type;
      const target = d.order_id ? { orderId: d.order_id } : d.rfq_id ? { rfqId: d.rfq_id } : null;
      const pdfKind = kind === "PI" ? "pi/pdf" : kind === "CI" ? "ci/pdf" : "pl/pdf";
      out.push({
        key: d.key,
        kind,
        date: normDate(d.date),
        doc_no: d.doc_no,
        customer: d.customer,
        project_title: d.project_title,
        vessel: d.vessel,
        amount: d.amount,
        currency: d.currency,
        item_count: d.item_count,
        valid_until: "",
        status: "",
        expired: false,
        pic: d.assignee,
        rfq_id: d.rfq_id,
        order_id: d.order_id,
        // 프로젝트에만 붙은 PI 는 /projects/{rfq}/pi/pdf, 나머지는 오더 기준.
        pdfUrl: target && (kind === "PI" || "orderId" in target) ? documentDownloadUrl(target, pdfKind) : null,
        fallback: d.order_id ? `/project?order=${d.order_id}&stage=7` : d.rfq_id ? `/project?rfq=${d.rfq_id}` : "/project",
      });
    }
    return out;
  }, [qtn, po, reg, canPo, byOrderId]);

  const counts = useMemo(() => {
    const c: Record<DocFilter, number> = { ALL: allRows.length, QTN: 0, PO: 0, PI: 0, CI: 0, PL: 0 };
    for (const r of allRows) c[r.kind] += 1;
    return c;
  }, [allRows]);
  const rows = useMemo(() => (filter === "ALL" ? allRows : allRows.filter((r) => r.kind === filter)), [allRows, filter]);
  // PI·CI·PL 조회가 실패해도 견적·P/O 는 보여 준다(그 경우 해당 버튼 건수 0).
  const loading = !qtn || (!reg && !regError) || (canPo && !po);

  // ── 컬럼 — 종류마다 의미 있는 칸만 ──────────────────────────────────────
  const columns = useMemo<ColumnDef<DocListRow>[]>(() => {
    const c: Record<string, ColumnDef<DocListRow>> = {
      kind: {
        key: "kind", label: "Type", filter: "facet",
        text: (r) => DOC_KIND_LABEL[r.kind],
        facetOrder: ["Quotation", "P/O", "PI", "CI", "PL"],
        render: (r) => <span className={`doc-kind doc-kind-${r.kind.toLowerCase()}`}>{DOC_KIND_LABEL[r.kind]}</span>,
      },
      date: { key: "date", label: filter === "PO" ? "Received" : "Date", text: (r) => r.date, filter: "date" },
      doc_no: { key: "doc_no", label: filter === "PO" ? "PO No." : "Doc No.", text: (r) => r.doc_no || "—" },
      customer: { key: "customer", label: "Customer", filter: "facet", text: (r) => r.customer, render: (r) => <CustomerName name={r.customer} /> },
      project: { key: "project", label: "Project", text: (r) => r.project_title },
      vessel: { key: "vessel", label: "Vessel", text: (r) => r.vessel },
      amount: {
        key: "amount", label: "Amount", numeric: true,
        text: (r) => (r.amount == null ? "" : dualCurrencyText(r.amount, r.currency)),
        render: (r) => (r.amount == null ? <span className="muted">—</span> : <DualCurrencyAmount value={r.amount} currency={r.currency} />),
        sortValue: (r) => r.amount ?? -1,
      },
      items: { key: "items", label: "Items", numeric: true, text: (r) => (r.item_count == null ? "" : String(r.item_count)), sortValue: (r) => r.item_count ?? -1 },
      valid_until: { key: "valid_until", label: "Valid until", text: (r) => r.valid_until, filter: "date" },
      status: {
        key: "status", label: "Status", filter: "facet", text: (r) => r.status,
        render: (r) => (r.status ? <span className={`ar-badge${r.expired ? " overdue" : ""}`}>{r.status}</span> : null),
      },
      pic: { key: "pic", label: "PIC", filter: "facet", text: (r) => r.pic },
      file: {
        key: "file", label: "File", text: () => "",
        render: (r) =>
          r.pdfUrl && canDownload() ? (
            <button
              className="btn sm"
              onClick={(e) => {
                e.stopPropagation();
                void downloadPdf(r.pdfUrl!, `${r.doc_no || r.kind}.pdf`);
              }}
            >
              PDF
            </button>
          ) : null,
      },
    };
    const keys: Record<DocFilter, string[]> = {
      ALL: ["kind", "date", "doc_no", "customer", "project", "vessel", "amount", "status", "pic", "file"],
      QTN: ["date", "doc_no", "customer", "project", "vessel", "amount", "items", "valid_until", "status", "pic", "file"],
      PO: ["date", "doc_no", "customer", "project", "vessel", "items", "status", "pic"],
      PI: ["date", "doc_no", "customer", "project", "vessel", "amount", "items", "pic", "file"],
      CI: ["date", "doc_no", "customer", "project", "vessel", "amount", "items", "pic", "file"],
      PL: ["date", "doc_no", "customer", "project", "vessel", "items", "pic", "file"],
    };
    return keys[filter].map((k) => c[k]);
  }, [filter]);

  const filters = DOC_FILTERS.filter((f) => f.key !== "PO" || canPo);
  // Briefing 탭과 같은 칩(mail-chip). 표 도구줄 왼쪽에 넣어 Columns 와 한 줄에 둔다.
  const chips = (
    <span className="brief-chips">
      {filters.map((f) => (
        <button
          key={f.key}
          type="button"
          className={`mail-chip${filter === f.key ? " on" : ""}`}
          onClick={() => pick(f.key)}
        >
          {f.label}
          {loading ? null : <b>{counts[f.key]}</b>}
        </button>
      ))}
    </span>
  );

  return (
    <div className="docs-board">

      {regError ? <div className="state error">PI·CI·PL list failed to load: {String(regError)}</div> : null}
      {loading ? (
        <>
          <div className="pl-toolbar">
            <span className="pl-toolbar-left">{chips}</span>
          </div>
          <div className="state">Loading…</div>
        </>
      ) : (
        <FilterTable
          key={filter}
          tableId={`home-docs-${filter.toLowerCase()}`}
          rows={rows}
          columns={columns}
          getRowKey={(r) => r.key}
          defaultSortKey="date"
          defaultSortDir="desc"
          rowClassName={(r) => (r.expired ? "danger" : "")}
          onRowClick={openRow}
          scrollBody
          leftActions={chips}
          empty="No documents yet."
        />
      )}

      {openProject ? (
        <PipelineModal
          r={openProject}
          steps={steps}
          customers={customers ?? []}
          vessels={vessels ?? []}
          onChanged={reloadAfterProjectEdit}
          onNavigate={navigateProject}
          onClose={() => setOpenRfqId(null)}
        />
      ) : null}
    </div>
  );
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

/* 통계 탭 통화 버킷 — 원통화 둘 + KRW 환산 합계.
   "KRW 환산"은 USD 실적을 매매기준율로 옮겨 KRW 실적과 더한 값이다. 두 통화로 갈린 실적을
   한쪽만 보면 그 달이 반쪽으로 보여서, 합계를 한 숫자로 읽을 자리를 따로 둔다.
   라벨(=사람에게 보일 이름)과 단위(=금액 앞에 붙는 통화)가 달라 둘을 나눠 쓴다. */
const STAT_CUR_KEYS: StatCurKey[] = ["USD", "KRW", "KRWC"];
const curLabel = (c: StatCurKey) => (c === "KRWC" ? "KRW conv." : c);
const curUnit = (c: StatCurKey): CurrencyKey => (c === "KRWC" ? "KRW" : c);

/* 통화별 금액 포맷 — KRW 는 정수, USD 는 정수(대시보드 요약용). */
function fmtMoney(cur: StatCurKey, n: number): string {
  return `${curUnit(cur)} ${Math.round(n).toLocaleString()}`;
}

/* 전월 대비 증감 꼬리표. prev=0 이면 표시 안 함. */
function DeltaChip({ cur, prev, label = "vs previous month", invert = false }: { cur: number; prev: number; label?: string; invert?: boolean }) {
  if (!prev) return null;
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  const up = pct >= 0;
  // invert: 작을수록 좋은 값(걸린 날) — 줄면 초록.
  const good = invert ? !up : up;
  return (
    <span className={`stat-delta ${good ? "up" : "down"}`} title={label}>
      {up ? "▲" : "▼"}{Math.abs(Math.round(pct))}%
    </span>
  );
}

type PeriodType = "M" | "Q" | "Y";
/** 근거 목록 — 숫자를 만든 딜들. */
type Drill = {
  key: string;
  title: string;
  rows: { rfq_id: number; no: string; customer: string; date: string; value: string; note: string }[];
};
/* 속도 지표 — 두 단계 완료 일시 사이 걸린 날(중앙값). */
const SPEEDS = [
  { key: "quote", label: "Quote Turnaround", from: 1, to: 4, tip: "RFQ received → quotation sent to the customer" },
  { key: "vendor", label: "Vendor Reply", from: 2, to: 3, tip: "RFQ sent to vendors → first vendor quote received" },
  { key: "cycle", label: "Sales Cycle", from: 1, to: 5, tip: "RFQ received → customer P/O" },
  { key: "collect", label: "Collection", from: 9, to: 10, tip: "Billed → payment completed" },
] as const;
/** a..b(포함) 정수 목록. */
function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

const MG_TABS = ["won", "quoted", "lost"] as const;
type MgTab = (typeof MG_TABS)[number];

// 통계 차트 공통 — 옅은 가로 격자 · 작은 축 글씨.
const GRID = "#eef1f5";
const AXIS_TICK = { fontSize: 10.5, fill: "#6b7686" };

// 파이프라인 4개 중분류(phase) 순서형 파랑 램프(light→dark) — dataviz 검증 통과.
// 단계는 순서형이므로 임의 카테고리색이 아니라 단일 색조 심도로 진행감을 준다.
const PHASE_RAMP = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#0d366b"];
const PHASE_LABELS = ["RFQ", "Quote", "P/O", "Documents", "AR"];
const PHASE_BOUNDS = [2, 4, 6, 8, 10]; // 각 phase 의 단계 상한(누적): 1–2 / 3–4 / 5–6 / 7–8 / 9–10
/** 1-based 단계 번호 → phase 인덱스(0..3). */
function phaseOfStage(stage: number): number {
  const i = PHASE_BOUNDS.findIndex((b) => stage <= b);
  return i < 0 ? PHASE_BOUNDS.length - 1 : i;
}

function StatisticsTab() {
  const { data, error } = useCachedData("dashboard", fetchDashboard);
  const { data: stat } = useCachedData("statistics", () => fetchStatistics(12));
  // 단계별 완료 일시·종결 사유는 파이프라인 목록에 이미 있다(같은 캐시를 Projects 화면과 나눠 쓴다).
  const { data: pipe } = useCachedData("pipeline", () => fetchPipeline());
  const [cur, setCur] = useState<StatCurKey>("USD");
  // 금액 KPI 월 이동 — null 이면 최신(이번 달). 절대 인덱스로 저장하고 로드 후 clamp.
  const [monthIdx, setMonthIdx] = useState<number | null>(null);
  // 관리자 전용 금액 KPI 감사 패널(행 단위 내역). 필요할 때만 온디맨드 로드.
  const [audit, setAudit] = useState<StatDebugData | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditErr, setAuditErr] = useState<string | null>(null);
  // RFQ 차트 아래 선택 월 RFQ 목록 펼침 여부(막대 클릭 시 열림).
  const [rfqListOpen, setRfqListOpen] = useState(false);
  // 프로젝트 마진 표 탭.
  const [mgTab, setMgTab] = useState<MgTab>("won");
  // 기간 단위(월·분기·올해) · 비교 기준(직전 기간 / 작년 같은 기간). 화면 전체가 이 기간을 따른다.
  const [ptype, setPtype] = useState<PeriodType>(() => {
    try { const v = localStorage.getItem("ktms:stat-period"); return v === "Q" || v === "Y" ? v : "M"; } catch { return "M"; }
  });
  const [cmpMode, setCmpMode] = useState<"prev" | "yoy">("prev");
  // 숫자를 누르면 그 숫자를 만든 딜 목록(근거)을 연다 — 같은 칸을 다시 누르면 닫힌다.
  const [drill, setDrill] = useState<Drill | null>(null);
  const toggleDrill = (d: Drill) => setDrill((cur) => (cur?.key === d.key ? null : d));
  // Top Items 보기 — 대분류별 / 품목별. 펼친 대분류.
  const [itemView, setItemView] = useState<"cat" | "item">("cat");
  const [openCat, setOpenCat] = useState<string | null>(null);
  // 고객 구성 카드 — 선주 / ISM 관리사.
  const [mixBy, setMixBy] = useState<"owner" | "manager">("owner");
  useEffect(() => { try { localStorage.setItem("ktms:stat-period", ptype); } catch { /* 저장 못 해도 화면은 동작 */ } }, [ptype]);
  const router = useRouter();

  if (error && !data) {
    return <div className="state error">API error: {error.message}</div>;
  }
  if (!data || !stat) {
    return <div className="state">Loading…</div>;
  }

  const { ops } = data;
  // 선택 월 인덱스(기본 이번 달) — 금액 KPI 3종은 월별 시계열에서 직접 뽑는다.
  // 그래프 축은 1~12월이라 마지막 칸이 12월(미래)이다. KPI 는 아직 오지 않은 달로
  // 넘어가지 않게 '이번 달'을 오른쪽 끝으로 삼는다.
  const curIdx = stat.current_month ? stat.months.indexOf(stat.current_month) : -1;
  const lastIdx = curIdx >= 0 ? curIdx : stat.months.length - 1;
  const idx = monthIdx == null ? lastIdx : Math.min(Math.max(monthIdx, 0), lastIdx);
  const selMonth = stat.months[idx];
  const isCurMonth = idx === lastIdx;
  // ── 기간 — 선택 월(idx)이 끝나는 달. 분기는 그 달이 속한 분기의 시작~idx, 올해는 1월~idx.
  const qStart = Math.floor(idx / 3) * 3;
  const pIdx: number[] = ptype === "M" ? [idx]
    : ptype === "Q" ? range(qStart, idx)
    : range(0, idx);
  // 비교 기간 — 직전 기간(같은 길이로 바로 앞) 또는 작년 같은 달들.
  const cmpYoy = cmpMode === "yoy" || ptype === "Y";
  const cIdx: number[] = cmpYoy ? pIdx
    : ptype === "M" ? (idx > 0 ? [idx - 1] : [])
    : (qStart >= 3 ? range(qStart - 3, qStart - 3 + (idx - qStart)) : []);
  const prevY = stat.prev_year;
  const hasPrevYear = !!prevY && [prevY.series.revenue.USD, prevY.series.revenue.KRW, prevY.series.order.USD, prevY.series.order.KRW, prevY.rfq_count]
    .some((arr) => arr.some((v) => v));
  const mm = (i: number) => stat.months[i]?.slice(5) ?? "";
  const periodLabel = ptype === "M" ? selMonth
    : ptype === "Q" ? `${selMonth.slice(0, 4)} Q${Math.floor(idx / 3) + 1}${idx - qStart < 2 ? ` (${mm(qStart)}–${mm(idx)})` : ""}`
    : `${selMonth.slice(0, 4)} YTD (01–${mm(idx)})`;
  const cmpLabel = cmpYoy ? "vs same period last year" : ptype === "M" ? "vs previous month" : "vs previous quarter (same length)";
  const sumOf = (arr: number[] | undefined, ix: number[]) => ix.reduce((t, i) => t + (arr?.[i] ?? 0), 0);
  const sparkOf = (arr: number[]) => arr.slice(0, lastIdx + 1);
  const pSum = (metric: "revenue" | "quote" | "order") => sumOf(stat.series[metric][cur], pIdx);
  const cSum = (metric: "revenue" | "quote" | "order") =>
    cmpYoy ? (hasPrevYear ? sumOf(prevY?.series[metric][cur], cIdx) : 0) : sumOf(stat.series[metric][cur], cIdx);
  const mRevenue = pSum("revenue"), mRevenuePrev = cSum("revenue");
  const mOrder = pSum("order"), mOrderPrev = cSum("order");
  const mQuote = pSum("quote"), mQuotePrev = cSum("quote");
  const pMonths = new Set(pIdx.map((i) => stat.months[i]));
  const cMonths = new Set(cmpYoy ? [] : cIdx.map((i) => stat.months[i]));
  const inP = (d: string) => pMonths.has((d || "").slice(0, 7));
  const inC = (d: string) => cMonths.has((d || "").slice(0, 7));

  // 차트 데이터 변환 ---------------------------------------------------------
  const monthLabel = (m: string) => m.slice(2); // "2026-07" → "26-07"
  // 축은 1~12월 전체지만, 아직 오지 않은 달은 0 이 아니라 "값 없음"(null)으로 둔다.
  // 0 으로 그리면 추이선이 연말까지 바닥을 기어 실적이 떨어진 것처럼 보인다.
  const future = (i: number) => lastIdx >= 0 && i > lastIdx;
  // 금액 추이 한 장 — Quoted·Won 막대 + Revenue 선(따로 있던 두 차트를 합침).
  const moneyTrend = stat.months.map((m, i) => ({
    month: monthLabel(m),
    quote: future(i) ? null : stat.series.quote[cur][i],
    order: future(i) ? null : stat.series.order[cur][i],
    revenue: future(i) ? null : stat.series.revenue[cur][i],
  }));
  // 선택 월을 추이 차트에 띠로 칠해 위 숫자와 같은 달을 가리킨다. 칸을 누르면 그 달로 이동.
  const selLabel = monthLabel(selMonth);
  const selFrom = monthLabel(stat.months[pIdx[0]]);
  const pickMonth = (s: { activeTooltipIndex?: number | string | null } | null | undefined) => {
    const i = Number(s?.activeTooltipIndex);
    if (s?.activeTooltipIndex != null && Number.isFinite(i) && i >= 0 && i <= lastIdx) setMonthIdx(i);
  };
  const mRfq = sumOf(stat.rfq_count, pIdx);
  const mRfqPrev = cmpYoy ? (hasPrevYear ? sumOf(prevY?.rfq_count, cIdx) : 0) : sumOf(stat.rfq_count, cIdx);
  const arOut = data.kpi.ar_outstanding?.[cur] ?? (cur === "USD" ? data.kpi.ar_outstanding_usd : 0);
  // 고객·품목 순위 — 고른 기간의 달만 더해 다시 센다(옛 서버는 연간 합계만 준다 → 그대로 씀).
  const fxConv = stat.fx?.rate || stat.usd_krw_rate;
  const inCur = (usd: number, krw: number) => (cur === "USD" ? usd : cur === "KRW" ? krw : krw + usd * fxConv);
  const custTop = (() => {
    const cm = stat.customer_month;
    if (!cm) return stat.customer_top[cur].map((r) => ({ name: r.name, amount: r.amount }));
    const names = new Set([...Object.keys(cm.USD || {}), ...Object.keys(cm.KRW || {})]);
    const rows = [...names].map((n) => ({ name: n, amount: inCur(sumOf(cm.USD?.[n], pIdx), sumOf(cm.KRW?.[n], pIdx)) }))
      .filter((r) => r.amount > 0).sort((x, y) => y.amount - x.amount);
    for (const n of stat.customer_pad ?? []) {
      if (rows.length >= 10) break;
      if (!rows.some((r) => r.name === n)) rows.push({ name: n, amount: 0 });
    }
    return rows.slice(0, 10);
  })();
  const itemTop = (() => {
    const im = stat.item_month;
    const label = (pn: string, d: string) => pn + (d ? ` · ${d.slice(0, 20)}` : "");
    if (!im) return stat.item_top[cur].map((r) => ({ name: label(r.part_no, r.description), amount: r.amount }));
    const acc = new Map<string, { name: string; usd: number; krw: number }>();
    for (const c of ["USD", "KRW"] as const) {
      for (const r of im[c] || []) {
        const e = acc.get(r.part_no) ?? { name: label(r.part_no, r.description), usd: 0, krw: 0 };
        if (c === "USD") e.usd += sumOf(r.m, pIdx); else e.krw += sumOf(r.m, pIdx);
        acc.set(r.part_no, e);
      }
    }
    return [...acc.values()].map((e) => ({ name: e.name, amount: inCur(e.usd, e.krw) }))
      .filter((r) => r.amount > 0).sort((x, y) => y.amount - x.amount).slice(0, 10);
  })();
  // 대분류별 매출 — 품목 마스터의 분류(대분류). 분류가 없는 품번은 Unclassified 로 묶는다.
  const catTop = (() => {
    const im = stat.item_month;
    if (!im) return [];
    const acc = new Map<string, { usd: number; krw: number; items: Map<string, { name: string; usd: number; krw: number }> }>();
    for (const c of ["USD", "KRW"] as const) {
      for (const r of im[c] || []) {
        const v = sumOf(r.m, pIdx);
        if (!v) continue;
        const cat = r.category || "Unclassified";
        const e = acc.get(cat) ?? { usd: 0, krw: 0, items: new Map() };
        const it = e.items.get(r.part_no) ?? { name: r.part_no + (r.description ? ` · ${r.description.slice(0, 30)}` : ""), usd: 0, krw: 0 };
        if (c === "USD") { e.usd += v; it.usd += v; } else { e.krw += v; it.krw += v; }
        e.items.set(r.part_no, it);
        acc.set(cat, e);
      }
    }
    return [...acc.entries()].map(([cat, e]) => ({
      cat, amount: inCur(e.usd, e.krw),
      items: [...e.items.values()].map((it) => ({ name: it.name, amount: inCur(it.usd, it.krw) })).sort((x, y) => y.amount - x.amount),
    })).sort((x, y) => (x.cat === "Unclassified" ? 1 : y.cat === "Unclassified" ? -1 : y.amount - x.amount));
  })();
  const catTotal = catTop.reduce((t, c) => t + c.amount, 0);
  const catMax = Math.max(1, ...catTop.map((c) => c.amount));
  const itemMax = Math.max(1, ...itemTop.map((c) => c.amount));

  // 축약 표기 한 가지 — 1천 미만 정수, 1만 미만 K 소수 1자리, 1백만 미만 K 정수, 그 위 M 소수 1자리.
  // ("950" 옆에 "8K" 가 서면 자릿수가 달라 보여 비교가 안 됐다.) 정확한 금액은 마우스를 올려 본다.
  const compact = (n: number) => {
    const a = Math.abs(n);
    if (a >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (a >= 10_000) return `${Math.round(n / 1_000)}K`;
    if (a >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
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
  // 월간 RFQ 수신 그래프 — 축은 months(올해 1~12월). 수신 없는 달은 0으로 비운다.
  const rfqData = stat.months.map((m, i) => ({
    month: monthLabel(m), count: stat.rfq_count[i] || 0, detail: stat.rfq_detail[i] || [],
    quote: future(i) ? null : stat.series.quote[cur][i],
  }));
  const selRfqs = pIdx.flatMap((i) => stat.rfq_detail[i] || []).sort((x, y) => (x.date < y.date ? 1 : -1));
  // 프로젝트 마진은 USD 로 정규화돼 오므로 화면 통화로 되돌린다. 'KRW 환산'은 서버가
  // 실제로 쓴 매매기준율(stat.fx)을 그대로 써야 KPI·랭킹과 같은 환율 위에 선다.
  const fxRate = cur === "KRWC" ? (stat.fx?.rate || stat.usd_krw_rate) : stat.usd_krw_rate;
  const toCur = (usd: number) => (cur === "USD" ? usd : usd * fxRate);
  // 프로젝트 마진 표 — 탭별 줄. 매입 미확정(발주 전) 건은 합계에서 뺀다.
  const mgRowsOf = (k: MgTab) =>
    (k === "won" ? stat.won_margin
      : stat.quoted_margin.rows.filter((r) => (k === "lost" ? r.status === "Lost" : r.status === "Open")))
      .filter((r) => inP(r.date));
  // 매출총이익(수주 건, 발주 확정분) — 고른 기간·비교 기간.
  const gp = (rows: typeof stat.won_margin) => {
    const done = rows.filter((w) => w.margin_usd != null);
    const sales = done.reduce((t, w) => t + w.sales_usd, 0);
    const margin = done.reduce((t, w) => t + (w.margin_usd ?? 0), 0);
    return { sales, margin, pct: sales ? Math.round((margin / sales) * 1000) / 10 : null, n: done.length };
  };
  const gpNow = gp(stat.won_margin.filter((w) => inP(w.date)));
  const gpPrev = cmpYoy ? null : gp(stat.won_margin.filter((w) => inC(w.date)));
  // 고른 기간의 퍼널 — 그 기간에 받은 RFQ 가 어디까지 갔나(rfq_detail 의 진행 상태).
  const pRfqRows = pIdx.flatMap((i) => stat.rfq_detail[i] || []);
  const fRfq = pRfqRows.length;
  const fQuote = pRfqRows.filter((d) => d.status !== "Open").length;
  const fPo = pRfqRows.filter((d) => d.status === "PO" || d.status === "Invoiced").length;
  const fRev = pRfqRows.filter((d) => d.status === "Invoiced").length;
  const pct1 = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const winRate = fQuote ? pct1(fPo, fQuote) : null;
  // 진행 중 견적(Open) — 지금 기준 전체(기간 무관).
  const openQuotes = stat.quoted_margin.rows.filter((r) => r.status === "Open");
  const openPipeline = openQuotes.reduce((t, r) => t + r.sales_usd, 0);

  // ── 2차: 속도 · 실주 사유 · 수주율 ───────────────────────────────────────────
  const prow = pipe?.rows ?? [];
  // 단계 사이 걸린 날(소수 1자리). 끝 단계가 고른 기간 안에 있는 딜만 센다.
  const daysBetween = (a: string, b: string) => {
    const t1 = Date.parse(a.length > 10 ? a : `${a}T00:00`), t2 = Date.parse(b.length > 10 ? b : `${b}T00:00`);
    return Number.isFinite(t1) && Number.isFinite(t2) ? (t2 - t1) / 86_400_000 : NaN;
  };
  const median = (xs: number[]) => {
    if (!xs.length) return null;
    const v = [...xs].sort((x, y) => x - y);
    const m = Math.floor(v.length / 2);
    return Math.round((v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2) * 10) / 10;
  };
  const speedOf = (from: number, to: number, keep: (d: string) => boolean) => {
    const xs: number[] = [];
    const rows: { r: (typeof prow)[number]; d: number; end: string }[] = [];
    for (const r of prow) {
      const a = stageDateOf(r, from), b = stageDateOf(r, to);
      if (!a || !b || !keep(b)) continue;
      const d = daysBetween(a, b);
      if (Number.isFinite(d) && d >= 0) { xs.push(d); rows.push({ r, d, end: b }); }
    }
    return { med: median(xs), n: xs.length, rows: rows.sort((x, y) => y.d - x.d) };
  };
  const speeds = SPEEDS.map((sp) => ({
    ...sp,
    now: speedOf(sp.from, sp.to, inP),
    prev: cmpYoy ? null : speedOf(sp.from, sp.to, inC),
  }));
  // 실주 사유 — 고른 기간에 닫은 딜. 한 딜이 여러 갈래면 갈래마다 센다(합계는 딜 수).
  const lostValue = new Map(stat.quoted_margin.rows.filter((r) => r.status === "Lost").map((r) => [r.rfq_id, r.sales_usd]));
  const lostDeals = prow.filter((r) => r.cancelled && r.closed_at && inP(r.closed_at));
  const lostByCode = new Map<string, { n: number; usd: number; cust: Map<string, number> }>();
  for (const r of lostDeals) {
    const codes = closeReasonCodes(r.close_reason);
    for (const c of codes.length ? codes : ["(none)"]) {
      const e = lostByCode.get(c) ?? { n: 0, usd: 0, cust: new Map() };
      e.n += 1;
      e.usd += lostValue.get(r.rfq_id) ?? 0;
      e.cust.set(r.customer || "—", (e.cust.get(r.customer || "—") ?? 0) + 1);
      lostByCode.set(c, e);
    }
  }
  const lostRows = [...lostByCode.entries()].map(([code, e]) => ({ code, ...e })).sort((x, y) => y.n - x.n || y.usd - x.usd);
  const lostMax = Math.max(1, ...lostRows.map((r) => r.n));
  const lostUsd = lostDeals.reduce((t, r) => t + (lostValue.get(r.rfq_id) ?? 0), 0);
  // 월별 수주율 — 건수(그 달에 받은 RFQ 중 견적 낸 것 → P/O) · 금액(그 달 수주 ÷ 그 달 견적).
  const winTrend = stat.months.map((m, i) => {
    if (future(i)) return { month: monthLabel(m), cnt: null, val: null };
    const rows = stat.rfq_detail[i] || [];
    const q = rows.filter((d) => d.status !== "Open").length;
    const w = rows.filter((d) => d.status === "PO" || d.status === "Invoiced").length;
    const qv = stat.series.quote[cur][i], ov = stat.series.order[cur][i];
    return { month: monthLabel(m), cnt: q ? pct1(w, q) : null, val: qv ? pct1(ov, qv) : null };
  });
  // 고객별 수주율 — 고른 기간에 RFQ 를 준 고객, RFQ 수 순.
  const cancelledIds = new Set(prow.filter((r) => r.cancelled).map((r) => r.rfq_id));
  const custWin = (() => {
    const m = new Map<string, { rfq: number; quoted: number; won: number; lost: number }>();
    for (const d of pRfqRows) {
      const e = m.get(d.customer) ?? { rfq: 0, quoted: 0, won: 0, lost: 0 };
      e.rfq += 1;
      if (d.status !== "Open") e.quoted += 1;
      if (d.status === "PO" || d.status === "Invoiced") e.won += 1;
      else if (cancelledIds.has(d.rfq_id)) e.lost += 1;
      m.set(d.customer, e);
    }
    return [...m.entries()].map(([name, e]) => ({ name, ...e, rate: e.quoted ? pct1(e.won, e.quoted) : null }))
      .sort((x, y) => y.rfq - x.rfq || y.won - x.won).slice(0, 10);
  })();
  // Top 10 고객 표 — 매출(기간) · 비중 · 누적 · 수주 건 마진(기간에 수주한 건).
  const wonInP = stat.won_margin.filter((w) => inP(w.date));
  const revTotal = (() => {
    const cm = stat.customer_month;
    if (!cm) return custTop.reduce((t, r) => t + r.amount, 0);
    const names = new Set([...Object.keys(cm.USD || {}), ...Object.keys(cm.KRW || {})]);
    return [...names].reduce((t, n) => t + inCur(sumOf(cm.USD?.[n], pIdx), sumOf(cm.KRW?.[n], pIdx)), 0);
  })();
  let cum = 0;
  const custRows = custTop.map((c) => {
    const won = wonInP.filter((w) => w.customer === c.name);
    const g = gp(won);
    cum += c.amount;
    return {
      ...c,
      share: revTotal ? Math.round((c.amount / revTotal) * 1000) / 10 : 0,
      cum: revTotal ? Math.round((cum / revTotal) * 1000) / 10 : 0,
      deals: won.length, margin: g.margin, gm: g.pct, won,
    };
  });
  const custMax = Math.max(1, ...custRows.map((c) => c.amount));
  // 단계별 딜 — 지금 각 단계에 머문 딜 수 · 금액 · 그 단계에 머문 날(중앙값) · 30일 넘은 딜.
  // 금액: 견적 단계(1~4)는 진행 중 견적, 그 뒤는 수주 금액(USD 기준 → 화면 통화).
  const openQ = new Map(openQuotes.map((r) => [r.rfq_id, r.sales_usd]));
  const wonV = new Map(stat.won_margin.map((r) => [r.rfq_id, r.sales_usd]));
  const nowMs = Date.now();
  const stageTable = (data.steps || []).map((label, i) => {
    const no = i + 1;
    const deals = prow.filter((r) => !r.cancelled && r.stage === no).map((r) => {
      const since = stageDateOf(r, no);
      const t = since ? Date.parse(since.length > 10 ? since : `${since}T00:00`) : NaN;
      const days = Number.isFinite(t) ? Math.max(0, Math.floor((nowMs - t) / 86_400_000)) : null;
      const usd = (no <= 4 ? openQ.get(r.rfq_id) : wonV.get(r.rfq_id)) ?? 0;
      return { r, days, usd };
    });
    const ds = deals.map((d) => d.days).filter((d): d is number => d != null);
    return {
      no, label, phase: phaseOfStage(no), deals,
      usd: deals.reduce((t, d) => t + d.usd, 0),
      med: no === (data.steps || []).length ? null : median(ds),
      stale: no === (data.steps || []).length ? 0 : ds.filter((d) => d > 30).length,
    };
  });
  const stageMax = Math.max(1, ...stageTable.map((r) => r.deals.length));

  // ── 4차: 미수금 구간 · 담당자 · 벤더 · 고객 구성 ─────────────────────────────────
  // 미수금 구간 — 만기 경과일(오늘 기준). 금액은 화면 통화로(KRW 환산은 USD×환율).
  const arAmt = (a: { currency: string; outstanding: number }) =>
    cur === "USD" ? (a.currency === "USD" ? a.outstanding : 0)
      : cur === "KRW" ? (a.currency === "KRW" ? a.outstanding : 0)
        : (a.currency === "KRW" ? a.outstanding : a.outstanding * fxConv);
  const todayMs = Date.now();
  const arRows = (stat.ar_open ?? []).map((a) => {
    const t = a.due_date ? Date.parse(`${a.due_date}T00:00`) : NaN;
    const over = Number.isFinite(t) ? Math.floor((todayMs - t) / 86_400_000) : null;
    return { ...a, over, amt: arAmt(a) };
  }).filter((a) => a.amt > 0);
  const AR_BUCKETS = [
    { key: "nd", label: "Not due", hit: (o: number | null) => o == null || o <= 0 },
    { key: "30", label: "1–30 days", hit: (o: number | null) => o != null && o >= 1 && o <= 30 },
    { key: "60", label: "31–60 days", hit: (o: number | null) => o != null && o >= 31 && o <= 60 },
    { key: "90", label: "61–90 days", hit: (o: number | null) => o != null && o >= 61 && o <= 90 },
    { key: "90p", label: "Over 90 days", hit: (o: number | null) => o != null && o > 90 },
  ];
  const arBuckets = AR_BUCKETS.map((b) => {
    const rows = arRows.filter((a) => b.hit(a.over));
    return { ...b, rows, amt: rows.reduce((t, a) => t + a.amt, 0) };
  });
  const arTotal = arBuckets.reduce((t, b) => t + b.amt, 0);
  const arMaxB = Math.max(1, ...arBuckets.map((b) => b.amt));
  // DSO — 지금 미수금 ÷ 최근 3개월 매출 × 90일(이번 달 포함).
  const rev90 = sumOf(stat.series.revenue[cur], range(Math.max(0, lastIdx - 2), lastIdx));
  const dso = rev90 > 0 ? Math.round((arOut / rev90) * 90) : null;

  // 담당자(PIC)별 — 고른 기간에 받은 RFQ 기준.
  const rowById = new Map(prow.map((r) => [r.rfq_id, r]));
  const picPerf = (() => {
    const m = new Map<string, { rfq: number; quoted: number; won: number; wonUsd: number; tat: number[] }>();
    const get = (k: string) => {
      const e = m.get(k) ?? { rfq: 0, quoted: 0, won: 0, wonUsd: 0, tat: [] };
      m.set(k, e);
      return e;
    };
    for (const d of pRfqRows) {
      const e = get(rowById.get(d.rfq_id)?.assignee || "—");
      e.rfq += 1;
      if (d.status !== "Open") e.quoted += 1;
      if (d.status === "PO" || d.status === "Invoiced") e.won += 1;
    }
    for (const w of wonInP) get(rowById.get(w.rfq_id)?.assignee || "—").wonUsd += w.sales_usd;
    for (const x of speeds[0].now.rows) get(x.r.assignee || "—").tat.push(x.d);
    return [...m.entries()].map(([pic, e]) => ({ pic, ...e, rate: e.quoted ? pct1(e.won, e.quoted) : null, tatMed: median(e.tat) }))
      .sort((x, y) => y.rfq - x.rfq || y.wonUsd - x.wonUsd);
  })();

  // 벤더별 — 고른 기간에 RFQ 를 보낸 건. 회신 = 그 발송 이후 같은 벤더의 견적 수신.
  const vendPerf = (() => {
    const m = new Map<string, { sent: number; replied: number; days: number[]; awarded: number; deals: Set<number> }>();
    for (const r of prow) {
      const awarded = (r.vendor || "").split(/[\n,]/).map((x) => x.trim().toUpperCase()).filter(Boolean);
      for (const snd of r.rfq_sends ?? []) {
        if (!snd.sent_at || !inP(snd.sent_at)) continue;
        const key = (snd.vendor || "—").trim();
        const e = m.get(key) ?? { sent: 0, replied: 0, days: [], awarded: 0, deals: new Set<number>() };
        e.sent += 1;
        const rec = (r.quote_receipts ?? [])
          .filter((q) => q.vendor.trim().toUpperCase() === key.toUpperCase() && q.received_at >= snd.sent_at)
          .sort((x, y) => (x.received_at < y.received_at ? -1 : 1))[0];
        if (rec) {
          e.replied += 1;
          const d = daysBetween(snd.sent_at, rec.received_at);
          if (Number.isFinite(d) && d >= 0) e.days.push(d);
        }
        if (!e.deals.has(r.rfq_id) && awarded.includes(key.toUpperCase())) e.awarded += 1;
        e.deals.add(r.rfq_id);
        m.set(key, e);
      }
    }
    return [...m.entries()].map(([vendor, e]) => ({
      vendor, sent: e.sent, replied: e.replied, awarded: e.awarded,
      rate: e.sent ? pct1(e.replied, e.sent) : null, med: median(e.days),
    })).sort((x, y) => y.sent - x.sent || y.replied - x.replied).slice(0, 12);
  })();

  // 고객 구성 — 신규(그 기간에 첫 매출) vs 기존, 선주·관리사별 매출.
  const custMix = (() => {
    const cm = stat.customer_month;
    if (!cm) return null;
    const names = new Set([...Object.keys(cm.USD || {}), ...Object.keys(cm.KRW || {})]);
    let nNew = 0, nOld = 0, vNew = 0, vOld = 0;
    const p0 = pIdx[0];
    for (const n of names) {
      const v = inCur(sumOf(cm.USD?.[n], pIdx), sumOf(cm.KRW?.[n], pIdx));
      if (!v) continue;
      const first = stat.months.findIndex((_, i) => (cm.USD?.[n]?.[i] ?? 0) + (cm.KRW?.[n]?.[i] ?? 0) > 0);
      if (first >= p0) { nNew += 1; vNew += v; } else { nOld += 1; vOld += v; }
    }
    return { nNew, nOld, vNew, vOld };
  })();
  const mixRows = (() => {
    const mm2 = mixBy === "owner" ? stat.owner_month : stat.manager_month;
    if (!mm2) return [];
    // 같은 회사가 대소문자만 달리 적힌 경우(MSC Shipmanagement Ltd / MSC SHIPMANAGEMENT LTD)는 하나로.
    const acc = new Map<string, { name: string; usd: number; krw: number }>();
    for (const c of ["USD", "KRW"] as const) {
      for (const [n, arr] of Object.entries(mm2[c] || {})) {
        const k = n.trim().toUpperCase().replace(/[.,]/g, "");
        const e = acc.get(k) ?? { name: n, usd: 0, krw: 0 };
        if (c === "USD") e.usd += sumOf(arr, pIdx); else e.krw += sumOf(arr, pIdx);
        acc.set(k, e);
      }
    }
    return [...acc.values()].map((e) => ({ name: e.name, amount: inCur(e.usd, e.krw) }))
      .filter((r) => r.amount > 0)
      .sort((x, y) => (x.name === "(unknown)" ? 1 : y.name === "(unknown)" ? -1 : y.amount - x.amount))
      .slice(0, 8);
  })();
  const mixMax = Math.max(1, ...mixRows.map((r) => r.amount));
  const mixTotal = mixRows.reduce((t, r) => t + r.amount, 0);
  const mgRows = mgRowsOf(mgTab);
  const mgDone = mgRows.filter((w) => w.margin_usd != null);
  const mgSales = mgDone.reduce((s, w) => s + w.sales_usd, 0);
  const mgMarginSum = mgDone.reduce((s, w) => s + (w.margin_usd ?? 0), 0);
  const mgPct = mgSales ? Math.round((mgMarginSum / mgSales) * 1000) / 10 : null;
  const mgPctMax = Math.max(1, ...mgDone.map((w) => Math.abs(w.margin_pct ?? 0)));
  const funnelData = [
    { stage: "RFQ", count: fRfq, rate: 100, label: "" },
    { stage: "Quote", count: fQuote, rate: pct1(fQuote, fRfq), label: "Quote / RFQ" },
    { stage: "PO", count: fPo, rate: pct1(fPo, fQuote), label: "PO / Quote" },
    { stage: "Revenue", count: fRev, rate: pct1(fRev, fPo), label: "Revenue / PO" },
  ].map((d) => ({ ...d, tag: d.label ? `${d.count} · ${d.rate}%` : String(d.count) }));

  // 근거 목록 만들기 ------------------------------------------------------------
  const money0 = (usd: number) => fmtMoney(cur, toCur(usd));
  const drillWon = (key: string, title: string, rows: typeof stat.won_margin): Drill => ({
    key, title, rows: rows.map((w) => ({
      rfq_id: w.rfq_id, no: w.project_no, customer: w.customer, date: w.date,
      value: money0(w.sales_usd), note: w.margin_pct == null ? "No vendor P/O yet" : `GM ${w.margin_pct}%`,
    })),
  });
  const drillRfq = (key: string, title: string, rows: typeof pRfqRows): Drill => ({
    key, title, rows: rows.map((d) => ({ rfq_id: d.rfq_id, no: d.rfq_no, customer: d.customer, date: d.date, value: "", note: d.status })),
  });
  const drillPipe = (key: string, title: string, rows: { r: (typeof prow)[number]; v: string; note: string; date: string }[]): Drill => ({
    key, title, rows: rows.map(({ r, v, note, date }) => ({
      rfq_id: r.rfq_id, no: r.project_no || r.kmaris_rfq_no, customer: r.customer, date, value: v, note,
    })),
  });

  // 커스텀 호버 툴팁(상세내역) --------------------------------------------
  // RFQ 툴팁 — 번호 나열 대신 고객사별 건수 상위 3 + 기타, 그리고 견적·발주 전환.
  // 전체 목록은 막대를 눌러 차트 아래에 펼친다.
  function RfqTip({ active, payload }: { active?: boolean; payload?: { payload: typeof rfqData[number] }[] }) {
    if (!active || !payload?.length) return null;
    const p = payload[0].payload;
    if (!p.detail) return null;
    const byCust = new Map<string, number>();
    p.detail.forEach((d) => byCust.set(d.customer, (byCust.get(d.customer) ?? 0) + 1));
    const ranked = [...byCust.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked.slice(0, 3);
    const rest = ranked.slice(3);
    const restN = rest.reduce((s, [, n]) => s + n, 0);
    const quoted = p.detail.filter((d) => d.status !== "Open").length;
    const po = p.detail.filter((d) => d.status === "PO" || d.status === "Invoiced").length;
    return (
      <div className="stat-tip">
        <div className="stat-tip-h">{p.month} · RFQ {p.count}</div>
        {p.count === 0 ? <div className="stat-tip-row muted">None received</div> : (
          <>
            {top.map(([c, n]) => (
              <div key={c} className="stat-tip-kv"><span>{c}</span><b>{n}</b></div>
            ))}
            {restN ? <div className="stat-tip-kv muted"><span>Others ({rest.length} co.)</span><b>{restN}</b></div> : null}
            <div className="stat-tip-foot">
              Quoted {quoted} ({Math.round((quoted / p.count) * 100)}%) · PO {po}
            </div>
            <div className="stat-tip-more">Click to list</div>
          </>
        )}
      </div>
    );
  }
  function FunnelTip({ active, payload }: { active?: boolean; payload?: { payload: typeof funnelData[number] }[] }) {
    if (!active || !payload?.length) return null;
    const p = payload[0].payload;
    return (
      <div className="stat-tip">
        <div className="stat-tip-h">{p.stage}: {p.count}</div>
        {p.label ? <div className="stat-tip-row">{p.label} = <b>{p.rate}%</b></div> : <div className="stat-tip-row muted">Baseline (all)</div>}
      </div>
    );
  }

  return (
    <>
      {/* ① 머리줄 — 월 이동 · (관리자)감사 · 통화 전환 ------------------------- */}
      <div className="stat-head">
        {/* 기간 단위 — 화면의 모든 숫자·순위·퍼널·마진이 이 기간을 따른다(Deals by Stage·상태 줄 제외). */}
        <div className="stat-cur-toggle sm" role="group" aria-label="Period">
          {(["M", "Q", "Y"] as const).map((k) => (
            <button key={k} className={ptype === k ? "on" : ""} onClick={() => setPtype(k)}>
              {k === "M" ? "Month" : k === "Q" ? "Quarter" : "Year to date"}
            </button>
          ))}
        </div>
        <span className="stat-monthnav">
          <button
            type="button" className="stat-mnav-btn"
            onClick={() => setMonthIdx(ptype === "Q" ? Math.max(qStart - 1, 0) : idx - 1)}
            disabled={ptype === "Y" || (ptype === "Q" ? qStart <= 0 : idx <= 0)}
            aria-label="Previous period" title="Previous period"
          >‹</button>
          <span className="stat-mnav-label">
            {periodLabel}{isCurMonth && ptype !== "Y" ? " · current" : ""}
          </span>
          <button
            type="button" className="stat-mnav-btn"
            onClick={() => setMonthIdx(ptype === "Q" ? Math.min(qStart + 5, lastIdx) : idx + 1)}
            disabled={ptype === "Y" || idx >= lastIdx}
            aria-label="Next period" title="Next period"
          >›</button>
        </span>
        {ptype !== "Y" ? (
          <div className="stat-cur-toggle sm" role="group" aria-label="Compare with">
            <button className={cmpMode === "prev" ? "on" : ""} onClick={() => setCmpMode("prev")}>vs prev.</button>
            <button className={cmpMode === "yoy" ? "on" : ""} onClick={() => setCmpMode("yoy")}
              title={hasPrevYear ? "Same period last year" : "No data for last year yet"}>vs last year</button>
          </div>
        ) : null}
        {/* 관리자 전용 감사 — 한 줄을 차지하던 토글을 아이콘으로 줄였다. */}
        {showAudit ? (
          <button type="button" className={`stat-audit-icon${auditOpen ? " on" : ""}`} onClick={loadAudit}
            title="Audit money KPIs — trace Orders Won / Quoted / Revenue rows">🔍</button>
        ) : null}
        {/* 환산 중일 때만 어떤 환율로 옮겼는지 밝힌다 — 합계가 환율에 따라 달라지므로,
            숫자만 두면 검산할 근거가 없다. */}
        {cur === "KRWC" ? (
          <span className="stat-fx-note">
            USD → KRW {fxRate.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            {stat.fx?.source === "exim"
              ? ` · base rate${stat.fx.date ? ` (posted ${stat.fx.date})` : ""}`
              : " · fixed rate (quote lookup failed)"}
          </span>
        ) : null}
        <div className="stat-cur-toggle sm stat-cur-inline">
          {STAT_CUR_KEYS.map((c) => (
            <button key={c} className={cur === c ? "on" : ""} onClick={() => setCur(c)}>
              {curLabel(c)}
            </button>
          ))}
        </div>
      </div>

      {/* ② 숫자 띠 두 줄 — [실적: 고른 기간] / [지금 상태: 기간 무관]. 성격이 다른 숫자를 한 줄에
          섞으면 "이번 달 얘기인지 지금 얘기인지"를 칸마다 따져야 했다. ---------------- */}
      <div className="stat-strip-label">Performance · {periodLabel} <span>{cmpLabel}</span></div>
      <div className="stat-strip perf">
        <StatCell label="Revenue" value={fmtMoney(cur, mRevenue)} tip="Tax-invoice month (domestic) or AR invoice date (export · PI)"
          extra={<DeltaChip cur={mRevenue} prev={mRevenuePrev} label={cmpLabel} />}
          spark={sparkOf(stat.series.revenue[cur])} />
        <StatCell label="Orders Won" value={fmtMoney(cur, mOrder)} tip="Order value in the period · click for deals"
          onClick={() => toggleDrill(drillWon("won", `Orders won · ${periodLabel}`, wonInP))}
          extra={<DeltaChip cur={mOrder} prev={mOrderPrev} label={cmpLabel} />}
          spark={sparkOf(stat.series.order[cur])} />
        <StatCell label="Gross Profit" value={`${curUnit(cur)} ${num(Math.round(toCur(gpNow.margin)))}`}
          onClick={() => toggleDrill(drillWon("gp", `Gross profit — won deals · ${periodLabel}`, wonInP.filter((w) => w.margin_usd != null)))}
          tip={`Won deals with a vendor P/O (${gpNow.n}) — order value minus purchase`}
          extra={<>
            {gpNow.pct != null ? <span className="stat-sub">GM {gpNow.pct}%</span> : null}
            {gpPrev ? <DeltaChip cur={gpNow.margin} prev={gpPrev.margin} label={cmpLabel} /> : null}
          </>} />
        <StatCell label="Win Rate" value={winRate == null ? "—" : `${winRate}%`}
          onClick={() => toggleDrill(drillRfq("win", `Quoted RFQs · ${periodLabel}`, pRfqRows.filter((d) => d.status !== "Open")))}
          tip="RFQs received in the period: reached P/O ÷ quoted"
          extra={<span className="stat-sub">{fPo}/{fQuote} quoted{mQuote ? ` · value ${pct1(mOrder, mQuote)}%` : ""}</span>} />
        <StatCell label="RFQs" value={mRfq} tip="RFQs received in the period · click for the list"
          onClick={() => toggleDrill(drillRfq("rfq", `RFQs received · ${periodLabel}`, pRfqRows))}
          extra={<DeltaChip cur={mRfq} prev={mRfqPrev} label={cmpLabel} />}
          spark={sparkOf(stat.rfq_count)} />
      </div>
      <div className="stat-strip-label">Now</div>
      <div className="stat-strip now">
        <StatCell label="AR Outstanding" value={`${curUnit(cur)} ${num(Math.round(arOut))}`}
          tip={`Outstanding receivables (${curLabel(cur)})`}
          extra={ops.overdue ? <span className="stat-flag red">Overdue {ops.overdue}</span> : null} />
        <StatCell label="Open Pipeline" value={`${curUnit(cur)} ${num(Math.round(toCur(openPipeline)))}`}
          onClick={() => toggleDrill({
            key: "open", title: "Open quotes (now)",
            rows: openQuotes.map((q) => ({ rfq_id: q.rfq_id, no: q.project_no, customer: q.customer, date: q.date,
              value: money0(q.sales_usd), note: q.margin_pct == null ? "" : `est. GM ${q.margin_pct}%` })),
          })}
          tip="Quotes sent and still open (not won, lost or expired)"
          extra={<span className="stat-sub">{openQuotes.length} quotes</span>} />
        <StatCell label="Delivery Delays" value={stat.delivery_delays} tip="Past promised date"
          tone={stat.delivery_delays ? "red" : undefined} />
        <StatCell label="Urgent" value={ops.urgent} tip="Level A · expiring"
          tone={ops.urgent ? "amber" : undefined}
          extra={ops.expiring ? <span className="stat-flag amber">Expiring {ops.expiring}</span> : null} />
      </div>
      {drill ? (
        <div className="stat-drill">
          <div className="stat-drill-h">
            <b>{drill.title}</b><span>{drill.rows.length} deals · click a row to open</span>
            <button type="button" className="stat-drill-x" onClick={() => setDrill(null)} aria-label="Close">×</button>
          </div>
          <div className="stat-drill-body">
            {drill.rows.length === 0 ? <div className="state">Nothing here.</div> : drill.rows.map((d, i) => (
              <div key={`${d.rfq_id}-${i}`} className="stat-drill-row" role="button"
                onClick={() => { if (d.rfq_id) router.push(`/project?rfq=${d.rfq_id}`); }}>
                <span className="no">{d.no}</span>
                <span className="c" title={d.customer}>{d.customer}</span>
                <span className="d">{d.date}</span>
                <span className="v">{d.value}</span>
                <span className="x">{d.note}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="stat-strip-label">Speed · {periodLabel} <span>median days · deals that reached the end step in the period</span></div>
      <div className="stat-strip now">
        {speeds.map((sp) => (
          <StatCell key={sp.key} label={sp.label}
            onClick={() => toggleDrill(drillPipe(`sp-${sp.key}`, `${sp.label} · ${periodLabel}`,
              sp.now.rows.map((x) => ({ r: x.r, v: `${Math.round(x.d * 10) / 10} d`, note: sp.tip, date: x.end.slice(0, 10) }))))}
            value={sp.now.med == null ? "—" : `${sp.now.med} d`}
            tip={`${sp.tip} · ${sp.now.n} deals`}
            extra={<>
              <span className="stat-sub">n={sp.now.n}</span>
              {sp.prev?.med != null && sp.now.med != null
                ? <DeltaChip cur={sp.now.med} prev={sp.prev.med} label={cmpLabel} invert /> : null}
            </>} />
        ))}
      </div>

      {/* 관리자 전용 감사 패널 — 금액 KPI 가 어떤 오더·견적·AR 에서 왔는지 행 단위로 확인.
          통화 오염(예: KRW 금액이 USD 로 계상) 원인을 화면에서 바로 특정한다. */}
      {showAudit && auditOpen ? (
        <div className="stat-audit">
          {auditBusy ? (
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
                  <span className="muted"> (counted by tax-invoice month, else AR invoice date = {audit.month})</span>
                </div>
                <table className="mini wide">
                  <thead><tr><th>Ref</th><th>Revenue month</th><th>Bucket</th><th style={{ textAlign: "right" }}>Amount</th><th>Counted</th></tr></thead>
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
          ) : null}
        </div>
      ) : null}

      {/* ③ 차트 (2열) — 선택 월은 추이 차트에 띠로 칠하고, 칸을 누르면 그 달로 옮긴다. */}
      <div className="stat-charts">
        {/* 금액 추이 — Quoted·Won 막대 + Revenue 선. 따로 있던 두 차트를 합쳤다. */}
        <div className="stat-chart">
          <SubHead title="Won · Revenue" sub={`${curLabel(cur)} · monthly`} />
          <ResponsiveContainer width="100%" height={210}>
            <ComposedChart data={moneyTrend} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
              onClick={pickMonth} style={{ cursor: "pointer" }}>
              <CartesianGrid vertical={false} stroke={GRID} />
              <ReferenceArea x1={selFrom} x2={selLabel} fill="#0055a8" fillOpacity={0.07} />
              <XAxis dataKey="month" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }} />
              <YAxis tickFormatter={compact} tick={AXIS_TICK} width={40} tickLine={false} axisLine={false} />
              <Tooltip formatter={(v) => fmtMoney(cur, Number(v) || 0)} />
              <Legend wrapperStyle={{ fontSize: 11 }} iconSize={9} />
              <Bar dataKey="order" fill="#2e8b57" name="Won" radius={[2, 2, 0, 0]} />
              <Bar dataKey="revenue" fill="#0055a8" name="Revenue" radius={[2, 2, 0, 0]} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* 전환 퍼널 — 막대 옆에 건수와 앞 단계 대비 전환율을 함께 적는다(Hit Rate 카드 대체). */}
        <div className="stat-chart">
          <SubHead title="Conversion" sub={`RFQs received in ${periodLabel}`} />
          <ResponsiveContainer width="100%" height={210}>
            <BarChart data={funnelData} layout="vertical" margin={{ top: 4, right: 70, bottom: 0, left: 0 }}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="stage" width={80} tick={AXIS_TICK} tickLine={false} axisLine={false} />
              <Tooltip content={<FunnelTip />} cursor={{ fill: "rgba(0,85,168,0.05)" }} />
              <Bar dataKey="count" name="Count" radius={[0, 3, 3, 0]} barSize={26}>
                {funnelData.map((_, i) => <Cell key={i} fill={PHASE_RAMP[i % PHASE_RAMP.length]} />)}
                <LabelList dataKey="tag" position="right" style={{ fontSize: 11, fill: "#45526a", fontWeight: 600 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* 월간 RFQ 수신 건수 — 호버 시 해당 월 RFQ 목록 표시 */}
        <div className="stat-chart">
          <SubHead title="RFQs · Quoted" sub={`RFQ count · quoted value (${curLabel(cur)})`} />
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={rfqData} margin={{ top: 14, right: 0, bottom: 0, left: 0 }}
              onClick={(st) => {
                const i = Number(st?.activeTooltipIndex);
                if (st?.activeTooltipIndex == null || !Number.isFinite(i) || i > lastIdx) return;
                // 같은 달을 다시 누르면 목록을 닫는다.
                setRfqListOpen(!(rfqListOpen && i === idx));
                setMonthIdx(i);
              }}
              style={{ cursor: "pointer" }}>
              <CartesianGrid yAxisId="n" vertical={false} stroke={GRID} />
              <ReferenceArea yAxisId="n" x1={selFrom} x2={selLabel} fill="#0055a8" fillOpacity={0.07} />
              <XAxis dataKey="month" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }} />
              <YAxis yAxisId="n" allowDecimals={false} tick={AXIS_TICK} width={28} tickLine={false} axisLine={false} />
              <YAxis yAxisId="v" orientation="right" tickFormatter={compact} tick={AXIS_TICK} width={40} tickLine={false} axisLine={false} />
              <Tooltip content={<RfqTip />} cursor={{ fill: "rgba(0,85,168,0.05)" }} />
              <Legend wrapperStyle={{ fontSize: 11 }} iconSize={9} />
              <Line yAxisId="v" type="monotone" dataKey="quote" stroke="#e8830c" strokeWidth={2} dot={{ r: 2 }} name="Quoted" />
              <Bar yAxisId="n" dataKey="count" fill="#86b6ef" name="RFQs" radius={[2, 2, 0, 0]}>
                {/* 축이 1~12월 고정이라 수신 없는 달이 여럿 생긴다 — 0 은 라벨을 지워
                    바닥에 0 이 줄줄이 찍히지 않게 한다(툴팁에는 "수신 없음"으로 안내). */}
                <LabelList
                  dataKey="count"
                  position="top"
                  style={{ fontSize: 10, fill: "#45526a" }}
                  formatter={(v) => (Number(v) > 0 ? String(v) : "")}
                />
              </Bar>
            </ComposedChart>
          </ResponsiveContainer>
          {/* 선택 월 RFQ 목록 — 접힌 채로는 한 줄. 줄을 누르면 프로젝트 팝업. */}
          <button type="button" className="stat-rfq-toggle" onClick={() => setRfqListOpen(!rfqListOpen)}
            disabled={!selRfqs.length}>
            {rfqListOpen ? "▾" : "▸"} {periodLabel} RFQs ({selRfqs.length})
          </button>
          {rfqListOpen && selRfqs.length ? (
            <div className="stat-rfq-list">
              {selRfqs.map((d) => (
                <div key={d.rfq_id} className="stat-rfq-row" role="button"
                  onClick={() => router.push(`/project?rfq=${d.rfq_id}`)}>
                  <span className="d">{d.date.slice(5)}</span>
                  <span className="no">{d.rfq_no}</span>
                  <span className="c">{d.customer}</span>
                  <span className={`st st-${d.status.toLowerCase()}`}>{d.status}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {/* 월별 수주율 — 건수(그 달 RFQ 중 견적 → P/O) · 금액(그 달 수주 ÷ 견적). */}
        <div className="stat-chart">
          <SubHead title="Win Rate" sub="monthly · by count and by value" />
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={winTrend} margin={{ top: 10, right: 12, bottom: 0, left: 0 }}
              onClick={pickMonth} style={{ cursor: "pointer" }}>
              <CartesianGrid vertical={false} stroke={GRID} />
              <ReferenceArea x1={selFrom} x2={selLabel} fill="#0055a8" fillOpacity={0.07} />
              <XAxis dataKey="month" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }} />
              <YAxis tickFormatter={(v) => `${v}%`} tick={AXIS_TICK} width={40} tickLine={false} axisLine={false} />
              <Tooltip formatter={(v, n) => [v == null ? "—" : `${v}%`, n]} />
              <Legend wrapperStyle={{ fontSize: 11 }} iconSize={9} />
              <Line type="monotone" dataKey="cnt" name="By count (P/O ÷ quoted RFQs)" stroke="#2e8b57" strokeWidth={2} dot={{ r: 2 }} connectNulls />
              <Line type="monotone" dataKey="val" name="By value (won ÷ quoted)" stroke="#86b6ef" strokeWidth={2} strokeDasharray="4 3" dot={{ r: 2 }} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* 실주 사유 — 고른 기간에 닫은 딜. 갈래마다 딜 수 · 놓친 견적 금액. */}
        <div className="stat-chart">
          <SubHead title="Lost Reasons" sub={`${periodLabel} · ${lostDeals.length} deals · ${fmtMoney(cur, toCur(lostUsd))} quoted`} />
          {lostRows.length === 0 ? (
            <div className="state">No deals closed in this period.</div>
          ) : (
            <div className="stat-lost">
              {lostRows.map((r) => {
                const b = r.code === "(none)" ? { text: "No reason", tone: "other" } : closeReasonBadge(r.code);
                const top = [...r.cust.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3);
                return (
                  <div key={r.code} className="stat-lost-row" role="button"
                    onClick={() => toggleDrill(drillPipe(`lost-${r.code}`, `Lost — ${b.text} · ${periodLabel}`,
                      lostDeals.filter((x) => (closeReasonCodes(x.close_reason).length ? closeReasonCodes(x.close_reason) : ["(none)"]).includes(r.code))
                        .map((x) => ({ r: x, v: lostValue.get(x.rfq_id) ? money0(lostValue.get(x.rfq_id) ?? 0) : "", note: x.close_reason_note || "", date: (x.closed_at || "").slice(0, 10) }))))}
                    title={`${CLOSE_REASONS.find((c) => c.code === r.code)?.label ?? b.text}\n${top.map(([c, n]) => `${c} ${n}`).join(" · ")}`}>
                    <span className={`close-badge tone-${b.tone}`}>{b.text}</span>
                    <span className="bar"><i className={`tone-${b.tone}`} style={{ width: `${(r.n / lostMax) * 100}%` }} /></span>
                    <b>{r.n}</b>
                    <span className="pct">{Math.round((r.n / lostDeals.length) * 100)}%</span>
                    <span className="amt">{r.usd ? compact(toCur(r.usd)) : "—"}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 고객별 수주율 — 고른 기간에 RFQ 를 준 고객. */}
        <div className="stat-chart">
          <SubHead title="Win Rate by Customer" sub={`${periodLabel} · RFQs received`} />
          {custWin.length === 0 ? (
            <div className="state">No RFQs in this period.</div>
          ) : (
            <table className="stat-cw">
              <thead>
                <tr><th>Customer</th><th>RFQs</th><th>Quoted</th><th>Won</th><th>Lost</th><th>Win rate</th></tr>
              </thead>
              <tbody>
                {custWin.map((c) => (
                  <tr key={c.name}>
                    <td className="n" title={c.name}>{c.name}</td>
                    <td>{c.rfq}</td><td>{c.quoted}</td><td className="won">{c.won || ""}</td>
                    <td className="lost">{c.lost || ""}</td>
                    <td className="rate">
                      {c.rate == null ? <span className="muted">—</span> : (
                        <><i style={{ width: Math.round(c.rate * 0.5) }} />{c.rate}%</>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* 프로젝트 마진 — Won(실적: 오더 vs 발주) / Quoted(진행 중 견적 예상) / Lost(실주·만료).
            최신순, 줄 클릭 → 프로젝트. 견적 건 예상 = 최신 고객 견적 vs 채택(없으면 최저) 벤더 단가. */}
        <div className="stat-chart">
          <div className="stat-mg-head">
            <SubHead title="Project Margin" sub={`${curLabel(cur)} · ${periodLabel}`} />
            <div className="stat-cur-toggle sm">
              {MG_TABS.map((k) => (
                <button key={k} className={mgTab === k ? "on" : ""} onClick={() => setMgTab(k)}>
                  {k === "won" ? "Won" : k === "quoted" ? "Quoted" : "Lost"} ({mgRowsOf(k).length})
                </button>
              ))}
            </div>
          </div>
          {mgRows.length === 0 ? (
            <div className="state">No deals here.</div>
          ) : (
            <div className="stat-mg">
              <div className="stat-mg-row h">
                <span>Project</span><span className="r">Sales</span><span className="r">Margin</span>
                <span>Margin %{mgTab === "won" ? "" : " (est.)"}</span>
              </div>
              <div className="stat-mg-body">
                {mgRows.map((w) => (
                  <div key={w.rfq_id} className="stat-mg-row" role="button"
                    onClick={() => router.push(`/project?rfq=${w.rfq_id}`)}
                    title={`${w.project_no} · ${w.customer}${w.project_title ? ` · ${w.project_title}` : ""} · ${w.date}`}>
                    <span className="p"><b>{w.project_no}</b><i>{w.project_title || w.customer}</i></span>
                    <span className="r">{compact(toCur(w.sales_usd))}</span>
                    <span className="r">{w.margin_usd == null ? "—" : compact(toCur(w.margin_usd))}</span>
                    {w.margin_pct == null ? (
                      <span className="pct muted">No PO yet</span>
                    ) : (
                      <span className="pct">
                        <i className={w.margin_pct < 0 ? "neg" : mgTab === "won" ? "" : "est"}
                          style={{ width: Math.round((Math.abs(w.margin_pct) / mgPctMax) * 70) }} />
                        <b className={w.margin_pct < 0 ? "neg" : ""}>{w.margin_pct}%</b>
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <div className="stat-mg-row t">
                <span>Total ({mgDone.length})</span>
                <span className="r">{compact(toCur(mgSales))}</span>
                <span className="r">{compact(toCur(mgMarginSum))}</span>
                <span className="pct"><b>{mgPct == null ? "—" : `${mgPct}%`}</b></span>
              </div>
            </div>
          )}
        </div>

        <div className="stat-chart">
          <SubHead title="Top 10 Customers" sub={`by revenue · ${periodLabel}`} />
          <table className="stat-cw stat-ct">
            <thead>
              <tr><th>Customer</th><th>Revenue</th><th>Share</th><th>Cum.</th><th title="Deals won in the period">Won</th><th title="Won deals in the period: order − purchase">Margin</th><th>GM%</th></tr>
            </thead>
            <tbody>
              {custRows.map((c) => (
                <tr key={c.name} role="button" className="clk"
                  onClick={() => toggleDrill(drillWon(`cust-${c.name}`, `${c.name} — won deals · ${periodLabel}`, c.won))}>
                  <td className="n" title={c.name}>{c.name}</td>
                  <td className="rev" title={fmtMoney(cur, c.amount)}>
                    <i style={{ width: Math.round((c.amount / custMax) * 46) }} />{c.amount ? compact(c.amount) : "—"}
                  </td>
                  <td>{c.amount ? `${c.share}%` : ""}</td>
                  <td className="muted">{c.amount ? `${c.cum}%` : ""}</td>
                  <td>{c.deals || ""}</td>
                  <td title={c.deals ? fmtMoney(cur, toCur(c.margin)) : ""}>{c.gm != null ? compact(toCur(c.margin)) : ""}</td>
                  <td className="gm">{c.gm != null ? `${c.gm}%` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 파이프라인 10단계 분포 — 지금 각 단계에 머문 딜 수. 색은 5개 중분류(phase). */}
        <div className="stat-chart">
          <SubHead title="Deals by Stage" sub="now · open deals" />
          <table className="stat-cw stat-st">
            <thead>
              <tr><th>Stage</th><th>Deals</th><th title="Stages 1–4: open quote value · 5+: order value">Value</th><th title="Median days since the deal reached this stage">Days</th><th title="Deals sitting here more than 30 days">&gt;30d</th></tr>
            </thead>
            <tbody>
              {stageTable.map((st) => (
                <tr key={st.no} role="button" className={st.deals.length ? "clk" : ""}
                  onClick={() => st.deals.length && toggleDrill(drillPipe(`stage-${st.no}`, `${st.no}. ${st.label} — now`,
                    [...st.deals].sort((x, y) => (y.days ?? -1) - (x.days ?? -1))
                      .map((d) => ({ r: d.r, v: d.usd ? money0(d.usd) : "", note: d.days == null ? "" : `${d.days} days here`, date: stageDateOf(d.r, st.no).slice(0, 10) }))))}>
                  <td className="n"><span className="stn" style={{ background: PHASE_RAMP[st.phase] }}>{st.no}</span>{st.label}</td>
                  <td className="cnt"><i style={{ width: Math.round((st.deals.length / stageMax) * 40), background: PHASE_RAMP[st.phase] }} />{st.deals.length || ""}</td>
                  <td title={st.usd ? fmtMoney(cur, toCur(st.usd)) : ""}>{st.usd ? compact(toCur(st.usd)) : ""}</td>
                  <td>{st.med == null ? "" : `${st.med}d`}</td>
                  <td className={st.stale ? "lost" : ""}>{st.stale || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="stat-chart stat-chart--wide">
          <div className="stat-mg-head">
            <SubHead title={itemView === "cat" ? "Revenue by Category" : "Top 10 Items"} sub={`by invoiced amount · ${periodLabel}`} />
            <div className="stat-cur-toggle sm">
              <button className={itemView === "cat" ? "on" : ""} onClick={() => setItemView("cat")}>By category</button>
              <button className={itemView === "item" ? "on" : ""} onClick={() => setItemView("item")}>By item</button>
            </div>
          </div>
          {itemView === "cat" && stat.item_month ? (
            catTop.length === 0 ? <div className="state">No invoiced items in this period.</div> : (
              <div className="stat-cat">
                {catTop.map((c) => (
                  <div key={c.cat}>
                    <div className={`stat-cat-row${c.cat === "Unclassified" ? " un" : ""}`} role="button"
                      onClick={() => setOpenCat(openCat === c.cat ? null : c.cat)}
                      title={`${fmtMoney(cur, c.amount)} · ${c.items.length} items — click to list`}>
                      <span className="t">{openCat === c.cat ? "▾" : "▸"} {c.cat}</span>
                      <span className="bar"><i style={{ width: `${(c.amount / catMax) * 100}%` }} /></span>
                      <b>{compact(c.amount)}</b>
                      <span className="pct">{catTotal ? Math.round((c.amount / catTotal) * 100) : 0}%</span>
                    </div>
                    {openCat === c.cat ? (
                      <div className="stat-cat-items">
                        {c.items.map((it) => (
                          <div key={it.name} className="stat-cat-item" title={fmtMoney(cur, it.amount)}>
                            <span>{it.name}</span><b>{compact(it.amount)}</b>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
                {catTop.some((c) => c.cat === "Unclassified") ? (
                  <div className="stat-cat-note">Unclassified = part numbers not in the item master with a category (Data › Items).</div>
                ) : null}
              </div>
            )
          ) : (
            <div className="stat-cat">
              {itemTop.length === 0 ? <div className="state">No invoiced items in this period.</div> : itemTop.map((it) => (
                <div key={it.name} className="stat-cat-row" title={fmtMoney(cur, it.amount)}>
                  <span className="t">{it.name}</span>
                  <span className="bar"><i style={{ width: `${(it.amount / itemMax) * 100}%` }} /></span>
                  <b>{compact(it.amount)}</b>
                  <span className="pct" />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 미수금 구간 — 만기 경과일(지금). DSO = 미수금 ÷ 최근 3개월 매출 × 90. */}
        <div className="stat-chart">
          <SubHead title="Receivables Aging" sub={`now · ${fmtMoney(cur, arTotal)} · DSO ${dso == null ? "—" : `${dso} d`}`} />
          {arRows.length === 0 ? (
            <div className="state">No outstanding receivables.</div>
          ) : (
            <div className="stat-cat">
              {arBuckets.map((b) => (
                <div key={b.key} className={`stat-cat-row ar-${b.key}`} role={b.rows.length ? "button" : undefined}
                  title={fmtMoney(cur, b.amt)}
                  onClick={() => b.rows.length && toggleDrill({
                    key: `ar-${b.key}`, title: `Receivables — ${b.label}`,
                    rows: b.rows.sort((x, y) => (y.over ?? -999) - (x.over ?? -999)).map((a) => ({
                      rfq_id: a.rfq_id ?? 0, no: a.project_no, customer: a.customer, date: a.due_date ? `due ${a.due_date}` : "",
                      value: fmtMoney(cur, a.amt), note: a.over != null && a.over > 0 ? `${a.over} days overdue` : "not due",
                    })),
                  })}>
                  <span className="t">{b.label} <i className="muted">({b.rows.length})</i></span>
                  <span className="bar"><i style={{ width: `${(b.amt / arMaxB) * 100}%` }} /></span>
                  <b>{b.amt ? compact(b.amt) : ""}</b>
                  <span className="pct">{arTotal && b.amt ? `${Math.round((b.amt / arTotal) * 100)}%` : ""}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 담당자별 실적 — 고른 기간에 받은 RFQ. */}
        <div className="stat-chart">
          <SubHead title="By PIC" sub={`${periodLabel} · RFQs received`} />
          {picPerf.length === 0 ? <div className="state">No RFQs in this period.</div> : (
            <table className="stat-cw">
              <thead>
                <tr><th>PIC</th><th>RFQs</th><th>Quoted</th><th>Won</th><th>Win rate</th><th title="Orders won in the period">Won value</th><th title="Median days RFQ → quote sent">Quote TAT</th></tr>
              </thead>
              <tbody>
                {picPerf.map((p) => (
                  <tr key={p.pic}>
                    <td className="n">{p.pic}</td><td>{p.rfq}</td><td>{p.quoted}</td>
                    <td className="won">{p.won || ""}</td>
                    <td className="rate">{p.rate == null ? <span className="muted">—</span> : `${p.rate}%`}</td>
                    <td title={p.wonUsd ? fmtMoney(cur, toCur(p.wonUsd)) : ""}>{p.wonUsd ? compact(toCur(p.wonUsd)) : ""}</td>
                    <td>{p.tatMed == null ? "" : `${p.tatMed} d`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* 벤더 성과 — 고른 기간에 RFQ 를 보낸 곳. */}
        <div className="stat-chart">
          <SubHead title="Vendor Performance" sub={`${periodLabel} · RFQs sent`} />
          {vendPerf.length === 0 ? <div className="state">No vendor RFQs sent in this period.</div> : (
            <table className="stat-cw">
              <thead>
                <tr><th>Vendor</th><th>Sent</th><th>Replied</th><th>Reply rate</th><th title="Median days from RFQ sent to quote received">Reply time</th><th title="Deals where this vendor got our P/O">Awarded</th></tr>
              </thead>
              <tbody>
                {vendPerf.map((v) => (
                  <tr key={v.vendor}>
                    <td className="n" title={v.vendor}>{v.vendor}</td><td>{v.sent}</td><td>{v.replied}</td>
                    <td className="rate">{v.rate == null ? "" : <><i style={{ width: Math.round(v.rate * 0.5) }} />{v.rate}%</>}</td>
                    <td>{v.med == null ? "" : `${v.med} d`}</td>
                    <td className="won">{v.awarded || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* 고객 구성 — 신규 vs 기존 · 선주 / ISM 관리사별 매출. */}
        <div className="stat-chart">
          <div className="stat-mg-head">
            <SubHead title="Customer Mix" sub={`by revenue · ${periodLabel}`} />
            <div className="stat-cur-toggle sm">
              <button className={mixBy === "owner" ? "on" : ""} onClick={() => setMixBy("owner")}>Owner</button>
              <button className={mixBy === "manager" ? "on" : ""} onClick={() => setMixBy("manager")}>ISM manager</button>
            </div>
          </div>
          {custMix ? (
            <div className="stat-mix-split" title="New = first revenue falls in this period">
              <span className="new" style={{ flexGrow: custMix.vNew || 0.0001 }}>
                New {custMix.nNew} · {compact(custMix.vNew)}
              </span>
              <span className="old" style={{ flexGrow: custMix.vOld || 0.0001 }}>
                Returning {custMix.nOld} · {compact(custMix.vOld)}
              </span>
            </div>
          ) : null}
          {mixRows.length === 0 ? <div className="state">No revenue in this period.</div> : (
            <div className="stat-cat">
              {mixRows.map((r) => (
                <div key={r.name} className={`stat-cat-row${r.name === "(unknown)" ? " un" : ""}`} title={fmtMoney(cur, r.amount)}>
                  <span className="t">{r.name === "(unknown)" ? "Unknown (vessel not looked up)" : r.name}</span>
                  <span className="bar"><i style={{ width: `${(r.amount / mixMax) * 100}%` }} /></span>
                  <b>{compact(r.amount)}</b>
                  <span className="pct">{mixTotal ? `${Math.round((r.amount / mixTotal) * 100)}%` : ""}</span>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </>
  );
}

/* 숫자 띠 한 칸 — 라벨 · 값 · (선택) 증감/경고 꼬리표. 설명은 툴팁으로만 둔다. */
function StatCell({
  label,
  value,
  tip,
  tone,
  extra,
  spark,
  onClick,
}: {
  label: string;
  value: string | number;
  tip?: string;
  tone?: "red" | "amber";
  extra?: React.ReactNode;
  /** 12개월 추세(작은 선) — 값 칸 오른쪽 위. */
  spark?: number[];
  /** 누르면 근거 목록을 연다. */
  onClick?: () => void;
}) {
  return (
    <div className={`stat-cell${tone ? ` ${tone}` : ""}${onClick ? " clk" : ""}`} title={tip}
      role={onClick ? "button" : undefined} onClick={onClick}>
      {spark && spark.some((v) => v) ? <Sparkline values={spark} /> : null}
      <div className="stat-cell-l">{label}</div>
      <div className="stat-cell-v">
        <span>{value}</span>
        {extra}
      </div>
    </div>
  );
}

/* 숫자 칸의 12개월 추세선 — 축·눈금 없이 모양만. 마지막 점(이번 달)만 찍는다. */
function Sparkline({ values }: { values: number[] }) {
  const w = 64, h = 18;
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`);
  const last = pts[pts.length - 1]?.split(",") ?? ["0", "0"];
  return (
    <svg className="stat-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline points={pts.join(" ")} fill="none" stroke="#7aa7dc" strokeWidth={1.4} strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={2} fill="#0055a8" />
    </svg>
  );
}
