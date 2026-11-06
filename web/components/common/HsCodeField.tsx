"use client";

import { useMemo, useState } from "react";
import { suggestHsCodes, type HsSuggestLine, type HsSuggestResult } from "@/lib/api";

/* 문서(PI·CI)의 HS Code 칸 + 추천. 근거는 지난 문서 → 품목 마스터 → Claude 순이다
   (ktms/services/hs_suggest.py). 칸을 채우기만 하고 저장은 문서 저장으로 한다.
   문서에는 코드가 하나뿐이라(저장 시 전 품목에 반영), 줄마다 코드가 다르면 그 사실을 알린다. */

const SOURCE: Record<string, string> = { history: "Used before", master: "Item master", ai: "AI" };

/** 같은 코드를 받은 줄끼리 묶는다 — 줄이 많은 코드가 위로. 코드를 못 찾은 줄은 맨 아래. */
function groupLines(lines: HsSuggestLine[]) {
  const map = new Map<string, HsSuggestLine[]>();
  for (const ln of lines) map.set(ln.code, [...(map.get(ln.code) || []), ln]);
  return [...map.entries()].sort(
    ([a, x], [b, y]) => Number(!a) - Number(!b) || y.length - x.length,
  );
}

export default function HsCodeField({
  value,
  onChange,
  items,
  docNo,
}: {
  value: string;
  onChange: (v: string) => void;
  items: { part_no?: string; description?: string; maker?: string }[];
  /** 지금 편집 중인 문서 번호 — 이 문서의 값은 근거에서 뺀다. */
  docNo: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<HsSuggestResult | null>(null);
  const groups = useMemo(() => groupLines(result?.lines || []), [result]);
  const hasLines = items.some((i) => i.part_no || i.description);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      setResult(
        await suggestHsCodes(
          items.map(({ part_no, description, maker }) => ({ part_no, description, maker })),
          docNo,
        ),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Suggestion failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <label className="form-field">
        <span>HS Code (optional)</span>
        <div className="hs-input">
          <input value={value} onChange={(e) => onChange(e.target.value)} />
          <button
            type="button"
            className="btn sm"
            disabled={busy || !hasLines}
            title={hasLines ? "Suggest from past documents and the item master, then AI for the rest" : "Add items first"}
            onClick={run}
          >
            {busy ? "Checking…" : "Suggest"}
          </button>
        </div>
        {err ? <span className="action-err">{err}</span> : null}
      </label>
      {result ? (
        <div className="hs-panel">
          <div className="hs-head">
            <b>Suggested HS codes</b>
            <button type="button" className="btn sm" onClick={() => setResult(null)}>Close</button>
          </div>
          <div className="muted">Reference only — confirm with your customs broker before declaring.</div>
          {groups.map(([code, lines]) => (
            <div className="hs-row" key={code || "none"}>
              <div className="hs-codes">
                {code ? (
                  <button type="button" className={`btn sm hs-pick${value === code ? " on" : ""}`} onClick={() => onChange(code)}>
                    {code}
                  </button>
                ) : (
                  <span className="muted">No code</span>
                )}
                {[...new Set(lines.map((l) => l.alt).filter(Boolean))].map((alt) => (
                  <button
                    type="button"
                    key={alt}
                    className={`btn sm hs-pick alt${value === alt ? " on" : ""}`}
                    title="Alternative — classification could go either way"
                    onClick={() => onChange(alt)}
                  >
                    {alt}
                  </button>
                ))}
              </div>
              <div>
                {lines.map((ln) => (
                  <div className="hs-line" key={ln.no}>
                    <b>#{ln.no}</b> {ln.description || ln.part_no}
                    {ln.source ? <span className="hs-src">{SOURCE[ln.source]}</span> : null}
                    {ln.source === "ai" ? <span className={`vs-conf vs-conf-${ln.confidence}`}>{ln.confidence}</span> : null}
                    {ln.reason ? <div className="muted">{ln.reason}</div> : null}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {result.distinct > 1 ? (
            <div className="hs-warn">
              These lines fall under {result.distinct} different codes. This document holds one HS code, applied to every line when saved.
            </div>
          ) : null}
          {result.note ? <div className="hs-warn">{result.note}</div> : null}
          {result.sources.length ? (
            <div className="vs-src">
              Sources:{" "}
              {result.sources.map((s, i) => (
                <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer" title={s.title}>
                  {i + 1}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
