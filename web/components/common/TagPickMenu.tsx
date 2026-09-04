"use client";

// 태그를 여러 개 한 번에 고르는 메뉴 — 분류(Category)·제조사(Maker) 태그 칸이 함께 쓴다.
//
// 원래는 네이티브 <select> 하나였다. 고르면 목록이 닫히므로 분류 셋을 달려면 창을 세 번
// 여닫아야 하고, 그 사이 트리를 처음부터 다시 훑어야 한다 — 25개짜리 목록에서 이건
// 고르기가 아니라 찾기의 반복이다. 여기서는 열어 둔 채로 체크만 하고 한 번에 닫는다.
//
// 메뉴는 body 로 portal + position:fixed 로 띄운다. 이 칸이 서는 회사정보 창이 제
// 스크롤 상자를 갖고 있어, 안에 절대배치하면 목록 아래쪽이 창 밖으로 잘린다
// (CustomerSelect·MakerCell 이 같은 이유로 같은 방법을 쓴다).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type TagOption = {
  id: number;
  /** 목록과 검색에 쓰는 이름. 분류는 "대 > 중 > 소" 경로 전체다. */
  name: string;
  /** 이름 뒤에 옅게 붙는 단서(제조사의 소재지 등). */
  sub?: string;
  logo?: string;
};

type MenuPos = { left: number; width: number; top?: number; bottom?: number };

export default function TagPickMenu({
  label,
  options,
  value,
  onChange,
  disabled,
  searchPlaceholder = "🔍 Search…",
}: {
  label: string;
  options: TagOption[];
  value: number[];
  onChange: (next: number[]) => void;
  disabled?: boolean;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [pos, setPos] = useState<MenuPos | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const chosen = new Set(value);

  function reposition() {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const openUp = spaceBelow < 280 && r.top > spaceBelow;
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
    // 창을 굴리면 메뉴가 단추를 따라온다(닫지 않는다). 메뉴 안쪽 목록 스크롤은 빼야
    // 한다 — capture 단계라 그것까지 여기로 들어온다.
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

  const ql = q.trim().toLowerCase();
  const list = ql
    ? options.filter((o) => `${o.name} ${o.sub ?? ""}`.toLowerCase().includes(ql))
    : options;

  function toggle(id: number) {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // 고른 순서가 아니라 목록 순서로 세운다 — 순서로 두면 같은 회사가 볼 때마다 다르게 선다.
    onChange(options.filter((o) => next.has(o.id)).map((o) => o.id));
  }

  return (
    <div className="tpm">
      <button
        type="button"
        ref={btnRef}
        className="tpm-btn"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{label}</span>
        <span className="tpm-caret" aria-hidden>▾</span>
      </button>

      {open && pos && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              className="tpm-menu"
              role="listbox"
              aria-multiselectable
              style={{ position: "fixed", left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom }}
            >
              <input
                className="tpm-search"
                placeholder={searchPlaceholder}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                autoFocus
              />
              <ul className="tpm-list">
                {list.map((o) => {
                  const on = chosen.has(o.id);
                  return (
                    <li key={o.id}>
                      {/* 골라도 닫지 않는다 — 이 메뉴의 존재 이유가 여러 개를 이어서
                          고르는 것이다. 닫는 것은 Done·바깥 클릭·Esc 셋 다 된다. */}
                      <button
                        type="button"
                        className={`tpm-opt${on ? " on" : ""}`}
                        role="option"
                        aria-selected={on}
                        onClick={() => toggle(o.id)}
                      >
                        <span className={`tpm-check${on ? " on" : ""}`} aria-hidden>{on ? "✓" : ""}</span>
                        {o.logo ? <img className="tpm-logo" src={o.logo} alt="" /> : null}
                        <span className="tpm-name" title={o.name}>{o.name}</span>
                        {o.sub ? <span className="tpm-sub">{o.sub}</span> : null}
                      </button>
                    </li>
                  );
                })}
                {list.length === 0 ? (
                  <li className="tpm-empty">
                    {options.length ? "No matches" : "Nothing to pick yet"}
                  </li>
                ) : null}
              </ul>
              <div className="tpm-foot">
                <span className="tpm-count">{value.length} selected</span>
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
