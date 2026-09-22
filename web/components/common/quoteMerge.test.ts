// 공급사 견적 취합(lib/quoteMerge) 검증 — node --test 로 실행:
//   cd web && node --test components/common/quoteMerge.test.ts
//
// 4단계에서 견적 두세 장을 한 장으로 합치는 규칙이다. 잘못되면 고객에게 나가는 견적서에
// 같은 줄이 두 번 서거나, 두 번째 견적을 부르는 순간 첫 번째가 사라진다 — 둘 다 문서를
// 내보낸 뒤에야 드러나는 종류의 잘못이라 여기서 못 박아 둔다.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  appendItems,
  costConvertible,
  costSources,
  lineKey,
  manualLines,
  soleSourceId,
  withoutSource,
} from "../../lib/quoteMerge.ts";
import type { CustomerQuoteItem } from "../../lib/types.ts";

const row = (p: Partial<CustomerQuoteItem>): CustomerQuoteItem => ({
  part_no: "",
  description: "",
  qty: 1,
  unit: "EA",
  cost_price: 0,
  margin_pct: 30,
  unit_price: 0,
  amount: 0,
  ...p,
});

const fromVendor = (vq: number, vendor: string, p: Partial<CustomerQuoteItem>) =>
  row({ src_vq_id: vq, src_vendor: vendor, src_vq_no: `Q-${vq}`, src_currency: "KRW", ...p });

test("서로 다른 품목을 보낸 두 견적은 한 표에 나란히 실린다", () => {
  const a = [fromVendor(1, "A", { lid: "L01", part_no: "P-1", cost_price: 100 })];
  const b = [fromVendor(2, "B", { lid: "L02", part_no: "P-2", cost_price: 200 })];
  const r = appendItems(a, b);
  assert.equal(r.added, 1);
  assert.equal(r.items.length, 2);
  assert.deepEqual(costSources(r.items).map((s) => s.vendor), ["A", "B"]);
});

test("같은 줄에 값을 준 두 번째 벤더는 건너뛴다 — 한 줄은 한 곳에서 산다", () => {
  const a = [fromVendor(1, "A", { lid: "L01", part_no: "P-1", cost_price: 100 })];
  const b = [fromVendor(2, "B", { lid: "L01", part_no: "P-1", cost_price: 90 })];
  const r = appendItems(a, b);
  assert.equal(r.added, 0);
  assert.equal(r.filled, 0);
  assert.deepEqual(r.skipped, ["P-1"]);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].src_vendor, "A");
});

test("값이 아직 안 들어온 자리는 제자리에서 채워진다(딜 품목으로 깔아 둔 빈 줄)", () => {
  const seeded = [
    row({ lid: "L01", part_no: "P-1", description: "PUMP", qty: 6 }),
    row({ lid: "L02", part_no: "P-2", description: "SEAL", qty: 3 }),
  ];
  const quote = [fromVendor(7, "A", { lid: "L01", part_no: "P-1", description: "PUMP", qty: 1, cost_price: 500 })];
  const r = appendItems(seeded, quote);
  assert.equal(r.added, 0);
  assert.equal(r.filled, 1);
  assert.equal(r.items.length, 2);
  // 값(원가·출처)은 벤더가 준 것, 자리(수량·라인 ID)는 딜이 정한 것.
  assert.equal(r.items[0].cost_price, 500);
  assert.equal(r.items[0].src_vq_id, 7);
  assert.equal(r.items[0].qty, 6);
  assert.equal(r.items[0].lid, "L01");
});

test("출처 띠는 견적별 줄 수·매입액을 센다", () => {
  const items = [
    fromVendor(1, "A", { lid: "L01", cost_price: 100, qty: 2 }),
    fromVendor(1, "A", { lid: "L02", cost_price: 50, qty: 1 }),
    fromVendor(2, "B", { lid: "L03", cost_price: 300, qty: 1 }),
    row({ lid: "L04", part_no: "X", cost_price: 10 }),
  ];
  const [a, b] = costSources(items);
  assert.equal(a.lines, 2);
  assert.equal(a.cost, 250);
  assert.equal(b.lines, 1);
  assert.equal(manualLines(items), 1);
  // 출처가 둘이면 문서 한 장에 매다는 옛 링크는 비운다.
  assert.equal(soleSourceId(items), null);
  assert.equal(soleSourceId(withoutSource(items, 2)), 1);
});

test("한 출처를 걷어내면 그 줄만 사라진다", () => {
  const items = [
    fromVendor(1, "A", { lid: "L01", cost_price: 100 }),
    fromVendor(2, "B", { lid: "L02", cost_price: 200 }),
  ];
  const left = withoutSource(items, 1);
  assert.equal(left.length, 1);
  assert.equal(left[0].src_vendor, "B");
});

test("옵션 구분행은 세지도, 겹치는지 보지도 않는다", () => {
  const items = [
    row({ row_kind: "option", description: "Option 1" }),
    fromVendor(1, "A", { lid: "L01", cost_price: 100 }),
  ];
  assert.equal(costSources(items)[0].lines, 1);
  assert.equal(manualLines(items), 0);
  const r = appendItems(items, [row({ row_kind: "option", description: "Option 2" })]);
  assert.equal(r.added, 0);
  assert.equal(r.items.length, 3);
});

test("라인 ID 가 없으면 품번으로, 품번도 없으면 품명으로 같은 줄을 가늠한다", () => {
  assert.equal(lineKey(row({ lid: "L01", part_no: "P-1" })), "lid:L01");
  assert.equal(lineKey(row({ part_no: " p-1 " })), "part:p-1");
  assert.equal(lineKey(row({ description: "  Thermal  oil  " })), "desc:thermal oil");
});

test("환산할 수 있는 통화쌍은 USD↔KRW 뿐이다", () => {
  assert.equal(costConvertible("USD", "KRW"), true);
  assert.equal(costConvertible("KRW", "KRW"), true);
  assert.equal(costConvertible("EUR", "KRW"), false);
});
