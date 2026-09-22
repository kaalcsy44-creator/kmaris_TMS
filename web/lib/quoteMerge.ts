// 여러 공급사 견적을 한 장의 고객 견적으로 — 줄마다 "이 원가는 어디서 왔나"를 적어 둔다.
//
// 보통은 공급사 견적 한 장이 고객 견적 한 장이 된다. 그런데 A/E·보일러·소화장치·펌프를
// 한 통에 묻는 문의처럼, 물어볼 곳이 처음부터 여럿인 건이 있다. 세 곳이 서로 다른 품목을
// 보내오고, 그래도 고객이 받는 견적서는 여전히 한 장이어야 한다. 여태 4단계의 "Load
// Vendor quote"는 고른 견적 한 장으로 품목표를 통째로 갈아 끼웠다 — 두 번째 견적을
// 부르면 첫 번째가 사라졌고, 그래서 두 번째부터는 손으로 옮겨 적어야 했다.
//
// 그래서 출처를 문서의 성질이 아니라 줄의 성질로 옮긴다(CustomerQuoteItem.src_vq_id).
// 문서 한 장에 벤더 하나를 매다는 옛 링크(Quotation.vendor_quote_id)는 출처가 하나일
// 때만 이어 두고 여럿이면 비운다 — 셋 중 하나만 적어 두면 나머지 둘이 없던 일이 된다.
//
// 이 파일은 셈만 한다(순수 함수 · node --test). 환율 환산·마진 계산은 부르는 쪽에 둔다.

import type { CustomerQuoteItem } from "@/lib/types";

// 옵션 구분행 판정(lib/quoteOptions.ts OPTION_ROW_KIND 와 같은 규칙). 이 파일은 node --test
// 로 곧장 돌려야 해서 값(runtime) import 없이 타입만 들여온다 — 규칙 한 줄을 여기 적어 둔다.
const isOptionRow = (it: { row_kind?: string | null }) => String(it?.row_kind || "") === "option";

/** 지금 이 견적의 원가가 어느 공급사 견적들에서 왔는지 — 한 출처당 한 줄. */
export type CostSource = {
  vq_id: number;
  vendor: string;
  vq_no: string;
  /** 출처 견적 자신의 통화(환산 전). 문서 원가 통화와 다를 수 있다. */
  currency: string;
  /** 이 출처에서 온 품목 줄 수. */
  lines: number;
  /** 이 출처 줄들의 매입 합계 — 문서의 원가 통화 기준(원가 × 수량). */
  cost: number;
};

/** 줄을 알아보는 이름. 라인 ID 가 있으면 그것이 정본이고, 없는 줄(파일에서 읽어 온
 *  옛 견적·손으로 친 줄)은 품번으로, 품번도 없으면 품명으로 가늠한다. */
export function lineKey(it: Pick<CustomerQuoteItem, "lid" | "part_no" | "description">): string {
  const lid = String(it.lid || "").trim();
  if (lid) return `lid:${lid}`;
  const part = String(it.part_no || "").trim().toLowerCase().replace(/\s+/g, "");
  if (part) return `part:${part}`;
  return `desc:${String(it.description || "").trim().toLowerCase().replace(/\s+/g, " ")}`;
}

/** 품목 줄만 — 옵션 구분행은 제목 한 줄이라 세지도, 겹치는지 보지도 않는다. */
const itemRows = (items: readonly CustomerQuoteItem[]) => (items || []).filter((it) => !isOptionRow(it));

/** 이 견적에 실려 있는 원가 출처들 — 줄에 적힌 순서(처음 나온 순)로 선다. */
export function costSources(items: readonly CustomerQuoteItem[]): CostSource[] {
  const out: CostSource[] = [];
  const at = new Map<number, CostSource>();
  itemRows(items).forEach((it) => {
    const id = Number(it.src_vq_id || 0);
    if (!id) return;
    let src = at.get(id);
    if (!src) {
      src = {
        vq_id: id,
        vendor: it.src_vendor || "",
        vq_no: it.src_vq_no || "",
        currency: (it.src_currency || "").toUpperCase(),
        lines: 0,
        cost: 0,
      };
      at.set(id, src);
      out.push(src);
    }
    src.lines += 1;
    src.cost += Number(it.cost_price || 0) * Number(it.qty || 1);
  });
  return out;
}

/** 출처가 적혀 있지 않은 줄 수 — 손으로 친 줄, 또는 출처를 적기 전에 만든 옛 견적. */
export function manualLines(items: readonly CustomerQuoteItem[]): number {
  return itemRows(items).filter((it) => !Number(it.src_vq_id || 0)).length;
}

/** 옛 문서 링크(Quotation.vendor_quote_id)에 적어 둘 값 — 출처가 딱 하나일 때만 그 하나.
 *  여럿이면 null: 셋 중 하나만 문서에 매달면 나머지 둘이 없던 일이 된다. */
export function soleSourceId(items: readonly CustomerQuoteItem[]): number | null {
  const src = costSources(items);
  return src.length === 1 ? src[0].vq_id : null;
}

export function hasSource(items: readonly CustomerQuoteItem[], vqId: number): boolean {
  return itemRows(items).some((it) => Number(it.src_vq_id || 0) === Number(vqId));
}

/** 한 출처에서 온 줄을 모두 걷어낸다 — 잘못 부른 견적을 한 번에 되돌리는 길. */
export function withoutSource(
  items: readonly CustomerQuoteItem[],
  vqId: number
): CustomerQuoteItem[] {
  return (items || []).filter((it) => Number(it.src_vq_id || 0) !== Number(vqId));
}

export type AppendResult = {
  items: CustomerQuoteItem[];
  /** 새로 붙은 품목 줄 수. */
  added: number;
  /** 값이 비어 있던 자리에 원가가 들어찬 줄 수(자리는 그대로, 값만 채워진다). */
  filled: number;
  /** 이미 값이 있는 줄이라 건너뛴 줄들의 품번(또는 품명) — 무엇이 빠졌는지 말해 주기 위함. */
  skipped: string[];
};

/** 값이 아직 안 들어온 자리인가 — 딜의 품목으로 미리 깔아 둔 빈 줄(원가 0·출처 없음).
 *  4단계 편집기는 문의서의 품목을 원가 0 으로 먼저 깔아 두므로, 벤더 견적을 부르면 그
 *  줄들이 "이미 있는 줄"로 보여 통째로 건너뛰는 일이 생긴다. 빈 자리는 채워야 한다. */
function isPlaceholder(it: CustomerQuoteItem): boolean {
  return !Number(it.src_vq_id || 0) && !Number(it.cost_price || 0);
}

/** 들어오는 줄을 현재 품목표에 싣는다.
 *
 * 같은 줄(같은 라인 ID·같은 품번)이 이미 있으면 — 그 줄이 값이 비어 있는 자리였으면
 * 제자리에서 채우고, 값이 이미 있으면 건너뛴다. 한 줄은 한 곳에서 사기 때문이다. 두 곳이
 * 같은 줄에 값을 줬을 때 어디서 살지는 3단계 채택 매트릭스가 정할 일이지, 여기서 같은
 * 줄을 두 줄로 늘려 둘 일이 아니다. 새 줄은 표 뒤에 붙는다. */
export function appendItems(
  existing: readonly CustomerQuoteItem[],
  incoming: readonly CustomerQuoteItem[]
): AppendResult {
  const items = [...(existing || [])];
  // 같은 줄을 되찾는 색인 — 채워 넣을 자리를 제자리에서 고쳐 쓰기 위해 위치까지 기억한다.
  const at = new Map<string, number>();
  items.forEach((it, i) => {
    if (isOptionRow(it)) return;
    const key = lineKey(it);
    if (!at.has(key)) at.set(key, i);
  });
  const skipped: string[] = [];
  let added = 0;
  let filled = 0;
  (incoming || []).forEach((it) => {
    if (isOptionRow(it)) {
      items.push(it);
      return;
    }
    const key = lineKey(it);
    const hit = at.get(key);
    if (hit !== undefined) {
      const there = items[hit];
      if (!isPlaceholder(there)) {
        skipped.push(it.part_no || it.description || key);
        return;
      }
      // 자리(순서·수량·라인 ID·분류)는 딜이 정한 것이고, 값(원가·납기·출처)은 벤더가 준 것이다.
      items[hit] = {
        ...there,
        ...it,
        qty: Number(there.qty || it.qty || 1),
        unit: there.unit || it.unit,
        lid: there.lid || it.lid || "",
        category_id: there.category_id ?? it.category_id ?? null,
      };
      filled += 1;
      return;
    }
    at.set(key, items.length);
    items.push(it);
    added += 1;
  });
  return { items, added, filled, skipped };
}

/** 합칠 때 알려야 할 것들 — 화면이 한 줄로 풀어 쓴다. */
export type MergeNotice = {
  /** 환산한 줄 수(출처 통화 ≠ 문서 원가 통화). */
  converted: number;
  /** 빈 자리에 값이 들어찬 줄 수. */
  filled: number;
  /** 겹쳐서 건너뛴 줄. */
  skipped: string[];
  /** 옵션 구분행이 걸린 합치기 — 옵션 경계가 흐트러질 수 있어 사람이 봐야 한다. */
  options: boolean;
};

export function mergeMessage(
  added: number,
  sources: { vendor: string; vq_no: string }[],
  notice: MergeNotice,
  costCurrency: string
): string {
  const who = sources.map((s) => `${s.vendor || "—"}(${s.vq_no || "—"})`).join(" · ");
  const n = added + notice.filled;
  const parts = [`Loaded ${n} line(s) from ${sources.length} vendor quote(s): ${who}.`];
  if (notice.filled > 0) {
    parts.push(`${notice.filled} of them landed on rows that were already in the list.`);
  }
  if (notice.converted > 0) {
    parts.push(`${notice.converted} line(s) converted to ${costCurrency.toUpperCase()} at the FX rate above.`);
  }
  if (notice.skipped.length > 0) {
    parts.push(`Already in this quotation, so skipped: ${notice.skipped.join(", ")}.`);
  }
  if (notice.options) {
    parts.push("This list carries option dividers — check that the merged lines sit under the option you meant.");
  }
  return parts.join(" ");
}

/** USD↔KRW 만 환산할 수 있다(convertCurrency 와 같은 규칙). 그 밖의 통화쌍은 환율이
 *  없어 숫자가 그대로 통과하므로, 조용히 틀린 원가가 되기 전에 막아야 한다. */
export function costConvertible(from: string | undefined, to: string | undefined): boolean {
  const f = (from || "").toUpperCase();
  const t = (to || "").toUpperCase();
  if (!f || !t || f === t) return true;
  return (f === "USD" && t === "KRW") || (f === "KRW" && t === "USD");
}
