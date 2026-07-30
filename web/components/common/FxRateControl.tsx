"use client";

import { useEffect, useRef, useState } from "react";
import { fetchFxRate } from "@/lib/api";

export type FxMode = "auto" | "manual";

/** 그 날짜의 수출입은행 고시 — 계산에 쓰는 매매기준율 + 참고용 살 때/팔 때. */
type FxRef = {
  base: number;
  tts: number | null; // 전신환 보내실 때 = 외화를 살 때
  ttb: number | null; // 전신환 받으실 때 = 외화를 팔 때
  date: string;
  source: "exim" | "fixed";
  reason?: "" | "no_key" | "no_data";
};

const fmtRate = (v: number) =>
  v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// 통화 옆 환율(매매기준율/직접입력) 입력 컨트롤. 1 USD = ? KRW.
// - "매매기준율": 지정한 날짜(date)의 수출입은행 고시값을 자동 조회(읽기전용).
// - "직접입력": 사용자가 값을 직접 입력.
// 고시값(기준율·살 때·팔 때)은 두 모드에서 모두 아래에 표시한다 — 직접입력으로 값을
// 정할 때야말로 그날 시세를 옆에 두고 봐야 한다.
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
  const [failed, setFailed] = useState(false);
  const [ref, setRef] = useState<FxRef | null>(null);
  const lastFetch = useRef<string>("");

  // 고시 조회는 모드와 무관하게 날짜·통화가 바뀔 때만.
  useEffect(() => {
    const d = (date || "").slice(0, 10);
    const key = `${d}|${cur}`;
    if (lastFetch.current === key) return;
    lastFetch.current = key;
    setLoading(true);
    setFailed(false);
    fetchFxRate(d, cur)
      .then((r) =>
        setRef({
          base: r.rate,
          tts: r.tts,
          ttb: r.ttb,
          date: r.date_used,
          source: r.source,
          reason: r.reason,
        })
      )
      .catch(() => {
        setRef(null);
        setFailed(true);
      })
      .finally(() => setLoading(false));
  }, [date, cur]);

  // 매매기준율 모드에서는 조회된 기준율을 그대로 값으로 쓴다.
  useEffect(() => {
    if (mode === "auto" && ref) onRate(ref.base);
    // onRate 는 의존성에서 제외(부모 리렌더로 값이 되돌아가는 것을 막는다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, ref]);

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
            Market rate
          </button>
          <button
            type="button"
            className={mode === "manual" ? "on" : ""}
            onClick={() => onMode("manual")}
          >
            Manual
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
      {/* 그날 고시 참고 — 매매기준율/살 때(TTS)/팔 때(TTB). 직접입력 모드에서도 보인다. */}
      <div className="fx-ref">
        {loading ? (
          <span className="fx-ref-note">Loading…</span>
        ) : failed ? (
          <span className="fx-ref-note">Lookup failed · fixed rate</span>
        ) : !ref ? null : ref.source !== "exim" ? (
          <span
            className="fx-ref-note"
            title={
              ref.reason === "no_key"
                ? "서버에 수출입은행 API 키(EXIM_API_KEY)가 없어 고시 시세를 못 불러온다."
                : "그 날짜의 고시가 없다(주말·공휴일·오전 고시 전)."
            }
          >
            {ref.reason === "no_key" ? "FX API key not set" : "No published rate"} · fixed{" "}
            {fmtRate(ref.base)}
          </span>
        ) : (
          <>
            <span className="fx-ref-item" title="매매기준율">
              Base <b>{fmtRate(ref.base)}</b>
            </span>
            {ref.tts ? (
              <span className="fx-ref-item" title="전신환 보내실 때 — 외화를 살 때">
                Buy <b>{fmtRate(ref.tts)}</b>
              </span>
            ) : null}
            {ref.ttb ? (
              <span className="fx-ref-item" title="전신환 받으실 때 — 외화를 팔 때">
                Sell <b>{fmtRate(ref.ttb)}</b>
              </span>
            ) : null}
            <span className="fx-ref-date">{ref.date}</span>
          </>
        )}
      </div>
    </div>
  );
}
