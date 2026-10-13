"use client";

import { useState, type InputHTMLAttributes } from "react";
import { amountInputValue, parseAmountInput } from "@/components/common/itemTable";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value"> & {
  value: number | string | null | undefined;
  /** 칸을 벗어났을 때 보일 소수 자릿수(엑셀 셀 서식). 없으면 있는 그대로. */
  decimals?: number | null;
};

function sameAmount(draft: string, value: Props["value"]): boolean {
  const a = parseAmountInput(draft);
  const b = value === null || value === undefined || value === "" ? null : parseAmountInput(String(value));
  return a === b;
}

/**
 * 금액·수량 입력칸. 저장값은 숫자, 화면은 "1,234.5" 처럼 천단위 쉼표로 보여 준다.
 *
 * 예전엔 value={amountInputValue(x)} 로 키 하나마다 숫자→문자로 다시 그려서, "123." 을 치는 순간
 * 123 으로 읽혀 점이 지워졌다(소수점을 처음부터 칠 수 없었다). 입력하는 동안은 친 글자를 그대로
 * 두고, 칸을 벗어나면 서식을 입힌다. 바깥에서 값이 바뀌면(붙여넣기·Ctrl+D·재계산) 그 값을 따른다.
 */
export default function AmountInput({ value, decimals, onChange, onBlur, ...rest }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft !== null && sameAmount(draft, value) ? draft : amountInputValue(value, decimals);
  return (
    <input
      inputMode="decimal"
      {...rest}
      value={shown}
      onChange={(e) => {
        setDraft(e.target.value);
        onChange?.(e);
      }}
      onBlur={(e) => {
        setDraft(null);
        onBlur?.(e);
      }}
    />
  );
}
