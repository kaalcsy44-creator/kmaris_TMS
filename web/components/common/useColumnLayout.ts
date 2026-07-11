"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// 테이블 컬럼 커스터마이즈(폭 조절·순서 변경·표시/숨김)를 관리하는 공용 훅.
// 설정은 localStorage 에 tableId 별로 저장되어 새로고침 후에도 유지된다.
// FilterTable 과 ProgressScreen 의 PipelineTable 이 함께 사용한다.

export type LayoutCol = { key: string; label: string };

export type ColumnLayout = {
  /** 화면에 표시할 컬럼 key(순서 반영, 숨김 제외). */
  visibleKeys: string[];
  /** 전체 컬럼 key 의 현재 순서(숨김 포함). */
  order: string[];
  /** key → 폭(px). 미설정이면 undefined(=CSS 기본폭). */
  widths: Record<string, number>;
  hidden: Set<string>;
  /** 드래그 중 실시간 폭 반영(상태만 갱신, localStorage 저장 안 함). */
  setWidth: (key: string, px: number) => void;
  /** 드래그 종료 시 현재 폭을 localStorage 에 한 번만 저장. */
  commitWidths: () => void;
  /** order 상의 위치를 from → to 로 이동(숨김 포함 전체 기준). */
  moveKey: (fromKey: string, toKey: string) => void;
  toggleHidden: (key: string) => void;
  reset: () => void;
  /** 사용자가 한 번이라도 커스터마이즈했는지(리셋 버튼 노출용). */
  customized: boolean;
};

type Stored = {
  order?: string[];
  widths?: Record<string, number>;
  hidden?: string[];
};

const KEY_PREFIX = "ktms.tableLayout.";
const MIN_W = 60;
const MAX_W = 900;

function load(tableId: string): Stored {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + tableId);
    return raw ? (JSON.parse(raw) as Stored) : {};
  } catch {
    return {};
  }
}

function save(tableId: string, data: Stored) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY_PREFIX + tableId, JSON.stringify(data));
  } catch {
    /* quota/private mode — 무시 */
  }
}

/** 저장된 order 를 현재 컬럼 집합에 맞춰 정합화: 사라진 key 제거, 새 key 는 코드 순서대로 추가. */
function reconcileOrder(stored: string[] | undefined, cols: LayoutCol[]): string[] {
  const codeKeys = cols.map((c) => c.key);
  if (!stored || stored.length === 0) return codeKeys;
  const codeSet = new Set(codeKeys);
  const kept = stored.filter((k) => codeSet.has(k));
  const keptSet = new Set(kept);
  // kept 를 기준선으로 두고, 코드에 새로 생긴 컬럼을 코드 인덱스 위치에 맞게 끼워 넣는다.
  const result: string[] = [...kept];
  codeKeys.forEach((k) => {
    if (keptSet.has(k)) return;
    const idx = codeKeys.indexOf(k);
    // idx 이전의 코드 컬럼 중 kept 에 있는 마지막 것을 찾아 그 뒤에 삽입
    let insertAt = result.length;
    for (let j = idx - 1; j >= 0; j--) {
      const prev = codeKeys[j];
      const pos = result.indexOf(prev);
      if (pos >= 0) {
        insertAt = pos + 1;
        break;
      }
      if (j === 0) insertAt = 0;
    }
    result.splice(insertAt, 0, k);
  });
  return result;
}

export function useColumnLayout(tableId: string, cols: LayoutCol[]): ColumnLayout {
  // 컬럼 key 시그니처 — 코드상 컬럼 구성이 바뀌면 정합화를 다시 수행한다.
  const colSig = cols.map((c) => c.key).join("|");

  // SSR/하이드레이션 불일치 방지: 초기엔 코드 기본값으로 렌더하고,
  // 마운트 후 useEffect 에서 localStorage 저장값을 적용한다.
  const [order, setOrder] = useState<string[]>(() => cols.map((c) => c.key));
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [customized, setCustomized] = useState<boolean>(false);

  // 마운트 시 + 코드 컬럼 구성/ tableId 변경 시 저장값을 로드·재정합.
  useEffect(() => {
    const stored = load(tableId);
    setOrder(reconcileOrder(stored.order, cols));
    setWidths(stored.widths ?? {});
    setHidden(new Set(stored.hidden ?? []));
    setCustomized(!!(stored.order || stored.widths || stored.hidden));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId, colSig]);

  const persist = useCallback(
    (next: Partial<Stored>) => {
      const cur = load(tableId);
      save(tableId, { ...cur, ...next });
      setCustomized(true);
    },
    [tableId]
  );

  const setWidth = useCallback((key: string, px: number) => {
    const w = Math.max(MIN_W, Math.min(MAX_W, Math.round(px)));
    // 드래그 중엔 상태만 갱신(리렌더는 rAF 로 스로틀됨). localStorage 저장은 commitWidths 에서.
    setWidths((prev) => (prev[key] === w ? prev : { ...prev, [key]: w }));
  }, []);

  const commitWidths = useCallback(() => {
    // 현재 폭을 저장만 하고 상태는 그대로(같은 참조 반환 → 리렌더 없음).
    setWidths((prev) => {
      persist({ widths: prev });
      return prev;
    });
  }, [persist]);

  const moveKey = useCallback(
    (fromKey: string, toKey: string) => {
      if (fromKey === toKey) return;
      setOrder((prev) => {
        const from = prev.indexOf(fromKey);
        const to = prev.indexOf(toKey);
        if (from < 0 || to < 0) return prev;
        const next = [...prev];
        next.splice(from, 1);
        next.splice(to, 0, fromKey);
        persist({ order: next });
        return next;
      });
    },
    [persist]
  );

  const toggleHidden = useCallback(
    (key: string) => {
      setHidden((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        persist({ hidden: [...next] });
        return next;
      });
    },
    [persist]
  );

  const reset = useCallback(() => {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(KEY_PREFIX + tableId);
      } catch {
        /* 무시 */
      }
    }
    setOrder(cols.map((c) => c.key));
    setWidths({});
    setHidden(new Set());
    setCustomized(false);
  }, [tableId, cols]);

  const visibleKeys = useMemo(
    () => order.filter((k) => !hidden.has(k)),
    [order, hidden]
  );

  return {
    visibleKeys,
    order,
    widths,
    hidden,
    setWidth,
    commitWidths,
    moveKey,
    toggleHidden,
    reset,
    customized,
  };
}
