"use client";

// 거래 상대 한 줄 — 고객(+담당자) · 벤더 · 거래구분. 개요(Overview) 머리의 그 줄과 같은
// 내용을 작업(Work) 화면 위에도 세운다: 단계를 오가며 일하는 동안 "누구와 무슨 거래인가"가
// 늘 보여야 한다. 팝업 머리 바로 아래(스크롤 영역 밖)에 두어 고정된다.
//
// 벤더는 견적을 물어본 곳이 열 군데를 넘기도 한다 — 줄바꿈으로 늘어놓으면 머리가 두세 줄로
// 불어나 작업 화면을 밀어낸다. 그래서 한 줄에 세우고 넘치는 것은 좌우 버튼으로 넘겨 본다.

import { useCallback, useEffect, useRef, useState } from "react";
import type { PipelineRow } from "@/lib/types";
import { tr } from "@/lib/labels";
import CustomerName from "@/components/common/CustomerName";
import { vendorList } from "@/components/common/dealFields";

export default function DealPartiesLine({ row }: { row: PipelineRow }) {
  return (
    <div className="deal-parties">
      <span className="deal-parties-f">
        <b>Customer</b>
        {row.customer ? <CustomerName name={row.customer} /> : <span className="muted">—</span>}
        {row.contact_person ? <span className="deal-parties-contact">{row.contact_person}</span> : null}
      </span>
      <span className="deal-parties-f deal-parties-vendf">
        <b>Vendor</b>
        <VendorStrip row={row} />
      </span>
      <span className="deal-parties-f">
        <b>Trade</b>
        {tr(row.trade_type || "수출")}
      </span>
    </div>
  );
}

/** 벤더 한 줄 — 넘치면 양 끝에 ‹ › 버튼이 생기고, 누르면 보이는 폭의 대략 80%씩 넘긴다. */
function VendorStrip({ row }: { row: PipelineRow }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdge((cur) => (cur.left === left && cur.right === right ? cur : { left, right }));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    Array.from(el.children).forEach((c) => ro.observe(c));
    return () => ro.disconnect();
  }, [measure, row]);

  const step = (dir: 1 | -1) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.8), behavior: "smooth" });
  };

  const overflow = edge.left || edge.right;
  return (
    <span className="deal-vstrip">
      {overflow ? (
        <button
          type="button"
          className="deal-vstrip-btn"
          onClick={() => step(-1)}
          disabled={!edge.left}
          aria-label="Previous vendors"
        >
          ‹
        </button>
      ) : null}
      <div
        ref={ref}
        className={`deal-vstrip-track${edge.left ? " fade-l" : ""}${edge.right ? " fade-r" : ""}`}
        onScroll={measure}
      >
        {vendorList(row)}
      </div>
      {overflow ? (
        <button
          type="button"
          className="deal-vstrip-btn"
          onClick={() => step(1)}
          disabled={!edge.right}
          aria-label="More vendors"
        >
          ›
        </button>
      ) : null}
    </span>
  );
}
