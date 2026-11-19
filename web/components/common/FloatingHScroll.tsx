"use client";

// 따라다니는 가로 스크롤바 — 단계 창(세로 스크롤) 안의 넓은 표는 제 바닥에 가로 스크롤바를
// 단다. 품목이 마흔 줄이면 그 바닥이 화면 아래 한참 밑이라, 오른쪽 칸을 보려면 끝까지 내렸다가
// 옆으로 밀고 다시 올라와야 했다. 표가 화면에 걸쳐 있고 제 스크롤바가 화면 밖에 있을 때만,
// 창 바닥(고정된 저장 줄이 있으면 그 바로 위)에 같은 폭의 대역 스크롤바를 띄워 둘을 맞물린다.
//
// 대상: 단계 창 안의 .table-wrap(품목표 등)·.lb-scroll(견적 비교표)·[data-hscroll].
// 팝업이 끌려 움직일 수 있어(transform·fixed) 몸통(body)에 포털로 띄우고 좌표는 매번 잰다.

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

const TARGETS = ".table-wrap, .lb-scroll, [data-hscroll]";
const BAR_H = 14;

export default function FloatingHScroll({ paneRef }: { paneRef: RefObject<HTMLElement | null> }) {
  const barRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const syncing = useRef(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;
    const pane = paneRef.current;
    const bar = barRef.current;
    const inner = innerRef.current;
    if (!pane || !bar || !inner) return;

    const onTargetScroll = () => {
      if (syncing.current) { syncing.current = false; return; }
      const t = targetRef.current;
      if (t && Math.abs(bar.scrollLeft - t.scrollLeft) > 0.5) { syncing.current = true; bar.scrollLeft = t.scrollLeft; }
    };
    const onBarScroll = () => {
      if (syncing.current) { syncing.current = false; return; }
      const t = targetRef.current;
      if (t && Math.abs(t.scrollLeft - bar.scrollLeft) > 0.5) { syncing.current = true; t.scrollLeft = bar.scrollLeft; }
    };
    bar.addEventListener("scroll", onBarScroll, { passive: true });

    const setTarget = (t: HTMLElement | null) => {
      if (targetRef.current === t) return;
      targetRef.current?.removeEventListener("scroll", onTargetScroll);
      targetRef.current = t;
      t?.addEventListener("scroll", onTargetScroll, { passive: true });
    };

    let raf = 0;
    const measure = () => {
      raf = 0;
      const pr = pane.getBoundingClientRect();
      // 창 바닥에 붙어 있는 저장 줄(sticky .form-actions)이 있으면 그 위가 바닥이다.
      let limit = pr.bottom;
      for (const fa of Array.from(pane.querySelectorAll<HTMLElement>(".form-actions"))) {
        if (getComputedStyle(fa).position !== "sticky") continue;
        const r = fa.getBoundingClientRect();
        if (r.height && r.bottom >= pr.bottom - 2 && r.top < limit) limit = r.top;
      }
      let pick: HTMLElement | null = null;
      for (const el of Array.from(pane.querySelectorAll<HTMLElement>(TARGETS))) {
        if (el.scrollWidth <= el.clientWidth + 1 || el.offsetParent === null) continue;
        const r = el.getBoundingClientRect();
        // 표가 화면에 충분히 걸쳐 있고(머리 60px 이상), 제 스크롤바는 바닥 아래에 숨어 있을 때.
        if (r.top < limit - 60 && r.bottom > limit + 2 && r.bottom > pr.top) { pick = el; break; }
      }
      setTarget(pick);
      if (!pick) { bar.style.display = "none"; return; }
      const r = pick.getBoundingClientRect();
      const left = Math.max(r.left + pick.clientLeft, pr.left);
      const right = Math.min(r.left + pick.clientLeft + pick.clientWidth, pr.right);
      bar.style.display = "block";
      bar.style.left = `${left}px`;
      bar.style.width = `${Math.max(0, right - left)}px`;
      bar.style.top = `${limit - BAR_H - 2}px`;
      inner.style.width = `${pick.scrollWidth - (pick.clientWidth - (right - left))}px`;
      if (Math.abs(bar.scrollLeft - pick.scrollLeft) > 0.5) { syncing.current = true; bar.scrollLeft = pick.scrollLeft; }
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };

    pane.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(pane);
    // 표가 늦게 그려지거나 단계가 바뀌어 내용이 갈리는 것까지 따라가려면 가끔 다시 잰다.
    const t = window.setInterval(schedule, 700);
    schedule();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      pane.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      ro.disconnect();
      window.clearInterval(t);
      bar.removeEventListener("scroll", onBarScroll);
      setTarget(null);
    };
  }, [mounted, paneRef]);

  if (!mounted) return null;
  return createPortal(
    <div ref={barRef} className="hscroll-float" aria-hidden style={{ display: "none" }}>
      <div ref={innerRef} className="hscroll-float-inner" />
    </div>,
    document.body,
  );
}
