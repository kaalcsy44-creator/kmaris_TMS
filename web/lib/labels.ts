// DB에 저장된 한글 enum/상태 값을 화면에서 영문으로 표시하기 위한 매핑.
// 저장값(비교·필터 키)은 그대로 두고, 표시 텍스트만 tr() 로 변환한다.
const LABELS: Record<string, string> = {
  // 공통
  전체: "All",
  미지정: "Unspecified",
  // WorkType
  부품공급: "Parts",
  서비스: "Service",
  // 거래구분(trade_type)
  수출: "Export",
  내수: "Domestic",
  "내수 (국내공급)": "Domestic",
  // RFQ status
  수신완료: "Received",
  "공급사 소싱중": "Sourcing",
  "견적 중": "Quoting",
  "이메일 발송 완료": "Email sent",
  수주완료: "Ordered",
  실주: "Lost",
  // Quotation status
  초안: "Draft",
  발송완료: "Sent",
  협상중: "Negotiating",
  수주확정: "Won",
  만료: "Expired",
  // Order status
  "오더 수주": "Order received",
  "발주 완료": "PO placed",
  "제조/준비중": "Preparing",
  출고완료: "Shipped",
  운송중: "In transit",
  "목적지 하차 완료": "Delivered",
  // AR status
  미수: "Outstanding",
  일부수금: "Partial",
  완납: "Paid",
  연체: "Overdue",
  // Vendor PO status
  발주완료: "PO placed",
  "이메일 발송완료": "Email sent",
};

/** 한글 저장값 → 영문 표시. 매핑이 없으면 원문 그대로. */
export function tr(value: string | null | undefined): string {
  if (!value) return value ?? "";
  return LABELS[value] ?? value;
}
