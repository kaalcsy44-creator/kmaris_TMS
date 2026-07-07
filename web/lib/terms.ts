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
