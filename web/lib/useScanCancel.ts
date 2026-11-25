"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 자동 입력(문서 AI 분석)을 중간에 멈추기 — 여러 파일을 차례로 읽는 화면들이 같이 쓴다.
 * begin() 이 준 signal 을 분석 요청에 넘기고, cancel() 을 부르면 기다리던 요청을 끊는다.
 * 창이 닫히면(언마운트) 저절로 끊긴다. 먼저 끝난 파일의 결과를 남길지는 화면이 정한다.
 */
export function useScanCancel() {
  // 분석 중에 캡처를 또 붙여넣으면 둘이 나란히 돈다 — 서로 끊지 않고, 취소는 전부 멈춘다.
  const running = useRef(new Set<AbortController>());
  const [active, setActive] = useState(false);
  const cancel = useCallback(() => running.current.forEach((c) => c.abort()), []);
  useEffect(() => cancel, [cancel]);
  const begin = useCallback((): AbortSignal => {
    const c = new AbortController();
    running.current.add(c);
    setActive(true);
    return c.signal;
  }, []);
  /** 이 분석이 끝났다 — 아직 도는 것이 있으면 true. */
  const end = useCallback((signal: AbortSignal): boolean => {
    running.current.forEach((c) => { if (c.signal === signal) running.current.delete(c); });
    setActive(running.current.size > 0);
    return running.current.size > 0;
  }, []);
  return { active, begin, end, cancel };
}

/** 분석 결과 — 취소됐으면 null(오류가 아니다). 다른 실패는 그대로 던진다. */
export async function orCancelled<T>(job: Promise<T>, signal: AbortSignal): Promise<T | null> {
  try {
    const r = await job;
    return signal.aborted ? null : r;
  } catch (e) {
    if (signal.aborted) return null;
    throw e;
  }
}
