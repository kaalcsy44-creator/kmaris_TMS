"use client";

import { useRef, useState } from "react";

/**
 * 이미 그려 놓은 표의 머리 칸에 정렬·필터만 얹는 장치.
 *
 * FilterTable 은 표 전체를 대신 그려 준다. 지급대장처럼 한 칸이 여러 줄인 표
 * (총액 아래 부가세·환산, 상태 배지 옆 납부일)나 tfoot 에 합계를 세우는 표는
 * 그 틀에 들어가지 않으므로, 표는 그대로 두고 머리 칸만 바꿔 끼운다. 메뉴 모양은
 * 진행현황 표와 같은 것(.pl-col-menu)을 쓴다 — 두 표에서 같은 동작을 다르게
 * 보이게 할 이유가 없다.
 */

export type HeadFilter = "facet" | "date";

export type HeadCol<T> = {
  key: string;
  /** 패싯 값·문자열 정렬에 쓰는 셀 텍스트. */
  text: (row: T) => string;
  /** 숫자 정렬값(있으면 text() 대신 이것으로 정렬). */
  sortValue?: (row: T) => number;
  /** 필터 유형(생략 시 정렬만). date 는 text() 가 "YYYY-MM-DD…" 형태여야 한다. */
  filter?: HeadFilter;
  /** 한 행이 값을 여러 개 갖는 열의 패싯 값들(예: 여러 딜에 걸친 품목의 프로젝트 번호).
   *  주면 후보 목록과 통과 판정을 이 값들로 한다 — 칸에 보이는 건 대표값 하나라도,
   *  고른 값이 그중 하나에 걸리면 그 행은 남는다. 생략하면 text() 한 값만 본다. */
  facetValues?: (row: T) => string[];
  /** 패싯 빈값("") 표시 라벨(기본 "Unspecified"). */
  emptyLabel?: string;
};

type SortDir = "asc" | "desc";

/** 머리 칸(HeadTh)이 쓰는 부분 — 행 타입과 무관하다. */
export type HeadMenuUi = {
  sortKey: string | null;
  sortDir: SortDir;
  openKey: string | null;
  isFiltered: (key: string) => boolean;
  toggleMenu: (key: string, e: React.MouseEvent<HTMLElement>) => void;
};

export type HeadMenu<T> = HeadMenuUi & {
  /** 필터 적용 후 정렬한 행 — 화면에 그릴 목록. */
  apply: (rows: T[]) => T[];
  filtersActive: boolean;
  resetFilters: () => void;
  /** 표 바깥(형제)에 그린다 — 열린 메뉴가 없으면 아무것도 그리지 않는다. */
  renderMenu: () => React.ReactNode;
};

/**
 * @param cols  열 정의(정렬·필터 규칙)
 * @param resetOn 값이 바뀌면 걸어 둔 필터를 지운다(예: 목록 갈래). 앞 갈래에서 고른
 *   값이 새 목록에 없으면 표가 통째로 빈 것처럼 보이기 때문. 정렬은 열이 그대로라 남긴다.
 */
export function useHeadMenu<T>(cols: HeadCol<T>[], resetOn?: string): HeadMenu<T> {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  // 패싯 필터는 값 여러 개를 고를 수 있다(고른 값 중 하나라도 맞으면 통과 = OR).
  // 빈 배열/미등록 = 미적용(전체) — 따로 '전체' 예약값을 둘 필요가 없다.
  const [facets, setFacets] = useState<Record<string, string[]>>({});
  const [dates, setDates] = useState<Record<string, { from: string; to: string }>>({});
  const [openKey, setOpenKey] = useState<string | null>(null);
  // 값 목록이 길 때 쓰는 메뉴 안 검색어. 메뉴를 새로 열면 비운다.
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  // 패싯 후보는 '지금 이 표에 들어온 행'에서 뽑는다 — apply() 가 받아 둔 것.
  const rowsRef = useRef<T[]>([]);
  const [token, setToken] = useState(resetOn);
  if (token !== resetOn) {
    setToken(resetOn);
    setFacets({});
    setDates({});
    setOpenKey(null);
  }

  const colOf = (key: string) => cols.find((c) => c.key === key);
  const facetValue = (key: string) => facets[key] ?? [];
  const dateRange = (key: string) => dates[key] ?? { from: "", to: "" };

  function setFacet(key: string, next: string[]) {
    setFacets((p) => ({ ...p, [key]: next }));
    // 메뉴는 열어 둔다 — 복수 선택은 하나씩 찍어 쌓는 동작이라, 고를 때마다 닫히면
    // 같은 메뉴를 값 수만큼 다시 열어야 한다. 닫기는 바깥 클릭/머리 칸 재클릭.
  }
  /** 값 하나를 켜고 끈다(다중 선택). */
  function toggleFacet(key: string, v: string) {
    const cur = facetValue(key);
    setFacet(key, cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]);
  }
  function setDate(key: string, patch: Partial<{ from: string; to: string }>) {
    setDates((p) => ({ ...p, [key]: { ...dateRange(key), ...patch } }));
  }

  function isFiltered(key: string): boolean {
    const col = colOf(key);
    if (!col) return false;
    if (col.filter === "facet") return facetValue(key).length > 0;
    if (col.filter === "date") {
      const d = dateRange(key);
      return !!(d.from || d.to);
    }
    return false;
  }

  /** 이 행이 이 열에서 갖는 패싯 값들 — 다중값 열은 그 목록, 아니면 text() 하나. */
  function facetsOf(col: HeadCol<T>, row: T): string[] {
    const vs = col.facetValues?.(row);
    return vs && vs.length ? vs : [col.text(row)];
  }

  function passes(col: HeadCol<T>, row: T): boolean {
    if (col.filter === "facet") {
      const sel = facetValue(col.key);
      return sel.length === 0 || facetsOf(col, row).some((v) => sel.includes(v));
    }
    if (col.filter === "date") {
      const { from, to } = dateRange(col.key);
      if (!from && !to) return true;
      const d = (col.text(row) || "").slice(0, 10);
      if (!d) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    }
    return true;
  }

  function apply(rows: T[]): T[] {
    rowsRef.current = rows;
    const out = rows.filter((r) => cols.every((c) => passes(c, r)));
    const col = sortKey ? colOf(sortKey) : undefined;
    if (!col) return out;
    const dir = sortDir === "asc" ? 1 : -1;
    const value = col.sortValue;
    return [...out].sort(
      (a, b) => (value ? value(a) - value(b) : col.text(a).localeCompare(col.text(b), "ko")) * dir
    );
  }

  function toggleMenu(key: string, e: React.MouseEvent<HTMLElement>) {
    setQuery("");
    if (openKey === key) {
      setOpenKey(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const width = 240;
    setPos({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      top: rect.bottom + 4,
    });
    setOpenKey(key);
  }

  function applySort(key: string, dir: SortDir) {
    setSortKey(key);
    setSortDir(dir);
    setOpenKey(null);
  }

  function renderMenu(): React.ReactNode {
    const col = openKey ? colOf(openKey) : undefined;
    if (!col) return null;
    // "All"(선택 해제) 줄은 값이 아니라 명령이라 목록 밖에서 따로 그린다.
    const opts =
      col.filter === "facet"
        ? Array.from(new Set(rowsRef.current.flatMap((r) => facetsOf(col, r))))
            .sort((a, b) => a.localeCompare(b, "ko"))
            .map((v) => ({ v, label: v || col.emptyLabel || "Unspecified" }))
        : [];
    const sel = facetValue(col.key);
    const d = dateRange(col.key);
    // 검색칸은 목록이 길 때만 — 값이 몇 개뿐인 열에서는 읽을 것만 한 줄 늘린다.
    const searchable = opts.length > 8;
    const q = query.trim().toLowerCase();
    const shownOpts = q ? opts.filter((o) => o.label.toLowerCase().includes(q)) : opts;
    return (
      <>
        <div className="pl-menu-backdrop" onClick={() => setOpenKey(null)} />
        <div className="pl-col-menu" style={{ left: pos.left, top: pos.top }} role="menu">
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
              {/* 고른 개수 — 목록이 스크롤로 밀려도 몇 개가 걸렸는지 머리에 남는다. */}
              {sel.length ? (
                <span className="pl-menu-cap">
                  Filter
                  <span className="pl-menu-cnt">{sel.length} selected</span>
                </span>
              ) : null}
              {searchable ? (
                <input
                  className="pl-menu-search"
                  type="search"
                  value={query}
                  autoFocus
                  placeholder={`Search ${opts.length} values`}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Search values"
                />
              ) : null}
              <div className="pl-menu-list">
                <button
                  className={`pl-menu-opt${sel.length === 0 ? " on" : ""}`}
                  onClick={() => setFacet(col.key, [])}
                >
                  <span className="chk">{sel.length === 0 ? "✓" : ""}</span>
                  <span className="lbl">All</span>
                </button>
                {shownOpts.length === 0 ? (
                  <div className="pl-menu-none">No match</div>
                ) : null}
                {shownOpts.map((o) => (
                  <button
                    key={o.v}
                    className={`pl-menu-opt${sel.includes(o.v) ? " on" : ""}`}
                    onClick={() => toggleFacet(col.key, o.v)}
                    role="menuitemcheckbox"
                    aria-checked={sel.includes(o.v)}
                  >
                    <span className="chk">{sel.includes(o.v) ? "✓" : ""}</span>
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

  return {
    sortKey,
    sortDir,
    openKey,
    isFiltered,
    toggleMenu,
    apply,
    filtersActive: cols.some((c) => isFiltered(c.key)),
    resetFilters: () => {
      setFacets({});
      setDates({});
    },
    renderMenu,
  };
}

/** 정렬·필터 메뉴를 여는 머리 칸. 기존 th 를 이것으로 갈아 끼우면 된다. */
export function HeadTh({
  menu,
  col,
  className,
  numeric,
  children,
}: {
  menu: HeadMenuUi;
  col: string;
  className?: string;
  /** 숫자 열 — 이름표를 오른쪽에 붙인다(칸 내용과 같은 쪽). */
  numeric?: boolean;
  children: React.ReactNode;
}) {
  const sorted = menu.sortKey === col;
  const filtered = menu.isFiltered(col);
  return (
    <th
      className={`pl-th${className ? ` ${className}` : ""}${menu.openKey === col ? " open" : ""}${sorted || filtered ? " active" : ""}`}
      aria-sort={sorted ? (menu.sortDir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        className={`pl-th-btn${numeric ? " num" : ""}`}
        onClick={(e) => menu.toggleMenu(col, e)}
      >
        <span className="pl-th-label">{children}</span>
        {filtered ? <span className="pl-th-dot" title="Filter applied" /> : null}
        <span className="pl-th-caret">{sorted ? (menu.sortDir === "asc" ? "▲" : "▼") : "▾"}</span>
      </button>
    </th>
  );
}
