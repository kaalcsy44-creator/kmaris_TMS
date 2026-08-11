"use client";

// 딜(프로젝트) 선택 드롭다운 — 줄 모양은 네이티브 <select> 때와 같다
// ("P-026(260811) · SOLUNA MARINETECH · ORIENTAL Crane Spare parts"). 거기에 세 가지만
// 얹었다: 번호를 업무 타입 색(Parts 파랑 / Service 초록)으로, 고객명 앞에 로고, 끝에 선박명.
// <option> 안에는 이미지도 색도 넣을 수 없어 CustomerSelect 와 같은 구조
// (버튼 + body portal 팝오버)로 짰다 — 보이는 것은 그대로 두고 그릴 수만 있게.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useCustomerLogo } from "@/lib/customerLogos";
import ProjectNo from "@/components/common/ProjectNo";

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
          {selected ? <OptionLine o={selected} logo={logoFor(selected.customer)} /> : (
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
                {filtered.map((o) => (
                  <li key={o.rfqId}>
                    <button
                      type="button"
                      className={`pjpick-opt${o.rfqId === value ? " on" : ""}`}
                      onClick={() => pick(o.rfqId)}
                    >
                      <OptionLine o={o} logo={logoFor(o.customer)} />
                    </button>
                  </li>
                ))}
                {filtered.length === 0 ? <li className="pjpick-empty">No matches</li> : null}
              </ul>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

// 한 줄 = 예전 <option> 문구 그대로 + 번호 색·로고·선박명. 나머지는 본문 색 그대로 둔다
// (고객명을 굵게 하거나 제목을 회색으로 내리면 정작 읽어야 할 것이 뒤로 물러난다).
function OptionLine({ o, logo }: { o: ProjectPickOption; logo?: string }) {
  const service = (o.workType || "부품공급") === "서비스";
  return (
    <span className="pjpick-line">
      <span className={`pjpick-no ${service ? "service" : "parts"}`}>
        <ProjectNo value={o.no} />
      </span>
      {logo ? <img className="cust-logo" src={logo} alt="" /> : null}
      <span className="pjpick-text">
        {[o.customer, o.title, o.vessel].filter(Boolean).join(" · ")}
      </span>
    </span>
  );
}
