"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 경량 stale-while-revalidate 캐시 훅.
 *
 * 화면을 떠났다 돌아와도(컴포넌트 언마운트→재마운트) 모듈 레벨 캐시에 데이터가
 * 남아 있어, 재방문 시 "불러오는 중…" 없이 즉시 이전 데이터를 보여주고
 * 백그라운드에서 조용히 최신화한다. 같은 key 의 동시 요청은 dedup 한다.
 *
 * staleMs 안에 다시 마운트되면 네트워크 재요청을 생략한다(빠른 페이지 왕복 보호).
 * 데이터를 바꾸는 액션 뒤에는 refresh() 또는 invalidateCache(key) 를 호출한다.
 */

type Entry<T> = {
  data?: T;
  error?: Error;
  promise?: Promise<T>;
  ts?: number; // 마지막 성공 시각
};

const cache = new Map<string, Entry<unknown>>();

/** 캐시 무효화. prefix 가 없으면 전체, 있으면 key === prefix 또는 prefix 로 시작하는 항목 삭제. */
export function invalidateCache(prefix?: string) {
  if (!prefix) {
    cache.clear();
    return;
  }
  for (const k of Array.from(cache.keys())) {
    if (k === prefix || k.startsWith(prefix)) cache.delete(k);
  }
}

function toErr(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

export function useCachedData<T>(
  key: string,
  fetcher: () => Promise<T>,
  staleMs = 15_000
) {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const init = cache.get(key) as Entry<T> | undefined;
  const [data, setData] = useState<T | undefined>(init?.data);
  const [error, setError] = useState<Error | null>(init?.error ?? null);
  const [loading, setLoading] = useState<boolean>(init?.data === undefined);

  const run = useCallback(
    (force: boolean): Promise<T> => {
      const cur = cache.get(key) as Entry<T> | undefined;
      // 충분히 신선하면 재요청 생략
      if (
        !force &&
        cur?.data !== undefined &&
        cur.ts &&
        Date.now() - cur.ts < staleMs
      ) {
        return Promise.resolve(cur.data);
      }
      // 진행 중 요청 dedup (강제 새로고침이면 새 요청)
      let p = cur?.promise;
      if (!p || force) {
        p = fetcherRef.current();
        cache.set(key, { ...(cur ?? {}), promise: p });
        p.then(
          (d) => cache.set(key, { data: d, ts: Date.now() }),
          (e) =>
            cache.set(key, {
              ...((cache.get(key) as Entry<T>) ?? {}),
              error: toErr(e),
              promise: undefined,
            })
        );
      }
      return p;
    },
    [key, staleMs]
  );

  useEffect(() => {
    let alive = true;
    const cur = cache.get(key) as Entry<T> | undefined;
    setData(cur?.data);
    setError(cur?.error ?? null);
    setLoading(cur?.data === undefined);
    run(false).then(
      (d) => {
        if (alive) {
          setData(d);
          setError(null);
          setLoading(false);
        }
      },
      (e) => {
        if (alive) {
          setError(toErr(e));
          setLoading(false);
        }
      }
    );
    return () => {
      alive = false;
    };
  }, [key, run]);

  const refresh = useCallback((): Promise<T> => {
    setLoading(true);
    return run(true).then(
      (d) => {
        setData(d);
        setError(null);
        setLoading(false);
        return d;
      },
      (e) => {
        setError(toErr(e));
        setLoading(false);
        throw e;
      }
    );
  }, [run]);

  return { data, error, loading, refresh };
}
