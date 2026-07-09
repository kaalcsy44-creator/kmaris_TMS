"use client";

import type { KeyboardEvent } from "react";
import { useCallback, useState } from "react";

export const USD_KRW_RATE = 1543.41;

// ── 품목표 다중 선택(체크박스) ─────────────────────────────────────────────
// 각 편집기에서 행을 체크박스로 선택 → 헤더 "Delete" 로 일괄 삭제한다.
// 선택은 행 인덱스 기준이므로 삭제·정렬 등 행 구성이 바뀌면 clear() 로 초기화한다.
export type RowSelection = {
  selected: Set<number>;
  isSelected: (i: number) => boolean;
  toggle: (i: number) => void;
  setAll: (count: number, on: boolean) => void;
  clear: () => void;
  count: number;
};

export function useRowSelection(): RowSelection {
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const toggle = useCallback((i: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }, []);
  const setAll = useCallback((count: number, on: boolean) => {
    setSelected(on ? new Set(Array.from({ length: count }, (_, i) => i)) : new Set());
  }, []);
  const clear = useCallback(() => setSelected(new Set()), []);
  return {
    selected,
    isSelected: (i: number) => selected.has(i),
    toggle,
    setAll,
    clear,
    count: selected.size,
  };
}

// 선택된 행을 제거하고 선택 상태를 초기화. onChange 로 남은 행을 전달한다.
// 빈 결과를 허용하려면 allowEmpty=true (마지막 1행까지 삭제 가능).
export function deleteSelectedRows<T>(
  items: T[],
  sel: RowSelection,
  onChange: (next: T[]) => void
) {
  if (sel.count === 0) return;
  onChange(items.filter((_, idx) => !sel.selected.has(idx)));
  sel.clear();
}

// 품목표 헤더 좌측(row-tools) 열의 전체 선택 체크박스.
export function ItemSelectHeaderCell({
  count,
  sel,
}: {
  count: number;
  sel: RowSelection;
}) {
  const all = count > 0 && sel.count === count;
  const some = sel.count > 0 && !all;
  return (
    <th className="row-tools">
      <input
        type="checkbox"
        className="row-check"
        aria-label="Select all rows"
        checked={all}
        disabled={count === 0}
        ref={(el) => {
          if (el) el.indeterminate = some;
        }}
        onChange={(e) => sel.setAll(count, e.target.checked)}
      />
    </th>
  );
}

// 품목표 각 행 좌측(row-tools) 열의 선택 체크박스.
export function ItemSelectCell({ index, sel }: { index: number; sel: RowSelection }) {
  return (
    <td className="row-tools">
      <input
        type="checkbox"
        className="row-check"
        aria-label={`Select row ${index + 1}`}
        checked={sel.isSelected(index)}
        onChange={() => sel.toggle(index)}
      />
    </td>
  );
}

// 품목표 헤더의 "+ Add" 옆 일괄 삭제 버튼. 선택된 행이 없으면 비활성.
export function DeleteSelectedButton({
  sel,
  onDelete,
}: {
  sel: RowSelection;
  onDelete: () => void;
}) {
  return (
    <button
      type="button"
      className="btn sm danger items-head-del"
      disabled={sel.count === 0}
      onClick={onDelete}
    >
      Delete{sel.count > 0 ? ` (${sel.count})` : ""}
    </button>
  );
}

export function parseAmountInput(value: string): number | null {
  const normalized = value.replace(/,/g, "").trim();
  if (normalized === "") return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function amountInputValue(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const parsed = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(parsed)) return "";
  return parsed.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

// Excel ROUNDUP(value, digits) 과 동일 — 0에서 먼 쪽으로 올림.
// digits 음수면 정수부(예: -3 → 1,000 단위)에서 올린다.
export function roundUp(value: number, digits = 0): number {
  if (!Number.isFinite(value) || value === 0) return 0;
  const factor = Math.pow(10, digits);
  const scaled = value * factor;
  const rounded = value >= 0 ? Math.ceil(scaled) : Math.floor(scaled);
  return rounded / factor;
}

// USD↔KRW 고정환율 변환. 그 외 통화쌍은 환율이 없으므로 원값을 그대로 둔다.
export function convertCurrency(
  amount: number,
  from: string | undefined,
  to: string | undefined,
  rate: number = USD_KRW_RATE
): number {
  const f = (from || "USD").toUpperCase();
  const t = (to || "USD").toUpperCase();
  const r = rate && Number.isFinite(rate) && rate > 0 ? rate : USD_KRW_RATE;
  if (!Number.isFinite(amount) || f === t) return amount;
  if (f === "KRW" && t === "USD") return amount / r;
  if (f === "USD" && t === "KRW") return amount * r;
  return amount;
}

export function moneyText(value: number | string | null | undefined): string {
  const parsed = toNumber(value);
  if (!Number.isFinite(parsed)) return "0";
  return Math.round(parsed).toLocaleString();
}

export function fxRateText(rate: number = USD_KRW_RATE): string {
  const r = rate && Number.isFinite(rate) && rate > 0 ? rate : USD_KRW_RATE;
  return `FX 1 USD = KRW ${r.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function dualCurrencyText(
  value: number | string | null | undefined,
  currency = "USD",
  rate: number = USD_KRW_RATE
): string {
  const amount = toNumber(value);
  const cur = (currency || "USD").toUpperCase();
  const r = rate && Number.isFinite(rate) && rate > 0 ? rate : USD_KRW_RATE;
  if (!Number.isFinite(amount)) return `${cur} 0 KRW 0`;
  if (cur === "KRW") {
    return `KRW ${Math.round(amount).toLocaleString()} USD ${moneyText(amount / r)}`;
  }
  if (cur === "USD") {
    return `USD ${moneyText(amount)} KRW ${Math.round(amount * r).toLocaleString()}`;
  }
  return `${cur} ${moneyText(amount)}`;
}

// 단계 편집기 하단 고정바용 총액 표기 — 주요 통화는 진하게, 나머지 통화·환율은 회색+non-bold.
// 3·4·5·6 단계(견적·PO) 저장 바에서 동일한 양식으로 사용한다.
export function StageTotal({
  value,
  currency = "USD",
  label = "Total",
  rate = USD_KRW_RATE,
}: {
  value: number | string | null | undefined;
  currency?: string;
  label?: string;
  rate?: number;
}) {
  const amount = toNumber(value);
  const cur = (currency || "USD").toUpperCase();
  const r = rate && Number.isFinite(rate) && rate > 0 ? rate : USD_KRW_RATE;
  let primary: string;
  let secondary = "";
  if (cur === "KRW") {
    primary = `KRW ${Math.round(amount).toLocaleString()}`;
    secondary = `USD ${moneyText(amount / r)}`;
  } else if (cur === "USD") {
    primary = `USD ${moneyText(amount)}`;
    secondary = `KRW ${Math.round(amount * r).toLocaleString()}`;
  } else {
    primary = `${cur} ${moneyText(amount)}`;
  }
  return (
    <span className="stage-total">
      <span className="stage-total-label">{label}</span>
      <b className="stage-total-main">{primary}</b>
      <span className="stage-total-sub">
        {secondary ? `${secondary} · ` : ""}
        {fxRateText(r)}
      </span>
    </span>
  );
}

export function DualCurrencyAmount({
  value,
  currency = "USD",
  rate = USD_KRW_RATE,
}: {
  value: number | string | null | undefined;
  currency?: string;
  rate?: number;
}) {
  const amount = toNumber(value);
  const cur = (currency || "USD").toUpperCase();
  const r = rate && Number.isFinite(rate) && rate > 0 ? rate : USD_KRW_RATE;
  if (cur === "KRW") {
    return (
      <span className="dual-amount">
        <span className="dual-line primary">KRW {Math.round(amount).toLocaleString()}</span>
        <span className="dual-line converted">USD {moneyText(amount / r)}</span>
      </span>
    );
  }
  if (cur === "USD") {
    return (
      <span className="dual-amount">
        <span className="dual-line primary">USD {moneyText(amount)}</span>
        <span className="dual-line converted">KRW {Math.round(amount * r).toLocaleString()}</span>
      </span>
    );
  }
  return (
    <span className="dual-amount">
      <span className="dual-line primary">{cur} {moneyText(amount)}</span>
    </span>
  );
}

function toNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  return typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
}

export function itemRowClass(index: number): string | undefined {
  return index > 0 && index % 5 === 0 ? "item-group-break" : undefined;
}

export function gridCellProps(row: number, col: number) {
  return {
    "data-grid-row": row,
    "data-grid-col": col,
    onKeyDown: handleGridKeyDown,
  };
}

type GridCell = HTMLInputElement | HTMLTextAreaElement;

function handleGridKeyDown(event: KeyboardEvent<GridCell>) {
  const key = event.key;
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

  const input = event.currentTarget;
  // 여러 줄 textarea: 캐럿이 첫 줄이면 ↑, 마지막 줄이면 ↓ 일 때만 위/아래 셀로 이동.
  // (중간 줄에서는 줄 이동을 그대로 둬서 여러 줄 편집을 방해하지 않는다.)
  if (
    input.tagName === "TEXTAREA" &&
    (key === "ArrowUp" || key === "ArrowDown") &&
    !shouldMoveVertically(input, key)
  ) {
    return;
  }
  if ((key === "ArrowLeft" || key === "ArrowRight") && !shouldMoveHorizontally(input, key)) {
    return;
  }

  const row = Number(input.dataset.gridRow);
  const col = Number(input.dataset.gridCol);
  if (!Number.isFinite(row) || !Number.isFinite(col)) return;

  const next =
    key === "ArrowLeft"
      ? findGridInput(input, row, col - 1)
      : key === "ArrowRight"
        ? findGridInput(input, row, col + 1)
        : key === "ArrowUp"
          ? findGridInput(input, row - 1, col)
          : findGridInput(input, row + 1, col);

  if (!next) return;
  event.preventDefault();
  next.focus();
  next.select();
}

function shouldMoveHorizontally(input: GridCell, key: string): boolean {
  const start = input.selectionStart ?? 0;
  const end = input.selectionEnd ?? 0;
  if (start !== end) return true;
  return key === "ArrowLeft" ? start === 0 : end === input.value.length;
}

// textarea 에서 위/아래 화살표로 인접 셀(행)로 이동할지 판단.
// 첫 줄에서 ↑, 마지막 줄에서 ↓ 이면 이동(줄바꿈 기준). 선택 영역이 있으면 편집 우선(이동 안 함).
function shouldMoveVertically(input: GridCell, key: string): boolean {
  const start = input.selectionStart ?? 0;
  const end = input.selectionEnd ?? 0;
  if (start !== end) return false;
  const value = input.value;
  if (key === "ArrowUp") return value.lastIndexOf("\n", start - 1) === -1;
  return value.indexOf("\n", end) === -1;
}

function findGridInput(from: GridCell, row: number, col: number): GridCell | null {
  const table = from.closest("table");
  if (!table) return null;
  return table.querySelector<GridCell>(
    `input[data-grid-row="${row}"][data-grid-col="${col}"]:not(:disabled),` +
      `textarea[data-grid-row="${row}"][data-grid-col="${col}"]:not(:disabled)`
  );
}
