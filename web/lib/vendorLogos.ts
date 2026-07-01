"use client";

// 벤더 로고를 "벤더명 → 로고(data URL)" 맵으로 한 번만 로드해 모듈 레벨에 캐시한다.
// 모든 목록 화면의 Vendor 컬럼(VendorName)이 이 캐시를 공유한다. (customerLogos 미러)
import { useEffect, useState } from "react";
import { fetchVendors } from "./api";

let cache: Map<string, string> | null = null;
let inflight: Promise<Map<string, string>> | null = null;
const subscribers = new Set<() => void>();

function buildMap(vendors: { name: string; logo?: string }[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const v of vendors) {
    if (v.logo && !m.get(v.name)) m.set(v.name, v.logo);
  }
  return m;
}

export function loadVendorLogos(force = false): Promise<Map<string, string>> {
  if (cache && !force) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = fetchVendors()
    .then((vs) => {
      cache = buildMap(vs);
      inflight = null;
      subscribers.forEach((fn) => fn());
      return cache;
    })
    .catch(() => {
      inflight = null;
      cache = cache ?? new Map();
      return cache;
    });
  return inflight;
}

/** 벤더 로고 편집 후 캐시를 다시 읽어 목록 표시를 갱신. */
export function invalidateVendorLogos() {
  cache = null;
  loadVendorLogos(true);
}

/** 벤더명 → 로고(data URL) 조회 함수. 캐시가 채워지면 자동 리렌더된다. */
export function useVendorLogo(): (name: string) => string | undefined {
  const [, bump] = useState(0);
  useEffect(() => {
    const rerender = () => bump((n) => n + 1);
    subscribers.add(rerender);
    if (!cache) loadVendorLogos();
    return () => {
      subscribers.delete(rerender);
    };
  }, []);
  return (name: string) => (name ? cache?.get(name) : undefined);
}
