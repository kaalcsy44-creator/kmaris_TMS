"use client";

// RFQ 후보 함 — 메일함에서 찾은 새 RFQ 를 사람이 확인해 프로젝트로 세운다.
//
// 판정은 서버가 매일 아침 메일 일과 끝에 한다(services/rfq_detect.py). 여기서는 고객·선박·
// 제목을 확인·고친 뒤 Approve 한 번으로 프로젝트 등록 + 드라이브 폴더 + 첨부·메일 본문
// `01 RFQ` 저장이 끝난다. 자동 승인은 없다 — 홍보 메일 하나가 프로젝트가 되면 이력이
// 오염되고 되돌리기 어렵다.
// 화면 문구는 나머지 화면과 같이 영문(주석만 국문).

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  approveRfqCandidate,
  fetchCustomers,
  fetchRfqCandidates,
  fetchSettingsVessels,
  rejectRfqCandidate,
  runRfqDetection,
  type RfqApproveResult,
  type RfqCandidate,
} from "@/lib/api";
import type { CustomerOption, SettingsVessel } from "@/lib/types";

type Draft = {
  company: string;          // 고른 회사(명부) — 비면 새 고객
  customerId: number;       // 고른 담당자 레코드
  newName: string;
  newContact: string;
  newEmail: string;
  vessel: string;
  title: string;
  workType: "PARTS" | "SERVICE";
};

const FORBIDDEN = /[\\/:*?"<>|\r\n\t]+/g;
function clean(s: string) {
  return s.replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim();
}
// 서버(drive_svc.project_folder_name)와 같은 규칙 — 미리보기용.
function folderPreview(sentAt: string, label: string, vessel: string, title: string) {
  const d = sentAt.replace(/\D/g, "");
  const ymd = d.length >= 8 ? d.slice(2, 8) : "";
  return clean([ymd, clean(label) || "NA", clean(vessel) || "NA", clean(title) || "NA"].join(" ")).slice(0, 120);
}

export default function RfqCandidatesPanel({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const [rows, setRows] = useState<RfqCandidate[] | null>(null);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [vessels, setVessels] = useState<SettingsVessel[]>([]);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [done, setDone] = useState<Record<number, RfqApproveResult>>({});

  const load = useCallback(async () => {
    try {
      const r = await fetchRfqCandidates("pending");
      setRows(r.rows);
      onCountChange?.(r.rows.length);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load RFQ candidates");
    }
  }, [onCountChange]);

  useEffect(() => {
    load();
    fetchCustomers().then(setCustomers).catch(() => setCustomers([]));
    fetchSettingsVessels().then(setVessels).catch(() => setVessels([]));
  }, [load]);

  const companies = useMemo(
    () => Array.from(new Set(customers.map((c) => c.name))).sort((a, b) => a.localeCompare(b)),
    [customers]
  );

  // 후보마다 고칠 칸의 초기값 — 서버가 맞춘 고객·선박·제목.
  useEffect(() => {
    if (!rows) return;
    setDrafts((prev) => {
      const next = { ...prev };
      for (const r of rows) {
        if (next[r.id]) continue;
        next[r.id] = {
          company: r.customer_name,
          customerId: r.customer_id,
          newName: r.customer_id ? "" : r.customer_guess,
          newContact: r.customer_id ? "" : r.from_name,
          newEmail: r.customer_id ? "" : r.from_addr,
          vessel: r.vessel,
          title: r.item_title,
          workType: r.work_type,
        };
      }
      return next;
    });
  }, [rows]);

  function setDraft(id: number, patch: Partial<Draft>) {
    setDrafts((p) => ({ ...p, [id]: { ...p[id], ...patch } }));
  }

  async function scan() {
    setScanBusy(true);
    setErr("");
    setNote("");
    try {
      const r = await runRfqDetection();
      setNote(`Scanned ${r.judged} new mail(s) · ${r.candidates} look like RFQs`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setScanBusy(false);
    }
  }

  async function reject(r: RfqCandidate) {
    setBusyId(r.id);
    setErr("");
    try {
      await rejectRfqCandidate(r.id);
      setRows((p) => (p ?? []).filter((x) => x.id !== r.id));
      onCountChange?.((rows?.length ?? 1) - 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not dismiss");
    } finally {
      setBusyId(null);
    }
  }

  async function approve(r: RfqCandidate) {
    const d = drafts[r.id];
    if (!d) return;
    const existing = d.company ? customers.find((c) => c.id === d.customerId) : undefined;
    if (d.company && !existing) {
      setErr("Pick the customer contact.");
      return;
    }
    if (!d.company && !d.newName.trim()) {
      setErr("Pick a customer, or type the new customer's company name.");
      return;
    }
    const v = vessels.find((x) => x.name.trim().toLowerCase() === d.vessel.trim().toLowerCase());
    setBusyId(r.id);
    setErr("");
    try {
      const res = await approveRfqCandidate(r.id, {
        ...(existing
          ? { customer_id: existing.id }
          : { new_customer: { name: d.newName.trim(), contact: d.newContact.trim(), email: d.newEmail.trim() } }),
        ...(v ? { vessel_id: v.id } : { vessel_name: d.vessel.trim() }),
        project_title: d.title.trim(),
        work_type: d.workType,
      });
      setDone((p) => ({ ...p, [r.id]: res }));
      onCountChange?.(Math.max(0, (rows?.length ?? 1) - 1));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Approve failed");
    } finally {
      setBusyId(null);
    }
  }

  if (!rows) return <div className="state">Loading RFQ candidates…</div>;

  return (
    <div className="rfqc">
      <div className="rfqc-head">
        <span className="hint-inline">
          New RFQs found in the mailbox (sales@ · samcho@). Nothing is created until you approve —
          Approve registers the project, creates its Drive folder and saves the mail and its
          attachments into <b>01 RFQ</b>.
        </span>
        <button className="btn sm" disabled={scanBusy} onClick={scan} title="Check recent unfiled mail now">
          {scanBusy ? "Scanning…" : "🔍 Scan now"}
        </button>
      </div>
      {note ? <div className="action-ok">{note}</div> : null}
      {err ? <div className="action-err">{err}</div> : null}
      {rows.length === 0 ? <div className="empty">No RFQ candidates right now.</div> : null}

      {rows.map((r) => {
        const d = drafts[r.id];
        const res = done[r.id];
        if (!d) return null;
        const contacts = customers.filter((c) => c.name === d.company);
        // 폴더명의 고객 칸 — 서버가 약칭을 알려 준 그 고객이면 약칭, 아니면 회사명.
        const label = d.company
          ? (r.customer_name === d.company && r.customer_short ? r.customer_short : d.company)
          : d.newName;
        const folder = folderPreview(r.sent_at, label, d.vessel, d.title);
        const busy = busyId === r.id;
        return (
          <div key={r.id} className={`rfqc-card${res ? " done" : ""}`}>
            <div className="rfqc-top">
              <span className={`rfqc-conf${r.confidence >= 0.8 ? " high" : ""}`} title="How sure the model is that this is a new RFQ">
                {Math.round(r.confidence * 100)}%
              </span>
              <b className="rfqc-subj" title={r.subject}>{r.subject || "(no subject)"}</b>
              <span className="rfqc-meta">
                {r.from_name || r.from_addr} · {r.sent_at.replace("T", " ")}
                {r.account ? ` · ${r.account.split("@")[0]}@` : ""}
              </span>
            </div>
            {r.reason ? <div className="rfqc-reason">{r.reason}</div> : null}
            {r.attachments.length ? (
              <div className="rfqc-atts">📎 {r.attachments.join(" · ")}</div>
            ) : null}
            <button type="button" className="link-btn" onClick={() => setOpen((p) => ({ ...p, [r.id]: !p[r.id] }))}>
              {open[r.id] ? "▾ Hide mail" : "▸ Show mail"}
            </button>
            {open[r.id] ? <pre className="rfqc-body">{r.body || r.preview}</pre> : null}

            {res ? (
              <div className="rfqc-result">
                <span className="action-ok">
                  ✓ Project created{res.rfq_no && res.rfq_no !== "-" ? ` — ${res.rfq_no}` : ""} · Drive: {res.saved.length} file(s) saved
                </span>
                {res.folder_url ? (
                  <a href={res.folder_url} target="_blank" rel="noopener noreferrer"> · 📁 open folder</a>
                ) : null}
                {res.drive_error ? <div className="hint-inline warn">⚠ {res.drive_error}</div> : null}
                {[...res.skipped, ...res.failed].map((x, i) => (
                  <div key={i} className="hint-inline warn">⚠ {x.name} — {x.reason}</div>
                ))}
              </div>
            ) : (
              <>
                <div className="rfqc-form">
                  <label>
                    <span>Customer</span>
                    <select
                      value={d.company}
                      disabled={busy}
                      onChange={(e) => {
                        const company = e.target.value;
                        const list = customers.filter((c) => c.name === company);
                        setDraft(r.id, { company, customerId: list.length === 1 ? list[0].id : 0 });
                      }}
                    >
                      <option value="">— New customer —</option>
                      {companies.map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                  </label>
                  {d.company ? (
                    <label>
                      <span>Contact</span>
                      <select
                        value={d.customerId || ""}
                        disabled={busy}
                        onChange={(e) => setDraft(r.id, { customerId: Number(e.target.value) || 0 })}
                      >
                        <option value="">— pick —</option>
                        {contacts.map((c) => (
                          <option key={c.id} value={c.id}>{c.contact || c.email || `#${c.id}`}</option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <>
                      <label>
                        <span>New company</span>
                        <input value={d.newName} disabled={busy} onChange={(e) => setDraft(r.id, { newName: e.target.value })} />
                      </label>
                      <label>
                        <span>Contact</span>
                        <input value={d.newContact} disabled={busy} onChange={(e) => setDraft(r.id, { newContact: e.target.value })} />
                      </label>
                      <label>
                        <span>Email</span>
                        <input value={d.newEmail} disabled={busy} onChange={(e) => setDraft(r.id, { newEmail: e.target.value })} />
                      </label>
                    </>
                  )}
                  <label>
                    <span>Vessel</span>
                    <input
                      list={`rfqc-vessels-${r.id}`}
                      value={d.vessel}
                      disabled={busy}
                      placeholder="(none)"
                      onChange={(e) => setDraft(r.id, { vessel: e.target.value })}
                    />
                    <datalist id={`rfqc-vessels-${r.id}`}>
                      {vessels.map((v) => (
                        <option key={v.id} value={v.name} />
                      ))}
                    </datalist>
                  </label>
                  <label className="wide">
                    <span>Project title</span>
                    <input value={d.title} disabled={busy} onChange={(e) => setDraft(r.id, { title: e.target.value })} />
                  </label>
                  <label>
                    <span>Type</span>
                    <select
                      value={d.workType}
                      disabled={busy}
                      onChange={(e) => setDraft(r.id, { workType: e.target.value as "PARTS" | "SERVICE" })}
                    >
                      <option value="PARTS">Parts</option>
                      <option value="SERVICE">Service</option>
                    </select>
                  </label>
                </div>
                <div className="rfqc-foot">
                  <span className="rfqc-folder" title="Drive folder that Approve will create">📁 {folder}</span>
                  {d.vessel.trim() && !vessels.some((v) => v.name.trim().toLowerCase() === d.vessel.trim().toLowerCase()) ? (
                    <span className="hint-inline">new vessel will be registered</span>
                  ) : null}
                  <button className="btn sm" disabled={busy} onClick={() => reject(r)} title="Not an RFQ — remove it from this list">
                    Not an RFQ
                  </button>
                  <button className="btn sm primary" disabled={busy} onClick={() => approve(r)}>
                    {busy ? "Creating…" : "✓ Approve"}
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
