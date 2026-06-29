import type { KeyboardEvent } from "react";

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

function handleGridKeyDown(event: KeyboardEvent<HTMLInputElement>) {
  const key = event.key;
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

  const input = event.currentTarget;
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

function shouldMoveHorizontally(input: HTMLInputElement, key: string): boolean {
  const start = input.selectionStart ?? 0;
  const end = input.selectionEnd ?? 0;
  if (start !== end) return true;
  return key === "ArrowLeft" ? start === 0 : end === input.value.length;
}

function findGridInput(from: HTMLInputElement, row: number, col: number): HTMLInputElement | null {
  const table = from.closest("table");
  if (!table) return null;
  return table.querySelector<HTMLInputElement>(
    `input[data-grid-row="${row}"][data-grid-col="${col}"]:not(:disabled)`
  );
}
