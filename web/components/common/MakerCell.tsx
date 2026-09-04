"use client";

// 품목표 셀용 제조사(Maker) 입력 — 등록된 메이커에서 고르거나, 없으면 그냥 적는다.
//
// 네이티브 <select> 로는 로고를 못 넣고, 무엇보다 **목록에 없는 이름을 적을 수 없다.**
// 메이커 명부는 우리가 아는 회사의 목록일 뿐이고 고객이 물어오는 부품의 제조사는 그보다
// 늘 넓다 — 처음 보는 이름 때문에 입력이 막히면 그 줄은 아예 비워진 채 저장된다.
// 그래서 칸은 평범한 글자 입력이고, 오른쪽 토글이 명부를 펼쳐 준다(ComboBox 와 같은 결).
//
// 메뉴는 body 로 portal + position:fixed 로 띄운다. 품목표가 가로 스크롤 상자
// (.table-wrap) 안에 있어, 셀 안에 절대배치하면 표 밖으로 나가는 순간 잘린다
// (CustomerSelect 가 같은 이유로 같은 방법을 쓴다).
//
// 적어 둔 이름이 명부의 회사와 맞으면 칸 왼쪽에 그 회사 로고가 선다. 로고는 "이 이름이
// 명부에 있는 그 회사"라는 확인이지 장식이 아니다 — MAN 과 MAN B&W 처럼 비슷한 이름이
// 섞이는 자리에서, 고른 것이 무엇인지 글자보다 먼저 알아보게 한다.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchSettingsMakers } from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";
import type { SettingsMaker } from "@/lib/types";

type MenuPos = { left: number; width: number; top?: number; bottom?: number };

/** 이름 비교용 — 대소문자·군더더기 공백·구두점을 지운다("MAN B&W" ↔ "man b w"). */
function norm(v: string): string {
  return v.replace(/[^0-9a-z가-힣]+/gi, " ").trim().toLowerCase().replace(/\s+/g, " ");
}

/** 등록된 메이커 명부. 자주 바뀌지 않아 캐시를 길게 둔다(분류 트리와 같은 취급). */
export function useMakerOptions(): SettingsMaker[] {
  const { data } = useCachedData("settings-makers", fetchSettingsMakers, 300_000);
  return data ?? [];
}

/** 이름 → 등록된 메이커(로고를 찾는 데 쓴다). 명부에 없으면 undefined. */
export function useMakerByName(): (name: string) => SettingsMaker | undefined {
  const makers = useMakerOptions();
  const byName = useMemo(() => {
    const m = new Map<string, SettingsMaker>();
    for (const k of makers) {
      const key = norm(k.name || "");
      if (key && !m.has(key)) m.set(key, k);
    }
    return m;
  }, [makers]);
  return (name: string) => (name ? byName.get(norm(name)) : undefined);
}

export default function MakerCell({
  value,
  onChange,
  onCommit,
  disabled,
  placeholder = "Maker",
  inputProps,
}: {
  value: string;
  onChange: (v: string) => void;
  /** 값을 "정했다"는 순간 — 목록에서 고르거나 Enter 를 쳤을 때. 한 글자마다 무언가를
   *  일으키면 안 되는 쓰임(선택한 줄에 일괄 적용)이 이 고리를 쓴다. */
  onCommit?: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** 엑셀식 편집 좌표·키 핸들러(useItemGridKeys 의 cell(row, col)). 그대로 input 에 붙는다. */
  inputProps?: Record<string, unknown>;
}) {
  const makers = useMakerOptions();
  const makerByName = useMakerByName();
  const [open, setOpen] = useState(false);
  // 열린 뒤 직접 친 글자가 있으면 그것으로 목록을 좁히고, 토글로 막 열었으면 전체를 보인다
  // (ComboBox 와 같은 규칙 — 값이 이미 있을 때 토글이 그 한 줄만 보여 주면 소용이 없다).
  const [typed, setTyped] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const hit = makerByName(value);

  function reposition() {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const openUp = spaceBelow < 240 && r.top > spaceBelow;
    setPos({
      left: r.left,
      width: Math.max(r.width, 240),
      top: openUp ? undefined : r.bottom + 3,
      bottom: openUp ? window.innerHeight - r.top + 3 : undefined,
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
      if (boxRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    // 표를 가로로 밀거나 창 크기가 바뀌면 메뉴가 셀을 따라온다(닫지 않는다).
    // 메뉴 안쪽 스크롤은 무시 — capture 단계라 그것까지 여기로 들어온다.
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

  const q = norm(value);
  const list = typed && q
    ? makers.filter((m) => norm(m.name || "").includes(q)
        || norm(m.specialization || "").includes(q))
    : makers;
  // 적어 둔 이름이 명부에 없다 — 그래도 그대로 저장된다는 것을 알려 둔다.
  const isNew = !!value.trim() && !hit;

  function pick(name: string) {
    onChange(name);
    onCommit?.(name);
    setOpen(false);
    setTyped(false);
  }

  return (
    <div className={`mk-cell${disabled ? " off" : ""}`} ref={boxRef}>
      {hit?.logo ? (
        <img className="mk-cell-logo" src={hit.logo} alt="" title={hit.name} />
      ) : null}
      <input
        {...inputProps}
        className="mk-cell-in"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        title={hit ? `${hit.name}${hit.country ? ` · ${hit.country}` : ""}` : value || placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setTyped(true);
          setOpen(true);
        }}
        onFocus={() => setTyped(false)}
        onKeyDown={(e) => {
          (inputProps?.onKeyDown as ((ev: typeof e) => void) | undefined)?.(e);
          if (e.key === "Enter" && onCommit) {
            e.preventDefault();
            setOpen(false);
            onCommit(value);
          }
        }}
      />
      <button
        type="button"
        className="mk-cell-toggle"
        tabIndex={-1}
        disabled={disabled}
        aria-label="Pick a registered maker"
        aria-expanded={open}
        onClick={() => {
          setTyped(false);
          setOpen((o) => !o);
        }}
      >
        ▾
      </button>

      {open && pos && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              className="mk-menu"
              role="listbox"
              style={{ position: "fixed", left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom }}
            >
              <ul className="mk-menu-list">
                {value ? (
                  <li>
                    <button type="button" className="mk-opt mk-opt--clear" onClick={() => pick("")}>
                      — Clear —
                    </button>
                  </li>
                ) : null}
                {list.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      className={`mk-opt${hit?.id === m.id ? " on" : ""}`}
                      onClick={() => pick(m.name)}
                    >
                      {m.logo ? <img className="mk-opt-logo" src={m.logo} alt="" /> : <span className="mk-opt-logo mk-opt-logo--none" aria-hidden />}
                      <span className="mk-opt-name">{m.name}</span>
                      {m.country ? <span className="mk-opt-sub">{m.country}</span> : null}
                    </button>
                  </li>
                ))}
                {list.length === 0 ? (
                  <li className="mk-menu-empty">
                    {makers.length ? "No registered maker matches." : "No maker registered yet."}
                  </li>
                ) : null}
              </ul>
              {/* 명부에 없어도 막지 않는다. 다만 새 이름이라는 것은 알려 준다 —
                  오타로 같은 회사를 둘로 만드는 일이 여기서 시작된다. */}
              <div className="mk-menu-foot">
                {isNew
                  ? <>“{value.trim()}” is not in the maker list — it will be saved as typed.</>
                  : <>Pick one, or just type a name that is not in the list.</>}
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

/* ── 벤더가 대 줄 수 있는 제조사 ─────────────────────────────────────────────
   분류 태그(CategoryTagPicker)와 같은 얼개이되 트리가 아니라 메이커 명부에서 고른다.
   분류가 "무엇을 다루나"라면 이쪽은 "누구 것을 대 주나"다 — 같은 '주기관 예비품'이라도
   MAN B&W 를 대 주는 곳과 Yanmar 를 대 주는 곳은 다른 회사다.

   글(Specialization)이 지금껏 이 일을 대신해 왔지만 적힌 이름은 표기가 흔들려
   (MAN B&W / MAN-B&W / MAN Energy Solutions) 그 이름으로 벤더를 되찾을 수 없었다. */

/** 읽기용 — 고른 메이커를 로고와 함께 세운다. max 를 주면 나머지는 "+N" 으로 접는다. */
export function MakerBadges({
  ids,
  max,
  empty = null,
}: {
  ids?: number[] | null;
  max?: number;
  empty?: React.ReactNode;
}) {
  const makers = useMakerOptions();
  const by = new Map(makers.map((m) => [m.id, m]));
  const picked = (ids ?? []).map((id) => by.get(id)).filter((m): m is SettingsMaker => !!m);
  if (!picked.length) return <>{empty}</>;
  const shown = max ? picked.slice(0, max) : picked;
  const rest = picked.length - shown.length;
  return (
    <span className="mk-tags">
      {shown.map((m) => (
        <span key={m.id} className="mk-tag" title={m.name}>
          {m.logo ? <img className="mk-tag-logo" src={m.logo} alt="" /> : null}
          {m.name}
        </span>
      ))}
      {rest > 0 ? (
        <span className="mk-tag mk-tag--more"
              title={picked.slice(shown.length).map((m) => m.name).join("\n")}>
          +{rest}
        </span>
      ) : null}
    </span>
  );
}

/** 편집용 — 고른 배지(×로 뺀다) + 명부에서 하나씩 더하는 칸. */
export function MakerTagPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: number[];
  onChange: (next: number[]) => void;
  disabled?: boolean;
}) {
  const makers = useMakerOptions();
  const [adding, setAdding] = useState("");
  const chosen = new Set(value);
  const by = new Map(makers.map((m) => [m.id, m]));
  const picked = value.map((id) => by.get(id)).filter((m): m is SettingsMaker => !!m);
  const addable = makers.filter((m) => !chosen.has(m.id));

  function add(id: number) {
    if (!id || chosen.has(id)) return;
    // 명부 순서(이름순)를 그대로 따른다 — 고른 순서로 두면 같은 회사가 볼 때마다 다르게 선다.
    onChange(makers.filter((m) => m.id === id || chosen.has(m.id)).map((m) => m.id));
  }

  return (
    <div className="form-field cat-picker">
      <span>Makers supplied</span>
      <div className="cat-picker-tags">
        {picked.length ? picked.map((m) => (
          <span key={m.id} className="mk-tag mk-tag--edit" title={m.name}>
            {m.logo ? <img className="mk-tag-logo" src={m.logo} alt="" /> : null}
            {m.name}
            {disabled ? null : (
              <button type="button" aria-label={`Remove ${m.name}`}
                      onClick={() => onChange(value.filter((v) => v !== m.id))}>×</button>
            )}
          </span>
        )) : <span className="hint-inline">Not registered yet.</span>}
      </div>
      {disabled ? null : (
        <div className="cat-picker-add">
          <select
            value={adding}
            onChange={(e) => { add(Number(e.target.value)); setAdding(""); }}
          >
            <option value="">— Add a maker —</option>
            {addable.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}{m.country ? ` · ${m.country}` : ""}
              </option>
            ))}
          </select>
        </div>
      )}
      <span className="hint-inline">
        Whose parts this company can actually supply — the answer to “who do we ask for a
        YANMAR spare?”. Register the maker under Partners ▸ Maker first; free-text brand
        names still belong in Specialization.
      </span>
    </div>
  );
}
