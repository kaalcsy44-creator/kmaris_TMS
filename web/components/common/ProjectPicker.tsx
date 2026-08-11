"use client";

// 딜(프로젝트) 선택 드롭다운 — 번호만 늘어놓는 네이티브 <select> 대신, 한 줄에서
// "어느 딜인지"를 알아볼 수 있게 번호·업무 타입(Parts/Service 색)·고객 로고·고객명·
// 프로젝트명·선박을 함께 보여준다. 미분류 메일을 딜에 붙일 때 번호만 보고 고르기는
// 어렵다 — 사람이 기억하는 건 "그 크레인 건", "그 배" 쪽이다.
// 옵션에 이미지를 넣을 수 없어 CustomerSelect 와 같은 구조(버튼 + body portal 팝오버)로 짰다.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useCustomerLogo } from "@/lib/customerLogos";
import ProjectNo from "@/components/common/ProjectNo";
import WorkTypeBadge from "@/components/WorkTypeBadge";

export type ProjectPickOption = {
  rfqId: number;
  no: string;         // "P-026(260811)" — 없으면 KMS RFQ No.
  workType: string;   // "부품공급" | "서비스"
  customer: string;
  title: string;
  vessel: string;     // 여러 척이면 "MV A 외 2"
};

type MenuPos = { left: number; width: number; top?: number; bottom?: number };

// 팝오버 최소 폭 — 버튼(=칸)이 좁아도 한 줄이 접히지 않을 만큼은 편다.
const MENU_MIN_WIDTH = 460;

export default function ProjectPicker({
  value,
  options,
  onChange,
  placeholder = "— Select project —",
  disabled = false,
}: {
  value: number | "";
  options: ProjectPickOption[];
  onChange: (rfqId: number | "") => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [pos, setPos] = useState<MenuPos | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const logoFor = useCustomerLogo();

  function reposition() {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, MENU_MIN_WIDTH), window.innerWidth - 16);
    const spaceBelow = window.innerHeight - r.bottom;
    const openUp = spaceBelow < 280 && r.top > spaceBelow;
    setPos({
      // 넓힌 메뉴가 화면 밖으로 나가지 않게 오른쪽 끝에서 밀어 넣는다.
      left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
      width,
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
    // 스크롤·리사이즈에는 앵커를 따라 옮긴다(닫지 않는다). 메뉴 안쪽 스크롤은 제외.
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

  const selected = value === "" ? null : options.find((o) => o.rfqId === value) ?? null;
  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    if (!ql) return options;
    return options.filter((o) =>
      `${o.no} ${o.customer} ${o.title} ${o.vessel}`.toLowerCase().includes(ql)
    );
  }, [options, q]);

  function pick(id: number | "") {
    onChange(id);
    setOpen(false);
    setQ("");
  }

  return (
    <div className="pjpick">
      <button
        type="button"
        ref={btnRef}
        className="pjpick-btn"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="pjpick-val">
          {selected ? (
            <>
              <ProjectNo value={selected.no} />
              <WorkTypeBadge type={selected.workType} />
              <span className="pjpick-cust">{selected.customer}</span>
            </>
          ) : (
            <span className="pjpick-placeholder">{placeholder}</span>
          )}
        </span>
        <span className="pjpick-caret" aria-hidden>▾</span>
      </button>

      {open && pos && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              className="pjpick-menu"
              role="listbox"
              style={{ position: "fixed", left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom }}
            >
              <input
                className="pjpick-search"
                placeholder="🔍 Search project / customer / vessel…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                autoFocus
              />
              <ul className="pjpick-list">
                <li>
                  <button
                    type="button"
                    className={`pjpick-opt${value === "" ? " on" : ""}`}
                    onClick={() => pick("")}
                  >
                    <span className="pjpick-placeholder">{placeholder}</span>
                  </button>
                </li>
                {filtered.map((o) => {
                  const logo = logoFor(o.customer);
                  return (
                    <li key={o.rfqId}>
                      <button
                        type="button"
                        className={`pjpick-opt${o.rfqId === value ? " on" : ""}`}
                        onClick={() => pick(o.rfqId)}
                      >
                        <span className="pjpick-l1">
                          <ProjectNo value={o.no} />
                          <WorkTypeBadge type={o.workType} />
                          {logo ? <img className="cust-logo" src={logo} alt="" /> : null}
                          <span className="pjpick-cust">{o.customer || "—"}</span>
                        </span>
                        <span className="pjpick-l2">
                          <span className="pjpick-title">{o.title || "(untitled)"}</span>
                          {o.vessel ? <span className="pjpick-vessel">⚓ {o.vessel}</span> : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
                {filtered.length === 0 ? <li className="pjpick-empty">No matches</li> : null}
              </ul>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
