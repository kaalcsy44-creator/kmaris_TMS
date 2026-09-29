"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";

/**
 * 문서 편집기의 되돌리기 이력(Ctrl+Z / Ctrl+Y · Ctrl+Shift+Z).
 *
 * 품목표는 React 가 값을 쥐고 있는 입력칸이라 브라우저의 기본 되돌리기가 행 추가·삭제·
 * 붙여넣기·Apply 같은 조작을 되돌리지 못했다. 잘못 누르면 되돌릴 길이 Cancel 뿐이었고,
 * 그 Cancel 도 단계 화면에서는 편집을 버리지 않았다.
 *
 * `state` 에는 **함께 움직여야 하는 값을 한 덩어리로** 넘긴다 — 견적이면 품목과 가격
 * 설정(통화·환율·올림·마진·할인). 통화만 되돌리고 품목은 그대로 두면, 숫자는 KRW 인데
 * 머리는 USD 인 표가 된다.
 *
 * `resetKey` 가 바뀌면(문서를 불러왔을 때) 이력을 비운다.
 * null 이면 아직 불러오는 중 — 아무것도 기록하지 않는다.
 *
 * 연달아 친 글자(0.7초 안의 변경)는 한 단계로 묶는다 — 한 글자씩 되돌리면 쓸 수가 없다.
 */
export function useEditHistory<T>(
  state: T,
  restore: (s: T) => void,
  resetKey: string | number | null
) {
  const json = JSON.stringify(state);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const cur = useRef(json);
  const keyRef = useRef<string | number | null>(null);
  const lastAt = useRef(0);
  const lastWasEdit = useRef(false);
  const sig = useRef(shapeOf(json));
  const restoring = useRef<string | null>(null);
  const restoreRef = useRef(restore);
  restoreRef.current = restore;

  useEffect(() => {
    if (resetKey == null) return;
    if (keyRef.current !== resetKey) {
      keyRef.current = resetKey;
      past.current = [];
      future.current = [];
      cur.current = json;
      sig.current = shapeOf(json);
      lastAt.current = 0;
      lastWasEdit.current = false;
      restoring.current = null;
      bump();
      return;
    }
    if (json === cur.current) return;
    if (restoring.current !== null && json === restoring.current) {
      restoring.current = null;
      cur.current = json;
      sig.current = shapeOf(json);
      return;
    }
    restoring.current = null;
    const now = Date.now();
    // 묶는 것은 "값만 바뀐" 연속 변경(글자 입력)끼리다. 행 추가·삭제처럼 모양이 바뀐 변경은
    // 늘 제 단계를 갖고, 그 직후의 입력도 새 단계로 시작한다.
    const shape = shapeOf(json);
    const isEdit = shape === sig.current;
    if (!(isEdit && lastWasEdit.current && now - lastAt.current <= 700)) {
      past.current.push(cur.current);
      if (past.current.length > 100) past.current.shift();
    }
    lastAt.current = now;
    lastWasEdit.current = isEdit;
    sig.current = shape;
    future.current = [];
    cur.current = json;
    bump();
  }, [json, resetKey]);

  const go = useCallback((from: React.MutableRefObject<string[]>, to: React.MutableRefObject<string[]>) => {
    const s = from.current.pop();
    if (s === undefined) return false;
    to.current.push(cur.current);
    restoring.current = s;
    lastAt.current = 0;   // 되돌린 직후의 입력은 새 단계로 시작한다
    lastWasEdit.current = false;
    restoreRef.current(JSON.parse(s) as T);
    bump();
    return true;
  }, []);
  const undo = useCallback(() => go(past, future), [go]);
  const redo = useCallback(() => go(future, past), [go]);

  /**
   * 편집기 바깥 틀에 onKeyDownCapture 로 건다. 품목표·가격 밴드 안이거나 입력칸 밖에서
   * 누른 Ctrl+Z 만 가로챈다 — 메모·견적번호 같은 낱칸에서는 브라우저 기본 되돌리기가
   * 그 칸의 글자를 되돌리는 게 맞다(그 칸은 이 이력에 없다).
   */
  const onKeyDownCapture = useCallback(
    (e: React.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      const isUndo = k === "z" && !e.shiftKey;
      const isRedo = k === "y" || (k === "z" && e.shiftKey);
      if (!isUndo && !isRedo) return;
      const t = e.target as HTMLElement | null;
      const field = t?.closest("input, textarea, select, [contenteditable='true']");
      if (field && !t?.closest("[data-undo-scope]")) return;
      e.preventDefault();
      e.stopPropagation();
      if (isUndo) undo();
      else redo();
    },
    [undo, redo]
  );

  return {
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    onKeyDownCapture,
  };
}

/**
 * 저장본과 달라졌나 — 폼 전체(되돌리기 이력에 없는 낱칸까지)를 한 덩어리로 견준다.
 * `resetKey` 가 바뀐 첫 값을 저장본으로 삼고, 저장에 성공하면 markClean 으로 옮긴다.
 */
export function useDirty(snapshot: unknown, resetKey: string | number | null) {
  const json = JSON.stringify(snapshot);
  const latest = useRef(json);
  latest.current = json;
  const base = useRef<string | null>(null);
  const key = useRef<string | number | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (resetKey == null || key.current === resetKey) return;
    key.current = resetKey;
    base.current = json;
    bump();
  }, [json, resetKey]);
  const dirty = resetKey != null && key.current === resetKey && base.current !== null && json !== base.current;
  const markClean = useCallback(() => {
    base.current = latest.current;
    bump();
  }, []);
  return { dirty, markClean };
}

/** 값은 지우고 모양(키·배열 길이·null 여부)만 남긴 서명 — 글자 입력은 모양을 안 바꾼다. */
function shapeOf(json: string): string {
  return JSON.stringify(JSON.parse(json), (_k, v) =>
    typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? 0 : v);
}

/** 고친 게 있으면 버릴지 묻는다. 없으면 묻지 않고 true. */
export function confirmDiscard(dirty: boolean): boolean {
  return !dirty || window.confirm("Discard unsaved changes?\n저장하지 않은 변경 사항을 버릴까요?");
}
