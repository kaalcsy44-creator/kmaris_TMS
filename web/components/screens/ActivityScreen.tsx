"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  fetchPipeline,
  fetchCustomers,
  fetchSettingsVessels,
  fetchMailByDate,
  addRfqStageNote,
  updateRfqStageNote,
  deleteRfqStageNote,
} from "@/lib/api";
import type { MailDateRow, PipelineData, PipelineRow, StageNote } from "@/lib/types";
import { vendorOf, activityParties, activityPersons } from "@/lib/deal";
import {
  buildActivities,
  daysSinceISO,
  hm,
  lastActivityISO,
  md,
  splitProjectNo,
  type Activity,
} from "@/lib/activity";
import CustomerName from "@/components/common/CustomerName";
import UnmatchedMailPanel, { type MailQueue } from "@/components/common/UnmatchedMailPanel";
import FilterSelect from "@/components/common/FilterSelect";
import VendorMonograms from "@/components/common/VendorMonograms";
import ActivityDesc from "@/components/common/ActivityDesc";
import ActivityNoteForm, {
  initialNoteValue,
  noteFormToPatch as formToPatch,
  type ActivityNoteValue,
  type NotePatch,
} from "@/components/common/ActivityNoteForm";
import { PipelineModal, byProjectNo } from "@/components/screens/ProjectsScreen";
import Modal from "@/components/common/Modal";
import { useCachedData } from "@/lib/useCachedData";

// 벤더 모노그램 상태 — 발주 벤더 확정 시 문자열 fallback, 아니면 RFQ 발송 벤더의 견적 수신여부.
// (ProjectsScreen 과 동일 규칙.)
function vendorStatusesFor(r: PipelineRow): { name: string; quoted: boolean }[] | undefined {
  if (r.vendor) return undefined;
  return r.rfq_vendors && r.rfq_vendors.length ? r.rfq_vendors : undefined;
}

// 딜에 걸린 선박 한 줄 — 오더별로 여러 척이면 첫 척에 "+N" 을 붙인다(줄바꿈 목록이 온다).
function vesselLabel(r: PipelineRow): string {
  const list = (r.vessels || r.vessel || "")
    .split("\n")
    .map((v) => v.trim())
    .filter(Boolean);
  if (!list.length) return "";
  return list.length > 1 ? `${list[0]} +${list.length - 1}` : list[0];
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
// 딜의 현재 단계가 속한 열 인덱스(단계 필터·진행 bar 공용).
function stageColOf(stage: number): number {
  const i = STAGE_COLUMNS.findIndex((c) => stage >= c.from && stage <= c.to);
  return i < 0 ? 0 : i;
}
// 딜에 연결된 vendor 이름 목록(","·줄바꿈 분리). vendor 필터·옵션 공용.
function vendorNames(row: PipelineRow): string[] {
  return (vendorOf(row) || "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}
// 경과일(최신 활동 이후) 구간 — 멀티 선택 필터용.
const AGE_BUCKETS: { value: string; label: string; min: number; max: number }[] = [
  { value: "0", label: "≤ 6d", min: 0, max: 6 },
  { value: "7", label: "7–13d", min: 7, max: 13 },
  { value: "14", label: "14–29d", min: 14, max: 29 },
  { value: "30", label: "≥ 30d", min: 30, max: Infinity },
];
const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "closed", label: "Closed" },
];

// 날짜 필터 — 다른 필터와 동일한 버튼/드롭다운 폼(단, 단일 선택). "Pick date" 시 날짜 입력.
function DateFilter({
  value,
  pickDate,
  onValue,
  onPick,
}: {
  value: "all" | "today" | "date";
  pickDate: string;
  onValue: (v: "all" | "today" | "date") => void;
  onPick: (d: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const label = value === "all" ? "All dates" : value === "today" ? "Today" : pickDate || "Pick date";
  return (
    <div className="filt" ref={ref}>
      <button type="button" className={`filt-btn${value !== "all" ? " on" : ""}`} onClick={() => setOpen((o) => !o)} title="Date">
        <span className="filt-lbl">{label}</span>
        <span className="filt-caret" aria-hidden>▾</span>
      </button>
      {open ? (
        <div className="filt-menu">
          {/* 시각은 다른 필터와 동일한 체크박스, 동작은 단일 선택(하나만 checked). */}
          <label className="filt-opt"><input type="checkbox" checked={value === "all"} onChange={() => { onValue("all"); setOpen(false); }} /><span>All dates</span></label>
          <label className="filt-opt"><input type="checkbox" checked={value === "today"} onChange={() => { onValue("today"); setOpen(false); }} /><span>Today</span></label>
          <label className="filt-opt"><input type="checkbox" checked={value === "date"} onChange={() => onValue("date")} /><span>Pick date</span></label>
          {value === "date" ? (
            <input type="date" className="filt-date" value={pickDate} onChange={(e) => onPick(e.target.value)} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// 활동 1건의 정렬/표시용 전체 일시(iso) — 노트는 datetime→at, 자동은 at, 종결은 날짜만.
function actTimeIso(act: Activity): string {
  if (act.kind === "note") return act.note.datetime || act.note.at || act.date;
  if (act.kind === "auto") return act.at || act.date;
  return act.date;
}

function todayISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 기존 활동 노트 수정 시 전달하는 값.


export default function ActivityScreen() {
  // 프로젝트 개요의 "Activity Log →" 바로가기가 ?q=<프로젝트번호> 로 넘어온다 —
  // 그 딜만 걸러 보이게 검색어 초기값으로 쓴다(이후엔 사용자가 자유롭게 바꾼다).
  const params = useSearchParams();
  const [data, setData] = useState<PipelineData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState(() => params.get("q") ?? "");
  const [dateFilter, setDateFilter] = useState<"all" | "today" | "date">("all");
  const [pickDate, setPickDate] = useState(todayISO());
  // 멀티 선택 필터(모두 동일 폼 드롭다운). 값은 문자열 배열.
  const [assigneeF, setAssigneeF] = useState<string[]>([]);
  const [statusF, setStatusF] = useState<string[]>(["active"]); // 기본: 진행 중만(종결 제외)
  const [stageF, setStageF] = useState<string[]>([]);
  const [ageF, setAgeF] = useState<string[]>([]);
  const [custF, setCustF] = useState<string[]>([]);
  const [vendF, setVendF] = useState<string[]>([]);
  // 탭: 딜별(카드) / 일자별(피드) / 메일 정리함. 대시보드의 "N unmatched" 와
  // Settings › Mailbox 의 "N unregistered" 링크가 ?view=mail(&queue=…)로 넘어오므로
  // 초기값을 주소에서 받는다.
  const [view, setView] = useState<"deal" | "date" | "mail">(
    () => (params.get("view") === "mail" ? "mail" : "deal"),
  );
  const mailQueue: MailQueue =
    params.get("queue") === "unknown" ? "unknown"
      : params.get("queue") === "filed" ? "filed"
      : "unmatched";

  // 일자별 탭에서 보고 있는 주(월요일 ISO). 한 번에 한 주만 그리고, 좌우 화살표로 옮긴다.
  const [weekSel, setWeekSel] = useState(() => weekStart(todayISO()));
  const weekRef = useRef<HTMLDivElement>(null);
  const didInitWeek = useRef(false);

  const [overviewId, setOverviewId] = useState<number | null>(null);
  // 주요(자동) 활동을 클릭해 들어온 경우의 목표 단계 — 팝업을 개요 대신 그 단계 작업화면으로 연다.
  // null 이면 지금까지처럼 프로젝트 개요로 연다.
  const [stageTarget, setStageTarget] = useState<{ stage: number; vrfqId?: number } | null>(null);
  const { data: customers } = useCachedData("settings:customers", fetchCustomers);
  const { data: vessels } = useCachedData("settings:vessels", fetchSettingsVessels);
  // 그날 오간 메일 — 캘린더가 프로젝트 칸에 함께 놓는다. 실패해도 캘린더는 그대로 나와야
  // 하므로(메일 연동은 선택 기능이다) 오류를 삼키고 빈 목록으로 둔다.
  const { data: mailByDate } = useCachedData("mail:by-date", () =>
    fetchMailByDate().catch(() => null));

  function load() {
    fetchPipeline()
      .then(setData)
      .catch((e) => setErr(e instanceof Error ? e.message : "Error"));
  }
  useEffect(load, []);

  const steps = data?.steps ?? [];
  const today = todayISO();
  const targetDate = dateFilter === "today" ? today : dateFilter === "date" ? pickDate : "";

  // 필터 드롭다운 옵션 — 현재 데이터의 담당자/고객사/vendor 유니크 목록.
  const assigneeOptions = useMemo(
    () => Array.from(new Set((data?.rows ?? []).map((r) => r.assignee).filter(Boolean))).sort(),
    [data],
  );
  const custOptions = useMemo(
    () => Array.from(new Set((data?.rows ?? []).map((r) => r.customer).filter(Boolean))).sort(),
    [data],
  );
  const vendOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of data?.rows ?? []) for (const v of vendorNames(r)) s.add(v);
    return Array.from(s).sort();
  }, [data]);

  // 행(딜) 단위 필터 — 딜별/일자별 탭 공용. 각 필터는 멀티 선택(빈 배열=전체). OR 매칭.
  const rowPasses = useCallback((row: PipelineRow): boolean => {
    if (statusF.length && !statusF.includes(row.cancelled ? "closed" : "active")) return false;
    if (assigneeF.length && !assigneeF.includes(row.assignee || "")) return false;
    if (custF.length && !custF.includes(row.customer)) return false;
    if (vendF.length && !vendorNames(row).some((v) => vendF.includes(v))) return false;
    if (stageF.length && !stageF.includes(String(stageColOf(row.stage)))) return false;
    if (ageF.length) {
      const d = daysSinceISO(lastActivityISO(row));
      const ok = d != null && AGE_BUCKETS.some((b) => ageF.includes(b.value) && d >= b.min && d <= b.max);
      if (!ok) return false;
    }
    const text = `${row.project_no} ${row.project_title} ${row.customer} ${row.vendor} ${row.vrfq_vendors} ${row.vessel}`.toLowerCase();
    if (q.trim() && !text.includes(q.trim().toLowerCase())) return false;
    return true;
  }, [statusF, assigneeF, custF, vendF, stageF, ageF, q]);

  const buckets = useMemo(() => {
    const groups: { phase: number; rows: { row: PipelineRow; acts: Activity[] }[] }[] =
      PHASES.map((_, i) => ({ phase: i, rows: [] }));
    for (const row of data?.rows ?? []) {
      if (!rowPasses(row)) continue;
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
  }, [data, steps, rowPasses, targetDate]);

  const totalDeals = buckets.reduce((s, g) => s + g.rows.length, 0);

  // ── 일자별 탭 — 주간 캘린더(7열). 주(월요일 시작)가 한 행, 위=이전 주·아래=다음 주.
  //    각 날짜 셀에 프로젝트별로 활동을 묶어 나열한다. 필터는 딜별 탭과 공유. ──
  const weekView = useMemo(() => {
    // 필터를 통과한 활동을 평탄화(날짜 없는 건은 캘린더에서 제외).
    const flat: { row: PipelineRow; act: Activity }[] = [];
    const passing = new Map<number, PipelineRow>();
    for (const row of data?.rows ?? []) {
      if (!rowPasses(row)) continue;
      passing.set(row.rfq_id, row);
      let acts = buildActivities(row, steps);
      if (targetDate) acts = acts.filter((a) => a.date === targetDate);
      for (const act of acts) if (act.date) flat.push({ row, act });
    }
    // 주(월요일 ISO) → 날짜 → 프로젝트(rfq_id) 로 3단계 그룹화.
    type Cell = { row: PipelineRow; acts: Activity[]; mails: MailDateRow[] };
    const weeks = new Map<string, Map<string, Map<number, Cell>>>();
    const cellFor = (row: PipelineRow, date: string): Cell => {
      const ws = weekStart(date);
      if (!weeks.has(ws)) weeks.set(ws, new Map());
      const days = weeks.get(ws) as Map<string, Map<number, Cell>>;
      if (!days.has(date)) days.set(date, new Map());
      const projs = days.get(date) as Map<number, Cell>;
      if (!projs.has(row.rfq_id)) projs.set(row.rfq_id, { row, acts: [], mails: [] });
      return projs.get(row.rfq_id) as Cell;
    };
    for (const { row, act } of flat) cellFor(row, act.date).acts.push(act);
    // 그날 오간 메일도 같은 자리에 놓는다 — 단계 이벤트와 메일은 같은 하루의 두 면이고,
    // 메일만 오간 날에도 그 딜은 그날 움직인 것이다(그 경우 칸이 새로 생긴다).
    for (const m of mailByDate?.rows ?? []) {
      const row = passing.get(m.rfq_id);
      const date = (m.sent_at || "").slice(0, 10);
      if (!row || !date || (targetDate && date !== targetDate)) continue;
      cellFor(row, date).mails.push(m);
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
        for (const p of projects) {
          p.acts.sort((x, y) => actStageSort(x) - actStageSort(y));
          p.mails.sort((x, y) => x.sent_at.localeCompare(y.sent_at));
        }
        days.push({ date, projects });
      }
      return { start: ws, days };
    });
  }, [data, steps, rowPasses, targetDate, mailByDate]);

  const totalActs = weekView.reduce(
    (s, w) => s + w.days.reduce((ds, d) => ds + d.projects.reduce((ps, p) => ps + p.acts.length, 0), 0),
    0
  );

  // ── 보고 있는 주 ──────────────────────────────────────────────────────
  // weekView 에는 활동이 있는 주만 들어 있다. 빈 주로도 넘어갈 수 있어야 하므로
  // (그 주에 일이 없었다는 것도 정보다) 없는 주는 월~일 빈 7칸을 그 자리에서 만든다.
  const curDays: DayCell[] = useMemo(() => {
    const hit = weekView.find((w) => w.start === weekSel);
    if (hit) return hit.days;
    return Array.from({ length: 7 }, (_, i) => ({ date: addDays(weekSel, i), projects: [] }));
  }, [weekView, weekSel]);
  const weekActs = curDays.reduce((s, d) => s + d.projects.reduce((ps, p) => ps + p.acts.length + p.mails.length, 0), 0);
  // 활동이 있는 이전/다음 주 — 몇 주씩 비어 있는 구간을 한 번에 건너뛴다.
  const activeStarts = useMemo(() => weekView.map((w) => w.start), [weekView]);
  const prevActive = useMemo(() => {
    const before = activeStarts.filter((x) => x < weekSel);
    return before.length ? before[before.length - 1] : null;
  }, [activeStarts, weekSel]);
  const nextActive = useMemo(() => activeStarts.find((x) => x > weekSel) ?? null, [activeStarts, weekSel]);
  const thisWeek = weekStart(today);

  // 날짜 필터(Today / Pick date)를 걸면 그 날이 든 주로 따라간다.
  useEffect(() => { if (targetDate) setWeekSel(weekStart(targetDate)); }, [targetDate]);
  // 첫 조회 때 이번 주가 비어 있으면 활동이 있는 가장 가까운 지난 주를 연다 — 빈 주로
  // 시작하면 자료가 없는 화면처럼 보인다. 사용자가 옮기기 시작한 뒤에는 관여하지 않는다.
  useEffect(() => {
    if (didInitWeek.current || !weekView.length) return;
    didInitWeek.current = true;
    if (weekView.some((w) => w.start === weekSel)) return;
    const before = weekView.filter((w) => w.start < weekSel);
    setWeekSel((before.length ? before[before.length - 1] : weekView[0]).start);
  }, [weekView, weekSel]);
  // 한 번에 3일만 보이므로, 주를 옮길 때 어느 3일부터 보여줄지 정한다 — 이번 주면
  // 오늘이 오른쪽 끝(=최근 3일), 아니면 그 주에서 처음 일이 있었던 날부터.
  const focusIdx = useMemo(() => {
    const ti = curDays.findIndex((d) => d.date === today);
    if (ti >= 0) return Math.max(0, ti - 2);
    const fi = curDays.findIndex((d) => d.projects.length > 0);
    return fi < 0 ? 0 : fi;
  }, [curDays, today]);
  useEffect(() => {
    const el = weekRef.current;
    if (!el) return;
    el.scrollLeft = focusIdx > 0 ? (el.scrollWidth / 7) * focusIdx : 0;
  }, [weekSel, focusIdx, view]);

  // 매트릭스 행 = 프로젝트. 단계 버킷을 평탄화해 최근 활동순으로 정렬한다.
  const dealRows = useMemo(() => {
    const all = buckets.flatMap((g) => g.rows);
    return all.sort((a, b) => {
      const la = a.acts.length ? a.acts[a.acts.length - 1].date : "";
      const lb = b.acts.length ? b.acts[b.acts.length - 1].date : "";
      return la < lb ? 1 : la > lb ? -1 : 0;
    });
  }, [buckets]);

  // 프로젝트 번호/카드 클릭 → 개요. 목표 단계는 비운다.
  const openOverview = useCallback((rfqId: number) => {
    setStageTarget(null);
    setOverviewId(rfqId);
  }, []);

  // 자동 단계 이벤트(RFQ Sent·Quote Received·P/O Sent …) 클릭 → 그 단계 작업 팝업.
  // 2단계(RFQ Sent)는 발송 벤더별로 활동이 나뉘므로 그 벤더 RFQ 를 바로 선택해 연다.
  const openActivityStage = useCallback((rfqId: number, a: Activity) => {
    if (a.kind !== "auto") return;
    setStageTarget({ stage: a.stage, vrfqId: a.vrfqId });
    setOverviewId(rfqId);
  }, []);

  async function toggleStar(rfqId: number, a: Activity) {
    if (a.kind !== "note") return;
    try {
      await updateRfqStageNote(rfqId, a.stage, a.index, {
        text: a.note.text,
        datetime: a.note.datetime,
        party: a.note.party,
        person: a.note.person,
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
      person: patch.person,
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

  // 미분류 메일을 붙일 딜 목록 — 화면 필터와 무관하게 전부(닫힌 딜의 옛 메일도 배정한다).
  // 번호 내림차순이라 최근 딜이 위에 온다. 번호만으로는 어느 건인지 떠올리기 어려워
  // 업무 타입·고객·프로젝트명·선박을 함께 넘긴다(ProjectPicker 가 한 줄로 보여준다).
  const mailProjects = useMemo(
    () =>
      [...(data?.rows ?? [])]
        .sort(byProjectNo)
        .reverse()
        .map((r) => ({
          rfqId: r.rfq_id,
          no: r.project_no || r.kmaris_rfq_no || "",
          workType: r.work_type || "부품공급",
          customer: r.customer || "",
          title: r.project_title || "",
          vessel: vesselLabel(r),
        })),
    [data]
  );

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
    <div className="act-screen">
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
        {/* 메일 정리함 — 아직 딜에 자리 잡지 못한 메일을 여기서 배정하고, 등록되지
            않은 상대를 등록·붙이기·무시로 처리한다(탭 안의 함 줄로 갈린다). */}
        <button
          className={view === "mail" ? "on" : ""}
          onClick={() => setView("mail")}
        >
          Mail
        </button>
        <Link href="/project" className="page-navlink">
          Projects <span className="pn-arrow">→</span>
        </Link>
      </div>

      {view === "mail" ? null : (
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
          <DateFilter value={dateFilter} pickDate={pickDate} onValue={setDateFilter} onPick={setPickDate} />
          <FilterSelect label="Assignee" allLabel="All PICs"
            options={assigneeOptions.map((a) => ({ value: a, label: a }))} selected={assigneeF} onChange={setAssigneeF} />
          <FilterSelect label="Status" allLabel="Any status"
            options={STATUS_OPTIONS} selected={statusF} onChange={setStatusF} />
          <FilterSelect label="Stage" allLabel="All stages"
            options={STAGE_COLUMNS.map((c, i) => ({ value: String(i), label: c.label }))} selected={stageF} onChange={setStageF} />
          <FilterSelect label="Age" allLabel="Any age"
            options={AGE_BUCKETS.map((b) => ({ value: b.value, label: b.label }))} selected={ageF} onChange={setAgeF} />
          <FilterSelect label="Customer" allLabel="All customers"
            options={custOptions.map((c) => ({ value: c, label: c }))} selected={custF} onChange={setCustF} />
          <FilterSelect label="Vendor" allLabel="All vendors"
            options={vendOptions.map((v) => ({ value: v, label: v }))} selected={vendF} onChange={setVendF} />
          {/* Reset 는 항상 자리를 차지(visibility 토글)해 필터 버튼 위치가 흔들리지 않게 한다. */}
          <button className="btn sm act-reset"
            style={{ visibility: (assigneeF.length || stageF.length || ageF.length || custF.length || vendF.length || q ||
              dateFilter !== "all" || statusF.length !== 1 || statusF[0] !== "active") ? "visible" : "hidden" }}
            title="Clear all filters"
            onClick={() => { setAssigneeF([]); setStatusF(["active"]); setStageF([]); setAgeF([]); setCustF([]); setVendF([]); setQ(""); setDateFilter("all"); }}>
            Reset
          </button>
          {/* 프로젝트별 최근 활동 요약은 Dashboard 의 Briefing 탭으로 옮겼다 —
              같은 카드에 메일과 AI 요약까지 함께 놓여야 상황이 한 번에 읽힌다.
              여기 있던 팝업은 그 화면과 내용이 겹쳐 지웠고, 자리만 링크로 남긴다. */}
          <Link className="btn sm" href="/" title="Latest activity and mail per project">
            🗒 Briefing
          </Link>
          <button className="btn sm" onClick={() => window.print()}>Print</button>
        </div>
      </div>
      )}

      {view === "mail" ? (
        <UnmatchedMailPanel projects={mailProjects} initialQueue={mailQueue} />
      ) : null}

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
                  onStar={(a) => toggleStar(row.rfq_id, a)}
                  onDelete={(a) => removeNote(row.rfq_id, a)}
                  onSave={(a, patch) => saveNote(row.rfq_id, a, patch)}
                  onAdded={load}
                  onOverview={() => openOverview(row.rfq_id)}
                  onOpenStage={(a) => openActivityStage(row.rfq_id, a)}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : view === "date" ? (
        <>
          {totalActs === 0 ? <div className="state">No activity to show.</div> : null}
          {totalActs > 0 ? (
            <div className="act-cal">
              {/* 주 이동 — «/» 는 활동이 있는 이전/다음 주로 건너뛴다(빈 주가 몇 주씩
                  이어지는 자료에서 ‹/› 만으로는 한참 눌러야 한다). */}
              <div className="act-cal-nav">
                <button type="button" className="act-cal-nbtn" title="Jump to previous week with activity"
                  disabled={!prevActive} onClick={() => prevActive && setWeekSel(prevActive)}>«</button>
                <button type="button" className="act-cal-nbtn" title="Previous week"
                  onClick={() => setWeekSel(addDays(weekSel, -7))}>‹</button>
                <span className="act-cal-range">{weekRangeLabel(weekSel)}</span>
                <span className="act-cal-nsub">
                  {weekActs} {weekActs === 1 ? "entry" : "entries"}
                  {weekSel === thisWeek ? " · This week" : ""}
                </span>
                <button type="button" className="act-cal-nbtn" title="Next week"
                  onClick={() => setWeekSel(addDays(weekSel, 7))}>›</button>
                <button type="button" className="act-cal-nbtn" title="Jump to next week with activity"
                  disabled={!nextActive} onClick={() => nextActive && setWeekSel(nextActive)}>»</button>
                {weekSel !== thisWeek ? (
                  <button type="button" className="btn sm act-cal-thisweek"
                    onClick={() => setWeekSel(thisWeek)}>This week</button>
                ) : null}
                <span className="act-cal-hint">3 days shown · scroll sideways for the rest of the week</span>
              </div>
              <div className="act-cal-week" ref={weekRef}>
                {curDays.map((day, di) => (
                  <div
                    key={day.date}
                    className={`act-cal-day${day.date === today ? " today" : ""}${day.projects.length === 0 ? " empty" : ""}${di >= 5 ? " weekend" : ""}`}
                  >
                    <div className="act-cal-date">
                      <span className="act-cal-wdname">{WEEKDAYS[di]}</span>
                      {md(day.date)}
                    </div>
                    {day.projects.map((p) => (
                      <div
                        key={p.row.rfq_id}
                        className={`act-cal-proj${p.row.work_type === "서비스" ? " service" : ""}`}
                      >
                        <div className="act-cal-phead">
                          <button
                            type="button"
                            className="act-cal-pno"
                            onClick={() => openOverview(p.row.rfq_id)}
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
                              <ActivityDesc
                                act={a}
                                onOpen={a.kind === "auto" ? () => openActivityStage(p.row.rfq_id, a) : undefined}
                              />
                            </li>
                          ))}
                          {/* 그날 오간 메일 — 단계 이벤트 아래에 시각순으로. 이벤트가
                              굵은 라벨로 하루의 뼈대를 잡고, 메일은 그 사이에 무슨 말이
                              오갔는지를 채운다. 시각을 앞에 세워 순서가 읽히게 한다. */}
                          {p.mails.map((m) => (
                            <li key={`m${m.id}`} className={`act-cal-mail ${m.direction}`}>
                              <span className="act-cal-maildir">
                                {m.direction === "out" ? "→" : "←"}
                              </span>
                              {hm(m.sent_at) ? (
                                <span className="act-cal-mailwhen">{hm(m.sent_at)}</span>
                              ) : null}
                              {m.party ? (
                                <span className="act-cal-mailparty">{m.party}</span>
                              ) : null}
                              <span className="act-cal-mailsum">{m.summary}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      {overviewId != null && data?.rows.find((row) => row.rfq_id === overviewId) ? (
        <PipelineModal
          r={data.rows.find((row) => row.rfq_id === overviewId) as PipelineRow}
          steps={data.steps}
          customers={customers ?? []}
          vessels={vessels ?? []}
          onChanged={load}
          onClose={() => { setOverviewId(null); setStageTarget(null); }}
          onNavigate={navigateOverview}
          initialView={stageTarget ? "work" : "overview"}
          initialStage={stageTarget?.stage ?? null}
          initialVrfqId={stageTarget?.vrfqId ?? null}
        />
      ) : null}
    </div>
  );
}

// 주간 캘린더용 타입/헬퍼.
type DayCell = {
  date: string;
  projects: { row: PipelineRow; acts: Activity[]; mails: MailDateRow[] }[];
};
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// "2026-06-08" → "Jun 8 – 14, 2026" (달을 넘기면 "Jun 29 – Jul 5, 2026").
function weekRangeLabel(ws: string): string {
  const a = new Date(`${ws}T00:00`);
  const b = new Date(`${addDays(ws, 6)}T00:00`);
  const mon = (d: Date) => d.toLocaleString("en-US", { month: "short" });
  const tail = a.getMonth() === b.getMonth() ? `${b.getDate()}` : `${mon(b)} ${b.getDate()}`;
  return `${mon(a)} ${a.getDate()} – ${tail}, ${b.getFullYear()}`;
}
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
  onStar,
  onDelete,
  onSave,
  onAdded,
  onOverview,
  onOpenStage,
}: {
  row: PipelineRow;
  acts: Activity[];
  onStar: (a: Activity) => void;
  onDelete: (a: Activity) => void;
  onSave: (a: Activity, patch: NotePatch) => Promise<void>;
  onAdded: () => void;
  onOverview: () => void;
  onOpenStage: (a: Activity) => void;
}) {
  const { code, date } = splitProjectNo(row.project_no || row.kmaris_rfq_no || "—");
  const vend = vendorOf(row);
  // 활동로그 Party·Person 드롭다운 후보 — 이 딜의 고객사·벤더사(명)와 각 담당자.
  const parties = activityParties(row);
  const persons = activityPersons(row);
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
    // 프로젝트 한 줄(정보 칸 + 단계 칸들)을 하나로 묶는다. 넓은 화면에선 display:contents 로
    // 비워 칸이 그리드에 그대로 얹히고, 좁은 화면에선 이 상자가 ‘프로젝트 한 묶음’이 된다.
    <div className={`act-mx-row${isService ? " service" : ""}${row.cancelled ? " cancelled" : ""}`}>
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
        // data-stage / empty 는 좁은 화면용 — 거기선 열이 세로로 쌓여 상단 단계 머리줄이
        // 사라지므로 칸마다 제 단계 이름을 달고, 빈 단계는 아예 접는다.
        <div
          key={ci}
          className={`act-mx-cell ${STAGE_COLUMNS[ci].tone} ${isService ? "wt-service" : "wt-parts"}${cur ? (isService ? " cur-service" : " cur-parts") : ""}${cacts.length === 0 && ci !== addCol ? " empty" : ""}`}
          data-stage={STAGE_COLUMNS[ci].label}
        >
          {cacts.length > 0 ? (
            <ul className="act-list">
              {cacts.map((a, i) =>
                a.kind === "note" ? (
                  <NoteRow
                    key={i}
                    a={a}
                    onStar={() => onStar(a)}
                    onDelete={() => onDelete(a)}
                    onSave={(patch) => onSave(a, patch)}
                    parties={parties}
                    persons={persons}
                  />
                ) : (
                  <li key={i} className="act-item">
                    <span className="act-date">
                      {md(a.date)}
                      {a.kind === "auto" && hm(a.at || "") ? <span className="act-time">{hm(a.at || "")}</span> : null}
                    </span>
                    <span className="act-auto">
                      {/* 단계 이벤트 라벨은 그 단계 작업 팝업으로 가는 링크 — 로그에서 본 사건을
                          바로 편집 화면으로 잇는다(2단계는 해당 벤더 RFQ 를 바로 선택). */}
                      {a.kind === "auto" ? (
                        <button
                          type="button"
                          className="act-auto-label act-auto-link"
                          title={`Open stage ${a.stage} · ${a.label}`}
                          onClick={() => onOpenStage(a)}
                        >
                          {a.label}
                        </button>
                      ) : null}
                      {a.kind === "auto" && a.party ? <span className="act-meta"> · {a.party}</span> : null}
                    </span>
                  </li>
                ),
              )}
            </ul>
          ) : ci !== addCol ? (
            <span className="act-mx-empty">·</span>
          ) : null}
          {ci === addCol ? (
            <AddActivity rfqId={row.rfq_id} stage={row.stage} onAdded={onAdded} parties={parties} persons={persons} />
          ) : null}
        </div>
        );
      })}
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
    person: n.person || "",
    channel: n.channel || "",
    star: !!n.star,
    pic: n.pic || "",
  });
}

// 기존 활동 노트 1건 — 표시/인라인 수정 토글.
function NoteRow({
  a,
  onStar,
  onDelete,
  onSave,
  parties,
  persons,
}: {
  a: Extract<Activity, { kind: "note" }>;
  onStar: () => void;
  onDelete: () => void;
  onSave: (patch: NotePatch) => Promise<void>;
  parties: string[];
  persons: string[];
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
            partyPresets={parties}
            personPresets={persons}
          />
        </div>
      </li>
    );
  }

  return (
    <li className={`act-item${n.star ? " star" : ""}`}>
      <span className="act-date">
        {md(a.date)}
        {hm(n.datetime || n.at || "") ? <span className="act-time">{hm(n.datetime || n.at || "")}</span> : null}
      </span>
      <span className="act-text">
        {n.text}
        {(() => {
          const dl = n.direction === "in" ? "from" : n.direction === "out" ? "to" : "";
          const who = [dl, n.party].filter(Boolean).join(" ");
          const parts = [who, n.person, n.channel].filter(Boolean);
          // 상대·채널·담당자는 내용 아래 줄로 내린다.
          if (!parts.length && !n.pic) return null;
          return (
            <span className="act-metaline">
              {parts.length ? <span className="act-meta">{parts.join(" · ")}</span> : null}
              {n.pic ? <span className="act-note-pic">{n.pic}</span> : null}
            </span>
          );
        })()}
      </span>
      <span className="act-actions">
        <button className={`act-starbtn${n.star ? " on" : ""}`} title="Mark priority" onClick={onStar}>★</button>
        <button className="act-edit-btn" title="Edit" onClick={begin}>✎</button>
        <button className="act-del" title="Delete" onClick={onDelete}>×</button>
      </span>
    </li>
  );
}

function AddActivity({ rfqId, stage, onAdded, parties, persons }: { rfqId: number; stage: number; onAdded: () => void; parties: string[]; persons: string[] }) {
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
      partyPresets={parties}
      personPresets={persons}
    />
  );
}
