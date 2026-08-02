"use client";

import { useMemo, useState } from "react";
import { fetchCcPresets, saveCcPresets, type CcPreset } from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";

// CC 입력칸(칩) + 팀 공용 CC 주소록. 홍보 메일 작성 화면과 단계별 문서 발송 화면이
// 같은 주소록을 쓰도록 한 벌만 두고 공유한다.
//
// 값은 주소 배열로 주고받는다 — 쉼표 문자열을 쓰는 화면은 부모에서 join/split 한다.
// onPendingChange: 아직 Enter 로 확정하지 않고 입력칸에 남아 있는 글자. 발송 버튼을
// 바로 눌러도 그 주소가 빠지지 않도록 부모가 발송 시 함께 실어 보낸다.
export default function CcField({
  value,
  onChange,
  onPendingChange,
  label = "CC (multiple)",
  inputId = "cc-input",
}: {
  value: string[];
  onChange: (next: string[]) => void;
  onPendingChange?: (pending: string) => void;
  label?: string;
  inputId?: string;
}) {
  const { data, refresh } = useCachedData("marketing-cc-presets", fetchCcPresets);
  const presets = useMemo(() => data?.rows ?? [], [data]);

  const [input, setInput] = useState("");
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState({ email: "", label: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function setPending(v: string) {
    setInput(v);
    onPendingChange?.(v);
  }

  // 여러 주소를 한 번에 붙여넣는 경우(쉼표·세미콜론·공백 구분)도 받는다.
  function commit(raw: string) {
    const parts = raw.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    for (const p of parts) if (!next.includes(p)) next.push(p);
    onChange(next);
    setPending("");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "," || e.key === ";") {
      e.preventDefault();
      commit(input);
    } else if (e.key === "Backspace" && !input && value.length) {
      onChange(value.slice(0, -1));
    }
  }

  function togglePreset(addr: string) {
    onChange(value.includes(addr) ? value.filter((x) => x !== addr) : [...value, addr]);
  }

  async function persist(rows: CcPreset[]) {
    setBusy(true);
    setErr("");
    try {
      await saveCcPresets(rows);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save the CC address book.");
    } finally {
      setBusy(false);
    }
  }

  async function addPreset() {
    const email = draft.email.trim();
    if (!email) return;
    if (presets.some((p) => p.email.toLowerCase() === email.toLowerCase())) {
      setDraft({ email: "", label: "" });
      return;
    }
    await persist([...presets, { email, label: draft.label.trim() }]);
    setDraft({ email: "", label: "" });
  }

  // 지금 CC 칸에 넣은 주소 중 아직 주소록에 없는 것들 — 한 번에 등록할 수 있게.
  const unsaved = value.filter(
    (a) => !presets.some((p) => p.email.toLowerCase() === a.toLowerCase())
  );

  return (
    <div className="form-field">
      <span className="compose-sig-head">
        {label}
        <span className="compose-sig-actions">
          <button
            type="button"
            className={`chip-btn${edit ? " on" : ""}`}
            onClick={() => setEdit((v) => !v)}
            title="Add or remove frequently used CC addresses"
          >
            {edit ? "Done" : "Manage"}
          </button>
        </span>
      </span>

      <div className="cc-chips" onClick={() => document.getElementById(inputId)?.focus()}>
        {value.map((addr) => (
          <span key={addr} className="cc-chip">
            {addr}
            <button
              type="button"
              className="cc-chip-x"
              onClick={() => onChange(value.filter((x) => x !== addr))}
              aria-label={`Remove ${addr}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          id={inputId}
          className="cc-chip-input"
          type="email"
          value={input}
          placeholder={value.length ? "" : "Add address, Enter"}
          onChange={(e) => setPending(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => commit(input)}
        />
      </div>

      {/* 등록해 둔 주소 — 클릭하면 위 CC 칸에 들어가고, 다시 누르면 빠진다. */}
      {presets.length ? (
        <div className="cc-presets">
          {presets.map((p) => {
            const on = value.includes(p.email);
            return (
              <span key={p.email} className={`cc-preset${on ? " on" : ""}`}>
                <button
                  type="button"
                  className="cc-preset-pick"
                  onClick={() => togglePreset(p.email)}
                  title={p.email}
                >
                  {on ? "✓ " : "+ "}
                  {p.label || p.email}
                </button>
                {edit ? (
                  <button
                    type="button"
                    className="cc-chip-x"
                    disabled={busy}
                    onClick={() => persist(presets.filter((x) => x.email !== p.email))}
                    aria-label={`Remove ${p.email} from the address book`}
                  >
                    ×
                  </button>
                ) : null}
              </span>
            );
          })}
        </div>
      ) : null}

      {edit ? (
        <div className="cc-preset-add">
          <input
            type="email"
            placeholder="email@company.com"
            value={draft.email}
            onChange={(e) => setDraft((c) => ({ ...c, email: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addPreset();
              }
            }}
          />
          <input
            placeholder="Display name (optional)"
            value={draft.label}
            onChange={(e) => setDraft((c) => ({ ...c, label: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addPreset();
              }
            }}
          />
          <button
            type="button"
            className="btn ghost"
            disabled={busy || !draft.email.trim()}
            onClick={addPreset}
          >
            + Add
          </button>
          {unsaved.length ? (
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => persist([...presets, ...unsaved.map((email) => ({ email, label: "" }))])}
              title={unsaved.join(", ")}
            >
              Save current CC ({unsaved.length})
            </button>
          ) : null}
        </div>
      ) : null}

      {err ? <div className="action-err">{err}</div> : null}
      <div className="compose-hint">
        Register frequently used CC addresses under Manage and add them with one click
        next time (shared across the team).
      </div>
    </div>
  );
}
