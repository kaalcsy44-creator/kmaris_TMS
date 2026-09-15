"use client";

// 대리점(Agency) 고르기 — 이 제조사를 대 주는 거래선.
//
// 값이 사는 자리는 거래선의 'Makers supplied'(Vendor.maker_ids)다. 여기서 새로 적는
// 것이 아니라 **그 칸을 반대쪽에서 고칠** 뿐이다 — 같은 사실을 두 군데 적어 두면
// 어긋나는 날이 오고, 그때 어느 쪽이 맞는지 아무도 모른다.
//
// 그런데 묻는 방향이 반대라 답도 다른 것이 된다. 거래선 쪽에서는 "이 회사가 누구 것을
// 대 주나"이고, 메이커 쪽에서는 "이 브랜드는 어디서 사나"다. 알게 되는 순간도 대개
// 뒤쪽이다 — 메이커를 들여다보다 "아, 여기는 저 회사가 대 주지" 하고 떠오른다. 그때
// 거래선 명부로 건너가 그 회사를 찾아 태그를 고쳐야 했다.
//
// 고르는 단위는 회사다. 거래선도 레코드 1건 = 담당자 1명이라 담당자가 셋인 회사는 세
// 줄인데, 대리점을 고를 때 찾는 것은 사람이 아니라 회사다.

import { useMemo } from "react";
import TagPickMenu from "@/components/common/TagPickMenu";
import { fetchSettingsVendors } from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";
import type { SettingsVendor } from "@/lib/types";

/** 이름 비교용 — 대소문자·군더더기 공백·구두점을 지운다(MakerCell 의 norm 과 같은 뜻). */
function norm(v: string): string {
  return (v || "").replace(/[^0-9a-z가-힣]+/gi, " ").trim().toLowerCase().replace(/\s+/g, " ");
}

/** 회사 한 곳당 한 줄인 거래선 목록(로고·지역은 비어 있지 않은 줄에서 끌어올린다). */
export function useVendorCompanies(): SettingsVendor[] {
  const { data } = useCachedData("settings-vendors", fetchSettingsVendors, 300_000);
  return useMemo(() => {
    const byName = new Map<string, SettingsVendor>();
    for (const v of data ?? []) {
      const key = norm(v.name || "");
      if (!key) continue;
      const seen = byName.get(key);
      if (!seen) {
        byName.set(key, v);
        continue;
      }
      byName.set(key, { ...seen, logo: seen.logo || v.logo, country: seen.country || v.country });
    }
    return [...byName.values()];
  }, [data]);
}

/** 읽기용 배지 줄 — 대리점 이름을 로고와 함께 세운다(명부에 없는 이름도 글자로 남긴다). */
export function AgencyBadges({ names }: { names: string[] }) {
  const companies = useVendorCompanies();
  const byName = useMemo(
    () => new Map(companies.map((v) => [norm(v.name || ""), v])),
    [companies],
  );
  if (!names.length) return null;
  return (
    <span className="mk-tags">
      {names.map((n) => {
        const co = byName.get(norm(n));
        return (
          <span key={n} className="mk-tag" title={`${n} — supplies this maker`}>
            {co?.logo ? <img className="mk-tag-logo" src={co.logo} alt="" /> : null}
            {co?.name || n}
          </span>
        );
      })}
    </span>
  );
}

/**
 * 고치는 자리. 값은 거래선 **회사 이름**의 목록이다 — id 가 아니다.
 *
 * id 로 들지 않는 까닭: 거래선 한 회사가 여러 줄이라 어느 줄의 id 인지가 뜻이 없고,
 * 서버도 이름으로 그 회사의 줄 전부에 같이 적는다(회사 정보 창의 규약 그대로).
 * 메뉴만은 id 로 고르게 되어 있어(TagPickMenu) 대표 줄의 id 로 오갈 뿐이다.
 */
export function AgencyTagPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const companies = useVendorCompanies();
  const byName = useMemo(
    () => new Map(companies.map((v) => [norm(v.name || ""), v])),
    [companies],
  );
  // 명부에서 찾은 것은 명부의 표기로, 못 찾은 것은 적힌 그대로 — 지우지 않는다.
  // 거래선을 지웠거나 이름을 바꿔 짝을 잃은 값이 조용히 사라지면, 사라졌다는 사실조차
  // 남지 않는다.
  const picked = value.map((n) => ({ name: byName.get(norm(n))?.name || n, raw: n }));
  const ids = picked
    .map((p) => byName.get(norm(p.raw))?.id)
    .filter((id): id is number => typeof id === "number");

  return (
    <div className="form-field cat-picker">
      <span>Agency</span>
      <div className="cat-picker-tags">
        {picked.length ? picked.map((p) => {
          const co = byName.get(norm(p.raw));
          return (
            <span key={p.raw} className="mk-tag mk-tag--edit" title={p.name}>
              {co?.logo ? <img className="mk-tag-logo" src={co.logo} alt="" /> : null}
              {p.name}
              {disabled ? null : (
                <button type="button" aria-label={`Remove ${p.name}`}
                        onClick={() => onChange(value.filter((v) => v !== p.raw))}>×</button>
              )}
            </span>
          );
        }) : <span className="hint-inline">No agency registered yet.</span>}
      </div>
      {disabled ? null : (
        <div className="cat-picker-add">
          <TagPickMenu
            label="— Add agencies —"
            options={companies.map((v) => ({
              id: v.id, name: v.name, sub: v.country || undefined, logo: v.logo || undefined,
            }))}
            value={ids}
            onChange={(next) => {
              // 메뉴가 돌려준 id 를 이름으로 되돌린다. 명부에 없어 id 가 없던 값은
              // 메뉴가 알지 못하므로 여기서 함께 지켜 준다.
              const byId = new Map(companies.map((v) => [v.id, v.name]));
              const chosen = next.map((id) => byId.get(id) || "").filter(Boolean);
              const orphans = value.filter((n) => !byName.has(norm(n)));
              onChange([...chosen, ...orphans]);
            }}
          />
        </div>
      )}
      <span className="hint-inline">
        Which of our vendors can supply this maker — the answer to “where do we buy this
        brand?”. This is the same value as the vendor’s “Makers supplied”, seen from the
        other side: saving here updates that tag on those vendors.
      </span>
    </div>
  );
}
