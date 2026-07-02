"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { globalSearch } from "@/lib/api";
import type { SearchResult } from "@/lib/types";
import { tr } from "@/lib/labels";

// 매칭 스니펫이 길면 잘라 표시.
function snippet(s: string, max = 80): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// 상단바 전역 검색 — RFQ(프로젝트) 단위로 식별자·품목·연락처·문서번호를 훑어
// 결과를 드롭다운으로 보여주고, 선택 시 해당 단계 작업 화면으로 이동한다.
export default function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 입력 디바운스(250ms) 후 검색. 2글자 미만은 조회하지 않는다.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      setOpen(false);
      setBusy(false);
      return;
    }
    setBusy(true);
    const t = setTimeout(() => {
      globalSearch(term)
        .then((d) => {
          setResults(d.results);
          setActive(0);
          setOpen(true);
        })
        .catch(() => setResults([]))
        .finally(() => setBusy(false));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  // 바깥 클릭 시 닫기.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // Ctrl+K / Cmd+K 로 검색창 포커스.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = useCallback(
    (r: SearchResult) => {
      setOpen(false);
      setQ("");
      setResults([]);
      router.push(r.href);
    },
    [router]
  );

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[active];
      if (r) go(r);
    }
  }

  return (
    <div className="gsearch" ref={boxRef}>
      <svg className="gsearch-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          d="M21 21l-4.3-4.3M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z"
        />
      </svg>
      <input
        ref={inputRef}
        className="gsearch-input"
        placeholder="Search everything… (Ctrl+K)"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => {
          if (results.length) setOpen(true);
        }}
        onKeyDown={onKeyDown}
        aria-label="Global search"
      />
      {open ? (
        <div className="gsearch-panel">
          {busy && results.length === 0 ? (
            <div className="gsearch-empty">Searching…</div>
          ) : results.length === 0 ? (
            <div className="gsearch-empty">No matches for “{q.trim()}”.</div>
          ) : (
            results.map((r, i) => (
              <button
                key={`${r.rfq_id}-${i}`}
                type="button"
                className={`gsearch-item${i === active ? " on" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(r)}
              >
                <div className="gsearch-item-main">
                  <span className="gsearch-proj">{r.project_no || `RFQ-${r.rfq_id}`}</span>
                  <span className="gsearch-cust">{r.customer}</span>
                  {r.vessel ? <span className="gsearch-vessel">· {r.vessel}</span> : null}
                  {r.status ? <span className="gsearch-status">{tr(r.status)}</span> : null}
                </div>
                <div className="gsearch-item-sub">
                  {r.project_title ? <span className="gsearch-title">{r.project_title}</span> : null}
                  {r.matched_label ? (
                    <span className="gsearch-match">
                      <b>{r.matched_label}:</b> {snippet(r.matched_text)}
                    </span>
                  ) : null}
                </div>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
