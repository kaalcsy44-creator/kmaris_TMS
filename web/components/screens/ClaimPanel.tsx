"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  createClaim,
  createCreditNote,
  deleteClaim,
  deleteCreditNote,
  fetchArCandidates,
  fetchClaims,
  fetchCreditNotePdf,
  fetchCreditNoteXlsx,
  fetchFxRate,
  fetchPoWorkOptions,
  updateClaim,
  updateCreditNote,
} from "@/lib/api";
import { can, canEditDeal, editBlockReason } from "@/lib/auth";
import { invalidateCache, useCachedData } from "@/lib/useCachedData";
import type { ArCandidate, ClaimCost, ClaimRow, CreditNoteItem, CreditNoteRow } from "@/lib/types";
import { useEditGate } from "@/lib/viewMode";
import RecordStrip from "@/components/common/RecordStrip";

// 납품 후 클레임 · 크레딧 노트 — 11단계(수금 완료) 워크스페이스의 세 번째 탭.
//
// 왜 여기인가: 상계할 청구서와 고객·P/O 가 이미 이 화면의 맥락에 있다. 클레임을 파이프라인
// 단계로 두지 않는 이유는 backend Claim 모델 주석 참고(예외 사건이라 단계로 두면 클레임이
// 없는 딜이 영영 미완료로 남는다).
//
// 화면이 지켜야 할 것 하나: 비용 라인은 '누가 부담했나(bearer)'와 '어떻게 정산했나
// (settlement)'를 반드시 함께 고르게 한다. 고객이 자기 돈으로 처리한 공임을 당사 부담으로
// 적으면 우리 손익이 이유 없이 깎이고, 상계한 부품비를 비용으로도 적으면 두 번 잡힌다.

const today = () => new Date().toISOString().slice(0, 10);

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const money = (v: number, cur = "") =>
  `${cur ? `${cur} ` : ""}${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

const KINDS: { v: string; label: string }[] = [
  { v: "labor", label: "Labor" },
  { v: "parts", label: "Parts" },
  { v: "freight", label: "Freight" },
  { v: "inspection", label: "Inspection" },
  { v: "other", label: "Other" },
];
const BEARERS: { v: string; label: string }[] = [
  { v: "us", label: "K-Maris (us)" },
  { v: "customer", label: "Customer" },
  { v: "vendor", label: "Vendor" },
  { v: "shared", label: "Shared" },
];
const SETTLEMENTS: { v: string; label: string }[] = [
  { v: "credit_note", label: "Offset · credit note" },
  { v: "cash", label: "Paid in cash" },
  { v: "vendor_ap", label: "Charged to vendor" },
  { v: "none", label: "Borne by them (no settlement)" },
];
const STATUSES: { v: string; label: string }[] = [
  { v: "open", label: "Open" },
  { v: "settled", label: "Settled" },
  { v: "closed", label: "Closed" },
];

const emptyCost: ClaimCost = {
  kind: "parts",
  description: "",
  amount: 0,
  currency: "USD",
  bearer: "us",
  settlement: "credit_note",
};

type ClaimForm = {
  claim_no: string;
  occurred_date: string;
  reported_date: string;
  site: string;
  title: string;
  description: string;
  status: string;
  costs: ClaimCost[];
};

const emptyForm = (): ClaimForm => ({
  claim_no: "",
  occurred_date: today(),
  reported_date: today(),
  site: "",
  title: "",
  description: "",
  status: "open",
  costs: [{ ...emptyCost }],
});

const rowToForm = (r: ClaimRow): ClaimForm => ({
  claim_no: r.claim_no || "",
  occurred_date: r.occurred_date || today(),
  reported_date: r.reported_date || "",
  site: r.site || "",
  title: r.title || "",
  description: r.description || "",
  status: r.status || "open",
  costs: (r.costs || []).map((c) => ({ ...emptyCost, ...c })),
});

export const claimsKey = (orderId: number) => `claims:order:${orderId}`;

/** 이 P/O 가 속한 프로젝트의 선박 목록 — 클레임이 난 배를 고르는 자리.
 *  현장 이름을 손으로 적으면 같은 배가 표기마다 달라져(ON PHOENIX / on phoenix / Phoenix)
 *  나중에 그 배의 클레임만 모아 볼 수가 없다. 이 P/O 의 배가 맨 앞에 선다. */
function useOrderVessels(orderId: number): string[] {
  const { data } = useCachedData("po:work-options", fetchPoWorkOptions);
  return useMemo(() => {
    const orders = data?.orders ?? [];
    const mine = orders.find((o) => o.id === orderId);
    const names = [mine?.vessel || "", ...orders
      .filter((o) => mine && o.rfq_id === mine.rfq_id)
      .map((o) => o.vessel || "")];
    return Array.from(new Set(names.map((v) => v.trim()).filter(Boolean)));
  }, [data, orderId]);
}

export default function ClaimPanel({
  orderId,
  assigneeId = 0,
  onChanged,
}: {
  orderId: number;
  /** 이 딜의 담당자(PIC) — 편집 권한 판정용(다른 화면과 같은 규칙). */
  assigneeId?: number;
  onChanged?: () => void;
}) {
  const { data, refresh } = useCachedData(claimsKey(orderId), () => fetchClaims({ orderId }));
  const vessels = useOrderVessels(orderId);
  const rows = useMemo(() => data?.rows ?? [], [data]);
  // null = 목록에서 아무것도 안 고름(신규 입력 중), 숫자 = 그 클레임 편집.
  const [selId, setSelId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!rows.length) return;
    setSelId((cur) => (cur != null && rows.some((r) => r.id === cur) ? cur : rows[0].id));
  }, [rows]);

  function reload() {
    // 상계는 미수 잔액을 바꾼다 — AR 화면과 재무 집계가 옛 값을 들고 있으면 안 된다.
    invalidateCache("ar:overview");
    invalidateCache("finance:");
    invalidateCache("dashboard");
    // 같은 클레임을 프로젝트 단위로도 읽는 곳이 있다(개요의 Claims 섹션) — 접두어로 함께 비운다.
    invalidateCache("claims:");
    onChanged?.();
    return refresh();
  }

  if (!data) return <div className="state">Loading claims…</div>;

  const selected = adding ? null : rows.find((r) => r.id === selId) ?? null;

  return (
    <div className="claim-panel">
      {/* 고정행(.pane-row)으로 두지 않는다 — 이 화면에는 이미 P/O 번호 행과 탭 행이
          위에 붙어 있어, 한 줄을 더 고정하면 탭이 그만큼 밀리며 그 자리에 빈 띠가 남는다. */}
      <div className="embedded-record-bar claim-bar">
        <span className="wp-po-picker-label">Claims</span>
        {rows.length ? (
          <RecordStrip ariaLabel="Claims" activeKey={adding ? -1 : selId ?? 0}>
            {rows.map((r) => (
              <button
                key={r.id}
                type="button"
                className={!adding && r.id === selId ? "on" : ""}
                onClick={() => {
                  setAdding(false);
                  setSelId(r.id);
                }}
              >
                {r.occurred_date || "—"} · {r.title || r.claim_no || `Claim ${r.id}`}
                {r.credit_notes.length ? ` · CN ${r.credit_notes.length}` : ""}
              </button>
            ))}
          </RecordStrip>
        ) : (
          <span className="hint-inline">
            No claim on this P/O — register one when the site reports a defect after delivery.
          </span>
        )}
        <button
          type="button"
          className="btn sm"
          style={{ marginLeft: "auto" }}
          onClick={() => setAdding(true)}
          disabled={adding}
        >
          + New claim
        </button>
      </div>

      <ClaimForm
        key={selected ? `c${selected.id}` : `new-${orderId}`}
        orderId={orderId}
        assigneeId={assigneeId}
        vessels={vessels}
        existing={selected}
        onSaved={(id) => {
          setAdding(false);
          if (id) setSelId(id);
          return reload();
        }}
        onCancelNew={rows.length ? () => setAdding(false) : undefined}
      />
    </div>
  );
}

/** 클레임 한 건의 입력·편집 + 그 클레임의 크레딧 노트. existing 이 없으면 신규 등록. */
function ClaimForm({
  orderId,
  assigneeId,
  vessels,
  existing,
  onSaved,
  onCancelNew,
}: {
  orderId: number;
  assigneeId: number;
  /** 이 프로젝트의 P/O 선박 — 고를 수 있게 목록으로 준다(첫 값이 이 P/O 의 배). */
  vessels: string[];
  existing: ClaimRow | null;
  onSaved: (id?: number) => void | Promise<unknown>;
  onCancelNew?: () => void;
}) {
  const canEdit = (can("ar", "edit") || can("ar", "create")) && canEditDeal(assigneeId);
  const { editing: canWriteNow, readMode, fieldsetProps } = useEditGate(canEdit);
  const [form, setForm] = useState<ClaimForm>(() =>
    existing ? rowToForm(existing) : { ...emptyForm(), site: vessels[0] || "" });
  // 목록에 없는 곳(부두·야드 등)은 직접 적는다 — 저장된 값이 목록 밖이면 그 상태로 연다.
  const [vesselMode, setVesselMode] = useState<"pick" | "manual">(() => {
    const cur = existing ? existing.site || "" : vessels[0] || "";
    return !cur || vessels.includes(cur) ? "pick" : "manual";
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof ClaimForm>(k: K, v: ClaimForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  // 선박 목록은 늦게 도착할 수 있다(P/O 옵션 조회) — 신규 입력에서 아직 비어 있으면
  // 그때 이 P/O 의 배로 채운다. 사람이 이미 고른 값은 건드리지 않는다.
  useEffect(() => {
    if (existing || !vessels.length) return;
    setForm((f) => (f.site ? f : { ...f, site: vessels[0] }));
  }, [existing, vessels]);

  const setCost = (i: number, patch: Partial<ClaimCost>) =>
    setForm((f) => ({ ...f, costs: f.costs.map((c, n) => (n === i ? { ...c, ...patch } : c)) }));

  // 통화별 합계 — 부담 주체로 나눠 센다. 고객이 자기 돈으로 처리한 몫은 우리 비용이 아니다.
  const totals = useMemo(() => {
    const by: Record<string, { us: number; other: number; all: number }> = {};
    for (const c of form.costs) {
      const cur = (c.currency || "USD").toUpperCase();
      const t = (by[cur] = by[cur] || { us: 0, other: 0, all: 0 });
      const amt = num(c.amount);
      t.all += amt;
      if (c.bearer === "us") t.us += amt;
      else t.other += amt;
    }
    return by;
  }, [form.costs]);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const body = {
        order_id: orderId,
        claim_no: form.claim_no.trim(),
        occurred_date: form.occurred_date,
        reported_date: form.reported_date,
        site: form.site,
        title: form.title,
        description: form.description,
        status: form.status,
        costs: form.costs
          .filter((c) => (c.description || "").trim() !== "" || num(c.amount) > 0)
          .map((c) => ({ ...c, amount: num(c.amount) })),
      };
      const res = existing ? await updateClaim(existing.id, body) : await createClaim(body);
      await onSaved(res.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!existing) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteClaim(existing.id);
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="claim-form">
      <div className="form-section-title">
        {existing ? `Claim${existing.claim_no ? ` ${existing.claim_no}` : ""}` : "New claim"}
        {existing?.project_no ? <span className="hint-inline"> · {existing.project_no}</span> : null}
      </div>
      <fieldset {...fieldsetProps}>
        <div className="form-grid">
          <label className="form-field">
            <span>Claim No.</span>
            <input
              value={form.claim_no}
              onChange={(e) => set("claim_no", e.target.value)}
              placeholder="optional"
            />
          </label>
          <label className="form-field">
            <span>Occurred</span>
            <input type="date" value={form.occurred_date} onChange={(e) => set("occurred_date", e.target.value)} />
          </label>
          <label className="form-field">
            <span>Reported</span>
            <input type="date" value={form.reported_date} onChange={(e) => set("reported_date", e.target.value)} />
          </label>
          <label className="form-field">
            <span>Vessel · site</span>
            {vesselMode === "pick" ? (
              <select
                value={form.site}
                onChange={(e) => {
                  if (e.target.value === "__other") {
                    setVesselMode("manual");
                    set("site", "");
                  } else set("site", e.target.value);
                }}
              >
                <option value="">—</option>
                {vessels.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
                <option value="__other">Other…</option>
              </select>
            ) : (
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  value={form.site}
                  onChange={(e) => set("site", e.target.value)}
                  placeholder="vessel · port"
                  autoFocus
                  style={{ flex: 1 }}
                />
                {vessels.length ? (
                  <button
                    type="button"
                    className="btn sm"
                    title="Pick a vessel from this project"
                    onClick={() => { setVesselMode("pick"); set("site", vessels[0]); }}
                  >
                    list
                  </button>
                ) : null}
              </span>
            )}
          </label>
          <label className="form-field">
            <span>Status</span>
            <select value={form.status} onChange={(e) => set("status", e.target.value)}>
              {STATUSES.map((o) => (
                <option key={o.v} value={o.v}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>Title</span>
            <input value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="what happened" />
          </label>
        </div>
        <label className="form-field" style={{ marginTop: 8 }}>
          <span>What happened · cause · action</span>
          <textarea rows={3} value={form.description} onChange={(e) => set("description", e.target.value)} />
        </label>

        <div className="form-section-title" style={{ marginTop: 12 }}>
          Costs
          <span className="hint-inline">
            {" "}— who bore it and how it was settled. A cost borne by the customer is not ours; a cost
            offset by a credit note is already a sales deduction, so never record it as an expense too.
          </span>
        </div>
        <div className="claim-costs-wrap">
          <table className="table mini wide claim-costs">
            <thead>
              <tr>
                <th style={{ width: 110 }}>Type</th>
                <th>Description</th>
                <th className="num" style={{ width: 110 }}>Amount</th>
                <th style={{ width: 74 }}>Cur.</th>
                <th style={{ width: 130 }}>Borne by</th>
                <th style={{ width: 180 }}>Settlement</th>
                <th style={{ width: 32 }} />
              </tr>
            </thead>
            <tbody>
              {form.costs.map((c, i) => (
                <tr key={i}>
                  <td>
                    <select value={c.kind} onChange={(e) => setCost(i, { kind: e.target.value })}>
                      {KINDS.map((o) => (
                        <option key={o.v} value={o.v}>{o.label}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input value={c.description} onChange={(e) => setCost(i, { description: e.target.value })} />
                  </td>
                  <td>
                    <input
                      className="num"
                      inputMode="decimal"
                      value={c.amount === 0 ? "" : String(c.amount)}
                      onChange={(e) => setCost(i, { amount: num(e.target.value.replace(/,/g, "")) })}
                    />
                  </td>
                  <td>
                    <select value={c.currency} onChange={(e) => setCost(i, { currency: e.target.value })}>
                      <option value="USD">USD</option>
                      <option value="KRW">KRW</option>
                      <option value="EUR">EUR</option>
                      <option value="JPY">JPY</option>
                    </select>
                  </td>
                  <td>
                    <select value={c.bearer} onChange={(e) => setCost(i, { bearer: e.target.value })}>
                      {BEARERS.map((o) => (
                        <option key={o.v} value={o.v}>{o.label}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select value={c.settlement} onChange={(e) => setCost(i, { settlement: e.target.value })}>
                      {SETTLEMENTS.map((o) => (
                        <option key={o.v} value={o.v}>{o.label}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="linklike"
                      title="Remove this line"
                      onClick={() => setForm((f) => ({ ...f, costs: f.costs.filter((_, n) => n !== i) }))}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          className="btn sm"
          style={{ marginTop: 6 }}
          onClick={() => setForm((f) => ({ ...f, costs: [...f.costs, { ...emptyCost }] }))}
        >
          + Cost line
        </button>
        <p className="hint-inline" style={{ display: "block", margin: "8px 0 0" }}>
          {Object.entries(totals).map(([cur, t]) => (
            <span key={cur} style={{ marginRight: 14 }}>
              <b>{cur}</b> total {money(t.all)} · ours {money(t.us)} · theirs {money(t.other)}
            </span>
          ))}
        </p>
      </fieldset>
      <div className="form-actions">
        {!canWriteNow ? (
          readMode ? null : <span className="hint-inline">{editBlockReason("ar", assigneeId)}</span>
        ) : (
          <>
            <button className="btn primary" disabled={busy} onClick={save}>
              {busy ? "Saving…" : existing ? "Save claim" : "Register claim"}
            </button>
            {existing ? (
              <button className="btn" disabled={busy} onClick={remove}>
                Delete
              </button>
            ) : onCancelNew ? (
              <button className="btn" disabled={busy} onClick={onCancelNew}>
                Cancel
              </button>
            ) : null}
          </>
        )}
        {err ? <span className="action-err">{err}</span> : null}
      </div>

      {existing ? (
        <CreditNoteSection
          claim={existing}
          orderId={orderId}
          canWrite={canWriteNow}
          onChanged={() => onSaved(existing.id)}
        />
      ) : (
        <p className="hint-inline" style={{ display: "block", margin: "10px 0 0" }}>
          Save the claim first — credit notes are issued against it.
        </p>
      )}
    </div>
  );
}

/** 크레딧 노트 문서에 찍히는 감액 내역 한 줄 — 금액은 상계 대상 청구서 통화. */
const emptyCnItem = (): CreditNoteItem => ({
  description: "",
  reference: "",
  qty: 1,
  unit_price: 0,
  amount: 0,
});

const fmt = (v: number, dec: number) =>
  v.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });

/** 받은 Blob 을 파일로 내려 준다(PDF·Excel 공통). */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // 브라우저가 파일을 다 읽고 난 뒤에 놓아 준다 — 바로 revoke 하면 빈 파일이 떨어진다.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** SET-OFF / OFFSET TERMS 표준 3조항 — 백엔드 _cn_default_terms 와 같은 문구.
 *
 *  화면에서 미리 채워 두는 이유: 이 세 줄이 고객 경리가 이 종이를 무엇으로 처리할지
 *  정하는 근거다. 빈 칸으로 두고 "안 적으면 알아서 나갑니다"라고 하면, 정작 문구를
 *  고쳐야 할 건(현금 환불이 섞인 건 등)에서 아무도 고치지 않는다. */
function defaultCnTerms(o: {
  cur: string;
  invCur: string;
  amount: number;
  applied: number;
  vessel: string;
  what: string;
  customer: string;
  invoiceNo: string;
  cashRefund: string;
}): string[] {
  const dec = o.invCur === "KRW" ? 0 : 2;
  let line1 =
    "Without prejudice and as a goodwill gesture, this Credit Note is issued for " +
    `${o.invCur} ${fmt(o.applied, dec)}`;
  if (o.cur !== o.invCur) line1 += `, equivalent to ${o.what} of ${o.cur} ${fmt(o.amount, 2)}`;
  if (o.vessel) line1 += ` incurred in connection with ${o.vessel}`;
  const lines = [`${line1}.`];
  if (o.invoiceNo) {
    lines.push(
      "The credit amount will be offset against the outstanding amount payable by " +
        `${o.customer || "the customer"} under Reference Invoice No. ${o.invoiceNo}.`,
    );
  }
  lines.push(
    o.cashRefund.toLowerCase().startsWith("y")
      ? "A cash refund will be made separately."
      : "No separate cash refund will be made.",
  );
  return lines;
}

/** 이 클레임으로 발행한 크레딧 노트 목록 + 발행·수정 폼 + 미리보기. */
function CreditNoteSection({
  claim,
  orderId,
  canWrite,
  onChanged,
}: {
  claim: ClaimRow;
  orderId: number;
  canWrite: boolean;
  onChanged: () => void | Promise<unknown>;
}) {
  // null = 폼 닫힘, {cn:null} = 신규 발행, {cn:행} = 그 노트 수정.
  const [form, setForm] = useState<{ cn: CreditNoteRow | null } | null>(null);
  const [preview, setPreview] = useState<CreditNoteRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const notes = claim.credit_notes || [];

  async function cancelNote(cn: CreditNoteRow) {
    setBusy(true);
    setErr(null);
    try {
      await deleteCreditNote(cn.id);
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Cancel failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="claim-cn">
      <div className="form-section-title" style={{ marginTop: 14 }}>
        Credit notes
        <span className="hint-inline">
          {" "}— issued to the customer to offset an outstanding invoice. Cancelling one brings the
          receivable back.
        </span>
      </div>
      {notes.length ? (
        <div className="claim-costs-wrap">
          <table className="table mini wide">
            <thead>
              <tr>
                <th>CN No.</th>
                <th style={{ width: 96 }}>Issued</th>
                <th className="num" style={{ width: 120 }}>Amount</th>
                <th className="num" style={{ width: 96 }}>FX</th>
                <th className="num" style={{ width: 140 }}>Offset applied</th>
                <th>Against invoice</th>
                <th style={{ width: 190 }} />
              </tr>
            </thead>
            <tbody>
              {notes.map((cn) => (
                <tr key={cn.id}>
                  <td>{cn.cn_no || `CN#${cn.id}`}</td>
                  <td>{cn.issue_date}</td>
                  <td className="num">{money(cn.amount, cn.currency)}</td>
                  <td className="num">{cn.fx_rate === 1 ? "—" : cn.fx_rate.toLocaleString()}</td>
                  <td className="num">{money(cn.applied_amount, cn.invoice_currency)}</td>
                  <td>
                    {cn.invoice_no || `AR#${cn.ar_id}`}
                    {cn.vat_amount ? (
                      <span className="hint-inline"> · VAT {money(cn.vat_amount, cn.invoice_currency)}</span>
                    ) : null}
                  </td>
                  <td>
                    {/* 감액 증서 — 발행하자마자 그 자리에서 보고 PDF·Excel 로 받는다. */}
                    <button type="button" className="linklike" onClick={() => setPreview(cn)}>
                      Preview
                    </button>
                    {canWrite ? (
                      <>
                        {" · "}
                        <button
                          type="button"
                          className="linklike"
                          disabled={busy}
                          onClick={() => setForm({ cn })}
                        >
                          Edit
                        </button>
                        {" · "}
                        <button type="button" className="linklike" disabled={busy} onClick={() => cancelNote(cn)}>
                          Cancel
                        </button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="hint-inline" style={{ display: "block", margin: "4px 0 0" }}>
          None yet.
        </p>
      )}
      {err ? <div className="action-err">{err}</div> : null}
      {canWrite ? (
        form ? (
          <CreditNoteForm
            key={form.cn ? `cn${form.cn.id}` : "cn-new"}
            claim={claim}
            orderId={orderId}
            existing={form.cn}
            onDone={async () => {
              setForm(null);
              await onChanged();
            }}
            onCancel={() => setForm(null)}
          />
        ) : (
          <button
            type="button"
            className="btn sm"
            style={{ marginTop: 8 }}
            onClick={() => setForm({ cn: null })}
          >
            + Issue credit note
          </button>
        )
      ) : null}
      {preview ? <CreditNotePreview cn={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}

/** 발행한 크레딧 노트 미리보기 — 화면에 뜬 그 PDF 를 그대로 내려받고, 같은 값의 Excel 도 받는다. */
function CreditNotePreview({ cn, onClose }: { cn: CreditNoteRow; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = (cn.cn_no || `CN-${cn.id}`).replace(/\//g, "-");

  useEffect(() => {
    let alive = true;
    let objUrl = "";
    fetchCreditNotePdf(cn.id)
      .then((blob) => {
        if (!alive) return;
        objUrl = URL.createObjectURL(blob);
        setUrl(objUrl);
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : "Could not open the PDF");
      });
    return () => {
      alive = false;
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
  }, [cn.id]);

  async function saveExcel() {
    setBusy(true);
    setErr(null);
    try {
      saveBlob(await fetchCreditNoteXlsx(cn.id), `${name}_CREDIT_NOTE.xlsx`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Excel download failed");
    } finally {
      setBusy(false);
    }
  }

  function savePdf() {
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}_CREDIT_NOTE.pdf`;
    a.click();
  }

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="doc-preview-backdrop" onClick={onClose}>
      <div className="doc-preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="doc-preview-head">
          <span className="doc-preview-title">{name} · CREDIT NOTE</span>
          <div className="doc-preview-acts">
            <button className="btn sm" disabled={busy} onClick={saveExcel}>
              Excel Download
            </button>
            <button className="btn sm doc-preview-save" disabled={!url} onClick={savePdf}>
              PDF Download
            </button>
            <button className="btn sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        {url ? (
          <iframe className="doc-preview-frame" src={url} title="Credit note preview" />
        ) : (
          <div className="state">{err ?? "Rendering the credit note…"}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** 크레딧 노트 발행·수정 폼 — 실제 발행해 온 양식의 칸을 그대로 채운다.
 *
 *  칸이 많아 보이지만 장식은 없다. 정산 방식·현금환불 여부·환율 근거가 빠진 감액 증서는
 *  받는 쪽에서 "그래서 이 돈을 돌려받는 건가"를 되묻게 되어 있고, 감액 내역 줄이 없으면
 *  무엇을 깎아 준 문서인지 종이만 보고는 알 수 없다.
 *  통화가 둘인 점만 조심하면 된다 — Original amount 는 현장 비용이 난 통화, 내역표와
 *  총액은 상계할 청구서의 통화다. */
function CreditNoteForm({
  claim,
  orderId,
  existing,
  onDone,
  onCancel,
}: {
  claim: ClaimRow;
  orderId: number;
  existing: CreditNoteRow | null;
  onDone: () => void | Promise<unknown>;
  onCancel: () => void;
}) {
  const { data } = useCachedData(`ar:candidates:${orderId}`, () => fetchArCandidates(orderId));
  const cands = useMemo(() => data?.rows ?? [], [data]);
  const [arId, setArId] = useState<number>(existing?.ar_id ?? 0);
  const [cnNo, setCnNo] = useState(existing?.cn_no ?? "");
  const [cnNoTouched, setCnNoTouched] = useState(Boolean(existing));
  const [issueDate, setIssueDate] = useState(existing?.issue_date || today());
  const [currency, setCurrency] = useState(existing?.currency || "USD");
  const [amount, setAmount] = useState(existing ? String(existing.amount) : "");
  const [fx, setFx] = useState(existing && existing.fx_rate !== 1 ? String(existing.fx_rate) : "");
  const [fxNote, setFxNote] = useState("");
  const [vatRate, setVatRate] = useState(existing ? String(existing.vat_rate) : "0");
  const [reason, setReason] = useState(existing?.reason ?? "");
  // ── 발행 문서에 그대로 찍히는 칸 ──
  const [vessel, setVessel] = useState(existing?.vessel_name || claim.site || "");
  const [settlement, setSettlement] = useState(
    existing?.settlement_method || "Set-off against outstanding balance");
  const [cashRefund, setCashRefund] = useState(existing?.cash_refund || "No");
  const [rateBasis, setRateBasis] = useState(existing?.rate_basis ?? "");
  const [quotation, setQuotation] = useState(existing?.fx_quotation ?? "");
  const [items, setItems] = useState<CreditNoteItem[]>(
    existing && existing.items.length ? existing.items.map((i) => ({ ...i })) : [emptyCnItem()]);
  const [itemsTouched, setItemsTouched] = useState(Boolean(existing?.items.length));
  const [terms, setTerms] = useState((existing?.terms ?? []).join("\n"));
  const [termsTouched, setTermsTouched] = useState(Boolean(existing?.terms.length));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const target = cands.find((c) => c.ar_id === arId) ?? null;
  const invCur = (target?.currency || existing?.invoice_currency || currency).toUpperCase();
  const dec = invCur === "KRW" ? 0 : 2;
  const customerName = data?.customer || "";

  // 첫 후보(같은 오더 건이 맨 위)를 기본 선택. 대상이 정해지면 통화·부가세율도 그 청구서에 맞춘다.
  useEffect(() => {
    if (!arId && cands.length) setArId(cands[0].ar_id);
  }, [cands, arId]);

  useEffect(() => {
    if (!target || existing) return;
    setVatRate(String(target.currency === "KRW" ? 0.1 : 0));
    // 번호 제안: <청구서번호>-CN (그 청구서에 이미 있으면 -CN2, -CN3 …). 손댄 뒤엔 건드리지 않는다.
    if (!cnNoTouched) {
      const base = target.invoice_no || target.po_no || `AR${target.ar_id}`;
      const n = target.credit_count;
      setCnNo(`${base}-CN${n ? n + 1 : ""}`);
    }
  }, [target, cnNoTouched, existing]);

  const sameCur = (currency || "").toUpperCase() === invCur;
  // 환산액 — 감액 내역 줄을 아직 손대지 않았을 때 그 줄을 채우는 값이기도 하다.
  const converted = Math.round((sameCur ? num(amount) : num(amount) * num(fx)) * 100) / 100;
  const itemsTotal = Math.round(items.reduce((sum, it) => sum + num(it.amount), 0) * 100) / 100;
  const applied = itemsTotal > 0 ? itemsTotal : converted;
  // 수정 중이면 이 노트가 이미 깎아 둔 몫을 되돌린 뒤 새 금액을 뺀다(잔액이 두 번 깎이지 않게).
  const after = target
    ? Math.round((target.outstanding + (existing?.applied_amount ?? 0) - applied) * 100) / 100
    : 0;

  const what = reason.trim() || claim.title || "the claim costs";

  // 감액 내역은 한 줄이면 되는 경우가 대부분이라 금액·사유를 따라 저절로 채운다.
  // 표를 한 번이라도 손대면 그때부터는 사람이 적은 것이 이긴다.
  useEffect(() => {
    if (itemsTouched) return;
    setItems([{
      description: what,
      reference: claim.claim_no || "",
      qty: 1,
      unit_price: converted,
      amount: converted,
    }]);
  }, [itemsTouched, converted, what, claim.claim_no]);

  useEffect(() => {
    if (termsTouched) return;
    setTerms(defaultCnTerms({
      cur: (currency || "").toUpperCase(),
      invCur,
      amount: num(amount),
      applied,
      vessel,
      what,
      customer: customerName,
      invoiceNo: target?.invoice_no || "",
      cashRefund,
    }).join("\n"));
  }, [termsTouched, currency, invCur, amount, applied, vessel, what, customerName, target, cashRefund]);

  const setItem = (i: number, patch: Partial<CreditNoteItem>) => {
    setItemsTouched(true);
    setItems((rows) => rows.map((it, n) => {
      if (n !== i) return it;
      const next = { ...it, ...patch };
      // 금액을 직접 고친 게 아니면 수량×단가를 따라간다(문서의 합이 어긋나지 않게).
      if (patch.amount === undefined) {
        next.amount = Math.round(num(next.qty) * num(next.unit_price) * 100) / 100;
      }
      return next;
    }));
  };

  async function loadRate() {
    if (!target) return;
    setFxNote("");
    try {
      const q = await fetchFxRate(issueDate, currency);
      const rate = q.rate / (q.unit || 1);
      if (rate) {
        setFx(String(rate));
        setFxNote(`매매기준율 ${q.date_used}${q.source === "fixed" ? " (fixed fallback)" : ""}`);
        // 환율 근거는 문서에 찍히는 칸이다 — 어디서 온 값인지 여기서 함께 채워 둔다.
        if (!rateBasis) {
          setRateBasis(q.source === "fixed" ? "Fixed internal rate" : "Korea Eximbank Basic Exchange Rate");
        }
        if (!quotation) setQuotation(`Base rate of ${q.date_used}`);
      }
    } catch {
      setFxNote("Rate lookup failed — enter it by hand.");
    }
  }

  async function issue() {
    setBusy(true);
    setErr(null);
    try {
      const body = {
        claim_id: claim.id,
        ar_id: arId,
        cn_no: cnNo.trim(),
        issue_date: issueDate,
        currency,
        amount: num(amount),
        fx_rate: sameCur ? 1 : num(fx),
        vat_rate: num(vatRate),
        reason,
        items: items.filter((it) => it.description.trim() !== "" || num(it.amount) > 0),
        vessel_name: vessel.trim(),
        settlement_method: settlement.trim(),
        cash_refund: cashRefund,
        rate_basis: rateBasis.trim(),
        fx_quotation: quotation.trim(),
        terms: terms.split("\n").map((t) => t.trim()).filter(Boolean),
      };
      if (existing) await updateCreditNote(existing.id, body);
      else await createCreditNote(body);
      await onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : existing ? "Save failed" : "Issue failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="claim-cn-form">
      <div className="form-grid">
        <label className="form-field" style={{ gridColumn: "span 2" }}>
          <span>Offset against invoice *</span>
          <select
            value={arId}
            onChange={(e) => { setArId(Number(e.target.value)); setCnNoTouched(Boolean(existing)); }}
          >
            {cands.length === 0 ? <option value={0}>No invoice on this customer yet</option> : null}
            {cands.map((c: ArCandidate) => (
              <option key={c.ar_id} value={c.ar_id}>
                {(c.invoice_no || `AR#${c.ar_id}`)} · {c.project_no || c.po_no} · outstanding{" "}
                {money(c.outstanding, c.currency)}{c.same_order ? " · this P/O" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span>CN No.</span>
          <input
            value={cnNo}
            onChange={(e) => { setCnNo(e.target.value); setCnNoTouched(true); }}
            placeholder="auto"
          />
        </label>
        <label className="form-field">
          <span>Issue date</span>
          <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
        </label>
        <label className="form-field">
          <span>Reference vessel</span>
          <input value={vessel} onChange={(e) => setVessel(e.target.value)} placeholder="M/V …" />
        </label>
        <label className="form-field">
          <span>Settlement method</span>
          <input
            value={settlement}
            onChange={(e) => setSettlement(e.target.value)}
            placeholder="Set-off against outstanding balance"
          />
        </label>
        <label className="form-field">
          <span>Cash refund</span>
          <select value={cashRefund} onChange={(e) => setCashRefund(e.target.value)}>
            <option value="No">No — offset only</option>
            <option value="Yes">Yes — refunded separately</option>
          </select>
        </label>
        <label className="form-field">
          <span>Original amount</span>
          <input
            className="num"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/,/g, ""))}
          />
        </label>
        <label className="form-field">
          <span>Currency</span>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="USD">USD</option>
            <option value="KRW">KRW</option>
            <option value="EUR">EUR</option>
            <option value="JPY">JPY</option>
          </select>
        </label>
        {!sameCur ? (
          <>
            <label className="form-field">
              <span>FX rate (1 {currency} = ? {invCur})</span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  className="num"
                  inputMode="decimal"
                  value={fx}
                  onChange={(e) => setFx(e.target.value.replace(/,/g, ""))}
                  style={{ flex: 1 }}
                />
                <button type="button" className="btn sm" onClick={loadRate} title="Use the base rate of the issue date">
                  base rate
                </button>
              </span>
            </label>
            <label className="form-field">
              <span>Rate basis</span>
              <input
                value={rateBasis}
                onChange={(e) => setRateBasis(e.target.value)}
                placeholder="e.g. Shinhan Bank Basic Exchange Rate"
              />
            </label>
            <label className="form-field">
              <span>Quotation</span>
              <input
                value={quotation}
                onChange={(e) => setQuotation(e.target.value)}
                placeholder="e.g. 528th quotation at 18:28:35, 24-Aug-2026"
              />
            </label>
          </>
        ) : null}
        <label className="form-field">
          <span>VAT on the deduction</span>
          <select value={vatRate} onChange={(e) => setVatRate(e.target.value)}>
            <option value="0">0% · export / zero-rated</option>
            <option value="0.1">10% · domestic (수정세금계산서)</option>
          </select>
        </label>
        <label className="form-field" style={{ gridColumn: "span 2" }}>
          <span>Reason</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why we credited this" />
        </label>
      </div>

      <div className="form-section-title" style={{ marginTop: 12 }}>
        Credit lines
        <span className="hint-inline">
          {" "}— what the note itself lists, in {invCur} (the invoice currency). Their total is the
          credit amount actually offset.
        </span>
      </div>
      <div className="claim-costs-wrap">
        <table className="table mini wide">
          <thead>
            <tr>
              <th style={{ width: 34 }}>No.</th>
              <th>Description</th>
              <th style={{ width: 150 }}>Reference</th>
              <th className="num" style={{ width: 64 }}>Qty</th>
              <th className="num" style={{ width: 110 }}>Unit price</th>
              <th className="num" style={{ width: 120 }}>Amount</th>
              <th style={{ width: 32 }} />
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>
                  <input value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} />
                </td>
                <td>
                  <input value={it.reference} onChange={(e) => setItem(i, { reference: e.target.value })} />
                </td>
                <td>
                  <input
                    className="num"
                    inputMode="decimal"
                    value={String(it.qty)}
                    onChange={(e) => setItem(i, { qty: num(e.target.value.replace(/,/g, "")) })}
                  />
                </td>
                <td>
                  <input
                    className="num"
                    inputMode="decimal"
                    value={it.unit_price === 0 ? "" : String(it.unit_price)}
                    onChange={(e) => setItem(i, { unit_price: num(e.target.value.replace(/,/g, "")) })}
                  />
                </td>
                <td>
                  <input
                    className="num"
                    inputMode="decimal"
                    value={it.amount === 0 ? "" : String(it.amount)}
                    onChange={(e) => setItem(i, { amount: num(e.target.value.replace(/,/g, "")) })}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="linklike"
                    title="Remove this line"
                    onClick={() => {
                      setItemsTouched(true);
                      setItems((rows) => (rows.length > 1 ? rows.filter((_, n) => n !== i) : rows));
                    }}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        className="btn sm"
        style={{ marginTop: 6 }}
        onClick={() => { setItemsTouched(true); setItems((rows) => [...rows, emptyCnItem()]); }}
      >
        + Credit line
      </button>

      <label className="form-field" style={{ marginTop: 12 }}>
        <span>
          Set-off / offset terms
          <span className="hint-inline"> — one clause per line; printed as the numbered terms.</span>
        </span>
        <textarea
          rows={4}
          value={terms}
          onChange={(e) => { setTerms(e.target.value); setTermsTouched(true); }}
        />
      </label>
      {termsTouched ? (
        <button
          type="button"
          className="btn sm"
          style={{ marginTop: 6 }}
          onClick={() => setTermsTouched(false)}
          title="Rewrite the standard three clauses from the amounts above"
        >
          Standard terms
        </button>
      ) : null}

      <p className="hint-inline" style={{ display: "block", margin: "8px 0 0" }}>
        {target ? (
          <>
            Total credit: <b>{invCur} {fmt(applied, dec)}</b>
            {!sameCur && fxNote ? ` (${fxNote})` : ""}
            {itemsTotal > 0 && converted > 0 && Math.abs(itemsTotal - converted) > 0.5
              ? ` — lines total ${fmt(itemsTotal, dec)}, conversion says ${fmt(converted, dec)}`
              : ""}
            {" · "}outstanding {money(target.outstanding, target.currency)} →{" "}
            <b>{money(after, target.currency)}</b>
            {after < -0.01 ? " — more than what is left on this invoice." : ""}
          </>
        ) : (
          "Pick the invoice this credit note is offset against."
        )}
      </p>
      <div className="form-actions">
        <button className="btn primary" disabled={busy || !arId || applied <= 0} onClick={issue}>
          {busy ? "Saving…" : existing ? "Save credit note" : "Issue credit note"}
        </button>
        <button className="btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  );
}
