"use client";

import { fetchItemCategories, fetchItemCategoryMap } from "@/lib/api";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import type { ItemCategory } from "@/lib/types";

// 품목표(RFQ·견적·발주) 셀에서 쓰는 한 칸짜리 분류 선택.
// 설정의 CategoryPicker(대>중>소 3단 캐스케이드)는 표 셀에 넣기엔 너무 넓으므로,
// 활성 분류 전체를 "대 > 중 > 소" 경로 한 줄로 펼친 select 하나로 대체한다.
// 값은 설정 화면과 같은 규칙 — 가장 깊게 고른 노드의 id(대만 고르면 대 id).
//
// 분류의 정본은 품목 마스터(item_master.category_id)다. 그래서 이 셀은 양방향으로 붙는다.
//   · Item > Category 에서 배정 → 품목 식별키로 마스터 분류를 찾아 여기 그대로 보인다.
//   · 여기서 고르고 문서를 저장 → 백엔드가 마스터 분류로 반영한다
//     (services/item_ledger.apply_line_categories).
// 입력은 선택 사항이다 — 비워 두면 아무 것도 하지 않는다.

export type CategoryOption = { id: number; path: string; depth: number };

/** 품목 식별키 — 백엔드 services.item_ledger.match_key 와 같은 규칙이어야 한다. */
export function itemMatchKey(partNo?: string | null, description?: string | null): string {
  const norm = (v?: string | null) => (v ?? "").replace(/\s+/g, " ").trim().toUpperCase();
  const pk = norm(partNo);
  if (pk) return `P:${pk}`;
  const dk = norm(description);
  return dk ? `D:${dk}` : "";
}

/** 트리를 정렬 순서대로 훑어 "대 > 중 > 소" 경로 옵션 목록으로 펼친다. 활성 노드만. */
export function useCategoryOptions(): CategoryOption[] {
  // 분류 트리는 자주 바뀌지 않으므로 캐시를 길게 잡아 편집기마다 재요청하지 않는다.
  const { data } = useCachedData("item-categories", fetchItemCategories, 300_000);
  const cats: ItemCategory[] = data ?? [];
  const out: CategoryOption[] = [];
  const childrenOf = (pid: number | null) =>
    cats
      .filter((c) => (c.parent_id ?? null) === pid && c.active)
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  const walk = (pid: number | null, prefix: string, depth: number) => {
    if (depth > 3) return;
    for (const c of childrenOf(pid)) {
      const path = prefix ? `${prefix} > ${c.name}` : c.name;
      out.push({ id: c.id, path, depth });
      walk(c.id, path, depth + 1);
    }
  };
  walk(null, "", 1);
  return out;
}

/** 품목 마스터의 현재 분류(식별키 → category_id). 마스터 쪽 변경이 품목표에 비치는 경로. */
export function useMasterCategory(): (partNo?: string | null, desc?: string | null) => number | null {
  // 마스터 분류는 다른 화면(Item > Category)에서 바뀔 수 있어 캐시를 짧게 둔다.
  const { data } = useCachedData("item-category-map", fetchItemCategoryMap, 30_000);
  return (partNo, desc) => {
    const key = itemMatchKey(partNo, desc);
    if (!key || !data) return null;
    return data[key]?.category_id ?? null;
  };
}

/** Item > Category 에서 분류를 바꾼 뒤 호출 — 품목표가 다음 조회에서 새 분류를 읽는다. */
export function invalidateMasterCategories(): void {
  invalidateCache("item-category-map");
}

/** 품목표 셀용 분류 선택. 라인에 저장된 값이 없으면 품목 마스터의 분류를 보여준다. */
export default function CategoryCell({
  value,
  onChange,
  partNo,
  description,
  disabled,
}: {
  /** 이 라인에 저장된 분류. null/undefined 면 마스터 분류로 대체 표시. */
  value: number | null | undefined;
  onChange: (id: number | null) => void;
  /** 마스터 분류를 찾는 식별키 재료(품목표의 Part No.·Description 셀 값). */
  partNo?: string | null;
  description?: string | null;
  disabled?: boolean;
}) {
  const opts = useCategoryOptions();
  const masterCategory = useMasterCategory();
  // 라인 값이 우선, 없으면 마스터 분류(= Item > Category 에서 배정한 값).
  const effective = value ?? masterCategory(partNo, description);
  const hit = effective != null ? opts.find((o) => o.id === effective) : undefined;
  const inherited = value == null && effective != null;
  return (
    <select
      className={`cat-cell${inherited ? " inherited" : ""}`}
      value={effective != null ? String(effective) : ""}
      disabled={disabled}
      // 셀이 좁아 경로가 잘려도 무엇이 선택됐는지 알 수 있게 툴팁으로 전체 경로를 보여준다.
      title={
        hit
          ? inherited
            ? `${hit.path} — from Item Master`
            : hit.path
          : "Category (optional)"
      }
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
    >
      <option value="">—</option>
      {/* 삭제·비활성된 분류가 저장돼 있으면 값이 조용히 사라지지 않게 자리를 남긴다. */}
      {effective != null && !hit ? <option value={String(effective)}>(#{effective})</option> : null}
      {opts.map((o) => (
        <option key={o.id} value={o.id}>
          {o.path}
        </option>
      ))}
    </select>
  );
}
