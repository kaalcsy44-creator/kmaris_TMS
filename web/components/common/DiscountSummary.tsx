"use client";

import { useEffect, useRef, useState } from "react";
import { dualCurrencyText, moneyText, USD_KRW_RATE } from "@/components/common/itemTable";

// 4단계 견적(Quote Sent)과 5단계 고객 P/O(P/O Received)가 같은 줄을 쓴다 —
// 둘이 같은 계산(소계 − 할인 = 최종)이어야 견적 Final 과 오더 Final 이 같은 숫자가 된다.

// 할인 칸 표시용 — 율은 소수 넷째 자리, 금액은 둘째 자리까지(끝의 0은 지운다).
function trimNum(v: number, digits: number): string {
  if (!Number.isFinite(v) || !v) return "0";
  return String(Math.round(v * 10 ** digits) / 10 ** digits);
}

// 소계 · 할인(율 또는 금액) · 최종금액 요약. 저장은 할인율(discount_pct) 하나다 —
// 금액 칸에 적으면 그 금액이 정확히 빠지도록 율을 역산해 넣는다(USD 400 → 8.5106…%).
// 금액으로 정한 할인은 품목을 고쳐 소계가 바뀌어도 금액이 그대로 유지된다.
export default function DiscountSummary({
  subtotal,
  discountPct,
  onDiscountChange,
  currency = "USD",
  rate = USD_KRW_RATE,
}: {
  subtotal: number;
  discountPct: number;
  onDiscountChange: (v: number) => void;
  currency?: string;
  rate?: number;
}) {
  const discountAmt = Math.round(subtotal * (Number(discountPct || 0) / 100) * 100) / 100;
  const finalTotal = Math.round((subtotal - discountAmt) * 100) / 100;
  const cur = (currency || "USD").toUpperCase();
  // 입력 중인 칸은 사용자가 친 글자를 그대로 두고, 다른 칸은 계산값으로 보여 준다.
  const [editing, setEditing] = useState<"pct" | "amt" | null>(null);
  const [text, setText] = useState("");
  // 마지막으로 금액을 정했으면 그 금액을 고정한다(소계가 바뀌면 율을 다시 계산).
  const fixedAmt = useRef<number | null>(null);
  const prevSubtotal = useRef(subtotal);
  useEffect(() => {
    const a = fixedAmt.current;
    const before = prevSubtotal.current;
    prevSubtotal.current = subtotal;
    if (a == null || !subtotal) return;
    // 율이 아직 그 금액에서 나온 값일 때만 따라간다 — 다른 견적을 불러와 율이 바뀌었으면
    // 고정을 풀어 버린다(옛 견적의 금액이 새 견적에 옮겨 붙지 않게).
    if (Math.abs(before * Number(discountPct || 0) / 100 - a) > 0.005) { fixedAmt.current = null; return; }
    const pct = (a / subtotal) * 100;
    if (Math.abs(pct - Number(discountPct || 0)) > 1e-9) onDiscountChange(pct);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtotal]);
  const pctShown = editing === "pct" ? text : trimNum(Number(discountPct || 0), 4);
  const amtShown = editing === "amt" ? text : trimNum(discountAmt, 2);
  // 총액은 표 합계행(tfoot)·하단 저장바(FINAL)에도 나오므로 여기서는 계산식 한 줄로만 둔다
  // ("소계 − 할인 = 최종"). 카드 4칸으로 벌려 놓으면 같은 숫자가 세 군데서 반복돼 읽기 어렵다.
  return (
    <div className="summary-strip">
      <span className="pb-title">Summary</span>
      <span className="ss-item">
        <span className="ss-l">Subtotal</span>
        <b>{cur} {moneyText(subtotal)}</b>
      </span>
      <span className="ss-op">−</span>
      <div className="form-field">
        <label>Discount</label>
        <input
          className="num"
          type="number"
          style={{ width: 72 }}
          value={pctShown}
          title="Discount rate"
          onFocus={() => { setEditing("pct"); setText(pctShown === "0" ? "" : pctShown); }}
          onBlur={() => setEditing(null)}
          onChange={(e) => {
            setText(e.target.value);
            fixedAmt.current = null;
            onDiscountChange(Number(e.target.value) || 0);
          }}
        />
        <span className="pb-unit">%</span>
      </div>
      <span className="ss-op">or</span>
      <div className="form-field">
        <span className="pb-unit">{cur}</span>
        <input
          className="num"
          type="number"
          style={{ width: 96 }}
          value={amtShown}
          title="Discount amount"
          onFocus={() => { setEditing("amt"); setText(amtShown === "0" ? "" : amtShown); }}
          onBlur={() => setEditing(null)}
          onChange={(e) => {
            setText(e.target.value);
            const a = Number(e.target.value) || 0;
            fixedAmt.current = a || null;
            onDiscountChange(subtotal ? (a / subtotal) * 100 : 0);
          }}
        />
      </div>
      <span className="ss-op">=</span>
      <span className="ss-item ss-final">
        <span className="ss-l">Final</span>
        <b>{dualCurrencyText(finalTotal, currency, rate)}</b>
      </span>
    </div>
  );
}
