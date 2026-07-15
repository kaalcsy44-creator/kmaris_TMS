// 품목표 ↔ 엑셀 클립보드 변환(순수 함수). UI 의존이 없어 단독으로 검증 가능하다.
// 엑셀/구글시트가 클립보드에 넣는 형식은 TSV — 탭=열, 개행=행이고, 셀 안에 탭·개행·따옴표가
// 있으면 그 셀을 따옴표로 감싸고 내부 따옴표는 두 번 겹쳐 온다("" → ").

/** 클립보드 TSV → 행×열 격자. */
export function parseClipboardGrid(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"' && cur === "") {
      quoted = true;
      i++;
      continue;
    }
    if (ch === "\t") {
      row.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  row.push(cur);
  rows.push(row);
  // 엑셀 복사본은 끝에 개행이 하나 붙어 빈 행이 생긴다 — 떼어낸다.
  while (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === "") rows.pop();
    else break;
  }
  return rows;
}

/** 엑셀에 붙일 TSV 한 칸 — 탭·줄바꿈·따옴표가 있으면 따옴표로 감싼다. */
export function tsvCell(s: string): string {
  return /[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 셀 값 → 텍스트. 숫자는 자릿수 구분 없이 그대로 내보내야 엑셀이 숫자로 받는다. */
export function cellText(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

/** 행 배열 → 엑셀에 붙일 TSV. */
export function toTsv(rows: string[][]): string {
  return rows.map((r) => r.map(tsvCell).join("\t")).join("\r\n");
}
