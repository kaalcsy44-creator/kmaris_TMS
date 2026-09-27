"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  /** 그 대분류의 K-MARIS 코드(EN·TS…). 새 트리에서는 이름보다 이 값이 안정적이다. */
  rootCode: string;
  /** part | service — 부품 트리와 용역 트리를 가르는 축(구 트리는 빈 값). */
  rootType: string;
};

/**
 * 용역 대분류의 이름 — 관리자가 코드 없이 만든 대분류를 알아보는 마지막 수단이다.
 * 정본은 대분류가 들고 있는 tree_type 이고(K-MARIS TS·TR), 그것이 없을 때만 이름을 본다.
 */
const SERVICE_ROOT = "SERVICE";

/** 이 옵션이 용역인가 — 새 트리는 대분류가 그렇다고 말해 주고(tree_type), 구 트리는
 *  이름이 'Service' 인 대분류가 그 자리였다. 둘 다 본다(전환 중에는 둘이 함께 선다). */
export function isServiceOption(o: { rootType?: string; rootName?: string }): boolean {
  return o.rootType === "service" || (o.rootName || "") === SERVICE_ROOT;
}

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
        rootCode: root?.rootCode ?? (c.code || "").trim().toUpperCase(),
        rootType: root?.rootType ?? (c.tree_type || ""),
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
  const isService = !!hit && isServiceOption(hit);
  const showApplied = isService && !!onAppliedToChange;
  // 부위로 고를 수 있는 것은 배 위의 계통뿐이다(용역에 용역을 걸 수는 없다).
  const partOpts = opts.filter((o) => !isServiceOption(o));
  const appliedHit = appliedTo != null ? opts.find((o) => o.id === appliedTo) : undefined;

  const cat = (
    <CategorySelect
      className={`cat-cell${inherited ? " inherited" : ""}`}
      options={opts}
      value={effective}
      disabled={disabled}
      // 셀이 좁아 경로가 잘려도 무엇이 선택됐는지 알 수 있게 툴팁으로 전체 경로를 보여준다.
      title={
        hit
          ? inherited
            ? `${hit.path} — from Item Master`
            : hit.path
          : "Category (optional)"
      }
      onChange={onChange}
    />
  );

  if (!showApplied) return cat;
  return (
    <div className="cat-cell-2">
      {cat}
      <CategorySelect
        className="cat-cell cat-cell--applied"
        options={partOpts}
        value={appliedTo ?? null}
        prefix="on: "
        disabled={disabled}
        title={appliedHit ? `Applied to ${appliedHit.path}` : "Where on board this service was done (optional)"}
        onChange={(id) => onAppliedToChange?.(id)}
      />
    </div>
  );
}

type MenuPos = { left: number; width: number; top?: number; bottom?: number };

/** 검색어의 낱말이 모두 경로 어딘가에 들어 있으면 걸린다 — "piston ring", "engine valve"
 *  처럼 대분류·부품 어느 쪽 이름으로 쳐도, 순서가 달라도 찾아진다. */
function matchCategory(path: string, q: string): boolean {
  const hay = path.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/**
 * 검색되는 분류 선택. 대분류×부품 150여 줄을 네이티브 <select> 로 펼치면 스크롤로 찾는
 * 수밖에 없어서, 누르면 맨 위에 검색칸이 달린 목록을 띄운다(치는 대로 좁혀지고 ↑↓·Enter
 * 로 고른다). 칸에 포커스가 있을 때 바로 글자를 쳐도 그 글자로 검색이 시작된다.
 * 메뉴는 MakerCell 과 같은 이유로 body 에 portal + fixed — 품목표가 스크롤 상자 안이라
 * 셀 안에 띄우면 잘린다.
 */
export function CategorySelect({
  options,
  value,
  onChange,
  className = "cat-cell",
  placeholder = "—",
  prefix = "",
  clearLabel = "— (none) —",
  title,
  disabled,
}: {
  options: CategoryOption[];
  value: number | null | undefined;
  onChange: (id: number | null) => void;
  className?: string;
  /** 값이 없을 때 칸에 보이는 글자. */
  placeholder?: string;
  /** 칸·옵션 앞에 붙는 머리말(용역 부위 칸의 "on: "). */
  prefix?: string;
  /** 비우기 줄의 글자. null 이면 비우기 줄을 두지 않는다. */
  clearLabel?: string | null;
  title?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const hit = value != null ? options.find((o) => o.id === value) : undefined;
  // 삭제·비활성된 분류가 저장돼 있으면 값이 조용히 사라지지 않게 id 라도 보인다.
  const label = value != null ? (hit ? hit.path : `(#${value})`) : "";

  const searching = !!q.trim();
  const list = searching ? options.filter((o) => matchCategory(o.path, q)) : options;
  // 키보드로 옮겨 다니는 줄: [비우기?, ...목록]. 검색 중에는 비우기 줄을 뺀다
  // (Enter 가 첫 결과를 고르도록).
  const rows: (CategoryOption | null)[] = clearLabel != null && !searching ? [null, ...list] : list;

  function reposition() {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const openUp = spaceBelow < 320 && r.top > spaceBelow;
    // 경로가 길어 셀 폭으로는 모자라다 — 메뉴는 넓게 펴되 화면 밖으로는 안 나가게.
    const width = Math.min(Math.max(r.width, 380), window.innerWidth - 16);
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
      width,
      top: openUp ? undefined : r.bottom + 3,
      bottom: openUp ? window.innerHeight - r.top + 3 : undefined,
    });
  }

  function openMenu(initial = "") {
    if (disabled) return;
    setQ(initial);
    // 열자마자 지금 고른 줄에 서 있게 한다(검색어로 열었으면 첫 결과).
    const idx = initial ? -1 : options.findIndex((o) => o.id === value);
    setActive(idx >= 0 ? idx + (clearLabel != null ? 1 : 0) : 0);
    reposition();
    setOpen(true);
  }

  function close(refocus = false) {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }

  function pick(o: CategoryOption | null) {
    onChange(o ? o.id : null);
    close(true);
  }

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    // 표를 밀거나 창 크기가 바뀌면 메뉴가 칸을 따라온다. 메뉴 안쪽 스크롤은 무시.
    function onShift(e: Event) {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      reposition();
    }
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onShift, true);
    window.addEventListener("resize", onShift);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onShift, true);
      window.removeEventListener("resize", onShift);
    };
  }, [open]);

  // 키로 옮긴 줄이 목록 밖으로 나가면 따라 스크롤한다.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`${className} cat-pick${value == null ? " empty" : ""}`}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openMenu();
          } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            openMenu(e.key);
          }
        }}
      >
        <span className="cat-pick-txt">{prefix}{label || placeholder}</span>
        <span className="cat-pick-caret" aria-hidden>▾</span>
      </button>

      {open && pos && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              className="mk-menu cat-menu"
              style={{ position: "fixed", left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom }}
            >
              <input
                className="cat-menu-search"
                autoFocus
                placeholder="Search category…"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setActive(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActive((a) => Math.min(a + 1, rows.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActive((a) => Math.max(a - 1, 0));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    if (rows.length) pick(rows[Math.min(active, rows.length - 1)]);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();   // 모달까지 닫히지 않게
                    close(true);
                  } else if (e.key === "Tab") {
                    close();
                  }
                }}
              />
              <ul className="mk-menu-list cat-menu-list" role="listbox" ref={listRef}>
                {rows.map((o, i) => {
                  const cut = o ? o.path.lastIndexOf(" > ") : -1;
                  return (
                    <li key={o ? o.id : "_clear"}>
                      <button
                        type="button"
                        data-idx={i}
                        tabIndex={-1}
                        role="option"
                        aria-selected={o ? o.id === value : value == null}
                        className={`mk-opt cat-opt${o ? "" : " mk-opt--clear"}${
                          o && o.id === value ? " on" : ""}${i === active ? " act" : ""}`}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => pick(o)}
                      >
                        {o ? (
                          <span className="mk-opt-name" title={o.path}>
                            {prefix}
                            {cut >= 0 ? (
                              <>
                                {/* 위 단계는 옅게 — 눈이 먼저 닿아야 하는 것은 끝 이름이다. */}
                                <span className="cat-opt-parent">{o.path.slice(0, cut + 3)}</span>
                                {o.path.slice(cut + 3)}
                              </>
                            ) : (
                              <b>{o.path}</b>
                            )}
                          </span>
                        ) : (
                          clearLabel
                        )}
                      </button>
                    </li>
                  );
                })}
                {list.length === 0 ? (
                  <li className="mk-menu-empty">No category matches “{q.trim()}”.</li>
                ) : null}
              </ul>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
