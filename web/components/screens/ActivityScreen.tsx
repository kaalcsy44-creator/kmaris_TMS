"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { PipelineModal, byProjectNo } from "@/components/screens/ProjectsScreen";
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

// By-deal 매트릭스의 단계 열 — Project Overview 의 Stages&activity 4칸과 동일한 구획.
const STAGE_COLUMNS: { label: string; tone: string; from: number; to: number }[] = [
  { label: "RFQ", tone: "r", from: 1, to: 2 },
  { label: "Quote", tone: "q", from: 3, to: 4 },
  { label: "P/O", tone: "p", from: 5, to: 6 },
  { label: "C/I & after", tone: "c", from: 7, to: 11 },
];

function todayISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 기존 활동 노트 수정 시 전달하는 값.
type NotePatch = { text: string; datetime?: string; direction?: string; party?: string; channel?: string; star?: boolean; pic?: string };


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

  // 매트릭스 행 = 프로젝트. 단계 버킷을 평탄화해 최근 활동순으로 정렬한다.
  const dealRows = useMemo(() => {
    const all = buckets.flatMap((g) => g.rows);
    return all.sort((a, b) => {
      const la = a.acts.length ? a.acts[a.acts.length - 1].date : "";
      const lb = b.acts.length ? b.acts[b.acts.length - 1].date : "";
      return la < lb ? 1 : la > lb ? -1 : 0;
    });
  }, [buckets]);

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

  // 개요 모달의 인접 프로젝트 전환 — 이웃 집합은 현재 뷰에 보이는 프로젝트(필터 적용)이되,
  // 순서는 프로젝트 번호 오름차순으로 고정한다(ProjectsScreen 과 동일 기준). ←=이전(작은 번호),
  // →=다음(큰 번호). 딜/일자 탭 모두 같은 방향으로 읽히게 하려는 것.
  const navIds = useMemo(() => {
    const rows: PipelineRow[] = [];
    const seen = new Set<number>();
    const collect = (row: PipelineRow) => {
      if (!seen.has(row.rfq_id)) {
        seen.add(row.rfq_id);
        rows.push(row);
      }
    };
    if (view === "deal") {
      for (const g of buckets) for (const { row } of g.rows) collect(row);
    } else {
      for (const w of weekView) for (const d of w.days) for (const p of d.projects) collect(p.row);
    }
    return [...rows].sort(byProjectNo).map((r) => r.rfq_id);
  }, [view, buckets, weekView]);

  // 마지막에서 다음은 처음, 처음에서 이전은 마지막으로 순환(ProjectsScreen 과 동일).
  const navigateOverview = useCallback(
    (dir: -1 | 1) => {
      setOverviewId((cur) => {
        if (cur == null) return cur;
        const idx = navIds.indexOf(cur);
        if (idx < 0) return cur;
        const n = navIds.length;
        return navIds[(((idx + dir) % n) + n) % n];
      });
    },
    [navIds]
  );

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
          {totalDeals > 0 ? (
            // 프로젝트=행, 단계(RFQ/Quote/P·O/C·I)=열 매트릭스. 활동이 세로로 길어져도
            // 단계 열로 분산돼 행 높이가 완만히 늘고, 상단 단계 헤더는 스크롤에 고정된다.
            <div className="act-matrix">
              <div className="act-mx-hcell act-mx-proj-h">Project</div>
              {STAGE_COLUMNS.map((c) => (
                <div key={c.label} className="act-mx-hcell">{c.label}</div>
              ))}
              {dealRows.map(({ row, acts }) => (
                <DealStageRow
                  key={row.rfq_id}
                  row={row}
                  acts={acts}
                  meeting={meeting}
                  onStar={(a) => toggleStar(row.rfq_id, a)}
                  onDelete={(a) => removeNote(row.rfq_id, a)}
                  onSave={(a, patch) => saveNote(row.rfq_id, a, patch)}
                  onAdded={load}
                  onOverview={() => setOverviewId(row.rfq_id)}
                />
              ))}
            </div>
          ) : null}
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
                        <div
                          key={p.row.rfq_id}
                          className={`act-cal-proj${p.row.work_type === "서비스" ? " service" : ""}`}
                        >
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
          onNavigate={navigateOverview}
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

// 매트릭스 한 행 = 한 프로젝트. 좌측 정보 셀 + 단계 4열 셀(그 단계의 활동)을 그리드에
// 직접 흘려보낸다(부모 .act-matrix 가 5열 그리드). 활동 노트는 편집 가능한 NoteRow 재사용.
function DealStageRow({
  row,
  acts,
  meeting,
  onStar,
  onDelete,
  onSave,
  onAdded,
  onOverview,
}: {
  row: PipelineRow;
  acts: Activity[];
  meeting: boolean;
  onStar: (a: Activity) => void;
  onDelete: (a: Activity) => void;
  onSave: (a: Activity, patch: NotePatch) => Promise<void>;
  onAdded: () => void;
  onOverview: () => void;
}) {
  const { code, date } = splitProjectNo(row.project_no || row.kmaris_rfq_no || "—");
  const vend = vendorOf(row);
  const isService = row.work_type === "서비스";
  const ageDays = daysSinceISO(lastActivityISO(row));
  const ageLevel: "normal" | "warn" | "urgent" = row.next_level
    ? row.next_level
    : !row.cancelled && ageDays != null
      ? ageDays >= 14 ? "urgent" : ageDays >= 7 ? "warn" : "normal"
      : "normal";
  const vs = (row.vessels || row.vessel || "").split("\n").filter(Boolean).join(" · ");
  // 활동(자동 이벤트·노트)을 단계 열로 분배. 종결(close)은 단계가 없어 정보 셀에서 처리.
  const closeAct = acts.find((a) => a.kind === "close");
  const byCol = STAGE_COLUMNS.map((c) =>
    acts.filter((a) => (a.kind === "note" || a.kind === "auto") && a.stage >= c.from && a.stage <= c.to),
  );
  // "+ Add activity"는 현재 단계 열(보통 최신 활동이 있는 열)의 맨 아래에 둔다.
  const addColRaw = STAGE_COLUMNS.findIndex((c) => row.stage >= c.from && row.stage <= c.to);
  const addCol = addColRaw < 0 ? 0 : addColRaw;
  const infoCls = `act-mx-info${isService ? " service" : ""}${row.cancelled ? " cancelled" : ""}`;

  return (
    <>
      <div className={infoCls}>
        <div className="act-card-h">
          <button type="button" className="act-pno" onClick={onOverview} title="Project overview">{code}</button>
          {date ? <span className="act-pno-date">{date}</span> : null}
          <span className="act-spacer" />
          {row.assignee ? <span className="act-pic">{row.assignee}</span> : null}
          <Link className="act-open" href={`/project?rfq=${row.rfq_id}&view=overview`} title="Project overview">→</Link>
          <Link className="act-open act-open-edit" href={`/project?rfq=${row.rfq_id}&stage=${row.stage}`} title="Open deal in Progress">✎</Link>
        </div>
        <div className="act-title2">
          {row.project_title || "(untitled)"}
          {vs ? <span className="act-tvessel"> · {vs}</span> : null}
        </div>
        {(row.customer || vend) ? (
          <div className="act-sub">
            {row.customer ? <CustomerName name={row.customer} /> : null}
            {row.contact_person ? <span className="act-sub-contact">· {row.contact_person}</span> : null}
            {vend ? <span className="act-sub-sep">/</span> : null}
            {vend ? <VendorMonograms value={vendorOf(row)} statuses={vendorStatusesFor(row)} /> : null}
          </div>
        ) : null}
        {closeAct ? (
          <div className="act-mx-closed"><span className="act-tag close">closed</span> {closeAct.kind === "close" ? closeAct.reason || "Closed" : ""}</div>
        ) : null}
        {ageDays != null ? (
          <div className="act-mx-info-foot">
            <span className={`act-age-inline lv-${ageLevel}`} title="Days since last activity">{ageDays}d</span>
          </div>
        ) : null}
      </div>
      {byCol.map((cacts, ci) => {
        // 지나왔거나 진행 중인 단계 열(ci ≤ 현재 단계 열)에 상단 업무타입 색 bar.
        const cur = ci <= addCol && !row.cancelled;
        return (
        <div key={ci} className={`act-mx-cell${cur ? (isService ? " cur-service" : " cur-parts") : ""}`}>
          {cacts.length > 0 ? (
            <ul className="act-list">
              {cacts.map((a, i) =>
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
                  <li key={i} className="act-item">
                    <span className="act-date">{md(a.date)}</span>
                    <span className="act-auto">
                      {a.kind === "auto" ? a.label : ""}
                      {a.kind === "auto" && a.party ? <span className="act-meta"> · {a.party}</span> : null}
                    </span>
                  </li>
                ),
              )}
            </ul>
          ) : ci !== addCol ? (
            <span className="act-mx-empty">·</span>
          ) : null}
          {ci === addCol && !meeting ? (
            <AddActivity rfqId={row.rfq_id} stage={row.stage} onAdded={onAdded} />
          ) : null}
        </div>
        );
      })}
    </>
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
