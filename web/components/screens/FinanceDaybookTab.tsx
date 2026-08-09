"use client";

import { useMemo, useState } from "react";
import { fetchFinanceCashflow, fetchFinanceCashflowItems } from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";
import type { FinanceCashflow, FinanceCashflowItem, FinanceCashflowItems } from "@/lib/types";
import { amountInputValue } from "@/components/common/itemTable";
import {
  CATEGORY_LABEL,
  INCOME_CATEGORY_LABEL,
  MONTH_NAMES,
  ProjectDocLink,
  localDayStr,
  money,
  monthBounds,
  monthLabel,
  startYears,
  sym,
} from "@/components/screens/financeShared";

/**
 * Daybook — 한 달의 자금 내역을 날짜순 한 장부로.
 *
 * Overview 의 Cash Flow 표는 한 달을 한 줄(유입·유출·잔고)로 접어 놓는다. 실제로 통장을
 * 맞출 때 필요한 건 그 안쪽이다: 며칠에 무엇이 나가고 무엇이 들어와 잔고가 얼마가 되는가.
 * 이 탭은 그 한 줄을 날짜순으로 펼치고, 줄마다 그 시점의 통장잔고를 굴려 적는다.
 *
 * 새 집계를 만들지 않는다 — Overview 와 같은 두 API(/cashflow, /cashflow/items)를 같은
 * 규칙(같은 통화, 같은 연초 기준 창)으로 부르므로, 이 달의 유입·유출 합계와 기말잔고는
 * Cash Flow 표의 그 달 행과 정확히 같은 값이 된다.
 */

/** 한 줄 = 한 건. side 는 어느 쪽 칸에 앉을지, balance 는 그 건까지 굴린 잔고. */
type DaybookRow = {
  item: FinanceCashflowItem;
  side: "in" | "out";
  balance: number;
  /** 그 날의 첫 줄인가 — 날짜를 여기서만 적고 위에 구분선을 둔다. */
  dayStart: boolean;
};

/** 통장에 찍힐 이름 — 사람이 붙인 적요가 있으면 그것, 없으면 상대처·분류로 대신한다. */
function descOf(r: FinanceCashflowItem): string {
  switch (r.kind) {
    case "ar":
      return r.party || (r.actual ? "Customer receipt" : "Customer invoice");
    case "ap":
      return r.party || "Vendor bill";
    case "po":
      return r.party || "Vendor P/O";
    case "income":
      return r.ref || INCOME_CATEGORY_LABEL[r.memo] || r.memo || "Other income";
    case "payable":
      return r.ref || CATEGORY_LABEL[r.memo] || r.memo || "Other cost";
  }
}

/** 무슨 성격의 돈인지 — 적요 아래 한 줄로 붙는다. */
function tagOf(r: FinanceCashflowItem): string {
  switch (r.kind) {
    case "ar":
      return r.actual ? "Receipt" : "Receivable";
    case "ap":
      return r.actual ? "Payment" : "Vendor bill";
    case "po":
      return "P/O cost (est.)";
    case "income":
      return INCOME_CATEGORY_LABEL[r.memo] || r.memo || "Other income";
    case "payable":
      return CATEGORY_LABEL[r.memo] || r.memo || "Other cost";
  }
}

/**
 * "2026-08-05" → "08-05". 한 달 안이라 연·월을 접는다(엑셀 자금 리스트와 같은 표기).
 * 다만 1월 장부는 그 앞의 연체·지난 회차까지 끌어안으므로, 이 달 밖의 날은 접지 않고
 * 통째로 적는다 — "11-14" 가 1월 시트에 서 있으면 그 달의 날짜로 읽힌다.
 */
function dayCell(iso: string, ym: string): string {
  if (!iso) return "";
  return iso.startsWith(ym) ? iso.slice(5) : iso;
}

export default function DaybookTab() {
  const today = localDayStr();
  const [year, setYear] = useState(() => Number(today.slice(0, 4)));
  const [month, setMonth] = useState(() => Number(today.slice(5, 7)));
  const [currency, setCurrency] = useState("KRW");
  const [includePo, setIncludePo] = useState(false);
  // 기초잔고는 통화별로 따로 기억한다(Overview 와 같은 이유 — ₩ 로 넣은 값이 $ 로 읽히면
  // 잔고 전체가 엉뚱해진다). 기준일은 그 해 1월 1일: 여기서부터 굴려 이 달 앞까지 온 값이
  // 이 장부의 첫 줄 잔고가 된다.
  const [openingByCur, setOpeningByCur] = useState<Record<string, string>>({ KRW: "0", USD: "0" });
  const openingInput = openingByCur[currency] ?? "0";
  const setOpeningInput = (v: string) => setOpeningByCur((m) => ({ ...m, [currency]: v }));
  const yearOpening = Number(openingInput) || 0;

  const ym = `${year}-${String(month).padStart(2, "0")}`;
  const [start, end] = monthBounds(ym);
  const cash = (n: number) => money(n, currency);

  // 1월부터 12칸 — 이 달의 기초잔고(앞 달까지의 누적)를 여기서 가져온다.
  // key 는 Overview 와 같은 모양이라, 같은 조건이면 캐시를 함께 쓴다.
  const cfKey = `finance:cashflow:month:12:${yearOpening}:${includePo}:${currency}:${year}-01`;
  const { data: cf, error: cfError } = useCachedData<FinanceCashflow>(
    cfKey,
    () => fetchFinanceCashflow("month", 12, yearOpening, includePo, currency, `${year}-01`)
  );

  // 창의 첫 칸(1월)은 그 앞의 연체·지난 회차를 흡수한다 — 집계와 같은 규칙이라야
  // 이 장부의 합계가 Cash Flow 표의 그 달 행과 맞는다.
  const first = month === 1;
  const itemsKey = `finance:cashflow:items:${start}:${end}:${currency}:${includePo}:${first}::`;
  const { data, error } = useCachedData<FinanceCashflowItems>(
    itemsKey,
    () => fetchFinanceCashflowItems(start, end, currency, includePo, first, "")
  );

  // 이 달의 기초잔고 = 앞 달의 누적잔고(1월이면 창 전체의 기초잔고).
  const opening = !cf ? 0 : month <= 1 ? cf.opening : cf.rows[month - 2]?.cumulative ?? cf.opening;

  const rows: DaybookRow[] = useMemo(() => {
    if (!data) return [];
    const merged = [
      ...data.inflow.map((item) => ({ item, side: "in" as const })),
      ...data.outflow.map((item) => ({ item, side: "out" as const })),
    ].sort((a, b) =>
      a.item.date.localeCompare(b.item.date) ||
      // 같은 날이면 들어온 돈을 먼저 — 그날 잔고가 바닥을 쳤는지 순서대로 읽히게.
      (a.side === b.side ? 0 : a.side === "in" ? -1 : 1) ||
      b.item.amount - a.item.amount
    );
    let balance = opening;
    let prevDay = "";
    return merged.map(({ item, side }) => {
      balance += side === "in" ? item.amount : -item.amount;
      const dayStart = item.date !== prevDay;
      prevDay = item.date;
      return { item, side, balance, dayStart };
    });
  }, [data, opening]);

  const totalIn = data?.total_inflow ?? 0;
  const totalOut = data?.total_outflow ?? 0;
  const ending = opening + totalIn - totalOut;
  const net = totalIn - totalOut;
  const loading = !data || !cf;
  const firstError = error || cfError;

  const stepMonth = (delta: number) => {
    const mm = month - 1 + delta;
    setYear(year + Math.floor(mm / 12));
    setMonth(((mm % 12) + 12) % 12 + 1);
  };

  return (
    <div className="fin-overview">
      <div className="fin-period-bar">
        <div className="fin-db-nav">
          <button type="button" className="btn sm" onClick={() => stepMonth(-1)} aria-label="Previous month">←</button>
          <label className="fin-inline-field">
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))} aria-label="Month">
              {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
            <select value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Year">
              {startYears().map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <button type="button" className="btn sm" onClick={() => stepMonth(1)} aria-label="Next month">→</button>
          <button
            type="button"
            className="btn sm"
            onClick={() => { setYear(Number(today.slice(0, 4))); setMonth(Number(today.slice(5, 7))); }}
          >
            This month
          </button>
        </div>
        <div className="seg-toggle" role="group" aria-label="Currency">
          <button className={currency === "KRW" ? "on" : ""} onClick={() => setCurrency("KRW")}>₩ KRW</button>
          <button className={currency === "USD" ? "on" : ""} onClick={() => setCurrency("USD")}>$ USD</button>
        </div>
        <label className="fin-inline-field">
          {/* 기준일이 1월 1일인 이유: 이 달의 첫 줄 잔고는 연초부터 굴려 온 값이다.
              '오늘 잔고'를 넣으면 올해 이미 오간 돈이 두 번 세어진다. */}
          Opening balance ({sym(currency).trim()}) <span className="muted">as of {year}-01-01</span>
          <input
            inputMode="decimal"
            value={amountInputValue(openingInput)}
            onChange={(e) => setOpeningInput(e.target.value.replace(/,/g, ""))}
            style={{ width: 140 }}
          />
        </label>
        <label className="check-chip" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={includePo} onChange={(e) => setIncludePo(e.target.checked)} /> Include vendor PO outflow (est.)
        </label>
      </div>

      {/* 엑셀 자금 리스트의 월별 시트 탭 자리 — 한 해를 한 줄에 두고 바로 건너뛴다. */}
      <div className="fin-db-months" role="group" aria-label="Month of year">
        {MONTH_NAMES.map((m, i) => (
          <button
            key={m}
            type="button"
            className={`fin-db-month${month === i + 1 ? " on" : ""}`}
            onClick={() => setMonth(i + 1)}
          >
            {String(year).slice(2)}{String(i + 1).padStart(2, "0")}
          </button>
        ))}
      </div>

      {firstError && loading ? <div className="state error">API error: {firstError.message}</div> : null}
      {loading ? <div className="state">Loading…</div> : (
        <>
          <div className="panel">
            <h3 className="form-title">
              {monthLabel(ym)} <span className="muted">· cash daybook ({sym(currency).trim()})</span>
            </h3>
            <table className="mini fin-daybook">
              <colgroup>
                <col className="fin-db-w-date" />
                <col /><col className="fin-db-w-ref" /><col className="fin-db-w-money" />
                <col /><col className="fin-db-w-ref" /><col className="fin-db-w-money" />
                <col className="fin-db-w-bal" />
              </colgroup>
              <thead>
                <tr>
                  <th rowSpan={2}>Date</th>
                  <th colSpan={3} className="fin-db-grp fin-db-grp--out">Out</th>
                  <th colSpan={3} className="fin-db-grp fin-db-grp--in">In</th>
                  <th rowSpan={2} className="num">Balance</th>
                </tr>
                <tr>
                  <th>Description</th><th>Reference</th><th className="num">Amount</th>
                  <th>Description</th><th>Reference</th><th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {/* 첫 줄은 전월 이월 — 잔고가 어디서 출발했는지 표 안에서 읽히게. */}
                <tr className="fin-db-carry">
                  <td>{start.slice(5)}</td>
                  <td colSpan={6}>Carried forward from {month <= 1 ? `${year}-01-01` : monthLabel(`${year}-${String(month - 1).padStart(2, "0")}`)}</td>
                  <td className="num" style={{ color: opening < 0 ? "#c0392b" : undefined }}>{cash(opening)}</td>
                </tr>
                {rows.length === 0 ? (
                  <tr><td className="mini-empty" colSpan={8}>Nothing moved in this month.</td></tr>
                ) : rows.map((r, i) => (
                  <DaybookLine
                    key={`${r.item.kind}-${r.item.row_id}-${r.item.date}-${r.item.actual ? "a" : "e"}-${r.side}-${i}`}
                    row={r}
                    ym={ym}
                    currency={currency}
                  />
                ))}
                <tr className="fin-period-total fin-db-total">
                  <td colSpan={3}><b>Total</b></td>
                  <td className="num" data-label="Out"><b>{cash(totalOut)}</b></td>
                  <td colSpan={2} />
                  <td className="num" data-label="In"><b>{cash(totalIn)}</b></td>
                  <td className="num" data-label="Balance" style={{ color: ending < 0 ? "#c0392b" : undefined }}>
                    <b>{cash(ending)}</b>
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="hint-inline" style={{ display: "block", marginTop: 10 }}>
              One line per movement, in date order, with the bank balance rolled forward line by line. Money already
              moved sits on the day it actually moved and is marked ✓; money still expected sits on its due date
              (receivable due date, payable occurrence) — so the balance below is a projection from that point on.
              Overdue items are pulled into January, which is where the year&apos;s balance starts. Only {currency} items
              are listed — nothing is converted, so the totals match the {ym} row of the Cash Flow table exactly.
            </p>
          </div>

          <div className="panel fin-db-summary">
            <h3 className="form-title">Month summary</h3>
            <table className="mini">
              <tbody>
                <tr>
                  <td>Opening<div className="hint-inline">carried in on {start}</div></td>
                  <td className="num">{cash(opening)}</td>
                </tr>
                <tr>
                  <td>In<div className="hint-inline">{data.actual_inflow ? `${cash(data.actual_inflow)} already received` : "all still expected"}</div></td>
                  <td className="num">{cash(totalIn)}</td>
                </tr>
                <tr>
                  <td>Out<div className="hint-inline">{data.actual_outflow ? `${cash(data.actual_outflow)} already paid` : "all still scheduled"}</div></td>
                  <td className="num">{cash(totalOut)}</td>
                </tr>
                <tr>
                  <td>Net<div className="hint-inline">in − out</div></td>
                  <td className="num" style={{ color: net >= 0 ? "#1e7a46" : "#c0392b" }}>
                    {net >= 0 ? "+" : "−"}{cash(Math.abs(net))}
                  </td>
                </tr>
                <tr className="fin-period-total">
                  <td><b>Ending</b></td>
                  <td className="num" style={{ color: ending < 0 ? "#c0392b" : undefined }}><b>{cash(ending)}</b></td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/** 한 건 — 자기 쪽 세 칸만 채우고 반대편은 비운다(엑셀 자금 리스트와 같은 모양). */
function DaybookLine({ row, ym, currency }: { row: DaybookRow; ym: string; currency: string }) {
  const { item: r, side, balance, dayStart } = row;
  const cash = (n: number) => money(n, currency);
  const linked = r.kind === "ar" || r.kind === "ap" || r.kind === "po";
  const desc = (
    <>
      <div className="fin-db-desc">{descOf(r)}</div>
      <div className="hint-inline">
        {tagOf(r)}
        {r.actual
          ? <span className="fin-db-done"> · ✓ {side === "in" ? "received" : "paid"}</span>
          : r.overdue ? <b className="fin-db-late"> · overdue</b> : <span> · expected</span>}
      </div>
    </>
  );
  const ref = linked ? (
    <ProjectDocLink
      orderId={r.order_id}
      rfqId={r.rfq_id}
      label={r.ref || "(no number)"}
      apPoId={r.kind === "ar" ? undefined : r.po_id || undefined}
    />
  ) : (r.party && r.party !== "—" ? r.party : "");

  const cls = [
    "fin-db-row",
    `fin-db-row--${side}`,
    dayStart ? "fin-db-daystart" : "",
    r.actual ? "fin-db-settled" : "",
    r.overdue ? "fin-overdue" : "",
  ].filter(Boolean).join(" ");

  return (
    <tr className={cls}>
      {/* 날짜는 늘 적어 두고, 같은 날의 두 번째 줄부터는 표에서만 감춘다 — 폰에서는
          한 건이 한 장의 카드로 서기 때문에 카드마다 날짜가 보여야 한다. */}
      <td className={`fin-db-date${dayStart ? "" : " fin-db-date--rep"}`}>{dayCell(r.date, ym)}</td>
      {side === "out" ? (
        <>
          <td className="fin-db-c-desc" data-label="Out">{desc}</td>
          <td className="fin-db-c-ref">{ref}</td>
          <td className="num" data-label="Out">{cash(r.amount)}</td>
          <td className="fin-db-c-desc" /><td className="fin-db-c-ref" /><td className="num" />
        </>
      ) : (
        <>
          <td className="fin-db-c-desc" /><td className="fin-db-c-ref" /><td className="num" />
          <td className="fin-db-c-desc" data-label="In">{desc}</td>
          <td className="fin-db-c-ref">{ref}</td>
          <td className="num" data-label="In">{cash(r.amount)}</td>
        </>
      )}
      <td className="num fin-db-bal" data-label="Balance" style={{ color: balance < 0 ? "#c0392b" : undefined }}>
        {cash(balance)}
      </td>
    </tr>
  );
}
