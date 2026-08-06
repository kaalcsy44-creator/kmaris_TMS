"use client";

import { Children, useCallback, useEffect, useRef, useState } from "react";

// 레코드 선택 탭(벤더 RFQ·견적·발주 등)을 담는 가로 스크롤 레인.
//
// 벤더·P/O 가 대여섯을 넘으면 칩이 줄을 넘겨 옆의 번호 배지·버튼을 밀어냈고, 행 전체가
// 옆으로 스크롤되면서 오른쪽 버튼까지 화면 밖으로 나갔다. 그래서 칩만 이 레인 안에서
// 넘치게 한다 — 번호 배지와 버튼은 레인 밖이라 항상 제자리에 보인다.
//   · 칩이 넘칠 때만 ‹ › 와 가장자리 그라데이션이 나타난다(더 있다는 신호).
//   · activeKey 가 바뀌면 그 칩이 보이도록 레인만 움직인다(페이지는 건드리지 않는다).
//   · 네이티브 스크롤바는 감춘다 — 얇은 회색 막대가 탭 바로 아래 붙어 지저분했다.
//
// 자식은 칩 버튼들이며, 선택된 것에 className="on" 을 준다(그 칩을 찾아 끌어온다).
export default function RecordStrip({
  children,
  activeKey,
  ariaLabel,
}: {
  children: React.ReactNode;
  activeKey?: string | number | null;
  ariaLabel?: string;
}) {
  const laneRef = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ over: false, start: true, end: false });
  // 칩 개수 — children 배열은 렌더마다 새 참조라 그대로 의존성에 넣으면 매번 다시 단다.
  const count = Children.count(children);

  const sync = useCallback(() => {
    const el = laneRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdge({ over: max > 2, start: el.scrollLeft <= 2, end: el.scrollLeft >= max - 2 });
  }, []);

  useEffect(() => {
    const el = laneRef.current;
    if (!el) return;
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sync, count]);

  // 선택된 칩이 레인 밖이면 그만큼만 끌어온다(scrollIntoView 는 페이지까지 움직인다).
  useEffect(() => {
    const el = laneRef.current;
    const on = el?.querySelector<HTMLElement>("button.on");
    if (!el || !on) return;
    const left = on.offsetLeft;
    const right = left + on.offsetWidth;
    if (left < el.scrollLeft) {
      el.scrollTo({ left: Math.max(0, left - 12), behavior: "smooth" });
    } else if (right > el.scrollLeft + el.clientWidth) {
      el.scrollTo({ left: right - el.clientWidth + 12, behavior: "smooth" });
    }
  }, [activeKey, count]);

  function nudge(dir: 1 | -1) {
    const el = laneRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(180, el.clientWidth * 0.7), behavior: "smooth" });
  }

  return (
    <div
      className={`rec-strip${edge.over ? " over" : ""}${edge.start ? "" : " fade-l"}${
        edge.end ? "" : " fade-r"
      }`}
    >
      {edge.over ? (
        <button
          type="button"
          className="rec-strip-nav"
          disabled={edge.start}
          aria-label="Scroll left"
          onClick={() => nudge(-1)}
        >
          ‹
        </button>
      ) : null}
      <div
        className="embedded-record-picker"
        role="tablist"
        aria-label={ariaLabel}
        ref={laneRef}
        onScroll={sync}
      >
        {children}
      </div>
      {edge.over ? (
        <button
          type="button"
          className="rec-strip-nav"
          disabled={edge.end}
          aria-label="Scroll right"
          onClick={() => nudge(1)}
        >
          ›
        </button>
      ) : null}
    </div>
  );
}
