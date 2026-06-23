"use client";

import { useState } from "react";
import Link from "next/link";
import {
  fetchDashboard,
  fetchPipeline,
  deleteRfq,
  updateRfq,
  fetchCustomers,
  fetchSettingsVessels,
  addRfqStageNote,
  updateRfqStageNote,
  deleteRfqStageNote,
} from "@/lib/api";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import type { PipelineRow, CustomerOption, SettingsVessel, StageNote } from "@/lib/types";
import WorkTypeBadge from "@/components/WorkTypeBadge";

const WORK_TYPES = ["부품공급", "서비스"];

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
type WorkFilter = "전체" | "부품공급" | "서비스";
const WORK_FILTERS: WorkFilter[] = ["전체", "부품공급", "서비스"];

export default function ProgressScreen() {
  const [tab, setTab] = useState<Tab>("internal");
  const [workFilter, setWorkFilter] = useState<WorkFilter>("전체");
  // 고객확인용 = dashboard snapshot, 내부확인용 = 통합 파이프라인.
  const { data, error } = useCachedData("dashboard", fetchDashboard);
  const {
    data: pipeline,
    error: pipeError,
    refresh: refreshPipeline,
  } = useCachedData("pipeline", () => fetchPipeline());
  // 편집 셀렉터용 고객사·선박 목록(카드 공통). 미리 로드해 두면 수정 진입 즉시 기존 값이 보인다.
  const { data: customers } = useCachedData("settings:customers", fetchCustomers);
  const { data: vessels } = useCachedData("settings:vessels", fetchSettingsVessels);

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
          <div className="seg-tabs" style={{ marginBottom: 14 }}>
            {WORK_FILTERS.map((f) => (
              <button
                key={f}
                className={workFilter === f ? "on" : ""}
                onClick={() => setWorkFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
          {pipeError && !pipeline ? (
            <div className="state error">API 오류: {pipeError.message}</div>
          ) : !pipeline ? (
            <div className="state">불러오는 중…</div>
          ) : (() => {
            const rows = pipeline.rows.filter(
              (r) => workFilter === "전체" || (r.work_type || "부품공급") === workFilter
            );
            if (rows.length === 0) {
              return <div className="state">해당하는 거래가 없습니다.</div>;
            }
            return rows.map((r) => (
              <PipelineCard
                key={`p-${r.rfq_id}`}
                r={r}
                steps={pipeline.steps}
                customers={customers ?? []}
                vessels={vessels ?? []}
                onChanged={reloadPipeline}
              />
            ));
          })()}
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
  customers,
  vessels,
  onChanged,
}: {
  r: PipelineRow;
  steps: string[];
  customers: CustomerOption[];
  vessels: SettingsVessel[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  // 편집 필드(편집 진입 시 r 값으로 seed)
  const [fWorkType, setFWorkType] = useState(r.work_type || "부품공급");
  const [fCustomerId, setFCustomerId] = useState<number | "">(r.customer_id || "");
  const [fVesselId, setFVesselId] = useState<number | "">(r.vessel_id || "");
  const [fCustRfqNo, setFCustRfqNo] = useState(r.customer_rfq_no || "");
  const [fProjectTitle, setFProjectTitle] = useState(r.project_title || "");
  const [fReceivedAt, setFReceivedAt] = useState(r.received_at || "");
  const stageLabel = steps[r.stage - 1] ?? "";

  function startEdit() {
    // 현재 저장값으로 seed 후 편집 모드 진입(목록은 상위에서 미리 로드됨)
    setFWorkType(r.work_type || "부품공급");
    setFCustomerId(r.customer_id || "");
    setFVesselId(r.vessel_id || "");
    setFCustRfqNo(r.customer_rfq_no || "");
    setFProjectTitle(r.project_title || "");
    setFReceivedAt(r.received_at || "");
    setEditing(true);
    setOpen(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await updateRfq(r.rfq_id, {
        customer_id: fCustomerId === "" ? undefined : fCustomerId,
        vessel_id: fVesselId === "" ? 0 : fVesselId, // 0 = 선박 미지정 해제
        customer_rfq_no: fCustRfqNo,
        project_title: fProjectTitle,
        work_type: fWorkType,
        received_at: fReceivedAt || undefined,
      });
      setEditing(false);
      onChanged();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "수정 실패");
    } finally {
      setSaving(false);
    }
  }

  // 선택한 고객 소유 선박만(소유 정보 없는 선박은 항상 노출)
  const vesselOptions = vessels.filter(
    (v) => fCustomerId === "" || !v.customer_id || v.customer_id === fCustomerId
  );

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

  const isService = (r.work_type || "부품공급") === "서비스";

  return (
    <div className={`intl-card${open ? " open" : ""}${isService ? " service" : ""}`}>
      <button
        type="button"
        className="intl-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`intl-caret${open ? " on" : ""}`}>▸</span>
        <span className="intl-title">
          <b>{r.kmaris_rfq_no}</b>
          <WorkTypeBadge type={r.work_type} />
          <span className="intl-customer">{r.customer || "고객사 미지정"}</span>
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
          {editing ? (
            <div className="intl-edit">
              <div className="form-field">
                <label>업무 타입</label>
                <div className="seg-tabs">
                  {WORK_TYPES.map((t) => (
                    <button
                      key={t}
                      type="button"
                      className={fWorkType === t ? "on" : ""}
                      onClick={() => setFWorkType(t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div className="form-grid">
                <div className="form-field">
                  <label>고객사</label>
                  <select
                    value={fCustomerId}
                    onChange={(e) => {
                      setFCustomerId(e.target.value === "" ? "" : Number(e.target.value));
                      setFVesselId("");
                    }}
                  >
                    <option value="">선택…</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <label>선박명</label>
                  <select
                    value={fVesselId}
                    onChange={(e) =>
                      setFVesselId(e.target.value === "" ? "" : Number(e.target.value))
                    }
                  >
                    <option value="">— 선박 미지정 —</option>
                    {vesselOptions.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <label>고객 RFQ No.</label>
                  <input
                    value={fCustRfqNo}
                    onChange={(e) => setFCustRfqNo(e.target.value)}
                    placeholder="고객사 고유 번호(선택)"
                  />
                </div>
                <div className="form-field">
                  <label>프로젝트 제목</label>
                  <input
                    value={fProjectTitle}
                    onChange={(e) => setFProjectTitle(e.target.value)}
                    placeholder="내부 식별용 제목(선택)"
                  />
                </div>
                <div className="form-field">
                  <label>RFQ 수신 일시</label>
                  <input
                    type="datetime-local"
                    value={fReceivedAt}
                    onChange={(e) => setFReceivedAt(e.target.value)}
                  />
                </div>
              </div>
            </div>
          ) : (
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
          )}

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
                        <StageNotes
                          rfqId={r.rfq_id}
                          stage={c.no}
                          notes={r.stage_notes?.[String(c.no)] ?? []}
                          onChanged={onChanged}
                        />
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
            <Link
              className="btn"
              href={r.order_id > 0 ? `/documents?order=${r.order_id}` : "/documents"}
              title={r.order_id > 0 ? undefined : "오더 미생성 — 문서 페이지에서 대상 오더를 선택하세요"}
            >
              문서 작업 (CI·PL·SA·Tax) →
            </Link>
            <Link
              className="btn"
              href={r.order_id > 0 ? `/ar?order=${r.order_id}` : "/ar"}
            >
              AR 작업 →
            </Link>
            {editing ? (
              <>
                <button
                  className="btn primary"
                  onClick={handleSave}
                  disabled={saving}
                  style={{ marginLeft: "auto" }}
                >
                  {saving ? "저장 중…" : "저장"}
                </button>
                <button
                  className="btn"
                  onClick={() => setEditing(false)}
                  disabled={saving}
                >
                  취소
                </button>
              </>
            ) : (
              <button
                className="btn"
                onClick={startEdit}
                style={{ marginLeft: "auto" }}
              >
                ✎ 수정
              </button>
            )}
            <button
              className="btn danger"
              onClick={handleDelete}
              disabled={deleting || editing}
            >
              {deleting ? "삭제 중…" : "삭제"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const NOTE_PARTIES = ["Customer", "Vendor", "내부", "기타"];
const NOTE_CHANNELS = ["이메일", "통화", "문자", "메신저", "방문", "기타"];

/** datetime-local 기본값(현재 시각, 분 단위) "YYYY-MM-DDTHH:MM". */
function nowLocalInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/** 활동 기록 구조화 입력 폼 — 신규/수정 공용. initial 이 있으면 그 값으로 채운다. */
function NoteForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: StageNote | null;
  submitLabel: string;
  onSubmit: (p: { text: string; datetime: string; party: string; channel: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [dt, setDt] = useState(initial?.datetime || initial?.at || nowLocalInput());
  const [party, setParty] = useState(initial?.party || "Customer");
  const [channel, setChannel] = useState(initial?.channel || "이메일");
  const [text, setText] = useState(initial?.text || "");
  const [busy, setBusy] = useState(false);

  async function go() {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    try {
      await onSubmit({ text: t, datetime: dt, party, channel });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pl-note-form">
      <div className="pl-note-fields">
        <input
          type="datetime-local"
          value={dt}
          onChange={(e) => setDt(e.target.value)}
          title="활동 일시"
        />
        <select value={party} onChange={(e) => setParty(e.target.value)} title="소통 상대">
          {NOTE_PARTIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select value={channel} onChange={(e) => setChannel(e.target.value)} title="소통 수단">
          {NOTE_CHANNELS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div className="pl-note-add">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") go();
            if (e.key === "Escape") onCancel();
          }}
          placeholder="활동 내용 입력 후 Enter"
          autoFocus
        />
        <button className="pl-note-btn primary" onClick={go} disabled={busy || !text.trim()}>
          {submitLabel}
        </button>
        <button className="pl-note-btn" onClick={onCancel}>
          취소
        </button>
      </div>
    </div>
  );
}

/** 단계별 코멘트/활동이력 — 일시·상대·수단·내용 구조화 입력 + 기록 표시/수정/삭제. */
function StageNotes({
  rfqId,
  stage,
  notes,
  onChanged,
}: {
  rfqId: number;
  stage: number;
  notes: StageNote[];
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);

  async function submitAdd(p: { text: string; datetime: string; party: string; channel: string }) {
    try {
      await addRfqStageNote(rfqId, stage, p);
      setAdding(false);
      onChanged();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "활동 추가 실패");
    }
  }

  async function submitEdit(
    index: number,
    p: { text: string; datetime: string; party: string; channel: string }
  ) {
    try {
      await updateRfqStageNote(rfqId, stage, index, p);
      setEditIndex(null);
      onChanged();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "수정 실패");
    }
  }

  async function remove(index: number) {
    if (!window.confirm("이 활동 기록을 삭제할까요?")) return;
    try {
      await deleteRfqStageNote(rfqId, stage, index);
      onChanged();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "삭제 실패");
    }
  }

  return (
    <div className="pl-notes">
      {notes.map((n, i) =>
        editIndex === i ? (
          <NoteForm
            key={i}
            initial={n}
            submitLabel="저장"
            onSubmit={(p) => submitEdit(i, p)}
            onCancel={() => setEditIndex(null)}
          />
        ) : (
          <div className="pl-note" key={i}>
            <span className="pl-note-at">{fmtStageDate(n.datetime || n.at)}</span>
            {n.party ? <span className="pl-note-tag party">{n.party}</span> : null}
            {n.channel ? <span className="pl-note-tag channel">{n.channel}</span> : null}
            <span className="pl-note-text">{n.text}</span>
            <button
              className="pl-note-edit"
              title="수정"
              onClick={() => {
                setAdding(false);
                setEditIndex(i);
              }}
            >
              ✎
            </button>
            <button className="pl-note-del" title="삭제" onClick={() => remove(i)}>
              ×
            </button>
          </div>
        )
      )}
      {adding ? (
        <NoteForm
          initial={null}
          submitLabel="추가"
          onSubmit={submitAdd}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button
          className="pl-note-toggle"
          onClick={() => {
            setEditIndex(null);
            setAdding(true);
          }}
        >
          + 활동 기록
        </button>
      )}
    </div>
  );
}
