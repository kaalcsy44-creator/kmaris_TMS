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

export type CategoryOption = {
  id: number;
  path: string;
  depth: number;
  /** 이 노드가 달린 대분류(1층) id — 용역인지 선박 계통인지를 가르는 데 쓴다. */
  rootId: number;
  /** 그 대분류 이름(대문자). 이름이 바뀌어도 트리가 무너지지 않게 이름으로만 판별한다. */
  rootName: string;
};

/**
 * 용역 대분류의 이름. Ship View 의 BERTH 와 같은 방식이다 — 아는 이름은 알아보고,
 * 모르는 이름은 그냥 선박 계통으로 둔다(관리자가 트리를 고쳐도 화면이 무너지지 않는다).
 */
const SERVICE_ROOT = "SERVICE";

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
  const walk = (pid: number | null, prefix: string, depth: number, root: CategoryOption | null) => {
    if (depth > 3) return;
    for (const c of childrenOf(pid)) {
      const path = prefix ? `${prefix} > ${c.name}` : c.name;
      const opt: CategoryOption = {
        id: c.id,
        path,
        depth,
        rootId: root?.rootId ?? c.id,
        rootName: root?.rootName ?? (c.name || "").trim().toUpperCase(),
      };
      out.push(opt);
      walk(c.id, path, depth + 1, root ?? opt);
    }
  };
  walk(null, "", 1, null);
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

/**
 * 품목표 셀용 분류 선택. 라인에 저장된 값이 없으면 품목 마스터의 분류를 보여준다.
 *
 * 용역 줄은 칸이 하나로는 모자란다. 'Repair & Overhaul' 은 무엇을 했는가일 뿐이고,
 * 어디에 했는가(주기관 피스톤인지 갑판 크레인 호이스트인지)는 건마다 다르다. 그래서
 * 고른 분류가 용역 밑이면 그 아래로 '부위' 칸이 한 줄 더 열린다 — 늘 두 칸을 벌려
 * 두면 부품 줄에서는 쓰지 않을 칸이 표를 넓히기만 한다.
 *
 * 부위는 품목 마스터로 올리지 않는다. 마스터는 품목 하나에 값 하나인데 부위는 건마다
 * 달라서, 올리면 마지막 저장이 앞 건의 부위를 덮어 쓴다. 라인에만 남는다.
 */
export default function CategoryCell({
  value,
  onChange,
  appliedTo,
  onAppliedToChange,
  partNo,
  description,
  disabled,
}: {
  /** 이 라인에 저장된 분류. null/undefined 면 마스터 분류로 대체 표시. */
  value: number | null | undefined;
  onChange: (id: number | null) => void;
  /** 용역이 닿은 선박 계통(라인 전용). 넘기지 않으면 부위 칸은 아예 뜨지 않는다. */
  appliedTo?: number | null;
  onAppliedToChange?: (id: number | null) => void;
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
  // 용역 줄인가 — 고른 분류가 용역 대분류 밑이면. 부위 칸은 그때만 연다.
  const isService = hit?.rootName === SERVICE_ROOT;
  const showApplied = isService && !!onAppliedToChange;
  // 부위로 고를 수 있는 것은 배 위의 계통뿐이다(용역에 용역을 걸 수는 없다).
  const partOpts = opts.filter((o) => o.rootName !== SERVICE_ROOT);
  const appliedHit = appliedTo != null ? opts.find((o) => o.id === appliedTo) : undefined;

  const cat = (
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

  if (!showApplied) return cat;
  return (
    <div className="cat-cell-2">
      {cat}
      <select
        className="cat-cell cat-cell--applied"
        value={appliedTo != null ? String(appliedTo) : ""}
        disabled={disabled}
        title={appliedHit ? `Applied to ${appliedHit.path}` : "Where on board this service was done (optional)"}
        onChange={(e) => onAppliedToChange?.(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">on: —</option>
        {appliedTo != null && !appliedHit ? <option value={String(appliedTo)}>(#{appliedTo})</option> : null}
        {partOpts.map((o) => (
          <option key={o.id} value={o.id}>
            on: {o.path}
          </option>
        ))}
      </select>
    </div>
  );
}
