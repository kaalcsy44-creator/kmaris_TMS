"use client";

import { useEffect, useRef } from "react";

// 공용 모달 — Progress 상세 모달과 동일한 pl-modal* 스타일을 재사용한다.
// 신규 등록 폼·상세(보기/수정) 양쪽에서 사용. 배경 클릭/ESC 로 닫힌다.
export default function Modal({
  title,
  onClose,
  wide,
  form,
  inline,
  children,
}: {
  title: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  // form: 입력 폼 전용 레이아웃 — 좁은 폭 + 본문을 세로 블록으로 스택(마스터 등록/수정 팝업용).
  // 기본 모달 본문은 Progress 상세용 좌우 2단 flex 라서, 폼에는 이 변형을 쓴다.
  form?: boolean;
  // inline: 오버레이·헤더·닫기 없이 본문만 흐름 안에 렌더(프로젝트 워크스페이스 임베드용).
  inline?: boolean;
  children: React.ReactNode;
}) {
  const backdropMouseDown = useRef(false);

  useEffect(() => {
    if (inline) return; // 임베드 모드에선 ESC 닫기 비활성(닫을 오버레이가 없음)
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, inline]);

  if (inline) {
    return <div className="embedded-detail">{children}</div>;
  }

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
        className={`pl-modal${form ? " pl-modal--form" : ""}`}
        style={wide && !form ? { maxWidth: 1120 } : undefined}
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
