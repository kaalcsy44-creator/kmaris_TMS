"use client";

import { createContext, useContext, useEffect, useMemo, useRef } from "react";

/** 단계 작업 화면의 표시 모드.
 *  read  — 저장된 값을 입력란 껍데기 없이 "무엇을 입력했나" 로 훑어보는 모드(수정 불가).
 *  edit  — 지금까지의 동작. 입력·저장.
 *  화면 DOM 은 두 모드가 같다 — 껍데기만 CSS 로 벗긴다. 그래서 모드를 오가도
 *  컴포넌트가 언마운트되지 않고, 편집 중이던 값이 날아가지 않는다. */
export type ViewMode = "read" | "edit";

type Ctx = {
  mode: ViewMode;
  setMode: (m: ViewMode) => void;
  /** 읽기모드에서 값이 빈 항목을 화면에서 아예 빼고 채워진 것만 보여준다. */
  hideEmpty: boolean;
};

// 기본값 edit — 프로바이더 밖(목록 모달 등)에서 쓰이는 편집기는 지금까지처럼 동작한다.
const ViewModeCtx = createContext<Ctx>({
  mode: "edit",
  setMode: () => undefined,
  hideEmpty: false,
});

export function ViewModeProvider({
  mode,
  setMode,
  hideEmpty = false,
  children,
}: {
  mode: ViewMode;
  setMode: (m: ViewMode) => void;
  hideEmpty?: boolean;
  children: React.ReactNode;
}) {
  const value = useMemo(() => ({ mode, setMode, hideEmpty }), [mode, setMode, hideEmpty]);
  return <ViewModeCtx.Provider value={value}>{children}</ViewModeCtx.Provider>;
}

export function useViewMode(): Ctx {
  return useContext(ViewModeCtx);
}

/** 값이 비어 있는 입력란인가. 체크박스·라디오·파일은 '켜짐/꺼짐' 자체가 정보라 비었다고 보지 않는다. */
function isBlankControl(el: Element): boolean | null {
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio" || el.type === "file") return null;
    return el.value.trim() === "";
  }
  if (el instanceof HTMLTextAreaElement) return el.value.trim() === "";
  if (el instanceof HTMLSelectElement) {
    const v = el.value.trim();
    const text = (el.selectedOptions[0]?.textContent || "").trim();
    // "— 선택 —" 류의 자리표시 옵션은 값이 없는 것으로 본다.
    return v === "" || text === "" || text === "—";
  }
  return null;
}

/** 읽기모드에서 '빈 항목'을 CSS 가 집을 수 있도록 data-vm-empty 로 표시한다.
 *  input.value 는 속성이 아니라 프로퍼티라 MutationObserver 로 잡히지 않는다 —
 *  그래서 렌더가 끝날 때마다 훑는다. DOM 속성만 건드려 리렌더를 유발하지 않으므로
 *  루프가 생기지 않고, 한 단계의 필드 수(수십 개)라 비용도 무시할 만하다. */
function markEmptyFields(root: HTMLElement | null, on: boolean) {
  if (!root) return;
  const fields = root.querySelectorAll<HTMLElement>(".form-field");
  for (const f of Array.from(fields)) {
    if (!on) {
      f.removeAttribute("data-vm-empty");
      continue;
    }
    const controls = f.querySelectorAll("input, select, textarea");
    let sawValue = false;
    let sawControl = false;
    for (const c of Array.from(controls)) {
      const blank = isBlankControl(c);
      if (blank === null) {
        // 체크박스류가 섞여 있으면 이 항목은 판단하지 않는다(항상 보여준다).
        sawValue = true;
        break;
      }
      sawControl = true;
      if (!blank) {
        sawValue = true;
        break;
      }
    }
    if (sawControl && !sawValue) f.setAttribute("data-vm-empty", "");
    else f.removeAttribute("data-vm-empty");
  }
}

/** 읽기모드에서 입력칸 값을 진짜 텍스트로 비춰 둔다.
 *  잠긴(disabled) 입력칸의 value 는 텍스트 노드가 아니라 마우스로 긁어 복사할 수 없다 —
 *  그래서 칸 바로 뒤에 같은 값을 담은 span.vm-text 를 두고 칸은 CSS 로 숨긴다.
 *  React 가 모르는 노드지만 React 노드를 옮기지 않으므로 재조정을 깨지 않는다.
 *  행이 지워져 짝을 잃은 span 은 다음 훑기에서 치운다. */
const MIRROR_SKIP = new Set(["checkbox", "radio", "file", "hidden", "button", "submit", "reset", "range", "color", "image"]);

function mirrorText(el: Element): string {
  if (el instanceof HTMLSelectElement) {
    const text = (el.selectedOptions[0]?.textContent || "").trim();
    return el.value.trim() === "" || text === "—" ? "" : text;
  }
  const v = (el as HTMLInputElement | HTMLTextAreaElement).value;
  // datetime-local 의 원값은 "2026-09-09T20:17" — 화면에서 읽히는 모양으로.
  return el instanceof HTMLInputElement && el.type === "datetime-local" ? v.replace("T", " ") : v;
}

function syncReadMirrors(root: HTMLElement | null, on: boolean) {
  if (!root) return;
  for (const s of Array.from(root.querySelectorAll<HTMLElement>("span.vm-text"))) {
    const prev = s.previousElementSibling;
    if (!on || !prev || !prev.hasAttribute("data-vm-mirror")) s.remove();
  }
  if (!on) {
    for (const c of Array.from(root.querySelectorAll("[data-vm-mirror]"))) c.removeAttribute("data-vm-mirror");
    return;
  }
  for (const c of Array.from(root.querySelectorAll("input, select, textarea"))) {
    if (c instanceof HTMLInputElement && MIRROR_SKIP.has(c.type)) continue;
    let span = c.nextElementSibling;
    if (!(span instanceof HTMLSpanElement && span.classList.contains("vm-text"))) {
      // 읽기모드 규칙이 칸 자체를 숨겨 둔 경우(도구 줄 등)는 비추지 않는다.
      if (getComputedStyle(c).display === "none") continue;
      span = document.createElement("span");
      span.className = "vm-text" + (c instanceof HTMLTextAreaElement ? " vm-text--multi" : "");
      c.after(span);
      c.setAttribute("data-vm-mirror", "");
    }
    const value = mirrorText(c);
    const ph = value ? "" : (c as HTMLInputElement).placeholder || "";
    const text = value || ph;
    if (span.textContent !== text) span.textContent = text;
    span.classList.toggle("vm-text--ph", !value && !!ph);
  }
}

/** 편집기 한 곳에서 쓰는 헬퍼.
 *  canEdit(권한)와 표시 모드를 합쳐 "지금 이 폼을 만질 수 있나(editing)"를 낸다.
 *  readMode 는 '권한은 있는데 읽기모드라서 잠긴' 상태 — 권한 부족 안내문과 구분해야 해서 따로 준다.
 *  fieldsetProps 는 <fieldset {...fieldsetProps}> 로 그대로 펼쳐 쓴다. */
export function useEditGate(canEdit: boolean) {
  const { mode, hideEmpty } = useViewMode();
  const readMode = mode === "read";
  const editing = canEdit && !readMode;
  const ref = useRef<HTMLFieldSetElement>(null);
  // 표시를 남긴 적이 있는지 — 편집모드에서 매 타이핑마다 훑지 않기 위한 표식.
  const marked = useRef(false);

  // 의존성 배열 없음 — 렌더될 때마다(=데이터가 늦게 도착해 값이 채워질 때마다) 다시 훑는다.
  // 편집모드에선 지울 표시가 남아 있을 때만 한 번 훑고 그 뒤로는 아무 일도 하지 않는다.
  useEffect(() => {
    if (!readMode && !marked.current) return;
    markEmptyFields(ref.current, readMode);
    syncReadMirrors(ref.current, readMode);
    marked.current = readMode;
  });

  // 하위 컴포넌트가 따로 데이터를 받아 값을 채우면 이 편집기는 리렌더되지 않는다 —
  // 읽기모드 동안은 짧은 간격으로 다시 비춰 '보이는 값 = 저장된 값'을 지킨다.
  useEffect(() => {
    if (!readMode) return;
    const t = window.setInterval(() => syncReadMirrors(ref.current, true), 800);
    return () => window.clearInterval(t);
  }, [readMode]);

  return {
    editing,
    readMode,
    fieldsetProps: {
      ref,
      className:
        "form-fieldset" + (readMode ? " vm-read" : "") + (readMode && hideEmpty ? " vm-hide-empty" : ""),
      disabled: !editing,
    },
  };
}

/** 읽기모드 화면에서 눈에 보이는 값을 그대로 텍스트로 뽑는다.
 *  (부분은 마우스로 긁어 복사할 수 있다 — syncReadMirrors 참고. 이 함수는 단계 전체를
 *  라벨·탭 구분으로 한 번에 뽑는 복사 버튼의 몫이다.)
 *  화면에서 숨겨진 것(빈 항목 숨김·다른 탭)은 뽑지 않는다 — 본 것과 복사한 것이 같아야 한다. */
function isHidden(el: HTMLElement): boolean {
  return el.offsetParent === null && getComputedStyle(el).position !== "fixed";
}

function controlText(el: Element): string | null {
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") return el.checked ? "Y" : "N";
    if (el.type === "file") return null;
    return el.value.trim();
  }
  if (el instanceof HTMLTextAreaElement) return el.value.trim();
  if (el instanceof HTMLSelectElement) return (el.selectedOptions[0]?.textContent || "").trim();
  return null;
}

/** .form-field 한 칸 → "라벨\t값". 값이 비면 화면과 같이 대시로 적는다. */
function fieldLine(f: HTMLElement): string | null {
  const labelEl = f.querySelector(":scope > label, :scope > span:first-child");
  const label = (labelEl?.textContent || "").trim().replace(/\s+/g, " ");
  const parts: string[] = [];
  for (const c of Array.from(f.querySelectorAll("input, select, textarea"))) {
    // 비춰 둔 칸은 CSS 로 숨겨져 있지만 값의 원본이다.
    if (c instanceof HTMLElement && !c.hasAttribute("data-vm-mirror") && isHidden(c)) continue;
    const t = controlText(c);
    if (t) parts.push(t);
  }
  const value = parts.join(" ").trim();
  if (!label && !value) return null;
  return `${label}\t${value || "—"}`;
}

/** 표 → 탭 구분 텍스트. 엑셀에 그대로 붙는다. 숨은 열(선택·삭제)은 빠진다. */
function tableLines(table: HTMLTableElement): string[] {
  const out: string[] = [];
  for (const tr of Array.from(table.querySelectorAll("tr"))) {
    if (isHidden(tr)) continue;
    const cells: string[] = [];
    for (const cell of Array.from(tr.children)) {
      if (!(cell instanceof HTMLElement) || isHidden(cell)) continue;
      const control = cell.querySelector("input, select, textarea");
      const text = control
        ? controlText(control) ?? ""
        : (cell.textContent || "").trim().replace(/\s+/g, " ");
      cells.push(text);
    }
    if (cells.some((c) => c !== "")) out.push(cells.join("\t"));
  }
  return out;
}

export function stagePaneText(root: HTMLElement | null): string {
  if (!root) return "";
  const out: string[] = [];
  const walk = (node: Element) => {
    for (const el of Array.from(node.children)) {
      if (!(el instanceof HTMLElement) || isHidden(el)) continue;
      if (el.tagName === "TABLE") {
        out.push(...tableLines(el as HTMLTableElement));
        continue;
      }
      if (el.classList.contains("form-field")) {
        const line = fieldLine(el);
        if (line) out.push(line);
        continue;
      }
      if (el.classList.contains("form-section-title") || el.classList.contains("pb-title")) {
        const t = (el.textContent || "").trim();
        if (t) out.push("", `[${t}]`);
        continue;
      }
      walk(el);
    }
  };
  walk(root);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
