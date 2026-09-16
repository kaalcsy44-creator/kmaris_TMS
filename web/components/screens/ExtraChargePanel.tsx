"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createExtraCharge,
  deleteExtraCharge,
  fetchPoWorkOptions,
  updateExtraCharge,
  fetchExtraCharges,
} from "@/lib/api";
import type { ExtraChargeSaveBody } from "@/lib/api";
import { can, canEditDeal, editBlockReason } from "@/lib/auth";
import { invalidateCache, useCachedData } from "@/lib/useCachedData";
import type { DocumentWorkItem, ExtraChargeRow } from "@/lib/types";
import { useEditGate } from "@/lib/viewMode";
import RecordStrip from "@/components/common/RecordStrip";
import VendorSelect from "@/components/common/VendorSelect";

// 추가비용 — 9단계(Billing · Statement) 워크스페이스의 네 번째 탭.
//
// 왜 여기인가: 일정이 밀려 항공권을 바꾸거나 비자를 새로 받으면 본 계약과 별개인 비용이
// 붙는데, 그 비용도 결국 견적·청구·수금을 거친다. 그 세 가지가 이미 모여 있는 자리가
// 9단계다. 파이프라인 단계로 두지 않는 이유는 Claim 과 같다(백엔드 ExtraCharge 주석).
//
// 화면이 지켜야 할 것 하나: 벤더측(우리가 낼 돈)과 고객측(우리가 받을 돈)을 반드시 한
// 화면에 나란히 둔다. 따로 두면 추가비용을 원가 그대로 넘겼는지 얹었는지 볼 수가 없다.
// 그래서 맨 아래 마진 한 줄이 이 탭의 요점이다.
//
// 승인일이 스위치다. 값을 채워 저장하면 그 쪽의 청구 레코드(AR/AP)가 서고, 비우면
// 거둬진다 — 단추가 아니라 날짜인 까닭은 "언제 승인했나"를 남겨야 나중에 되짚을 수
// 있기 때문이다.

const today = () => new Date().toISOString().slice(0, 10);

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const money = (v: number, cur = "") =>
  `${cur ? `${cur} ` : ""}${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

const REASONS: { v: string; label: string }[] = [
  { v: "schedule_delay", label: "Schedule delay" },
  { v: "scope_change", label: "Scope change" },
  { v: "rework", label: "Rework" },
  { v: "other", label: "Other" },
];
const TIMINGS: { v: string; label: string }[] = [
  { v: "before", label: "Before the work" },
  { v: "after", label: "After the work" },
];
const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  quoted: "Quoted",
  approved: "Approved",
  invoiced: "Invoiced",
  settled: "Settled",
};

/** 편집 중인 한 건. 서버 행(ExtraChargeRow)에서 입력 칸만 떼어 둔 모양. */
type Draft = ExtraChargeSaveBody & { items: DocumentWorkItem[]; vendor_items: DocumentWorkItem[] };

const emptyItem = (): DocumentWorkItem =>
  ({ description: "", part_no: "", qty: 1, unit_price: 0, amount: 0 } as DocumentWorkItem);

function emptyDraft(orderId: number): Draft {
  return {
    order_id: orderId,
    title: "",
    reason: "schedule_delay",
    occurred_date: today(),
    timing: "before",
    description: "",
    vendor_id: null,
    vendor_quote_no: "",
    vendor_quote_date: "",
    vendor_currency: "KRW",
    vendor_items: [emptyItem()],
    vendor_approved_date: "",
    quote_no: "",
    quote_date: today(),
    valid_until: "",
    currency: "USD",
    fx_rate: 1,
    items: [emptyItem()],
    vat_rate: 0,
    sent_date: "",
    approved_date: "",
    approved_ref: "",
    notes: "",
  };
}

function draftOf(r: ExtraChargeRow): Draft {
  return {
    order_id: r.order_id,
    title: r.title,
    reason: r.reason,
    occurred_date: r.occurred_date,
    timing: r.timing,
    description: r.description,
    vendor_id: r.vendor_id || null,
    vendor_quote_no: r.vendor_quote_no,
    vendor_quote_date: r.vendor_quote_date,
    vendor_currency: r.vendor_currency,
    vendor_items: r.vendor_items?.length ? r.vendor_items : [emptyItem()],
    vendor_approved_date: r.vendor_approved_date,
    quote_no: r.quote_no,
    quote_date: r.quote_date,
    valid_until: r.valid_until,
    currency: r.currency,
    fx_rate: r.fx_rate,
    items: r.items?.length ? r.items : [emptyItem()],
    vat_rate: r.vat_rate,
    sent_date: r.sent_date,
    approved_date: r.approved_date,
    approved_ref: r.approved_ref,
    notes: r.notes,
  };
}

const sumItems = (items: DocumentWorkItem[]) =>
  items.reduce((n, i) => n + num(i.amount), 0);

/** 추가비용의 품목표 — 본 청구서의 품목표보다 훨씬 짧다(항공권 1줄, 비자 1줄 식).
 *  그래서 정렬·복사·분류가 붙은 큰 표를 쓰지 않고 이 가벼운 표를 쓴다. */
function MiniItems({
  items,
  onChange,
  currency,
  disabled,
}: {
  items: DocumentWorkItem[];
  onChange: (next: DocumentWorkItem[]) => void;
  currency: string;
  disabled?: boolean;
}) {
  function set(i: number, patch: Partial<DocumentWorkItem>) {
    onChange(items.map((row, k) => {
      if (k !== i) return row;
      const next = { ...row, ...patch } as DocumentWorkItem;
      // 수량·단가를 고치면 금액을 따라 채운다 — 금액만 따로 고치는 것도 그대로 둔다.
      if (patch.qty !== undefined || patch.unit_price !== undefined) {
        next.amount = Math.round(num(next.qty) * num(next.unit_price) * 100) / 100;
      }
      return next;
    }));
  }
  return (
    <table className="mini xc-items">
      <thead>
        <tr>
          <th>Description</th>
          <th className="xc-num">Qty</th>
          <th className="xc-num">Unit price</th>
          <th className="xc-num">Amount ({currency})</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {items.map((it, i) => (
          <tr key={i}>
            <td>
              <input value={String(it.description ?? "")} disabled={disabled}
                     placeholder="Flight change fee (2 engineers)"
                     onChange={(e) => set(i, { description: e.target.value })} />
            </td>
            <td className="xc-num">
              <input value={String(it.qty ?? "")} disabled={disabled}
                     onChange={(e) => set(i, { qty: num(e.target.value) })} />
            </td>
            <td className="xc-num">
              <input value={String(it.unit_price ?? "")} disabled={disabled}
                     onChange={(e) => set(i, { unit_price: num(e.target.value) })} />
            </td>
            <td className="xc-num">
              <input value={String(it.amount ?? "")} disabled={disabled}
                     onChange={(e) => set(i, { amount: num(e.target.value) })} />
            </td>
            <td className="xc-del">
              {items.length > 1 && !disabled ? (
                <button type="button" className="co-mv-del" title="Remove this line"
                        onClick={() => onChange(items.filter((_, k) => k !== i))}>✕</button>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={3} className="xc-foot-label">Subtotal</td>
          <td className="xc-num xc-foot-val">{money(sumItems(items))}</td>
          <td />
        </tr>
      </tfoot>
      {disabled ? null : (
        <caption className="xc-cap">
          <button type="button" className="co-mv-add" onClick={() => onChange([...items, emptyItem()])}>
            ＋ line
          </button>
        </caption>
      )}
    </table>
  );
}

/** 청구 레코드 한 건의 현황 한 줄 — 금액·수금(지급)·잔액. 값은 서버가 실어 준다. */
function BillLine({ label, bill, hint }: {
  label: string;
  bill: ExtraChargeRow["ar"];
  hint: string;
}) {
  if (!bill) return <div className="xc-bill xc-bill--none">{label} — {hint}</div>;
  const done = bill.outstanding <= 0.01;
  return (
    <div className="xc-bill">
      <span className="xc-bill-label">{label}</span>
      <span className="xc-bill-no">{bill.invoice_no || bill.bill_no || "—"}</span>
      <span>{money(bill.invoice_amount, bill.currency)}</span>
      <span className="xc-bill-sep">·</span>
      <span>paid {money(bill.paid_amount, bill.currency)}</span>
      <span className={`ar-badge${done ? "" : " overdue"}`}>
        {done ? "Settled" : `Outstanding ${money(bill.outstanding, bill.currency)}`}
      </span>
    </div>
  );
}

export default function ExtraChargePanel({
  orderId,
  assigneeId,
  onChanged,
}: {
  orderId: number;
  assigneeId: number;
  onChanged?: () => void;
}) {
  const cacheKey = `extra:by-order:${orderId}`;
  const { data, error, refresh } = useCachedData(cacheKey, () => fetchExtraCharges({ orderId }));
  const { data: poOptions } = useCachedData("po:work-options", fetchPoWorkOptions);
  const rows = useMemo(() => data?.rows ?? [], [data]);

  const [selId, setSelId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(orderId));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canEdit = (can("ar", "edit") || can("ar", "create")) && canEditDeal(assigneeId);
  const { editing: canWriteNow, readMode, fieldsetProps } = useEditGate(canEdit);

  // 목록이 바뀌면 고른 건을 되찾는다(저장 뒤 새 목록에서도 같은 건을 계속 본다).
  useEffect(() => {
    if (adding) return;
    setSelId((cur) => (cur != null && rows.some((r) => r.id === cur) ? cur : rows[0]?.id ?? null));
  }, [rows, adding]);

  const selected = adding ? null : rows.find((r) => r.id === selId) ?? null;

  // 고른 건이 바뀌면 편집본을 그 건으로 다시 잡는다.
  useEffect(() => {
    setDraft(selected ? draftOf(selected) : emptyDraft(orderId));
  }, [selected, orderId]);

  function load() {
    invalidateCache(cacheKey);
    invalidateCache("dashboard");
    invalidateCache("pipeline");
    invalidateCache("ar:");
    onChanged?.();
    return refresh();
  }

  function set(patch: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...patch }));
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const body: ExtraChargeSaveBody = {
        ...draft,
        order_id: orderId,
        // 금액은 보내지 않는다 — 서버가 품목 합으로 채운다(화면과 저장본이 갈리지 않게).
        amount: null,
        vendor_amount: null,
      };
      if (selected) await updateExtraCharge(selected.id, body);
      else {
        const r = await createExtraCharge(body);
        setAdding(false);
        setSelId(r.id);
      }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!selected) return;
    if (!confirm("Delete this extra charge? The linked invoice/bill will be removed too.")) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteExtraCharge(selected.id);
      setSelId(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div className="state error">API error: {String((error as Error)?.message ?? error)}</div>;
  if (!data) return <div className="state">Loading extra charges…</div>;

  const vendorOptions = (poOptions?.vendors ?? []).map((v) => ({ id: v.id, name: v.name }));
  const vendorTotal = sumItems(draft.vendor_items);
  const salesTotal = sumItems(draft.items);
  const costInSales = Math.round(vendorTotal * num(draft.fx_rate || 1) * 100) / 100;
  const margin = Math.round((salesTotal - costInSales) * 100) / 100;
  const marginPct = salesTotal ? Math.round((margin / salesTotal) * 1000) / 10 : 0;

  return (
    <div className="claim-panel xc-panel">
      <div className="embedded-record-bar claim-bar">
        <span className="wp-po-picker-label">Extra charges</span>
        {rows.length ? (
          <RecordStrip ariaLabel="Extra charges" activeKey={adding ? -1 : selId ?? 0}>
            {rows.map((r) => (
              <button
                key={r.id}
                type="button"
                className={!adding && r.id === selId ? "on" : ""}
                onClick={() => { setAdding(false); setSelId(r.id); }}
              >
                {r.occurred_date || "—"} · {r.title || `Extra ${r.id}`} · {STATUS_LABEL[r.status] ?? r.status}
              </button>
            ))}
          </RecordStrip>
        ) : (
          <span className="hint-inline">
            No extra charge on this P/O — register one when a delay adds cost outside the contract.
          </span>
        )}
        {canWriteNow ? (
          <button type="button" className="btn sm" style={{ marginLeft: "auto" }}
                  onClick={() => { setAdding(true); setSelId(null); }} disabled={adding}>
            ＋ New extra charge
          </button>
        ) : null}
      </div>

      {!rows.length && !adding ? null : (
        <fieldset {...fieldsetProps}>
          {/* ① 사건 — 무엇 때문에, 언제, 작업 전인가 후인가 */}
          <div className="stage-card">
            <div className="form-section-title">What happened</div>
            <div className="form-grid form-grid--cols4">
              <label className="form-field form-field--span2">
                <span>Title</span>
                <input value={draft.title ?? ""} placeholder="Flight change & visa due to schedule delay"
                       onChange={(e) => set({ title: e.target.value })} />
              </label>
              <label className="form-field">
                <span>Reason</span>
                <select value={draft.reason} onChange={(e) => set({ reason: e.target.value })}>
                  {REASONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                </select>
              </label>
              <label className="form-field">
                <span>Occurred on</span>
                <input type="date" value={draft.occurred_date ?? ""}
                       onChange={(e) => set({ occurred_date: e.target.value })} />
              </label>
              <label className="form-field">
                <span>Timing</span>
                <select value={draft.timing} onChange={(e) => set({ timing: e.target.value })}>
                  {TIMINGS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                </select>
              </label>
              <label className="form-field form-field--full">
                <span>What happened</span>
                <textarea className="po-textarea small" value={draft.description ?? ""}
                          placeholder="Yard pushed the window by 5 days — tickets rebooked, new visas required."
                          onChange={(e) => set({ description: e.target.value })} />
              </label>
            </div>
          </div>

          {/* ② 벤더측 — 공급사가 보내온 견적을 우리가 승인한다 */}
          <div className="stage-card">
            <div className="form-section-title">
              Vendor side — their quote, our approval
              <span className="section-hint"> · approving creates the payable (AP)</span>
            </div>
            <div className="form-grid form-grid--cols4">
              <label className="form-field form-field--span2">
                <span>Vendor</span>
                <VendorSelect value={draft.vendor_id ?? ""} options={vendorOptions}
                              onChange={(id) => set({ vendor_id: id === "" ? null : id })} />
              </label>
              <label className="form-field">
                <span>Their quote no.</span>
                <input value={draft.vendor_quote_no ?? ""}
                       onChange={(e) => set({ vendor_quote_no: e.target.value })} />
              </label>
              <label className="form-field">
                <span>Received on</span>
                <input type="date" value={draft.vendor_quote_date ?? ""}
                       onChange={(e) => set({ vendor_quote_date: e.target.value })} />
              </label>
              <label className="form-field">
                <span>Currency</span>
                <select value={draft.vendor_currency} onChange={(e) => set({ vendor_currency: e.target.value })}>
                  <option value="KRW">KRW</option>
                  <option value="USD">USD</option>
                </select>
              </label>
              <label className="form-field form-field--span2">
                <span>We approved on</span>
                <input type="date" value={draft.vendor_approved_date ?? ""}
                       onChange={(e) => set({ vendor_approved_date: e.target.value })} />
                <span className="hint-inline">Leave empty until approved — the payable is created from this date.</span>
              </label>
            </div>
            <div className="form-grid form-grid--cols2">
              <div className="form-field form-field--full">
                <span>Their cost lines</span>
                <MiniItems items={draft.vendor_items} currency={draft.vendor_currency ?? "KRW"}
                           disabled={!canWriteNow}
                           onChange={(vendor_items) => set({ vendor_items })} />
              </div>
            </div>
            {selected ? (
              <div className="xc-bills">
                <BillLine label="Payable (AP)" bill={selected.ap}
                          hint="not created yet — fill in the approval date above" />
              </div>
            ) : null}
          </div>

          {/* ③ 고객측 — 우리가 발행한 견적을 고객이 승인한다 */}
          <div className="stage-card">
            <div className="form-section-title">
              Customer side — our quote, their approval
              <span className="section-hint"> · approving creates the invoice (AR)</span>
            </div>
            <div className="form-grid form-grid--cols4">
              <label className="form-field">
                <span>Our quote no.</span>
                <input value={draft.quote_no ?? ""} placeholder="KMS-QUO-2609-001-E1"
                       onChange={(e) => set({ quote_no: e.target.value })} />
              </label>
              <label className="form-field">
                <span>Quote date</span>
                <input type="date" value={draft.quote_date ?? ""}
                       onChange={(e) => set({ quote_date: e.target.value })} />
              </label>
              <label className="form-field">
                <span>Valid until</span>
                <input type="date" value={draft.valid_until ?? ""}
                       onChange={(e) => set({ valid_until: e.target.value })} />
              </label>
              <label className="form-field">
                <span>Sent on</span>
                <input type="date" value={draft.sent_date ?? ""}
                       onChange={(e) => set({ sent_date: e.target.value })} />
              </label>
              <label className="form-field">
                <span>Currency</span>
                <select value={draft.currency} onChange={(e) => set({ currency: e.target.value })}>
                  <option value="USD">USD</option>
                  <option value="KRW">KRW</option>
                </select>
              </label>
              <label className="form-field">
                <span>FX (1 {draft.vendor_currency} = ? {draft.currency})</span>
                <input value={String(draft.fx_rate ?? 1)}
                       onChange={(e) => set({ fx_rate: num(e.target.value) })} />
              </label>
              <label className="form-field">
                <span>VAT %</span>
                <input value={String(draft.vat_rate ?? 0)}
                       onChange={(e) => set({ vat_rate: num(e.target.value) })} />
              </label>
              <label className="form-field">
                <span>Customer approved on</span>
                <input type="date" value={draft.approved_date ?? ""}
                       onChange={(e) => set({ approved_date: e.target.value })} />
              </label>
              <label className="form-field form-field--span2">
                <span>Approval reference</span>
                <input value={draft.approved_ref ?? ""} placeholder="Mail 2026-09-02 / PO-XY2026090201"
                       onChange={(e) => set({ approved_ref: e.target.value })} />
                <span className="hint-inline">Where the approval is recorded — mail subject or their P/O no.</span>
              </label>
            </div>
            <div className="form-grid form-grid--cols2">
              <div className="form-field form-field--full">
                <span>What we charge</span>
                <MiniItems items={draft.items} currency={draft.currency ?? "USD"}
                           disabled={!canWriteNow}
                           onChange={(items) => set({ items })} />
              </div>
            </div>
            {selected ? (
              <div className="xc-bills">
                <BillLine label="Receivable (AR)" bill={selected.ar}
                          hint="not created yet — fill in the customer approval date above" />
              </div>
            ) : null}
          </div>

          {/* ④ 마진 — 이 탭의 요점. 원가 그대로 넘겼는지 얹었는지 한 줄로 보인다. */}
          <div className="stage-card">
            <div className="form-section-title">Margin on this extra charge</div>
            <div className="xc-margin">
              <span>Charged {money(salesTotal, draft.currency ?? "USD")}</span>
              <span className="xc-bill-sep">−</span>
              <span>
                cost {money(vendorTotal, draft.vendor_currency ?? "KRW")}
                {(draft.vendor_currency ?? "KRW") !== (draft.currency ?? "USD")
                  ? ` (= ${money(costInSales, draft.currency ?? "USD")})`
                  : ""}
              </span>
              <span className="xc-bill-sep">=</span>
              <span className={`xc-margin-val${margin < 0 ? " neg" : ""}`}>
                {money(margin, draft.currency ?? "USD")}
                {salesTotal ? ` (${marginPct}%)` : ""}
              </span>
            </div>
            {margin < 0 ? (
              <p className="hint-inline xc-margin-warn">
                We are charging less than we pay — check the FX rate and both cost lines.
              </p>
            ) : null}
            <div className="form-grid form-grid--cols2">
              <label className="form-field form-field--full">
                <span>Notes</span>
                <textarea className="po-textarea small" value={draft.notes ?? ""}
                          onChange={(e) => set({ notes: e.target.value })} />
              </label>
            </div>
          </div>
        </fieldset>
      )}

      {!rows.length && !adding ? null : (
        <div className="form-actions" style={{ marginTop: 14 }}>
          {!canWriteNow ? (
            readMode ? null : <span className="hint-inline">{editBlockReason("ar", assigneeId)}</span>
          ) : (
            <button className="btn primary" disabled={busy} onClick={save}>
              {busy ? "Working…" : selected ? "Save" : "Create extra charge"}
            </button>
          )}
          {adding ? (
            <button className="btn" disabled={busy} onClick={() => setAdding(false)}>Cancel</button>
          ) : null}
          {selected && canWriteNow ? (
            <button className="btn danger" disabled={busy} onClick={remove} style={{ marginLeft: "auto" }}>
              Delete
            </button>
          ) : null}
          {err ? <span className="action-err">{err}</span> : null}
        </div>
      )}
    </div>
  );
}
