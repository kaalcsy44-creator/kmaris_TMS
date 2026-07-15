// 클립보드 파서 검증 — node --test 로 실행:
//   cd web && node --test components/common/itemClipboard.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseClipboardGrid, toTsv, tsvCell, cellText } from "./itemClipboard.ts";

test("엑셀에서 복사한 여러 행×열 — 끝 개행은 빈 행으로 남지 않는다", () => {
  assert.deepEqual(parseClipboardGrid("A1\tB1\r\nA2\tB2\r\n"), [
    ["A1", "B1"],
    ["A2", "B2"],
  ]);
});

test("컬럼 하나만 복사 — 세로 한 줄", () => {
  assert.deepEqual(parseClipboardGrid("Valve\r\nSeal kit\r\nGasket\r\n"), [
    ["Valve"],
    ["Seal kit"],
    ["Gasket"],
  ]);
});

test("셀 안 줄바꿈은 따옴표로 감싸여 오고, 행이 쪼개지지 않는다", () => {
  assert.deepEqual(parseClipboardGrid('"Ball valve\nActuator"\t2\r\n'), [
    ["Ball valve\nActuator", "2"],
  ]);
});

test('셀 안 따옴표는 "" 로 겹쳐 온다', () => {
  assert.deepEqual(parseClipboardGrid('"He said ""hi"""\tX\r\n'), [['He said "hi"', "X"]]);
});

test("빈 셀이 중간/끝에 있어도 열 수가 유지된다", () => {
  assert.deepEqual(parseClipboardGrid("A\t\tC\r\nD\tE\t\r\n"), [
    ["A", "", "C"],
    ["D", "E", ""],
  ]);
});

test("개행 종류(LF / CRLF / CR)를 모두 행 구분으로 본다", () => {
  assert.deepEqual(parseClipboardGrid("A\nB"), [["A"], ["B"]]);
  assert.deepEqual(parseClipboardGrid("A\r\nB"), [["A"], ["B"]]);
  assert.deepEqual(parseClipboardGrid("A\rB"), [["A"], ["B"]]);
});

test("한 칸짜리 붙여넣기", () => {
  assert.deepEqual(parseClipboardGrid("1,234"), [["1,234"]]);
});

test("내보낸 TSV 를 다시 읽으면 원본과 같다(왕복)", () => {
  const rows = [
    ["Part", "Description", "Qty"],
    ["HBB-150", "Ball valve\nwith actuator", "2"],
    ["HAP-150", 'Seal "kit"', "10"],
    ["", "탭\t포함", "1"],
  ];
  assert.deepEqual(parseClipboardGrid(toTsv(rows)), rows);
});

test("따옴표가 필요한 셀만 감싼다", () => {
  assert.equal(tsvCell("plain"), "plain");
  assert.equal(tsvCell("has\ttab"), '"has\ttab"');
  assert.equal(tsvCell('q"x'), '"q""x"');
});

test("숫자는 자릿수 구분 없이 나가야 엑셀이 숫자로 받는다", () => {
  assert.equal(cellText(1234.5), "1234.5");
  assert.equal(cellText(null), "");
  assert.equal(cellText(undefined), "");
  assert.equal(cellText(0), "0");
});
