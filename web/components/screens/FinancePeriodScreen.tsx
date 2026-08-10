"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { fetchFinanceCashflowItems } from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";
import type { CashBucket, FinanceCashflowItem, FinanceCashflowItems } from "@/lib/types";
import {
  CATEGORY_LABEL,
  INCOME_CATEGORY_LABEL,
  KpiTile,
  ProjectDocLink,
  money,
  sym,
} from "@/components/screens/financeShared";

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
  start: "", end: "", currency: "KRW", bucket: "", inflow: [], outflow: [],
  total_inflow: 0, total_outflow: 0, actual_inflow: 0, actual_outflow: 0,
};

/** 여섯 갈래의 화면 이름 — Overview 의 세 기둥에 적힌 것과 같은 말을 쓴다. */
const BUCKET_TITLE: Record<CashBucket, string> = {
  receivables: "Receivables",
  income: "Other income",
  collected: "Collected",
  payables: "Payables",
  other: "Other costs",
  paid: "Paid",
};
const IN_BUCKETS: CashBucket[] = ["receivables", "income", "collected"];
function isBucket(v: string): v is CashBucket {
  return v in BUCKET_TITLE;
}

/** 예정일에서 오늘까지 며칠 지났나 — 연체 줄에 "12 days overdue" 로 적는다. */
function daysLate(iso: string): number {
  const due = Date.parse(`${iso}T00:00:00`);
  if (Number.isNaN(due)) return 0;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.max(0, Math.round((today - due) / 86400000));
}

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
  const urlParams = useSearchParams();
  // 통화 토글은 같은 페이지의 질의값만 바꾼다. router.replace 로 하면 그때마다 라우터
  // 전환(서버 왕복)이 걸려 눌러도 한참 안 바뀌는 것처럼 보인다 — 얕게 갱신하고 화면은
  // 이 상태로 즉시 되돌린다(Finance 화면의 useFinanceNav 와 같은 이유).
  const [qs, setQs] = useState(() =>
    typeof window === "undefined" ? urlParams.toString() : window.location.search.replace(/^\?/, "")
  );
  useEffect(() => {
    const fromRouter = urlParams.toString();
    if (fromRouter === window.location.search.replace(/^\?/, "")) setQs(fromRouter);
  }, [urlParams]);
  useEffect(() => {
    const onPop = () => setQs(window.location.search.replace(/^\?/, ""));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const params = useMemo(() => new URLSearchParams(qs), [qs]);
  const start = params.get("start") || "";
  const end = params.get("end") || "";
  const label = params.get("label") || (start && end ? `${start} ~ ${end}` : "");
  const currency = (params.get("cur") || "KRW").toUpperCase();
  const includePo = params.get("po") === "1";
  const first = params.get("first") === "1";
  // 연체를 합계에 넣을지 — Overview 의 같은 이름 스위치를 주소로 물려받는다. 기본은
  // 빼고 센다(오지 않은 돈은 잔고가 아니다). 여기 합계가 저쪽 표의 그 행과 맞아야 하므로
  // 규칙도 같아야 한다.
  const includeOverdue = params.get("ovd") === "1";
  // Overview 세 기둥의 한 줄을 눌러 왔으면 그 갈래만 펼친다(비어 있으면 유입·유출 전부).
  const bucketParam = params.get("bucket") || "";
  const bucket: CashBucket | "" = isBucket(bucketParam) ? bucketParam : "";
  // 갈래를 정하지 않고 금액만 눌러 왔으면 그쪽 표를 먼저 보여 준다(둘 다 렌더는 한다).
  const side: "in" | "out" = bucket
    ? (IN_BUCKETS.includes(bucket) ? "in" : "out")
    : params.get("side") === "out" ? "out" : "in";
  /** 통화만 바꿔 다시 그린다 — 잔고·합계는 한 통화 안에서만 의미가 있어 환산하지 않는다. */
  const pickCurrency = (cur: string) => {
    const q = new URLSearchParams(window.location.search);
    q.set("cur", cur);
    const next = q.toString();
    window.history.replaceState(null, "", `/finance/period?${next}`);
    setQs(next);
  };

  const cash = (n: number) => money(n, currency);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end);

  const key = `finance:cashflow:items:${start}:${end}:${currency}:${includePo}:${first}:${bucket}`;
  // 주소가 성치 않으면 서버를 부르지 않는다(아래에서 안내 화면으로 빠진다).
  const { data, error } = useCachedData<FinanceCashflowItems>(
    key,
    () => (valid ? fetchFinanceCashflowItems(start, end, currency, includePo, first, bucket)
                 : Promise.resolve(EMPTY_ITEMS))
  );

  // 서버가 주는 total_* 는 연체까지 다 더한 값이라, 빼고 볼 때는 여기서 다시 센다 —
  // 그래야 Overview 표의 그 행·그 칸과 같은 숫자가 나온다.
  const sums = useMemo(() => {
    const add = (rows: FinanceCashflowItem[], parked: boolean) =>
      rows.reduce((t, r) => t + (!!r.overdue === parked ? r.amount : 0), 0);
    const odIn = data ? add(data.inflow, true) : 0;
    const odOut = data ? add(data.outflow, true) : 0;
    const inflow = (data?.total_inflow ?? 0) - (includeOverdue ? 0 : odIn);
    const outflow = (data?.total_outflow ?? 0) - (includeOverdue ? 0 : odOut);
    return { inflow, outflow, odIn, odOut, net: inflow - outflow };
  }, [data, includeOverdue]);
  const net = sums.net;
  const backHref = "/finance";

  if (!valid) {
    return (
      <div className="fin-overview">
        <div className="state error">This page needs a period — open it from the cash flow table.</div>
        <p><Link className="fin-doc-link" href={backHref}>← Back to Finance</Link></p>
      </div>
    );
  }

  return (
    <div className="fin-overview">
      <div className="fin-period-head">
        <Link className="btn sm" href={backHref}>← Finance</Link>
        <h2 className="form-title fin-period-title">
          {label}{bucket ? <span className="muted"> · {BUCKET_TITLE[bucket]}</span> : null}
        </h2>
        <div className="seg-toggle" role="group" aria-label="Currency">
          {(["KRW", "USD"] as const).map((c) => (
            <button key={c} className={currency === c ? "on" : ""} onClick={() => pickCurrency(c)}>
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
          {bucket ? (
            <div className="fin-kpis fin-kpis--actual">
              <KpiTile
                label={BUCKET_TITLE[bucket]}
                main={cash(side === "in" ? sums.inflow : sums.outflow)}
                sub={`${(side === "in" ? data.inflow : data.outflow).length} items · ${label}`}
                tone={side === "in" ? "blue" : "amber"}
              />
            </div>
          ) : (
            <div className="fin-kpis">
              <KpiTile
                label="Inflow"
                main={cash(sums.inflow)}
                sub={data.actual_inflow ? `${cash(data.actual_inflow)} already received` : "all still expected"}
                tone="blue"
              />
              <KpiTile
                label="Outflow"
                main={cash(sums.outflow)}
                sub={data.actual_outflow ? `${cash(data.actual_outflow)} already paid` : "all still scheduled"}
                tone="amber"
              />
              <KpiTile label="Net" main={`${net >= 0 ? "+" : "−"}${cash(Math.abs(net))}`} tone={net >= 0 ? "green" : "red"} />
            </div>
          )}

          {/* 갈래가 걸렸으면 그 표 하나만. 아니면 둘 다 — 눌러 온 쪽을 위로 올린다. */}
          {(bucket ? [side] : side === "out" ? (["out", "in"] as const) : (["in", "out"] as const)).map((s) => (
            <ItemPanel
              key={s}
              side={s}
              title={bucket ? `${BUCKET_TITLE[bucket]} (${sym(currency).trim()})` : ""}
              rows={s === "in" ? data.inflow : data.outflow}
              total={s === "in" ? sums.inflow : sums.outflow}
              overdue={s === "in" ? sums.odIn : sums.odOut}
              includeOverdue={includeOverdue}
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

function ItemPanel({ side, title, rows, total, overdue, includeOverdue, currency }: {
  side: "in" | "out";
  /** 갈래를 걸고 들어왔을 때의 제목(비우면 Inflow/Outflow). */
  title?: string;
  rows: FinanceCashflowItem[];
  /** 합계 — 연체를 뺀(또는 넣은) 값. 아래 줄들의 단순 합이 아닐 수 있다. */
  total: number;
  /** 그중 연체 금액. 빼고 셀 때는 이 값이 total 밖에 있다는 뜻이라 따로 적는다. */
  overdue: number;
  includeOverdue: boolean;
  currency: string;
}) {
  const cash = (n: number) => money(n, currency);
  const heading = title || `${side === "in" ? "Inflow" : "Outflow"} (${sym(currency).trim()})`;
  return (
    <div className="panel">
      <h3 className="form-title">{heading} <span className="muted">· {rows.length} item{rows.length === 1 ? "" : "s"}</span></h3>
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
                    // 며칠 늦었는지까지 — Date 칸이 원래 결제일이므로 둘이 한 줄에서 읽힌다.
                    : r.overdue
                      ? <b title={`Due ${r.date}`}>{daysLate(r.date)} days overdue</b>
                      : <span className="muted">Expected</span>}
                </td>
                <td className="num">{cash(r.amount)}</td>
              </tr>
            ))}
            {/* 연체를 빼고 셀 때는 합계가 위 줄들의 단순 합이 아니다 — 얼마를 빼고 센
                것인지 그 자리에서 밝힌다(안 밝히면 더해 보는 사람이 틀렸다고 읽는다). */}
            {overdue ? (
              <tr className="fin-period-overdue">
                <td colSpan={5}>
                  {includeOverdue ? "Of which overdue (included)" : "Overdue — not counted in the total"}
                </td>
                <td className="num">{includeOverdue ? "" : "−"}{cash(overdue)}</td>
              </tr>
            ) : null}
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
