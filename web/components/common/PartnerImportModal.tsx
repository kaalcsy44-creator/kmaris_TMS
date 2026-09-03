"use client";

import { useEffect, useRef, useState } from "react";
import Modal from "@/components/common/Modal";
import {
  applyPartnerImport,
  readPartnerImport,
  type PartnerImportKind,
  type PartnerImportPlan,
  type PartnerImportRow,
  type PartnerImportSheet,
} from "@/lib/api";

const ACTION_LABEL: Record<PartnerImportRow["action"], string> = {
  new: "New",
  update: "Update",
  same: "No change",
  error: "Error",
};

/**
 * 명부 엑셀 업로드 — 올리고, 열을 맞추고, **무엇이 바뀌는지 보고 나서** 저장한다.
 *
 * 올리자마자 저장하지 않는 것이 이 창의 전부다. 68명이 든 명부에 잘못 덮어쓰면
 * 되돌릴 방법이 없고, 파일 하나로 그 일이 한 번에 일어난다. 그래서 저장 단추는
 * 판정표를 지나야만 나온다 — 그 표가 곧 확인이다.
 *
 * 미리보기와 저장은 서버에서 같은 계산(build_plan)을 쓴다. 화면이 따로 계산해
 * 보여 주면 둘이 어긋나는 날 미리보기는 확인이 아니라 장식이 된다.
 */
export default function PartnerImportButton({
  kind,
  onDone,
}: {
  kind: PartnerImportKind;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="btn"
        title="Register or update the whole list from an Excel · CSV file"
        onClick={() => setOpen(true)}
      >
        ⬆ Import
      </button>
      {open ? (
        <ImportWizard
          kind={kind}
          onClose={() => setOpen(false)}
          onDone={onDone}
        />
      ) : null}
    </>
  );
}

function ImportWizard({
  kind,
  onClose,
  onDone,
}: {
  kind: PartnerImportKind;
  onClose: () => void;
  onDone: () => void;
}) {
  const [sheet, setSheet] = useState<PartnerImportSheet | null>(null);
  const [mapping, setMapping] = useState<string[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [plan, setPlan] = useState<PartnerImportPlan | null>(null);
  const [skip, setSkip] = useState<Set<number>>(new Set()); // 사용자가 뺀 줄
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState<PartnerImportPlan["applied"] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function pick(file: File | null) {
    if (!file) return;
    setBusy("Reading the file…");
    setErr("");
    setPlan(null);
    setDone(null);
    setSkip(new Set());
    try {
      const s = await readPartnerImport(file, kind);
      setSheet(s);
      setMapping(s.mapping);
    } catch (e) {
      setSheet(null);
      setErr(e instanceof Error ? e.message : "Could not read the file.");
    } finally {
      setBusy("");
    }
  }

  // 열 지정이나 덮어쓰기 여부가 바뀌면 판정을 다시 받는다 — 화면이 스스로 계산하지
  // 않는다(저장과 같은 계산이어야 미리보기가 확인 구실을 한다).
  useEffect(() => {
    if (!sheet || done) return;
    let alive = true;
    setBusy("Checking against the list…");
    applyPartnerImport({
      kind, headers: sheet.headers, rows: sheet.rows, mapping,
      overwrite, dry_run: true,
    })
      .then((p) => { if (alive) { setPlan(p); setErr(""); } })
      .catch((e) => { if (alive) { setPlan(null); setErr(e instanceof Error ? e.message : "Preview failed"); } })
      .finally(() => { if (alive) setBusy(""); });
    return () => { alive = false; };
  }, [sheet, mapping, overwrite, kind, done]);

  const actionable = (plan?.rows ?? []).filter(
    (r) => (r.action === "new" || r.action === "update") && r.changes.length,
  );
  const accepted = actionable.filter((r) => !skip.has(r.i));

  async function save() {
    if (!sheet || !accepted.length) return;
    setBusy("Saving…");
    setErr("");
    try {
      const res = await applyPartnerImport({
        kind, headers: sheet.headers, rows: sheet.rows, mapping,
        overwrite, dry_run: false, accept: accepted.map((r) => r.i),
      });
      setPlan(res);
      setDone(res.applied ?? null);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy("");
    }
  }

  function toggle(i: number) {
    setSkip((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  const title = sheet?.title ?? (kind === "vendors" ? "Vendor" : kind === "makers" ? "Maker" : "Customer");

  return (
    <Modal title={`⬆ Import ${title} list`} onClose={onClose} maxWidth={1240}>
      <div className="pimp">
        {/* ① 파일 */}
        <section className="pimp-step">
          <h4>① Choose a file</h4>
          <p className="pimp-hint">
            Upload an Excel (.xlsx) or CSV file — the column names tell us which field is
            which. A file downloaded from <b>🖨 Print → Excel</b> on this screen can be edited
            and uploaded straight back.
          </p>
          <div className="pimp-file">
            {/* 파일 칸은 브라우저가 제 나름대로 그리고 그 글자는 OS 언어를 따른다 —
                한국어 윈도에서는 "파일 선택 / 선택된 파일 없음"이 나와 이 창만 두 말을
                쓰게 된다. 진짜 input 은 숨기고 우리 단추로 두드린다. */}
            <input
              ref={fileRef}
              className="pimp-file-input"
              type="file"
              accept=".xlsx,.xlsm,.xls,.csv"
              onChange={(e) => { pick(e.target.files?.[0] ?? null); e.target.value = ""; }}
            />
            <button
              type="button"
              className="btn"
              disabled={!!busy}
              onClick={() => fileRef.current?.click()}
            >
              {sheet ? "Choose another file…" : "Choose file…"}
            </button>
            <span className={`pimp-file-name${sheet ? "" : " none"}`}>
              {sheet
                ? `${sheet.filename} — ${sheet.headers.length} columns · ${sheet.rows.length} rows`
                  + (sheet.header_row > 1 ? ` (header on row ${sheet.header_row})` : "")
                : "No file selected"}
            </span>
          </div>
        </section>

        {/* ② 열 맞추기 — 아직 못 가는 걸음도 자리를 지킨다. 걸음이 셋이라고 번호를
            매겨 놓고 하나만 보이면, 나머지가 어디 갔는지가 먼저 궁금해진다. */}
        <section className={`pimp-step${sheet ? "" : " pimp-step--wait"}`}>
          <h4>② Match the columns</h4>
          {!sheet ? (
            <p className="pimp-wait">Waiting for a file — the columns appear here once one is loaded.</p>
          ) : (
          <>
            <p className="pimp-hint">
              Change anything guessed wrong. Columns left as <b>Ignore</b> are not read —
              counts that come from your deal history (inquiries, projects, items) are never
              written from a file.
            </p>
            <div className="pimp-map">
              {sheet.headers.map((h, i) => (
                <label key={i} className="pimp-map-col">
                  <span className="pimp-map-head" title={h}>{h || `(column ${i + 1})`}</span>
                  <select
                    value={mapping[i] ?? ""}
                    onChange={(e) =>
                      setMapping(mapping.map((m, idx) => (idx === i ? e.target.value : m)))
                    }
                  >
                    <option value="">— Ignore —</option>
                    {sheet.fields.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}{f.multi ? " (multiple)" : ""}
                      </option>
                    ))}
                  </select>
                  <span className="pimp-map-eg" title={sheet.rows[0]?.[i] ?? ""}>
                    {sheet.rows[0]?.[i] || " "}
                  </span>
                </label>
              ))}
            </div>
            <label className="check-inline pimp-ow">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
              />
              Overwrite fields that already have a value
              <span className="pimp-hint"> — off: fill only the empty ones, and add only the
              emails and phones that are not there yet.</span>
            </label>
          </>
          )}
        </section>

        {/* ③ 판정 */}
        <section className={`pimp-step${plan ? "" : " pimp-step--wait"}`}>
          <h4>③ Review what will change</h4>
          {!plan ? (
            <p className="pimp-wait">
              Every row is checked against the current list — new, to update, unchanged or
              in error — before anything is saved.
            </p>
          ) : (
          <>
            <div className="pimp-sum">
              <Tally tone="new" n={plan.summary.new} label="new" />
              <Tally tone="update" n={plan.summary.update} label="to update" />
              <Tally tone="same" n={plan.summary.same} label="unchanged" />
              <Tally tone="error" n={plan.summary.error} label="with errors" />
              {skip.size ? <span className="pimp-skip">{skip.size} excluded</span> : null}
            </div>
            {!done ? (
              <p className="pimp-hint">
                Before saving, download the current list with <b>🖨 Print → Excel</b> — that
                file is your backup. Nothing is ever deleted: rows missing from your file stay
                as they are.
              </p>
            ) : null}
            <div className="table-wrap pimp-wrap">
              <table className="mini wide pimp-table">
                <thead>
                  <tr>
                    <th className="pimp-ck"></th>
                    <th className="pimp-rn">Row</th>
                    <th className="pimp-ac">Action</th>
                    <th>{kind === "makers" ? "Maker" : "Company / Contact"}</th>
                    <th>Changes</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.rows.map((r) => {
                    const act = r.action === "error" ? "error"
                      : !r.changes.length ? "same" : r.action;
                    const canPick = act === "new" || act === "update";
                    const off = skip.has(r.i);
                    return (
                      <tr key={r.i} className={`pimp-row pimp-row--${act}${off ? " off" : ""}`}>
                        <td className="pimp-ck">
                          {canPick && !done ? (
                            <input type="checkbox" checked={!off} onChange={() => toggle(r.i)} />
                          ) : null}
                        </td>
                        <td className="pimp-rn">{r.i + 1}</td>
                        <td className="pimp-ac">
                          <span className={`pimp-badge pimp-badge--${act}`}>{ACTION_LABEL[act]}</span>
                        </td>
                        <td>
                          <b>{r.name || <span className="dash">—</span>}</b>
                          {r.contact ? <span className="pimp-person"> · {r.contact}</span> : null}
                          {r.joined ? (
                            <span className="pimp-inh" title="Already in the list — the registered spelling of the company name is used">
                              joins existing company
                            </span>
                          ) : null}
                          {r.inherited.length ? (
                            <span className="pimp-inh" title="Copied from the other contacts of this company">
                              company info inherited
                            </span>
                          ) : null}
                        </td>
                        <td>
                          {r.error ? <span className="action-err">{r.error}</span> : null}
                          {!r.error && !r.changes.length ? (
                            <span className="dash">Nothing to change</span>
                          ) : null}
                          {r.changes.map((c) => (
                            <div key={c.field} className="pimp-chg">
                              <span className="pimp-chg-f">{c.label}</span>
                              {c.from ? <span className="pimp-chg-o">{c.from}</span> : null}
                              <span className="pimp-chg-a">→</span>
                              <span className="pimp-chg-n">{c.to}</span>
                            </div>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
          )}
        </section>

        <div className="form-actions pimp-actions">
          {done ? (
            <>
              <span className="action-ok">
                Saved — {done.created} new · {done.updated} updated · {done.skipped} skipped
                {done.failed.length ? ` · ${done.failed.length} failed` : ""}
              </span>
              <button className="btn primary" onClick={onClose}>Close</button>
            </>
          ) : (
            <>
              <button
                className="btn primary"
                disabled={!!busy || !accepted.length}
                onClick={save}
              >
                {accepted.length ? `Save ${accepted.length} row${accepted.length === 1 ? "" : "s"}` : "Nothing to save"}
              </button>
              <button className="btn" disabled={!!busy} onClick={onClose}>Cancel</button>
            </>
          )}
          {busy ? <span className="hint-inline">{busy}</span> : null}
          {err ? <span className="action-err">{err}</span> : null}
          {done?.failed.length ? (
            <span className="action-err">
              Failed: {done.failed.map((f) => `row ${f.i + 1} ${f.name}`).join(", ")}
            </span>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

function Tally({ tone, n, label }: { tone: string; n: number; label: string }) {
  return (
    <span className={`pimp-tally pimp-tally--${tone}${n ? "" : " zero"}`}>
      <b>{n}</b> {label}
    </span>
  );
}
