"use client";

// 배 위의 구역 — 분류 트리의 대분류를 네 자리(선교·갑판·기관·부두) 중 하나에 앉힌다.
//
// Ship View 가 카드를 놓는 데 쓰던 규칙인데, 그 색이 곧 "이 계통이 배의 어디냐"를
// 말하므로 분류 배지도 같은 색을 써야 한다. 배지가 목록에서 초록 하나로만 서 있으면
// 'Main Engine System' 과 'Crane' 이 같은 무게로 읽히지만, 실제로는 하나는 기관실이고
// 하나는 갑판이다 — 화면 두 곳이 같은 것을 다르게 칠하면 색이 뜻을 잃는다.
//
// 배치는 이름으로 잡되 강제하지 않는다. 분류 트리는 관리자가 고칠 수 있으므로, 아는
// 이름은 제자리에 세우고 모르는 이름은 부두에 세운다 — 트리를 바꿨다고 화면이
// 무너지면 안 된다.

/**
 * 갑판 — 카드가 스스로 달고 다니는 이름표. 자리(격자 칸)로 갑판을 나누지 않는다:
 * 계통마다 부피가 열 배씩 차이 나서(기관실 아홉 계열 vs 선교 셋), 칸을 갑판으로
 * 못 박으면 어떤 칸은 안에서 스크롤하고 어떤 칸은 절반이 빈 채로 남는다.
 * 이름표를 카드에 붙여 두면 카드는 어느 열에 놓여도 제 갑판을 말한다.
 */
export const DECKS = [
  { name: "Bridge & upper deck", sub: "선교·상부" },
  { name: "Main deck", sub: "갑판·화물" },
  { name: "Machinery spaces", sub: "기관·전장" },
  { name: "Quay", sub: "육상·용역" },
] as const;

/**
 * 대분류 이름 → 갑판. 기본 트리(init_db.ITEM_CATEGORY_TREE)의 일곱 대분류를 제자리에
 * 세운다. 여기 없는 이름은 부두로 간다 — 자리를 못 찾은 것이지 잘못된 것이 아니므로
 * 화면에서 빠지지는 않는다(관리자가 트리를 고쳐도 화면이 무너지지 않는다).
 */
export const BERTH: Record<string, number> = {
  "BRIDGE": 0,
  "DECK MACHINERY": 0,
  "CARGO & TANK SYSTEM": 1,
  "CARGO AND TANK SYSTEM": 1,
  "ENGINE ROOM": 2,
  "ELECTRICAL & AUTOMATION": 2,
  "OTHER EQUIPMENT": 2,
  "SERVICE": 3,
};

/** 대분류 이름 → 갑판 번호(0~3). 모르는 이름은 부두(마지막 자리)에 내려놓는다. */
export function berthOf(name: string): number {
  const k = (name || "").trim().toUpperCase();
  return BERTH[k] ?? DECKS.length - 1;
}
