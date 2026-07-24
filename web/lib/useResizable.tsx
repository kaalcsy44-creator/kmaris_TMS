"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

const RESIZE_DIRS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;

// 모달/팝업을 8방향(4변 + 4코너)으로 드래그해 크기 조절하는 공용 훅.
// - ref: 크기를 조절할 패널(.pl-modal 등)에 부착. position:relative 여야 핸들 기준이 잡힌다.
// - style: 조절 시작 후 인라인 position:fixed 로 고정된 박스. 미조절 상태면 undefined(CSS 기본).
// - handles: 패널 안에 렌더할 8개 드래그 핸들(span). 기존 .pl-resize-h CSS 를 재사용한다.
// storageKey 를 주면 마지막 크기를 localStorage 에 기억했다가 다음에 그 크기로 중앙 배치한다.
export function useResizable(opts?: { minW?: number; minH?: number; storageKey?: string }) {
  const minW = opts?.minW ?? 360;
  const minH = opts?.minH ?? 260;
  const key = opts?.storageKey;
  const ref = useRef<HTMLDivElement>(null);

  const [box, setBox] = useState<{ left: number; top: number; w: number; h: number } | null>(() => {
    if (typeof window === "undefined" || !key) return null;
    try {
      const s = JSON.parse(window.localStorage.getItem(key) || "null");
      if (s && s.w && s.h) {
        const w = Math.min(s.w, window.innerWidth - 24);
        const h = Math.min(s.h, window.innerHeight - 24);
        return { w, h, left: Math.max(12, (window.innerWidth - w) / 2), top: Math.max(12, (window.innerHeight - h) / 2) };
      }
    } catch {
      /* ignore malformed */
    }
    return null;
  });

  useEffect(() => {
    if (box && key && typeof window !== "undefined") {
      window.localStorage.setItem(key, JSON.stringify({ w: Math.round(box.w), h: Math.round(box.h) }));
    }
  }, [box?.w, box?.h, key]);

  function startResize(dir: string, e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const el = ref.current;
    if (!el) return;
    const r0 = el.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, left: r0.left, top: r0.top, w: r0.width, h: r0.height };
    const maxW = window.innerWidth - 16;
    const maxH = window.innerHeight - 16;
    const cursor = getComputedStyle(e.currentTarget as Element).cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = cursor;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      let { left, top, w, h } = start;
      if (dir.includes("e")) w = start.w + dx;
      if (dir.includes("s")) h = start.h + dy;
      if (dir.includes("w")) { w = start.w - dx; left = start.left + dx; }
      if (dir.includes("n")) { h = start.h - dy; top = start.top + dy; }
      if (w < minW) { if (dir.includes("w")) left = start.left + (start.w - minW); w = minW; }
      if (h < minH) { if (dir.includes("n")) top = start.top + (start.h - minH); h = minH; }
      w = Math.min(w, maxW);
      h = Math.min(h, maxH);
      // 최소 120px 는 화면 안에 남겨 완전히 사라지지 않게 한다.
      left = Math.min(Math.max(left, 120 - w), window.innerWidth - 120);
      top = Math.min(Math.max(top, 8), window.innerHeight - 60);
      setBox({ left, top, w, h });
    };
    const onUp = () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  // 헤더를 잡고 드래그해 위치를 옮긴다(크기는 유지). 버튼 등 조작 요소 위에선 시작 안 함.
  function startDrag(e: React.PointerEvent) {
    if ((e.target as HTMLElement).closest("button, a, input, select, textarea, [role='group']")) return;
    e.preventDefault();
    const el = ref.current;
    if (!el) return;
    const r0 = el.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, left: r0.left, top: r0.top, w: r0.width, h: r0.height };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      // 완전히 화면 밖으로 나가지 않게 최소 120px 는 남긴다.
      const left = Math.min(Math.max(start.left + dx, 120 - start.w), window.innerWidth - 120);
      const top = Math.min(Math.max(start.top + dy, 8), window.innerHeight - 60);
      setBox({ left, top, w: start.w, h: start.h });
    };
    const onUp = () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  const style: CSSProperties | undefined = box
    ? {
        position: "fixed",
        left: box.left,
        top: box.top,
        width: box.w,
        height: box.h,
        maxWidth: "none",
        maxHeight: "none",
        margin: 0,
      }
    : undefined;

  const handles: ReactNode = RESIZE_DIRS.map((d) => (
    <span key={d} className={`pl-resize-h ${d}`} onPointerDown={(e) => startResize(d, e)} aria-hidden />
  ));

  // 드래그 핸들(모달 헤더)에 스프레드해 붙인다.
  const dragHandleProps = { onPointerDown: startDrag };

  return { ref, style, handles, dragHandleProps };
}
