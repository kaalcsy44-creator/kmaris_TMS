"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createArRecord,
  completeOrderStage,
  deleteArRecord,
  fetchArOverview,
  fetchDocumentDetail,
  fetchPoWorkOptions,
  recordArPayment,
  updateArRecord,
} from "@/lib/api";
import { can, canEditDeal, editBlockReason } from "@/lib/auth";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import type { ArRow, DocumentDetail, PoWorkOptions } from "@/lib/types";
import { tr } from "@/lib/labels";
import Modal from "@/components/common/Modal";
import { ModalTitle } from "@/components/common/BaseMeta";
import CurrencyToggle from "@/components/common/CurrencyToggle";
import { dualCurrencyText } from "@/components/common/itemTable";

const today = () => new Date().toISOString().slice(0, 10);

/** 현재 로컬(KST) 벽시계를 datetime-local 입력 형식 'YYYY-MM-DDTHH:MM' 으로. */
const nowLocal = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

type ArForm = {
  id: number;
  order_id: number | "";
  ci_no: string;
  invoice_amount: number;
  paid_amount: number;
  currency: string;
  due_date: string;
  status: string;
  notes: string;
};

const emptyForm: ArForm = {
  id: 0,
  order_id: "",
  ci_no: "",
  invoice_amount: 0,
  paid_amount: 0,
  currency: "USD",
  due_date: today(),
  status: "미수",
  notes: "",
};

type StageTab = 10 | 11;

// 프로젝트 팝업(진행현황) 내 AR 작업 — 이 오더의 세금계산서 발행(10)·수금 완료(11)를
// 인라인으로 편집한다. 전역 목록·SOA 내보내기는 진행현황 통합 목록으로 이전됨.
export function ArOverview({
  initialOrderId = null,
  initialStage = null,
}: {
  initialOrderId?: number | null;
  initialStage?: StageTab | null;
} = {}) {
  const { data, refresh } = useCachedData("ar:overview", fetchArOverview);
  const { data: options } = useCachedData("ar:workoptions", fetchPoWorkOptions);
  const [stageTab, setStageTab] = useState<StageTab>(initialStage === 11 ? 11 : 10);
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const orderId = initialOrderId ?? null;

  // 딥링크 단계(?stage=10|11) 변화 시 탭 동기화.
  useEffect(() => {
    if (initialStage === 11) setStageTab(11);
    else if (initialStage === 10) setStageTab(10);
  }, [initialStage]);

  function load() {
    invalidateCache("dashboard");
    invalidateCache("pipeline");
    return refresh();
  }

  if (!data) return <div className="state">Loading details…</div>;
  const match = orderId ? rows.find((r) => r.order_id === orderId) : undefined;
  if (!match) {
    if (!orderId) {
      return (
        <div className="project-work-panel">
          <div className="project-work-empty">
            Register the Customer P/O (stage 5) first — AR is tracked against an order.
          </div>
        </div>
      );
    }
    return (
      <div className="embedded-detail">
        <div className="form-section-title" style={{ marginTop: 0 }}>Add AR record</div>
        <ArAddForm options={options ?? null} fallbackOrderId={orderId} onChanged={load} />
      </div>
    );
  }
  return (
    <div className="action-tabs embedded">
      {stageTab === 10 ? (
        <TaxIssueModal row={match} onChanged={load} onClose={load} inline />
      ) : (
        <PaymentModal row={match} onChanged={load} onClose={load} inline />
      )}
    </div>
  );
}

/** Fetches order/document detail to show key deal info (shared popup header). */
function OrderInfoBlock({
  orderId,
  detail,
}: {
  orderId: number;
  detail?: DocumentDetail | null;
}) {
  const [fetched, setFetched] = useState<DocumentDetail | null>(null);
  const d = detail ?? fetched;

  useEffect(() => {
    if (detail !== undefined) return; // parent passes detail directly → skip fetch
    let alive = true;
    fetchDocumentDetail(orderId)
      .then((x) => alive && setFetched(x))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [orderId, detail]);

  if (!d) return null;
  return (
    <dl className="intl-meta" style={{ margin: "0 0 14px" }}>
      <div><dt>Project No.</dt><dd><b>{d.order.project_no || "—"}</b></dd></div>
      <div><dt>First RFQ at</dt><dd>{(d.order.first_rfq_at || "").replace("T", " ") || "—"}</dd></div>
      <div><dt>Type</dt><dd>{tr(d.order.work_type) || "—"}</dd></div>
      <div><dt>Trade type</dt><dd>{tr(d.order.trade_type) || "—"}</dd></div>
      <div><dt>Project</dt><dd>{d.order.project_title || "—"}</dd></div>
      <div><dt>Customer</dt><dd>{d.order.customer || "—"}</dd></div>
      <div><dt>Vendor</dt><dd>{d.order.vendor || "—"}</dd></div>
      <div><dt>Vessel</dt><dd>{d.order.vessel || "—"}</dd></div>
      <div><dt>PO No.</dt><dd>{d.order.po_no || "—"}</dd></div>
      <div><dt>Items</dt><dd>{d.order.items.length}</dd></div>
      <div><dt>Customer Tax ID</dt><dd>{d.order.customer_tax_id || "—"}</dd></div>
    </dl>
  );
}

function ciTotal(d: DocumentDetail | null): number {
  if (!d?.ci?.items) return 0;
  return d.ci.items.reduce((s, it) => s + num(it.amount), 0);
}

/** 10) Issue Tax Invoice — save billing details, then complete stage 10. */
function TaxIssueModal({
  row,
  onChanged,
  onClose,
  inline,
}: {
  row: ArRow;
  onChanged: () => void;
  onClose: () => void;
  inline?: boolean;
}) {
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [ciNo, setCiNo] = useState(row.ci_no);
  const [invoice, setInvoice] = useState(row.invoice_amount);
  const [currency, setCurrency] = useState(row.currency);
  const [dueDate, setDueDate] = useState(row.due_date || today());
  const [notes, setNotes] = useState(row.notes);
  const [issuedAt, setIssuedAt] = useState(row.tax_issued_date || nowLocal());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 편집 권한 = 역할 권한(ar.edit) × 담당(PIC) 소유권. 없으면 읽기전용.
  const canEditThis = can("ar", "edit") && canEditDeal(row.assignee_id);
  const canDeleteThis = can("ar", "delete") && canEditDeal(row.assignee_id);

  // Fetch order/CI detail to auto-fill empty fields (user input is preserved).
  useEffect(() => {
    let alive = true;
    fetchDocumentDetail(row.order_id)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        setCiNo((v) => v || d.ci?.ci_no || "");
        setCurrency((v) => v || d.ci?.currency || "USD");
        setInvoice((v) => (v ? v : ciTotal(d)));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [row.order_id]);

  async function save(complete: boolean) {
    setBusy(true);
    setErr(null);
    try {
      await updateArRecord(row.id, {
        order_id: row.order_id,
        ci_no: ciNo,
        invoice_amount: invoice,
        paid_amount: row.paid_amount,
        currency,
        due_date: dueDate,
        status: row.status,
        notes,
      });
      await completeOrderStage(row.order_id, 10, complete, complete ? issuedAt : undefined);
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm("Delete this AR record?")) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteArRecord(row.id);
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={<ModalTitle label={`Issue Tax Invoice — ${row.ci_no || "AR"}`} projectNo={row.project_no} />} onClose={onClose} wide inline={inline}>
      {!inline ? <OrderInfoBlock orderId={row.order_id} detail={detail} /> : null}
      <div className="milestone-row" style={{ marginBottom: 12 }}>
        <span className={`ar-badge${row.tax_issued ? "" : " overdue"}`}>
          {row.tax_issued ? `Issued (${row.tax_issued_date || "done"})` : "Not issued"}
        </span>
      </div>
      <fieldset className="form-fieldset" disabled={!canEditThis}>
        <div className="form-grid">
          <Field label="CI No." value={ciNo} onChange={setCiNo} />
          <Field label="Invoice amount" value={String(invoice)} onChange={(v) => setInvoice(num(v))} type="number" />
          <label className="form-field">
            <span>Currency</span>
            <CurrencyToggle value={currency} onChange={setCurrency} />
          </label>
          <Field label="Due date" value={dueDate} onChange={setDueDate} type="date" />
          <Field label="Issued at" value={issuedAt} onChange={setIssuedAt} type="datetime-local" />
          <Field label="Notes" value={notes} onChange={setNotes} />
        </div>
      </fieldset>
      <div className="form-actions">
        {!canEditThis ? (
          <span className="hint-inline">{editBlockReason("ar", row.assignee_id)}</span>
        ) : (
          <>
            <button className="btn primary" disabled={busy} onClick={() => save(true)}>
              {busy ? "Working…" : row.tax_issued ? "Save issued date & details" : "Complete tax invoice issuance"}
            </button>
            {row.tax_issued ? (
              <button className="btn" disabled={busy} onClick={() => save(false)}>
                Undo issuance
              </button>
            ) : null}
          </>
        )}
        {canDeleteThis ? (
          <button className="btn danger" disabled={busy} onClick={remove} style={{ marginLeft: "auto" }}>
            Delete
          </button>
        ) : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </Modal>
  );
}

/** 11) Payment Completed — record payment, then complete stage 11. */
function PaymentModal({
  row,
  onChanged,
  onClose,
  inline,
}: {
  row: ArRow;
  onChanged: () => void;
  onClose: () => void;
  inline?: boolean;
}) {
  const [amount, setAmount] = useState(row.outstanding > 0 ? String(row.outstanding) : "");
  const [dueDate, setDueDate] = useState(row.due_date || today());
  const [paidAt, setPaidAt] = useState(row.paid_date || nowLocal());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 편집 권한 = 역할 권한(ar.edit) × 담당(PIC) 소유권. 없으면 읽기전용.
  const canEditThis = can("ar", "edit") && canEditDeal(row.assignee_id);

  async function save(complete: boolean) {
    setBusy(true);
    setErr(null);
    try {
      const amt = num(amount);
      if (amt > 0) await recordArPayment(row.id, amt, dueDate);
      await completeOrderStage(row.order_id, 11, complete, complete ? paidAt : undefined);
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={<ModalTitle label={`Record Payment — ${row.ci_no || "AR"}`} projectNo={row.project_no} />} onClose={onClose} wide inline={inline}>
      {!inline ? <OrderInfoBlock orderId={row.order_id} /> : null}
      <div className="milestone-row" style={{ marginBottom: 12 }}>
        <span className={`ar-badge${row.paid_done ? "" : " overdue"}`}>
          {row.paid_done ? `Paid (${row.paid_date || "done"})` : "Pending"}
        </span>
      </div>
      <dl className="intl-meta" style={{ margin: "0 0 14px" }}>
        <div><dt>Invoice amount</dt><dd>{dualCurrencyText(row.invoice_amount, row.currency)}</dd></div>
        <div><dt>Paid to date</dt><dd>{dualCurrencyText(row.paid_amount, row.currency)}</dd></div>
        <div><dt>Outstanding</dt><dd>{dualCurrencyText(row.outstanding, row.currency)}</dd></div>
        <div><dt>Status</dt><dd>{tr(row.status)}</dd></div>
      </dl>
      <fieldset className="form-fieldset" disabled={!canEditThis}>
        <div className="form-grid">
          <Field label="Payment amount" value={amount} onChange={setAmount} type="number" />
          <Field label="Payment date / due" value={dueDate} onChange={setDueDate} type="date" />
          <Field label="Paid at" value={paidAt} onChange={setPaidAt} type="datetime-local" />
        </div>
        <p className="hint-inline" style={{ display: "block", margin: "6px 0 0" }}>
          Leave the amount empty to only mark payment complete. Entering an amount records the payment first.
        </p>
      </fieldset>
      <div className="form-actions">
        {!canEditThis ? (
          <span className="hint-inline">{editBlockReason("ar", row.assignee_id)}</span>
        ) : (
          <>
            <button className="btn primary" disabled={busy} onClick={() => save(true)}>
              {busy ? "Working…" : row.paid_done ? "Save paid date" : "Complete payment"}
            </button>
            {row.paid_done ? (
              <button className="btn" disabled={busy} onClick={() => save(false)}>
                Undo completion
              </button>
            ) : null}
          </>
        )}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </Modal>
  );
}

/** Direct AR record creation form (inside modal). */
function ArAddForm({
  options,
  fallbackOrderId,
  onChanged,
}: {
  options: PoWorkOptions | null;
  fallbackOrderId: number | null;
  onChanged: () => void;
}) {
  const [form, setForm] = useState<ArForm>({ ...emptyForm, order_id: fallbackOrderId ?? "" });
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // 오더 선택 시 해당 프로젝트/CI 정보를 불러와 기본정보 표시 + 빈 항목 자동 입력.
  useEffect(() => {
    if (form.order_id === "") {
      setDetail(null);
      return;
    }
    let alive = true;
    fetchDocumentDetail(form.order_id)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        setForm((f) => ({
          ...f,
          ci_no: f.ci_no || d.ci?.ci_no || "",
          currency: d.ci?.currency || f.currency,
          invoice_amount: f.invoice_amount || ciTotal(d),
        }));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [form.order_id]);

  async function save() {
    if (form.order_id === "") return;
    setErr("");
    setBusy(true);
    try {
      await createArRecord({
        order_id: form.order_id,
        ci_no: form.ci_no,
        invoice_amount: form.invoice_amount,
        paid_amount: form.paid_amount,
        currency: form.currency,
        due_date: form.due_date,
        status: form.status,
        notes: form.notes,
      });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="project-select">
        <label>Order *</label>
        <select
          value={form.order_id}
          onChange={(e) => setForm({ ...form, order_id: e.target.value ? Number(e.target.value) : "" })}
        >
          <option value="">Select…</option>
          {(options?.orders || []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.project_no} · {o.customer} · {o.vessel || "-"}
            </option>
          ))}
        </select>
      </div>
      {form.order_id !== "" ? <OrderInfoBlock orderId={form.order_id} detail={detail} /> : null}
      <div className="form-grid">
        <Field label="CI No." value={form.ci_no} onChange={(v) => setForm({ ...form, ci_no: v })} />
        <Field label="Invoice amount" value={String(form.invoice_amount)} onChange={(v) => setForm({ ...form, invoice_amount: num(v) })} type="number" />
        <Field label="Paid amount" value={String(form.paid_amount)} onChange={(v) => setForm({ ...form, paid_amount: num(v) })} type="number" />
        <label className="form-field">
          <span>Currency</span>
          <CurrencyToggle value={form.currency} onChange={(v) => setForm({ ...form, currency: v })} />
        </label>
        <Field label="Due date" value={form.due_date} onChange={(v) => setForm({ ...form, due_date: v })} type="date" />
        <label className="form-field">
          <span>Status</span>
          <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            <option value="미수">{tr("미수")}</option>
            <option value="일부수금">{tr("일부수금")}</option>
            <option value="완납">{tr("완납")}</option>
            <option value="연체">{tr("연체")}</option>
          </select>
        </label>
        <Field label="Notes" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} />
      </div>
      <div className="form-actions">
        <button className="btn primary" disabled={form.order_id === "" || busy} onClick={save}>
          {busy ? "Working…" : "Add AR"}
        </button>
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="form-field">
      <span>{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
