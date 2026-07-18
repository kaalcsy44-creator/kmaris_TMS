"use client";

import { useMemo } from "react";
import { useColumnLayout, type ColumnLayout } from "./useColumnLayout";
import { ColumnResizer, ColumnsButton } from "./tableLayout";

// 편집 가능한 품목표(Item list)에 컬럼 폭 조절 + 컬럼 숨김을 붙이는 공용 도구.
// FilterTable(목록표)과 달리 품목표는 셀이 입력 위젯이라 본문 JSX를 그대로 두고,
// 물리적 컬럼 위치(nth-child) 기반의 스코프 <style> 로 폭/숨김을 적용한다.
//   - 폭:  사용자가 드래그로 지정한 폭을 !important 로 덮어써 기존 nth-child 폭 규칙을 이긴다.
//   - 숨김: 해당 컬럼의 thead/tbody/tfoot 셀을 display:none 처리(합계 tfoot 은 컬럼당 1셀이어야 정렬 유지).
// 순서 변경은 지원하지 않는다(입력 드래그와 충돌 방지) — 코드 정의 순서 고정.

export type ItemCol = {
  key: string;
  /** 헤더/컬럼 메뉴에 쓰는 라벨. fixed 컬럼(선택·No.)은 생략 가능. */
  label?: string;
  /** th 에 부여할 추가 클래스(예: "num", "seq"). */
  className?: string;
  /** 선택 체크박스·No. 처럼 숨기거나 폭 조절하지 않는 구조 컬럼. */
  fixed?: boolean;
};

export type ItemGridApi = {
  layout: ColumnLayout;
  /** 숨김 메뉴에 노출할(=fixed 아님) 컬럼. */
  hideableCols: { key: string; label: string }[];
  /** 전체 컬럼(코드 순서, fixed 포함) — nth-child 위치 계산용. */
  cols: ItemCol[];
  /** key → 1-based 물리 컬럼 위치. */
  colIndex: Record<string, number>;
  /** <table> 에 부여할 스코프 클래스. */
  tableClass: string;
};

/** 품목표 컬럼 커스터마이즈(폭·숨김) 상태. tableId 별로 localStorage 에 저장된다. */
export function useItemGrid(tableId: string, cols: ItemCol[]): ItemGridApi {
  const hideableCols = useMemo(
    () => cols.filter((c) => !c.fixed).map((c) => ({ key: c.key, label: c.label ?? c.key })),
    [cols]
  );
  const layout = useColumnLayout(tableId, hideableCols);
  const colIndex = useMemo(() => {
    const m: Record<string, number> = {};
    cols.forEach((c, i) => (m[c.key] = i + 1));
    return m;
  }, [cols]);
  const tableClass = `ig-${tableId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return { layout, hideableCols, cols, colIndex, tableClass };
}

/** 폭 조절 핸들 + 숨김(✕) 버튼을 가진 헤더 셀. fixed 컬럼은 이 대신 일반 <th> 를 쓴다. */
export function ItemTh({
  grid,
  k,
  className,
  children,
}: {
  grid: ItemGridApi;
  k: string;
  className?: string;
  children: React.ReactNode;
}) {
  const { layout } = grid;
  const lastShown = layout.visibleKeys.length <= 1 && !layout.hidden.has(k);
  return (
    <th className={`ig-th${className ? ` ${className}` : ""}`}>
      <span className="ig-th-label">{children}</span>
      {!lastShown ? (
        <button
          type="button"
          className="ig-hide"
          title="Hide column"
          onClick={() => layout.toggleHidden(k)}
        >
          ✕
        </button>
      ) : null}
      <ColumnResizer onResize={(px) => layout.setWidth(k, px)} onResizeEnd={layout.commitWidths} />
    </th>
  );
}

/** 현재 폭/숨김 상태를 물리 컬럼 위치 기준 CSS 로 방출(스코프 클래스로 이 표에만 적용). */
export function ItemGridStyle({ grid }: { grid: ItemGridApi }) {
  const { cols, colIndex, layout, tableClass } = grid;
  const css = useMemo(() => {
    const rules: string[] = [];
    for (const c of cols) {
      const i = colIndex[c.key];
      // thead 는 그룹 헤더행(.ig-group)을 제외하고 컬럼 헤더행에만 적용(colspan 그룹셀 오정렬 방지).
      const sel = `.${tableClass} thead th:not(.ig-group):nth-child(${i}),.${tableClass} tbody td:nth-child(${i}),.${tableClass} tfoot td:nth-child(${i})`;
      if (!c.fixed && layout.hidden.has(c.key)) {
        rules.push(`${sel}{display:none!important}`);
        continue;
      }
      const w = layout.widths[c.key];
      if (w) {
        rules.push(`${sel}{width:${w}px!important;min-width:${w}px!important;max-width:${w}px!important}`);
        // 컬럼 폭을 사용자가 지정하면 안의 입력 박스도 함께 줄도록 기본 min-width 해제.
        rules.push(
          `.${tableClass} tbody td:nth-child(${i}) input,.${tableClass} tbody td:nth-child(${i}) textarea{min-width:0!important}`
        );
      }
    }
    return rules.join("\n");
  }, [cols, colIndex, layout.hidden, layout.widths, tableClass]);
  if (!css) return null;
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

/** items-head 액션 영역에 넣는 "Columns" 표시/숨김 메뉴 버튼. */
export function ItemColsButton({ grid }: { grid: ItemGridApi }) {
  return <ColumnsButton cols={grid.hideableCols} layout={grid.layout} />;
}
