// 메일 본문 편집기의 서식 도우미.
// 본문은 평문으로 저장하고 발송 시 서버가 HTML 로 렌더하므로, 굵게는 마크다운
// 표기(**텍스트**)로 남긴다. 여기서는 선택 영역에 그 표기를 씌우거나 벗긴다.
const MARK = "**";

/** 선택 영역을 굵게 토글. 선택이 없으면 아무 일도 하지 않는다. */
export function toggleBold(
  el: HTMLTextAreaElement | null,
  onChange: (next: string) => void
): void {
  if (!el) return;
  const { selectionStart: a, selectionEnd: b, value } = el;
  if (a === b) return;

  const sel = value.slice(a, b);
  let start = a;
  let end = b;
  let next: string;

  if (sel.startsWith(MARK) && sel.endsWith(MARK) && sel.length > MARK.length * 2) {
    next = sel.slice(MARK.length, -MARK.length);                 // 선택 안쪽의 ** 벗기기
  } else if (value.slice(a - MARK.length, a) === MARK && value.slice(b, b + MARK.length) === MARK) {
    start = a - MARK.length;                                      // 선택 바깥의 ** 벗기기
    end = b + MARK.length;
    next = sel;
  } else {
    next = `${MARK}${sel}${MARK}`;
  }

  onChange(value.slice(0, start) + next + value.slice(end));
  // 값 반영은 다음 렌더에 일어나므로, 선택 복원도 그 뒤로 미룬다.
  requestAnimationFrame(() => {
    el.focus();
    el.setSelectionRange(start, start + next.length);
  });
}

/** Ctrl/⌘+B 를 굵게로. textarea 의 onKeyDown 에 그대로 연결한다. */
export function onBoldKey(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  onChange: (next: string) => void
): void {
  if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "B")) {
    e.preventDefault();
    toggleBold(e.currentTarget, onChange);
  }
}
