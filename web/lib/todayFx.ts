"use client";

import { useEffect, useState } from "react";
import { fetchFxRate } from "@/lib/api";
import { setUsdKrwRate } from "@/components/common/itemTable";

// 오늘자 USD 매매기준율을 화면 전체의 기본 환율(USD_KRW_RATE)로 올린다.
// 저장된 환율이 없는 화면(5단계 이후 문서·AR·재무 등)은 모두 이 값을 쓴다.
// 하루 한 번만 묻는다 — 받은 값은 localStorage 에 날짜와 함께 두고, 같은 날이면 바로 쓴다.
const KEY = "ktms.fx.usdkrw";

function todayLocal(): string {
  return new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD (현지 = KST)
}

function readStored(): { day: string; rate: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null");
    return v && typeof v.rate === "number" && v.rate > 0 ? v : null;
  } catch {
    return null;
  }
}

let fresh = false; // 이 탭에서 오늘 값이 이미 올라갔나
if (typeof window !== "undefined") {
  const st = readStored();
  if (st) {
    setUsdKrwRate(st.rate); // 어제 값이라도 고정값보다는 낫다 — 곧 오늘 값으로 바뀐다
    fresh = st.day === todayLocal();
  }
}

/** 앱 셸에서 한 번 부른다. 오늘 값이 올라갈 때까지(최대 2.5초) false — 그동안 화면을 띄우지
 *  않아야 첫 화면이 고정값으로 계산됐다가 숫자가 바뀌는 일이 없다. 조회 실패면 그냥 연다. */
export function useTodayFxReady(): boolean {
  const [ready, setReady] = useState(fresh);
  useEffect(() => {
    if (fresh) return;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      fresh = true;
      setReady(true);
    };
    const timer = setTimeout(finish, 2500);
    fetchFxRate(todayLocal(), "USD")
      .then((r) => {
        // source=fixed 는 조회 실패의 폴백값이다 — 올리지 않는다.
        if (r.source === "exim" && r.rate > 0) {
          const rate = r.rate / (r.unit || 1);
          setUsdKrwRate(rate);
          try {
            localStorage.setItem(KEY, JSON.stringify({ day: todayLocal(), rate }));
          } catch {
            /* 저장 못 해도 이번 탭은 값이 올라갔다 */
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        finish();
      });
  }, []);
  return ready;
}
