"use client";

import { useMemo, useState } from "react";
import { fetchFinanceProfit } from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";
import type { FinanceProfit } from "@/lib/types";
import { CATEGORY_LABEL, KpiTile, monthLabel } from "@/components/screens/financeShared";

/**
 * Profit — 한 해의 월별 손익을 한 장으로. 매출 − 비용 − 세금 = 순수익.
 *
 * Closing · VAT 는 고른 한 기간을 세로로 파고드는 화면이라(그 기간의 매출·매입·부가세),
 * '어느 달이 남았고 어느 달이 밑졌나'는 달을 바꿔 가며 열두 번 읽어야 알 수 있었다.
 * 여기서는 축을 돌린다 — 줄이 손익계산서의 항목, 칸이 달이다. 그래서 한 눈에 읽히는 건
 * 각 달의 값이 아니라 줄의 모양(어느 비용이 언제 튀는가)과 맨 아랫줄의 부호다.
 *
 * 계산 규약은 Closing · VAT 와 같다(같은 발생 기준·같은 환산). 다만 거기서 마진 밖에
 * 세워 두었던 것들 — 운영비·기타수입·세금 — 까지 이 표는 끝까지 뺀다. 그래서 매출총이익
 * (Closing 의 Gross profit)과 이 표의 Net profit 은 다른 값이며, 그 차이가 곧 아래 세
 * 묶음(운영비·부가세·세금 납부)이다.
 */

/** 12칸 배열끼리 더하기 — 손익 줄들의 소계는 전부 이 한 가지 모양이다. */
function addRows(...rows: number[][]): number[] {
  return Array.from({ length: 12 }, (_, i) => rows.reduce((s, r) => s + (r[i] || 0), 0));
}
const sumOf = (row: number[]) => row.reduce((s, n) => s + n, 0);

/** 표 칸의 금액 — 0은 점 하나로 눕힌다(열두 칸 중 대부분이 0인 줄이 많다). */
function cell(n: number): React.ReactNode {
  if (!Math.round(n)) return <span className="zero">–</span>;
  const s = Math.abs(Math.round(n)).toLocaleString();
  return n < 0 ? <span className="neg">−{s}</span> : s;
}

/** 막대 위 꼬리표 — 자릿수를 다 적으면 열두 칸이 서로 밀린다. */
function compact(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (a >= 1e8) return `${sign}₩${(a / 1e8).toFixed(a >= 1e9 ? 0 : 1)}억`;
  if (a >= 1e4) return `${sign}₩${(a / 1e4).toFixed(a >= 1e6 ? 0 : 1)}만`;
  return `${sign}₩${Math.round(a).toLocaleString()}`;
}
const won = (n: number) => `${n < 0 ? "−" : ""}₩${Math.abs(Math.round(n)).toLocaleString()}`;

/** 표의 한 줄 — 이름과 12칸, 그리고 어떤 줄인지(소계·총계·참고). */
type Line = {
  name: string;
  values: number[];
  kind?: "sum" | "grand" | "note";
  /** 합계 밖의 줄(참고용)임을 알리는 꼬리말. */
  hint?: string;
  /** 이 줄의 내역이 details 의 어느 key 에 있는지. 없으면 칸에 툴팁이 붙지 않는다. */
  detail?: string;
};

/**
 * 칸 하나의 툴팁 — "6월 · Purchases ₩8,060,000" 아래에 거래선/금액을 몇 줄.
 *
 * 브라우저 기본 툴팁(title)을 쓴다. 직접 그린 팝오버는 12×14 칸 위에서 스크롤·경계와
 * 싸워야 하는데, 여기서 원하는 건 잠깐 훑는 것뿐이라 그 값을 치를 이유가 없다.
 * 내역이 없거나 0인 칸은 빈 문자열을 돌려줘 툴팁 자체가 뜨지 않게 한다.
 */
function tip(
  details: FinanceProfit["details"],
  line: Line,
  month: number,
  label: string
): string {
  const v = line.values[month];
  if (!details || !line.detail || !Math.round(v)) return "";
  const cellDetail = details[line.detail]?.[String(month)];
  if (!cellDetail || cellDetail.rows.length === 0) return "";
  const body = cellDetail.rows.map((r) => `${r.name} / ${won(r.amount)}`);
  if (cellDetail.more) body.push(`+${cellDetail.more} more / ${won(cellDetail.more_amount)}`);
  return [`${label} · ${line.name} ${won(v)}`, ...body].join("\n");
}

export default function FinanceProfitTab() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  // 추정 부가세를 세금에 넣을지. 부가세를 실제 납부한 달에 '세금' 분류로 등록해 두었다면
  // 두 번 빠지므로 끌 수 있어야 한다(어느 쪽을 쓰든 줄은 표에 그대로 남는다).
  const [withVat, setWithVat] = useState(true);
  // 법인세 시뮬레이션을 세금에 넣을지. 추정일 뿐이라(세무조정 전) 끄고 볼 수 있어야 한다.
  const [withTax, setWithTax] = useState(true);

  const { data, error } = useCachedData<FinanceProfit>(
    `finance:profit:${year}`,
    () => fetchFinanceProfit(year)
  );
  const years = Array.from({ length: 6 }, (_, i) => now.getFullYear() - i);

  const model = useMemo(() => {
    if (!data) return null;
    const revenue = addRows(data.revenue.sales, data.revenue.other_income);
    const opex = data.costs.operating.map((o) => o.values);
    const costs = addRows(data.costs.purchase, data.costs.consulting, ...opex);
    const taxes = addRows(
      withVat ? data.taxes.vat : [],
      data.taxes.payments,
      withTax ? data.taxes.corporate : []
    );
    const net = Array.from({ length: 12 }, (_, i) => revenue[i] - costs[i] - taxes[i]);

    // 거래선지급을 손으로 등록한 경우에만 그 줄을 보인다 — 벤더 P/O 원가와 겹쳐서
    // 합계에는 넣지 않는다(넣으면 같은 매입이 두 번 빠진다).
    const vendorManual: Line[] = sumOf(data.costs.vendor_manual)
      ? [{
          name: "Vendor payment (manual)",
          values: data.costs.vendor_manual,
          kind: "note",
          hint: "not counted — already in Purchases",
          detail: "vendor_manual",
        }]
      : [];

    // 투자금 — 통장에는 들어왔지만 판 것이 아니라 넣은 것이다. 수익 합계 밖에 세우되
    // 숨기지는 않는다: 그 달에 돈이 들어온 것은 사실이고, 없으면 '왜 잔고가 늘었나'를
    // 이 표에서 설명할 수 없다.
    const investmentLine: Line[] = sumOf(data.revenue.investment)
      ? [{
          name: "Investment (capital in)",
          values: data.revenue.investment,
          kind: "note",
          hint: "not revenue — money put in, not sold",
          detail: "investment",
        }]
      : [];

    // 수수료는 매출월에 서고, 실제로 등록한 지급은 그 의무의 정산이라 합계 밖이다.
    // 소개자를 쓰지 않는 해에는 두 줄 다 감춘다 — 운영비 분류와 같은 규칙(값이 있어야 줄이 선다).
    const consultingLines: Line[] = [
      ...(sumOf(data.costs.consulting) || sumOf(data.costs.consulting_booked)
        ? [{ name: "Consulting fee", values: data.costs.consulting, detail: "consulting" } as Line]
        : []),
      ...(sumOf(data.costs.consulting_booked)
        ? [{
            name: "└ registered as payable",
            values: data.costs.consulting_booked,
            kind: "note",
            hint: "not counted — settles the accrual above",
            detail: "consulting_booked",
          } as Line]
        : []),
    ];

    const lines: Line[] = [
      { name: "Sales (supply value)", values: data.revenue.sales, detail: "sales" },
      { name: "Other income", values: data.revenue.other_income, detail: "other_income" },
      ...investmentLine,
      { name: "Revenue", values: revenue, kind: "sum" },
      { name: "Purchases (cost)", values: data.costs.purchase, detail: "purchase" },
      ...consultingLines,
      ...data.costs.operating.map((o) => ({
        name: CATEGORY_LABEL[o.key] || o.key,
        values: o.values,
        detail: `op:${o.key}`,
      })),
      ...vendorManual,
      { name: "Costs", values: costs, kind: "sum" },
      {
        name: "VAT (est.)",
        values: data.taxes.vat,
        kind: withVat ? undefined : "note",
        hint: withVat ? undefined : "not counted — tax payments only",
      },
      { name: "Tax payments", values: data.taxes.payments, detail: "tax_payments" },
      {
        name: "Corporate tax (est.)",
        values: data.taxes.corporate,
        kind: withTax ? undefined : "note",
        hint: withTax
          ? `${(data.corporate_tax.top_rate * 100).toFixed(0)}% + 10% local, spread over profitable months`
          : "not counted — switch it on above",
      },
      { name: "Taxes", values: taxes, kind: "sum" },
      { name: "Net profit", values: net, kind: "grand" },
    ];
    return { lines, revenue, costs, taxes, net };
  }, [data, withVat, withTax]);

  return (
    <div className="fin-overview">
      <div className="fin-period-bar">
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <span className="fin-period-range">{year}-01-01 ~ {year}-12-31</span>
        <label className="check-chip" style={{ marginLeft: "auto", cursor: "pointer" }}>
          <input type="checkbox" checked={withVat} onChange={(e) => setWithVat(e.target.checked)} />
          {" "}Count estimated VAT as tax
        </label>
        <label className="check-chip" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={withTax} onChange={(e) => setWithTax(e.target.checked)} />
          {" "}Simulate corporate tax
        </label>
      </div>

      {error && !data ? <div className="state error">API error: {error.message}</div> : null}
      {!data || !model ? <div className="state">Loading…</div> : (
        <>
          <div className="fin-kpis">
            <KpiTile
              label={`Revenue (${year})`}
              main={won(sumOf(model.revenue))}
              sub={sumOf(data.revenue.investment)
                ? `Sales ${won(sumOf(data.revenue.sales))} · Other ${won(sumOf(data.revenue.other_income))} · investment ${won(sumOf(data.revenue.investment))} excluded`
                : `Sales ${won(sumOf(data.revenue.sales))} · Other ${won(sumOf(data.revenue.other_income))}`}
              tone="blue"
            />
            <KpiTile
              label="Costs"
              main={won(sumOf(model.costs))}
              sub={`Purchases ${won(sumOf(data.costs.purchase))} · Operating ${won(sumOf(model.costs) - sumOf(data.costs.purchase))}`}
              tone="amber"
            />
            <KpiTile
              label="Taxes"
              main={won(sumOf(model.taxes))}
              sub={[
                withVat ? `VAT ${won(sumOf(data.taxes.vat))}` : `VAT ${won(sumOf(data.taxes.vat))} excluded`,
                `Paid ${won(sumOf(data.taxes.payments))}`,
                withTax
                  ? `Corporate (est.) ${won(data.corporate_tax.total)}`
                  : `Corporate ${won(data.corporate_tax.total)} excluded`,
              ].join(" · ")}
              tone="red"
            />
            <KpiTile
              label="Net profit"
              main={won(sumOf(model.net))}
              sub={sumOf(model.revenue)
                ? `Margin ${(sumOf(model.net) / sumOf(model.revenue) * 100).toFixed(1)}% · ${model.net.filter((n) => n > 0).length} of 12 months in profit`
                : "No revenue this year"}
              tone={sumOf(model.net) >= 0 ? "green" : "red"}
            />
          </div>

          <div className="panel">
            <div className="items-head">
              <h3 className="form-title" style={{ margin: 0 }}>Monthly net profit ({year}, ₩)</h3>
              <div className="fin-legend">
                <span className="fin-legend-item"><span className="fin-dot fin-dot--profit" /> Profit</span>
                <span className="fin-legend-item"><span className="fin-dot fin-dot--loss" /> Loss</span>
              </div>
            </div>
            <NetBars labels={data.labels} net={model.net} revenue={model.revenue} costs={model.costs} taxes={model.taxes} />
          </div>

          <div className="panel">
            <h3 className="form-title">Revenue − costs − taxes = net profit (₩)</h3>
            <div className="fin-pl-scroll">
              <table className="mini fin-pl">
                <thead>
                  <tr>
                    <th className="fin-pl-name">Line</th>
                    {data.labels.map((m) => <th key={m} className="num">{m}</th>)}
                    <th className="num tot">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {model.lines.map((l) => (
                    <tr key={l.name} className={l.kind ? `fin-pl-${l.kind}` : ""}>
                      <td className="fin-pl-name">
                        {l.name}
                        {l.hint ? <span className="hint-inline"> {l.hint}</span> : null}
                      </td>
                      {/* 칸에 마우스를 올리면 그 숫자를 이룬 거래선·금액이 뜬다 — 표가
                          한 칸에 담을 수 있는 건 합계 하나뿐인데, 대개 다음 질문이
                          "그게 누구 건인가"라서. 내역이 없는 줄(소계·부가세)은 그냥 둔다. */}
                      {l.values.map((v, i) => (
                        <td key={i} className="num" title={tip(data.details, l, i, data.labels[i])}>
                          {cell(v)}
                        </td>
                      ))}
                      <td className="num tot">{cell(sumOf(l.values))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint-inline" style={{ display: "block", marginTop: 8 }}>
              Accrual basis, same as Closing · VAT — sales sit on the invoice date, purchases on the P/O date and
              operating costs on the tax-invoice date (recurring items on each occurrence). Consulting fees follow
              the sale rather than the payment: each one lands in the month its project was invoiced, at the rate
              agreed on that RFQ, so it is already a cost here before anyone books the payable. Amounts are supply
              values: VAT is stripped out of both sides and settled once on the VAT line, where a negative figure
              is a refund. Register payroll, rent and the like under Outflow so they land on their own line here.
              Hover any figure to see what it is made of.
            </p>
            <p className="hint-inline" style={{ display: "block", marginTop: 4 }}>
              Corporate tax is a simulation, not a filing: {won(data.corporate_tax.base)} pre-tax profit taxed at
              the {(data.corporate_tax.top_rate * 100).toFixed(0)}% bracket gives {won(data.corporate_tax.national)}{" "}
              plus {won(data.corporate_tax.local)} local income tax, and that year total is spread across the months
              that made a profit. The real base is settled by tax adjustments (depreciation and entertainment caps,
              loss carry-forward, credits), and the money actually leaves in March and August — treat this line as
              the share to set aside, not a due date.
            </p>
            <FxFootnote fx={data.fx} fixed={data.usd_krw} />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 환산 각주 — 이 표의 외화가 무슨 환율로 원화가 되었는지.
 *
 * 없어도 표는 읽히지만, 그 표가 맞는지 따져 보려면 반드시 있어야 하는 줄이다: 달러 매출
 * 한 줄이 원화로 얼마가 되었는지는 환율을 모르면 검산할 수 없다. 원화 거래뿐인 해에는
 * 아무것도 그리지 않는다 — 말할 것이 없다.
 */
function FxFootnote({ fx, fixed }: { fx?: FinanceProfit["fx"]; fixed: number }) {
  if (!fx || fx.rates.length === 0) return null;
  return (
    <p className="hint-inline" style={{ display: "block", marginTop: 4 }}>
      Foreign currency is converted at each month&apos;s closing base rate (매매기준율):{" "}
      {/* 같은 달·통화가 두 번 나올 수 있다 — 예정분은 고시, 지급분은 적어 둔 적용환율. */}
      {fx.rates.map((r, i) => (
        <span key={`${r.month}-${r.cur}-${i}`}>
          {i ? " · " : ""}
          {monthLabel(r.month)} {r.cur} ₩{r.rate.toLocaleString()}
          {r.entered ? " (as paid)" : ""}
        </span>
      ))}
      {fx.fallback
        ? ` — some months fell back to the fixed rate ₩${fixed.toLocaleString()} because no quote was available (set EXIM_API_KEY).`
        : "."}
      {" "}Payments that recorded the rate actually applied are converted at that rate instead.
    </p>
  );
}

/** 월별 순수익 막대 — 0선을 가운데 두고 이익은 위, 손실은 아래로 자란다. */
function NetBars({ labels, net, revenue, costs, taxes }: {
  labels: string[];
  net: number[];
  revenue: number[];
  costs: number[];
  taxes: number[];
}) {
  const max = Math.max(1, ...net.map(Math.abs));
  return (
    <div className="fin-net-chart fin-pl-chart">
      {labels.map((lab, i) => (
        <div
          key={lab}
          className="fin-net-col"
          title={`${lab} · Revenue ${won(revenue[i])} · Costs ${won(costs[i])} · Taxes ${won(taxes[i])} · Net ${won(net[i])}`}
        >
          <div className="fin-net-track">
            <div className="fin-net-mid" />
            {/* 값 꼬리표는 막대가 자라는 쪽 바깥에 — 0선 위아래 어느 쪽이든 막대 끝을 따라간다. */}
            {Math.round(net[i]) ? (
              <div
                className={`fin-pl-cap ${net[i] >= 0 ? "pos" : "neg"}`}
                style={{ [net[i] >= 0 ? "bottom" : "top"]: `calc(50% + ${(Math.abs(net[i]) / max) * 48}%)` } as React.CSSProperties}
              >
                {compact(net[i])}
              </div>
            ) : null}
            <div
              className={`fin-net-bar ${net[i] >= 0 ? "pos" : "neg"}`}
              style={{ height: `${(Math.abs(net[i]) / max) * 48}%`, [net[i] >= 0 ? "bottom" : "top"]: "50%" } as React.CSSProperties}
            />
          </div>
          <div className="fin-bar-label">{lab}</div>
        </div>
      ))}
    </div>
  );
}
