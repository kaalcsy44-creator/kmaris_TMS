/**
 * 회사 이름 맞대기 — 웹에서 찾은 선주·관리사 이름이 우리 고객 중 누구인지.
 *
 * 공개 선박 페이지는 법인 이름을 통째로 적는다("ANGLO-EASTERN SHIPMANAGEMENT LTD"),
 * 우리 고객 목록은 부르는 이름이다("ANGLO-EASTERN"). 그래서 같음이 아니라 "고객 이름의
 * 낱말들이 상대 이름 앞머리에 그대로 서 있는가"로 본다. 법인 꼬리(LTD·CO·INC·GROUP…)와
 * 괄호 속 지역 표시("(Hongkong)")는 양쪽에서 떼고 비교한다.
 */

const CORP_TAIL = new Set([
  "LTD", "LIMITED", "CO", "COMPANY", "INC", "INCORPORATED", "LLC", "LLP", "PTE", "PLC",
  "SA", "AS", "ASA", "AB", "BV", "NV", "GMBH", "AG", "SRL", "SPA", "KK", "CORP", "CORPORATION",
  "GROUP", "HOLDINGS", "HOLDING", "THE",
]);

export function companyTokens(name: string): string[] {
  return (name || "")
    .toUpperCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9가-힣]+/g, " ")
    .split(" ")
    .filter((w) => w && !CORP_TAIL.has(w));
}

/** candidates 중 name 과 같은 회사로 보이는 것 — 가장 길게(구체적으로) 맞는 하나, 없으면 null. */
export function matchCompany<T extends { name: string }>(name: string, candidates: T[]): T | null {
  const target = companyTokens(name);
  if (!target.length) return null;
  let best: T | null = null;
  let bestLen = 0;
  for (const c of candidates) {
    const core = companyTokens(c.name);
    // 한 글자짜리·짧은 약어 한 낱말("MS")로는 아무 이름에나 걸린다 — 너무 짧으면 버린다.
    if (!core.length || core.join("").length < 3) continue;
    // 고객 이름이 상대 앞머리이거나, 상대가 고객 이름 앞머리(웹 쪽이 더 짧게 적힌 경우).
    const [short, long] = core.length <= target.length ? [core, target] : [target, core];
    if (short.join("").length >= 3 && short.every((w, i) => long[i] === w) && core.length > bestLen) {
      best = c;
      bestLen = core.length;
    }
  }
  return best;
}
