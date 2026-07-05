"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  fetchPipeline,
  fetchRfqOverview,
  fetchPoWorkOptions,
  deleteRfq,
  updateRfq,
  fetchCustomers,
  fetchSettingsVessels,
  fetchAssignableUsers,
  addRfqStageNote,
  updateRfqStageNote,
  deleteRfqStageNote,
} from "@/lib/api";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import { useColumnLayout } from "@/components/common/useColumnLayout";
import { ColumnResizer, ColumnsButton, dragHandleProps } from "@/components/common/tableLayout";
import type { PipelineRow, CustomerOption, SettingsVessel, StageNote } from "@/lib/types";
import WorkTypeBadge from "@/components/WorkTypeBadge";
import CustomerName from "@/components/common/CustomerName";
import VendorName from "@/components/common/VendorName";
import RfqActionTabs from "@/components/RfqActionTabs";
import NewRfqForm from "@/components/screens/NewRfqForm";
import { PoActionTabs } from "@/components/screens/PoScreen";
import { DocumentsOverview } from "@/components/screens/DocumentsScreen";
import { ArOverview } from "@/components/screens/ArScreen";
import { tr } from "@/lib/labels";
import { getUser, can, isOwnScoped, canEditDeal } from "@/lib/auth";

const WORK_TYPES = ["부품공급", "서비스"];

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

// 업무타입 "서비스"는 내부 11단계 중 7·8단계를 서비스 명칭으로 표시한다.
const SERVICE_STEP_OVERRIDES: Record<number, string> = {
  7: "Service Readiness",
  8: "Service Complete · Report",
};
function resolveSteps(baseSteps: string[], workType?: string | null): string[] {
  // 내부 11단계에만 적용(고객확인용 7단계는 그대로).
  if (baseSteps.length !== 11 || (workType || "부품공급") !== "서비스") return baseSteps;
  return baseSteps.map((name, i) => SERVICE_STEP_OVERRIDES[i + 1] ?? name);
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

/** "YYYY-MM-DDTHH:MM" → "yy-mm-dd HH:MM" (표시용). 빈값이면 "". */
function fmtStageDate(iso: string): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return iso;
  const [, y, mo, d, h, mi] = m;
  return `${y.slice(2)}-${mo}-${d} ${h}:${mi}`;
}

type Tab = "customer" | "internal";
type WorkspaceArea = "rfq" | "po" | "documents" | "ar";
type StageTabKey = number;

export default function ProgressScreen() {
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
  const [deepLink, setDeepLink] = useState<{
    rfqId: number | null;
    orderId: number | null;
    stage: number | null;
  } | null>(null);
  useEffect(() => {
    if (!deepRfq && !deepOrder) return;
    setTab("internal");
    setDeepLink({
      rfqId: deepRfq ? Number(deepRfq) : null,
      orderId: deepOrder ? Number(deepOrder) : null,
      stage: deepStage ? Number(deepStage) : null,
    });
    // URL 정리 — 새로고침마다 같은 팝업이 다시 열리지 않도록 파라미터를 제거한다.
    router.replace("/progress", { scroll: false });
  }, [deepRfq, deepOrder, deepStage, router]);
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
              tableId="progress-customer"
              rows={pipeline.rows}
              steps={CUSTOMER_STEPS}
              stageOf={(r) => customerStage(r.stage)}
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
              tableId="progress-internal"
              rows={pipeline.rows}
              steps={pipeline.steps}
              customers={customers ?? []}
              vessels={vessels ?? []}
              onChanged={reloadPipeline}
              openRfqId={deepLink?.rfqId ?? null}
              openOrderId={deepLink?.orderId ?? null}
              openStage={deepLink?.stage ?? null}
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
    crfq_at: "",
    vrfq_vendors: "",
    vrfq_at: "",
    vquote_no: "",
    vquote_at: "",
    vendor_amount: "",
    cquote_no: "",
    cquote_at: "",
    customer_amount: "",
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

/** ` · ` 로 빈값을 건너뛰며 이어붙인다. */
function joinDot(...parts: (string | undefined)[]): string {
  return parts.filter((p) => p && p.trim()).join(" · ");
}

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

type ColKey =
  | "received_at"
  | "customer"
  | "vendor"
  | "work_type"
  | "vessel"
  | "project_title"
  | "stage"
  | "assignee";

const PIPELINE_COLUMNS: { key: ColKey; label: string }[] = [
  { key: "received_at", label: "Project No." },
  { key: "customer", label: "Customer" },
  { key: "vendor", label: "Vendor" },
  { key: "work_type", label: "Type" },
  { key: "vessel", label: "Vessel" },
  { key: "project_title", label: "Project" },
  { key: "stage", label: "Stage" },
  { key: "assignee", label: "PIC" },
];

// 컬럼 key → 기본 폭 CSS 클래스(table-layout: fixed 기준폭).
const PLC_CLASS: Record<ColKey, string> = {
  received_at: "plc-date",
  customer: "plc-customer",
  vendor: "plc-vendor",
  work_type: "plc-work",
  vessel: "plc-vessel",
  project_title: "plc-project",
  stage: "plc-stage",
  assignee: "plc-assignee",
};

/** 거래의 벤더 표시값 — 확정 벤더(PO) 우선, 없으면 RFQ 발송 벤더 목록. */
function vendorOf(r: PipelineRow): string {
  return r.vendor || r.vrfq_vendors || "";
}

/** 한 행에서 컬럼별 텍스트 값(검색·문자열 정렬용). */
function cellText(r: PipelineRow, key: ColKey, steps: string[]): string {
  switch (key) {
    case "received_at":
      // "Project No." 컬럼 — 정렬/검색은 화면에 표시되는 관리번호(yymmdd-nn) 기준.
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
  }
}

type SortDir = "asc" | "desc";

/** 통합 파이프라인 테이블 — 거래 1건 = 1행. 헤더 클릭 정렬 + 컬럼별 검색, 행 클릭 시 상세 모달.
 *  열: 최초 RFQ 수신 등록 일시 · 고객사 · 업무 타입 · 선박 · 프로젝트명 · 완료한 단계 · 다음 단계 · 담당자 */
function PipelineTable({
  rows,
  steps,
  customers,
  vessels,
  onChanged,
  stageOf = (r) => r.stage,
  tableId = "progress-internal",
  openRfqId = null,
  openOrderId = null,
  openStage = null,
}: {
  rows: PipelineRow[];
  steps: string[];
  customers: CustomerOption[];
  vessels: SettingsVessel[];
  onChanged: () => void | Promise<unknown>;
  // 단계 체계 추상화: 내부확인용=12단계(r.stage), 고객확인용=7단계(매핑값)
  stageOf?: (r: PipelineRow) => number;
  // 컬럼 커스터마이즈 저장 키(내부/고객 뷰 별도)
  tableId?: string;
  // 딥링크: rfq_id(우선) 또는 order_id 로 해당 프로젝트 팝업을 openStage 단계로 1회 자동 오픈.
  openRfqId?: number | null;
  openOrderId?: number | null;
  openStage?: number | null;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // 딥링크로 열 때만 지정 단계로 진입. 수동 오픈 시엔 null → 해당 프로젝트의 현재 단계로.
  const [deepStage, setDeepStage] = useState<number | null>(null);
  // 딥링크 1회 소비 가드(행 로드 지연·재렌더 시 닫은 팝업이 다시 열리지 않도록).
  const deepConsumed = useRef(false);
  // 목록·상세 모달 공용 오픈 헬퍼(수동 오픈은 지정 단계 없음).
  const openRow = useCallback((id: number) => {
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
    setSelectedId(id);
    setDeepStage(openStage && openStage > 0 ? openStage : null);
  }, [openRfqId, openOrderId, openStage, rows]);
  // 목록 표시 방식: 표(table) / 칸반 보드(board). 같은 데이터·같은 상세 모달 재사용.
  const [view, setView] = useState<"table" | "board">("table");
  // 기본 정렬: 관리번호(Project No.) 내림차순 — 최근 프로젝트가 맨 위.
  const [sortKey, setSortKey] = useState<ColKey | null>("received_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [dragKey, setDragKey] = useState<string | null>(null);
  // 컬럼 폭·순서·표시여부 (localStorage 저장)
  const layout = useColumnLayout(tableId, PIPELINE_COLUMNS);
  const drag = { active: dragKey, set: setDragKey };
  const orderedColumns = layout.visibleKeys
    .map((k) => PIPELINE_COLUMNS.find((c) => c.key === k))
    .filter((c): c is { key: ColKey; label: string } => !!c);
  // 담당자(PIC) 범위: sales 는 서버에서 본인 건만 내려오므로 항상 잠금 표시.
  // admin/viewer 는 "내 담당만" 토글로 본인(username) 건만 클라이언트 필터.
  const me = getUser();
  const salesScoped = isOwnScoped();
  const [mineOnly, setMineOnly] = useState(false);
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
  function applySort(key: ColKey, dir: SortDir) {
    setSortKey(key);
    setSortDir(dir);
    setOpenCol(null);
  }

  // 컬럼별 필터 값/세터/활성여부 — 메뉴에서 공통 사용
  function colValue(key: ColKey): string {
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
  function setColValue(key: ColKey, v: string) {
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
  function isColFiltered(key: ColKey): boolean {
    switch (key) {
      case "received_at": return !!(fFrom || fTo);
      case "customer": return fCustomer !== "전체";
      case "vendor": return fVendor !== "전체";
      case "work_type": return fWorkType !== "전체";
      case "vessel": return fVessel !== "전체";
      case "assignee": return fAssignee !== "전체";
      case "stage": return fStage !== "전체";
      default: return false;
    }
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

  // 메뉴 값 목록(전체 + 데이터 고유값). 날짜·필터없는 컬럼은 빈 배열.
  function colOptions(key: ColKey): { v: string; label: string }[] {
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
  // 2) 정렬: 완료/다음 단계는 단계 번호(숫자), 그 외는 표시 문자열(한글 로케일)
  if (sortKey) {
    const key = sortKey;
    const dir = sortDir === "asc" ? 1 : -1;
    displayRows = [...displayRows].sort((a, b) => {
      let cmp: number;
      if (key === "stage") {
        cmp = stageOf(a) - stageOf(b);
      } else {
        cmp = cellText(a, key, steps).localeCompare(cellText(b, key, steps), "ko");
      }
      return cmp * dir;
    });
  }

  // 새로고침 후에도 rfq_id로 다시 찾으므로 모달이 최신 값으로 유지된다(삭제되면 null → 자동 닫힘).
  const selected = rows.find((r) => r.rfq_id === selectedId) ?? null;

  // 헤더 클릭 시 뜨는 컬럼 메뉴: 정렬(오름/내림) + 필터(값 목록 / 날짜는 기간)
  function renderColMenu(col: ColKey) {
    const opts = colOptions(col);
    return (
      <>
        <div className="pl-menu-backdrop" onClick={() => setOpenCol(null)} />
        <div
          className="pl-col-menu"
          style={{ left: menuPos.left, top: menuPos.top }}
          role="menu"
        >
          <div className="pl-menu-sort">
            <button
              className={sortKey === col && sortDir === "asc" ? "on" : ""}
              onClick={() => applySort(col, "asc")}
            >
              <span className="ic">▲</span> Ascending
            </button>
            <button
              className={sortKey === col && sortDir === "desc" ? "on" : ""}
              onClick={() => applySort(col, "desc")}
            >
              <span className="ic">▼</span> Descending
            </button>
          </div>

          {col === "received_at" ? (
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
          ) : opts.length > 0 ? (
            <>
              <div className="pl-menu-divider" />
              <div className="pl-menu-list">
                {opts.map((o) => (
                  <button
                    key={o.v}
                    className={`pl-menu-opt${colValue(col) === o.v ? " on" : ""}`}
                    onClick={() => setColValue(col, o.v)}
                  >
                    <span className="chk">{colValue(col) === o.v ? "✓" : ""}</span>
                    <span className="lbl">{o.label}</span>
                  </button>
                ))}
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
        {filtersActive ? (
          <button type="button" className="pl-filter-reset" onClick={resetFilters}>
            Reset filters
          </button>
        ) : null}
        <span className="pl-search-count">
          {displayRows.length} / {rows.length}
        </span>
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
        {view === "table" ? <ColumnsButton cols={PIPELINE_COLUMNS} layout={layout} /> : null}
      </div>

      {view === "board" ? (
        <PipelineBoard
          rows={displayRows}
          steps={steps}
          stageOf={stageOf}
          selectedId={selectedId}
          onSelect={openRow}
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
          </colgroup>
          <thead>
            <tr>
              {orderedColumns.map((c) => {
                const sorted = sortKey === c.key;
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
                    <ColumnResizer onResize={(px) => layout.setWidth(c.key, px)} />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {displayRows.length === 0 ? (
              <tr>
                <td className="pl-empty" colSpan={orderedColumns.length}>
                  No deals match the filters.
                </td>
              </tr>
            ) : (
              displayRows.map((r) => {
                const isService = (r.work_type || "부품공급") === "서비스";
                return (
                  <tr
                    key={`p-${r.rfq_id}`}
                    className={`${isService ? "service " : ""}${
                      selectedId === r.rfq_id ? "sel" : ""
                    }`}
                    onClick={() => openRow(r.rfq_id)}
                  >
                    {orderedColumns.map((c) => (
                      <PipelineCell
                        key={c.key}
                        colKey={c.key}
                        r={r}
                        steps={steps}
                        stage={stageOf(r)}
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
          onClose={() => {
            setSelectedId(null);
            setDeepStage(null);
          }}
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
}: {
  rows: PipelineRow[];
  steps: string[];
  stageOf: (r: PipelineRow) => number;
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const grouped = steps.length === 11;
  const cols = grouped
    ? STAGE_PHASES.map((p, pi) => ({
        label: p.label,
        accent: pi,
        match: (st: number) => phaseIndexOfStage(st) === pi,
      }))
    : steps.map((label, i) => ({
        label: `${i + 1}. ${label}`,
        accent: i % 4,
        match: (st: number) => st === i + 1,
      }));

  return (
    <div className="pl-board">
      {cols.map((col, ci) => {
        const cards = rows.filter((r) => col.match(stageOf(r)));
        return (
          <section key={ci} className="pl-board-col" data-accent={col.accent}>
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
                    onClick={() => onSelect(r.rfq_id)}
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

/** 보드 1장 = 거래 1건. 관리번호·고객·선박·진행바·PIC·경과일·금액. */
function BoardCard({
  r,
  steps,
  stage,
  sel,
  onClick,
}: {
  r: PipelineRow;
  steps: string[];
  stage: number;
  sel: boolean;
  onClick: () => void;
}) {
  const isService = (r.work_type || "부품공급") === "서비스";
  const total = steps.length;
  const filled = Math.max(0, Math.min(stage, total));
  const amount = r.customer_amount || r.vendor_amount || "";
  const age = daysSince(r.first_rfq_at);
  return (
    <button
      type="button"
      className={`pl-card${sel ? " sel" : ""}${isService ? " service" : ""}`}
      onClick={onClick}
    >
      <div className="pl-card-top">
        <span className="pl-card-no">{r.project_no || "—"}</span>
        <WorkTypeBadge type={r.work_type} />
      </div>
      <div className="pl-card-cust" title={r.customer || ""}>
        {r.customer ? <CustomerName name={r.customer} /> : "—"}
      </div>
      {r.project_title ? (
        <div className="pl-card-proj" title={r.project_title}>{r.project_title}</div>
      ) : null}
      {r.vessel ? <div className="pl-card-sub" title={r.vessel}>{r.vessel}</div> : null}
      <div className="pl-card-bar" title={`${filled}/${total} ${steps[filled - 1] ?? ""}`}>
        {Array.from({ length: total }).map((_, i) => (
          <span key={i} className={`seg${i < filled ? " on" : ""}`} />
        ))}
      </div>
      <div className="pl-card-stage">
        {filled}/{total} · {steps[filled - 1] ?? ""}
      </div>
      <div className="pl-card-foot">
        <span className={`pl-card-pic${r.assignee ? "" : " none"}`}>{r.assignee || "—"}</span>
        {age != null ? <span className="pl-card-age" title="Days since first RFQ">{age}d</span> : null}
      </div>
      {amount ? <div className="pl-card-amt" title={amount}>{amount}</div> : null}
      {r.next_action ? (
        <div className={`pl-card-next lv-${r.next_level || "normal"}`} title="Recommended next action">
          {r.next_action}
        </div>
      ) : null}
    </button>
  );
}

/** 파이프라인 테이블 셀 — 컬럼 key 에 따라 내용/클래스를 렌더(순서 변경에 대응). */
function PipelineCell({
  colKey,
  r,
  steps,
  stage,
}: {
  colKey: ColKey;
  r: PipelineRow;
  steps: string[];
  stage: number;
}) {
  switch (colKey) {
    case "received_at":
      return (
        <td className="nowrap">
          <div className="proj-cell">
            <div className="pn">{r.project_no || <span className="muted">—</span>}</div>
            {r.received_at ? <div className="pn-at">{fmtStageDate(r.received_at)}</div> : null}
          </div>
        </td>
      );
    case "customer":
      return <td className="strong">{r.customer ? <CustomerName name={r.customer} /> : "No customer"}</td>;
    case "vendor":
      return <td className="pl-td-vendor">{vendorOf(r) ? <VendorName name={vendorOf(r)} /> : <span className="muted">—</span>}</td>;
    case "work_type":
      return (
        <td>
          <WorkTypeBadge type={r.work_type} />
        </td>
      );
    case "vessel":
      return <td>{r.vessel || <span className="muted">No vessel</span>}</td>;
    case "project_title":
      return <td>{r.project_title || <span className="muted">No title</span>}</td>;
    case "stage":
      return (
        <td className="pl-td-stage">
          <StageBar stage={stage} steps={resolveSteps(steps, r.work_type)} />
        </td>
      );
    case "assignee":
      return <td>{r.assignee || <span className="muted">—</span>}</td>;
    default:
      return <td />;
  }
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
  isNew,
  initialStage = null,
}: {
  r: PipelineRow;
  steps: string[];
  customers: CustomerOption[];
  vessels: SettingsVessel[];
  onChanged: () => void | Promise<unknown>;
  onClose: () => void;
  // isNew: 신규 RFQ 등록 모드 — 저장된 프로젝트가 없으므로 좌측/딜 액션은 안내로 대체하고
  // 우측 상세 자리에 신규 RFQ 기본정보 입력 폼(NewRfqForm)을 넣는다.
  isNew?: boolean;
  // 딥링크로 열 때 진입할 단계(1~11). null 이면 프로젝트의 현재 단계로 연다.
  initialStage?: number | null;
}) {
  const isNewProject = !!isNew;
  const backdropMouseDown = useRef(false);
  // 담당(PIC) 소유권: 비관리자는 본인이 담당인 딜만 편집/삭제. 남의 건은 조회만.
  const ownsDeal = canEditDeal(r.assignee_id);
  const canEdit = can("rfq", "edit") && ownsDeal;
  const canDelete = can("rfq", "delete") && ownsDeal;
  const { data: users } = useCachedData("assignable-users", fetchAssignableUsers);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  // 단계 상세 표시: 단계별 그룹(stages, 편집 가능) / 시간순 여정(timeline, 읽기전용)
  const [selectedStage, setSelectedStage] = useState<StageTabKey>(
    Math.min(Math.max(initialStage || r.stage || 1, 1), 11)
  );
  // 편집 필드(편집 진입 시 r 값으로 seed)
  const [fWorkType, setFWorkType] = useState(r.work_type || "부품공급");
  const [fCustomerId, setFCustomerId] = useState<number | "">(r.customer_id || "");
  const [fVesselId, setFVesselId] = useState<number | "">(r.vessel_id || "");
  const [fCustRfqNo, setFCustRfqNo] = useState(r.customer_rfq_no || "");
  const [fProjectTitle, setFProjectTitle] = useState(r.project_title || "");
  const [fReceivedAt, setFReceivedAt] = useState(r.received_at || "");
  const [fAssigneeId, setFAssigneeId] = useState<number | "">(r.assignee_id || "");
  const rSteps = resolveSteps(steps, fWorkType);

  function startEdit() {
    // 현재 저장값으로 seed 후 편집 모드 진입(목록은 상위에서 미리 로드됨)
    setFWorkType(r.work_type || "부품공급");
    setFCustomerId(r.customer_id || "");
    setFVesselId(r.vessel_id || "");
    setFCustRfqNo(r.customer_rfq_no || "");
    setFProjectTitle(r.project_title || "");
    setFReceivedAt(r.received_at || "");
    setFAssigneeId(r.assignee_id || "");
    setEditing(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await updateRfq(r.rfq_id, {
        customer_id: fCustomerId === "" ? undefined : fCustomerId,
        vessel_id: fVesselId === "" ? 0 : fVesselId, // 0 = 선박 미지정 해제
        customer_rfq_no: fCustRfqNo,
        project_title: fProjectTitle,
        work_type: fWorkType,
        received_at: fReceivedAt || undefined,
        assignee_id: fAssigneeId === "" ? 0 : fAssigneeId, // 0 = 담당자 미지정
      });
      // 목록 새로고침이 끝난 뒤에 편집 모드를 닫는다. 그래야 보기 모드로 돌아갈 때
      // 이미 갱신된 값(예: PIC)이 반영되어, "한 번에 안 바뀐다"는 착시가 없어진다.
      await onChanged();
      setEditing(false);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Update failed");
    } finally {
      setSaving(false);
    }
  }

  // 선택한 고객 소유 선박만(소유 정보 없는 선박은 항상 노출)
  const vesselOptions = vessels.filter(
    (v) => fCustomerId === "" || !v.customer_id || v.customer_id === fCustomerId
  );

  async function handleDelete() {
    const ok = window.confirm(
      `Delete deal ${r.kmaris_rfq_no}?\nLinked Vendor RFQs/quotes will also be deleted.\n(Deals already advanced to a customer quote/order cannot be deleted.)`
    );
    if (!ok) return;
    setDeleting(true);
    try {
      await deleteRfq(r.rfq_id);
      onChanged();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  /** 단계의 표시 일시(읽기 전용): 수동 저장값 우선, 없으면 자동 동기화값, 둘 다 없으면 빈칸. */
  function effective(stage: number): string {
    return r.stage_dates?.[String(stage)] ?? r.stage_auto?.[String(stage)] ?? "";
  }

  // 12단계 체인: 1~6은 문서번호·금액, 7~12는 문서 없이 완료 일시만. 일시는 effective() 통일.
  const docValue: Record<number, string> = {
    1: r.customer_rfq_no,
    2: r.vrfq_vendors,
    3: joinDot(r.vquote_no, r.vendor_amount),
    4: joinDot(r.cquote_no, r.customer_amount),
    5: r.customer_po_no || "",
    6: joinDot(r.vendor_po_no, r.vendor),
  };
  const isDomestic = (r.trade_type || "수출") === "내수";
  const isService = (r.work_type || "부품공급") === "서비스";
  const chain = rSteps.map((label, i) => {
    const no = i + 1;
    // 내수 부품공급은 7·8·9단계(CI/PL/SA/POD)를 생략한다.
    // 서비스는 7·8·9가 Service Readiness/arrangement/Complete 단계이므로 내수여도 생략하지 않는다.
    const skip = isDomestic && !isService && (no === 7 || no === 8);
    return { no, label, value: docValue[no] ?? "", at: effective(no), skip };
  });

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
        className={`pl-modal${isService ? " service" : ""}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="pl-modal-head">
          {isNewProject ? (
            <span className="intl-title">
              <b>New Customer RFQ</b>
              <span className="pl-proj-name">Register a new project</span>
            </span>
          ) : (
            <span className="intl-title">
              <span className="pl-recv-label">Project No.</span>
              <b>{r.project_no || "—"}</b>
              <WorkTypeBadge type={r.work_type} />
              {r.project_title ? <span className="pl-proj-name">{r.project_title}</span> : null}
              {r.received_at ? <span className="pl-recv-at">First RFQ {fmtStageDate(r.received_at)}</span> : null}
            </span>
          )}
          <span className="pl-head-right">
            <span className="pl-pic-chip">
              <span className="pl-pic-label">PIC</span>
              {r.assignee || "—"}
            </span>
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

        {/* 단계 스트립 — 진행상태(완료 음영/현재)와 탐색(선택)을 통합하고, 각 단계의
            주요 결과물(번호·Vendor·금액 등)과 완료 일시를 카드에 함께 노출한다. */}
        <div className="project-stage-tabs" role="tablist" aria-label="Project stages">
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

        <div className="pl-modal-body">
          <div className="intl-detail">
            <div className="project-workspace-layout">
              <aside className="project-info-pane">
            {isNewProject ? (
            <div className="intl-new-hint">
              <p>Fill in the basic info on the right and click <b>Create RFQ</b>.</p>
              <p className="muted">Once created, this project appears on the board with its stages.</p>
            </div>
          ) : editing ? (
            <div className="intl-edit">
              <div className="form-field">
                <label>Work type</label>
                <div className="seg-tabs">
                  {WORK_TYPES.map((t) => (
                    <button
                      key={t}
                      type="button"
                      className={fWorkType === t ? "on" : ""}
                      onClick={() => setFWorkType(t)}
                    >
                      {tr(t)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="form-grid">
                <div className="form-field">
                  <label>Customer</label>
                  <select
                    value={fCustomerId}
                    onChange={(e) => {
                      setFCustomerId(e.target.value === "" ? "" : Number(e.target.value));
                      setFVesselId("");
                    }}
                  >
                    <option value="">Select…</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <label>Vessel</label>
                  <select
                    value={fVesselId}
                    onChange={(e) =>
                      setFVesselId(e.target.value === "" ? "" : Number(e.target.value))
                    }
                  >
                    <option value="">— No vessel —</option>
                    {vesselOptions.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <label>Customer RFQ No.</label>
                  <input
                    value={fCustRfqNo}
                    onChange={(e) => setFCustRfqNo(e.target.value)}
                    placeholder="Customer's reference no. (optional)"
                  />
                </div>
                <div className="form-field">
                  <label>Project title</label>
                  <input
                    value={fProjectTitle}
                    onChange={(e) => setFProjectTitle(e.target.value)}
                    placeholder="Internal reference title (optional)"
                  />
                </div>
                <div className="form-field">
                  <label>RFQ received at</label>
                  <input
                    type="datetime-local"
                    value={fReceivedAt}
                    onChange={(e) => setFReceivedAt(e.target.value)}
                  />
                </div>
                <div className="form-field">
                  <label>PIC</label>
                  <select
                    value={fAssigneeId}
                    onChange={(e) =>
                      setFAssigneeId(e.target.value === "" ? "" : Number(e.target.value))
                    }
                  >
                    <option value="">— Unassigned —</option>
                    {(users ?? []).map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.username}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          ) : (
            <dl className="intl-meta">
              <div>
                <dt>Customer</dt>
                <dd>{r.customer ? <CustomerName name={r.customer} /> : "—"}</dd>
              </div>
              <div>
                <dt>Trade type</dt>
                <dd>{tr(r.trade_type || "수출")}</dd>
              </div>
              <div>
                <dt>Vessel</dt>
                <dd>{r.vessel || "—"}</dd>
              </div>
              <div>
                <dt>Vendor</dt>
                <dd>{r.vendor || "—"}</dd>
              </div>
              <div>
                <dt>Project title</dt>
                <dd>{r.project_title || "—"}</dd>
              </div>
              <div>
                <dt>Customer P/O No.</dt>
                <dd>{r.customer_po_no || "—"}</dd>
              </div>
              <div>
                <dt>Items</dt>
                <dd>{r.item_count}</dd>
              </div>
              <div>
                <dt>PIC</dt>
                <dd>{r.assignee || "—"}</dd>
              </div>
            </dl>
          )}

          {!isNewProject && r.next_action ? (
            <div className={`pl-next-banner lv-${r.next_level || "normal"}`}>
              <span className="pl-next-label">Next action</span>
              <span className="pl-next-text">{r.next_action}</span>
            </div>
          ) : null}

          {/* 딜(프로젝트) 수준 액션 — 좌측 기본정보와 함께. 단계 레코드 편집(우측)과
              분리되어 하단 버튼 중복을 없앤다. 신규 등록 모드에서는 감춘다. */}
          {!isNewProject ? (
          <div className="pl-deal-actions">
            {!ownsDeal && can("rfq", "edit") ? (
              <span className="hint-inline" title={r.assignee ? `PIC: ${r.assignee}` : undefined}>
                View only — assigned to {r.assignee || "another PIC"}
              </span>
            ) : null}
            {canEdit && editing ? (
              <>
                <button className="btn primary" onClick={handleSave} disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </button>
                <button className="btn" onClick={() => setEditing(false)} disabled={saving}>
                  Cancel
                </button>
              </>
            ) : canEdit ? (
              <button className="btn" onClick={startEdit}>
                ✎ Edit project info
              </button>
            ) : null}
            {canDelete ? (
              <button className="btn danger" onClick={handleDelete} disabled={deleting || editing}>
                {deleting ? "Deleting…" : "Delete project"}
              </button>
            ) : null}
          </div>
          ) : null}
              </aside>

              <section className="project-stage-pane">
            {/* 단계 상세 공통 헤더 — 모든 단계에서 동일한 위치·서체의 제목(좌) +
                다음 단계로 이동하는 → 버튼(우상단). 11개 단계 UI 일관성의 기준. */}
            <div className="stage-pane-head">
              <h3 className="stage-pane-title">
                <span className="stage-pane-no">{selectedStage}</span>
                <span>{rSteps[selectedStage - 1] ?? ""}</span>
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
  if (area === "rfq") {
    return <ProjectRfqWorkspace row={row} stage={stage} onChanged={onChanged} />;
  }
  if (area === "po") {
    return <ProjectPoWorkspace row={row} stage={stage} onChanged={onChanged} />;
  }
  if (area === "documents") {
    return row.order_id > 0 ? (
      <div className="project-work-panel embedded-workspace">
        <Suspense fallback={<div className="state">Loading...</div>}>
          <DocumentsOverview
            initialOrderId={row.order_id}
            initialStage={Math.min(Math.max(stage, 7), 9)}
            initialView={row.work_type === "서비스" ? "service" : "parts"}
          />
        </Suspense>
      </div>
    ) : (
      <MissingOrderPanel />
    );
  }
  return row.order_id > 0 ? (
    <div className="project-work-panel embedded-workspace">
      <Suspense fallback={<div className="state">Loading...</div>}>
        <ArOverview
          initialOrderId={row.order_id}
          initialStage={stage >= 11 ? 11 : 10}
        />
      </Suspense>
    </div>
  ) : (
    <MissingOrderPanel />
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
  onChanged,
}: {
  row: PipelineRow;
  stage: number;
  onChanged: () => void | Promise<unknown>;
}) {
  const { data: options, refresh } = useCachedData("po:work-options", fetchPoWorkOptions);
  const load = useCallback(() => {
    invalidateCache("dashboard");
    invalidateCache("pipeline");
    onChanged();
    return refresh();
  }, [onChanged, refresh]);
  if (!options) return <div className="state">Loading...</div>;
  return (
    <div className="project-work-panel embedded-workspace">
      <PoActionTabs
        options={options}
        deepOrderId={row.order_id > 0 ? row.order_id : null}
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

const NOTE_PARTIES = ["Customer", "Vendor", "Internal", "Other"];
const NOTE_CHANNELS = ["Email", "Call", "SMS", "Messenger", "Visit", "Other"];

/** datetime-local 기본값(현재 시각, 분 단위) "YYYY-MM-DDTHH:MM". */
function nowLocalInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/** 활동 기록 구조화 입력 폼 — 신규/수정 공용. initial 이 있으면 그 값으로 채운다. */
function NoteForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: StageNote | null;
  submitLabel: string;
  onSubmit: (p: { text: string; datetime: string; party: string; channel: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [dt, setDt] = useState(initial?.datetime || initial?.at || nowLocalInput());
  const [party, setParty] = useState(initial?.party || "Customer");
  const [channel, setChannel] = useState(initial?.channel || "Email");
  const [text, setText] = useState(initial?.text || "");
  const [busy, setBusy] = useState(false);

  async function go() {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    try {
      await onSubmit({ text: t, datetime: dt, party, channel });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pl-note-form">
      <div className="pl-note-fields">
        <input
          type="datetime-local"
          value={dt}
          onChange={(e) => setDt(e.target.value)}
          title="Activity time"
        />
        <select value={party} onChange={(e) => setParty(e.target.value)} title="Party">
          {NOTE_PARTIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select value={channel} onChange={(e) => setChannel(e.target.value)} title="Channel">
          {NOTE_CHANNELS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div className="pl-note-add">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") go();
            if (e.key === "Escape") onCancel();
          }}
          placeholder="Type the activity and press Enter"
          autoFocus
        />
        <button className="pl-note-btn primary" onClick={go} disabled={busy || !text.trim()}>
          {submitLabel}
        </button>
        <button className="pl-note-btn" onClick={onCancel}>
          Cancel
        </button>
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

  async function submitAdd(p: { text: string; datetime: string; party: string; channel: string }) {
    try {
      await addRfqStageNote(rfqId, stage, p);
      setAdding(false);
      onChanged();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to add activity");
    }
  }

  async function submitEdit(
    index: number,
    p: { text: string; datetime: string; party: string; channel: string }
  ) {
    try {
      await updateRfqStageNote(rfqId, stage, index, p);
      setEditIndex(null);
      onChanged();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Update failed");
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
          <NoteForm
            key={i}
            initial={n}
            submitLabel="Save"
            onSubmit={(p) => submitEdit(i, p)}
            onCancel={() => setEditIndex(null)}
          />
        ) : (
          <div className="pl-note" key={i}>
            <span className="pl-note-at">{fmtStageDate(n.datetime || n.at)}</span>
            {n.party ? <span className="pl-note-tag party">{n.party}</span> : null}
            {n.channel ? <span className="pl-note-tag channel">{n.channel}</span> : null}
            <span className="pl-note-text">{n.text}</span>
            {writable ? (
              <>
                <button
                  className="pl-note-edit"
                  title="Edit"
                  onClick={() => {
                    setAdding(false);
                    setEditIndex(i);
                  }}
                >
                  ✎
                </button>
                <button className="pl-note-del" title="Delete" onClick={() => remove(i)}>
                  ×
                </button>
              </>
            ) : null}
          </div>
        )
      )}
      {!writable ? null : adding ? (
        <NoteForm
          initial={null}
          submitLabel="Add"
          onSubmit={submitAdd}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button
          className="pl-note-toggle"
          onClick={() => {
            setEditIndex(null);
            setAdding(true);
          }}
        >
          + Activity log
        </button>
      )}
    </div>
  );
}
