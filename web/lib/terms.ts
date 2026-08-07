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
// satisfies 로 두면 QuotationTerms 적합성은 그대로 검사하면서 키가 이 넷으로 좁혀져,
// 아래 보완 루프가 문자열 필드만 다룬다는 걸 타입으로 알 수 있다(clauses 등 배열 필드 제외).
export const DEFAULT_TERMS = {
  incoterms: "EXW (Ex Works)",
  delivery_place: "Busan, Republic of Korea",
  payment_terms: "T/T 30 days after delivery",
  warranty: "6 months from delivery",
} satisfies QuotationTerms;

// 저장된 terms 에 기본값을 채워 반환한다. 이미 값이 있는 필드는 그대로 두고,
// 비어 있는(미입력) 필드만 DEFAULT_TERMS 로 보완한다. t 를 안 주면 순수 기본값.
export function withDefaultTerms(t?: QuotationTerms | null): QuotationTerms {
  const out: QuotationTerms = { ...DEFAULT_TERMS, ...(t || {}) };
  (Object.keys(DEFAULT_TERMS) as (keyof typeof DEFAULT_TERMS)[]).forEach((k) => {
    if (!out[k] || String(out[k]).trim() === "") out[k] = DEFAULT_TERMS[k];
  });
  return out;
}

// 문자열 값을 가지는 거래조건 키 — 문서 간 복사(벤더 견적 → 고객 견적)에 쓴다.
// clauses·extra_clauses 는 견적서 전용 목록이라 여기 넣지 않는다(복사 대상 아님).
export const TERM_TEXT_KEYS = [
  "incoterms", "payment_terms", "delivery_place", "shipment_method",
  "packing", "warranty", "remarks", "messrs", "attn", "ref_no",
] as const;

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

// 견적서(QUOTATION / COSTING SHEET) 하단에 찍히는 표준 Terms & Conditions 문장.
// 서버의 quotation_clause_catalog(ktms/services/kmaris_docs.py)와 id·문구가 짝이다 —
// 한쪽만 고치면 4단계 화면에서 고른 문장과 실제 문서가 어긋나므로 함께 고칠 것.
// 거래조건 필드가 들어가는 문장은 현재 입력값으로 즉시 다시 만들어, 화면에 보이는
// 문장이 곧 인쇄될 문장이 되게 한다.
export const QUOTATION_VALIDITY_DAYS = 30;

export const QUOTATION_CLAUSES: readonly {
  id: string;
  text: (t: QuotationTerms) => string;
}[] = [
  { id: "validity", text: () => `Quotation validity: ${QUOTATION_VALIDITY_DAYS} days from quotation date.` },
  { id: "confirmation", text: () => "Price, availability, and delivery time are subject to final confirmation upon order placement." },
  {
    id: "delivery_term",
    text: (t) =>
      `Delivery term: ${t.incoterms || "EXW (Ex Works)"} ${t.delivery_place || "Busan, Republic of Korea"}, Incoterms 2020.`,
  },
  { id: "charges_excluded", text: () => "Freight, customs duty, local tax, and other logistics charges are excluded unless otherwise stated." },
  { id: "payment_term", text: (t) => `Payment term: ${t.payment_terms || "T/T in advance"}` },
  { id: "buyer_check", text: () => "Buyer to confirm part number, description, quantity, engine type, and technical suitability before order." },
  { id: "certificates", text: () => "Certificates are excluded unless specifically stated." },
  { id: "cancellation", text: () => "Cancellation or return may not be accepted after order confirmation, especially for specially ordered or non-stock items." },
  { id: "warranty", text: (t) => `Warranty follows ${t.warranty || "6 months from delivery"}.` },
  {
    id: "complete_order",
    text: () =>
      "The unit price suggested is based on the complete order with complete quantities. In case of reduction for qty, "
      + "it may constitute a variation to the contract, subject to mutual agreement.",
  },
];

// 지금 문서에 찍힐 문장 id 들. 고른 적이 없는(=clauses 미저장) 견적은 전체가 들어간다 —
// 서버 quotation_standard_terms 와 같은 판정이라 화면 미리보기와 문서가 일치한다.
export function selectedClauseIds(t: QuotationTerms): string[] {
  return Array.isArray(t.clauses) ? t.clauses : QUOTATION_CLAUSES.map((c) => c.id);
}
