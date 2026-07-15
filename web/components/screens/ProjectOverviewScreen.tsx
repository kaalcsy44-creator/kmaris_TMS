"use client";

import Link from "next/link";
import {
  fetchPipeline,
  fetchRfqDetail,
  fetchQuotationOverview,
  fetchCustomerQuotationDetail,
  fetchPoWorkOptions,
  fetchDocumentDetail,
  closeReasonLabel,
} from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";
import { sortByDocNo } from "@/lib/sort";
import { resolveSteps, fmtStageDate, buildStageChain, type StageChainItem } from "@/lib/deal";
import { buildActivities, md, splitProjectNo, type Activity } from "@/lib/activity";
import type { PipelineRow, PoWorkOptions, CustomerQuotationDetail } from "@/lib/types";
import { INFO_FIELDS } from "@/components/common/dealFields";
import {
  DualCurrencyAmount,
  fxRateText,
  USD_KRW_RATE,
} from "@/components/common/itemTable";
import ActivityDesc from "@/components/common/ActivityDesc";
import WorkTypeBadge from "@/components/WorkTypeBadge";

/**
 * 프로젝트 개요 — 한 프로젝트의 모든 정보를 한 페이지에 읽기 전용으로 모아 보여준다.
 * 목적은 "팀원과 현재 상황 공유"라서 URL 로 바로 열리고 인쇄가 되는 게 핵심이다.
 *
 * 편집은 하지 않는다. 각 단계 카드를 누르면 기존 진행현황 팝업의 그 단계로 보낸다
 * (/progress?rfq=N&stage=M) — 개요는 읽고, 작업은 팝업에서 하는 역할 분담.
 */
export default function ProjectOverviewScreen({ rfqId }: { rfqId: number }) {
  // 목록에서 넘어오면 이미 캐시에 있어 즉시 그려진다(같은 "pipeline" 키를 공유).
  const { data: pipeline, error: pipeErr } = useCachedData("pipeline", () => fetchPipeline());
  // 품목은 파이프라인 행에 없어(개수만) RFQ 상세를 따로 받는다.
  // 단, RFQ 품목은 "고객이 요청한 줄"이라 단가가 없다(전부 null). 값이 매겨진 품목은
  // 견적(Quotation)에 있으므로, 견적이 있으면 그쪽을 우선 쓴다. ↓ quoted
  const { data: detail } = useCachedData(`rfq:${rfqId}`, () => fetchRfqDetail(rfqId));
  // 견적 목록에서 이 프로젝트의 견적을 찾는다(백엔드가 id 내림차순 → 첫 건이 최신).
  const { data: qtnList } = useCachedData("quotations:overview", () => fetchQuotationOverview());
  const qtnId = qtnList?.rows.find((q) => q.rfq_id === rfqId)?.id ?? 0;
  const { data: quote } = useCachedData(`quotation:${qtnId}`, () =>
    qtnId ? fetchCustomerQuotationDetail(qtnId) : Promise.resolve(null)
  );
  // 고객 P/O — 선박이 여러 척이면 P/O 도 선박별로 나뉜다(견적 1건 → P/O N건).
  // ProgressScreen 과 같은 캐시 키를 써서 중복 호출하지 않는다.
  const { data: poOpts } = useCachedData("po:work-options", fetchPoWorkOptions);

  if (pipeErr && !pipeline) return <div className="state error">API error: {pipeErr.message}</div>;
  if (!pipeline) return <div className="state">Loading…</div>;

  const row = pipeline.rows.find((r) => r.rfq_id === rfqId) ?? null;
  // sales 계정은 서버가 본인 담당 딜만 내려준다 → 남의 프로젝트 링크를 열면 행이 없다.
  // "없는 프로젝트"가 아니라 "볼 권한이 없다"로 안내해야 링크를 받은 팀원이 헷갈리지 않는다.
  if (!row) {
    return (
      <div className="state">
        This project is not available — it may have been deleted, or your account may not have
        access to it.
        <div style={{ marginTop: 10 }}>
          <Link className="btn sm" href="/progress">
            ← Back to Progress
          </Link>
        </div>
      </div>
    );
  }

  // 견적이 있으면 값이 매겨진 견적 품목을, 아직 없으면 RFQ 요청 품목(단가 없음)을 보여준다.
  const source: ItemSource | null = quote
    ? {
        kind: "quote",
        label: quote.qtn_no || "Quotation",
        items: quote.items,
        currency: quote.currency || "USD",
        // 원가 통화는 판매 통화와 다를 수 있다(벤더 견적 통화 그대로). 미지정이면 판매 통화.
        costCurrency: quote.cost_currency || quote.currency || "USD",
        fxRate: quote.fx_rate ?? null,
        discountPct: quote.discount_pct || 0,
        total: quote.amount ?? null,
      }
    : qtnId
      ? null // 견적이 있는데 아직 로딩 중 → 표만 늦게 채운다
      : detail
        ? {
            kind: "rfq",
            label: "RFQ request",
            items: detail.items,
            currency: "USD",
            costCurrency: "USD",
            fxRate: null,
            discountPct: 0,
            total: null,
          }
        : null;

  // 이 프로젝트의 고객 P/O — K-Maris P/O 번호 오름차순(ProgressScreen 과 동일 정렬).
  const orders = sortByDocNo(
    (poOpts?.orders ?? []).filter((o) => o.rfq_id === rfqId),
    (o) => o.po_no,
    (o) => o.id
  );

  return (
    <Overview
      row={row}
      steps={pipeline.steps}
      source={source}
      quote={quote ?? null}
      orders={orders}
    />
  );
}

type ProjectOrder = PoWorkOptions["orders"][number];

/** 문서 품목 합계 — amount 가 있으면 그대로, 없으면 단가×수량으로 보정. */
function sumItems(
  items: { qty?: number; unit_price?: number | null; amount?: number | null }[]
): number {
  return items.reduce(
    (s, it) =>
      s +
      (it.amount != null ? Number(it.amount) : Number(it.unit_price || 0) * Number(it.qty || 1)),
    0
  );
}

/** 품목 표의 출처 — 견적(값 있음) 또는 RFQ 요청(값 없음). 화면에 어느 쪽인지 밝힌다. */
type ItemSource = {
  kind: "quote" | "rfq";
  label: string;
  items: OverviewItem[];
  /** 판매(견적) 통화. */
  currency: string;
  /** 원가 통화 — 벤더 견적 통화라 판매 통화와 다를 수 있다. */
  costCurrency: string;
  /** 견적에 저장된 적용 환율(1 통화 = ? KRW). 없으면 기본 환율로 환산. */
  fxRate: number | null;
  discountPct: number;
  /** 견적 총액(할인 반영). 품목 합계와 다를 수 있어 서버 값을 그대로 쓴다. */
  total: number | null;
};

// RfqItem 과 CustomerQuoteItem 이 공통으로 갖는 표시용 필드.
// cost_price·margin_pct 는 견적 품목에만 있다(RFQ 요청 품목은 값이 없음).
type OverviewItem = {
  part_no: string;
  description: string;
  serial_no?: string;
  qty: number;
  unit: string;
  cost_price?: number | null;
  margin_pct?: number | null;
  unit_price: number | null;
  amount: number | null;
  remark?: string;
};

function Overview({
  row,
  steps,
  source,
  quote,
  orders,
}: {
  row: PipelineRow;
  steps: string[];
  // null = 아직 로딩 중(품목 표만 늦게 채워진다). 나머지 화면은 먼저 보여준다.
  source: ItemSource | null;
  quote: CustomerQuotationDetail | null;
  orders: ProjectOrder[];
}) {
  const rSteps = resolveSteps(steps, row.work_type);
  const chain = buildStageChain(row, rSteps);
  const acts = buildActivities(row, rSteps);
  const { code, date } = splitProjectNo(row.project_no || row.kmaris_rfq_no || "—");
  const isService = (row.work_type || "부품공급") === "서비스";
  const editHref = `/progress?rfq=${row.rfq_id}&stage=${Math.max(row.stage, 1)}`;
  // 선박은 오더별로 여러 척일 수 있다(vessels = 줄바꿈 구분). 한 줄 머리글이므로 · 로 잇는다.
  const vessels = (row.vessels || row.vessel).split("\n").filter(Boolean).join(" · ");

  return (
    <div className={`proj-ov${isService ? " service" : ""}${row.cancelled ? " cancelled" : ""}`}>
      {/* 머리글 한 줄: 번호 · (날짜) · 타입 · 프로젝트명 · 선박 + 우측 액션.
          현재 단계·경과일·Next action 은 아래 Stages 스트립이 같은 내용을 더 정확히
          보여줘서 따로 두지 않는다. */}
      <div className="proj-ov-head">
        <h1 className="proj-ov-id">
          <Link className="proj-ov-back" href="/progress" title="Back to Progress">
            ←
          </Link>
          <b className="proj-ov-no">{code}</b>
          {date ? <span className="proj-ov-nodate">{date}</span> : null}
          <WorkTypeBadge type={row.work_type} />
          <span className="proj-ov-title">{row.project_title || "(untitled project)"}</span>
          {vessels ? <span className="proj-ov-vessel">· {vessels}</span> : null}
          {row.cancelled ? (
            <span className="proj-ov-closed">
              ⊘ Closed
              {row.close_reason
                ? ` · ${
                    row.close_reason === "other" && row.close_reason_note
                      ? row.close_reason_note
                      : closeReasonLabel(row.close_reason)
                  }`
                : ""}
            </span>
          ) : null}
        </h1>
        <div className="proj-ov-actions">
          <span className="proj-ov-pic">
            <span className="proj-ov-pic-label">PIC</span>
            {row.assignee || "—"}
          </span>
          <button type="button" className="btn sm" onClick={() => window.print()}>
            🖨 Print
          </button>
          <Link className="btn sm primary" href={editHref}>
            ✎ Open in Progress
          </Link>
        </div>
      </div>

      <div className="proj-ov-cols">
        <section className="proj-ov-sec">
          <h2 className="proj-ov-h">Project info</h2>
          <dl className="proj-ov-info">
            {INFO_FIELDS.map((f) => (
              <div key={f.key}>
                <dt>{f.label}</dt>
                <dd>{f.render(row)}</dd>
              </div>
            ))}
          </dl>
        </section>

        <StageTimeline row={row} chain={chain} acts={acts} />
      </div>

      <AmountHistory quote={quote} orders={orders} rate={source?.fxRate ?? null} />

      {/* 품목 — 내부 공유용이므로 매입(원가)·매출·마진을 모두 노출한다. */}
      <section className="proj-ov-sec">
        <h2 className="proj-ov-h">
          Items{source ? <span className="proj-ov-cnt">{source.items.length}</span> : null}
          {source ? (
            <span className="proj-ov-src">
              {source.kind === "quote"
                ? `from ${source.label} · sales ${source.currency}${
                    source.costCurrency !== source.currency ? ` · cost ${source.costCurrency}` : ""
                  } · ${fxRateText(source.fxRate ?? undefined)}`
                : "from RFQ request — not priced until a quotation is created"}
            </span>
          ) : null}
        </h2>
        <ItemsTable source={source} />
      </section>
    </div>
  );
}

/**
 * 단계 + 활동 통합 타임라인 — 단계가 뼈대, 사람이 쓴 노트가 그 아래 붙는다.
 *
 * 예전엔 가로 단계 스트립과 활동 로그를 따로 뒀는데, 활동 로그의 자동 행들이
 * 결국 단계 완료 이벤트라서 같은 사건이 한 화면에 두 번 나왔다. 여기서 하나로 합쳐
 * 중복을 없애고 프로세스 순서대로 읽히게 한다.
 *
 * 자동 이벤트(단계 완료)는 buildActivities 가 만든 것을 그대로 쓴다 — 상대(from/to)
 * 표기 규칙이 업무일지 화면과 갈라지지 않게 하기 위해서다.
 */
function StageTimeline({
  row,
  chain,
  acts,
}: {
  row: PipelineRow;
  chain: StageChainItem[];
  acts: Activity[];
}) {
  // 단계별로 활동을 나눠 담는다. 자동 이벤트는 단계당 최대 1건(완료), 노트는 여러 건.
  const autoOf = new Map<number, Extract<Activity, { kind: "auto" }>>();
  const notesOf = new Map<number, Extract<Activity, { kind: "note" }>[]>();
  let closeAct: Extract<Activity, { kind: "close" }> | null = null;
  for (const a of acts) {
    if (a.kind === "auto") autoOf.set(a.stage, a);
    else if (a.kind === "note") notesOf.set(a.stage, [...(notesOf.get(a.stage) ?? []), a]);
    else closeAct = a;
  }
  const done = Math.max(0, Math.min(row.stage, chain.length));

  return (
    <section className="proj-ov-sec">
      <h2 className="proj-ov-h">
        Stages &amp; activity
        <span className="proj-ov-cnt">
          {done}/{chain.length}
        </span>
      </h2>
      <ol className="proj-ov-tl">
        {chain.map((c) => {
          const state = c.no < row.stage ? "done" : c.no === row.stage ? "current" : "todo";
          const auto = autoOf.get(c.no);
          const notes = notesOf.get(c.no) ?? [];
          return (
            <li key={c.no} className={`${state}${c.skip ? " skip" : ""}`}>
              {/* 단계 줄 클릭 → 진행현황 팝업의 그 단계(편집 진입점). */}
              <Link
                className="ov-tl-stage"
                href={`/progress?rfq=${row.rfq_id}&stage=${c.no}`}
                title={`Open stage ${c.no} in Progress`}
              >
                <span className="ov-tl-dot" aria-hidden>
                  {state === "done" ? "✓" : state === "current" ? "●" : "○"}
                </span>
                <span className="ov-tl-no">{c.no}</span>
                <b className="ov-tl-label">{c.label}</b>
                {auto?.party ? <span className="ov-tl-party">{auto.party}</span> : null}
                <span className="ov-tl-val">{c.skip ? "N/A" : c.value || ""}</span>
                <time className="ov-tl-at">{c.at ? fmtStageDate(c.at) : ""}</time>
              </Link>
              {notes.length ? (
                <ul className="ov-tl-notes">
                  {notes.map((n, i) => (
                    <li key={i} className={n.note.star ? "star" : undefined}>
                      <span className="ov-tl-ndate">{md(n.date)}</span>
                      <span className="ov-tl-ntext">
                        <ActivityDesc act={n} />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
        {closeAct ? (
          <li className="closed">
            <span className="ov-tl-stage">
              <span className="ov-tl-dot" aria-hidden>
                ⊘
              </span>
              <span className="ov-tl-no" />
              <b className="ov-tl-label">
                <ActivityDesc act={closeAct} />
              </b>
              <time className="ov-tl-at">{closeAct.date ? md(closeAct.date) : ""}</time>
            </span>
          </li>
        ) : null}
      </ol>
    </section>
  );
}

/**
 * 금액 이력 — Quote → P/O → C/I.
 *
 * 세 단계의 금액은 서로 다를 수 있다: 견적 뒤 일부만 발주되거나, 선박이 여러 척이면
 * 견적 1건이 선박별 P/O 여러 건으로 갈리고, 선적 시 수량이 바뀌면 C/I 가 또 달라진다.
 * 그래서 합계 하나만 보여주면 "왜 견적이랑 다르지" 가 남는다 — 단계별로 나란히 둔다.
 */
function AmountHistory({
  quote,
  orders,
  rate,
}: {
  quote: CustomerQuotationDetail | null;
  orders: ProjectOrder[];
  /** 견적에 저장된 적용 환율. 없으면 기본 환율. */
  rate: number | null;
}) {
  if (!quote && orders.length === 0) return null;
  const eff = rate && rate > 0 ? rate : USD_KRW_RATE;
  return (
    <section className="proj-ov-sec">
      <h2 className="proj-ov-h">
        Amount history
        <span className="proj-ov-src">
          Quote → P/O → C/I · {fxRateText(eff)}
          {rate && rate > 0 ? " (from the quotation)" : " (default rate — none saved on the quotation)"}
        </span>
      </h2>
      <div className="proj-ov-items-wrap">
        <table className="proj-ov-items proj-ov-hist">
          <thead>
            <tr>
              <th className="ov-hs-stage">Stage</th>
              <th>Vessel</th>
              <th>Doc No.</th>
              <th className="ov-hs-date">Date</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {quote ? (
              <tr className="ov-hs-quote">
                <td className="ov-hs-stage">Quote</td>
                <td className="muted">— all vessels —</td>
                <td className="ov-it-part">{quote.qtn_no || "—"}</td>
                <td className="ov-hs-date">{quote.sent_date || quote.date || "—"}</td>
                <td className="num">
                  <DualCurrencyAmount
                    value={quote.amount}
                    currency={quote.currency || "USD"}
                    rate={eff}
                  />
                </td>
              </tr>
            ) : null}
            {orders.map((o) => (
              <OrderAmountRows key={o.id} order={o} rate={eff} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** 한 고객 P/O 의 금액과, 그 P/O 로 발행된 C/I 금액. 선박별 P/O 이므로 행이 한 쌍씩 늘어난다. */
function OrderAmountRows({ order, rate }: { order: ProjectOrder; rate: number }) {
  const { data: doc } = useCachedData(`documents:${order.id}`, () => fetchDocumentDetail(order.id));
  const ci = doc?.ci ?? null;
  return (
    <>
      <tr className="ov-hs-po">
        <td className="ov-hs-stage">P/O</td>
        <td>{order.vessel || <span className="muted">—</span>}</td>
        <td className="ov-it-part">{order.po_no || "—"}</td>
        <td className="ov-hs-date">{order.date || "—"}</td>
        <td className="num">
          <DualCurrencyAmount
            value={sumItems(order.items)}
            currency={order.currency || "USD"}
            rate={rate}
          />
        </td>
      </tr>
      <tr className="ov-hs-ci">
        <td className="ov-hs-stage">C/I</td>
        <td>{order.vessel || <span className="muted">—</span>}</td>
        <td className="ov-it-part">{ci?.ci_no || <span className="muted">not issued</span>}</td>
        <td className="ov-hs-date">{ci?.date || "—"}</td>
        <td className="num">
          {ci ? (
            <DualCurrencyAmount
              value={sumItems(ci.items)}
              currency={ci.currency || order.currency || "USD"}
              rate={rate}
            />
          ) : (
            <span className="muted">—</span>
          )}
        </td>
      </tr>
    </>
  );
}

function ItemsTable({ source }: { source: ItemSource | null }) {
  if (source === null) return <div className="proj-ov-empty">Loading items…</div>;
  if (source.items.length === 0) return <div className="proj-ov-empty">No items registered.</div>;
  const { currency, costCurrency, fxRate } = source;
  // 견적에 저장된 환율이 있으면 그 환율로 환산해 견적서와 숫자가 어긋나지 않게 한다.
  const rate = fxRate && fxRate > 0 ? fxRate : undefined;
  // 값이 없는(RFQ 요청) 품목은 0 으로 보이면 "무료"로 오해되므로 — 로 비운다.
  const money = (v: number | null | undefined, cur: string) =>
    v == null ? <span className="muted">—</span> : (
      <DualCurrencyAmount value={v} currency={cur} rate={rate} />
    );
  // 매입 합계는 원가 통화 기준(판매 통화와 다를 수 있어 매출 총액과 직접 빼지 않는다).
  const costTotal = source.items.reduce(
    (s, it) => s + Number(it.cost_price || 0) * Number(it.qty || 1),
    0
  );
  const hasCost = source.items.some((it) => it.cost_price != null);
  return (
    <div className="proj-ov-items-wrap">
      <table className="proj-ov-items">
        <thead>
          <tr>
            <th className="ov-it-n">#</th>
            <th>Part No.</th>
            <th>Description</th>
            <th className="ov-it-qty">Qty</th>
            <th className="num">Purchase / unit</th>
            <th className="num">Purchase</th>
            <th className="num ov-it-mg">Margin</th>
            <th className="num">Sales / unit</th>
            <th className="num">Sales</th>
            <th>Remark</th>
          </tr>
        </thead>
        <tbody>
          {source.items.map((it, i) => {
            const qty = Number(it.qty || 1);
            const cost = it.cost_price;
            return (
              <tr key={i}>
                <td className="ov-it-n">{i + 1}</td>
                <td className="ov-it-part">{it.part_no || "—"}</td>
                <td>
                  {it.description || "—"}
                  {it.serial_no ? <span className="ov-it-serial"> · S/N {it.serial_no}</span> : null}
                </td>
                <td className="ov-it-qty">
                  {it.qty}
                  {it.unit ? ` ${it.unit}` : ""}
                </td>
                <td className="num">{money(cost, costCurrency)}</td>
                <td className="num">{money(cost == null ? null : cost * qty, costCurrency)}</td>
                <td className="num ov-it-mg">
                  {it.margin_pct == null ? <span className="muted">—</span> : `${it.margin_pct}%`}
                </td>
                <td className="num">{money(it.unit_price, currency)}</td>
                <td className="num">{money(it.amount, currency)}</td>
                <td className="ov-it-remark">{it.remark || ""}</td>
              </tr>
            );
          })}
        </tbody>
        {source.total != null ? (
          <tfoot>
            <tr>
              <td colSpan={4} className="ov-it-totlabel">
                Total
                {source.discountPct ? ` (sales after ${source.discountPct}% discount)` : ""}
              </td>
              <td />
              <td className="num ov-it-total">
                {hasCost ? (
                  <DualCurrencyAmount value={costTotal} currency={costCurrency} rate={rate} />
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td />
              <td />
              <td className="num ov-it-total">
                <DualCurrencyAmount value={source.total} currency={currency} rate={rate} />
              </td>
              <td />
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}
