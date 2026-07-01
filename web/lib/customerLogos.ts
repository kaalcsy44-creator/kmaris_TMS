"use client";

// 고객사 로고를 "고객명 → 로고(data URL)" 맵으로 한 번만 로드해 모듈 레벨에 캐시한다.
// 모든 목록 화면의 Customer 컬럼(CustomerName)이 이 캐시를 공유하므로, 리스트 API를
// 건드리지 않고도 고객명 옆에 로고를 표시할 수 있다.
import { useEffect, useState } from "react";
import { fetchCustomers } from "./api";

let cache: Map<string, string> | null = null;
let inflight: Promise<Map<string, string>> | null = null;
const subscribers = new Set<() => void>();

function buildMap(customers: { name: string; logo?: string }[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of customers) {
    // 같은 고객명이 담당자별로 여러 레코드일 수 있다 — 로고가 있는 첫 레코드를 채택.
    if (c.logo && !m.get(c.name)) m.set(c.name, c.logo);
  }
  return m;
}

export function loadCustomerLogos(force = false): Promise<Map<string, string>> {
  if (cache && !force) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = fetchCustomers()
    .then((cs) => {
      cache = buildMap(cs);
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

/** 고객 로고 편집 후 캐시를 다시 읽어 목록 표시를 갱신. */
export function invalidateCustomerLogos() {
  cache = null;
  loadCustomerLogos(true);
}

/** 고객명 → 로고(data URL) 조회 함수. 캐시가 채워지면 자동 리렌더된다. */
export function useCustomerLogo(): (name: string) => string | undefined {
  const [, bump] = useState(0);
  useEffect(() => {
    const rerender = () => bump((n) => n + 1);
    subscribers.add(rerender);
    if (!cache) loadCustomerLogos();
    return () => {
      subscribers.delete(rerender);
    };
  }, []);
  return (name: string) => (name ? cache?.get(name) : undefined);
}
