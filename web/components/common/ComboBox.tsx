"use client";

import { useEffect, useRef, useState } from "react";

// 선택 + 자유입력 겸용 콤보박스.
// 네이티브 <datalist> 는 현재 입력값으로 목록을 필터링해서, 값이 이미 선택돼 있으면
// 토글을 눌러도 그 값 하나만 보인다. 이 컴포넌트는 토글/포커스로 열면 항상 전체 목록을
// 보여주고, 사용자가 입력하기 시작하면 그때부터 부분일치로 좁힌다. 목록에 없는 값도
// 그대로 입력·저장 가능.
// 키보드: ↑↓ 로 목록 안을 옮기고 Enter 로 고른다(Esc 닫기). 아무것도 짚지 않은 채
// Enter 를 누르면 적은 글자를 그대로 둔다 — 목록에 없는 값을 적는 길을 막지 않게.
// 언제 열리나: 글자를 적을 때 · ▾ · ↓ · 빈 칸을 클릭할 때뿐. 포커스만으로는 열지 않고
// (Tab 으로 지나가거나 창이 열리며 포커스가 와도 목록이 아래 칸을 덮지 않게) 포커스가
// 떠나면 닫는다 — 열린 채 남은 목록이 아래 칸을 덮고 있으면, 그 칸을 누른다는 게
// 목록의 기존 값을 고르는 일이 되어 버린다(신규 등록 중 기존 업체가 불려 오던 원인).
// 마우스를 올린 것만으로는 Enter 대상이 되지 않는다 — ↑↓ 로 짚은 값만 Enter 로 고른다.
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
  const [active, setActive] = useState(-1); // ↑↓ 로 짚은 값(평평한 목록 기준), -1 = 없음
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);

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
  const flat = groups.flatMap((g) => g.options);
  const count = flat.length;

  // 거르는 글자가 바뀌거나 닫히면 짚은 자리를 지운다(엉뚱한 값이 짚혀 있지 않게).
  useEffect(() => setActive(-1), [q, open]);

  // 짚은 값이 메뉴 밖으로 나가면 따라 내린다.
  useEffect(() => {
    if (active < 0) return;
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function pick(o: string) {
    onChange(o);
    setOpen(false);
  }

  return (
    <div className="combobox" ref={ref}>
      <input
        ref={inputRef}
        className="combobox-input"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
          setTyped(true);
          setOpen(true);
        }}
        onMouseDown={() => {
          // 빈 칸을 누르면 고를 거리를 보여 준다. 값이 있으면 글자를 고치려는 클릭이다.
          if (!value.trim()) {
            setTyped(false);
            setOpen(true);
          }
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
          } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) {
              setOpen(true);
              return;
            }
            if (!count) return;
            const step = e.key === "ArrowDown" ? 1 : -1;
            setActive((i) => (i < 0 ? (step > 0 ? 0 : count - 1) : (i + step + count) % count));
          } else if (e.key === "Enter" && open && active >= 0 && active < count) {
            e.preventDefault(); // 폼 제출로 새지 않게
            pick(flat[active]);
          }
        }}
      />
      <button
        type="button"
        className="combobox-toggle"
        tabIndex={-1}
        disabled={disabled}
        aria-label="Toggle options"
        // 입력칸의 포커스를 빼앗지 않는다 — 빼앗으면 onBlur 가 먼저 닫고 클릭이 다시 연다.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setTyped(false);
          setOpen((v) => !v);
          inputRef.current?.focus();
        }}
      >
        ▾
      </button>
      {open && count ? (
        <ul
          className="combobox-menu"
          role="listbox"
          ref={menuRef}
          // 스크롤바를 끌거나 묶음 제목을 눌러도 입력칸 포커스가 남아 목록이 닫히지 않게.
          onMouseDown={(e) => e.preventDefault()}
        >
          {groups.map((g, gi) => (
            <li key={g.label || "_"} className="combobox-group" role="presentation">
              {g.label ? <div className="combobox-group-label">{g.label}</div> : null}
              <ul role="group" aria-label={g.label || undefined}>
                {g.options.map((o, oi) => {
                  const idx = groups.slice(0, gi).reduce((n, x) => n + x.options.length, 0) + oi;
                  return (
                    <li
                      key={o}
                      role="option"
                      data-idx={idx}
                      aria-selected={o === value}
                      className={[o === value ? "on" : "", idx === active ? "active" : ""]
                        .filter(Boolean)
                        .join(" ")}
                      // onMouseDown(+preventDefault): input blur 전에 선택이 먼저 처리되게 한다.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pick(o);
                      }}
                    >
                      {o}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
