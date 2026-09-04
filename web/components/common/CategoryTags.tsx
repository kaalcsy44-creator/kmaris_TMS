"use client";

// 거래선이 다루는 품목 분류를 배지로 세운다 — 취급품목을 글이 아니라 트리의 자리로.
//
// 왜 배지인가. 취급품목은 지금까지 자유 문장이었고("Marine engine spares — MAN B&W,
// Wärtsilä, Yanmar"), 벤더 추천은 그 문장을 낱말로 쪼개 맞춰 왔다. 그런데 거의 모든
// 벤더가 'marine·spare'를 적어 두어 그 낱말들은 아무것도 가려내지 못한다 — 서버가
// df 로 흔한 말을 걸러내고 글귀 점수에 상한까지 걸어 둔 이유다(services/vendor_match).
// 트리의 자리로 적어 두면 그 보정이 필요 없어지고, 무엇보다 **분류에서 벤더를 되찾을
// 수 있다**(Ship View 가 그 방향으로 읽는다).
//
// 글을 대신하지는 않는다. 저 문장에는 트리에 없는 것 — 브랜드와 메이커 — 가 들어 있고,
// 벤더를 고르는 축의 절반이 그것이다. 배지와 글은 나란히 선다.
//
// 깊이는 중분류(2단계)까지다. 소분류까지 태그하면 벤더 하나가 스무 개를 달아 배지가
// 회사 이름을 덮는다. 소분류의 실적은 서버가 중분류로 접어 올린다(VENDOR_TAG_LEVEL).

import { useMemo } from "react";
import { useCategoryOptions, type CategoryOption } from "@/components/common/CategoryCell";
import TagPickMenu from "@/components/common/TagPickMenu";

/** 배지로 쓸 수 있는 분류만 — 대(1)·중(2)분류. 소분류는 너무 잘다. */
export function useVendorCategoryOptions(): CategoryOption[] {
  const all = useCategoryOptions();
  return useMemo(() => all.filter((o) => o.depth <= 2), [all]);
}

/** id → 옵션. 트리에서 사라진 id(분류를 지운 뒤 남은 태그)는 조용히 빠진다. */
function pick(options: CategoryOption[], ids: number[]): CategoryOption[] {
  const by = new Map(options.map((o) => [o.id, o]));
  return ids.map((id) => by.get(id)).filter((o): o is CategoryOption => !!o);
}

/** 배지에 적을 짧은 이름 — 경로의 마지막 마디. 전체 경로는 title 로 남는다. */
const leafOf = (path: string) => path.split(">").pop()?.trim() || path;

/**
 * 읽기용 배지 줄. 목록 칸·회사 정보 창·Ship View 가 함께 쓴다.
 * max 를 주면 그만큼만 세우고 나머지는 "+N" 으로 접는다(칸이 좁은 목록용).
 */
export function CategoryBadges({
  ids,
  max,
  empty = null,
}: {
  ids?: number[] | null;
  max?: number;
  empty?: React.ReactNode;
}) {
  const options = useVendorCategoryOptions();
  const picked = pick(options, ids ?? []);
  if (!picked.length) return <>{empty}</>;
  const shown = max ? picked.slice(0, max) : picked;
  const rest = picked.length - shown.length;
  return (
    <span className="cat-tags">
      {shown.map((o) => (
        <span key={o.id} className="cat-tag" title={o.path}>{leafOf(o.path)}</span>
      ))}
      {rest > 0 ? (
        <span className="cat-tag cat-tag--more" title={picked.slice(shown.length).map((o) => o.path).join("\n")}>
          +{rest}
        </span>
      ) : null}
    </span>
  );
}

/** 실적에서 뽑아 온 제안 한 줄 — 서버의 category-suggestions 행 그대로. */
export type CategorySuggestion = {
  id: number;
  path: string;
  kind: "bought" | "quoted" | string;
  count: number;
  last: string;
};

/**
 * 편집용 — 고른 배지(×로 뺀다) + 고르는 칸 + 실적에서 채우기.
 *
 * 처음부터 손으로 채우게 하면 아무도 안 채우고, 절반만 채워진 태그는 없느니만 못하다
 * (Ship View 가 "이 계통은 물어볼 데가 없다"고 잘못 말하게 된다). 그래서 장부에 이미
 * 있는 것 — 무엇을 샀고 무엇에 값을 받아 봤는지 — 를 첫 값으로 내민다.
 */
export function CategoryTagPicker({
  value,
  onChange,
  suggestions,
  disabled = false,
}: {
  value: number[];
  onChange: (next: number[]) => void;
  /** 이 회사의 실적 제안. 없으면 단추를 내밀지 않는다(누를 게 없다). */
  suggestions?: CategorySuggestion[];
  disabled?: boolean;
}) {
  const options = useVendorCategoryOptions();
  const picked = pick(options, value);
  const chosen = new Set(value);
  // 제안 중 아직 안 단 것. 이미 다 달았으면 단추를 흐리게 두지 않고 그 사실을 적는다.
  const fresh = (suggestions ?? []).filter((s) => !chosen.has(s.id));

  return (
    <div className="form-field cat-picker">
      <span>Item categories</span>
      <div className="cat-picker-tags">
        {picked.length ? picked.map((o) => (
          <span key={o.id} className="cat-tag cat-tag--edit" title={o.path}>
            {leafOf(o.path)}
            {disabled ? null : (
              <button type="button" aria-label={`Remove ${o.path}`}
                      onClick={() => onChange(value.filter((v) => v !== o.id))}>×</button>
            )}
          </span>
        )) : <span className="hint-inline">Not tagged yet.</span>}
      </div>
      {disabled ? null : (
        <div className="cat-picker-add">
          {/* 한 번에 여러 개. 분류는 한 회사에 서너 개가 보통이라, 고를 때마다 목록이
              닫히면 같은 트리를 그 횟수만큼 다시 훑게 된다. */}
          <TagPickMenu
            label="— Add categories —"
            options={options.map((o) => ({ id: o.id, name: o.path }))}
            value={value}
            onChange={onChange}
          />
          {suggestions?.length ? (
            <button
              type="button"
              className="btn sm"
              disabled={!fresh.length}
              title={fresh.length
                ? fresh.map((s) => `${s.path} — ${s.kind === "bought" ? "bought" : "quoted"} ×${s.count}`).join("\n")
                : "Everything we have traded is already tagged"}
              onClick={() => {
                const merged = new Set([...value, ...fresh.map((s) => s.id)]);
                onChange(options.filter((o) => merged.has(o.id)).map((o) => o.id));
              }}
            >
              {fresh.length ? `Fill from history (${fresh.length})` : "Nothing new in history"}
            </button>
          ) : null}
        </div>
      )}
      <span className="hint-inline">
        What this company actually deals in — used to suggest vendors for an RFQ and to show them on Ship View.
        Brands and makers belong in Specialization below; the tree has no place for them.
      </span>
    </div>
  );
}
