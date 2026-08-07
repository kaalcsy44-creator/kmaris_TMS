"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useColumnLayout, CELL_PAD_W, type ColumnLayout } from "./useColumnLayout";
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
  /** 폰에서 "핵심 칸만" 으로 접었을 때 남길 컬럼. 이 표식이 하나도 없으면 접기 자체를 끈다.
   *  (접기는 CSS 미디어쿼리로만 동작해 데스크톱의 저장된 컬럼 설정을 건드리지 않는다.) */
  phone?: boolean;
};

/** 폰에서 품목표를 "핵심 칸만" 으로 접을지 — 표마다가 아니라 앱 전체 하나의 스위치. */
const PHONE_FOLD_KEY = "ktms.itemgrid.phoneFold";
/** 접기가 동작하는 화면 폭 — globals.css 의 품목표 폰 규칙과 같은 경계를 쓴다. */
const PHONE_MAX = 640;

/** colspan 으로 직접 구성한 셀(그룹 헤더·합계행)에 붙이는 표식 — 덮는 컬럼 key 목록.
 *  ItemGridStyle 이 이 표식을 보고 그 셀 폭도 컬럼 폭 합으로 함께 고정한다. */
export function igSpan(keys: string[]) {
  return { "data-ig-span": keys.join(",") };
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
  /** 이 표가 폰 접기를 지원하는지(= phone 표식을 단 컬럼이 있는지). */
  foldable: boolean;
  /** 폰에서 지금 접혀 있는지. 데스크톱 표시에는 영향이 없다. */
  phoneFold: boolean;
  togglePhoneFold: () => void;
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
  const foldable = useMemo(() => cols.some((c) => c.phone), [cols]);
  // 기본값은 "접힘". localStorage 는 첫 렌더 뒤에 읽어 서버/클라 첫 그림을 같게 유지한다.
  const [phoneFold, setPhoneFold] = useState(true);
  useEffect(() => {
    try {
      setPhoneFold(window.localStorage.getItem(PHONE_FOLD_KEY) !== "0");
    } catch {
      /* 저장소를 못 읽으면 기본값 유지 */
    }
  }, []);
  const togglePhoneFold = useCallback(() => {
    setPhoneFold((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(PHONE_FOLD_KEY, next ? "1" : "0");
      } catch {
        /* 저장 실패는 무시 — 이번 화면에서만 적용된다 */
      }
      return next;
    });
  }, []);
  return { layout, hideableCols, cols, colIndex, tableClass, foldable, phoneFold, togglePhoneFold };
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
      <ColumnResizer
        colKey={k}
        onResize={(px) => layout.setWidth(k, px)}
        onResizeEnd={layout.commitWidths}
      />
    </th>
  );
}

/** 현재 폭/숨김 상태를 물리 컬럼 위치 기준 CSS 로 방출(스코프 클래스로 이 표에만 적용).
 *  spans: colspan 으로 직접 구성한 셀들이 덮는 컬럼 key 목록(그룹 헤더행·합계행 세그먼트).
 *  각 셀에 igSpan(keys) 표식을 함께 달아야 한다. */
export function ItemGridStyle({ grid, spans }: { grid: ItemGridApi; spans?: string[][] }) {
  const { cols, colIndex, layout, tableClass, foldable, phoneFold } = grid;
  const spanSig = (spans ?? []).map((keys) => keys.join(",")).join("|");
  const css = useMemo(() => {
    const rules: string[] = [];
    const colSel = (i: number) =>
      `.${tableClass} thead th:not(.ig-group):nth-child(${i}),.${tableClass} tbody td:nth-child(${i}),.${tableClass} tfoot td:not(.ig-foot):nth-child(${i})`;
    for (const c of cols) {
      const i = colIndex[c.key];
      // thead 는 그룹 헤더행(.ig-group)을, tfoot 은 colspan 으로 직접 구성한 합계행(.ig-foot)을
      // 제외한다 — 둘 다 컬럼당 1셀이 아니라 물리 nth-child 가 어긋나므로(자체적으로 숨김 컬럼을
      // 건너뛰어 정렬을 유지한다).
      const sel = colSel(i);
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
    // colspan 셀은 위 nth-child 규칙에서 제외돼 폭이 auto 로 남는다. 그런데 한 컬럼만 덮는
    // auto 셀이 하나라도 있으면 브라우저는 그 컬럼을 "폭 미지정"으로 보고 내용 기준으로 잡아버려,
    // 드래그로 지정한 폭이 통째로 무시된다(실측: 합계행의 빈 1칸짜리 셀 때문에 Cost·Unit Price·
    // Margin 이 안 좁아졌다). 덮는 컬럼 폭을 모두 알면 그 합(= 지정폭 + 셀 패딩)으로 같이 고정한다.
    for (const keys of spans ?? []) {
      if (!keys.length || !keys.every((k) => layout.widths[k])) continue;
      const outer = keys.reduce((s, k) => s + layout.widths[k] + CELL_PAD_W, 0);
      // 그룹 헤더행은 셀 패딩이 달라(0 10px) content-box 로는 어긋나므로 border-box 로 맞춘다.
      rules.push(
        `.${tableClass} [data-ig-span="${keys.join(",")}"]{box-sizing:border-box!important;width:${outer}px!important;min-width:${outer}px!important;max-width:${outer}px!important}`
      );
    }
    // 폰 접기 — 핵심 칸(phone)만 남기고 나머지 컬럼을 미디어쿼리로 감춘다. 저장된 컬럼
    // 설정(hidden/widths)은 그대로 두고 화면 폭으로만 갈리므로, 폰에서 접었다 폈다 해도
    // 데스크톱 배치는 변하지 않는다. 드래그로 지정한 px 폭도 폰에서는 함께 풀어 준다
    // (360px 화면에 280px 컬럼이 남으면 접는 의미가 없다).
    if (foldable && phoneFold) {
      const folded = cols
        .filter((c) => !c.fixed && !c.phone && !layout.hidden.has(c.key))
        .map((c) => colSel(colIndex[c.key]));
      const phoneRules = [
        ...(folded.length ? [`${folded.join(",")}{display:none!important}`] : []),
        // 그룹 헤더행·colspan 합계행은 "보이는 컬럼 수" 를 JS 로 계산해 만든 행이라
        // CSS 로 컬럼을 감추면 칸 수가 어긋난다 → 폰에서는 통째로 내린다(합계는 표
        // 아래 Summary 줄에 그대로 있다).
        `.${tableClass} thead tr.ig-group-row{display:none!important}`,
        `.${tableClass} tfoot tr:has(td.ig-foot){display:none!important}`,
        `.${tableClass} th,.${tableClass} td{width:auto!important;min-width:0!important;max-width:none!important}`,
        `.${tableClass} td input,.${tableClass} td textarea{min-width:0!important}`,
      ];
      rules.push(`@media (max-width:${PHONE_MAX}px){${phoneRules.join("")}}`);
    }
    return rules.join("\n");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cols, colIndex, layout.hidden, layout.widths, tableClass, spanSig, foldable, phoneFold]);
  if (!css) return null;
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

/** items-head 액션 영역에 넣는 "Columns" 표시/숨김 메뉴 버튼.
 *  폰에서는 그 옆에 "핵심 칸만 ↔ 전체 칸" 스위치가 함께 뜬다(데스크톱에서는 숨김). */
export function ItemColsButton({ grid }: { grid: ItemGridApi }) {
  return (
    <>
      <ColumnsButton cols={grid.hideableCols} layout={grid.layout} />
      {grid.foldable ? (
        <button
          type="button"
          className={`ig-fold-btn${grid.phoneFold ? "" : " on"}`}
          onClick={grid.togglePhoneFold}
          title={
            grid.phoneFold
              ? "지금은 핵심 칸만 — 모든 칸을 좌우로 넘겨 보려면 누르세요"
              : "모든 칸 표시 중 — 핵심 칸만 남겨 화면에 맞추려면 누르세요"
          }
        >
          {grid.phoneFold ? "▤ All cols" : "▤ Key cols"}
        </button>
      ) : null}
    </>
  );
}
