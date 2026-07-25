"use client";

import { useMemo, useState } from "react";
import {
  fetchFinanceSummary,
  fetchFinanceReceivables,
  fetchFinancePayables,
  fetchFinanceCalendar,
  fetchFinanceClosing,
  fetchFinanceCashflow,
  createFinancePayable,
  updateFinancePayable,
  deleteFinancePayable,
  payFinancePayable,
  fetchVendors,
} from "@/lib/api";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import type {
  FinancePayable,
  FinancePayableSave,
  FinanceReceivable,
  FinanceSummary,
  FinanceClosing,
  FinanceCashflow,
  FinanceCalendarEvent,
  MoneyByCurrency,
  FxQuote,
} from "@/lib/types";
import { can } from "@/lib/auth";
import Modal from "@/components/common/Modal";
import CurrencyToggle from "@/components/common/CurrencyToggle";
import { amountInputValue, parseAmountInput } from "@/components/common/itemTable";

// ── Display helpers ────────────────────────────────────────────────────────────
// Category codes are stored values (do not translate); labels below are display-only.
const CATEGORIES = ["거래선지급", "임차료", "급여", "공과금", "세금", "기타"];
const RECURRENCE_LABEL: Record<string, string> = {
  none: "One-time",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};
const CATEGORY_LABEL: Record<string, string> = {
  거래선지급: "Vendor payment",
  임차료: "Rent",
  급여: "Payroll",
  공과금: "Utilities",
  세금: "Tax",
  기타: "Other",
};

function sym(currency: string): string {
  return currency === "KRW" ? "₩" : currency === "USD" ? "$" : `${currency} `;
}
function money(amount: number, currency: string): string {
  return `${sym(currency)}${Math.round(amount).toLocaleString()}`;
}
function won(n: number): string {
  return `₩${Math.round(n).toLocaleString()}`;
}
/** 표시할 통화 목록 — KRW·USD 를 앞에 두고 나머지는 알파벳 순. */
function currencyKeys(m: MoneyByCurrency): string[] {
  const keys = Object.keys(m || {}).filter((k) => Math.abs(m[k]) > 0.5);
  const rank = (c: string) => (c === "KRW" ? 0 : c === "USD" ? 1 : 2);
  return keys.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
function byCurrency(m: MoneyByCurrency): string {
  const keys = currencyKeys(m);
  if (!keys.length) return "—";
  return keys.map((c) => money(m[c], c)).join(" · ");
}
/** 통화별 금액을 한 줄씩 — 환산 없이 ₩·$ 를 나란히 보여줄 때 쓴다. */
function byCurrencyLines(m: MoneyByCurrency): React.ReactNode {
  const keys = currencyKeys(m);
  if (!keys.length) return "—";
  return keys.map((c) => (
    <div key={c} className="cur-line">{money(m[c], c)}</div>
  ));
}

/** 통화별 합계를 참고용 KRW 한 값으로 — 표시 전용(집계·저장에는 쓰지 않는다). */
function toKrw(m: MoneyByCurrency, usdKrw: number): number {
  return Object.entries(m || {}).reduce(
    (sum, [cur, amt]) => sum + (cur === "USD" ? amt * usdKrw : amt),
    0
  );
}

/** AR 상태(DB는 한글 enum) → 화면 표기. */
const AR_STATUS_LABEL: Record<string, string> = {
  미수: "Outstanding",
  일부수금: "Partial",
  완납: "Paid",
  연체: "Overdue",
};
const todayStr = () => new Date().toISOString().slice(0, 10);

// ── Screen ───────────────────────────────────────────────────────────────────
type Tab = "overview" | "receivables" | "payables" | "closing" | "cashflow" | "calendar";

export default function FinanceScreen() {
  const [tab, setTab] = useState<Tab>("overview");
  return (
    <div className="action-tabs">
      <div className="page-tabs">
        <button className={tab === "overview" ? "on" : ""} onClick={() => setTab("overview")}>Overview</button>
        <button className={tab === "receivables" ? "on" : ""} onClick={() => setTab("receivables")}>Receivables</button>
        <button className={tab === "payables" ? "on" : ""} onClick={() => setTab("payables")}>Payables</button>
        <button className={tab === "closing" ? "on" : ""} onClick={() => setTab("closing")}>Closing · VAT</button>
        <button className={tab === "cashflow" ? "on" : ""} onClick={() => setTab("cashflow")}>Cash Flow</button>
        <button className={tab === "calendar" ? "on" : ""} onClick={() => setTab("calendar")}>Calendar</button>
      </div>

      {tab === "overview" && <OverviewTab />}
      {tab === "receivables" && <ReceivablesTab />}
      {tab === "payables" && <PayablesTab />}
      {tab === "closing" && <ClosingTab />}
      {tab === "cashflow" && <CashFlowTab />}
      {tab === "calendar" && <CalendarTab />}
    </div>
  );
}

// ── Overview ─────────────────────────────────────────────────────────────────
function OverviewTab() {
  const { data, error } = useCachedData<FinanceSummary>("finance:summary", fetchFinanceSummary);
  if (error && !data) return <div className="state error">API error: {error.message}</div>;
  if (!data) return <div className="state">Loading…</div>;

  return (
    <div className="fin-overview">
      {/* 금액은 환산하지 않고 통화별로 그대로 보여준다(₩·$ 각 줄). */}
      <div className="fin-kpis">
        <KpiTile label="Outstanding" main={byCurrencyLines(data.receivable.outstanding)} sub={`${data.receivable.count} invoices`} tone="blue" />
        <KpiTile label="Overdue AR" main={byCurrencyLines(data.receivable.overdue)} tone="red" />
        <KpiTile label="Payable (30d + overdue)" main={byCurrencyLines(data.payable.total)} sub={`Due in 30d ${byCurrency(data.payable.upcoming_30d)}`} tone="amber" />
        <KpiTile label="Overdue payable" main={byCurrencyLines(data.payable.overdue)} tone="red" />
      </div>

      <div className="fin-overview-cols">
        <div className="panel">
          <h3 className="form-title">Receivables by customer</h3>
          {data.by_customer.length === 0 ? (
            <div className="muted">No outstanding balance.</div>
          ) : (
            <table className="mini">
              <thead><tr><th>Customer</th><th className="num">Outstanding</th></tr></thead>
              <tbody>
                {data.by_customer.map((r) => (
                  <tr key={r.name}><td>{r.name}</td><td className="num">{byCurrency(r.outstanding)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="panel">
          <h3 className="form-title">Payables by category</h3>
          {data.by_category.length === 0 ? (
            <div className="muted">No scheduled payables.</div>
          ) : (
            <table className="mini">
              <thead><tr><th>Category</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {data.by_category.map((r) => (
                  <tr key={r.name}><td>{CATEGORY_LABEL[r.name] || r.name}</td><td className="num">{byCurrency(r.amount)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <p className="hint-inline" style={{ display: "block", marginTop: 10 }}>
        Amounts are shown in their original currency — no FX conversion, so totals are never mixed across currencies.
      </p>
    </div>
  );
}

function KpiTile({ label, main, sub, tone }: { label: string; main: React.ReactNode; sub?: string; tone: "blue" | "red" | "amber" }) {
  return (
    <div className={`fin-kpi fin-kpi--${tone}`}>
      <div className="fin-kpi-label">{label}</div>
      <div className="fin-kpi-main">{main}</div>
      {sub ? <div className="fin-kpi-sub">{sub}</div> : null}
    </div>
  );
}

// ── Receivables (read-only; editing lives in project stages 9–11) ──────────────
function ReceivablesTab() {
  const { data, error } = useCachedData<{ rows: FinanceReceivable[]; fx: FxQuote }>("finance:receivables", fetchFinanceReceivables);
  const [openOnly, setOpenOnly] = useState(true);
  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    return openOnly ? all.filter((r) => r.outstanding > 0) : all;
  }, [data, openOnly]);
  // 합계 3열(청구·수금·미수) — 통화별로 분리 집계.
  const totals = useMemo(() => {
    const t = { invoice: {} as MoneyByCurrency, paid: {} as MoneyByCurrency, outstanding: {} as MoneyByCurrency };
    for (const r of rows) {
      t.invoice[r.currency] = (t.invoice[r.currency] || 0) + r.invoice_amount;
      t.paid[r.currency] = (t.paid[r.currency] || 0) + r.paid_amount;
      t.outstanding[r.currency] = (t.outstanding[r.currency] || 0) + r.outstanding;
    }
    return t;
  }, [rows]);

  if (error && !data) return <div className="state error">API error: {error.message}</div>;
  if (!data) return <div className="state">Loading…</div>;
  const fx: FxQuote = data.fx ?? { rate: 0, date: "", source: "fixed" };

  return (
    <div className="panel">
      <div className="items-head">
        <h3 className="form-title" style={{ margin: 0 }}>Receivables</h3>
        <label className="check-chip" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Outstanding only
        </label>
      </div>
      <p className="hint-inline" style={{ display: "block", margin: "4px 0 10px" }}>
        Receivables are populated automatically from the project&apos;s tax-invoice and collection stages. This view is read-only.
      </p>
      {rows.length === 0 ? (
        <div className="muted">No receivables to show.</div>
      ) : (
        <table className="mini">
          <thead>
            <tr>
              <th>Customer</th><th>Invoice No.</th><th>Due</th>
              <th className="num">Invoice</th><th className="num">Paid</th><th className="num">Outstanding</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.overdue ? "fin-overdue" : ""}>
                <td>{r.customer}</td>
                <td>{r.invoice_no || r.ci_no || "—"}</td>
                <td>{r.due_date || "—"}</td>
                <td className="num">{money(r.invoice_amount, r.currency)}</td>
                <td className="num">{money(r.paid_amount, r.currency)}</td>
                <td className="num"><b>{money(r.outstanding, r.currency)}</b></td>
                <td>
                  {r.overdue ? (
                    <span className="wt-badge" style={{ background: "#fde2e1", color: "#c0392b" }}>Overdue</span>
                  ) : (
                    <>
                      {AR_STATUS_LABEL[r.status] || r.status}
                      {/* 완납 건은 수금일을 상태 옆에 함께 보여준다. */}
                      {r.paid_date ? <span className="fin-paid-on">{r.paid_date}</span> : null}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {/* 합계 라벨은 Invoice No. 열에서 시작하도록 첫 칸(Customer)을 비운다. */}
            <tr className="foot-grand fin-foot-total">
              <td />
              <td className="total-label fin-foot-name" colSpan={2}>Total</td>
              <td className="num total-value">{byCurrencyLines(totals.invoice)}</td>
              <td className="num total-value">{byCurrencyLines(totals.paid)}</td>
              <td className="num total-value">{byCurrencyLines(totals.outstanding)}</td>
              <td />
            </tr>
            {/* 참고용 KRW 환산 — 오늘자 매매기준율(조회 실패 시 고정환율). 집계에는 쓰지 않는다. */}
            <tr className="fin-foot-ref">
              <td />
              <td className="fin-foot-name" colSpan={2}>
                Total (In KRW · 1 USD = {fx.rate.toLocaleString()}
                {fx.source === "exim" ? ` · 매매기준율 ${fx.date}` : " · fixed rate"})
              </td>
              <td className="num">{won(toKrw(totals.invoice, fx.rate))}</td>
              <td className="num">{won(toKrw(totals.paid, fx.rate))}</td>
              <td className="num">{won(toKrw(totals.outstanding, fx.rate))}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}

// ── Payables (payment ledger) ──────────────────────────────────────────────────
const emptyPayable: FinancePayableSave = {
  category: "거래선지급",
  counterparty: "",
  vendor_id: null,
  description: "",
  amount: 0,
  currency: "KRW",
  due_date: todayStr(),
  recurrence: "none",
  recur_until: "",
  notes: "",
};

function PayablesTab() {
  const { data, error, refresh } = useCachedData<{ rows: FinancePayable[]; fx: FxQuote }>("finance:payables", fetchFinancePayables);
  const [editing, setEditing] = useState<FinancePayable | null>(null);
  const [adding, setAdding] = useState(false);
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const canEdit = can("finance", "create") || can("finance", "edit");
  // 합계는 통화별 분리(미수 목록과 같은 규칙). 반복 항목은 1회차 금액 기준.
  const totals = useMemo(() => {
    const t = { all: {} as MoneyByCurrency, unpaid: {} as MoneyByCurrency };
    for (const p of rows) {
      t.all[p.currency] = (t.all[p.currency] || 0) + p.amount;
      if (!p.paid) t.unpaid[p.currency] = (t.unpaid[p.currency] || 0) + p.amount;
    }
    return t;
  }, [rows]);

  function reload() {
    invalidateCache("finance:summary");
    invalidateCache("finance:calendar");
    return refresh();
  }

  async function togglePaid(p: FinancePayable) {
    // Per-occurrence payment of recurring items is handled from the calendar.
    if (p.recurrence !== "none") return;
    await payFinancePayable(p.id, !p.paid);
    reload();
  }

  async function remove(p: FinancePayable) {
    if (!confirm(`Delete payable "${p.description || p.counterparty}"?`)) return;
    await deleteFinancePayable(p.id);
    reload();
  }

  if (error && !data) return <div className="state error">API error: {error.message}</div>;
  if (!data) return <div className="state">Loading…</div>;
  const fx: FxQuote = data.fx ?? { rate: 0, date: "", source: "fixed" };

  return (
    <div className="panel">
      <div className="items-head">
        <h3 className="form-title" style={{ margin: 0 }}>Payables</h3>
        {can("finance", "create") ? (
          <button className="btn primary sm" onClick={() => setAdding(true)}>+ Add payable</button>
        ) : null}
      </div>
      <p className="hint-inline" style={{ display: "block", margin: "4px 0 10px" }}>
        Vendor bills arrive here automatically from the project&apos;s billing stages and are read-only. Use <b>+ Add payable</b> for the company&apos;s own costs — rent, payroll, utilities, taxes. Monthly/quarterly/yearly recurring items appear as occurrences on the calendar.
      </p>
      {rows.length === 0 ? (
        <div className="muted">No payables registered.</div>
      ) : (
        <table className="mini">
          <thead>
            <tr>
              <th>Category</th><th>Counterparty</th><th>Description</th>
              <th className="num">Amount</th><th>Due</th><th>Recurrence</th><th>Status</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const isAp = p.source === "ap";
              return (
              <tr key={`${p.source || "manual"}-${p.id}`}>
                <td>{CATEGORY_LABEL[p.category] || p.category}</td>
                <td>{p.counterparty || "—"}{isAp && p.po_no ? <span className="muted"> · {p.po_no}</span> : null}</td>
                <td>{p.description || "—"}</td>
                <td className="num">{money(p.amount, p.currency)}</td>
                <td>{p.due_date || "—"}</td>
                <td>{isAp ? <span className="muted">Vendor bill</span> : (RECURRENCE_LABEL[p.recurrence] || p.recurrence)}</td>
                <td>
                  {isAp ? (
                    <span className="wt-badge" title="Managed in project stage 9/10">Unpaid (AP)</span>
                  ) : p.recurrence === "none" ? (
                    <button
                      type="button"
                      className={`wt-badge fin-paid-toggle${p.paid ? " on" : ""}`}
                      title={canEdit ? "Toggle paid status" : ""}
                      disabled={!canEdit}
                      onClick={() => togglePaid(p)}
                    >
                      {p.paid ? "Paid" : "Unpaid"}
                    </button>
                  ) : (
                    <span className="muted">{p.paid_dates.length} paid</span>
                  )}
                </td>
                <td>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    {isAp ? (
                      <span className="hint-inline">Project stage 9/10</span>
                    ) : (
                      <>
                        {can("finance", "edit") ? <button className="btn sm" onClick={() => setEditing(p)}>Edit</button> : null}
                        {can("finance", "delete") ? <button className="btn danger sm" onClick={() => remove(p)}>Delete</button> : null}
                      </>
                    )}
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
          {/* 합계 — 통화별 분리, 그 아래 참고용 KRW 환산(미수 목록과 같은 규칙). */}
          <tfoot>
            <tr className="foot-grand fin-foot-total">
              <td />
              <td className="total-label fin-foot-name" colSpan={2}>Total</td>
              <td className="num total-value">{byCurrencyLines(totals.all)}</td>
              <td /><td />
              <td className="total-value">Unpaid {byCurrency(totals.unpaid)}</td>
              <td />
            </tr>
            <tr className="fin-foot-ref">
              <td />
              <td className="fin-foot-name" colSpan={2}>
                Total (In KRW · 1 USD = {fx.rate.toLocaleString()}
                {fx.source === "exim" ? ` · 매매기준율 ${fx.date}` : " · fixed rate"})
              </td>
              <td className="num">{won(toKrw(totals.all, fx.rate))}</td>
              <td /><td />
              <td>Unpaid {won(toKrw(totals.unpaid, fx.rate))}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      )}

      {adding ? (
        <PayableForm
          initial={emptyPayable}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); reload(); }}
        />
      ) : null}
      {editing ? (
        <PayableForm
          initial={editing}
          rowId={editing.id}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      ) : null}
    </div>
  );
}

function PayableForm({
  initial,
  rowId,
  onClose,
  onSaved,
}: {
  initial: FinancePayableSave;
  rowId?: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FinancePayableSave>({ ...initial });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const { data: vendors } = useCachedData("settings:vendors-opt", fetchVendors);

  function set<K extends keyof FinancePayableSave>(k: K, v: FinancePayableSave[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save() {
    if (!(form.due_date || "").trim()) { setErr("Enter a due date."); return; }
    if (!(form.description || "").trim() && !(form.counterparty || "").trim()) {
      setErr("Enter a description or counterparty."); return;
    }
    setBusy(true); setErr("");
    try {
      if (rowId) await updateFinancePayable(rowId, form);
      else await createFinancePayable(form);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={rowId ? "Edit payable" : "Add payable"} onClose={onClose} form>
      <div className="form-grid">
        <label className="form-field">
          <span>Category</span>
          <select value={form.category} onChange={(e) => set("category", e.target.value)}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c] || c}</option>)}
          </select>
        </label>
        <label className="form-field">
          <span>Vendor link (optional)</span>
          <select
            value={form.vendor_id ?? ""}
            onChange={(e) => {
              const id = e.target.value ? Number(e.target.value) : null;
              const v = (vendors ?? []).find((x) => x.id === id);
              setForm((f) => ({ ...f, vendor_id: id, counterparty: v ? v.name : f.counterparty }));
            }}
          >
            <option value="">— Manual entry —</option>
            {(vendors ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
        <label className="form-field">
          <span>Counterparty</span>
          <input value={form.counterparty} onChange={(e) => set("counterparty", e.target.value)} placeholder="e.g. Landlord / Payroll" />
        </label>
        <label className="form-field">
          <span>Description</span>
          <input value={form.description} onChange={(e) => set("description", e.target.value)} />
        </label>
        <label className="form-field">
          <span>Amount</span>
          <input className="num" inputMode="decimal" value={amountInputValue(form.amount)} onChange={(e) => set("amount", parseAmountInput(e.target.value) ?? 0)} />
        </label>
        <label className="form-field">
          <span>Currency</span>
          <CurrencyToggle value={form.currency || "KRW"} onChange={(v) => set("currency", v)} />
        </label>
        <label className="form-field">
          <span>Due date{form.recurrence !== "none" ? " · first occurrence" : ""}</span>
          <input type="date" value={form.due_date} onChange={(e) => set("due_date", e.target.value)} />
        </label>
        <label className="form-field">
          <span>Recurrence</span>
          <select value={form.recurrence} onChange={(e) => set("recurrence", e.target.value)}>
            {Object.entries(RECURRENCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        {form.recurrence !== "none" ? (
          <label className="form-field">
            <span>Repeat until (optional)</span>
            <input type="date" value={form.recur_until} onChange={(e) => set("recur_until", e.target.value)} />
          </label>
        ) : null}
      </div>
      <label className="form-field" style={{ marginTop: 10 }}>
        <span>Notes</span>
        <textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
      </label>
      <div className="form-actions">
        <button className="btn primary" disabled={busy} onClick={save}>{busy ? "Working…" : "Save"}</button>
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </Modal>
  );
}

// ── Closing · VAT ──────────────────────────────────────────────────────────────
type PeriodType = "month" | "quarter" | "half" | "year";

function periodRange(type: PeriodType, year: number, idx: number): { start: string; end: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const lastDay = (y: number, m: number) => new Date(y, m, 0).getDate(); // m: 1-12
  if (type === "year") return { start: `${year}-01-01`, end: `${year}-12-31` };
  if (type === "half") {
    return idx === 0
      ? { start: `${year}-01-01`, end: `${year}-06-30` }
      : { start: `${year}-07-01`, end: `${year}-12-31` };
  }
  if (type === "quarter") {
    const sm = idx * 3 + 1;
    const em = sm + 2;
    return { start: `${year}-${pad(sm)}-01`, end: `${year}-${pad(em)}-${lastDay(year, em)}` };
  }
  const m = idx + 1; // month
  return { start: `${year}-${pad(m)}-01`, end: `${year}-${pad(m)}-${lastDay(year, m)}` };
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function ClosingTab() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [type, setType] = useState<PeriodType>("month");
  const [idx, setIdx] = useState(now.getMonth()); // month index by default

  const subOptions = useMemo(() => {
    if (type === "year") return ["Full year"];
    if (type === "half") return ["First half", "Second half"];
    if (type === "quarter") return ["Q1", "Q2", "Q3", "Q4"];
    return MONTH_ABBR.slice();
  }, [type]);

  const safeIdx = Math.min(idx, subOptions.length - 1);
  const range = periodRange(type, year, safeIdx);
  const key = `finance:closing:${range.start}:${range.end}:${year}`;
  const { data, error } = useCachedData<FinanceClosing>(key, () => fetchFinanceClosing(range.start, range.end, year));

  const years = Array.from({ length: 6 }, (_, i) => now.getFullYear() - i);

  return (
    <div className="fin-overview">
      <div className="fin-period-bar">
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <div className="seg-toggle" role="group" aria-label="Period type">
          {([["month", "Monthly"], ["quarter", "Quarterly"], ["half", "Half"], ["year", "Yearly"]] as [PeriodType, string][]).map(([t, label]) => (
            <button key={t} className={type === t ? "on" : ""} onClick={() => { setType(t); setIdx(0); }}>{label}</button>
          ))}
        </div>
        {type !== "year" ? (
          <select value={safeIdx} onChange={(e) => setIdx(Number(e.target.value))}>
            {subOptions.map((o, i) => <option key={o} value={i}>{o}</option>)}
          </select>
        ) : null}
        <span className="fin-period-range">{range.start} ~ {range.end}</span>
      </div>

      {error && !data ? <div className="state error">API error: {error.message}</div> : null}
      {!data ? <div className="state">Loading…</div> : (
        <>
          <div className="fin-kpis">
            <KpiTile label="Sales (supply value)" main={won(data.sales.supply_krw)} sub={`${data.sales.count} · VAT ${won(data.sales.vat_krw)}`} tone="blue" />
            <KpiTile label="Purchases (cost)" main={won(data.purchase.cost_krw)} sub={`${data.purchase.count} · est. input VAT ${won(data.purchase.vat_krw)}`} tone="amber" />
            <KpiTile label="Gross profit (margin)" main={won(data.margin_krw)} sub={`Margin ${data.margin_pct}%`} tone="blue" />
            <KpiTile
              label={data.vat.payable_krw >= 0 ? "VAT payable (est.)" : "VAT refund (est.)"}
              main={won(Math.abs(data.vat.payable_krw))}
              sub={`Output VAT ${won(data.vat.output_krw)} − Input VAT ${won(data.vat.input_krw)}`}
              tone={data.vat.payable_krw >= 0 ? "red" : "blue"}
            />
          </div>

          <div className="panel">
            <h3 className="form-title">Monthly sales · purchases ({year}, ₩)</h3>
            <MonthlyBars labels={data.monthly.labels} sales={data.monthly.sales} purchase={data.monthly.purchase} />
          </div>

          <div className="fin-overview-cols">
            <div className="panel">
              <h3 className="form-title">VAT calculation</h3>
              <table className="mini">
                <tbody>
                  <tr><td>Output VAT</td><td className="num">{won(data.vat.output_krw)}</td></tr>
                  <tr><td>Input VAT (est.)</td><td className="num">− {won(data.vat.input_krw)}</td></tr>
                  <tr className="foot-grand">
                    <td className="total-label">{data.vat.payable_krw >= 0 ? "Payable" : "Refund"}</td>
                    <td className="num total-value">{won(Math.abs(data.vat.payable_krw))}</td>
                  </tr>
                </tbody>
              </table>
              <p className="hint-inline" style={{ display: "block", marginTop: 8 }}>
                Exports (zero-rated) carry 0 output VAT. Input VAT is estimated as 10% of domestic purchase cost (actual filing is based on tax invoices).
              </p>
            </div>
            <div className="panel">
              <h3 className="form-title">Sales by customer (Top)</h3>
              {data.by_customer.length === 0 ? (
                <div className="muted">No sales in this period.</div>
              ) : (
                <table className="mini">
                  <thead><tr><th>Customer</th><th className="num">Sales (supply, ₩)</th></tr></thead>
                  <tbody>
                    {data.by_customer.map((r) => (
                      <tr key={r.name}><td>{r.name}</td><td className="num">{won(r.sales_krw)}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MonthlyBars({ labels, sales, purchase }: { labels: string[]; sales: number[]; purchase: number[] }) {
  const max = Math.max(1, ...sales, ...purchase);
  return (
    <div className="fin-bars">
      {labels.map((lab, i) => (
        <div key={lab} className="fin-bar-col" title={`${lab} · Sales ${won(sales[i])} · Purchases ${won(purchase[i])}`}>
          <div className="fin-bar-stack">
            <div className="fin-bar sales" style={{ height: `${(sales[i] / max) * 100}%` }} />
            <div className="fin-bar purchase" style={{ height: `${(purchase[i] / max) * 100}%` }} />
          </div>
          <div className="fin-bar-label">{lab}</div>
        </div>
      ))}
    </div>
  );
}

// ── Cash Flow (projection) ──────────────────────────────────────────────────────
function CashFlowTab() {
  const [unit, setUnit] = useState<"month" | "week">("month");
  const [count, setCount] = useState(6);
  const [openingInput, setOpeningInput] = useState("0");
  const [includePo, setIncludePo] = useState(false);
  // 잔고 곡선은 한 통화 안에서만 의미가 있으므로 환산 대신 통화를 골라 본다.
  const [currency, setCurrency] = useState("KRW");
  const opening = Number(openingInput) || 0;
  const cash = (n: number) => money(n, currency);

  const key = `finance:cashflow:${unit}:${count}:${opening}:${includePo}:${currency}`;
  const { data, error } = useCachedData<FinanceCashflow>(key, () => fetchFinanceCashflow(unit, count, opening, includePo, currency));

  const maxNet = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, ...data.rows.map((r) => Math.abs(r.net)));
  }, [data]);

  return (
    <div className="fin-overview">
      <div className="fin-period-bar">
        <div className="seg-toggle" role="group" aria-label="Unit">
          <button className={unit === "month" ? "on" : ""} onClick={() => { setUnit("month"); setCount(6); }}>Monthly</button>
          <button className={unit === "week" ? "on" : ""} onClick={() => { setUnit("week"); setCount(12); }}>Weekly</button>
        </div>
        <label className="fin-inline-field">
          Periods
          <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {(unit === "month" ? [3, 6, 12] : [8, 12, 16]).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <div className="seg-toggle" role="group" aria-label="Currency">
          <button className={currency === "KRW" ? "on" : ""} onClick={() => setCurrency("KRW")}>₩ KRW</button>
          <button className={currency === "USD" ? "on" : ""} onClick={() => setCurrency("USD")}>$ USD</button>
        </div>
        <label className="fin-inline-field">
          Opening balance ({sym(currency).trim()})
          <input inputMode="decimal" value={amountInputValue(openingInput)} onChange={(e) => setOpeningInput(e.target.value.replace(/,/g, ""))} style={{ width: 140 }} />
        </label>
        <label className="check-chip" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={includePo} onChange={(e) => setIncludePo(e.target.checked)} /> Include vendor PO outflow (est.)
        </label>
      </div>

      {error && !data ? <div className="state error">API error: {error.message}</div> : null}
      {!data ? <div className="state">Loading…</div> : (
        <>
          <div className="fin-kpis">
            <KpiTile label="Projected inflow" main={cash(data.total_inflow)} tone="blue" />
            <KpiTile label="Projected outflow" main={cash(data.total_outflow)} tone="amber" />
            <KpiTile label="Ending balance" main={cash(data.ending)} sub={`Opening ${cash(data.opening)}`} tone={data.ending >= 0 ? "blue" : "red"} />
          </div>

          <div className="panel">
            <h3 className="form-title">Net cash flow ({sym(currency).trim()})</h3>
            <div className="fin-net-chart">
              {data.rows.map((r) => (
                <div key={r.label} className="fin-net-col" title={`${r.label} · Inflow ${cash(r.inflow)} · Outflow ${cash(r.outflow)} · Net ${cash(r.net)}`}>
                  <div className="fin-net-track">
                    <div className="fin-net-mid" />
                    <div
                      className={`fin-net-bar ${r.net >= 0 ? "pos" : "neg"}`}
                      style={{ height: `${(Math.abs(r.net) / maxNet) * 48}%`, [r.net >= 0 ? "bottom" : "top"]: "50%" } as React.CSSProperties}
                    />
                  </div>
                  <div className="fin-bar-label">{r.label}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <h3 className="form-title">Cash flow projection</h3>
            <table className="mini">
              <thead>
                <tr><th>Period</th><th className="num">Inflow</th><th className="num">Outflow</th><th className="num">Net</th><th className="num">Cumulative</th></tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.label} className={r.cumulative < 0 ? "fin-overdue" : ""}>
                    <td>{r.label}</td>
                    <td className="num">{cash(r.inflow)}</td>
                    <td className="num">{cash(r.outflow)}</td>
                    <td className="num" style={{ color: r.net >= 0 ? "#1e7a46" : "#c0392b" }}>{r.net >= 0 ? "+" : "−"}{cash(Math.abs(r.net))}</td>
                    <td className="num"><b>{cash(r.cumulative)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint-inline" style={{ display: "block", marginTop: 8 }}>
              Inflow = receivables due (AR due), outflow = unpaid payable occurrences{includePo ? " + vendor POs (estimated from order date)" : ""}. Only {currency} items are counted — switch the currency toggle for the other book; nothing is converted. Overdue / past-due items fall into the first period. A negative cumulative balance (red) marks a cash shortfall.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

// ── Calendar ─────────────────────────────────────────────────────────────────
function CalendarTab() {
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() }; // m: 0-11
  });

  // Grid range (Sunday of the first week … Saturday of the last week).
  const grid = useMemo(() => buildMonthGrid(month.y, month.m), [month]);
  const rangeKey = `finance:calendar:${grid.start}:${grid.end}`;
  const { data, error, refresh } = useCachedData(rangeKey, () => fetchFinanceCalendar(grid.start, grid.end));

  const byDate = useMemo(() => {
    const map = new Map<string, FinanceCalendarEvent[]>();
    for (const e of data?.rows ?? []) {
      const arr = map.get(e.date) ?? [];
      arr.push(e);
      map.set(e.date, arr);
    }
    return map;
  }, [data]);

  async function togglePayable(e: FinanceCalendarEvent) {
    if (e.kind !== "payable" || !can("finance", "edit")) return;
    if (e.source === "ap") return;   // 매입(AP) 이벤트는 읽기전용(프로젝트 단계에서 관리)
    await payFinancePayable(e.ref_id, !e.paid, e.occurrence ?? undefined);
    invalidateCache("finance:summary");
    refresh();
  }

  const monthLabel = new Date(month.y, month.m, 1).toLocaleDateString("en-US", { year: "numeric", month: "long" });
  const shift = (delta: number) => setMonth((cur) => {
    const d = new Date(cur.y, cur.m + delta, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  return (
    <div className="panel">
      <div className="fin-cal-head">
        <div className="fin-cal-nav">
          <button className="btn sm" onClick={() => shift(-1)}>‹ Prev</button>
          <button className="btn sm" onClick={() => setMonth(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; })}>Today</button>
          <button className="btn sm" onClick={() => shift(1)}>Next ›</button>
        </div>
        <h3 className="form-title" style={{ margin: 0 }}>{monthLabel}</h3>
        <div className="fin-cal-legend">
          <span className="fin-dot fin-dot--rec" /> Receivables (AR)
          <span className="fin-dot fin-dot--pay" /> Payables
        </div>
      </div>
      {error && !data ? <div className="state error">API error: {error.message}</div> : null}
      <div className="fin-cal-grid">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="fin-cal-dow">{d}</div>
        ))}
        {grid.days.map((day) => {
          const events = byDate.get(day.iso) ?? [];
          return (
            <div key={day.iso} className={`fin-cal-cell${day.inMonth ? "" : " out"}${day.iso === todayStr() ? " today" : ""}`}>
              <div className="fin-cal-date">{day.d}</div>
              <div className="fin-cal-events">
                {events.map((e, i) => (
                  <button
                    key={i}
                    type="button"
                    className={`fin-ev fin-ev--${e.kind}${e.overdue ? " overdue" : ""}${e.paid ? " paid" : ""}`}
                    title={`${e.kind === "receivable" ? "Receivable" : "Payable"} · ${e.title} · ${money(e.amount, e.currency)}${e.paid ? " (paid)" : ""}`}
                    onClick={() => togglePayable(e)}
                  >
                    <span className="fin-ev-title">{e.title}</span>
                    <span className="fin-ev-amt">{money(e.amount, e.currency)}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <p className="hint-inline" style={{ display: "block", marginTop: 8 }}>
        Click a payable to toggle paid / unpaid (recurring items toggle only that occurrence). Receivables (AR) are managed from the project stages.
      </p>
    </div>
  );
}

function buildMonthGrid(y: number, m: number) {
  const first = new Date(y, m, 1);
  const startOffset = first.getDay(); // 0=Sun
  const gridStart = new Date(y, m, 1 - startOffset);
  const days: { iso: string; d: number; inMonth: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    const dt = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    days.push({
      iso: `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`,
      d: dt.getDate(),
      inMonth: dt.getMonth() === m,
    });
  }
  return { days, start: days[0].iso, end: days[days.length - 1].iso };
}
