// 딜(프로젝트) 공용 로직 — 목록·보드·상세 모달·개요 페이지가 함께 쓰는 순수 헬퍼.
// 표시 규칙이 화면마다 갈라지지 않도록 여기 한 곳에서만 정의한다.

import type { PipelineRow } from "@/lib/types";

/** 딜의 벤더 표시값 — 확정 벤더(P/O) 우선, 없으면 RFQ 발송 벤더 목록. */
export function vendorOf(r: PipelineRow): string {
  return (r.vendor || "").trim() || (r.vrfq_vendors || "").trim();
}

// 업무타입 "서비스"는 내부 11단계 중 7·8단계를 서비스 명칭으로 표시한다.
const SERVICE_STEP_OVERRIDES: Record<number, string> = {
  7: "Service Readiness",
  8: "Service Complete · Report",
};

/** 업무타입에 맞는 단계 이름 배열. 내부 11단계에만 적용(고객 7단계는 그대로). */
export function resolveSteps(baseSteps: string[], workType?: string | null): string[] {
  if (baseSteps.length !== 11 || (workType || "부품공급") !== "서비스") return baseSteps;
  return baseSteps.map((name, i) => SERVICE_STEP_OVERRIDES[i + 1] ?? name);
}

/** "YYYY-MM-DDTHH:MM" → "yy-mm-dd HH:MM" (표시용). 빈값이면 "". */
export function fmtStageDate(iso: string): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return iso;
  const [, y, mo, d, h, mi] = m;
  return `${y.slice(2)}-${mo}-${d} ${h}:${mi}`;
}

/** 단계의 표시 일시: 수동 저장값 우선, 없으면 자동 동기화값, 둘 다 없으면 "". */
export function stageDateOf(r: PipelineRow, stage: number): string {
  return r.stage_dates?.[String(stage)] ?? r.stage_auto?.[String(stage)] ?? "";
}

/** ` · ` 로 빈값을 건너뛰며 이어붙인다. */
export function joinDot(...parts: (string | undefined)[]): string {
  return parts.filter((p) => p && p.trim()).join(" · ");
}

export type StageChainItem = {
  no: number;
  label: string;
  /** 그 단계의 주요 결과물(문서번호·벤더·금액). 7단계 이후는 문서가 없어 "". */
  value: string;
  /** 완료 일시(수동 우선). 미완료면 "". */
  at: string;
  /** 이 딜에서 해당 없는 단계(내수 부품공급의 CI/PL/SA) */
  skip: boolean;
};

/**
 * 11단계 체인 — 1~6은 문서번호·금액, 7~11은 문서 없이 완료 일시만.
 * 상세 모달의 단계 스트립과 개요 페이지의 타임라인이 같은 값을 쓰도록 여기서 만든다.
 * rSteps 는 resolveSteps() 를 거친(업무타입 반영) 단계 이름 배열.
 */
export function buildStageChain(r: PipelineRow, rSteps: string[]): StageChainItem[] {
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
  return rSteps.map((label, i) => {
    const no = i + 1;
    // 내수 부품공급은 7·8단계(CI/PL/SA/POD)를 생략한다.
    // 서비스는 7·8이 Service Readiness/Complete 단계이므로 내수여도 생략하지 않는다.
    const skip = isDomestic && !isService && (no === 7 || no === 8);
    return { no, label, value: docValue[no] ?? "", at: stageDateOf(r, no), skip };
  });
}
