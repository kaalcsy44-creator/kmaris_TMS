"use client";

import { fetchItemCategories } from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";
import type { ItemCategory } from "@/lib/types";

// 품목표(RFQ·견적·발주) 셀에서 쓰는 한 칸짜리 분류 선택.
// 설정의 CategoryPicker(대>중>소 3단 캐스케이드)는 표 셀에 넣기엔 너무 넓으므로,
// 활성 분류 전체를 "대 > 중 > 소" 경로 한 줄로 펼친 select 하나로 대체한다.
// 값은 설정 화면과 같은 규칙 — 가장 깊게 고른 노드의 id(대만 고르면 대 id).
//
// 입력은 선택 사항이다. 비워 두면 저장 시 아무 것도 하지 않고, 고르면 문서 저장 시
// 백엔드가 그 분류를 품목 마스터에 반영한다(services/item_ledger.apply_line_categories).

export type CategoryOption = { id: number; path: string; depth: number };

/** 트리를 정렬 순서대로 훑어 "대 > 중 > 소" 경로 옵션 목록으로 펼친다. 활성 노드만. */
export function useCategoryOptions(): CategoryOption[] {
  // 분류는 자주 바뀌지 않으므로 캐시를 길게 잡아 편집기마다 재요청하지 않는다.
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

/** 품목표 셀용 분류 선택. 미선택(미분류)이 기본값. */
export default function CategoryCell({
  value,
  onChange,
  disabled,
}: {
  value: number | null | undefined;
  onChange: (id: number | null) => void;
  disabled?: boolean;
}) {
  const opts = useCategoryOptions();
  const hit = value != null ? opts.find((o) => o.id === value) : undefined;
  return (
    <select
      className="cat-cell"
      value={value != null ? String(value) : ""}
      disabled={disabled}
      // 셀이 좁아 경로가 잘려도 무엇이 선택됐는지 알 수 있게 툴팁으로 전체 경로를 보여준다.
      title={hit ? hit.path : "Category (optional)"}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
    >
      <option value="">—</option>
      {/* 삭제·비활성된 분류가 저장돼 있으면 값이 조용히 사라지지 않게 자리를 남긴다. */}
      {value != null && !hit ? <option value={String(value)}>(#{value})</option> : null}
      {opts.map((o) => (
        <option key={o.id} value={o.id}>
          {o.path}
        </option>
      ))}
    </select>
  );
}
