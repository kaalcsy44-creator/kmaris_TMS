"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
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
  // 매 요청에 순번을 매겨, 늦게 도착한 이전 검색 응답이 최신 결과를 덮어쓰지 않게 한다.
  const reqSeq = useRef(0);

  // 입력 디바운스(250ms) 후 검색. 2글자 미만은 조회하지 않는다.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      reqSeq.current += 1; // 진행 중이던 응답도 무효화
      setResults([]);
      setOpen(false);
      setBusy(false);
      return;
    }
    setBusy(true);
    const seq = (reqSeq.current += 1);
    const t = setTimeout(() => {
      globalSearch(term)
        .then((d) => {
          if (seq !== reqSeq.current) return; // 더 최신 검색이 있으면 이 응답은 버린다
          setResults(d.results);
          setActive(0);
          setOpen(true);
        })
        .catch(() => {
          if (seq === reqSeq.current) setResults([]);
        })
        .finally(() => {
          if (seq === reqSeq.current) setBusy(false);
        });
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

  /** 결과 패널을 닫고 입력을 비운다. 이동은 부르는 쪽이 한다(router.push 또는 <Link>). */
  const dismiss = useCallback(() => {
    setOpen(false);
    setQ("");
    setResults([]);
  }, []);

  const go = useCallback(
    (r: SearchResult) => {
      dismiss();
      router.push(r.href);
    },
    [dismiss, router]
  );

  /** 개요(읽기 전용)로. 검색 결과의 기본 이동(그 단계 편집 화면)과 짝을 이룬다. */
  const goOverview = useCallback(
    (r: SearchResult) => {
      dismiss();
      router.push(`/project?rfq=${r.rfq_id}&view=overview`);
    },
    [dismiss, router]
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
      if (!r) return;
      // Shift+Enter → 개요. 손을 키보드에서 떼지 않고 읽기 전용 화면으로 갈 수 있게.
      if (e.shiftKey) goOverview(r);
      else go(r);
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
              /* 결과 한 줄에 문이 둘 — 본문은 그 단계 편집 화면으로(기존 동작), ⤢ 는 읽기
                 전용 개요로. 개요 링크를 본문 버튼 안에 넣으면 버튼 중첩이라 못 넣는다. */
              <div
                key={`${r.rfq_id}-${i}`}
                className={`gsearch-item${i === active ? " on" : ""}`}
                onMouseEnter={() => setActive(i)}
              >
                <button type="button" className="gsearch-item-go" onClick={() => go(r)}>
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
                <Link
                  className="gsearch-item-ov"
                  href={`/project?rfq=${r.rfq_id}&view=overview`}
                  onClick={dismiss}
                  title="Open the project overview (read-only) — Shift+Enter"
                  aria-label={`Open ${r.project_no || `RFQ-${r.rfq_id}`} overview`}
                >
                  ⤢
                </Link>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
