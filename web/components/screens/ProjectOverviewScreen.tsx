"use client";

import { Fragment, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  fetchPipeline,
  fetchRfqDetail,
  fetchCustomerQuotationDetail,
  fetchPoWorkOptions,
  fetchDocumentDetail,
  fetchApByOrder,
  addRfqStageNote,
  updateRfqStageNote,
  deleteRfqStageNote,
  closeReasonLabel,
  fetchProjectMail,
  fetchRfqVendorQuotes,
} from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";
import { sortByDocNo } from "@/lib/sort";
import {
  resolveSteps,
  buildStageChain,
  makeItemMatcher,
  ciPurchase,
  activityParties,
  activityPersons,
  type StageChainItem,
} from "@/lib/deal";
import { buildActivities, hm, md, splitProjectNo, type Activity } from "@/lib/activity";
import type { ApRow, MailMessage, PipelineRow, PoWorkOptions, RfqItem, StageNote } from "@/lib/types";
import { vendorList } from "@/components/common/dealFields";
import { convertCurrency, USD_KRW_RATE } from "@/components/common/itemTable";
import { tr } from "@/lib/labels";
import CustomerName from "@/components/common/CustomerName";
import ProjectMailPanel, { projectMailKey } from "@/components/common/ProjectMailPanel";
import ActivityDesc from "@/components/common/ActivityDesc";
import ActivityNoteForm, {
  initialNoteValue,
  type ActivityNoteValue,
} from "@/components/common/ActivityNoteForm";
import WorkTypeBadge from "@/components/WorkTypeBadge";

/**
 * 단계를 Items 표의 열 묶음과 같은 4칸으로 나눈다 — 페이지 전체가 좌→우로
 * RFQ → Quote → P/O → C/I 한 방향으로 읽히게 하려는 것.
 * 색도 Items 의 묶음 헤더와 맞춘다(파랑=Quote, 보라=P/O, 초록=C/I).
 */
const STAGE_COLUMNS: { label: string; tone: string; from: number; to: number }[] = [
  { label: "RFQ", tone: "r", from: 1, to: 2 },
  { label: "Quote", tone: "q", from: 3, to: 4 },
  { label: "P/O", tone: "p", from: 5, to: 6 },
  { label: "C/I & after", tone: "c", from: 7, to: 11 },
];

/**
 * 프로젝트 개요 — 한 프로젝트의 모든 정보를 한 페이지에 읽기 전용으로 모아 보여준다.
 * 목적은 "팀원과 현재 상황 공유"라서 URL 로 바로 열리고 인쇄가 되는 게 핵심이다.
 *
 * 편집은 하지 않는다. 각 단계 카드를 누르면 프로젝트 목록(/project) 팝업의 그 단계로
 * 보낸다 (/project?rfq=N&stage=M) — 개요는 읽고, 작업은 팝업에서 하는 역할 분담.
 *
 * 두 곳에서 쓴다:
 *  - 페이지(/project/<id>) — 기본. URL 공유·인쇄가 되는 건 이쪽뿐이다.
 *  - 작업 팝업 안의 Overview 뷰 — embedded. 머리글은 팝업 헤더가 이미 갖고 있어 빼고,
 *    단계 줄은 링크가 아니라 onOpenStage 로 그 자리에서 작업 화면으로 되돌린다.
 *    "pipeline"·"po:work-options" 는 팝업이 이미 받아 둔 캐시를 그대로 쓰고, rfq:<id> 와
 *    quotations:overview 만 첫 전환에서 받는다(이후 캐시).
 */
export default function ProjectOverviewScreen({
  rfqId,
  embedded = false,
  onOpenStage,
  onActivityChanged,
}: {
  rfqId: number;
  /** 작업 팝업 안에 끼워 넣는 모드 — 자체 머리글(신원·PIC·인쇄·뒤로)을 렌더하지 않는다. */
  embedded?: boolean;
  /** 단계 줄 클릭 처리. 주면 링크 대신 이 콜백을 쓴다(팝업 안에서 화면 전환). */
  onOpenStage?: (stage: number, vrfqId?: number, orderId?: number) => void;
  /** 활동기록을 이 화면에서 추가한 뒤 부모에게 알린다(팝업/목록 갱신). */
  onActivityChanged?: () => void | Promise<unknown>;
}) {
  // 목록에서 넘어오면 이미 캐시에 있어 즉시 그려진다(같은 "pipeline" 키를 공유).
  const { data: pipeline, error: pipeErr, refresh: refreshPipeline } = useCachedData("pipeline", () => fetchPipeline());
  // 견적 전(1~3단계) 프로젝트는 고객이 요청한 RFQ 품목만 있다 — 값이 매겨지기 전 목록.
  const { data: detail } = useCachedData(`rfq:${rfqId}`, () => fetchRfqDetail(rfqId));
  // 고객 P/O·Vendor P/O·견적을 한 번에 받는다. ProjectsScreen 과 같은 캐시 키.
  const { data: poOpts } = useCachedData("po:work-options", fetchPoWorkOptions);
  // 받은 벤더 견적 **전부**. 고객 견적에는 원가 출처로 고른 한 건만 링크되어 있어서,
  // 그것만 그리면 두 번째·세 번째로 받은 견적이 개요에서 통째로 사라진다 — 경쟁 견적을
  // 받아 둔 딜에서 "얼마에 받아 봤나"를 확인할 자리가 여기 말고 없다.
  const { data: vqData } = useCachedData(`rfq:vendor-quotes:${rfqId}`, () =>
    fetchRfqVendorQuotes(rfqId));

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
        {/* 팝업 안에서는 이미 그 프로젝트를 열어 둔 상태라 목록으로 보내는 링크가 무의미하다. */}
        {embedded ? null : (
          <div style={{ marginTop: 10 }}>
            <Link className="btn sm" href="/project">
              ← Back to Projects
            </Link>
          </div>
        )}
      </div>
    );
  }

  // 이 프로젝트의 고객 P/O — 선박별로 나뉜다. P/O 번호 오름차순(ProjectsScreen 과 동일 정렬).
  const orders = sortByDocNo(
    (poOpts?.orders ?? []).filter((o) => o.rfq_id === rfqId),
    (o) => o.po_no,
    (o) => o.id
  );
  const purchaseOrders = poOpts?.purchase_orders ?? [];
  // 이 프로젝트의 견적 전부(견적번호 오름차순). P/O 가 아직 없으면 이 견적들이 각각 한 묶음이 된다
  // — 한 프로젝트에 견적이 여러 건일 수 있는데(예: 002~005) 예전엔 한 건만 그렸다.
  const quotations = sortByDocNo(
    (poOpts?.quotations ?? []).filter((q) => q.rfq_id === rfqId),
    (q) => q.qtn_no,
    (q) => q.id
  );

  // 받은 순서(오래된 것 → 최근)로 세운다. 번호를 나열하는 자리라, 받은 차례대로 읽히는
  // 편이 "누구한테 먼저 물었나"를 그대로 보여 준다.
  const vendorQuotes: VqRef[] = (vqData?.vendor_quotes ?? [])
    .map((v) => ({
      id: v.id,
      no: v.vendor_quote_no || "",
      vendor: v.vendor || "",
      vrfqId: v.vendor_rfq_id ?? undefined,
      amount: vqTotal(v.items ?? []),
      currency: v.currency || "USD",
    }))
    .filter((v) => v.no && v.no !== "—")
    .sort((a, b) => a.id - b.id);

  // 활동기록 추가 후: 이 화면 데이터를 새로 받고(같은 "pipeline" 캐시) 부모에게도 알린다.
  const onActivityAdded = async () => {
    await refreshPipeline();
    await onActivityChanged?.();
  };

  return (
    <Overview
      row={row}
      steps={pipeline.steps}
      orders={orders}
      purchaseOrders={purchaseOrders}
      quotations={quotations}
      rfqItems={detail?.items ?? null}
      // 매입측 견적 = 벤더 견적번호(프로젝트 단위). Quote 묶음 머리에 매출 견적과 나란히 둔다.
      vendorQuotes={vendorQuotes}
      // 목록을 못 받았을 때(권한·오류)의 폴백 한 줄. 여러 건이면 "(외 N건)"이 붙어 온다.
      vendorQuoteNo={row.vquote_no || ""}
      embedded={embedded}
      onOpenStage={onOpenStage}
      onActivityAdded={onActivityAdded}
    />
  );
}

/** 이 프로젝트가 받은 벤더 견적 한 건 — Quote 묶음 머리의 매입측에 번호로 선다.
 *  amount 는 그 견적서에 적힌 금액(Σ 단가×수량)이다. 표의 QUOTE Purchase 열과 다를 수
 *  있는데, 그 열은 "고객 견적이 원가로 삼은 값"이라 견적서를 받은 뒤 손을 댔으면 갈린다. */
type VqRef = {
  id: number;
  no: string;
  vendor: string;
  vrfqId?: number;
  amount: number | null;
  currency: string;
};

/** 벤더 견적서 총액 — 단가가 매겨진 줄만 더한다(하나도 없으면 null = "금액 미기재"). */
function vqTotal(items: { qty?: number; cost_price?: number | null }[]): number | null {
  const priced = items.filter((it) => it.cost_price != null);
  return priced.length
    ? priced.reduce((a, it) => a + Number(it.cost_price) * Number(it.qty || 1), 0)
    : null;
}

type ProjectOrder = PoWorkOptions["orders"][number];
type VendorPo = PoWorkOptions["purchase_orders"][number];
type ProjectQuote = PoWorkOptions["quotations"][number];


/**
 * 이 오더에 해당하는 견적 — 링크(quotation_id) 우선, 없으면 같은 선박의 견적.
 * 견적 없이 등록된 오더가 있어 링크가 늘 채워져 있지는 않다. 선박도 못 맞추면 null
 * (= 그 선박은 견적 없이 발주된 것).
 */
function quoteForOrder(order: ProjectOrder, quotes: ProjectQuote[]): ProjectQuote | null {
  if (order.quotation_id) {
    const linked = quotes.find((q) => q.id === order.quotation_id);
    if (linked) return linked;
  }
  const vid = order.vessel_id || 0;
  return (vid && quotes.find((q) => (q.vessel_id || 0) === vid)) || null;
}
type StageItem = {
  qty?: number;
  unit_price?: number | null;
  amount?: number | null;
  /** 그 문서에서 뺀 줄 — 표에는 남지만 발행 문서와 합계에서는 빠진다. */
  excluded?: boolean;
};

/** 품목 1줄의 금액 — amount 가 있으면 그대로, 없으면 단가×수량으로 보정.
 *
 *  문서에서 뺀 줄은 null 을 준다. 금액 0 과 같은 뜻이 아니다 — 0 은 "이 문서에 들어
 *  있고 값이 0"(끼워 준 부품)이고, 제외는 "이 문서에 안 나간다"(발주하지 않음)다.
 *  둘이 같은 얼굴이면 무엇이 실제로 납품됐는지 표에서 읽을 수 없다. null 로 두면
 *  합계에서도 자동으로 빠져 서버의 발행 규칙(_total_amount)과 어긋나지 않는다. */
function lineAmount(it: StageItem | undefined): number | null {
  if (!it || it.excluded) return null;
  if (it.amount != null) return Number(it.amount);
  if (it.unit_price == null) return null;
  return Number(it.unit_price) * Number(it.qty || 1);
}

function sumLines(items: StageItem[]): number | null {
  return total(items.map(lineAmount));
}

/** 값이 있는 것만 더한다. 하나도 없으면 null(= 0 이 아니라 "없음"). */
function total(vals: (number | null)[]): number | null {
  const xs = vals.filter((v): v is number => v != null);
  return xs.length ? xs.reduce((a, b) => a + b, 0) : null;
}

/** 부대비용(Freight/Packing/Insurance) — 품목 단가 밖에서 문서 하단에 붙는 금액. */
type Charges = { freight: number; packing: number; insurance: number; total: number };
type ChargeKey = "freight" | "packing" | "insurance";
const CHARGE_LABELS: [ChargeKey, string][] = [
  ["freight", "Freight"],
  ["packing", "Packing"],
  ["insurance", "Insurance"],
];

/** 숫자로 읽는다 — 부대비용은 입력폼을 거쳐 문자열("1200")로 저장돼 있다. */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 문서에 기록된 부대비용을 읽는다. 매출측 C/I 는 terms JSON, 매입측 벤더 청구(AP)는
 * charges JSON — 담기는 자리만 다르고 키(freight/packing/insurance)는 같다.
 * 값이 하나도 없으면 null(= 그 문서엔 부대비용이 없다 → 줄을 만들지 않는다).
 */
function readCharges(
  src: { freight?: unknown; packing?: unknown; insurance?: unknown } | null | undefined
): Charges | null {
  if (!src) return null;
  const freight = num(src.freight);
  const packing = num(src.packing);
  const insurance = num(src.insurance);
  const sum = freight + packing + insurance;
  return sum ? { freight, packing, insurance, total: sum } : null;
}

/** VAT 율을 분수로 정규화 — C/I 는 퍼센트(10), AP/AR 은 분수(0.1) 규약이라 섞여 들어온다. */
function vatFraction(v: number | null | undefined): number {
  const r = num(v);
  return r > 1 ? r / 100 : r;
}

/** VAT 줄 이름 — 매출·매입 세율이 같을 때만 율을 적는다(다르면 어느 쪽 율인지 오해된다). */
function vatLabel(salesRate: number, purRate: number): string {
  if (salesRate !== purRate) return "VAT";
  return `VAT (${Math.round(salesRate * 1000) / 10}%)`;
}

/** 품목 합계에 부대비용을 더한다. 품목이 없어도(=null) 부대비용만으로 금액이 선다. */
function addCharges(base: number | null, extra: number | null | undefined): number | null {
  if (!extra) return base;
  return (base ?? 0) + extra;
}

/** 문서번호에서 그 문서를 다루는 단계로 보내는 데 필요한 것. Items 묶음 머리로 내려간다. */
type DocNav = {
  rfqId: number;
  /** 팝업 안(embedded)일 때만 있다 — 그 자리에서 작업 화면으로 전환한다. */
  onOpenStage?: (stage: number, vrfqId?: number, orderId?: number) => void;
};

/** 문서번호를 다루는 단계 — Stages 스트립의 번호와 같다. */
const DOC_STAGE = {
  vendorQuote: 3, // 매입 견적(벤더에게 받은 견적)
  quote: 4,       // 매출 견적(고객에게 보낸 견적)
  customerPo: 5,  // 고객 P/O
  vendorPo: 6,    // 벤더 P/O
  ci: 7,          // C/I·PL·SA 등 선적서류
} as const;

const DOC_STAGE_NAME: Record<number, string> = {
  3: "Quote Received",
  4: "Quote Sent",
  5: "P/O Received",
  6: "P/O Sent",
  7: "Delivery Readiness",
};

/**
 * 문서번호 링크 — 그 번호를 만든/쓰는 단계의 작업 화면으로 보낸다.
 * 팝업 안에서는 그 자리에서 단계를 바꾸고(onOpenStage), 페이지에서는 /project 딥링크로 연다.
 * orderId 를 주면 오더가 여럿인 프로젝트에서 그 선박의 P/O 가 선택된 채로 열린다.
 */
function DocNoLink({
  no,
  stage,
  orderId,
  vrfqId,
  nav,
}: {
  no: string;
  stage: number;
  orderId?: number;
  /** 벤더 견적번호처럼 벤더별로 갈리는 문서 — 그 벤더 탭이 열린 채로 3단계를 연다. */
  vrfqId?: number;
  nav: DocNav;
}) {
  // 번호가 없는 자리(— 같은 자리표시)는 갈 곳이 없으니 그냥 글자로 둔다.
  if (!no || no === "—") return <>{no}</>;
  const title = `${no} — open stage ${stage} (${DOC_STAGE_NAME[stage] ?? "work"})`;
  if (nav.onOpenStage) {
    return (
      <button
        type="button"
        className="ov-doc-link"
        title={title}
        onClick={() => nav.onOpenStage!(stage, vrfqId, orderId)}
      >
        {no}
      </button>
    );
  }
  return (
    <Link
      className="ov-doc-link"
      title={title}
      href={`/project?rfq=${nav.rfqId}&stage=${stage}${vrfqId ? `&vrfq=${vrfqId}` : ""}${orderId ? `&order=${orderId}` : ""}`}
    >
      {no}
    </Link>
  );
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
  quotations,
  rfqItems,
  vendorQuotes,
  vendorQuoteNo,
  embedded = false,
  onOpenStage,
  onActivityAdded,
}: {
  row: PipelineRow;
  steps: string[];
  orders: ProjectOrder[];
  purchaseOrders: VendorPo[];
  quotations: ProjectQuote[];
  rfqItems: RfqItem[] | null;
  vendorQuotes: VqRef[];
  vendorQuoteNo: string;
  embedded?: boolean;
  onOpenStage?: (stage: number, vrfqId?: number, orderId?: number) => void;
  /** 활동기록 추가 후 데이터 갱신 콜백. */
  onActivityAdded?: () => void | Promise<unknown>;
}) {
  // 이 딜의 메일 — 아래 Mail 패널과 같은 캐시 키라 조회는 한 번이고, 거기서 Sync 를
  // 누르면 단계 보드의 메일 줄까지 함께 갱신된다.
  const { data: mail } = useCachedData(projectMailKey(row.rfq_id), () =>
    fetchProjectMail(row.rfq_id));
  const rSteps = resolveSteps(steps, row.work_type);
  const chain = buildStageChain(row, rSteps);
  const acts = buildActivities(row, rSteps);
  const { code, date } = splitProjectNo(row.project_no || row.kmaris_rfq_no || "—");
  const isService = (row.work_type || "부품공급") === "서비스";
  const editHref = `/project?rfq=${row.rfq_id}&stage=${Math.max(row.stage, 1)}`;
  // 선박은 오더별로 여러 척일 수 있다(vessels = 줄바꿈 구분). 한 줄 머리글이므로 · 로 잇는다.
  const vessels = (row.vessels || row.vessel).split("\n").filter(Boolean).join(" · ");

  return (
    <div
      className={`proj-ov${isService ? " service" : ""}${row.cancelled ? " cancelled" : ""}${
        embedded ? " embedded" : ""
      }`}
    >
      {/* 머리글 한 줄: 번호 · (날짜) · 타입 · 프로젝트명 · 선박 + 우측 액션.
          현재 단계·경과일·Next action 은 아래 Stages 스트립이 같은 내용을 더 정확히
          보여줘서 따로 두지 않는다.
          팝업 안(embedded)에서는 통째로 뺀다 — 번호·타입·제목·PIC 는 팝업 헤더가 이미
          같은 걸 보여주고, 뒤로·인쇄·"Open in Progress" 는 팝업 안에서 갈 곳이 없다. */}
      {embedded ? null : (
      <div className="proj-ov-head">
        <h1 className="proj-ov-id">
          <Link className="proj-ov-back" href="/project" title="Back to Projects">
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
                ? ` · ${(() => {
                    const label = closeReasonLabel(row.close_reason);
                    const note = (row.close_reason_note || "").trim();
                    return row.close_reason === "other"
                      ? (note || label)
                      : (note ? `${label} — ${note}` : label);
                  })()}`
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
      )}

      {/* 거래 상대 한 줄 — 고객·벤더·거래구분. 나머지 옛 Project info 항목은 이 페이지
          다른 곳에 이미 있다: 선박·제목은 머리글, 고객 P/O 번호는 Items 묶음 머리,
          Sales·Purchase·Margin 은 Items 합계 행. */}
      <div className="proj-ov-meta">
        <span className="ov-meta-f">
          <b>Customer</b>
          {row.customer ? <CustomerName name={row.customer} /> : <span className="muted">—</span>}
          {/* 고객사 담당자(연락 담당) — 회사명 우측에 한 톤 낮춰 붙인다. */}
          {row.contact_person ? <span className="ov-meta-contact">{row.contact_person}</span> : null}
        </span>
        <span className="ov-meta-f ov-meta-vendors">
          <b>Vendor</b>
          {vendorList(row)}
        </span>
        <span className="ov-meta-f">
          <b>Trade</b>
          {tr(row.trade_type || "수출")}
        </span>
      </div>

      <StageTimeline
        row={row}
        chain={chain}
        acts={acts}
        mails={(mail?.threads ?? []).flatMap((t) => t.messages)}
        onOpenStage={onOpenStage}
        onActivityAdded={onActivityAdded}
      />

      {/* 이 딜에서 고객·벤더와 오간 메일 — 단계 진행 바로 다음, 품목·금액 앞에 둔다.
          "무슨 일이 있었나"가 "얼마짜리인가"보다 먼저 읽히는 순서다. */}
      <ProjectMailPanel rfqId={row.rfq_id} />

      <ItemsSection
        stage={row.stage}
        orders={orders}
        purchaseOrders={purchaseOrders}
        quotations={quotations}
        rfqItems={rfqItems}
        vendorQuotes={vendorQuotes}
        vendorQuoteNo={vendorQuoteNo}
        nav={{ rfqId: row.rfq_id, onOpenStage }}
      />
    </div>
  );
}

/** 활동의 정렬·시각표시용 일시 문자열(iso). 노트는 datetime, 자동이벤트는 at 우선. */
function actAt(a: Activity): string {
  if (a.kind === "note") return a.note.datetime || a.note.at || a.date;
  if (a.kind === "auto") return a.at || a.date;
  return a.date;
}

/** 노트를 입력한 일시가 속한 단계로 자동 배치한다 — 그 시점에 "진행 중"이던 단계
 *  (= 완료 일시가 그 일시 이후인 가장 이른 단계). 모든 완료 단계보다 늦으면 현재 단계.
 *  일시를 못 읽으면 현재 단계. chain 은 no 오름차순, at 도 대체로 그에 따라 증가한다.
 *
 *  해당 없는 단계(N/A)도 완료 일시가 있으면 후보로 둔다 — 배치 기준은 "이 딜이 그 단계를
 *  밟았는가"가 아니라 "그 시각에 어디까지 와 있었는가"다. 빼 두면 내수 딜의 7·8단계 구간
 *  로그가 전부 9단계로 쏠려, 9단계 줄보다 열흘씩 이른 기록이 그 아래 쌓인다. */
/** 접히는 활동 로그의 한 줄 — 사람이 쓴 노트이거나, 오간 메일이거나. */
type LogItem = { at: string; act?: Activity; mail?: MailMessage };

/** 머리줄의 일시 — 날짜와 시각은 무게가 다르다. 세로로 훑을 때 눈이 잡는 건 날짜라
 *  굵게 검정으로 두고, 시각은 그 날 안에서의 순서일 뿐이라 한 급 작은 회색으로 붙인다. */
function OvWhen({ date, at }: { date: string; at: string }) {
  const t = hm(at);
  return (
    <span className="ov-tl-ndate">
      {md(date)}
      {t ? <span className="ov-tl-ntime">{t}</span> : null}
    </span>
  );
}

/** 메일 한 줄 — 방향·상대·요약. 노트와 달리 여기서 고칠 것이 없어 링크도 편집도 없다.
 *  원문은 아래 Mail 목록에서 편다(이 자리는 "언제 무슨 말이 오갔나"만 알려 준다). */
function renderMailRow(m: MailMessage, key: string) {
  return (
    <li key={key} className={`ov-tl-mail ${m.direction}`}>
      {/* 머리줄은 [날짜 · 방향 · 상대], 본문은 그 아래 칸 왼쪽 끝부터. 요약이 상대 이름
          오른쪽에서 시작하면 25% 폭 칸에서는 한 줄에 서너 글자밖에 못 들어간다. */}
      <div className="ov-tl-row">
        <OvWhen date={m.sent_at} at={m.sent_at} />
        <span className="ov-tl-maildir">{m.direction === "out" ? "→" : "←"}</span>
        {m.party ? <span className="ov-tl-mailparty">{m.party}</span> : null}
        <span className="ov-tl-mailsum">{m.summary || m.subject || "(no subject)"}</span>
      </div>
    </li>
  );
}

function stageForNote(chain: StageChainItem[], iso: string, current: number): number {
  const t = Date.parse((iso || "").slice(0, 16));
  if (Number.isNaN(t)) return current;
  for (const c of chain) {
    if (!c.at) continue;
    const ct = Date.parse(c.at);
    if (!Number.isNaN(ct) && ct >= t) return c.no;
  }
  return current;
}

/**
 * 단계 + 활동 — 단계가 뼈대, 사람이 쓴 노트가 그 단계 아래 붙는다.
 *
 * 아래 Items 표와 같은 4칸(RFQ / Quote / P/O / C/I)으로 나눠, 페이지 전체가 좌→우로
 * 한 방향으로 읽히게 한다. 세로로 길게 늘어놓으면 같은 단계의 "무슨 일이 있었나"와
 * "얼마였나"가 화면 위아래로 멀어져 눈이 오간다.
 *
 * 자동 이벤트(단계 완료)는 buildActivities 가 만든 것을 그대로 쓴다 — 상대(from/to)
 * 표기 규칙이 업무일지 화면과 갈라지지 않게 하기 위해서다.
 */
function StageTimeline({
  row,
  chain,
  acts,
  mails,
  onOpenStage,
  onActivityAdded,
}: {
  row: PipelineRow;
  chain: StageChainItem[];
  acts: Activity[];
  /** 이 딜에서 오간 메일 — 보낸/받은 시각이 속한 단계의 활동 로그에 함께 놓인다. */
  mails: MailMessage[];
  /** 주면 단계 줄이 링크 대신 이 콜백을 부른다(작업 팝업 안에서 화면 전환). */
  onOpenStage?: (stage: number, vrfqId?: number, orderId?: number) => void;
  /** 활동기록 추가 후 데이터 갱신 콜백. 주면 각 단계에 "+ note" 입력이 열린다. */
  onActivityAdded?: () => void | Promise<unknown>;
}) {
  // 어느 단계에 활동기록 입력창을 열어 뒀는지(한 번에 하나). null 이면 모두 닫힘.
  const [addStage, setAddStage] = useState<number | null>(null);
  // 활동기록(노트)을 펼쳐 둔 단계. 기본은 모두 접힘 — 개요는 "지금 어디까지 왔나"를 한눈에
  // 보는 자리라, 통화·메일 로그가 길게 깔리면 단계 진행이 묻힌다. 단계별로 ▾ 로 펼친다.
  const [openNotes, setOpenNotes] = useState<number[]>([]);
  const toggleNotes = (no: number) =>
    setOpenNotes((prev) => (prev.includes(no) ? prev.filter((x) => x !== no) : [...prev, no]));
  // 노트 편집(★·수정·삭제)에 필요한 Party/Person 후보 — 이 딜의 고객사·벤더사와 담당자.
  const parties = activityParties(row);
  const persons = activityPersons(row);

  // 단계별로 활동을 나눠 담는다. 자동 이벤트는 대개 단계당 1건이나, 2단계(RFQ Sent)는
  // 벤더별 발송이 여러 건일 수 있어 리스트로 담는다. 노트는 저장된 단계가 아니라 입력
  // 일시가 속한 단계로 자동 배치한다(stageForNote) — 어느 단계에 넣을지 고를 필요가 없다.
  const autoOf = new Map<number, Extract<Activity, { kind: "auto" }>[]>();
  const notesOf = new Map<number, Extract<Activity, { kind: "note" }>[]>();
  let closeAct: Extract<Activity, { kind: "close" }> | null = null;
  for (const a of acts) {
    if (a.kind === "auto") autoOf.set(a.stage, [...(autoOf.get(a.stage) ?? []), a]);
    else if (a.kind === "note") {
      const s = stageForNote(chain, a.note.datetime || a.note.at || a.date, row.stage);
      notesOf.set(s, [...(notesOf.get(s) ?? []), a]);
    } else closeAct = a;
  }
  // 메일도 노트와 같은 규칙으로 단계에 놓는다 — 보낸/받은 시각이 어느 단계 안에서
  // 일어났는지가 그 메일이 속할 자리다. 별도의 메일 타임라인을 아래에 또 두면, 같은
  // 이야기의 "무엇을 했다"와 "무슨 말이 오갔다"가 화면 위아래로 갈라진다.
  const mailOf = new Map<number, MailMessage[]>();
  for (const m of mails) {
    const s = stageForNote(chain, m.sent_at, row.stage);
    mailOf.set(s, [...(mailOf.get(s) ?? []), m]);
  }
  const done = Math.max(0, Math.min(row.stage, chain.length));

  return (
    <section className="proj-ov-sec">
      <h2 className="proj-ov-h">
        Stages &amp; activity
        <span className="proj-ov-cnt">
          {done}/{chain.length}
        </span>
        {/* 업무일지(Activity Log)에서 이 프로젝트만 걸러 보는 바로가기. 검색어에 프로젝트
            번호를 실어 By-deal 카드가 이 딜만 남게 한다. 입력·수정은 그 화면에서 한다. */}
        <Link
          className="proj-ov-actlink"
          href={`/activity?q=${encodeURIComponent(row.project_no || row.kmaris_rfq_no || "")}`}
          title="Open this project in the Activity Log"
        >
          Activity Log →
        </Link>
      </h2>
      <div className="proj-ov-tlcols">
        {STAGE_COLUMNS.map((col) => (
          <div key={col.label} className={`ov-tlcol ${col.tone}`}>
            <div className="ov-tlcol-h">{col.label}</div>
            <ol className="proj-ov-tl">
              {chain
                .filter((c) => c.no >= col.from && c.no <= col.to)
                .map((c) => {
                  const state = c.no < row.stage ? "done" : c.no === row.stage ? "current" : "todo";
                  const autos = autoOf.get(c.no) ?? [];
                  const notes = notesOf.get(c.no) ?? [];
                  // 이 단계의 활동(자동이벤트 + 노트)을 시간순 한 목록으로. 날짜는 헤더가 아니라
                  // 각 행에 두고(열 정렬), 헤더에는 번호·제목만 남긴다.
                  const rows: Activity[] = [...autos, ...notes];
                  rows.sort((x, y) => actAt(x).localeCompare(actAt(y)));
                  return (
                    <li key={c.no} className={`${state}${c.skip ? " skip" : ""}`}>
                      {/* 헤더(번호+제목)를 따로 두지 않는다. 단계 번호 원형은 그 단계의
                          메인 활동(자동이벤트) 행에 얹고, 그 행이 작업화면 진입 링크가 된다.
                          클릭은 팝업 안에선 버튼(onOpenStage), 페이지에선 Link 로 그 단계를 연다.
                          활동이 아직 없는 미래 단계·N/A 는 번호+제목 한 줄(로드맵 자리)로만 남긴다. */}
                      {(() => {
                        const openTitle = onOpenStage
                          ? `Open stage ${c.no} in the work view`
                          : `Open stage ${c.no} in Progress`;
                        // vrfqId: 2단계 RFQ Sent 로그를 클릭하면 그 벤더 RFQ 상세로 바로 이동.
                        const rowLink = (children: ReactNode, vrfqId?: number) =>
                          onOpenStage ? (
                            <button type="button" className="ov-tl-rowlink" onClick={() => onOpenStage(c.no, vrfqId)} title={openTitle}>
                              {children}
                            </button>
                          ) : (
                            <Link
                              className="ov-tl-rowlink"
                              href={`/project?rfq=${row.rfq_id}&stage=${c.no}${vrfqId ? `&vrfq=${vrfqId}` : ""}`}
                              title={openTitle}
                            >
                              {children}
                            </Link>
                          );
                        // 해당 없는 단계(내수 부품공급의 C/I·PL·SA·POD) 표시. 활동 기록이
                        // 있어도 늘 붙인다 — 흐림(.skip)만으로는 "아직 안 한 단계"로 읽힌다.
                        const naTag = c.skip ? <span className="ov-tl-na">N/A</span> : null;
                        // 지금 어디까지 왔나 — 번호 원형과 그 링이 하던 표시다. 왼쪽 자리를
                        // 쓰지 않도록 행 오른쪽 끝 칩으로 옮겼다(N/A 와 같은 자리·같은 꼴).
                        const nowTag = c.no === row.stage ? <span className="ov-tl-now">NOW</span> : null;
                        if (!rows.length) {
                          return rowLink(
                            <>
                              <b className="ov-tl-label">{c.label}</b>
                              {nowTag}
                              {naTag}
                            </>,
                          );
                        }
                        // 메인 활동 = 그 단계의 자동 이벤트(단계 완료). 없으면(노트만 있는
                        // 단계) 번호+제목만의 헤더 줄을 따로 얹어 모든 노트를 편집 가능한
                        // 행으로 남긴다 — 노트가 메인 자리로 올라가면 링크에 감싸여 편집할 수 없다.
                        // 늘 보이는 줄(단계 진행 + ★ 노트)과 접히는 줄(그 외 활동기록)을 나눈다.
                        // 접히는 줄은 토글 바로 아래에 통째로 붙는다 — 시간순 사이사이에 흩어 놓으면
                        // 펼칠 때 토글 위에 줄이 생겨 방금 누른 버튼이 아래로 밀린다.
                        // 감추기는 CSS 가 한다(DOM 에는 남긴다) — 인쇄물엔 접힌 것도 다 나와야 한다.
                        const isLog = (a: Activity) => a.kind === "note" && !a.note.star;
                        const pinned = rows.filter((a) => !isLog(a));
                        const mainIdx = pinned.findIndex((r) => r.kind === "auto");
                        const notesOpen = openNotes.includes(c.no);
                        // 접히는 로그 = 평범한 노트 + 이 단계에서 오간 메일. 시간순으로
                        // 한 줄씩 섞는다 — 둘은 같은 단계에서 일어난 같은 일의 두 면이다.
                        const log: LogItem[] = [
                          ...rows.filter(isLog).map((a) => ({ at: actAt(a), act: a })),
                          ...(mailOf.get(c.no) ?? []).map((m) => ({ at: m.sent_at, mail: m })),
                        ].sort((x, y) => x.at.localeCompare(y.at));
                        const mailCount = (mailOf.get(c.no) ?? []).length;
                        // 블록을 통째로 첫 로그의 시각 자리에 끼운다 — 단계 완료보다 이른 기록이면
                        // 단계 줄 위로 간다(그 단계를 끝내기까지 있었던 일이므로). 블록이 쪼개지지
                        // 않으니 펼침은 늘 토글 아래로만 늘어나고, 토글은 제자리에 남는다.
                        const logAt = log.length ? log[0].at : "";
                        const logPos = log.length
                          ? pinned.filter((a) => actAt(a) <= logAt).length
                          : pinned.length;
                        // 활동 1줄 — 노트는 편집 가능한 행으로, 자동 이벤트는 단계/벤더 링크 행으로.
                        const renderRow = (a: Activity, key: string, isMain: boolean) => {
                          const dateEl = <OvWhen date={a.date} at={actAt(a)} />;
                          // 사람이 쓴 노트 — ★·수정·삭제가 가능한 편집 행으로 렌더한다.
                          if (a.kind === "note") {
                            return (
                              <OvNoteRow
                                key={key}
                                a={a}
                                dateEl={dateEl}
                                rfqId={row.rfq_id}
                                parties={parties}
                                persons={persons}
                                onChanged={onActivityAdded}
                              />
                            );
                          }
                          // rows 에는 close 가 섞이지 않지만(별도 처리), 타입 좁히기용 가드.
                          if (a.kind !== "auto") return null;
                          // 머리줄은 [날짜][라벨][칩], 본문줄은 상대 표기. 라벨(RFQ Sent…)은
                          // 짧고 그 줄이 무슨 사건인지 알려 주는 이름이라 날짜 옆에 두고,
                          // 긴 상대 표기만 아래 줄 왼쪽 끝부터 흐르게 한다.
                          const contentEl = (tags?: ReactNode) => (
                            <>
                              <b className="ov-tl-actlabel">{a.label}</b>
                              {tags}
                              {a.party ? <span className="ov-tl-actmeta">{a.party}</span> : null}
                            </>
                          );
                          // 메인 활동 행(자동 이벤트) = 그 단계의 작업화면으로 가는 링크.
                          if (isMain) {
                            return (
                              <li key={key} className="ov-tl-main">
                                {rowLink(<>{dateEl}{contentEl(<>{nowTag}{naTag}</>)}</>, a.vrfqId)}
                              </li>
                            );
                          }
                          // 2단계 RFQ Sent 처럼 벤더 RFQ id 가 있는 보조 행은 그 벤더 상세로 가는 링크.
                          if (a.vrfqId) {
                            return (
                              <li key={key}>
                                {rowLink(<>{dateEl}{contentEl()}</>, a.vrfqId)}
                              </li>
                            );
                          }
                          return (
                            <li key={key}>
                              <div className="ov-tl-row">
                                {dateEl}
                                {contentEl()}
                              </div>
                            </li>
                          );
                        };
                        const pinnedRows = pinned.map((a, i) => renderRow(a, `p${i}`, i === mainIdx));
                        // 토글 + 접힌 로그 = 한 덩어리. 위 logPos 자리에 통째로 들어간다.
                        const logBlock = log.length
                          ? [
                              <li key="more" className="ov-tl-morerow">
                                <button
                                  type="button"
                                  className="ov-tl-more"
                                  onClick={() => toggleNotes(c.no)}
                                  title={
                                    notesOpen
                                      ? "Collapse the activity log for this stage"
                                      : "Show the activity log for this stage"
                                  }
                                >
                                  {notesOpen
                                    ? "▴ hide log"
                                    : `▾ ${log.length} more${mailCount ? ` · ${mailCount} mail` : ""}`}
                                </button>
                              </li>,
                              ...log.map((it, i) =>
                                it.act
                                  ? renderRow(it.act, `n${i}`, false)
                                  : renderMailRow(it.mail as MailMessage, `m${i}`)),
                            ]
                          : [];
                        return (
                          <ul className={`ov-tl-acts${notesOpen ? " notes-open" : ""}`}>
                            {mainIdx < 0 ? (
                              <li className="ov-tl-main">
                                {rowLink(
                                  <>
                                    <b className="ov-tl-label">{c.label}</b>
                                    {nowTag}
                                    {naTag}
                                  </>,
                                )}
                              </li>
                            ) : null}
                            {pinnedRows.slice(0, logPos)}
                            {logBlock}
                            {pinnedRows.slice(logPos)}
                          </ul>
                        );
                      })()}
                      {/* 활동기록 추가 — 마지막 활동 바로 아래, 즉 현재 단계 로그 맨 밑에 한 곳만.
                          입력한 일시로 알맞은 단계에 자동 배치된다. 현재 단계는 흐림이 없어
                          단계 li 안에 둬도 눌리지 않는다. onActivityAdded 있을 때만(로그인) 노출. */}
                      {onActivityAdded && c.no === row.stage ? (
                        addStage === c.no ? (
                          <div className="ov-tl-addform">
                            <StageAddNote
                              rfqId={row.rfq_id}
                              chain={chain}
                              currentStage={row.stage}
                              parties={activityParties(row)}
                              persons={activityPersons(row)}
                              onDone={async () => {
                                setAddStage(null);
                                await onActivityAdded();
                              }}
                              onCancel={() => setAddStage(null)}
                            />
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="ov-tl-add ov-tl-addfoot"
                            onClick={() => setAddStage(c.no)}
                            title="Add activity — placed by the date you enter"
                          >
                            + note
                          </button>
                        )
                      ) : null}
                    </li>
                  );
                })}
            </ol>
          </div>
        ))}
      </div>
      {/* 종결은 특정 단계에 속하지 않으므로 4칸 아래 전체 폭으로. */}
      {closeAct ? (
        <div className="ov-tl-closed">
          <span className="ov-tl-dot" aria-hidden>
            ⊘
          </span>
          <ActivityDesc act={closeAct} />
          <time className="ov-tl-at">{closeAct.date ? md(closeAct.date) : ""}</time>
        </div>
      ) : null}
    </section>
  );
}

/** 활동기록(stage note) → 저장 payload. 빈 값은 보내지 않아 서버가 '미지정'으로 남긴다.
 *  (ActivityScreen 의 formToPatch 와 같은 규칙 — 두 화면이 같은 stage_notes 에 쓴다.) */
function noteFormToPatch(v: ActivityNoteValue) {
  return {
    text: v.text.trim(),
    datetime: v.datetime,
    direction: v.direction || undefined,
    party: v.party || undefined,
    person: v.person || undefined,
    channel: v.channel || undefined,
    star: v.star,
    pic: v.pic.trim() || undefined,
  };
}

/** 저장된 노트 → 폼 값(ActivityScreen 의 noteToForm 과 같은 규칙). */
function noteToForm(n: StageNote): ActivityNoteValue {
  return initialNoteValue({
    text: n.text,
    datetime: n.datetime || n.at || "",
    direction: (n.direction as "" | "in" | "out") || "",
    party: n.party || "",
    person: n.person || "",
    channel: n.channel || "",
    star: !!n.star,
    pic: n.pic || "",
  });
}

/**
 * 개요 타임라인의 노트 1건 — 표시 / 인라인 수정 토글 + ★·삭제.
 * 노트는 화면상 입력 일시로 배치되지만(stageForNote), 수정·삭제는 저장된 단계·인덱스
 * (a.stage·a.index)로 해야 서버의 그 노트를 정확히 가리킨다. onChanged 가 없으면(=편집
 * 불가 맥락) 읽기 전용으로 그린다. Activity Log 화면의 NoteRow 와 같은 동작을 개요 폼에 맞춘 것.
 */
function OvNoteRow({
  a,
  dateEl,
  rfqId,
  parties,
  persons,
  onChanged,
}: {
  a: Extract<Activity, { kind: "note" }>;
  dateEl: ReactNode;
  rfqId: number;
  parties: string[];
  persons: string[];
  onChanged?: () => void | Promise<unknown>;
}) {
  const n = a.note;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<ActivityNoteValue>(() => noteToForm(n));

  // 편집 불가 맥락 — 예전처럼 읽기 전용 한 줄(★ 접두 표시 유지).
  // ov-tl-note: 개요에서 접히는 대상 표시(★ 는 접지 않는다) — 감추기는 CSS 가 한다.
  if (!onChanged) {
    return (
      <li className={`ov-tl-note${n.star ? " star" : ""}`}>
        <div className="ov-tl-row">
          {dateEl}
          <span className="ov-tl-ntext"><ActivityDesc act={a} metaBlock /></span>
        </div>
      </li>
    );
  }

  async function toggleStar() {
    setBusy(true);
    try {
      // 저장된 값 그대로 두고 star 만 뒤집는다(ActivityScreen.toggleStar 와 동일).
      await updateRfqStageNote(rfqId, a.stage, a.index, {
        text: n.text,
        datetime: n.datetime,
        direction: n.direction,
        party: n.party,
        person: n.person,
        channel: n.channel,
        star: !n.star,
        pic: n.pic,
      });
      await onChanged!();
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!form.text.trim()) return;
    setBusy(true);
    try {
      await updateRfqStageNote(rfqId, a.stage, a.index, noteFormToPatch(form));
      setEditing(false);
      await onChanged!();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("Delete this activity?")) return;
    setBusy(true);
    try {
      await deleteRfqStageNote(rfqId, a.stage, a.index);
      await onChanged!();
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <li className="ov-tl-note ov-tl-noteedit">
        <div className="ov-tl-row">
          <div className="ov-tl-editform">
            <ActivityNoteForm
              value={form}
              onChange={setForm}
              onSubmit={save}
              onCancel={() => setEditing(false)}
              submitLabel="Save"
              busy={busy}
              partyPresets={parties}
              personPresets={persons}
            />
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className={`ov-tl-note${n.star ? " star" : ""}`}>
      <div className="ov-tl-row ov-tl-noterow">
        {dateEl}
        <span className="ov-tl-ntext">
          <ActivityDesc act={a} metaBlock hideStar />
        </span>
        <span className="ov-tl-nactions">
          <button
            type="button"
            className={`ov-tl-star${n.star ? " on" : ""}`}
            title="Mark priority"
            onClick={toggleStar}
            disabled={busy}
          >
            ★
          </button>
          <button
            type="button"
            className="ov-tl-nedit"
            title="Edit"
            onClick={() => { setForm(noteToForm(n)); setEditing(true); }}
            disabled={busy}
          >
            ✎
          </button>
          <button
            type="button"
            className="ov-tl-ndel"
            title="Delete"
            onClick={remove}
            disabled={busy}
          >
            ×
          </button>
        </span>
      </div>
    </li>
  );
}

/** 개요에 활동기록 1건 추가 — 공용 ActivityNoteForm 을 그대로 쓴다. 저장 단계는 고르지
 *  않고 입력한 일시(stageForNote)로 자동 결정한다 — 화면 표시와 같은 규칙이라 어긋나지 않는다. */
function StageAddNote({
  rfqId,
  chain,
  currentStage,
  onDone,
  onCancel,
  parties,
  persons,
}: {
  rfqId: number;
  chain: StageChainItem[];
  currentStage: number;
  onDone: () => void | Promise<unknown>;
  onCancel: () => void;
  parties: string[];
  persons: string[];
}) {
  const [form, setForm] = useState<ActivityNoteValue>(() => initialNoteValue());
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!form.text.trim()) return;
    setBusy(true);
    try {
      const patch = noteFormToPatch(form);
      const stage = stageForNote(chain, patch.datetime, currentStage);
      await addRfqStageNote(rfqId, stage, patch);
      await onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <ActivityNoteForm
      value={form}
      onChange={setForm}
      onSubmit={submit}
      onCancel={onCancel}
      submitLabel="Add"
      busy={busy}
      partyPresets={parties}
      personPresets={persons}
    />
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
  stage,
  orders,
  purchaseOrders,
  quotations,
  rfqItems,
  vendorQuotes,
  vendorQuoteNo,
  nav,
}: {
  stage: number;
  orders: ProjectOrder[];
  purchaseOrders: VendorPo[];
  quotations: ProjectQuote[];
  rfqItems: RfqItem[] | null;
  vendorQuotes: VqRef[];
  vendorQuoteNo: string;
  nav: DocNav;
}) {
  const hasGroups = orders.length > 0 || quotations.length > 0;
  const phaseClass = (from: number) => (stage >= from ? "ov-phase-on" : "ov-phase-todo");
  const rfqPhase = phaseClass(1);
  const quotePhase = phaseClass(3);
  const poPhase = phaseClass(5);
  const ciPhase = phaseClass(7);
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
            {/* 열 폭 고정 — 식별 4열이 25%, Quote·P/O·C/I 가 각 25%. 위 Stages 4칸과
                경계를 같은 자리(25/50/75%)에 두려는 것. 둘 중 하나만 바꾸면 어긋난다. */}
            {/* 톤(ovt-*)은 각 단계 열에 옅은 바탕을 깔아 위 Stages 4칸과 세로로 잇는다. */}
            <colgroup>
              <col className="ovc-n ovt-r" />
              <col className="ovc-part ovt-r" />
              <col className="ovc-desc ovt-r" />
              <col className="ovc-qty ovt-r" />
              {["q", "p", "c"].map((g) => (
                <Fragment key={g}>
                  <col className={`ovc-pur ovt-${g}`} />
                  <col className={`ovc-mg ovt-${g}`} />
                  <col className={`ovc-sales ovt-${g}`} />
                </Fragment>
              ))}
            </colgroup>
            <thead>
              <tr>
                <th className={`ov-it-n ${rfqPhase}`} rowSpan={2}>
                  #
                </th>
                <th className={rfqPhase} rowSpan={2}>Part No.</th>
                <th className={rfqPhase} rowSpan={2}>Description</th>
                <th className={`ov-it-qty ${rfqPhase}`} rowSpan={2}>
                  Qty
                </th>
                <th className={`num ov-gh q gs ${quotePhase}`} colSpan={3}>
                  Quote
                </th>
                <th className={`num ov-gh p gs ${poPhase}`} colSpan={3}>
                  P/O
                </th>
                <th className={`num ov-gh c gs ${ciPhase}`} colSpan={3}>
                  C/I
                </th>
              </tr>
              <tr>
                {[["q", quotePhase], ["p", poPhase], ["c", ciPhase]].map(([g, phase]) => (
                  <Fragment key={g}>
                    <th className={`num ov-sub ${g} gs ${phase}`}>Purchase</th>
                    <th className={`num ov-sub ${g} ${phase}`}>Margin</th>
                    <th className={`num ov-sub ${g} ${phase}`}>Sales</th>
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
                  quote={quoteForOrder(o, quotations)}
                  vendorQuotes={vendorQuotes}
                  vendorQuoteNo={vendorQuoteNo}
                  nav={nav}
                />
              ))
            ) : (
              // P/O 전 — 이 프로젝트의 견적을 건별로 한 묶음씩(견적번호 오름차순).
              quotations.map((q) => (
                <QuoteOnlyGroup
                  key={q.id}
                  quoteId={q.id}
                  vendorQuotes={vendorQuotes}
                  vendorQuoteNo={vendorQuoteNo}
                  nav={nav}
                />
              ))
            )}
          </table>
        </div>
      )}
    </section>
  );
}

/** 통화 + 금액 한 줄(조밀). 값이 없으면 —. 0 으로 보이면 "무료"로 오해되므로 구분한다.
 *  0 은 아직 값이 없다는 뜻이라 .zero 로 톤만 낮춘다(표기는 그대로 둔다).
 *
 *  excluded 는 "이 문서에서 뺀 줄"이라 —(없음)과도 0(값이 0)과도 다르게 적는다.
 *  그러지 않으면 "발주에서 빠진 품목"과 "끼워 준 0원 품목"이 같은 칸으로 보인다. */
function Money({
  value,
  currency,
  excluded,
}: {
  value: number | null | undefined;
  currency: string;
  excluded?: boolean;
}) {
  if (excluded) return <span className="ov-excl" title="Excluded from this document">excl.</span>;
  if (value == null || !Number.isFinite(value)) return <span className="muted">—</span>;
  return (
    <span className={`ov-m${Math.round(value) === 0 ? " zero" : ""}`}>
      <em>{currency}</em> {Math.round(value).toLocaleString()}
    </span>
  );
}

function Pct({ value, excluded }: { value: number | null; excluded?: boolean }) {
  if (excluded || value == null) return <span className="muted">—</span>;
  return <span className="ov-pct">{value}%</span>;
}

/** 한 선박(=고객 P/O) 묶음 — 그 P/O 의 품목을 기준 행으로 삼고 견적·C/I 를 순서로 맞춘다. */
function OrderItemGroup({
  order,
  vendorPos,
  quote: quoteRow,
  vendorQuotes,
  vendorQuoteNo,
  nav,
}: {
  order: ProjectOrder;
  vendorPos: VendorPo[];
  /** 이 선박의 견적(목록 행). 없으면 견적 없이 발주된 선박. */
  quote: ProjectQuote | null;
  vendorQuotes: VqRef[];
  vendorQuoteNo: string;
  nav: DocNav;
}) {
  // 원가·마진은 견적 목록에 없고 상세에만 있어 따로 받는다(_item_view 가 원가를 지움).
  const qid = quoteRow?.id ?? 0;
  const { data: quote } = useCachedData(`quotation:${qid}`, () =>
    qid ? fetchCustomerQuotationDetail(qid) : Promise.resolve(null)
  );
  const { data: doc } = useCachedData(`documents:${order.id}`, () => fetchDocumentDetail(order.id));
  const ci = doc?.ci ?? null;
  // 부대비용(Freight/Packing/Insurance)·VAT — 매입측은 벤더 청구(AP)에 기록된다.
  // 캐시 키는 AP 편집 화면(ArScreen)과 같은 것을 쓴다 — 같은 응답을 두 번 받지 않게.
  const { data: apData } = useCachedData(`ap:by-order:${order.id}`, () => fetchApByOrder(order.id));

  // 매입 = 실제 Vendor P/O. 한 오더에 발주서가 여러 장이면 P/O 번호 순으로 이어 붙여 순서를 맞춘다.
  const vpos = sortByDocNo(vendorPos, (p) => p.po_no, (p) => p.id);
  const vpoItems = vpos.flatMap((p) => p.items);
  const vpoCur = vpos[0]?.currency || order.currency || "USD";
  const vpoNos = vpos.map((p) => p.po_no).filter(Boolean);

  const qCur = quote?.currency || order.currency || "USD";
  const qCostCur = quote?.cost_currency || qCur;
  const oCur = order.currency || "USD";
  const ciCur = ci?.currency || oCur;
  // 환산 기준은 견적에 저장된 환율(없으면 기본값). 통화가 다른 단계 간 마진 계산에만 쓰인다.
  const rate = quote?.fx_rate && quote.fx_rate > 0 ? quote.fx_rate : USD_KRW_RATE;

  // ── 부대비용·VAT ─────────────────────────────────────────────────────────
  // 품목 단가에는 들어가지 않고 문서 하단에 붙는 금액이라, 품목 줄 아래 별도 줄로 그리고
  // 합계에 더한다. 실무상 견적·P/O 단계에는 없고 C/I(매출)와 벤더 청구(매입)에서 붙는다.
  const ciCharges = readCharges(ci?.terms);
  const apRecords = (apData?.rows ?? []).map((r) => r.ap).filter((a): a is ApRow => !!a);
  // 벤더 청구가 여러 건(P/O 여러 장)이면 합산 — 통화가 다르면 벤더 P/O 통화로 환산해 더한다.
  const apCharges = apRecords.reduce<Charges | null>((acc, a) => {
    const c = readCharges(a.charges);
    if (!c) return acc;
    const conv = (v: number) => convertCurrency(v, a.currency, vpoCur, rate);
    const add = { freight: conv(c.freight), packing: conv(c.packing), insurance: conv(c.insurance) };
    return {
      freight: (acc?.freight ?? 0) + add.freight,
      packing: (acc?.packing ?? 0) + add.packing,
      insurance: (acc?.insurance ?? 0) + add.insurance,
      total: (acc?.total ?? 0) + add.freight + add.packing + add.insurance,
    };
  }, null);
  const ciVatRate = vatFraction(ci?.vat_rate);
  // 매입 VAT 율 — 벤더 청구서의 세율(국내 매입은 대개 10%). 여러 건이면 첫 값을 쓴다.
  const apVatRate = vatFraction(apRecords.find((a) => a.vat_rate != null)?.vat_rate);

  const rows = order.items.length ? order.items : (quote?.items ?? []);
  // 품번으로 각 문서의 같은 품목을 찾는다. 아래 map 이 순서대로 돌면서 소비한다.
  const matchQuote = makeItemMatcher(quote?.items ?? []);
  const matchVpo = makeItemMatcher(vpoItems);
  const matchCi = makeItemMatcher(ci?.items ?? []);

  // 줄별 금액을 한 번에 계산해 두고, 합계는 이 값들을 더한다(화면 숫자와 합계가 늘 일치).
  const lines = rows.map((it, i) => {
    const qIt = matchQuote(it, i);
    const vIt = matchVpo(it, i);
    const cIt = matchCi(it, i);
    // 제외는 단계마다 따로 정한다 — 견적에는 넣었다가 발주에서 뺀 품목이 흔하다.
    // 매입/매출도 서로 다른 문서(벤더 P/O vs 고객 P/O)라 각각의 표식을 본다.
    const qEx = !!qIt?.excluded;
    const vEx = !!vIt?.excluded;
    return {
      it,
      qIt,
      qEx,
      vEx,
      pSalesEx: !!it.excluded,
      cSalesEx: !!cIt?.excluded,
      qPur: qEx || qIt?.cost_price == null
        ? null
        : Number(qIt.cost_price) * Number(qIt.qty || 1),
      qSales: lineAmount(qIt),
      pPur: lineAmount(vIt),
      pSales: lineAmount(it),
      cPur: vEx ? null : ciPurchase(vIt, cIt),
      cSales: lineAmount(cIt),
    };
  });

  // C/I 단계 금액 = 품목 합계 + 부대비용(=공급가액). VAT 는 그 위에 따로 얹는다 —
  // 마진은 공급가액끼리 봐야 뜻이 맞고(부가세는 남는 돈이 아니다), 청구 총액은 아래
  // "Total incl. VAT" 줄에서 확인한다.
  const ciPurSupply = addCharges(total(lines.map((l) => l.cPur)), apCharges?.total);
  const ciSalesSupply = addCharges(total(lines.map((l) => l.cSales)), ciCharges?.total);
  const ciPurVat = ciPurSupply == null ? null : ciPurSupply * apVatRate;
  const ciSalesVat = ciSalesSupply == null ? null : ciSalesSupply * ciVatRate;
  // 양쪽 다 0이면(수출처럼 영세율뿐이면) VAT 줄을 만들지 않는다. 한쪽만 붙는 경우
  // (국내 매입 10% + 수출 매출 0%)는 흔하므로, 0 인 쪽도 0 으로 적어 대비를 보여준다.
  const hasVat = !!(ciPurVat || ciSalesVat);

  return (
    <tbody className="ov-grp">
      <GroupHead
        vessel={order.vessel}
        quoteDocs={quote ? { sales: quote.qtn_no || "—" } : null}
        vendorQuotes={vendorQuotes}
        srcVqId={quote?.vendor_quote_id ?? null}
        vendorQuoteNo={quote?.vendor_quote_no || vendorQuoteNo}
        poDocs={{ pur: vpoNos, sales: order.po_no || "—" }}
        ciNo={ci?.ci_no || ""}
        orderId={order.id}
        nav={nav}
      />
      {/* 합계를 품목 1번행 바로 위에 둔다 — 표를 끝까지 훑지 않고도 단계별 총액을 먼저 본다. */}
      <GroupTotal
        quotePur={total(lines.map((l) => l.qPur))}
        quoteSales={total(lines.map((l) => l.qSales))}
        poPur={total(lines.map((l) => l.pPur))}
        poSales={total(lines.map((l) => l.pSales))}
        ciPur={ciPurSupply}
        ciSales={ciSalesSupply}
        cur={{ qCostCur, qCur, vpoCur, oCur, ciCur }}
        rate={rate}
      />
      {lines.map((ln, i) => (
        <tr key={i}>
          <td className="ov-it-n">{i + 1}</td>
          <td className="ov-it-part">{ln.it.part_no || <span className="muted">—</span>}</td>
          <td>{ln.it.description || ln.qIt?.description || "—"}</td>
          <td className="ov-it-qty">
            {Number(ln.it.qty || 1)}
            {ln.it.unit ? ` ${ln.it.unit}` : ""}
          </td>
          <td className="num gs">
            <Money value={ln.qPur} currency={qCostCur} excluded={ln.qEx} />
          </td>
          <td className="num">
            <Pct value={ln.qIt?.margin_pct ?? null} excluded={ln.qEx} />
          </td>
          <td className="num ov-sal">
            <Money value={ln.qSales} currency={qCur} excluded={ln.qEx} />
          </td>
          <td className="num gs">
            <Money value={ln.pPur} currency={vpoCur} excluded={ln.vEx} />
          </td>
          <td className="num">
            <Pct
              value={marginPct(ln.pSales, ln.pPur, oCur, vpoCur, rate)}
              excluded={ln.vEx || ln.pSalesEx}
            />
          </td>
          <td className="num ov-sal">
            <Money value={ln.pSales} currency={oCur} excluded={ln.pSalesEx} />
          </td>
          <td className="num gs">
            <Money value={ln.cPur} currency={vpoCur} excluded={ln.vEx} />
          </td>
          <td className="num">
            <Pct
              value={marginPct(ln.cSales, ln.cPur, ciCur, vpoCur, rate)}
              excluded={ln.vEx || ln.cSalesEx}
            />
          </td>
          <td className="num ov-sal">
            <Money value={ln.cSales} currency={ciCur} excluded={ln.cSalesEx} />
          </td>
        </tr>
      ))}
      {/* 부대비용 — 값이 있는 항목만 한 줄씩. 위 Total 에는 이미 더해져 있다. */}
      {CHARGE_LABELS.map(([k, label]) =>
        apCharges?.[k] || ciCharges?.[k] ? (
          <ExtraRow
            key={k}
            label={label}
            pur={apCharges?.[k] ?? null}
            sales={ciCharges?.[k] ?? null}
            purCur={vpoCur}
            salesCur={ciCur}
          />
        ) : null
      )}
      {hasVat ? (
        <ExtraRow
          label={vatLabel(ciVatRate, apVatRate)}
          pur={ciPurVat}
          sales={ciSalesVat}
          purCur={vpoCur}
          salesCur={ciCur}
        />
      ) : null}
      {hasVat ? (
        <ExtraRow
          grand
          label="Total incl. VAT"
          pur={ciPurSupply == null ? null : ciPurSupply + (ciPurVat ?? 0)}
          sales={ciSalesSupply == null ? null : ciSalesSupply + (ciSalesVat ?? 0)}
          purCur={vpoCur}
          salesCur={ciCur}
        />
      ) : null}
    </tbody>
  );
}

/**
 * 부대비용·VAT 한 줄 — 품목이 아니라 문서에 붙는 금액이라 품목 줄 아래에 따로 놓는다.
 * 기록되는 자리가 C/I(매출)와 벤더 청구(매입)뿐이라 앞의 두 단계 칸은 비워 둔다 —
 * "—"로 채우면 값이 있는 자리와 구분이 안 된다. 줄 단위 마진은 뜻이 없어 마진 칸도 비운다.
 */
function ExtraRow({
  label,
  pur,
  sales,
  purCur,
  salesCur,
  grand = false,
}: {
  label: string;
  pur: number | null;
  sales: number | null;
  purCur: string;
  salesCur: string;
  grand?: boolean;
}) {
  return (
    <tr className={`ov-grp-extra${grand ? " ov-grp-grand" : ""}`}>
      <td colSpan={4} className="ov-it-extralabel">
        {label}
      </td>
      <td className="num gs" colSpan={3} />
      <td className="num gs" colSpan={3} />
      <td className="num gs">{pur == null ? null : <Money value={pur} currency={purCur} />}</td>
      <td className="num" />
      <td className="num ov-sal">{sales == null ? null : <Money value={sales} currency={salesCur} />}</td>
    </tr>
  );
}

/**
 * 선박 묶음 머리 — 문서번호를 각 단계 열 위에 정렬해 둔다.
 * 한 줄에 몰아 쓰면 어느 번호가 어느 단계인지 눈으로 짚어야 해서, 열에 맞춰 나눈다.
 * 각 단계는 "매입문서 → 매출문서" 순(예: 벤더견적 → 고객견적, 벤더P/O → 고객P/O).
 */
function GroupHead({
  vessel,
  quoteDocs,
  vendorQuotes,
  srcVqId,
  vendorQuoteNo,
  poDocs,
  ciNo,
  orderId,
  nav,
}: {
  vessel: string;
  quoteDocs: { sales: string } | null;
  /** 이 프로젝트가 받은 벤더 견적 전부(받은 순). 여러 벤더에 물었으면 여러 건이다. */
  vendorQuotes: VqRef[];
  /** 그중 이 고객 견적이 원가 출처로 고른 한 건. 나머지는 비교용으로 받아 둔 견적이다. */
  srcVqId: number | null;
  /** 목록을 못 받았을 때 쓰는 번호 한 줄(폴백). */
  vendorQuoteNo: string;
  /** 벤더 P/O 는 한 오더에 여러 장일 수 있어 배열 — 번호마다 따로 링크한다. */
  poDocs: { pur: string[]; sales: string };
  ciNo: string;
  /** 이 묶음의 고객 P/O(오더). 5단계 이후 링크가 이 선박을 골라 연다. */
  orderId?: number;
  nav: DocNav;
}) {
  // 원가로 쓴 견적을 맨 앞에. 나머지는 받은 순서 그대로 뒤에 붙어, 앞의 것이 이 딜의
  // 원가라는 게 순서만으로도 읽힌다(색과 굵기로 한 번 더 갈라 준다).
  const vqs = [...vendorQuotes].sort((a, b) =>
    (a.id === srcVqId ? 0 : 1) - (b.id === srcVqId ? 0 : 1));
  return (
    <tr className="ov-grp-head">
      <td colSpan={4}>
        <span className="ov-grp-vessel">{vessel || "— no vessel —"}</span>
      </td>
      <td colSpan={3} className="ov-grp-doc q gs">
        {quoteDocs ? (
          <DocPair
            pur={
              vqs.length ? (
                vqs.map((v, i) => (
                  <Fragment key={v.id}>
                    {i ? <span className="sep">·</span> : null}
                    <span
                      className={`ov-vq${v.id === srcVqId ? " src" : ""}`}
                      title={
                        v.vendor
                          ? `${v.vendor}${v.id === srcVqId ? " — cost source for this quote" : ""}`
                          : undefined
                      }
                    >
                      <DocNoLink
                        no={v.no}
                        stage={DOC_STAGE.vendorQuote}
                        vrfqId={v.vrfqId}
                        nav={nav}
                      />
                      {/* 번호만으로는 비교가 안 된다 — 여러 곳에 물어본 이유가 값이라,
                          받은 금액이 번호 옆에 같이 서야 그 자리에서 견줘진다. */}
                      {v.amount != null ? (
                        <span className="ov-vq-amt">
                          {v.currency} {Math.round(v.amount).toLocaleString()}
                        </span>
                      ) : null}
                    </span>
                  </Fragment>
                ))
              ) : (
                <DocNoLink no={vendorQuoteNo} stage={DOC_STAGE.vendorQuote} nav={nav} />
              )
            }
            sales={<DocNoLink no={quoteDocs.sales} stage={DOC_STAGE.quote} nav={nav} />}
            hasPur={vqs.length > 0 || !!vendorQuoteNo}
          />
        ) : (
          <i className="muted">not quoted</i>
        )}
      </td>
      <td colSpan={3} className="ov-grp-doc p gs">
        {poDocs.sales ? (
          <DocPair
            pur={poDocs.pur.map((no, i) => (
              <Fragment key={no}>
                {i ? <span className="sep">·</span> : null}
                <DocNoLink no={no} stage={DOC_STAGE.vendorPo} orderId={orderId} nav={nav} />
              </Fragment>
            ))}
            sales={<DocNoLink no={poDocs.sales} stage={DOC_STAGE.customerPo} orderId={orderId} nav={nav} />}
            hasPur={poDocs.pur.length > 0}
          />
        ) : (
          <i className="muted">no P/O yet</i>
        )}
      </td>
      <td colSpan={3} className="ov-grp-doc c gs">
        {ciNo ? (
          <DocNoLink no={ciNo} stage={DOC_STAGE.ci} orderId={orderId} nav={nav} />
        ) : (
          <i className="muted">not issued</i>
        )}
      </td>
    </tr>
  );
}

/** "매입문서 → 매출문서". 매입문서가 없으면 매출문서만. */
function DocPair({ pur, sales, hasPur }: { pur: ReactNode; sales: ReactNode; hasPur: boolean }) {
  return (
    <>
      {hasPur ? (
        <>
          <span className="ov-doc-pur">{pur}</span>
          <span className="sep">→</span>
        </>
      ) : null}
      {sales}
    </>
  );
}

/** 묶음 합계 행 — 각 단계의 매입·마진·매출 총계. 마진은 총계끼리 다시 계산한다. */
function GroupTotal({
  quotePur,
  quoteSales,
  poPur,
  poSales,
  ciPur,
  ciSales,
  cur,
  rate,
}: {
  quotePur: number | null;
  quoteSales: number | null;
  poPur: number | null;
  poSales: number | null;
  ciPur: number | null;
  ciSales: number | null;
  cur: { qCostCur: string; qCur: string; vpoCur: string; oCur: string; ciCur: string };
  rate: number;
}) {
  return (
    <tr className="ov-grp-total">
      <td colSpan={4} className="ov-it-totlabel">
        Total
      </td>
      <td className="num gs">
        <Money value={quotePur} currency={cur.qCostCur} />
      </td>
      <td className="num">
        <Pct value={marginPct(quoteSales, quotePur, cur.qCur, cur.qCostCur, rate)} />
      </td>
      <td className="num ov-it-total">
        <Money value={quoteSales} currency={cur.qCur} />
      </td>
      <td className="num gs">
        <Money value={poPur} currency={cur.vpoCur} />
      </td>
      <td className="num">
        <Pct value={marginPct(poSales, poPur, cur.oCur, cur.vpoCur, rate)} />
      </td>
      <td className="num ov-it-total">
        <Money value={poSales} currency={cur.oCur} />
      </td>
      <td className="num gs">
        <Money value={ciPur} currency={cur.vpoCur} />
      </td>
      <td className="num">
        <Pct value={marginPct(ciSales, ciPur, cur.ciCur, cur.vpoCur, rate)} />
      </td>
      <td className="num ov-it-total">
        <Money value={ciSales} currency={cur.ciCur} />
      </td>
    </tr>
  );
}

/** P/O 전(4단계 이하) — 견적만 있는 프로젝트. Quote 열만 채우고 P/O·C/I 는 비운다. */
function QuoteOnlyGroup({
  quoteId,
  vendorQuotes,
  vendorQuoteNo,
  nav,
}: {
  quoteId: number;
  vendorQuotes: VqRef[];
  vendorQuoteNo: string;
  nav: DocNav;
}) {
  const { data: quote } = useCachedData(`quotation:${quoteId}`, () =>
    fetchCustomerQuotationDetail(quoteId)
  );
  if (!quote) {
    return (
      <tbody>
        <tr>
          <td colSpan={13} className="proj-ov-empty">
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
      <GroupHead
        vessel={quote.vessel}
        quoteDocs={{ sales: quote.qtn_no || "—" }}
        vendorQuotes={vendorQuotes}
        srcVqId={quote.vendor_quote_id ?? null}
        vendorQuoteNo={quote.vendor_quote_no || vendorQuoteNo}
        poDocs={{ pur: [], sales: "" }}
        ciNo=""
        nav={nav}
      />
      {/* 합계를 품목 1번행 바로 위에 둔다(OrderItemGroup 과 동일 배치). */}
      <GroupTotal
        quotePur={sumLines(quote.items.map((x) => ({
          amount: (x.cost_price ?? 0) * (x.qty || 1),
          excluded: x.excluded,
        })))}
        quoteSales={quote.amount ?? sumLines(quote.items)}
        poPur={null}
        poSales={null}
        ciPur={null}
        ciSales={null}
        cur={{ qCostCur, qCur, vpoCur: qCur, oCur: qCur, ciCur: qCur }}
        rate={rate}
      />
      {quote.items.map((it, i) => (
        <tr key={i}>
          <td className="ov-it-n">{i + 1}</td>
          <td className="ov-it-part">{it.part_no || <span className="muted">—</span>}</td>
          <td>{it.description || "—"}</td>
          <td className="ov-it-qty">
            {it.qty}
            {it.unit ? ` ${it.unit}` : ""}
          </td>
          <td className="num gs">
            <Money
              value={
                it.excluded || it.cost_price == null
                  ? null
                  : Number(it.cost_price) * Number(it.qty || 1)
              }
              currency={qCostCur}
              excluded={it.excluded}
            />
          </td>
          <td className="num">
            <Pct value={it.margin_pct ?? null} excluded={it.excluded} />
          </td>
          <td className="num ov-sal">
            <Money value={lineAmount(it)} currency={qCur} excluded={it.excluded} />
          </td>
          <td className="num gs" colSpan={6}>
            <span className="muted">—</span>
          </td>
        </tr>
      ))}
    </tbody>
  );
}

/** 견적 전 — 고객이 요청한 RFQ 품목만. 단가가 없으므로 수량까지만 보여준다. */
function RfqItemsTable({ items }: { items: RfqItem[] | null }) {
  if (items === null) return <div className="proj-ov-empty">Loading items…</div>;
  if (items.length === 0) return <div className="proj-ov-empty">No items registered.</div>;
  return (
    <div className="proj-ov-items-wrap">
      <table className="proj-ov-items proj-ov-grid">
        <colgroup>
          <col className="ovc-n ovt-r" />
          <col className="ovc-part ovt-r" />
          <col className="ovc-desc ovt-r" />
          <col className="ovc-qty ovt-r" />
          {["q", "p", "c"].map((g) => (
            <Fragment key={g}>
              <col className={`ovc-pur ovt-${g}`} />
              <col className={`ovc-mg ovt-${g}`} />
              <col className={`ovc-sales ovt-${g}`} />
            </Fragment>
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="ov-it-n ov-phase-on" rowSpan={2}>#</th>
            <th className="ov-phase-on" rowSpan={2}>Part No.</th>
            <th className="ov-phase-on" rowSpan={2}>Description</th>
            <th className="ov-it-qty ov-phase-on" rowSpan={2}>Qty</th>
            <th className="num ov-gh q gs ov-phase-todo" colSpan={3}>Quote</th>
            <th className="num ov-gh p gs ov-phase-todo" colSpan={3}>P/O</th>
            <th className="num ov-gh c gs ov-phase-todo" colSpan={3}>C/I</th>
          </tr>
          <tr>
            {["q", "p", "c"].map((g) => (
              <Fragment key={g}>
                <th className={`num ov-sub ${g} gs ov-phase-todo`}>Purchase</th>
                <th className={`num ov-sub ${g} ov-phase-todo`}>Margin</th>
                <th className={`num ov-sub ${g} ov-phase-todo`}>Sales</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i}>
              <td className="ov-it-n">{i + 1}</td>
              <td className="ov-it-part">{it.part_no || "—"}</td>
              <td>
                {it.description || "—"}
                {it.remark ? <span className="ov-rfq-remark">{it.remark}</span> : null}
              </td>
              <td className="ov-it-qty">
                {it.qty}
                {it.unit ? ` ${it.unit}` : ""}
              </td>
              {["q", "p", "c"].map((g) => (
                <td key={g} className="num gs" colSpan={3} aria-label={`${g} not available`} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
