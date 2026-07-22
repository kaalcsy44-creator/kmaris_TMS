// 딜(프로젝트) 공용 로직 — 목록·보드·상세 모달·개요 페이지가 함께 쓰는 순수 헬퍼.
// 표시 규칙이 화면마다 갈라지지 않도록 여기 한 곳에서만 정의한다.

import type { PipelineRow } from "@/lib/types";

/** 딜의 벤더 표시값 — 확정 벤더(P/O) 우선, 없으면 RFQ 발송 벤더 목록. */
export function vendorOf(r: PipelineRow): string {
  return (r.vendor || "").trim() || (r.vrfq_vendors || "").trim();
}

// 빈값·중복·자리표시("—")를 걸러 순서대로 담는다(활동로그 드롭다운 후보 조립용).
function pushUnique(out: string[], v: string | undefined) {
  const t = (v || "").trim();
  if (t && t !== "—" && !out.includes(t)) out.push(t);
}

/** 활동로그 Party(소통 상대 회사) 드롭다운 후보 — 이 딜의 고객사 + 연결된 벤더사(들). */
export function activityParties(r: PipelineRow): string[] {
  const out: string[] = [];
  pushUnique(out, r.customer);
  (r.rfq_vendors ?? []).forEach((v) => pushUnique(out, v.name));
  pushUnique(out, r.vendor);                                   // 확정 P/O 벤더
  (r.vrfq_vendors || "").split(/[\n,]/).forEach((v) => pushUnique(out, v)); // 옛 데이터 폴백
  return out;
}

/** 활동로그 Person(소통 상대 담당자) 드롭다운 후보 — 고객사 담당자 + 벤더사 담당자(들). */
export function activityPersons(r: PipelineRow): string[] {
  const out: string[] = [];
  pushUnique(out, r.contact_person);                          // 고객사 담당자
  (r.rfq_vendors ?? []).forEach((v) => pushUnique(out, v.contact)); // 벤더사 담당자(들)
  return out;
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

function partKey(v: string | undefined): string {
  return (v || "").trim().toUpperCase();
}

type DocLine = { qty?: number; unit_price?: number | null; amount?: number | null };

/** 품목 1줄의 단가 — unit_price 우선, 없으면 금액÷수량으로 역산. */
export function unitPriceOf(it: DocLine | undefined): number | null {
  if (!it) return null;
  if (it.unit_price != null) return Number(it.unit_price);
  const q = Number(it.qty || 0);
  if (it.amount != null && q) return Number(it.amount) / q;
  return null;
}

/**
 * C/I 1줄의 매입액 — 벤더 발주 단가 × C/I 수량.
 *
 * C/I 는 실제로 실은 수량만 적는다(안 실린 품목은 수량 0으로 남는다). 그래서 발주 금액을
 * 그대로 옮기면 나가지도 않은 물건의 원가가 매입으로 잡혀 마진이 음수로 무너진다.
 * 매입은 나간 수량만큼만 잡는다.
 */
export function ciPurchase(vendorPoLine: DocLine | undefined, ciLine: DocLine | undefined): number | null {
  if (!ciLine) return null;
  const unit = unitPriceOf(vendorPoLine);
  if (unit == null) return null;
  return unit * Number(ciLine.qty ?? 0);
}

/**
 * 단계 간 품목 연결자 — 기준 행(고객 P/O 품목)에 대응하는 다른 문서(견적·벤더P/O·C/I)의
 * 품목을 찾는다. 프로젝트 개요의 Quote→P/O→C/I 가로 배치가 이걸로 줄을 맞춘다.
 *
 * 품번(Part No.)이 있으면 그것으로 잇는다. 그래야 문서마다 품목 수가 달라도 제자리를
 * 찾는다 — 예: C/I 가 6개 중 5·6항만 실었으면 그 두 줄에만 붙고 나머지는 빈칸으로 남는다.
 * 같은 품번이 여러 줄이면 나온 순서대로 하나씩 소비한다.
 *
 * 품번이 하나도 없는 문서(옛 데이터)는 배열 순서로 맞춘다 — 이때는 문서별 품목 수·순서가
 * 같아야만 맞으므로, 품번을 넣어 두는 편이 정확하다.
 *
 * 반환된 함수는 소비 상태를 들고 있으므로 기준 행을 처음부터 순서대로 훑어야 한다.
 */
export function makeItemMatcher<T extends { part_no?: string }>(items: T[]) {
  const keyed = items.some((it) => partKey(it.part_no));
  const buckets = new Map<string, T[]>();
  if (keyed) {
    for (const it of items) {
      const k = partKey(it.part_no);
      if (!k) continue;
      buckets.set(k, [...(buckets.get(k) ?? []), it]);
    }
  }
  const used = new Map<string, number>();
  return (base: { part_no?: string }, index: number): T | undefined => {
    if (!keyed) return items[index];
    const k = partKey(base.part_no);
    if (!k) return undefined;
    const list = buckets.get(k);
    if (!list) return undefined; // 이 문서에는 없는 품목(예: C/I 에 안 실린 항)
    const n = used.get(k) ?? 0;
    if (n >= list.length) return undefined;
    used.set(k, n + 1);
    return list[n];
  };
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
