// AI 메일 요약(rollup) 한 줄을 읽는 규칙 — Briefing 카드와 딜 화면의 Mail 정리가
// 같은 텍스트를 각자 파싱하고 있어 한 곳에 모았다.
//
// 라벨은 한국어로 저장된다(서버 프롬프트가 "진행: …" 꼴을 요구한다). 화면에는 영문으로
// 세운다 — 나머지 화면 문구가 모두 영문이라 여기만 한글이면 라벨이 본문처럼 읽힌다.
// 저장값을 그대로 두는 건 이미 쌓인 요약도 함께 영문으로 나오게 하기 위함이다
// (프롬프트를 영문으로 바꾸면 옛 요약만 한글 라벨로 남는다).

export type RollupKind = "flow" | "issue" | "terms" | "next";

export const ROLLUP_LABELS: Record<string, { kind: RollupKind; en: string }> = {
  "진행": { kind: "flow", en: "Progress" },
  "쟁점": { kind: "issue", en: "Issue" },
  "금액·납기": { kind: "terms", en: "Terms" },
  "다음": { kind: "next", en: "Next" },
};

export type ParsedRollupLine = { kind: RollupKind; label: string; body: string };

// Next 줄은 정해진 세 마디 중 하나로 시작한다(서버 프롬프트가 그렇게 요구한다):
// "우리 → …" · "상대 대기 — …" · "종료". 이 셋만은 문장이 아니라 상태를 가리키는
// 표식이라, 화면 위쪽 필터 칩과 같은 말로 옮긴다 — 같은 상태를 두 가지 말로 부르면
// "Our move 2" 칩과 카드의 "우리 →" 가 같은 것인지 알아보기 어렵다.
// 뒤따르는 본문은 손대지 않는다(사람이 읽을 한국어 문장이다).
const NEXT_PREFIXES: [RegExp, string][] = [
  [/^우리\s*(?:→|->)\s*/, "Our move → "],
  [/^상대\s*대기\s*(?:[—–-]\s*)?/, "Waiting on them — "],
  // \b 는 한글에 걸리지 않는다(한글은 \w 가 아니다) — "종료된 건…" 같은 문장을
  // 잘라 먹지 않도록 뒤에 무엇이 오는지를 직접 본다.
  [/^종료(?=$|[\s—–-])\s*(?:[—–-]\s*)?/, "Closed — "],
];

/** Next 줄 머리말을 영문으로. 셋 중 어디에도 안 맞으면 그대로 둔다. */
export function nextBodyEn(body: string): string {
  for (const [re, en] of NEXT_PREFIXES) {
    if (re.test(body)) {
      const rest = body.replace(re, "").trim();
      return rest ? `${en}${rest}` : en.replace(/\s*[—→-]\s*$/, "");
    }
  }
  return body;
}

/** "진행: 7/30 …" → { kind:"flow", label:"Progress", body:"7/30 …" }.
 *  넷 중 하나일 때만 라벨로 본다 — 본문에 콜론이 있다고 라벨이 되면 안 된다.
 *  라벨이 없으면 null(예전 "- 문장" 꼴 서술형 요약). */
export function parseRollupLine(text: string): ParsedRollupLine | null {
  const t = text.replace(/^[-•]\s*/, "").trim();
  const at = t.search(/[:：]/);
  if (at <= 0) return null;
  const hit = ROLLUP_LABELS[t.slice(0, at).trim()];
  if (!hit) return null;
  const body = t.slice(at + 1).trim();
  return { kind: hit.kind, label: hit.en, body: hit.kind === "next" ? nextBodyEn(body) : body };
}

/** 라벨 붙은 요약인가 — 라벨 규격이 생기기 전에 만들어진 서술형 요약은 다시 써야 할
 *  대상이라 빈 요약과 같이 취급한다(마지막 메일이 그대로면 서버는 그것을 "최신"으로
 *  보고 영영 다시 쓰지 않으므로, 화면이 알아보고 짚어 줘야 한다). */
export function isLabelledRollup(rollup?: string | null): boolean {
  return !!rollup && rollup.split("\n").some((l) => parseRollupLine(l) !== null);
}
