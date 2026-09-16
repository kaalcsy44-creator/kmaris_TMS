"use client";

// 지역(Region) 고르기 — 고객·거래선·제조사가 모두 같은 칸을 쓴다.
//
// 그전에는 빈 칸에 아무렇게나 적었다. 그래서 같은 곳이 "Korea"·"KOREA"·"South Korea"·
// "대한민국" 넷으로 갈렸고, 목록 머리의 지역 필터는 그 넷을 다른 곳으로 셌다.
// 여기서는 토글을 눌러 고르게 하되, **목록에 없는 값도 그대로 적을 수 있게** 둔다 —
// "Gimhae-si, Korea" 처럼 나라보다 잘게 적어 둔 것이 이미 많고, 그것이 틀린 것도 아니다.
//
// 목록은 두 묶음이다.
//   1. Already used — 이 명부들에 이미 적혀 있는 지역. 많이 쓴 것부터.
//      새로 적는 곳도 대개 이미 거래하던 곳이라, 첫 화면에서 끝나는 쪽이 맞다.
//   2. Countries — 나머지 나라. 처음 가는 곳일 때만 여기까지 내려간다.

import { useMemo } from "react";
import ComboBox, { type ComboSection } from "@/components/common/ComboBox";
import { fetchSettingsCustomers, fetchSettingsMakers, fetchSettingsVendors } from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";

/** 나라 이름(영문). 이미 적어 둔 지역과 겹치는 것은 아래 묶음에서 빠진다. */
export const COUNTRIES: readonly string[] = [
  "Afghanistan", "Albania", "Algeria", "Angola", "Argentina", "Armenia", "Australia", "Austria",
  "Azerbaijan", "Bahamas", "Bahrain", "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize",
  "Benin", "Bermuda", "Bolivia", "Bosnia and Herzegovina", "Botswana", "Brazil", "Brunei",
  "Bulgaria", "Cambodia", "Cameroon", "Canada", "Cape Verde", "Chile", "China", "Colombia",
  "Congo", "Costa Rica", "Croatia", "Cuba", "Curaçao", "Cyprus", "Czechia", "Denmark", "Djibouti",
  "Dominican Republic", "Ecuador", "Egypt", "El Salvador", "Estonia", "Ethiopia", "Fiji",
  "Finland", "France", "Gabon", "Georgia", "Germany", "Ghana", "Gibraltar", "Greece", "Guatemala",
  "Guinea", "Guyana", "Honduras", "Hong Kong", "Hungary", "Iceland", "India", "Indonesia", "Iran",
  "Iraq", "Ireland", "Israel", "Italy", "Ivory Coast", "Jamaica", "Japan", "Jordan", "Kazakhstan",
  "Kenya", "Korea", "Kuwait", "Latvia", "Lebanon", "Liberia", "Libya", "Lithuania", "Luxembourg",
  "Macau", "Madagascar", "Malaysia", "Maldives", "Malta", "Marshall Islands", "Mauritania",
  "Mauritius", "Mexico", "Moldova", "Monaco", "Mongolia", "Montenegro", "Morocco", "Mozambique",
  "Myanmar", "Namibia", "Netherlands", "New Zealand", "Nicaragua", "Nigeria", "North Macedonia",
  "Norway", "Oman", "Pakistan", "Panama", "Papua New Guinea", "Paraguay", "Peru", "Philippines",
  "Poland", "Portugal", "Qatar", "Romania", "Russia", "Saudi Arabia", "Senegal", "Serbia",
  "Seychelles", "Sierra Leone", "Singapore", "Slovakia", "Slovenia", "South Africa", "Spain",
  "Sri Lanka", "Sudan", "Suriname", "Sweden", "Switzerland", "Syria", "Taiwan", "Tanzania",
  "Thailand", "Togo", "Trinidad and Tobago", "Tunisia", "Turkey", "Turkmenistan", "UAE",
  "Uganda", "Ukraine", "United Kingdom", "United States", "Uruguay", "Uzbekistan", "Venezuela",
  "Vietnam", "Yemen", "Zambia", "Zimbabwe",
];

/** 이름 비교용 — 대소문자·군더더기 공백을 지운다(같은 곳을 두 번 세지 않게). */
function norm(v: string): string {
  return (v || "").trim().toLowerCase().replace(/\s+/g, " ");
}

type PartyRow = { regions?: string[]; country?: string };

/** 한 줄이 들고 있는 지역들 — 다중값이 있으면 그것, 없으면 대표 지역 한 칸. */
function rowRegions(r: PartyRow): string[] {
  const list = (r.regions ?? []).map((v) => (v || "").trim()).filter(Boolean);
  return list.length ? list : [(r.country || "").trim()].filter(Boolean);
}

/** 세 명부에 이미 적혀 있는 지역 — 많이 쓴 것부터, 같은 수면 가나다순.
 *  목록은 이미 앱 곳곳이 쓰는 캐시(5분)를 그대로 읽는다 — 이 칸 때문에 새로 부르지 않는다. */
export function useUsedRegions(): string[] {
  const { data: customers } = useCachedData("settings-customers", fetchSettingsCustomers, 300_000);
  const { data: vendors } = useCachedData("settings-vendors", fetchSettingsVendors, 300_000);
  const { data: makers } = useCachedData("settings-makers", fetchSettingsMakers, 300_000);
  return useMemo(() => {
    const count = new Map<string, { label: string; n: number }>();
    for (const rows of [customers, vendors, makers]) {
      for (const r of (rows ?? []) as PartyRow[]) {
        for (const v of rowRegions(r)) {
          const key = norm(v);
          const seen = count.get(key);
          // 표기가 갈리면 먼저 만난 쪽을 대표로 둔다(둘 다 세되 한 줄로 보인다).
          if (seen) seen.n += 1;
          else count.set(key, { label: v, n: 1 });
        }
      }
    }
    return [...count.values()]
      .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
      .map((x) => x.label);
  }, [customers, vendors, makers]);
}

/** 지역 칸이 쓰는 두 묶음 — 이미 쓴 것 / 나머지 나라. */
export function useRegionSections(): ComboSection[] {
  const used = useUsedRegions();
  return useMemo(() => {
    const seen = new Set(used.map(norm));
    const rest = COUNTRIES.filter((c) => !seen.has(norm(c)));
    const out: ComboSection[] = [];
    if (used.length) out.push({ label: "Already used", options: used });
    out.push({ label: used.length ? "Other countries" : "Countries", options: rest });
    return out;
  }, [used]);
}

/** 지역 입력 한 칸 — 토글로 고르고, 목록에 없는 값은 그대로 적는다. */
export default function RegionCombo({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const sections = useRegionSections();
  return (
    <ComboBox
      value={value}
      onChange={onChange}
      sections={sections}
      placeholder={placeholder}
      disabled={disabled}
    />
  );
}
