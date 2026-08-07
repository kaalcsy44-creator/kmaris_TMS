"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** 터치 화면 전용 스크롤바 — 손가락으로 잡아 끌 수 있는 굵은 엄지.
 *
 *  모바일 브라우저의 기본 스크롤바는 "지금 어디쯤인지" 알려주는 표시일 뿐이라
 *  손가락으로는 잡히지 않는다(내용을 직접 밀어야만 움직인다). 품목표처럼 가로로 긴
 *  표에서는 입력칸을 피해 밀 여백이 거의 없어 그 방법이 잘 통하지 않는다.
 *
 *  그래서 마우스가 없는 기기(pointer: coarse)에서만, 방금 만진 스크롤 영역 위에
 *  잡을 수 있는 엄지를 띄운다. 화면 전체에 하나만 떠 있고(마지막으로 만진 영역),
 *  손을 떼고 잠시 지나면 사라진다. body 바로 아래에 고정 배치되므로 어떤 팝업·
 *  표 안이든 같은 방식으로 동작한다. */

type Bar = {
  axis: "x" | "y";
  // 엄지의 화면 좌표·크기
  x: number;
  y: number;
  w: number;
  h: number;
  // 엄지가 움직일 수 있는 거리와 그때 스크롤되는 거리 — 둘의 비가 드래그 배율.
  track: number;
  max: number;
};

const THICK = 14; // 엄지 두께(px)
const MIN_THUMB = 44; // 손가락으로 잡을 최소 길이
const HIDE_MS = 2200; // 마지막 움직임 뒤 사라지기까지

function scrollableAt(node: EventTarget | null): HTMLElement | null {
  let el = node instanceof Element ? (node as HTMLElement) : null;
  for (; el && el !== document.body; el = el.parentElement) {
    if (el.dataset.tsb === "off") return null;
    const s = getComputedStyle(el);
    const scrollsX =
      (s.overflowX === "auto" || s.overflowX === "scroll") && el.scrollWidth - el.clientWidth > 2;
    const scrollsY =
      (s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight - el.clientHeight > 2;
    if (scrollsX || scrollsY) return el;
  }
  return null;
}

function measure(el: HTMLElement): Bar[] {
  const r = el.getBoundingClientRect();
  if (r.width < 40 || r.height < 40) return [];
  const bars: Bar[] = [];
  const maxX = el.scrollWidth - el.clientWidth;
  if (maxX > 2) {
    const len = el.clientWidth;
    const thumb = Math.max(MIN_THUMB, Math.min(len, (len * el.clientWidth) / el.scrollWidth));
    const track = len - thumb;
    bars.push({
      axis: "x",
      x: r.left + el.clientLeft + track * (el.scrollLeft / maxX),
      y: r.top + el.clientTop + el.clientHeight - THICK - 2,
      w: thumb,
      h: THICK,
      track,
      max: maxX,
    });
  }
  const maxY = el.scrollHeight - el.clientHeight;
  if (maxY > 2) {
    const len = el.clientHeight;
    const thumb = Math.max(MIN_THUMB, Math.min(len, (len * el.clientHeight) / el.scrollHeight));
    const track = len - thumb;
    bars.push({
      axis: "y",
      x: r.left + el.clientLeft + el.clientWidth - THICK - 2,
      y: r.top + el.clientTop + track * (el.scrollTop / maxY),
      w: THICK,
      h: thumb,
      track,
      max: maxY,
    });
  }
  return bars;
}

export default function TouchScrollbars() {
  const [bars, setBars] = useState<Bar[]>([]);
  const [dragAxis, setDragAxis] = useState<"x" | "y" | null>(null);
  const elRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ axis: "x" | "y"; from: number; scroll: number; ratio: number } | null>(null);
  const hideRef = useRef<number | null>(null);

  const hideLater = useCallback(() => {
    if (hideRef.current) window.clearTimeout(hideRef.current);
    hideRef.current = window.setTimeout(() => {
      if (dragRef.current) return; // 끄는 중이면 유지
      elRef.current = null;
      setBars([]);
    }, HIDE_MS);
  }, []);

  const show = useCallback(
    (el: HTMLElement | null) => {
      if (!el) return;
      elRef.current = el;
      setBars(measure(el));
      hideLater();
    },
    [hideLater],
  );

  useEffect(() => {
    // 마우스가 있는 기기의 기본 스크롤바는 이미 잡아 끌 수 있다 — 손가락 전용.
    if (!window.matchMedia?.("(pointer: coarse)").matches) return;

    const onTouch = (e: Event) => show(scrollableAt(e.target));
    const onScroll = (e: Event) => {
      if (dragRef.current && elRef.current) {
        // 내가 끄는 중 — 위치만 갱신(대상 교체 금지).
        setBars(measure(elRef.current));
        return;
      }
      const el = e.target instanceof Element ? (e.target as HTMLElement) : null;
      if (el) show(el);
    };
    const onGone = () => {
      elRef.current = null;
      setBars([]);
    };

    document.addEventListener("touchstart", onTouch, { capture: true, passive: true });
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onGone);
    window.addEventListener("orientationchange", onGone);
    return () => {
      document.removeEventListener("touchstart", onTouch, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onGone);
      window.removeEventListener("orientationchange", onGone);
      if (hideRef.current) window.clearTimeout(hideRef.current);
    };
  }, [show]);

  function onDown(e: React.PointerEvent<HTMLDivElement>, bar: Bar) {
    const el = elRef.current;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      axis: bar.axis,
      from: bar.axis === "x" ? e.clientX : e.clientY,
      scroll: bar.axis === "x" ? el.scrollLeft : el.scrollTop,
      ratio: bar.track > 0 ? bar.max / bar.track : 0,
    };
    setDragAxis(bar.axis);
  }

  function onMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    const el = elRef.current;
    if (!d || !el) return;
    e.preventDefault();
    const moved = ((d.axis === "x" ? e.clientX : e.clientY) - d.from) * d.ratio;
    if (d.axis === "x") el.scrollLeft = d.scroll + moved;
    else el.scrollTop = d.scroll + moved;
    // scroll 이벤트가 안 오는 경우(끝에 닿음)도 있으니 직접 갱신해 둔다.
    setBars(measure(el));
  }

  function onUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragAxis(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    hideLater();
  }

  if (bars.length === 0) return null;
  return (
    <div className="tsb-layer" data-tsb="off" aria-hidden="true">
      {bars.map((b) => (
        <div
          key={b.axis}
          className={`tsb-thumb ${b.axis}${dragAxis === b.axis ? " on" : ""}`}
          style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
          onPointerDown={(e) => onDown(e, b)}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
      ))}
    </div>
  );
}
