"use client";

import { useState } from "react";
import { useColumnLayout } from "./useColumnLayout";
import { ColumnResizer, ColumnsButton, dragHandleProps } from "./tableLayout";

// Progress(진행현황) 표의 컬럼 헤더 정렬·필터 UX를 제네릭으로 추출한 공용 테이블.
// ProgressScreen 의 PipelineTable 과 동일한 pl-* CSS 클래스를 그대로 사용해
// 시각·동작이 일치한다. 각 목록 화면은 ColumnDef 배열만 정의하면 된다.
// tableId 를 주면 컬럼 폭 조절·순서 변경·표시/숨김(브라우저에 저장)이 활성화된다.

export type FilterKind = "facet" | "date" | "none";

export type ColumnDef<T> = {
  key: string;
  label: string;
  /** 패싯 값/검색/문자열 정렬에 쓰는 셀 텍스트. */
  text: (row: T) => string;
  /** 셀 렌더(생략 시 text()). */
  render?: (row: T) => React.ReactNode;
  /** 필터 유형(기본 none). date 는 text()가 "YYYY-MM-DD…" 형태여야 한다. */
  filter?: FilterKind;
  /** 숫자 정렬값(있으면 우선). */
  sortValue?: (row: T) => number;
  /** 우측 정렬(숫자열). */
  numeric?: boolean;
  /** 패싯 빈값("") 표시 라벨(기본 "미지정"). */
  emptyLabel?: string;
};

type SortDir = "asc" | "desc";

function colClass(key: string): string {
  return `pl-col-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

// 날짜 표시는 4자리 연도를 2자리로 줄인다. "2026-07-03" → "26-07-03".
// (필터·정렬은 원본 text() 기준으로 동작하고, 표시값만 축약한다.)
function shortYear(s: string): string {
  return s.replace(/\b\d{2}(\d{2}-\d{2}-\d{2})(?![\d-])/g, "$1");
}

export default function FilterTable<T>({
  rows,
  columns,
  getRowKey,
  onRowClick,
  rowClassName,
  empty = "No items to display.",
  actions,
  leftActions,
  defaultSortKey = null,
  defaultSortDir = "asc",
  tableId,
  groupBy,
  groupMergeKeys,
}: {
  rows: T[];
  columns: ColumnDef<T>[];
  getRowKey: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string;
  empty?: string;
  /** 지정 시 같은 그룹 키의 행들을 인접·줄무늬 묶음으로 표시(예: 프로젝트 단위). */
  groupBy?: (row: T) => string | number;
  /** 그룹 연속 행에서 값을 비우는(병합 표시) 컬럼 key 목록(그룹 첫 행에만 표시). */
  groupMergeKeys?: string[];
  /** 툴바 우측 슬롯(예: "+ 신규 등록" 버튼). */
  actions?: React.ReactNode;
  /** 툴바 좌측 슬롯(예: CI/PL 토글). */
  leftActions?: React.ReactNode;
  /** 초기 정렬 컬럼 key(미지정 시 정렬 없음). */
  defaultSortKey?: string | null;
  /** 초기 정렬 방향(기본 오름차순). */
  defaultSortDir?: SortDir;
  /** 지정 시 컬럼 폭·순서·표시여부 커스터마이즈를 활성화(localStorage 저장 키). */
  tableId?: string;
}) {
  const [sortKey, setSortKey] = useState<string | null>(defaultSortKey);
  const [sortDir, setSortDir] = useState<SortDir>(defaultSortDir);
  const [facets, setFacets] = useState<Record<string, string>>({});
  const [dates, setDates] = useState<Record<string, { from: string; to: string }>>({});
  const [openCol, setOpenCol] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const [dragKey, setDragKey] = useState<string | null>(null);

  const colByKey = (k: string) => columns.find((c) => c.key === k)!;

  // 컬럼 레이아웃(폭·순서·표시) — tableId 없으면 코드 정의 그대로 사용.
  const layout = useColumnLayout(tableId ?? "__off__", columns);
  const customize = !!tableId;
  const orderedColumns = customize
    ? layout.visibleKeys
        .map((k) => columns.find((c) => c.key === k))
        .filter((c): c is ColumnDef<T> => !!c)
    : columns;
  const drag = { active: dragKey, set: setDragKey };

  function openMenu(key: string, e: React.MouseEvent<HTMLElement>) {
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
  function applySort(key: string, dir: SortDir) {
    setSortKey(key);
    setSortDir(dir);
    setOpenCol(null);
  }

  // 데이터에 실제 존재하는 패싯 값(한글 정렬). 빈값은 "" 으로 포함.
  function distinct(col: ColumnDef<T>): string[] {
    return Array.from(new Set(rows.map(col.text))).sort((a, b) => a.localeCompare(b, "ko"));
  }
  function facetValue(key: string): string {
    return facets[key] ?? "전체";
  }
  function setFacet(key: string, v: string) {
    setFacets((p) => ({ ...p, [key]: v }));
    setOpenCol(null);
  }
  function dateRange(key: string): { from: string; to: string } {
    return dates[key] ?? { from: "", to: "" };
  }
  function setDate(key: string, patch: Partial<{ from: string; to: string }>) {
    setDates((p) => ({ ...p, [key]: { ...dateRange(key), ...patch } }));
  }

  function isColFiltered(col: ColumnDef<T>): boolean {
    if (col.filter === "facet") return facetValue(col.key) !== "전체";
    if (col.filter === "date") {
      const d = dateRange(col.key);
      return !!(d.from || d.to);
    }
    return false;
  }

  const filtersActive = columns.some(isColFiltered);

  function resetFilters() {
    setFacets({});
    setDates({});
  }

  // 1) 필터: 활성 조건들의 교집합(AND)
  let displayRows = rows.filter((r) =>
    columns.every((col) => {
      if (col.filter === "facet") {
        const sel = facetValue(col.key);
        return sel === "전체" || col.text(r) === sel;
      }
      if (col.filter === "date") {
        const { from, to } = dateRange(col.key);
        if (!from && !to) return true;
        const d = (col.text(r) || "").slice(0, 10);
        if (!d) return false;
        if (from && d < from) return false;
        if (to && d > to) return false;
        return true;
      }
      return true;
    })
  );

  // 2) 정렬: sortValue 가 있으면 숫자, 없으면 text() 한글 로케일
  if (sortKey) {
    const col = colByKey(sortKey);
    const dir = sortDir === "asc" ? 1 : -1;
    displayRows = [...displayRows].sort((a, b) => {
      let cmp: number;
      if (col.sortValue) cmp = col.sortValue(a) - col.sortValue(b);
      else cmp = col.text(a).localeCompare(col.text(b), "ko");
      return cmp * dir;
    });
  }

  // 3) 그룹핑: 같은 그룹 키의 행을 인접하게 모은다(정렬 순서에서 그룹 첫 등장 순 유지).
  //    각 그룹에 교대 배경(줄무늬)과 첫 행 구분선을 부여하고, 반복 컬럼은 첫 행에만 표시.
  const mergeSet = new Set(groupMergeKeys ?? []);
  const rowMeta = new Map<T, { first: boolean; parity: 0 | 1 }>();
  if (groupBy) {
    const order: (string | number)[] = [];
    const buckets = new Map<string | number, T[]>();
    for (const r of displayRows) {
      const k = groupBy(r);
      if (!buckets.has(k)) {
        buckets.set(k, []);
        order.push(k);
      }
      buckets.get(k)!.push(r);
    }
    displayRows = order.flatMap((k) => buckets.get(k)!);
    order.forEach((k, gi) => {
      const members = buckets.get(k)!;
      members.forEach((r, ri) => {
        rowMeta.set(r, { first: ri === 0, parity: (gi % 2) as 0 | 1 });
      });
    });
  }

  function renderColMenu(col: ColumnDef<T>) {
    const opts =
      col.filter === "facet"
        ? [{ v: "전체", label: "All" }, ...distinct(col).map((v) => ({ v, label: v || col.emptyLabel || "Unspecified" }))]
        : [];
    const d = dateRange(col.key);
    return (
      <>
        <div className="pl-menu-backdrop" onClick={() => setOpenCol(null)} />
        <div className="pl-col-menu" style={{ left: menuPos.left, top: menuPos.top }} role="menu">
          <div className="pl-menu-sort">
            <button
              className={sortKey === col.key && sortDir === "asc" ? "on" : ""}
              onClick={() => applySort(col.key, "asc")}
            >
              <span className="ic">▲</span> Ascending
            </button>
            <button
              className={sortKey === col.key && sortDir === "desc" ? "on" : ""}
              onClick={() => applySort(col.key, "desc")}
            >
              <span className="ic">▼</span> Descending
            </button>
          </div>

          {col.filter === "date" ? (
            <>
              <div className="pl-menu-divider" />
              <div className="pl-menu-date">
                <span className="pl-menu-cap">Range</span>
                <input
                  type="date"
                  value={d.from}
                  onChange={(e) => setDate(col.key, { from: e.target.value })}
                  aria-label="From"
                />
                <span className="pl-menu-tilde">~</span>
                <input
                  type="date"
                  value={d.to}
                  onChange={(e) => setDate(col.key, { to: e.target.value })}
                  aria-label="To"
                />
                {d.from || d.to ? (
                  <button className="pl-menu-clear" onClick={() => setDate(col.key, { from: "", to: "" })}>
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
                    className={`pl-menu-opt${facetValue(col.key) === o.v ? " on" : ""}`}
                    onClick={() => setFacet(col.key, o.v)}
                  >
                    <span className="chk">{facetValue(col.key) === o.v ? "✓" : ""}</span>
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
        {leftActions ? <span className="pl-toolbar-left">{leftActions}</span> : null}
        {filtersActive ? (
          <button type="button" className="pl-filter-reset" onClick={resetFilters}>
            Reset filters
          </button>
        ) : null}
        <span className="pl-search-count">
          {displayRows.length} / {rows.length}
        </span>
        {customize ? <ColumnsButton cols={columns} layout={layout} /> : null}
        {actions ? <span className="pl-toolbar-actions">{actions}</span> : null}
      </div>

      <div className="pl-table-wrap">
        <table className={`pipeline${customize ? " customizable" : ""}`}>
          <colgroup>
            {orderedColumns.map((c) => {
              const w = customize ? layout.widths[c.key] : undefined;
              return (
                <col
                  key={c.key}
                  className={colClass(c.key)}
                  style={w ? { width: w, minWidth: w } : undefined}
                />
              );
            })}
          </colgroup>
          <thead>
            <tr>
              {orderedColumns.map((c) => {
                const sorted = sortKey === c.key;
                const filtered = isColFiltered(c);
                const hasMenu = (c.filter && c.filter !== "none") || true;
                return (
                  <th
                    key={c.key}
                    className={`pl-th ${colClass(c.key)}${openCol === c.key ? " open" : ""}${sorted || filtered ? " active" : ""}${dragKey === c.key ? " dragging" : ""}`}
                    aria-sort={sorted ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                  >
                    <button
                      type="button"
                      className="pl-th-btn"
                      onClick={(e) => (hasMenu ? openMenu(c.key, e) : undefined)}
                      {...(customize ? dragHandleProps(c.key, layout, drag) : {})}
                    >
                      <span className="pl-th-label">{c.label}</span>
                      {filtered ? <span className="pl-th-dot" title="Filter applied" /> : null}
                      <span className="pl-th-caret">{sorted ? (sortDir === "asc" ? "▲" : "▼") : "▾"}</span>
                    </button>
                    {customize ? (
                      <ColumnResizer onResize={(px) => layout.setWidth(c.key, px)} onResizeEnd={layout.commitWidths} />
                    ) : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {displayRows.length === 0 ? (
              <tr>
                <td className="pl-empty" colSpan={orderedColumns.length}>
                  {empty}
                </td>
              </tr>
            ) : (
              displayRows.map((r) => {
                const gm = groupBy ? rowMeta.get(r) : undefined;
                const groupCls = gm
                  ? ` grp grp-${gm.parity}${gm.first ? " group-start" : " group-cont"}`
                  : "";
                return (
                  <tr
                    key={getRowKey(r)}
                    className={`${rowClassName ? rowClassName(r) : ""}${groupCls}`.trim() || undefined}
                    onClick={onRowClick ? () => onRowClick(r) : undefined}
                    style={onRowClick ? { cursor: "pointer" } : undefined}
                  >
                    {orderedColumns.map((c) => {
                      // 그룹 연속 행이면서 병합 대상 컬럼은 비워 "묶음" 느낌을 준다.
                      const merged = gm && !gm.first && mergeSet.has(c.key);
                      return (
                        <td key={c.key} className={`${colClass(c.key)}${c.numeric ? " num" : ""}${merged ? " grp-merged" : ""}`}>
                          {merged ? null : c.render ? c.render(r) : (c.filter === "date" ? shortYear(c.text(r)) : c.text(r)) || <span className="muted">—</span>}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {openCol ? renderColMenu(colByKey(openCol)) : null}
    </>
  );
}
