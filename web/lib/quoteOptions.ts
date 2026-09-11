// 견적 옵션(Option) — 한 건에 대안이 여럿일 때(수리 키트 / 완제품 교체 …) 품목표를
// 옵션별로 끊어 적고 옵션마다 Total 을 붙이기 위한 규칙. 서버(services/kmaris_docs.py 의
// option_blocks·item_row_plan)와 같은 규칙을 화면에서도 쓴다 — 편집기에서 본 소계와
// 발행된 PDF·Excel 의 소계가 다르면 어느 쪽을 믿어야 할지 알 수 없다.
//
// 표시는 품목 사이에 끼워 넣은 '옵션 표시행'(row_kind="option", description=옵션 제목)으로
// 한다. 소계는 저장하지 않고 그릴 때마다 다시 센다 — 저장해 두면 품목을 고친 뒤에도 옛
// 숫자가 남아 표 안에서 앞뒤가 안 맞는다.

export const OPTION_ROW_KIND = "option";

/** 옵션 판정에 필요한 최소 형태 — 품목 타입(고객 견적·공급사 견적·발주)마다 다른 필드는 보지 않는다. */
export type OptionRowLike = {
  row_kind?: string | null;
  description?: string;
  qty?: number | null;
  amount?: number | null;
  cost_price?: number | null;
};

export function isOptionRow(it: OptionRowLike | null | undefined): boolean {
  return String(it?.row_kind || "") === OPTION_ROW_KIND;
}

export function hasOptions(items: readonly OptionRowLike[] | null | undefined): boolean {
  return (items || []).some(isOptionRow);
}

export function optionLabel(no: number, title: string): string {
  const t = (title || "").trim();
  return `Option ${no}.${t ? ` ${t}` : ""}`;
}

export type OptionBlock<T> = {
  /** 옵션 번호(1,2,3…). 첫 옵션 표시행보다 앞에 놓인 품목들의 블록은 null. */
  no: number | null;
  title: string;
  /** "Option 1. Repair kit" — 번호가 없으면 빈 문자열. */
  label: string;
  items: T[];
  /** 원본 배열에서의 위치 — 편집기가 행을 되짚어 갱신할 때 쓴다. */
  indexes: number[];
  /** 옵션 표시행 자신의 위치(없으면 -1). */
  headerIndex: number;
};

/** 품목 목록을 옵션 블록으로 끊는다. 옵션 표시행이 없으면 빈 배열(=옵션을 쓰지 않는 견적). */
export function optionBlocks<T extends OptionRowLike>(items: readonly T[] | null | undefined): OptionBlock<T>[] {
  const rows = items || [];
  if (!rows.some(isOptionRow)) return [];
  const blocks: OptionBlock<T>[] = [];
  let no = 0;
  rows.forEach((it, i) => {
    if (isOptionRow(it)) {
      no += 1;
      const title = (it.description || "").trim();
      blocks.push({ no, title, label: optionLabel(no, title), items: [], indexes: [], headerIndex: i });
      return;
    }
    if (blocks.length === 0) {
      blocks.push({ no: null, title: "", label: "", items: [], indexes: [], headerIndex: -1 });
    }
    const b = blocks[blocks.length - 1];
    b.items.push(it);
    b.indexes.push(i);
  });
  return blocks;
}

/** 집계(견적 금액·마진·딜 금액)에 쓸 품목 — 옵션 구분행만 뺀 **전체** 품목.
 *
 *  옵션마다 Subtotal 을 세우고 맨 아래 Total 은 그것들을 모두 더한 값이다. 서버의
 *  _counted_rows 와 같은 규칙이라, 화면의 Final 과 목록·마진의 숫자가 한 값이 된다. */
export function countedItems<T extends OptionRowLike>(items: readonly T[] | null | undefined): T[] {
  return (items || []).filter((it) => !isOptionRow(it));
}

export type PlanEntry<T> =
  | { kind: "item"; index: number; item: T; seq: number }
  | { kind: "option"; index: number; item: T; label: string }
  | { kind: "total"; label: string; block: OptionBlock<T> };

/** 표에 실제로 그릴 행 목록 — 옵션 표시행 뒤로 그 옵션의 품목, 블록 끝에 소계행. */
export function optionPlan<T extends OptionRowLike>(items: readonly T[] | null | undefined): PlanEntry<T>[] {
  const rows = items || [];
  const blocks = optionBlocks(rows);
  if (blocks.length === 0) {
    return rows.map((item, index) => ({ kind: "item", index, item, seq: index + 1 }));
  }
  const plan: PlanEntry<T>[] = [];
  let seq = 0;
  for (const b of blocks) {
    if (b.headerIndex >= 0) {
      plan.push({ kind: "option", index: b.headerIndex, item: rows[b.headerIndex], label: b.label });
    }
    b.indexes.forEach((index, n) => {
      seq += 1;
      plan.push({ kind: "item", index, item: b.items[n], seq });
    });
    // 옵션 줄은 Subtotal — 표 맨 아래 Total(모든 옵션의 합)과 구별되어야 한다.
    plan.push({ kind: "total", label: b.no ? `Subtotal (Option ${b.no})` : "Subtotal", block: b });
  }
  return plan;
}
