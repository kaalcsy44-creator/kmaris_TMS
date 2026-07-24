"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createArRecord,
  completeOrderStage,
  deleteArRecord,
  fetchArOverview,
  fetchDocumentDetail,
  fetchPoWorkOptions,
  previewTaxInvoicePdf,
  recordArPayment,
  updateArRecord,
} from "@/lib/api";
import { can, canEditDeal, editBlockReason } from "@/lib/auth";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import type { ArRow, DocumentDetail, PoWorkOptions, TaxInvoiceItem } from "@/lib/types";
import { createPortal } from "react-dom";
import CurrencyToggle from "@/components/common/CurrencyToggle";
import {
  useRowSelection,
  deleteSelectedRows,
  ItemSelectHeaderCell,
  ItemSelectCell,
  DeleteSelectedButton,
  amountInputValue,
  parseAmountInput,
  itemRowClass,
} from "@/components/common/itemTable";
import { useItemGrid, ItemGridStyle, ItemTh, ItemColsButton, type ItemCol } from "@/components/common/itemGrid";

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
  // 세금계산서(대금청구서) 문서 필드
  invoice_no: string;
  invoice_date: string;
  vat_rate: number;
  items: TaxInvoiceItem[];
  remarks: string;
  // 청구처(BILL TO) 오버라이드 — 비우면 고객 마스터값을 사용.
  bill_to_tax_id: string;
  bill_to_contact: string;
  bill_to_email: string;
  bill_to_phone: string;
};

const DEFAULT_REMARKS =
  "입금 후 입금증을 담당자에게 송부 부탁드립니다. 전자세금계산서 발행을 위해 사업자등록증 사본을 함께 전달 부탁드립니다.";

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
  invoice_no: "",
  invoice_date: today(),
  vat_rate: 0.1,
  items: [],
  remarks: DEFAULT_REMARKS,
  bill_to_tax_id: "",
  bill_to_contact: "",
  bill_to_email: "",
  bill_to_phone: "",
};

const emptyTaxItem: TaxInvoiceItem = { description: "", part_no: "", qty: 1, unit_price: 0, amount: 0 };

type StageTab = 9 | 10 | 11;

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
  const [stageTab, setStageTab] = useState<StageTab>(
    initialStage === 11 ? 11 : initialStage === 9 ? 9 : 10
  );
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const orderId = initialOrderId ?? null;

  // 딥링크 단계(?stage=9|10|11) 변화 시 탭 동기화.
  useEffect(() => {
    if (initialStage === 11) setStageTab(11);
    else if (initialStage === 10) setStageTab(10);
    else if (initialStage === 9) setStageTab(9);
  }, [initialStage]);

  function load() {
    invalidateCache("dashboard");
    invalidateCache("pipeline");
    return refresh();
  }

  if (!data) return <div className="state">Loading details…</div>;
  if (!orderId) {
    return (
      <div className="project-work-panel">
        <div className="project-work-empty">
          Register the Customer P/O (stage 5) first — AR is tracked against an order.
        </div>
      </div>
    );
  }
  const match = rows.find((r) => r.order_id === orderId);
  // 9~11단계 모두 같은 대금청구서 편집기(ArAddForm)를 본문으로 쓴다 — P/O 간·단계 간 화면 일관성.
  // 레코드가 없으면 생성 폼, 있으면 편집 폼. 10·11단계는 그 아래 발행/수금 완료 바(MilestoneBar)를 덧붙인다.
  return (
    <div className="embedded-detail">
      <div className="form-section-title" style={{ marginTop: 0 }}>
        {match ? "AR record (edit)" : "Add AR record"}
      </div>
      <ArAddForm key={match?.id ?? `new-${orderId}`} options={options ?? null} fallbackOrderId={orderId} existing={match} onChanged={load} />
      {match && stageTab !== 9 ? <MilestoneBar row={match} stage={stageTab} onChanged={load} /> : null}
    </div>
  );
}

/** 10·11단계 완료 바 — 대금청구서 편집(ArAddForm) 아래에 붙는 발행/수금 완료 액션.
 *  청구서 필드는 위 ArAddForm 에서 편집하므로, 여기서는 발행일/수금액 등 마일스톤만 다룬다. */
function MilestoneBar({ row, stage, onChanged }: { row: ArRow; stage: 10 | 11; onChanged: () => void }) {
  const canEditThis = can("ar", "edit") && canEditDeal(row.assignee_id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [issuedAt, setIssuedAt] = useState(row.tax_issued_date || nowLocal());
  const [amount, setAmount] = useState(row.outstanding > 0 ? String(row.outstanding) : "");
  const [payDue, setPayDue] = useState(row.due_date || today());
  const [paidAt, setPaidAt] = useState(row.paid_date || nowLocal());
  const done = stage === 10 ? row.tax_issued : row.paid_done;

  async function complete(flag: boolean) {
    setBusy(true);
    setErr(null);
    try {
      if (stage === 11 && flag) {
        const amt = num(amount);
        if (amt > 0) await recordArPayment(row.id, amt, payDue);
      }
      await completeOrderStage(row.order_id, stage, flag, flag ? (stage === 10 ? issuedAt : paidAt) : undefined);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ar-milestone">
      <div className="form-section-title">
        {stage === 10 ? "세금계산서 발행 (Tax invoice issuance)" : "수금 완료 (Payment)"}
      </div>
      <div className="milestone-row" style={{ marginBottom: 10 }}>
        <span className={`ar-badge${done ? "" : " overdue"}`}>
          {stage === 10
            ? (row.tax_issued ? `Issued (${row.tax_issued_date || "done"})` : "Not issued")
            : (row.paid_done ? `Paid (${row.paid_date || "done"})` : "Pending")}
        </span>
        {stage === 11 ? (
          <span className="hint-inline" style={{ marginLeft: 10 }}>
            Outstanding {row.outstanding.toLocaleString()} {row.currency}
          </span>
        ) : null}
      </div>
      <fieldset className="form-fieldset" disabled={!canEditThis}>
        <div className="form-grid">
          {stage === 10 ? (
            <Field label="Issued at" value={issuedAt} onChange={setIssuedAt} type="datetime-local" />
          ) : (
            <>
              <Field label="Payment amount" value={amount} onChange={setAmount} type="number" />
              <Field label="Payment date / due" value={payDue} onChange={setPayDue} type="date" />
              <Field label="Paid at" value={paidAt} onChange={setPaidAt} type="datetime-local" />
            </>
          )}
        </div>
        {stage === 11 ? (
          <p className="hint-inline" style={{ display: "block", margin: "6px 0 0" }}>
            금액을 비우면 완료 표시만, 입력하면 수금 기록 후 완료합니다.
          </p>
        ) : null}
      </fieldset>
      <div className="form-actions">
        {!canEditThis ? (
          <span className="hint-inline">{editBlockReason("ar", row.assignee_id)}</span>
        ) : (
          <>
            <button className="btn primary" disabled={busy} onClick={() => complete(true)}>
              {busy ? "Working…" : done
                ? (stage === 10 ? "Save issued date" : "Save paid date")
                : (stage === 10 ? "Complete tax invoice issuance" : "Complete payment")}
            </button>
            {done ? (
              <button className="btn" disabled={busy} onClick={() => complete(false)}>
                {stage === 10 ? "Undo issuance" : "Undo completion"}
              </button>
            ) : null}
          </>
        )}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  );
}

function ciTotal(d: DocumentDetail | null): number {
  if (!d?.ci?.items) return 0;
  return d.ci.items.reduce((s, it) => s + num(it.amount), 0);
}

/** CI 품목 → 세금계산서 청구 품목(설명·Part No.·수량·단가·금액). */
function ciItemsToTax(d: DocumentDetail | null): TaxInvoiceItem[] {
  return (d?.ci?.items ?? []).map((it) => {
    const qty = num(it.qty);
    const unit_price = num(it.unit_price);
    return {
      description: it.description || "",
      part_no: it.part_no || "",
      qty,
      unit_price,
      amount: num(it.amount) || qty * unit_price,
    };
  });
}

const taxSubtotal = (items: TaxInvoiceItem[]) => items.reduce((s, it) => s + num(it.amount), 0);

/** 기존 AR 레코드 → 편집 폼 초기값. */
function arRowToForm(r: ArRow): ArForm {
  return {
    id: r.id,
    order_id: r.order_id,
    ci_no: r.ci_no || "",
    invoice_amount: r.invoice_amount || 0,
    paid_amount: r.paid_amount || 0,
    currency: r.currency || "USD",
    due_date: r.due_date || today(),
    status: r.status || "미수",
    notes: r.notes || "",
    invoice_no: r.invoice_no || "",
    invoice_date: r.invoice_date || today(),
    vat_rate: r.vat_rate ?? 0.1,
    items: (r.items || []).map((it) => ({ ...it })),
    remarks: r.remarks || DEFAULT_REMARKS,
    bill_to_tax_id: r.bill_to_tax_id || "",
    bill_to_contact: r.bill_to_contact || "",
    bill_to_email: r.bill_to_email || "",
    bill_to_phone: r.bill_to_phone || "",
  };
}

/** AR(대금청구서) 레코드 편집기 — 없으면 생성, 있으면(existing) 그 레코드를 수정한다. */
function ArAddForm({
  options,
  fallbackOrderId,
  existing,
  onChanged,
}: {
  options: PoWorkOptions | null;
  fallbackOrderId: number | null;
  // 주면 그 AR 레코드를 편집(수정). 없으면 신규 생성.
  existing?: ArRow;
  onChanged: () => void;
}) {
  const editing = !!existing;
  const [form, setForm] = useState<ArForm>(
    existing ? arRowToForm(existing) : { ...emptyForm, order_id: fallbackOrderId ?? "" }
  );
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // 송장번호 자동생성 규칙 = P/O번호 + "-INV". auto 모드면 이 값을 그대로 사용.
  const [autoInvoiceNo, setAutoInvoiceNo] = useState("");
  // 편집 모드는 저장된 송장번호를 그대로 보여준다(수동). 신규는 자동 생성이 기본.
  const [invMode, setInvMode] = useState<"auto" | "manual">(editing ? "manual" : "auto");
  // "Load CI" 버튼용 — 선택 오더의 CI 품목을 보관했다가 필요 시 표에 다시 채운다.
  const [ciItems, setCiItems] = useState<TaxInvoiceItem[]>([]);
  const sel = useRowSelection();

  // 오더 선택 시 해당 프로젝트/CI 정보를 불러와 빈 항목 자동 입력.
  useEffect(() => {
    if (form.order_id === "") return;
    let alive = true;
    fetchDocumentDetail(form.order_id)
      .then((d) => {
        if (!alive) return;
        const autoInv = d.order.po_no ? `${d.order.po_no}-INV` : "";
        setAutoInvoiceNo(autoInv);
        setCiItems(ciItemsToTax(d));
        setForm((f) => ({
          ...f,
          ci_no: f.ci_no || d.ci?.ci_no || "",
          currency: d.ci?.currency || f.currency,
          invoice_amount: f.invoice_amount || ciTotal(d),
          // 송장번호 = P/O번호+"-INV"(비어있을 때만). 항목은 CI 품목을 기본값으로 불러온다.
          invoice_no: f.invoice_no || autoInv,
          items: f.items.length ? f.items : ciItemsToTax(d),
          // 청구처는 고객 마스터값을 기본으로 채운다(사용자가 덮어쓰면 유지).
          bill_to_tax_id: f.bill_to_tax_id || d.order.customer_tax_id || "",
          bill_to_email: f.bill_to_email || d.order.customer_email || "",
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
      const body = {
        order_id: form.order_id,
        ci_no: form.ci_no,
        // 청구 금액 = 품목 합계(소계+VAT). 별도 입력란 없이 항상 품목표에서 계산.
        invoice_amount: Math.round(subtotal + vat),
        currency: form.currency,
        due_date: form.due_date,
        invoice_no: form.invoice_no,
        invoice_date: form.invoice_date,
        vat_rate: form.vat_rate,
        items: form.items,
        remarks: form.remarks,
        bill_to_tax_id: form.bill_to_tax_id,
        bill_to_contact: form.bill_to_contact,
        bill_to_email: form.bill_to_email,
        bill_to_phone: form.bill_to_phone,
      };
      if (editing) await updateArRecord(form.id, { ...body, paid_amount: form.paid_amount, status: form.status, notes: form.notes });
      else await createArRecord(body);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  // 청구 품목 편집 — 수량·단가 변경 시 금액(=수량×단가) 자동 계산.
  function setItem(i: number, key: keyof TaxInvoiceItem, value: string) {
    setForm((f) => {
      const items = f.items.map((it, idx) => {
        if (idx !== i) return it;
        const numeric = key === "qty" || key === "unit_price";
        const next = { ...it, [key]: numeric ? parseAmountInput(value) ?? 0 : value };
        if (numeric) next.amount = num(next.qty) * num(next.unit_price);
        return next;
      });
      return { ...f, items };
    });
  }
  const addItem = () => setForm((f) => ({ ...f, items: [...f.items, { ...emptyTaxItem }] }));
  const setItems = (items: TaxInvoiceItem[]) => setForm((f) => ({ ...f, items }));
  // Load CI — 선택 오더의 CI 품목을 표에 다시 채운다(현재 편집 내용 대체).
  const loadCi = () => { setItems(ciItems.map((it) => ({ ...it }))); sel.clear(); };
  // Cancel — 편집 중이면 저장된 값으로, 신규면 빈 폼으로 되돌린다(오더 선택은 유지).
  const cancel = () => {
    if (existing) { setForm(arRowToForm(existing)); setInvMode("manual"); }
    else { setForm({ ...emptyForm, order_id: form.order_id }); setInvMode("auto"); }
    sel.clear();
  };
  // 편집 레코드 삭제(구 발행 화면의 Delete 기능 대체).
  const [delBusy, setDelBusy] = useState(false);
  async function removeRecord() {
    if (!existing) return;
    if (!confirm("Delete this AR record?")) return;
    setDelBusy(true);
    setErr("");
    try {
      await deleteArRecord(existing.id);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDelBusy(false);
    }
  }

  const subtotal = taxSubtotal(form.items);
  const vat = subtotal * num(form.vat_rate);

  // 청구 품목표 — 폭조절·컬럼숨김 가능한 공용 그리드. 좌측 체크박스로 선택→선택삭제.
  const itemCols: ItemCol[] = [
    { key: "__sel", fixed: true },
    { key: "__seq", fixed: true, className: "seq" },
    { key: "description", label: "Description" },
    { key: "part_no", label: "Part No." },
    { key: "qty", label: "Qty", className: "num" },
    { key: "unit_price", label: "Unit Price", className: "num" },
    { key: "amount", label: "Amount", className: "num" },
  ];
  const grid = useItemGrid("ar-tax-items", itemCols);

  return (
    <div>
      <div className="project-select">
        <label>Order *</label>
        <select
          value={form.order_id}
          disabled={editing}
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
      <div className="form-grid">
        <label className="form-field">
          <span>Invoice No.</span>
          {invMode === "auto" ? (
            <select value="auto" onChange={(e) => { if (e.target.value === "manual") setInvMode("manual"); }}>
              <option value="auto">{autoInvoiceNo ? `${autoInvoiceNo} (auto)` : "Auto-generate"}</option>
              <option value="manual">Manual entry…</option>
            </select>
          ) : (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input value={form.invoice_no} onChange={(e) => setForm({ ...form, invoice_no: e.target.value })} placeholder="Invoice No.…" autoFocus style={{ flex: 1 }} />
              <button type="button" className="btn sm" onClick={() => { setInvMode("auto"); setForm((f) => ({ ...f, invoice_no: autoInvoiceNo })); }} title="Use auto number">auto</button>
            </div>
          )}
        </label>
        <Field label="Invoice date" value={form.invoice_date} onChange={(v) => setForm({ ...form, invoice_date: v })} type="date" />
        <Field label="CI No." value={form.ci_no} onChange={(v) => setForm({ ...form, ci_no: v })} />
        <label className="form-field">
          <span>Currency</span>
          <CurrencyToggle value={form.currency} onChange={(v) => setForm({ ...form, currency: v })} />
        </label>
        <Field label="VAT %" value={String(Math.round(form.vat_rate * 100))} onChange={(v) => setForm({ ...form, vat_rate: num(v) / 100 })} type="number" />
        <Field label="Due date" value={form.due_date} onChange={(v) => setForm({ ...form, due_date: v })} type="date" />
        <Field label="Notes" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} />
      </div>

      {/* 청구처(BILL TO) — 세금계산서에 인쇄. 비우면 고객 마스터값을 사용. */}
      <div className="form-section-title">Bill to (청구처)</div>
      <div className="form-grid">
        <Field label="Customer Tax ID (사업자등록번호)" value={form.bill_to_tax_id} onChange={(v) => setForm({ ...form, bill_to_tax_id: v })} />
        <Field label="Contact (담당자)" value={form.bill_to_contact} onChange={(v) => setForm({ ...form, bill_to_contact: v })} />
        <Field label="Email" value={form.bill_to_email} onChange={(v) => setForm({ ...form, bill_to_email: v })} />
        <Field label="Phone (연락처)" value={form.bill_to_phone} onChange={(v) => setForm({ ...form, bill_to_phone: v })} />
      </div>

      {/* 청구 품목(Item list) — TAX INVOICE 문서에 그대로 출력된다. CI 품목이 기본값. */}
      <div className="tax-items">
        <div className="items-head">
          <div className="form-section-title" style={{ margin: 0 }}>Item list</div>
          <div className="items-head-actions">
            <button type="button" className="btn sm" onClick={loadCi} disabled={ciItems.length === 0}>Load CI</button>
            <ItemColsButton grid={grid} />
            <DeleteSelectedButton sel={sel} onDelete={() => deleteSelectedRows(form.items, sel, setItems)} />
            <button type="button" className="btn sm items-head-add" onClick={addItem}>+ Add</button>
          </div>
        </div>
        <div className="table-wrap item-scroll">
          <ItemGridStyle grid={grid} />
          <table className={`mini wide lead-tools ${grid.tableClass}`}>
            <thead>
              <tr>
                <ItemSelectHeaderCell count={form.items.length} sel={sel} />
                <th className="seq">No.</th>
                <ItemTh grid={grid} k="description">Description</ItemTh>
                <ItemTh grid={grid} k="part_no">Part No.</ItemTh>
                <ItemTh grid={grid} k="qty" className="num">Qty</ItemTh>
                <ItemTh grid={grid} k="unit_price" className="num">Unit Price</ItemTh>
                <ItemTh grid={grid} k="amount" className="num">Amount</ItemTh>
              </tr>
            </thead>
            <tbody>
              {form.items.length === 0 ? (
                <tr><td colSpan={7} className="tax-items-empty">No items — “+ Add” or “Load CI”.</td></tr>
              ) : form.items.map((it, i) => (
                <tr key={i} className={itemRowClass(i)}>
                  <ItemSelectCell index={i} sel={sel} />
                  <td className="seq">{i + 1}</td>
                  <td><textarea className="desc" rows={1} value={it.description} onChange={(e) => setItem(i, "description", e.target.value)} /></td>
                  <td><textarea className="wrapcell" rows={1} value={it.part_no} onChange={(e) => setItem(i, "part_no", e.target.value)} /></td>
                  <td><input className="num" value={amountInputValue(it.qty)} onChange={(e) => setItem(i, "qty", e.target.value)} /></td>
                  <td><input className="num" value={amountInputValue(it.unit_price)} onChange={(e) => setItem(i, "unit_price", e.target.value)} /></td>
                  <td className="num">{it.amount.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
            {/* 합계행 — 컬럼당 1셀(폭조절/숨김 정렬 유지). 라벨=Unit Price열, 값=Amount열. */}
            <tfoot>
              <tr>
                <td /><td /><td /><td /><td />
                <td className="total-label">Subtotal</td>
                <td className="num total-value">{subtotal.toLocaleString()}</td>
              </tr>
              <tr>
                <td /><td /><td /><td /><td />
                <td className="total-label">VAT ({Math.round(form.vat_rate * 100)}%)</td>
                <td className="num total-value">{Math.round(vat).toLocaleString()}</td>
              </tr>
              <tr className="foot-grand">
                <td /><td /><td /><td /><td />
                <td className="total-label">Total</td>
                <td className="num total-value">{Math.round(subtotal + vat).toLocaleString()}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <label className="form-field ar-remarks">
        <span>Remarks (청구서 비고)</span>
        <textarea rows={2} value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
      </label>

      <div className="form-actions doc-actions">
        <div className="doc-actions-left">
          <TaxPreviewButton orderId={form.order_id === "" ? null : form.order_id} form={form} />
        </div>
        <div className="doc-actions-center">
          {err ? <span className="action-err">{err}</span> : null}
        </div>
        <div className="doc-actions-right">
          {editing ? (
            <button className="btn danger" disabled={busy || delBusy} onClick={removeRecord}>
              {delBusy ? "Deleting…" : "Delete"}
            </button>
          ) : null}
          <button className="btn" disabled={busy} onClick={cancel}>{editing ? "Reset" : "Cancel"}</button>
          <button className="btn primary" disabled={form.order_id === "" || busy} onClick={save}>
            {busy ? "Working…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** TAX INVOICE(대금청구서) 미리보기 버튼 — 현재 편집값으로 PDF 렌더 후 iframe 모달 표시. */
function TaxPreviewButton({ orderId, form }: { orderId: number | null; form: ArForm }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function open() {
    if (orderId == null) return;
    setBusy(true);
    try {
      const blob = await previewTaxInvoicePdf(orderId, {
        invoice_no: form.invoice_no,
        invoice_date: form.invoice_date,
        due_date: form.due_date,
        currency: form.currency,
        vat_rate: form.vat_rate,
        items: form.items,
        remarks: form.remarks,
        bill_to_tax_id: form.bill_to_tax_id,
        bill_to_contact: form.bill_to_contact,
        bill_to_email: form.bill_to_email,
        bill_to_phone: form.bill_to_phone,
      });
      setUrl(URL.createObjectURL(blob));
    } catch (e) {
      alert(e instanceof Error ? e.message : "미리보기를 열 수 없습니다.");
    } finally {
      setBusy(false);
    }
  }
  function close() {
    if (url) URL.revokeObjectURL(url);
    setUrl(null);
  }
  function savePdf() {
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `${form.invoice_no || "TAX_INVOICE"}.pdf`;
    a.click();
  }

  return (
    <>
      <button type="button" className="btn doc-preview-btn" disabled={orderId == null || busy} onClick={open}>
        {busy ? "Opening…" : "Preview Tax Invoice"}
      </button>
      {url && typeof document !== "undefined"
        ? createPortal(
            <div className="doc-preview-backdrop" onClick={close}>
              <div className="doc-preview-modal" onClick={(e) => e.stopPropagation()}>
                <div className="doc-preview-head">
                  <span className="doc-preview-title">{form.invoice_no || "TAX INVOICE"}</span>
                  <div className="doc-preview-acts">
                    <button className="btn sm doc-preview-save" onClick={savePdf}>PDF Download</button>
                    <button className="btn sm" onClick={close}>Close</button>
                  </div>
                </div>
                <iframe className="doc-preview-frame" src={url} title="Tax Invoice Preview" />
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
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
