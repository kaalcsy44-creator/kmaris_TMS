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
  new: "신규",
  update: "수정",
  same: "변화없음",
  error: "오류",
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
        title="Excel·CSV 파일로 명부를 한 번에 등록·갱신"
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
    setBusy("파일을 읽는 중…");
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
      setErr(e instanceof Error ? e.message : "파일을 읽지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  // 열 지정이나 덮어쓰기 여부가 바뀌면 판정을 다시 받는다 — 화면이 스스로 계산하지
  // 않는다(저장과 같은 계산이어야 미리보기가 확인 구실을 한다).
  useEffect(() => {
    if (!sheet || done) return;
    let alive = true;
    setBusy("겹쳐 보는 중…");
    applyPartnerImport({
      kind, headers: sheet.headers, rows: sheet.rows, mapping,
      overwrite, dry_run: true,
    })
      .then((p) => { if (alive) { setPlan(p); setErr(""); } })
      .catch((e) => { if (alive) { setPlan(null); setErr(e instanceof Error ? e.message : "계산 실패"); } })
      .finally(() => { if (alive) setBusy(""); });
    return () => { alive = false; };
  }, [sheet, mapping, overwrite, kind, done]);

  const actionable = (plan?.rows ?? []).filter(
    (r) => (r.action === "new" || r.action === "update") && r.changes.length,
  );
  const accepted = actionable.filter((r) => !skip.has(r.i));

  async function save() {
    if (!sheet || !accepted.length) return;
    setBusy("저장하는 중…");
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
      setErr(e instanceof Error ? e.message : "저장 실패");
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
    <Modal title={`⬆ ${title} 명부 업로드`} onClose={onClose} maxWidth={1240}>
      <div className="pimp">
        {/* ① 파일 */}
        <section className="pimp-step">
          <h4>① 파일 고르기</h4>
          <p className="pimp-hint">
            Excel(.xlsx)·CSV 를 올리면 열 이름을 보고 어떤 칸인지 짐작합니다. 이 화면의
            <b> 🖨 Print → Excel</b> 로 내려받은 파일을 고쳐 그대로 올려도 됩니다.
          </p>
          <div className="pimp-file">
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xlsm,.xls,.csv"
              disabled={!!busy}
              onChange={(e) => { pick(e.target.files?.[0] ?? null); e.target.value = ""; }}
            />
            {sheet ? (
              <span className="pimp-file-name">
                {sheet.filename} — {sheet.headers.length}칸 · {sheet.rows.length}줄
                {sheet.header_row > 1 ? ` (머리줄 ${sheet.header_row}행)` : ""}
              </span>
            ) : null}
          </div>
        </section>

        {/* ② 열 맞추기 */}
        {sheet ? (
          <section className="pimp-step">
            <h4>② 열 맞추기</h4>
            <p className="pimp-hint">
              잘못 짚었으면 바꾸세요. <b>무시</b>로 둔 열은 읽지 않습니다 — 실적에서
              나오는 칸(문의·프로젝트·품목 수)은 사람이 적는 값이 아니라 무시합니다.
            </p>
            <div className="pimp-map">
              {sheet.headers.map((h, i) => (
                <label key={i} className="pimp-map-col">
                  <span className="pimp-map-head" title={h}>{h || `(${i + 1}번 열)`}</span>
                  <select
                    value={mapping[i] ?? ""}
                    onChange={(e) =>
                      setMapping(mapping.map((m, idx) => (idx === i ? e.target.value : m)))
                    }
                  >
                    <option value="">— 무시 —</option>
                    {sheet.fields.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}{f.multi ? " (여러 값)" : ""}
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
              이미 값이 있는 칸도 엑셀 값으로 덮어쓰기
              <span className="pimp-hint"> — 꺼 두면 빈 칸만 채우고, 이메일·전화는 없는 값만 보탭니다.</span>
            </label>
          </section>
        ) : null}

        {/* ③ 판정 */}
        {plan ? (
          <section className="pimp-step">
            <h4>③ 무엇이 바뀌는지</h4>
            <div className="pimp-sum">
              <Tally tone="new" n={plan.summary.new} label="신규" />
              <Tally tone="update" n={plan.summary.update} label="수정" />
              <Tally tone="same" n={plan.summary.same} label="변화없음" />
              <Tally tone="error" n={plan.summary.error} label="오류" />
              {skip.size ? <span className="pimp-skip">{skip.size}줄 제외됨</span> : null}
            </div>
            {!done ? (
              <p className="pimp-hint">
                저장하기 전에 <b>🖨 Print → Excel</b> 로 지금 명부를 내려받아 두면 그게
                곧 백업입니다. 지우는 일은 하지 않습니다 — 엑셀에 없는 줄은 그대로 남습니다.
              </p>
            ) : null}
            <div className="table-wrap pimp-wrap">
              <table className="mini wide pimp-table">
                <thead>
                  <tr>
                    <th className="pimp-ck"></th>
                    <th className="pimp-rn">행</th>
                    <th className="pimp-ac">판정</th>
                    <th>{kind === "makers" ? "Maker" : "회사 / 담당자"}</th>
                    <th>바뀌는 것</th>
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
                            <span className="pimp-inh" title="이미 등록된 회사입니다 — 회사명은 명부에 적힌 철자를 씁니다">
                              기존 회사에 합류
                            </span>
                          ) : null}
                          {r.inherited.length ? (
                            <span className="pimp-inh" title="같은 회사의 기존 줄에서 물려받았습니다">
                              회사 공통정보 상속
                            </span>
                          ) : null}
                        </td>
                        <td>
                          {r.error ? <span className="action-err">{r.error}</span> : null}
                          {!r.error && !r.changes.length ? (
                            <span className="dash">바뀌는 것이 없습니다</span>
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
          </section>
        ) : null}

        {/* ④ 저장 */}
        <div className="form-actions pimp-actions">
          {done ? (
            <>
              <span className="action-ok">
                저장했습니다 — 신규 {done.created} · 수정 {done.updated} · 건너뜀 {done.skipped}
                {done.failed.length ? ` · 실패 ${done.failed.length}` : ""}
              </span>
              <button className="btn primary" onClick={onClose}>닫기</button>
            </>
          ) : (
            <>
              <button
                className="btn primary"
                disabled={!!busy || !accepted.length}
                onClick={save}
              >
                {accepted.length ? `${accepted.length}줄 저장` : "저장할 줄 없음"}
              </button>
              <button className="btn" disabled={!!busy} onClick={onClose}>취소</button>
            </>
          )}
          {busy ? <span className="hint-inline">{busy}</span> : null}
          {err ? <span className="action-err">{err}</span> : null}
          {done?.failed.length ? (
            <span className="action-err">
              실패: {done.failed.map((f) => `${f.i + 1}행 ${f.name}`).join(", ")}
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
