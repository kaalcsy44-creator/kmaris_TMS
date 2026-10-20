"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// 공용 멀티 선택 드롭다운(체크박스) — Activity·Projects 등 목록 화면의 필터를 동일 폼으로
// 통일한다. 버튼은 고정폭(.filt-btn)이라 선택값이 바뀌어도 위치가 흔들리지 않는다.
//
// 메뉴 머리(검색 + All)는 목록 위에 붙박이다. 전에는 "전체로 되돌리기"(Clear)가 목록
// 맨 아래에 있어, 벤더처럼 긴 목록에서는 하나 고른 뒤 전체로 돌아가려면 끝까지 내려야
// 했다. All 은 "아무것도 안 고름 = 전부"라는 이 필터의 규칙(selected=[])을 그대로 켠다.

/** 항목이 이보다 많을 때만 검색칸을 단다 — Status 처럼 서너 개짜리에 검색은 군더더기다. */
const SEARCH_MIN = 7;

export default function FilterSelect({
  label,
  allLabel,
  options,
  selected,
  onChange,
}: {
  label: string;
  allLabel: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  // 열 때마다 빈 검색으로 시작하고, 검색칸에 바로 쓸 수 있게 초점을 준다.
  useEffect(() => {
    if (!open) return;
    setQ("");
    searchRef.current?.focus();
  }, [open]);

  const searchable = options.length >= SEARCH_MIN;
  const needle = q.trim().toLowerCase();
  const shown = useMemo(
    () => (needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options),
    [options, needle]
  );

  const summary =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? options.find((o) => o.value === selected[0])?.label ?? `${label} · 1`
        : `${label} · ${selected.length}`;
  function toggle(v: string) {
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  }
  /** 검색에 걸린 것을 한꺼번에 더한다(이미 고른 것은 그대로). */
  function addMatches() {
    onChange(Array.from(new Set([...selected, ...shown.map((o) => o.value)])));
  }
  return (
    <div className="filt" ref={ref}>
      <button type="button" className={`filt-btn${selected.length ? " on" : ""}`} onClick={() => setOpen((o) => !o)} title={label}>
        <span className="filt-lbl">{summary}</span>
        <span className="filt-caret" aria-hidden>▾</span>
      </button>
      {open ? (
        <div className="filt-menu filt-menu--list" role="listbox" aria-multiselectable>
          <div className="filt-head">
            {searchable ? (
              <input
                ref={searchRef}
                className="filt-search"
                type="search"
                placeholder="Search…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  // 하나만 걸렸으면 Enter 로 바로 고른다.
                  if (e.key === "Enter" && shown.length === 1) {
                    e.preventDefault();
                    toggle(shown[0].value);
                  }
                }}
              />
            ) : null}
            <label className="filt-opt filt-all">
              <input type="checkbox" checked={selected.length === 0} onChange={() => onChange([])} />
              <span>{allLabel}</span>
            </label>
            {needle && shown.length > 1 ? (
              <button type="button" className="filt-match" onClick={addMatches}>
                Select {shown.length} matches
              </button>
            ) : null}
          </div>
          <div className="filt-list">
            {shown.length === 0 ? <div className="filt-none">{needle ? "No match" : "—"}</div> : null}
            {shown.map((o) => (
              <label key={o.value} className="filt-opt">
                <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
