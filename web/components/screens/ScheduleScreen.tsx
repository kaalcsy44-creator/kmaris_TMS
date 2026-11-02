"use client";

/* Office › Schedule — 일정(회의·출장·납기 등) 전용 화면.
   목록·등록/수정 창·회의록/출장보고서 인쇄를 여기 모아 두고, Home 카드는 다가오는 일정만 요약한다. */

import { Fragment, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  fetchSchedule,
  fetchCustomers,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  type ScheduleSave,
} from "@/lib/api";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import { canEditDeal, getUser } from "@/lib/auth";
import type { ScheduleRow, ScheduleAgendaItem, CustomerOption, TripReport } from "@/lib/types";
import ComboBox from "@/components/common/ComboBox";
import { ViewModeProvider, useEditGate, useViewMode, type ViewMode } from "@/lib/viewMode";
import { confirmDiscard, useDirty } from "@/components/common/editHistory";
import FilterTable, { ColumnDef } from "@/components/common/FilterTable";
import CustomerName from "@/components/common/CustomerName";
import Modal from "@/components/common/Modal";
import {
  TRIP_TYPE, TRIP_TABS, type TripTab, initialTrip, cleanTrip, tripPeriod, tripReportHtml,
  tripTotal, tripReceipts, tripVisits,
  TripActionsTable, TripItineraryTab, TripExpensesTab, TripMemosTab,
} from "@/components/screens/TripReport";

const today = () => new Date().toISOString().slice(0, 10);

/** 오늘에서 n일 뒤 'YYYY-MM-DD'. */
function daysFromToday(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 일정 목록 칸 — Schedule 화면과 Home 카드가 같이 쓴다. 출장은 시간 대신 기간(끝 날)을 보여 준다. */
export function scheduleColumns(compact = false): ColumnDef<ScheduleRow>[] {
  const cols: ColumnDef<ScheduleRow>[] = [
    { key: "date", label: "Date", text: (r) => r.date || "", filter: "date" },
    { key: "time", label: "Time", text: (r) => (r.event_type === TRIP_TYPE && r.trip?.date_end ? tripPeriod(r.date, r.trip.date_end) : scheduleTime(r)) },
    { key: "title", label: "Title", text: (r) => r.title || "" },
    { key: "event_type", label: "Type", text: (r) => r.event_type || "", filter: "facet" },
    {
      key: "status", label: "Status", text: (r) => SCHEDULE_STATUS_LABEL[r.status] || "Planned", filter: "facet",
      render: (r) => <span className={`sched-badge ${r.status || "planned"}`}>{SCHEDULE_STATUS_LABEL[r.status] || "Planned"}</span>,
    },
    { key: "customer", label: "Customer", text: (r) => r.customer || "", filter: "facet", render: (r) => (r.customer ? <CustomerName name={r.customer} /> : <>—</>) },
    { key: "location", label: "Location", text: (r) => r.location || "" },
    { key: "attendees", label: "Attendees", text: (r) => r.attendees || "" },
    // 진행 후에는 결과가, 그 전에는 안건이 이 일정을 한 줄로 말해 준다.
    { key: "notes", label: "Notes", text: (r) => (r.status === "done" ? r.outcome || r.minutes : "") || r.notes || "" },
    { key: "pic", label: "PIC", text: (r) => r.owner || "", filter: "facet" },
  ];
  return compact ? cols.filter((c) => ["date", "time", "title", "event_type", "status", "customer", "pic"].includes(c.key)) : cols;
}

/** Home 카드에 올릴 일정 — 앞으로 7일 안의 예정 + 날짜가 지났는데 결과를 아직 안 적은 예정. */
export function upcomingSchedule(rows: ScheduleRow[]): ScheduleRow[] {
  const until = daysFromToday(7);
  return rows.filter((r) => (r.status || "planned") === "planned" && (r.date || "") <= until);
}

/** 등록(row 없음)·열람/수정(row 있음) 창 — 저장 안 한 변경이 있으면 닫기 전에 묻는다. */
export function ScheduleModal({
  row, rows, customers, onClose, onSaved,
}: {
  row?: ScheduleRow;
  rows: ScheduleRow[];
  customers: CustomerOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const dirty = useRef(false);
  return (
    // form 레이아웃 — 본문이 세로로 스크롤되고 Save 바가 바닥에 붙는다(넓은 폭은 maxWidth 로).
    <Modal title={row ? "Schedule" : "Add schedule"} onClose={() => { if (confirmDiscard(dirty.current)) onClose(); }} form maxWidth={1120}>
      <ScheduleForm
        row={row}
        history={rows}
        customers={customers}
        canEdit={row ? canEditDeal(row.owner_id) : true}
        dirtyRef={dirty}
        onSaved={onSaved}
        onDeleted={() => {
          dirty.current = false;
          onClose();
          onSaved();
        }}
      />
    </Modal>
  );
}

type View = "upcoming" | "past" | "all";
const VIEWS: { id: View; label: string }[] = [
  { id: "upcoming", label: "Upcoming" },
  { id: "past", label: "Past" },
  { id: "all", label: "All" },
];

export default function ScheduleScreen() {
  const { data: schedule, refresh } = useCachedData("home:schedule", fetchSchedule);
  const { data: customers } = useCachedData("settings:customers", fetchCustomers);
  const rows = useMemo(() => schedule?.rows ?? [], [schedule]);
  const [view, setView] = useState<View>("upcoming");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ScheduleRow | null>(null);

  // Upcoming = 오늘 이후 + 날짜가 지났는데 아직 '예정'인 것(결과를 적을 차례). Past = 나머지 지난 일정.
  const t = today();
  const shown = rows.filter((r) => {
    const open = (r.status || "planned") === "planned";
    if (view === "upcoming") return (r.date || "") >= t || open;
    if (view === "past") return (r.date || "") < t && !open;
    return true;
  });
  const counts = {
    upcoming: rows.filter((r) => (r.date || "") >= t || (r.status || "planned") === "planned").length,
    past: rows.filter((r) => (r.date || "") < t && (r.status || "planned") !== "planned").length,
    all: rows.length,
  };

  return (
    <div className="sched-page">
      <div className="sched-page-bar">
        <span className="pl-view-toggle" role="group" aria-label="Schedule view">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" className={view === v.id ? "on" : ""} aria-pressed={view === v.id} onClick={() => setView(v.id)}>
              {v.label} <small>{counts[v.id]}</small>
            </button>
          ))}
        </span>
      </div>
      {!schedule ? (
        <div className="state">Loading…</div>
      ) : (
        <FilterTable
          // 보기마다 정렬 기본값이 달라 — 앞으로는 가까운 순, 지난 것은 최근 순.
          key={view}
          tableId="schedule-list"
          rows={shown}
          columns={scheduleColumns()}
          getRowKey={(r) => r.id}
          defaultSortKey="date"
          defaultSortDir={view === "upcoming" ? "asc" : "desc"}
          onRowClick={(r) => setEditing(r)}
          empty={view === "upcoming" ? "Nothing coming up. Click + Add schedule to create one." : "No schedule."}
          actions={
            <button className="btn primary" onClick={() => setAdding(true)}>
              + Add schedule
            </button>
          }
        />
      )}
      {adding || editing ? (
        <ScheduleModal
          row={editing ?? undefined}
          rows={rows}
          customers={customers ?? []}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onSaved={refresh}
        />
      ) : null}
    </div>
  );
}

/** Home 카드 머리의 '전체 보기' 링크. */
export function ScheduleOpenLink() {
  return (
    <Link href="/schedule" className="btn">
      Open Schedule →
    </Link>
  );
}

/* 일정 등록/수정 폼 — Schedule 화면·Home 카드가 여는 창의 본문.
   왼쪽은 예정(언제·어디서·누구와·무엇을), 오른쪽은 진행 후 기록(상태·회의 내용·결과).
   같은 일정을 두 번 연다 — 잡을 때 왼쪽을, 다녀와서 오른쪽을 채운다. */
const SCHEDULE_TYPES = ["Meeting", "Business trip", "Delivery", "Deadline", "Other"];
const SCHEDULE_STATUS: { value: string; label: string }[] = [
  { value: "planned", label: "Planned" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];
const SCHEDULE_STATUS_LABEL: Record<string, string> = Object.fromEntries(
  SCHEDULE_STATUS.map((o) => [o.value, o.label])
);

/** 일정의 시간 한 줄 — '14:00–15:30', 끝 시간이 없으면 시작만. */
function scheduleTime(r: { time_start?: string; time_end?: string }): string {
  if (!r.time_start) return "";
  return r.time_end ? `${r.time_start}–${r.time_end}` : r.time_start;
}

/** 참석자 칸 값 → 이름 목록. 지금은 한 줄에 한 명이지만 예전 값은 쉼표로 이어져 있다. */
function splitPeople(s: string | undefined): string[] {
  return (s || "").split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
}

/** 안건 목록이 없던 예전 일정 — 평문 안건(notes)을 줄마다 한 항목으로, 앞 번호는 떼고. */
function initialAgenda(row?: ScheduleRow): ScheduleAgendaItem[] {
  if (row?.agenda?.length) return row.agenda.map((a) => ({ text: a.text, result: a.result }));
  const lines = (row?.notes || "")
    .split("\n")
    .map((l) => l.replace(/^\s*\d+\s*[.)]\s*/, "").trim())
    .filter(Boolean);
  return lines.length ? lines.map((text) => ({ text, result: "" })) : [{ text: "", result: "" }];
}

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * 회의록 한 장(A4 세로) — 미리보기(iframe)와 인쇄가 같은 문서를 쓴다.
 * 화면 CSS 와 섞이지 않게 스타일을 문서 안에 통째로 담는다(인쇄는 이 문서만 찍는다).
 */
function scheduleMinutesHtml(d: {
  data: ScheduleSave;
  customer: string;
  owner: string;
}): string {
  const s = d.data;
  const v = (x: string | undefined) => (x && x.trim() ? escHtml(x.trim()) : "—");
  const when = [s.date, scheduleTime({ time_start: s.time_start, time_end: s.time_end })].filter(Boolean).join(" · ");
  const people = splitPeople(s.attendees);
  const items = s.agenda ?? [];
  // 개요는 2열(항목 두 쌍씩 한 줄) — 짧은 값이 한 줄을 통째로 먹지 않게. 참석자만 한 줄을 다 쓴다.
  const cellPair = (k: string, val: string) => `<th>${k}</th><td>${val}</td>`;
  const infoRows = [
    cellPair("Date / time", v(when)) + cellPair("Type", v(s.event_type)),
    cellPair("Location", v(s.location)) + cellPair("Customer", v(d.customer)),
    cellPair("Status", escHtml(SCHEDULE_STATUS_LABEL[s.status || "planned"] || "Planned")) + cellPair("Prepared by", v(d.owner)),
    `<th>Attendees</th><td colspan="3">${people.length ? people.map(escHtml).join(", ") : "—"}</td>`,
  ];
  const agendaRows = items.length
    ? items.map((a, i) => `<tr><td class="no">${i + 1}</td><td>${v(a.text)}</td><td>${v(a.result)}</td></tr>`).join("")
    : `<tr><td class="no">—</td><td colspan="2" class="muted">No agenda items</td></tr>`;
  const block = (title: string, body: string | undefined) =>
    body && body.trim() ? `<h2>${title}</h2><div class="box">${escHtml(body.trim())}</div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${v(s.title)} — minutes</title>
<style>
  @page { size: A4; margin: 14mm 14mm 16mm; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; padding: 18px 22px; font: 12px/1.5 "Pretendard", "Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif; color: #111827; background: #fff; }
  @media print { body { padding: 0; } }
  .brand { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #0b1f3a; padding-bottom: 6px; }
  .brand b { font-size: 13px; letter-spacing: .06em; color: #0b1f3a; }
  .brand span { font-size: 11px; color: #6b7280; }
  h1 { font-size: 19px; margin: 12px 0 10px; color: #0b1f3a; }
  h2 { font-size: 12.5px; margin: 16px 0 6px; color: #0b1f3a; text-transform: uppercase; letter-spacing: .04em; }
  table { width: 100%; border-collapse: collapse; }
  .info { table-layout: fixed; }
  .info th { width: 92px; text-align: left; font-weight: 700; color: #374151; background: #f3f6fa; }
  th, td { border: 1px solid #d5dde8; padding: 5px 8px; vertical-align: top; white-space: pre-wrap; word-break: break-word; }
  /* 머리글은 옅은 바탕 + 진한 글씨 — 브라우저가 배경을 빼고 찍어도 글씨가 남는다. */
  .agenda thead th { background: #e8eef6; color: #0b1f3a; text-align: left; font-weight: 700; border-bottom: 2px solid #0b1f3a; }
  .agenda td.no, .agenda th.no { width: 42px; text-align: center; white-space: nowrap; }
  .agenda td:nth-child(2) { width: 42%; }
  tr { break-inside: avoid; }
  .box { border: 1px solid #d5dde8; border-radius: 4px; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; break-inside: avoid; }
  .muted { color: #9ca3af; }
  .sign { margin-top: 28px; display: flex; gap: 24px; justify-content: flex-end; font-size: 11px; color: #6b7280; }
  .sign div { width: 150px; border-top: 1px solid #9ca3af; padding-top: 4px; text-align: center; }
</style></head><body>
  <div class="brand"><b>K-MARIS</b><span>${v(when)}</span></div>
  <h1>${v(s.title)}</h1>
  <table class="info">${infoRows.map((r) => `<tr>${r}</tr>`).join("")}</table>
  <h2>Agenda &amp; results</h2>
  <table class="agenda"><thead><tr><th class="no">No.</th><th>Agenda</th><th>Result</th></tr></thead><tbody>${agendaRows}</tbody></table>
  ${block("Outcome / next actions", s.outcome)}
  ${block("Other notes", s.minutes)}
  <div class="sign"><div>Prepared by</div><div>Reviewed by</div></div>
</body></html>`;
}

type ScheduleFormProps = {
  row?: ScheduleRow;
  /** 전체 일정 — 예전에 적은 참석자를 참석자 칸의 드롭다운 후보로 쓴다. */
  history: ScheduleRow[];
  customers: CustomerOption[];
  canEdit: boolean;
  /** 저장 안 한 변경이 있는지를 창(부모)에 알려 둔다 — 닫기 전에 물어보는 데 쓴다. */
  dirtyRef: React.MutableRefObject<boolean>;
  /** 저장 뒤 — 목록만 새로 받는다(창은 그대로 둔다). */
  onSaved: () => void;
  /** 삭제 뒤 — 창을 닫고 목록을 새로 받는다. */
  onDeleted: () => void;
};

/** 읽기/편집 — 프로젝트 단계 화면과 같은 규약(같은 DOM, 껍데기만 바꿈).
 *  저장된 일정은 읽기로, 새 일정은 편집으로 연다. */
export function ScheduleForm(props: ScheduleFormProps) {
  const [mode, setMode] = useState<ViewMode>(props.row ? "read" : "edit");
  return (
    <ViewModeProvider mode={mode} setMode={setMode}>
      <ScheduleEditor {...props} />
    </ViewModeProvider>
  );
}

function ScheduleEditor({ row, history, customers, canEdit, dirtyRef, onSaved, onDeleted }: ScheduleFormProps) {
  const { mode, setMode } = useViewMode();
  const gate = useEditGate(canEdit);
  // 처음 저장한 새 일정의 id — 그 뒤 저장은 같은 일정을 고친다(창이 닫히지 않으므로).
  const [savedId, setSavedId] = useState<number | null>(row?.id ?? null);
  const [date, setDate] = useState(row?.date || today());
  const [timeStart, setTimeStart] = useState(row?.time_start ?? "");
  const [timeEnd, setTimeEnd] = useState(row?.time_end ?? "");
  const [title, setTitle] = useState(row?.title ?? "");
  const [eventType, setEventType] = useState(row?.event_type || "Meeting");
  const [customerId, setCustomerId] = useState<number | "">(row?.customer_id ?? "");
  const [location, setLocation] = useState(row?.location ?? "");
  // 한 칸에 한 명 — 마지막 칸은 늘 비워 두지 않고 '+ Add {isTrip ? "traveler" : "attendee"}' 로 늘린다.
  const [people, setPeople] = useState<string[]>(() => {
    const p = splitPeople(row?.attendees);
    return p.length ? p : [""];
  });
  const [agenda, setAgenda] = useState<ScheduleAgendaItem[]>(() => initialAgenda(row));
  const [status, setStatus] = useState(row?.status || "planned");
  const [minutes, setMinutes] = useState(row?.minutes ?? "");
  const [outcome, setOutcome] = useState(row?.outcome ?? "");
  // 출장(Business trip) 보고서 — 유형이 출장일 때만 탭으로 보이고 저장된다.
  const [trip, setTrip] = useState<TripReport>(() =>
    initialTrip(row?.trip, { author: row?.owner || getUser()?.username || "", date: row?.date || today() })
  );
  const [tripTab, setTripTab] = useState<TripTab>("report");
  const isTrip = eventType === TRIP_TYPE;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const valid = title.trim() !== "" && date.trim() !== "";
  // 날짜가 지났는데 아직 '예정'이면 결과를 적을 차례라고 알려 준다.
  const due = status === "planned" && !!savedId && date < today();

  // 예전 일정들에 적힌 참석자 — 자주 만난 사람부터.
  const peopleHistory = useMemo(() => {
    const count = new Map<string, number>();
    for (const r of history) for (const p of splitPeople(r.attendees)) count.set(p, (count.get(p) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([p]) => p);
  }, [history]);

  /** 회의 내용·결과를 적기 시작하면 '예정'은 '진행 완료'로 넘어간다(취소는 그대로 둔다). */
  function writeResult(set: (v: string) => void, v: string) {
    set(v);
    if (v.trim() && status === "planned") setStatus("done");
  }

  function setAgendaAt(i: number, patch: Partial<ScheduleAgendaItem>) {
    setAgenda((list) => list.map((a, j) => (j === i ? { ...a, ...patch } : a)));
    if (patch.result?.trim() && status === "planned") setStatus("done");
  }

  function body(): ScheduleSave {
    const items = agenda
      .map((a) => ({ text: a.text.trim(), result: a.result.trim() }))
      .filter((a) => a.text || a.result);
    const names = [...new Set(people.map((p) => p.trim()).filter(Boolean))];
    return {
      date,
      time_start: timeStart,
      time_end: timeEnd,
      title: title.trim(),
      event_type: eventType,
      // 목록의 Notes 열·예전 화면이 읽는 평문 안건 — 번호를 붙여 한 줄씩.
      notes: items.filter((a) => a.text).map((a, i) => `${i + 1}. ${a.text}`).join("\n"),
      agenda: items,
      customer_id: customerId === "" ? null : customerId,
      location: location.trim(),
      attendees: names.join("\n"),
      status,
      minutes,
      outcome,
      trip: isTrip ? cleanTrip(trip) : undefined,
    };
  }

  // 저장본과 지금 입력이 다른가 — Save 옆 점(•)과 닫기 확인에 쓴다. 기준은 처음 연 값.
  const { dirty, markClean } = useDirty(body(), "loaded");
  dirtyRef.current = dirty;

  async function save() {
    if (!valid) {
      setErr("날짜와 제목을 입력하세요.");
      return;
    }
    if (isTrip && trip.date_end && trip.date_end < date) {
      setErr("출장 종료일이 시작일보다 빠릅니다.");
      return;
    }
    if (timeStart && timeEnd && timeEnd < timeStart) {
      setErr("끝 시간이 시작 시간보다 빠릅니다.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      if (savedId) await updateSchedule(savedId, body());
      else setSavedId((await createSchedule(body())).id);
      invalidateCache("dashboard");
      // 창은 닫지 않는다 — 기준값을 지금 내용으로 옮겨 Save 옆 점만 지운다.
      markClean();
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!savedId) return;
    if (!confirm("Delete this schedule?")) return;
    setBusy(true);
    setErr("");
    try {
      await deleteSchedule(savedId);
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  // 미리보기 — 같은 창 안에서 폼 대신 회의록 문서를 보여 준다(저장 전 입력값 그대로).
  const [preview, setPreview] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const customerName = customers.find((c) => c.id === customerId)?.name ?? row?.customer ?? "";
  // 출장은 엑셀 양식과 같은 출장결과보고서(네 장), 나머지는 회의록 한 장.
  const minutesHtml = !preview
    ? ""
    : isTrip
      ? tripReportHtml({
          title: title.trim(),
          date,
          region: location.trim(),
          travelers: [...new Set(people.map((p) => p.trim()).filter(Boolean))],
          customer: customerName,
          results: body().agenda ?? [],
          opinion: outcome,
          trip,
        })
      : scheduleMinutesHtml({ data: body(), customer: customerName, owner: row?.owner || getUser()?.username || "" });

  if (preview) {
    return (
      <div>
        <iframe ref={frameRef} className="sched-minutes" title="Meeting minutes preview" srcDoc={minutesHtml} />
        <div className="form-actions">
          <button type="button" className="btn" onClick={() => setPreview(false)}>← Back</button>
          <button type="button" className="btn primary" onClick={() => frameRef.current?.contentWindow?.print()}>
            🖨 Print
          </button>
        </div>
      </div>
    );
  }

  // 일반 일정과 출장 보고서가 같이 쓰는 칸들.
  const dateField = (
    <label className="form-field sched-date">
      <span>{isTrip ? "Start date" : "Date"}</span>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
    </label>
  );
  const typeField = (
    <label className="form-field sched-type">
      <span>Type</span>
      <select value={eventType} onChange={(e) => setEventType(e.target.value)}>
        {SCHEDULE_TYPES.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
    </label>
  );
  // 한 줄: 제목 · 고객사
  const titleRow = (
    <div className="sched-row">
      <label className="form-field">
        <span>Title</span>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="form-field">
        <span>Customer (optional)</span>
        <select
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value ? Number(e.target.value) : "")}
        >
          <option value="">—</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </label>
    </div>
  );
  /* 참석자 — 한 칸에 한 명. 예전 일정에 적은 이름이 드롭다운 후보로 뜨고,
     처음 만나는 사람은 그냥 적으면 된다(앱 공용 ComboBox = 고르기 + 직접 입력).
     다른 칸에서 이미 고른 이름은 후보에서 뺀다. */
  const peopleField = (
    <div className="form-field">
      <span>{isTrip ? "Travelers" : "Attendees"}</span>
      <div className="sched-people">
        {people.map((p, i) => (
          <span key={i} className="sched-person">
            <ComboBox
              value={p}
              options={peopleHistory.filter((h) => h === p || !people.includes(h))}
              placeholder={peopleHistory.length ? "Pick or type a name" : "Type a name"}
              onChange={(v) => setPeople((list) => list.map((x, j) => (j === i ? v : x)))}
            />
            {people.length > 1 ? (
              <button
                type="button"
                className="btn tiny sched-x"
                aria-label={`Remove attendee ${i + 1}`}
                onClick={() => setPeople((list) => list.filter((_, j) => j !== i))}
              >
                ×
              </button>
            ) : null}
          </span>
        ))}
        <button type="button" className="btn tiny sched-add" onClick={() => setPeople((list) => [...list, ""])}>
          + Add {isTrip ? "traveler" : "attendee"}
        </button>
      </div>
    </div>
  );
  const statusField = (
    <div className="form-field">
      <span>Status</span>
      <span className="pl-view-toggle sched-status" role="group" aria-label="Status">
        {SCHEDULE_STATUS.map((o) => (
          <button
            key={o.value}
            type="button"
            className={status === o.value ? "on" : ""}
            aria-pressed={status === o.value}
            onClick={() => setStatus(o.value)}
          >
            {o.label}
          </button>
        ))}
      </span>
      {due ? <span className="hint-inline">This date has passed — record how it went below.</span> : null}
    </div>
  );

  /* 2단 격자 — 왼쪽 칸은 예정(Plan), 오른쪽 칸은 진행 후 기록(Result).
     안건은 줄마다 왼쪽에 안건, 같은 줄 오른쪽에 그 안건의 결과가 선다. */
  const planBody = (
    <div className="sched-form">
      <h4 className="sched-col-title sched-l">Plan</h4>
      <h4 className="sched-col-title sched-r">Result</h4>

      <section className="sched-l sched-stack">
        {/* 한 줄: 날짜 · 시간(시작~끝) · 유형 */}
        <div className="sched-when">
          {dateField}
          <div className="form-field sched-time-field">
            <span>Time (optional)</span>
            {/* div 로 둔다 — .form-field > span 은 라벨 규칙(block)을 받아 두 칸이 세로로 쌓인다. */}
            <div className="sched-time">
              <input type="time" value={timeStart} aria-label="Start time" onChange={(e) => setTimeStart(e.target.value)} />
              <i className="sched-tilde">~</i>
              <input type="time" value={timeEnd} aria-label="End time" onChange={(e) => setTimeEnd(e.target.value)} />
            </div>
          </div>
          {typeField}
        </div>
        {titleRow}
        <label className="form-field">
          <span>Location</span>
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="e.g. Seoul office · Busan port · Zoom"
          />
        </label>
        {peopleField}
      </section>

      <section className="sched-r sched-stack">
        {statusField}
        <label className="form-field">
          <span>Outcome / next actions</span>
          <textarea
            rows={6}
            value={outcome}
            onChange={(e) => writeResult(setOutcome, e.target.value)}
            placeholder="Overall conclusion, follow-ups, who does what by when"
          />
        </label>
      </section>

      <div className="sched-l sched-sub">Agenda</div>
      <div className="sched-r sched-sub">Result per agenda item</div>
      {agenda.map((a, i) => (
        <Fragment key={i}>
          <div className="sched-l sched-item">
            <span className="sched-no">{i + 1}.</span>
            <textarea
              rows={1}
              value={a.text}
              aria-label={`Agenda item ${i + 1}`}
              placeholder="What to discuss"
              onChange={(e) => setAgendaAt(i, { text: e.target.value })}
            />
            <button
              type="button"
              className="btn tiny sched-x"
              aria-label={`Remove agenda item ${i + 1}`}
              disabled={agenda.length === 1 && !a.text && !a.result}
              onClick={() =>
                setAgenda((list) => (list.length > 1 ? list.filter((_, j) => j !== i) : [{ text: "", result: "" }]))
              }
            >
              ×
            </button>
          </div>
          <div className="sched-r sched-item">
            <span className="sched-no">{i + 1}.</span>
            <textarea
              rows={1}
              value={a.result}
              aria-label={`Result of agenda item ${i + 1}`}
              placeholder={a.text ? `Result — ${a.text.split("\n")[0].slice(0, 40)}` : "Result of this item"}
              onChange={(e) => setAgendaAt(i, { result: e.target.value })}
            />
          </div>
        </Fragment>
      ))}
      <div className="sched-l">
        <button
          type="button"
          className="btn tiny sched-add"
          onClick={() => setAgenda((list) => [...list, { text: "", result: "" }])}
        >
          + Add agenda item
        </button>
      </div>
      <div className="sched-r" />

      <label className="form-field sched-r sched-other">
        <span>Other notes (outside the agenda)</span>
        <textarea
          rows={4}
          value={minutes}
          onChange={(e) => writeResult(setMinutes, e.target.value)}
          placeholder="Anything discussed that was not on the agenda"
        />
      </label>
    </div>
  );

  const tripField = (key: keyof TripReport, label: string, ph = "", type = "text") => (
    <label className="form-field">
      <span>{label}</span>
      <input
        type={type}
        value={String(trip[key] ?? "")}
        placeholder={ph}
        onChange={(e) => setTrip({ ...trip, [key]: e.target.value })}
      />
    </label>
  );
  // 탭 옆 숫자 — 시트마다 적은 줄 수(빈 줄 제외).
  const tripClean = isTrip ? cleanTrip(trip) : null;
  const tripCounts = {
    itinerary: tripClean?.itinerary.length ?? 0,
    expenses: tripClean?.expenses.length ?? 0,
    memos: tripClean?.memos.length ?? 0,
  };
  /* 출장 — 엑셀 '출장결과보고서'와 같은 네 장을 탭으로. 결과보고서 탭은 01 개요 ~ 05 경비 요약 순서.
     주요 결과(02)는 안건 칸(제목=text, 내용=result)을, 종합 의견(04)은 outcome 칸을 그대로 쓴다. */
  const tripBody =
    tripTab === "itinerary" ? (
      <TripItineraryTab trip={trip} setTrip={setTrip} />
    ) : tripTab === "expenses" ? (
      <TripExpensesTab trip={trip} setTrip={setTrip} />
    ) : tripTab === "memos" ? (
      <TripMemosTab trip={trip} setTrip={setTrip} />
    ) : (
      <div className="sched-form">
        <h4 className="sched-col-title sched-l">01 Overview</h4>
        <h4 className="sched-col-title sched-r">02 Key results</h4>

        <section className="sched-l sched-stack">
          <div className="sched-when">
            {dateField}
            <label className="form-field sched-date">
              <span>End date</span>
              <input type="date" value={trip.date_end} min={date} onChange={(e) => setTrip({ ...trip, date_end: e.target.value })} />
            </label>
            {typeField}
          </div>
          {titleRow}
          <div className="sched-row">
            <label className="form-field">
              <span>Region</span>
              <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Busan" />
            </label>
            {statusField}
          </div>
          <label className="form-field">
            <span>Purpose</span>
            <textarea rows={2} value={trip.purpose} onChange={(e) => setTrip({ ...trip, purpose: e.target.value })} />
          </label>
          <label className="form-field">
            <span>Visits / met with</span>
            <textarea rows={2} value={trip.visits} onChange={(e) => setTrip({ ...trip, visits: e.target.value })} />
          </label>
          {peopleField}
          <div className="trip-quad">
            {tripField("report_date", "Report date", "", "date")}
            {tripField("author", "Author")}
            {tripField("position", "Dept / title")}
            {tripField("report_to", "Report to", "e.g. Team")}
          </div>
        </section>

        <section className="sched-r sched-stack">
          {agenda.map((a, i) => (
            <div key={i} className="trip-result">
              <div className="sched-item">
                <span className="sched-no">{i + 1}.</span>
                <input
                  type="text"
                  value={a.text}
                  aria-label={`Result heading ${i + 1}`}
                  placeholder="Heading — e.g. New partners & supply chain"
                  onChange={(e) => setAgendaAt(i, { text: e.target.value })}
                />
                <button
                  type="button"
                  className="btn tiny sched-x"
                  aria-label={`Remove result ${i + 1}`}
                  disabled={agenda.length === 1 && !a.text && !a.result}
                  onClick={() =>
                    setAgenda((list) => (list.length > 1 ? list.filter((_, j) => j !== i) : [{ text: "", result: "" }]))
                  }
                >
                  ×
                </button>
              </div>
              <div className="sched-item trip-result-body">
                <textarea
                  rows={1}
                  value={a.result}
                  aria-label={`Result detail ${i + 1}`}
                  placeholder="Details"
                  onChange={(e) => setAgendaAt(i, { result: e.target.value })}
                />
              </div>
            </div>
          ))}
          <button
            type="button"
            className="btn tiny sched-add trip-add-left"
            onClick={() => setAgenda((list) => [...list, { text: "", result: "" }])}
          >
            + Add result
          </button>
        </section>

        <div className="sched-sub trip-full">03 Follow-up actions</div>
        <div className="trip-full">
          <TripActionsTable trip={trip} setTrip={setTrip} />
        </div>

        <div className="sched-l sched-sub">04 Overall opinion / requests</div>
        <div className="sched-r sched-sub">05 Expense summary</div>
        <label className="form-field sched-l">
          <textarea
            rows={5}
            aria-label="Overall opinion"
            value={outcome}
            onChange={(e) => writeResult(setOutcome, e.target.value)}
            placeholder="Overall assessment of the trip and any requests to the company"
          />
        </label>
        <section className="sched-r sched-stack">
          <div className="trip-sum">
            <div><span>Total (KRW)</span><b>{tripTotal(trip).toLocaleString("ko-KR")}</b></div>
            <div><span>Receipts</span><b>{tripReceipts(trip)}</b></div>
            <div><span>Visits</span><b>{tripVisits(trip)}</b></div>
          </div>
          {tripField("attachments", "Attachments", "Business cards, receipts, etc.")}
          <div className="sched-row">
            {tripField("reviewer", "Reviewed by")}
            {tripField("approver", "Approved by")}
          </div>
        </section>
      </div>
    );

  return (
    <div>
      {/* 읽기 ↔ 편집 — 단계 화면과 같은 토글. 저장된 일정에만(새 일정은 쓰는 중이라 편집뿐). */}
      {savedId && canEdit ? (
        <div className="sched-modebar">
          <div className="stage-mode-toggle" role="group" aria-label="View mode">
            <button
              type="button"
              className={mode === "read" ? "on" : ""}
              aria-pressed={mode === "read"}
              onClick={() => setMode("read")}
              title="Read — see what was entered, without editing"
            >
              <span aria-hidden>👁 </span>Read
            </button>
            <button
              type="button"
              className={mode === "edit" ? "on" : ""}
              aria-pressed={mode === "edit"}
              onClick={() => setMode("edit")}
              title="Edit — change and save this schedule"
            >
              <span aria-hidden>✎ </span>Edit
            </button>
          </div>
          {dirty ? <span className="hint-inline">Unsaved changes</span> : null}
        </div>
      ) : null}
      {/* 출장 — 엑셀 시트처럼 네 장을 탭으로 넘긴다. 읽기모드에서도 넘길 수 있게 fieldset 밖에 둔다. */}
      {isTrip ? (
        <div className="trip-tabs" role="tablist" aria-label="Trip report sheets">
          {TRIP_TABS.map((t) => {
            const n = t.id === "report" ? 0 : tripCounts[t.id];
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tripTab === t.id}
                className={tripTab === t.id ? "on" : ""}
                onClick={() => setTripTab(t.id)}
              >
                {t.label}
                {n ? <i>{n}</i> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <fieldset {...gate.fieldsetProps}>
        {isTrip ? tripBody : planBody}
      </fieldset>
      <div className="form-actions">
        {/* 작성자가 아니어도(읽기 전용) 회의록은 보고 인쇄할 수 있다. */}
        <button type="button" className="btn" disabled={busy} onClick={() => setPreview(true)}
                title={isTrip ? "Preview and print as a business trip report (4 sheets)" : "Preview and print as meeting minutes"}>
          📄 Preview / Print
        </button>
        {/* 저장 뒤 고친 것이 있으면 Save 옆에 점(•) — 앱 전역 규약(RFQ 편집기와 같은 모양). */}
        {gate.editing ? (
          <button className="btn primary" disabled={busy || !valid} onClick={save}
                  title={dirty ? "Unsaved changes" : undefined}>
            {busy ? "Saving…" : savedId ? (dirty ? "Save •" : "Save") : "Add schedule"}
          </button>
        ) : !canEdit ? (
          <span className="hint-inline">View only — created by another PIC</span>
        ) : null}
        {savedId && gate.editing ? (
          <button className="btn danger" disabled={busy} onClick={remove} style={{ marginLeft: "auto" }}>
            Delete
          </button>
        ) : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  );
}
