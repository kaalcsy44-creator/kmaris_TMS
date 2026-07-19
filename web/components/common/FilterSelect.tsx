"use client";

import { useEffect, useRef, useState } from "react";

// 공용 멀티 선택 드롭다운(체크박스) — Activity·Projects 등 목록 화면의 필터를 동일 폼으로
// 통일한다. 버튼은 고정폭(.filt-btn)이라 선택값이 바뀌어도 위치가 흔들리지 않는다.
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
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const summary =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? options.find((o) => o.value === selected[0])?.label ?? `${label} · 1`
        : `${label} · ${selected.length}`;
  function toggle(v: string) {
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  }
  return (
    <div className="filt" ref={ref}>
      <button type="button" className={`filt-btn${selected.length ? " on" : ""}`} onClick={() => setOpen((o) => !o)} title={label}>
        <span className="filt-lbl">{summary}</span>
        <span className="filt-caret" aria-hidden>▾</span>
      </button>
      {open ? (
        <div className="filt-menu" role="listbox">
          {options.length === 0 ? <div className="filt-none">—</div> : null}
          {options.map((o) => (
            <label key={o.value} className="filt-opt">
              <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
              <span>{o.label}</span>
            </label>
          ))}
          {selected.length ? (
            <button type="button" className="filt-clear" onClick={() => onChange([])}>Clear</button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
