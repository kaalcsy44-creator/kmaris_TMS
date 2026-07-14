"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import Link from "next/link";
import {
  fetchPipeline,
  addRfqStageNote,
  updateRfqStageNote,
  deleteRfqStageNote,
  fetchAssignableUsers,
} from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";
import type { PipelineData, PipelineRow, StageNote } from "@/lib/types";
import { getUserId, getUser } from "@/lib/auth";
import CustomerName from "@/components/common/CustomerName";
import VendorMonograms from "@/components/common/VendorMonograms";

// 벤더 모노그램 상태 — 발주 벤더 확정 시 문자열 fallback, 아니면 RFQ 발송 벤더의 견적 수신여부.
// (ProgressScreen 과 동일 규칙.)
function vendorStatusesFor(r: PipelineRow): { name: string; quoted: boolean }[] | undefined {
  if (r.vendor) return undefined;
  return r.rfq_vendors && r.rfq_vendors.length ? r.rfq_vendors : undefined;
}

// 담당자(PIC) 드롭다운 후보 — 배정 가능 사용자(+ 로그인 사용자, + 현재 선택값). 공유 캐시.
function usePicOptions(current: string): string[] {
  const me = getUser();
  const { data: users } = useCachedData("assignable-users", fetchAssignableUsers);
  return useMemo(() => {
    const set = new Set<string>();
    if (me?.username) set.add(me.username);
    (users ?? []).forEach((u) => set.add(u.username));
    if (current) set.add(current);
    return Array.from(set);
  }, [users, me?.username, current]);
}

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
// 최신 활동 일시(iso) — 단계 완료(수동/자동)·단계 노트 중 최신. 백엔드 _last_activity_iso 와 동일 규칙.
function lastActivityISO(row: PipelineRow): string {
  const times: string[] = [];
  for (const m of [row.stage_dates, row.stage_auto]) {
    for (const v of Object.values(m ?? {})) if (v) times.push(v);
  }
  for (const notes of Object.values(row.stage_notes ?? {})) {
    for (const n of notes ?? []) {
      const v = n.datetime || n.at || "";
      if (v) times.push(v);
    }
  }
  return times.length ? times.reduce((a, b) => (a > b ? a : b)) : "";
}
// iso 로부터 오늘까지 경과 일수(≥0). 파싱 불가면 null. progress 페이지 daysSince 와 동일.
function daysSinceISO(iso: string): number | null {
  const t = Date.parse((iso || "").slice(0, 10));
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
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

// 기존 활동 노트 수정 시 전달하는 값.
type NotePatch = { text: string; datetime?: string; direction?: string; party?: string; star?: boolean; pic?: string };

// 카드 드래그앤드롭(동일 단계 그룹 내 순서 변경) 배선.
type CardDrag = {
  enabled: boolean;   // meeting 모드 등에서 비활성
  over: boolean;      // 드롭 대상 하이라이트
  dragging: boolean;  // 드래그 중인 카드(반투명)
  onStart: (e: ReactDragEvent) => void;
  onEnd: (e: ReactDragEvent) => void;
  onOver: (e: ReactDragEvent) => void;
  onDrop: (e: ReactDragEvent) => void;
};

// 사용자별 카드 순서 저장(브라우저 localStorage). phase → rfq_id 배열.
const ORDER_KEY = "act-card-order";
function loadCardOrder(): Record<number, number[]> {
  try {
    return JSON.parse(localStorage.getItem(ORDER_KEY) || "{}") as Record<number, number[]>;
  } catch {
    return {};
  }
}
function saveCardOrder(o: Record<number, number[]>): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(o));
  } catch {
    /* 저장 실패는 무시(시크릿 모드 등). */
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

  // ── 카드 순서(드래그앤드롭) ─────────────────────────────────────────────
  // SSR 하이드레이션 불일치를 피하려고 초기값은 빈 객체, 마운트 후 localStorage 로드.
  const [cardOrder, setCardOrder] = useState<Record<number, number[]>>({});
  useEffect(() => setCardOrder(loadCardOrder()), []);
  const dragId = useRef<number | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null); // 시각 피드백용(리렌더 보장)
  const [overId, setOverId] = useState<number | null>(null);

  // 저장된 순서를 적용해 그룹 행을 정렬. 저장에 없는(신규) 딜은 기본 정렬 순서로 뒤에 둔다.
  function orderedRows(phase: number, rows: { row: PipelineRow; acts: Activity[] }[]) {
    const saved = cardOrder[phase];
    if (!saved || saved.length === 0) return rows;
    const pos = new Map(saved.map((id, i) => [id, i]));
    return [...rows].sort((a, b) => {
      const pa = pos.has(a.row.rfq_id) ? (pos.get(a.row.rfq_id) as number) : Infinity;
      const pb = pos.has(b.row.rfq_id) ? (pos.get(b.row.rfq_id) as number) : Infinity;
      return pa - pb;
    });
  }

  // 드래그한 카드를 대상 카드 '앞'에 삽입하고 그 phase 의 전체 순서를 저장.
  function reorderCards(phase: number, from: number | null, to: number, current: { row: PipelineRow }[]) {
    if (from == null || from === to) return;
    const ids = current.map((r) => r.row.rfq_id);
    const fromIdx = ids.indexOf(from);
    if (fromIdx < 0 || ids.indexOf(to) < 0) return;
    ids.splice(fromIdx, 1);
    ids.splice(ids.indexOf(to), 0, from);
    const next = { ...cardOrder, [phase]: ids };
    setCardOrder(next);
    saveCardOrder(next);
  }

  function makeDrag(phase: number, id: number, current: { row: PipelineRow }[]): CardDrag {
    return {
      enabled: !meeting,
      over: overId === id && draggingId !== null && draggingId !== id,
      dragging: draggingId === id,
      onStart: (e) => { dragId.current = id; setDraggingId(id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(id)); },
      onEnd: () => { dragId.current = null; setDraggingId(null); setOverId(null); },
      onOver: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (overId !== id) setOverId(id); },
      onDrop: (e) => { e.preventDefault(); reorderCards(phase, dragId.current, id, current); dragId.current = null; setDraggingId(null); setOverId(null); },
    };
  }

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
        pic: a.note.pic,
      });
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Update failed");
    }
  }

  async function saveNote(rfqId: number, a: Activity, patch: NotePatch) {
    if (a.kind !== "note") return;
    await updateRfqStageNote(rfqId, a.stage, a.index, {
      text: patch.text,
      datetime: patch.datetime,
      direction: patch.direction,
      party: patch.party,
      channel: a.note.channel, // 편집 폼에 없는 필드 — 기존값 보존
      star: patch.star ?? a.note.star,
      pic: patch.pic,
    });
    load();
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
              {(() => {
                const ordered = orderedRows(g.phase, g.rows);
                return ordered.map(({ row, acts }) => (
                  <ActivityCard
                    key={row.rfq_id}
                    row={row}
                    acts={acts}
                    meeting={meeting}
                    onStar={(a) => toggleStar(row.rfq_id, a)}
                    onDelete={(a) => removeNote(row.rfq_id, a)}
                    onSave={(a, patch) => saveNote(row.rfq_id, a, patch)}
                    onAdded={load}
                    drag={makeDrag(g.phase, row.rfq_id, ordered)}
                  />
                ));
              })()}
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
  onSave,
  onAdded,
  drag,
}: {
  row: PipelineRow;
  acts: Activity[];
  meeting: boolean;
  onStar: (a: Activity) => void;
  onDelete: (a: Activity) => void;
  onSave: (a: Activity, patch: NotePatch) => Promise<void>;
  onAdded: () => void;
  drag?: CardDrag;
}) {
  const { code, date } = splitProjectNo(row.project_no || row.kmaris_rfq_no || "—");
  const vend = vendorOf(row);
  const isService = row.work_type === "서비스";
  // 경과일(최신 활동 이후) + 색상 등급 — progress next-action 규칙 동기화.
  // 백엔드 next_level 이 있으면 그대로(완료/실주=normal 포함), 없으면 임계값(7/14일)으로.
  const ageDays = daysSinceISO(lastActivityISO(row));
  const ageLevel: "normal" | "warn" | "urgent" = row.next_level
    ? row.next_level
    : !row.cancelled && ageDays != null
      ? ageDays >= 14 ? "urgent" : ageDays >= 7 ? "warn" : "normal"
      : "normal";
  return (
    <div
      className={`act-card${isService ? " service" : ""}${drag?.over ? " drag-over" : ""}${drag?.dragging ? " dragging" : ""}`}
      onDragOver={drag?.onOver}
      onDrop={drag?.onDrop}
    >
      {/* 상단 헤더(1~3행) — 음영으로 카드 식별. 이 영역을 잡고 드래그해 순서 변경. */}
      <div
        className={`act-card-head${drag?.enabled ? " draggable" : ""}`}
        draggable={drag?.enabled ?? false}
        onDragStart={drag?.onStart}
        onDragEnd={drag?.onEnd}
        title={drag?.enabled ? "Drag to reorder" : undefined}
      >
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
        {/* 고객사(로고+이름) · 담당자 / 벤더(이니셜 원형 배지). (우측 상단 배지 = 내부 PIC) */}
        {(row.customer || vend) ? (
          <div className="act-sub">
            {row.customer ? <CustomerName name={row.customer} /> : null}
            {row.contact_person ? <span className="act-sub-contact">· {row.contact_person}</span> : null}
            {vend ? <span className="act-sub-sep">/</span> : null}
            {vend ? <VendorMonograms value={vendorOf(row)} statuses={vendorStatusesFor(row)} /> : null}
          </div>
        ) : null}
      </div>
      <ul className="act-list">
        {acts.length === 0 ? <li className="act-empty muted">No activity yet</li> : null}
        {acts.map((a, i) =>
          a.kind === "note" ? (
            <NoteRow
              key={i}
              a={a}
              meeting={meeting}
              onStar={() => onStar(a)}
              onDelete={() => onDelete(a)}
              onSave={(patch) => onSave(a, patch)}
            />
          ) : (
            <li key={i} className={`act-item${a.kind === "close" ? " closed" : ""}`}>
              <span className="act-date">{md(a.date)}</span>
              {a.kind === "auto" ? (
                <span className="act-auto">
                  <span className="act-tag">auto</span> {a.label}
                  {a.party ? <span className="act-meta"> · {a.party}</span> : null}
                </span>
              ) : (
                <span className="act-text"><span className="act-tag close">closed</span> {a.reason || "Closed"}</span>
              )}
            </li>
          )
        )}
      </ul>
      {!meeting ? <AddActivity rfqId={row.rfq_id} stage={row.stage} onAdded={onAdded} /> : null}
      {ageDays != null ? (
        <span className={`act-age lv-${ageLevel}`} title="Days since last activity">{ageDays}d</span>
      ) : null}
    </div>
  );
}

// Party 선택 — 프리셋(Customer/Vendor/Internal) + '직접입력'(자유 텍스트).
const PARTY_PRESETS = ["Customer", "Vendor", "Internal"];
function PartySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  // 값이 있고 프리셋이 아니면 직접입력 모드로 시작.
  const [custom, setCustom] = useState(() => !!value && !PARTY_PRESETS.includes(value));
  return (
    <>
      <select
        value={custom ? "__custom__" : value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__custom__") { setCustom(true); onChange(""); }
          else { setCustom(false); onChange(v); }
        }}
      >
        <option value="">Party —</option>
        {PARTY_PRESETS.map((p) => (
          <option key={p} value={p}>{p}</option>
        ))}
        <option value="__custom__">직접입력</option>
      </select>
      {custom ? (
        <input
          className="act-party-custom"
          type="text"
          value={value}
          placeholder="Party"
          autoFocus
          onChange={(e) => onChange(e.target.value)}
        />
      ) : null}
    </>
  );
}

// 기존 활동 노트 1건 — 표시/인라인 수정 토글.
function NoteRow({
  a,
  meeting,
  onStar,
  onDelete,
  onSave,
}: {
  a: Extract<Activity, { kind: "note" }>;
  meeting: boolean;
  onStar: () => void;
  onDelete: () => void;
  onSave: (patch: NotePatch) => Promise<void>;
}) {
  const n = a.note;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState(n.text);
  const [date, setDate] = useState((n.datetime || n.at || "").slice(0, 10) || todayISO());
  const [dir, setDir] = useState<"" | "in" | "out">((n.direction as "" | "in" | "out") || "");
  const [party, setParty] = useState(n.party || "");
  const [star, setStar] = useState(!!n.star);
  const [pic, setPic] = useState(n.pic || "");
  const picOptions = usePicOptions(pic);

  function begin() {
    // 최신 저장값으로 초기화 후 편집 시작.
    setText(n.text);
    setDate((n.datetime || n.at || "").slice(0, 10) || todayISO());
    setDir((n.direction as "" | "in" | "out") || "");
    setParty(n.party || "");
    setStar(!!n.star);
    setPic(n.pic || "");
    setEditing(true);
  }

  async function save() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await onSave({
        text: text.trim(),
        datetime: `${date}T09:00`,
        direction: dir || undefined,
        party: party || undefined,
        star,
        pic: pic.trim() || undefined,
      });
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <li className="act-item editing">
        <div className="act-add act-edit">
          {/* 1행: 날짜 · From/To · Party · 담당자 · ★ */}
          <div className="act-add-row">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <div className="act-seg sm">
              {(["in", "out"] as const).map((d) => (
                <button key={d} className={dir === d ? "on" : ""} onClick={() => setDir((v) => (v === d ? "" : d))}>
                  {d === "in" ? "From" : "To"}
                </button>
              ))}
            </div>
            <PartySelect value={party} onChange={setParty} />
            <select className="act-add-pic" value={pic} title="담당자(작성자)" onChange={(e) => setPic(e.target.value)}>
              {pic ? null : <option value="">PIC —</option>}
              {picOptions.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
            <label className="act-check"><input type="checkbox" checked={star} onChange={(e) => setStar(e.target.checked)} /> ★</label>
          </div>
          {/* 2행: 내용 */}
          <div className="act-add-row">
            <textarea
              className="act-add-text"
              value={text}
              rows={2}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); } }}
              autoFocus
            />
          </div>
          {/* 3행: Save · Cancel */}
          <div className="act-add-row">
            <button className="btn sm primary act-add-go" disabled={busy || !text.trim()} onClick={save}>{busy ? "…" : "Save"}</button>
            <button className="btn sm act-add-go" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className={`act-item${n.star ? " star" : ""}`}>
      <span className="act-date">{md(a.date)}</span>
      <span className="act-text">
        {n.text}
        {(() => {
          const dl = n.direction === "in" ? "from" : n.direction === "out" ? "to" : "";
          const who = [dl, n.party].filter(Boolean).join(" ");
          const parts = [who, n.channel].filter(Boolean);
          return parts.length ? <span className="act-meta"> · {parts.join(" · ")}</span> : null;
        })()}
        {n.pic ? <span className="act-note-pic">{n.pic}</span> : null}
      </span>
      <span className="act-actions">
        <button className={`act-starbtn${n.star ? " on" : ""}`} title="Mark priority" onClick={onStar}>★</button>
        {!meeting ? <button className="act-edit-btn" title="Edit" onClick={begin}>✎</button> : null}
        {!meeting ? <button className="act-del" title="Delete" onClick={onDelete}>×</button> : null}
      </span>
    </li>
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
  const [pic, setPic] = useState(me?.username ?? ""); // 담당자(작성자) — 기본값=로그인 사용자, 편집 가능
  const picOptions = usePicOptions(pic);

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
        pic: pic.trim() || undefined,
      });
      setText(""); setDir(""); setParty(""); setStar(false); setPic(me?.username ?? ""); setOpen(false);
      onAdded();
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="act-add-btn" onClick={() => setOpen(true)}>+ Add activity</button>
    );
  }
  return (
    <div className="act-add">
      {/* 1행: 날짜 */}
      <div className="act-add-row">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      {/* 2행: From/To · Party · 담당자(PIC) · ★ */}
      <div className="act-add-row">
        <div className="act-seg sm">
          {(["in", "out"] as const).map((d) => (
            <button key={d} className={dir === d ? "on" : ""} onClick={() => setDir((v) => (v === d ? "" : d))}>
              {d === "in" ? "From" : "To"}
            </button>
          ))}
        </div>
        <PartySelect value={party} onChange={setParty} />
        <select className="act-add-pic" value={pic} title="담당자(작성자)" onChange={(e) => setPic(e.target.value)}>
          {pic ? null : <option value="">PIC —</option>}
          {picOptions.map((u) => (
            <option key={u} value={u}>{u}</option>
          ))}
        </select>
        <label className="act-check"><input type="checkbox" checked={star} onChange={(e) => setStar(e.target.checked)} /> ★</label>
      </div>
      {/* 3행: 내용 입력 — 길어지면 자동 줄바꿈(Enter=저장, Shift+Enter=줄바꿈). */}
      <div className="act-add-row">
        <textarea
          className="act-add-text"
          placeholder="Activity note (e.g. Waiting for PO / requested update)"
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          autoFocus
        />
      </div>
      {/* 4행: Add · Cancel */}
      <div className="act-add-row">
        <button className="btn sm primary act-add-go" disabled={busy || !text.trim()} onClick={submit}>{busy ? "…" : "Add"}</button>
        <button className="btn sm act-add-go" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}
