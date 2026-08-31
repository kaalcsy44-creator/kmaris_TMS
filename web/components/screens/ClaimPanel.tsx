"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createClaim,
  createCreditNote,
  deleteClaim,
  deleteCreditNote,
  fetchArCandidates,
  fetchClaims,
  fetchFxRate,
  updateClaim,
} from "@/lib/api";
import { can, canEditDeal, editBlockReason } from "@/lib/auth";
import { invalidateCache, useCachedData } from "@/lib/useCachedData";
import type { ArCandidate, ClaimCost, ClaimRow, CreditNoteRow } from "@/lib/types";
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
  { v: "labor", label: "Labor · 공임" },
  { v: "parts", label: "Parts · 부품" },
  { v: "freight", label: "Freight · 운송" },
  { v: "inspection", label: "Inspection · 검사" },
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
    invalidateCache("finance:summary");
    invalidateCache("finance:receivables");
    invalidateCache("finance:calendar");
    invalidateCache("dashboard");
    onChanged?.();
    return refresh();
  }

  if (!data) return <div className="state">Loading claims…</div>;

  const selected = adding ? null : rows.find((r) => r.id === selId) ?? null;

  return (
    <div className="claim-panel">
      <div className="embedded-record-bar pane-row">
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
  existing,
  onSaved,
  onCancelNew,
}: {
  orderId: number;
  assigneeId: number;
  existing: ClaimRow | null;
  onSaved: (id?: number) => void | Promise<unknown>;
  onCancelNew?: () => void;
}) {
  const canEdit = (can("ar", "edit") || can("ar", "create")) && canEditDeal(assigneeId);
  const { editing: canWriteNow, readMode, fieldsetProps } = useEditGate(canEdit);
  const [form, setForm] = useState<ClaimForm>(() => (existing ? rowToForm(existing) : emptyForm()));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof ClaimForm>(k: K, v: ClaimForm[K]) => setForm((f) => ({ ...f, [k]: v }));

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
            <span>Site · vessel</span>
            <input value={form.site} onChange={(e) => set("site", e.target.value)} placeholder="port · vessel" />
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

/** 이 클레임으로 발행한 크레딧 노트 목록 + 발행 폼. */
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
  const [open, setOpen] = useState(false);
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
                <th style={{ width: 70 }} />
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
                    {canWrite ? (
                      <button type="button" className="linklike" disabled={busy} onClick={() => cancelNote(cn)}>
                        Cancel
                      </button>
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
        open ? (
          <CreditNoteForm
            claimId={claim.id}
            orderId={orderId}
            onDone={async () => {
              setOpen(false);
              await onChanged();
            }}
            onCancel={() => setOpen(false)}
          />
        ) : (
          <button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={() => setOpen(true)}>
            + Issue credit note
          </button>
        )
      ) : null}
    </div>
  );
}

/** 크레딧 노트 발행 폼 — 상계 대상 청구서를 고르고, 통화가 다르면 환율로 환산한다. */
function CreditNoteForm({
  claimId,
  orderId,
  onDone,
  onCancel,
}: {
  claimId: number;
  orderId: number;
  onDone: () => void | Promise<unknown>;
  onCancel: () => void;
}) {
  const { data } = useCachedData(`ar:candidates:${orderId}`, () => fetchArCandidates(orderId));
  const cands = useMemo(() => data?.rows ?? [], [data]);
  const [arId, setArId] = useState<number>(0);
  const [cnNo, setCnNo] = useState("");
  const [cnNoTouched, setCnNoTouched] = useState(false);
  const [issueDate, setIssueDate] = useState(today());
  const [currency, setCurrency] = useState("USD");
  const [amount, setAmount] = useState("");
  const [fx, setFx] = useState("");
  const [fxNote, setFxNote] = useState("");
  const [vatRate, setVatRate] = useState("0");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const target = cands.find((c) => c.ar_id === arId) ?? null;

  // 첫 후보(같은 오더 건이 맨 위)를 기본 선택. 대상이 정해지면 통화·부가세율도 그 청구서에 맞춘다.
  useEffect(() => {
    if (!arId && cands.length) setArId(cands[0].ar_id);
  }, [cands, arId]);

  useEffect(() => {
    if (!target) return;
    setVatRate(String(target.currency === "KRW" ? 0.1 : 0));
    // 번호 제안: <청구서번호>-CN (그 청구서에 이미 있으면 -CN2, -CN3 …). 손댄 뒤엔 건드리지 않는다.
    if (!cnNoTouched) {
      const base = target.invoice_no || target.po_no || `AR${target.ar_id}`;
      const n = target.credit_count;
      setCnNo(`${base}-CN${n ? n + 1 : ""}`);
    }
  }, [target, cnNoTouched]);

  const sameCur = !target || (currency || "").toUpperCase() === (target.currency || "").toUpperCase();
  const applied = sameCur ? num(amount) : num(amount) * num(fx);
  const after = target ? Math.round((target.outstanding - applied) * 100) / 100 : 0;

  async function loadRate() {
    if (!target) return;
    setFxNote("");
    try {
      const q = await fetchFxRate(issueDate, currency);
      const rate = q.rate / (q.unit || 1);
      if (rate) {
        setFx(String(rate));
        setFxNote(`매매기준율 ${q.date_used}${q.source === "fixed" ? " (fixed fallback)" : ""}`);
      }
    } catch {
      setFxNote("Rate lookup failed — enter it by hand.");
    }
  }

  async function issue() {
    setBusy(true);
    setErr(null);
    try {
      await createCreditNote({
        claim_id: claimId,
        ar_id: arId,
        cn_no: cnNo.trim(),
        issue_date: issueDate,
        currency,
        amount: num(amount),
        fx_rate: sameCur ? 1 : num(fx),
        vat_rate: num(vatRate),
        reason,
      });
      await onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Issue failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="claim-cn-form">
      <div className="form-grid">
        <label className="form-field" style={{ gridColumn: "span 2" }}>
          <span>Offset against invoice *</span>
          <select value={arId} onChange={(e) => { setArId(Number(e.target.value)); setCnNoTouched(false); }}>
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
          <span>Amount</span>
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
          <label className="form-field">
            <span>FX rate (1 {currency} = ? {target?.currency})</span>
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
      <p className="hint-inline" style={{ display: "block", margin: "6px 0 0" }}>
        {target ? (
          <>
            Offset applied: <b>{money(applied, target.currency)}</b>
            {!sameCur && fxNote ? ` (${fxNote})` : ""} · outstanding {money(target.outstanding, target.currency)} →{" "}
            <b>{money(after, target.currency)}</b>
            {after < -0.01 ? " — more than what is left on this invoice." : ""}
          </>
        ) : (
          "Pick the invoice this credit note is offset against."
        )}
      </p>
      <div className="form-actions">
        <button className="btn primary" disabled={busy || !arId || num(amount) <= 0} onClick={issue}>
          {busy ? "Issuing…" : "Issue credit note"}
        </button>
        <button className="btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  );
}
