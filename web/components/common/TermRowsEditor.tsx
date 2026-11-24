"use client";

import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import type { TermRow } from "@/lib/types";
import { suggestClauses, type ClauseSuggestion } from "@/lib/api";

/* 견적서 Remark · Terms & Conditions 행 편집기(4단계). 한 행 = 문서의 한 줄(•).
   체크한 행만 인쇄하고, 순서는 손잡이 끌기나 ↑↓ 로 바꾼다. 아래 입력칸에 국문(문장·단어)을
   넣으면 영문 문장을 추천받아 행으로 더한다. 저장은 견적 저장으로 한다. */
export default function TermRowsEditor({
  kind,
  rows,
  onChange,
  standard = [],
}: {
  kind: "remark" | "terms";
  rows: TermRow[];
  onChange: (rows: TermRow[]) => void;
  /** 표준 문장(지금 거래조건 값이 들어간 문구) — id 있는 행의 자동 문구이자 되살릴 목록. */
  standard?: { id: string; text: string }[];
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [points, setPoints] = useState<ClauseSuggestion[] | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // 새로 만든 행으로 커서를 옮긴다 — 값이 부모를 돌아 내려온 다음이라야 칸이 있다.
  const focusAt = useRef<number | null>(null);
  useEffect(() => {
    if (focusAt.current == null) return;
    const el = listRef.current?.querySelectorAll<HTMLTextAreaElement>("textarea")[focusAt.current];
    focusAt.current = null;
    el?.focus();
  }, [rows]);

  const autoText = (r: TermRow) => standard.find((s) => s.id === r.id)?.text ?? "";
  const textOf = (r: TermRow) => r.text ?? autoText(r);
  const printed = rows.filter((r) => r.on && textOf(r).trim()).length;
  const allOn = rows.length > 0 && rows.every((r) => r.on);
  const missing = standard.filter((s) => !rows.some((r) => r.id === s.id));
  const has = (text: string) => rows.some((r) => textOf(r).trim() === text);

  const patch = (i: number, p: Partial<TermRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i));
  const add = (texts: string[]) => {
    const fresh = [...new Set(texts.map((t) => t.trim()))].filter((t) => t && !has(t));
    if (fresh.length) onChange([...rows, ...fresh.map((text) => ({ text, on: true }))]);
  };

  function insertBlank(at: number) {
    focusAt.current = at;
    onChange([...rows.slice(0, at), { text: "", on: true }, ...rows.slice(at)]);
  }

  function move(from: number, to: number) {
    if (from === to || to < 0 || to >= rows.length) return;
    const next = [...rows];
    const [r] = next.splice(from, 1);
    next.splice(to, 0, r);
    onChange(next);
  }

  function edit(i: number, value: string) {
    const row = rows[i];
    // 여러 줄을 붙여 넣으면 줄마다 한 행으로 나눈다.
    const [first, ...rest] = value.split(/\r?\n/);
    // 표준 문장을 원래 문구로 되돌려 적으면 다시 자동 문구(거래조건을 따라감)로 친다.
    const head: TermRow = { ...row, text: row.id && first === autoText(row) ? undefined : first };
    onChange([
      ...rows.slice(0, i),
      head,
      ...rest.filter((l) => l.trim()).map((l) => ({ text: l.trim(), on: row.on })),
      ...rows.slice(i + 1),
    ]);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>, i: number) {
    if (e.nativeEvent.isComposing) return; // 한글 조합 중 Enter 는 글자 확정이다
    if (e.key === "Enter") {
      e.preventDefault();
      insertBlank(i + 1);
    } else if (e.key === "Backspace" && !rows[i].id && !rows[i].text) {
      e.preventDefault();
      if (i > 0) focusAt.current = i - 1;
      remove(i);
    }
  }

  async function suggest() {
    setBusy(true);
    setErr(null);
    try {
      setPoints((await suggestClauses(draft.trim(), kind)).points);
    } catch (e) {
      setPoints(null);
      setErr(e instanceof Error ? e.message : "Suggestion failed");
    } finally {
      setBusy(false);
    }
  }

  function done() {
    setPoints(null);
    setErr(null);
    setDraft("");
  }

  const endDrag = () => {
    setDrag(null);
    setOver(null);
  };
  const onDrop = (e: DragEvent, i: number) => {
    if (drag == null) return;
    e.preventDefault();
    e.stopPropagation();
    move(drag, i);
    endDrag();
  };

  return (
    <div className="trows">
      <div className="clause-head">
        <span className="clause-title">{kind === "terms" ? "Clauses printed on the quotation" : "Lines printed on the quotation"}</span>
        <span className="clause-count">{printed} / {rows.length}</span>
        {missing.length ? (
          <button
            type="button"
            className="btn sm clause-all"
            title="Bring back the standard clauses that were deleted (added unticked)"
            onClick={() => onChange([...rows, ...missing.map((s) => ({ id: s.id, on: false }))])}
          >
            Restore standard ({missing.length})
          </button>
        ) : null}
        {rows.length ? (
          <button type="button" className="btn sm clause-all" onClick={() => onChange(rows.map((r) => ({ ...r, on: !allOn })))}>
            {allOn ? "Clear all" : "Select all"}
          </button>
        ) : null}
        <button type="button" className="btn sm clause-all" onClick={() => insertBlank(rows.length)}>
          + Add row
        </button>
      </div>

      {rows.length ? (
        <ul className="trow-list" ref={listRef}>
          {rows.map((r, i) => (
            <li
              key={i}
              className={
                "trow" + (r.on ? " on" : "") + (drag === i ? " dragging" : "") +
                (drag != null && over === i && drag !== i ? (drag < i ? " drop-after" : " drop-before") : "")
              }
              onDragOver={(e) => {
                if (drag == null) return;
                e.preventDefault();
                if (over !== i) setOver(i);
              }}
              onDrop={(e) => onDrop(e, i)}
            >
              <span
                className="trow-grip"
                draggable
                title="Drag to reorder"
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", "");
                  const li = e.currentTarget.closest("li");
                  if (li) e.dataTransfer.setDragImage(li, 10, 10);
                  setDrag(i);
                }}
                onDragEnd={endDrag}
              >
                ⠿
              </span>
              <input
                type="checkbox"
                checked={r.on}
                title="Print on the quotation"
                aria-label={`Print row ${i + 1}`}
                onChange={(e) => patch(i, { on: e.target.checked })}
              />
              <div className="trow-text">
                <textarea
                  rows={1}
                  value={textOf(r)}
                  aria-label={`Row ${i + 1}`}
                  onChange={(e) => edit(i, e.target.value)}
                  onKeyDown={(e) => onKey(e, i)}
                />
              </div>
              <span className="trow-tools">
                {r.id && r.text != null ? (
                  <button
                    type="button"
                    className="trow-btn"
                    title="Back to the standard wording (follows the terms above)"
                    aria-label="Reset to standard wording"
                    onClick={() => patch(i, { text: undefined })}
                  >
                    ↺
                  </button>
                ) : null}
                <button type="button" className="trow-btn" title="Move up" aria-label="Move up" disabled={i === 0} onClick={() => move(i, i - 1)}>
                  ↑
                </button>
                <button type="button" className="trow-btn" title="Move down" aria-label="Move down" disabled={i === rows.length - 1} onClick={() => move(i, i + 1)}>
                  ↓
                </button>
                <button type="button" className="trow-btn del" title="Delete row" aria-label="Delete row" onClick={() => remove(i)}>
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="trow-empty">No lines yet.</div>
      )}

      <div className="trow-compose">
        <textarea
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type in Korean (국문) — sentences or just words, one point per line. English works too."
          aria-label="Text to turn into English"
        />
        <div className="trow-compose-btns">
          <button type="button" className="btn sm primary" disabled={busy || !draft.trim()} onClick={suggest}>
            {busy ? "Writing…" : "Suggest English"}
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={!draft.trim()}
            title="Add each line as a row exactly as typed"
            onClick={() => {
              add(draft.split("\n"));
              done();
            }}
          >
            Add as typed
          </button>
        </div>
        {err ? <span className="action-err">{err}</span> : null}
        {points ? (
          <div className="trow-sugg">
            <div className="trow-sugg-head">
              <b>Suggested wording</b>
              <button
                type="button"
                className="btn sm primary"
                title="Add the first wording of every point not added yet"
                onClick={() => {
                  add(points.filter((p) => !p.options.some(has)).map((p) => p.options[0]));
                  done();
                }}
              >
                Add all
              </button>
              <button type="button" className="btn sm" onClick={done}>Close</button>
            </div>
            {points.map((p, pi) => (
              <div className="trow-point" key={pi}>
                {p.source ? <div className="muted">{p.source}</div> : null}
                {p.options.map((o) => (
                  <div className="trow-opt" key={o}>
                    <span>{o}</span>
                    <button type="button" className="btn sm" disabled={has(o)} onClick={() => add([o])}>
                      {has(o) ? "Added" : "+ Add"}
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
