"use client";

import { useEffect, useRef, useState } from "react";

// 선택 + 자유입력 겸용 콤보박스.
// 네이티브 <datalist> 는 현재 입력값으로 목록을 필터링해서, 값이 이미 선택돼 있으면
// 토글을 눌러도 그 값 하나만 보인다. 이 컴포넌트는 토글/포커스로 열면 항상 전체 목록을
// 보여주고, 사용자가 입력하기 시작하면 그때부터 부분일치로 좁힌다. 목록에 없는 값도
// 그대로 입력·저장 가능.
/** 목록을 묶음으로 나눠 보여줄 때 — 묶음 제목 + 그 안의 값들.
 *  예: "Already used"(이미 적어 둔 지역) / "Countries"(나머지 국가). */
export type ComboSection = { label: string; options: readonly string[] };

export default function ComboBox({
  value,
  onChange,
  options,
  sections,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options?: readonly string[];
  /** 주면 options 대신 이것을 쓴다 — 묶음마다 제목을 얹어 보여준다. */
  sections?: readonly ComboSection[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(false); // 열린 뒤 사용자가 직접 입력했는지
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  // 입력을 시작했으면 현재 텍스트로 필터, 아니면(토글/포커스로 막 열었으면) 전체 목록.
  const q = typed ? value.trim().toLowerCase() : "";
  const keep = (o: string) => !q || o.toLowerCase().includes(q);
  // 묶음이 주어지면 묶음째로 거른다 — 걸러 내고 빈 묶음은 제목만 남으므로 뺀다.
  const groups: ComboSection[] = (
    sections?.length
      ? sections.map((g) => ({ label: g.label, options: g.options.filter(keep) }))
      : [{ label: "", options: (options ?? []).filter(keep) }]
  ).filter((g) => g.options.length);
  const count = groups.reduce((n, g) => n + g.options.length, 0);

  return (
    <div className="combobox" ref={ref}>
      <input
        className="combobox-input"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
          setTyped(true);
          setOpen(true);
        }}
        onFocus={() => {
          setTyped(false);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <button
        type="button"
        className="combobox-toggle"
        tabIndex={-1}
        disabled={disabled}
        aria-label="Toggle options"
        onClick={() => {
          setTyped(false);
          setOpen((v) => !v);
        }}
      >
        ▾
      </button>
      {open && count ? (
        <ul className="combobox-menu" role="listbox">
          {groups.map((g) => (
            <li key={g.label || "_"} className="combobox-group" role="presentation">
              {g.label ? <div className="combobox-group-label">{g.label}</div> : null}
              <ul role="group" aria-label={g.label || undefined}>
                {g.options.map((o) => (
                  <li
                    key={o}
                    role="option"
                    aria-selected={o === value}
                    className={o === value ? "on" : ""}
                    // onMouseDown(+preventDefault): input blur 전에 선택이 먼저 처리되게 한다.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onChange(o);
                      setOpen(false);
                    }}
                  >
                    {o}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
