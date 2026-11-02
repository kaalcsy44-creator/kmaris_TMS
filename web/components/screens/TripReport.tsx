"use client";

/* 출장(Business trip) 일정의 보고서 — 엑셀 '출장결과보고서' 양식과 같은 네 장(탭).
   결과보고서 · 출장일정 · 출장경비 · 업체별 미팅메모. 인쇄본도 같은 네 장으로 나온다. */

import ComboBox from "@/components/common/ComboBox";
import type { ScheduleAgendaItem, TripAction, TripExpense, TripMemo, TripReport, TripStop } from "@/lib/types";

export const TRIP_TYPE = "Business trip";

export type TripTab = "report" | "itinerary" | "expenses" | "memos";
export const TRIP_TABS: { id: TripTab; label: string }[] = [
  { id: "report", label: "Trip report" },
  { id: "itinerary", label: "Itinerary" },
  { id: "expenses", label: "Expenses" },
  { id: "memos", label: "Meeting memos" },
];

export const EXPENSE_CATEGORIES = ["Transport", "Lodging", "Meals", "Entertainment", "Communication", "Other"];
export const PAYMENT_METHODS = ["Personal card", "Corporate card", "Cash", "Bank transfer"];

const emptyAction = (): TripAction => ({ text: "", owner: "", due: "", note: "" });
const emptyStop = (date = ""): TripStop => ({
  date, time: "", org: "", place: "", people: "", activity: "", result: "", note: "",
});
const emptyExpense = (date = "", user = ""): TripExpense => ({
  date, user, category: "", detail: "", payment: "", fx_note: "", amount: 0, receipt: true, note: "",
});
const emptyMemo = (company = ""): TripMemo => ({ company, section: "", item: "", memo: "", insight: "", note: "" });

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const rows = <T,>(v: unknown, make: (r: Record<string, unknown>) => T): T[] =>
  Array.isArray(v) ? v.filter((r) => r && typeof r === "object").map((r) => make(r as Record<string, unknown>)) : [];

/** 저장본(모양이 덜 찬 예전 값일 수도) → 화면이 쓰는 온전한 보고서. 빈 표는 빈 줄 하나로 연다. */
export function initialTrip(raw: Partial<TripReport> | undefined, defaults: { author: string; date: string }): TripReport {
  const r = (raw ?? {}) as Record<string, unknown>;
  const actions = rows(r.actions, (a) => ({ text: str(a.text), owner: str(a.owner), due: str(a.due), note: str(a.note) }));
  const itinerary = rows(r.itinerary, (a) => ({
    date: str(a.date), time: str(a.time), org: str(a.org), place: str(a.place),
    people: str(a.people), activity: str(a.activity), result: str(a.result), note: str(a.note),
  }));
  const expenses = rows(r.expenses, (a) => ({
    date: str(a.date), user: str(a.user), category: str(a.category), detail: str(a.detail),
    payment: str(a.payment), fx_note: str(a.fx_note), amount: Number(a.amount) || 0,
    receipt: a.receipt !== false, note: str(a.note),
  }));
  const memos = rows(r.memos, (a) => ({
    company: str(a.company), section: str(a.section), item: str(a.item),
    memo: str(a.memo), insight: str(a.insight), note: str(a.note),
  }));
  return {
    date_end: str(r.date_end),
    purpose: str(r.purpose),
    visits: str(r.visits),
    author: raw && "author" in raw ? str(r.author) : defaults.author,
    position: str(r.position),
    report_to: str(r.report_to),
    report_date: raw && "report_date" in raw ? str(r.report_date) : "",
    attachments: str(r.attachments),
    reviewer: str(r.reviewer),
    approver: str(r.approver),
    actions: actions.length ? actions : [emptyAction()],
    itinerary: itinerary.length ? itinerary : [emptyStop(defaults.date)],
    expenses: expenses.length ? expenses : [emptyExpense(defaults.date)],
    memos: memos.length ? memos : [emptyMemo()],
  };
}

/** 저장할 모양 — 글자를 다듬고 아무것도 안 적은 줄은 버린다. */
export function cleanTrip(t: TripReport): TripReport {
  const trimAll = <T extends Record<string, unknown>>(o: T): T =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v])) as T;
  const filled = (o: Record<string, unknown>, skip: string[] = []) =>
    Object.entries(o).some(([k, v]) => !skip.includes(k) && (typeof v === "string" ? v.trim() !== "" : typeof v === "number" ? v !== 0 : false));
  return {
    ...trimAll({ ...t, actions: [], itinerary: [], expenses: [], memos: [] }),
    actions: t.actions.map(trimAll).filter((a) => filled(a)),
    // 날짜만 미리 채워 둔 줄은 빈 줄이다.
    itinerary: t.itinerary.map(trimAll).filter((a) => filled(a, ["date"])),
    expenses: t.expenses.map(trimAll).filter((a) => filled(a, ["date", "user"])),
    memos: t.memos.map(trimAll).filter((a) => filled(a, ["company"]) || a.company !== ""),
  };
}

export const tripTotal = (t: TripReport) => t.expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
export const tripReceipts = (t: TripReport) => t.expenses.filter((e) => e.receipt && (Number(e.amount) || 0) !== 0).length;
/** 출장 활동 건수 — 방문기관/업체를 적은 일정 줄. */
export const tripVisits = (t: TripReport) => t.itinerary.filter((s) => s.org.trim()).length;

const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** '26.10.15(Thu)~16(Fri)' — 엑셀 양식의 출장기간 표기. 달이 바뀌면 끝에도 월을 붙인다. */
export function tripPeriod(start: string, end: string): string {
  const one = (iso: string, withYm: "full" | "md" | "d") => {
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return iso;
    const [y, m, dd] = iso.split("-");
    const head = withYm === "full" ? `${y.slice(2)}.${m}.${dd}` : withYm === "md" ? `${m}.${dd}` : dd;
    return `${head}(${WEEK[d.getDay()]})`;
  };
  if (!start) return "";
  if (!end || end === start) return one(start, "full");
  const sameYm = start.slice(0, 7) === end.slice(0, 7);
  const sameY = start.slice(0, 4) === end.slice(0, 4);
  return `${one(start, "full")}~${sameYm ? one(end, "d") : sameY ? one(end, "md") : one(end, "full")}`;
}

const krw = (n: number) => (Number(n) || 0).toLocaleString("ko-KR");

/* ── 표 편집기 — 줄마다 같은 칸들, 끝에 줄 지우기(×), 아래에 줄 더하기 ───────────── */
type Col<T> = {
  key: keyof T & string;
  label: string;
  /** 칸 폭(px) — 안 주면 남은 폭을 나눠 갖는다. */
  w?: number;
  kind?: "text" | "area" | "date" | "number" | "check" | "combo";
  options?: string[];
  ph?: string;
};

function RowTable<T extends object>({
  cols, list, onChange, make, addLabel, numbered, foot,
}: {
  cols: Col<T>[];
  list: T[];
  onChange: (next: T[]) => void;
  /** 새 줄 — 바로 윗줄을 보고 날짜·사람 같은 값을 이어 받는다. */
  make: (prev: T | undefined) => T;
  addLabel: string;
  numbered?: boolean;
  foot?: React.ReactNode;
}) {
  const set = (i: number, key: keyof T, v: unknown) =>
    onChange(list.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
  return (
    <div className="trip-table-wrap">
      <table className="trip-table">
        <colgroup>
          {numbered ? <col style={{ width: 34 }} /> : null}
          {cols.map((c) => (
            <col key={c.key} style={c.w ? { width: c.w } : undefined} />
          ))}
          <col style={{ width: 28 }} />
        </colgroup>
        <thead>
          <tr>
            {numbered ? <th className="no">No.</th> : null}
            {cols.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
            <th aria-label="Remove" />
          </tr>
        </thead>
        <tbody>
          {list.map((r, i) => (
            <tr key={i}>
              {numbered ? <td className="no">{i + 1}</td> : null}
              {cols.map((c) => {
                const v = (r as Record<string, unknown>)[c.key];
                const label = `${c.label} ${i + 1}`;
                return (
                  <td key={c.key} className={c.kind === "check" ? "chk" : c.kind === "number" ? "num" : undefined}>
                    {c.kind === "check" ? (
                      <input type="checkbox" aria-label={label} checked={!!v} onChange={(e) => set(i, c.key, e.target.checked)} />
                    ) : c.kind === "combo" ? (
                      <ComboBox value={str(v)} options={c.options ?? []} placeholder={c.ph} onChange={(x) => set(i, c.key, x)} />
                    ) : c.kind === "area" ? (
                      <textarea rows={1} aria-label={label} placeholder={c.ph} value={str(v)} onChange={(e) => set(i, c.key, e.target.value)} />
                    ) : c.kind === "number" ? (
                      <input
                        type="number"
                        aria-label={label}
                        value={Number(v) ? String(v) : ""}
                        placeholder={c.ph}
                        onChange={(e) => set(i, c.key, Number(e.target.value) || 0)}
                      />
                    ) : (
                      <input
                        type={c.kind === "date" ? "date" : "text"}
                        aria-label={label}
                        placeholder={c.ph}
                        value={str(v)}
                        onChange={(e) => set(i, c.key, e.target.value)}
                      />
                    )}
                  </td>
                );
              })}
              <td className="x">
                <button
                  type="button"
                  className="btn tiny sched-x"
                  aria-label={`Remove row ${i + 1}`}
                  onClick={() => onChange(list.length > 1 ? list.filter((_, j) => j !== i) : [make(undefined)])}
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
        {foot}
      </table>
      <button type="button" className="btn tiny sched-add" onClick={() => onChange([...list, make(list[list.length - 1])])}>
        + {addLabel}
      </button>
    </div>
  );
}

/* ── 탭별 본문 ───────────────────────────────────────────────────────────── */
export function TripActionsTable({ trip, setTrip }: { trip: TripReport; setTrip: (t: TripReport) => void }) {
  return (
    <RowTable<TripAction>
      numbered
      list={trip.actions}
      onChange={(actions) => setTrip({ ...trip, actions })}
      make={(p) => ({ ...emptyAction(), owner: p?.owner ?? "" })}
      addLabel="Add action"
      cols={[
        { key: "text", label: "Action", kind: "area", ph: "What to do next" },
        { key: "owner", label: "Owner", w: 130 },
        { key: "due", label: "Target date", w: 120, ph: "e.g. Nov wk 1" },
        { key: "note", label: "Note", w: 170 },
      ]}
    />
  );
}

export function TripItineraryTab({ trip, setTrip }: { trip: TripReport; setTrip: (t: TripReport) => void }) {
  return (
    <>
      <p className="trip-hint">Record each visit: when, what was discussed, the result and follow-ups. For travel legs, filling in Time / move alone is enough.</p>
      <RowTable<TripStop>
        list={trip.itinerary}
        onChange={(itinerary) => setTrip({ ...trip, itinerary })}
        make={(p) => emptyStop(p?.date ?? "")}
        addLabel="Add row"
        cols={[
          { key: "date", label: "Date", w: 128, kind: "date" },
          { key: "time", label: "Time / move", w: 120, kind: "area", ph: "09:00–10:00" },
          { key: "org", label: "Organization", w: 130, kind: "area" },
          { key: "place", label: "Place", w: 120, kind: "area" },
          { key: "people", label: "Attendees", w: 150, kind: "area" },
          { key: "activity", label: "Discussion / activity", kind: "area" },
          { key: "result", label: "Result & follow-up", kind: "area" },
          { key: "note", label: "Note", w: 100, kind: "area" },
        ]}
      />
    </>
  );
}

export function TripExpensesTab({ trip, setTrip }: { trip: TripReport; setTrip: (t: TripReport) => void }) {
  const byUser = expenseGroups(trip.expenses);
  return (
    <>
      <p className="trip-hint">Enter amounts in KRW · convert foreign payments at the applied exchange rate.</p>
      <RowTable<TripExpense>
        list={trip.expenses}
        onChange={(expenses) => setTrip({ ...trip, expenses })}
        make={(p) => ({ ...emptyExpense(p?.date ?? "", p?.user ?? ""), payment: p?.payment ?? "" })}
        addLabel="Add expense"
        cols={[
          { key: "date", label: "Date", w: 128, kind: "date" },
          { key: "user", label: "User", w: 90 },
          { key: "category", label: "Category", w: 110, kind: "combo", options: EXPENSE_CATEGORIES },
          { key: "detail", label: "Vendor / details", kind: "area" },
          { key: "payment", label: "Payment", w: 130, kind: "combo", options: PAYMENT_METHODS },
          { key: "fx_note", label: "Currency / FX", w: 110 },
          { key: "amount", label: "Amount KRW", w: 110, kind: "number" },
          { key: "receipt", label: "Receipt", w: 58, kind: "check" },
          { key: "note", label: "Note", w: 120 },
        ]}
        foot={
          <tfoot>
            {byUser.length > 1
              ? byUser.map((g) => (
                  <tr key={g.user} className="sub">
                    <td colSpan={6}>{g.user || "(no user)"} subtotal</td>
                    <td className="num">{krw(g.total)}</td>
                    <td colSpan={3} />
                  </tr>
                ))
              : null}
            <tr className="total">
              <td colSpan={6}>Total · receipts {tripReceipts(trip)}</td>
              <td className="num">{krw(tripTotal(trip))}</td>
              <td colSpan={3} />
            </tr>
          </tfoot>
        }
      />
    </>
  );
}

export function TripMemosTab({ trip, setTrip }: { trip: TripReport; setTrip: (t: TripReport) => void }) {
  return (
    <>
      <p className="trip-hint">Summarize each company by topic (overview, capabilities, limits) and note insights or points to verify separately.</p>
      <RowTable<TripMemo>
        list={trip.memos}
        onChange={(memos) => setTrip({ ...trip, memos })}
        make={(p) => emptyMemo(p?.company ?? "")}
        addLabel="Add memo"
        cols={[
          { key: "company", label: "Company", w: 130 },
          { key: "section", label: "Section", w: 100 },
          { key: "item", label: "Item", w: 120 },
          { key: "memo", label: "Meeting notes", kind: "area" },
          { key: "insight", label: "Insight / to verify", w: 230, kind: "area" },
          { key: "note", label: "Note", w: 100, kind: "area" },
        ]}
      />
    </>
  );
}

function expenseGroups(list: TripExpense[]) {
  const groups: { user: string; rows: TripExpense[]; total: number }[] = [];
  for (const e of list) {
    let g = groups.find((x) => x.user === e.user.trim());
    if (!g) groups.push((g = { user: e.user.trim(), rows: [], total: 0 }));
    g.rows.push(e);
    g.total += Number(e.amount) || 0;
  }
  return groups;
}

/* ── 인쇄본 — 엑셀 양식과 같은 네 장. 결과보고서는 A4 세로, 나머지 표는 A4 가로 ─────── */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function tripReportHtml(d: {
  title: string;
  date: string;
  region: string;
  travelers: string[];
  customer: string;
  results: ScheduleAgendaItem[];
  opinion: string;
  trip: TripReport;
}): string {
  const t = cleanTrip(d.trip);
  const v = (x: string | undefined) => (x && x.trim() ? esc(x.trim()) : "");
  const period = tripPeriod(d.date, t.date_end);

  const overview = `
    <table class="ov">
      <colgroup><col class="k"><col><col class="k"><col><col class="k"><col><col class="k"><col></colgroup>
      <tr><th>Report date</th><td>${v(t.report_date)}</td><th>Author</th><td>${v(t.author)}</td>
          <th>Dept / title</th><td>${v(t.position)}</td><th>Report to</th><td>${v(t.report_to)}</td></tr>
      <tr><th>Period</th><td colspan="3">${esc(period)}</td><th>Region</th><td colspan="3">${v(d.region)}</td></tr>
      <tr><th>Purpose</th><td colspan="3">${v(t.purpose)}</td><th>Visits / met with</th><td colspan="3">${v(t.visits)}</td></tr>
      ${d.travelers.length || d.customer
        ? `<tr><th>Travelers</th><td colspan="3">${esc(d.travelers.join(", "))}</td><th>Customer</th><td colspan="3">${v(d.customer)}</td></tr>`
        : ""}
    </table>`;
  const results = d.results.length
    ? d.results.map((r, i) => `<div class="res"><b>${i + 1}. ${v(r.text)}</b>${r.result ? `<p>${v(r.result)}</p>` : ""}</div>`).join("")
    : `<p class="muted">—</p>`;
  const actions = t.actions.length
    ? t.actions.map((a, i) => `<tr><td class="c">${i + 1}</td><td>${v(a.text)}</td><td class="c">${v(a.owner)}</td><td class="c">${v(a.due)}</td><td>${v(a.note)}</td></tr>`).join("")
    : `<tr><td class="c">—</td><td colspan="4" class="muted">—</td></tr>`;
  const sheet1 = `
  <section class="sheet">
    <div class="brand"><b>K-MARIS</b><span>${esc(period)}</span></div>
    <h1>BUSINESS TRIP REPORT</h1>
    <div class="subt">${d.title ? esc(d.title) : "&nbsp;"}</div>
    <h2>01&nbsp; Overview</h2>${overview}
    <h2>02&nbsp; Key results</h2>${results}
    <h2>03&nbsp; Follow-up actions</h2>
    <table class="grid"><colgroup><col style="width:42px"><col><col style="width:80px"><col style="width:90px"><col style="width:22%"></colgroup>
      <thead><tr><th>No.</th><th>Action</th><th>Owner</th><th>Target date</th><th>Note</th></tr></thead><tbody>${actions}</tbody></table>
    <h2>04&nbsp; Overall opinion / requests</h2><div class="box">${v(d.opinion) || "&nbsp;"}</div>
    <h2>05&nbsp; Expense summary <small>(details: Expenses)</small></h2>
    <table class="ov"><tr><th>Total (KRW)</th><td class="r">${krw(tripTotal(t))}</td><th>Receipts</th><td class="r">${tripReceipts(t)}</td>
      <th>Visits</th><td class="r">${tripVisits(t)}</td></tr></table>
    <p class="att">Attachments: ${v(t.attachments) || "Business cards, receipts and other supporting documents"}</p>
    <table class="sign"><tr><th>Prepared by</th><td>${v(t.author)}</td><th>Reviewed by</th><td>${v(t.reviewer)}</td><th>Approved by</th><td>${v(t.approver)}</td></tr></table>
  </section>`;

  // 출장일정 — 같은 날은 일자 칸을, 같은 날 같은 시간대는 시간 칸을 하나로 합친다(엑셀 병합과 같게).
  let sheet2 = "";
  if (t.itinerary.length) {
    const it = t.itinerary;
    const span = (i: number, same: (a: TripStop, b: TripStop) => boolean) => {
      if (i > 0 && same(it[i - 1], it[i])) return 0;
      let n = 1;
      while (i + n < it.length && same(it[i + n - 1], it[i + n])) n++;
      return n;
    };
    const sameDate = (a: TripStop, b: TripStop) => a.date === b.date;
    const sameTime = (a: TripStop, b: TripStop) => sameDate(a, b) && !!a.time && a.time === b.time;
    const body = it
      .map((s, i) => {
        const ds = span(i, sameDate);
        const ts = span(i, sameTime);
        const move = !s.org && !s.place && !s.activity && !s.result;
        return `<tr${move ? ' class="move"' : ""}>${ds ? `<td class="c day" rowspan="${ds}">${v(s.date)}</td>` : ""}${
          ts ? `<td class="c" rowspan="${ts}">${v(s.time)}</td>` : ""
        }<td><b>${v(s.org)}</b></td><td>${v(s.place)}</td><td>${v(s.people)}</td><td>${v(s.activity)}</td><td>${v(s.result)}</td><td>${v(s.note)}</td></tr>`;
      })
      .join("");
    sheet2 = `
  <section class="sheet wide">
    <h1>ITINERARY &amp; MEETING LOG</h1>
    <div class="subt">When, what was discussed, results and follow-ups for each visit</div>
    <table class="grid">
      <colgroup><col style="width:78px"><col style="width:92px"><col style="width:10%"><col style="width:9%"><col style="width:13%"><col><col><col style="width:8%"></colgroup>
      <thead><tr><th>Date</th><th>Time / move</th><th>Organization</th><th>Place</th><th>Attendees</th><th>Discussion / activity</th><th>Result &amp; follow-up</th><th>Note</th></tr></thead>
      <tbody>${body}</tbody></table>
  </section>`;
  }

  let sheet3 = "";
  if (t.expenses.length) {
    const groups = expenseGroups(t.expenses);
    const line = (e: TripExpense) =>
      `<tr><td class="c">${v(e.date)}</td><td class="c">${v(e.user)}</td><td class="c">${v(e.category)}</td><td>${v(e.detail)}</td><td class="c">${v(e.payment)}</td><td>${v(e.fx_note)}</td><td class="r">${krw(e.amount)}</td><td class="c">${e.receipt ? "Yes" : "No"}</td><td>${v(e.note)}</td></tr>`;
    const body = groups
      .map((g) => g.rows.map(line).join("") + (groups.length > 1 ? `<tr class="sub"><td colspan="6">${v(g.user) || "—"} subtotal</td><td class="r">${krw(g.total)}</td><td colspan="2"></td></tr>` : ""))
      .join("");
    sheet3 = `
  <section class="sheet wide">
    <h1>TRAVEL EXPENSES</h1>
    <div class="subt">Amounts in KRW · foreign payments converted at the applied exchange rate</div>
    <table class="grid">
      <colgroup><col style="width:82px"><col style="width:64px"><col style="width:64px"><col><col style="width:96px"><col style="width:12%"><col style="width:92px"><col style="width:48px"><col style="width:14%"></colgroup>
      <thead><tr><th>Date</th><th>User</th><th>Category</th><th>Vendor / details</th><th>Payment</th><th>Currency / FX</th><th>Amount (KRW)</th><th>Receipt</th><th>Note</th></tr></thead>
      <tbody>${body}<tr class="total"><td colspan="6">Total</td><td class="r">${krw(tripTotal(t))}</td><td colspan="2"></td></tr></tbody></table>
  </section>`;
  }

  let sheet4 = "";
  if (t.memos.length) {
    const m = t.memos;
    const body = m
      .map((r, i) => {
        let cell = "";
        if (i === 0 || m[i - 1].company !== r.company) {
          let n = 1;
          while (i + n < m.length && m[i + n].company === r.company) n++;
          cell = `<td class="c day" rowspan="${n}"><b>${v(r.company)}</b></td>`;
        }
        return `<tr>${cell}<td class="c">${v(r.section)}</td><td class="c">${v(r.item)}</td><td>${v(r.memo)}</td><td>${v(r.insight)}</td><td>${v(r.note)}</td></tr>`;
      })
      .join("");
    sheet4 = `
  <section class="sheet wide">
    <h1>${d.title ? `${esc(d.title)} | ` : ""}MEETING MEMOS BY COMPANY</h1>
    <div class="subt">${esc(period)}</div>
    <table class="grid">
      <colgroup><col style="width:96px"><col style="width:76px"><col style="width:96px"><col><col style="width:22%"><col style="width:9%"></colgroup>
      <thead><tr><th>Company</th><th>Section</th><th>Item</th><th>Meeting notes</th><th>Insight / to verify</th><th>Note</th></tr></thead>
      <tbody>${body}</tbody></table>
  </section>`;
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>Business trip report${d.title ? ` — ${esc(d.title)}` : ""}</title>
<style>
  @page { size: A4; margin: 14mm 13mm 14mm; }
  @page wide { size: A4 landscape; margin: 11mm 11mm 12mm; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; padding: 18px 22px; font: 11.5px/1.5 "Pretendard", "Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif; color: #111827; background: #fff; }
  .sheet + .sheet { break-before: page; margin-top: 28px; padding-top: 22px; border-top: 2px dashed #cbd5e1; }
  .sheet.wide { page: wide; }
  @media print { body { padding: 0; } .sheet + .sheet { margin-top: 0; padding-top: 0; border-top: 0; } }
  .brand { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #0b1f3a; padding-bottom: 6px; }
  .brand b { font-size: 13px; letter-spacing: .06em; color: #0b1f3a; }
  .brand span { font-size: 11px; color: #6b7280; }
  h1 { font-size: 20px; margin: 12px 0 2px; color: #0b1f3a; text-align: center; letter-spacing: .08em; }
  .sheet.wide h1 { text-align: left; letter-spacing: .02em; font-size: 17px; margin-top: 0; }
  .subt { text-align: center; font-size: 10.5px; color: #6b7280; letter-spacing: .04em; margin-bottom: 8px; }
  .sheet.wide .subt { text-align: left; }
  h2 { font-size: 12.5px; margin: 14px 0 5px; padding: 4px 8px; color: #fff; background: #0b1f3a; border-radius: 2px; }
  h2 small { font-weight: 400; opacity: .8; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { border: 1px solid #c8d2df; padding: 4px 6px; vertical-align: top; white-space: pre-wrap; word-break: break-word; }
  .ov th { background: #eef3f9; color: #1f2d44; font-weight: 700; text-align: center; vertical-align: middle; }
  .ov col.k { width: 76px; }
  .grid thead th { background: #e3ebf5; color: #0b1f3a; font-weight: 700; text-align: center; border-bottom: 2px solid #0b1f3a; }
  .grid td.day { background: #f6f8fb; vertical-align: middle; }
  .grid tr.move td { color: #6b7280; font-style: italic; }
  .c { text-align: center; } .r { text-align: right; font-variant-numeric: tabular-nums; }
  tr.sub td { background: #f6f8fb; font-weight: 700; }
  tr.total td { background: #e3ebf5; font-weight: 800; }
  tr { break-inside: avoid; }
  .res { margin: 0 0 6px; break-inside: avoid; }
  .res b { color: #0b1f3a; }
  .res p { margin: 2px 0 0 14px; white-space: pre-wrap; }
  .box { border: 1px solid #c8d2df; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; min-height: 60px; }
  .att { margin: 12px 0 8px; font-size: 11px; color: #374151; }
  .sign th { width: 76px; background: #eef3f9; text-align: center; }
  .sign td { height: 34px; text-align: center; vertical-align: middle; }
  .muted { color: #9ca3af; }
</style></head><body>${sheet1}${sheet2}${sheet3}${sheet4}</body></html>`;
}
