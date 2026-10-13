"use client";

/** 저장값(문서 terms 에 문자열로 들어가기도 한다) → 자릿수. 비었거나 이상하면 null(자동). */
export function decimalsOf(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 3 ? n : null;
}

/**
 * 품목표 머리의 "금액 소수 자릿수" 선택(엑셀 0 / 0.0 / 0.00 / 0.000). 고르면 표가 단가·금액을
 * 그 자리로 반올림하고 그 자릿수로 보여 준다 — 반올림 자체는 표마다(onChange 쪽) 한다.
 */
export default function DecimalsSelect({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (d: number | null) => void;
}) {
  return (
    <select
      className="btn sm items-head-decimals"
      value={value == null ? "" : String(value)}
      title="Round unit prices and amounts to this many decimal places (like Excel 0 / 0.0 / 0.00)"
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
    >
      <option value="">Decimals: auto</option>
      <option value="0">0</option>
      <option value="1">0.0</option>
      <option value="2">0.00</option>
      <option value="3">0.000</option>
    </select>
  );
}
