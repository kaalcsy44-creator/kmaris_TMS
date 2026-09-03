"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  fetchFinanceSummary,
  fetchFinanceReceivables,
  fetchFinancePayables,
  fetchFinanceCalendar,
  fetchFinanceClaims,
  fetchFinanceClosing,
  fetchFinanceConsulting,
  fetchFinanceCashflow,
  fetchFxRate,
  createFinancePayable,
  updateFinancePayable,
  deleteFinancePayable,
  payFinancePayable,
  createFinanceIncome,
  updateFinanceIncome,
  deleteFinanceIncome,
  receiveFinanceIncome,
  fetchVendors,
  fetchPipeline,
} from "@/lib/api";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import type {
  FinancePayable,
  FinancePayableSave,
  FinanceIncomeSave,
  FinanceReceivable,
  FinanceSummary,
  FinanceClaimsData,
  FinanceClosing,
  FinanceConsultingRow,
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
import { HeadTh, useHeadMenu, type HeadCol } from "@/components/common/tableHeadMenu";
import { amountInputValue, parseAmountInput } from "@/components/common/itemTable";
import FinanceDaybook from "@/components/screens/FinanceDaybook";
import FinanceProfitTab from "@/components/screens/FinanceProfit";
import {
  CATEGORY_LABEL,
  INCOME_CATEGORY_LABEL,
  KpiTile,
  MONTH_NAMES,
  ProjectDocLink,
  cell,
  localDayStr,
  money,
  monthBounds,
  monthLabel,
  startYears,
  sumOf,
  sym,
} from "@/components/screens/financeShared";

// ── Display helpers ────────────────────────────────────────────────────────────
// 통화·달 이름·KPI 타일·문서번호 링크는 Finance 화면들이 함께 쓰므로 financeShared 에 있다
// (위 import 참고). 여기 남은 것들은 이 화면에서만 쓰는 목록·폼용 표기다.
// Category codes are stored values (do not translate); labels below are display-only.
const CATEGORIES = ["거래선지급", "컨설팅비", "임차료", "급여", "공과금", "수수료", "세금", "기타"];
/** 소개 수수료 분류 — 금액이 프로젝트 매출에서 계산되는 유일한 지급이라 이름을 상수로 둔다. */
const CONSULTING = "컨설팅비";
/** 거래선 지급 — 벤더에게 나가는 돈. 딜을 지목하면 그 딜의 매입 원가로 집계된다
 *  (벤더 P/O 없이 나간 지급. 서버의 _is_deal_purchase 와 같은 규약). */
const VENDOR_PAY = "거래선지급";
const RECURRENCE_LABEL: Record<string, string> = {
  none: "One-time",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};
// 기타 수입 분류(저장값은 한글 코드, 표시만 영문).
// 투자금은 통장에는 들어오지만 매출이 아니다 — 손익표(Profit)가 이 분류를 수익에서 뺀다.
const INCOME_CATEGORIES = ["이자수입", "환급", "투자금", "잡수입", "기타"];

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
/** "2026-06-16" + 7일 → "2026-06-23". 빈 날짜는 그대로 빈값으로 돌려준다. */
function addDays(iso: string, n: number): string {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00`);
  d.setDate(d.getDate() + n);
  const p = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── Screen ───────────────────────────────────────────────────────────────────
// Cash Flow 는 따로 서지 않는다 — 잔액과 현금흐름은 같은 질문의 앞뒤라서 Overview 하나로 합쳤다.
// 목록 두 탭은 Overview 의 두 기둥과 같은 이름을 쓴다(Inflow/Outflow) — 같은 돈을
// 한쪽에서는 '들어올 돈', 다른 쪽에서는 'Receivables' 라 부르면 매번 옮겨 읽어야 한다.
// Profit 은 Outflow 다음에 선다 — 들어온 돈, 나간 돈, 그래서 남은 돈. Closing · VAT 는
// 그 뒤다(신고를 위해 한 기간을 다시 세로로 파는 화면이라 성격이 다르다).
// Claims 는 Outflow 다음에 선다 — 클레임은 나간 돈(현금 부담)과 깎아 준 매출(상계)이
// 한 사건에 함께 있어, 어느 한쪽 목록에만 두면 나머지 절반이 보이지 않는다.
type Tab = "overview" | "inflow" | "outflow" | "claims" | "profit" | "closing" | "calendar";

const TABS: Tab[] = ["overview", "inflow", "outflow", "claims", "profit", "closing", "calendar"];
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
        <button className={tab === "claims" ? "on" : ""} onClick={() => setTab("claims")}>Claims</button>
        <button className={tab === "profit" ? "on" : ""} onClick={() => setTab("profit")}>Profit</button>
        <button className={tab === "closing" ? "on" : ""} onClick={() => setTab("closing")}>Closing · VAT</button>
        <button className={tab === "calendar" ? "on" : ""} onClick={() => setTab("calendar")}>Calendar</button>
      </div>

      {tab === "overview" && <OverviewTab />}
      {tab === "inflow" && <InflowTab />}
      {tab === "outflow" && <OutflowTab />}
      {tab === "claims" && <ClaimsTab />}
      {tab === "profit" && <FinanceProfitTab />}
      {tab === "closing" && <ClosingTab />}
      {tab === "calendar" && <CalendarTab />}
    </div>
  );
}

// ── Overview — 잔액과 현금흐름을 한 화면에 ────────────────────────────────────
// 예전 Cash Flow 탭이 여기로 합쳐졌다. '얼마 남았나'와 '얼마 들어오고 나가나'는
// 같은 질문의 앞뒤인데 탭이 갈라져 있어 매번 오가야 했다.

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

/**
 * 목록을 정산 여부로 거를 때 쓰는 값 — 세 기둥 격자의 세로축(Receivables/Received,
 * Payables/Paid)이 그대로 넘어온다. 갈래 서브탭이 격자의 가로축(Sales·Other·Total)이므로,
 * 둘을 합치면 격자의 칸 하나가 목록 화면 하나에 1:1 로 대응한다. 빈 값이면 전부.
 */
type LedgerStatus = "due" | "settled";
function asLedgerStatus(v: string | null): LedgerStatus | "" {
  return v === "due" || v === "settled" ? v : "";
}

/** 정산 여부 필터 — 이름은 방향에 따라 다르다(미수/수금 vs 미지급/지급). */
function LedgerStatusPick({ st, names, onChange }: {
  st: LedgerStatus | "";
  /** [아직 안 오간 것, 이미 오간 것] — Receivable/Received · Payable/Paid. */
  names: [string, string];
  onChange: (v: LedgerStatus | "") => void;
}) {
  return (
    <div className="seg-toggle" role="group" aria-label="Settled or not">
      <button className={st === "" ? "on" : ""} onClick={() => onChange("")}>All</button>
      <button className={st === "due" ? "on" : ""} onClick={() => onChange("due")}>{names[0]}</button>
      <button className={st === "settled" ? "on" : ""} onClick={() => onChange("settled")}>{names[1]}</button>
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


/**
 * 현금흐름 한 칸의 한 줄 → 그 갈래를 다루는 목록 탭(Inflow/Outflow)의 같은 이름 화면,
 * 기간까지 걸어서. 건별로 볼 자리가 목록에도 있는데 따로 만든 페이지로 보내면
 * 같은 목록을 두 군데서 보게 된다.
 * 첫 칸은 앞선 연체까지 끌어안으므로 시작을 열어 둔다(from 없음) — 그래야 목록의
 * 합과 기둥의 금액이 맞는다. 통화도 같은 이유로 걸어 보낸다: 이 기둥은 고른 통화 하나만
 * 세고 있어, 통화를 안 걸면 목록에 다른 통화가 섞여 합이 어긋난다.
 */
function ledgerHref(
  r: FinanceCashflowRow,
  first: boolean,
  side: "in" | "out",
  /** 격자의 세로칸 — 거래에서 나온 돈(매출·매입) / 그 밖 / 둘 다. */
  col: "trade" | "other" | "total",
  currency: string,
  /** 격자의 가로줄 — 아직 안 오간 것 / 이미 오간 것. 빈 값이면 전부. */
  st?: LedgerStatus
): string {
  const view = col === "total" ? "total"
    : col === "other" ? (side === "in" ? "income" : "other")
      : (side === "in" ? "receivables" : "payables");
  const q = new URLSearchParams({
    tab: side === "in" ? "inflow" : "outflow",
    view,
    to: r.end,
    cur: currency,
  });
  if (st) q.set("st", st);
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
              cols={["Sales", "Other income"]}
              colHref={[
                ledgerHref(row, idx === 0, "in", "trade", currency),
                ledgerHref(row, idx === 0, "in", "other", currency),
                ledgerHref(row, idx === 0, "in", "total", currency),
              ]}
              due={{
                label: "Receivables",
                hint: "not settled yet",
                trade: row.in_ar ?? 0,
                other: row.in_income ?? 0,
                total: (row.in_ar ?? 0) + (row.in_income ?? 0),
                parked: parkExpected,
                href: [
                  ledgerHref(row, idx === 0, "in", "trade", currency, "due"),
                  ledgerHref(row, idx === 0, "in", "other", currency, "due"),
                ],
                totalHref: ledgerHref(row, idx === 0, "in", "total", currency, "due"),
              }}
              settled={{
                label: "Received",
                hint: "already in the account",
                trade: row.actual_in_ar ?? 0,
                other: row.actual_in_income ?? 0,
                total: row.actual_inflow,
                split: typeof row.actual_in_ar === "number",
                href: [
                  ledgerHref(row, idx === 0, "in", "trade", currency, "settled"),
                  ledgerHref(row, idx === 0, "in", "other", currency, "settled"),
                ],
                totalHref: ledgerHref(row, idx === 0, "in", "total", currency, "settled"),
              }}
              allHref={`${periodHref(row, idx === 0, currency, includePo, overdueRolled, !parkExpected)}&side=in`}
              currency={currency}
            />
            <BucketCard
              title="Outflow"
              period={pickedLabel}
              tone="out"
              cols={["Purchases", "Other costs"]}
              colHref={[
                ledgerHref(row, idx === 0, "out", "trade", currency),
                ledgerHref(row, idx === 0, "out", "other", currency),
                ledgerHref(row, idx === 0, "out", "total", currency),
              ]}
              due={{
                label: "Payables",
                hint: "not settled yet",
                trade: row.out_ap ?? 0,
                other: row.out_other ?? 0,
                total: (row.out_ap ?? 0) + (row.out_other ?? 0),
                parked: parkExpected,
                href: [
                  ledgerHref(row, idx === 0, "out", "trade", currency, "due"),
                  ledgerHref(row, idx === 0, "out", "other", currency, "due"),
                ],
                totalHref: ledgerHref(row, idx === 0, "out", "total", currency, "due"),
              }}
              settled={{
                label: "Paid",
                hint: "already out of the account",
                trade: row.actual_out_ap ?? 0,
                other: row.actual_out_other ?? 0,
                total: row.actual_outflow,
                split: typeof row.actual_out_ap === "number",
                href: [
                  ledgerHref(row, idx === 0, "out", "trade", currency, "settled"),
                  ledgerHref(row, idx === 0, "out", "other", currency, "settled"),
                ],
                totalHref: ledgerHref(row, idx === 0, "out", "total", currency, "settled"),
              }}
              allHref={`${periodHref(row, idx === 0, currency, includePo, overdueRolled, !parkExpected)}&side=out`}
              currency={currency}
            />
            <div className="panel fin-bucket-card fin-bucket--balance">
              {/* 구간 이름은 왼쪽 앞머리가 세 기둥을 대신해 한 번만 적는다. */}
              <h3 className="form-title">Balance</h3>
              {/* 이 카드는 옆 두 기둥과 같은 세 칸으로 짜인다 — 머리줄(칸 이름 ↔ Opening),
                  윗줄(Receivables·Payables ↔ 잔고 밖의 돈), 아랫줄(Received·Paid ↔ Net).
                  같은 줄에 선 것끼리 실제로 같은 것을 말하기 때문이다: 밖에 세워 둔 돈은
                  옆 윗줄들의 합이고, Net 은 옆 아랫줄들의 차다. Ending 만 짝 없이 발밑에
                  남는다 — 이 표에서만 나오는 값(기초 + 순증감)이라서. */}
              <table className="mini fin-balance-grid">
                <thead>
                  {/* 기초잔고 — 계산의 출발점이라 머리줄 자리. 딸린 한 줄은 Ending 의
                      'carried out' 과 짝을 이룬다(받아서 넘긴다는 같은 말의 앞뒤). */}
                  <tr>
                    <th scope="row">Opening<div className="hint-inline">carried in</div></th>
                    <th className="num">{cash(rowOpening)}</th>
                  </tr>
                </thead>
                <tbody>
                  {/* 잔고 밖에 세워 둔 돈 — 옆 두 기둥의 미수·미지급 줄과 같은 자리에 둔다.
                      여기 적히는 값이 바로 그 줄들의 합이기 때문이다(Expected in =
                      Receivables 두 줄, Expected out = Payables 두 줄).
                      이 줄이 없으면 '예정·연체는 안 셌다'는 사실이 화면 어디에도 남지 않아,
                      잔고가 그만큼 좋아 보이거나(미지급) 나빠 보이는(미수) 이유를 알 수 없다.
                      예정을 먼저, 연체를 뒤에 — 예정이 큰 덩어리이고 연체는 그중 날이 지난 몫.
                      세울 것이 없어도 줄은 비운 채로 남긴다: 그래야 아래 Net 이 옆의
                      Received·Paid 와 계속 나란히 선다. */}
                  <tr>
                    <td className="fin-balance-parked" colSpan={2}>
                      {(parkExpected && ((row.expected_in ?? 0) || (row.expected_out ?? 0))) || row.overdue_in || row.overdue_out ? (
                        <div className={`fin-overdue-note fin-overdue-note--row${overdueRolled ? " in" : ""}`}>
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
                    </td>
                  </tr>
                  {/* 예정을 잔고 밖에 세워 두면 이 값은 '실제로 오간 돈끼리의 차'다 —
                      옆 두 기둥의 아랫줄(Received·Paid) 합계끼리 뺀 것. 그 둘과 같은 줄에
                      서고 같은 음영을 받아, 어느 숫자에서 왔는지 자리로 먼저 읽힌다. */}
                  <tr className="fin-bucket-settled">
                    <th scope="row">Net<div className="hint-inline">{parkExpected ? "received − paid" : "inflow − outflow"}</div></th>
                    <td className="num" style={{ color: row.net >= 0 ? "#1e7a46" : "#c0392b" }}>
                      {row.net >= 0 ? "+" : "−"}{cash(Math.abs(row.net))}
                    </td>
                  </tr>
                  {/* 기초에서 순증감을 굴린 그 구간 끝의 통장잔고 — 위 두 줄의 결과라
                      발밑에 따로 선다. */}
                  <tr className="fin-period-total">
                    <th scope="row"><b>Ending</b><div className="hint-inline">carried out</div></th>
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
                        {/* 그달에 현금 대신 상계로 사라진 미수 — 유입 '밖'의 금액이라
                            잔고를 움직이지 않는다. 이 줄이 없으면 미수가 조용히 줄어든
                            것으로만 보인다(건별 내역은 아래 장부의 set-off 줄). */}
                        {r.offset_in ? (
                          <div className="fin-cf-offset" title="Cleared by credit note — no cash moved, so it is not in the balance">
                            {cash(r.offset_in)} set off
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

/** 격자의 한 줄 — 두 갈래 금액과 그 합, 그리고 칸마다 열리는 목록. */
type BucketRow = {
  label: string;
  hint: string;
  /** 거래에서 나온 돈(매출·매입). */
  trade: number;
  /** 그 밖(기타수입·임차료·급여 등). */
  other: number;
  total: number;
  /** 잔고 밖에 세워 둔 줄인가 — 금액은 적되 잔고에는 안 들어 있다. */
  parked?: boolean;
  /**
   * 갈래별 금액이 실제로 갈라져 오는가. 옛 백엔드는 실적을 합계로만 보내므로(배포 시차)
   * 그때 두 칸에 0 을 적으면 '아무것도 안 들어왔다'는 거짓말이 된다 — 줄표로 비운다.
   */
  split?: boolean;
  /** [거래 칸, 그 밖 칸] 목록 주소. */
  href: [string, string];
  /** 합계 칸의 목록 주소(없으면 카드의 allHref). */
  totalHref?: string;
};

/**
 * 한 구간의 유입(또는 유출)을 격자로 — 세로는 정산 여부(미수/실적), 가로는 출처
 * (거래/그 밖). 두 겹으로 갈리는 갈래라 줄로만 세우면 여섯 줄이 되고, 어느 둘이 같은
 * 종류인지가 이름의 앞마디를 읽어야만 잡혔다. 격자로 놓으면 그 관계가 자리로 읽힌다:
 * 세로로 더하면 그 출처의 전부, 가로로 더하면 그 상태의 전부(Total 칸).
 * 칸마다 그 조건으로 걸러 낸 목록으로 간다.
 */
function BucketCard({ title, period, tone, cols, colHref, due, settled, allHref, currency }: {
  title: string;
  period: string;
  tone: "in" | "out";
  /** 가로 두 칸의 이름 — [거래, 그 밖]. */
  cols: [string, string];
  /** 그 칸 이름이 여는 목록 — [거래, 그 밖, 합계]. 정산 여부는 걸지 않는다(그 세로칸 전부). */
  colHref: [string, string, string];
  /** 윗줄 = 아직 안 오간 돈(Receivables · Payables). */
  due: BucketRow;
  /** 아랫줄 = 이미 오간 돈(Received · Paid). */
  settled: BucketRow;
  /** 기둥 이름 → 이 구간 전체를 한 화면에 펼친 기간 상세. */
  allHref: string;
  currency: string;
}) {
  const cash = (n: number) => money(n, currency);
  /** 금액 한 칸 — 누르면 그 칸이 가리키는 목록이 열린다. */
  const cell = (amount: number, href: string, what: string, shown = true) => (
    <td className="num">
      {shown ? (
        <Link className="fin-cell-link" href={href} title={`${what} · ${period}`}>{cash(amount)}</Link>
      ) : (
        <span className="fin-cell-none" title="This period's figure is not split by source yet">—</span>
      )}
    </td>
  );
  /** 격자 한 줄. 음영은 아랫줄(실적)에만 — 옆 기둥의 Ending 과 짝이 되는 자리라서다. */
  const line = (r: BucketRow, isSettled: boolean) => (
    <tr className={`${isSettled ? "fin-bucket-settled" : ""}${r.parked ? " fin-bucket-off" : ""}`}>
      <th scope="row">
        {r.label}
        {/* 꼬리말은 줄을 나눠 적는다 — 옆 잔고 카드의 '잔고 밖' 상자가 이름줄 + 금액 줄로
            서기 때문이다. 한 줄로 두면 이 칸만 낮아 세 카드의 줄이 어긋나 보인다. */}
        <div className="hint-inline">
          {r.hint}
          {r.parked ? <><br />not in balance</> : null}
        </div>
      </th>
      {cell(r.trade, r.href[0], `${r.label} · ${cols[0]}`, r.split !== false)}
      {cell(r.other, r.href[1], `${r.label} · ${cols[1]}`, r.split !== false)}
      {cell(r.total, r.totalHref ?? allHref, `${r.label} · all`)}
    </tr>
  );
  return (
    <div className={`panel fin-bucket-card fin-bucket--${tone}`}>
      {/* 기둥 이름이 곧 '이 구간 전부'로 가는 문이다. 구간 이름은 왼쪽 앞머리가 한 번만
          적는다(여기서는 링크 설명에만 남는다). */}
      <h3 className="form-title">
        <Link className="fin-doc-link" href={allHref} title={`Every ${title.toLowerCase()} item · ${period}`}>
          {title}
        </Link>
      </h3>
      <table className="mini fin-bucket-grid">
        <thead>
          {/* 칸 이름도 문이다 — 그 세로칸 전부(미수와 실적을 함께)를 목록으로 연다.
              아래 금액 칸은 거기에 정산 여부까지 걸어 한 칸으로 좁힌 것이다. */}
          <tr>
            <th />
            {[cols[0], cols[1], "Total"].map((name, i) => (
              <th className="num" key={name}>
                <Link className="fin-cell-link" href={colHref[i]} title={`${name} · ${period}`}>{name}</Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {line(due, false)}
          {line(settled, true)}
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

type InflowView = "receivables" | "income" | "total";

function InflowTab() {
  const { data, error, refresh } = useCachedData<{ rows: FinanceReceivable[]; fx: FxQuote }>("finance:receivables", fetchFinanceReceivables);
  // 오늘 기준 잔액·연체 — 목록의 합계는 지금 걸러 놓은 행만 세므로 따로 받는다.
  const { data: sum } = useCachedData<FinanceSummary>("finance:summary", () => fetchFinanceSummary());
  // 갈래와 기간은 주소에 산다 — Overview 의 한 줄이 'Inflow 의 Collected, 7월'로
  // 곧장 건너뛰고, 그 화면을 그대로 링크로 넘길 수 있어야 한다.
  const { params, setParams } = useFinanceNav();
  const viewParam = params.get("view") || "";
  const view: InflowView = (["receivables", "income", "total"] as const).includes(viewParam as InflowView)
    ? (viewParam as InflowView) : "receivables";
  const setView = (v: InflowView) => setParams({ view: v === "receivables" ? "" : v });
  const from = params.get("from") || "";
  const to = params.get("to") || "";
  // 통화도 주소에 산다(갈래·기간과 같은 규약) — '₩만 본 이 화면'을 그대로 넘길 수 있게.
  const cur = asLedgerCur(params.get("cur"));
  // 정산 여부 — 격자의 세로축이 그대로 넘어온다. 기본은 전부(수금이 끝난 청구서가
  // 목록에서 사라지면 "그 청구서 어디 갔지"가 된다).
  const st = asLedgerStatus(params.get("st"));
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<FinanceReceivable | null>(null);
  const [receiving, setReceiving] = useState<{ row: FinanceReceivable; occurrence: string } | null>(null);
  const all = useMemo(() => data?.rows ?? [], [data]);
  const rows = useMemo(() => all
    // Total 갈래는 출처를 가리지 않는다 — 매출과 기타수입을 한 표에 담는다.
    .filter((r) => (view === "total" ? true : view === "income" ? r.source === "income" : r.source !== "income"))
    .filter((r) => r.currency === cur)
    // 예정 항목은 예정일 기준 — 반복(기타수입)은 회차 하나라도 구간에 들면 남긴다.
    .filter((r) => dueInRange(r, from, to))
    // 미수만/수금분만 — 한 건이 둘 다일 수 있으므로(부분수금) 어느 쪽으로도 걸린다.
    .filter((r) => (st === "due" ? r.outstanding > 0 : st === "settled" ? r.paid_amount > 0 : true)),
  [all, view, st, from, to, cur]);
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
      : "Sales and other income in one list. Each line carries what was invoiced, what has come in and what is still owed, so the three filters on the right cut it the same way the Overview grid does.";

  return (
    <div className="panel">
      <div className="items-head">
        <h3 className="form-title fin-page-title" style={{ margin: 0 }}>Inflow</h3>
        <div className="items-head-actions">
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
          <button className={view === "receivables" ? "on" : ""} onClick={() => setView("receivables")}>Sales</button>
          <button className={view === "income" ? "on" : ""} onClick={() => setView("income")}>Other income</button>
          <button className={view === "total" ? "on" : ""} onClick={() => setView("total")}>Total</button>
        </div>
        {/* 무엇을 걸러 볼지는 오른쪽에 모아 둔다 — 왼쪽 갈래(무엇을 보는가)와 갈라서. */}
        <div className="fin-ledger-filters">
          <LedgerStatusPick st={st} names={["Receivable", "Received"]} onChange={(v) => setParams({ st: v })} />
          <LedgerCurrency cur={cur} onChange={(c) => setParams({ cur: c })} />
          <LedgerPeriod from={from} to={to} onChange={(f, t) => setParams({ from: f, to: t })} />
        </div>
      </div>
      <p className="hint-inline" style={{ display: "block", margin: "8px 0 10px" }}>{hint}</p>

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
            <tr><td colSpan={9} className="mini-empty">{
              st ? "Nothing in this period matches that filter."
                : view === "income" ? "No other income registered." : "No customer invoices to show."}</td></tr>
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
  rfq_id: null,
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

// 갈래 = 격자의 가로축(Inflow 와 같은 규약). 'Paid' 는 상태라 st 필터로 옮겼다.
// 컨설팅비가 제 갈래를 갖는 이유: 나머지 지출은 받은 청구서를 적는 일이지만, 이것은
// 매출에서 계산해 내는 일이다. 그 계산의 근거(어느 딜이 얼마에 팔렸나)는 다른 세 갈래의
// 어느 열에도 들어갈 자리가 없어, 표 위에 따로 세운다.
type OutflowView = "payables" | "consulting" | "other" | "total";

function OutflowTab() {
  const { data, error, refresh } = useCachedData<{ rows: FinancePayable[]; fx: FxQuote }>("finance:payables", fetchFinancePayables);
  // 오늘 기준 예정·연체와 분류별 합계 — 목록은 건별이라 이 두 가지를 스스로 답하지 못한다.
  const { data: sum } = useCachedData<FinanceSummary>("finance:summary", () => fetchFinanceSummary());
  // 갈래와 기간은 주소에 산다(Inflow 와 같은 규약).
  const { params, setParams } = useFinanceNav();
  const viewParam = params.get("view") || "";
  const view: OutflowView = (["payables", "consulting", "other", "total"] as const).includes(viewParam as OutflowView)
    ? (viewParam as OutflowView) : "payables";
  const setView = (v: OutflowView) => setParams({ view: v === "payables" ? "" : v });
  const from = params.get("from") || "";
  const to = params.get("to") || "";
  // 통화 필터 — Inflow 와 같은 규약(주소의 cur).
  const cur = asLedgerCur(params.get("cur"));
  const st = asLedgerStatus(params.get("st"));
  const [editing, setEditing] = useState<FinancePayable | null>(null);
  // 등록 폼에 미리 채워 넣을 값 — 빈 폼이면 emptyPayable, 수수료 줄에서 열면 그 딜의 값.
  const [adding, setAdding] = useState<FinancePayableSave | null>(null);
  // 납부 입력 대상 — 회차일(occurrence)과 실제 납부일을 함께 받는다.
  const [paying, setPaying] = useState<{ row: FinancePayable; occurrence: string } | null>(null);
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const canEdit = can("finance", "create") || can("finance", "edit");
  // 거래(매입) / 기타 지출 두 섹션 — 성격이 다르고 다루는 항목도 달라서 표를 따로 낸다.
  // 벤더 청구서는 프로젝트에서 넘어온 읽기전용(청구서번호·발행일 중심), 기타 지출은
  // 여기서 직접 등록하는 항목(분류·반복 중심)이라 열 구성이 서로 맞지 않는다.
  // 보고 있는 갈래의 행 — 거래(매입)냐 그 밖이냐, Total 이면 둘 다. 가르는 규칙은
  // 백엔드의 out_ap/out_other 와 같다(지급대장의 '거래선지급'은 벤더 청구와 한 갈래).
  const visible = useMemo(() => {
    const isTrade = (p: FinancePayable) => p.source === "ap" || p.category === "거래선지급";
    const inView = (p: FinancePayable) => {
      if (view === "total") return true;
      if (view === "consulting") return p.category === CONSULTING;
      if (view === "payables") return isTrade(p);
      // Other costs — 남은 것 전부. 컨설팅비는 제 갈래로 빠져 여기 다시 세지 않는다.
      return !isTrade(p) && p.category !== CONSULTING;
    };
    return rows
      .filter((p) => p.currency === cur)
      // 예정 항목은 예정일 기준 — 반복(임차료·급여)은 회차 하나라도 구간에 들면 남긴다.
      .filter((p) => dueInRange(p, from, to))
      .filter(inView)
      // 미지급만/지급분만 — 반복 항목은 회차 하나라도 납부했으면 지급분에 든다.
      .filter((p) => (st === "due" ? p.outstanding > 0
        : st === "settled" ? (p.paid_amount > 0 || p.paid || (p.paid_dates?.length ?? 0) > 0)
          : true));
  }, [rows, view, st, from, to, cur]);

  // 머리행에서 거는 정렬·필터 — 위쪽 갈래/기간/통화 필터가 고른 목록을 다시 자른다.
  // 분류·상대처·적요·상태·반복은 고르는 목록(복수 선택)으로, 날짜 둘은 기간으로,
  // 금액 셋은 숫자로 정렬한다. 적요는 값 종류가 많지만 "공동인증수수료"·"6월 급여"처럼
  // 되풀이되는 항목이라 고르는 값이 된다 — 목록이 길어지면 메뉴가 검색칸을 띄운다.
  const headCols = useMemo<HeadCol<FinancePayable>[]>(() => [
    { key: "category", text: (p) => CATEGORY_LABEL[p.category] || p.category, filter: "facet" },
    { key: "party", text: (p) => p.counterparty || "", filter: "facet", emptyLabel: "Unspecified" },
    { key: "desc", text: (p) => p.description || "", filter: "facet", emptyLabel: "No description" },
    { key: "bill_date", text: (p) => p.bill_date || "", filter: "date" },
    { key: "due_date", text: (p) => p.due_date || "", filter: "date" },
    { key: "amount", text: (p) => String(p.invoice_amount), sortValue: (p) => p.invoice_amount },
    { key: "paid", text: (p) => String(p.paid_amount), sortValue: (p) => p.paid_amount },
    { key: "outstanding", text: (p) => String(p.outstanding), sortValue: (p) => p.outstanding },
    { key: "status", text: (p) => payableStatus(p).label, sortValue: (p) => payableStatus(p).rank, filter: "facet" },
    { key: "recurrence", text: (p) => RECURRENCE_LABEL[p.recurrence] || p.recurrence, filter: "facet" },
  ], []);
  const head = useHeadMenu(headCols, view);
  const shown = head.apply(visible);
  // 합계 3열(청구·지급·미지급) — 통화별 분리(수입 목록과 같은 규칙).
  // 보이는 행의 합이다 — 머리행 필터로 잘라 낸 행은 발밑 합계에서도 빠진다.
  const totals = payableTotals(shown);

  function reload() {
    invalidateCache("finance:summary");
    invalidateCache("finance:calendar");
    // 수수료 근거표는 '이미 등록된 지급'을 함께 세므로 지급이 바뀌면 같이 다시 읽는다.
    invalidateCache("finance:consulting");
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
    // 손으로 등록한 행이 아니면(벤더 청구·은행 수수료) 여기서 상태를 바꿀 수 없다.
    const derived = (p.source || "manual") !== "manual";
    const late = !!p.overdue && !p.paid;
    return (
      <td data-label="Status">
        {derived ? (
          // 벤더 청구서도 기타 지출과 같은 칩으로 보여준다 — 다만 지급 기록은
          // 프로젝트 11단계 AP 탭의 Payment 칸에서 하므로 여기서는 누를 수 없다.
          // 수취수수료는 입금되는 순간 떼인 돈이라 애초에 기록할 것이 없다.
          <button
            type="button"
            className={`wt-badge fin-paid-toggle${p.paid ? " on" : ""}${late ? " overdue" : ""}`}
            title={p.source === "bankfee"
              ? "Deducted by the bank as the money came in"
              : "Record the payment in the project's stage 11 Payable (AP)"}
            disabled
          >
            {p.paid
              ? p.source === "bankfee" ? "Deducted" : "Paid"
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

  /**
   * 합계 두 줄 — 보고 있는 표의 발밑. 표 '안'(tfoot)에 들어가야 한다.
   *
   * 전에는 합계만 따로 떼어 낸 표에 그렸고, 그 표는 앞 다섯 칸을 하나로 묶어 두었다.
   * 표가 둘이면 칸 폭도 따로 정해진다 — table-layout:auto 는 제 표의 내용만 보고 폭을
   * 나누므로, 폭 지정(fin-w-money)을 똑같이 걸어 두어도 두 표의 세로선은 어긋난다.
   * 그래서 합계 금액이 위 금액들과 오른쪽 끝을 맞추지 못했다. 같은 표의 tfoot 이면
   * 칸이 하나뿐이라 어긋날 자리가 없다.
   *
   * 열은 11칸 — 앞 다섯(분류·상대처·적요·청구일·예정일)을 묶고, 금액 셋을 제자리에 놓고,
   * 뒤 셋(상태·반복·조작)은 비운다.
   */
  function totalsFoot(amountLabel: string) {
    if (shown.length === 0) return null;
    return (
      <tfoot>
        <tr className="foot-grand fin-foot-total">
          <td className="total-label fin-foot-name" colSpan={5}>Total</td>
          <td className="num total-value" data-label={amountLabel}>{byCurrencyLines(totals.invoice)}</td>
          <td className="num total-value" data-label="Paid">{byCurrencyLines(totals.paid)}</td>
          <td className="num total-value" data-label="Payable">{byCurrencyLines(totals.outstanding)}</td>
          <td colSpan={3} />
        </tr>
        {/* 참고용 KRW 환산 — 오늘자 매매기준율(조회 실패 시 고정환율). 집계에는 쓰지 않는다.
            ₩ 만 남은 표에서는 접는다(같은 숫자를 한 줄 더 적는 셈이라). */}
        {needsKrwRef(totals.invoice, totals.paid, totals.outstanding) ? (
          <tr className="fin-foot-ref">
            <td className="fin-foot-name" colSpan={5}>
              Total (In KRW · 1 USD = {fx.rate.toLocaleString()}
              {fx.source === "exim" ? ` · 매매기준율 ${fx.date}` : " · fixed rate"})
            </td>
            <td className="num" data-label={amountLabel}>{won(toKrw(totals.invoice, fx.rate))}</td>
            <td className="num" data-label="Paid">{won(toKrw(totals.paid, fx.rate))}</td>
            <td className="num" data-label="Payable">{won(toKrw(totals.outstanding, fx.rate))}</td>
            <td colSpan={3} />
          </tr>
        ) : null}
      </tfoot>
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
          {p.source === "bankfee" ? (
            // 수금에 딸려 나온 행이라 고칠 것이 없다 — 그 수금이 있는 자리로 보낸다.
            <ProjectDocLink orderId={p.order_id} rfqId={p.rfq_id} label="From this receipt" hint />
          ) : p.source === "ap" ? (
            <ProjectDocLink orderId={p.order_id} rfqId={p.rfq_id} label="Project stage 11" hint apPoId={p.po_id} />
          ) : (
            <>
              {can("finance", "edit") ? (
                <button className="btn tiny" title="Edit" aria-label="Edit" onClick={() => setEditing(p)}>✎</button>
              ) : null}
              {/* 다음 달 것을 적을 때 지난달 줄에서 시작한다 — 임차료·급여처럼 매달 같은
                  자리에 같은 금액이 서는 항목이 대부분이라, 날짜만 한 달 밀어 열어 준다.
                  저장하기 전까지는 아무것도 만들어지지 않으므로 그 자리에서 고치면 된다. */}
              {can("finance", "create") ? (
                <button
                  className="btn tiny"
                  title="Copy as new — same details with the dates moved on a month"
                  aria-label="Copy as new"
                  onClick={() => setAdding(nextMonthCopy(p))}
                >
                  ⧉
                </button>
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
            <button className="btn primary sm" onClick={() => setAdding(emptyPayable)}>+ Add payable</button>
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
          <button className={view === "payables" ? "on" : ""} onClick={() => setView("payables")}>Purchases</button>
          <button className={view === "consulting" ? "on" : ""} onClick={() => setView("consulting")}>Consulting fee</button>
          <button className={view === "other" ? "on" : ""} onClick={() => setView("other")}>Other costs</button>
          <button className={view === "total" ? "on" : ""} onClick={() => setView("total")}>Total</button>
        </div>
        {/* 무엇을 걸러 볼지는 오른쪽에 모아 둔다 — 왼쪽 갈래(무엇을 보는가)와 갈라서. */}
        <div className="fin-ledger-filters">
          <LedgerStatusPick st={st} names={["Payable", "Paid"]} onChange={(v) => setParams({ st: v })} />
          <LedgerCurrency cur={cur} onChange={(c) => setParams({ cur: c })} />
          <LedgerPeriod from={from} to={to} onChange={(f, t) => setParams({ from: f, to: t })} />
        </div>
      </div>
      <p className="hint-inline" style={{ display: "block", margin: "8px 0 10px" }}>
        {view === "payables"
          ? "Vendor bills arrive here automatically from the project's billing stages and are read-only — click the bill number to open that project's stage 11 Payable (AP), where the payment is confirmed. Payments registered by hand under the vendor-payment category sit here too."
          : view === "consulting"
            ? "Introducer commission. The table above works out what each project owes — its sales times the fee rate agreed on the RFQ — and Register turns one of those lines into a payable with the consultant and the amount already filled in. The list below is what has actually been booked."
            : view === "other"
              ? "The company's own costs — rent, payroll, utilities, taxes — are registered by hand here; monthly/quarterly/yearly items appear as occurrences on the calendar. Bank receiving fees on foreign-currency collections are worked out for you and shown read-only, with the arithmetic under each line."
              : "Purchases and other costs in one list. Each line carries what was billed, what has gone out and what is still owed, so the four filters on the right cut it the same way the Overview grid does."}
      </p>

      {/* 수수료의 근거 — 등록된 지급 목록 '위'에 둔다. 이 갈래에서 먼저 답해야 할 질문은
          '무엇을 냈나'가 아니라 '얼마를 내야 하나'이고, 그 답은 아래 표에 없다. */}
      {view === "consulting" ? <ConsultingBasis onRegister={setAdding} /> : null}

      {/* 표는 하나 — 세 갈래가 같은 열을 쓰기 때문이다(벤더 청구든 임차료든 '분류·상대처·
          적요·날짜 둘·금액 셋·상태·반복'으로 적힌다). 갈래마다 표를 따로 두었을 때는
          Total 을 낼 자리가 없었고, 같은 표를 두 벌 손봐야 했다. 이름 두 개만 갈린다:
          거래 쪽은 청구서 번호와 'Bill', 그 밖은 적요와 'Amount'. */}
      {/* 머리행 필터가 걸렸을 때만 나타나는 줄 — 몇 줄이 남았는지와 되돌리는 버튼.
          아무것도 걸지 않았으면 자리도 차지하지 않는다. */}
      {head.filtersActive ? (
        <div className="fin-head-filter-bar">
          <span className="pl-search-count">{shown.length} / {visible.length}</span>
          <button type="button" className="pl-filter-reset" onClick={head.resetFilters}>Reset column filters</button>
        </div>
      ) : null}

      <section className="fin-sec">
        <table className="mini fin-ledger">
          <thead>
            <tr>
              {/* 머리 칸을 누르면 그 열로 오름/내림 정렬하거나 값을 골라 거를 수 있다. */}
              <HeadTh menu={head} col="category" className="fin-w-cat">Category</HeadTh>
              <HeadTh menu={head} col="party" className="fin-w-party">
                {view === "payables" ? "Vendor" : view === "consulting" ? "Consultant" : "Vendor / payee"}
              </HeadTh>
              <HeadTh menu={head} col="desc">{view === "payables" ? "Bill No. / Vendor P/O"
                : view === "consulting" ? "Project"
                  : view === "other" ? "Description" : "Reference"}</HeadTh>
              <HeadTh menu={head} col="bill_date" className="fin-w-date">Bill date</HeadTh>
              <HeadTh menu={head} col="due_date" className="fin-w-date">Due</HeadTh>
              <HeadTh menu={head} col="amount" className="num fin-w-money" numeric>
                {view === "payables" ? "Bill" : "Amount"}
              </HeadTh>
              <HeadTh menu={head} col="paid" className="num fin-w-money" numeric>Paid</HeadTh>
              <HeadTh menu={head} col="outstanding" className="num fin-w-money" numeric>Payable</HeadTh>
              <HeadTh menu={head} col="status" className="fin-w-status">Status</HeadTh>
              <HeadTh menu={head} col="recurrence" className="fin-w-rec">Recurrence</HeadTh>
              <th className="fin-w-act" />
            </tr>
          </thead>
          <tbody>
            {/* 행이 없어도 표(머리행)는 남긴다 — 어떤 항목이 들어오는 자리인지 보이도록. */}
            {shown.length === 0 ? (
              <tr><td colSpan={11} className="mini-empty">{
                head.filtersActive ? "No line matches the column filters."
                  : st ? "Nothing in this period matches that filter."
                    : view === "consulting" ? "No consulting fee registered yet — use Register on a line above."
                      : view === "other" ? "No other costs registered." : "No vendor bills yet."}</td></tr>
            ) : null}
            {shown.map((p) => (
              <tr key={`${p.source || "manual"}-${p.id}`} className={p.overdue && !p.paid ? "fin-overdue" : ""}>
                <td data-label="Category">{CATEGORY_LABEL[p.category] || p.category}</td>
                <td className="fin-c-title">{p.counterparty || "—"}</td>
                {/* 청구서 번호 = 미수 목록의 Invoice No. 자리. AP 행은 그 아래 벤더 P/O 를
                    옅게 덧붙인다(번호가 아직 없으면 P/O 만 보인다). 수동 등록은 적요이고,
                    메모는 별도 열까지 둘 만큼 길지 않아 그 아래 옅게 붙인다. */}
                <td className="fin-c-sub">
                  {p.source === "ap" ? (
                    <>
                      <ProjectDocLink orderId={p.order_id} rfqId={p.rfq_id} label={p.description} apPoId={p.po_id} />
                      {p.po_no && p.po_no !== p.description ? <div className="muted">{p.po_no}</div> : null}
                    </>
                  ) : p.source === "bankfee" ? (
                    // 산출근거를 적요 아래에 그대로 — 이 금액이 왜 이 값인지가 행 안에서 끝난다.
                    <>
                      <ProjectDocLink orderId={p.order_id} rfqId={p.rfq_id} label={p.description} />
                      <div className="muted">{p.notes}</div>
                    </>
                  ) : (
                    <>
                      {/* 프로젝트에 매인 지급(컨설팅 수수료)은 적요에서 그 딜로 건너뛴다 —
                          금액의 근거가 거기 있어서 "왜 이 금액인가"는 늘 그리로 간다. */}
                      {p.rfq_id ? (
                        <ProjectDocLink rfqId={p.rfq_id} label={p.description || "—"} />
                      ) : (
                        p.description || "—"
                      )}
                      {p.notes ? <div className="muted">{p.notes}</div> : null}
                    </>
                  )}
                </td>
                <td data-label="Billed">{p.bill_date || "—"}</td>
                <td data-label="Due">{p.due_date || "—"}</td>
                {/* 총액 아래에 그 안의 부가세를 옅게 — 결산의 매입세액으로 넘어가는 값이라
                    목록에서 바로 확인할 수 있어야 한다. */}
                <td className="num" data-label={view === "payables" ? "Bill" : "Amount"}>
                  {money(p.invoice_amount, p.currency)}
                  {p.vat_amount ? <div className="muted">VAT {money(p.vat_amount, p.currency)}</div> : null}
                  {/* 적용환율을 적어 둔 외화 건은 원화로 얼마인지도 함께 — 손익·결산이
                      집계에 쓰는 바로 그 값이라, 목록에서 확인할 수 있어야 한다. */}
                  {p.fx_rate ? (
                    <div className="muted">
                      {won(p.invoice_amount * p.fx_rate)} @{p.fx_rate.toLocaleString()}
                    </div>
                  ) : null}
                </td>
                <td className="num" data-label="Paid">{money(p.paid_amount, p.currency)}</td>
                <td className="num" data-label="Payable">{money(p.outstanding, p.currency)}</td>
                {statusCell(p)}
                {recurrenceCell(p)}
                {actionCell(p)}
              </tr>
            ))}
          </tbody>
          {totalsFoot(view === "payables" ? "Bill" : "Amount")}
        </table>
      </section>
      {head.renderMenu()}

      {paying ? (
        <PaymentDateModal
          row={paying.row}
          occurrence={paying.occurrence}
          onClose={() => setPaying(null)}
          onSaved={() => { setPaying(null); reload(); }}
        />
      ) : null}
      {adding ? (
        // 손으로 등록한 지출은 분류가 '거래선지급'이면 Payables, 컨설팅비면 그 갈래,
        // 그 외에는 Other costs 로 들어간다 — 저장 뒤 그 갈래로 옮겨 방금 넣은 항목이
        // 바로 보이게 한다.
        <PayableForm
          initial={adding}
          onClose={() => setAdding(null)}
          onSaved={(category) => {
            setAdding(null);
            setView(category === "거래선지급" ? "payables"
              : category === CONSULTING ? "consulting" : "other");
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

/**
 * 소개 수수료의 근거 — 소개자가 걸린 프로젝트마다 '매출 × 요율 = 수수료'.
 *
 * 아래 지급 목록과 나란히 두지 않고 그 위에 세운다. 목록은 이미 낸 것을 적고, 이 표는
 * 내야 할 것을 센다 — 같은 갈래 안의 서로 다른 두 질문이라 열이 겹치지 않는다.
 * 요율은 프로젝트 1단계에서 정한 값(없으면 컨설턴트 기본율)이고, 매출은 그 딜의 고객
 * 청구 합계다. 아직 청구 전이면 고객 P/O 금액을 임시 근거로 쓰고 그렇다고 밝힌다.
 */
function ConsultingBasis({ onRegister }: { onRegister: (prefill: FinancePayableSave) => void }) {
  const { data, error } = useCachedData<{ rows: FinanceConsultingRow[]; usd_krw: number }>(
    "finance:consulting",
    fetchFinanceConsulting
  );
  const canCreate = can("finance", "create");
  const rows = data?.rows ?? [];

  function prefill(r: FinanceConsultingRow): FinancePayableSave {
    return {
      ...emptyPayable,
      category: CONSULTING,
      counterparty: r.consultant,
      rfq_id: r.rfq_id,
      description: `Consulting fee · ${r.project_no || r.rfq_no || r.customer}`,
      // 수수료는 이미 계산된 값이라 총액으로 그대로 넣는다(부가세는 폼에서 고른다).
      amount: r.pay_amount,
      vat_amount: 0,
      currency: r.pay_currency,
      // 지급 예정일 = 그 딜의 매출이 들어온 날 + 1주일. 소개비는 받은 돈에서 떼어 주는
      // 것이라 입금 전에는 예정일이 없다 — 그때는 비워 두고 사람이 정하게 한다
      // (청구일 기준으로 넣어 두면 아직 들어오지도 않은 돈에 기일부터 서는 셈이었다).
      due_date: r.collected_date ? addDays(r.collected_date, 7) : "",
      notes: `${r.rate}% of ${money(r.sales_amount, r.currency)} sales`
        + (r.basis === "order" ? " (customer P/O — not invoiced yet)" : "")
        + (r.collected_date ? ` · collected ${r.collected_date}` : " · not collected yet"),
    };
  }

  if (error && !data) return <div className="state error">API error: {error.message}</div>;
  if (!data) return <div className="state">Loading…</div>;

  return (
    <section className="fin-sec fin-consult">
      <div className="items-head">
        <h4 className="sub-h" style={{ margin: 0 }}>Fee due by project</h4>
        <span className="hint-inline">
          Sales × the rate agreed on the RFQ. Set the introducer on the project&apos;s stage 1.
        </span>
      </div>
      <table className="mini fin-consult-table">
        <thead>
          <tr>
            <th>Project</th>
            <th>Customer</th>
            <th>Consultant</th>
            <th className="num">Sales</th>
            <th className="num fin-consult-rate">Rate</th>
            <th className="num">Fee</th>
            <th className="num">Registered</th>
            <th className="fin-w-act" />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={8} className="mini-empty">
                No project has an introducer yet — set one on the project&apos;s stage 1 (RFQ received).
              </td>
            </tr>
          ) : null}
          {rows.map((r) => {
            const booked = currencyKeys(r.registered).length > 0;
            return (
              <tr key={r.rfq_id} className={booked ? "" : "fin-consult-open"}>
                <td className="fin-c-title">
                  <ProjectDocLink rfqId={r.rfq_id} label={r.project_no || r.rfq_no || `#${r.rfq_id}`} />
                  {r.project_title ? <div className="muted">{r.project_title}</div> : null}
                </td>
                <td>{r.customer}</td>
                <td>
                  {r.consultant || <span className="dash">—</span>}
                  {/* 계좌를 여기 함께 보이는 이유: 지급 직전에 확인하는 값이고, 비어 있다면
                      등록하러 가야 한다는 뜻이라 그 사실 자체가 이 표의 정보다. */}
                  {r.bank ? <div className="muted">{r.bank}</div> : <div className="hint-inline">No account on file</div>}
                </td>
                <td className="num">
                  {r.basis === "none" ? <span className="dash">Not sold yet</span> : money(r.sales_amount, r.currency)}
                  {r.basis === "order" ? <div className="hint-inline">customer P/O</div> : null}
                </td>
                <td className="num fin-consult-rate">{r.rate}%</td>
                {/* 판 통화 그대로 낸다 — 달러 딜이면 달러로. 원화 환산은 실제로 송금할 때
                    적용환율과 함께 정해지므로 여기서는 미리 바꿔 두지 않는다. */}
                <td className="num fin-consult-fee">{money(r.fee, r.currency)}</td>
                <td className="num">
                  {booked ? byCurrencyLines(r.registered) : <span className="dash">—</span>}
                </td>
                <td className="fin-c-act">
                  {canCreate && r.basis !== "none" ? (
                    <button
                      className="btn tiny"
                      title={booked
                        ? "Register another payment for this project (split payments)"
                        : "Create the payable with the consultant and amount filled in"}
                      onClick={() => onRegister(prefill(r))}
                    >
                      {booked ? "+ Again" : "Register"}
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/**
 * 상태 칸을 한 낱말로 — 머리행의 상태 필터가 고를 수 있는 값.
 *
 * 표에 그려지는 배지는 반복 항목이면 "3 paid" 처럼 회차 수를 달고 나오는데, 그대로
 * 쓰면 회차 수마다 다른 값이 되어 고를 수 없다. 여기서는 묻는 것("낸 건가, 밀린 건가")
 * 만 남긴다. 순번은 급한 것부터 — 정렬하면 밀린 건이 위로 온다.
 */
function payableStatus(p: FinancePayable): { label: string; rank: number } {
  const late = !!p.overdue && !p.paid;
  const part = p.paid_amount > 0 || (p.paid_dates?.length ?? 0) > 0;
  if (p.paid) return { label: p.source === "bankfee" ? "Deducted" : "Paid", rank: 4 };
  if (late) return { label: part ? "Partly paid · overdue" : "Overdue", rank: part ? 1 : 0 };
  return part ? { label: "Partly paid", rank: 2 } : { label: "Payable", rank: 3 };
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

/**
 * 외화 지급의 적용환율 — 이 건이 원화로 얼마인지를 정하는 한 칸.
 *
 * 기본값은 그 날짜의 매매기준율(수출입은행 고시)이다. 다만 여기 남길 값은 고시가 아니라
 * **실제로 은행에서 적용받은 환율**이라, 채워 넣은 뒤 손으로 고칠 수 있어야 한다 — 그래서
 * 자동 조회는 사람이 아직 손대지 않은 동안에만 값을 밀어 넣는다. 날짜(계산서일·지급 예정일)를
 * 바꾸면 그 날 고시로 다시 따라오되, 이미 고쳐 둔 값은 건드리지 않는다.
 */
function PayableFxField({
  form,
  set,
}: {
  form: FinancePayableSave;
  set: <K extends keyof FinancePayableSave>(k: K, v: FinancePayableSave[K]) => void;
}) {
  const cur = form.currency || "USD";
  const on = (form.bill_date || "").slice(0, 10) || (form.due_date || "").slice(0, 10) || todayStr();
  // 손으로 고쳤는가 — 고친 뒤에는 날짜가 바뀌어도 고시로 덮어쓰지 않는다.
  const [touched, setTouched] = useState(() => !!form.fx_rate);
  const [quote, setQuote] = useState<{ rate: number; date: string; source: string } | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    setErr("");
    fetchFxRate(on, cur)
      .then((q) => {
        if (!alive) return;
        const rate = q.rate / (q.unit || 1);
        setQuote({ rate, date: q.date_used, source: q.source });
        if (q.source !== "exim") setErr(q.reason === "no_key" ? "FX API key not set" : "quote unavailable");
        // 아직 사람이 손대지 않았다면 고시값으로 채운다.
        if (!touched) set("fx_rate", Math.round(rate * 100) / 100);
      })
      .catch(() => { if (alive) setErr("quote failed"); });
    return () => { alive = false; };
    // touched 는 의도적으로 뺀다 — 손댄 뒤에 다시 조회해 덮어쓰지 않게.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, cur]);

  const rate = form.fx_rate || 0;
  return (
    // label 이 아니라 div — 라벨 안에 버튼을 두면 클릭이 금액 칸으로 새어 든다
    // (부가세 칸이 select 를 div 로 감싼 것과 같은 이유).
    <div className="form-field">
      <span className="fin-vat-label">
        FX rate (₩ per {sym(cur).trim()})
        {quote ? (
          <button
            type="button"
            className="btn tiny fin-fx-reset"
            title={quote.date ? `매매기준율 ${quote.date}` : "fixed rate (no quote)"}
            onClick={() => { setTouched(false); set("fx_rate", Math.round(quote.rate * 100) / 100); }}
          >
            매매기준율 {quote.rate.toLocaleString()}
          </button>
        ) : null}
      </span>
      <input
        className="num"
        inputMode="decimal"
        value={amountInputValue(rate)}
        onChange={(e) => { setTouched(true); set("fx_rate", parseAmountInput(e.target.value) ?? 0); }}
      />
      <span className="hint-inline">
        {rate
          ? `≈ ${won(Math.round((form.amount || 0) * rate))} on ${on}`
          : `Leave blank to convert at that month's base rate.`}
        {err ? ` · ${err}` : ""}
      </span>
    </div>
  );
}

/** 분류·통화로 정하는 기본 부가세율 — 급여·세금(납부한 세금)과 외화 건은 매입세액이 없어 0.
 *  그 밖은 10%. 어디까지나 처음 채워 주는 값이고, 실제 세율은 폼에서 직접 고른다. */
function autoVatRate(category: string, currency: string): number {
  if ((currency || "KRW").toUpperCase() !== "KRW") return 0;
  // 소개 수수료도 0 에서 출발한다 — 개인 소개자는 세금계산서 대신 원천징수 대상이라
  // 부가세가 붙지 않는 쪽이 흔하다(법인 소개자면 폼에서 10% 로 되돌린다).
  return category === "급여" || category === "세금" || category === CONSULTING ? 0 : 0.1;
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

/** 소개 수수료의 근거 — 이 딜의 매출(그 통화)과 요율, 그리고 거기서 나온 수수료. */
type FeeBase = { sales: number; currency: string; rate: number; fee: number };

/**
 * "2026-07-31" + 1개월 → "2026-08-31". 그 달에 없는 날(31일)은 말일로 당긴다.
 * 'YYYY-MM' 만 준 경우(비용 귀속 기간)는 같은 형식으로 돌려준다.
 */
function addMonths(value: string, n: number): string {
  const v = (value || "").trim();
  if (!v) return "";
  const [ys, ms, ds] = v.slice(0, 10).split("-");
  const y = Number(ys);
  const m = Number(ms);
  if (!y || !m) return v;
  const t = new Date(y, m - 1 + n, 1);
  const p = (x: number) => String(x).padStart(2, "0");
  const ym = `${t.getFullYear()}-${p(t.getMonth() + 1)}`;
  if (!ds) return ym;
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  return `${ym}-${p(Math.min(Number(ds) || 1, last))}`;
}

/**
 * 이 줄을 그대로 베낀 '다음 달' 등록감 — 날짜만 한 달 밀고 나머지는 손대지 않는다.
 *
 * 매달 같은 항목을 다시 두드리는 일을 없애는 것이 목적이라, 금액·분류·거래선·부가세는
 * 물론 비용 귀속 기간까지 그대로 따라간다. 납부 여부는 따라가지 않는다(새 건은 미납에서
 * 시작한다 — 서버가 그렇게 만든다).
 */
function nextMonthCopy(p: FinancePayable): FinancePayableSave {
  return {
    category: p.category,
    counterparty: p.counterparty,
    vendor_id: p.vendor_id ?? null,
    rfq_id: p.rfq_id || null,
    description: p.description,
    amount: p.amount,
    vat_amount: p.vat_amount || 0,
    currency: p.currency,
    fx_rate: p.fx_rate || undefined,
    bill_date: addMonths(p.bill_date || "", 1),
    due_date: addMonths(p.due_date || "", 1),
    recurrence: p.recurrence,
    recur_until: p.recur_until || "",
    accrual_from: addMonths(p.accrual_from || "", 1),
    accrual_to: addMonths(p.accrual_to || "", 1),
    notes: p.notes || "",
  };
}

/** 이 지급이 덮는 달 목록 — 백엔드 _accrual_months 와 같은 규칙(화면에서 몫을 미리 보여준다). */
function accrualMonths(f: FinancePayableSave): string[] {
  const a = (f.accrual_from || "").slice(0, 7);
  const b = (f.accrual_to || "").slice(0, 7) || a;
  if (a.length !== 7 || b.length !== 7 || b < a) return [];
  const out: string[] = [];
  let y = Number(a.slice(0, 4));
  let m = Number(a.slice(5, 7));
  while (`${y}-${String(m).padStart(2, "0")}` <= b && out.length < 60) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (m === 12) { y += 1; m = 1; } else { m += 1; }
  }
  return out;
}

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
  // 소개 수수료일 때만 필요한 목록 — 프로젝트를 고르면 소개자·금액이 함께 따라온다.
  // (분류를 바꿔 가며 열어 볼 수 있어 조건 없이 걸어 둔다 — 캐시라 왕복은 한 번뿐이다.)
  const { data: consulting } = useCachedData<{ rows: FinanceConsultingRow[]; usd_krw: number }>(
    "finance:consulting",
    fetchFinanceConsulting
  );
  const isConsulting = form.category === CONSULTING;
  const isVendorPay = form.category === VENDOR_PAY;
  // 거래선지급을 딜에 걸 때 고르는 목록 — 소개자가 걸린 딜만 담는 consulting 과 달리
  // 모든 딜이 후보다(발주서 없이 협력사에 바로 지급하는 건은 업무 타입을 가리지 않는다).
  const { data: pipeline } = useCachedData("pipeline", () => fetchPipeline());
  const dealOptions = useMemo(
    () =>
      [...(pipeline?.rows ?? [])]
        .sort((a, b) => (b.project_no || "").localeCompare(a.project_no || ""))
        .map((r) => ({
          rfqId: r.rfq_id,
          label: `${r.project_no || r.kmaris_rfq_no || `#${r.rfq_id}`} · ${r.customer}${r.project_title ? ` · ${r.project_title}` : ""}`,
        })),
    [pipeline]
  );

  // 이 지급이 매인 딜의 매출 청구서 — 우리 쪽 두 날짜가 무엇에 기대고 있는지 옆에
  // 세워 둔다. 고쳐 쓰라는 값이 아니라 견주라는 값이다: 소개비의 기일은 저쪽 청구가
  // 언제 서고 언제 들어왔는지에서 나오는데, 그걸 보려고 Inflow 탭을 다녀와야 했다.
  const { data: receivables } = useCachedData<{ rows: FinanceReceivable[]; fx: FxQuote }>(
    "finance:receivables",
    fetchFinanceReceivables
  );
  const salesRef = useMemo(() => {
    const rid = form.rfq_id || 0;
    if (!rid) return null;
    // 한 딜에 청구가 여러 건이면 마지막 것을 세운다 — 수수료도 마지막 입금을 따라간다.
    const ar = (receivables?.rows ?? [])
      .filter((r) => (r.source ?? "ar") === "ar" && r.rfq_id === rid)
      .sort((a, b) => (a.invoice_date || a.due_date || "").localeCompare(b.invoice_date || b.due_date || ""));
    const last = ar[ar.length - 1];
    return last ? { last, count: ar.length } : null;
  }, [receivables, form.rfq_id]);

  /**
   * 이 수수료의 근거 — 어느 딜의 매출 얼마에 몇 %인가.
   *
   * 금액은 사람이 정하는 값이 아니라 이 셋에서 나온다. 그래서 화면에 그대로 적어 두고
   * (공급가액 칸 아래), 통화나 환율이 바뀌면 여기서 다시 계산한다.
   */
  const feeBase = useMemo<FeeBase | null>(() => {
    if (!isConsulting || !form.rfq_id) return null;
    const r = (consulting?.rows ?? []).find((x) => x.rfq_id === form.rfq_id);
    return r ? { sales: r.sales_amount, currency: r.currency, rate: r.rate, fee: r.fee } : null;
  }, [consulting, form.rfq_id, isConsulting]);
  // 상태 갱신 함수는 렌더 밖에서 도므로 최신 근거를 ref 로 들려 보낸다.
  const feeBaseRef = useRef(feeBase);
  feeBaseRef.current = feeBase;

  /**
   * 수수료를 지급 통화로 환산 — 매출과 같은 통화면 그대로, 다르면 적용환율로 옮긴다.
   * fx_rate 는 '외화 1단위 = ₩?' 이라, 원화 매출을 외화로 낼 때는 나누고 그 반대는 곱한다.
   * 환율을 아직 모르면 null 을 준다: 그때 금액을 건드리면 적어 둔 값이 0으로 지워진다.
   */
  function feeIn(base: FeeBase, currency: string, fxRate: number): number | null {
    if ((currency || "KRW") === base.currency) return base.fee;
    if (!fxRate) return null;
    return base.currency === "KRW" ? round2(base.fee / fxRate) : round2(base.fee * fxRate);
  }

  /** 근거에서 다시 계산한 수수료를 폼에 접어 넣는다. vatRate 를 주면 그 세율로 계산한다. */
  function withFee(f: FinancePayableSave, base: FeeBase, vatRate?: number | null): FinancePayableSave {
    const amount = feeIn(base, f.currency || "KRW", f.fx_rate || 0);
    if (amount == null) return f;
    const r = vatRate === undefined ? (vatChoice === "custom" ? null : Number(vatChoice)) : vatRate;
    return r == null ? withMoney(f, amount, f.vat_amount || 0) : withMoney(f, amount, Math.round(amount * r));
  }

  function set<K extends keyof FinancePayableSave>(k: K, v: FinancePayableSave[K]) {
    setForm((f) => {
      const next = { ...f, [k]: v };
      // 환율이 정해지면(고시 조회·직접 입력) 그 통화의 수수료도 함께 정해진다 — 소개비는
      // 매출에서 나오는 값이라, 환율만 바뀌고 금액이 그대로면 틀린 값이 남는다.
      return k === "fx_rate" && feeBaseRef.current ? withFee(next, feeBaseRef.current) : next;
    });
  }

  /**
   * 프로젝트를 고르면 그 딜의 수수료가 통째로 채워진다 — 소개자 이름, 요율로 계산한
   * 금액, 그리고 근거를 적은 메모. 손으로 옮겨 적을 것이 남지 않게 하는 것이 요점이다:
   * 이 금액은 사람이 정하는 값이 아니라 매출에서 나오는 값이라, 다시 두드리면 틀린다.
   */
  function pickProject(rfqId: number) {
    const r = (consulting?.rows ?? []).find((x) => x.rfq_id === rfqId);
    if (!r) {
      setForm((f) => ({ ...f, rfq_id: null }));
      return;
    }
    setVatChoice(rateChoice(autoVatRate(CONSULTING, r.pay_currency)));
    setForm((f) => ({
      ...f,
      rfq_id: r.rfq_id,
      counterparty: r.consultant || f.counterparty,
      description: `Consulting fee · ${r.project_no || r.rfq_no || r.customer}`,
      amount: r.pay_amount,
      vat_amount: 0,
      currency: r.pay_currency,
      due_date: f.due_date || r.invoice_date || todayStr(),
      notes: `${r.rate}% of ${money(r.sales_amount, r.currency)} sales`
        + (r.basis === "order" ? " (customer P/O — not invoiced yet)" : ""),
    }));
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
    // 프로젝트 연결이 뜻을 갖는 분류는 둘뿐이다 — 소개 수수료(어느 딜의 매출에서 나왔나)와
    // 거래선지급(어느 딜의 매입인가). 그 밖으로 옮기면 연결을 지운다: 남겨 두면 임차료가
    // 어느 딜에 매인 것처럼 저장되고, 손익이 그것을 그 딜의 원가로 센다.
    if (next.category !== CONSULTING && next.category !== VENDOR_PAY) {
      next = { ...next, rfq_id: null };
    }
    let vatRate: number | null = null;
    let out = next;
    if (vatChoice !== "custom") {
      vatRate = autoVatRate(next.category || "기타", next.currency || "KRW");
      setVatChoice(rateChoice(vatRate));
      out = withRate(next, vatRate);
    }
    // 통화를 바꾸면 수수료도 그 통화의 값이 된다 — 원화 1,049,000 이 달러 칸에 그대로
    // 남아 $1,049,000 이 되던 것을 막는다. 환율을 아직 모르는 순간(방금 USD 로 바꾼
    // 직후)에는 그대로 두고, FX 칸이 고시를 물어온 뒤 set() 이 다시 맞춘다.
    if (next.category === CONSULTING && feeBase) out = withFee(out, feeBase, vatRate);
    setForm(out);
  }

  const supply = supplyOf(form);
  const vat = form.vat_amount || 0;

  async function save() {
    if (!(form.due_date || "").trim()) { setErr("Enter a due date."); return; }
    if (!(form.description || "").trim() && !(form.counterparty || "").trim()) {
      setErr("Enter a description or counterparty."); return;
    }
    // 수수료는 어느 딜의 매출에서 나왔는지가 곧 그 금액의 근거다 — 딜 없이 저장하면
    // 근거표가 이 지급을 되찾지 못해 같은 수수료를 또 등록하게 된다.
    if (isConsulting && !form.rfq_id) { setErr("Select the project this fee belongs to."); return; }
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
        {/* 소개 수수료는 거래선이 아니라 '어느 딜'에 매인다 — 그 자리에 프로젝트를 세운다.
            고르면 소개자·금액·근거가 함께 따라온다. */}
        {isConsulting ? (
          <label className="form-field">
            <span>Project *</span>
            <select
              value={form.rfq_id ?? ""}
              onChange={(e) => pickProject(e.target.value ? Number(e.target.value) : 0)}
            >
              <option value="">— Select a project —</option>
              {(consulting?.rows ?? []).map((r) => (
                <option key={r.rfq_id} value={r.rfq_id}>
                  {(r.project_no || r.rfq_no || `#${r.rfq_id}`)} · {r.customer} · {r.consultant}
                </option>
              ))}
            </select>
            {(consulting?.rows ?? []).length === 0 ? (
              <span className="hint-inline">No project has an introducer yet — set one on stage 1.</span>
            ) : null}
          </label>
        ) : (
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
        )}
        {/* 벤더 P/O 없이 나간 지급 — 딜을 지목하면 그 딜의 매입 원가가 된다. 비워 두면
            지금까지처럼 합계 밖(어느 P/O 의 매입을 손으로 한 번 더 적은 것으로 본다). */}
        {isVendorPay ? (
          <label className="form-field">
            <span>Project (optional)</span>
            <select
              value={form.rfq_id ?? ""}
              onChange={(e) => set("rfq_id", e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">— Not tied to a deal —</option>
              {dealOptions.map((d) => (
                <option key={d.rfqId} value={d.rfqId}>{d.label}</option>
              ))}
            </select>
            <span className="hint-inline">
              {form.rfq_id
                ? "Counted as this deal's purchase cost in Profit and Closing · VAT — use it for money paid without a vendor P/O."
                : "Leave empty if a vendor P/O already carries this cost (stage 9 AP), or it would be counted twice."}
            </span>
          </label>
        ) : null}
        <label className="form-field">
          <span>{isConsulting ? "Consultant" : "Vendor / payee"}</span>
          <input
            value={form.counterparty}
            onChange={(e) => set("counterparty", e.target.value)}
            placeholder={isConsulting ? "Filled in from the project" : "e.g. Landlord / Payroll"}
          />
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
          {/* 이 금액이 어디서 나왔는지 — 매출 × 요율. 손으로 고칠 수 있는 칸이라, 근거를
              곁에 두어야 고친 값이 근거와 어긋났는지 그 자리에서 보인다. 지급 통화가
              매출 통화와 다르면 환산까지 이어 적는다(무슨 환율로 얼마가 되었는가). */}
          {feeBase ? (
            <span className="hint-inline">
              Base {money(feeBase.sales, feeBase.currency)} sales × {feeBase.rate}% ={" "}
              {money(feeBase.fee, feeBase.currency)}
              {(form.currency || "KRW") !== feeBase.currency ? (
                form.fx_rate
                  ? ` → ${money(feeIn(feeBase, form.currency || "KRW", form.fx_rate) ?? 0, form.currency || "KRW")} at ${form.fx_rate.toLocaleString()}`
                  : " — set the FX rate below to convert"
              ) : ""}
            </span>
          ) : null}
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
        {/* 외화 지급에만 묻는다 — 이 건이 통장에서 원화 얼마로 빠져나가는가. 손익·결산은
            그 달 말일 매매기준율로 환산하지만, 실제로 송금한 날의 환율을 적어 두면 그것이
            이 지출의 진짜 원화 금액이므로 집계가 그 값을 쓴다. */}
        {(form.currency || "KRW") !== "KRW" ? <PayableFxField form={form} set={set} /> : null}
        <label className="form-field">
          {/* 고지서·계산서를 받은 날(선택). 벤더 청구서의 발행일과 같은 뜻이라 목록에서 한 열에 모인다. */}
          <span>Bill date (optional)</span>
          <input type="date" value={form.bill_date || ""} onChange={(e) => set("bill_date", e.target.value)} />
          {/* 그 딜의 매출 청구서는 언제 섰나 — 이 지급의 청구일을 견줄 자리. */}
          {salesRef ? (
            <span className="hint-inline">
              Sales {salesRef.last.invoice_no || salesRef.last.ci_no || "invoice"} billed{" "}
              {salesRef.last.invoice_date || "—"}
              {salesRef.count > 1 ? ` · latest of ${salesRef.count}` : ""}
            </span>
          ) : null}
        </label>
        <label className="form-field">
          <span>Due date{form.recurrence !== "none" ? " · first occurrence" : ""}</span>
          <input type="date" value={form.due_date} onChange={(e) => set("due_date", e.target.value)} />
          {/* 그 매출이 언제 들어오기로 했고 실제로 언제 들어왔나 — 수수료 기일(입금 + 1주일)의 근거. */}
          {salesRef ? (
            <span className="hint-inline">
              Sales due {salesRef.last.due_date || "—"}
              {salesRef.last.paid_date
                ? ` · collected ${salesRef.last.paid_date}`
                : ` · ${salesRef.last.outstanding > 0 ? "not collected yet" : "collection date unknown"}`}
            </span>
          ) : null}
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
        {/* 고지서 한 장이 여러 달을 덮을 때 — 4대보험 6·7월분을 8월에 한 번에 받는 식이다.
            비워 두면 청구일 한 달에 통째로 선다. 반복 항목은 회차 자체가 달을 나누므로 묻지 않는다. */}
        {form.recurrence === "none" ? (
          <div className="form-field fin-accrual" style={{ gridColumn: "1 / -1" }}>
            <span>Cost period (optional)</span>
            <div className="fin-accrual-row">
              <input
                type="month"
                value={form.accrual_from || ""}
                aria-label="Cost period from"
                onChange={(e) => set("accrual_from", e.target.value)}
              />
              <span className="fin-accrual-tilde">~</span>
              <input
                type="month"
                value={form.accrual_to || ""}
                aria-label="Cost period to"
                onChange={(e) => set("accrual_to", e.target.value)}
              />
              {form.accrual_from || form.accrual_to ? (
                <button
                  type="button"
                  className="btn tiny"
                  onClick={() => setForm((f) => ({ ...f, accrual_from: "", accrual_to: "" }))}
                >
                  Clear
                </button>
              ) : null}
            </div>
            <span className="hint-inline">
              {accrualMonths(form).length > 1
                ? `Split evenly over ${accrualMonths(form).length} months — ${money(
                  (form.amount || 0) / accrualMonths(form).length, form.currency || "KRW")} each in Profit.`
                : "One bill covering several months — set the months it belongs to and Profit spreads it evenly. Leave blank to book it all on the bill date."}
            </span>
          </div>
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

/** 월별 내역 표의 한 줄 — Profit 의 손익 줄과 같은 모양(kind 가 소계·총계를 가른다). */
type ClosingLine = {
  name: string;
  values: number[];
  kind?: "sum" | "grand";
  hint?: string;
};

// ── Claims — 납품 후 하자 비용과 그 정산 ───────────────────────────────────────
// 한 사건에서 돈은 세 갈래로 갈린다: 고객·벤더가 자기 돈으로 처리한 몫, 우리가 청구서를
// 깎아 준 몫(크레딧 노트), 우리가 현금으로 물어 준 몫. 이 표는 그 셋을 한 줄에 세워
// "이 클레임이 우리에게 얼마였나"와 "아직 정산이 남았나"를 한눈에 답한다.
// 금액은 전부 KRW 환산이다 — 현장 비용은 USD, 깎아 준 청구서는 KRW 인 일이 흔해서
// 통화를 섞은 채로는 더할 수가 없다(사건이 난 달의 말일 매매기준율).
const CLAIM_STATUS_LABEL: Record<string, string> = {
  open: "Open",
  settled: "Settled",
  closed: "Closed",
};

function ClaimsTab() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const { data, error } = useCachedData<FinanceClaimsData>(
    `finance:claims:${year}`,
    () => fetchFinanceClaims(year)
  );
  const years = Array.from({ length: 6 }, (_, i) => now.getFullYear() - i);
  const rows = data?.rows ?? [];

  return (
    <div className="fin-overview">
      <div className="fin-period-bar">
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <span className="fin-period-range">Claims raised in {year}</span>
      </div>

      {error && !data ? <div className="state error">API error: {error.message}</div> : null}
      {!data ? <div className="state">Loading…</div> : (
        <>
          <div className="fin-kpis">
            <KpiTile label="Our share" main={won(data.totals.ours_krw)} sub={`${data.totals.count} claim(s)`} tone="amber" />
            <KpiTile label="Offset by credit notes" main={won(data.totals.credited_krw)} sub="Deducted from receivables" tone="blue" />
            <KpiTile label="Paid in cash" main={won(data.totals.cash_krw)} sub="Booked as a cost" tone="red" />
            <KpiTile
              label="Not settled yet"
              main={won(data.totals.open_krw)}
              sub="Our share still to be credited or paid"
              tone={data.totals.open_krw > 0 ? "red" : "green"}
            />
          </div>

          <div className="panel">
            <h3 className="form-title">Claims</h3>
            {rows.length === 0 ? (
              <div className="muted">No claim recorded in {year}.</div>
            ) : (
              <div className="table-wrap">
                <table className="mini wide">
                  <thead>
                    <tr>
                      <th style={{ width: 92 }}>Date</th>
                      <th style={{ width: 120 }}>Project</th>
                      <th>Customer · claim</th>
                      <th style={{ width: 80 }}>Status</th>
                      <th className="num" style={{ width: 110 }}>Our share</th>
                      <th className="num" style={{ width: 110 }}>Credited</th>
                      <th className="num" style={{ width: 100 }}>Cash</th>
                      <th className="num" style={{ width: 110 }}>Open</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <Fragment key={r.id}>
                        <tr>
                          <td>{r.date || "—"}</td>
                          <td>
                            <ProjectDocLink rfqId={r.rfq_id} orderId={r.order_id} stage={11} claim
                                            label={r.project_no || `#${r.rfq_id}`} />
                          </td>
                          <td>
                            {r.customer}
                            <span className="muted"> · {r.title || r.claim_no || "claim"}</span>
                            {r.site ? <span className="muted"> · {r.site}</span> : null}
                          </td>
                          <td>{CLAIM_STATUS_LABEL[r.status] || r.status}</td>
                          <td className="num">{won(r.ours_krw)}</td>
                          <td className="num">{r.credited_krw ? won(r.credited_krw) : "—"}</td>
                          <td className="num">{r.cash_krw ? won(r.cash_krw) : "—"}</td>
                          <td className={`num${r.open_krw > 0 ? " fin-claim-open" : ""}`}>
                            {r.open_krw ? won(r.open_krw) : "—"}
                          </td>
                        </tr>
                        {/* 크레딧 노트는 클레임 아래 한 줄씩 — 어느 청구서를 얼마에 깎았는지가
                            사건과 떨어져 있으면 두 표를 오가며 맞춰 봐야 한다. */}
                        {r.credit_notes.map((cn) => (
                          <tr key={`cn${cn.id}`} className="fin-c-subrow">
                            <td>{cn.issue_date}</td>
                            <td className="muted">CN</td>
                            <td colSpan={2}>
                              {/* 두 문서 번호는 각자의 자리로 간다 — 노트는 이 클레임의
                                  11단계 Claim 탭, 청구서는 그 청구서가 선 딜의 9단계.
                                  상계 대상은 다른 프로젝트의 미수일 수 있어(cn.rfq_id)
                                  둘이 서로 다른 딜을 가리킬 수 있다. */}
                              <ProjectDocLink
                                rfqId={r.rfq_id}
                                orderId={r.order_id}
                                stage={11}
                                claim
                                label={cn.cn_no || `CN#${cn.id}`}
                              />
                              <span className="muted"> → </span>
                              <ProjectDocLink
                                rfqId={cn.rfq_id}
                                orderId={cn.order_id}
                                label={cn.invoice_no || `AR#${cn.ar_id}`}
                              />
                              <span className="muted">
                                {cn.issue_currency && cn.issue_currency !== cn.currency
                                  ? ` · ${cn.issue_currency} ${cn.issue_amount.toLocaleString()} × ${cn.fx_rate.toLocaleString()}`
                                  : ""}
                              </span>
                            </td>
                            <td />
                            <td className="num">{won(cn.total)}</td>
                            <td colSpan={2} />
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="hint-inline" style={{ display: "block", marginTop: 8 }}>
              Amounts are converted to KRW at the month-end base rate of the month the claim occurred —
              except a line settled by a credit note, which is worth what that note settled it at (its own
              rate), so a fully credited claim closes at zero instead of leaving a rounding tail.
              What the customer or the vendor bore is not counted here as ours. A credited amount is a
              deduction from sales (it already lowers that invoice and its VAT), a cash amount is a cost
              under Outflow — never both for the same line. Claims are entered on the deal, at stage 11 →
              Claim · Credit Note.
            </p>
            {/* 어떤 환율로 옮겼는지 — 이 줄이 없으면 표를 검산할 수가 없고, 고시를 못 받아
                1:1 로 선 통화가 섞여 있어도(EUR 390 이 ₩390 으로 서는 식) 알 길이 없다. */}
            {data.fx && data.fx.rates.length ? (
              <p className="hint-inline" style={{ display: "block", marginTop: 4 }}>
                Converted at:{" "}
                {data.fx.rates.map((r, i) => (
                  <span key={`${r.month}-${r.cur}-${i}`}>
                    {i ? " · " : ""}
                    {r.month} {r.cur} ₩{r.rate.toLocaleString()}
                    {r.entered ? " (as credited)" : r.date ? ` (매매기준율 ${r.date})` : ""}
                  </span>
                ))}
                {data.fx.fallback
                  ? " — a rate without a quote date fell back to the fixed one, and any currency other than USD"
                    + " falls back to 1:1, which is not a real conversion. Set EXIM_API_KEY to quote them."
                  : "."}
              </p>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

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

  // 월별 내역의 줄 — 위 그래프가 그린 매출·매입 위에 마진과 부가세를 얹는다. 그래프는
  // 크기를 견주는 자리고 이 표는 값을 확인하는 자리라, 같은 열두 달을 두 방식으로 읽는다.
  // 부가세 계열은 백엔드가 나중에 붙은 값이라(배포 시차) 없으면 그 세 줄만 접는다.
  const monthlyLines = useMemo<ClosingLine[]>(() => {
    const m = data?.monthly;
    if (!m) return [];
    const n = m.labels.length;
    const at = (a: number[] | undefined, i: number) => a?.[i] ?? 0;
    const lines: ClosingLine[] = [
      { name: "Sales (supply value)", values: m.sales },
      { name: "Purchases (cost)", values: m.purchase },
      { name: "Gross profit", kind: "sum",
        values: Array.from({ length: n }, (_, i) => at(m.sales, i) - at(m.purchase, i)) },
    ];
    if (m.output_vat && m.input_vat) {
      const out = m.output_vat, inp = m.input_vat;
      lines.push({ name: "Output VAT", values: out });
      lines.push({ name: "Input VAT", values: inp, hint: "purchases + other costs" });
      lines.push({ name: "VAT payable", hint: "− is a refund", kind: "grand",
                   values: Array.from({ length: n }, (_, i) => at(out, i) - at(inp, i)) });
    }
    return lines;
  }, [data]);

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
            {/* 매출은 이미 크레딧 노트만큼 깎인 값이다 — 얼마를 깎았는지 함께 적지 않으면
                "왜 청구서 합계와 다르지?"가 된다. */}
            <KpiTile
              label="Sales (supply value)"
              main={won(data.sales.supply_krw)}
              sub={`${data.sales.count} · VAT ${won(data.sales.vat_krw)}`
                + (data.credit_notes && data.credit_notes.count
                    ? ` · credit notes −${won(data.credit_notes.supply_krw)}`
                    : "")}
              tone="blue"
            />
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

          {/* 월별 내역 — 줄이 항목, 칸이 달. Profit 의 손익 장표와 같은 표를 쓴다(같은
              모양이라 두 화면을 오가도 눈이 다시 적응하지 않는다). 위 그래프와 달리
              마진과 부가세까지 한 장에 서므로, 어느 달에 세금이 몰렸는지가 여기서 보인다. */}
          <div className="panel">
            <h3 className="form-title">Monthly breakdown ({year}, ₩)</h3>
            <div className="fin-pl-scroll">
              <table className={`mini fin-pl${data.monthly.labels.length <= 6 ? " fin-pl--few" : ""}`}>
                <thead>
                  <tr>
                    <th className="fin-pl-name">Line</th>
                    {data.monthly.labels.map((m) => <th key={m} className="num">{m}</th>)}
                    <th className="num tot">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyLines.map((l) => (
                    <tr key={l.name} className={l.kind ? `fin-pl-${l.kind}` : ""}>
                      <td className="fin-pl-name">
                        {l.name}
                        {l.hint ? <span className="hint-inline"> {l.hint}</span> : null}
                      </td>
                      {l.values.map((v, i) => <td key={i} className="num">{cell(v)}</td>)}
                      <td className="num tot">{cell(sumOf(l.values))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint-inline" style={{ display: "block", marginTop: 8 }}>
              계산 규약은 위 카드와 같다 — 매출은 고객 청구서, 매입은 9단계에 등록한 벤더
              청구서, 기타 지출의 매입세액은 지급 건에 입력한 부가세다. 크레딧 노트는 매출과
              매출세액에서 이미 빠져 있다. 이 표는 위에서 고른 기간으로 좁혀지지 않고 늘
              {" "}{year}년 열두 달을 편다 — 고른 기간이 나머지 달들 사이에서 어디쯤인지를
              함께 보라고 둔 자리다.
            </p>
          </div>

          <div className="fin-overview-cols">
            <div className="panel">
              <h3 className="form-title">VAT calculation</h3>
              <table className="mini">
                <tbody>
                  <tr><td>Output VAT</td><td className="num">{won(data.vat.output_krw)}</td></tr>
                  {/* 매입세액은 두 갈래 — 프로젝트 매입(벤더 청구서의 세율)과 기타 지출(입력값). */}
                  <tr><td>Input VAT · purchases</td><td className="num">− {won(data.vat.input_purchase_krw ?? data.vat.input_krw)}</td></tr>
                  <tr>
                    <td>
                      Input VAT · other costs
                      {data.other_costs ? <span className="muted"> ({data.other_costs.count})</span> : null}
                    </td>
                    <td className="num">− {won(data.vat.input_other_krw ?? 0)}</td>
                  </tr>
                  {data.credit_notes && data.credit_notes.count ? (
                    <tr>
                      <td>
                        Credit notes issued
                        <span className="muted"> ({data.credit_notes.count})</span>
                      </td>
                      <td className="num">− {won(data.credit_notes.vat_krw)}</td>
                    </tr>
                  ) : null}
                  <tr className="foot-grand">
                    <td className="total-label">{data.vat.payable_krw >= 0 ? "Payable" : "Refund"}</td>
                    <td className="num total-value">{won(Math.abs(data.vat.payable_krw))}</td>
                  </tr>
                </tbody>
              </table>
              <p className="hint-inline" style={{ display: "block", marginTop: 8 }}>
                Exports (zero-rated) carry 0 output VAT. Both sides count what was billed: sales on the customer
                invoice, purchases on the vendor bill entered at stage 9 — a P/O with no bill against it yet is not
                a purchase here. Purchase input VAT comes from the rate on that bill, other costs from the VAT
                entered on each payable, so register rent, utilities and the like with the supply value and VAT
                split (actual filing is based on tax invoices).
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
      {/* 실제 납부일 자리에 찍힌 이벤트는 체크+진한 칸으로 구분(예정일 이벤트는 옅은 칸에 취소선). */}
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
        {/* 색은 돈의 방향 두 가지뿐 — 어느 쪽이 무엇을 담는지까지 적는다. 파랑에만 출처를
            적고 주황은 'Payables' 한 마디로 두면, 달력 주황 칸의 절반인 매입청구(AP)와
            나머지 비용이 범례에 없는 셈이 된다. 이름은 Outflow 갈래(Purchases / Other
            costs)와 같은 말로 적는다 — 범례에만 있는 말을 지어내지 않는다.
            농도 규칙은 표 아래 설명이 받는다. */}
        <div className="fin-legend fin-cal-legend">
          <span className="fin-legend-item"><span className="fin-dot fin-dot--rec" /> Money in — sales (AR) · other income</span>
          <span className="fin-legend-item"><span className="fin-dot fin-dot--pay" /> Money out — vendor bills (AP) · other costs</span>
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
        Colour is the direction of the money — blue comes in, amber goes out — and the shade is whether it has actually moved: pale is a scheduled date, deep is a real receipt or payment, and a solid block is a scheduled date now overdue. Every item sits on its scheduled date until it settles, then appears again on the day the money actually moved — the scheduled entry stays pale and struck through, and the deeper ✓ entry is the real date. Click one of your own costs to record its payment — you enter the date it was really paid, which may differ from the scheduled date (recurring items settle one occurrence at a time); click a paid one to undo. Customer invoices (AR) and vendor bills (AP) are managed from the project stages instead — both on stage 11, the Receivable tab for collections and the Payable tab for vendor payments.
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
