"use client";

import { useMemo } from "react";
import { fetchFinanceCashflowItems } from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";
import type { FinanceCashflowItem, FinanceCashflowItems } from "@/lib/types";
import {
  CATEGORY_LABEL,
  INCOME_CATEGORY_LABEL,
  ProjectDocLink,
  money,
} from "@/components/screens/financeShared";

/**
 * Daybook — Cash Flow 표의 한 줄을 그 자리에서 날짜순 장부로 펼친 것.
 *
 * 표는 한 달을 한 줄(유입·유출·잔고)로 접어 놓는다. 실제로 통장을 맞출 때 필요한 건
 * 그 안쪽이다: 며칠에 무엇이 들어오고 무엇이 나가 잔고가 얼마가 되는가. 이 조각은
 * 표의 그 행 바로 아래에 펼쳐지며, 줄마다 그 시점의 통장잔고를 굴려 적는다.
 *
 * 유입이 왼쪽, 유출이 오른쪽 — 위 표(Inflow·Outflow)와 세 기둥의 순서 그대로다.
 * 자기 조작칸은 두지 않는다: 기간·통화·기초잔고는 모두 표에서 그대로 받는다. 새 집계도
 * 만들지 않는다 — 같은 API·같은 규칙(/cashflow/items, 같은 통화, 같은 first 여부)이라
 * 이 장부의 합계와 기말잔고는 펼쳐 놓은 그 행과 정확히 같은 값이 된다.
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
 * "2026-08-05" → "08-05". 한 구간 안이라 연도는 접어 둔다(엑셀 자금 리스트와 같은 표기).
 * 다만 첫 구간은 그 앞의 연체·지난 회차까지 끌어안으므로, 구간 밖의 날은 접지 않고
 * 통째로 적는다 — "11-14" 가 1월 장부에 서 있으면 그 달의 날짜로 읽힌다.
 */
function dayCell(iso: string, start: string, end: string): string {
  if (!iso) return "";
  return iso >= start && iso <= end ? iso.slice(5) : iso;
}

export default function FinanceDaybook({ start, end, label, opening, currency, includePo, first }: {
  start: string;
  end: string;
  /** 구간 이름 — 위 표의 Period 칸과 같은 말("2026-08", "8/1~8/7"). */
  label: string;
  /** 이 구간의 기초잔고 = 앞 구간의 누적잔고. 여기서부터 줄마다 굴린다. */
  opening: number;
  currency: string;
  includePo: boolean;
  /** 창의 첫 칸인가 — 그렇다면 앞선 연체·지난 회차까지 이 장부가 끌어안는다. */
  first: boolean;
}) {
  const cash = (n: number) => money(n, currency);
  const key = `finance:cashflow:items:${start}:${end}:${currency}:${includePo}:${first}::`;
  const { data, error } = useCachedData<FinanceCashflowItems>(
    key,
    () => fetchFinanceCashflowItems(start, end, currency, includePo, first, "")
  );

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

  return (
    <div className="fin-db-wrap">
      {error && !data ? <div className="state error">API error: {error.message}</div> : null}
      {!data ? <div className="state">Loading…</div> : (
        <>
          <div className="fin-db-scroll">
            <table className="mini fin-daybook">
              {/* 폭은 위 Cash Flow 표(fin-cf-w-*)와 짝을 이룬다 — Inflow 세 칸의 오른쪽 끝이
                  그 표의 Inflow 칸 끝과, Outflow 는 Outflow 칸 끝과, Balance 는 그쪽 Balance
                  칸 끝과 맞는다. 그래서 마지막 줄의 잔고가 바로 위 행의 기말잔고 아래에
                  정확히 선다. */}
              <colgroup>
                <col className="fin-db-w-date" />
                <col className="fin-db-w-desc" /><col className="fin-db-w-ref" /><col className="fin-db-w-money" />
                <col className="fin-db-w-desc" /><col className="fin-db-w-ref" /><col className="fin-db-w-money" />
                <col className="fin-db-w-bal" />
              </colgroup>
              {/* 머리줄이 없다 — 바로 위 Cash Flow 표의 Period · Inflow · Outflow · Balance
                  가 같은 자리에 서 있어 그것이 이 표의 머리 노릇을 한다. 여기서 한 벌 더
                  세우면 같은 이름이 두 줄 겹쳐 어느 쪽 표를 읽는지 흐려진다. */}
              <tbody>
                {/* 첫 줄은 이월 — 잔고가 어디서 출발했는지 표 안에서 읽히게. */}
                <tr className="fin-db-carry">
                  <td>{start.slice(5)}</td>
                  <td colSpan={6}>Carried forward into {label}</td>
                  <td className="num" style={{ color: opening < 0 ? "#c0392b" : undefined }}>{cash(opening)}</td>
                </tr>
                {rows.length === 0 ? (
                  <tr><td className="mini-empty" colSpan={8}>Nothing moved in this period.</td></tr>
                ) : rows.map((r, i) => (
                  <DaybookLine
                    key={`${r.item.kind}-${r.item.row_id}-${r.item.date}-${r.item.actual ? "a" : "e"}-${r.side}-${i}`}
                    row={r}
                    start={start}
                    end={end}
                    currency={currency}
                  />
                ))}
                {/* 합계 줄은 두지 않는다 — 유입·유출 합과 기말잔고는 바로 위에 펼쳐 놓은
                    그 행이 이미 같은 칸에 적고 있고, 마지막 줄의 잔고가 곧 기말잔고다.
                    같은 세 숫자를 한 화면에 세 번 적는 셈이 된다. */}
              </tbody>
            </table>
          </div>
          {/* 한 줄만 남긴다. '날짜순 한 건씩'도 '합이 위 행과 같다'도 보면 알 수 있는 것들이고,
              서랍을 열 때마다 같은 문단을 다시 읽힐 이유가 없다. 보아서는 알 수 없는 건
              하나뿐이다 — 예정 건이 섞여 있어 그 아래 잔고는 사실이 아니라 예측이라는 것. */}
          <p className="hint-inline" style={{ display: "block", marginTop: 10 }}>
            ✓ already moved, on the day it moved; the rest sit on their due date, so the balance past them is a
            projection.
          </p>
        </>
      )}
    </div>
  );
}

/** 한 건 — 자기 쪽 세 칸만 채우고 반대편은 비운다(엑셀 자금 리스트와 같은 모양). */
function DaybookLine({ row, start, end, currency }: {
  row: DaybookRow;
  start: string;
  end: string;
  currency: string;
}) {
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
      {/* 날짜는 줄마다 빠짐없이 적는다. 같은 날의 두 번째 줄부터를 비워 두면 눈이 위로
          거슬러 올라가야 날짜를 알 수 있고, 통장과 한 줄씩 대조할 때는 그 한 번이 매번의
          품이 된다. 날이 바뀌는 자리는 dayStart 가 긋는 가로선이 따로 표시한다. */}
      <td className="fin-db-date">{dayCell(r.date, start, end)}</td>
      {/* 유입이 왼쪽, 유출이 오른쪽 — 위 표·세 기둥과 같은 순서. */}
      {side === "in" ? (
        <>
          <td className="fin-db-c-desc" data-label="Inflow">{desc}</td>
          <td className="fin-db-c-ref">{ref}</td>
          <td className="num" data-label="Inflow">{cash(r.amount)}</td>
          <td className="fin-db-c-desc" /><td className="fin-db-c-ref" /><td className="num" />
        </>
      ) : (
        <>
          <td className="fin-db-c-desc" /><td className="fin-db-c-ref" /><td className="num" />
          <td className="fin-db-c-desc" data-label="Outflow">{desc}</td>
          <td className="fin-db-c-ref">{ref}</td>
          <td className="num" data-label="Outflow">{cash(r.amount)}</td>
        </>
      )}
      <td className="num fin-db-bal" data-label="Balance" style={{ color: balance < 0 ? "#c0392b" : undefined }}>
        {cash(balance)}
      </td>
    </tr>
  );
}
