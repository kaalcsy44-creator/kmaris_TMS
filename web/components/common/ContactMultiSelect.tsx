"use client";

// 한 회사의 담당자 복수 선택 — 줄마다 이름과 이메일을 함께 보여 준다(이름이 같은 레코드도
// 이메일로 가려 고른다). 맨 처음 고른 사람이 대표(★)이고, 나머지는 함께 받은 사람이다.
// 메뉴는 CustomerSelect 처럼 body 로 portal + position:fixed 로 띄워 모달 클리핑을 피한다.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CustomerOption } from "@/lib/types";

type MenuPos = { left: number; width: number; top?: number; bottom?: number };

export default function ContactMultiSelect({
  options,
  mainId,
  ccIds,
  onToggle,
  onMakeMain,
  placeholder = "Select contact…",
  disabled = false,
}: {
  options: CustomerOption[];
  mainId: number | "";
  ccIds: number[];
  onToggle: (id: number) => void;
  onMakeMain: (id: number) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
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
      width: Math.max(r.width, 320),
      top: openUp ? undefined : r.bottom + 4,
      bottom: openUp ? window.innerHeight - r.top + 4 : undefined,
    });
  }

  useEffect(() => {
    if (!open) return;
    reposition();
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();   // 모달까지 닫히지 않게
        setOpen(false);
      }
    }
    function onShift(e: Event) {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      reposition();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onShift, true);
    window.addEventListener("resize", onShift);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onShift, true);
      window.removeEventListener("resize", onShift);
    };
  }, [open]);

  const main = mainId === "" ? undefined : options.find((c) => c.id === mainId);
  const extras = ccIds.map((id) => options.find((c) => c.id === id)).filter(Boolean) as CustomerOption[];
  const count = (main ? 1 : 0) + extras.length;

  return (
    <div className="cust-select contact-multi">
      <button
        type="button"
        ref={btnRef}
        className="cust-select-btn"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="cust-select-val">
          {main ? (
            <span className="contact-multi-val">
              {main.contact?.trim() || "(no contact)"}
              {extras.length ? <span className="contact-multi-more">+{extras.length}</span> : null}
            </span>
          ) : (
            <span className="cust-select-placeholder">{placeholder}</span>
          )}
        </span>
        <span className="cust-select-caret" aria-hidden>▾</span>
      </button>

      {open && pos && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              className="cust-select-menu"
              role="listbox"
              aria-multiselectable
              style={{ position: "fixed", left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom }}
            >
              <ul className="cust-select-list">
                {options.map((c) => {
                  const isMain = c.id === mainId;
                  const on = isMain || ccIds.includes(c.id);
                  return (
                    <li key={c.id}>
                      <div className={`cust-select-opt contact-multi-opt${on ? " on" : ""}`}>
                        <button type="button" className="contact-multi-pick" onClick={() => onToggle(c.id)}>
                          <span className={`cust-opt-check${on ? " on" : ""}`} aria-hidden>
                            {on ? "✓" : ""}
                          </span>
                          <span className="contact-multi-text">
                            <span className="contact-multi-name">{c.contact?.trim() || "(no contact)"}</span>
                            <span className="contact-multi-email">{c.email?.trim() || "no email"}</span>
                          </span>
                        </button>
                        {isMain ? (
                          <span className="contact-multi-star on" title="Main contact (Attn on documents)">★ Main</span>
                        ) : on ? (
                          <button
                            type="button"
                            className="contact-multi-star"
                            title="Make this the main contact"
                            onClick={() => onMakeMain(c.id)}
                          >
                            ☆ Main
                          </button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
                {options.length === 0 ? <li className="cust-select-empty">No contacts</li> : null}
              </ul>
              <div className="cust-select-foot">
                <span className="cust-select-count">{count} selected</span>
                <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
                  Done
                </button>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
