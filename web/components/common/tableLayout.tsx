"use client";

import { useState } from "react";
import { COL_MIN_W, COL_MAX_W, type ColumnLayout, type LayoutCol } from "./useColumnLayout";

// useColumnLayout 과 함께 쓰는 공용 UI: 폭 조절 핸들 · 헤더 드래그 재정렬 · 컬럼 표시/숨김 메뉴.

/** 헤더 우측 끝의 폭 조절 핸들. 부모 th 의 현재 폭을 기준으로 드래그한다. */
export function ColumnResizer({
  onResize,
  onResizeEnd,
}: {
  onResize: (px: number) => void;
  /** 드래그 종료 시 1회 호출(예: localStorage 저장). */
  onResizeEnd?: () => void;
}) {
  function onPointerDown(e: React.PointerEvent<HTMLSpanElement>) {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget.closest("th") ?? e.currentTarget.parentElement) as HTMLElement | null;
    if (!th) return;
    const table = th.closest("table") as HTMLTableElement | null;
    const startX = e.clientX;
    const startW = th.offsetWidth;
    // 편집형 품목표(table-layout:fixed + 명시적 전체폭)는 컬럼을 줄이면 표 전체폭도 그만큼
    // 줄어야 한다. 미리보기에서도 전체폭을 함께 갱신(파이프라인 표는 컨테이너 채움이라 제외).
    const sizedTable = !!table && table.classList.contains("lead-tools");
    const startTableW = table ? table.offsetWidth : 0;
    // 0-based 물리 컬럼 위치(th 가 아닌 경우 대비 -1 가드).
    const colIndex = (th as HTMLTableCellElement).cellIndex ?? -1;
    const n = colIndex + 1; // nth-child(1-based)

    // 드래그 중엔 React 상태를 건드리지 않고, 주입한 <style> 로만 폭을 미리보기한다.
    // → 프레임마다 React 리렌더가 없어 부드럽고, 백그라운드 새로고침으로 표가 리렌더돼도
    //   미리보기가 되돌아가지 않는다(React 가 소유한 노드를 건드리지 않으므로).
    // 한 규칙으로 두 종류의 표를 모두 커버:
    //  · <colgroup><col> 표(FilterTable·PipelineTable) → col:nth-child 로 컬럼 폭 지정
    //  · nth-child <style> 표(itemGrid)               → th/td:nth-child 로 셀 폭 지정
    let liveStyle: HTMLStyleElement | null = null;
    if (table && colIndex >= 0) {
      table.setAttribute("data-col-resizing", "");
      liveStyle = document.createElement("style");
      document.head.appendChild(liveStyle);
    }

    const clamp = (w: number) => Math.max(COL_MIN_W, Math.min(COL_MAX_W, Math.round(w)));
    function preview(w: number) {
      if (!liveStyle) return;
      const wpx = `${w}px`;
      // 품목표는 표 전체폭도 (시작폭 − 시작컬럼폭 + 새컬럼폭)으로 맞춰, 줄인 만큼 표가 좁아지게.
      const tableRule = sizedTable
        ? `table[data-col-resizing]{width:${Math.max(0, startTableW - startW + w)}px!important}`
        : "";
      liveStyle.textContent =
        tableRule +
        `table[data-col-resizing]>colgroup>col:nth-child(${n})` +
        `{width:${wpx}!important;min-width:${wpx}!important}` +
        `table[data-col-resizing] thead th:not(.ig-group):nth-child(${n}),` +
        `table[data-col-resizing] tbody td:nth-child(${n}),` +
        `table[data-col-resizing] tfoot td:nth-child(${n})` +
        `{width:${wpx}!important;min-width:${wpx}!important;max-width:${wpx}!important}` +
        `table[data-col-resizing] tbody td:nth-child(${n}) input:not([type=checkbox]),` +
        `table[data-col-resizing] tbody td:nth-child(${n}) textarea{min-width:0!important;width:100%!important;box-sizing:border-box}`;
    }

    // pointermove 는 초당 수십~수백 번 발생하므로 rAF 로 프레임당 1회만 DOM 을 갱신한다.
    let raf = 0;
    let pendingW = startW;
    function flush() {
      raf = 0;
      preview(clamp(pendingW));
    }
    function move(ev: PointerEvent) {
      pendingW = startW + (ev.clientX - startX);
      if (!raf) raf = requestAnimationFrame(flush);
    }
    function up() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      const finalW = clamp(pendingW);
      onResize(finalW); // React 상태에 한 번만 커밋(정식 폭 규칙 반영)
      onResizeEnd?.(); // localStorage 저장도 여기서 한 번만
      // 정식 규칙이 그려진 다음 프레임에 미리보기 <style> 제거 — 같은 값이라 깜빡임 없음.
      requestAnimationFrame(() => {
        if (liveStyle) liveStyle.remove();
        if (table) table.removeAttribute("data-col-resizing");
      });
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("col-resizing");
    }
    document.body.classList.add("col-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  return (
    <span
      className="pl-col-resizer"
      onPointerDown={onPointerDown}
      onClick={(e) => e.stopPropagation()}
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize"
    />
  );
}

/** 헤더 라벨에 부여하는 드래그 재정렬용 props(HTML5 DnD). */
export function dragHandleProps(
  key: string,
  layout: ColumnLayout,
  drag: { active: string | null; set: (k: string | null) => void }
) {
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      drag.set(key);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", key);
    },
    onDragEnd: () => drag.set(null),
    onDragOver: (e: React.DragEvent) => {
      if (drag.active && drag.active !== key) e.preventDefault();
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const from = drag.active || e.dataTransfer.getData("text/plain");
      if (from) layout.moveKey(from, key);
      drag.set(null);
    },
  };
}

/** 툴바의 "Columns" 버튼 + 표시/숨김 체크리스트 메뉴. */
export function ColumnsButton({
  cols,
  layout,
}: {
  cols: LayoutCol[];
  layout: ColumnLayout;
}) {
  const [open, setOpen] = useState(false);
  // order 순서대로(없으면 코드 순서) 나열
  const ordered = layout.order.length
    ? layout.order
        .map((k) => cols.find((c) => c.key === k))
        .filter((c): c is LayoutCol => !!c)
    : cols;
  return (
    <span className="pl-cols-btn-wrap">
      <button type="button" className="pl-cols-btn" onClick={() => setOpen((v) => !v)}>
        ⛃ Columns
      </button>
      {open ? (
        <>
          <div className="pl-menu-backdrop" onClick={() => setOpen(false)} />
          <div className="pl-cols-menu" role="menu">
            <div className="pl-cols-menu-head">
              <span>Show columns</span>
              {layout.customized ? (
                <button className="pl-menu-clear" onClick={layout.reset}>
                  Reset
                </button>
              ) : null}
            </div>
            <div className="pl-cols-menu-list">
              {ordered.map((c) => {
                const shown = !layout.hidden.has(c.key);
                const lastShown = layout.visibleKeys.length <= 1 && shown;
                return (
                  <label key={c.key} className="pl-cols-menu-item">
                    <input
                      type="checkbox"
                      checked={shown}
                      disabled={lastShown}
                      onChange={() => layout.toggleHidden(c.key)}
                    />
                    <span>{c.label || c.key}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </>
      ) : null}
    </span>
  );
}
