"use client";

// 벤더 선택 드롭다운 — 기본 <select> 는 옵션 안에 이미지를 넣을 수 없어, 회사 로고를
// 같이 보여주려고 커스텀 드롭다운으로 구현했다(ProjectSelect 와 같은 구조).
// 로고는 옵션에 실려 오면 그걸 쓰고, 없으면 vendorLogos 캐시(벤더명→data URL)에서 찾는다.
// 로고가 없는 벤더도 이름 시작 위치가 어긋나지 않도록 빈 자리를 남겨 준다.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useVendorLogo } from "@/lib/vendorLogos";

// name 은 로고를 찾는 열쇠(벤더명)이자 기본 표시 문구. 한 줄에 날짜·견적번호 등을
// 같이 보여줘야 하면 label 로 표시 내용을 따로 넘긴다.
// uses = 그 벤더와의 거래 건수(서버 집계). 넘어오면 자주 거래하는 벤더를 위쪽
// 그룹으로 올린다 — 벤더가 수십 곳이라 이름순만으로는 매번 스크롤해야 해서다.
export type VendorSelectOption = { id: number; name: string; logo?: string; label?: ReactNode; uses?: number };

// 상단 그룹에 올릴 최대 벤더 수. 너무 길면 "위쪽 = 자주 쓰는 것" 이라는 이점이 사라진다.
const FREQUENT_MAX = 8;

export default function VendorSelect({
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled,
}: {
  value: number | "";
  onChange: (id: number | "") => void;
  options: VendorSelectOption[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // 키보드 이동 위치. -1 = 첫 항목(선택 해제 = placeholder).
  const [active, setActive] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const logoFor = useVendorLogo();
  const selected = options.find((o) => o.id === value) ?? null;

  // 자주 거래하는 벤더를 앞으로 빼고, 나머지는 받은 순서(이름순) 그대로 뒤에 붙인다.
  // 같은 벤더가 두 번 보이지 않게 위로 올린 건 아래 목록에서 뺀다. uses 가 실려 오지
  // 않는 목록(Vendor RFQ·Vendor Quote 선택 등)은 순서를 그대로 둔다.
  const { ordered, frequentCount } = useMemo(() => {
    const top = options
      .filter((o) => (o.uses ?? 0) > 0)
      .sort((a, b) => (b.uses ?? 0) - (a.uses ?? 0) || a.name.localeCompare(b.name))
      .slice(0, FREQUENT_MAX);
    if (top.length < 2) return { ordered: options, frequentCount: 0 };  // 1곳뿐이면 나눌 이유가 없다.
    const ids = new Set(top.map((o) => o.id));
    return {
      ordered: [...top, ...options.filter((o) => !ids.has(o.id))],
      frequentCount: top.length,
    };
  }, [options]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function openMenu() {
    setActive(ordered.findIndex((o) => o.id === value));
    setOpen(true);
  }
  function pick(id: number | "") {
    onChange(id);
    setOpen(false);
  }
  // 기본 <select> 를 대신하는 만큼 키보드 조작(↑↓·Enter·Esc·Home/End)도 그대로 살린다.
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => Math.min(ordered.length - 1, Math.max(-1, i + step)));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(-1);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(ordered.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(active < 0 ? "" : ordered[active].id);
    }
  }

  function Label({ o }: { o: VendorSelectOption }) {
    const logo = o.logo || logoFor(o.name);
    return (
      <span className="vsel-label">
        {logo ? (
          <img className="vsel-logo" src={logo} alt="" />
        ) : (
          <span className="vsel-logo vsel-logo-blank" aria-hidden />
        )}
        <span className="vsel-name">{o.label ?? o.name}</span>
      </span>
    );
  }

  return (
    <div className={"vsel" + (disabled ? " disabled" : "")} ref={ref}>
      <button
        type="button"
        className="vsel-btn"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        {selected ? <Label o={selected} /> : <span className="vsel-placeholder">{placeholder}</span>}
        <span className="vsel-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open ? (
        <ul className="vsel-list" role="listbox">
          <li
            className={"vsel-item" + (active === -1 ? " active" : "") + (value === "" ? " on" : "")}
            role="option"
            aria-selected={value === ""}
            onMouseEnter={() => setActive(-1)}
            onClick={() => pick("")}
          >
            <span className="vsel-placeholder">{placeholder}</span>
          </li>
          {ordered.map((o, i) => (
            <Fragment key={o.id}>
              {/* 두 그룹으로 나뉜 경우에만 구분 머리글을 끼운다. */}
              {frequentCount > 0 && i === 0 ? <li className="vsel-group" role="presentation">Frequent</li> : null}
              {frequentCount > 0 && i === frequentCount ? (
                <li className="vsel-group" role="presentation">All vendors</li>
              ) : null}
              <li
                ref={(el) => {
                  if (el && i === active) el.scrollIntoView({ block: "nearest" });
                }}
                className={"vsel-item" + (i === active ? " active" : "") + (o.id === value ? " on" : "")}
                role="option"
                aria-selected={o.id === value}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o.id)}
              >
                <Label o={o} />
              </li>
            </Fragment>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
