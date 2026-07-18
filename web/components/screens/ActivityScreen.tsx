"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  fetchPipeline,
  fetchCustomers,
  fetchSettingsVessels,
  addRfqStageNote,
  updateRfqStageNote,
  deleteRfqStageNote,
} from "@/lib/api";
import type { PipelineData, PipelineRow, StageNote } from "@/lib/types";
import { getUserId } from "@/lib/auth";
import { vendorOf } from "@/lib/deal";
import {
  buildActivities,
  daysSinceISO,
  lastActivityISO,
  md,
  splitProjectNo,
  type Activity,
} from "@/lib/activity";
import CustomerName from "@/components/common/CustomerName";
import VendorMonograms from "@/components/common/VendorMonograms";
import ActivityDesc from "@/components/common/ActivityDesc";
import ActivityNoteForm, {
  initialNoteValue,
  type ActivityNoteValue,
} from "@/components/common/ActivityNoteForm";
import { PipelineModal } from "@/components/screens/ProjectsScreen";
import { useCachedData } from "@/lib/useCachedData";

// 벤더 모노그램 상태 — 발주 벤더 확정 시 문자열 fallback, 아니면 RFQ 발송 벤더의 견적 수신여부.
// (ProjectsScreen 과 동일 규칙.)
function vendorStatusesFor(r: PipelineRow): { name: string; quoted: boolean }[] | undefined {
  if (r.vendor) return undefined;
  return r.rfq_vendors && r.rfq_vendors.length ? r.rfq_vendors : undefined;
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

function todayISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 기존 활동 노트 수정 시 전달하는 값.
type NotePatch = { text: string; datetime?: string; direction?: string; party?: string; channel?: string; star?: boolean; pic?: string };

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

export default function ActivityScreen() {
  // 프로젝트 개요의 "Activity Log →" 바로가기가 ?q=<프로젝트번호> 로 넘어온다 —
  // 그 딜만 걸러 보이게 검색어 초기값으로 쓴다(이후엔 사용자가 자유롭게 바꾼다).
  const params = useSearchParams();
  const [data, setData] = useState<PipelineData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState(() => params.get("q") ?? "");
  const [mine, setMine] = useState(false);
  const [dateFilter, setDateFilter] = useState<"all" | "today" | "date">("all");
  const [pickDate, setPickDate] = useState(todayISO());
  const [showClosed, setShowClosed] = useState(false);
  const [meeting, setMeeting] = useState(false);
  const [view, setView] = useState<"deal" | "date">("deal"); // 탭: 딜별(카드) / 일자별(피드)

  const [overviewId, setOverviewId] = useState<number | null>(null);
  const { data: customers } = useCachedData("settings:customers", fetchCustomers);
  const { data: vessels } = useCachedData("settings:vessels", fetchSettingsVessels);
  const uid = getUserId();

  function load() {
    fetchPipeline()
      .then(setData)
      .catch((e) => setErr(e instanceof Error ? e.message : "Error"));
  }
  useEffect(load, []);

  const steps = data?.steps ?? [];
  const today = todayISO();
  const targetDate = dateFilter === "today" ? today : dateFilter === "date" ? pickDate : "";

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

  // ── 일자별 탭 — 주간 캘린더(7열). 주(월요일 시작)가 한 행, 위=이전 주·아래=다음 주.
  //    각 날짜 셀에 프로젝트별로 활동을 묶어 나열한다. 필터는 딜별 탭과 공유. ──
  const weekView = useMemo(() => {
    // 필터를 통과한 활동을 평탄화(날짜 없는 건은 캘린더에서 제외).
    const flat: { row: PipelineRow; act: Activity }[] = [];
    for (const row of data?.rows ?? []) {
      if (row.cancelled && !showClosed) continue;
      if (mine && row.assignee_id !== uid) continue;
      const text = `${row.project_no} ${row.project_title} ${row.customer} ${row.vendor} ${row.vrfq_vendors} ${row.vessel}`.toLowerCase();
      if (q.trim() && !text.includes(q.trim().toLowerCase())) continue;
      let acts = buildActivities(row, steps);
      if (targetDate) acts = acts.filter((a) => a.date === targetDate);
      for (const act of acts) if (act.date) flat.push({ row, act });
    }
    // 주(월요일 ISO) → 날짜 → 프로젝트(rfq_id) 로 3단계 그룹화.
    const weeks = new Map<string, Map<string, Map<number, { row: PipelineRow; acts: Activity[] }>>>();
    for (const { row, act } of flat) {
      const ws = weekStart(act.date);
      if (!weeks.has(ws)) weeks.set(ws, new Map());
      const days = weeks.get(ws) as Map<string, Map<number, { row: PipelineRow; acts: Activity[] }>>;
      if (!days.has(act.date)) days.set(act.date, new Map());
      const projs = days.get(act.date) as Map<number, { row: PipelineRow; acts: Activity[] }>;
      if (!projs.has(row.rfq_id)) projs.set(row.rfq_id, { row, acts: [] });
      (projs.get(row.rfq_id) as { row: PipelineRow; acts: Activity[] }).acts.push(act);
    }
    // 주 오름차순(위=이전) → 각 주를 월~일 7칸으로 채운다.
    return Array.from(weeks.keys()).sort().map((ws) => {
      const days: DayCell[] = [];
      for (let i = 0; i < 7; i++) {
        const date = addDays(ws, i);
        const projMap = weeks.get(ws)?.get(date);
        const projects = projMap
          ? Array.from(projMap.values()).sort((a, b) => {
              const pa = a.row.project_no || "", pb = b.row.project_no || "";
              return pa < pb ? -1 : pa > pb ? 1 : 0;
            })
          : [];
        for (const p of projects) p.acts.sort((x, y) => actStageSort(x) - actStageSort(y));
        days.push({ date, projects });
      }
      return { start: ws, days };
    });
  }, [data, steps, q, mine, uid, showClosed, targetDate]);

  const totalActs = weekView.reduce(
    (s, w) => s + w.days.reduce((ds, d) => ds + d.projects.reduce((ps, p) => ps + p.acts.length, 0), 0),
    0
  );

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
      channel: patch.channel,
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
      {/* 페이지 탭 — Progress 페이지와 동일한 폼(상단 고정 밑줄 탭 + 우측 교차 링크). */}
      <div className="page-tabs">
        <button
          className={view === "deal" ? "on" : ""}
          onClick={() => setView("deal")}
        >
          Activity (By deal)
        </button>
        <button
          className={view === "date" ? "on" : ""}
          onClick={() => setView("date")}
        >
          Activity (By date)
        </button>
        <Link href="/project" className="btn sm" style={{ marginLeft: "auto" }}>
          📋 Projects
        </Link>
      </div>

      <div className="act-toolbar">
        <span className="act-count">
          {view === "deal" ? `stage activity by deal · ${totalDeals}` : `stage activity by date · ${totalActs}`}
        </span>
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

      {view === "deal" ? (
        <>
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
                        onOverview={() => setOverviewId(row.rfq_id)}
                        drag={makeDrag(g.phase, row.rfq_id, ordered)}
                      />
                    ));
                  })()}
                </div>
              </section>
            )
          )}
        </>
      ) : (
        <>
          {totalActs === 0 ? <div className="state">No activity to show.</div> : null}
          {totalActs > 0 ? (
            <div className="act-cal">
              <div className="act-cal-weekdays">
                {WEEKDAYS.map((w) => (
                  <div key={w} className="act-cal-wd">{w}</div>
                ))}
              </div>
              {weekView.map((week) => (
                <div key={week.start} className="act-cal-week">
                  {week.days.map((day) => (
                    <div
                      key={day.date}
                      className={`act-cal-day${day.date === today ? " today" : ""}${day.projects.length === 0 ? " empty" : ""}`}
                    >
                      <div className="act-cal-date">{md(day.date)}</div>
                      {day.projects.map((p) => (
                        <div key={p.row.rfq_id} className="act-cal-proj">
                          <div className="act-cal-phead">
                            <button
                              type="button"
                              className="act-cal-pno"
                              onClick={() => setOverviewId(p.row.rfq_id)}
                              title="Project overview"
                            >
                              {splitProjectNo(p.row.project_no || p.row.kmaris_rfq_no || "—").code}
                            </button>
                            <span className="act-cal-ptitle">{p.row.project_title || "(untitled)"}</span>
                          </div>
                          <ul className="act-cal-acts">
                            {p.acts.map((a, i) => (
                              <li
                                key={i}
                                className={`act-cal-act ${a.kind === "note" ? "note" : a.kind === "close" ? "closed" : "auto"}${a.kind === "note" && a.note.star ? " star" : ""}`}
                              >
                                <ActivityDesc act={a} />
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
      {overviewId != null && data?.rows.find((row) => row.rfq_id === overviewId) ? (
        <PipelineModal
          r={data.rows.find((row) => row.rfq_id === overviewId) as PipelineRow}
          steps={data.steps}
          customers={customers ?? []}
          vessels={vessels ?? []}
          onChanged={load}
          onClose={() => setOverviewId(null)}
          initialView="overview"
        />
      ) : null}
    </div>
  );
}

// 주간 캘린더용 타입/헬퍼.
type DayCell = { date: string; projects: { row: PipelineRow; acts: Activity[] }[] };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function actStageSort(a: Activity): number {
  return a.kind === "close" ? 99 : a.stage;
}
function toISODate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// 해당 날짜가 속한 주의 월요일(ISO).
function weekStart(iso: string): string {
  const d = new Date(`${iso}T00:00`);
  const day = d.getDay(); // 0=일 … 6=토
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return toISODate(d);
}
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00`);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

function ActivityCard({
  row,
  acts,
  meeting,
  onStar,
  onDelete,
  onSave,
  onAdded,
  onOverview,
  drag,
}: {
  row: PipelineRow;
  acts: Activity[];
  meeting: boolean;
  onStar: (a: Activity) => void;
  onDelete: (a: Activity) => void;
  onSave: (a: Activity, patch: NotePatch) => Promise<void>;
  onAdded: () => void;
  onOverview: () => void;
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
          <button
            type="button"
            className="act-pno"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onOverview}
            title="Project overview"
          >
            {code}
          </button>
          {date ? <span className="act-pno-date">{date}</span> : null}
          <span className="act-spacer" />
          {row.assignee ? <span className="act-pic">{row.assignee}</span> : null}
          {/* 개요(읽기 전용 한 페이지) → / 진행현황 팝업(작업) ✎ — 두 진입점을 나눠 둔다. */}
          <Link className="act-open" href={`/project?rfq=${row.rfq_id}&view=overview`} title="Project overview">→</Link>
          <Link
            className="act-open act-open-edit"
            href={`/project?rfq=${row.rfq_id}&stage=${row.stage}`}
            title="Open deal in Progress"
          >
            ✎
          </Link>
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
                  {a.label}
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

/** 저장된 노트 → 폼 값. */
function noteToForm(n: StageNote): ActivityNoteValue {
  return initialNoteValue({
    text: n.text,
    datetime: n.datetime || n.at || "",
    direction: (n.direction as "" | "in" | "out") || "",
    party: n.party || "",
    channel: n.channel || "",
    star: !!n.star,
    pic: n.pic || "",
  });
}

/** 폼 값 → 저장 payload. 빈 값은 보내지 않아 서버가 '미지정'으로 남긴다. */
function formToPatch(v: ActivityNoteValue): NotePatch {
  return {
    text: v.text.trim(),
    datetime: v.datetime,
    direction: v.direction || undefined,
    party: v.party || undefined,
    channel: v.channel || undefined,
    star: v.star,
    pic: v.pic.trim() || undefined,
  };
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
  const [form, setForm] = useState<ActivityNoteValue>(() => noteToForm(n));

  function begin() {
    setForm(noteToForm(n));   // 최신 저장값으로 초기화 후 편집 시작.
    setEditing(true);
  }

  async function save() {
    if (!form.text.trim()) return;
    setBusy(true);
    try {
      await onSave(formToPatch(form));
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <li className="act-item editing">
        <div className="act-edit">
          <ActivityNoteForm
            value={form}
            onChange={setForm}
            onSubmit={save}
            onCancel={() => setEditing(false)}
            submitLabel="Save"
            busy={busy}
          />
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
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<ActivityNoteValue>(() => initialNoteValue());

  async function submit() {
    if (!form.text.trim()) return;
    setBusy(true);
    try {
      await addRfqStageNote(rfqId, stage, formToPatch(form));
      setForm(initialNoteValue());
      setOpen(false);
      onAdded();
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return <button className="act-add-btn" onClick={() => setOpen(true)}>+ Add activity</button>;
  }
  return (
    <ActivityNoteForm
      value={form}
      onChange={setForm}
      onSubmit={submit}
      onCancel={() => setOpen(false)}
      submitLabel="Add"
      busy={busy}
    />
  );
}
