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
 * 표의 그 행 바로 '위'에 펼쳐지며, 줄마다 그 시점의 통장잔고를 굴려 적는다 — 앞 구간의
 * 기말잔고 바로 아래에서 출발해 마지막 줄이 그 행의 기말잔고로 닿게(합계는 내역의
 * 결론이지 머리말이 아니다).
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
  /** 이 건까지 굴린 잔고. 잔고를 움직이지 않는 줄(연체)이면 null — 칸을 비워 둔다. */
  balance: number | null;
  /** 그 날의 첫 줄인가 — 날짜를 여기서만 적고 위에 구분선을 둔다. */
  dayStart: boolean;
  /**
   * 이 줄의 잔고가 예측인가. 예정 건이 한 번이라도 지나가면 그 아래 잔고는 전부
   * 예측이 된다 — 그 뒤에 실제로 오간 건이 섞여 있어도 마찬가지다(앞의 예정이 빗나가면
   * 같이 어긋난다). 그래서 줄 자체가 예정인지가 아니라 '여기까지 예정을 만났는가'로 센다.
   */
  projected: boolean;
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
    case "credit":
      return r.party || "Credit note";
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
    // 크레딧 노트 번호가 있으면 그것까지 — 통장에 안 찍힌 줄이라, 무엇을 근거로 미수가
    // 지워졌는지는 이 한 줄이 아니면 장부에서 찾을 데가 없다.
    case "credit":
      return r.memo ? `Set-off · ${r.memo}` : "Set-off";
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

/** 예정일에서 오늘까지 며칠 지났나 — 연체 줄에 "12 days overdue" 로 적는다. */
function daysLate(iso: string): number {
  const due = Date.parse(`${iso}T00:00:00`);
  if (Number.isNaN(due)) return 0;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.max(0, Math.round((today - due) / 86400000));
}

export default function FinanceDaybook({ start, end, label, opening, currency, includePo, parkOverdue, parkExpected, first }: {
  start: string;
  end: string;
  /** 구간 이름 — 위 표의 Period 칸과 같은 말("2026-08", "8/1~8/7"). */
  label: string;
  /** 이 구간의 기초잔고 = 앞 구간의 누적잔고. 여기서부터 줄마다 굴린다. */
  opening: number;
  currency: string;
  includePo: boolean;
  /**
   * 연체를 잔고 밖에 세워 둘지 — 위 표를 낸 집계와 같은 값이어야 이 장부의 마지막 잔고가
   * 그 행의 기말잔고와 정확히 같아진다. 그래서 '연체를 뺄까'가 아니라 '저 집계가 뺐나'로
   * 받는다(부모가 응답을 보고 정한다).
   */
  parkOverdue: boolean;
  /**
   * 예정(아직 안 오간 돈)을 통째로 잔고 밖에 세워 둘지 — parkOverdue 와 같은 이유로
   * 부모가 응답을 보고 정한다. 켜지면 잔고 칸은 실제로 오간 돈만으로 굴러가고, 예정 줄은
   * 제자리(예정일)에 그대로 서되 잔고 칸을 비운다. 연체는 예정의 부분집합이라 이 값이
   * 켜져 있으면 parkOverdue 와 무관하게 함께 세워진다.
   */
  parkExpected: boolean;
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
    let metExpected = false;
    return merged.map(({ item, side }) => {
      // 아직 오지 않은 돈은 잔고를 움직이지 않는다 — 줄은 제자리(예정일)에 그대로 두고
      // 잔고 칸만 비운다. 두 갈래로 세워 둔다:
      //  · parkExpected — 예정 전부. 잔고를 '통장에 찍힌 것'으로 볼 때.
      //  · parkOverdue  — 그중 날짜가 지난 것만. 예정으로 앞을 내다보되, 오지 않은 돈으로
      //    굴린 잔고가 그 아래 전부와 다음 구간까지 함께 틀어지는 것은 막을 때.
      // 상계(noncash)는 어느 손잡이와도 무관하게 늘 세워 둔다 — 예정이라서가 아니라
      // 통장이 움직인 적이 없어서다. 나머지 둘은 '아직 안 온 돈'을 세우는 손잡이다.
      const parked = !!item.noncash || (!item.actual && parkExpected) || (item.overdue && parkOverdue);
      if (!parked) balance += side === "in" ? item.amount : -item.amount;
      const dayStart = item.date !== prevDay;
      prevDay = item.date;
      // 예측 표시는 '잔고를 움직인 예정'만 센다 — 세워 둔 연체는 잔고를 건드리지 않아
      // 그 아래 잔고를 예측으로 만들지 않는다.
      metExpected = metExpected || (!item.actual && !parked && !item.noncash);
      return { item, side, balance: parked ? null : balance, dayStart, projected: metExpected };
    });
  }, [data, opening, parkOverdue, parkExpected]);

  return (
    <div className="fin-db-wrap">
      {error && !data ? <div className="state error">API error: {error.message}</div> : null}
      {!data ? <div className="state">Loading…</div> : (
        <>
          <div className="fin-db-scroll">
            <table className="mini fin-daybook">
              {/* 폭은 바깥 Cash Flow 표(fin-cf-w-*)와 짝을 이룬다 — Inflow 세 칸의 오른쪽 끝이
                  그 표의 Inflow 칸 끝과, Outflow 는 Outflow 칸 끝과, Balance 는 그쪽 Balance
                  칸 끝과 맞는다. 그래서 마지막 줄의 잔고가 바로 아래 행의 기말잔고 위에
                  정확히 선다. */}
              <colgroup>
                <col className="fin-db-w-date" />
                <col className="fin-db-w-desc" /><col className="fin-db-w-ref" /><col className="fin-db-w-money" />
                <col className="fin-db-w-desc" /><col className="fin-db-w-ref" /><col className="fin-db-w-money" />
                <col className="fin-db-w-bal" />
              </colgroup>
              {/* 머리줄이 없다 — 이 표를 품은 Cash Flow 표의 머리줄(Period · Inflow ·
                  Outflow · Balance)이 같은 자리·같은 폭으로 서 있어 그것이 이 표의 머리
                  노릇을 한다. 여기서 한 벌 더 세우면 같은 이름이 두 줄 겹쳐 어느 쪽 표를
                  읽는지 흐려진다. */}
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
                {/* 합계 줄은 두지 않는다 — 유입·유출 합과 기말잔고는 바로 아래에서 이
                    서랍을 닫는 그 구간 행이 같은 칸에 적고 있고(그 행이 곧 이 장부의
                    합계 줄이다), 마지막 줄의 잔고가 곧 기말잔고다. 여기 한 벌 더 두면
                    같은 세 숫자가 잇달아 두 번 선다. */}
              </tbody>
            </table>
          </div>
          {/* 한 줄만 남긴다. '날짜순 한 건씩'도 '합이 아래 행과 같다'도 보면 알 수 있는
              것들이고, 서랍을 열 때마다 같은 문단을 다시 읽힐 이유가 없다. 보아서는 알 수
              없는 건 잔고 칸이 무엇을 세고 있는가 하나뿐이다 — 예정을 굴린 예측인지,
              실제로 오간 돈만인지. */}
          <p className="hint-inline" style={{ display: "block", marginTop: 10 }}>
            {parkExpected
              ? "✓ already moved, on the day it moved — the balance counts these and nothing else. The rest sit on their due date and show — for balance: scheduled is not settled, so it is not counted here."
              : <>
                  ✓ already moved, on the day it moved; the rest sit on their due date, so the balance past them is a
                  projection.{rows.some((r) => r.balance === null)
                    ? " Overdue lines stay on the date they were due and show — for balance: the money has not moved, so it is not counted."
                    : ""}
                </>}
          </p>
          {/* 상계 줄이 서 있을 때만, 그 줄이 어느 갈래인지에 따라. 보아서는 알 수 없는
              것들이다: 입금 옆의 줄은 왜 유출인지, 잔고 밖의 줄은 왜 잔고를 안 움직이는지. */}
          {rows.some((r) => r.item.paired) ? (
            <p className="hint-inline" style={{ display: "block", marginTop: 4 }}>
              A receipt is the amount that reached the bank. Where a credit note settled part of the invoice, that
              part is not in the receipt — it stands beside it on the same day, and the two together come to the
              invoice.
            </p>
          ) : null}
          {rows.some((r) => r.item.noncash && !r.item.paired) ? (
            <p className="hint-inline" style={{ display: "block", marginTop: 4 }}>
              A set-off standing on its own clears a receivable that was never collected. No money moved and the
              receivable already dropped by it, so it shows — for balance; the reference is the invoice credited.
            </p>
          ) : null}
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
  const { item: r, side, balance, dayStart, projected } = row;
  const cash = (n: number) => money(n, currency);
  // 상계 줄의 ref 는 '깎아 준 청구서'다 — 다른 줄이 자기 문서를 가리키는 자리에 이 줄만
  // 남의 문서를 세우는 셈인데, 그 남의 문서가 곧 이 줄의 뜻이다(무엇에서 지웠는가).
  const linked = r.kind === "ar" || r.kind === "ap" || r.kind === "po" || r.kind === "credit";
  const desc = (
    <>
      <div className="fin-db-desc">{descOf(r)}</div>
      <div className="hint-inline">
        {tagOf(r)}
        {/* 두 줄이 서로를 설명한다.
            입금 줄 — 금액은 통장에 꽂힌 돈이라 청구액과 다를 수 있다. 그 이유(상계로 얼마를
              덜어 냈나)를 그 줄에 적는다: 청구서 번호를 들고 금액을 맞춰 보는 사람이 여기서
              멈추지 않게.
            상계 줄 — '아직 안 온 돈'이 아니다. 이미 끝난 정산이라 expected 로 적으면 거짓말이
              되므로, 그 금액이 어느 청구서의 무엇인지로 닫는다. 입금 옆에 선 줄(paired)은
              '그 청구서의 나머지', 홀로 선 줄은 '그 청구서에 얼마가 남았나'. */}
        {r.kind === "ar" && r.actual && (r.set_off ?? 0) > 0
          ? <>
              <span className="fin-db-done"> · ✓ received</span>
              <span> · {cash(r.set_off ?? 0)} of the {cash(r.invoiced ?? 0)} invoice set off</span>
            </>
          : r.kind === "credit"
          ? <>
              <span className="fin-db-done"> · ✓ credited</span>
              {r.target_amount
                ? <span>
                    {" · "}
                    {r.paired
                      ? `the rest of the ${cash(r.target_amount)} invoice — settled, but not in cash`
                      : (r.target_outstanding ?? 0) > 0
                        ? `${cash(r.target_outstanding ?? 0)} left of ${cash(r.target_amount)}`
                        // 잔액이 음수 = 그 청구서는 이미 현금으로 다 받았다는 뜻이다.
                        // 이 노트는 그 청구서를 지운 게 아니라 고객에게 남은 크레딧이다.
                        : (r.target_outstanding ?? 0) < 0
                          ? `stands as credit — the ${cash(r.target_amount)} invoice was already settled`
                          : `cleared the ${cash(r.target_amount)} invoice in full`}
                  </span>
                : null}
            </>
          : r.actual
          ? <span className="fin-db-done"> · ✓ {side === "in" ? "received" : "paid"}</span>
          // 연체는 '늦었다'로 끝내지 않고 며칠인지까지 적는다 — 사흘 늦은 건과 석 달 늦은
          // 건은 같은 말로 부를 수 없다. 날짜 칸이 원래 결제일이므로 둘이 한 줄에서 읽힌다.
          : r.overdue
            ? <b className="fin-db-late"> · {daysLate(r.date)} days overdue</b>
            : <span> · expected</span>}
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
    // 아직 오지 않은 돈은 글자를 낮춘다 — 실제로 오간 건과 나란히 놓였을 때 어느 쪽이
    // 사실이고 어느 쪽이 아직 예정인지가 읽기 전에 갈리도록. 상계는 그 회색을 쓰지
    // 않는다: 통장을 안 거쳤을 뿐 이미 끝난 정산이라 예정과 한 색으로 묶으면 안 된다.
    r.actual || r.noncash ? "" : "fin-db-expected",
    r.noncash ? "fin-db-noncash" : "",
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
      {/* 예정 건을 한 번 지난 뒤의 잔고는 사실이 아니라 예측 — 아래 안내가 말로 하는 것을
          여기서는 색으로 보여 준다. 마이너스 잔고는 그래도 붉게 남긴다(경고가 먼저다).
          잔고를 움직이지 않은 줄(세워 둔 연체)은 숫자 대신 줄표 — 앞줄의 잔고를 한 번 더
          적으면 이 건으로 잔고가 움직인 것처럼 읽힌다. */}
      {balance === null ? (
        <td
          className="num fin-db-bal fin-db-parked"
          data-label="Balance"
          title={r.noncash
            ? "Set-off — settled without cash, so the balance does not move"
            : "Unsettled — not counted in the balance"}
        >
          —
        </td>
      ) : (
        <td
          className={`num fin-db-bal${projected ? " fin-db-proj" : ""}`}
          data-label="Balance"
          style={{ color: balance < 0 ? "#c0392b" : undefined }}
        >
          {cash(balance)}
        </td>
      )}
    </tr>
  );
}
