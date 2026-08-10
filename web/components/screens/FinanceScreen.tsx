"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  fetchFinanceSummary,
  fetchFinanceReceivables,
  fetchFinancePayables,
  fetchFinanceCalendar,
  fetchFinanceClosing,
  fetchFinanceCashflow,
  createFinancePayable,
  updateFinancePayable,
  deleteFinancePayable,
  payFinancePayable,
  createFinanceIncome,
  updateFinanceIncome,
  deleteFinanceIncome,
  receiveFinanceIncome,
  fetchVendors,
} from "@/lib/api";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import type {
  FinancePayable,
  FinancePayableSave,
  FinanceIncomeSave,
  FinanceReceivable,
  FinanceSummary,
  FinanceClosing,
  FinanceCashflow,
  FinanceCashflowRow,
  CashBucket,
  FinanceCalendarEvent,
  MoneyByCurrency,
  FxQuote,
} from "@/lib/types";
import { can } from "@/lib/auth";
import Modal from "@/components/common/Modal";
import CurrencyToggle from "@/components/common/CurrencyToggle";
import { amountInputValue, parseAmountInput } from "@/components/common/itemTable";
import FinanceDaybook from "@/components/screens/FinanceDaybook";
import {
  CATEGORY_LABEL,
  INCOME_CATEGORY_LABEL,
  KpiTile,
  MONTH_NAMES,
  ProjectDocLink,
  localDayStr,
  money,
  monthBounds,
  monthLabel,
  startYears,
  sym,
} from "@/components/screens/financeShared";

// ── Display helpers ────────────────────────────────────────────────────────────
// 통화·달 이름·KPI 타일·문서번호 링크는 Finance 화면들이 함께 쓰므로 financeShared 에 있다
// (위 import 참고). 여기 남은 것들은 이 화면에서만 쓰는 목록·폼용 표기다.
// Category codes are stored values (do not translate); labels below are display-only.
const CATEGORIES = ["거래선지급", "임차료", "급여", "공과금", "세금", "기타"];
const RECURRENCE_LABEL: Record<string, string> = {
  none: "One-time",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};
// 기타 수입 분류(저장값은 한글 코드, 표시만 영문).
const INCOME_CATEGORIES = ["이자수입", "환급", "잡수입", "기타"];

function won(n: number): string {
  return `₩${Math.round(n).toLocaleString()}`;
}
/** 표시할 통화 목록 — KRW·USD 를 앞에 두고 나머지는 알파벳 순. */
function currencyKeys(m: MoneyByCurrency): string[] {
  const keys = Object.keys(m || {}).filter((k) => Math.abs(m[k]) > 0.5);
  const rank = (c: string) => (c === "KRW" ? 0 : c === "USD" ? 1 : 2);
  return keys.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
function byCurrency(m: MoneyByCurrency): string {
  const keys = currencyKeys(m);
  if (!keys.length) return "—";
  return keys.map((c) => money(m[c], c)).join(" · ");
}
/** 통화별 금액을 한 줄씩 — 환산 없이 ₩·$ 를 나란히 보여줄 때 쓴다. */
function byCurrencyLines(m: MoneyByCurrency): React.ReactNode {
  const keys = currencyKeys(m);
  if (!keys.length) return "—";
  return keys.map((c) => (
    <div key={c} className="cur-line">{money(m[c], c)}</div>
  ));
}

/** 통화별 합계를 참고용 KRW 한 값으로 — 표시 전용(집계·저장에는 쓰지 않는다). */
function toKrw(m: MoneyByCurrency, usdKrw: number): number {
  return Object.entries(m || {}).reduce(
    (sum, [cur, amt]) => sum + (cur === "USD" ? amt * usdKrw : amt),
    0
  );
}

/** AR 상태(DB는 한글 enum) → 화면 표기. */
// 들어오는 돈의 상태 — 아직 안 온 것은 Receivable, 온 것은 Received 로 부른다.
// 나가는 돈(Payable / Paid)과 짝을 맞춘 말이라, 어느 쪽 돈인지가 상태 하나로 읽힌다
// ("Paid" 를 양쪽에 쓰면 수금인지 지급인지 표를 보고서야 안다).
const AR_STATUS_LABEL: Record<string, string> = {
  미수: "Receivable",
  일부수금: "Partly received",
  완납: "Received",
  연체: "Overdue",
};
const todayStr = () => new Date().toISOString().slice(0, 10);

// ── Screen ───────────────────────────────────────────────────────────────────
// Cash Flow 는 따로 서지 않는다 — 잔액과 현금흐름은 같은 질문의 앞뒤라서 Overview 하나로 합쳤다.
// 목록 두 탭은 Overview 의 두 기둥과 같은 이름을 쓴다(Inflow/Outflow) — 같은 돈을
// 한쪽에서는 '들어올 돈', 다른 쪽에서는 'Receivables' 라 부르면 매번 옮겨 읽어야 한다.
type Tab = "overview" | "inflow" | "outflow" | "closing" | "calendar";

const TABS: Tab[] = ["overview", "inflow", "outflow", "closing", "calendar"];
/** 이름을 바꾸기 전 주소로 들어오는 링크 — 같은 자리로 보낸다. */
const TAB_ALIAS: Record<string, Tab> = { receivables: "inflow", payables: "outflow" };

/** 주소의 질의값을 고쳐 쓴다 — 탭·갈래·기간이 모두 주소에 살아 링크로 오갈 수 있게.
 *
 * 갱신은 router.replace 가 아니라 history.replaceState 로 한다. 같은 페이지의 질의값만
 * 바뀌는데도 router.replace 는 매번 라우터 전환(서버 RSC 왕복)을 걸고, 그동안 화면은
 * 이전 탭에 머문다 — 눌러도 안 넘어가는 것처럼 보이던 원인이다. 얕은 갱신은 즉시
 * 끝나고, 아래 구독으로 이 화면의 훅 인스턴스들(탭 머리·Inflow·Outflow)이 같은 값을
 * 함께 본다. 뒤로/앞으로와 딥링크도 그대로 동작한다.
 */
const navListeners = new Set<(qs: string) => void>();

function useFinanceNav() {
  // 첫 진입·딥링크 값. 브라우저에서는 주소창이 늘 최신이므로 그쪽을 먼저 본다
  // (탭을 옮기며 새로 붙는 컴포넌트가 한 박자 늦은 값으로 시작하지 않게).
  const urlParams = useSearchParams();
  const [qs, setQs] = useState(() =>
    typeof window === "undefined" ? urlParams.toString() : window.location.search.replace(/^\?/, "")
  );

  // 라우터 쪽에서 주소가 바뀌는 경우(다른 화면에서 넘어온 링크 등)를 따라간다.
  // 단, 라우터가 실제 주소와 다른 값을 들고 있으면(내 얕은 갱신이 아직 반영되기 전)
  // 무시한다 — 그대로 받으면 방금 옮긴 탭이 이전 탭으로 되튄다.
  useEffect(() => {
    const fromRouter = urlParams.toString();
    if (fromRouter === window.location.search.replace(/^\?/, "")) setQs(fromRouter);
  }, [urlParams]);

  useEffect(() => {
    const onSet = (next: string) => setQs(next);
    const onPop = () => setQs(window.location.search.replace(/^\?/, ""));
    navListeners.add(onSet);
    window.addEventListener("popstate", onPop);
    return () => {
      navListeners.delete(onSet);
      window.removeEventListener("popstate", onPop);
    };
  }, []);

  const params = useMemo(() => new URLSearchParams(qs), [qs]);

  const setParams = useCallback((patch: Record<string, string>) => {
    // 기준은 항상 지금 주소 — 이 훅을 쓰는 컴포넌트가 여럿이라 각자의 사본을 믿으면
    // 한쪽이 뒤처진 값으로 덮어쓸 수 있다.
    const q = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v) q.set(k, v);
      else q.delete(k);
    }
    const next = q.toString();
    window.history.replaceState(null, "", next ? `/finance?${next}` : "/finance");
    for (const notify of Array.from(navListeners)) notify(next);
  }, []);

  return { params, setParams };
}

export default function FinanceScreen() {
  // 탭은 상태가 아니라 주소에서 읽는다 — Overview 의 한 줄이 '이 탭의 이 갈래, 이 달'
  // 로 건너뛰는데, 상태로 들고 있으면 이미 떠 있는 화면이 주소만 바뀌고 안 따라온다.
  const { params, setParams } = useFinanceNav();
  const fromUrl = params.get("tab") || "";
  const asTab = (TAB_ALIAS[fromUrl] ?? fromUrl) as Tab;
  const tab: Tab = TABS.includes(asTab) ? asTab : "overview";
  // 탭을 옮기면 그 탭의 갈래·기간은 새로 고른다(전 탭의 것이 따라오면 엉뚱해진다).
  const setTab = (t: Tab) => setParams({ tab: t === "overview" ? "" : t, view: "", from: "", to: "" });
  return (
    <div className="action-tabs">
      <div className="page-tabs">
        <button className={tab === "overview" ? "on" : ""} onClick={() => setTab("overview")}>Overview</button>
        <button className={tab === "inflow" ? "on" : ""} onClick={() => setTab("inflow")}>Inflow</button>
        <button className={tab === "outflow" ? "on" : ""} onClick={() => setTab("outflow")}>Outflow</button>
        <button className={tab === "closing" ? "on" : ""} onClick={() => setTab("closing")}>Closing · VAT</button>
        <button className={tab === "calendar" ? "on" : ""} onClick={() => setTab("calendar")}>Calendar</button>
      </div>

      {tab === "overview" && <OverviewTab />}
      {tab === "inflow" && <InflowTab />}
      {tab === "outflow" && <OutflowTab />}
      {tab === "closing" && <ClosingTab />}
      {tab === "calendar" && <CalendarTab />}
    </div>
  );
}

// ── Overview — 잔액과 현금흐름을 한 화면에 ────────────────────────────────────
// 예전 Cash Flow 탭이 여기로 합쳐졌다. '얼마 남았나'와 '얼마 들어오고 나가나'는
// 같은 질문의 앞뒤인데 탭이 갈라져 있어 매번 오가야 했다.

/** 현금흐름 한 칸을 이루는 여섯 갈래 — 서버 bucket 값과 같은 이름. */
const BUCKET_LABEL: Record<CashBucket, string> = {
  receivables: "Receivables",
  income: "Other income",
  collected: "Received",
  payables: "Payables",
  other: "Other costs",
  paid: "Paid",
};
const BUCKET_HINT: Record<CashBucket, string> = {
  receivables: "invoices due",
  income: "other income due",
  collected: "already in the account",
  payables: "vendor bills due",
  other: "rent · payroll · utilities · tax",
  paid: "already out of the account",
};

/**
 * 현금흐름 한 칸 → 그 구간의 건별 내역 화면(/finance/period) 주소.
 * first(창의 첫 칸)까지 넘겨야 상세의 합계가 표의 그 행과 맞는다 — 첫 칸은 앞선
 * 연체까지 끌어안기 때문이다. bucket 을 주면 그 갈래만 펼친 화면이 열린다.
 */
/** 이번 달("2026-07") — 목록의 기간 필터 기본값. */
const thisMonthStr = () => localDayStr().slice(0, 7);

/** 구간 [lo,hi] 안인가. 한쪽이 비면 그쪽은 열려 있다(첫 구간이 과거를 흡수하는 규칙). */
function inRange(d: string, lo: string, hi: string): boolean {
  if (!d) return !lo && !hi;
  return (!lo || d >= lo) && (!hi || d <= hi);
}

/**
 * 반복 규칙을 [lo,hi] 안의 회차일로 펼친다 — 서버 _finance_occurrences 와 같은 규칙
 * (말일 보정 포함). lo 가 비면 첫 회차부터 본다.
 */
function occurrencesIn(due: string, recurrence: string, recurUntil: string, lo: string, hi: string): string[] {
  if (!due) return [];
  const step = recurrence === "monthly" ? 1 : recurrence === "quarterly" ? 3 : recurrence === "yearly" ? 12 : 0;
  if (!step) return inRange(due, lo, hi) ? [due] : [];
  const [y, m, d] = due.split("-").map(Number);
  const out: string[] = [];
  for (let i = 0; i < 240; i += 1) {
    const dt = new Date(y, m - 1 + step * i, 1);
    const last = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
    dt.setDate(Math.min(d, last));
    const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    if (recurUntil && iso > recurUntil) break;
    if (hi && iso > hi) break;
    if (inRange(iso, lo, hi)) out.push(iso);
  }
  return out;
}

/** 예정일이 구간에 드는가 — 반복 항목은 회차 하나라도 들면 든 것으로 본다. */
function dueInRange(
  r: { due_date?: string; recurrence?: string; recur_until?: string },
  lo: string,
  hi: string
): boolean {
  if (!lo && !hi) return true;
  return occurrencesIn(r.due_date || "", r.recurrence || "none", r.recur_until || "", lo, hi).length > 0;
}

/**
 * 목록의 기간 필터 — 전체 / 한 달, 그리고 Overview 에서 넘어온 임의 구간(주 단위 등).
 * 예정 항목은 예정일, 실적 항목은 실제로 오간 날을 기준으로 거른다.
 */
function LedgerPeriod({ from, to, onChange }: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}) {
  const ym = from.slice(0, 7);
  const whole = Boolean(from) && Boolean(to) && from === monthBounds(ym)[0] && to === monthBounds(ym)[1];
  const [y, m] = whole ? ym.split("-").map(Number) : [0, 0];
  // 'Monthly' 로 넘어갈 때 어느 달을 펼칠지 — 지금 걸린 구간의 달, 없으면 이번 달.
  const anchor = ym || (to ? to.slice(0, 7) : thisMonthStr());
  return (
    <div className="fin-ledger-period">
      <div className="seg-toggle" role="group" aria-label="Period">
        <button className={!from && !to ? "on" : ""} onClick={() => onChange("", "")}>All time</button>
        <button
          className={from || to ? "on" : ""}
          onClick={() => onChange(...monthBounds(anchor))}
        >
          Monthly
        </button>
      </div>
      {whole ? (
        <label className="fin-inline-field">
          <select value={m} onChange={(e) => onChange(...monthBounds(`${y}-${String(Number(e.target.value)).padStart(2, "0")}`))} aria-label="Month">
            {MONTH_NAMES.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
          </select>
          <select value={y} onChange={(e) => onChange(...monthBounds(`${e.target.value}-${String(m).padStart(2, "0")}`))} aria-label="Year">
            {startYears().map((yy) => <option key={yy} value={yy}>{yy}</option>)}
          </select>
        </label>
      ) : from || to ? (
        // Overview 의 주 단위 칸이나 '앞선 연체까지' 구간에서 넘어온 경우 — 그대로 보여 준다.
        <span className="fin-inline-field">
          {from ? from : "everything up to"} {from && to ? "→" : ""} {to}
        </span>
      ) : null}
    </div>
  );
}

/**
 * 목록의 통화 필터 — 빈 값이면 통화를 가리지 않는다(전부 한 표에, 합계는 통화별 줄).
 *
 * 환산해서 섞지 않고 '고른 통화만' 남기는 방식이다. 잔고·합계는 한 통화 안에서만 뜻이
 * 있고(현금흐름 화면의 ₩/$ 토글과 같은 규칙), 환산값을 목록에 섞으면 어느 숫자가 실제로
 * 오간 금액인지가 흐려진다. 참고용 KRW 환산은 표 발밑에 한 줄로만 남는다.
 */
type LedgerCur = "KRW" | "USD";

/** 주소의 cur → 통화. 없거나 모르는 값이면 원화 — 이 회사의 장부는 ₩ 가 기본이다. */
function asLedgerCur(v: string | null): LedgerCur {
  return (v || "").toUpperCase() === "USD" ? "USD" : "KRW";
}

/**
 * 통화는 둘 중 하나만 고른다 — '전부 한 표에'는 두지 않는다. 섞어 놓으면 합계가 통화마다
 * 한 줄씩 쌓여 어느 숫자가 이 표의 답인지 흐려지고, 정렬도 금액 순으로 읽히지 않는다.
 */
function LedgerCurrency({ cur, onChange }: { cur: LedgerCur; onChange: (c: LedgerCur) => void }) {
  return (
    <div className="seg-toggle" role="group" aria-label="Currency">
      <button className={cur === "KRW" ? "on" : ""} onClick={() => onChange("KRW")}>₩ KRW</button>
      <button className={cur === "USD" ? "on" : ""} onClick={() => onChange("USD")}>$ USD</button>
    </div>
  );
}

/** 통화별 합계에서 고른 통화만 남긴다. */
function pickCurrency(m: MoneyByCurrency, cur: LedgerCur): MoneyByCurrency {
  return (m && cur in m) ? { [cur]: m[cur] } : {};
}

/** 환산해 볼 것이 남았는가 — KRW 만 남은 표에 'In KRW' 줄을 한 번 더 적지 않기 위해. */
function needsKrwRef(...maps: MoneyByCurrency[]): boolean {
  return maps.some((m) => currencyKeys(m).some((c) => c !== "KRW"));
}

/** 유입 쪽 갈래 — 나머지는 유출. 목록 탭을 고를 때 쓴다. */
const IN_BUCKETS: CashBucket[] = ["receivables", "income", "collected"];

/**
 * 현금흐름 한 칸의 한 줄 → 그 갈래를 다루는 목록 탭(Inflow/Outflow)의 같은 이름 화면,
 * 기간까지 걸어서. 건별로 볼 자리가 목록에도 있는데 따로 만든 페이지로 보내면
 * 같은 목록을 두 군데서 보게 된다.
 * 첫 칸은 앞선 연체까지 끌어안으므로 시작을 열어 둔다(from 없음) — 그래야 목록의
 * 합과 기둥의 금액이 맞는다. 통화도 같은 이유로 걸어 보낸다: 이 기둥은 고른 통화 하나만
 * 세고 있어, 통화를 안 걸면 목록에 다른 통화가 섞여 합이 어긋난다.
 */
function ledgerHref(r: FinanceCashflowRow, first: boolean, bucket: CashBucket, currency: string): string {
  const q = new URLSearchParams({
    tab: IN_BUCKETS.includes(bucket) ? "inflow" : "outflow",
    view: bucket,
    to: r.end,
    cur: currency,
  });
  if (!first) q.set("from", r.start);
  return `/finance?${q.toString()}`;
}

function periodHref(
  r: FinanceCashflowRow,
  first: boolean,
  currency: string,
  includePo: boolean,
  /** 연체를 합계에 넣어 볼지 — 이 화면과 같은 규칙으로 펼쳐지도록 함께 넘긴다. */
  includeOverdue: boolean,
  /** 예정을 합계에 넣어 볼지 — 같은 이유로 함께 넘긴다(저쪽 합계가 이 표의 칸과 맞아야 한다). */
  includeExpected: boolean,
  bucket?: CashBucket
): string {
  const q = new URLSearchParams({
    start: r.start,
    end: r.end,
    label: r.label,
    cur: currency,
    po: includePo ? "1" : "0",
    first: first ? "1" : "0",
    ovd: includeOverdue ? "1" : "0",
    exp: includeExpected ? "1" : "0",
  });
  if (bucket) q.set("bucket", bucket);
  return `/finance/period?${q.toString()}`;
}

function OverviewTab() {
  const [unit, setUnit] = useState<"month" | "week">("month");
  const [count, setCount] = useState(12);
  const [includePo, setIncludePo] = useState(false);
  // 연체(예정일이 지난 미정산)를 잔고에 태울지. 기본은 끄고 본다 — 오지 않은 돈으로 굴린
  // 잔고는 그 구간 하나가 아니라 그 뒤 모든 구간을 함께 틀리게 만든다. 켜면 예전처럼
  // 흐름에 넣어, '받을 것을 다 받고 낼 것을 다 냈다면' 얼마가 되는지도 볼 수 있다.
  const [includeOverdue, setIncludeOverdue] = useState(false);
  // 예정(아직 안 오간 돈)을 잔고에 태울지. 기본은 끄고 본다 — 잔고는 통장에 찍힌 것,
  // 즉 실제로 오간 돈이어야 읽는 사람이 바로 믿을 수 있다. 예정 건은 그대로 내역에
  // 남고(유입·유출 아래 'expected' 로, 장부에는 잔고 칸을 비운 줄로) 금액만 잔고 밖에
  // 선다. 켜면 그 예정까지 굴려 '이대로 가면 얼마가 되는가'를 미리 본다.
  const [includeExpected, setIncludeExpected] = useState(false);
  // 잔고 곡선은 한 통화 안에서만 의미가 있으므로 환산 대신 통화를 골라 본다.
  const [currency, setCurrency] = useState("KRW");
  // 기초잔고는 통화별로 따로 기억한다 — 하나만 두면 ₩ 로 넣은 값이 $ 로 바꾼 순간
  // 그대로 달러로 읽혀(5천만원 → $50,000,000) 잔고 곡선 전체가 엉뚱해진다.
  const [openingByCur, setOpeningByCur] = useState<Record<string, string>>({ KRW: "0", USD: "0" });
  const openingInput = openingByCur[currency] ?? "0";
  const setOpeningInput = (v: string) => setOpeningByCur((m) => ({ ...m, [currency]: v }));
  const opening = Number(openingInput) || 0;
  // 창의 시작점(그 달 1일). 기본은 올해 1월 — 한 해가 통째로 들어오는 편이 이번 달부터
  // 앞만 보는 것보다 쓸모가 많다(지나간 달의 실적까지 함께 굴러간다).
  // 브라우저 기본 월 선택기는 창 언어를 따라가 한국어로 뜨므로 직접 고르게 둔다.
  const [startY, setStartY] = useState(() => new Date().getFullYear());
  const [startM, setStartM] = useState(1);
  const start = `${startY}-${String(startM).padStart(2, "0")}`;
  // 표에서 고른 한 칸(index) — 위쪽 세 기둥이 그 칸을 펼쳐 보여 준다.
  const [picked, setPicked] = useState<number | null>(null);
  // 일자별 장부를 펼쳐 둔 구간들(구간 이름으로 기억한다). 여러 달을 동시에 열어 둘 수
  // 있어야 8월과 9월을 오르내리며 견줄 수 있다 — 하나만 열리면 9월을 여는 순간 8월이
  // 닫혀, 두 달을 나란히 놓고 보려면 매번 다시 열어야 한다. index 가 아니라 이름으로
  // 기억하는 건 창(시작월·구간 수)이 바뀌면 같은 index 가 다른 달을 가리키기 때문이다.
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const toggleRow = (label: string) =>
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (!next.delete(label)) next.add(label);
      return next;
    });
  const cash = (n: number) => money(n, currency);

  const key = `finance:cashflow:${unit}:${count}:${opening}:${includePo}:${currency}:${start}:${includeOverdue}:${includeExpected}`;
  const { data, error } = useCachedData<FinanceCashflow>(
    key,
    () => fetchFinanceCashflow(unit, count, opening, includePo, currency, start, includeOverdue, includeExpected)
  );
  const rows = useMemo(() => data?.rows ?? [], [data]);
  // 이 집계가 예정·연체를 흐름 밖에 세워 두었나 — 펼친 장부가 같은 규칙으로 굴려야
  // 마지막 잔고가 그 행의 기말잔고와 어긋나지 않는다. 스위치가 아니라 응답을 보고 정하는
  // 건 배포 시차 때문이다: 백엔드가 아직 옛 버전이면 이 필드들이 아예 오지 않고, 그때
  // 집계는 예정·연체를 흐름에 그대로 넣은 값이라 장부만 빼면 둘이 어긋난다.
  const parkExpected = data?.expected_included === false;
  // 연체가 실제로 잔고에 실렸는가. 스위치만 보면 안 된다 — 예정을 통째로 세워 두면 연체는
  // 그 부분집합이라 스위치가 켜진 채로도 밖에 서고(서버가 함께 끈다), 그때 '잔고에 넣었다'는
  // 문구가 남으면 화면이 거짓말을 한다.
  const overdueRolled = includeOverdue && !parkExpected;
  const parkOverdue = typeof rows[0]?.overdue_in === "number" && !overdueRolled;
  const maxNet = useMemo(() => Math.max(1, ...rows.map((r) => Math.abs(r.net))), [rows]);
  // 기본 선택 = 오늘이 든 칸(창이 과거·미래로 벗어나 있으면 첫 칸).
  const todayIso = localDayStr();
  const defaultIdx = Math.max(0, rows.findIndex((r) => r.start <= todayIso && todayIso <= r.end));
  const idx = picked !== null && picked < rows.length ? picked : defaultIdx;
  const row: FinanceCashflowRow | undefined = rows[idx];
  // 기초잔고 기준일 = 첫 구간 시작일. 응답이 오기 전에도 라벨을 띄워야 해서
  // 서버(_cashflow_buckets)와 같은 규칙으로 미리 계산하고, 오면 응답 값으로 맞춘다.
  const openingAsOf = data?.opening_as_of ?? `${start}-01`;
  // 고른 칸의 기초잔고 = 앞 칸의 누적잔고(첫 칸이면 창 전체의 기초잔고).
  const rowOpening = !data ? 0 : idx === 0 ? data.opening : rows[idx - 1].cumulative;
  // 기둥 머리에는 읽기 좋은 이름으로("2026-07" → "Jul 2026"). 주 단위는 그대로.
  const pickedLabel = !row ? "" : unit === "month" ? monthLabel(row.label) : row.label;

  return (
    <div className="fin-overview">
      <div className="fin-period-bar">
        <div className="seg-toggle" role="group" aria-label="Unit">
          {/* 월 단위는 한 해를 통째로, 주 단위는 이번 달부터 — 1월부터 12주만 보면
              지금이 창 밖으로 밀려나 고를 것이 없다. */}
          <button className={unit === "month" ? "on" : ""} onClick={() => { setUnit("month"); setCount(12); setStartM(1); setPicked(null); }}>Monthly</button>
          <button className={unit === "week" ? "on" : ""} onClick={() => { setUnit("week"); setCount(12); setStartY(new Date().getFullYear()); setStartM(new Date().getMonth() + 1); setPicked(null); }}>Weekly</button>
        </div>
        <label className="fin-inline-field">
          {/* 시작점을 뒤로 물리면 지나간 달의 실적까지 함께 굴러간다 — 연초부터 되짚어 볼 때.
              주 단위도 같은 자리에서 시작한다(그 달 1일부터 N주). */}
          Start
          <select value={startM} onChange={(e) => { setStartM(Number(e.target.value)); setPicked(null); }} aria-label="Start month">
            {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
          <select value={startY} onChange={(e) => { setStartY(Number(e.target.value)); setPicked(null); }} aria-label="Start year">
            {startYears().map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        <button
          type="button"
          className="btn sm"
          title="Open the window at January and run it through December"
          onClick={() => { setStartY(new Date().getFullYear()); setStartM(1); setCount(12); setPicked(null); }}
        >
          This year
        </button>
        <label className="fin-inline-field">
          Periods
          <select value={count} onChange={(e) => { setCount(Number(e.target.value)); setPicked(null); }}>
            {(unit === "month" ? [3, 6, 12, 18, 24] : [8, 12, 16, 24]).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        {/* '어느 칸을 들여다볼지'는 이 줄에 없다 — 이 줄은 창을 어떻게 뜰지 정하는
            설정들이고, 그건 아래 세 기둥이 무엇을 말하는지를 정하는 것이라 기둥 바로
            왼쪽(표의 Period 칸 자리)에 서 있다. */}
        <div className="seg-toggle" role="group" aria-label="Currency">
          <button className={currency === "KRW" ? "on" : ""} onClick={() => setCurrency("KRW")}>₩ KRW</button>
          <button className={currency === "USD" ? "on" : ""} onClick={() => setCurrency("USD")}>$ USD</button>
        </div>
        <label className="fin-inline-field">
          {/* 기준일을 라벨에 박아 둔다 — 첫 구간이 이번 달 1일부터라 '오늘 잔고'를 넣으면
              이번 달에 이미 오간 돈이 두 번 세어진다. */}
          Opening balance ({sym(currency).trim()}) <span className="muted">as of {openingAsOf}</span>
          <input inputMode="decimal" value={amountInputValue(openingInput)} onChange={(e) => setOpeningInput(e.target.value.replace(/,/g, ""))} style={{ width: 140 }} />
        </label>
        <label className="check-chip" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={includePo} onChange={(e) => setIncludePo(e.target.checked)} /> Include vendor PO outflow (est.)
        </label>
        {/* 예정을 흐름에 태워 보는 스위치 — 기본은 꺼짐(잔고는 실제로 오간 돈만).
            켜면 아래 잔고 곡선이 통장이 아니라 예측이 된다. */}
        <label
          className="check-chip"
          style={{ cursor: "pointer" }}
          title="Scheduled items that have not moved yet are kept out of the balance — the balance shows money that actually moved. Tick to roll them in and project ahead."
        >
          <input type="checkbox" checked={includeExpected} onChange={(e) => setIncludeExpected(e.target.checked)} /> Count expected in balance
        </label>
        {/* 연체를 흐름에 태워 보는 스위치 — 기본은 꺼짐(잔고 밖에 세워 둔다). 연체는
            예정의 부분집합이라, 예정을 통째로 세워 둔 동안에는 고를 것이 없다. */}
        <label
          className={`check-chip${includeExpected ? "" : " off"}`}
          style={{ cursor: includeExpected ? "pointer" : "default" }}
          title={includeExpected
            ? "Overdue items are unsettled, so by default they are kept out of the balance. Tick to roll them in."
            : "Overdue items are expected items too — while expected money is kept out of the balance, this has nothing left to decide."}
        >
          <input
            type="checkbox"
            checked={includeOverdue && includeExpected}
            disabled={!includeExpected}
            onChange={(e) => setIncludeOverdue(e.target.checked)}
          /> Include overdue in balance
        </label>
      </div>

      {error && !data ? <div className="state error">API error: {error.message}</div> : null}
      {!data || !row ? <div className="state">Loading…</div> : (
        <>
          {/* 들어올 돈 / 나갈 돈 / 남는 돈 — 한 구간을 세 기둥으로 갈라 놓는다.
              각 줄은 그 갈래의 건별 목록으로 가는 문이다.
              갈래 금액에 ?? 0 을 두는 건 배포 시차 때문 — 백엔드가 아직 옛 버전이면
              그 필드가 비어 와서 NaN 이 찍힌다. */}
          <div className="fin-three-cols">
            {/* 앞머리 — 아래 표의 Period 칸과 같은 자리에 서서, 세 기둥이 어느 구간의
                것인지를 한 번만 말한다(기둥마다 이름 뒤에 "· Aug 2026" 을 되풀이하던
                것을 여기로 모았다). 고르는 칸이기도 하다: 아래 차트·표를 눌러도 같은
                값이 바뀌고, 여기서 바꾸면 세 기둥이 그 구간으로 옮겨 간다. */}
            <div className="panel fin-bucket-card fin-three-lead">
              <label className="fin-inline-field fin-focus-field">
                <span className="fin-focus-cap">Showing</span>
                <select
                  className="fin-focus-select"
                  value={idx}
                  onChange={(e) => setPicked(Number(e.target.value))}
                  aria-label="Period in focus"
                  disabled={!rows.length}
                >
                  {rows.map((r, i) => (
                    <option key={r.label} value={i}>{unit === "month" ? monthLabel(r.label) : r.label}</option>
                  ))}
                </select>
              </label>
            </div>
            {/* 이름은 Cash Flow 표의 칸 이름과 같은 말을 쓴다 — 같은 금액을 위에서는
                'In', 아래에서는 'Inflow' 라 부르면 매번 옮겨 읽어야 한다. */}
            <BucketCard
              title="Inflow"
              period={pickedLabel}
              tone="in"
              lines={[["receivables", row.in_ar ?? 0], ["income", row.in_income ?? 0], ["collected", row.actual_inflow]]}
              parked={parkExpected ? ["receivables", "income"] : []}
              allHref={`${periodHref(row, idx === 0, currency, includePo, overdueRolled, !parkExpected)}&side=in`}
              currency={currency}
              href={(b) => ledgerHref(row, idx === 0, b, currency)}
            />
            <BucketCard
              title="Outflow"
              period={pickedLabel}
              tone="out"
              lines={[["payables", row.out_ap ?? 0], ["other", row.out_other ?? 0], ["paid", row.actual_outflow]]}
              parked={parkExpected ? ["payables", "other"] : []}
              allHref={`${periodHref(row, idx === 0, currency, includePo, overdueRolled, !parkExpected)}&side=out`}
              currency={currency}
              href={(b) => ledgerHref(row, idx === 0, b, currency)}
            />
            <div className="panel fin-bucket-card fin-bucket--balance">
              {/* 구간 이름은 왼쪽 앞머리가 세 기둥을 대신해 한 번만 적는다. */}
              <h3 className="form-title">Balance</h3>
              <table className="mini">
                <tbody>
                  <tr>
                    <td>Opening<div className="hint-inline">carried in</div></td>
                    <td className="num">{cash(rowOpening)}</td>
                  </tr>
                  <tr>
                    <td>Net<div className="hint-inline">inflow − outflow</div></td>
                    <td className="num" style={{ color: row.net >= 0 ? "#1e7a46" : "#c0392b" }}>
                      {row.net >= 0 ? "+" : "−"}{cash(Math.abs(row.net))}
                    </td>
                  </tr>
                  {/* 세 기둥 모두 세 줄 — 옆의 두 기둥이 합계 줄을 걷어내면서 줄 수가 맞았다.
                      (예전에는 그 합계 줄과 Ending 을 같은 높이에 세우려고 여기 빈 줄을
                      하나 끼워 두었다.) 그래서 Ending 은 옆 기둥의 실적 줄과 나란히 선다 —
                      잔고를 만든 것이 그 줄이므로 자리로도 맞는 짝이다. */}
                  <tr className="fin-period-total">
                    {/* 딸린 한 줄은 옆 기둥의 마지막 줄과 키를 맞추는 몫도 한다 — 셋 다
                        이름 아래 한 줄이 붙어야 세 기둥의 발밑이 같은 높이에 선다.
                        말은 Opening('carried in')과 짝을 이룬다. */}
                    <td><b>Ending</b><div className="hint-inline">carried out</div></td>
                    <td className="num" style={{ color: row.cumulative < 0 ? "#c0392b" : undefined }}>
                      <b>{cash(row.cumulative)}</b>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="hint-inline" style={{ display: "block", marginTop: 8 }}>
                Rolled up from {cash(data.opening)} on {openingAsOf}.{parkExpected
                  ? " It counts only money that actually moved — scheduled items are listed but left out."
                  : ""} A negative ending balance marks a cash shortfall.
              </p>
              {/* 잔고 밖에 세워 둔 돈 — 잔고 바로 아래에 붙여 둔다. 이 줄들이 없으면
                  '예정·연체는 안 셌다'는 사실이 화면 어디에도 남지 않아, 잔고가 그만큼 좋아
                  보이거나(미지급) 나빠 보이는(미수) 이유를 알 수 없다. 예정을 먼저, 연체를
                  뒤에 적는다 — 예정이 더 큰 덩어리이고, 연체는 그중 날짜가 지난 몫이다. */}
              {(parkExpected && ((row.expected_in ?? 0) || (row.expected_out ?? 0))) || row.overdue_in || row.overdue_out ? (
                <div className={`fin-overdue-note${overdueRolled ? " in" : ""}`}>
                  <div className="fin-overdue-cap">
                    {overdueRolled ? "Of this balance, still unsettled" : "Not in this balance"}
                  </div>
                  {parkExpected && (row.expected_in ?? 0) ? (
                    <div className="fin-overdue-line">
                      <span>Expected in<span className="hint-inline"> not due yet</span></span>
                      <b className="num">+{cash(row.expected_in ?? 0)}</b>
                    </div>
                  ) : null}
                  {parkExpected && (row.expected_out ?? 0) ? (
                    <div className="fin-overdue-line">
                      <span>Expected out<span className="hint-inline"> not due yet</span></span>
                      <b className="num">−{cash(row.expected_out ?? 0)}</b>
                    </div>
                  ) : null}
                  {row.overdue_in ? (
                    <div className="fin-overdue-line">
                      <span>Overdue in<span className="hint-inline"> to collect</span></span>
                      <b className="num">+{cash(row.overdue_in)}</b>
                    </div>
                  ) : null}
                  {row.overdue_out ? (
                    <div className="fin-overdue-line">
                      <span>Overdue out<span className="hint-inline"> to pay</span></span>
                      <b className="num">−{cash(row.overdue_out)}</b>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          <div className="panel">
            <h3 className="form-title">Net cash flow ({sym(currency).trim()})</h3>
            <div className="fin-net-chart">
              {/* 막대를 누르면 위 세 기둥이 그 칸으로 바뀐다. */}
              {rows.map((r, i) => (
                <button
                  key={r.label}
                  type="button"
                  className={`fin-net-col${i === idx ? " on" : ""}`}
                  onClick={() => setPicked(i)}
                  title={`${r.label} · In ${cash(r.inflow)} · Out ${cash(r.outflow)} · Net ${cash(r.net)}`}
                >
                  <div className="fin-net-track">
                    <div className="fin-net-mid" />
                    <div
                      className={`fin-net-bar ${r.net >= 0 ? "pos" : "neg"}`}
                      style={{ height: `${(Math.abs(r.net) / maxNet) * 48}%`, [r.net >= 0 ? "bottom" : "top"]: "50%" } as React.CSSProperties}
                    />
                  </div>
                  {/* 좁은 화면에서는 연도를 접는다 — 열 하나가 30px 남짓이라
                      "2026-07" 은 두 줄로 접히고 눈금이 뭉개진다. */}
                  <div className="fin-bar-label">
                    {unit === "month" ? <><span className="fin-lab-yr">{r.label.slice(0, 5)}</span>{r.label.slice(5)}</> : r.label}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="panel">
            <h3 className="form-title">Cash flow</h3>
            {/* 좁은 화면에서는 다섯 칸이 한 줄에 못 선다 — CSS 가 이 표를 구간별 카드로
                접고, 그때 칸 이름은 data-label 이 대신 말한다. */}
            <table className="mini fin-cf-table">
              {/* 폭을 못박아 두는 건 아래로 펼쳐지는 일자별 장부와 세로줄을 맞추기 위해서다 —
                  장부의 Inflow·Outflow 합계와 마지막 잔고가 이 행의 같은 칸 바로 아래에
                  서야, 둘이 같은 값이라는 게 눈으로 읽힌다(globals.css 의 fin-db-w-* 와 짝). */}
              <colgroup>
                <col className="fin-cf-w-period" />
                <col className="fin-cf-w-flow" />
                <col className="fin-cf-w-flow" />
                <col className="fin-cf-w-net" />
                <col className="fin-cf-w-cum" />
              </colgroup>
              <thead>
                {/* 이 머리줄은 펼쳐진 장부의 머리 노릇도 한다 — 두 표가 같은 자를 쓰므로
                    장부는 자기 머리줄을 따로 세우지 않는다(FinanceDaybook 참고).
                    Cumulative 를 Balance 라 부르는 이유: 이 값은 기초잔고에서 순증감을
                    굴린 그 구간 끝의 통장잔고 자체다. 장부가 줄마다 굴리는 잔고와 같은
                    것이고, 그 마지막 값이 바로 이 칸이다. */}
                <tr><th>Period</th><th className="num">Inflow</th><th className="num">Outflow</th><th className="num">Net</th><th className="num">Balance</th></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const open = openRows.has(r.label);
                  const periodRow = (
                    <tr
                      className={`fin-row-pick${i === idx ? " on" : ""}${open ? " fin-cf-open" : ""}${r.cumulative < 0 ? " fin-overdue" : ""}`}
                      onClick={() => setPicked(i)}
                      title="Show this period in the three columns above"
                    >
                      <td>
                        {/* 이 줄의 안쪽(일자별 장부)을 그 자리에서 여닫는다. 줄마다 따로
                            여닫히므로 여러 달을 동시에 펼쳐 둘 수 있다 — 다른 줄을 연다고
                            이 줄이 닫히지 않는다. 누른 줄로 위 세 기둥도 함께 옮겨 온다. */}
                        <button
                          type="button"
                          className="fin-cf-toggle"
                          aria-expanded={open}
                          aria-label={`${open ? "Hide" : "Show"} the daybook for ${r.label}`}
                          title={open ? "Hide this period's daybook" : "Open this period day by day"}
                          onClick={(e) => {
                            e.stopPropagation();
                            setPicked(i);
                            toggleRow(r.label);
                          }}
                        >
                          {open ? "▾" : "▸"}
                        </button>
                        {r.label}
                      </td>
                      {/* 이미 오간 부분은 금액 아래 옅게 덧붙인다 — 같은 칸의 나머지가 예정분.
                          예정을 잔고 밖에 세워 두면 위 금액이 곧 실적이라 그 줄은 같은 말을
                          두 번 하는 셈이 되므로, 대신 '밖에 세워 둔 예정'을 적는다.
                          연체는 그 아래 한 줄 더 — 위 금액 '밖'의 돈이라, 이 줄이 없으면
                          그 달에 얼마가 밀려 있는지가 표에서 사라진다. */}
                      <td className="num" data-label="Inflow">
                        {cash(r.inflow)}
                        {parkExpected
                          ? ((r.expected_in ?? 0) ? (
                            <div className="fin-cf-parked" title="Scheduled, not yet received — kept out of the balance">
                              {cash(r.expected_in ?? 0)} expected
                            </div>
                          ) : null)
                          : (r.actual_inflow ? <div className="fin-cf-actual">{cash(r.actual_inflow)} received</div> : null)}
                        {r.overdue_in ? (
                          <div className="fin-cf-overdue" title={overdueRolled ? "Included above" : "Kept out of the balance"}>
                            {cash(r.overdue_in)} overdue
                          </div>
                        ) : null}
                      </td>
                      <td className="num" data-label="Outflow">
                        {cash(r.outflow)}
                        {parkExpected
                          ? ((r.expected_out ?? 0) ? (
                            <div className="fin-cf-parked" title="Scheduled, not yet paid — kept out of the balance">
                              {cash(r.expected_out ?? 0)} expected
                            </div>
                          ) : null)
                          : (r.actual_outflow ? <div className="fin-cf-actual">{cash(r.actual_outflow)} paid</div> : null)}
                        {r.overdue_out ? (
                          <div className="fin-cf-overdue" title={overdueRolled ? "Included above" : "Kept out of the balance"}>
                            {cash(r.overdue_out)} overdue
                          </div>
                        ) : null}
                      </td>
                      <td className="num" data-label="Net" style={{ color: r.net >= 0 ? "#1e7a46" : "#c0392b" }}>{r.net >= 0 ? "+" : "−"}{cash(Math.abs(r.net))}</td>
                      <td className="num" data-label="Balance"><b>{cash(r.cumulative)}</b></td>
                    </tr>
                  );
                  // 펼친 줄의 안쪽 — 기간·통화·기초잔고를 그대로 물려받으므로 이 장부의
                  // 합계와 기말잔고는 바로 아래 행의 Inflow·Outflow·Balance 와 같은 값이다.
                  const detailRow = (
                    <tr className="fin-cf-detail">
                      <td colSpan={5}>
                        <FinanceDaybook
                          start={r.start}
                          end={r.end}
                          label={unit === "month" ? monthLabel(r.label) : r.label}
                          opening={i === 0 ? data.opening : rows[i - 1].cumulative}
                          currency={currency}
                          includePo={includePo}
                          parkOverdue={parkOverdue}
                          parkExpected={parkExpected}
                          first={i === 0}
                        />
                      </td>
                    </tr>
                  );
                  // 서랍이 먼저, 구간 줄이 그 아래 — 합계는 안쪽 내역의 결론이지 머리말이
                  // 아니다. 이 순서라야 읽는 순서가 잔고가 굴러가는 순서와 같아진다:
                  // 앞 구간의 기말잔고 → 이월 → 하루하루 → 이 구간의 기말잔고 → 다음 구간.
                  // 합계를 위에 두면 아직 읽지 않은 내역의 답이 먼저 나와, 그 숫자가 어느
                  // 구간의 것인지(위쪽 달인지 아래 내역의 달인지)가 흐려진다.
                  return (
                    <Fragment key={r.label}>
                      {open ? detailRow : null}
                      {periodRow}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            <p className="hint-inline" style={{ display: "block", marginTop: 8 }}>
              Click a period to break it down in the three columns above, or the ▸ handle to open it day by day right
              here; click a line up there for the items behind it. Each period mixes money already moved (grey, dated
              on the day it actually arrived or left) with money still expected — receivables by due date and unpaid
              payable occurrences{includePo ? " + vendor POs (estimated from order date)" : ""}.
              So the opening balance must be your balance on {openingAsOf}, not today&apos;s. Only {currency} items are
              counted — switch the currency toggle for the other book; nothing is converted.{parkExpected
                ? " Money that has not moved yet — anything still expected, overdue included — is listed but kept out of the balance, so this balance is what your account actually holds. Tick “Count expected in balance” to roll it in and project ahead instead."
                : ""} Anything already past its date and still unsettled stays on that date as overdue{parkExpected
                ? "."
                : overdueRolled
                  ? ", and is rolled into the balance because you asked for it."
                  : ", and is left out of the balance — it is money that has not moved."} Past-due items from before the
              window fall into the first period.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

/** 한 구간의 유입(또는 유출) 세 갈래. 각 줄은 그 갈래의 건별 목록으로 간다. */
function BucketCard({ title, period, tone, lines, parked, allHref, currency, href }: {
  title: string;
  period: string;
  tone: "in" | "out";
  lines: [CashBucket, number][];
  /**
   * 잔고 밖에 세워 둔 갈래 — 금액은 그대로 적되 잔고에는 들어 있지 않다. 줄을 지우지
   * 않는 건 '무엇이 예정되어 있나'가 사라지면 안 되기 때문이고, 옅게 눕히는 건 잔고를
   * 움직이지 않은 줄임을 그 자리에서 알리기 위해서다.
   */
  parked?: CashBucket[];
  /** 기둥 이름 → 이 구간 전체를 한 화면에 펼친 기간 상세. */
  allHref: string;
  currency: string;
  href: (b: CashBucket) => string;
}) {
  const cash = (n: number) => money(n, currency);
  const isParked = (b: CashBucket) => !!parked?.includes(b);
  return (
    <div className={`panel fin-bucket-card fin-bucket--${tone}`}>
      {/* 기둥 이름이 곧 '이 구간 전부'로 가는 문이다 — 합계 줄에 달려 있던 링크를 여기로
          올렸다. 구간 이름은 왼쪽 앞머리가 한 번만 적는다(여기서는 링크 설명에만 남는다). */}
      <h3 className="form-title">
        <Link className="fin-doc-link" href={allHref} title={`Every ${title.toLowerCase()} item · ${period}`}>
          {title}
        </Link>
      </h3>
      {/* 합계 줄은 두지 않는다. 예정을 잔고 밖에 세워 두면(기본값) 세 줄이 더해서 하나가
          되지 않아 '합계'라 부를 것이 없고, 그때 그 자리에 적히던 값은 바로 위 실적 줄과
          같은 숫자였다 — 같은 값을 두 줄에 적으면 어느 쪽이 답인지가 흐려진다.
          구간의 유입·유출 합계는 아래 Cash flow 표의 그 행이 이미 적고 있다. */}
      <table className="mini">
        <tbody>
          {/* 마지막 줄(이미 오간 돈)은 옆 기둥의 Ending 과 같은 자리·같은 무게로 세운다 —
              세 기둥의 발밑에서 서로 짝이 되는 줄이라(이 줄이 곧 그 잔고를 만든 돈이다),
              음영과 윗선이 나란히 이어져야 셋이 한 줄로 읽힌다. */}
          {lines.map(([b, amount], i) => (
            <tr
              key={b}
              className={`${i === lines.length - 1 ? "fin-bucket-settled" : ""}${isParked(b) ? " fin-bucket-off" : ""}`}
            >
              <td>
                <Link className="fin-doc-link" href={href(b)} title={`Open the ${BUCKET_LABEL[b].toLowerCase()} items for ${period}`}>
                  {BUCKET_LABEL[b]}
                </Link>
                <div className="hint-inline">
                  {BUCKET_HINT[b]}{isParked(b) ? " · not in balance" : ""}
                </div>
              </td>
              <td className="num">{cash(amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 수입 목록 합계 — 청구·수금·미수 3열을 통화별로 모은다. */
function receivableTotals(rows: FinanceReceivable[]) {
  const t = { invoice: {} as MoneyByCurrency, paid: {} as MoneyByCurrency, outstanding: {} as MoneyByCurrency };
  for (const r of rows) {
    t.invoice[r.currency] = (t.invoice[r.currency] || 0) + r.invoice_amount;
    t.paid[r.currency] = (t.paid[r.currency] || 0) + r.paid_amount;
    t.outstanding[r.currency] = (t.outstanding[r.currency] || 0) + r.outstanding;
  }
  return t;
}

// ── Inflow — 들어올 돈(매출채권·기타수입)과 들어온 돈(수금) ─────────────────────
// 세 갈래는 Overview 의 In 기둥과 같은 이름·같은 뜻이다: 예정 둘(출처별)과 실적 하나.

/** 실적 한 건 — 실제로 오간 돈. 수금/지급 목록이 같은 모양을 쓴다. */
type SettledRow = {
  key: string;
  /** 실제로 오간 날(모르면 빈 값 — 부분수금은 날짜를 남길 자리가 없다). */
  date: string;
  kind: string;
  party: string;
  ref: React.ReactNode;
  amount: number;
  currency: string;
};

/** 통화별 합계 — 실적 목록의 발밑 합계. */
function settledTotals(rows: SettledRow[]): MoneyByCurrency {
  const t: MoneyByCurrency = {};
  for (const r of rows) t[r.currency] = (t[r.currency] || 0) + r.amount;
  return t;
}

/**
 * 수금 실적 — 매출채권 입금 + 기타수입 수령.
 * 반복 기타수입은 납부한 회차마다 한 줄로 펼친다(실제 입금일이 있으면 그 날짜로).
 */
function receiptRows(rows: FinanceReceivable[]): SettledRow[] {
  const out: SettledRow[] = [];
  for (const r of rows) {
    if (r.source === "income") {
      const amount = r.amount ?? r.invoice_amount;
      if ((r.recurrence ?? "none") === "none") {
        if (r.paid) {
          out.push({
            key: `inc-${r.id}`, date: r.paid_date || r.due_date,
            kind: INCOME_CATEGORY_LABEL[r.category || ""] || r.category || "Other income",
            party: r.counterparty || r.customer, ref: r.description || "—",
            amount, currency: r.currency,
          });
        }
      } else {
        for (const occ of r.paid_dates ?? []) {
          out.push({
            key: `inc-${r.id}-${occ}`, date: r.payments?.[occ] || occ,
            kind: INCOME_CATEGORY_LABEL[r.category || ""] || r.category || "Other income",
            party: r.counterparty || r.customer,
            ref: <>{r.description || "—"} <span className="hint-inline">· due {occ}</span></>,
            amount, currency: r.currency,
          });
        }
      }
    } else if (r.paid_amount > 0) {
      out.push({
        key: `ar-${r.id}`, date: r.paid_date || "", kind: "Sales",
        party: r.customer,
        ref: <ProjectDocLink orderId={r.order_id} rfqId={r.rfq_id} label={r.invoice_no || r.ci_no} />,
        amount: r.paid_amount, currency: r.currency,
      });
    }
  }
  return out.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

/** 지급 실적 — 벤더 청구 지급 + 기타비용 납부(반복은 회차별로 펼친다). */
function paymentRows(rows: FinancePayable[]): SettledRow[] {
  const out: SettledRow[] = [];
  for (const p of rows) {
    if (p.source === "ap") {
      if (p.paid_amount > 0) {
        out.push({
          key: `ap-${p.id}`, date: p.paid_date || "", kind: "Vendor bill",
          party: p.counterparty || "—",
          ref: <ProjectDocLink orderId={p.order_id} rfqId={p.rfq_id} label={p.description || p.po_no} apPoId={p.po_id} />,
          amount: p.paid_amount, currency: p.currency,
        });
      }
    } else if ((p.recurrence ?? "none") === "none") {
      if (p.paid) {
        out.push({
          key: `pay-${p.id}`, date: p.paid_date || p.due_date,
          kind: CATEGORY_LABEL[p.category] || p.category,
          party: p.counterparty || "—", ref: p.description || "—",
          amount: p.amount, currency: p.currency,
        });
      }
    } else {
      for (const occ of p.paid_dates ?? []) {
        out.push({
          key: `pay-${p.id}-${occ}`, date: p.payments?.[occ] || occ,
          kind: CATEGORY_LABEL[p.category] || p.category,
          party: p.counterparty || "—",
          ref: <>{p.description || "—"} <span className="hint-inline">· due {occ}</span></>,
          amount: p.amount, currency: p.currency,
        });
      }
    }
  }
  return out.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

/** 실적 목록 — 언제·무엇으로·누구에게 오갔는지. 수금·지급이 같은 표를 쓴다. */
function SettledTable({ rows, dateLabel, partyLabel, empty, fx }: {
  rows: SettledRow[];
  dateLabel: string;
  partyLabel: string;
  empty: string;
  fx: FxQuote;
}) {
  const totals = settledTotals(rows);
  return (
    <>
      <table className="mini fin-ledger">
        <thead>
          <tr>
            <th className="fin-w-date">{dateLabel}</th>
            <th className="fin-w-cat">Type</th>
            <th className="fin-w-party">{partyLabel}</th>
            <th>Reference</th>
            <th className="num fin-w-money">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? <tr><td colSpan={5} className="mini-empty">{empty}</td></tr> : null}
          {rows.map((r) => (
            <tr key={r.key}>
              {/* 날짜가 없는 건 = 부분수금 — 언제 들어왔는지 적을 자리가 레코드에 없다. */}
              <td data-label={dateLabel}>{r.date || <span className="hint-inline">no date</span>}</td>
              <td data-label="Type">{r.kind}</td>
              <td className="fin-c-title">{r.party}</td>
              <td className="fin-c-sub">{r.ref}</td>
              <td className="num" data-label="Amount">{money(r.amount, r.currency)}</td>
            </tr>
          ))}
          <tr className="fin-group-sub">
            <td className="fin-foot-name" colSpan={4}>Total · {rows.length} item{rows.length === 1 ? "" : "s"}</td>
            <td className="num" data-label="Amount">{byCurrencyLines(totals)}</td>
          </tr>
          {/* 참고용 KRW 환산 — 오늘자 매매기준율(조회 실패 시 고정환율). 집계에는 쓰지 않는다.
              환산할 것이 없으면(₩만 남은 표) 같은 숫자를 한 줄 더 적을 뿐이라 접는다. */}
          {needsKrwRef(totals) ? (
            <tr className="fin-foot-ref">
              <td className="fin-foot-name" colSpan={4}>
                Total (In KRW · 1 USD = {fx.rate.toLocaleString()}
                {fx.source === "exim" ? ` · 매매기준율 ${fx.date}` : " · fixed rate"})
              </td>
              <td className="num">{won(toKrw(totals, fx.rate))}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </>
  );
}

type InflowView = "receivables" | "income" | "collected";

function InflowTab() {
  const { data, error, refresh } = useCachedData<{ rows: FinanceReceivable[]; fx: FxQuote }>("finance:receivables", fetchFinanceReceivables);
  // 오늘 기준 잔액·연체 — 목록의 합계는 지금 걸러 놓은 행만 세므로 따로 받는다.
  const { data: sum } = useCachedData<FinanceSummary>("finance:summary", () => fetchFinanceSummary());
  // 갈래와 기간은 주소에 산다 — Overview 의 한 줄이 'Inflow 의 Collected, 7월'로
  // 곧장 건너뛰고, 그 화면을 그대로 링크로 넘길 수 있어야 한다.
  const { params, setParams } = useFinanceNav();
  const viewParam = params.get("view") || "";
  const view: InflowView = (["receivables", "income", "collected"] as const).includes(viewParam as InflowView)
    ? (viewParam as InflowView) : "receivables";
  const setView = (v: InflowView) => setParams({ view: v === "receivables" ? "" : v });
  const from = params.get("from") || "";
  const to = params.get("to") || "";
  // 통화도 주소에 산다(갈래·기간과 같은 규약) — '₩만 본 이 화면'을 그대로 넘길 수 있게.
  const cur = asLedgerCur(params.get("cur"));
  // 원장은 기본적으로 전부 보여준다 — 켜 두면 수금이 끝난 청구서가 목록에서 사라져
  // "그 청구서 어디 갔지"가 된다. 미수만 추리고 싶을 때만 사용자가 켠다.
  const [openOnly, setOpenOnly] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<FinanceReceivable | null>(null);
  const [receiving, setReceiving] = useState<{ row: FinanceReceivable; occurrence: string } | null>(null);
  const all = useMemo(() => data?.rows ?? [], [data]);
  const rows = useMemo(() => {
    const src = all
      .filter((r) => (view === "income" ? r.source === "income" : r.source !== "income"))
      .filter((r) => r.currency === cur)
      // 예정 항목은 예정일 기준 — 반복(기타수입)은 회차 하나라도 구간에 들면 남긴다.
      .filter((r) => dueInRange(r, from, to));
    return openOnly ? src.filter((r) => r.outstanding > 0) : src;
  }, [all, view, openOnly, from, to, cur]);
  // 실적은 실제로 오간 날 기준 — 현금흐름이 그 날짜로 세는 것과 같다.
  const settled = useMemo(
    () => receiptRows(all).filter((r) => r.currency === cur && inRange(r.date, from, to)),
    [all, from, to, cur]
  );
  const totals = useMemo(() => receivableTotals(rows), [rows]);
  // 머리 KPI 는 기간·갈래와 무관한 '오늘 기준' 값이지만, 통화는 따른다 — 한 통화만 보기로
  // 해 놓고 그 위에 다른 통화 줄이 남아 있으면 무엇을 보고 있는지가 흐려진다. 건수도 함께
  // 다시 센다(서버가 준 count 는 전 통화 기준이라 그대로 두면 금액과 짝이 맞지 않는다).
  const openCount = useMemo(
    () => all.filter((r) => r.outstanding > 0 && r.currency === cur).length,
    [all, cur]
  );

  function reload() {
    invalidateCache("finance:summary");
    invalidateCache("finance:calendar");
    return refresh();
  }

  async function undoReceived(r: FinanceReceivable, occurrence?: string) {
    await receiveFinanceIncome(r.id, false, occurrence);
    reload();
  }

  async function removeIncome(r: FinanceReceivable) {
    if (!confirm(`Delete income "${r.description || r.counterparty}"?`)) return;
    await deleteFinanceIncome(r.id);
    reload();
  }

  if (error && !data) return <div className="state error">API error: {error.message}</div>;
  if (!data) return <div className="state">Loading…</div>;
  const fx: FxQuote = data.fx ?? { rate: 0, date: "", source: "fixed" };
  const canEdit = can("finance", "create") || can("finance", "edit");
  const hint = view === "receivables"
    ? "Customer invoices arrive here automatically from the project's tax-invoice and collection stages and are read-only — click the invoice number to open that project's billing stage."
    : view === "income"
      ? "Money that is not project sales — interest, refunds, misc — is registered by hand here, and received here too."
      : "Money that has actually arrived, dated on the day it came in. Sales and other income together, newest first.";

  return (
    <div className="panel">
      <div className="items-head">
        <h3 className="form-title fin-page-title" style={{ margin: 0 }}>Inflow</h3>
        <div className="items-head-actions">
          {view !== "collected" ? (
            <label className="check-chip" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Receivable only
            </label>
          ) : null}
          {/* 등록 버튼은 갈래와 무관하게 늘 같은 자리에 둔다 — 수입을 적으려고 먼저
              "Other income" 탭을 찾아 들어가야 했던 걸 없앤다. 저장하면 그 항목이 보이는
              갈래로 옮겨 준다(아래 onSaved). */}
          {can("finance", "create") ? (
            <button className="btn primary sm" onClick={() => setAdding(true)}>+ Add income</button>
          ) : null}
        </div>
      </div>
      {/* 오늘 기준 두 숫자 — 어느 갈래를 보고 있든 같은 값이라 위에 고정해 둔다. */}
      {sum ? (
        <div className="fin-kpis fin-kpis--pair">
          <KpiTile
            label="Receivable"
            main={byCurrencyLines(pickCurrency(sum.receivable.outstanding, cur))}
            sub={`${openCount} open invoices · as of today`}
            tone="blue"
          />
          <KpiTile label="Overdue" main={byCurrencyLines(pickCurrency(sum.receivable.overdue, cur))} sub="past the due date" tone="red" />
        </div>
      ) : null}
      <div className="fin-subtab-bar">
        <div className="seg-toggle fin-subtabs" role="group" aria-label="Inflow view">
          <button className={view === "receivables" ? "on" : ""} onClick={() => setView("receivables")}>Receivables</button>
          <button className={view === "income" ? "on" : ""} onClick={() => setView("income")}>Other income</button>
          <button className={view === "collected" ? "on" : ""} onClick={() => setView("collected")}>Received</button>
        </div>
        {/* 무엇을 걸러 볼지는 오른쪽에 모아 둔다 — 왼쪽 갈래(무엇을 보는가)와 갈라서. */}
        <div className="fin-ledger-filters">
          <LedgerCurrency cur={cur} onChange={(c) => setParams({ cur: c })} />
          <LedgerPeriod from={from} to={to} onChange={(f, t) => setParams({ from: f, to: t })} />
        </div>
      </div>
      <p className="hint-inline" style={{ display: "block", margin: "8px 0 10px" }}>{hint}</p>

      {view === "collected" ? (
        <SettledTable rows={settled} dateLabel="Received" partyLabel="Customer" empty="Nothing received yet." fx={fx} />
      ) : (
        <table className="mini fin-ledger">
          <thead>
            <tr>
              <th className="fin-w-party">Customer</th><th>Invoice No.</th>
              <th className="fin-w-date">Invoice date</th><th className="fin-w-date">Due</th>
              <th className="num fin-w-money">Invoice</th><th className="num fin-w-money">Received</th><th className="num fin-w-money">Receivable</th>
              <th className="fin-w-status">Status</th><th className="fin-w-act" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={9} className="mini-empty">{view === "income" ? "No other income registered." : "No customer invoices to show."}</td></tr>
            ) : null}
            {rows.map((r) => {
              const isIncome = r.source === "income";
              return (
              <tr key={`${r.source || "ar"}-${r.id}`} className={r.overdue ? "fin-overdue" : ""}>
                {/* fin-c-title / fin-c-sub / data-label 은 좁은 화면용 — 거기서 이 행은
                    카드가 되고, 머리줄이 사라진 자리를 칸마다의 이름이 대신한다. */}
                <td className="fin-c-title">{r.customer}</td>
                <td className="fin-c-sub">{isIncome ? (r.invoice_no || r.ci_no || "—") : <ProjectDocLink orderId={r.order_id} rfqId={r.rfq_id} label={r.invoice_no || r.ci_no} />}</td>
                {/* 발행일 — 9단계 대금청구서에 입력한 값. 기타 수입에는 없는 개념. */}
                <td data-label="Invoiced">{r.invoice_date || "—"}</td>
                <td data-label="Due">{r.due_date || "—"}</td>
                <td className="num" data-label="Invoice">{money(r.invoice_amount, r.currency)}</td>
                <td className="num" data-label="Received">{money(r.paid_amount, r.currency)}</td>
                <td className="num" data-label="Receivable">{money(r.outstanding, r.currency)}</td>
                <td data-label="Status">
                  {/* 기타 수입은 이 화면에서 바로 입금 처리(실제 입금일 입력). 기일이 지난
                      건도 눌러야 한다 — 연체 배지만 띄우면 늦게 들어온 돈을 영영 기록할 수
                      없다. 그래서 연체는 배지 대신 이 단추의 색과 이름으로 알린다.
                      프로젝트 매출(AR)은 9~11단계에서 수금하므로 여기서는 읽기전용. */}
                  {isIncome ? (
                    <button
                      type="button"
                      className={`wt-badge fin-paid-toggle${r.paid ? " on" : ""}${r.overdue ? " overdue" : ""}`}
                      title={canEdit ? (r.paid ? "Undo receipt" : r.overdue ? "Record receipt (past due)" : "Record receipt") : ""}
                      disabled={!canEdit}
                      onClick={() =>
                        r.recurrence !== "none"
                          ? setReceiving({ row: r, occurrence: nextUnpaidOccurrence(asPayableLike(r)) })
                          : r.paid
                            ? undoReceived(r)
                            : setReceiving({ row: r, occurrence: r.due_date })
                      }
                    >
                      {r.recurrence !== "none"
                        ? `${(r.paid_dates || []).length} received`
                        : r.paid ? "Received" : r.overdue ? "Overdue" : "Expected"}
                    </button>
                  ) : r.overdue ? (
                    <span className="wt-badge" style={{ background: "#fde2e1", color: "#c0392b" }}>Overdue</span>
                  ) : (
                    AR_STATUS_LABEL[r.status] || r.status
                  )}
                  {r.paid_date ? <span className="fin-paid-on">{r.paid_date}</span> : null}
                </td>
                <td className="fin-c-act">
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    {isIncome ? (
                      <>
                        {can("finance", "edit") ? (
                          <button className="btn tiny" title="Edit" aria-label="Edit" onClick={() => setEditing(r)}>✎</button>
                        ) : null}
                        {can("finance", "delete") ? (
                          <button className="btn tiny danger" title="Delete" aria-label="Delete" onClick={() => removeIncome(r)}>×</button>
                        ) : null}
                      </>
                    ) : (
                      <ProjectDocLink orderId={r.order_id} rfqId={r.rfq_id} label="Project stage 9–11" hint />
                    )}
                  </div>
                </td>
              </tr>
              );
            })}
            <tr className="fin-group-sub">
              <td />
              <td className="fin-foot-name" colSpan={3}>Total</td>
              <td className="num" data-label="Invoice">{byCurrencyLines(totals.invoice)}</td>
              <td className="num" data-label="Received">{byCurrencyLines(totals.paid)}</td>
              <td className="num" data-label="Receivable">{byCurrencyLines(totals.outstanding)}</td>
              <td /><td />
            </tr>
            {/* 참고용 KRW 환산 — 오늘자 매매기준율(조회 실패 시 고정환율). 집계에는 쓰지 않는다.
                ₩ 만 남은 표에서는 접는다(같은 숫자를 한 줄 더 적는 셈이라). */}
            {needsKrwRef(totals.invoice, totals.paid, totals.outstanding) ? (
              <tr className="fin-foot-ref">
                <td />
                <td className="fin-foot-name" colSpan={3}>
                  Total (In KRW · 1 USD = {fx.rate.toLocaleString()}
                  {fx.source === "exim" ? ` · 매매기준율 ${fx.date}` : " · fixed rate"})
                </td>
                <td className="num" data-label="Invoice">{won(toKrw(totals.invoice, fx.rate))}</td>
                <td className="num" data-label="Received">{won(toKrw(totals.paid, fx.rate))}</td>
                <td className="num" data-label="Receivable">{won(toKrw(totals.outstanding, fx.rate))}</td>
                <td /><td />
              </tr>
            ) : null}
          </tbody>
        </table>
      )}

      {receiving ? (
        <ReceiptDateModal
          row={receiving.row}
          occurrence={receiving.occurrence}
          onClose={() => setReceiving(null)}
          onSaved={() => { setReceiving(null); reload(); }}
        />
      ) : null}
      {adding ? (
        // 저장한 항목은 "Other income" 갈래에 들어간다 — 다른 갈래에서 등록했어도
        // 결과가 보이는 곳으로 옮겨 준다(등록하고 아무 일도 안 일어난 것처럼 보이지 않게).
        <IncomeForm
          initial={emptyIncome}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); setView("income"); reload(); }}
        />
      ) : null}
      {editing ? (
        <IncomeForm
          initial={{
            category: editing.category,
            counterparty: editing.counterparty,
            customer_id: editing.customer_id ?? null,
            description: editing.description,
            amount: editing.amount,
            currency: editing.currency,
            due_date: editing.due_date,
            recurrence: editing.recurrence,
            recur_until: editing.recur_until,
            notes: editing.notes,
          }}
          rowId={editing.id}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      ) : null}
    </div>
  );
}

// 기타 수입 등록 기본값 — 지급대장(emptyPayable)의 수입측 대응.
const emptyIncome: FinanceIncomeSave = {
  category: "잡수입",
  counterparty: "",
  customer_id: null,
  description: "",
  amount: 0,
  currency: "KRW",
  due_date: todayStr(),
  recurrence: "none",
  recur_until: "",
  notes: "",
};

/** FinanceReceivable(기타 수입 행) → 반복 회차 계산용 최소 형태. */
function asPayableLike(r: FinanceReceivable): FinancePayable {
  return {
    ...(r as unknown as FinancePayable),
    due_date: r.due_date,
    recurrence: r.recurrence ?? "none",
    recur_until: r.recur_until ?? "",
    paid_dates: r.paid_dates ?? [],
  };
}

/** 입금 기록 — 예정일과 실제 입금일이 다를 수 있어 둘 다 받는다(납부 팝업과 동일). */
function ReceiptDateModal({
  row,
  occurrence,
  onClose,
  onSaved,
}: {
  row: FinanceReceivable;
  occurrence: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const recurring = (row.recurrence ?? "none") !== "none";
  const [occ, setOcc] = useState(occurrence || row.due_date || todayStr());
  const [paidOn, setPaidOn] = useState(todayStr());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    setBusy(true);
    setErr("");
    try {
      await receiveFinanceIncome(row.id, true, recurring ? occ : undefined, paidOn);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
      setBusy(false);
    }
  }

  return (
    <Modal title="Record receipt" onClose={onClose} form maxWidth={340}>
      <div className="fin-pay-form">
        <div className="fin-pay-target">
          {row.description || row.counterparty || row.customer} · {money(row.invoice_amount, row.currency)}
        </div>
        {recurring ? (
          <label className="form-field">
            <span>Scheduled occurrence</span>
            <input type="date" value={occ} onChange={(e) => setOcc(e.target.value)} />
          </label>
        ) : (
          <div className="hint-inline">Expected {row.due_date || "—"}</div>
        )}
        <label className="form-field">
          <span>Receipt date</span>
          <input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </label>
      </div>
      <div className="form-actions">
        {err ? <span className="action-err">{err}</span> : null}
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy || !paidOn}>
          {busy ? "Saving…" : "Mark received"}
        </button>
      </div>
    </Modal>
  );
}

/** 기타 수입 등록/수정 폼 — 지급대장 PayableForm 의 수입측 대응. */
function IncomeForm({
  initial,
  rowId,
  onClose,
  onSaved,
}: {
  initial: FinanceIncomeSave;
  rowId?: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FinanceIncomeSave>({ ...initial });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = <K extends keyof FinanceIncomeSave>(k: K, v: FinanceIncomeSave[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setBusy(true);
    setErr("");
    try {
      if (rowId) await updateFinanceIncome(rowId, form);
      else await createFinanceIncome(form);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
      setBusy(false);
    }
  }

  return (
    <Modal title={rowId ? "Edit income" : "Add income"} onClose={onClose} form>
      <div className="form-grid">
        <label className="form-field">
          <span>Category</span>
          <select value={form.category} onChange={(e) => set("category", e.target.value)}>
            {INCOME_CATEGORIES.map((c) => (
              <option key={c} value={c}>{INCOME_CATEGORY_LABEL[c] || c}</option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span>Payer</span>
          <input value={form.counterparty || ""} onChange={(e) => set("counterparty", e.target.value)} />
        </label>
        <label className="form-field">
          <span>Description</span>
          <input value={form.description || ""} onChange={(e) => set("description", e.target.value)} />
        </label>
        <label className="form-field">
          <span>Amount</span>
          <input
            inputMode="decimal"
            value={amountInputValue(form.amount ?? 0)}
            onChange={(e) => set("amount", parseAmountInput(e.target.value) ?? 0)}
          />
        </label>
        <label className="form-field">
          <span>Currency</span>
          <CurrencyToggle value={form.currency || "KRW"} onChange={(v) => set("currency", v)} />
        </label>
        <label className="form-field">
          <span>Expected date</span>
          <input type="date" value={form.due_date || ""} onChange={(e) => set("due_date", e.target.value)} />
        </label>
        <label className="form-field">
          <span>Recurrence</span>
          <select
            value={form.recurrence}
            onChange={(e) => set("recurrence", e.target.value as FinanceIncomeSave["recurrence"])}
          >
            {(["none", "monthly", "quarterly", "yearly"] as const).map((r) => (
              <option key={r} value={r}>{RECURRENCE_LABEL[r]}</option>
            ))}
          </select>
        </label>
        {form.recurrence !== "none" ? (
          <label className="form-field">
            <span>Repeat until (optional)</span>
            <input type="date" value={form.recur_until || ""} onChange={(e) => set("recur_until", e.target.value)} />
          </label>
        ) : null}
        <label className="form-field" style={{ gridColumn: "1 / -1" }}>
          <span>Notes</span>
          <textarea className="po-textarea small" value={form.notes || ""} onChange={(e) => set("notes", e.target.value)} />
        </label>
      </div>
      <div className="form-actions">
        {err ? <span className="action-err">{err}</span> : null}
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </Modal>
  );
}

// ── Payables (payment ledger) ──────────────────────────────────────────────────
// 등록 버튼이 기타 지출 섹션에 있으므로 기본 분류도 기타 — 거래선지급은 대개
// 프로젝트에서 자동으로 넘어오고, 직접 넣을 때만 분류를 바꾼다.
const emptyPayable: FinancePayableSave = {
  category: "기타",
  counterparty: "",
  vendor_id: null,
  description: "",
  amount: 0,
  vat_amount: 0,
  currency: "KRW",
  bill_date: "",
  due_date: todayStr(),
  recurrence: "none",
  recur_until: "",
  notes: "",
};

type OutflowView = "payables" | "other" | "paid";

function OutflowTab() {
  const { data, error, refresh } = useCachedData<{ rows: FinancePayable[]; fx: FxQuote }>("finance:payables", fetchFinancePayables);
  // 오늘 기준 예정·연체와 분류별 합계 — 목록은 건별이라 이 두 가지를 스스로 답하지 못한다.
  const { data: sum } = useCachedData<FinanceSummary>("finance:summary", () => fetchFinanceSummary());
  // 갈래와 기간은 주소에 산다(Inflow 와 같은 규약).
  const { params, setParams } = useFinanceNav();
  const viewParam = params.get("view") || "";
  const view: OutflowView = (["payables", "other", "paid"] as const).includes(viewParam as OutflowView)
    ? (viewParam as OutflowView) : "payables";
  const setView = (v: OutflowView) => setParams({ view: v === "payables" ? "" : v });
  const from = params.get("from") || "";
  const to = params.get("to") || "";
  // 통화 필터 — Inflow 와 같은 규약(주소의 cur).
  const cur = asLedgerCur(params.get("cur"));
  const [editing, setEditing] = useState<FinancePayable | null>(null);
  const [adding, setAdding] = useState(false);
  // 납부 입력 대상 — 회차일(occurrence)과 실제 납부일을 함께 받는다.
  const [paying, setPaying] = useState<{ row: FinancePayable; occurrence: string } | null>(null);
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const canEdit = can("finance", "create") || can("finance", "edit");
  // 거래(매입) / 기타 지출 두 섹션 — 성격이 다르고 다루는 항목도 달라서 표를 따로 낸다.
  // 벤더 청구서는 프로젝트에서 넘어온 읽기전용(청구서번호·발행일 중심), 기타 지출은
  // 여기서 직접 등록하는 항목(분류·반복 중심)이라 열 구성이 서로 맞지 않는다.
  const [trade, other] = useMemo(() => {
    const isTrade = (p: FinancePayable) => p.source === "ap" || p.category === "거래선지급";
    // 예정 항목은 예정일 기준 — 반복(임차료·급여)은 회차 하나라도 구간에 들면 남긴다.
    const inWindow = rows.filter((p) => p.currency === cur && dueInRange(p, from, to));
    return [inWindow.filter(isTrade), inWindow.filter((p) => !isTrade(p))];
  }, [rows, from, to, cur]);
  // 보고 있는 갈래의 합계 3열(청구·지급·미지급) — 통화별 분리(수입 목록과 같은 규칙).
  const visible = view === "other" ? other : trade;
  const totals = useMemo(() => payableTotals(visible), [visible]);
  // 실적은 실제로 나간 날 기준 — 현금흐름이 그 날짜로 세는 것과 같다.
  const settled = useMemo(
    () => paymentRows(rows).filter((r) => r.currency === cur && inRange(r.date, from, to)),
    [rows, from, to, cur]
  );

  function reload() {
    invalidateCache("finance:summary");
    invalidateCache("finance:calendar");
    return refresh();
  }

  // 납부 처리는 항상 실제 납부일을 받는다(예정일과 다를 수 있음). 취소는 바로 해제.
  async function undoPaid(p: FinancePayable, occurrence?: string) {
    await payFinancePayable(p.id, false, occurrence);
    reload();
  }

  async function remove(p: FinancePayable) {
    if (!confirm(`Delete payable "${p.description || p.counterparty}"?`)) return;
    await deleteFinancePayable(p.id);
    reload();
  }

  if (error && !data) return <div className="state error">API error: {error.message}</div>;
  if (!data) return <div className="state">Loading…</div>;
  const fx: FxQuote = data.fx ?? { rate: 0, date: "", source: "fixed" };

  /** 상태 칸 — 두 표가 공유. AP(프로젝트 유래)는 읽기전용 배지, 수동 등록은 납부 토글.
      말은 수입 목록과 짝을 이룬다: 기일 전이면 Payable(저쪽은 Receivable), 지났으면
      Overdue, 끝났으면 Paid(저쪽은 Received). */
  function statusCell(p: FinancePayable) {
    const isAp = p.source === "ap";
    const late = !!p.overdue && !p.paid;
    return (
      <td data-label="Status">
        {isAp ? (
          // 벤더 청구서도 기타 지출과 같은 칩으로 보여준다 — 다만 지급 기록은
          // 프로젝트 11단계 AP 탭의 Payment 칸에서 하므로 여기서는 누를 수 없다.
          <button
            type="button"
            className={`wt-badge fin-paid-toggle${p.paid ? " on" : ""}${late ? " overdue" : ""}`}
            title="Record the payment in the project's stage 11 Payable (AP)"
            disabled
          >
            {p.paid
              ? "Paid"
              : late
                ? p.paid_amount > 0 ? "Partly paid · overdue" : "Overdue"
                : p.paid_amount > 0 ? "Partly paid" : "Payable"}
          </button>
        ) : p.recurrence === "none" ? (
          <button
            type="button"
            className={`wt-badge fin-paid-toggle${p.paid ? " on" : ""}${late ? " overdue" : ""}`}
            title={canEdit ? (p.paid ? "Undo payment" : late ? "Record payment (past due)" : "Record payment") : ""}
            disabled={!canEdit}
            onClick={() => (p.paid ? undoPaid(p) : setPaying({ row: p, occurrence: p.due_date }))}
          >
            {p.paid ? "Paid" : late ? "Overdue" : "Payable"}
          </button>
        ) : (
          <button
            type="button"
            className={`wt-badge fin-paid-toggle${late ? " overdue" : ""}`}
            title={canEdit ? (late ? "Record a payment (an occurrence is past due)" : "Record a payment for one occurrence") : ""}
            disabled={!canEdit}
            onClick={() => setPaying({ row: p, occurrence: nextUnpaidOccurrence(p) })}
          >
            {p.paid_dates.length} paid{late ? " · overdue" : ""}
          </button>
        )}
        {/* 지급 완료 건은 실제 납부일을 상태 옆에 함께 보여준다(미수 목록과 동일). */}
        {p.paid_date ? <span className="fin-paid-on">{p.paid_date}</span> : null}
      </td>
    );
  }

  /** 반복 칸 — 수동 등록 항목의 주기(+종료일). AP 는 1회성이라 그대로 One-time. */
  function recurrenceCell(p: FinancePayable) {
    return (
      <td data-label="Recurrence">
        {RECURRENCE_LABEL[p.recurrence] || p.recurrence}
        {p.recurrence !== "none" && p.recur_until ? <div className="muted">until {p.recur_until}</div> : null}
      </td>
    );
  }

  /** 조작 칸 — AP 는 프로젝트 단계로 가는 안내 링크, 수동 등록은 수정/삭제 아이콘. */
  function actionCell(p: FinancePayable) {
    return (
      <td className="fin-c-act">
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          {p.source === "ap" ? (
            <ProjectDocLink orderId={p.order_id} rfqId={p.rfq_id} label="Project stage 11" hint apPoId={p.po_id} />
          ) : (
            <>
              {can("finance", "edit") ? (
                <button className="btn tiny" title="Edit" aria-label="Edit" onClick={() => setEditing(p)}>✎</button>
              ) : null}
              {can("finance", "delete") ? (
                <button className="btn tiny danger" title="Delete" aria-label="Delete" onClick={() => remove(p)}>×</button>
              ) : null}
            </>
          )}
        </div>
      </td>
    );
  }

  return (
    <div className="panel">
      <div className="items-head">
        <h3 className="form-title fin-page-title" style={{ margin: 0 }}>Outflow</h3>
        <div className="items-head-actions">
          {/* 등록 버튼은 갈래와 무관하게 늘 같은 자리에 둔다 — 지출을 적으려고 먼저
              "Other costs" 탭으로 옮겨 가야 했던 걸 없앤다. 저장하면 그 항목이 실제로
              보이는 갈래로 옮겨 준다(아래 onSaved). */}
          {can("finance", "create") ? (
            <button className="btn primary sm" onClick={() => setAdding(true)}>+ Add payable</button>
          ) : null}
        </div>
      </div>
      {/* 오늘 기준 두 숫자 — 어느 갈래를 보고 있든 같은 값이라 위에 고정해 둔다. */}
      {sum ? (
        <div className="fin-kpis fin-kpis--pair">
          {/* 기간·갈래와 무관한 '오늘 기준' 값이지만 통화 필터는 따른다(Inflow 와 같은 이유). */}
          <KpiTile
            label="Due in 30 days + overdue"
            main={byCurrencyLines(pickCurrency(sum.payable.total, cur))}
            sub={`Next 30 days ${byCurrency(pickCurrency(sum.payable.upcoming_30d, cur))}`}
            tone="amber"
          />
          <KpiTile label="Overdue" main={byCurrencyLines(pickCurrency(sum.payable.overdue, cur))} sub="past the due date" tone="red" />
        </div>
      ) : null}
      <div className="fin-subtab-bar">
        <div className="seg-toggle fin-subtabs" role="group" aria-label="Outflow view">
          <button className={view === "payables" ? "on" : ""} onClick={() => setView("payables")}>Payables</button>
          <button className={view === "other" ? "on" : ""} onClick={() => setView("other")}>Other costs</button>
          <button className={view === "paid" ? "on" : ""} onClick={() => setView("paid")}>Paid</button>
        </div>
        {/* 무엇을 걸러 볼지는 오른쪽에 모아 둔다 — 왼쪽 갈래(무엇을 보는가)와 갈라서. */}
        <div className="fin-ledger-filters">
          <LedgerCurrency cur={cur} onChange={(c) => setParams({ cur: c })} />
          <LedgerPeriod from={from} to={to} onChange={(f, t) => setParams({ from: f, to: t })} />
        </div>
      </div>
      <p className="hint-inline" style={{ display: "block", margin: "8px 0 10px" }}>
        {view === "payables"
          ? "Vendor bills arrive here automatically from the project's billing stages and are read-only — click the bill number to open that project's stage 11 Payable (AP), where the payment is confirmed. Payments registered by hand under the vendor-payment category sit here too."
          : view === "other"
            ? "The company's own costs — rent, payroll, utilities, taxes — are registered by hand here; monthly/quarterly/yearly items appear as occurrences on the calendar."
            : "Money that has actually left, dated on the day it went out. Vendor bills and other costs together, newest first."}
      </p>

      {view === "paid" ? (
        <SettledTable rows={settled} dateLabel="Paid" partyLabel="Vendor / payee" empty="Nothing paid yet." fx={fx} />
      ) : view === "payables" ? (
      <section className="fin-sec">
        {/* 행이 없어도 표(머리행)는 남긴다 — 어떤 항목이 들어오는 자리인지 보이도록. */}
        <table className="mini fin-ledger">
          <thead>
            <tr>
              <th className="fin-w-cat">Category</th><th className="fin-w-party">Vendor</th><th>Bill No. / Vendor P/O</th><th className="fin-w-date">Bill date</th><th className="fin-w-date">Due</th>
              <th className="num fin-w-money">Bill</th><th className="num fin-w-money">Paid</th><th className="num fin-w-money">Payable</th>
              <th className="fin-w-status">Status</th><th className="fin-w-rec">Recurrence</th><th className="fin-w-act" />
            </tr>
          </thead>
          <tbody>
            {trade.length === 0 ? (
              <tr><td colSpan={11} className="mini-empty">No vendor bills yet.</td></tr>
            ) : null}
            {trade.map((p) => (
              <tr key={`${p.source || "manual"}-${p.id}`} className={p.overdue && !p.paid ? "fin-overdue" : ""}>
                <td data-label="Category">{CATEGORY_LABEL[p.category] || p.category}</td>
                <td className="fin-c-title">{p.counterparty || "—"}</td>
                {/* 청구서 번호 = 미수 목록의 Invoice No. 자리. AP 행은 그 아래 벤더 P/O 를
                    옅게 덧붙인다(번호가 아직 없으면 P/O 만 보인다). 수동 등록은 적요. */}
                <td className="fin-c-sub">
                  {p.source === "ap" ? (
                    <>
                      <ProjectDocLink orderId={p.order_id} rfqId={p.rfq_id} label={p.description} apPoId={p.po_id} />
                      {p.po_no && p.po_no !== p.description ? <div className="muted">{p.po_no}</div> : null}
                    </>
                  ) : (
                    p.description || "—"
                  )}
                </td>
                <td data-label="Billed">{p.bill_date || "—"}</td>
                <td data-label="Due">{p.due_date || "—"}</td>
                <td className="num" data-label="Bill">{money(p.invoice_amount, p.currency)}</td>
                <td className="num" data-label="Paid">{money(p.paid_amount, p.currency)}</td>
                <td className="num" data-label="Payable">{money(p.outstanding, p.currency)}</td>
                {statusCell(p)}
                {recurrenceCell(p)}
                {actionCell(p)}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      ) : (
      <section className="fin-sec">
        {/* 행이 없어도 표(머리행)는 남긴다 — 등록 버튼이 무엇을 만드는지 열 이름으로 보인다. */}
        <table className="mini fin-ledger">
          <thead>
            {/* 열 자리는 위 표와 동일 — 이름만 이 표의 항목에 맞춘다(등록 폼의 입력칸과 1:1). */}
            <tr>
              <th className="fin-w-cat">Category</th><th className="fin-w-party">Vendor / payee</th><th>Description</th><th className="fin-w-date">Bill date</th><th className="fin-w-date">Due</th>
              <th className="num fin-w-money">Amount</th><th className="num fin-w-money">Paid</th><th className="num fin-w-money">Payable</th>
              <th className="fin-w-status">Status</th><th className="fin-w-rec">Recurrence</th><th className="fin-w-act" />
            </tr>
          </thead>
          <tbody>
            {other.length === 0 ? (
              <tr><td colSpan={11} className="mini-empty">No other costs registered.</td></tr>
            ) : null}
            {other.map((p) => (
              <tr key={`${p.source || "manual"}-${p.id}`} className={p.overdue && !p.paid ? "fin-overdue" : ""}>
                <td data-label="Category">{CATEGORY_LABEL[p.category] || p.category}</td>
                <td className="fin-c-title">{p.counterparty || "—"}</td>
                {/* 메모는 별도 열까지 둘 만큼 길지 않아 적요 아래 옅게 붙인다. */}
                <td className="fin-c-sub">
                  {p.description || "—"}
                  {p.notes ? <div className="muted">{p.notes}</div> : null}
                </td>
                <td data-label="Billed">{p.bill_date || "—"}</td>
                <td data-label="Due">{p.due_date || "—"}</td>
                {/* 총액 아래에 그 안의 부가세를 옅게 — 결산의 매입세액으로 넘어가는 값이라
                    목록에서 바로 확인할 수 있어야 한다. */}
                <td className="num" data-label="Amount">
                  {money(p.invoice_amount, p.currency)}
                  {p.vat_amount ? <div className="muted">VAT {money(p.vat_amount, p.currency)}</div> : null}
                </td>
                <td className="num" data-label="Paid">{money(p.paid_amount, p.currency)}</td>
                <td className="num" data-label="Payable">{money(p.outstanding, p.currency)}</td>
                {statusCell(p)}
                {recurrenceCell(p)}
                {actionCell(p)}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      )}

      {/* ── 합계 — 보고 있는 표의 금액. 열 폭을 위 표와 맞춰 같은 자리에서 끝난다. ── */}
      {view === "paid" || visible.length === 0 ? null : (
        <table className="mini fin-ledger fin-ledger-total">
          <colgroup>
            <col />
            <col className="fin-w-money" /><col className="fin-w-money" /><col className="fin-w-money" />
            <col className="fin-w-status" /><col className="fin-w-rec" /><col className="fin-w-act" />
          </colgroup>
          <tfoot>
            <tr className="foot-grand fin-foot-total">
              <td className="total-label fin-foot-name">Total</td>
              <td className="num total-value" data-label="Amount">{byCurrencyLines(totals.invoice)}</td>
              <td className="num total-value" data-label="Paid">{byCurrencyLines(totals.paid)}</td>
              <td className="num total-value" data-label="Payable">{byCurrencyLines(totals.outstanding)}</td>
              <td /><td /><td />
            </tr>
            {/* 참고용 KRW 환산 — 오늘자 매매기준율(조회 실패 시 고정환율). 집계에는 쓰지 않는다.
                ₩ 만 남은 표에서는 접는다(같은 숫자를 한 줄 더 적는 셈이라). */}
            {needsKrwRef(totals.invoice, totals.paid, totals.outstanding) ? (
              <tr className="fin-foot-ref">
                <td className="fin-foot-name">
                  Total (In KRW · 1 USD = {fx.rate.toLocaleString()}
                  {fx.source === "exim" ? ` · 매매기준율 ${fx.date}` : " · fixed rate"})
                </td>
                <td className="num" data-label="Amount">{won(toKrw(totals.invoice, fx.rate))}</td>
                <td className="num" data-label="Paid">{won(toKrw(totals.paid, fx.rate))}</td>
                <td className="num" data-label="Payable">{won(toKrw(totals.outstanding, fx.rate))}</td>
                <td /><td /><td />
              </tr>
            ) : null}
          </tfoot>
        </table>
      )}

      {paying ? (
        <PaymentDateModal
          row={paying.row}
          occurrence={paying.occurrence}
          onClose={() => setPaying(null)}
          onSaved={() => { setPaying(null); reload(); }}
        />
      ) : null}
      {adding ? (
        // 손으로 등록한 지출은 분류가 '거래선지급'이면 Payables, 그 외에는 Other costs 로
        // 들어간다 — 저장 뒤 그 갈래로 옮겨 방금 넣은 항목이 바로 보이게 한다.
        <PayableForm
          initial={emptyPayable}
          onClose={() => setAdding(false)}
          onSaved={(category) => {
            setAdding(false);
            setView(category === "거래선지급" ? "payables" : "other");
            reload();
          }}
        />
      ) : null}
      {editing ? (
        <PayableForm
          initial={editing}
          rowId={editing.id}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      ) : null}
    </div>
  );
}

/** 지급 목록 합계 — 청구·지급·미지급 3열을 통화별로 모은다. */
function payableTotals(rows: FinancePayable[]) {
  const t = { invoice: {} as MoneyByCurrency, paid: {} as MoneyByCurrency, outstanding: {} as MoneyByCurrency };
  for (const p of rows) {
    t.invoice[p.currency] = (t.invoice[p.currency] || 0) + p.invoice_amount;
    t.paid[p.currency] = (t.paid[p.currency] || 0) + p.paid_amount;
    t.outstanding[p.currency] = (t.outstanding[p.currency] || 0) + p.outstanding;
  }
  return t;
}

/** 반복 항목의 다음 미납 회차일 — due_date 에서 주기만큼 더해가며 첫 미납 회차를 찾는다. */
function nextUnpaidOccurrence(p: FinancePayable): string {
  const step = p.recurrence === "monthly" ? 1 : p.recurrence === "quarterly" ? 3 : 12;
  const paid = new Set(p.paid_dates || []);
  const first = p.due_date || todayStr();
  const [y, m, d] = first.split("-").map(Number);
  for (let i = 0; i < 60; i += 1) {
    const dt = new Date(y, m - 1 + step * i, 1);
    // 말일 보정 — 그 달에 없는 날짜(31일 등)는 말일로 맞춘다(서버 규칙과 동일).
    const last = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
    dt.setDate(Math.min(d, last));
    const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    if (p.recur_until && iso > p.recur_until) break;
    if (!paid.has(iso)) return iso;
  }
  return first;
}

/** 납부 기록 — 예정일(회차일)과 실제 납부일이 다를 수 있어 둘 다 받는다. */
function PaymentDateModal({
  row,
  occurrence,
  onClose,
  onSaved,
}: {
  row: FinancePayable;
  occurrence: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const recurring = row.recurrence !== "none";
  const [occ, setOcc] = useState(occurrence || row.due_date || todayStr());
  const [paidOn, setPaidOn] = useState(todayStr());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    setBusy(true);
    setErr("");
    try {
      await payFinancePayable(row.id, true, recurring ? occ : undefined, paidOn);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
      setBusy(false);
    }
  }

  return (
    <Modal title="Record payment" onClose={onClose} form maxWidth={340}>
      <div className="fin-pay-form">
        <div className="fin-pay-target">
          {row.description || row.counterparty || "—"} · {money(row.amount, row.currency)}
        </div>
        {recurring ? (
          <label className="form-field">
            <span>Scheduled occurrence</span>
            <input type="date" value={occ} onChange={(e) => setOcc(e.target.value)} />
          </label>
        ) : (
          <div className="hint-inline">Scheduled {row.due_date || "—"}</div>
        )}
        <label className="form-field">
          <span>Payment date</span>
          <input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </label>
      </div>
      <div className="form-actions">
        {err ? <span className="action-err">{err}</span> : null}
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy || !paidOn}>
          {busy ? "Saving…" : "Mark paid"}
        </button>
      </div>
    </Modal>
  );
}

/** 분류·통화로 정하는 기본 부가세율 — 급여·세금(납부한 세금)과 외화 건은 매입세액이 없어 0.
 *  그 밖은 10%. 어디까지나 처음 채워 주는 값이고, 실제 세율은 폼에서 직접 고른다. */
function autoVatRate(category: string, currency: string): number {
  if ((currency || "KRW").toUpperCase() !== "KRW") return 0;
  return category === "급여" || category === "세금" ? 0 : 0.1;
}

/** 부가세 입력 방식 — 세율을 고르거나("0.1"·"0"), 금액을 직접 넣는다("custom").
 *  급여·경비 클레임처럼 부가세가 아예 없는 지출이 흔해 0% 를 한 번에 고를 수 있어야 한다. */
type VatChoice = "0.1" | "0" | "custom";
const VAT_CHOICES: { value: VatChoice; label: string }[] = [
  { value: "0.1", label: "10%" },
  { value: "0", label: "0% · none" },
  { value: "custom", label: "Custom" },
];
const rateChoice = (rate: number): VatChoice => (rate === 0.1 ? "0.1" : rate === 0 ? "0" : "custom");

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
/** 저장은 총액(amount)이 기준 — 공급가액은 총액에서 부가세를 뺀 나머지로 되돌린다. */
const supplyOf = (f: FinancePayableSave) => round2((f.amount || 0) - (f.vat_amount || 0));

function PayableForm({
  initial,
  rowId,
  onClose,
  onSaved,
}: {
  initial: FinancePayableSave;
  rowId?: number;
  onClose: () => void;
  /** 저장한 분류를 넘겨준다 — 목록이 그 항목이 실제로 보이는 갈래로 옮겨 가는 데 쓴다. */
  onSaved: (category: string) => void;
}) {
  const [form, setForm] = useState<FinancePayableSave>({ ...initial });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // 부가세율 — 신규는 분류·통화의 기본율에서 시작하고, 수정은 저장된 금액에서 되읽는다
  // (10%로 딱 떨어지면 10%, 0이면 0%, 그 밖은 직접 입력으로 본다).
  const [vatChoice, setVatChoice] = useState<VatChoice>(() => {
    if (!rowId) return rateChoice(autoVatRate(initial.category || "기타", initial.currency || "KRW"));
    const s = supplyOf(initial);
    const v = initial.vat_amount || 0;
    if (v === 0) return "0";
    return s > 0 && Math.abs(v - Math.round(s * 0.1)) <= 1 ? "0.1" : "custom";
  });
  const { data: vendors } = useCachedData("settings:vendors-opt", fetchVendors);

  function set<K extends keyof FinancePayableSave>(k: K, v: FinancePayableSave[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  /** 공급가액·부가세를 총액(amount)과 부가세로 접어 넣는다 — 총액 = 공급가액 + 부가세. */
  function withMoney(f: FinancePayableSave, supply: number, vat: number): FinancePayableSave {
    const v = round2(Math.max(0, vat));
    return { ...f, amount: round2(round2(supply) + v), vat_amount: v };
  }

  /** 고른 세율로 부가세를 다시 계산 — 공급가액은 그대로 두고 총액만 다시 합친다. */
  function withRate(f: FinancePayableSave, rate: number): FinancePayableSave {
    const s = supplyOf(f);
    return withMoney(f, s, Math.round(s * rate));
  }

  /** 분류·통화를 바꿨을 때 — 직접 입력이 아니면 그쪽 기본율(급여·외화는 0)로 따라간다.
   *  세율 선택도 함께 옮겨 화면에 보이는 값과 실제 계산이 어긋나지 않게 한다. */
  function applyCategoryOrCurrency(next: FinancePayableSave) {
    if (vatChoice === "custom") {
      setForm(next);
      return;
    }
    const rate = autoVatRate(next.category || "기타", next.currency || "KRW");
    setVatChoice(rateChoice(rate));
    setForm(withRate(next, rate));
  }

  const supply = supplyOf(form);
  const vat = form.vat_amount || 0;

  async function save() {
    if (!(form.due_date || "").trim()) { setErr("Enter a due date."); return; }
    if (!(form.description || "").trim() && !(form.counterparty || "").trim()) {
      setErr("Enter a description or counterparty."); return;
    }
    setBusy(true); setErr("");
    try {
      if (rowId) await updateFinancePayable(rowId, form);
      else await createFinancePayable(form);
      // 저장한 분류를 함께 알려 준다 — 목록이 이 항목이 들어간 갈래로 옮겨 갈 수 있게.
      onSaved(form.category || "");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={rowId ? "Edit payable" : "Add payable"} onClose={onClose} form>
      <div className="form-grid">
        <label className="form-field">
          <span>Category</span>
          <select
            value={form.category}
            onChange={(e) => applyCategoryOrCurrency({ ...form, category: e.target.value })}
          >
            {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c] || c}</option>)}
          </select>
        </label>
        <label className="form-field">
          <span>Vendor link (optional)</span>
          <select
            value={form.vendor_id ?? ""}
            onChange={(e) => {
              const id = e.target.value ? Number(e.target.value) : null;
              const v = (vendors ?? []).find((x) => x.id === id);
              setForm((f) => ({ ...f, vendor_id: id, counterparty: v ? v.name : f.counterparty }));
            }}
          >
            <option value="">— Manual entry —</option>
            {(vendors ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
        <label className="form-field">
          <span>Vendor / payee</span>
          <input value={form.counterparty} onChange={(e) => set("counterparty", e.target.value)} placeholder="e.g. Landlord / Payroll" />
        </label>
        <label className="form-field">
          <span>Description</span>
          <input value={form.description} onChange={(e) => set("description", e.target.value)} />
        </label>
        {/* 공급가액·부가세를 나눠 받는다 — 결산의 부가세 계산이 추정 없이 이 값을 쓴다.
            저장은 총액(amount)과 그 안의 부가세(vat_amount)로, 공급가액은 그 차액이다. */}
        <label className="form-field">
          <span>Supply value</span>
          <input
            className="num"
            inputMode="decimal"
            value={amountInputValue(supply)}
            onChange={(e) => {
              const s = parseAmountInput(e.target.value) ?? 0;
              // 세율을 골라 둔 상태면 공급가액이 바뀔 때 부가세도 그 비율로 따라간다.
              setForm((f) => withMoney(f, s, vatChoice === "custom" ? (f.vat_amount || 0) : Math.round(s * Number(vatChoice))));
            }}
          />
        </label>
        {/* 부가세 — 세율을 직접 고른다. 급여·경비 클레임처럼 부가세가 없는 지출은 0%,
            면세·불공제·끝수 조정처럼 비율로 안 떨어지는 건만 Custom 으로 금액을 넣는다.
            (라벨 안에 select 를 두면 클릭이 금액 칸으로 새므로 div 로 짠다.) */}
        <div className="form-field">
          <span className="fin-vat-label">
            VAT
            <select
              className="fin-vat-rate"
              value={vatChoice}
              aria-label="VAT rate"
              onChange={(e) => {
                const v = e.target.value as VatChoice;
                setVatChoice(v);
                if (v !== "custom") setForm((f) => withRate(f, Number(v)));
              }}
            >
              {VAT_CHOICES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </span>
          <input
            className="num"
            inputMode="decimal"
            value={amountInputValue(vat)}
            title={vatChoice === "custom" ? "" : "Set the rate to Custom to type a VAT amount that is not a plain percentage."}
            onChange={(e) => {
              // 금액을 직접 고치면 세율 선택도 Custom 으로 넘어간다(값이 덮어써지지 않게).
              setVatChoice("custom");
              const v = parseAmountInput(e.target.value) ?? 0;
              setForm((f) => withMoney(f, supplyOf(f), v));
            }}
          />
        </div>
        <label className="form-field">
          <span>Total (paid)</span>
          <input className="num fin-total-ro" value={amountInputValue(form.amount)} readOnly tabIndex={-1} />
        </label>
        <label className="form-field">
          <span>Currency</span>
          <CurrencyToggle value={form.currency || "KRW"} onChange={(v) => applyCategoryOrCurrency({ ...form, currency: v })} />
        </label>
        <label className="form-field">
          {/* 고지서·계산서를 받은 날(선택). 벤더 청구서의 발행일과 같은 뜻이라 목록에서 한 열에 모인다. */}
          <span>Bill date (optional)</span>
          <input type="date" value={form.bill_date || ""} onChange={(e) => set("bill_date", e.target.value)} />
        </label>
        <label className="form-field">
          <span>Due date{form.recurrence !== "none" ? " · first occurrence" : ""}</span>
          <input type="date" value={form.due_date} onChange={(e) => set("due_date", e.target.value)} />
        </label>
        <label className="form-field">
          <span>Recurrence</span>
          <select value={form.recurrence} onChange={(e) => set("recurrence", e.target.value)}>
            {Object.entries(RECURRENCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        {form.recurrence !== "none" ? (
          <label className="form-field">
            <span>Repeat until (optional)</span>
            <input type="date" value={form.recur_until} onChange={(e) => set("recur_until", e.target.value)} />
          </label>
        ) : null}
      </div>
      <label className="form-field" style={{ marginTop: 10 }}>
        <span>Notes</span>
        <textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
      </label>
      <p className="hint-inline" style={{ display: "block", marginTop: 8 }}>
        Enter the supply value and pick the VAT rate as printed on the tax invoice — the total is what you actually
        pay, and the VAT feeds the input VAT on Closing · VAT. Payroll, expense claims, tax payments and
        foreign-currency items carry no VAT, so put those at 0%.
      </p>
      <div className="form-actions">
        <button className="btn primary" disabled={busy} onClick={save}>{busy ? "Working…" : "Save"}</button>
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </Modal>
  );
}

// ── Closing · VAT ──────────────────────────────────────────────────────────────
type PeriodType = "month" | "quarter" | "half" | "year";

function periodRange(type: PeriodType, year: number, idx: number): { start: string; end: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate(); // m: 1-12
  if (type === "year") return { start: `${year}-01-01`, end: `${year}-12-31` };
  if (type === "half") {
    return idx === 0
      ? { start: `${year}-01-01`, end: `${year}-06-30` }
      : { start: `${year}-07-01`, end: `${year}-12-31` };
  }
  if (type === "quarter") {
    const sm = idx * 3 + 1;
    const em = sm + 2;
    return { start: `${year}-${pad(sm)}-01`, end: `${year}-${pad(em)}-${lastDay(year, em)}` };
  }
  const m = idx + 1; // month
  return { start: `${year}-${pad(m)}-01`, end: `${year}-${pad(m)}-${lastDay(year, m)}` };
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function ClosingTab() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [type, setType] = useState<PeriodType>("month");
  const [idx, setIdx] = useState(now.getMonth()); // month index by default

  const subOptions = useMemo(() => {
    if (type === "year") return ["Full year"];
    if (type === "half") return ["First half", "Second half"];
    if (type === "quarter") return ["Q1", "Q2", "Q3", "Q4"];
    return MONTH_ABBR.slice();
  }, [type]);

  const safeIdx = Math.min(idx, subOptions.length - 1);
  const range = periodRange(type, year, safeIdx);
  const key = `finance:closing:${range.start}:${range.end}:${year}`;
  const { data, error } = useCachedData<FinanceClosing>(key, () => fetchFinanceClosing(range.start, range.end, year));

  const years = Array.from({ length: 6 }, (_, i) => now.getFullYear() - i);

  return (
    <div className="fin-overview">
      <div className="fin-period-bar">
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <div className="seg-toggle" role="group" aria-label="Period type">
          {([["month", "Monthly"], ["quarter", "Quarterly"], ["half", "Half"], ["year", "Yearly"]] as [PeriodType, string][]).map(([t, label]) => (
            <button key={t} className={type === t ? "on" : ""} onClick={() => { setType(t); setIdx(0); }}>{label}</button>
          ))}
        </div>
        {type !== "year" ? (
          <select value={safeIdx} onChange={(e) => setIdx(Number(e.target.value))}>
            {subOptions.map((o, i) => <option key={o} value={i}>{o}</option>)}
          </select>
        ) : null}
        <span className="fin-period-range">{range.start} ~ {range.end}</span>
      </div>

      {error && !data ? <div className="state error">API error: {error.message}</div> : null}
      {!data ? <div className="state">Loading…</div> : (
        <>
          <div className="fin-kpis">
            <KpiTile label="Sales (supply value)" main={won(data.sales.supply_krw)} sub={`${data.sales.count} · VAT ${won(data.sales.vat_krw)}`} tone="blue" />
            <KpiTile label="Purchases (cost)" main={won(data.purchase.cost_krw)} sub={`${data.purchase.count} · est. input VAT ${won(data.purchase.vat_krw)}`} tone="amber" />
            <KpiTile label="Gross profit (margin)" main={won(data.margin_krw)} sub={`Margin ${data.margin_pct}%`} tone="blue" />
            <KpiTile
              label={data.vat.payable_krw >= 0 ? "VAT payable (est.)" : "VAT refund (est.)"}
              main={won(Math.abs(data.vat.payable_krw))}
              sub={`Output VAT ${won(data.vat.output_krw)} − Input VAT ${won(data.vat.input_krw)}`}
              tone={data.vat.payable_krw >= 0 ? "red" : "blue"}
            />
          </div>

          <div className="panel">
            {/* 두 계열이 색으로만 갈리므로 제목 줄에 범례를 함께 둔다(캘린더와 같은 자리·모양). */}
            <div className="items-head">
              <h3 className="form-title" style={{ margin: 0 }}>Monthly sales · purchases ({year}, ₩)</h3>
              <div className="fin-legend">
                <span className="fin-legend-item"><span className="fin-dot fin-dot--sales" /> Sales (supply value)</span>
                <span className="fin-legend-item"><span className="fin-dot fin-dot--purchase" /> Purchases (cost)</span>
              </div>
            </div>
            <MonthlyBars labels={data.monthly.labels} sales={data.monthly.sales} purchase={data.monthly.purchase} />
          </div>

          <div className="fin-overview-cols">
            <div className="panel">
              <h3 className="form-title">VAT calculation</h3>
              <table className="mini">
                <tbody>
                  <tr><td>Output VAT</td><td className="num">{won(data.vat.output_krw)}</td></tr>
                  {/* 매입세액은 두 갈래 — 프로젝트 매입(원가의 10% 추정)과 기타 지출(입력값). */}
                  <tr><td>Input VAT · purchases (est.)</td><td className="num">− {won(data.vat.input_purchase_krw ?? data.vat.input_krw)}</td></tr>
                  <tr>
                    <td>
                      Input VAT · other costs
                      {data.other_costs ? <span className="muted"> ({data.other_costs.count})</span> : null}
                    </td>
                    <td className="num">− {won(data.vat.input_other_krw ?? 0)}</td>
                  </tr>
                  <tr className="foot-grand">
                    <td className="total-label">{data.vat.payable_krw >= 0 ? "Payable" : "Refund"}</td>
                    <td className="num total-value">{won(Math.abs(data.vat.payable_krw))}</td>
                  </tr>
                </tbody>
              </table>
              <p className="hint-inline" style={{ display: "block", marginTop: 8 }}>
                Exports (zero-rated) carry 0 output VAT. Purchase input VAT is estimated as 10% of domestic purchase cost;
                other costs use the VAT entered on each payable, so register rent, utilities and the like with the supply
                value and VAT split (actual filing is based on tax invoices).
              </p>
            </div>
            <div className="panel">
              <h3 className="form-title">Sales by customer (Top)</h3>
              {data.by_customer.length === 0 ? (
                <div className="muted">No sales in this period.</div>
              ) : (
                <table className="mini">
                  <thead><tr><th>Customer</th><th className="num">Sales (supply, ₩)</th></tr></thead>
                  <tbody>
                    {data.by_customer.map((r) => (
                      <tr key={r.name}><td>{r.name}</td><td className="num">{won(r.sales_krw)}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MonthlyBars({ labels, sales, purchase }: { labels: string[]; sales: number[]; purchase: number[] }) {
  const max = Math.max(1, ...sales, ...purchase);
  return (
    <div className="fin-bars">
      {labels.map((lab, i) => (
        <div key={lab} className="fin-bar-col" title={`${lab} · Sales ${won(sales[i])} · Purchases ${won(purchase[i])}`}>
          <div className="fin-bar-stack">
            <div className="fin-bar sales" style={{ height: `${(sales[i] / max) * 100}%` }} />
            <div className="fin-bar purchase" style={{ height: `${(purchase[i] / max) * 100}%` }} />
          </div>
          <div className="fin-bar-label">{lab}</div>
        </div>
      ))}
    </div>
  );
}

// ── Calendar ─────────────────────────────────────────────────────────────────
const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function CalendarTab() {
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() }; // m: 0-11
  });

  // Grid range (Sunday of the first week … Saturday of the last week).
  const grid = useMemo(() => buildMonthGrid(month.y, month.m), [month]);
  const rangeKey = `finance:calendar:${grid.start}:${grid.end}`;
  const { data, error, refresh } = useCachedData(rangeKey, () => fetchFinanceCalendar(grid.start, grid.end));

  const byDate = useMemo(() => {
    const map = new Map<string, FinanceCalendarEvent[]>();
    for (const e of data?.rows ?? []) {
      const arr = map.get(e.date) ?? [];
      arr.push(e);
      map.set(e.date, arr);
    }
    return map;
  }, [data]);

  // 프로젝트 단계에서 관리하는 청구·수금(AR/AP)은 캘린더에서 못 누른다 — 눌리는 것처럼
  // 보이지 않게 커서·호버를 죽인다(수금은 원래 그랬고, 지급도 같은 규칙).
  const readOnlyEvent = (e: FinanceCalendarEvent) =>
    e.kind === "receivable" || e.source === "ap" || !can("finance", "edit");

  // 납부 처리는 실제 납부일을 받아야 하므로 입력창을 띄운다(해제는 즉시).
  const [payingEvent, setPayingEvent] = useState<FinanceCalendarEvent | null>(null);
  const [paidOn, setPaidOn] = useState(todayStr());

  async function togglePayable(e: FinanceCalendarEvent) {
    if (e.kind !== "payable" || !can("finance", "edit")) return;
    if (e.source === "ap") return;   // 매입(AP) 이벤트는 읽기전용(프로젝트 단계에서 관리)
    if (!e.paid) {
      setPaidOn(todayStr());
      setPayingEvent(e);
      return;
    }
    await payFinancePayable(e.ref_id, false, e.occurrence ?? undefined);
    invalidateCache("finance:summary");
    invalidateCache("finance:payables");
    refresh();
  }

  async function confirmPay() {
    const e = payingEvent;
    if (!e) return;
    await payFinancePayable(e.ref_id, true, e.occurrence ?? undefined, paidOn);
    setPayingEvent(null);
    invalidateCache("finance:summary");
    invalidateCache("finance:payables");
    refresh();
  }

  const monthLabel = new Date(month.y, month.m, 1).toLocaleDateString("en-US", { year: "numeric", month: "long" });
  const shift = (delta: number) => setMonth((cur) => {
    const d = new Date(cur.y, cur.m + delta, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  // 한 건의 칸 — 표(달력)와 좁은 화면의 일정 목록이 같은 단추를 쓴다.
  const eventButton = (e: FinanceCalendarEvent, key: number) => (
    <button
      key={key}
      type="button"
      className={`fin-ev fin-ev--${e.kind}${e.overdue ? " overdue" : ""}${e.paid ? " paid" : ""}${e.actual ? " actual" : ""}${readOnlyEvent(e) ? " readonly" : ""}`}
      title={
        e.actual
          // 수금은 '납부'가 아니라 '입금'이다 — 방향에 맞는 말로 표기.
          ? `${e.kind === "receivable" ? "Received" : "Paid"} ${e.paid_on} · ${e.title} · ${money(e.amount, e.currency)}${
              e.scheduled ? ` (due ${e.scheduled})` : ""
            }`
          : `${e.kind === "receivable" ? "Receivable" : "Payable"} · ${e.title} · ${money(e.amount, e.currency)}${
              e.paid ? ` (paid${e.paid_on ? ` ${e.paid_on}` : ""})` : ""
            }${e.source === "ap" ? " — recorded in the project's stage 11 Payable (AP)" : ""}`
      }
      onClick={() => togglePayable(e)}
    >
      {/* 실제 납부일 자리에 찍힌 이벤트는 체크로 구분(예정일 이벤트는 취소선). */}
      <span className="fin-ev-title">{e.actual ? `✓ ${e.title}` : e.title}</span>
      <span className="fin-ev-amt">{money(e.amount, e.currency)}</span>
    </button>
  );

  // 좁은 화면용 — 7칸 표는 한 칸이 손가락보다 좁아 제목도 금액도 남지 않는다.
  // 이 달에 실제로 돈이 오가는 날만 골라 날짜별 목록으로 세운다(단추는 표와 동일).
  const agendaDays = grid.days
    .filter((day) => day.inMonth && (byDate.get(day.iso)?.length ?? 0) > 0)
    .map((day) => ({ ...day, events: byDate.get(day.iso)! }));

  return (
    <div className="panel">
      <div className="fin-cal-head">
        {/* 좌: 이번 달로 돌아오는 단추 하나 / 중앙: 화살표가 달을 양옆에서 감싼다 / 우: 범례.
            보고 있는 달이 이번 달이면 Today는 갈 곳이 없으므로 눌리지 않게 둔다. */}
        <div className="fin-cal-today">
          <button
            className="btn sm"
            disabled={month.y === new Date().getFullYear() && month.m === new Date().getMonth()}
            onClick={() => setMonth(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; })}
          >Today</button>
        </div>
        <div className="fin-cal-nav">
          <button className="btn sm fin-cal-arrow" onClick={() => shift(-1)} aria-label="Previous month">‹</button>
          <h3 className="form-title fin-cal-month">{monthLabel}</h3>
          <button className="btn sm fin-cal-arrow" onClick={() => shift(1)} aria-label="Next month">›</button>
        </div>
        {/* 색은 돈의 방향 두 가지뿐 — 상태(예정/결제됨/연체)는 같은 계열의 농도가 말하므로
            범례는 계열 이름만 적고, 농도 규칙은 표 아래 설명이 받는다. */}
        <div className="fin-legend fin-cal-legend">
          <span className="fin-legend-item"><span className="fin-dot fin-dot--rec" /> Receivables (AR) · income</span>
          <span className="fin-legend-item"><span className="fin-dot fin-dot--pay" /> Payables</span>
        </div>
      </div>
      {error && !data ? <div className="state error">API error: {error.message}</div> : null}
      <div className="fin-cal-grid">
        {DOW_SHORT.map((d) => (
          <div key={d} className="fin-cal-dow">{d}</div>
        ))}
        {grid.days.map((day) => {
          // 앞뒤 주를 채우는 옆 달 칸은 자리만 지키고 비운다 — 날짜도 일정도 적지 않는다.
          // 격자를 맞추려고 놓은 칸이지 이 달의 하루가 아니고, 거기 숫자와 금액이 적혀
          // 있으면 이 달의 첫날·마지막날이 어디인지가 한눈에 안 잡힌다.
          if (!day.inMonth) return <div key={day.iso} className="fin-cal-cell out" aria-hidden="true" />;
          const events = byDate.get(day.iso) ?? [];
          return (
            <div key={day.iso} className={`fin-cal-cell${day.iso === todayStr() ? " today" : ""}`}>
              <div className="fin-cal-date">{day.d}</div>
              <div className="fin-cal-events">
                {events.map((e, i) => eventButton(e, i))}
              </div>
            </div>
          );
        })}
      </div>
      {/* 좁은 화면에서 표 대신 서는 목록 — 둘 중 하나만 보인다(CSS가 고른다). */}
      <div className="fin-cal-agenda">
        {agendaDays.length === 0 ? (
          <div className="fin-cal-agenda-empty">Nothing scheduled this month.</div>
        ) : (
          agendaDays.map((day) => (
            <div key={day.iso} className={`fin-cal-agenda-day${day.iso === todayStr() ? " today" : ""}`}>
              <div className="fin-cal-agenda-date">
                <span className="fin-cal-agenda-dow">{DOW_SHORT[new Date(`${day.iso}T00:00:00`).getDay()]}</span>
                <span className="fin-cal-agenda-num">{day.d}</span>
              </div>
              <div className="fin-cal-agenda-events">{day.events.map((e, i) => eventButton(e, i))}</div>
            </div>
          ))
        )}
      </div>
      <p className="hint-inline" style={{ display: "block", marginTop: 8 }}>
        Colour is the direction of the money — blue comes in, amber goes out — and the shade is its state: pale is still expected, deeper has settled, and a solid block is overdue. Every item sits on its scheduled date until it settles, then appears again on the day the money actually moved — the scheduled entry is struck through and the ✓ entry is the real date. Click one of your own costs to record its payment — you enter the date it was really paid, which may differ from the scheduled date (recurring items settle one occurrence at a time); click a paid one to undo. Customer invoices (AR) and vendor bills (AP) are managed from the project stages instead — both on stage 11, the Receivable tab for collections and the Payable tab for vendor payments.
      </p>
      {payingEvent ? (
        <Modal title="Record payment" onClose={() => setPayingEvent(null)} form maxWidth={340}>
          <div className="fin-pay-form">
            <div className="fin-pay-target">
              {payingEvent.title} · {money(payingEvent.amount, payingEvent.currency)}
            </div>
            <div className="hint-inline">Scheduled {payingEvent.occurrence || payingEvent.date}</div>
            <label className="form-field">
              <span>Payment date</span>
              <input type="date" value={paidOn} onChange={(ev) => setPaidOn(ev.target.value)} />
            </label>
          </div>
          <div className="form-actions">
            <button className="btn" onClick={() => setPayingEvent(null)}>Cancel</button>
            <button className="btn primary" onClick={confirmPay} disabled={!paidOn}>Mark paid</button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function buildMonthGrid(y: number, m: number) {
  const first = new Date(y, m, 1);
  const startOffset = first.getDay(); // 0=Sun
  const gridStart = new Date(y, m, 1 - startOffset);
  // 이 달의 마지막 날이 든 주까지만 그린다 — 6주를 고정으로 깔면 달에 따라 다음 달만
  // 가득한 줄이 하나 더 붙는다. 그 줄은 이 달에 대해 아무 말도 하지 않으면서 자리를
  // 차지하고, 거기 실린 다음 달 일정이 이 달 것으로 읽힌다.
  const last = new Date(y, m + 1, 0);
  const cells = startOffset + last.getDate() + (6 - last.getDay());
  const days: { iso: string; d: number; inMonth: boolean }[] = [];
  for (let i = 0; i < cells; i++) {
    const dt = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    days.push({
      iso: `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`,
      d: dt.getDate(),
      inMonth: dt.getMonth() === m,
    });
  }
  // 불러올 구간은 격자가 아니라 '이 달'이다 — 앞뒤로 삐져나온 칸은 비워 두므로(달력은
  // 이 달의 이야기만 한다) 그 날짜의 일정은 받아도 놓을 자리가 없다.
  const iso = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  return { days, start: iso(first), end: iso(last) };
}
