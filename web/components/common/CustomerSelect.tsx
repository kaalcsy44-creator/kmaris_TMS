"use client";

// 고객사 선택 드롭다운 — 각 옵션 앞에 등록된 회사 로고를 함께 표시한다.
// 네이티브 <select>는 이미지를 못 넣으므로 버튼+팝오버로 구성한다. 모달 내부의
// overflow 클리핑을 피하려고 메뉴는 body 로 portal + position:fixed 로 띄운다.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CustomerOption } from "@/lib/types";

type MenuPos = { left: number; width: number; top?: number; bottom?: number };

export default function CustomerSelect({
  value,
  options,
  onChange,
  emptyLabel = "— None —",
  disabled = false,
  showContact = false,
  multiple = false,
  selectedIds = [],
}: {
  value: number | "";
  options: CustomerOption[];
  onChange: (id: number | "") => void;
  emptyLabel?: string;       // "" 선택 시 표기(예: "— Prospect (not registered) —")
  disabled?: boolean;
  // 레코드 1건 = 담당자 1명이라 같은 회사가 여러 번 나온다. 담당자를 골라야 하는
  // 화면(메일 발송 등)에서는 회사명 뒤에 담당자 이름을 붙여 구분할 수 있게 한다.
  showContact?: boolean;
  // 복수 선택 — 한 번 고를 때마다 닫지 않고 체크를 토글한다(같은 회사 담당자 여럿을
  // 이어서 담는 화면용). 선택 상태는 부모가 selectedIds 로 넘긴다.
  multiple?: boolean;
  selectedIds?: number[];
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [pos, setPos] = useState<MenuPos | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function reposition() {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const openUp = spaceBelow < 260 && r.top > spaceBelow;
    setPos({
      left: r.left,
      width: r.width,
      top: openUp ? undefined : r.bottom + 4,
      bottom: openUp ? window.innerHeight - r.top + 4 : undefined,
    });
  }

  useEffect(() => {
    if (open) reposition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    // 스크롤/리사이즈 시 메뉴를 앵커(버튼)에 맞춰 재배치해 따라오게 한다(닫지 않음).
    // 단, 메뉴 내부 목록(overflow 스크롤) 스크롤은 무시 — 그때 재배치할 필요가 없고,
    // capture 단계라 내부 스크롤도 여기로 잡혀 예전엔 메뉴가 닫히던 버그의 원인이었다.
    function onShift(e: Event) {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      reposition();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onShift, true);
    window.addEventListener("resize", onShift);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onShift, true);
      window.removeEventListener("resize", onShift);
    };
  }, [open]);

  const selected = value === "" ? null : options.find((c) => c.id === value) ?? null;
  const ql = q.trim().toLowerCase();
  const filtered = ql
    ? options.filter((c) =>
        `${c.name} ${showContact ? c.contact ?? "" : ""}`.toLowerCase().includes(ql)
      )
    : options;

  function pick(id: number | "") {
    onChange(id);
    // 복수 선택 모드에서는 메뉴와 검색어를 그대로 둔다 — 같은 검색 결과에서 여러
    // 담당자를 이어서 체크할 수 있어야 한다(고를 때마다 닫히면 매번 다시 찾아야 한다).
    if (multiple) return;
    setOpen(false);
    setQ("");
  }

  function optionInner(c: CustomerOption, checked = false) {
    return (
      <span className="cust-name">
        {multiple ? (
          <span className={`cust-opt-check${checked ? " on" : ""}`} aria-hidden>
            {checked ? "✓" : ""}
          </span>
        ) : null}
        {c.logo ? <img className="cust-logo" src={c.logo} alt="" /> : null}
        <span className="cust-name-text">{c.name}</span>
        {showContact ? (
          <span className="cust-opt-contact">{c.contact?.trim() || "(no contact)"}</span>
        ) : null}
      </span>
    );
  }

  return (
    <div className="cust-select">
      <button
        type="button"
        ref={btnRef}
        className="cust-select-btn"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="cust-select-val">
          {selected ? optionInner(selected) : <span className="cust-select-placeholder">{emptyLabel}</span>}
        </span>
        <span className="cust-select-caret" aria-hidden>▾</span>
      </button>

      {open && pos && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              className="cust-select-menu"
              role="listbox"
              style={{ position: "fixed", left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom }}
            >
              <input
                className="cust-select-search"
                placeholder="🔍 Search…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                autoFocus
              />
              <ul className="cust-select-list">
                {/* 복수 선택에는 "선택 안 함"이 없다 — 체크를 다시 눌러 빼면 된다. */}
                {multiple ? null : (
                  <li>
                    <button
                      type="button"
                      className={`cust-select-opt${value === "" ? " on" : ""}`}
                      onClick={() => pick("")}
                    >
                      <span className="cust-select-placeholder">{emptyLabel}</span>
                    </button>
                  </li>
                )}
                {filtered.map((c) => {
                  const on = multiple ? selectedIds.includes(c.id) : value === c.id;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        className={`cust-select-opt${on ? " on" : ""}`}
                        onClick={() => pick(c.id)}
                      >
                        {optionInner(c, on)}
                      </button>
                    </li>
                  );
                })}
                {filtered.length === 0 ? <li className="cust-select-empty">No matches</li> : null}
              </ul>
              {multiple ? (
                <div className="cust-select-foot">
                  <span className="cust-select-count">{selectedIds.length} selected</span>
                  <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
                    Done
                  </button>
                </div>
              ) : null}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
