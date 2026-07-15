"use client";

import type { ClipboardEvent, KeyboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cellText, parseClipboardGrid, tsvCell } from "./itemClipboard";

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
  return queryGridInput(table, row, col);
}

function queryGridInput(table: Element, row: number, col: number): GridCell | null {
  return table.querySelector<GridCell>(
    `input[data-grid-row="${row}"][data-grid-col="${col}"]:not(:disabled),` +
      `textarea[data-grid-row="${row}"][data-grid-col="${col}"]:not(:disabled)`
  );
}

function focusGridCell(from: GridCell, row: number, col: number): boolean {
  const el = findGridInput(from, row, col);
  if (!el) return false;
  el.focus();
  el.select();
  return true;
}

// ── 엑셀식 편집(붙여넣기 · 복사 · Ctrl+D · Enter) ───────────────────────────
// 각 셀에 data-grid-row/col 좌표를 붙이고, 그 위에 키 이동·클립보드·블록 편집을
// 얹어 "엑셀에서 복사 → 표에 붙여넣기" 를 지원한다.
//
// 컬럼 매핑은 fields — 그리드 열 번호(0-based) 순서대로 나열한 필드 키 — 하나로 정한다.
// Amount 처럼 계산 전용 컬럼은 입력이 없어 열 번호를 차지하지 않으므로 fields 에도 넣지 않는다.
//
// 붙여넣기는 "이 표의 컬럼 순서" 기준으로 자리를 맞춘다. 벤더 엑셀의 컬럼 순서는 대개 이 표와
// 다르므로, 여러 컬럼을 한 번에 붙이는 것보다 컬럼 단위(엑셀에서 Description 열만 복사 →
// 이 표 Description 첫 셀에 붙여넣기)로 옮기는 쪽이 잘 맞는다.

export type ItemGridKeys = {
  /** 셀에 뿌리는 props — 좌표 + 키/붙여넣기 처리. <input {...cell(i, 0)} /> 처럼 쓴다. */
  cell: (row: number, col: number) => {
    "data-grid-row": number;
    "data-grid-col": number;
    onKeyDown: (e: KeyboardEvent<GridCell>) => void;
    onPaste: (e: ClipboardEvent<GridCell>) => void;
  };
  /** 행을 TSV 로 클립보드에 복사(엑셀에 그대로 붙는다). 선택 행이 없으면 전체 행. */
  copyRows: () => Promise<void>;
};

export function useItemGridKeys<T extends object>({
  items,
  onChange,
  fields,
  numeric = [],
  blank,
  headers,
  sel,
  normalizeRow,
}: {
  items: T[];
  onChange: (next: T[]) => void;
  /** 그리드 열 번호 순서대로 나열한 필드 키. cell(row, col) 의 col 과 1:1 로 맞아야 한다. */
  fields: string[];
  /** 숫자로 저장할 필드 — 붙여넣기 시 "1,234" → 1234 로 파싱한다. */
  numeric?: string[];
  /** 행이 모자랄 때(붙여넣기·마지막 행 Enter) 새로 만들 빈 행. */
  blank: () => T;
  /** Copy 시 첫 줄에 붙일 헤더. 생략하면 값만 복사. */
  headers?: string[];
  /** 주면 체크된 행만 복사. */
  sel?: RowSelection;
  /** 파생 컬럼(Amount 등)이 있는 표에서 쓴다. 값을 쓴 뒤 그 행을 다시 계산할 기회.
   *  changed = 이번에 값이 들어간 필드 키. 편집기의 patch() 재계산 분기와 같은 규칙을 넣어야
   *  붙여넣기/Ctrl+D 결과가 손으로 친 것과 같아진다. */
  normalizeRow?: (row: T, changed: string[]) => T;
}): ItemGridKeys {
  const finish = (row: T, changed: string[]): T => (normalizeRow ? normalizeRow(row, changed) : row);
  // 행이 늘어난 뒤(=리렌더 후)에야 새 셀이 DOM 에 생기므로, 포커스는 여기 적어두고 다음 커밋에서 준다.
  const pending = useRef<{ table: Element; row: number; col: number } | null>(null);
  useEffect(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    const el = queryGridInput(p.table, p.row, p.col);
    el?.focus();
    el?.select();
  });

  function writeField(row: number, col: number, raw: string) {
    const f = fields[col];
    if (!f) return;
    onChange(
      items.map((it, i) =>
        i === row
          ? finish({ ...it, [f]: numeric.includes(f) ? parseAmountInput(raw) : raw } as T, [f])
          : it
      )
    );
  }

  // 클립보드 블록을 (startRow, startCol) 기준으로 찍어넣는다. 행이 모자라면 늘리고,
  // 표 오른쪽 밖으로 넘치는 열은 버린다.
  function applyBlock(startRow: number, startCol: number, block: string[][]) {
    const next = items.slice();
    while (next.length < startRow + block.length) next.push(blank());
    block.forEach((cells, r) => {
      const target = { ...next[startRow + r] } as Record<string, unknown>;
      const changed: string[] = [];
      cells.forEach((raw, c) => {
        const f = fields[startCol + c];
        if (!f) return;
        target[f] = numeric.includes(f) ? parseAmountInput(raw) : raw;
        changed.push(f);
      });
      next[startRow + r] = finish(target as T, changed);
    });
    onChange(next);
  }

  function onPaste(e: ClipboardEvent<GridCell>) {
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    const block = parseClipboardGrid(text);
    // 한 칸짜리는 브라우저 기본 동작에 맡긴다(부분 선택 교체 등이 자연스럽게 동작).
    if (block.length === 0 || (block.length === 1 && block[0].length === 1)) return;
    const el = e.currentTarget;
    const row = Number(el.dataset.gridRow);
    const col = Number(el.dataset.gridCol);
    if (!Number.isFinite(row) || !Number.isFinite(col)) return;
    e.preventDefault();
    applyBlock(row, col, block);
  }

  function onKeyDown(e: KeyboardEvent<GridCell>) {
    const el = e.currentTarget;
    const row = Number(el.dataset.gridRow);
    const col = Number(el.dataset.gridCol);
    if (!Number.isFinite(row) || !Number.isFinite(col)) return;

    // Ctrl+D — 바로 위 셀 값을 내려받는다(엑셀 동일). 숫자/문자 타입을 보존하려 파싱 없이 그대로 복사.
    if ((e.ctrlKey || e.metaKey) && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      const f = fields[col];
      if (!f || row < 1) return;
      const above = items[row - 1] as Record<string, unknown>;
      onChange(items.map((it, i) => (i === row ? finish({ ...it, [f]: above[f] } as T, [f]) : it)));
      return;
    }

    if (e.key === "Enter") {
      // Alt+Enter — 셀 안 줄바꿈(엑셀 동일). 브라우저 기본값에 기대지 않고 직접 끼워넣는다.
      if (e.altKey) {
        if (el.tagName !== "TEXTAREA") return;
        e.preventDefault();
        const s = el.selectionStart ?? el.value.length;
        const t = el.selectionEnd ?? s;
        writeField(row, col, `${el.value.slice(0, s)}\n${el.value.slice(t)}`);
        requestAnimationFrame(() => {
          el.selectionStart = el.selectionEnd = s + 1;
        });
        return;
      }
      e.preventDefault();
      if (e.shiftKey) {
        focusGridCell(el, row - 1, col);
        return;
      }
      if (focusGridCell(el, row + 1, col)) return;
      // 마지막 행에서 Enter → 행을 하나 늘리고 같은 컬럼으로 내려간다.
      // 갓 추가된 빈 행에서 또 누르면 계속 늘어나므로, 손대지 않은 행이면 늘리지 않는다.
      if (isUntouchedRow(items[row], blank(), fields)) return;
      const table = el.closest("table");
      if (table) pending.current = { table, row: row + 1, col };
      onChange([...items, blank()]);
      return;
    }

    handleGridKeyDown(e);
  }

  async function copyRows() {
    const chosen = sel && sel.count > 0 ? items.filter((_, i) => sel.selected.has(i)) : items;
    const lines: string[] = [];
    if (headers?.length) lines.push(headers.map(tsvCell).join("\t"));
    for (const it of chosen) {
      const r = it as Record<string, unknown>;
      lines.push(fields.map((f) => tsvCell(cellText(r[f]))).join("\t"));
    }
    await navigator.clipboard.writeText(lines.join("\r\n"));
  }

  return {
    cell: (row, col) => ({
      "data-grid-row": row,
      "data-grid-col": col,
      onKeyDown,
      onPaste,
    }),
    copyRows,
  };
}

/** blank() 대비 아직 아무것도 입력되지 않은 행인지. 기본값(qty=1, unit=PCS 등)은 빈 것으로 본다. */
function isUntouchedRow<T extends object>(row: T | undefined, blank: T, fields: string[]): boolean {
  if (!row) return true;
  const a = row as Record<string, unknown>;
  const b = blank as Record<string, unknown>;
  return fields.every((f) => cellText(a[f]) === cellText(b[f]));
}


/** 품목표 헤더의 엑셀 단축키 안내. Enter 가 줄바꿈이 아니라 아래 셀 이동으로 바뀌었으므로
 *  (엑셀과 동일) 최소한의 발견 수단이 필요하다 — 자세한 내용은 hover 툴팁. */
export function ItemGridHint() {
  return (
    <span
      className="items-head-hint"
      title={[
        "엑셀에서 복사한 범위를 셀에 붙여넣기 — 행이 모자라면 자동으로 늘어납니다.",
        "  · 컬럼 순서가 다르면 엑셀에서 컬럼 하나씩 복사해 같은 컬럼에 붙여넣으세요.",
        "Enter — 아래 셀로 이동 / Shift+Enter — 위로",
        "Alt+Enter — 셀 안에서 줄바꿈",
        "Ctrl+D — 바로 위 셀의 값을 그대로 내려받기",
        "방향키 — 셀 이동 / Tab — 다음 셀",
        "Copy — 선택한 행(없으면 전체)을 엑셀로 붙여넣게 복사",
      ].join("\n")}
    >
      Excel keys
    </span>
  );
}

/** 선택 행(없으면 전체)을 엑셀용 TSV 로 복사하는 헤더 버튼. */
export function CopyRowsButton({ grid, sel }: { grid: ItemGridKeys; sel?: RowSelection }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn sm"
      title="선택한 행(없으면 전체)을 엑셀에 붙여넣을 수 있게 복사"
      onClick={async () => {
        await grid.copyRows();
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? "Copied" : `Copy${sel && sel.count > 0 ? ` (${sel.count})` : ""}`}
    </button>
  );
}
