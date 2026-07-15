"use client";

import Link from "next/link";
import {
  fetchPipeline,
  fetchRfqDetail,
  fetchQuotationOverview,
  fetchCustomerQuotationDetail,
  closeReasonLabel,
} from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";
import {
  resolveSteps,
  fmtStageDate,
  buildStageChain,
  vendorOf,
} from "@/lib/deal";
import {
  buildActivities,
  daysSinceISO,
  lastActivityISO,
  md,
  splitProjectNo,
} from "@/lib/activity";
import type { PipelineRow } from "@/lib/types";
import { INFO_FIELDS } from "@/components/common/dealFields";
import { DualCurrencyAmount } from "@/components/common/itemTable";
import ActivityDesc from "@/components/common/ActivityDesc";
import WorkTypeBadge from "@/components/WorkTypeBadge";
import VendorMonograms from "@/components/common/VendorMonograms";

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
            fxRate: null,
            discountPct: 0,
            total: null,
          }
        : null;

  return <Overview row={row} steps={pipeline.steps} source={source} />;
}

/** 품목 표의 출처 — 견적(값 있음) 또는 RFQ 요청(값 없음). 화면에 어느 쪽인지 밝힌다. */
type ItemSource = {
  kind: "quote" | "rfq";
  label: string;
  items: OverviewItem[];
  currency: string;
  /** 견적에 저장된 적용 환율(1 통화 = ? KRW). 없으면 기본 환율로 환산. */
  fxRate: number | null;
  discountPct: number;
  /** 견적 총액(할인 반영). 품목 합계와 다를 수 있어 서버 값을 그대로 쓴다. */
  total: number | null;
};

// RfqItem 과 CustomerQuoteItem 이 공통으로 갖는 표시용 필드.
type OverviewItem = {
  part_no: string;
  description: string;
  serial_no?: string;
  qty: number;
  unit: string;
  unit_price: number | null;
  amount: number | null;
  remark?: string;
};

function Overview({
  row,
  steps,
  source,
}: {
  row: PipelineRow;
  steps: string[];
  // null = 아직 로딩 중(품목 표만 늦게 채워진다). 나머지 화면은 먼저 보여준다.
  source: ItemSource | null;
}) {
  const rSteps = resolveSteps(steps, row.work_type);
  const chain = buildStageChain(row, rSteps);
  const acts = buildActivities(row, rSteps);
  const { code, date } = splitProjectNo(row.project_no || row.kmaris_rfq_no || "—");
  const isService = (row.work_type || "부품공급") === "서비스";
  const age = daysSinceISO(lastActivityISO(row));
  const total = rSteps.length;
  const filled = Math.max(0, Math.min(row.stage, total));
  const editHref = `/progress?rfq=${row.rfq_id}&stage=${Math.max(row.stage, 1)}`;

  return (
    <div className={`proj-ov${isService ? " service" : ""}${row.cancelled ? " cancelled" : ""}`}>
      <div className="proj-ov-head">
        <div className="proj-ov-id">
          <Link className="proj-ov-back" href="/progress" title="Back to Progress">
            ←
          </Link>
          <b className="proj-ov-no">{code}</b>
          {date ? <span className="proj-ov-nodate">{date}</span> : null}
          <WorkTypeBadge type={row.work_type} />
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
        </div>
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

      <h1 className="proj-ov-title">
        {row.project_title || "(untitled project)"}
        {row.vessel ? <span className="proj-ov-vessel"> · {row.vessel}</span> : null}
      </h1>
      <div className="proj-ov-sub">
        <span className="proj-ov-stagenow">
          {filled}/{total} {rSteps[filled - 1] ?? "Not started"}
        </span>
        {vendorOf(row) ? (
          <VendorMonograms
            value={vendorOf(row)}
            statuses={row.vendor ? undefined : row.rfq_vendors}
          />
        ) : null}
        {age != null ? (
          <span className="proj-ov-age" title="Days since last activity">
            {age}d since last activity
          </span>
        ) : null}
        {row.received_at ? (
          <span className="proj-ov-recv">First RFQ {fmtStageDate(row.received_at)}</span>
        ) : null}
      </div>

      {row.next_action ? (
        <div className={`proj-ov-next lv-${row.next_level || "normal"}`}>
          <span className="proj-ov-next-label">Next action</span>
          {row.next_action}
        </div>
      ) : null}

      {/* 단계 — 11개를 한 줄에 모두 펼쳐 현재 위치와 각 단계 결과물을 한눈에.
          카드를 누르면 진행현황 팝업의 해당 단계로 이동한다(편집 진입점). */}
      <section className="proj-ov-sec">
        <h2 className="proj-ov-h">Stages</h2>
        <ol className="proj-ov-stages">
          {chain.map((c) => {
            const cls = [
              c.no <= row.stage ? "done" : "",
              c.no === row.stage ? "current" : "",
              c.skip ? "skip" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <li key={c.no} className={cls}>
                <Link href={`/progress?rfq=${row.rfq_id}&stage=${c.no}`} title={`Open stage ${c.no}`}>
                  <span className="ov-st-head">
                    <span className="ov-st-no">{c.no}</span>
                    <b className="ov-st-label">{c.label}</b>
                  </span>
                  <em className="ov-st-val">{c.skip ? "N/A" : c.value || ""}</em>
                  <time className="ov-st-at">{c.at ? fmtStageDate(c.at) : ""}</time>
                </Link>
              </li>
            );
          })}
        </ol>
      </section>

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

        {/* 활동 로그 — Activity Log 화면과 같은 규칙(buildActivities)으로 만든 전체 이력. */}
        <section className="proj-ov-sec">
          <h2 className="proj-ov-h">
            Activity log <span className="proj-ov-cnt">{acts.length}</span>
          </h2>
          {acts.length === 0 ? (
            <div className="proj-ov-empty">No activity yet.</div>
          ) : (
            <ul className="proj-ov-acts">
              {acts.map((a, i) => (
                <li
                  key={i}
                  className={`${a.kind === "note" ? "note" : a.kind === "close" ? "closed" : "auto"}${
                    a.kind === "note" && a.note.star ? " star" : ""
                  }`}
                >
                  <span className="ov-act-date">{md(a.date)}</span>
                  <span className="ov-act-text">
                    <ActivityDesc act={a} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* 품목 — 내부 공유용이므로 단가·금액까지 노출한다. */}
      <section className="proj-ov-sec">
        <h2 className="proj-ov-h">
          Items{source ? <span className="proj-ov-cnt">{source.items.length}</span> : null}
          {source ? (
            <span className="proj-ov-src">
              {source.kind === "quote"
                ? `from ${source.label} · ${source.currency}`
                : "from RFQ request — not priced until a quotation is created"}
            </span>
          ) : null}
        </h2>
        <ItemsTable source={source} />
      </section>
    </div>
  );
}

function ItemsTable({ source }: { source: ItemSource | null }) {
  if (source === null) return <div className="proj-ov-empty">Loading items…</div>;
  if (source.items.length === 0) return <div className="proj-ov-empty">No items registered.</div>;
  const { currency, fxRate } = source;
  // 견적에 저장된 환율이 있으면 그 환율로 환산해 견적서와 숫자가 어긋나지 않게 한다.
  const rate = fxRate && fxRate > 0 ? fxRate : undefined;
  // 값이 없는(RFQ 요청) 품목은 0 으로 보이면 "무료"로 오해되므로 — 로 비운다.
  const money = (v: number | null | undefined) =>
    v == null ? <span className="muted">—</span> : (
      <DualCurrencyAmount value={v} currency={currency} rate={rate} />
    );
  return (
    <div className="proj-ov-items-wrap">
      <table className="proj-ov-items">
        <thead>
          <tr>
            <th className="ov-it-n">#</th>
            <th>Part No.</th>
            <th>Description</th>
            <th className="ov-it-qty">Qty</th>
            <th className="num">Unit price</th>
            <th className="num">Amount</th>
            <th>Remark</th>
          </tr>
        </thead>
        <tbody>
          {source.items.map((it, i) => (
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
              <td className="num">{money(it.unit_price)}</td>
              <td className="num">{money(it.amount)}</td>
              <td className="ov-it-remark">{it.remark || ""}</td>
            </tr>
          ))}
        </tbody>
        {source.total != null ? (
          <tfoot>
            <tr>
              <td colSpan={5} className="ov-it-totlabel">
                Quotation total
                {source.discountPct ? ` (after ${source.discountPct}% discount)` : ""}
              </td>
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
