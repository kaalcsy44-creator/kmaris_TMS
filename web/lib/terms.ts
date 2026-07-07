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
