"use client";

import { createContext, useContext, useMemo } from "react";

/** 단계 작업 화면의 표시 모드.
 *  read  — 저장된 값을 입력란 껍데기 없이 "무엇을 입력했나" 로 훑어보는 모드(수정 불가).
 *  edit  — 지금까지의 동작. 입력·저장.
 *  화면 DOM 은 두 모드가 같다 — 껍데기만 CSS 로 벗긴다. 그래서 모드를 오가도
 *  컴포넌트가 언마운트되지 않고, 편집 중이던 값이 날아가지 않는다. */
export type ViewMode = "read" | "edit";

type Ctx = { mode: ViewMode; setMode: (m: ViewMode) => void };

// 기본값 edit — 프로바이더 밖(목록 모달 등)에서 쓰이는 편집기는 지금까지처럼 동작한다.
const ViewModeCtx = createContext<Ctx>({ mode: "edit", setMode: () => undefined });

export function ViewModeProvider({
  mode,
  setMode,
  children,
}: {
  mode: ViewMode;
  setMode: (m: ViewMode) => void;
  children: React.ReactNode;
}) {
  const value = useMemo(() => ({ mode, setMode }), [mode, setMode]);
  return <ViewModeCtx.Provider value={value}>{children}</ViewModeCtx.Provider>;
}

export function useViewMode(): Ctx {
  return useContext(ViewModeCtx);
}

/** 편집기 한 곳에서 쓰는 헬퍼.
 *  canEdit(권한)와 표시 모드를 합쳐 "지금 이 폼을 만질 수 있나(editing)"를 낸다.
 *  readMode 는 '권한은 있는데 읽기모드라서 잠긴' 상태 — 권한 부족 안내문과 구분해야 해서 따로 준다.
 *  fieldsetProps 는 <fieldset {...fieldsetProps}> 로 그대로 펼쳐 쓴다. */
export function useEditGate(canEdit: boolean) {
  const { mode } = useViewMode();
  const readMode = mode === "read";
  const editing = canEdit && !readMode;
  return {
    editing,
    readMode,
    fieldsetProps: {
      className: "form-fieldset" + (readMode ? " vm-read" : ""),
      disabled: !editing,
    },
  };
}
