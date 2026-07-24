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
} from "@/lib/types";
import { can } from "@/lib/auth";
import Modal from "@/components/common/Modal";
import CurrencyToggle from "@/components/common/CurrencyToggle";

// ── 표시 헬퍼 ──────────────────────────────────────────────────────────────────
const CATEGORIES = ["거래선지급", "임차료", "급여", "공과금", "세금", "기타"];
const RECURRENCE_LABEL: Record<string, string> = {
  none: "일회성",
  monthly: "매월",
  quarterly: "분기",
  yearly: "매년",
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
function byCurrency(m: MoneyByCurrency): string {
  const keys = Object.keys(m || {}).filter((k) => Math.abs(m[k]) > 0.5);
  if (!keys.length) return "—";
  return keys.map((c) => money(m[c], c)).join(" · ");
}
const todayStr = () => new Date().toISOString().slice(0, 10);

// ── 화면 ───────────────────────────────────────────────────────────────────────
type Tab = "overview" | "receivables" | "payables" | "closing" | "cashflow" | "calendar";

export default function FinanceScreen() {
  const [tab, setTab] = useState<Tab>("overview");
  return (
    <div className="action-tabs">
      <div className="page-tabs">
        <button className={tab === "overview" ? "on" : ""} onClick={() => setTab("overview")}>Overview</button>
        <button className={tab === "receivables" ? "on" : ""} onClick={() => setTab("receivables")}>Receivables (수금)</button>
        <button className={tab === "payables" ? "on" : ""} onClick={() => setTab("payables")}>Payables (지급)</button>
        <button className={tab === "closing" ? "on" : ""} onClick={() => setTab("closing")}>Closing · VAT (결산·부가세)</button>
        <button className={tab === "cashflow" ? "on" : ""} onClick={() => setTab("cashflow")}>Cash Flow (현금흐름)</button>
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
      <div className="fin-kpis">
        <KpiTile label="미수금 (Outstanding)" main={won(data.receivable.outstanding_krw)} sub={`${data.receivable.count} invoices · ${byCurrency(data.receivable.outstanding)}`} tone="blue" />
        <KpiTile label="연체 미수 (Overdue AR)" main={byCurrency(data.receivable.overdue)} tone="red" />
        <KpiTile label="지급 예정 (Payable, 30d + overdue)" main={won(data.payable.total_krw)} sub={byCurrency(data.payable.upcoming_30d)} tone="amber" />
        <KpiTile label="연체 지급 (Overdue payable)" main={byCurrency(data.payable.overdue)} tone="red" />
      </div>

      <div className="fin-overview-cols">
        <div className="panel">
          <h3 className="form-title">거래선별 미수 (Receivables by customer)</h3>
          {data.by_customer.length === 0 ? (
            <div className="muted">미수 잔액이 없습니다.</div>
          ) : (
            <table className="mini">
              <thead><tr><th>Customer</th><th className="num">Outstanding (₩ 환산)</th></tr></thead>
              <tbody>
                {data.by_customer.map((r) => (
                  <tr key={r.name}><td>{r.name}</td><td className="num">{won(r.outstanding_krw)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="panel">
          <h3 className="form-title">지급 분류별 (Payables by category)</h3>
          {data.by_category.length === 0 ? (
            <div className="muted">예정된 지급이 없습니다.</div>
          ) : (
            <table className="mini">
              <thead><tr><th>Category</th><th className="num">Amount (₩ 환산)</th></tr></thead>
              <tbody>
                {data.by_category.map((r) => (
                  <tr key={r.name}><td>{CATEGORY_LABEL[r.name] || r.name}</td><td className="num">{won(r.amount_krw)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <p className="hint-inline" style={{ display: "block", marginTop: 10 }}>
        ₩ 환산은 USD {data.usd_krw.toLocaleString()}원 기준의 참고 합계입니다. 통화별 실제 금액은 각 항목에서 확인하세요.
      </p>
    </div>
  );
}

function KpiTile({ label, main, sub, tone }: { label: string; main: string; sub?: string; tone: "blue" | "red" | "amber" }) {
  return (
    <div className={`fin-kpi fin-kpi--${tone}`}>
      <div className="fin-kpi-label">{label}</div>
      <div className="fin-kpi-main">{main}</div>
      {sub ? <div className="fin-kpi-sub">{sub}</div> : null}
    </div>
  );
}

// ── Receivables (읽기 전용; 편집은 프로젝트 9~11단계에서) ───────────────────────
function ReceivablesTab() {
  const { data, error } = useCachedData<{ rows: FinanceReceivable[] }>("finance:receivables", fetchFinanceReceivables);
  const [openOnly, setOpenOnly] = useState(true);
  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    return openOnly ? all.filter((r) => r.outstanding > 0) : all;
  }, [data, openOnly]);
  const totals = useMemo(() => {
    const t: MoneyByCurrency = {};
    for (const r of rows) t[r.currency] = (t[r.currency] || 0) + r.outstanding;
    return t;
  }, [rows]);

  if (error && !data) return <div className="state error">API error: {error.message}</div>;
  if (!data) return <div className="state">Loading…</div>;

  return (
    <div className="panel">
      <div className="items-head">
        <h3 className="form-title" style={{ margin: 0 }}>Receivables (미수금)</h3>
        <label className="check-chip" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> 미수 잔액만
        </label>
      </div>
      <p className="hint-inline" style={{ display: "block", margin: "4px 0 10px" }}>
        수금 데이터는 프로젝트의 세금계산서·수금 단계에서 자동 반영됩니다. 여기서는 현황만 확인합니다.
      </p>
      {rows.length === 0 ? (
        <div className="muted">표시할 미수 항목이 없습니다.</div>
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
                <td>{r.overdue ? <span className="wt-badge" style={{ background: "#fde2e1", color: "#c0392b" }}>연체</span> : r.status}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="foot-grand">
              <td className="total-label" colSpan={5}>Total outstanding</td>
              <td className="num total-value" colSpan={2}>{byCurrency(totals)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}

// ── Payables (지급대장) ────────────────────────────────────────────────────────
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
  const { data, error, refresh } = useCachedData<{ rows: FinancePayable[] }>("finance:payables", fetchFinancePayables);
  const [editing, setEditing] = useState<FinancePayable | null>(null);
  const [adding, setAdding] = useState(false);
  const rows = data?.rows ?? [];
  const canEdit = can("finance", "create") || can("finance", "edit");

  function reload() {
    invalidateCache("finance:summary");
    invalidateCache("finance:calendar");
    return refresh();
  }

  async function togglePaid(p: FinancePayable) {
    // 반복 항목의 회차 납부는 캘린더에서 처리한다.
    if (p.recurrence !== "none") return;
    await payFinancePayable(p.id, !p.paid);
    reload();
  }

  async function remove(p: FinancePayable) {
    if (!confirm(`"${p.description || p.counterparty}" 지급 항목을 삭제할까요?`)) return;
    await deleteFinancePayable(p.id);
    reload();
  }

  if (error && !data) return <div className="state error">API error: {error.message}</div>;
  if (!data) return <div className="state">Loading…</div>;

  return (
    <div className="panel">
      <div className="items-head">
        <h3 className="form-title" style={{ margin: 0 }}>Payables (지급대장)</h3>
        {can("finance", "create") ? (
          <button className="btn primary sm" onClick={() => setAdding(true)}>+ 지급 항목 추가</button>
        ) : null}
      </div>
      <p className="hint-inline" style={{ display: "block", margin: "4px 0 10px" }}>
        거래선 지급뿐 아니라 임차료·급여·공과금·세금 등 회사 지급을 등록합니다. 매월/분기/매년 반복 항목은 캘린더에 회차로 표시됩니다.
      </p>
      {rows.length === 0 ? (
        <div className="muted">등록된 지급 항목이 없습니다.</div>
      ) : (
        <table className="mini">
          <thead>
            <tr>
              <th>Category</th><th>Counterparty</th><th>Description</th>
              <th className="num">Amount</th><th>Due</th><th>Recurrence</th><th>Status</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>{CATEGORY_LABEL[p.category] || p.category}</td>
                <td>{p.counterparty || "—"}</td>
                <td>{p.description || "—"}</td>
                <td className="num">{money(p.amount, p.currency)}</td>
                <td>{p.due_date || "—"}</td>
                <td>{RECURRENCE_LABEL[p.recurrence] || p.recurrence}</td>
                <td>
                  {p.recurrence === "none" ? (
                    <button
                      type="button"
                      className={`wt-badge fin-paid-toggle${p.paid ? " on" : ""}`}
                      title={canEdit ? "납부 상태 토글" : ""}
                      disabled={!canEdit}
                      onClick={() => togglePaid(p)}
                    >
                      {p.paid ? "납부완료" : "미납"}
                    </button>
                  ) : (
                    <span className="muted">{p.paid_dates.length}회 납부</span>
                  )}
                </td>
                <td>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    {can("finance", "edit") ? <button className="btn sm" onClick={() => setEditing(p)}>수정</button> : null}
                    {can("finance", "delete") ? <button className="btn danger sm" onClick={() => remove(p)}>삭제</button> : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
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
    if (!(form.due_date || "").trim()) { setErr("지급 예정일을 입력하세요."); return; }
    if (!(form.description || "").trim() && !(form.counterparty || "").trim()) {
      setErr("내역 또는 거래선을 입력하세요."); return;
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
    <Modal title={rowId ? "지급 항목 수정" : "지급 항목 추가"} onClose={onClose} form>
      <div className="form-grid">
        <label className="form-field">
          <span>Category (분류)</span>
          <select value={form.category} onChange={(e) => set("category", e.target.value)}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c] || c} ({c})</option>)}
          </select>
        </label>
        <label className="form-field">
          <span>거래선 연결 (선택)</span>
          <select
            value={form.vendor_id ?? ""}
            onChange={(e) => {
              const id = e.target.value ? Number(e.target.value) : null;
              const v = (vendors ?? []).find((x) => x.id === id);
              setForm((f) => ({ ...f, vendor_id: id, counterparty: v ? v.name : f.counterparty }));
            }}
          >
            <option value="">— 직접 입력 —</option>
            {(vendors ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
        <label className="form-field">
          <span>Counterparty (거래선·수취인)</span>
          <input value={form.counterparty} onChange={(e) => set("counterparty", e.target.value)} placeholder="예: 건물주 / 급여" />
        </label>
        <label className="form-field">
          <span>Description (내역)</span>
          <input value={form.description} onChange={(e) => set("description", e.target.value)} />
        </label>
        <label className="form-field">
          <span>Amount</span>
          <input type="number" value={form.amount} onChange={(e) => set("amount", Number(e.target.value))} />
        </label>
        <label className="form-field">
          <span>Currency</span>
          <CurrencyToggle value={form.currency || "KRW"} onChange={(v) => set("currency", v)} />
        </label>
        <label className="form-field">
          <span>Due date (지급 예정일{form.recurrence !== "none" ? " · 최초 회차" : ""})</span>
          <input type="date" value={form.due_date} onChange={(e) => set("due_date", e.target.value)} />
        </label>
        <label className="form-field">
          <span>Recurrence (반복)</span>
          <select value={form.recurrence} onChange={(e) => set("recurrence", e.target.value)}>
            {Object.entries(RECURRENCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        {form.recurrence !== "none" ? (
          <label className="form-field">
            <span>Repeat until (반복 종료, 선택)</span>
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

// ── Closing · VAT (결산·부가세) ────────────────────────────────────────────────
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

function ClosingTab() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [type, setType] = useState<PeriodType>("month");
  const [idx, setIdx] = useState(now.getMonth()); // month index by default

  const subOptions = useMemo(() => {
    if (type === "year") return ["연간"];
    if (type === "half") return ["상반기", "하반기"];
    if (type === "quarter") return ["1분기", "2분기", "3분기", "4분기"];
    return Array.from({ length: 12 }, (_, i) => `${i + 1}월`);
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
          {years.map((y) => <option key={y} value={y}>{y}년</option>)}
        </select>
        <div className="seg-toggle" role="group" aria-label="Period type">
          {([["month", "월간"], ["quarter", "분기"], ["half", "반기"], ["year", "연간"]] as [PeriodType, string][]).map(([t, label]) => (
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
            <KpiTile label="매출 (공급가액)" main={won(data.sales.supply_krw)} sub={`${data.sales.count}건 · 세액 ${won(data.sales.vat_krw)}`} tone="blue" />
            <KpiTile label="매입 (원가)" main={won(data.purchase.cost_krw)} sub={`${data.purchase.count}건 · 추정 매입세액 ${won(data.purchase.vat_krw)}`} tone="amber" />
            <KpiTile label="매출총이익 (마진)" main={won(data.margin_krw)} sub={`이익률 ${data.margin_pct}%`} tone="blue" />
            <KpiTile
              label={data.vat.payable_krw >= 0 ? "부가세 납부 예상" : "부가세 환급 예상"}
              main={won(Math.abs(data.vat.payable_krw))}
              sub={`매출세액 ${won(data.vat.output_krw)} − 매입세액 ${won(data.vat.input_krw)}`}
              tone={data.vat.payable_krw >= 0 ? "red" : "blue"}
            />
          </div>

          <div className="panel">
            <h3 className="form-title">월별 매출·매입 추이 ({year}년, ₩ 환산)</h3>
            <MonthlyBars labels={data.monthly.labels} sales={data.monthly.sales} purchase={data.monthly.purchase} />
          </div>

          <div className="fin-overview-cols">
            <div className="panel">
              <h3 className="form-title">부가세 계산 (VAT)</h3>
              <table className="mini">
                <tbody>
                  <tr><td>매출세액 (Output VAT)</td><td className="num">{won(data.vat.output_krw)}</td></tr>
                  <tr><td>매입세액 (Input VAT, 추정)</td><td className="num">− {won(data.vat.input_krw)}</td></tr>
                  <tr className="foot-grand">
                    <td className="total-label">{data.vat.payable_krw >= 0 ? "납부세액" : "환급세액"}</td>
                    <td className="num total-value">{won(Math.abs(data.vat.payable_krw))}</td>
                  </tr>
                </tbody>
              </table>
              <p className="hint-inline" style={{ display: "block", marginTop: 8 }}>
                수출(영세율)은 매출세액 0. 매입세액은 내수 매입 원가의 10%로 추정한 값입니다(정확한 신고는 세금계산서 기준).
              </p>
            </div>
            <div className="panel">
              <h3 className="form-title">거래선별 매출 (Top)</h3>
              {data.by_customer.length === 0 ? (
                <div className="muted">해당 기간 매출이 없습니다.</div>
              ) : (
                <table className="mini">
                  <thead><tr><th>Customer</th><th className="num">매출(공급가액, ₩)</th></tr></thead>
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
        <div key={lab} className="fin-bar-col" title={`${lab} · 매출 ${won(sales[i])} · 매입 ${won(purchase[i])}`}>
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

// ── Cash Flow (현금흐름 예측) ───────────────────────────────────────────────────
function CashFlowTab() {
  const [unit, setUnit] = useState<"month" | "week">("month");
  const [count, setCount] = useState(6);
  const [openingInput, setOpeningInput] = useState("0");
  const [includePo, setIncludePo] = useState(false);
  const opening = Number(openingInput) || 0;

  const key = `finance:cashflow:${unit}:${count}:${opening}:${includePo}`;
  const { data, error } = useCachedData<FinanceCashflow>(key, () => fetchFinanceCashflow(unit, count, opening, includePo));

  const maxNet = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, ...data.rows.map((r) => Math.abs(r.net)));
  }, [data]);

  return (
    <div className="fin-overview">
      <div className="fin-period-bar">
        <div className="seg-toggle" role="group" aria-label="Unit">
          <button className={unit === "month" ? "on" : ""} onClick={() => { setUnit("month"); setCount(6); }}>월별</button>
          <button className={unit === "week" ? "on" : ""} onClick={() => { setUnit("week"); setCount(12); }}>주별</button>
        </div>
        <label className="fin-inline-field">
          구간 수
          <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {(unit === "month" ? [3, 6, 12] : [8, 12, 16]).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="fin-inline-field">
          기초잔고 (₩)
          <input type="number" value={openingInput} onChange={(e) => setOpeningInput(e.target.value)} style={{ width: 140 }} />
        </label>
        <label className="check-chip" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={includePo} onChange={(e) => setIncludePo(e.target.checked)} /> 벤더 PO 유출 반영(추정)
        </label>
      </div>

      {error && !data ? <div className="state error">API error: {error.message}</div> : null}
      {!data ? <div className="state">Loading…</div> : (
        <>
          <div className="fin-kpis">
            <KpiTile label="예상 유입 (Inflow)" main={won(data.total_inflow)} tone="blue" />
            <KpiTile label="예상 유출 (Outflow)" main={won(data.total_outflow)} tone="amber" />
            <KpiTile label="기말 잔고 (Ending)" main={won(data.ending)} sub={`기초 ${won(data.opening)}`} tone={data.ending >= 0 ? "blue" : "red"} />
          </div>

          <div className="panel">
            <h3 className="form-title">순증감 추이 (Net cash flow, ₩)</h3>
            <div className="fin-net-chart">
              {data.rows.map((r) => (
                <div key={r.label} className="fin-net-col" title={`${r.label} · 유입 ${won(r.inflow)} · 유출 ${won(r.outflow)} · 순 ${won(r.net)}`}>
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
            <h3 className="form-title">현금흐름 예측표</h3>
            <table className="mini">
              <thead>
                <tr><th>기간</th><th className="num">유입</th><th className="num">유출</th><th className="num">순증감</th><th className="num">누적잔고</th></tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.label} className={r.cumulative < 0 ? "fin-overdue" : ""}>
                    <td>{r.label}</td>
                    <td className="num">{won(r.inflow)}</td>
                    <td className="num">{won(r.outflow)}</td>
                    <td className="num" style={{ color: r.net >= 0 ? "#1e7a46" : "#c0392b" }}>{r.net >= 0 ? "+" : "−"}{won(Math.abs(r.net))}</td>
                    <td className="num"><b>{won(r.cumulative)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint-inline" style={{ display: "block", marginTop: 8 }}>
              유입=미수 수금 예정(AR due), 유출=지급대장 미납 회차{includePo ? " + 벤더 PO(발주일 추정)" : ""}. 연체·기지난 예정은 첫 구간에 반영됩니다. 누적잔고가 음수(빨강)면 현금 부족 구간입니다.
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

  // 그리드 범위(월 첫 주 일요일 ~ 마지막 주 토요일).
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
    await payFinancePayable(e.ref_id, !e.paid, e.occurrence);
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
          <span className="fin-dot fin-dot--rec" /> 수금(AR)
          <span className="fin-dot fin-dot--pay" /> 지급
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
                    title={`${e.kind === "receivable" ? "수금" : "지급"} · ${e.title} · ${money(e.amount, e.currency)}${e.paid ? " (납부완료)" : ""}`}
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
        지급 항목을 클릭하면 납부 완료/미납을 토글합니다(반복 항목은 해당 회차만). 수금(AR)은 프로젝트 단계에서 관리됩니다.
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
