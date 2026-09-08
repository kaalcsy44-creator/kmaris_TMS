"use client";

import type { ReactNode } from "react";
import type { PipelineRow } from "@/lib/types";
import CustomerName from "@/components/common/CustomerName";
import VendorName from "@/components/common/VendorName";
import { tr } from "@/lib/labels";
import { poVendorsOf, stageDateOf } from "@/lib/deal";

// 프로젝트 정보 항목 정의 — 상세 모달 좌측 패널(사용자가 표시 여부 선택)과
// 프로젝트 개요 페이지(전체 표시)가 함께 쓴다. render 는 표시값.

// 줄바꿈으로 구분된 여러 값(선박·고객 PO 목록)을 여러 줄로 렌더. 1개면 그대로, 없으면 —.
export function multiText(s: string): ReactNode {
  const parts = (s || "").split("\n").filter(Boolean);
  if (parts.length === 0) return "—";
  if (parts.length === 1) return parts[0];
  return parts.map((p, i) => <div key={i}>{p}</div>);
}

// Vendor 한 곳의 표시 상태:
//  quoted  견적 수신    → 선명(기본색)
//  out     견적 불가 통보(declined) 또는 견적단계(4)를 넘겼는데도 미수신 → 취소선
//  waiting 아직 견적 대기(발송 후 진행 중) → 회색
// stage 4 = Quote Sent. 그 단계를 넘기면 미회신 벤더는 사실상 제외로 본다.
export type VendorState = "quoted" | "out" | "waiting";
export function vendorState(
  v: { quoted: boolean; declined?: boolean; sent_at?: string },
  r: PipelineRow,
): VendorState {
  if (v.quoted) return "quoted";
  if (v.declined) return "out";
  if (r.stage < 4) return "waiting";
  // 고객 견적을 낸 뒤에 물어본 곳은 지난 라운드의 낙오가 아니라 새 라운드다 — 공급사가
  // 공급을 거절해 딜을 닫았다 다시 열고 여러 곳에 새로 RFQ 를 보내는 일이 있다. 단계
  // 번호만 보고 지워 버리면, 지금 답을 기다리는 곳이 이미 끝난 곳으로 읽힌다.
  const quoteSent = stageDateOf(r, 4);
  if (quoteSent && (v.sent_at || "") > quoteSent) return "waiting";
  return "out";
}

// Vendor 필드: RFQ를 보낸 모든 벤더를 위 규칙대로 색/취소선으로 나열한다.
// RFQ 발송 전이면 발주(P/O) 벤더 또는 —. 벤더명 좌측 로고는 VendorName 이 붙인다.
export function vendorList(r: PipelineRow): ReactNode {
  const list = r.rfq_vendors;
  if (list && list.length) {
    // RFQ 없이 발주만 나간 벤더(직발주)는 목록에 없다 — 뒤에 붙여 준다.
    const shown = [
      ...list,
      ...poVendorsOf(r)
        .filter((n) => !list.some((v) => v.name === n))
        .map((n) => ({ name: n, quoted: true })),
    ];
    return shown.map((v, i) => (
      <div key={i} className={`vendor-${vendorState(v, r)}`}>
        <VendorName name={v.name} />
      </div>
    ));
  }
  return r.vendor ? <VendorName name={r.vendor} /> : "—";
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
