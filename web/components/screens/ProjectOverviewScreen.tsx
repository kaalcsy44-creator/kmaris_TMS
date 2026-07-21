"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import {
  fetchPipeline,
  fetchRfqDetail,
  fetchQuotationOverview,
  fetchCustomerQuotationDetail,
  fetchPoWorkOptions,
  fetchDocumentDetail,
  addRfqStageNote,
  closeReasonLabel,
} from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";
import { sortByDocNo } from "@/lib/sort";
import {
  resolveSteps,
  buildStageChain,
  makeItemMatcher,
  ciPurchase,
  type StageChainItem,
} from "@/lib/deal";
import { buildActivities, hm, md, splitProjectNo, type Activity } from "@/lib/activity";
import type { PipelineRow, PoWorkOptions, RfqItem } from "@/lib/types";
import { vendorList } from "@/components/common/dealFields";
import { convertCurrency, USD_KRW_RATE } from "@/components/common/itemTable";
import { tr } from "@/lib/labels";
import CustomerName from "@/components/common/CustomerName";
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
  onOpenStage?: (stage: number) => void;
  /** 활동기록을 이 화면에서 추가한 뒤 부모에게 알린다(팝업/목록 갱신). */
  onActivityChanged?: () => void | Promise<unknown>;
}) {
  // 목록에서 넘어오면 이미 캐시에 있어 즉시 그려진다(같은 "pipeline" 키를 공유).
  const { data: pipeline, error: pipeErr, refresh: refreshPipeline } = useCachedData("pipeline", () => fetchPipeline());
  // 견적 전(1~3단계) 프로젝트는 고객이 요청한 RFQ 품목만 있다 — 값이 매겨지기 전 목록.
  const { data: detail } = useCachedData(`rfq:${rfqId}`, () => fetchRfqDetail(rfqId));
  // 고객 P/O·Vendor P/O·견적을 한 번에 받는다. ProjectsScreen 과 같은 캐시 키.
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
  // P/O 가 아직 없으면 견적(있으면)만으로 한 그룹을 만든다.
  const quoteOnlyId = orders.length === 0 ? (qtnList?.rows.find((q) => q.rfq_id === rfqId)?.id ?? 0) : 0;

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
      quotations={(poOpts?.quotations ?? []).filter((q) => q.rfq_id === rfqId)}
      quoteOnlyId={quoteOnlyId}
      rfqItems={detail?.items ?? null}
      // 매입측 견적 = 벤더 견적번호(프로젝트 단위). Quote 묶음 머리에 매출 견적과 나란히 둔다.
      vendorQuoteNo={row.vquote_no || ""}
      embedded={embedded}
      onOpenStage={onOpenStage}
      onActivityAdded={onActivityAdded}
    />
  );
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
type StageItem = { qty?: number; unit_price?: number | null; amount?: number | null };

/** 품목 1줄의 금액 — amount 가 있으면 그대로, 없으면 단가×수량으로 보정. */
function lineAmount(it: StageItem | undefined): number | null {
  if (!it) return null;
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
  quoteOnlyId,
  rfqItems,
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
  /** P/O 가 아직 없을 때 보여줄 견적 id. 0 이면 없음. */
  quoteOnlyId: number;
  rfqItems: RfqItem[] | null;
  vendorQuoteNo: string;
  embedded?: boolean;
  onOpenStage?: (stage: number) => void;
  /** 활동기록 추가 후 데이터 갱신 콜백. */
  onActivityAdded?: () => void | Promise<unknown>;
}) {
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
        onOpenStage={onOpenStage}
        onActivityAdded={onActivityAdded}
      />

      <ItemsSection
        stage={row.stage}
        orders={orders}
        purchaseOrders={purchaseOrders}
        quotations={quotations}
        quoteOnlyId={quoteOnlyId}
        rfqItems={rfqItems}
        vendorQuoteNo={vendorQuoteNo}
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
 *  일시를 못 읽으면 현재 단계. chain 은 no 오름차순, at 도 대체로 그에 따라 증가한다. */
function stageForNote(chain: StageChainItem[], iso: string, current: number): number {
  const t = Date.parse((iso || "").slice(0, 16));
  if (Number.isNaN(t)) return current;
  for (const c of chain) {
    if (c.skip || !c.at) continue;
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
  onOpenStage,
  onActivityAdded,
}: {
  row: PipelineRow;
  chain: StageChainItem[];
  acts: Activity[];
  /** 주면 단계 줄이 링크 대신 이 콜백을 부른다(작업 팝업 안에서 화면 전환). */
  onOpenStage?: (stage: number) => void;
  /** 활동기록 추가 후 데이터 갱신 콜백. 주면 각 단계에 "+ note" 입력이 열린다. */
  onActivityAdded?: () => void | Promise<unknown>;
}) {
  // 어느 단계에 활동기록 입력창을 열어 뒀는지(한 번에 하나). null 이면 모두 닫힘.
  const [addStage, setAddStage] = useState<number | null>(null);

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
                      {/* 단계 줄 클릭 → 그 단계의 작업 화면(편집 진입점).
                          팝업 안에서는 링크가 아니라 버튼이어야 한다: 이미 이 프로젝트를
                          열어 둔 상태라 같은 URL 로 다시 라우팅해도 딥링크가 1회 소비된 뒤라
                          아무 일도 일어나지 않는다(조용히 죽는 링크). */}
                      {onOpenStage ? (
                        <button
                          type="button"
                          className="ov-tl-stage"
                          onClick={() => onOpenStage(c.no)}
                          title={`Open stage ${c.no} in the work view`}
                        >
                          <span className="ov-tl-dot">{c.no}</span>
                          <b className="ov-tl-label">{c.label}</b>
                        </button>
                      ) : (
                        <Link
                          className="ov-tl-stage"
                          href={`/project?rfq=${row.rfq_id}&stage=${c.no}`}
                          title={`Open stage ${c.no} in Progress`}
                        >
                          <span className="ov-tl-dot">{c.no}</span>
                          <b className="ov-tl-label">{c.label}</b>
                        </Link>
                      )}
                      {/* 이 단계의 활동 — 날짜·시각을 앞 열에 두고 그 뒤에 내용을 정렬한다.
                          자동이벤트(수·발신)는 상대만(라벨은 헤더 제목), 노트는 내용 + 메타.
                          해당 없는 단계(내수 CI/PL 등)는 N/A 만 표시. */}
                      {c.skip ? (
                        <div className="ov-tl-sub">
                          <span className="ov-tl-ndate" />
                          <span className="ov-tl-val">N/A</span>
                        </div>
                      ) : rows.length ? (
                        <ul className="ov-tl-notes">
                          {rows.map((a, i) => (
                            <li key={i} className={a.kind === "note" && a.note.star ? "star" : undefined}>
                              <span className="ov-tl-ndate">{md(a.date)}{hm(actAt(a)) ? ` ${hm(actAt(a))}` : ""}</span>
                              <span className="ov-tl-ntext">
                                {a.kind === "auto" ? (
                                  a.party ? <span className="ov-tl-actmeta">{a.party}</span> : null
                                ) : (
                                  <ActivityDesc act={a} metaBlock />
                                )}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
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
    channel: v.channel || undefined,
    star: v.star,
    pic: v.pic.trim() || undefined,
  };
}

/** 개요에 활동기록 1건 추가 — 공용 ActivityNoteForm 을 그대로 쓴다. 저장 단계는 고르지
 *  않고 입력한 일시(stageForNote)로 자동 결정한다 — 화면 표시와 같은 규칙이라 어긋나지 않는다. */
function StageAddNote({
  rfqId,
  chain,
  currentStage,
  onDone,
  onCancel,
}: {
  rfqId: number;
  chain: StageChainItem[];
  currentStage: number;
  onDone: () => void | Promise<unknown>;
  onCancel: () => void;
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
  quoteOnlyId,
  rfqItems,
  vendorQuoteNo,
}: {
  stage: number;
  orders: ProjectOrder[];
  purchaseOrders: VendorPo[];
  quotations: ProjectQuote[];
  quoteOnlyId: number;
  rfqItems: RfqItem[] | null;
  vendorQuoteNo: string;
}) {
  const hasGroups = orders.length > 0 || quoteOnlyId > 0;
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
                  vendorQuoteNo={vendorQuoteNo}
                />
              ))
            ) : (
              <QuoteOnlyGroup quoteId={quoteOnlyId} vendorQuoteNo={vendorQuoteNo} />
            )}
          </table>
        </div>
      )}
    </section>
  );
}

/** 통화 + 금액 한 줄(조밀). 값이 없으면 —. 0 으로 보이면 "무료"로 오해되므로 구분한다.
 *  0 은 아직 값이 없다는 뜻이라 .zero 로 톤만 낮춘다(표기는 그대로 둔다). */
function Money({ value, currency }: { value: number | null | undefined; currency: string }) {
  if (value == null || !Number.isFinite(value)) return <span className="muted">—</span>;
  return (
    <span className={`ov-m${Math.round(value) === 0 ? " zero" : ""}`}>
      <em>{currency}</em> {Math.round(value).toLocaleString()}
    </span>
  );
}

function Pct({ value }: { value: number | null }) {
  if (value == null) return <span className="muted">—</span>;
  return <span className="ov-pct">{value}%</span>;
}

/** 한 선박(=고객 P/O) 묶음 — 그 P/O 의 품목을 기준 행으로 삼고 견적·C/I 를 순서로 맞춘다. */
function OrderItemGroup({
  order,
  vendorPos,
  quote: quoteRow,
  vendorQuoteNo,
}: {
  order: ProjectOrder;
  vendorPos: VendorPo[];
  /** 이 선박의 견적(목록 행). 없으면 견적 없이 발주된 선박. */
  quote: ProjectQuote | null;
  vendorQuoteNo: string;
}) {
  // 원가·마진은 견적 목록에 없고 상세에만 있어 따로 받는다(_item_view 가 원가를 지움).
  const qid = quoteRow?.id ?? 0;
  const { data: quote } = useCachedData(`quotation:${qid}`, () =>
    qid ? fetchCustomerQuotationDetail(qid) : Promise.resolve(null)
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
  // 품번으로 각 문서의 같은 품목을 찾는다. 아래 map 이 순서대로 돌면서 소비한다.
  const matchQuote = makeItemMatcher(quote?.items ?? []);
  const matchVpo = makeItemMatcher(vpoItems);
  const matchCi = makeItemMatcher(ci?.items ?? []);

  // 줄별 금액을 한 번에 계산해 두고, 합계는 이 값들을 더한다(화면 숫자와 합계가 늘 일치).
  const lines = rows.map((it, i) => {
    const qIt = matchQuote(it, i);
    const vIt = matchVpo(it, i);
    const cIt = matchCi(it, i);
    return {
      it,
      qIt,
      qPur: qIt?.cost_price == null ? null : Number(qIt.cost_price) * Number(qIt.qty || 1),
      qSales: lineAmount(qIt),
      pPur: lineAmount(vIt),
      pSales: lineAmount(it),
      cPur: ciPurchase(vIt, cIt),
      cSales: lineAmount(cIt),
    };
  });

  return (
    <tbody className="ov-grp">
      <GroupHead
        vessel={order.vessel}
        quoteDocs={quote ? { pur: vendorQuoteNo, sales: quote.qtn_no || "—" } : null}
        poDocs={{ pur: vpoNos, sales: order.po_no || "—" }}
        ciNo={ci?.ci_no || ""}
      />
      {/* 합계를 품목 1번행 바로 위에 둔다 — 표를 끝까지 훑지 않고도 단계별 총액을 먼저 본다. */}
      <GroupTotal
        quotePur={total(lines.map((l) => l.qPur))}
        quoteSales={total(lines.map((l) => l.qSales))}
        poPur={total(lines.map((l) => l.pPur))}
        poSales={total(lines.map((l) => l.pSales))}
        ciPur={total(lines.map((l) => l.cPur))}
        ciSales={total(lines.map((l) => l.cSales))}
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
            <Money value={ln.qPur} currency={qCostCur} />
          </td>
          <td className="num">
            <Pct value={ln.qIt?.margin_pct ?? null} />
          </td>
          <td className="num ov-sal">
            <Money value={ln.qSales} currency={qCur} />
          </td>
          <td className="num gs">
            <Money value={ln.pPur} currency={vpoCur} />
          </td>
          <td className="num">
            <Pct value={marginPct(ln.pSales, ln.pPur, oCur, vpoCur, rate)} />
          </td>
          <td className="num ov-sal">
            <Money value={ln.pSales} currency={oCur} />
          </td>
          <td className="num gs">
            <Money value={ln.cPur} currency={vpoCur} />
          </td>
          <td className="num">
            <Pct value={marginPct(ln.cSales, ln.cPur, ciCur, vpoCur, rate)} />
          </td>
          <td className="num ov-sal">
            <Money value={ln.cSales} currency={ciCur} />
          </td>
        </tr>
      ))}
    </tbody>
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
  poDocs,
  ciNo,
}: {
  vessel: string;
  quoteDocs: { pur: string; sales: string } | null;
  poDocs: { pur: string; sales: string };
  ciNo: string;
}) {
  return (
    <tr className="ov-grp-head">
      <td colSpan={4}>
        <span className="ov-grp-vessel">{vessel || "— no vessel —"}</span>
      </td>
      <td colSpan={3} className="ov-grp-doc q gs">
        {quoteDocs ? <DocPair pur={quoteDocs.pur} sales={quoteDocs.sales} /> : <i className="muted">not quoted</i>}
      </td>
      <td colSpan={3} className="ov-grp-doc p gs">
        {poDocs.sales ? (
          <DocPair pur={poDocs.pur} sales={poDocs.sales} />
        ) : (
          <i className="muted">no P/O yet</i>
        )}
      </td>
      <td colSpan={3} className="ov-grp-doc c gs">
        {ciNo || <i className="muted">not issued</i>}
      </td>
    </tr>
  );
}

/** "매입문서 → 매출문서". 매입문서가 없으면 매출문서만. */
function DocPair({ pur, sales }: { pur: string; sales: string }) {
  return (
    <>
      {pur ? (
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
function QuoteOnlyGroup({ quoteId, vendorQuoteNo }: { quoteId: number; vendorQuoteNo: string }) {
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
        quoteDocs={{ pur: vendorQuoteNo, sales: quote.qtn_no || "—" }}
        poDocs={{ pur: "", sales: "" }}
        ciNo=""
      />
      {/* 합계를 품목 1번행 바로 위에 둔다(OrderItemGroup 과 동일 배치). */}
      <GroupTotal
        quotePur={sumLines(quote.items.map((x) => ({ amount: (x.cost_price ?? 0) * (x.qty || 1) })))}
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
              value={it.cost_price == null ? null : Number(it.cost_price) * Number(it.qty || 1)}
              currency={qCostCur}
            />
          </td>
          <td className="num">
            <Pct value={it.margin_pct ?? null} />
          </td>
          <td className="num ov-sal">
            <Money value={lineAmount(it)} currency={qCur} />
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
