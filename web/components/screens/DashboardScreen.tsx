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
} from "@/lib/api";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import { can, getToken, isAdmin } from "@/lib/auth";
import type {
  PipelineRow, StatisticsData, CurrencyKey, StatCurKey,
  StatDebugData,
} from "@/lib/types";
import { PipelineModal, byProjectNo } from "@/components/screens/ProjectsScreen";
import BriefingTab from "@/components/screens/BriefingTab";
import {
  ResponsiveContainer, ComposedChart, Line, BarChart, Bar,
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

type Tab = "briefing" | "home" | "stats";

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
        <button className={tab === "home" ? "on" : ""} onClick={() => setTab("home")}>
          Documents
        </button>
        <button className={tab === "stats" ? "on" : ""} onClick={() => setTab("stats")}>
          Statistics
        </button>
      </div>

      {tab === "briefing" ? <BriefingTab /> : tab === "home" ? <HomeTab /> : <StatisticsTab />}
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
    alert(`Download failed (${res.status})`);
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

function HomeTab() {
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
          r.pdfUrl ? (
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

  return (
    <div className="docs-board">
      {/* Briefing 탭과 같은 칩 줄(brief-bar · mail-chip) — 대시보드 탭끼리 버튼 모양을 맞춘다. */}
      <div className="brief-bar">
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
      </div>

      {regError ? <div className="state error">PI·CI·PL list failed to load: {String(regError)}</div> : null}
      {loading ? (
        <div className="state">Loading…</div>
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
function DeltaChip({ cur, prev }: { cur: number; prev: number }) {
  if (!prev) return null;
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  const up = pct >= 0;
  return (
    <span className={`stat-delta ${up ? "up" : "down"}`} title="vs previous month">
      {up ? "▲" : "▼"}{Math.abs(Math.round(pct))}%
    </span>
  );
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
  const router = useRouter();

  if (error && !data) {
    return <div className="state error">API error: {error.message}</div>;
  }
  if (!data || !stat) {
    return <div className="state">Loading…</div>;
  }

  const { ops, perf } = data;
  // 선택 월 인덱스(기본 이번 달) — 금액 KPI 3종은 월별 시계열에서 직접 뽑는다.
  // 그래프 축은 1~12월이라 마지막 칸이 12월(미래)이다. KPI 는 아직 오지 않은 달로
  // 넘어가지 않게 '이번 달'을 오른쪽 끝으로 삼는다.
  const curIdx = stat.current_month ? stat.months.indexOf(stat.current_month) : -1;
  const lastIdx = curIdx >= 0 ? curIdx : stat.months.length - 1;
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
  const pickMonth = (s: { activeTooltipIndex?: number | string | null } | null | undefined) => {
    const i = Number(s?.activeTooltipIndex);
    if (s?.activeTooltipIndex != null && Number.isFinite(i) && i >= 0 && i <= lastIdx) setMonthIdx(i);
  };
  const mRfq = stat.rfq_count[idx] || 0, mRfqPrev = idx > 0 ? stat.rfq_count[idx - 1] || 0 : 0;
  const arOut = data.kpi.ar_outstanding?.[cur] ?? (cur === "USD" ? data.kpi.ar_outstanding_usd : 0);
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
  // 월간 RFQ 수신 그래프 — 축은 months(올해 1~12월). 수신 없는 달은 0으로 비운다.
  const rfqData = stat.months.map((m, i) => ({
    month: monthLabel(m), count: stat.rfq_count[i] || 0, detail: stat.rfq_detail[i] || [],
  }));
  const selRfqs = stat.rfq_detail[idx] || [];
  // 프로젝트 마진은 USD 로 정규화돼 오므로 화면 통화로 되돌린다. 'KRW 환산'은 서버가
  // 실제로 쓴 매매기준율(stat.fx)을 그대로 써야 KPI·랭킹과 같은 환율 위에 선다.
  const fxRate = cur === "KRWC" ? (stat.fx?.rate || stat.usd_krw_rate) : stat.usd_krw_rate;
  const toCur = (usd: number) => (cur === "USD" ? usd : usd * fxRate);
  // 프로젝트 마진 표 — 탭별 줄. 매입 미확정(발주 전) 건은 합계에서 뺀다.
  const mgRowsOf = (k: MgTab) =>
    k === "won" ? stat.won_margin
      : stat.quoted_margin.rows.filter((r) => (k === "lost" ? r.status === "Lost" : r.status === "Open"));
  const mgRows = mgRowsOf(mgTab);
  const mgDone = mgRows.filter((w) => w.margin_usd != null);
  const mgSales = mgDone.reduce((s, w) => s + w.sales_usd, 0);
  const mgMarginSum = mgDone.reduce((s, w) => s + (w.margin_usd ?? 0), 0);
  const mgPct = mgSales ? Math.round((mgMarginSum / mgSales) * 1000) / 10 : null;
  const mgPctMax = Math.max(1, ...mgDone.map((w) => Math.abs(w.margin_pct ?? 0)));
  const funnelData = [
    { stage: "RFQ", count: stat.funnel.rfq, rate: 100, label: "" },
    { stage: "Quote", count: stat.funnel.quote, rate: stat.funnel.quote_rate, label: "Quote / RFQ" },
    { stage: "PO", count: stat.funnel.order, rate: stat.funnel.order_rate, label: "PO / Quote" },
    { stage: "Revenue", count: stat.funnel.revenue, rate: stat.funnel.revenue_rate, label: "Revenue / PO" },
  ].map((d) => ({ ...d, tag: d.label ? `${d.count} · ${d.rate}%` : String(d.count) }));
  // 파이프라인 10단계 분포 — 색은 5개 중분류(phase).
  const stageRows = data.stage_distribution.map((count, i) => ({
    name: `${i + 1}. ${data.steps[i] ?? ""}`,
    count,
    phase: phaseOfStage(i + 1),
  }));

  // 커스텀 호버 툴팁(상세내역) --------------------------------------------
  // RFQ 툴팁 — 번호 나열 대신 고객사별 건수 상위 3 + 기타, 그리고 견적·발주 전환.
  // 전체 목록은 막대를 눌러 차트 아래에 펼친다.
  function RfqTip({ active, payload }: { active?: boolean; payload?: { payload: typeof rfqData[number] }[] }) {
    if (!active || !payload?.length) return null;
    const p = payload[0].payload;
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

      {/* ② 숫자 띠 — 윗줄은 선택 월 실적, 아랫줄은 지금 상태(월 이동과 무관). ---- */}
      <div className="stat-strip">
        <StatCell label="Revenue" value={fmtMoney(cur, mRevenue)} tip="Tax-invoice month (domestic) or AR invoice date (export · PI)"
          extra={<DeltaChip cur={mRevenue} prev={mRevenuePrev} />} />
        <StatCell label="Orders Won" value={fmtMoney(cur, mOrder)} tip="Order value in the selected month"
          extra={<DeltaChip cur={mOrder} prev={mOrderPrev} />} />
        <StatCell label="Quoted" value={fmtMoney(cur, mQuote)} tip="Quote value in the selected month"
          extra={<DeltaChip cur={mQuote} prev={mQuotePrev} />} />
        <StatCell label="RFQs" value={mRfq} tip="RFQs received in the selected month"
          extra={<DeltaChip cur={mRfq} prev={mRfqPrev} />} />
        <StatCell label="Gross Margin" value={`${perf.gross_margin_pct}%`} tip="Current gross margin %" />
        <StatCell label="AR Outstanding" value={`${curUnit(cur)} ${num(Math.round(arOut))}`}
          tip={`Outstanding receivables (${curLabel(cur)})`}
          extra={ops.overdue ? <span className="stat-flag red">Overdue {ops.overdue}</span> : null} />
        <StatCell label="Delivery Delays" value={stat.delivery_delays} tip="Past promised date"
          tone={stat.delivery_delays ? "red" : undefined} />
        <StatCell label="Urgent" value={ops.urgent} tip="Level A · expiring"
          tone={ops.urgent ? "amber" : undefined}
          extra={ops.expiring ? <span className="stat-flag amber">Expiring {ops.expiring}</span> : null} />
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
          <SubHead title="Quoted · Won · Revenue" sub={curLabel(cur)} />
          <ResponsiveContainer width="100%" height={210}>
            <ComposedChart data={moneyTrend} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
              onClick={pickMonth} style={{ cursor: "pointer" }}>
              <CartesianGrid vertical={false} stroke={GRID} />
              <ReferenceArea x1={selLabel} x2={selLabel} fill="#0055a8" fillOpacity={0.07} />
              <XAxis dataKey="month" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }} />
              <YAxis tickFormatter={compact} tick={AXIS_TICK} width={40} tickLine={false} axisLine={false} />
              <Tooltip formatter={(v) => fmtMoney(cur, Number(v) || 0)} />
              <Legend wrapperStyle={{ fontSize: 11 }} iconSize={9} />
              <Bar dataKey="quote" fill="#e8830c" name="Quoted" radius={[2, 2, 0, 0]} />
              <Bar dataKey="order" fill="#2e8b57" name="Won" radius={[2, 2, 0, 0]} />
              <Line type="monotone" dataKey="revenue" stroke="#0055a8" strokeWidth={2} dot={{ r: 2 }} name="Revenue" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* 전환 퍼널 — 막대 옆에 건수와 앞 단계 대비 전환율을 함께 적는다(Hit Rate 카드 대체). */}
        <div className="stat-chart">
          <SubHead title="Conversion" sub="RFQ → Quote → PO → Revenue" />
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
          <SubHead title="RFQs Received" />
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={rfqData} margin={{ top: 14, right: 8, bottom: 0, left: 0 }}
              onClick={(st) => {
                const i = Number(st?.activeTooltipIndex);
                if (st?.activeTooltipIndex == null || !Number.isFinite(i) || i > lastIdx) return;
                // 같은 달을 다시 누르면 목록을 닫는다.
                setRfqListOpen(!(rfqListOpen && i === idx));
                setMonthIdx(i);
              }}
              style={{ cursor: "pointer" }}>
              <CartesianGrid vertical={false} stroke={GRID} />
              <ReferenceArea x1={selLabel} x2={selLabel} fill="#0055a8" fillOpacity={0.07} />
              <XAxis dataKey="month" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }} />
              <YAxis allowDecimals={false} tick={AXIS_TICK} width={28} tickLine={false} axisLine={false} />
              <Tooltip content={<RfqTip />} cursor={{ fill: "rgba(0,85,168,0.05)" }} />
              <Bar dataKey="count" fill="#0055a8" name="RFQ" radius={[2, 2, 0, 0]}>
                {/* 축이 1~12월 고정이라 수신 없는 달이 여럿 생긴다 — 0 은 라벨을 지워
                    바닥에 0 이 줄줄이 찍히지 않게 한다(툴팁에는 "수신 없음"으로 안내). */}
                <LabelList
                  dataKey="count"
                  position="top"
                  style={{ fontSize: 10, fill: "#45526a" }}
                  formatter={(v) => (Number(v) > 0 ? String(v) : "")}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          {/* 선택 월 RFQ 목록 — 접힌 채로는 한 줄. 줄을 누르면 프로젝트 팝업. */}
          <button type="button" className="stat-rfq-toggle" onClick={() => setRfqListOpen(!rfqListOpen)}
            disabled={!selRfqs.length}>
            {rfqListOpen ? "▾" : "▸"} {selMonth} RFQs ({selRfqs.length})
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

        {/* 프로젝트 마진 — Won(실적: 오더 vs 발주) / Quoted(진행 중 견적 예상) / Lost(실주·만료).
            최신순, 줄 클릭 → 프로젝트. 견적 건 예상 = 최신 고객 견적 vs 채택(없으면 최저) 벤더 단가. */}
        <div className="stat-chart">
          <div className="stat-mg-head">
            <SubHead title="Project Margin" sub={`${curLabel(cur)} · latest first`} />
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
          <SubHead title="Top 10 Customers" sub="by revenue" />
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={custTop} layout="vertical" margin={{ top: 0, right: 48, bottom: 0, left: 0 }} barCategoryGap={3}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="name" width={140} interval={0} tick={AXIS_TICK} tickLine={false} axisLine={false} />
              <Tooltip formatter={(v) => fmtMoney(cur, Number(v) || 0)} cursor={{ fill: "rgba(0,85,168,0.05)" }} />
              <Bar dataKey="amount" name="Revenue" fill="#0055a8" radius={[0, 2, 2, 0]}>
                <LabelList dataKey="amount" position="right" formatter={(v) => compact(Number(v) || 0)}
                  style={{ fontSize: 10, fill: "#45526a" }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* 파이프라인 10단계 분포 — 지금 각 단계에 머문 딜 수. 색은 5개 중분류(phase). */}
        <div className="stat-chart">
          <SubHead title="Deals by Stage" sub="current" />
          <ResponsiveContainer width="100%" height={stageRows.length * 22 + 8}>
            <BarChart data={stageRows} layout="vertical" margin={{ top: 0, right: 32, bottom: 0, left: 0 }} barCategoryGap={3}>
              <XAxis type="number" hide allowDecimals={false} />
              <YAxis type="category" dataKey="name" width={150} interval={0} tick={AXIS_TICK} tickLine={false} axisLine={false} />
              <Tooltip
                cursor={{ fill: "rgba(42,120,214,0.06)" }}
                formatter={(v) => [`${Number(v) || 0} deals`, "Count"]}
              />
              <Bar dataKey="count" radius={[0, 2, 2, 0]} background={{ fill: "#f4f7fb" }}>
                {stageRows.map((d, i) => <Cell key={i} fill={PHASE_RAMP[d.phase]} />)}
                <LabelList
                  dataKey="count"
                  position="right"
                  formatter={(v) => {
                    const n = Number(v) || 0;
                    return n ? String(n) : "";
                  }}
                  style={{ fontSize: 10, fontWeight: 700, fill: "#111827" }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="stat-chart stat-chart--wide">
          <SubHead title="Top 10 Items" sub="by invoiced amount" />
          <ResponsiveContainer width="100%" height={230}>
            <BarChart data={itemTop} layout="vertical" margin={{ top: 0, right: 48, bottom: 0, left: 0 }} barCategoryGap={3}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="name" width={260} interval={0} tick={{ ...AXIS_TICK, fontSize: 10 }} tickLine={false} axisLine={false} />
              <Tooltip formatter={(v) => fmtMoney(cur, Number(v) || 0)} cursor={{ fill: "rgba(0,85,168,0.05)" }} />
              <Bar dataKey="amount" name="Revenue" fill="#2e8b57" radius={[0, 2, 2, 0]}>
                <LabelList dataKey="amount" position="right" formatter={(v) => compact(Number(v) || 0)}
                  style={{ fontSize: 10, fill: "#45526a" }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
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
}: {
  label: string;
  value: string | number;
  tip?: string;
  tone?: "red" | "amber";
  extra?: React.ReactNode;
}) {
  return (
    <div className={`stat-cell${tone ? ` ${tone}` : ""}`} title={tip}>
      <div className="stat-cell-l">{label}</div>
      <div className="stat-cell-v">
        <span>{value}</span>
        {extra}
      </div>
    </div>
  );
}
