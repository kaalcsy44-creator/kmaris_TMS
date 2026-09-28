"use client";

import { useState } from "react";
import { decideVendorTag } from "@/lib/api";
import type { VendorTagSource, VendorTagSuggestion } from "@/lib/types";

// 거래선 태그 제안 목록 — "이 메이커/분류가 견적·메일에서 확인됐는데 추가할까요?"
// 알림(종)과 Company info 창이 같은 목록을 쓴다. 근거(어느 견적·메일의 어느 문장)를
// 함께 보여 주어야 사람이 판단할 수 있다 — 이름만 내밀면 눌러 보고 확인하러 가야 한다.

const SRC_LABEL: Record<VendorTagSource["type"], string> = {
  quote: "Quote",
  po: "P/O",
  email: "Email",
  bought: "Bought",
};

export default function VendorTagSuggestions({
  company,
  items,
  onDecided,
  compact = false,
}: {
  company: string;
  items: VendorTagSuggestion[];
  /** 한 건을 처리했다 — accepted=true 면 태그에 들어갔다. */
  onDecided?: (s: VendorTagSuggestion, accepted: boolean) => void;
  /** 근거를 한 줄만(종 안처럼 좁은 자리). */
  compact?: boolean;
}) {
  const [busy, setBusy] = useState<string>("");
  const [done, setDone] = useState<Record<string, "added" | "dismissed">>({});
  const [err, setErr] = useState("");

  async function decide(s: VendorTagSuggestion, accept: boolean) {
    const key = `${s.kind}:${s.ref_id}`;
    setBusy(key);
    setErr("");
    try {
      await decideVendorTag(accept ? "accept" : "dismiss", { company, kind: s.kind, ref_id: s.ref_id });
      setDone((d) => ({ ...d, [key]: accept ? "added" : "dismissed" }));
      onDecided?.(s, accept);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className={`vts${compact ? " compact" : ""}`}>
      {items.map((s) => {
        const key = `${s.kind}:${s.ref_id}`;
        const state = done[key];
        const srcs = compact ? s.sources.slice(0, 1) : s.sources.slice(0, 3);
        return (
          <div key={key} className={`vts-row${state ? " decided" : ""}`}>
            <div className="vts-main">
              <span className={`vts-kind ${s.kind}`}>{s.kind === "maker" ? "Maker" : "Category"}</span>
              <b className="vts-label">{s.label}</b>
              {s.sources.length > 1 ? <span className="vts-count">×{s.sources.length}</span> : null}
              <span className="vts-actions">
                {state ? (
                  <span className={`vts-state ${state}`}>{state === "added" ? "✓ Added" : "Dismissed"}</span>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn tiny primary"
                      disabled={!!busy}
                      onClick={(e) => { e.stopPropagation(); decide(s, true); }}
                      title={`Add ${s.label} to ${company}'s ${s.kind === "maker" ? "Makers supplied" : "Item categories"}`}
                    >
                      ＋ Add
                    </button>
                    <button
                      type="button"
                      className="btn tiny"
                      disabled={!!busy}
                      onClick={(e) => { e.stopPropagation(); decide(s, false); }}
                      title="Not relevant — don't suggest this again for this company"
                    >
                      Dismiss
                    </button>
                  </>
                )}
              </span>
            </div>
            {srcs.map((src, i) => (
              <div key={i} className="vts-src">
                <span className="vts-src-type">{SRC_LABEL[src.type] ?? src.type}</span>
                {src.project_no ? <span className="vts-src-proj">{src.project_no}</span> : null}
                {src.date ? <span className="vts-src-date">{src.date}</span> : null}
                <span className="vts-src-text" title={src.subject || src.text}>{src.text}</span>
              </div>
            ))}
          </div>
        );
      })}
      {err ? <div className="vts-err">{err}</div> : null}
    </div>
  );
}
