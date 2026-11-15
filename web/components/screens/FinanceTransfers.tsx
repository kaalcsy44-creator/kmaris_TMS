"use client";

/**
 * 환전(계좌 간 통화 이동)과 계좌별 기준 잔고 — Finance Overview 에 붙는 두 조각.
 *
 * 환전은 매출도 비용도 아니다. 판 통화 계좌에서는 유출, 받은 통화 계좌에서는 유입으로
 * 같은 날 현금흐름에 서서 두 통장 잔고를 함께 맞춘다. 손익에는 '외화를 장부에 올린 환율과
 * 실제로 판 환율의 차이'(실현 환차손익)만 남는다 — Profit 의 FX gain / loss 줄.
 *
 * 기준 잔고는 '이 날 마감 때 통장 잔고가 얼마였다'는 한 점이다. 현금흐름은 이 점에서
 * 실제로 오간 돈을 앞뒤로 굴려 창의 기초잔고를 스스로 낸다(예전엔 매번 손으로 넣었다).
 */

import { useState } from "react";
import AmountInput from "@/components/common/AmountInput";
import Modal from "@/components/common/Modal";
import CurrencyToggle from "@/components/common/CurrencyToggle";
import { parseAmountInput } from "@/components/common/itemTable";
import {
  createFinanceTransfer,
  deleteFinanceTransfer,
  fetchFinanceBalanceAnchors,
  fetchFinanceLedgerBalance,
  fetchFinanceTransfers,
  saveFinanceBalanceAnchor,
  updateFinanceTransfer,
} from "@/lib/api";
import { can } from "@/lib/auth";
import { invalidateCache, useCachedData } from "@/lib/useCachedData";
import type { FinanceTransfer, FinanceTransferSave } from "@/lib/types";
import { localDayStr, money } from "@/components/screens/financeShared";

/** 환전·기준 잔고가 바뀌면 현금흐름·장부·손익이 모두 달라진다 — finance 캐시를 통째로 비운다. */
function refreshFinance() {
  invalidateCache("finance:");
}

const emptyTransfer = (): FinanceTransferSave => ({
  date: localDayStr(),
  from_currency: "USD",
  from_amount: 0,
  to_currency: "KRW",
  to_amount: 0,
  fee: 0,
  fee_currency: "KRW",
  description: "",
  notes: "",
});

/** 적용환율(1 외화 = ? KRW) — 두 금액에서 나눠 나온다(서버와 같은 규칙). */
function rateOf(f: Pick<FinanceTransferSave, "from_currency" | "from_amount" | "to_amount">): number {
  if (!f.from_amount || !f.to_amount) return 0;
  return f.from_currency === "KRW" ? f.from_amount / f.to_amount : f.to_amount / f.from_amount;
}

const fmtRate = (r: number) => r.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function TransferForm({ initial, rowId, onClose, onSaved }: {
  initial?: FinanceTransferSave;
  rowId?: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FinanceTransferSave>(() => ({ ...(initial ?? emptyTransfer()) }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = <K extends keyof FinanceTransferSave>(k: K, v: FinanceTransferSave[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const rate = rateOf(form);
  const foreign = form.from_currency === "KRW" ? form.to_currency : form.from_currency;

  async function save() {
    setBusy(true);
    setErr("");
    try {
      if (rowId) await updateFinanceTransfer(rowId, form);
      else await createFinanceTransfer(form);
      refreshFinance();
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
      setBusy(false);
    }
  }

  async function remove() {
    if (!rowId || !window.confirm("Delete this conversion? Both account balances move back.")) return;
    setBusy(true);
    try {
      await deleteFinanceTransfer(rowId);
      refreshFinance();
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
      setBusy(false);
    }
  }

  return (
    <Modal title={rowId ? "Edit FX conversion" : "Add FX conversion"} onClose={onClose} form maxWidth={560}>
      <div className="form-grid">
        <label className="form-field">
          <span>Date</span>
          <input type="date" value={form.date} onChange={(e) => set("date", e.target.value)} />
        </label>
        <label className="form-field">
          <span>Description (optional)</span>
          <input value={form.description} placeholder="FX conversion" onChange={(e) => set("description", e.target.value)} />
        </label>
        <label className="form-field">
          <span>Sold — left this account</span>
          <div style={{ display: "flex", gap: 6 }}>
            <CurrencyToggle value={form.from_currency} onChange={(v) => set("from_currency", v)} />
            <AmountInput
              inputMode="decimal"
              value={form.from_amount}
              onChange={(e) => set("from_amount", parseAmountInput(e.target.value) ?? 0)}
            />
          </div>
        </label>
        <label className="form-field">
          <span>Received — reached this account</span>
          <div style={{ display: "flex", gap: 6 }}>
            <CurrencyToggle value={form.to_currency} onChange={(v) => set("to_currency", v)} />
            <AmountInput
              inputMode="decimal"
              value={form.to_amount}
              onChange={(e) => set("to_amount", parseAmountInput(e.target.value) ?? 0)}
            />
          </div>
        </label>
        <div className="form-field" style={{ gridColumn: "1 / -1" }}>
          <span>Applied rate</span>
          <div className="hint-inline">
            {rate && form.from_currency !== form.to_currency
              ? <>1 {foreign} = <b>{fmtRate(rate)}</b> {form.from_currency === "KRW" || form.to_currency === "KRW" ? "KRW" : form.to_currency} — worked out from the two amounts</>
              : "Enter both amounts — the rate is worked out from them."}
          </div>
        </div>
        <label className="form-field">
          <span>Separate fee (optional)</span>
          <div style={{ display: "flex", gap: 6 }}>
            <CurrencyToggle value={form.fee_currency} onChange={(v) => set("fee_currency", v)} />
            <AmountInput
              inputMode="decimal"
              value={form.fee}
              onChange={(e) => set("fee", parseAmountInput(e.target.value) ?? 0)}
            />
          </div>
          <span className="hint-inline">Only if the bank charged one on top — usually it sits inside the rate.</span>
        </label>
        <label className="form-field" style={{ gridColumn: "1 / -1" }}>
          <span>Notes</span>
          <textarea className="po-textarea small" value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </label>
      </div>
      <div className="form-actions">
        {err ? <span className="action-err">{err}</span> : null}
        {rowId ? <button className="btn danger" style={{ marginRight: "auto" }} onClick={remove} disabled={busy}>Delete</button> : null}
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button
          className="btn primary"
          onClick={save}
          disabled={busy || !form.date || !form.from_amount || !form.to_amount || form.from_currency === form.to_currency}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}

/** Overview 맨 아래 — 환전 내역과 건별 실현 환차손익. */
export function TransfersPanel({ onChanged }: { onChanged?: () => void }) {
  const { data, error, refresh } = useCachedData<{ rows: FinanceTransfer[] }>("finance:transfers", fetchFinanceTransfers);
  const [editing, setEditing] = useState<FinanceTransfer | null>(null);
  const [adding, setAdding] = useState(false);
  const canEdit = can("finance", "create") || can("finance", "edit");
  const rows = data?.rows ?? [];
  const gainTotal = rows.reduce((s, r) => s + (r.fx_gain ?? 0), 0);
  const done = () => {
    setEditing(null);
    setAdding(false);
    refresh();
    onChanged?.();
  };

  return (
    <div className="panel">
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h3 className="form-title" style={{ margin: 0 }}>FX conversions</h3>
        {canEdit ? (
          <button className="btn sm primary" style={{ marginLeft: "auto" }} onClick={() => setAdding(true)}>
            + Add conversion
          </button>
        ) : null}
      </div>
      {error && !data ? <div className="state error">API error: {error.message}</div> : null}
      {!data ? <div className="state">Loading…</div> : (
        <div style={{ overflowX: "auto" }}>
          <table className="mini" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">Sold</th>
                <th className="num">Received</th>
                <th className="num">Rate</th>
                <th className="num" title="Moving-average rate the sold currency was carried at in the books">Book rate</th>
                <th className="num">FX gain / loss</th>
                <th className="num">Fee</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td className="mini-empty" colSpan={8}>No conversions yet.</td></tr>
              ) : rows.map((r) => (
                <tr
                  key={r.id}
                  className={canEdit ? "fin-row-pick" : undefined}
                  onClick={canEdit ? () => setEditing(r) : undefined}
                  title={canEdit ? "Edit this conversion" : undefined}
                >
                  <td>{r.date}</td>
                  <td className="num">{money(r.from_amount, r.from_currency)}</td>
                  <td className="num">{money(r.to_amount, r.to_currency)}</td>
                  <td className="num">{r.rate ? fmtRate(r.rate) : "—"}</td>
                  <td className="num">{r.book_rate ? fmtRate(r.book_rate) : "—"}</td>
                  <td className="num" style={{ color: (r.fx_gain ?? 0) < 0 ? "#c0392b" : (r.fx_gain ?? 0) > 0 ? "#1e7a46" : undefined }}>
                    {r.fx_gain === null ? "—" : `${r.fx_gain >= 0 ? "+" : "−"}${money(Math.abs(r.fx_gain), "KRW")}`}
                  </td>
                  <td className="num">{r.fee ? money(r.fee, r.fee_currency) : "—"}</td>
                  <td>{r.description || <span className="muted">FX conversion</span>}</td>
                </tr>
              ))}
            </tbody>
            {rows.some((r) => r.fx_gain !== null) ? (
              <tfoot>
                <tr className="fin-period-total">
                  <th colSpan={5}>Realized FX gain / loss — all conversions</th>
                  <td className="num" style={{ color: gainTotal < 0 ? "#c0392b" : "#1e7a46" }}>
                    <b>{gainTotal >= 0 ? "+" : "−"}{money(Math.abs(gainTotal), "KRW")}</b>
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      )}
      <p className="hint-inline" style={{ display: "block", marginTop: 8 }}>
        A conversion moves money between your own accounts — it leaves the sold currency&apos;s cash flow and
        enters the received one&apos;s on the same day, and is neither revenue nor cost. What reaches Profit is the
        realized FX gain / loss: the won received less the foreign amount at its book rate. Book rate = moving
        average of the rates that currency entered the books at — a customer receipt at the rate its sale was booked
        (month-end rate of the invoice month), other income at its month-end rate.
      </p>
      {adding ? <TransferForm onClose={() => setAdding(false)} onSaved={done} /> : null}
      {editing ? (
        <TransferForm
          rowId={editing.id}
          initial={{
            date: editing.date,
            from_currency: editing.from_currency,
            from_amount: editing.from_amount,
            to_currency: editing.to_currency,
            to_amount: editing.to_amount,
            fee: editing.fee,
            fee_currency: editing.fee_currency,
            description: editing.description,
            notes: editing.notes,
          }}
          onClose={() => setEditing(null)}
          onSaved={done}
        />
      ) : null}
    </div>
  );
}

/**
 * 계좌 기준 잔고 — 한 통화의 '이 날 마감 통장 잔고' 한 점을 저장하고, 아무 날짜의 KTMS
 * 장부 잔고를 통장과 맞춰 본다. 기준을 바꾸면 현금흐름의 기초잔고가 거기서 다시 굴러간다.
 */
export function BalanceAnchorModal({ currency, onClose, onSaved }: {
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data } = useCachedData("finance:anchors", fetchFinanceBalanceAnchors);
  const saved = data?.anchors?.[currency];
  const [asOf, setAsOf] = useState<string | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // 맞춰 보기 — 통장 화면의 잔고를 넣으면 KTMS 장부와의 차이를 바로 보여 준다(저장 안 함).
  const [checkOn, setCheckOn] = useState(localDayStr());
  const [bank, setBank] = useState<number>(0);
  const { data: ledger } = useCachedData(
    `finance:ledger-balance:${currency}:${checkOn}`,
    () => fetchFinanceLedgerBalance(currency, checkOn)
  );
  const canEdit = can("finance", "create") || can("finance", "edit");
  const asOfVal = asOf ?? saved?.as_of ?? "";
  const amountVal = amount ?? saved?.amount ?? 0;
  const diff = ledger?.balance === null || ledger?.balance === undefined ? null : bank - ledger.balance;

  async function save() {
    setBusy(true);
    setErr("");
    try {
      await saveFinanceBalanceAnchor(currency, asOfVal, amountVal);
      refreshFinance();
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
      setBusy(false);
    }
  }

  return (
    <Modal title={`Account balance — ${currency}`} onClose={onClose} form maxWidth={480}>
      <div className="form-grid">
        <p className="hint-inline" style={{ gridColumn: "1 / -1", display: "block", margin: 0 }}>
          One known point: what the {currency} account held at the end of a given day. The cash flow rolls every
          window&apos;s opening balance from here using the money that actually moved — no more typing it in.
          A day before the first transaction with a zero balance is the simplest anchor.
        </p>
        <label className="form-field">
          <span>Balance at end of</span>
          <input type="date" value={asOfVal} onChange={(e) => setAsOf(e.target.value)} disabled={!canEdit} />
        </label>
        <label className="form-field">
          <span>Bank balance ({currency})</span>
          <AmountInput
            inputMode="decimal"
            value={amountVal}
            onChange={(e) => setAmount(parseAmountInput(e.target.value) ?? 0)}
            disabled={!canEdit}
          />
        </label>
      </div>
      <div className="form-actions">
        {err ? <span className="action-err">{err}</span> : null}
        <button className="btn" onClick={onClose} disabled={busy}>Close</button>
        {canEdit ? (
          <button className="btn primary" onClick={save} disabled={busy || !asOfVal}>
            {busy ? "Saving…" : "Save balance"}
          </button>
        ) : null}
      </div>

      <h4 className="form-title" style={{ marginTop: 18 }}>Check against the bank</h4>
      <div className="form-grid">
        <label className="form-field">
          <span>On (end of day)</span>
          <input type="date" value={checkOn} onChange={(e) => setCheckOn(e.target.value)} />
        </label>
        <label className="form-field">
          <span>Bank shows</span>
          <AmountInput inputMode="decimal" value={bank} onChange={(e) => setBank(parseAmountInput(e.target.value) ?? 0)} />
        </label>
      </div>
      <table className="mini" style={{ marginTop: 8 }}>
        <tbody>
          <tr>
            <th scope="row">KTMS balance</th>
            <td className="num">
              {!ledger ? "…" : ledger.balance === null ? <span className="muted">save a balance first</span> : <b>{money(ledger.balance, currency)}</b>}
            </td>
          </tr>
          {bank && diff !== null ? (
            <tr>
              <th scope="row">Difference (bank − KTMS)</th>
              <td className="num" style={{ color: Math.abs(diff) < 0.5 ? "#1e7a46" : "#c0392b" }}>
                {Math.abs(diff) < 0.5 ? "✓ matches" : `${diff > 0 ? "+" : "−"}${money(Math.abs(diff), currency)}`}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {bank && diff !== null && Math.abs(diff) >= 0.5 ? (
        <p className="hint-inline" style={{ display: "block", marginTop: 6 }}>
          {diff > 0
            ? "The bank holds more than KTMS — something came in that is not recorded (or a payment is recorded that has not left)."
            : "The bank holds less than KTMS — something went out that is not recorded (a fee, a tax, a transfer)."}{" "}
          Open that month&apos;s daybook to find it.
        </p>
      ) : null}
    </Modal>
  );
}
