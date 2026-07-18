"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  fetchPipeline,
  fetchRfqOverview,
  fetchPoWorkOptions,
  fetchCustomers,
  fetchSettingsVessels,
  addRfqStageNote,
  updateRfqStageNote,
  deleteRfqStageNote,
  setRfqCancelled,
  updateRfq,
  fetchAssignableUsers,
  resetStage,
  CLOSE_REASONS,
  closeReasonLabel,
} from "@/lib/api";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import {
  vendorOf,
  resolveSteps,
  fmtStageDate,
  stageDateOf,
  buildStageChain,
  joinDot,
} from "@/lib/deal";
import { INFO_FIELDS, DEFAULT_INFO_FIELDS } from "@/components/common/dealFields";
import { sortByDocNo } from "@/lib/sort";
import { useColumnLayout } from "@/components/common/useColumnLayout";
import { ColumnResizer, ColumnsButton, dragHandleProps } from "@/components/common/tableLayout";
import type { PipelineRow, CustomerOption, SettingsVessel, StageNote } from "@/lib/types";
import WorkTypeBadge from "@/components/WorkTypeBadge";
import CustomerName from "@/components/common/CustomerName";
import ActivityNoteForm, {
  initialNoteValue,
  type ActivityNoteValue,
} from "@/components/common/ActivityNoteForm";
import { useCustomerLogo } from "@/lib/customerLogos";
import VendorName from "@/components/common/VendorName";
import VendorMonograms from "@/components/common/VendorMonograms";
import ProjectNo from "@/components/common/ProjectNo";
import RfqActionTabs from "@/components/RfqActionTabs";
import NewRfqForm from "@/components/screens/NewRfqForm";
import { PoActionTabs } from "@/components/screens/PoScreen";
import { DocumentsOverview } from "@/components/screens/DocumentsScreen";
import { ArOverview } from "@/components/screens/ArScreen";
import ProjectOverviewScreen from "@/components/screens/ProjectOverviewScreen";
import { tr } from "@/lib/labels";
import { getUser, can, isOwnScoped, isAdmin } from "@/lib/auth";

// 고객확인용 7단계(RFQ 3 + Order 4) — 내부확인용과 동일한 표를 쓰되 단계만 7개.
const CUSTOMER_STEPS = [
  "RFQ Received",
  "Preparing Quotation",
  "Quotation Submitted",
  "Order Confirmed",
  "Under Production",
  "In Transit",
  "Delivered",
];
// 내부 11단계 → 고객 7단계 매핑(인덱스 = 내부단계-1). 필요 시 경계 조정.
const CUSTOMER_STAGE_MAP = [1, 2, 2, 3, 4, 5, 6, 7, 7, 7, 7];
function customerStage(internal: number): number {
  if (internal <= 0) return 0;
  return CUSTOMER_STAGE_MAP[Math.min(internal, 11) - 1] ?? 0;
}

// 내부 11단계 → 5개 중분류(영역): RFQ 1–2 / Quote 3–4 / PO 5–6 / Docs 7–9 / AR 10–11.
// (7 Readiness · 8 Complete·POD · 9 Tax·Billing 은 모두 Documents 페이지 탭 → Documents.)
const STAGE_PHASES: { label: string; count: number }[] = [
  { label: "RFQ", count: 2 },
  { label: "Quote", count: 2 },
  { label: "PO", count: 2 },
  { label: "Documents", count: 3 },
  { label: "AR", count: 2 },
];
// 5개 중분류 accent(보드 컬럼과 동일) — 타임라인 점 색상에 사용.
// RFQ~AR 중분류 색은 구분하지 않고 단일 파란색으로 통일(보드 컬럼과 동일).
const PHASE_ACCENTS = ["#0055a8", "#0055a8", "#0055a8", "#0055a8", "#0055a8"];

/** 현재 단계(stage)가 속한 중분류 인덱스. 미시작(0)이면 -1. */
function phaseIndexOfStage(stage: number): number {
  if (stage <= 0) return -1;
  let acc = 0;
  for (let i = 0; i < STAGE_PHASES.length; i++) {
    acc += STAGE_PHASES[i].count;
    if (stage <= acc) return i;
  }
  return STAGE_PHASES.length - 1;
}

/** ISO('YYYY-MM-DD…') → 관리번호와 같은 6자리 yymmdd(예: "260703"). 없으면 빈칸. */
function fmtYYMMDD(iso: string): string {
  const m = (iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[1].slice(2) + m[2] + m[3] : "";
}

/** 복수 통화 금액에서 주요(첫) 통화만: "KRW 6,614,200 USD 4,285" → "KRW 6,614,200". */
function primaryAmount(s: string): string {
  const m = (s || "").match(/[A-Z]{3}\s*[\d,.]+/);
  return m ? m[0].replace(/\s+/, " ") : s || "";
}

type Tab = "customer" | "internal";
type WorkspaceArea = "rfq" | "po" | "documents" | "ar";
type StageTabKey = number;

export default function ProjectsScreen() {
  const [tab, setTab] = useState<Tab>("internal");
  // 신규 RFQ 등록 팝업 — 화면 우측 하단 버튼으로 연다.
  const [newRfqOpen, setNewRfqOpen] = useState(false);
  // 딥링크(?rfq=<id> | ?order=<id> [&stage=N]) — 대시보드·전역검색 등에서 넘어오면
  // 내부확인용 목록의 해당 프로젝트 팝업을 그 단계로 연다. (모든 단계 작업의 단일 진입점)
  const router = useRouter();
  const params = useSearchParams();
  const deepRfq = params.get("rfq");
  const deepOrder = params.get("order");
  const deepStage = params.get("stage");
  const deepView = params.get("view");
  const [deepLink, setDeepLink] = useState<{
    rfqId: number | null;
    orderId: number | null;
    stage: number | null;
    view: "work" | "overview";
  } | null>(null);
  useEffect(() => {
    if (!deepRfq && !deepOrder) return;
    setTab("internal");
    setDeepLink({
      rfqId: deepRfq ? Number(deepRfq) : null,
      orderId: deepOrder ? Number(deepOrder) : null,
      stage: deepStage ? Number(deepStage) : null,
      view: deepView === "overview" ? "overview" : "work",
    });
    // URL 정리 — 새로고침마다 같은 팝업이 다시 열리지 않도록 파라미터를 제거한다.
    router.replace("/project", { scroll: false });
  }, [deepRfq, deepOrder, deepStage, deepView, router]);
  // 내부확인용·고객확인용 모두 통합 파이프라인(rows) 사용. 단계 체계만 12 vs 7로 다름.
  const {
    data: pipeline,
    error: pipeError,
    refresh: refreshPipeline,
  } = useCachedData("pipeline", () => fetchPipeline());
  // 편집 셀렉터용 고객사·선박 목록(카드 공통). 미리 로드해 두면 수정 진입 즉시 기존 값이 보인다.
  const { data: customers } = useCachedData("settings:customers", fetchCustomers);
  const { data: vessels } = useCachedData("settings:vessels", fetchSettingsVessels);

  // 삭제 등 변경 후: 파이프라인 목록 새로고침 + 대시보드 캐시 무효화
  function reloadPipeline() {
    invalidateCache("dashboard");
    return refreshPipeline();
  }

  return (
    <>
      <div className="page-tabs">
        <button
          className={tab === "internal" ? "on" : ""}
          onClick={() => setTab("internal")}
        >
          Progress (Internal)
        </button>
        <button
          className={tab === "customer" ? "on" : ""}
          onClick={() => setTab("customer")}
        >
          Progress (Customer)
        </button>
        <Link href="/activity" className="btn sm" style={{ marginLeft: "auto" }}>
          🗒 Activity Log
        </Link>
      </div>

      {tab === "customer" && (
        <>
          {/* 고객 트래킹용 현황 — 내부확인용과 동일한 표, 단계만 7단계(고객 추적) */}
          {pipeError && !pipeline ? (
            <div className="state error">API error: {pipeError.message}</div>
          ) : !pipeline ? (
            <div className="state">Loading…</div>
          ) : pipeline.rows.length === 0 ? (
            <div className="state">No deals registered.</div>
          ) : (
            <PipelineTable
              tableId="projects-customer"
              rows={pipeline.rows}
              steps={CUSTOMER_STEPS}
              stageOf={(r) => customerStage(r.stage)}
              // 금액 없는 구성 — 이 탭은 고객에게 보이는 정보를 확인하는 용도라
              // 매입가·마진이 화면에 있으면 안 된다(화면공유·이미지 내보내기 포함).
              columns={PIPELINE_COLUMNS_NO_MONEY}
              customers={customers ?? []}
              vessels={vessels ?? []}
              onChanged={reloadPipeline}
            />
          )}
        </>
      )}

      {tab === "internal" && (
        <>
          {/* 통합 파이프라인 — RFQ표·PO표를 흡수한 단일 목록. 행 클릭 시 상세 모달 */}
          {pipeError && !pipeline ? (
            <div className="state error">API error: {pipeError.message}</div>
          ) : !pipeline ? (
            <div className="state">Loading…</div>
          ) : pipeline.rows.length === 0 ? (
            <div className="state">No deals registered.</div>
          ) : (
            <PipelineTable
              tableId="projects-internal"
              rows={pipeline.rows}
              steps={pipeline.steps}
              customers={customers ?? []}
              vessels={vessels ?? []}
              onChanged={reloadPipeline}
              openRfqId={deepLink?.rfqId ?? null}
              openOrderId={deepLink?.orderId ?? null}
              openStage={deepLink?.stage ?? null}
              openView={deepLink?.view ?? "work"}
            />
          )}
        </>
      )}

      {/* 신규 RFQ 등록 — 화면 우측 하단 플로팅 버튼 → 기본정보 입력 팝업. */}
      {can("rfq", "create") ? (
        <button
          type="button"
          className="progress-fab"
          onClick={() => setNewRfqOpen(true)}
          title="Register a new RFQ"
        >
          + New RFQ
        </button>
      ) : null}
      {newRfqOpen ? (
        <PipelineModal
          isNew
          r={blankPipelineRow()}
          steps={pipeline?.steps ?? []}
          customers={customers ?? []}
          vessels={vessels ?? []}
          onChanged={reloadPipeline}
          onClose={() => setNewRfqOpen(false)}
        />
      ) : null}
    </>
  );
}

/** 신규 프로젝트용 빈 PipelineRow — "+ New RFQ" 팝업을 기존 프로젝트 모달과 동일한
 *  껍데기(단계 탭·좌측 정보·우측 상세)로 열기 위한 시드. 저장 전까지 rfq_id=0. */
function blankPipelineRow(): PipelineRow {
  return {
    rfq_id: 0,
    order_id: 0,
    customer_rfq_no: "",
    kmaris_rfq_no: "",
    work_type: "부품공급",
    trade_type: "수출",
    customer: "",
    customer_id: 0,
    vessel: "",
    vessel_id: 0,
    project_title: "",
    received_at: "",
    first_rfq_at: "",
    project_no: "",
    assignee: "",
    assignee_id: 0,
    item_count: 0,
    first_item: "",
    crfq_at: "",
    vrfq_vendors: "",
    vrfq_at: "",
    vquote_no: "",
    vquote_at: "",
    vendor_amount: "",
    cquote_no: "",
    cquote_at: "",
    customer_amount: "",
    sales_total: "",
    purchase_total: "",
    margin_amount: "",
    margin_pct: null,
    vessels: "",
    customer_po_nos: "",
    order_amount: "",
    customer_po_no: "",
    customer_po_at: "",
    vendor_po_no: "",
    vendor_po_at: "",
    vendor: "",
    vendor_email: "",
    stage: 0,
    status: "",
    stage_dates: {},
    stage_auto: {},
    stage_notes: {},
  };
}

// 상세편집 단계 제목의 보조 설명(괄호) — 발신/수신 주체를 회색으로 덧붙인다.
// 단계 제목 본문(steps[])은 짧게 유지하고, 이 자격 문구는 상세 헤더에서만 표기.
const STAGE_TITLE_QUALIFIER: Record<number, string> = {
  1: "from Customer",
  2: "to Vendor",
  3: "from Vendor",
  4: "to Customer",
  5: "from Customer",
  6: "to Vendor",
};

/** 완료한 단계 라벨: "N. 라벨" (stage가 0이면 "미시작"). */
function doneStageLabel(stage: number, steps: string[]): string {
  if (stage <= 0) return "Not started";
  return `${stage}. ${steps[stage - 1] ?? ""}`;
}

/** 다음 단계 라벨: stage+1 (12단계 완료면 "완료"). */
function nextStageLabel(stage: number, steps: string[]): string {
  if (stage >= steps.length) return "Done";
  const n = Math.max(stage, 0);
  return `${n + 1}. ${steps[n] ?? ""}`;
}

/** 단계 시각화 — steps.length 칸 세그먼트 바(현재 단계까지 채움) + 아래에 완료/다음 단계. */
function StageBar({ stage, steps }: { stage: number; steps: string[] }) {
  const total = steps.length;
  const filled = Math.max(0, Math.min(stage, total));
  const done = doneStageLabel(stage, steps);
  const next = nextStageLabel(stage, steps);
  // 내부 12단계에서만 4개 중분류로 그룹핑(고객확인용 7단계는 기존 평면 바 유지).
  const grouped = total === 11;
  const curPhase = grouped ? phaseIndexOfStage(stage) : -1;
  return (
    <div className="pl-stage">
      <div className="pl-stage-top">
        {grouped ? (
          <span className="pl-stage-segwrap">
            <span className="pl-stage-phases">
              {STAGE_PHASES.map((p, pi) => (
                <span
                  key={p.label}
                  className={`ph${pi === curPhase ? " on" : ""}`}
                  style={{ flexGrow: p.count }}
                  title={p.label}
                >
                  {p.label}
                </span>
              ))}
            </span>
            <span className="pl-stage-segs grouped">
              {STAGE_PHASES.map((p, pi) => {
                const start = STAGE_PHASES.slice(0, pi).reduce((s, x) => s + x.count, 0);
                return (
                  <span key={p.label} className="seg-group" style={{ flexGrow: p.count }}>
                    {Array.from({ length: p.count }).map((_, k) => {
                      const gi = start + k;
                      return <span key={gi} className={`seg${gi < filled ? " on" : ""}`} />;
                    })}
                  </span>
                );
              })}
            </span>
          </span>
        ) : (
          <span className="pl-stage-segs">
            {Array.from({ length: total }).map((_, i) => (
              <span key={i} className={`seg${i < filled ? " on" : ""}`} />
            ))}
          </span>
        )}
        <span className="pl-stage-num">
          {filled}/{total}
        </span>
      </div>
      <div className="pl-stage-meta">
        <span className="pl-stage-done" title={done}>{done}</span>
        <span className="pl-stage-arrow">→</span>
        <span className="pl-stage-next" title={next}>{next}</span>
      </div>
    </div>
  );
}

/** 정렬·필터가 걸리는 개별 필드. 화면의 열(ColKey)보다 잘게 나뉜다. */
type FieldKey =
  | "received_at"
  | "customer"
  | "vendor"
  | "work_type"
  | "vessel"
  | "project_title"
  | "stage"
  | "assignee"
  | "margin_pct";

/**
 * 화면의 열 = 관련 필드를 묶은 그룹. 한 셀 안에 여러 줄로 쌓는다(다행 레이아웃).
 * 열을 잘게 쪼개 두면 프로젝트명·벤더명·이중통화 금액이 좁은 칸에서 단어 중간에
 * 잘려서, 필드를 읽는 순서(무엇→누구→얼마)대로 묶었다.
 */
type ColKey = "project" | "customer" | "vendor" | "stage" | "amounts" | "assignee";

const PIPELINE_COLUMNS: { key: ColKey; label: string }[] = [
  { key: "project", label: "Project" },
  { key: "customer", label: "Customer" },
  { key: "vendor", label: "Vendor" },
  { key: "stage", label: "Stage" },
  { key: "amounts", label: "Amounts" },
  { key: "assignee", label: "PIC" },
];

/** 금액 열을 뺀 구성 — 고객확인용 탭. 매입가·마진은 고객에게 보일 수 없다. */
const PIPELINE_COLUMNS_NO_MONEY = PIPELINE_COLUMNS.filter((c) => c.key !== "amounts");

/**
 * 그룹 열이 품는 정렬 기준. 여러 필드를 한 열에 접었으므로 메뉴가 필드별 정렬을 제공해야
 * 접기 전에 있던 기능이 사라지지 않는다.
 * 금액(Sales·Purchase)은 정렬 대상이 아니다 — 서버가 "USD 8,000 KRW 12,347,280" 같은
 * 이중통화 '문자열'만 내려줘서, 통화가 섞인 행들을 숫자로 비교할 방법이 없다. 마진율만
 * 숫자(margin_pct)라 정렬이 가능하다.
 */
const COL_SORTS: Record<ColKey, { key: FieldKey; label: string }[]> = {
  project: [
    { key: "received_at", label: "Project No." },
    { key: "project_title", label: "Title" },
  ],
  customer: [{ key: "customer", label: "Customer" }],
  vendor: [{ key: "vendor", label: "Vendor" }],
  stage: [{ key: "stage", label: "Stage" }],
  amounts: [{ key: "margin_pct", label: "Margin %" }],
  assignee: [{ key: "assignee", label: "PIC" }],
};

/** 그룹 열이 품는 패싯 필터(값 목록). 수신일 범위는 project 열이 따로 렌더한다. */
const COL_FILTERS: Record<ColKey, FieldKey[]> = {
  project: ["work_type", "vessel"],
  customer: ["customer"],
  vendor: ["vendor"],
  stage: ["stage"],
  amounts: [],
  assignee: ["assignee"],
};

/** 필터 섹션 제목 — 한 메뉴에 목록이 둘 이상 들어가면 무엇을 고르는지 밝혀야 한다. */
const FIELD_LABEL: Partial<Record<FieldKey, string>> = {
  work_type: "Type",
  vessel: "Vessel",
  customer: "Customer",
  vendor: "Vendor",
  stage: "Stage",
  assignee: "PIC",
};

// 컬럼 key → 기본 폭 CSS 클래스(table-layout: fixed 기준폭).
const PLC_CLASS: Record<ColKey, string> = {
  project: "plc-project",
  customer: "plc-customer",
  vendor: "plc-vendor",
  stage: "plc-stage",
  amounts: "plc-amounts",
  assignee: "plc-assignee",
};

// 보드 카드 벤더 배지: P/O 발주 벤더가 정해지기 전에는 RFQ 발송 벤더 + 견적 수신여부를
// 넘겨 미제출 벤더를 고스트로 표시한다. P/O 이후엔(문자열) 그대로 정상 표시.
function vendorStatusesFor(r: PipelineRow): { name: string; quoted: boolean }[] | undefined {
  if (r.vendor) return undefined; // 발주 벤더 확정 → 문자열 fallback(모두 정상)
  return r.rfq_vendors && r.rfq_vendors.length ? r.rfq_vendors : undefined;
}

/** 한 행에서 필드별 텍스트 값(검색·문자열 정렬용). */
function cellText(r: PipelineRow, key: FieldKey, steps: string[]): string {
  switch (key) {
    case "received_at":
      // 정렬/검색은 화면에 표시되는 관리번호(yymmdd-nn) 기준.
      return r.project_no || "";
    case "customer":
      return r.customer || "";
    case "vendor":
      return vendorOf(r);
    case "work_type":
      return r.work_type || "부품공급";
    case "vessel":
      return r.vessel || "";
    case "project_title":
      return r.project_title || "";
    case "stage":
      return doneStageLabel(r.stage, steps);
    case "assignee":
      return r.assignee || "";
    case "margin_pct":
      // 숫자 정렬 경로로 빠지므로 문자열은 쓰이지 않는다(검색 blob 용 표기만).
      return r.margin_pct != null ? String(r.margin_pct) : "";
  }
}

type SortDir = "asc" | "desc";

/** 통합 파이프라인 테이블 — 프로젝트 1건 = 1행(셀 안은 여러 줄). 헤더 클릭 정렬 + 컬럼별
 *  필터, 행 클릭 시 상세 모달.
 *  열: 프로젝트(번호·타입·선박·제목) · 고객사(+담당자) · 벤더 · 단계 · 금액 · PIC */
function PipelineTable({
  rows,
  steps,
  customers,
  vessels,
  onChanged,
  stageOf = (r) => r.stage,
  tableId = "projects-internal",
  columns = PIPELINE_COLUMNS,
  openRfqId = null,
  openOrderId = null,
  openStage = null,
  openView = "work",
}: {
  rows: PipelineRow[];
  steps: string[];
  customers: CustomerOption[];
  vessels: SettingsVessel[];
  onChanged: () => void | Promise<unknown>;
  // 단계 체계 추상화: 내부확인용=11단계(r.stage), 고객확인용=7단계(매핑값)
  stageOf?: (r: PipelineRow) => number;
  // 컬럼 커스터마이즈 저장 키(내부/고객 뷰 별도).
  // 열이 8개 단일필드 → 6개 그룹으로 바뀌면서 progress-* 에서 projects-* 로 갈아탔다.
  // 옛 키를 그대로 쓰면 customer·vendor·stage·assignee 는 key 가 같아 살아남는 바람에,
  // 좁은 단일필드용으로 저장해 둔 폭이 다행 그룹 열에 그대로 먹어 답답해진다.
  tableId?: string;
  // 표시할 열 구성. 고객확인용은 금액을 뺀 구성을 넘긴다 — tableId 로 분기하지 않고
  // 명시적으로 받는다. 저장키 이름이 바뀌어도 매입가·마진이 새지 않게.
  columns?: { key: ColKey; label: string }[];
  // 딥링크: rfq_id(우선) 또는 order_id 로 해당 프로젝트 팝업을 openStage 단계로 1회 자동 오픈.
  openRfqId?: number | null;
  openOrderId?: number | null;
  openStage?: number | null;
  openView?: "work" | "overview";
}) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [initialModalView, setInitialModalView] = useState<"work" | "overview">("work");
  // 딥링크로 열 때만 지정 단계로 진입. 수동 오픈 시엔 null → 해당 프로젝트의 현재 단계로.
  const [deepStage, setDeepStage] = useState<number | null>(null);
  // 딥링크 1회 소비 가드(행 로드 지연·재렌더 시 닫은 팝업이 다시 열리지 않도록).
  const deepConsumed = useRef(false);
  // 목록·상세 모달 공용 오픈 헬퍼(수동 오픈은 지정 단계 없음).
  const openRow = useCallback((id: number) => {
    setInitialModalView("work");
    setSelectedId(id);
    setDeepStage(null);
  }, []);
  const openOverview = useCallback((id: number) => {
    setInitialModalView("overview");
    setSelectedId(id);
    setDeepStage(null);
  }, []);
  useEffect(() => {
    if (deepConsumed.current) return;
    if (!openRfqId && !openOrderId) return;
    if (rows.length === 0) return; // 목록 로드 대기
    const id =
      openRfqId ?? rows.find((r) => r.order_id === openOrderId)?.rfq_id ?? null;
    if (!id) return;
    deepConsumed.current = true;
    setInitialModalView(openView);
    setSelectedId(id);
    setDeepStage(openStage && openStage > 0 ? openStage : null);
  }, [openRfqId, openOrderId, openStage, openView, rows]);
  // 목록 표시 방식: 표(table) / 칸반 보드(board). 같은 데이터·같은 상세 모달 재사용.
  const [view, setView] = useState<"table" | "board">("board");
  // 현황판 전체 미리보기(A4 가로 이미지) 팝업 열림 여부.
  const [previewOpen, setPreviewOpen] = useState(false);
  // 보드 카드 밀도: 상세(false) / 간략(true). 간략이면 모든 카드를 한 줄 요약으로 접어 전체를 한눈에.
  const [boardCompact, setBoardCompact] = useState<boolean>(
    () => typeof window !== "undefined" && window.localStorage.getItem("ktms:board-compact") === "1"
  );
  useEffect(() => {
    if (typeof window !== "undefined")
      window.localStorage.setItem("ktms:board-compact", boardCompact ? "1" : "0");
  }, [boardCompact]);
  // 기본 정렬: 관리번호(Project No.) 내림차순 — 최근 프로젝트가 맨 위.
  const [sortKey, setSortKey] = useState<FieldKey | null>("received_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [dragKey, setDragKey] = useState<string | null>(null);
  // 컬럼 폭·순서·표시여부 (localStorage 저장)
  const layout = useColumnLayout(tableId, columns);
  const drag = { active: dragKey, set: setDragKey };
  const orderedColumns = layout.visibleKeys
    .map((k) => columns.find((c) => c.key === k))
    .filter((c): c is { key: ColKey; label: string } => !!c);
  // 담당자(PIC) 범위: sales 는 서버에서 본인 건만 내려오므로 항상 잠금 표시.
  // admin/viewer 는 "내 담당만" 토글로 본인(username) 건만 클라이언트 필터.
  const me = getUser();
  const salesScoped = isOwnScoped();
  const [mineOnly, setMineOnly] = useState(false);
  // 종결(취소·실주) 프로젝트는 기본으로 접는다 — 표는 "지금 뭘 해야 하나"를 보는 곳이라
  // 끝난 건이 섞이면 훑는 데 방해가 된다. 보드는 Closed 칸으로 따로 모으므로 표에만 적용.
  const [showClosed, setShowClosed] = useState(false);
  // 패싯 필터: 각 값 "전체"는 미적용. 빈 문자열("")은 "미지정" 값 자체를 의미.
  const [fWorkType, setFWorkType] = useState("전체");
  const [fCustomer, setFCustomer] = useState("전체");
  const [fVendor, setFVendor] = useState("전체");
  const [fVessel, setFVessel] = useState("전체");
  const [fAssignee, setFAssignee] = useState("전체");
  const [fStage, setFStage] = useState("전체"); // 단계 번호 문자열
  const [fFrom, setFFrom] = useState(""); // 수신일 From "YYYY-MM-DD"
  const [fTo, setFTo] = useState(""); // 수신일 To
  // 헤더 클릭 시 뜨는 컬럼 메뉴(정렬+필터). fixed 위치라 가로 스크롤에 잘리지 않는다.
  const [openCol, setOpenCol] = useState<ColKey | null>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  function openMenu(key: ColKey, e: React.MouseEvent<HTMLElement>) {
    if (openCol === key) {
      setOpenCol(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const width = 240;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    setMenuPos({ left, top: rect.bottom + 4 });
    setOpenCol(key);
  }
  function applySort(key: FieldKey, dir: SortDir) {
    setSortKey(key);
    setSortDir(dir);
    setOpenCol(null);
  }

  // 필드별 필터 값/세터/활성여부 — 메뉴에서 공통 사용
  function fieldValue(key: FieldKey): string {
    switch (key) {
      case "customer": return fCustomer;
      case "vendor": return fVendor;
      case "work_type": return fWorkType;
      case "vessel": return fVessel;
      case "assignee": return fAssignee;
      case "stage": return fStage;
      default: return "전체";
    }
  }
  function setFieldValue(key: FieldKey, v: string) {
    switch (key) {
      case "customer": setFCustomer(v); break;
      case "vendor": setFVendor(v); break;
      case "work_type": setFWorkType(v); break;
      case "vessel": setFVessel(v); break;
      case "assignee": setFAssignee(v); break;
      case "stage": setFStage(v); break;
    }
    setOpenCol(null);
  }
  function isFieldFiltered(key: FieldKey): boolean {
    if (key === "received_at") return !!(fFrom || fTo);
    return fieldValue(key) !== "전체";
  }
  /** 그룹 열 머리글의 '필터 걸림' 표시 — 품고 있는 필드 중 하나라도 걸려 있으면 활성. */
  function isColFiltered(key: ColKey): boolean {
    if (key === "project" && (fFrom || fTo)) return true;
    return COL_FILTERS[key].some(isFieldFiltered);
  }

  // 드롭다운 옵션: 현재 데이터에 실제 존재하는 값만(한글 정렬). 빈 값은 "" 으로 포함(미지정).
  function distinct(getVal: (r: PipelineRow) => string): string[] {
    return Array.from(new Set(rows.map(getVal))).sort((a, b) => a.localeCompare(b, "ko"));
  }
  const workTypeOpts = distinct((r) => r.work_type || "부품공급");
  const customerOpts = distinct((r) => r.customer || "");
  const vendorOpts = distinct(vendorOf);
  const vesselOpts = distinct((r) => r.vessel || "");
  const assigneeOpts = distinct((r) => r.assignee || "");
  // 단계 옵션: 데이터에 존재하는 stage 번호를 오름차순으로
  const stageOpts = Array.from(new Set(rows.map((r) => stageOf(r)))).sort((a, b) => a - b);

  // 메뉴 값 목록(전체 + 데이터 고유값). 날짜·필터없는 필드는 빈 배열.
  function colOptions(key: FieldKey): { v: string; label: string }[] {
    const all = { v: "전체", label: "All" };
    switch (key) {
      case "customer":
        return [all, ...customerOpts.map((v) => ({ v, label: v || "Unspecified" }))];
      case "vendor":
        return [all, ...vendorOpts.map((v) => ({ v, label: v || "Unspecified" }))];
      case "work_type":
        return [all, ...workTypeOpts.map((v) => ({ v, label: tr(v) }))];
      case "vessel":
        return [all, ...vesselOpts.map((v) => ({ v, label: v || "No vessel" }))];
      case "assignee":
        return [all, ...assigneeOpts.map((v) => ({ v, label: v || "Unspecified" }))];
      case "stage":
        return [all, ...stageOpts.map((s) => ({ v: String(s), label: doneStageLabel(s, steps) }))];
      default:
        return [];
    }
  }

  const filtersActive =
    fWorkType !== "전체" ||
    fCustomer !== "전체" ||
    fVendor !== "전체" ||
    fVessel !== "전체" ||
    fAssignee !== "전체" ||
    fStage !== "전체" ||
    fFrom !== "" ||
    fTo !== "";

  function resetFilters() {
    setFWorkType("전체");
    setFCustomer("전체");
    setFVendor("전체");
    setFVessel("전체");
    setFAssignee("전체");
    setFStage("전체");
    setFFrom("");
    setFTo("");
  }

  // 수신일(received_at "YYYY-MM-DDTHH:MM")의 날짜부가 [from, to] 범위인지. 날짜 없으면 범위 지정 시 제외.
  function inDateRange(received: string): boolean {
    if (!fFrom && !fTo) return true;
    const d = (received || "").slice(0, 10);
    if (!d) return false;
    if (fFrom && d < fFrom) return false;
    if (fTo && d > fTo) return false;
    return true;
  }

  // 1) 필터: 선택한 조건들의 교집합(AND)
  const myName = me?.username || "";
  let displayRows = rows.filter(
    (r) =>
      (fWorkType === "전체" || (r.work_type || "부품공급") === fWorkType) &&
      (fCustomer === "전체" || (r.customer || "") === fCustomer) &&
      (fVendor === "전체" || vendorOf(r) === fVendor) &&
      (fVessel === "전체" || (r.vessel || "") === fVessel) &&
      (fAssignee === "전체" || (r.assignee || "") === fAssignee) &&
      (fStage === "전체" || stageOf(r) === Number(fStage)) &&
      (!mineOnly || (r.assignee || "") === myName) &&
      inDateRange(r.received_at)
  );
  // 2) 정렬: 단계·마진율은 숫자, 그 외는 표시 문자열(한글 로케일)
  if (sortKey) {
    const key = sortKey;
    const dir = sortDir === "asc" ? 1 : -1;
    displayRows = [...displayRows].sort((a, b) => {
      let cmp: number;
      if (key === "stage") {
        cmp = stageOf(a) - stageOf(b);
      } else if (key === "margin_pct") {
        // 마진율이 없는 행(견적 전·매입 미정)은 방향과 무관하게 항상 아래로 — 정렬을
        // 걸었을 때 빈 행이 상단을 차지하면 비교하려던 숫자가 화면에서 밀려난다.
        const av = a.margin_pct, bv = b.margin_pct;
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        cmp = av - bv;
      } else {
        cmp = cellText(a, key, steps).localeCompare(cellText(b, key, steps), "ko");
      }
      return cmp * dir;
    });
  }

  // 3) 표에서만 종결 프로젝트를 접는다. 보드는 Closed 칸에 따로 모으는 구조라 여기서
  //    걸러내면 그 칸이 늘 비어 버린다.
  const closedCount = displayRows.filter((r) => r.cancelled).length;
  const tableRows = showClosed ? displayRows : displayRows.filter((r) => !r.cancelled);
  const shownRows = view === "table" ? tableRows : displayRows;

  // 새로고침 후에도 rfq_id로 다시 찾으므로 모달이 최신 값으로 유지된다(삭제되면 null → 자동 닫힘).
  const selected = rows.find((r) => r.rfq_id === selectedId) ?? null;

  // 인접 프로젝트 전환 — "현재 보이는 목록 순서"(shownRows: 표=tableRows, 보드=displayRows)에서
  // 위/아래 이웃으로. 양 끝에선 제자리(넘어갈 곳 없음). 방향 전환 시 딥링크 단계는 비운다.
  const navigateSelected = useCallback(
    (dir: -1 | 1) => {
      setSelectedId((cur) => {
        if (cur == null) return cur;
        const idx = shownRows.findIndex((r) => r.rfq_id === cur);
        if (idx < 0) return cur;
        const next = shownRows[idx + dir];
        return next ? next.rfq_id : cur;
      });
      setDeepStage(null);
    },
    [shownRows]
  );

  /**
   * 헤더 클릭 시 뜨는 컬럼 메뉴: 정렬 + 필터.
   * 그룹 열이라 한 메뉴가 여러 필드를 담는다 — 정렬 기준이 둘 이상이면 기준별로 ▲▼ 를
   * 주고, 필터 목록이 둘 이상이면 각 목록에 필드 이름표를 붙인다. 그래야 Vessel·Type 처럼
   * Project 열 안으로 접힌 필드도 고르는 곳이 남는다.
   */
  function renderColMenu(col: ColKey) {
    const sorts = COL_SORTS[col];
    const filters = COL_FILTERS[col];
    const showDate = col === "project";
    // 정렬 기준에 이름표를 붙일지 — 기준이 여럿이거나, 하나뿐이어도 그 이름이 열 이름과
    // 다를 때(Amounts 열은 'Margin %' 로만 정렬된다). 맨 Ascending/Descending 만 두면
    // 무엇을 기준으로 줄 세우는지 알 수 없다.
    const colLabel = columns.find((c) => c.key === col)?.label ?? "";
    const sortCaps = sorts.length > 1 || (sorts[0] && sorts[0].label !== colLabel);
    return (
      <>
        <div className="pl-menu-backdrop" onClick={() => setOpenCol(null)} />
        <div
          className="pl-col-menu"
          style={{ left: menuPos.left, top: menuPos.top }}
          role="menu"
        >
          {sorts.map((s) => (
            <div key={s.key} className="pl-menu-sort">
              {/* 기준 이름이 열 이름과 같고 하나뿐이면 이름표 없이 — 기존과 같은 모양. */}
              {sortCaps ? <span className="pl-menu-cap">{s.label}</span> : null}
              <button
                className={sortKey === s.key && sortDir === "asc" ? "on" : ""}
                onClick={() => applySort(s.key, "asc")}
              >
                <span className="ic">▲</span> {sortCaps ? "Asc" : "Ascending"}
              </button>
              <button
                className={sortKey === s.key && sortDir === "desc" ? "on" : ""}
                onClick={() => applySort(s.key, "desc")}
              >
                <span className="ic">▼</span> {sortCaps ? "Desc" : "Descending"}
              </button>
            </div>
          ))}

          {filters.map((f) => {
            const opts = colOptions(f);
            if (opts.length === 0) return null;
            return (
              <div key={f}>
                <div className="pl-menu-divider" />
                {filters.length > 1 ? (
                  <span className="pl-menu-cap">{FIELD_LABEL[f]}</span>
                ) : null}
                <div className="pl-menu-list">
                  {opts.map((o) => (
                    <button
                      key={o.v}
                      className={`pl-menu-opt${fieldValue(f) === o.v ? " on" : ""}`}
                      onClick={() => setFieldValue(f, o.v)}
                    >
                      <span className="chk">{fieldValue(f) === o.v ? "✓" : ""}</span>
                      <span className="lbl">{o.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}

          {showDate ? (
            <>
              <div className="pl-menu-divider" />
              <div className="pl-menu-date">
                <span className="pl-menu-cap">Received range</span>
                <input type="date" value={fFrom} onChange={(e) => setFFrom(e.target.value)} aria-label="Received from" />
                <span className="pl-menu-tilde">~</span>
                <input type="date" value={fTo} onChange={(e) => setFTo(e.target.value)} aria-label="Received to" />
                {fFrom || fTo ? (
                  <button
                    className="pl-menu-clear"
                    onClick={() => {
                      setFFrom("");
                      setFTo("");
                    }}
                  >
                    Clear range
                  </button>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="pl-toolbar">
        {salesScoped ? (
          <span className="pl-scope-badge" title="Sales accounts see only their own deals">
            🔒 My deals only
          </span>
        ) : (
          <label className="pl-mine-toggle">
            <input
              type="checkbox"
              checked={mineOnly}
              onChange={(e) => setMineOnly(e.target.checked)}
            />
            My deals only
          </label>
        )}
        {/* 종결 프로젝트 토글 — 표에서만 의미가 있다(보드는 Closed 칸으로 분리). */}
        {view === "table" && closedCount > 0 ? (
          <label className="pl-mine-toggle">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(e) => setShowClosed(e.target.checked)}
            />
            Show closed ({closedCount})
          </label>
        ) : null}
        {filtersActive ? (
          <button type="button" className="pl-filter-reset" onClick={resetFilters}>
            Reset filters
          </button>
        ) : null}
        <span className="pl-search-count">
          {shownRows.length} / {rows.length}
        </span>
        {view === "table" ? <ColumnsButton cols={columns} layout={layout} /> : null}
        {view === "board" ? (
          <span className="pl-view-toggle" role="group" aria-label="카드 밀도">
            <button
              type="button"
              className={!boardCompact ? "on" : ""}
              aria-pressed={!boardCompact}
              onClick={() => setBoardCompact(false)}
              title="카드를 상세하게 표시"
            >
              ▤ Detailed
            </button>
            <button
              type="button"
              className={boardCompact ? "on" : ""}
              aria-pressed={boardCompact}
              onClick={() => setBoardCompact(true)}
              title="모든 카드를 한 줄 요약으로 접어 전체를 한눈에"
            >
              ▬ Compact
            </button>
          </span>
        ) : null}
        {view === "board" ? (
          <button
            type="button"
            className="btn sm pl-preview-btn"
            onClick={() => setPreviewOpen(true)}
            title="현황판 전체를 A4 가로 1장으로 미리보기 · 이미지 저장"
          >
            🖼 Preview
          </button>
        ) : null}
        <span className="pl-view-toggle" role="tablist" aria-label="View mode">
          <button
            type="button"
            className={view === "table" ? "on" : ""}
            aria-pressed={view === "table"}
            onClick={() => setView("table")}
          >
            ▤ Table
          </button>
          <button
            type="button"
            className={view === "board" ? "on" : ""}
            aria-pressed={view === "board"}
            onClick={() => setView("board")}
          >
            ▦ Board
          </button>
        </span>
      </div>

      {view === "board" ? (
        <PipelineBoard
          rows={displayRows}
          steps={steps}
          stageOf={stageOf}
          selectedId={selectedId}
          onSelect={openRow}
          onOverview={openOverview}
          compact={boardCompact}
        />
      ) : (
      <div className="pl-table-wrap">
        <table className="pipeline customizable">
          <colgroup>
            {orderedColumns.map((c) => {
              const w = layout.widths[c.key];
              return (
                <col
                  key={c.key}
                  className={PLC_CLASS[c.key]}
                  style={w ? { width: w, minWidth: w } : undefined}
                />
              );
            })}
            {/* 개요 열 — 사용자가 옮기거나 숨기는 열(PIPELINE_COLUMNS) 밖에 고정으로 둔다.
                행 어디를 눌러도 편집 팝업이 열리므로, 읽기 전용 개요로 갈 문은 따로 필요하다. */}
          </colgroup>
          <thead>
            <tr>
              {orderedColumns.map((c) => {
                // 그룹 열 — 품고 있는 정렬 기준 중 하나라도 걸려 있으면 정렬된 열로 표시.
                const sorted = COL_SORTS[c.key].some((s) => s.key === sortKey);
                const filtered = isColFiltered(c.key);
                return (
                  <th
                    key={c.key}
                    className={`pl-th${openCol === c.key ? " open" : ""}${
                      sorted || filtered ? " active" : ""
                    }${dragKey === c.key ? " dragging" : ""}`}
                    aria-sort={
                      sorted ? (sortDir === "asc" ? "ascending" : "descending") : "none"
                    }
                  >
                    <button
                      type="button"
                      className="pl-th-btn"
                      onClick={(e) => openMenu(c.key, e)}
                      {...dragHandleProps(c.key, layout, drag)}
                    >
                      <span className="pl-th-label">{c.label}</span>
                      {filtered ? <span className="pl-th-dot" title="Filter applied" /> : null}
                      <span className="pl-th-caret">
                        {sorted ? (sortDir === "asc" ? "▲" : "▼") : "▾"}
                      </span>
                    </button>
                    <ColumnResizer onResize={(px) => layout.setWidth(c.key, px)} onResizeEnd={layout.commitWidths} />
                  </th>
                );
              })}
              {/* 정렬·필터·리사이즈가 없는 고정 열이라 pl-th 머리 장치를 붙이지 않는다. */}
            </tr>
          </thead>
          <tbody>
            {tableRows.length === 0 ? (
              <tr>
                <td className="pl-empty" colSpan={orderedColumns.length}>
                  No deals match the filters.
                </td>
              </tr>
            ) : (
              tableRows.map((r) => {
                const isService = (r.work_type || "부품공급") === "서비스";
                return (
                  <tr
                    key={`p-${r.rfq_id}`}
                    className={`${isService ? "service " : ""}${
                      r.cancelled ? "closed " : ""
                    }${selectedId === r.rfq_id ? "sel" : ""}`}
                    onClick={() => openRow(r.rfq_id)}
                  >
                    {orderedColumns.map((c) => (
                      <PipelineCell
                        key={c.key}
                        colKey={c.key}
                        r={r}
                        steps={steps}
                        stage={stageOf(r)}
                        onOverview={() => openOverview(r.rfq_id)}
                      />
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      )}

      {openCol ? renderColMenu(openCol) : null}

      {selected ? (
        <PipelineModal
          r={selected}
          steps={steps}
          customers={customers}
          vessels={vessels}
          onChanged={onChanged}
          initialStage={deepStage}
          initialView={initialModalView}
          onNavigate={navigateSelected}
          onClose={() => {
            setSelectedId(null);
            setDeepStage(null);
          }}
        />
      ) : null}

      {previewOpen ? (
        <BoardPreviewModal
          rows={displayRows}
          steps={steps}
          stageOf={stageOf}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
    </>
  );
}

/** first_rfq_at('YYYY-MM-DD…') 로부터 경과 일수. 파싱 불가면 null. */
function daysSince(iso: string): number | null {
  const t = Date.parse((iso || "").slice(0, 10));
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

type BoardCol = {
  label: string;
  variant?: "done" | "cancelled";
  match: (r: PipelineRow) => boolean;
};

/** 내부 11단계 보드의 컬럼 정의(Closed·RFQ·Quote·PO·Documents·AR·Done). 보드/미리보기 공용. */
function groupedBoardColumns(stageOf: (r: PipelineRow) => number): BoardCol[] {
  return [
    { label: "Closed", variant: "cancelled", match: (r) => !!r.cancelled },
    { label: "RFQ", match: (r) => !r.cancelled && stageOf(r) <= 2 },
    { label: "Quote", match: (r) => !r.cancelled && stageOf(r) >= 3 && stageOf(r) <= 4 },
    { label: "PO", match: (r) => !r.cancelled && stageOf(r) >= 5 && stageOf(r) <= 6 },
    { label: "Documents", match: (r) => !r.cancelled && stageOf(r) >= 7 && stageOf(r) <= 9 },
    { label: "AR", match: (r) => !r.cancelled && stageOf(r) === 10 },
    { label: "Done ✓", variant: "done", match: (r) => !r.cancelled && stageOf(r) >= 11 },
  ];
}

/**
 * 칸반 보드 — 테이블과 동일한 데이터(displayRows)를 단계 영역별 컬럼으로 시각화.
 * 12단계는 4개 중분류(RFQ&Quotation·PO·Documents·AR)로, 고객 7단계는 단계별 컬럼으로.
 * 카드 클릭 시 테이블과 동일한 상세 모달(onSelect)을 연다.
 */
function PipelineBoard({
  rows,
  steps,
  stageOf,
  selectedId,
  onSelect,
  onOverview,
  compact,
}: {
  rows: PipelineRow[];
  steps: string[];
  stageOf: (r: PipelineRow) => number;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onOverview: (id: number) => void;
  compact: boolean;
}) {
  // 카드별 접힘 예외: 글로벌 밀도와 반대로 뒤집힌 카드 id 집합.
  // 글로벌 토글이 바뀌면 예외를 초기화해 전체가 새 기본값을 따르게 함.
  const [flipped, setFlipped] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    setFlipped(new Set());
  }, [compact]);
  const toggleCard = useCallback((id: number) => {
    setFlipped((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const grouped = steps.length === 11;
  // 종결(취소/실주) 딜은 진행 컬럼에서 빼고 별도 Closed 존(RFQ 좌측 맨 앞)으로 모은다.
  // 완료(11단계 Payment Completed)는 AR 을 떠나 Done 컬럼으로 종결 처리한다.
  const cols: BoardCol[] = grouped
    ? groupedBoardColumns(stageOf)
    : steps.map((label, i) => ({
        label: `${i + 1}. ${label}`,
        match: (r: PipelineRow) => !r.cancelled && stageOf(r) === i + 1,
      }));

  return (
    <div className="pl-board">
      {cols.map((col, ci) => {
        const cards = rows.filter((r) => col.match(r));
        // Cancelled 존은 종결 딜이 하나도 없으면 아예 표시하지 않는다(평소 보드는 깔끔하게).
        if (col.variant === "cancelled" && cards.length === 0) return null;
        return (
          <section
            key={ci}
            className={`pl-board-col${col.variant ? ` ${col.variant}` : ""}`}
          >
            <header className="pl-board-head">
              {/* 단계 작업은 카드 클릭 → 프로젝트 팝업에서 처리(별도 작업 페이지 없음). */}
              <span className="pl-board-title" title={col.label}>{col.label}</span>
              <span className="pl-board-count">{cards.length}</span>
            </header>
            <div className="pl-board-list">
              {cards.length === 0 ? (
                <div className="pl-board-empty">—</div>
              ) : (
                cards.map((r) => (
                  <BoardCard
                    key={`b-${r.rfq_id}`}
                    r={r}
                    steps={steps}
                    stage={stageOf(r)}
                    sel={selectedId === r.rfq_id}
                    compact={compact !== flipped.has(r.rfq_id)}
                    onClick={() => onSelect(r.rfq_id)}
                    onOverview={() => onOverview(r.rfq_id)}
                    onToggle={() => toggleCard(r.rfq_id)}
                  />
                ))
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** 현황판 전체를 A4 가로 1장으로 미리보기 + PNG 내려받기.
 *  클릭한 시점의 필터/정렬 결과(displayRows)를 그대로 담아 한눈에 보여준다. */
function BoardPreviewModal({
  rows,
  steps,
  stageOf,
  onClose,
}: {
  rows: PipelineRow[];
  steps: string[];
  stageOf: (r: PipelineRow) => number;
  onClose: () => void;
}) {
  const A4_W = 1400;
  const A4_H = 990; // 1400/990 ≈ 1.414 (A4 가로 비율)
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    function fit() {
      // 가로 폭 기준으로 최대한 넓게(최대 1.4배까지 확대). 높이가 넘치면 팝업 안에서 세로 스크롤.
      const s = Math.min(1.4, (window.innerWidth - 40) / A4_W);
      setScale(s > 0.2 ? s : 0.4);
    }
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  // 종결(Closed) 존은 해당 딜이 있을 때만 표시(보드와 동일 규칙).
  const cols = groupedBoardColumns(stageOf).filter(
    (c) => c.variant !== "cancelled" || rows.some((r) => c.match(r))
  );
  const today = new Date().toISOString().slice(0, 10);

  async function download() {
    if (!frameRef.current) return;
    setBusy(true);
    try {
      const { toPng } = await import("html-to-image");
      const url = await toPng(frameRef.current, {
        width: A4_W,
        height: A4_H,
        pixelRatio: 2,
        backgroundColor: "#ffffff",
        cacheBust: true,
      });
      const a = document.createElement("a");
      a.href = url;
      a.download = `KMARIS-progress-${today}.png`;
      a.click();
    } catch {
      /* 캡처 실패 시 조용히 무시 */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="pl-modal-backdrop board-prev-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="presentation"
    >
      <div className="board-prev" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="board-prev-bar">
          <b>Board overview · A4 landscape</b>
          <span className="board-prev-actions">
            <button className="btn primary" onClick={download} disabled={busy}>
              {busy ? "Rendering…" : "⬇ Download PNG"}
            </button>
            <button className="btn" onClick={onClose}>Close</button>
          </span>
        </div>
        <div className="board-prev-scroll">
          <div className="board-prev-vp" style={{ width: A4_W * scale, height: A4_H * scale }}>
            <div className="board-prev-scale" style={{ transform: `scale(${scale})` }}>
              <div ref={frameRef} className="board-prev-a4" style={{ width: A4_W, height: A4_H }}>
              <div className="board-prev-pghead">
                <span className="board-prev-brand">K-MARIS · Progress (Internal)</span>
                <span className="board-prev-meta">{today} · {rows.length} deals</span>
              </div>
              <div className="board-prev-cols">
                {cols.map((col, ci) => {
                  const cards = rows.filter((r) => col.match(r));
                  return (
                    <div key={ci} className={`board-prev-col${col.variant ? ` ${col.variant}` : ""}`}>
                      <div className="board-prev-colhead">
                        <span>{col.label}</span>
                        <span className="board-prev-cnt">{cards.length}</span>
                      </div>
                      <div className="board-prev-list">
                        {cards.length === 0 ? (
                          <div className="board-prev-empty">—</div>
                        ) : (
                          cards.map((r) => {
                            const total = steps.length;
                            const filled = Math.max(0, Math.min(stageOf(r), total));
                            const amount = r.order_amount || r.customer_amount || r.vendor_amount || "";
                            const isService = (r.work_type || "부품공급") === "서비스";
                            return (
                              <div key={r.rfq_id} className={`board-prev-card${isService ? " service" : ""}`}>
                                <div className="board-prev-top">
                                  <span className="board-prev-cardno"><ProjectNo value={r.project_no} /></span>
                                  <span className="board-prev-pic">{r.assignee || "—"}</span>
                                </div>
                                {r.project_title ? (
                                  <div className="board-prev-title2">{r.project_title}</div>
                                ) : null}
                                <div className="board-prev-cust">{r.customer || "—"}</div>
                                <div className="board-prev-cardbar">
                                  {Array.from({ length: total }).map((_, i) => (
                                    <span key={i} className={`seg${i < filled ? " on" : ""}`} />
                                  ))}
                                </div>
                                {amount ? (
                                  <div className="board-prev-foot">
                                    <span className="board-prev-amt" title={amount}>{primaryAmount(amount)}</span>
                                  </div>
                                ) : null}
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  );
}

/** 보드 1장 = 거래 1건. 관리번호·고객·선박·진행바·PIC·경과일·금액.
 *  compact=true 면 관리번호·고객·진행바만 남긴 한 줄 요약으로 접힘. */
function BoardCard({
  r,
  steps,
  stage,
  sel,
  compact,
  onClick,
  onOverview,
  onToggle,
}: {
  r: PipelineRow;
  steps: string[];
  stage: number;
  sel: boolean;
  compact: boolean;
  onClick: () => void;
  onOverview: () => void;
  onToggle: () => void;
}) {
  const isService = (r.work_type || "부품공급") === "서비스";
  const total = steps.length;
  const filled = Math.max(0, Math.min(stage, total));
  // PO 이후 단계는 고객 P/O(오더) 합산액(order_amount)을 우선 표시. 견적 단계는 견적액.
  const amount = r.order_amount || r.customer_amount || r.vendor_amount || "";
  const age = daysSince(r.first_rfq_at);
  const barTitle = `${filled}/${total} ${steps[filled - 1] ?? ""}`;
  // 현재(최종 진행) 단계의 날짜: 수동 저장값 우선, 없으면 자동 동기화값. yymmdd로 표기.
  // 조회는 내부 단계번호(r.stage) 기준 — Customer 탭에서 filled가 재매핑돼도 정확.
  const stageDate = fmtYYMMDD(stageDateOf(r, r.stage));
  // 종결 상태: 취소(회색+리본) / 완료(11단계 Payment Completed → 초록 체크).
  const cancelled = !!r.cancelled;
  const done = !cancelled && filled >= total;
  // 간략 카드: 고객 로고 + 프로젝트명(없으면 고객명)으로 인지성 확보.
  const logo = useCustomerLogo()(r.customer || "");
  const compactLabel = r.project_title || r.customer || "—";
  // 접힘/펼침 화살표(카드 클릭=상세 팝업과 분리하려고 별도 버튼 + stopPropagation).
  const chevron = (
    <button
      type="button"
      className="pl-card-toggle"
      aria-label={compact ? "카드 펼치기" : "카드 접기"}
      aria-expanded={!compact}
      title={compact ? "펼치기" : "접기"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {compact ? "▸" : "▾"}
    </button>
  );
  // 개요 바로가기 — 보드가 기본 뷰라 표에만 두면 대부분의 사용자에겐 없는 것과 같다.
  // 화살표와 같은 이유로 stopPropagation(카드 클릭은 편집 팝업).
  const overview = (
    <Link
      className="pl-card-ov"
      href={`/project/${r.rfq_id}`}
      onClick={(e) => e.stopPropagation()}
      title={`Open ${r.project_no || "project"} overview (read-only)`}
      aria-label={`Open ${r.project_no || "project"} overview`}
    >
      ⤢
    </Link>
  );
  // 번호 자체도 개요로 가는 문. ⤢ 는 카드를 짚어야 드러나서(평소 color:transparent) 처음 보는
  // 사람에겐 없는 것과 같다 — 번호는 늘 보이고 이미 파랗다. 카드는 role="button"인 div라
  // 버튼 중첩이 아니고, 카드 클릭(편집 팝업)을 막으려면 여기도 stopPropagation.
  const projectNo = (
    <button
      type="button"
      className="pl-card-no"
      onClick={(e) => { e.stopPropagation(); onOverview(); }}
      title={`Open ${r.project_no || "project"} overview`}
    >
      <ProjectNo value={r.project_no} />
    </button>
  );
  const cardProps = {
    role: "button" as const,
    tabIndex: 0,
    className: `pl-card${compact ? " compact" : ""}${sel ? " sel" : ""}${isService ? " service" : ""}${cancelled ? " cancelled" : ""}${done ? " done" : ""}`,
    onClick,
    onKeyDown: (e: ReactKeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    },
  };

  if (compact) {
    return (
      <div {...cardProps}>
        {cancelled ? <span className="pl-card-ribbon">CLOSED</span> : null}
        <div className="pl-card-nrow">
          {projectNo}
          {chevron}
        </div>
        <div className="pl-card-crow">
          {logo ? <img className="cust-logo" src={logo} alt="" /> : null}
          <span className="pl-card-proj-c" title={`${compactLabel}${r.customer ? ` · ${r.customer}` : ""}`}>
            {compactLabel}
          </span>
          {age != null ? <span className="pl-card-age" title="Days since first RFQ">{age}d</span> : null}
        </div>
        <div className="pl-card-bar" title={barTitle}>
          {Array.from({ length: total }).map((_, i) => (
            <span key={i} className={`seg${i < filled ? " on" : ""}`} />
          ))}
        </div>
        {vendorOf(r) ? (
          <div className="pl-card-vrow">
            <VendorMonograms value={vendorOf(r)} statuses={vendorStatusesFor(r)} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div {...cardProps}>
      {cancelled ? <span className="pl-card-ribbon">CLOSED</span> : null}
      <div className="pl-card-top">
        {projectNo}
        <span className="pl-card-top-r">
          <span className={`pl-card-pic${r.assignee ? "" : " none"}`}>{r.assignee || "—"}</span>
          <WorkTypeBadge type={r.work_type} />
          {chevron}
        </span>
      </div>
      {r.project_title ? (
        <div className="pl-card-proj" title={r.project_title}>{r.project_title}</div>
      ) : null}
      {(() => {
        // 고객명 + 선박(오더 여럿이면 " · "로 이어)을 한 줄의 보조 메타로 병합.
        const vs = (r.vessels || r.vessel).split("\n").filter(Boolean).join(" · ");
        return (
          <div className="pl-card-meta" title={`${r.customer || "—"}${vs ? ` · ${vs}` : ""}`}>
            {r.customer ? <CustomerName name={r.customer} /> : <span className="muted">—</span>}
            {vs ? <span className="pl-card-meta-vessel"> · {vs}</span> : null}
          </div>
        );
      })()}
      <div className="pl-card-bar" title={barTitle}>
        {Array.from({ length: total }).map((_, i) => (
          <span key={i} className={`seg${i < filled ? " on" : ""}`} />
        ))}
      </div>
      <div className="pl-card-stageline">
        <span className="pl-card-stage">
          {steps[filled - 1] ?? ""}
          {stageDate ? <span className="pl-card-stage-date"> ({stageDate})</span> : null}
        </span>
        <VendorMonograms value={vendorOf(r)} statuses={vendorStatusesFor(r)} />
        {age != null ? <span className="pl-card-age" title="Days since first RFQ">{age}d</span> : null}
      </div>
      {amount ? <div className="pl-card-amt" title={amount}>{amount}</div> : null}
      {r.next_action ? (
        <div className={`pl-card-next lv-${r.next_level || "normal"}`} title="Recommended next action">
          {r.next_action}
        </div>
      ) : null}
    </div>
  );
}

/** 파이프라인 테이블 셀 — 컬럼 key 에 따라 내용/클래스를 렌더(순서 변경에 대응). */
/**
 * 이중통화 금액("USD 8,000 KRW 12,347,280")을 통화 단위로 끊어 각 조각을 한 덩어리로
 * 유지한다. 그냥 wrap 시키면 "12,347,280" 같은 숫자 한가운데가 잘리는데, 통화 코드
 * (대문자 3글자) 앞에서만 끊으면 "USD 8,000" / "KRW 12,347,280" 이 각각 붙어 있다.
 * 폭이 남으면 한 줄에 나란히, 좁으면 접힌다(CSS flex-wrap).
 */
function DualAmount({ value }: { value: string }) {
  const parts = value.trim().split(/\s+(?=[A-Z]{3}\s)/);
  return (
    <span className="pl-amt">
      {parts.map((p, i) => (
        <span key={i} className="pl-amt-cur">
          {p}
        </span>
      ))}
    </span>
  );
}

/** 금액 한 줄 — 왼쪽 이름표, 오른쪽 금액. 세 줄이 한 셀에 쌓이므로 이름표가 있어야
 *  어느 숫자가 매출·매입·마진인지 열 머리글 없이도 읽힌다. */
function MoneyLine({
  label,
  value,
  pct,
}: {
  label: string;
  value?: string | null;
  pct?: number | null;
}) {
  return (
    <div className="pl-money-line">
      <span className="pl-money-label">{label}</span>
      {value ? (
        <span className="pl-money-val">
          <DualAmount value={value} />
          {pct != null ? <span className="pl-margin-pct">{pct}%</span> : null}
        </span>
      ) : (
        <span className="muted">—</span>
      )}
    </div>
  );
}

/**
 * 그룹 열 한 칸 — 묶인 필드를 여러 줄로 쌓는다.
 * 관리번호·타입·선박이 윗줄, 프로젝트명이 아랫줄인 식으로 "무엇인가"를 한 덩어리로 읽게 한다.
 */
function PipelineCell({
  colKey,
  r,
  steps,
  stage,
  onOverview,
}: {
  colKey: ColKey;
  r: PipelineRow;
  steps: string[];
  stage: number;
  onOverview: () => void;
}) {
  switch (colKey) {
    case "project": {
      // 선박은 오더별로 여러 척일 수 있다(vessels = 줄바꿈 구분).
      const vessels = (r.vessels || r.vessel || "").split("\n").filter(Boolean).join(" · ");
      return (
        <td className="pl-td-project">
          <div className="pl-idline">
            <button
              type="button"
              className="pl-project-no-btn"
              onClick={(e) => { e.stopPropagation(); onOverview(); }}
              title={`Open ${r.project_no || "project"} overview`}
            >
              <ProjectNo value={r.project_no} />
            </button>
            <WorkTypeBadge type={r.work_type} />
            {vessels ? <span className="pl-vessel">{vessels}</span> : null}
          </div>
          <div className="pl-title">
            {r.project_title || <span className="muted">No title</span>}
          </div>
          {r.received_at ? <div className="pl-received">{fmtStageDate(r.received_at)}</div> : null}
        </td>
      );
    }
    case "customer":
      return (
        <td className="pl-td-customer">
          <div className="strong">
            {r.customer ? <CustomerName name={r.customer} /> : "No customer"}
          </div>
          <div className="pl-contact">
            {r.contact_person || <span className="muted">—</span>}
          </div>
        </td>
      );
    case "vendor":
      return (
        <td className="pl-td-vendor">
          {vendorOf(r) ? <VendorName name={vendorOf(r)} /> : <span className="muted">—</span>}
        </td>
      );
    case "stage":
      return (
        <td className="pl-td-stage">
          <StageBar stage={stage} steps={resolveSteps(steps, r.work_type)} />
        </td>
      );
    case "amounts":
      return (
        <td className="pl-td-amounts">
          <MoneyLine label="Sales" value={r.sales_total} />
          <MoneyLine label="Purchase" value={r.purchase_total} />
          <MoneyLine label="Margin" value={r.margin_amount} pct={r.margin_pct} />
        </td>
      );
    case "assignee":
      return <td className="pl-td-pic">{r.assignee || <span className="muted">—</span>}</td>;
    default:
      return <td />;
  }
}

// 모달 크기 상태 — 사용자가 드래그로 지정한 '선호 크기'(원본)를 저장하고, 표시할 땐
// 현재 뷰포트에 맞춰 클램프+가운데 정렬한다. 모바일에서 열려 축소된 값을 그대로 저장하지
// 않으므로, 모바일↔PC 를 오가도 팝업이 좁게 굳지 않는다.
const MODAL_SIZE_KEY = "ktms:proj-modal-size";
function readModalPref(): { w: number; h: number } | null {
  if (typeof window === "undefined") return null;
  try {
    const s = JSON.parse(window.localStorage.getItem(MODAL_SIZE_KEY) || "null");
    const w = Number(s?.w), h = Number(s?.h);
    // 리사이즈 최소값(560×360) 미만은 옛 버그로 모바일에서 축소·저장된 손상값 → 폐기하고
    // 기본(중앙·큰) 레이아웃으로 복귀시킨다.
    if (w >= 560 && h >= 360) return { w, h };
    if (s) window.localStorage.removeItem(MODAL_SIZE_KEY);
  } catch {
    /* ignore malformed */
  }
  return null;
}
function computeModalBox(pref: { w: number; h: number } | null) {
  if (!pref || typeof window === "undefined") return null;
  const w = Math.min(pref.w, window.innerWidth - 24);
  const h = Math.min(pref.h, window.innerHeight - 24);
  return { w, h, left: Math.max(12, (window.innerWidth - w) / 2), top: Math.max(12, (window.innerHeight - h) / 2) };
}

/** 통합 파이프라인 상세 모달 — 테이블 행 클릭 시 전 구간 문서 체인을 팝업으로 보여준다.
 *  헤더: RFQ No. · 업무 타입 · 고객사 · 선박 · 프로젝트 제목 + 닫기
 *  본문: 핵심 메타 + 6구간 문서 체인 + 12단계 완료 일시 + RFQ/P·O 작업 바로가기 */
export function PipelineModal({
  r,
  steps,
  customers,
  vessels,
  onChanged,
  onClose,
  onNavigate,
  isNew,
  initialStage = null,
  initialView = "work",
}: {
  r: PipelineRow;
  steps: string[];
  customers: CustomerOption[];
  vessels: SettingsVessel[];
  onChanged: () => void | Promise<unknown>;
  onClose: () => void;
  // 인접 프로젝트로 전환(-1=이전, +1=다음). 부모가 "현재 보이는 목록 순서"로 이웃을 계산해
  // selectedId 를 바꾼다. 주면 ←/→ 방향키와 헤더의 ‹ › 버튼이 활성화된다. 신규 등록 모드엔 없다.
  onNavigate?: (dir: -1 | 1) => void;
  // isNew: 신규 RFQ 등록 모드 — 저장된 프로젝트가 없으므로 좌측/딜 액션은 안내로 대체하고
  // 우측 상세 자리에 신규 RFQ 기본정보 입력 폼(NewRfqForm)을 넣는다.
  isNew?: boolean;
  // 딥링크로 열 때 진입할 단계(1~11). null 이면 프로젝트의 현재 단계로 연다.
  initialStage?: number | null;
  initialView?: "work" | "overview";
}) {
  const isNewProject = !!isNew;
  const backdropMouseDown = useRef(false);
  // 딜 종결(취소/실주) 토글 — 종결 시 보드 Cancelled 존으로, 재활성 시 진행 컬럼으로 복귀.
  const [cancelBusy, setCancelBusy] = useState(false);
  // 종결 시 사유 선택 모달 상태. 재활성은 사유가 필요 없으므로 바로 처리한다.
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reasonCode, setReasonCode] = useState<string>("");
  const [reasonNote, setReasonNote] = useState("");
  async function toggleCancelled() {
    if (isNewProject || cancelBusy) return;
    if (!r.cancelled) {
      // 종결 → 사유 선택 모달을 연다(직접 확정은 confirmClose 에서).
      setReasonCode("");
      setReasonNote("");
      setReasonOpen(true);
      return;
    }
    // 재활성 → 진행 컬럼으로 복귀(사유는 백엔드에서 비운다).
    setCancelBusy(true);
    try {
      await setRfqCancelled(r.rfq_id, false);
      await onChanged();
    } finally {
      setCancelBusy(false);
    }
  }
  async function confirmClose() {
    if (cancelBusy || !reasonCode) return;
    setCancelBusy(true);
    try {
      await setRfqCancelled(
        r.rfq_id,
        true,
        reasonCode,
        reasonCode === "other" ? reasonNote : undefined
      );
      setReasonOpen(false);
      await onChanged();
    } finally {
      setCancelBusy(false);
    }
  }
  // 담당자(PIC) 재지정 — 우측 상단 PIC 칩에서 어느 단계에서도 변경(admin 전용).
  const canEditPic = !isNewProject && isAdmin();
  const [picUsers, setPicUsers] = useState<{ id: number; username: string }[]>([]);
  const [picBusy, setPicBusy] = useState(false);
  useEffect(() => {
    if (!canEditPic) return;
    let alive = true;
    fetchAssignableUsers()
      .then((u) => { if (alive) setPicUsers(u); })
      .catch(() => { if (alive) setPicUsers([]); });
    return () => { alive = false; };
  }, [canEditPic]);
  async function reassignPic(id: number) {
    if (picBusy || id === (r.assignee_id || 0)) return;
    setPicBusy(true);
    try {
      await updateRfq(r.rfq_id, { assignee_id: id });
      await onChanged();
    } finally {
      setPicBusy(false);
    }
  }
  // 좌측 정보 패널에 표시할 항목 선택(체크박스 메뉴). localStorage 로 유지.
  const [infoFields, setInfoFields] = useState<string[]>(() => {
    if (typeof window === "undefined") return DEFAULT_INFO_FIELDS;
    try {
      const arr = JSON.parse(window.localStorage.getItem("ktms:proj-info-fields") || "null");
      if (!Array.isArray(arr) || !arr.length) return DEFAULT_INFO_FIELDS;
      // 신규 도입 필드는 저장된 목록에 없으므로, 기존 사용자에게도 1회만 덧붙인다.
      // (이후 사용자가 지우면 그 의사를 존중 — 마커로 재추가를 막는다.)
      if (window.localStorage.getItem("ktms:proj-info-fields-mig1") !== "1") {
        window.localStorage.setItem("ktms:proj-info-fields-mig1", "1");
        const add = ["sales_amount", "purchase_amount", "margin"].filter((k) => !arr.includes(k));
        return add.length ? [...arr, ...add] : arr;
      }
      return arr;
    } catch {
      return DEFAULT_INFO_FIELDS;
    }
  });
  const [fieldsMenuOpen, setFieldsMenuOpen] = useState(false);
  const fieldsMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (typeof window !== "undefined")
      window.localStorage.setItem("ktms:proj-info-fields", JSON.stringify(infoFields));
  }, [infoFields]);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (fieldsMenuRef.current && !fieldsMenuRef.current.contains(e.target as Node))
        setFieldsMenuOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  function toggleInfoField(key: string) {
    setInfoFields((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }
  // 단계 상세 표시: 단계별 그룹(stages, 편집 가능) / 시간순 여정(timeline, 읽기전용)
  const [selectedStage, setSelectedStage] = useState<StageTabKey>(
    Math.min(Math.max(initialStage || r.stage || 1, 1), 11)
  );
  // 팝업 안 화면 전환: 단계 작업(work) ↔ 프로젝트 개요(overview).
  // 기억하지 않고 늘 work 로 연다 — 팝업을 여는 목적은 대개 단계를 진행시키는 것이라,
  // overview 로 굳어 있으면 작업하려던 사람이 매번 한 번 더 눌러야 한다.
  // 오래 읽는 용도는 페이지(/project/<id>)가 맡는다.
  const [modalView, setModalView] = useState<"work" | "overview">(initialView);
  /** 개요의 단계 줄 클릭 → 그 단계의 작업 화면으로. 개요에서 짚은 곳을 바로 편집. */
  const openStageFromOverview = useCallback((no: number) => {
    setSelectedStage(Math.min(Math.max(no, 1), 11));
    setModalView("work");
  }, []);

  // 인접 프로젝트 전환 — 부모가 같은 모달을 다른 r 로 다시 그린다(리마운트 안 함).
  // 프로젝트가 바뀌면 그 프로젝트의 현재 단계로 맞춘다. 보던 뷰(작업/개요)는 그대로 둬서
  // 개요를 훑던 사람은 계속 개요로, 작업하던 사람은 계속 작업으로 이웃을 넘긴다.
  const prevRfqId = useRef(r.rfq_id);
  useEffect(() => {
    if (prevRfqId.current === r.rfq_id) return;
    prevRfqId.current = r.rfq_id;
    setSelectedStage(Math.min(Math.max(r.stage || 1, 1), 11));
  }, [r.rfq_id, r.stage]);

  // ←/→ 방향키로 이웃 프로젝트 전환. 입력 중(텍스트칸·선택·메모)엔 커서 이동이 우선이라
  // 가로채지 않는다. Close deal 사유 모달이 열려 있을 때도 비활성(그 안에서 조작 중).
  useEffect(() => {
    if (!onNavigate || isNewProject) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (reasonOpen) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      e.preventDefault();
      onNavigate?.(e.key === "ArrowLeft" ? -1 : 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNavigate, isNewProject, reasonOpen]);
  // 모바일 전용: 프로젝트 정보/단계 상세를 동시에 띄우면 좁아, 탭으로 하나씩 전환.
  // (데스크톱은 좌우 2단으로 함께 보이므로 이 값은 CSS 상 무시된다.)
  const [mobilePane, setMobilePane] = useState<"info" | "stage">("stage");
  // 상단 단계 스트립 — 모바일에선 가로 스크롤. 선택 단계를 화면 중앙으로 자동 스크롤한다.
  const stageStripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = stageStripRef.current;
    if (!strip) return;
    const btn = strip.querySelector<HTMLElement>(`[data-stage="${selectedStage}"]`);
    // 실제로 넘칠 때(모바일 가로 스크롤)만 중앙 정렬 이동 — 데스크톱은 no-op.
    if (btn && strip.scrollWidth > strip.clientWidth + 4) {
      const sr = strip.getBoundingClientRect();
      const br = btn.getBoundingClientRect();
      const target = strip.scrollLeft + (br.left - sr.left) - (strip.clientWidth - br.width) / 2;
      strip.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
    }
  }, [selectedStage]);
  // 좌측 기본정보 패널: 구분선 드래그로 폭 조절 + 토글 버튼으로 숨김. localStorage 로 유지.
  const layoutRef = useRef<HTMLDivElement>(null);
  const [infoWidth, setInfoWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 300;
    const v = Number(window.localStorage.getItem("ktms:proj-info-w"));
    return v >= 200 && v <= 620 ? v : 300;
  });
  const [infoCollapsed, setInfoCollapsed] = useState<boolean>(
    () => typeof window !== "undefined" && window.localStorage.getItem("ktms:proj-info-collapsed") === "1"
  );
  // 상단 단계 스트립: 토글로 납작한(번호+작은 제목) 바로 접기. localStorage 로 유지.
  const [stagesCollapsed, setStagesCollapsed] = useState<boolean>(
    () => typeof window !== "undefined" && window.localStorage.getItem("ktms:proj-stages-collapsed") === "1"
  );
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem("ktms:proj-info-w", String(infoWidth));
  }, [infoWidth]);
  useEffect(() => {
    if (typeof window !== "undefined")
      window.localStorage.setItem("ktms:proj-info-collapsed", infoCollapsed ? "1" : "0");
  }, [infoCollapsed]);
  useEffect(() => {
    if (typeof window !== "undefined")
      window.localStorage.setItem("ktms:proj-stages-collapsed", stagesCollapsed ? "1" : "0");
  }, [stagesCollapsed]);

  function startInfoDrag(e: React.MouseEvent) {
    if (infoCollapsed) return;
    e.preventDefault();
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      const rect = layoutRef.current?.getBoundingClientRect();
      if (!rect) return;
      setInfoWidth(Math.max(200, Math.min(620, ev.clientX - rect.left)));
    };
    const onUp = () => {
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // 모달 크기 조절: 테두리/모서리를 잡고 드래그(8방향). 크기는 localStorage 로 기억하고
  // 열 때마다 그 크기로 화면 중앙에 배치한다. 미조절 상태(null)면 CSS 기본(중앙 정렬).
  const modalRef = useRef<HTMLDivElement>(null);
  // 사용자가 드래그로 확정한 '선호 크기'(원본) — 저장/복원의 기준. 표시 박스는 여기서 파생.
  const prefSizeRef = useRef<{ w: number; h: number } | null>(readModalPref());
  const [modalBox, setModalBox] = useState<{ left: number; top: number; w: number; h: number } | null>(
    () => computeModalBox(prefSizeRef.current)
  );
  // 뷰포트 크기 변경(모바일↔PC 전환, 브라우저 리사이즈) 시 선호 크기에서 다시 계산해
  // 항상 화면에 맞게 클램프+중앙 정렬한다. (축소된 값을 저장하지 않으므로 원래 크기로 복귀)
  useEffect(() => {
    function onResize() {
      setModalBox(computeModalBox(prefSizeRef.current));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function startResize(dir: string, e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const el = modalRef.current;
    if (!el) return;
    const r0 = el.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, left: r0.left, top: r0.top, w: r0.width, h: r0.height };
    const MINW = 560;
    const MINH = 360;
    const maxW = window.innerWidth - 16;
    const maxH = window.innerHeight - 16;
    const cursor = getComputedStyle(e.currentTarget as Element).cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = cursor;
    let lastSize = { w: start.w, h: start.h };
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      let { left, top, w, h } = start;
      if (dir.includes("e")) w = start.w + dx;
      if (dir.includes("s")) h = start.h + dy;
      if (dir.includes("w")) { w = start.w - dx; left = start.left + dx; }
      if (dir.includes("n")) { h = start.h - dy; top = start.top + dy; }
      if (w < MINW) { if (dir.includes("w")) left = start.left + (start.w - MINW); w = MINW; }
      if (h < MINH) { if (dir.includes("n")) top = start.top + (start.h - MINH); h = MINH; }
      w = Math.min(w, maxW);
      h = Math.min(h, maxH);
      // 최소 120px 는 화면 안에 남겨 완전히 사라지지 않게 한다.
      left = Math.min(Math.max(left, 120 - w), window.innerWidth - 120);
      top = Math.min(Math.max(top, 8), window.innerHeight - 60);
      lastSize = { w, h };
      setModalBox({ left, top, w, h });
    };
    const onUp = () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      // 드래그로 확정된 '실제' 크기만 선호 크기로 저장(뷰포트에 맞춰 축소된 값은 저장하지 않음).
      prefSizeRef.current = { w: Math.round(lastSize.w), h: Math.round(lastSize.h) };
      try {
        window.localStorage.setItem(MODAL_SIZE_KEY, JSON.stringify(prefSizeRef.current));
      } catch {
        /* ignore quota/serialization errors */
      }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }
  const RESIZE_DIRS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;

  // 프로젝트 정보 편집·삭제는 우측 1단계(RFQ Received) 패널에서 처리한다.
  // 좌측 패널은 읽기전용 요약(+ 표시 항목 선택)만 담당한다.
  const rSteps = resolveSteps(steps, r.work_type || "부품공급");

  const isService = (r.work_type || "부품공급") === "서비스";
  const chain = buildStageChain(r, rSteps);

  function onBackdropMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    backdropMouseDown.current = e.target === e.currentTarget;
  }

  function onBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (backdropMouseDown.current && e.target === e.currentTarget) {
      onClose();
    }
    backdropMouseDown.current = false;
  }

  function areaForStage(no: number): WorkspaceArea {
    if (no <= 4) return "rfq";
    if (no <= 6) return "po";
    if (no <= 9) {
      if (no === 9 && (isService || r.trade_type === "내수")) return "ar";
      return "documents";
    }
    return "ar";
  }

  return (
    <div
      className={`pl-modal-backdrop${isService ? " service" : ""}`}
      onMouseDown={onBackdropMouseDown}
      onClick={onBackdropClick}
      role="presentation"
    >
      <div
        ref={modalRef}
        className={`pl-modal pl-modal--resizable${isService ? " service" : ""}`}
        style={
          modalBox
            ? {
                position: "fixed",
                left: modalBox.left,
                top: modalBox.top,
                width: modalBox.w,
                height: modalBox.h,
                maxWidth: "none",
                maxHeight: "none",
                margin: 0,
              }
            : undefined
        }
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {RESIZE_DIRS.map((d) => (
          <span
            key={d}
            className={`pl-resize-h ${d}`}
            onPointerDown={(e) => startResize(d, e)}
            aria-hidden
          />
        ))}
        <div className="pl-modal-head">
          {/* 인접 프로젝트 전환 — 헤더 맨 앞의 ‹ › (방향키와 같은 동작). 목록 순서대로 앞뒤 딜. */}
          {!isNewProject && onNavigate ? (
            <span className="pl-modal-nav" role="group" aria-label="Adjacent projects">
              <button
                type="button"
                className="pl-nav-btn"
                onClick={() => onNavigate(-1)}
                title="Previous project (←)"
                aria-label="Previous project"
              >
                ‹
              </button>
              <button
                type="button"
                className="pl-nav-btn"
                onClick={() => onNavigate(1)}
                title="Next project (→)"
                aria-label="Next project"
              >
                ›
              </button>
            </span>
          ) : null}
          {isNewProject ? (
            <span className="intl-title">
              <b>New Customer RFQ</b>
              <span className="pl-proj-name">Register a new project</span>
            </span>
          ) : (
            <span className="intl-title">
              <b><ProjectNo value={r.project_no} /></b>
              <WorkTypeBadge type={r.work_type} />
              {r.project_title ? <span className="pl-proj-name">{r.project_title}</span> : null}
              {r.vessels || r.vessel ? (
                <span className="pl-proj-vessel">
                  · {(r.vessels || r.vessel).split("\n").filter(Boolean).join(" · ")}
                </span>
              ) : null}
            </span>
          )}
          <span className="pl-head-right">
            {/* 작업 ↔ 개요 전환 — 같은 프로젝트를 "이번 단계 작업"과 "상황 전체"로 오간다.
                예전엔 여기서 /project/<id> 로 페이지를 통째로 떠났는데, 돌아오면 열어 둔
                단계와 스크롤을 잃었다. 공유·인쇄가 필요한 사람은 개요 뷰의 ↗ 로 나간다. */}
            {!isNewProject ? (
              <span className="pl-modal-viewtoggle" role="tablist" aria-label="Modal view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={modalView === "work"}
                  className={modalView === "work" ? "on" : ""}
                  onClick={() => setModalView("work")}
                  title="Work the stages of this project"
                >
                  ✎ Work
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={modalView === "overview"}
                  className={modalView === "overview" ? "on" : ""}
                  onClick={() => setModalView("overview")}
                  title="Read the whole project at a glance"
                >
                  ▤ Overview
                </button>
              </span>
            ) : null}
            <span className={`pl-pic-chip${canEditPic ? " editable" : ""}`}>
              <span className="pl-pic-label">PIC</span>
              {canEditPic ? (
                <select
                  className="pl-pic-select"
                  value={r.assignee_id || 0}
                  disabled={picBusy}
                  onChange={(e) => reassignPic(Number(e.target.value))}
                  title="Reassign PIC (admin only)"
                >
                  <option value={0}>Unassigned</option>
                  {picUsers.map((u) => (
                    <option key={u.id} value={u.id}>{u.username}</option>
                  ))}
                  {/* 현재 담당자가 후보 목록에 없으면(비활성 등) 유지되도록 fallback 옵션 */}
                  {r.assignee_id && !picUsers.some((u) => u.id === r.assignee_id) ? (
                    <option value={r.assignee_id}>{r.assignee || `User #${r.assignee_id}`}</option>
                  ) : null}
                </select>
              ) : (
                r.assignee || "—"
              )}
            </span>
            {!isNewProject && r.cancelled && r.close_reason ? (
              <span
                className="pl-close-reason"
                title={
                  r.close_reason === "other" && r.close_reason_note
                    ? r.close_reason_note
                    : closeReasonLabel(r.close_reason)
                }
              >
                ⊘{" "}
                {r.close_reason === "other" && r.close_reason_note
                  ? r.close_reason_note
                  : closeReasonLabel(r.close_reason)}
              </span>
            ) : null}
            {!isNewProject ? (
              <button
                type="button"
                className={`pl-modal-cancel${r.cancelled ? " reactivate" : ""}`}
                onClick={toggleCancelled}
                disabled={cancelBusy}
                title={r.cancelled ? "Reactivate this project" : "Mark this deal as closed"}
              >
                {cancelBusy ? "…" : r.cancelled ? "↺ Reactivate" : "⊘ Close deal"}
              </button>
            ) : null}
            <button
              type="button"
              className="pl-modal-close"
              onClick={onClose}
              aria-label="Close"
            >
              ×
            </button>
          </span>
        </div>

        {/* Close deal 사유 선택 — 종결 확정 전 사유를 고른다(기타는 직접 입력). */}
        {reasonOpen ? (
          <div
            className="close-reason-backdrop"
            onMouseDown={(e) => { if (e.target === e.currentTarget && !cancelBusy) setReasonOpen(false); }}
            role="presentation"
          >
            <div className="close-reason-modal" role="dialog" aria-modal="true" aria-label="Close deal reason">
              <div className="close-reason-title">Close this deal</div>
              <div className="close-reason-sub">
                Select a reason. It will move to the Closed zone on the board — you can reactivate it anytime.
              </div>
              <div className="close-reason-list">
                {CLOSE_REASONS.map((opt) => (
                  <label key={opt.code} className={`close-reason-opt${reasonCode === opt.code ? " sel" : ""}`}>
                    <input
                      type="radio"
                      name="close-reason"
                      value={opt.code}
                      checked={reasonCode === opt.code}
                      onChange={() => setReasonCode(opt.code)}
                    />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>
              {reasonCode === "other" ? (
                <textarea
                  className="close-reason-note"
                  placeholder="Enter the reason"
                  value={reasonNote}
                  onChange={(e) => setReasonNote(e.target.value)}
                  rows={3}
                  autoFocus
                />
              ) : null}
              <div className="close-reason-actions">
                <button type="button" className="btn" onClick={() => setReasonOpen(false)} disabled={cancelBusy}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn primary"
                  onClick={confirmClose}
                  disabled={cancelBusy || !reasonCode || (reasonCode === "other" && !reasonNote.trim())}
                >
                  {cancelBusy ? "Closing…" : "Close deal"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* 개요 뷰 — 팝업 안에서 프로젝트 전체를 읽는다. 단계 스트립과 좌우 2단 작업
            패널을 대신한다(개요가 같은 단계 타임라인을 더 자세히 갖고 있어 스트립이
            겹친다). pl-modal-body 는 overflow:hidden 이라 스크롤 컨테이너를 따로 둔다. */}
        {modalView === "overview" && !isNewProject ? (
          <div className="pl-modal-ov">
            <ProjectOverviewScreen
              rfqId={r.rfq_id}
              embedded
              onOpenStage={openStageFromOverview}
            />
            {/* 인쇄·공유는 URL 이 필요한 일이라 페이지 개요로 보낸다. 팝업 안에서
                window.print() 를 부르면 백드롭과 뒤 화면까지 같이 인쇄된다. */}
          </div>
        ) : null}

        {/* 단계 스트립 — 진행상태(완료 음영/현재)와 탐색(선택)을 통합하고, 각 단계의
            주요 결과물(번호·Vendor·금액 등)과 완료 일시를 카드에 함께 노출한다.
            우측 토글로 납작한(번호+작은 제목) 바로 접어 세로 공간을 아낀다. */}
        {modalView === "work" ? (
        <div className={`project-stage-tabs-row${stagesCollapsed ? " collapsed" : ""}`}>
          <div className="project-stage-tabs" role="tablist" aria-label="Project stages" ref={stageStripRef}>
          {chain.map((c) => {
            const no = c.no;
            const cls = [
              selectedStage === no ? "on" : "",
              no <= r.stage ? "done" : "",
              no === r.stage ? "current" : "",
              c.skip ? "skip" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={no}
                type="button"
                data-stage={no}
                className={cls}
                aria-pressed={selectedStage === no}
                onClick={() => setSelectedStage(no)}
                title={c.value ? `${c.label} — ${c.value}` : c.label}
              >
                <span className="st-head">
                  <span className="st-no">{no}</span>
                  <b className="st-label">{c.label}</b>
                </span>
                <em className="st-val">{c.skip ? "N/A" : c.value || ""}</em>
                <time className="st-at">{c.at ? fmtStageDate(c.at) : ""}</time>
              </button>
            );
          })}
          </div>
          <button
            type="button"
            className="stage-tabs-toggle"
            onClick={() => setStagesCollapsed((v) => !v)}
            title={stagesCollapsed ? "Expand stage details" : "Collapse stages"}
            aria-label={stagesCollapsed ? "Expand stage details" : "Collapse stages"}
            aria-pressed={stagesCollapsed}
          >
            {stagesCollapsed ? "▾" : "▴"}
          </button>
        </div>
        ) : null}

        {modalView === "work" ? (
        <div className="pl-modal-body">
          <div className="intl-detail">
            {/* 모바일 전환 탭 — 좁은 화면에서만 노출(데스크톱은 CSS 로 숨김). */}
            <div className="pl-pane-tabs" role="tablist" aria-label="Panel">
              <button
                type="button"
                role="tab"
                aria-selected={mobilePane === "info"}
                className={mobilePane === "info" ? "on" : ""}
                onClick={() => setMobilePane("info")}
              >
                Project info
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mobilePane === "stage"}
                className={mobilePane === "stage" ? "on" : ""}
                onClick={() => setMobilePane("stage")}
              >
                {selectedStage}. {rSteps[selectedStage - 1] ?? "Detail"}
              </button>
            </div>
            <div
              className={`project-workspace-layout mobile-pane-${mobilePane}${infoCollapsed ? " info-collapsed" : ""}`}
              ref={layoutRef}
              style={{
                gridTemplateColumns: infoCollapsed
                  ? "0 26px minmax(0, 1fr)"
                  : `${infoWidth}px 14px minmax(0, 1fr)`,
              }}
            >
              <aside className="project-info-pane" hidden={infoCollapsed}>
            {isNewProject ? (
            <div className="intl-new-hint">
              <p>Fill in the basic info on the right and click <b>Create RFQ</b>.</p>
              <p className="muted">Once created, this project appears on the board with its stages.</p>
            </div>
          ) : (
            <>
              {/* 표시 항목 선택 메뉴(⚙). 편집·삭제는 우측 1단계 패널에서 처리. */}
              <div className="intl-meta-head">
                <span className="intl-meta-title">Project info</span>
                <div className="intl-fields-menu-wrap" ref={fieldsMenuRef}>
                  <button
                    type="button"
                    className="intl-fields-btn"
                    onClick={() => setFieldsMenuOpen((v) => !v)}
                    title="Choose fields to show"
                    aria-label="Choose fields to show"
                  >
                    ⚙
                  </button>
                  {fieldsMenuOpen ? (
                    <div className="pl-cols-menu intl-fields-menu">
                      <div className="pl-cols-menu-head">Show fields</div>
                      <div className="pl-cols-menu-list">
                        {INFO_FIELDS.map((f) => (
                          <label key={f.key} className="pl-cols-menu-item">
                            <input
                              type="checkbox"
                              checked={infoFields.includes(f.key)}
                              onChange={() => toggleInfoField(f.key)}
                            />
                            {f.label}
                          </label>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
              <dl className="intl-meta">
                {INFO_FIELDS.filter((f) => infoFields.includes(f.key)).map((f) => (
                  <div key={f.key}>
                    <dt>{f.label}</dt>
                    <dd>{f.render(r)}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}

          {!isNewProject && r.next_action ? (
            <div className={`pl-next-banner lv-${r.next_level || "normal"}`}>
              <span className="pl-next-label">Next action</span>
              <span className="pl-next-text">{r.next_action}</span>
            </div>
          ) : null}

          {!isNewProject ? (
            <div className="intl-activity">
              <div className="intl-activity-head">
                Activity log
                <span className="intl-activity-stage">
                  {selectedStage}. {rSteps[selectedStage - 1] ?? ""}
                </span>
              </div>
              <StageNotes
                rfqId={r.rfq_id}
                stage={selectedStage}
                notes={r.stage_notes?.[String(selectedStage)] ?? []}
                onChanged={onChanged}
              />
            </div>
          ) : null}
              </aside>

              {/* 드래그로 좌우 폭 조절 + 토글 버튼으로 좌측 패널 숨김/표시. */}
              <div
                className="ws-divider"
                onMouseDown={startInfoDrag}
                role="separator"
                aria-orientation="vertical"
                title={infoCollapsed ? undefined : "Drag to resize"}
              >
                <button
                  type="button"
                  className="ws-divider-toggle"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => setInfoCollapsed((v) => !v)}
                  title={infoCollapsed ? "Show project info" : "Hide project info"}
                  aria-label={infoCollapsed ? "Show project info" : "Hide project info"}
                >
                  {infoCollapsed ? "›" : "‹"}
                </button>
              </div>

              <section className="project-stage-pane">
            {/* 단계 상세 공통 헤더 — 모든 단계에서 동일한 위치·서체의 제목(좌) +
                다음 단계로 이동하는 → 버튼(우상단). 11개 단계 UI 일관성의 기준. */}
            <div className="stage-pane-head">
              <h3 className="stage-pane-title">
                <span className="stage-pane-no">{selectedStage}</span>
                <span>{rSteps[selectedStage - 1] ?? ""}</span>
                {STAGE_TITLE_QUALIFIER[selectedStage] ? (
                  <span className="stage-pane-qual">({STAGE_TITLE_QUALIFIER[selectedStage]})</span>
                ) : null}
              </h3>
              {!isNewProject ? (
                <div className="stage-pane-nav">
                  <button
                    type="button"
                    className="stage-pane-prev"
                    onClick={() => setSelectedStage((s) => Math.max(s - 1, 1))}
                    disabled={selectedStage <= 1}
                    title={selectedStage > 1 ? `Prev: ${selectedStage - 1}. ${rSteps[selectedStage - 2] ?? ""}` : undefined}
                  >
                    <span aria-hidden>← </span>Prev
                  </button>
                  <button
                    type="button"
                    className="stage-pane-next"
                    onClick={() => setSelectedStage((s) => Math.min(s + 1, rSteps.length))}
                    disabled={selectedStage >= rSteps.length}
                    title={selectedStage < rSteps.length ? `Next: ${selectedStage + 1}. ${rSteps[selectedStage] ?? ""}` : undefined}
                  >
                    Next<span aria-hidden> →</span>
                  </button>
                </div>
              ) : null}
            </div>
            {isNewProject ? (
              <div className="project-work-panel embedded-workspace embedded-detail">
                <NewRfqForm
                  embedded
                  onCreated={() => {
                    onChanged();
                    onClose();
                  }}
                  onCancel={onClose}
                />
              </div>
            ) : (
              <WorkspacePanel
                stage={selectedStage}
                area={areaForStage(selectedStage)}
                row={r}
                onChanged={onChanged}
              />
            )}
              </section>
            </div>
          </div>
        </div>
        ) : null}
      </div>
    </div>
  );
}

function WorkspacePanel({
  stage,
  area,
  row,
  onChanged,
}: {
  stage: number;
  area: WorkspaceArea;
  row: PipelineRow;
  onChanged: () => void | Promise<unknown>;
}) {
  // 이 프로젝트(RFQ)의 고객 P/O(오더)들 — 6~11단계는 어느 P/O 기준으로 진행할지 선택.
  const { data: poOptions } = useCachedData("po:work-options", fetchPoWorkOptions);
  // 복수 P/O는 K-Maris PO 번호 오름차순(숫자 빠른 순)으로 좌→우 배치.
  const projectOrders = useMemo(
    () => sortByDocNo((poOptions?.orders ?? []).filter((o) => o.rfq_id === row.rfq_id), (o) => o.po_no, (o) => o.id),
    [poOptions, row.rfq_id]
  );
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  // 임베드된 문서 뷰(DocumentsOverview)는 orderId 변화로만 재조회하므로, 7단계 초기화 후
  // 강제 리마운트해 지워진 CI/SA 를 즉시 반영한다.
  const [docReloadKey, setDocReloadKey] = useState(0);
  // 기본 선택: 대표 오더(row.order_id) 우선, 없으면 첫 오더. 선택 유효성 유지.
  useEffect(() => {
    setSelectedOrderId((cur) => {
      if (cur != null && projectOrders.some((o) => o.id === cur)) return cur;
      if (row.order_id > 0 && projectOrders.some((o) => o.id === row.order_id)) return row.order_id;
      return projectOrders[0]?.id ?? (row.order_id > 0 ? row.order_id : null);
    });
  }, [projectOrders, row.order_id]);

  const effectiveOrderId = selectedOrderId ?? (row.order_id > 0 ? row.order_id : 0);

  // 6단계 이상 + 고객 P/O가 2건 이상일 때만 상단 P/O 선택기 노출.
  // (5단계는 CustomerPoTab 자체에 P/O 선택기가 있어 중복 표시하지 않는다.)
  const picker =
    stage >= 6 && projectOrders.length > 1 ? (
      <div className="embedded-record-bar wp-po-picker">
        <span className="wp-po-picker-label">P/O</span>
        <div className="embedded-record-picker" role="tablist" aria-label="Customer POs">
          {projectOrders.map((o) => (
            <button
              key={o.id}
              type="button"
              className={o.id === effectiveOrderId ? "on" : ""}
              onClick={() => setSelectedOrderId(o.id)}
            >
              {o.po_no || o.vessel || `PO ${o.id}`}
            </button>
          ))}
        </div>
      </div>
    ) : null;

  if (area === "rfq") {
    return <ProjectRfqWorkspace row={row} stage={stage} onChanged={onChanged} />;
  }
  if (area === "po") {
    return (
      <>
        {picker}
        <ProjectPoWorkspace row={row} stage={stage} orderId={effectiveOrderId} onChanged={onChanged} />
      </>
    );
  }
  if (area === "documents") {
    const docStage = Math.min(Math.max(stage, 7), 9);
    return effectiveOrderId > 0 ? (
      <>
        {picker}
        <div className="project-work-panel embedded-workspace">
          <Suspense fallback={<div className="state">Loading details…</div>}>
            <DocumentsOverview
              key={docReloadKey}
              initialOrderId={effectiveOrderId}
              initialStage={docStage}
              initialView={row.work_type === "서비스" ? "service" : "parts"}
            />
          </Suspense>
        </div>
        <ResetStageBar
          orderId={effectiveOrderId}
          stage={docStage}
          onChanged={async () => { setDocReloadKey((k) => k + 1); await onChanged(); }}
        />
      </>
    ) : (
      <MissingOrderPanel />
    );
  }
  // AR 영역 단계 = 실제 파이프라인 단계(서비스/내수 9단계 청구도 여기로 옴). 9~11로 한정.
  const arStage = Math.max(9, Math.min(stage, 11));
  return effectiveOrderId > 0 ? (
    <>
      {picker}
      <div className="project-work-panel embedded-workspace stage-fill">
        <Suspense fallback={<div className="state">Loading details…</div>}>
          <ArOverview
            key={docReloadKey}
            initialOrderId={effectiveOrderId}
            initialStage={stage >= 11 ? 11 : 10}
          />
        </Suspense>
      </div>
      <ResetStageBar
        orderId={effectiveOrderId}
        stage={arStage}
        onChanged={async () => { setDocReloadKey((k) => k + 1); await onChanged(); }}
      />
    </>
  ) : (
    <MissingOrderPanel />
  );
}

// 단계(7~11) 초기화 바(하단 고정) — 이 P/O에서 해당 단계의 완료 근거를 한 번에 지워 앞 단계로 되돌린다.
// (단계 완료는 저장 플래그가 아니라 근거 레코드 존재로 계산되므로, 필드를 비우는 것만으로는 내려가지 않는다.)
const RESET_STAGE_EVIDENCE: Record<number, string> = {
  7: "Commercial Invoice (+Packing List), Shipping Advice, and confirmation milestones",
  8: "the Proof of Delivery (POD) and delivery date",
  9: "the Tax Invoice and its A/R record",
  10: "the manual completion of this stage",
  11: "the manual completion of this stage",
};
function ResetStageBar({ orderId, stage, onChanged }: { orderId: number; stage: number; onChanged: () => void | Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  async function reset() {
    if (!confirm(`Reset stage ${stage} for the selected P/O?\nRemoves ${RESET_STAGE_EVIDENCE[stage] || "this stage's records"}. The deal returns to the previous stage.`)) return;
    setBusy(true);
    try {
      await resetStage(orderId, stage);
      invalidateCache("dashboard");
      invalidateCache("pipeline");
      invalidateCache("po:work-options");
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Reset failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="wp-reset-foot">
      <span className="wp-reset-hint">Stage {stage} is auto-derived from records on this P/O.</span>
      <button type="button" className="btn sm danger" disabled={busy} onClick={reset}>
        {busy ? "…" : "Reset this stage"}
      </button>
    </div>
  );
}

function ProjectRfqWorkspace({
  row,
  stage,
  onChanged,
}: {
  row: PipelineRow;
  stage: number;
  onChanged: () => void | Promise<unknown>;
}) {
  const { data: overview, refresh } = useCachedData("rfq:overview:", () => fetchRfqOverview());
  const rows = overview?.rows ?? [];
  const load = useCallback(() => {
    invalidateCache("dashboard");
    invalidateCache("pipeline");
    onChanged();
    return refresh();
  }, [onChanged, refresh]);
  const initialTab = stage <= 1 ? "new" : stage === 2 ? "vrfq" : stage === 3 ? "vquote" : "cquote";
  return (
    <div className="project-work-panel embedded-workspace">
      <RfqActionTabs
        rfqId={row.rfq_id}
        rows={rows}
        onSelect={() => undefined}
        onChanged={load}
        initialTab={initialTab}
        embedded
      />
    </div>
  );
}

function ProjectPoWorkspace({
  row,
  stage,
  orderId,
  onChanged,
}: {
  row: PipelineRow;
  stage: number;
  // 상위(WorkspacePanel)에서 선택된 고객 P/O(오더). 6단계 Vendor P/O가 이 오더 기준으로 발행된다.
  orderId: number;
  onChanged: () => void | Promise<unknown>;
}) {
  const { data: options, refresh } = useCachedData("po:work-options", fetchPoWorkOptions);
  const load = useCallback(() => {
    invalidateCache("dashboard");
    invalidateCache("pipeline");
    onChanged();
    return refresh();
  }, [onChanged, refresh]);
  if (!options) return <div className="state">Loading details…</div>;
  return (
    <div className="project-work-panel embedded-workspace">
      <PoActionTabs
        options={options}
        deepOrderId={orderId > 0 ? orderId : null}
        deepRfqId={row.rfq_id}
        initialTab={stage >= 6 ? "vendor" : "customer"}
        onChanged={load}
        embedded
      />
    </div>
  );
}

function MissingOrderPanel() {
  return (
    <div className="project-work-panel">
      <div className="project-work-empty">
        Customer P/O is not created yet. Create or register the order before working on this area.
      </div>
    </div>
  );
}

/** 단계별 코멘트/활동이력 — 일시·상대·수단·내용 구조화 입력 + 기록 표시/수정/삭제. */
/**
 * 거래 여정 타임라인 — 단계 완료 일시 + 모든 단계 노트를 시간순으로 병합해
 * 하나의 세로 타임라인으로. 단계별 그룹(pl-chain)과 달리 "언제 무슨 일이 있었나"를
 * 시간순으로 보여준다(읽기전용). 점 색상은 4개 중분류(phase)로 구분.
 */
function DealTimeline({
  chain,
  stageNotes,
  steps,
}: {
  chain: { no: number; label: string; value: string; at: string; skip: boolean }[];
  stageNotes: Record<string, StageNote[]> | undefined;
  steps: string[];
}) {
  type Ev = {
    key: string; sort: number; at: string; kind: "stage" | "note";
    no: number; label: string; value?: string; note?: StageNote;
  };
  const parse = (s: string) => {
    const t = Date.parse((s || "").replace(" ", "T"));
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  const events: Ev[] = [];
  chain.forEach((c) => {
    if (c.skip || !c.at) return;
    events.push({ key: `s${c.no}`, sort: parse(c.at), at: c.at, kind: "stage", no: c.no, label: c.label, value: c.value });
  });
  Object.entries(stageNotes ?? {}).forEach(([k, notes]) => {
    const no = Number(k);
    (notes ?? []).forEach((n, i) => {
      const at = n.datetime || n.at || "";
      events.push({ key: `n${k}-${i}`, sort: parse(at), at, kind: "note", no, label: steps[no - 1] ?? "", note: n });
    });
  });
  events.sort((a, b) => a.sort - b.sort);

  if (events.length === 0) {
    return (
      <div className="pl-tl-empty">
        No dated activity yet. Stage completions and notes will appear here in order.
      </div>
    );
  }
  return (
    <div className="pl-timeline">
      {events.map((e) => {
        const accent = PHASE_ACCENTS[Math.max(0, phaseIndexOfStage(e.no))] ?? PHASE_ACCENTS[0];
        return (
          <div className={`pl-tl-item ${e.kind}`} key={e.key}>
            <span
              className="pl-tl-dot"
              style={{ background: e.kind === "stage" ? accent : "var(--surface, #fff)", borderColor: accent }}
            />
            <div className="pl-tl-body">
              <div className="pl-tl-head">
                <span className="pl-tl-stage" style={{ color: accent }}>
                  {e.no}. {e.label}
                </span>
                <span className="pl-tl-at">{e.at ? fmtStageDate(e.at) : ""}</span>
              </div>
              {e.kind === "stage" ? (
                <div className="pl-tl-text done">
                  Stage completed{e.value ? ` · ${e.value}` : ""}
                </div>
              ) : (
                <div className="pl-tl-text">
                  {e.note?.direction === "in" ? (
                    <span className="pl-tl-dir in" title="Received (수신)">↓ </span>
                  ) : e.note?.direction === "out" ? (
                    <span className="pl-tl-dir out" title="Sent (발신)">↑ </span>
                  ) : null}
                  {e.note?.party || e.note?.channel ? (
                    <span className="pl-tl-meta">{joinDot(e.note?.party, e.note?.channel)} </span>
                  ) : null}
                  {e.note?.text || ""}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StageNotes({
  rfqId,
  stage,
  notes,
  onChanged,
}: {
  rfqId: number;
  stage: number;
  notes: StageNote[];
  onChanged: () => void;
}) {
  const writable = can("rfq", "edit");
  const [adding, setAdding] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  // 입력 폼은 Activity 페이지와 같은 공용 컴포넌트를 쓴다(담당자·★ 포함, 일시는 분 단위).
  const [form, setForm] = useState<ActivityNoteValue>(() => initialNoteValue());
  const [busy, setBusy] = useState(false);

  function beginAdd() {
    setEditIndex(null);
    setForm(initialNoteValue());
    setAdding(true);
  }
  function beginEdit(i: number, n: StageNote) {
    setAdding(false);
    setForm(initialNoteValue({
      text: n.text,
      datetime: n.datetime || n.at || "",
      direction: (n.direction as "" | "in" | "out") || "",
      party: n.party || "",
      channel: n.channel || "",
      star: !!n.star,
      pic: n.pic || "",
    }));
    setEditIndex(i);
  }

  function payload() {
    return {
      text: form.text.trim(),
      datetime: form.datetime,
      direction: form.direction || undefined,
      party: form.party || undefined,
      channel: form.channel || undefined,
      star: form.star,
      pic: form.pic.trim() || undefined,
    };
  }

  async function submitAdd() {
    if (!form.text.trim()) return;
    setBusy(true);
    try {
      await addRfqStageNote(rfqId, stage, payload());
      setAdding(false);
      onChanged();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to add activity");
    } finally {
      setBusy(false);
    }
  }

  async function submitEdit(index: number) {
    if (!form.text.trim()) return;
    setBusy(true);
    try {
      await updateRfqStageNote(rfqId, stage, index, payload());
      setEditIndex(null);
      onChanged();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(index: number) {
    if (!window.confirm("Delete this activity log entry?")) return;
    try {
      await deleteRfqStageNote(rfqId, stage, index);
      onChanged();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <div className="pl-notes">
      {notes.map((n, i) =>
        editIndex === i ? (
          <ActivityNoteForm
            key={i}
            value={form}
            onChange={setForm}
            onSubmit={() => submitEdit(i)}
            onCancel={() => setEditIndex(null)}
            submitLabel="Save"
            busy={busy}
          />
        ) : (
          <div className={`pl-note${n.star ? " star" : ""}`} key={i}>
            <div className="pl-note-meta">
              {/* ★·담당자는 입력 폼(공용)이 받는 값이라 여기서도 보여준다 — 안 그러면 넣어도 사라진 것처럼 보인다. */}
              {n.star ? <span className="pl-note-star" title="중요">★</span> : null}
              <span className="pl-note-at">{fmtStageDate(n.datetime || n.at)}</span>
              {n.party ? <span className="pl-note-tag party">{n.party}</span> : null}
              {n.channel ? <span className="pl-note-tag channel">{n.channel}</span> : null}
              {n.direction === "in" ? (
                <span className="pl-note-tag dir in" title="Received (수신)">↓ In</span>
              ) : n.direction === "out" ? (
                <span className="pl-note-tag dir out" title="Sent (발신)">↑ Out</span>
              ) : null}
              {n.pic ? <span className="pl-note-tag pic" title="담당자(작성자)">{n.pic}</span> : null}
              {writable ? (
                <span className="pl-note-actions">
                  <button
                    className="pl-note-edit"
                    title="Edit"
                    onClick={() => beginEdit(i, n)}
                  >
                    ✎
                  </button>
                  <button className="pl-note-del" title="Delete" onClick={() => remove(i)}>
                    ×
                  </button>
                </span>
              ) : null}
            </div>
            <div className="pl-note-text">{n.text}</div>
          </div>
        )
      )}
      {!writable ? null : adding ? (
        <ActivityNoteForm
          value={form}
          onChange={setForm}
          onSubmit={submitAdd}
          onCancel={() => setAdding(false)}
          submitLabel="Add"
          busy={busy}
        />
      ) : (
        <button className="pl-note-toggle" onClick={beginAdd}>
          + Activity log
        </button>
      )}
    </div>
  );
}
