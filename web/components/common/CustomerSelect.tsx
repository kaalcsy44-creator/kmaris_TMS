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
}: {
  value: number | "";
  options: CustomerOption[];
  onChange: (id: number | "") => void;
  emptyLabel?: string;       // "" 선택 시 표기(예: "— Prospect (not registered) —")
  disabled?: boolean;
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
    // 스크롤/리사이즈 시 메뉴가 떨어져 보이지 않도록 닫는다(재계산 대신 단순 닫기).
    function onShift() {
      setOpen(false);
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
  const filtered = ql ? options.filter((c) => c.name.toLowerCase().includes(ql)) : options;

  function pick(id: number | "") {
    onChange(id);
    setOpen(false);
    setQ("");
  }

  function optionInner(c: CustomerOption) {
    return (
      <span className="cust-name">
        {c.logo ? <img className="cust-logo" src={c.logo} alt="" /> : null}
        <span className="cust-name-text">{c.name}</span>
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
                <li>
                  <button
                    type="button"
                    className={`cust-select-opt${value === "" ? " on" : ""}`}
                    onClick={() => pick("")}
                  >
                    <span className="cust-select-placeholder">{emptyLabel}</span>
                  </button>
                </li>
                {filtered.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className={`cust-select-opt${value === c.id ? " on" : ""}`}
                      onClick={() => pick(c.id)}
                    >
                      {optionInner(c)}
                    </button>
                  </li>
                ))}
                {filtered.length === 0 ? <li className="cust-select-empty">No matches</li> : null}
              </ul>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
