// 결제조건(Payment Terms) 추천 프리셋 — 고객/공급사 정보 등록과 견적서 Terms 편집에서
// datalist(콤보박스)로 공유한다. 콤보박스이므로 목록에 없는 값도 자유 입력 가능하다.
// 국제 무역에서 흔히 쓰는 조건들을 선불(advance) → 분할 → 후불(net) → 신용장(L/C)
// → 추심(D/P·D/A) 순으로 배열.
export const PAYMENT_TERMS_PRESETS: readonly string[] = [
  "100% T/T in advance",
  "100% T/T against proforma invoice",
  "30% T/T in advance, 70% before shipment",
  "50% T/T in advance, 50% before shipment",
  "30% T/T in advance, 70% against copy of B/L",
  "T/T 30 days after delivery",
  "T/T 60 days after delivery",
  "T/T 90 days after delivery",
  "T/T 30 days after B/L date",
  "Net 30 days from invoice date",
  "L/C at sight",
  "L/C at sight, irrevocable",
  "L/C 30 days after B/L date",
  "D/P at sight",
  "D/A 30 days",
];

import type { QuotationTerms } from "./types";

// Terms & Conditions 기본값 — 신규 견적/오더/발주서 작성 시 미리 채워지는 값.
// (Packing·Remarks 는 비워 둔다.) 콤보박스라 사용자가 자유롭게 바꿀 수 있다.
export const DEFAULT_TERMS: QuotationTerms = {
  incoterms: "EXW (Ex Works)",
  delivery_place: "Busan, Republic of Korea",
  payment_terms: "T/T 30 days after delivery",
  warranty: "6 months from delivery",
};

// 저장된 terms 에 기본값을 채워 반환한다. 이미 값이 있는 필드는 그대로 두고,
// 비어 있는(미입력) 필드만 DEFAULT_TERMS 로 보완한다. t 를 안 주면 순수 기본값.
export function withDefaultTerms(t?: QuotationTerms | null): QuotationTerms {
  const out: QuotationTerms = { ...DEFAULT_TERMS, ...(t || {}) };
  (Object.keys(DEFAULT_TERMS) as (keyof QuotationTerms)[]).forEach((k) => {
    if (!out[k] || String(out[k]).trim() === "") out[k] = DEFAULT_TERMS[k];
  });
  return out;
}

// 견적서/오더/발주서 Terms & Conditions 편집기 프리셋(콤보박스, 자유입력 가능).
export const TERM_PRESETS = {
  // Incoterms 는 규칙만 — 지역/항구는 Place 필드에서 지정. 약어 풀이를 괄호에 표기.
  incoterms: [
    "EXW (Ex Works)",
    "FCA (Free Carrier)",
    "FOB (Free On Board)",
    "CFR (Cost and Freight)",
    "CIF (Cost, Insurance and Freight)",
    "DAP (Delivered at Place)",
  ],
  payment_terms: PAYMENT_TERMS_PRESETS,
  packing: ["Standard export packing", "Seaworthy export packing", "Wooden case packing"],
  delivery_place: ["Busan, Republic of Korea", "Incheon, Republic of Korea", "named port of destination"],
  warranty: ["Manufacturer's standard warranty", "12 months from delivery", "6 months from delivery", "No warranty"],
} as const;
