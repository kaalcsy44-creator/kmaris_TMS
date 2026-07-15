"use client";

import { Fragment } from "react";
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
import type { PipelineRow, PoWorkOptions, RfqItem } from "@/lib/types";
import { INFO_FIELDS } from "@/components/common/dealFields";
import { convertCurrency, USD_KRW_RATE } from "@/components/common/itemTable";
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
  // 견적 전(1~3단계) 프로젝트는 고객이 요청한 RFQ 품목만 있다 — 값이 매겨지기 전 목록.
  const { data: detail } = useCachedData(`rfq:${rfqId}`, () => fetchRfqDetail(rfqId));
  // 고객 P/O·Vendor P/O·견적을 한 번에 받는다. ProgressScreen 과 같은 캐시 키.
  const { data: poOpts } = useCachedData("po:work-options", fetchPoWorkOptions);
  // 이 프로젝트에 견적만 있고 아직 P/O 가 없을 때 쓸 견적 id(가장 최근 것).
  const { data: qtnList } = useCachedData("quotations:overview", () => fetchQuotationOverview());

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

  // 이 프로젝트의 고객 P/O — 선박별로 나뉜다. P/O 번호 오름차순(ProgressScreen 과 동일 정렬).
  const orders = sortByDocNo(
    (poOpts?.orders ?? []).filter((o) => o.rfq_id === rfqId),
    (o) => o.po_no,
    (o) => o.id
  );
  const purchaseOrders = poOpts?.purchase_orders ?? [];
  // P/O 가 아직 없으면 견적(있으면)만으로 한 그룹을 만든다.
  const quoteOnlyId = orders.length === 0 ? (qtnList?.rows.find((q) => q.rfq_id === rfqId)?.id ?? 0) : 0;

  return (
    <Overview
      row={row}
      steps={pipeline.steps}
      orders={orders}
      purchaseOrders={purchaseOrders}
      quoteOnlyId={quoteOnlyId}
      rfqItems={detail?.items ?? null}
    />
  );
}

type ProjectOrder = PoWorkOptions["orders"][number];
type VendorPo = PoWorkOptions["purchase_orders"][number];
type StageItem = { qty?: number; unit_price?: number | null; amount?: number | null };

/** 품목 1줄의 금액 — amount 가 있으면 그대로, 없으면 단가×수량으로 보정. */
function lineAmount(it: StageItem | undefined): number | null {
  if (!it) return null;
  if (it.amount != null) return Number(it.amount);
  if (it.unit_price == null) return null;
  return Number(it.unit_price) * Number(it.qty || 1);
}

function sumLines(items: StageItem[]): number | null {
  const vals = items.map(lineAmount).filter((v): v is number => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
}

/**
 * 마진율(%) — (매출 − 매입) / 매출. 통화가 다르면 매입을 매출 통화로 환산해 비교한다.
 * 매출이 0이거나 한쪽이 없으면 계산하지 않는다(0% 로 보이면 오해되므로).
 */
function marginPct(
  sales: number | null,
  purchase: number | null,
  salesCur: string,
  purCur: string,
  rate: number
): number | null {
  if (sales == null || purchase == null || !sales) return null;
  const p = convertCurrency(purchase, purCur, salesCur, rate);
  return Math.round(((sales - p) / sales) * 1000) / 10;
}

function Overview({
  row,
  steps,
  orders,
  purchaseOrders,
  quoteOnlyId,
  rfqItems,
}: {
  row: PipelineRow;
  steps: string[];
  orders: ProjectOrder[];
  purchaseOrders: VendorPo[];
  /** P/O 가 아직 없을 때 보여줄 견적 id. 0 이면 없음. */
  quoteOnlyId: number;
  rfqItems: RfqItem[] | null;
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

      <ItemsSection
        orders={orders}
        purchaseOrders={purchaseOrders}
        quoteOnlyId={quoteOnlyId}
        rfqItems={rfqItems}
      />
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
 * 품목 — 선박(=고객 P/O)별로 묶고, 한 줄 안에서 Quote → P/O → C/I 를 좌→우로 잇는다.
 * 각 단계마다 매입·마진·매출을 나란히 둬서 "견적에선 이랬는데 발주·송장에선 이렇게 됐다"를
 * 한 줄로 읽게 한다. 세 단계 금액은 일부만 발주되거나 선적 수량이 바뀌면 서로 달라진다.
 *
 * 단계 간 품목 연결은 배열 순서(index)로 맞춘다 — Part No. 가 비어 있는 건이 많아
 * 번호로는 이을 수 없다. 따라서 각 문서의 품목 순서가 서로 같다는 전제가 깔린다.
 */
function ItemsSection({
  orders,
  purchaseOrders,
  quoteOnlyId,
  rfqItems,
}: {
  orders: ProjectOrder[];
  purchaseOrders: VendorPo[];
  quoteOnlyId: number;
  rfqItems: RfqItem[] | null;
}) {
  const hasGroups = orders.length > 0 || quoteOnlyId > 0;
  return (
    <section className="proj-ov-sec">
      <h2 className="proj-ov-h">
        Items
        <span className="proj-ov-src">
          {hasGroups
            ? "by vessel · Quote → P/O → C/I · purchase = vendor P/O"
            : "from RFQ request — not priced until a quotation is created"}
        </span>
      </h2>
      {!hasGroups ? (
        <RfqItemsTable items={rfqItems} />
      ) : (
        <div className="proj-ov-items-wrap">
          <table className="proj-ov-items proj-ov-grid">
            <thead>
              <tr>
                <th className="ov-it-n" rowSpan={2}>
                  #
                </th>
                <th rowSpan={2}>Description</th>
                <th className="ov-it-qty" rowSpan={2}>
                  Qty
                </th>
                <th className="num ov-gh q" colSpan={3}>
                  Quote
                </th>
                <th className="num ov-gh p" colSpan={3}>
                  P/O
                </th>
                <th className="num ov-gh c" colSpan={3}>
                  C/I
                </th>
              </tr>
              <tr>
                {["q", "p", "c"].map((g) => (
                  <Fragment key={g}>
                    <th className={`num ov-sub ${g}`}>Purchase</th>
                    <th className={`num ov-sub ${g}`}>Margin</th>
                    <th className={`num ov-sub ${g}`}>Sales</th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            {orders.length > 0 ? (
              orders.map((o) => (
                <OrderItemGroup
                  key={o.id}
                  order={o}
                  vendorPos={purchaseOrders.filter((p) => p.order_id === o.id)}
                />
              ))
            ) : (
              <QuoteOnlyGroup quoteId={quoteOnlyId} />
            )}
          </table>
        </div>
      )}
    </section>
  );
}

/** 통화 + 금액 한 줄(조밀). 값이 없으면 —. 0 으로 보이면 "무료"로 오해되므로 구분한다. */
function Money({ value, currency }: { value: number | null | undefined; currency: string }) {
  if (value == null || !Number.isFinite(value)) return <span className="muted">—</span>;
  return (
    <span className="ov-m">
      <em>{currency}</em> {Math.round(value).toLocaleString()}
    </span>
  );
}

function Pct({ value }: { value: number | null }) {
  if (value == null) return <span className="muted">—</span>;
  return <span className="ov-pct">{value}%</span>;
}

/** 한 선박(=고객 P/O) 묶음 — 그 P/O 의 품목을 기준 행으로 삼고 견적·C/I 를 순서로 맞춘다. */
function OrderItemGroup({ order, vendorPos }: { order: ProjectOrder; vendorPos: VendorPo[] }) {
  // 이 오더가 나온 견적(없으면 quotation_id = 0 → Quote 열 전체가 —).
  const { data: quote } = useCachedData(`quotation:${order.quotation_id}`, () =>
    order.quotation_id ? fetchCustomerQuotationDetail(order.quotation_id) : Promise.resolve(null)
  );
  const { data: doc } = useCachedData(`documents:${order.id}`, () => fetchDocumentDetail(order.id));
  const ci = doc?.ci ?? null;

  // 매입 = 실제 Vendor P/O. 한 오더에 발주서가 여러 장이면 P/O 번호 순으로 이어 붙여 순서를 맞춘다.
  const vpos = sortByDocNo(vendorPos, (p) => p.po_no, (p) => p.id);
  const vpoItems = vpos.flatMap((p) => p.items);
  const vpoCur = vpos[0]?.currency || order.currency || "USD";
  const vpoNos = vpos.map((p) => p.po_no).filter(Boolean).join(" · ");

  const qCur = quote?.currency || order.currency || "USD";
  const qCostCur = quote?.cost_currency || qCur;
  const oCur = order.currency || "USD";
  const ciCur = ci?.currency || oCur;
  // 환산 기준은 견적에 저장된 환율(없으면 기본값). 통화가 다른 단계 간 마진 계산에만 쓰인다.
  const rate = quote?.fx_rate && quote.fx_rate > 0 ? quote.fx_rate : USD_KRW_RATE;

  const rows = order.items.length ? order.items : (quote?.items ?? []);

  return (
    <tbody className="ov-grp">
      <tr className="ov-grp-head">
        <td colSpan={12}>
          <span className="ov-grp-vessel">{order.vessel || "— no vessel —"}</span>
          <span className="ov-grp-docs">
            <b className="q">Quote</b> {quote?.qtn_no || <i className="muted">none</i>}
            <span className="sep">→</span>
            <b className="p">P/O</b> {order.po_no || "—"}
            {vpoNos ? <span className="ov-grp-vpo">(vendor {vpoNos})</span> : null}
            <span className="sep">→</span>
            <b className="c">C/I</b> {ci?.ci_no ? ci.ci_no : <i className="muted">not issued</i>}
          </span>
        </td>
      </tr>
      {rows.map((it, i) => {
        const qIt = quote?.items[i];
        const qty = Number(it.qty || 1);
        const qPur = qIt?.cost_price == null ? null : Number(qIt.cost_price) * Number(qIt.qty || 1);
        const qSales = lineAmount(qIt);
        const pPur = lineAmount(vpoItems[i]);
        const pSales = lineAmount(it);
        const cSales = lineAmount(ci?.items[i]);
        return (
          <tr key={i}>
            <td className="ov-it-n">{i + 1}</td>
            <td>{it.description || qIt?.description || "—"}</td>
            <td className="ov-it-qty">
              {qty}
              {it.unit ? ` ${it.unit}` : ""}
            </td>
            <td className="num">
              <Money value={qPur} currency={qCostCur} />
            </td>
            <td className="num">
              <Pct value={qIt?.margin_pct ?? null} />
            </td>
            <td className="num">
              <Money value={qSales} currency={qCur} />
            </td>
            <td className="num">
              <Money value={pPur} currency={vpoCur} />
            </td>
            <td className="num">
              <Pct value={marginPct(pSales, pPur, oCur, vpoCur, rate)} />
            </td>
            <td className="num">
              <Money value={pSales} currency={oCur} />
            </td>
            <td className="num">
              {/* C/I 단계 매입은 별도 문서가 없어 실제 발주(Vendor P/O)를 그대로 잇는다. */}
              <Money value={cSales == null ? null : pPur} currency={vpoCur} />
            </td>
            <td className="num">
              <Pct value={cSales == null ? null : marginPct(cSales, pPur, ciCur, vpoCur, rate)} />
            </td>
            <td className="num">
              <Money value={cSales} currency={ciCur} />
            </td>
          </tr>
        );
      })}
      <GroupTotal
        quotePur={
          quote ? sumLines(quote.items.map((x) => ({ amount: (x.cost_price ?? 0) * (x.qty || 1) }))) : null
        }
        quoteSales={quote ? (quote.amount ?? sumLines(quote.items)) : null}
        poPur={sumLines(vpoItems)}
        poSales={sumLines(order.items)}
        ciSales={ci ? sumLines(ci.items) : null}
        cur={{ qCostCur, qCur, vpoCur, oCur, ciCur }}
        rate={rate}
      />
    </tbody>
  );
}

/** 묶음 합계 행 — 각 단계의 매입·마진·매출 총계. 마진은 총계끼리 다시 계산한다. */
function GroupTotal({
  quotePur,
  quoteSales,
  poPur,
  poSales,
  ciSales,
  cur,
  rate,
}: {
  quotePur: number | null;
  quoteSales: number | null;
  poPur: number | null;
  poSales: number | null;
  ciSales: number | null;
  cur: { qCostCur: string; qCur: string; vpoCur: string; oCur: string; ciCur: string };
  rate: number;
}) {
  return (
    <tr className="ov-grp-total">
      <td colSpan={3} className="ov-it-totlabel">
        Total
      </td>
      <td className="num">
        <Money value={quotePur} currency={cur.qCostCur} />
      </td>
      <td className="num">
        <Pct value={marginPct(quoteSales, quotePur, cur.qCur, cur.qCostCur, rate)} />
      </td>
      <td className="num ov-it-total">
        <Money value={quoteSales} currency={cur.qCur} />
      </td>
      <td className="num">
        <Money value={poPur} currency={cur.vpoCur} />
      </td>
      <td className="num">
        <Pct value={marginPct(poSales, poPur, cur.oCur, cur.vpoCur, rate)} />
      </td>
      <td className="num ov-it-total">
        <Money value={poSales} currency={cur.oCur} />
      </td>
      <td className="num">
        <Money value={ciSales == null ? null : poPur} currency={cur.vpoCur} />
      </td>
      <td className="num">
        <Pct value={ciSales == null ? null : marginPct(ciSales, poPur, cur.ciCur, cur.vpoCur, rate)} />
      </td>
      <td className="num ov-it-total">
        <Money value={ciSales} currency={cur.ciCur} />
      </td>
    </tr>
  );
}

/** P/O 전(4단계 이하) — 견적만 있는 프로젝트. Quote 열만 채우고 P/O·C/I 는 비운다. */
function QuoteOnlyGroup({ quoteId }: { quoteId: number }) {
  const { data: quote } = useCachedData(`quotation:${quoteId}`, () =>
    fetchCustomerQuotationDetail(quoteId)
  );
  if (!quote) {
    return (
      <tbody>
        <tr>
          <td colSpan={12} className="proj-ov-empty">
            Loading items…
          </td>
        </tr>
      </tbody>
    );
  }
  const qCur = quote.currency || "USD";
  const qCostCur = quote.cost_currency || qCur;
  const rate = quote.fx_rate && quote.fx_rate > 0 ? quote.fx_rate : USD_KRW_RATE;
  return (
    <tbody className="ov-grp">
      <tr className="ov-grp-head">
        <td colSpan={12}>
          <span className="ov-grp-vessel">{quote.vessel || "— no vessel —"}</span>
          <span className="ov-grp-docs">
            <b className="q">Quote</b> {quote.qtn_no || "—"}
            <span className="sep">→</span>
            <i className="muted">no P/O yet</i>
          </span>
        </td>
      </tr>
      {quote.items.map((it, i) => (
        <tr key={i}>
          <td className="ov-it-n">{i + 1}</td>
          <td>{it.description || "—"}</td>
          <td className="ov-it-qty">
            {it.qty}
            {it.unit ? ` ${it.unit}` : ""}
          </td>
          <td className="num">
            <Money
              value={it.cost_price == null ? null : Number(it.cost_price) * Number(it.qty || 1)}
              currency={qCostCur}
            />
          </td>
          <td className="num">
            <Pct value={it.margin_pct ?? null} />
          </td>
          <td className="num">
            <Money value={lineAmount(it)} currency={qCur} />
          </td>
          <td className="num" colSpan={6}>
            <span className="muted">—</span>
          </td>
        </tr>
      ))}
      <GroupTotal
        quotePur={sumLines(quote.items.map((x) => ({ amount: (x.cost_price ?? 0) * (x.qty || 1) })))}
        quoteSales={quote.amount ?? sumLines(quote.items)}
        poPur={null}
        poSales={null}
        ciSales={null}
        cur={{ qCostCur, qCur, vpoCur: qCur, oCur: qCur, ciCur: qCur }}
        rate={rate}
      />
    </tbody>
  );
}

/** 견적 전 — 고객이 요청한 RFQ 품목만. 단가가 없으므로 수량까지만 보여준다. */
function RfqItemsTable({ items }: { items: RfqItem[] | null }) {
  if (items === null) return <div className="proj-ov-empty">Loading items…</div>;
  if (items.length === 0) return <div className="proj-ov-empty">No items registered.</div>;
  return (
    <div className="proj-ov-items-wrap">
      <table className="proj-ov-items">
        <thead>
          <tr>
            <th className="ov-it-n">#</th>
            <th>Part No.</th>
            <th>Description</th>
            <th className="ov-it-qty">Qty</th>
            <th>Remark</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i}>
              <td className="ov-it-n">{i + 1}</td>
              <td className="ov-it-part">{it.part_no || "—"}</td>
              <td>{it.description || "—"}</td>
              <td className="ov-it-qty">
                {it.qty}
                {it.unit ? ` ${it.unit}` : ""}
              </td>
              <td className="ov-it-remark">{it.remark || ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
