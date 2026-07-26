"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
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
  createFinanceIncome,
  updateFinanceIncome,
  deleteFinanceIncome,
  receiveFinanceIncome,
  fetchVendors,
} from "@/lib/api";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import type {
  FinancePayable,
  FinancePayableSave,
  FinanceIncomeSave,
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
// 기타 수입 분류(저장값은 한글 코드, 표시만 영문).
const INCOME_CATEGORIES = ["이자수입", "환급", "잡수입", "기타"];
const INCOME_CATEGORY_LABEL: Record<string, string> = {
  이자수입: "Interest",
  환급: "Refund",
  잡수입: "Misc income",
  기타: "Other",
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

/** "2026-07" → "Jul 2026". 실적 KPI·기초잔고 기준일처럼 기간을 밝혀야 할 때 쓴다. */
function monthLabel(ym: string): string {
  const [y, m] = (ym || "").split("-").map(Number);
  if (!y || !m) return ym || "";
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
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

      {/* 위 네 타일은 '아직 안 오간 돈'이라 완납되는 순간 값이 사라진다. 이미 들어오고
          나간 돈은 여기서만 보이므로 줄을 나누고 색(초록)도 달리 준다. */}
      <div className="fin-kpis-cap">Cash actually moved · {monthLabel(data.month)}</div>
      <div className="fin-kpis fin-kpis--actual">
        <KpiTile
          label="Collected"
          main={byCurrencyLines(data.collected_month.amount)}
          sub={`${data.collected_month.count} received`}
          tone="green"
        />
        <KpiTile
          label="Paid out"
          main={byCurrencyLines(data.paid_month.amount)}
          sub={`${data.paid_month.count} settled`}
          tone="green"
        />
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

function KpiTile({ label, main, sub, tone }: { label: string; main: React.ReactNode; sub?: string; tone: "blue" | "red" | "amber" | "green" }) {
  return (
    <div className={`fin-kpi fin-kpi--${tone}`}>
      <div className="fin-kpi-label">{label}</div>
      <div className="fin-kpi-main">{main}</div>
      {sub ? <div className="fin-kpi-sub">{sub}</div> : null}
    </div>
  );
}

/** 수입 목록 합계 — 청구·수금·미수 3열을 통화별로 모은다. */
function receivableTotals(rows: FinanceReceivable[]) {
  const t = { invoice: {} as MoneyByCurrency, paid: {} as MoneyByCurrency, outstanding: {} as MoneyByCurrency };
  for (const r of rows) {
    t.invoice[r.currency] = (t.invoice[r.currency] || 0) + r.invoice_amount;
    t.paid[r.currency] = (t.paid[r.currency] || 0) + r.paid_amount;
    t.outstanding[r.currency] = (t.outstanding[r.currency] || 0) + r.outstanding;
  }
  return t;
}

/**
 * 프로젝트 문서번호 → 그 프로젝트의 9단계(AR/AP 작업 화면) 링크.
 * 수금(AR)·매입청구(AP) 행은 여기서 편집할 수 없고 프로젝트 단계에서 관리하므로,
 * 번호를 눌러 그 자리로 바로 갈 수 있어야 한다. 오더 id 로 딥링크하면 목록이
 * rfq_id 를 찾아 팝업을 열어 준다(ProjectsScreen 의 ?order= 처리).
 */
function ProjectDocLink({
  orderId,
  rfqId,
  label,
  hint,
  apPoId,
}: {
  orderId?: number;
  /** 이 문서가 속한 프로젝트(RFQ). 목록에서 프로젝트를 찾는 기준값 — order_id 보다 우선. */
  rfqId?: number;
  label?: string;
  /** 표 우측의 안내 문구 자리 — 링크를 못 걸 때 옅은 안내 문구로 남긴다. */
  hint?: boolean;
  /** 지급(AP) 행 전용 — AP 탭 + 이 벤더 P/O 가 선택된 상태로 연다. */
  apPoId?: number;
}) {
  const text = label || "—";
  // 프로젝트를 특정할 수 없는 행(오더·프로젝트 연결 없음)은 링크 없이 원래 표기로 둔다.
  if (!orderId && !rfqId) return hint ? <span className="hint-inline">{text}</span> : <>{text}</>;
  // rfq 와 order 를 함께 넘긴다 — rfq 로 프로젝트를 찾고, order 로 그 프로젝트 안에서
  // 이 문서의 고객 P/O 를 고른다. (한 프로젝트에 P/O 가 여러 건일 수 있다.)
  // 지급(AP) 행은 11단계(Payment Completed)로 연다 — 지급 확인 칸이 붙어 있는 단계라,
  // 목록에서 누르면 바로 그 칸이 보인다. 수입(AR) 행은 청구서를 편집하는 9단계 그대로.
  const params = [
    rfqId ? `rfq=${rfqId}` : "",
    orderId ? `order=${orderId}` : "",
    apPoId ? "stage=11" : "stage=9",
    apPoId ? `ap=${apPoId}` : "",
  ].filter(Boolean).join("&");
  return (
    <Link
      className={`fin-doc-link${hint ? " hint" : ""}`}
      href={`/project?${params}`}
      title={apPoId ? "Open this vendor bill · stage 11 Payable (AP)" : "Open this project's billing · AR/AP stage"}
    >
      {text}
    </Link>
  );
}

// ── Receivables — 프로젝트 매출(AR, 읽기전용) + 기타 수입(수동 등록) ────────────
function ReceivablesTab() {
  const { data, error, refresh } = useCachedData<{ rows: FinanceReceivable[]; fx: FxQuote }>("finance:receivables", fetchFinanceReceivables);
  const [openOnly, setOpenOnly] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<FinanceReceivable | null>(null);
  const [receiving, setReceiving] = useState<{ row: FinanceReceivable; occurrence: string } | null>(null);
  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    return openOnly ? all.filter((r) => r.outstanding > 0) : all;
  }, [data, openOnly]);
  // 섹션 = 프로젝트 매출(AR) / 기타 수입. 성격이 달라 소계도 따로 낸다.
  const groups = useMemo(() => [
    {
      key: "ar",
      title: "Sales",
      sub: "customer invoices (AR)",
      empty: "No customer invoices to show.",
      rows: rows.filter((r) => r.source !== "income"),
    },
    {
      key: "income",
      title: "Other income",
      sub: "interest, refunds, misc",
      empty: "No other income registered.",
      rows: rows.filter((r) => r.source === "income"),
    },
  ], [rows]);
  // 합계 3열(청구·수금·미수) — 통화별로 분리 집계.
  const totals = useMemo(() => receivableTotals(rows), [rows]);

  function reload() {
    invalidateCache("finance:summary");
    invalidateCache("finance:calendar");
    return refresh();
  }

  async function undoReceived(r: FinanceReceivable, occurrence?: string) {
    await receiveFinanceIncome(r.id, false, occurrence);
    reload();
  }

  async function removeIncome(r: FinanceReceivable) {
    if (!confirm(`Delete income "${r.description || r.counterparty}"?`)) return;
    await deleteFinanceIncome(r.id);
    reload();
  }

  if (error && !data) return <div className="state error">API error: {error.message}</div>;
  if (!data) return <div className="state">Loading…</div>;
  const fx: FxQuote = data.fx ?? { rate: 0, date: "", source: "fixed" };
  const canEdit = can("finance", "create") || can("finance", "edit");

  return (
    <div className="panel">
      <div className="items-head">
        <h3 className="form-title fin-page-title" style={{ margin: 0 }}>Receivables</h3>
        <div className="items-head-actions">
          <label className="check-chip" style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Outstanding only
          </label>
        </div>
      </div>
      <p className="hint-inline" style={{ display: "block", margin: "4px 0 10px" }}>
        Customer invoices arrive here automatically from the project&apos;s tax-invoice and collection stages and are read-only — click the invoice number to open that project&apos;s billing stage. Money that is not project sales — interest, refunds, misc — is registered by hand in the second table.
      </p>
      {/* 섹션 = 프로젝트 매출(AR) / 기타 수입. 지급 목록과 같은 규칙 —
          섹션마다 표를 따로 내고 각 표 끝에 소계, 두 표 아래 전체 합계. */}
      {groups.map((g) => (
        <section className="fin-sec" key={g.key}>
          <div className="fin-sec-head">
            <h4 className="fin-sec-title">{g.title} <span className="fin-sec-sub">· {g.sub}</span></h4>
            {/* 등록 버튼은 이 버튼이 행을 만드는 표(기타 수입) 위에 둔다 — 지급 목록과 같은 규칙. */}
            {g.key === "income" && can("finance", "create") ? (
              <button className="btn primary sm" onClick={() => setAdding(true)}>+ Add income</button>
            ) : null}
          </div>
          {/* 행이 없어도 표(머리행)는 남긴다 — 어떤 항목이 들어오는 자리인지 보이도록. */}
          <table className="mini fin-ledger">
            <thead>
              <tr>
                <th className="fin-w-party">Customer</th><th>Invoice No.</th>
                <th className="fin-w-date">Invoice date</th><th className="fin-w-date">Due</th>
                <th className="num fin-w-money">Invoice</th><th className="num fin-w-money">Paid</th><th className="num fin-w-money">Outstanding</th>
                <th className="fin-w-status">Status</th><th className="fin-w-act" />
              </tr>
            </thead>
            <tbody>
              {g.rows.length === 0 ? (
                <tr><td colSpan={9} className="mini-empty">{g.empty}</td></tr>
              ) : null}
              {g.rows.map((r) => {
                const isIncome = r.source === "income";
                return (
                <tr key={`${r.source || "ar"}-${r.id}`} className={r.overdue ? "fin-overdue" : ""}>
                  <td>{r.customer}</td>
                  <td>{isIncome ? (r.invoice_no || r.ci_no || "—") : <ProjectDocLink orderId={r.order_id} rfqId={r.rfq_id} label={r.invoice_no || r.ci_no} />}</td>
                  {/* 발행일 — 9단계 대금청구서에 입력한 값. 기타 수입에는 없는 개념. */}
                  <td>{r.invoice_date || "—"}</td>
                  <td>{r.due_date || "—"}</td>
                  <td className="num">{money(r.invoice_amount, r.currency)}</td>
                  <td className="num">{money(r.paid_amount, r.currency)}</td>
                  <td className="num">{money(r.outstanding, r.currency)}</td>
                  <td>
                    {r.overdue ? (
                      <span className="wt-badge" style={{ background: "#fde2e1", color: "#c0392b" }}>Overdue</span>
                    ) : isIncome ? (
                      // 기타 수입은 이 화면에서 바로 입금 처리(실제 입금일 입력).
                      <button
                        type="button"
                        className={`wt-badge fin-paid-toggle${r.paid ? " on" : ""}`}
                        title={canEdit ? (r.paid ? "Undo receipt" : "Record receipt") : ""}
                        disabled={!canEdit}
                        onClick={() =>
                          r.recurrence !== "none"
                            ? setReceiving({ row: r, occurrence: nextUnpaidOccurrence(asPayableLike(r)) })
                            : r.paid
                              ? undoReceived(r)
                              : setReceiving({ row: r, occurrence: r.due_date })
                        }
                      >
                        {r.recurrence !== "none" ? `${(r.paid_dates || []).length} received` : r.paid ? "Received" : "Expected"}
                      </button>
                    ) : (
                      AR_STATUS_LABEL[r.status] || r.status
                    )}
                    {r.paid_date ? <span className="fin-paid-on">{r.paid_date}</span> : null}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      {isIncome ? (
                        <>
                          {can("finance", "edit") ? (
                            <button className="btn tiny" title="Edit" aria-label="Edit" onClick={() => setEditing(r)}>✎</button>
                          ) : null}
                          {can("finance", "delete") ? (
                            <button className="btn tiny danger" title="Delete" aria-label="Delete" onClick={() => removeIncome(r)}>×</button>
                          ) : null}
                        </>
                      ) : (
                        <ProjectDocLink orderId={r.order_id} rfqId={r.rfq_id} label="Project stage 9–11" hint />
                      )}
                    </div>
                  </td>
                </tr>
                );
              })}
              {(() => {
                const st = receivableTotals(g.rows);
                return (
                  <tr className="fin-group-sub">
                    <td />
                    <td className="fin-foot-name" colSpan={3}>Subtotal</td>
                    <td className="num">{byCurrency(st.invoice)}</td>
                    <td className="num">{byCurrency(st.paid)}</td>
                    <td className="num">{byCurrency(st.outstanding)}</td>
                    <td /><td />
                  </tr>
                );
              })()}
            </tbody>
          </table>
        </section>
      ))}

      {/* ── 전체 합계 — 두 표를 합친 금액. 열 폭을 위 표들과 맞춰 같은 자리에서 끝난다. ── */}
      {rows.length === 0 ? null : (
        <table className="mini fin-ledger fin-ledger-total">
          <colgroup>
            <col />
            <col className="fin-w-money" /><col className="fin-w-money" /><col className="fin-w-money" />
            <col className="fin-w-status" /><col className="fin-w-act" />
          </colgroup>
          <tfoot>
            <tr className="foot-grand fin-foot-total">
              <td className="total-label fin-foot-name">Total</td>
              <td className="num total-value">{byCurrencyLines(totals.invoice)}</td>
              <td className="num total-value">{byCurrencyLines(totals.paid)}</td>
              <td className="num total-value">{byCurrencyLines(totals.outstanding)}</td>
              <td /><td />
            </tr>
            {/* 참고용 KRW 환산 — 오늘자 매매기준율(조회 실패 시 고정환율). 집계에는 쓰지 않는다. */}
            <tr className="fin-foot-ref">
              <td className="fin-foot-name">
                Total (In KRW · 1 USD = {fx.rate.toLocaleString()}
                {fx.source === "exim" ? ` · 매매기준율 ${fx.date}` : " · fixed rate"})
              </td>
              <td className="num">{won(toKrw(totals.invoice, fx.rate))}</td>
              <td className="num">{won(toKrw(totals.paid, fx.rate))}</td>
              <td className="num">{won(toKrw(totals.outstanding, fx.rate))}</td>
              <td /><td />
            </tr>
          </tfoot>
        </table>
      )}

      {receiving ? (
        <ReceiptDateModal
          row={receiving.row}
          occurrence={receiving.occurrence}
          onClose={() => setReceiving(null)}
          onSaved={() => { setReceiving(null); reload(); }}
        />
      ) : null}
      {adding ? (
        <IncomeForm initial={emptyIncome} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />
      ) : null}
      {editing ? (
        <IncomeForm
          initial={{
            category: editing.category,
            counterparty: editing.counterparty,
            customer_id: editing.customer_id ?? null,
            description: editing.description,
            amount: editing.amount,
            currency: editing.currency,
            due_date: editing.due_date,
            recurrence: editing.recurrence,
            recur_until: editing.recur_until,
            notes: editing.notes,
          }}
          rowId={editing.id}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      ) : null}
    </div>
  );
}

// 기타 수입 등록 기본값 — 지급대장(emptyPayable)의 수입측 대응.
const emptyIncome: FinanceIncomeSave = {
  category: "잡수입",
  counterparty: "",
  customer_id: null,
  description: "",
  amount: 0,
  currency: "KRW",
  due_date: todayStr(),
  recurrence: "none",
  recur_until: "",
  notes: "",
};

/** FinanceReceivable(기타 수입 행) → 반복 회차 계산용 최소 형태. */
function asPayableLike(r: FinanceReceivable): FinancePayable {
  return {
    ...(r as unknown as FinancePayable),
    due_date: r.due_date,
    recurrence: r.recurrence ?? "none",
    recur_until: r.recur_until ?? "",
    paid_dates: r.paid_dates ?? [],
  };
}

/** 입금 기록 — 예정일과 실제 입금일이 다를 수 있어 둘 다 받는다(납부 팝업과 동일). */
function ReceiptDateModal({
  row,
  occurrence,
  onClose,
  onSaved,
}: {
  row: FinanceReceivable;
  occurrence: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const recurring = (row.recurrence ?? "none") !== "none";
  const [occ, setOcc] = useState(occurrence || row.due_date || todayStr());
  const [paidOn, setPaidOn] = useState(todayStr());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    setBusy(true);
    setErr("");
    try {
      await receiveFinanceIncome(row.id, true, recurring ? occ : undefined, paidOn);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
      setBusy(false);
    }
  }

  return (
    <Modal title="Record receipt" onClose={onClose} form maxWidth={340}>
      <div className="fin-pay-form">
        <div className="fin-pay-target">
          {row.description || row.counterparty || row.customer} · {money(row.invoice_amount, row.currency)}
        </div>
        {recurring ? (
          <label className="form-field">
            <span>Scheduled occurrence</span>
            <input type="date" value={occ} onChange={(e) => setOcc(e.target.value)} />
          </label>
        ) : (
          <div className="hint-inline">Expected {row.due_date || "—"}</div>
        )}
        <label className="form-field">
          <span>Receipt date</span>
          <input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </label>
      </div>
      <div className="form-actions">
        {err ? <span className="action-err">{err}</span> : null}
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy || !paidOn}>
          {busy ? "Saving…" : "Mark received"}
        </button>
      </div>
    </Modal>
  );
}

/** 기타 수입 등록/수정 폼 — 지급대장 PayableForm 의 수입측 대응. */
function IncomeForm({
  initial,
  rowId,
  onClose,
  onSaved,
}: {
  initial: FinanceIncomeSave;
  rowId?: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FinanceIncomeSave>({ ...initial });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = <K extends keyof FinanceIncomeSave>(k: K, v: FinanceIncomeSave[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setBusy(true);
    setErr("");
    try {
      if (rowId) await updateFinanceIncome(rowId, form);
      else await createFinanceIncome(form);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
      setBusy(false);
    }
  }

  return (
    <Modal title={rowId ? "Edit income" : "Add income"} onClose={onClose} form>
      <div className="form-grid">
        <label className="form-field">
          <span>Category</span>
          <select value={form.category} onChange={(e) => set("category", e.target.value)}>
            {INCOME_CATEGORIES.map((c) => (
              <option key={c} value={c}>{INCOME_CATEGORY_LABEL[c] || c}</option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span>Payer</span>
          <input value={form.counterparty || ""} onChange={(e) => set("counterparty", e.target.value)} />
        </label>
        <label className="form-field">
          <span>Description</span>
          <input value={form.description || ""} onChange={(e) => set("description", e.target.value)} />
        </label>
        <label className="form-field">
          <span>Amount</span>
          <input
            inputMode="decimal"
            value={amountInputValue(form.amount ?? 0)}
            onChange={(e) => set("amount", parseAmountInput(e.target.value) ?? 0)}
          />
        </label>
        <label className="form-field">
          <span>Currency</span>
          <CurrencyToggle value={form.currency || "KRW"} onChange={(v) => set("currency", v)} />
        </label>
        <label className="form-field">
          <span>Expected date</span>
          <input type="date" value={form.due_date || ""} onChange={(e) => set("due_date", e.target.value)} />
        </label>
        <label className="form-field">
          <span>Recurrence</span>
          <select
            value={form.recurrence}
            onChange={(e) => set("recurrence", e.target.value as FinanceIncomeSave["recurrence"])}
          >
            {(["none", "monthly", "quarterly", "yearly"] as const).map((r) => (
              <option key={r} value={r}>{RECURRENCE_LABEL[r]}</option>
            ))}
          </select>
        </label>
        {form.recurrence !== "none" ? (
          <label className="form-field">
            <span>Repeat until (optional)</span>
            <input type="date" value={form.recur_until || ""} onChange={(e) => set("recur_until", e.target.value)} />
          </label>
        ) : null}
        <label className="form-field" style={{ gridColumn: "1 / -1" }}>
          <span>Notes</span>
          <textarea className="po-textarea small" value={form.notes || ""} onChange={(e) => set("notes", e.target.value)} />
        </label>
      </div>
      <div className="form-actions">
        {err ? <span className="action-err">{err}</span> : null}
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </Modal>
  );
}

// ── Payables (payment ledger) ──────────────────────────────────────────────────
// 등록 버튼이 기타 지출 섹션에 있으므로 기본 분류도 기타 — 거래선지급은 대개
// 프로젝트에서 자동으로 넘어오고, 직접 넣을 때만 분류를 바꾼다.
const emptyPayable: FinancePayableSave = {
  category: "기타",
  counterparty: "",
  vendor_id: null,
  description: "",
  amount: 0,
  currency: "KRW",
  bill_date: "",
  due_date: todayStr(),
  recurrence: "none",
  recur_until: "",
  notes: "",
};

function PayablesTab() {
  const { data, error, refresh } = useCachedData<{ rows: FinancePayable[]; fx: FxQuote }>("finance:payables", fetchFinancePayables);
  const [editing, setEditing] = useState<FinancePayable | null>(null);
  const [adding, setAdding] = useState(false);
  // 납부 입력 대상 — 회차일(occurrence)과 실제 납부일을 함께 받는다.
  const [paying, setPaying] = useState<{ row: FinancePayable; occurrence: string } | null>(null);
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const canEdit = can("finance", "create") || can("finance", "edit");
  // 거래(매입) / 기타 지출 두 섹션 — 성격이 다르고 다루는 항목도 달라서 표를 따로 낸다.
  // 벤더 청구서는 프로젝트에서 넘어온 읽기전용(청구서번호·발행일 중심), 기타 지출은
  // 여기서 직접 등록하는 항목(분류·반복 중심)이라 열 구성이 서로 맞지 않는다.
  const [trade, other] = useMemo(() => {
    const isTrade = (p: FinancePayable) => p.source === "ap" || p.category === "거래선지급";
    return [rows.filter(isTrade), rows.filter((p) => !isTrade(p))];
  }, [rows]);
  // 합계 3열(청구·지급·미지급) — 통화별 분리(미수 목록과 같은 규칙).
  const totals = useMemo(() => payableTotals(rows), [rows]);

  function reload() {
    invalidateCache("finance:summary");
    invalidateCache("finance:calendar");
    return refresh();
  }

  // 납부 처리는 항상 실제 납부일을 받는다(예정일과 다를 수 있음). 취소는 바로 해제.
  async function undoPaid(p: FinancePayable, occurrence?: string) {
    await payFinancePayable(p.id, false, occurrence);
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
  const tradeSt = payableTotals(trade);
  const otherSt = payableTotals(other);

  /** 상태 칸 — 두 표가 공유. AP(프로젝트 유래)는 읽기전용 배지, 수동 등록은 납부 토글. */
  function statusCell(p: FinancePayable) {
    const isAp = p.source === "ap";
    return (
      <td>
        {isAp ? (
          // 벤더 청구서도 기타 지출과 같은 Paid/Unpaid 칩으로 보여준다 — 다만 지급 기록은
          // 프로젝트 11단계 AP 탭의 Payment 칸에서 하므로 여기서는 누를 수 없다.
          <button
            type="button"
            className={`wt-badge fin-paid-toggle${p.paid ? " on" : ""}`}
            title="Record the payment in the project's stage 11 Payable (AP)"
            disabled
          >
            {p.paid ? "Paid" : p.paid_amount > 0 ? "Partly paid" : "Unpaid"}
          </button>
        ) : p.recurrence === "none" ? (
          <button
            type="button"
            className={`wt-badge fin-paid-toggle${p.paid ? " on" : ""}`}
            title={canEdit ? (p.paid ? "Undo payment" : "Record payment") : ""}
            disabled={!canEdit}
            onClick={() => (p.paid ? undoPaid(p) : setPaying({ row: p, occurrence: p.due_date }))}
          >
            {p.paid ? "Paid" : "Unpaid"}
          </button>
        ) : (
          <button
            type="button"
            className="wt-badge fin-paid-toggle"
            title={canEdit ? "Record a payment for one occurrence" : ""}
            disabled={!canEdit}
            onClick={() => setPaying({ row: p, occurrence: nextUnpaidOccurrence(p) })}
          >
            {p.paid_dates.length} paid
          </button>
        )}
        {/* 지급 완료 건은 실제 납부일을 상태 옆에 함께 보여준다(미수 목록과 동일). */}
        {p.paid_date ? <span className="fin-paid-on">{p.paid_date}</span> : null}
      </td>
    );
  }

  /** 반복 칸 — 수동 등록 항목의 주기(+종료일). AP 는 1회성이라 그대로 One-time. */
  function recurrenceCell(p: FinancePayable) {
    return (
      <td>
        {RECURRENCE_LABEL[p.recurrence] || p.recurrence}
        {p.recurrence !== "none" && p.recur_until ? <div className="muted">until {p.recur_until}</div> : null}
      </td>
    );
  }

  /** 조작 칸 — AP 는 프로젝트 단계로 가는 안내 링크, 수동 등록은 수정/삭제 아이콘. */
  function actionCell(p: FinancePayable) {
    return (
      <td>
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          {p.source === "ap" ? (
            <ProjectDocLink orderId={p.order_id} rfqId={p.rfq_id} label="Project stage 11" hint apPoId={p.po_id} />
          ) : (
            <>
              {can("finance", "edit") ? (
                <button className="btn tiny" title="Edit" aria-label="Edit" onClick={() => setEditing(p)}>✎</button>
              ) : null}
              {can("finance", "delete") ? (
                <button className="btn tiny danger" title="Delete" aria-label="Delete" onClick={() => remove(p)}>×</button>
              ) : null}
            </>
          )}
        </div>
      </td>
    );
  }

  return (
    <div className="panel">
      <div className="items-head">
        <h3 className="form-title fin-page-title" style={{ margin: 0 }}>Payables</h3>
      </div>
      <p className="hint-inline" style={{ display: "block", margin: "4px 0 10px" }}>
        Vendor bills arrive here automatically from the project&apos;s billing stages and are read-only — click the bill number to open that project&apos;s stage 11 Payable (AP), where the payment is confirmed. The company&apos;s own costs — rent, payroll, utilities, taxes — are registered by hand in the second table; monthly/quarterly/yearly items appear as occurrences on the calendar.
      </p>

      {/* ── 거래 매입 — 프로젝트에서 넘어온 벤더 청구서(읽기전용). ─────────────── */}
      <section className="fin-sec">
        <div className="fin-sec-head">
          {/* 제목은 굵게, 어떤 항목이 들어오는지 설명하는 뒷부분은 옅게. */}
          <h4 className="fin-sec-title">Trade purchases <span className="fin-sec-sub">· vendor bills</span></h4>
        </div>
        {/* 행이 없어도 표(머리행)는 남긴다 — 어떤 항목이 들어오는 자리인지 보이도록. */}
        <table className="mini fin-ledger">
          <thead>
            <tr>
              <th className="fin-w-cat">Category</th><th className="fin-w-party">Vendor</th><th>Bill No. / Vendor P/O</th><th className="fin-w-date">Bill date</th><th className="fin-w-date">Due</th>
              <th className="num fin-w-money">Bill</th><th className="num fin-w-money">Paid</th><th className="num fin-w-money">Outstanding</th>
              <th className="fin-w-status">Status</th><th className="fin-w-rec">Recurrence</th><th className="fin-w-act" />
            </tr>
          </thead>
          <tbody>
            {trade.length === 0 ? (
              <tr><td colSpan={11} className="mini-empty">No vendor bills yet.</td></tr>
            ) : null}
            {trade.map((p) => (
              <tr key={`${p.source || "manual"}-${p.id}`}>
                <td>{CATEGORY_LABEL[p.category] || p.category}</td>
                <td>{p.counterparty || "—"}</td>
                {/* 청구서 번호 = 미수 목록의 Invoice No. 자리. AP 행은 그 아래 벤더 P/O 를
                    옅게 덧붙인다(번호가 아직 없으면 P/O 만 보인다). 수동 등록은 적요. */}
                <td>
                  {p.source === "ap" ? (
                    <>
                      <ProjectDocLink orderId={p.order_id} rfqId={p.rfq_id} label={p.description} apPoId={p.po_id} />
                      {p.po_no && p.po_no !== p.description ? <div className="muted">{p.po_no}</div> : null}
                    </>
                  ) : (
                    p.description || "—"
                  )}
                </td>
                <td>{p.bill_date || "—"}</td>
                <td>{p.due_date || "—"}</td>
                <td className="num">{money(p.invoice_amount, p.currency)}</td>
                <td className="num">{money(p.paid_amount, p.currency)}</td>
                <td className="num">{money(p.outstanding, p.currency)}</td>
                {statusCell(p)}
                {recurrenceCell(p)}
                {actionCell(p)}
              </tr>
            ))}
            <tr className="fin-group-sub">
              <td />
              <td className="fin-foot-name" colSpan={4}>Subtotal</td>
              <td className="num">{byCurrency(tradeSt.invoice)}</td>
              <td className="num">{byCurrency(tradeSt.paid)}</td>
              <td className="num">{byCurrency(tradeSt.outstanding)}</td>
              <td /><td /><td />
            </tr>
          </tbody>
        </table>
      </section>

      {/* ── 기타 지출 — 여기서 직접 등록하는 항목. 열 구성은 등록 폼의 입력칸과 1:1. ── */}
      <section className="fin-sec">
        <div className="fin-sec-head">
          <h4 className="fin-sec-title">Other costs <span className="fin-sec-sub">· rent, payroll, utilities, taxes</span></h4>
          {can("finance", "create") ? (
            <button className="btn primary sm" onClick={() => setAdding(true)}>+ Add payable</button>
          ) : null}
        </div>
        {/* 행이 없어도 표(머리행)는 남긴다 — 등록 버튼이 무엇을 만드는지 열 이름으로 보인다. */}
        <table className="mini fin-ledger">
          <thead>
            {/* 열 자리는 위 표와 동일 — 이름만 이 표의 항목에 맞춘다(등록 폼의 입력칸과 1:1). */}
            <tr>
              <th className="fin-w-cat">Category</th><th className="fin-w-party">Vendor / payee</th><th>Description</th><th className="fin-w-date">Bill date</th><th className="fin-w-date">Due</th>
              <th className="num fin-w-money">Amount</th><th className="num fin-w-money">Paid</th><th className="num fin-w-money">Outstanding</th>
              <th className="fin-w-status">Status</th><th className="fin-w-rec">Recurrence</th><th className="fin-w-act" />
            </tr>
          </thead>
          <tbody>
            {other.length === 0 ? (
              <tr><td colSpan={11} className="mini-empty">No other costs registered.</td></tr>
            ) : null}
            {other.map((p) => (
              <tr key={`${p.source || "manual"}-${p.id}`}>
                <td>{CATEGORY_LABEL[p.category] || p.category}</td>
                <td>{p.counterparty || "—"}</td>
                {/* 메모는 별도 열까지 둘 만큼 길지 않아 적요 아래 옅게 붙인다. */}
                <td>
                  {p.description || "—"}
                  {p.notes ? <div className="muted">{p.notes}</div> : null}
                </td>
                <td>{p.bill_date || "—"}</td>
                <td>{p.due_date || "—"}</td>
                <td className="num">{money(p.invoice_amount, p.currency)}</td>
                <td className="num">{money(p.paid_amount, p.currency)}</td>
                <td className="num">{money(p.outstanding, p.currency)}</td>
                {statusCell(p)}
                {recurrenceCell(p)}
                {actionCell(p)}
              </tr>
            ))}
            <tr className="fin-group-sub">
              <td />
              <td className="fin-foot-name" colSpan={4}>Subtotal</td>
              <td className="num">{byCurrency(otherSt.invoice)}</td>
              <td className="num">{byCurrency(otherSt.paid)}</td>
              <td className="num">{byCurrency(otherSt.outstanding)}</td>
              <td /><td /><td />
            </tr>
          </tbody>
        </table>
      </section>

      {/* ── 전체 합계 — 두 표를 합친 금액. 열 폭을 위 표들과 맞춰 같은 자리에서 끝난다. ── */}
      {rows.length === 0 ? null : (
        <table className="mini fin-ledger fin-ledger-total">
          <colgroup>
            <col />
            <col className="fin-w-money" /><col className="fin-w-money" /><col className="fin-w-money" />
            <col className="fin-w-status" /><col className="fin-w-rec" /><col className="fin-w-act" />
          </colgroup>
          <tfoot>
            <tr className="foot-grand fin-foot-total">
              <td className="total-label fin-foot-name">Total</td>
              <td className="num total-value">{byCurrencyLines(totals.invoice)}</td>
              <td className="num total-value">{byCurrencyLines(totals.paid)}</td>
              <td className="num total-value">{byCurrencyLines(totals.outstanding)}</td>
              <td /><td /><td />
            </tr>
            {/* 참고용 KRW 환산 — 오늘자 매매기준율(조회 실패 시 고정환율). 집계에는 쓰지 않는다. */}
            <tr className="fin-foot-ref">
              <td className="fin-foot-name">
                Total (In KRW · 1 USD = {fx.rate.toLocaleString()}
                {fx.source === "exim" ? ` · 매매기준율 ${fx.date}` : " · fixed rate"})
              </td>
              <td className="num">{won(toKrw(totals.invoice, fx.rate))}</td>
              <td className="num">{won(toKrw(totals.paid, fx.rate))}</td>
              <td className="num">{won(toKrw(totals.outstanding, fx.rate))}</td>
              <td /><td /><td />
            </tr>
          </tfoot>
        </table>
      )}

      {paying ? (
        <PaymentDateModal
          row={paying.row}
          occurrence={paying.occurrence}
          onClose={() => setPaying(null)}
          onSaved={() => { setPaying(null); reload(); }}
        />
      ) : null}
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

/** 지급 목록 합계 — 청구·지급·미지급 3열을 통화별로 모은다. */
function payableTotals(rows: FinancePayable[]) {
  const t = { invoice: {} as MoneyByCurrency, paid: {} as MoneyByCurrency, outstanding: {} as MoneyByCurrency };
  for (const p of rows) {
    t.invoice[p.currency] = (t.invoice[p.currency] || 0) + p.invoice_amount;
    t.paid[p.currency] = (t.paid[p.currency] || 0) + p.paid_amount;
    t.outstanding[p.currency] = (t.outstanding[p.currency] || 0) + p.outstanding;
  }
  return t;
}

/** 반복 항목의 다음 미납 회차일 — due_date 에서 주기만큼 더해가며 첫 미납 회차를 찾는다. */
function nextUnpaidOccurrence(p: FinancePayable): string {
  const step = p.recurrence === "monthly" ? 1 : p.recurrence === "quarterly" ? 3 : 12;
  const paid = new Set(p.paid_dates || []);
  const first = p.due_date || todayStr();
  const [y, m, d] = first.split("-").map(Number);
  for (let i = 0; i < 60; i += 1) {
    const dt = new Date(y, m - 1 + step * i, 1);
    // 말일 보정 — 그 달에 없는 날짜(31일 등)는 말일로 맞춘다(서버 규칙과 동일).
    const last = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
    dt.setDate(Math.min(d, last));
    const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    if (p.recur_until && iso > p.recur_until) break;
    if (!paid.has(iso)) return iso;
  }
  return first;
}

/** 납부 기록 — 예정일(회차일)과 실제 납부일이 다를 수 있어 둘 다 받는다. */
function PaymentDateModal({
  row,
  occurrence,
  onClose,
  onSaved,
}: {
  row: FinancePayable;
  occurrence: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const recurring = row.recurrence !== "none";
  const [occ, setOcc] = useState(occurrence || row.due_date || todayStr());
  const [paidOn, setPaidOn] = useState(todayStr());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    setBusy(true);
    setErr("");
    try {
      await payFinancePayable(row.id, true, recurring ? occ : undefined, paidOn);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
      setBusy(false);
    }
  }

  return (
    <Modal title="Record payment" onClose={onClose} form maxWidth={340}>
      <div className="fin-pay-form">
        <div className="fin-pay-target">
          {row.description || row.counterparty || "—"} · {money(row.amount, row.currency)}
        </div>
        {recurring ? (
          <label className="form-field">
            <span>Scheduled occurrence</span>
            <input type="date" value={occ} onChange={(e) => setOcc(e.target.value)} />
          </label>
        ) : (
          <div className="hint-inline">Scheduled {row.due_date || "—"}</div>
        )}
        <label className="form-field">
          <span>Payment date</span>
          <input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </label>
      </div>
      <div className="form-actions">
        {err ? <span className="action-err">{err}</span> : null}
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy || !paidOn}>
          {busy ? "Saving…" : "Mark paid"}
        </button>
      </div>
    </Modal>
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
          <span>Vendor / payee</span>
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
          {/* 고지서·계산서를 받은 날(선택). 벤더 청구서의 발행일과 같은 뜻이라 목록에서 한 열에 모인다. */}
          <span>Bill date (optional)</span>
          <input type="date" value={form.bill_date || ""} onChange={(e) => set("bill_date", e.target.value)} />
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
  const [includePo, setIncludePo] = useState(false);
  // 잔고 곡선은 한 통화 안에서만 의미가 있으므로 환산 대신 통화를 골라 본다.
  const [currency, setCurrency] = useState("KRW");
  // 기초잔고는 통화별로 따로 기억한다 — 하나만 두면 ₩ 로 넣은 값이 $ 로 바꾼 순간
  // 그대로 달러로 읽혀(5천만원 → $50,000,000) 잔고 곡선 전체가 엉뚱해진다.
  const [openingByCur, setOpeningByCur] = useState<Record<string, string>>({ KRW: "0", USD: "0" });
  const openingInput = openingByCur[currency] ?? "0";
  const setOpeningInput = (v: string) => setOpeningByCur((m) => ({ ...m, [currency]: v }));
  const opening = Number(openingInput) || 0;
  const cash = (n: number) => money(n, currency);

  const key = `finance:cashflow:${unit}:${count}:${opening}:${includePo}:${currency}`;
  const { data, error } = useCachedData<FinanceCashflow>(key, () => fetchFinanceCashflow(unit, count, opening, includePo, currency));

  const maxNet = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, ...data.rows.map((r) => Math.abs(r.net)));
  }, [data]);

  // 기초잔고 기준일 = 첫 구간 시작일. 응답이 오기 전에도 라벨을 띄워야 해서
  // 서버(_cashflow_buckets)와 같은 규칙으로 미리 계산하고, 오면 응답 값으로 맞춘다.
  const openingAsOf = data?.opening_as_of ?? (() => {
    const d = new Date();
    const first = unit === "month" ? new Date(d.getFullYear(), d.getMonth(), 1) : d;
    return `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}-${String(first.getDate()).padStart(2, "0")}`;
  })();

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
          {/* 기준일을 라벨에 박아 둔다 — 첫 구간이 이번 달 1일부터라 '오늘 잔고'를 넣으면
              이번 달에 이미 오간 돈이 두 번 세어진다. */}
          Opening balance ({sym(currency).trim()}) <span className="muted">as of {openingAsOf}</span>
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
            <KpiTile
              label="Inflow"
              main={cash(data.total_inflow)}
              sub={data.actual_inflow ? `${cash(data.actual_inflow)} already received` : "all still expected"}
              tone="blue"
            />
            <KpiTile
              label="Outflow"
              main={cash(data.total_outflow)}
              sub={data.actual_outflow ? `${cash(data.actual_outflow)} already paid` : "all still scheduled"}
              tone="amber"
            />
            <KpiTile label="Ending balance" main={cash(data.ending)} sub={`Opening ${cash(data.opening)} · ${openingAsOf}`} tone={data.ending >= 0 ? "blue" : "red"} />
          </div>

          <div className="panel">
            <h3 className="form-title">Net cash flow ({sym(currency).trim()})</h3>
            <div className="fin-net-chart">
              {data.rows.map((r) => (
                <div key={r.label} className="fin-net-col" title={`${r.label} · Inflow ${cash(r.inflow)}${r.actual_inflow ? ` (${cash(r.actual_inflow)} received)` : ""} · Outflow ${cash(r.outflow)}${r.actual_outflow ? ` (${cash(r.actual_outflow)} paid)` : ""} · Net ${cash(r.net)}`}>
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
            <h3 className="form-title">Cash flow</h3>
            <table className="mini">
              <thead>
                <tr><th>Period</th><th className="num">Inflow</th><th className="num">Outflow</th><th className="num">Net</th><th className="num">Cumulative</th></tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.label} className={r.cumulative < 0 ? "fin-overdue" : ""}>
                    <td>{r.label}</td>
                    {/* 이미 오간 부분은 금액 아래 옅게 덧붙인다 — 같은 칸의 나머지가 예정분. */}
                    <td className="num">
                      {cash(r.inflow)}
                      {r.actual_inflow ? <div className="fin-cf-actual">{cash(r.actual_inflow)} received</div> : null}
                    </td>
                    <td className="num">
                      {cash(r.outflow)}
                      {r.actual_outflow ? <div className="fin-cf-actual">{cash(r.actual_outflow)} paid</div> : null}
                    </td>
                    <td className="num" style={{ color: r.net >= 0 ? "#1e7a46" : "#c0392b" }}>{r.net >= 0 ? "+" : "−"}{cash(Math.abs(r.net))}</td>
                    <td className="num"><b>{cash(r.cumulative)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint-inline" style={{ display: "block", marginTop: 8 }}>
              Each period mixes money already moved (shown in grey under the amount, dated on the day it actually arrived or left) with money still expected — receivables by due date and unpaid payable occurrences{includePo ? " + vendor POs (estimated from order date)" : ""}. So the opening balance must be your balance on {openingAsOf}, not today&apos;s. Only {currency} items are counted — switch the currency toggle for the other book; nothing is converted. Overdue / past-due items fall into the first period. A negative cumulative balance (red) marks a cash shortfall.
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

  // 프로젝트 단계에서 관리하는 청구·수금(AR/AP)은 캘린더에서 못 누른다 — 눌리는 것처럼
  // 보이지 않게 커서·호버를 죽인다(수금은 원래 그랬고, 지급도 같은 규칙).
  const readOnlyEvent = (e: FinanceCalendarEvent) =>
    e.kind === "receivable" || e.source === "ap" || !can("finance", "edit");

  // 납부 처리는 실제 납부일을 받아야 하므로 입력창을 띄운다(해제는 즉시).
  const [payingEvent, setPayingEvent] = useState<FinanceCalendarEvent | null>(null);
  const [paidOn, setPaidOn] = useState(todayStr());

  async function togglePayable(e: FinanceCalendarEvent) {
    if (e.kind !== "payable" || !can("finance", "edit")) return;
    if (e.source === "ap") return;   // 매입(AP) 이벤트는 읽기전용(프로젝트 단계에서 관리)
    if (!e.paid) {
      setPaidOn(todayStr());
      setPayingEvent(e);
      return;
    }
    await payFinancePayable(e.ref_id, false, e.occurrence ?? undefined);
    invalidateCache("finance:summary");
    invalidateCache("finance:payables");
    refresh();
  }

  async function confirmPay() {
    const e = payingEvent;
    if (!e) return;
    await payFinancePayable(e.ref_id, true, e.occurrence ?? undefined, paidOn);
    setPayingEvent(null);
    invalidateCache("finance:summary");
    invalidateCache("finance:payables");
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
        {/* 좌: 이번 달로 돌아오는 단추 하나 / 중앙: 화살표가 달을 양옆에서 감싼다 / 우: 범례.
            보고 있는 달이 이번 달이면 Today는 갈 곳이 없으므로 눌리지 않게 둔다. */}
        <div className="fin-cal-today">
          <button
            className="btn sm"
            disabled={month.y === new Date().getFullYear() && month.m === new Date().getMonth()}
            onClick={() => setMonth(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; })}
          >Today</button>
        </div>
        <div className="fin-cal-nav">
          <button className="btn sm fin-cal-arrow" onClick={() => shift(-1)} aria-label="Previous month">‹</button>
          <h3 className="form-title fin-cal-month">{monthLabel}</h3>
          <button className="btn sm fin-cal-arrow" onClick={() => shift(1)} aria-label="Next month">›</button>
        </div>
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
                    className={`fin-ev fin-ev--${e.kind}${e.overdue ? " overdue" : ""}${e.paid ? " paid" : ""}${e.actual ? " actual" : ""}${readOnlyEvent(e) ? " readonly" : ""}`}
                    title={
                      e.actual
                        // 수금은 '납부'가 아니라 '입금'이다 — 방향에 맞는 말로 표기.
                        ? `${e.kind === "receivable" ? "Received" : "Paid"} ${e.paid_on} · ${e.title} · ${money(e.amount, e.currency)}${
                            e.scheduled ? ` (due ${e.scheduled})` : ""
                          }`
                        : `${e.kind === "receivable" ? "Receivable" : "Payable"} · ${e.title} · ${money(e.amount, e.currency)}${
                            e.paid ? ` (paid${e.paid_on ? ` ${e.paid_on}` : ""})` : ""
                          }${e.source === "ap" ? " — recorded in the project's stage 11 Payable (AP)" : ""}`
                    }
                    onClick={() => togglePayable(e)}
                  >
                    {/* 실제 납부일 자리에 찍힌 이벤트는 체크로 구분(예정일 이벤트는 취소선). */}
                    <span className="fin-ev-title">{e.actual ? `✓ ${e.title}` : e.title}</span>
                    <span className="fin-ev-amt">{money(e.amount, e.currency)}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <p className="hint-inline" style={{ display: "block", marginTop: 8 }}>
        Every item sits on its scheduled date until it settles, then appears again (✓) on the day the money actually moved. Click one of your own costs to record its payment — you enter the date it was really paid, which may differ from the scheduled date (recurring items settle one occurrence at a time); click a paid one to undo. Customer invoices (AR) and vendor bills (AP) are managed from the project stages instead — both on stage 11, the Receivable tab for collections and the Payable tab for vendor payments.
      </p>
      {payingEvent ? (
        <Modal title="Record payment" onClose={() => setPayingEvent(null)} form maxWidth={340}>
          <div className="fin-pay-form">
            <div className="fin-pay-target">
              {payingEvent.title} · {money(payingEvent.amount, payingEvent.currency)}
            </div>
            <div className="hint-inline">Scheduled {payingEvent.occurrence || payingEvent.date}</div>
            <label className="form-field">
              <span>Payment date</span>
              <input type="date" value={paidOn} onChange={(ev) => setPaidOn(ev.target.value)} />
            </label>
          </div>
          <div className="form-actions">
            <button className="btn" onClick={() => setPayingEvent(null)}>Cancel</button>
            <button className="btn primary" onClick={confirmPay} disabled={!paidOn}>Mark paid</button>
          </div>
        </Modal>
      ) : null}
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
