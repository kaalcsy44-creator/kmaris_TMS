"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  fetchPipeline,
  addRfqStageNote,
  updateRfqStageNote,
  deleteRfqStageNote,
} from "@/lib/api";
import type { PipelineData, PipelineRow, StageNote } from "@/lib/types";
import { getUserId, getUser } from "@/lib/auth";

// 내부 11단계 → 5개 버킷(RFQ 1–2 / Quote 3–4 / PO 5–6 / Documents 7–9 / AR 10–11).
const PHASES: { label: string; from: number; to: number }[] = [
  { label: "RFQ", from: 1, to: 2 },
  { label: "Quote", from: 3, to: 4 },
  { label: "PO", from: 5, to: 6 },
  { label: "Documents", from: 7, to: 9 },
  { label: "AR", from: 10, to: 11 },
];
function phaseOf(stage: number): number {
  for (let i = 0; i < PHASES.length; i++) if (stage >= PHASES[i].from && stage <= PHASES[i].to) return i;
  return stage <= 1 ? 0 : PHASES.length - 1;
}

const CLOSE_REASONS: Record<string, string> = {
  schedule: "Schedule delay / cancelled",
  slow_response: "Slow response",
  no_quote: "No quote available",
  other: "Other",
};

function todayISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// "2026-07-14T09:30" | "2026-07-14" → "7/14"
function md(iso: string): string {
  const s = (iso || "").slice(0, 10);
  const m = s.match(/^\d{4}-(\d{2})-(\d{2})/);
  if (!m) return s;
  return `${Number(m[1])}/${Number(m[2])}`;
}
// 프로젝트 번호 "P-010(260713)" → { code: "P-010", date: "(260713)" }
function splitProjectNo(pno: string): { code: string; date: string } {
  const m = (pno || "").match(/^(.*?)\s*(\(.*\))\s*$/);
  return m ? { code: m[1], date: m[2] } : { code: pno || "—", date: "" };
}
function vendorOf(row: PipelineRow): string {
  return (row.vendor || "").trim() || (row.vrfq_vendors || "").trim();
}
// 자동 단계 이벤트의 From/To 상대 — 단계별로 고객/벤더를 붙인다.
function autoParty(stage: number, row: PipelineRow): string {
  const cust = row.customer || "";
  const vend = vendorOf(row);
  switch (stage) {
    case 1: return cust ? `from ${cust}` : "";   // RFQ Received
    case 2: return vend ? `to ${vend}` : "";     // RFQ Sent
    case 3: return vend ? `from ${vend}` : "";   // Quote Received
    case 4: return cust ? `to ${cust}` : "";     // Quote Sent
    case 5: return cust ? `from ${cust}` : "";   // P/O Received
    case 6: return vend ? `to ${vend}` : "";     // P/O Sent
    case 8: return cust ? `to ${cust}` : "";     // Delivery Complete
    case 9: return cust ? `to ${cust}` : "";     // Tax Invoice · Billing
    case 10: return cust ? `to ${cust}` : "";    // Tax Invoice Issued
    case 11: return cust ? `from ${cust}` : "";  // Payment
    default: return "";
  }
}

// 한 딜의 활동 = 자동 단계 이벤트 + 수동 stage_notes + 종결 이벤트.
type Activity =
  | { kind: "auto"; date: string; stage: number; label: string; party: string }
  | { kind: "note"; date: string; stage: number; index: number; note: StageNote }
  | { kind: "close"; date: string; reason: string };

function buildActivities(row: PipelineRow, steps: string[]): Activity[] {
  const out: Activity[] = [];
  for (let n = 1; n <= steps.length; n++) {
    const key = String(n);
    const date = (row.stage_dates?.[key] || row.stage_auto?.[key] || "").slice(0, 10);
    if (date) out.push({ kind: "auto", date, stage: n, label: steps[n - 1] || `Stage ${n}`, party: autoParty(n, row) });
  }
  for (const [stage, list] of Object.entries(row.stage_notes ?? {})) {
    (list ?? []).forEach((note, index) => {
      const date = (note.datetime || note.at || "").slice(0, 10);
      out.push({ kind: "note", date, stage: Number(stage), index, note });
    });
  }
  out.sort((a, b) => {
    const da = a.kind === "note" ? (a.note.datetime || a.note.at || a.date) : a.date;
    const db = b.kind === "note" ? (b.note.datetime || b.note.at || b.date) : b.date;
    return da < db ? -1 : da > db ? 1 : 0;
  });
  // 종결 이벤트 — 항상 맨 아래에 붙인다(날짜 없으면 날짜칸 비움).
  if (row.cancelled) {
    const reason = CLOSE_REASONS[row.close_reason || ""] || row.close_reason || "";
    const note = (row.close_reason_note || "").trim();
    out.push({
      kind: "close",
      date: (row.closed_at || "").slice(0, 10),
      reason: [reason, note].filter(Boolean).join(" — "),
    });
  }
  return out;
}

export default function ActivityScreen() {
  const [data, setData] = useState<PipelineData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [mine, setMine] = useState(false);
  const [dateFilter, setDateFilter] = useState<"all" | "today" | "date">("all");
  const [pickDate, setPickDate] = useState(todayISO());
  const [showClosed, setShowClosed] = useState(false);
  const [meeting, setMeeting] = useState(false);

  const uid = getUserId();

  function load() {
    fetchPipeline()
      .then(setData)
      .catch((e) => setErr(e instanceof Error ? e.message : "Error"));
  }
  useEffect(load, []);

  const steps = data?.steps ?? [];
  const targetDate = dateFilter === "today" ? todayISO() : dateFilter === "date" ? pickDate : "";

  const buckets = useMemo(() => {
    const groups: { phase: number; rows: { row: PipelineRow; acts: Activity[] }[] }[] =
      PHASES.map((_, i) => ({ phase: i, rows: [] }));
    for (const row of data?.rows ?? []) {
      if (row.cancelled && !showClosed) continue;
      if (mine && row.assignee_id !== uid) continue;
      const text = `${row.project_no} ${row.project_title} ${row.customer} ${row.vendor} ${row.vrfq_vendors} ${row.vessel}`.toLowerCase();
      if (q.trim() && !text.includes(q.trim().toLowerCase())) continue;
      let acts = buildActivities(row, steps);
      if (targetDate) acts = acts.filter((a) => a.date === targetDate);
      if (targetDate && acts.length === 0) continue;
      groups[phaseOf(row.stage)].rows.push({ row, acts });
    }
    for (const g of groups) {
      g.rows.sort((a, b) => {
        const la = a.acts.length ? a.acts[a.acts.length - 1].date : "";
        const lb = b.acts.length ? b.acts[b.acts.length - 1].date : "";
        return la < lb ? 1 : la > lb ? -1 : 0;
      });
    }
    return groups;
  }, [data, steps, q, mine, uid, showClosed, targetDate]);

  const totalDeals = buckets.reduce((s, g) => s + g.rows.length, 0);

  async function toggleStar(rfqId: number, a: Activity) {
    if (a.kind !== "note") return;
    try {
      await updateRfqStageNote(rfqId, a.stage, a.index, {
        text: a.note.text,
        datetime: a.note.datetime,
        party: a.note.party,
        channel: a.note.channel,
        direction: a.note.direction,
        star: !a.note.star,
      });
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Update failed");
    }
  }

  async function removeNote(rfqId: number, a: Activity) {
    if (a.kind !== "note") return;
    if (!window.confirm("Delete this activity?")) return;
    try {
      await deleteRfqStageNote(rfqId, a.stage, a.index);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    }
  }

  if (err) return <div className="state error">{err}</div>;
  if (!data) return <div className="state">Loading…</div>;

  return (
    <div className={`act-screen${meeting ? " meeting" : ""}`}>
      <div className="act-toolbar">
        <div className="act-title">
          <b>Activity Log</b>
          <span className="muted">Project · stage activity by deal · {totalDeals}</span>
        </div>
        <div className="act-filters">
          <input
            className="act-search"
            placeholder="Search project / customer / vendor"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="act-seg">
            {(["all", "today", "date"] as const).map((k) => (
              <button key={k} className={dateFilter === k ? "on" : ""} onClick={() => setDateFilter(k)}>
                {k === "all" ? "All" : k === "today" ? "Today" : "Date"}
              </button>
            ))}
            {dateFilter === "date" ? (
              <input type="date" value={pickDate} onChange={(e) => setPickDate(e.target.value)} />
            ) : null}
          </div>
          <label className="act-check"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Mine</label>
          <label className="act-check"><input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Include closed</label>
          <button className={`btn sm${meeting ? " primary" : ""}`} onClick={() => setMeeting((v) => !v)}>
            {meeting ? "Meeting ON" : "Meeting mode"}
          </button>
          <button className="btn sm" onClick={() => window.print()}>Print</button>
        </div>
      </div>

      {totalDeals === 0 ? <div className="state">No activity to show.</div> : null}

      {buckets.map((g) =>
        g.rows.length === 0 ? null : (
          <section key={g.phase} className="act-bucket">
            <h3 className="act-bucket-h">
              {PHASES[g.phase].label} <span className="cnt">{g.rows.length}</span>
            </h3>
            <div className="act-cards">
              {g.rows.map(({ row, acts }) => (
                <ActivityCard
                  key={row.rfq_id}
                  row={row}
                  acts={acts}
                  meeting={meeting}
                  onStar={(a) => toggleStar(row.rfq_id, a)}
                  onDelete={(a) => removeNote(row.rfq_id, a)}
                  onAdded={load}
                />
              ))}
            </div>
          </section>
        )
      )}
    </div>
  );
}

function ActivityCard({
  row,
  acts,
  meeting,
  onStar,
  onDelete,
  onAdded,
}: {
  row: PipelineRow;
  acts: Activity[];
  meeting: boolean;
  onStar: (a: Activity) => void;
  onDelete: (a: Activity) => void;
  onAdded: () => void;
}) {
  const { code, date } = splitProjectNo(row.project_no || row.kmaris_rfq_no || "—");
  const vend = vendorOf(row);
  return (
    <div className="act-card">
      <div className="act-card-h">
        <span className="act-pno">{code}</span>
        {date ? <span className="act-pno-date">{date}</span> : null}
        <span className="act-spacer" />
        {row.assignee ? <span className="act-pic">{row.assignee}</span> : null}
        <Link className="act-open" href={`/progress?rfq=${row.rfq_id}&stage=${row.stage}`} title="Open deal">→</Link>
      </div>
      {/* 프로젝트명 + 선박명(우측, 동일 크기·색상). */}
      <div className="act-title2">
        {row.project_title || "(untitled)"}
        {row.vessel ? <span className="act-tvessel"> · {row.vessel}</span> : null}
      </div>
      {/* 고객사 · 고객사 담당자 / 벤더. (우측 상단 배지 = 내부 PIC) */}
      {(row.customer || vend) ? (
        <div className="act-sub">
          {row.customer}
          {row.contact_person ? <span className="act-sub-contact"> · {row.contact_person}</span> : null}
          {vend ? ` / ${vend}` : ""}
        </div>
      ) : null}
      <ul className="act-list">
        {acts.length === 0 ? <li className="act-empty muted">No activity yet</li> : null}
        {acts.map((a, i) => (
          <li key={i} className={`act-item${a.kind === "note" && a.note.star ? " star" : ""}${a.kind === "close" ? " closed" : ""}`}>
            <span className="act-date">{md(a.date)}</span>
            {a.kind === "auto" ? (
              <span className="act-auto">
                <span className="act-tag">auto</span> {a.label}
                {a.party ? <span className="act-meta"> · {a.party}</span> : null}
              </span>
            ) : a.kind === "close" ? (
              <span className="act-text"><span className="act-tag close">closed</span> {a.reason || "Closed"}</span>
            ) : (
              <span className="act-text">
                {a.note.text}
                {(() => {
                  const dl = a.note.direction === "in" ? "from" : a.note.direction === "out" ? "to" : "";
                  const who = [dl, a.note.party].filter(Boolean).join(" ");
                  const parts = [who, a.note.channel].filter(Boolean);
                  return parts.length ? <span className="act-meta"> · {parts.join(" · ")}</span> : null;
                })()}
              </span>
            )}
            {a.kind === "note" ? (
              <span className="act-actions">
                <button className={`act-starbtn${a.note.star ? " on" : ""}`} title="Mark priority" onClick={() => onStar(a)}>★</button>
                {!meeting ? <button className="act-del" title="Delete" onClick={() => onDelete(a)}>×</button> : null}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {!meeting ? <AddActivity rfqId={row.rfq_id} stage={row.stage} onAdded={onAdded} /> : null}
    </div>
  );
}

function AddActivity({ rfqId, stage, onAdded }: { rfqId: number; stage: number; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [date, setDate] = useState(todayISO());
  const [dir, setDir] = useState<"" | "in" | "out">(""); // in=from(수신) / out=to(발신)
  const [party, setParty] = useState("");
  const [star, setStar] = useState(false);
  const [busy, setBusy] = useState(false);
  const me = getUser();

  async function submit() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await addRfqStageNote(rfqId, stage, {
        text: text.trim(),
        datetime: `${date}T09:00`,
        direction: dir || undefined,
        party: party || undefined,
        star,
      });
      setText(""); setDir(""); setParty(""); setStar(false); setOpen(false);
      onAdded();
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="act-add-btn" onClick={() => setOpen(true)}>+ Add activity{me ? ` (${me.username})` : ""}</button>
    );
  }
  return (
    <div className="act-add">
      {/* 1행: 날짜 · From/To · Party · ★ */}
      <div className="act-add-row">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <div className="act-seg sm">
          {(["in", "out"] as const).map((d) => (
            <button key={d} className={dir === d ? "on" : ""} onClick={() => setDir((v) => (v === d ? "" : d))}>
              {d === "in" ? "From" : "To"}
            </button>
          ))}
        </div>
        <select value={party} onChange={(e) => setParty(e.target.value)}>
          <option value="">Party —</option>
          <option value="Customer">Customer</option>
          <option value="Vendor">Vendor</option>
          <option value="Internal">Internal</option>
        </select>
        <label className="act-check"><input type="checkbox" checked={star} onChange={(e) => setStar(e.target.checked)} /> ★</label>
      </div>
      {/* 2행: 내용 입력 */}
      <div className="act-add-row">
        <input
          className="act-add-text"
          placeholder="Activity note (e.g. Waiting for PO / requested update)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          autoFocus
        />
      </div>
      {/* 3행: Add · Cancel */}
      <div className="act-add-row">
        <button className="btn sm primary act-add-go" disabled={busy || !text.trim()} onClick={submit}>{busy ? "…" : "Add"}</button>
        <button className="btn sm act-add-go" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}
