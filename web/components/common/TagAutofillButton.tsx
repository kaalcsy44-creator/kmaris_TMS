"use client";

import { useRef, useState } from "react";
import type { AutofillTag, TagAutofill, TagAutofillResult } from "@/lib/tagAutofill";

/** 태그 칸 옆의 ✨ Auto-fill — 거래 기록과 홈페이지에서 나온 것을 칸에 바로 넣고, 무엇을
 *  왜 넣었는지 아래에 적는다. 저장은 하지 않는다(틀린 것은 ×로 빼고 Save).
 *
 *  단추와 결과를 훅으로 나눈 것은 자리 때문이다 — 단추는 고르는 칸 옆에, 결과는 그 아래 줄에 선다. */
export function useTagAutofillField({
  run,
  field,
  value,
  onChange,
}: {
  run?: TagAutofill;
  field: "categories" | "makers";
  value: number[];
  onChange: (next: number[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<TagAutofillResult | null>(null);
  const [added, setAdded] = useState<AutofillTag[]>([]);
  // 홈페이지를 읽는 30초 사이에 사람이 칸을 고칠 수 있다 — 끝난 시점의 값에 얹는다.
  const live = useRef({ value, onChange });
  live.current = { value, onChange };

  async function go() {
    if (!run || busy) return;
    setBusy(true);
    setRes(null);
    try {
      const r = await run();
      const fresh = r[field].filter((t) => !live.current.value.includes(t.id));
      if (fresh.length) live.current.onChange([...live.current.value, ...fresh.map((t) => t.id)]);
      setAdded(fresh);
      setRes(r);
    } finally {
      setBusy(false);
    }
  }

  const button = run ? (
    <button type="button" className="btn sm" disabled={busy} onClick={() => void go()}
            title="Fill from past quotes and orders and from the company's website. Nothing is saved until you press Save.">
      {busy ? "Reading…" : "✨ Auto-fill"}
    </button>
  ) : null;

  const report = busy ? (
    <span className="hint-inline">Reading past records and the website — 20–60 s.</span>
  ) : res ? (
    <div className="tag-auto">
      {added.length ? (
        <span className="action-ok">
          Added {added.length}: {added.map((t) => `${t.name} (${t.why})`).join(", ")} — remove any that are wrong, then Save.
        </span>
      ) : (
        <span className="hint-inline">Nothing new to add.</span>
      )}
      {res.notes.length ? <span className="hint-inline">{res.notes.join(" ")}</span> : null}
    </div>
  ) : null;

  return { button, report, result: res };
}
