"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { fetchFinanceCashflowItems } from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";
import type { FinanceCashflowItem, FinanceCashflowItems } from "@/lib/types";
import {
  CATEGORY_LABEL,
  INCOME_CATEGORY_LABEL,
  KpiTile,
  ProjectDocLink,
  money,
  sym,
} from "@/components/screens/FinanceScreen";

/**
 * 한 건이 어떤 돈인지 — 출처 + (지급대장·기타수입은) 분류까지.
 * 이미 오간 건은 이름을 달리한다: 청구서(Receivable)와 입금(Receipt)은 같은 줄에
 * 나란히 설 수 있어서, 이름이 같으면 어느 쪽이 실적인지 표에서 구분되지 않는다.
 */
function typeLabel(r: FinanceCashflowItem): string {
  switch (r.kind) {
    case "ar": return r.actual ? "Receipt" : "Receivable";
    case "ap": return r.actual ? "Payment" : "Vendor bill";
    case "po": return "P/O cost (est.)";
    case "income": return `Other income · ${INCOME_CATEGORY_LABEL[r.memo] || r.memo}`;
    case "payable": return `Payable · ${CATEGORY_LABEL[r.memo] || r.memo}`;
  }
}

const EMPTY_ITEMS: FinanceCashflowItems = {
  start: "", end: "", currency: "KRW", inflow: [], outflow: [],
  total_inflow: 0, total_outflow: 0, actual_inflow: 0, actual_outflow: 0,
};

/** "2026-07-01" → "Jul 1". 같은 구간 안이라 연도는 접어 둔다. */
function dayLabel(iso: string): string {
  const [y, m, d] = (iso || "").split("-").map(Number);
  if (!y || !m || !d) return iso || "";
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * 현금흐름 한 구간의 건별 내역 화면(/finance/period).
 *
 * Cash Flow 표의 한 칸이 '₩12,481,876' 한 덩어리로만 보이면 그 안에 무엇이 들었는지
 * 알 길이 없다. 이 화면은 그 칸을 그대로 펼친다 — 같은 규칙으로 담고 합계도 표의
 * 그 행과 맞는다. 주소에 기간·통화가 담겨 있어 링크로 주고받거나 새로고침해도 같은
 * 화면이 열린다.
 */

export default function FinancePeriodScreen() {
  const params = useSearchParams();
  const start = params.get("start") || "";
  const end = params.get("end") || "";
  const label = params.get("label") || (start && end ? `${start} ~ ${end}` : "");
  const currency = (params.get("cur") || "KRW").toUpperCase();
  const includePo = params.get("po") === "1";
  const first = params.get("first") === "1";
  // Cash Flow 표에서 금액을 눌러 왔으면 그쪽 표를 먼저 보여 준다(둘 다 렌더는 한다).
  const side = params.get("side") === "out" ? "out" : params.get("side") === "in" ? "in" : "";
  // 어디서 들어왔는지 — 돌아가기 링크가 떠나온 자리를 그대로 가리키게.
  const from = params.get("from") || "";
  const router = useRouter();
  /** 통화만 바꾼 같은 기간 주소 — 잔고·합계는 한 통화 안에서만 의미가 있어 환산하지 않는다. */
  const withCurrency = (cur: string) => {
    const q = new URLSearchParams(params.toString());
    q.set("cur", cur);
    return `/finance/period?${q.toString()}`;
  };

  const cash = (n: number) => money(n, currency);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end);

  const key = `finance:cashflow:items:${start}:${end}:${currency}:${includePo}:${first}`;
  // 주소가 성치 않으면 서버를 부르지 않는다(아래에서 안내 화면으로 빠진다).
  const { data, error } = useCachedData<FinanceCashflowItems>(
    key,
    () => (valid ? fetchFinanceCashflowItems(start, end, currency, includePo, first)
                 : Promise.resolve(EMPTY_ITEMS))
  );

  const net = useMemo(() => (data ? data.total_inflow - data.total_outflow : 0), [data]);

  const backHref = from === "overview" ? "/finance" : "/finance?tab=cashflow";
  const backLabel = from === "overview" ? "← Overview" : "← Cash Flow";

  if (!valid) {
    return (
      <div className="fin-overview">
        <div className="state error">This page needs a period — open it from the Cash Flow table.</div>
        <p><Link className="fin-doc-link" href={backHref}>← Back to Cash Flow</Link></p>
      </div>
    );
  }

  return (
    <div className="fin-overview">
      <div className="fin-period-head">
        <Link className="btn sm" href={backHref}>{backLabel}</Link>
        <h2 className="form-title fin-period-title">{label}</h2>
        <div className="seg-toggle" role="group" aria-label="Currency">
          {(["KRW", "USD"] as const).map((c) => (
            <button key={c} className={currency === c ? "on" : ""} onClick={() => router.replace(withCurrency(c))}>
              {c === "KRW" ? "₩ KRW" : "$ USD"}
            </button>
          ))}
        </div>
        <span className="muted">
          {start} → {end}
          {includePo ? " · incl. vendor PO (est.)" : ""}
          {first ? " · absorbs earlier overdue" : ""}
        </span>
      </div>

      {error && !data ? <div className="state error">API error: {error.message}</div> : null}
      {!data ? <div className="state">Loading…</div> : (
        <>
          <div className="fin-kpis">
            <KpiTile
              label="Inflow"
              main={cash(data.total_inflow)}
              sub={data.actual_inflow ? `${cash(data.actual_inflow)} already received` : "all still expected"}
              tone="blue"
            />
            <KpiTile
              label="Outflow"
              main={cash(data.total_outflow)}
              sub={data.actual_outflow ? `${cash(data.actual_outflow)} already paid` : "all still scheduled"}
              tone="amber"
            />
            <KpiTile label="Net" main={`${net >= 0 ? "+" : "−"}${cash(Math.abs(net))}`} tone={net >= 0 ? "green" : "red"} />
          </div>

          {/* 표에서 유출 금액을 눌러 왔으면 유출을 위로 — 보러 온 표가 먼저 눈에 들게. */}
          {(side === "out" ? (["out", "in"] as const) : (["in", "out"] as const)).map((s) => (
            <ItemPanel
              key={s}
              side={s}
              rows={s === "in" ? data.inflow : data.outflow}
              total={s === "in" ? data.total_inflow : data.total_outflow}
              currency={currency}
            />
          ))}

          <p className="hint-inline" style={{ display: "block", marginTop: 10 }}>
            Dates are the day the money is expected (receivable due date, payable occurrence) or the day it
            actually moved for settled items. Only {currency} items are listed — nothing is converted, so these
            totals match the {currency} row in the Cash Flow table exactly.
          </p>
        </>
      )}
    </div>
  );
}

function ItemPanel({ side, rows, total, currency }: {
  side: "in" | "out";
  rows: FinanceCashflowItem[];
  total: number;
  currency: string;
}) {
  const cash = (n: number) => money(n, currency);
  const title = `${side === "in" ? "Inflow" : "Outflow"} (${sym(currency).trim()})`;
  return (
    <div className="panel">
      <h3 className="form-title">{title} <span className="muted">· {rows.length} item{rows.length === 1 ? "" : "s"}</span></h3>
      {rows.length === 0 ? (
        <div className="muted">Nothing in this period.</div>
      ) : (
        <table className="mini">
          <thead>
            <tr>
              <th>Date</th><th>Type</th><th>Counterparty</th><th>Reference</th><th>Status</th><th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.kind}-${r.row_id}-${r.date}-${r.actual ? "a" : "e"}-${i}`} className={r.overdue ? "fin-overdue" : ""}>
                <td>{dayLabel(r.date)}</td>
                <td>{typeLabel(r)}</td>
                <td>{r.party || "—"}</td>
                <td>
                  {/* 프로젝트에서 관리하는 건(AR·AP·P/O)은 그 단계로 바로 건너뛴다. */}
                  {r.kind === "ar" || r.kind === "ap" || r.kind === "po" ? (
                    <ProjectDocLink
                      orderId={r.order_id}
                      rfqId={r.rfq_id}
                      label={r.ref || "(no number)"}
                      apPoId={r.kind === "ar" ? undefined : r.po_id || undefined}
                    />
                  ) : (r.ref || "—")}
                </td>
                <td>
                  {r.actual
                    ? <span className="fin-cf-actual">{side === "in" ? "Received" : "Paid"}</span>
                    : r.overdue ? <b>Overdue</b> : <span className="muted">Expected</span>}
                </td>
                <td className="num">{cash(r.amount)}</td>
              </tr>
            ))}
            <tr className="fin-period-total">
              <td colSpan={5}><b>Total</b></td>
              <td className="num"><b>{cash(total)}</b></td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
