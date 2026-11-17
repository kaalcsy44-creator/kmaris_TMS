// 부대비용 줄(운임 등)은 같은 L번호의 품목과 대안으로 묶이지 않고 늘 합계에 든다.
//   cd web && node --test components/common/chargeRow.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applyLineAlts, countedItems, isChargeRow, lineGroups } from "../../lib/quoteOptions.ts";

test("charge: 품명으로 가늠하고 사람이 정한 값이 먼저", () => {
  assert.equal(isChargeRow({ description: "Freight cost" }), true);
  assert.equal(isChargeRow({ description: "Packing charge" }), true);
  assert.equal(isChargeRow({ description: "Delivery valve" }), false);
  assert.equal(isChargeRow({ description: "Freight cost", charge: false }), false);
  assert.equal(isChargeRow({ description: "Survey attendance", charge: true }), true);
});

test("charge: 같은 L의 품목과 묶이지 않고, 저장된 alt_off 도 합계에서 빼지 않는다", () => {
  const items = [
    { description: "Nitric Acid", lid: "L15", amount: 100 },
    { description: "Freight cost", lid: "L15", amount: 50, alt_off: true, line_mode: "alt" as const },
  ];
  assert.equal(lineGroups(items).size, 0);
  assert.equal(countedItems(items).length, 2);
  const fixed = applyLineAlts(items);
  assert.equal(fixed[1].alt_off, false);
});
