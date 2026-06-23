"use client";

import { useState } from "react";
import Link from "next/link";
import { fetchDashboard, fetchPipeline, deleteRfq } from "@/lib/api";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import type { PipelineRow } from "@/lib/types";

/** "YYYY-MM-DDTHH:MM" → "yy-mm-dd HH:MM" (표시용). 빈값이면 "". */
function fmtStageDate(iso: string): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return iso;
  const [, y, mo, d, h, mi] = m;
  return `${y.slice(2)}-${mo}-${d} ${h}:${mi}`;
}

function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="hstepper">
      {steps.map((label, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        return (
          <div className={`hstep ${state}`} key={i}>
            <span className="dot">{i < current ? "✓" : i + 1}</span>
            <span className="lbl">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

/** 탭(대제목) 아래 한 단계 낮은 섹션 소제목 (작은 회색 라벨). */
function SubHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="dash-subhead">
      <span className="t">{title}</span>
      {sub ? <span className="s">{sub}</span> : null}
    </div>
  );
}

type Tab = "customer" | "internal";

export default function ProgressScreen() {
  const [tab, setTab] = useState<Tab>("internal");
  // 고객확인용 = dashboard snapshot, 내부확인용 = 통합 파이프라인.
  const { data, error } = useCachedData("dashboard", fetchDashboard);
  const {
    data: pipeline,
    error: pipeError,
    refresh: refreshPipeline,
  } = useCachedData("pipeline", () => fetchPipeline());

  // 삭제 등 변경 후: 파이프라인 목록 새로고침 + 대시보드 캐시 무효화
  function reloadPipeline() {
    invalidateCache("dashboard");
    return refreshPipeline();
  }

  return (
    <>
      <div className="page-tabs">
        <button
          className={tab === "internal" ? "on" : ""}
          onClick={() => setTab("internal")}
        >
          진행 현황 (내부확인용)
        </button>
        <button
          className={tab === "customer" ? "on" : ""}
          onClick={() => setTab("customer")}
        >
          진행 현황 (고객확인용)
        </button>
      </div>

      {tab === "customer" && (
        <>
          {/* 고객 트래킹용 현황 — 고객에게 노출되는 RFQ/Order 추적 단계 */}
          <SubHead
            title="RFQ · Order 진행 현황"
            sub="고객 추적 단계 (k-maris.com/track 미리보기)"
          />
          {error && !data ? (
            <div className="state error">API 오류: {error.message}</div>
          ) : !data ? (
            <div className="state">불러오는 중…</div>
          ) : data.snapshot.length === 0 ? (
            <div className="state">등록된 RFQ가 없습니다.</div>
          ) : (
            data.snapshot.map((r) => (
              <div className="track-row" key={`t-${r.rfq_no}`}>
                <div className="track-card">
                  <div className="track-card-head">
                    <span className="track-card-title">
                      {r.rfq_no}
                      {r.customer_rfq_no ? (
                        <small> · Customer RFQ {r.customer_rfq_no}</small>
                      ) : null}
                    </span>
                    <span className="track-card-badge">{r.status}</span>
                  </div>
                  <div className="track-card-sub">{r.customer_vessel}</div>
                  <div className="track-card-meta">
                    Items {r.item_count} · Level {r.follow_up_level} · {r.date}
                  </div>
                  <Stepper steps={data.rfq_steps} current={r.step} />
                </div>

                {r.order ? (
                  <div className="track-card">
                    <div className="track-card-head">
                      <span className="track-card-title">{r.order.ord_no}</span>
                      <span className="track-card-badge">{r.order.status}</span>
                    </div>
                    <div className="track-card-sub">{r.order.customer_vessel}</div>
                    <div className="track-card-meta">
                      Items {r.order.item_count} · {r.order.date}
                    </div>
                    <Stepper steps={data.order_steps} current={r.order.step} />
                  </div>
                ) : (
                  <div className="track-card empty">
                    <div className="track-card-head">
                      <span className="track-card-title">No linked order</span>
                    </div>
                    <div className="track-card-sub">
                      아직 오더가 생성되지 않았습니다.
                    </div>
                    <Stepper steps={data.order_steps} current={-1} />
                  </div>
                )}
              </div>
            ))
          )}
        </>
      )}

      {tab === "internal" && (
        <>
          {/* 통합 파이프라인 — RFQ표·PO표를 흡수한 단일 목록. 행 클릭 시 상세 토글 */}
          <SubHead
            title="통합 진행 현황 (12단계)"
            sub="RFQ · 견적 · P/O 전 구간 · 회사 내부 확인용"
          />
          {pipeError && !pipeline ? (
            <div className="state error">API 오류: {pipeError.message}</div>
          ) : !pipeline ? (
            <div className="state">불러오는 중…</div>
          ) : pipeline.rows.length === 0 ? (
            <div className="state">등록된 거래가 없습니다.</div>
          ) : (
            pipeline.rows.map((r) => (
              <PipelineCard
                key={`p-${r.rfq_id}`}
                r={r}
                steps={pipeline.steps}
                onChanged={reloadPipeline}
              />
            ))
          )}
        </>
      )}
    </>
  );
}

/** ` · ` 로 빈값을 건너뛰며 이어붙인다. */
function joinDot(...parts: (string | undefined)[]): string {
  return parts.filter((p) => p && p.trim()).join(" · ");
}

/** 통합 파이프라인 카드 — RFQ표·PO표를 흡수한 단일 행. 클릭하면 전 구간 문서 체인이 펼쳐진다.
 *  접힘: RFQ No. · 선박명 · 프로젝트 제목 + 12단계 진행바
 *  펼침: 핵심 메타 + 6구간 문서 체인 + 12단계 완료 일시 + RFQ/P·O 작업 바로가기 */
function PipelineCard({
  r,
  steps,
  onChanged,
}: {
  r: PipelineRow;
  steps: string[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const stageLabel = steps[r.stage - 1] ?? "";

  async function handleDelete() {
    const ok = window.confirm(
      `${r.kmaris_rfq_no} 거래를 삭제할까요?\n연결된 Vendor RFQ/견적도 함께 삭제됩니다.\n(이미 Customer 견적·오더로 진행된 건은 삭제할 수 없습니다.)`
    );
    if (!ok) return;
    setDeleting(true);
    try {
      await deleteRfq(r.rfq_id);
      onChanged();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "삭제 실패");
    } finally {
      setDeleting(false);
    }
  }

  /** 단계의 표시 일시(읽기 전용): 수동 저장값 우선, 없으면 자동 동기화값, 둘 다 없으면 빈칸. */
  function effective(stage: number): string {
    return r.stage_dates?.[String(stage)] ?? r.stage_auto?.[String(stage)] ?? "";
  }

  // 12단계 체인: 1~6은 문서번호·금액, 7~12는 문서 없이 완료 일시만. 일시는 effective() 통일.
  const docValue: Record<number, string> = {
    1: r.customer_rfq_no,
    2: r.vrfq_vendors,
    3: joinDot(r.vquote_no, r.vendor_amount),
    4: joinDot(r.cquote_no, r.customer_amount),
    5: joinDot(r.customer_po_no, r.ord_no),
    6: joinDot(r.vendor_po_no, r.vendor),
  };
  const chain = steps.map((label, i) => ({
    no: i + 1,
    label,
    value: docValue[i + 1] ?? "",
    at: effective(i + 1),
  }));
  const leftChain = chain.slice(0, 6);
  const rightChain = chain.slice(6, 12);

  const poHref = r.order_id > 0 ? `/po?order=${r.order_id}` : `/po?rfq=${r.rfq_id}`;

  return (
    <div className={`intl-card${open ? " open" : ""}`}>
      <button
        type="button"
        className="intl-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`intl-caret${open ? " on" : ""}`}>▸</span>
        <span className="intl-title">
          <b>{r.kmaris_rfq_no}</b>
          <span className="intl-vessel">{r.vessel || "선박 미지정"}</span>
          {r.project_title ? (
            <span className="intl-proj">{r.project_title}</span>
          ) : (
            <span className="intl-proj muted">제목 없음</span>
          )}
        </span>
        <span className="intl-stage">
          {r.stage}/12 {stageLabel}
        </span>
      </button>

      <div className="intl-bar">
        {Array.from({ length: 12 }).map((_, k) => (
          <span key={k} className={`seg${k < r.stage ? " on" : ""}`} />
        ))}
      </div>

      {open ? (
        <div className="intl-detail">
          <dl className="intl-meta">
            <div>
              <dt>고객사</dt>
              <dd>{r.customer || "—"}</dd>
            </div>
            <div>
              <dt>선박명</dt>
              <dd>{r.vessel || "—"}</dd>
            </div>
            <div>
              <dt>프로젝트 제목</dt>
              <dd>{r.project_title || "—"}</dd>
            </div>
            <div>
              <dt>품목 수</dt>
              <dd>{r.item_count}</dd>
            </div>
            <div>
              <dt>현재 단계</dt>
              <dd>
                {r.stage}/12 {stageLabel}
              </dd>
            </div>
          </dl>

          {/* 12단계 체인 — 1~6 / 7~12 두 열. 일시는 자동 동기화(읽기전용) */}
          <div className="pl-chain">
            {[leftChain, rightChain].map((col, ci) => (
              <div className="pl-col" key={ci}>
                {col.map((c) => {
                  const state =
                    c.no < r.stage ? "done" : c.no === r.stage ? "current" : "todo";
                  return (
                    <div className={`pl-row ${state}`} key={c.no}>
                      <span className="pl-no">{c.no}</span>
                      <div className="pl-main">
                        <div className="pl-top">
                          <span className="pl-label">{c.label}</span>
                          <span className="pl-at">{c.at ? fmtStageDate(c.at) : ""}</span>
                        </div>
                        {c.value ? <div className="pl-value">{c.value}</div> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="pl-actions">
            <Link className="btn" href={`/rfq?rfq=${r.rfq_id}`}>
              RFQ · 견적 작업 →
            </Link>
            <Link className="btn" href={poHref}>
              P/O 작업 →
            </Link>
            {r.order_id > 0 ? (
              <Link className="btn" href={`/documents?order=${r.order_id}`}>
                문서 작업 (CI·PL·SA·Tax) →
              </Link>
            ) : (
              <span className="btn disabled" title="오더 생성 후 가능">
                문서 작업 (오더 필요)
              </span>
            )}
            <button
              className="btn danger"
              onClick={handleDelete}
              disabled={deleting}
              style={{ marginLeft: "auto" }}
            >
              {deleting ? "삭제 중…" : "삭제"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
