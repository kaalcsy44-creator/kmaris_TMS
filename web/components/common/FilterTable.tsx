"use client";

import { useState } from "react";

// Progress(진행현황) 표의 컬럼 헤더 정렬·필터 UX를 제네릭으로 추출한 공용 테이블.
// ProgressScreen 의 PipelineTable 과 동일한 pl-* CSS 클래스를 그대로 사용해
// 시각·동작이 일치한다. 각 목록 화면은 ColumnDef 배열만 정의하면 된다.

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

export default function FilterTable<T>({
  rows,
  columns,
  getRowKey,
  onRowClick,
  rowClassName,
  empty = "표시할 항목이 없습니다.",
  actions,
}: {
  rows: T[];
  columns: ColumnDef<T>[];
  getRowKey: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string;
  empty?: string;
  /** 툴바 우측 슬롯(예: "+ 신규 등록" 버튼). */
  actions?: React.ReactNode;
}) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [facets, setFacets] = useState<Record<string, string>>({});
  const [dates, setDates] = useState<Record<string, { from: string; to: string }>>({});
  const [openCol, setOpenCol] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  const colByKey = (k: string) => columns.find((c) => c.key === k)!;

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

  function renderColMenu(col: ColumnDef<T>) {
    const opts =
      col.filter === "facet"
        ? [{ v: "전체", label: "전체" }, ...distinct(col).map((v) => ({ v, label: v || col.emptyLabel || "미지정" }))]
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
              <span className="ic">▲</span> 오름차순
            </button>
            <button
              className={sortKey === col.key && sortDir === "desc" ? "on" : ""}
              onClick={() => applySort(col.key, "desc")}
            >
              <span className="ic">▼</span> 내림차순
            </button>
          </div>

          {col.filter === "date" ? (
            <>
              <div className="pl-menu-divider" />
              <div className="pl-menu-date">
                <span className="pl-menu-cap">기간</span>
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
                    기간 해제
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
        {filtersActive ? (
          <button type="button" className="pl-filter-reset" onClick={resetFilters}>
            필터 초기화
          </button>
        ) : null}
        <span className="pl-search-count">
          {displayRows.length} / {rows.length}건
        </span>
        {actions ? <span className="pl-toolbar-actions">{actions}</span> : null}
      </div>

      <div className="pl-table-wrap">
        <table className="pipeline">
          <thead>
            <tr>
              {columns.map((c) => {
                const sorted = sortKey === c.key;
                const filtered = isColFiltered(c);
                const hasMenu = (c.filter && c.filter !== "none") || true;
                return (
                  <th
                    key={c.key}
                    className={`pl-th${openCol === c.key ? " open" : ""}${sorted || filtered ? " active" : ""}`}
                    aria-sort={sorted ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                  >
                    <button
                      type="button"
                      className="pl-th-btn"
                      onClick={(e) => (hasMenu ? openMenu(c.key, e) : undefined)}
                    >
                      <span className="pl-th-label">{c.label}</span>
                      {filtered ? <span className="pl-th-dot" title="필터 적용 중" /> : null}
                      <span className="pl-th-caret">{sorted ? (sortDir === "asc" ? "▲" : "▼") : "▾"}</span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {displayRows.length === 0 ? (
              <tr>
                <td className="pl-empty" colSpan={columns.length}>
                  {empty}
                </td>
              </tr>
            ) : (
              displayRows.map((r) => (
                <tr
                  key={getRowKey(r)}
                  className={rowClassName ? rowClassName(r) : undefined}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                  style={onRowClick ? { cursor: "pointer" } : undefined}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={c.numeric ? "num" : undefined}>
                      {c.render ? c.render(r) : c.text(r) || <span className="muted">—</span>}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {openCol ? renderColMenu(colByKey(openCol)) : null}
    </>
  );
}
