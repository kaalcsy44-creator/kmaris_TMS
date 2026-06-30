"use client";

import { useState } from "react";
import type { ColumnLayout, LayoutCol } from "./useColumnLayout";

// useColumnLayout 과 함께 쓰는 공용 UI: 폭 조절 핸들 · 헤더 드래그 재정렬 · 컬럼 표시/숨김 메뉴.

/** 헤더 우측 끝의 폭 조절 핸들. 부모 th 의 현재 폭을 기준으로 드래그한다. */
export function ColumnResizer({ onResize }: { onResize: (px: number) => void }) {
  function onPointerDown(e: React.PointerEvent<HTMLSpanElement>) {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget.closest("th") ?? e.currentTarget.parentElement) as HTMLElement | null;
    if (!th) return;
    const startX = e.clientX;
    const startW = th.offsetWidth;
    function move(ev: PointerEvent) {
      onResize(startW + (ev.clientX - startX));
    }
    function up() {
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
