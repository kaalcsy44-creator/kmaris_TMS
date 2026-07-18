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
  /** 기본 컬럼 폭(px). 미지정 시 className 으로 추정. 사용자가 조절하면 그 값이 우선. */
  width?: number;
};

/** 사용자 지정 폭이 없을 때 쓰는 기본 폭(px). 품목표는 table-layout:fixed 라 이 값이 실제 컬럼폭. */
export function defaultColWidth(c: ItemCol): number {
  if (c.width != null) return c.width;
  if (c.key === "__sel") return 34;
  if ((c.className ?? "").includes("seq")) return 44;
  if ((c.className ?? "").includes("num")) return 96;
  return 130;
}

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

/** 품목표 앞에 놓는 <colgroup> — table-layout:fixed 에서 각 컬럼 폭의 기준.
 *  폭 값 자체는 ItemGridStyle 의 col:nth-child 규칙이 준다(여기선 빈 <col> 만 배치). */
export function ItemColGroup({ grid }: { grid: ItemGridApi }) {
  return (
    <colgroup>
      {grid.cols.map((c) => (
        <col key={c.key} />
      ))}
    </colgroup>
  );
}

/**
 * 현재 폭/숨김 상태를 물리 컬럼 위치 기준 CSS 로 방출(스코프 클래스로 이 표에만 적용).
 * 품목표는 table-layout:fixed 라, 컬럼 폭은 <colgroup><col> 의 width 로만 정확히 먹는다
 * (auto 레이아웃에선 셀의 width/max-width 가 무시돼 아무리 줄여도 안 줄어든다 — 실측 확인).
 * fixed 표는 전체 폭이 명시돼야 col 폭이 그대로 반영되므로, 보이는 컬럼 폭의 합을 표 width 로 준다.
 */
export function ItemGridStyle({ grid }: { grid: ItemGridApi }) {
  const { cols, colIndex, layout, tableClass } = grid;
  const css = useMemo(() => {
    const rules: string[] = [];
    let total = 0;
    for (const c of cols) {
      const i = colIndex[c.key];
      if (!c.fixed && layout.hidden.has(c.key)) {
        // 숨김: col 폭 0 + 해당 물리열의 헤더/본문/합계 셀 감춤(그룹헤더 colspan 셀은 제외).
        rules.push(`.${tableClass} colgroup col:nth-child(${i}){width:0}`);
        rules.push(
          `.${tableClass} thead th:not(.ig-group):nth-child(${i}),.${tableClass} tbody td:nth-child(${i}),.${tableClass} tfoot td:nth-child(${i}){display:none!important}`
        );
        continue;
      }
      const w = layout.widths[c.key] ?? defaultColWidth(c);
      total += w;
      rules.push(`.${tableClass} colgroup col:nth-child(${i}){width:${w}px}`);
      // fixed 표에선 셀 내용이 컬럼폭을 넘겨도 넘치지 않게 클립/줄바꿈. 입력칸은 셀에 맞춰 채운다.
      rules.push(
        `.${tableClass} tbody td:nth-child(${i}) input:not([type=checkbox]),.${tableClass} tbody td:nth-child(${i}) textarea{min-width:0!important;width:100%!important;box-sizing:border-box}`
      );
    }
    // 표 전체 폭 = 보이는 컬럼 폭의 합. 이게 있어야 fixed 레이아웃이 col 폭을 그대로 반영한다.
    rules.push(`.${tableClass}{width:${total}px;min-width:0}`);
    return rules.join("\n");
  }, [cols, colIndex, layout.hidden, layout.widths, tableClass]);
  if (!css) return null;
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

/** items-head 액션 영역에 넣는 "Columns" 표시/숨김 메뉴 버튼. */
export function ItemColsButton({ grid }: { grid: ItemGridApi }) {
  return <ColumnsButton cols={grid.hideableCols} layout={grid.layout} />;
}
