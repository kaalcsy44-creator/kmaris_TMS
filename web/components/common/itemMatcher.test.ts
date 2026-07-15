// 단계 간 품목 연결(makeItemMatcher) 검증 — node --test 로 실행:
//   cd web && node --test components/common/itemMatcher.test.ts
//
// 프로젝트 개요의 Quote → P/O → C/I 가로 배치가 이 함수로 줄을 맞춘다.
// 잘못 맞으면 "5·6항 C/I 가 1·2항에 붙는" 식으로 조용히 틀린 숫자가 나오므로 고정해 둔다.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeItemMatcher, ciPurchase, unitPriceOf } from "../../lib/deal.ts";

type Item = { part_no?: string; tag: string };

/** 기준 행들을 순서대로 훑어 각 행에 붙는 상대 품목의 tag(없으면 null)를 뽑는다. */
function pair(base: Item[], doc: Item[]): (string | null)[] {
  const match = makeItemMatcher(doc);
  return base.map((b, i) => match(b, i)?.tag ?? null);
}

test("C/I 가 6개 중 5·6항만 실었으면 그 두 줄에만 붙는다", () => {
  const po: Item[] = [
    { part_no: "A-1", tag: "po1" },
    { part_no: "B-1", tag: "po2" },
    { part_no: "A-2", tag: "po3" },
    { part_no: "B-2", tag: "po4" },
    { part_no: "A-3", tag: "po5" },
    { part_no: "A-4", tag: "po6" },
  ];
  const ci: Item[] = [
    { part_no: "A-3", tag: "ci5" },
    { part_no: "A-4", tag: "ci6" },
  ];
  assert.deepEqual(pair(po, ci), [null, null, null, null, "ci5", "ci6"]);
});

test("문서에 품목이 더 많아도 기준 행에 있는 것만 붙는다", () => {
  const po: Item[] = [{ part_no: "A-3", tag: "po5" }];
  const quote: Item[] = [
    { part_no: "A-1", tag: "q1" },
    { part_no: "A-3", tag: "q5" },
    { part_no: "B-1", tag: "q2" },
  ];
  assert.deepEqual(pair(po, quote), ["q5"]);
});

test("같은 품번이 여러 줄이면 나온 순서대로 하나씩 소비한다", () => {
  const po: Item[] = [
    { part_no: "A-1", tag: "po1" },
    { part_no: "A-1", tag: "po2" },
    { part_no: "A-1", tag: "po3" },
  ];
  const ci: Item[] = [
    { part_no: "A-1", tag: "ci-first" },
    { part_no: "A-1", tag: "ci-second" },
  ];
  // 3줄 중 2줄만 실렸으므로 앞의 둘에 순서대로 붙고 세 번째는 빈칸.
  assert.deepEqual(pair(po, ci), ["ci-first", "ci-second", null]);
});

test("품번 대소문자·공백 차이는 같은 품목으로 본다", () => {
  const po: Item[] = [{ part_no: " a-1 ", tag: "po1" }];
  const ci: Item[] = [{ part_no: "A-1", tag: "ci1" }];
  assert.deepEqual(pair(po, ci), ["ci1"]);
});

test("품번이 하나도 없는 옛 문서는 배열 순서로 맞춘다", () => {
  const po: Item[] = [
    { part_no: "A-1", tag: "po1" },
    { part_no: "A-2", tag: "po2" },
  ];
  const legacy: Item[] = [{ tag: "old1" }, { tag: "old2" }];
  assert.deepEqual(pair(po, legacy), ["old1", "old2"]);
});

test("상대 문서가 비어 있으면 전부 빈칸 — 순서 매칭으로 새지 않는다", () => {
  const po: Item[] = [{ part_no: "A-1", tag: "po1" }];
  assert.deepEqual(pair(po, []), [null]);
});

test("기준 행에 품번이 없으면 품번 있는 문서와는 잇지 않는다", () => {
  // 한쪽만 품번을 채운 어중간한 상태에서 엉뚱한 줄에 붙는 것을 막는다.
  const po: Item[] = [{ tag: "po1" }];
  const ci: Item[] = [{ part_no: "A-9", tag: "ci1" }];
  assert.deepEqual(pair(po, ci), [null]);
});

// ── C/I 매입 = 벤더 단가 × 실린 수량 ─────────────────────────────────────

test("C/I 수량이 0이면 매입도 0 — 안 실린 물건의 원가를 잡지 않는다", () => {
  const vendorPo = { qty: 1, unit_price: 150000, amount: 150000 };
  assert.equal(ciPurchase(vendorPo, { qty: 0, amount: 0 }), 0);
});

test("C/I 수량이 발주보다 적으면 실린 만큼만 매입", () => {
  const vendorPo = { qty: 10, unit_price: 1000, amount: 10000 };
  assert.equal(ciPurchase(vendorPo, { qty: 3, amount: 3000 }), 3000);
});

test("C/I 에 아예 없는 줄이면 매입은 null(빈칸) — 0 과 구분한다", () => {
  const vendorPo = { qty: 1, unit_price: 150000 };
  assert.equal(ciPurchase(vendorPo, undefined), null);
});

test("발주 단가가 없으면 금액÷수량으로 역산해 쓴다", () => {
  assert.equal(unitPriceOf({ qty: 4, amount: 800 }), 200);
  assert.equal(ciPurchase({ qty: 4, amount: 800 }, { qty: 2 }), 400);
});

test("P-007 ON PHOENIX — 6줄 중 5·6항만 실린 C/I 의 매입 합계", () => {
  // 발주 6줄(각 수량 1). C/I 는 5·6항만 수량 1, 나머지는 0으로 남아 있다.
  const vendorPo = [150000, 450000, 188000, 450000, 150000, 150000].map((p) => ({
    qty: 1,
    unit_price: p,
    amount: p,
  }));
  const ci = [0, 0, 0, 0, 1, 1].map((q, i) => ({ qty: q, amount: q * [0, 0, 0, 0, 214290, 214290][i] }));
  const purchases = vendorPo.map((v, i) => ciPurchase(v, ci[i]));
  assert.deepEqual(purchases, [0, 0, 0, 0, 150000, 150000]);
  // 매입 300,000 / 매출 428,580 → 마진 30%. 발주 전액(1,538,000)을 잡던 예전 계산은 -258.9%.
  const purTotal = purchases.reduce((a, b) => (a ?? 0) + (b ?? 0), 0) as number;
  const salesTotal = 214290 * 2;
  assert.equal(purTotal, 300000);
  assert.equal(Math.round(((salesTotal - purTotal) / salesTotal) * 1000) / 10, 30);
});
