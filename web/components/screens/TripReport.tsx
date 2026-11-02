"use client";

/* 출장(Business trip) 일정의 보고서 — 엑셀 '출장결과보고서' 양식과 같은 네 장(탭).
   결과보고서 · 출장일정 · 출장경비 · 업체별 미팅메모. 인쇄본도 같은 네 장으로 나온다. */

import ComboBox from "@/components/common/ComboBox";
import type { ScheduleAgendaItem, TripAction, TripExpense, TripMemo, TripReport, TripStop } from "@/lib/types";

export const TRIP_TYPE = "Business trip";

export type TripTab = "report" | "itinerary" | "expenses" | "memos";
export const TRIP_TABS: { id: TripTab; label: string; sheet: string }[] = [
  { id: "report", label: "Trip report", sheet: "출장결과보고서" },
  { id: "itinerary", label: "Itinerary", sheet: "출장일정" },
  { id: "expenses", label: "Expenses", sheet: "출장경비" },
  { id: "memos", label: "Meeting memos", sheet: "업체별 미팅메모" },
];

export const EXPENSE_CATEGORIES = ["교통비", "숙박비", "식비", "접대비", "통신비", "기타"];
export const PAYMENT_METHODS = ["개인 신용카드", "법인카드", "현금", "계좌이체"];

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

const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
/** '26.10.15(목)~16(금)' — 엑셀 양식의 출장기간 표기. 달이 바뀌면 끝에도 월을 붙인다. */
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
        { key: "text", label: "Action (내용)", kind: "area", ph: "What to do next" },
        { key: "owner", label: "Owner (담당자)", w: 130 },
        { key: "due", label: "Target (목표 일정)", w: 120, ph: "11월 1주" },
        { key: "note", label: "Note (비고)", w: 170 },
      ]}
    />
  );
}

export function TripItineraryTab({ trip, setTrip }: { trip: TripReport; setTrip: (t: TripReport) => void }) {
  return (
    <>
      <p className="trip-hint">방문처별로 일시, 논의 내용, 결과 및 후속 행동을 기록하세요. 이동은 Time / move 칸에만 적어도 됩니다.</p>
      <RowTable<TripStop>
        list={trip.itinerary}
        onChange={(itinerary) => setTrip({ ...trip, itinerary })}
        make={(p) => emptyStop(p?.date ?? "")}
        addLabel="Add row"
        cols={[
          { key: "date", label: "Date (일자)", w: 128, kind: "date" },
          { key: "time", label: "Time / move (시간)", w: 120, kind: "area", ph: "09:00–10:00" },
          { key: "org", label: "Visit (방문기관/업체)", w: 130, kind: "area" },
          { key: "place", label: "Place (장소)", w: 120, kind: "area" },
          { key: "people", label: "Attendees (참석자/담당자)", w: 150, kind: "area" },
          { key: "activity", label: "Discussion (논의/활동 내용)", kind: "area" },
          { key: "result", label: "Result & follow-up (결과)", kind: "area" },
          { key: "note", label: "Note (비고)", w: 100, kind: "area" },
        ]}
      />
    </>
  );
}

export function TripExpensesTab({ trip, setTrip }: { trip: TripReport; setTrip: (t: TripReport) => void }) {
  const byUser = expenseGroups(trip.expenses);
  return (
    <>
      <p className="trip-hint">금액은 원화(KRW) 기준 · 해외 결제는 적용 환율로 환산하여 입력하세요.</p>
      <RowTable<TripExpense>
        list={trip.expenses}
        onChange={(expenses) => setTrip({ ...trip, expenses })}
        make={(p) => ({ ...emptyExpense(p?.date ?? "", p?.user ?? ""), payment: p?.payment ?? "" })}
        addLabel="Add expense"
        cols={[
          { key: "date", label: "Date (지출일)", w: 128, kind: "date" },
          { key: "user", label: "User (사용자)", w: 90 },
          { key: "category", label: "Category (구분)", w: 110, kind: "combo", options: EXPENSE_CATEGORIES },
          { key: "detail", label: "Where / what (사용처/내역)", kind: "area" },
          { key: "payment", label: "Payment (결제 수단)", w: 130, kind: "combo", options: PAYMENT_METHODS },
          { key: "fx_note", label: "Currency / FX (환율 메모)", w: 110 },
          { key: "amount", label: "Amount KRW", w: 110, kind: "number" },
          { key: "receipt", label: "Receipt", w: 58, kind: "check" },
          { key: "note", label: "Note (비고)", w: 120 },
        ]}
        foot={
          <tfoot>
            {byUser.length > 1
              ? byUser.map((g) => (
                  <tr key={g.user} className="sub">
                    <td colSpan={6}>{g.user || "(no user)"} 계</td>
                    <td className="num">{krw(g.total)}</td>
                    <td colSpan={3} />
                  </tr>
                ))
              : null}
            <tr className="total">
              <td colSpan={6}>총 계 · receipts {tripReceipts(trip)}</td>
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
      <p className="trip-hint">업체별로 사업 개요·역량·제약 등을 항목별로 정리하고, 시사점/검증할 점을 따로 적어 두세요.</p>
      <RowTable<TripMemo>
        list={trip.memos}
        onChange={(memos) => setTrip({ ...trip, memos })}
        make={(p) => emptyMemo(p?.company ?? "")}
        addLabel="Add memo"
        cols={[
          { key: "company", label: "Company (업체)", w: 130 },
          { key: "section", label: "Section (구분)", w: 100 },
          { key: "item", label: "Item (세부 항목)", w: 120 },
          { key: "memo", label: "Memo (미팅 메모 정리)", kind: "area" },
          { key: "insight", label: "Insight / to verify (시사점)", w: 230, kind: "area" },
          { key: "note", label: "Note (비고)", w: 100, kind: "area" },
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
      <tr><th>작성일</th><td>${v(t.report_date)}</td><th>작성자</th><td>${v(t.author)}</td>
          <th>소속 / 직위</th><td>${v(t.position)}</td><th>보고 대상</th><td>${v(t.report_to)}</td></tr>
      <tr><th>출장기간</th><td colspan="3">${esc(period)}</td><th>출장지역</th><td colspan="3">${v(d.region)}</td></tr>
      <tr><th>출장목적</th><td colspan="3">${v(t.purpose)}</td><th>방문처 / 미팅 상대</th><td colspan="3">${v(t.visits)}</td></tr>
      ${d.travelers.length || d.customer
        ? `<tr><th>출장자</th><td colspan="3">${esc(d.travelers.join(", "))}</td><th>관련 고객사</th><td colspan="3">${v(d.customer)}</td></tr>`
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
    <h1>출장 결과 보고서</h1>
    <div class="subt">BUSINESS TRIP REPORT${d.title ? ` · ${esc(d.title)}` : ""}</div>
    <h2>01&nbsp; 출장 개요</h2>${overview}
    <h2>02&nbsp; 주요 출장 결과 및 성과</h2>${results}
    <h2>03&nbsp; 후속 조치 및 제안</h2>
    <table class="grid"><colgroup><col style="width:42px"><col><col style="width:80px"><col style="width:90px"><col style="width:22%"></colgroup>
      <thead><tr><th>번호</th><th>내용</th><th>담당자</th><th>목표 일정</th><th>비고</th></tr></thead><tbody>${actions}</tbody></table>
    <h2>04&nbsp; 종합 의견 / 요청 사항</h2><div class="box">${v(d.opinion) || "&nbsp;"}</div>
    <h2>05&nbsp; 출장 경비 요약 <small>(상세: 출장경비)</small></h2>
    <table class="ov"><tr><th>총 경비 (KRW)</th><td class="r">${krw(tripTotal(t))}</td><th>영수증 수</th><td class="r">${tripReceipts(t)}</td>
      <th>출장 활동 건수</th><td class="r">${tripVisits(t)}</td></tr></table>
    <p class="att">첨부자료: ${v(t.attachments) || "명함, 영수증 등 관련 증빙 별첨"}</p>
    <table class="sign"><tr><th>작성자 확인</th><td>${v(t.author)}</td><th>검토</th><td>${v(t.reviewer)}</td><th>승인</th><td>${v(t.approver)}</td></tr></table>
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
    <h1>출장 일정 및 방문 미팅 기록</h1>
    <div class="subt">출장 중 방문처별 일시, 논의 내용, 결과 및 후속 행동</div>
    <table class="grid">
      <colgroup><col style="width:78px"><col style="width:92px"><col style="width:10%"><col style="width:9%"><col style="width:13%"><col><col><col style="width:8%"></colgroup>
      <thead><tr><th>일자</th><th>시간 / 장소</th><th>방문기관 / 업체</th><th>장소</th><th>참석자 / 담당자</th><th>논의 / 활동 내용</th><th>결과 및 후속 조치</th><th>비고</th></tr></thead>
      <tbody>${body}</tbody></table>
  </section>`;
  }

  let sheet3 = "";
  if (t.expenses.length) {
    const groups = expenseGroups(t.expenses);
    const line = (e: TripExpense) =>
      `<tr><td class="c">${v(e.date)}</td><td class="c">${v(e.user)}</td><td class="c">${v(e.category)}</td><td>${v(e.detail)}</td><td class="c">${v(e.payment)}</td><td>${v(e.fx_note)}</td><td class="r">${krw(e.amount)}</td><td class="c">${e.receipt ? "유" : "무"}</td><td>${v(e.note)}</td></tr>`;
    const body = groups
      .map((g) => g.rows.map(line).join("") + (groups.length > 1 ? `<tr class="sub"><td colspan="6">${v(g.user) || "—"} 계</td><td class="r">${krw(g.total)}</td><td colspan="2"></td></tr>` : ""))
      .join("");
    sheet3 = `
  <section class="sheet wide">
    <h1>출장 경비 정산</h1>
    <div class="subt">금액은 원화(KRW) 기준 · 해외 결제는 적용 환율로 환산하여 입력</div>
    <table class="grid">
      <colgroup><col style="width:82px"><col style="width:64px"><col style="width:64px"><col><col style="width:96px"><col style="width:12%"><col style="width:92px"><col style="width:48px"><col style="width:14%"></colgroup>
      <thead><tr><th>지출일</th><th>사용자</th><th>경비 구분</th><th>사용처 / 내역</th><th>결제 수단</th><th>통화 / 환율 메모</th><th>금액 (KRW)</th><th>영수증</th><th>비고</th></tr></thead>
      <tbody>${body}<tr class="total"><td colspan="6">총 계</td><td class="r">${krw(tripTotal(t))}</td><td colspan="2"></td></tr></tbody></table>
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
    <h1>${d.title ? `${esc(d.title)} | ` : ""}업체별 상세 미팅 메모</h1>
    <div class="subt">${esc(period)}</div>
    <table class="grid">
      <colgroup><col style="width:96px"><col style="width:76px"><col style="width:96px"><col><col style="width:22%"><col style="width:9%"></colgroup>
      <thead><tr><th>업체</th><th>구분</th><th>세부 항목</th><th>미팅 메모 정리</th><th>시사점 / 검증 필요</th><th>비고</th></tr></thead>
      <tbody>${body}</tbody></table>
  </section>`;
  }

  return `<!doctype html><html><head><meta charset="utf-8"><title>출장결과보고서${d.title ? ` — ${esc(d.title)}` : ""}</title>
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
