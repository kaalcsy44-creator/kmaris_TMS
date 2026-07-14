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

// 한 딜의 활동 = 자동 단계 이벤트(stage_dates/auto) + 수동 stage_notes 병합.
type Activity =
  | { kind: "auto"; date: string; stage: number; label: string }
  | { kind: "note"; date: string; stage: number; index: number; note: StageNote };

function buildActivities(row: PipelineRow, steps: string[]): Activity[] {
  const out: Activity[] = [];
  // 자동 단계 이벤트 — 각 단계에서 실제일자(stage_dates) 우선, 없으면 자동시각(stage_auto).
  for (let n = 1; n <= steps.length; n++) {
    const key = String(n);
    const date = (row.stage_dates?.[key] || row.stage_auto?.[key] || "").slice(0, 10);
    if (date) out.push({ kind: "auto", date, stage: n, label: steps[n - 1] || `Stage ${n}` });
  }
  // 수동 활동 기록.
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

  // 딜별로 활동을 만들고, 필터(담당/검색/종결/날짜)를 적용한 뒤 버킷별로 묶는다.
  const buckets = useMemo(() => {
    const groups: { phase: number; rows: { row: PipelineRow; acts: Activity[] }[] }[] =
      PHASES.map((_, i) => ({ phase: i, rows: [] }));
    for (const row of data?.rows ?? []) {
      if (row.cancelled && !showClosed) continue;
      if (mine && row.assignee_id !== uid) continue;
      const text = `${row.project_no} ${row.project_title} ${row.customer} ${row.vendor} ${row.vrfq_vendors}`.toLowerCase();
      if (q.trim() && !text.includes(q.trim().toLowerCase())) continue;
      let acts = buildActivities(row, steps);
      if (targetDate) acts = acts.filter((a) => a.date === targetDate);
      // 날짜 필터가 걸린 경우, 해당일 활동이 없는 딜은 숨긴다.
      if (targetDate && acts.length === 0) continue;
      groups[phaseOf(row.stage)].rows.push({ row, acts });
    }
    // 각 버킷 내 정렬 — 최근 활동(마지막 활동일) 내림차순.
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
    if (!window.confirm("이 활동 기록을 삭제할까요?")) return;
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
          <span className="muted">프로젝트별 · 단계별 활동 일지 · {totalDeals}건</span>
        </div>
        <div className="act-filters">
          <input
            className="act-search"
            placeholder="프로젝트 / 고객 / 벤더 검색"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="act-seg">
            {(["all", "today", "date"] as const).map((k) => (
              <button key={k} className={dateFilter === k ? "on" : ""} onClick={() => setDateFilter(k)}>
                {k === "all" ? "전체" : k === "today" ? "오늘" : "날짜"}
              </button>
            ))}
            {dateFilter === "date" ? (
              <input type="date" value={pickDate} onChange={(e) => setPickDate(e.target.value)} />
            ) : null}
          </div>
          <label className="act-check"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> 내 담당</label>
          <label className="act-check"><input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> 종결 포함</label>
          <button className={`btn sm${meeting ? " primary" : ""}`} onClick={() => setMeeting((v) => !v)}>
            {meeting ? "회의모드 ON" : "회의모드"}
          </button>
          <button className="btn sm" onClick={() => window.print()}>인쇄</button>
        </div>
      </div>

      {totalDeals === 0 ? <div className="state">표시할 활동이 없습니다.</div> : null}

      {buckets.map((g) =>
        g.rows.length === 0 ? null : (
          <section key={g.phase} className="act-bucket">
            <h3 className="act-bucket-h">
              {PHASES[g.phase].label} 중 <span className="cnt">{g.rows.length}</span>
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
  const vendor = (row.vendor || "").trim() || (row.vrfq_vendors || "").trim();
  const head = [row.project_title || "(제목 없음)", row.customer, vendor].filter(Boolean).join(" / ");
  return (
    <div className="act-card">
      <div className="act-card-h">
        <span className="act-pno">{row.project_no || row.kmaris_rfq_no || "—"})</span>
        <span className="act-head">{head}</span>
        <span className="act-spacer" />
        {row.assignee ? <span className="act-pic">{row.assignee}</span> : null}
        <Link className="act-open" href={`/progress?rfq=${row.rfq_id}&stage=${row.stage}`}>열기 →</Link>
      </div>
      <ul className="act-list">
        {acts.length === 0 ? <li className="act-empty muted">활동 기록 없음</li> : null}
        {acts.map((a, i) => (
          <li key={i} className={`act-item${a.kind === "note" && a.note.star ? " star" : ""}`}>
            <span className="act-date">{md(a.date)}</span>
            {a.kind === "auto" ? (
              <span className="act-auto"><span className="act-tag">자동</span> {a.label}</span>
            ) : (
              <span className="act-text">
                {a.note.text}
                {a.note.party || a.note.channel ? (
                  <span className="act-meta"> · {[a.note.party, a.note.channel].filter(Boolean).join(" · ")}</span>
                ) : null}
              </span>
            )}
            {a.kind === "note" ? (
              <span className="act-actions">
                <button className={`act-starbtn${a.note.star ? " on" : ""}`} title="우선 표시" onClick={() => onStar(a)}>★</button>
                {!meeting ? <button className="act-del" title="삭제" onClick={() => onDelete(a)}>×</button> : null}
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
        party: party || undefined,
        star,
      });
      setText(""); setParty(""); setStar(false); setOpen(false);
      onAdded();
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="act-add-btn" onClick={() => setOpen(true)}>+ 활동 추가{me ? ` (${me.username})` : ""}</button>
    );
  }
  return (
    <div className="act-add">
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <input
        className="act-add-text"
        placeholder="활동 내용 (예: PO 기다리는 중 / 업데이트 요청)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        autoFocus
      />
      <select value={party} onChange={(e) => setParty(e.target.value)}>
        <option value="">상대 —</option>
        <option value="Customer">Customer</option>
        <option value="Vendor">Vendor</option>
        <option value="Internal">Internal</option>
      </select>
      <label className="act-check"><input type="checkbox" checked={star} onChange={(e) => setStar(e.target.checked)} /> ★</label>
      <button className="btn sm primary" disabled={busy || !text.trim()} onClick={submit}>{busy ? "…" : "추가"}</button>
      <button className="btn sm" onClick={() => setOpen(false)}>취소</button>
    </div>
  );
}
