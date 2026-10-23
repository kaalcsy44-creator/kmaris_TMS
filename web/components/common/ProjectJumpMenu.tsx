"use client";

/**
 * 프로젝트 팝업 머리의 ▾ — 프로젝트 번호·제목으로 다른 딜에 바로 건너간다.
 *
 * ‹ › 와 방향키는 바로 앞뒤 딜만 오간다. 열 칸 떨어진 딜로 가려면 열 번 눌러야 했다.
 * 펼치면 지금 목록(‹ › 가 도는 그 집합)이 번호순으로 서고, 글자를 치면 목록에 없는
 * 딜까지 전체에서 찾는다(목록 필터를 풀러 팝업을 닫지 않아도 되게).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { PipelineRow } from "@/lib/types";
import ProjectNo from "@/components/common/ProjectNo";
import CustomerName from "@/components/common/CustomerName";

export default function ProjectJumpMenu({
  listed,
  all,
  currentId,
  onPick,
}: {
  /** 지금 목록에 보이는 딜 — 번호순. 검색어가 없을 때 이것만 보인다. */
  listed: PipelineRow[];
  /** 검색 대상 전체 — 목록 필터 밖의 딜까지. */
  all: PipelineRow[];
  currentId: number;
  onPick: (rfqId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return listed;
    const words = needle.split(/\s+/);
    const hay = (r: PipelineRow) =>
      [r.project_no, r.project_title, r.customer, r.vessels || r.vessel, r.kmaris_rfq_no, r.customer_rfq_no, r.first_item]
        .filter(Boolean).join(" ").toLowerCase();
    const seen = new Set<number>();
    const pool = [...listed, ...all].filter((r) => (seen.has(r.rfq_id) ? false : (seen.add(r.rfq_id), true)));
    return pool.filter((r) => { const h = hay(r); return words.every((w) => h.includes(w)); });
  }, [q, listed, all]);
  const listedIds = useMemo(() => new Set(listed.map((r) => r.rfq_id)), [listed]);

  // 펼칠 때 지금 딜에 커서를 두고 그 줄이 보이게 스크롤.
  useEffect(() => {
    if (!open) return;
    const i = items.findIndex((r) => r.rfq_id === currentId);
    setHi(i >= 0 ? i : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => { if (q) setHi(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi, open, items]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  function pick(r: PipelineRow | undefined) {
    if (!r) return;
    setOpen(false);
    setQ("");
    if (r.rfq_id !== currentId) onPick(r.rfq_id);
  }

  return (
    <div className="pj-jump" ref={boxRef}>
      <button
        type="button"
        className={"pl-nav-btn pj-toggle" + (open ? " on" : "")}
        onClick={() => setOpen((o) => !o)}
        title="Jump to a project by number or name"
        aria-label="Jump to project"
        aria-expanded={open}
      >
        ▾
      </button>
      {open ? (
        <div
          className="pj-pop"
          role="dialog"
          aria-label="Jump to project"
          // 팝업 머리는 창을 끄는 손잡이다 — 목록 여백·스크롤바를 눌러도 창이 끌려가지 않게.
          onPointerDown={(e) => e.stopPropagation()}
        >
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Project no., title, customer, vessel…"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(items.length - 1, h + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
              else if (e.key === "Enter") { e.preventDefault(); pick(items[hi]); }
              else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); }
            }}
          />
          <ul ref={listRef} role="listbox">
            {items.map((r, i) => (
              <li key={r.rfq_id} data-i={i}>
                <button
                  type="button"
                  className={(i === hi ? "hi " : "") + (r.rfq_id === currentId ? "cur" : "")}
                  onMouseEnter={() => setHi(i)}
                  onClick={() => pick(r)}
                >
                  <span className="pj-no">
                    {r.project_no ? <ProjectNo value={r.project_no} /> : <b>{r.kmaris_rfq_no || `#${r.rfq_id}`}</b>}
                  </span>
                  <span className="pj-title">
                    <span className="pj-name">
                      <b>{r.project_title || r.first_item || "—"}</b>
                      {r.vessels || r.vessel ? (
                        <span className="pj-vessel">
                          {" · "}{(r.vessels || r.vessel).split("\n").filter(Boolean).join(" · ")}
                        </span>
                      ) : null}
                    </span>
                    {r.customer && r.customer !== "—" ? (
                      <span className="pj-cust"><CustomerName name={r.customer} /></span>
                    ) : null}
                  </span>
                  <span className="pj-stage">
                    {r.cancelled ? "Closed" : `Stage ${r.stage}`}
                    {q && !listedIds.has(r.rfq_id) ? <small>not in list</small> : null}
                  </span>
                </button>
              </li>
            ))}
            {!items.length ? <li className="pj-empty">No matching project</li> : null}
          </ul>
          <div className="pj-foot">
            {q ? `${items.length} found in all projects` : `${listed.length} in the current list · type to search all`}
            {" · ↑↓ Enter"}
          </div>
        </div>
      ) : null}
    </div>
  );
}
