"use client";

import { useEffect, useRef } from "react";

// 공용 모달 — Progress 상세 모달과 동일한 pl-modal* 스타일을 재사용한다.
// 신규 등록 폼·상세(보기/수정) 양쪽에서 사용. 배경 클릭/ESC 로 닫힌다.
export default function Modal({
  title,
  onClose,
  wide,
  children,
}: {
  title: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  children: React.ReactNode;
}) {
  const backdropMouseDown = useRef(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function onBackdropMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    backdropMouseDown.current = e.target === e.currentTarget;
  }

  function onBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (backdropMouseDown.current && e.target === e.currentTarget) {
      onClose();
    }
    backdropMouseDown.current = false;
  }

  return (
    <div
      className="pl-modal-backdrop"
      onMouseDown={onBackdropMouseDown}
      onClick={onBackdropClick}
      role="presentation"
    >
      <div
        className="pl-modal"
        style={wide ? { maxWidth: 1120 } : undefined}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="pl-modal-head">
          <span className="intl-title">
            <b>{title}</b>
          </span>
          <button type="button" className="pl-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="pl-modal-body">{children}</div>
      </div>
    </div>
  );
}
