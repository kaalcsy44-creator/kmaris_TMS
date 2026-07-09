"use client";

import { useEffect, useRef, useState } from "react";
import { fetchFxRate } from "@/lib/api";

export type FxMode = "auto" | "manual";

// 통화 옆 환율(매매기준율/직접입력) 입력 컨트롤. 1 USD = ? KRW.
// - "매매기준율": 지정한 날짜(date)의 수출입은행 고시값을 자동 조회(읽기전용).
// - "직접입력": 사용자가 값을 직접 입력.
export default function FxRateControl({
  rate,
  onRate,
  mode,
  onMode,
  date,
  cur = "USD",
  label = "FX rate (1 USD = KRW)",
}: {
  rate: number | null;
  onRate: (v: number | null) => void;
  mode: FxMode;
  onMode: (m: FxMode) => void;
  date?: string; // YYYY-MM-DD 또는 datetime-local. 매매기준율 조회 기준일.
  cur?: string;
  label?: string;
}) {
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState("");
  const lastFetch = useRef<string>("");

  useEffect(() => {
    if (mode !== "auto") return;
    const d = (date || "").slice(0, 10);
    const key = `${d}|${cur}`;
    if (lastFetch.current === key) return;
    lastFetch.current = key;
    setLoading(true);
    fetchFxRate(d, cur)
      .then((r) => {
        onRate(r.rate);
        setNote(r.source === "exim" ? `매매기준율 ${r.date_used}` : "고시 없음 · 고정환율");
      })
      .catch(() => setNote("조회 실패 · 고정환율"))
      .finally(() => setLoading(false));
    // onRate 는 의존성에서 제외(부모 리렌더로 인한 재조회 방지). date/cur/mode 변경 시에만 조회.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, date, cur]);

  return (
    <div className="form-field fx-field">
      <label>{label}</label>
      <div className="fx-control">
        <div className="fx-toggle">
          <button
            type="button"
            className={mode === "auto" ? "on" : ""}
            onClick={() => onMode("auto")}
          >
            매매기준율
          </button>
          <button
            type="button"
            className={mode === "manual" ? "on" : ""}
            onClick={() => { onMode("manual"); lastFetch.current = ""; }}
          >
            직접입력
          </button>
        </div>
        <input
          className="fx-rate-input"
          type="number"
          step="0.01"
          inputMode="decimal"
          value={rate ?? ""}
          readOnly={mode === "auto"}
          onChange={(e) => onRate(e.target.value === "" ? null : Number(e.target.value))}
          placeholder="1 USD = ? KRW"
        />
      </div>
      {mode === "auto" ? (
        <span className="fx-note-inline">{loading ? "조회중…" : note}</span>
      ) : null}
    </div>
  );
}
