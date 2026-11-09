"use client";

// 거래 상대 한 줄 — 고객(+담당자) · 벤더 · 거래구분. 개요(Overview) 머리의 그 줄과 같은
// 내용을 작업(Work) 화면 위에도 세운다: 단계를 오가며 일하는 동안 "누구와 무슨 거래인가"가
// 늘 보여야 한다. 팝업 머리 바로 아래(스크롤 영역 밖)에 두어 고정된다.

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
      <span className="deal-parties-f deal-parties-vendors">
        <b>Vendor</b>
        {vendorList(row)}
      </span>
      <span className="deal-parties-f">
        <b>Trade</b>
        {tr(row.trade_type || "수출")}
      </span>
    </div>
  );
}
