"use client";

import type { ReactNode } from "react";
import type { PipelineRow } from "@/lib/types";
import CustomerName from "@/components/common/CustomerName";
import VendorName from "@/components/common/VendorName";
import { tr } from "@/lib/labels";
import { vendorEntriesOf } from "@/lib/deal";

// 프로젝트 정보 항목 정의 — 상세 모달 좌측 패널(사용자가 표시 여부 선택)과
// 프로젝트 개요 페이지(전체 표시)가 함께 쓴다. render 는 표시값.

// 줄바꿈으로 구분된 여러 값(선박·고객 PO 목록)을 여러 줄로 렌더. 1개면 그대로, 없으면 —.
export function multiText(s: string): ReactNode {
  const parts = (s || "").split("\n").filter(Boolean);
  if (parts.length === 0) return "—";
  if (parts.length === 1) return parts[0];
  return parts.map((p, i) => <div key={i}>{p}</div>);
}

// Vendor 필드: RFQ를 보낸 모든 벤더를 상태(vendorEntriesOf)대로 나열한다 — 견적을 받은
// 곳에는 체크, 기다리는 곳은 회색, 못 준다고 한 곳·끝내 답이 없던 곳은 취소선.
// RFQ 발송 전이면 발주(P/O) 벤더 또는 —. 벤더명 좌측 로고는 VendorName 이 붙인다.
export function vendorList(r: PipelineRow): ReactNode {
  const entries = vendorEntriesOf(r);
  if (!entries.length) return r.vendor ? <VendorName name={r.vendor} /> : "—";
  return entries.map((e, i) => (
    <div key={i}>
      <VendorName entries={[e]} />
    </div>
  ));
}

export const INFO_FIELDS: { key: string; label: string; render: (r: PipelineRow) => ReactNode }[] = [
  { key: "customer", label: "Customer", render: (r) => (r.customer ? <CustomerName name={r.customer} /> : "—") },
  { key: "trade_type", label: "Trade type", render: (r) => tr(r.trade_type || "수출") },
  { key: "vessel", label: "Vessel", render: (r) => multiText(r.vessels || r.vessel) },
  { key: "vendor", label: "Vendor", render: (r) => vendorList(r) },
  { key: "project_title", label: "Project title", render: (r) => r.project_title || "—" },
  { key: "customer_po_no", label: "Customer P/O No.", render: (r) => multiText(r.customer_po_nos || r.customer_po_no) },
  {
    key: "items",
    label: "Items",
    render: (r) =>
      r.item_count ? (r.first_item ? `${r.first_item} 외 ${r.item_count} unit` : r.item_count) : "—",
  },
  { key: "sales_amount", label: "Sales", render: (r) => r.sales_total || r.customer_amount || "—" },
  { key: "purchase_amount", label: "Purchase", render: (r) => r.purchase_total || r.vendor_amount || "—" },
  {
    key: "margin",
    label: "Margin",
    render: (r) =>
      r.margin_amount
        ? `${r.margin_amount}${r.margin_pct != null ? ` (${r.margin_pct}%)` : ""}`
        : "—",
  },
  { key: "pic", label: "PIC", render: (r) => r.assignee || "—" },
  { key: "customer_rfq_no", label: "Customer RFQ No.", render: (r) => r.customer_rfq_no || "—" },
  { key: "kmaris_rfq_no", label: "K-Maris RFQ No.", render: (r) => r.kmaris_rfq_no || "—" },
];

export const DEFAULT_INFO_FIELDS = [
  "customer", "trade_type", "vessel", "vendor", "project_title", "customer_po_no", "items",
  "sales_amount", "purchase_amount", "margin",
];
