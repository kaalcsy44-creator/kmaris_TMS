// 단계 간 품목 연결(makeItemMatcher) 검증 — node --test 로 실행:
//   cd web && node --test components/common/itemMatcher.test.ts
//
// 프로젝트 개요의 Quote → P/O → C/I 가로 배치가 이 함수로 줄을 맞춘다.
// 잘못 맞으면 "5·6항 C/I 가 1·2항에 붙는" 식으로 조용히 틀린 숫자가 나오므로 고정해 둔다.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeItemMatcher } from "../../lib/deal.ts";

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
