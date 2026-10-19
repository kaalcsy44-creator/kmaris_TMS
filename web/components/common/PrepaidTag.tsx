"use client";

/**
 * 선입금 표시 — 돈이 물건보다 먼저 온 딜.
 *
 * 제작품은 선금을 받고 만들어 보낸다. 그런 딜은 9·10·11(청구·세금계산서·수금)이 먼저
 * 끝나고 7·8(출고 준비·인도)이 뒤에 온다. 딜의 자리는 물건 쪽에 머무르므로, 돈이
 * 이미 들어왔다는 사실은 이 꼬리표가 말한다.
 *
 * 결제조건(advance_terms)만으로는 붙이지 않는다 — "100% T/T in advance" 가 사실상 기본
 * 조건이라 딜 대부분(2026-10 기준 36건)에 붙어 아무것도 가려내지 못했다. 실제로 돈 단계가
 * 먼저 끝난 딜(prepaid)에만 선다.
 */
export default function PrepaidTag({ row }: { row: { prepaid?: boolean } }) {
  if (!row.prepaid) return null;
  return (
    <span
      className="prepaid-tag on"
      title="Prepaid — billing/payment (stages 9–11) finished before delivery (7–8). The deal stays at the delivery stage until the goods go out."
    >
      Prepaid ✓
    </span>
  );
}
