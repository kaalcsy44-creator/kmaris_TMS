"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchFxRate } from "@/lib/api";

export type FxMode = "auto" | "manual";

/** 그 날짜의 수출입은행 고시 — 계산에 쓰는 매매기준율 + 참고용 살 때/팔 때. */
type FxRef = {
  base: number;
  tts: number | null; // 전신환 보내실 때 = 외화를 살 때
  ttb: number | null; // 전신환 받으실 때 = 외화를 팔 때
  date: string;
  source: "exim" | "fixed";
  reason?: string;
};

/** 고시 조회 실패 사유 → 화면 문구 + 설명. 사유별로 손댈 곳이 달라 뭉뚱그리지 않는다. */
const FX_FALLBACK: Record<string, { text: string; hint: string }> = {
  no_key: {
    text: "FX API key not set",
    hint: "서버에 수출입은행 인증키(EXIM_API_KEY)가 없다. Render 환경변수에 등록 필요.",
  },
  bad_key: {
    text: "FX API key rejected",
    hint: "수출입은행이 인증키를 거부했다(result=3). 키 값을 확인.",
  },
  quota: {
    text: "FX API daily limit reached",
    hint: "수출입은행 API 일일 호출 한도를 넘겼다(result=4). 내일 다시 조회된다.",
  },
  network: {
    text: "FX lookup failed",
    hint: "수출입은행 API 요청이 실패했다(타임아웃·SSL·DNS 등).",
  },
  data_code: {
    text: "FX lookup failed",
    hint: "요청 DATA 코드 오류(result=2) — 서버 코드 문제.",
  },
  no_data: {
    text: "No published rate",
    hint: "그 날짜의 고시가 없다(주말·공휴일·오전 고시 전).",
  },
};
// reason 자체가 없으면 백엔드가 아직 옛 버전 — 사유를 구분해 보내주지 않는다.
const FX_FALLBACK_UNKNOWN = {
  text: "Rate lookup unavailable",
  hint: "백엔드가 조회 실패 사유를 보내지 않는다 — API 서버가 아직 이전 버전일 수 있다.",
};

const fmtRate = (v: number) =>
  v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 오늘 날짜 "YYYY-MM-DD" (로컬 기준). */
function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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

  const load = useCallback(
    (d: string) => {
      lastFetch.current = `${d}|${cur}`;
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
    },
    [cur]
  );

  // 고시 조회는 모드와 무관하게 날짜·통화가 바뀔 때만.
  useEffect(() => {
    const d = (date || "").slice(0, 10);
    if (lastFetch.current === `${d}|${cur}`) return;
    load(d);
  }, [date, cur, load]);

  // 문서 날짜가 며칠 지난 뒤 열면 참고줄도 그날 고시에 머문다 — 지금 시세를 확인해야
  // 할 때 눌러 오늘자 고시로 갈아끼운다. 매매기준율 모드면 값도 함께 따라간다.
  const stale = ref !== null && ref.date !== todayLocal();

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
          (() => {
            const f = (ref.reason && FX_FALLBACK[ref.reason]) || FX_FALLBACK_UNKNOWN;
            return (
              <span className="fx-ref-note" title={f.hint}>
                {f.text} · fixed {fmtRate(ref.base)}
              </span>
            );
          })()
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
        <button
          type="button"
          className={`fx-ref-refresh${stale ? " stale" : ""}`}
          onClick={() => load(todayLocal())}
          disabled={loading}
          title={
            stale
              ? `Look up today's published rate (${todayLocal()}) instead of ${ref?.date}`
              : "Look up today's published rate again"
          }
        >
          Update
        </button>
      </div>
    </div>
  );
}
