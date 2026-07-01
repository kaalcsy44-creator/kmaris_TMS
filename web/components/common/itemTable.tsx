import type { KeyboardEvent } from "react";

export const USD_KRW_RATE = 1543.41;

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

// USD↔KRW 고정환율 변환. 그 외 통화쌍은 환율이 없으므로 원값을 그대로 둔다.
export function convertCurrency(
  amount: number,
  from: string | undefined,
  to: string | undefined
): number {
  const f = (from || "USD").toUpperCase();
  const t = (to || "USD").toUpperCase();
  if (!Number.isFinite(amount) || f === t) return amount;
  if (f === "KRW" && t === "USD") return amount / USD_KRW_RATE;
  if (f === "USD" && t === "KRW") return amount * USD_KRW_RATE;
  return amount;
}

export function moneyText(value: number | string | null | undefined): string {
  const parsed = toNumber(value);
  if (!Number.isFinite(parsed)) return "0";
  return Math.round(parsed).toLocaleString();
}

export function fxRateText(): string {
  return `FX 1 USD = KRW ${USD_KRW_RATE.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function dualCurrencyText(
  value: number | string | null | undefined,
  currency = "USD"
): string {
  const amount = toNumber(value);
  const cur = (currency || "USD").toUpperCase();
  if (!Number.isFinite(amount)) return `${cur} 0 KRW 0`;
  if (cur === "KRW") {
    return `KRW ${Math.round(amount).toLocaleString()} USD ${moneyText(amount / USD_KRW_RATE)}`;
  }
  if (cur === "USD") {
    return `USD ${moneyText(amount)} KRW ${Math.round(amount * USD_KRW_RATE).toLocaleString()}`;
  }
  return `${cur} ${moneyText(amount)}`;
}

export function DualCurrencyAmount({
  value,
  currency = "USD",
}: {
  value: number | string | null | undefined;
  currency?: string;
}) {
  const amount = toNumber(value);
  const cur = (currency || "USD").toUpperCase();
  if (cur === "KRW") {
    return (
      <span className="dual-amount">
        <span className="dual-line primary">KRW {Math.round(amount).toLocaleString()}</span>
        <span className="dual-line converted">USD {moneyText(amount / USD_KRW_RATE)}</span>
      </span>
    );
  }
  if (cur === "USD") {
    return (
      <span className="dual-amount">
        <span className="dual-line primary">USD {moneyText(amount)}</span>
        <span className="dual-line converted">KRW {Math.round(amount * USD_KRW_RATE).toLocaleString()}</span>
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
