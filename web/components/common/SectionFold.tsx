"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

// 화면의 큰 묶음(개요의 Stages · Mail · Items)을 접었다 펴는 공용 훅과 제목 버튼.
// 어느 묶음을 접어 뒀는지는 localStorage 에 묶음 id 별로 남겨 새로고침 후에도 유지된다.
// 접기는 DOM 을 지우지 않고 CSS 로만 한다 — 인쇄물에는 접어 둔 것도 다 나와야 한다.

const KEY_PREFIX = "ktms.section.";

export type SectionFold = {
  open: boolean;
  toggle: () => void;
};

export function useSectionFold(id: string, initial = true): SectionFold {
  // 서버 렌더와 첫 그림은 initial 로 맞추고(hydration 불일치 방지), 저장해 둔 값은
  // 그린 뒤에 읽어 반영한다.
  const [open, setOpen] = useState(initial);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY_PREFIX + id);
      if (raw === "0") setOpen(false);
      else if (raw === "1") setOpen(true);
    } catch {
      /* private mode — 무시 */
    }
  }, [id]);

  const toggle = useCallback(() => {
    setOpen((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(KEY_PREFIX + id, next ? "1" : "0");
      } catch {
        /* quota/private mode — 무시 */
      }
      return next;
    });
  }, [id]);

  return { open, toggle };
}

/** 묶음 제목 — 제목 줄 자체가 접기 버튼이다(옆의 링크·버튼은 그대로 눌린다). */
export function FoldTitle({
  fold,
  label,
  children,
}: {
  fold: SectionFold;
  /** 접기/펴기 툴팁에 쓸 묶음 이름. */
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="sec-fold"
      aria-expanded={fold.open}
      title={fold.open ? `Collapse ${label}` : `Expand ${label}`}
      onClick={fold.toggle}
    >
      <span className="sec-fold-caret" aria-hidden>
        {fold.open ? "▾" : "▸"}
      </span>
      {children}
    </button>
  );
}
