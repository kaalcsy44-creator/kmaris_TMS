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
  fetchApByOrder,
  createApRecord,
  updateApRecord,
  deleteApRecord,
} from "@/lib/api";
import { can, canEditDeal, editBlockReason } from "@/lib/auth";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import type { ApByOrderRow, ArRow, DocCharges, DocumentDetail, DocumentWorkItem, PoWorkOptions, TaxInvoiceItem } from "@/lib/types";
import { createPortal } from "react-dom";
import CurrencyToggle from "@/components/common/CurrencyToggle";
import {
  useRowSelection,
  deleteSelectedRows,
  ItemSelectHeaderCell,
  ItemSelectCell,
  DeleteSelectedButton,
  ExcludeSelectedButton,
  ExcludedCountNote,
  includedRows,
  includedSeqNos,
  isRowExcluded,
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

/** 부대비용 입력값(문자열로 들고 있다가 저장 시 숫자로 변환) — PI/CI 품목표와 같은 방식. */
type ChargeForm = { freight: string; packing: string; insurance: string };
const emptyCharges: ChargeForm = { freight: "", packing: "", insurance: "" };
const CHARGE_KEYS: { key: keyof ChargeForm; label: string }[] = [
  { key: "freight", label: "Freight" },
  { key: "packing", label: "Packing" },
  { key: "insurance", label: "Insurance" },
];
/** 저장된 charges(JSON) → 입력 폼 값. 0/빈값은 빈 칸으로 둔다. */
function chargesToForm(c: DocCharges | null | undefined): ChargeForm {
  const one = (v: number | string | undefined) => (v === undefined || v === null || num(v) === 0 ? "" : String(v));
  return { freight: one(c?.freight), packing: one(c?.packing), insurance: one(c?.insurance) };
}
/** 입력 폼 값 → 저장용 숫자 JSON. */
const chargesToSave = (c: ChargeForm): DocCharges => ({
  freight: num(c.freight),
  packing: num(c.packing),
  insurance: num(c.insurance),
});
const chargesTotal = (c: ChargeForm) => num(c.freight) + num(c.packing) + num(c.insurance);

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
  charges: ChargeForm;
  remarks: string;
  // 청구처(BILL TO) 오버라이드 — 비우면 고객 마스터값을 사용.
  bill_to_tax_id: string;
  bill_to_contact: string;
  bill_to_email: string;
  bill_to_phone: string;
};

const DEFAULT_REMARKS =
  "After payment, please send the deposit receipt to the person in charge. To issue the electronic tax invoice, please also provide a copy of your business registration certificate.";

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
  charges: { ...emptyCharges },
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
  initialApPoId = null,
  onChanged,
}: {
  initialOrderId?: number | null;
  initialStage?: StageTab | null;
  /** 지급대장(Payables)에서 벤더 청구서 번호를 눌러 온 경우 — AP 탭을 그 P/O 로 연다. */
  initialApPoId?: number | null;
  /** 상위(프로젝트 팝업)의 파이프라인 새로고침 — 단계 완료가 즉시 단계 칩에 반영되게 한다. */
  onChanged?: () => void;
} = {}) {
  const { data, refresh } = useCachedData("ar:overview", fetchArOverview);
  const { data: options } = useCachedData("ar:workoptions", fetchPoWorkOptions);
  const [stageTab, setStageTab] = useState<StageTab>(
    initialStage === 11 ? 11 : initialStage === 9 ? 9 : 10
  );
  // 수취(AR, 고객 청구) / 지급(AP, 벤더 매입) 문서 탭. 지급대장에서 온 딥링크는 AP 로 연다.
  const [docTab, setDocTab] = useState<"ar" | "ap">(initialApPoId ? "ap" : "ar");
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const orderId = initialOrderId ?? null;

  // 딥링크 단계(?stage=9|10|11) 변화 시 탭 동기화.
  useEffect(() => {
    if (initialStage === 11) setStageTab(11);
    else if (initialStage === 10) setStageTab(10);
    else if (initialStage === 9) setStageTab(9);
  }, [initialStage]);

  // 지급대장 딥링크(?ap=<po_id>)로 들어오면 문서 탭도 지급(AP)으로 맞춘다.
  useEffect(() => {
    if (initialApPoId) setDocTab("ap");
  }, [initialApPoId]);

  function load() {
    invalidateCache("dashboard");
    invalidateCache("pipeline");
    // 캐시 무효화만으로는 이미 떠 있는 상위 화면이 다시 부르지 않는다 — 단계 칩이
    // 예전 단계에 머무르지 않도록 파이프라인 재조회를 직접 요청한다.
    onChanged?.();
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
  // AR(수취) 옆에 AP(지급, 벤더 매입) 탭 — 각 벤더 P/O 의 대금청구서·전자세금계산서를 입력.
  return (
    <div className="embedded-detail ar-ap-detail">
      <div className="pane-tabs" role="tablist" aria-label="Receivable / Payable">
        <button className={docTab === "ar" ? "on" : ""} onClick={() => setDocTab("ar")}>
          Receivable · Customer (AR)
        </button>
        <button className={docTab === "ap" ? "on" : ""} onClick={() => setDocTab("ap")}>
          Payable · Vendor (AP)
        </button>
      </div>

      {docTab === "ar" ? (
        <>
          <ArAddForm key={match?.id ?? `new-${orderId}`} options={options ?? null} fallbackOrderId={orderId} existing={match} onChanged={load} />
          {match && stageTab !== 9 ? <MilestoneBar row={match} stage={stageTab} onChanged={load} /> : null}
        </>
      ) : (
        <ApSection orderId={orderId} stage={stageTab} focusPoId={initialApPoId ?? null} onChanged={load} />
      )}
    </div>
  );
}

/** AP(매입 지급) 섹션 — 이 오더의 벤더 P/O 를 골라 대금청구서·전자세금계산서를 입력한다.
 *  한 오더에 벤더 P/O 가 여러 개일 수 있어 P/O 선택기를 먼저 둔다(각 P/O = AP 1건). */
function ApSection({
  orderId,
  stage,
  focusPoId = null,
  onChanged,
}: {
  orderId: number;
  stage: StageTab;
  /** 지급대장에서 눌러 온 벤더 P/O — 목록이 로드되면 그 P/O 를 선택해 연다. */
  focusPoId?: number | null;
  onChanged: () => void;
}) {
  const cacheKey = `ap:by-order:${orderId}`;
  const { data, error, refresh } = useCachedData(cacheKey, () => fetchApByOrder(orderId));
  const [selPo, setSelPo] = useState<number | null>(focusPoId);
  const poRows = useMemo(() => data?.rows ?? [], [data]);

  // 딥링크로 지정된 P/O 가 이 오더에 있으면 그 건을 연다(그 뒤엔 사용자의 선택이 우선).
  useEffect(() => {
    if (focusPoId && poRows.some((r) => r.po_id === focusPoId)) setSelPo(focusPoId);
  }, [focusPoId, poRows]);

  useEffect(() => {
    if (poRows.length && (selPo == null || !poRows.some((r) => r.po_id === selPo))) {
      setSelPo(poRows[0].po_id);
    }
  }, [poRows, selPo]);

  function reload() {
    invalidateCache("finance:summary");
    invalidateCache("finance:payables");
    invalidateCache("finance:calendar");
    onChanged();
    return refresh();
  }

  if (error && !data) return <div className="state error">API error: {error.message}</div>;
  if (!data) return <div className="state">Loading…</div>;
  if (poRows.length === 0) {
    return (
      <div className="project-work-empty">
        No vendor P/O on this order yet — send the Vendor P/O (stage 6) first. Vendor bills are recorded per P/O.
      </div>
    );
  }

  const current = poRows.find((r) => r.po_id === selPo) ?? poRows[0];

  return (
    <div>
      <div className="project-select">
        <label>Vendor P/O *</label>
        <select value={current.po_id} onChange={(e) => setSelPo(Number(e.target.value))}>
          {poRows.map((r) => (
            <option key={r.po_id} value={r.po_id}>
              {(r.po_no || `PO#${r.po_id}`)} · {r.vendor}{r.ap ? "  ✓ billed" : ""}
            </option>
          ))}
        </select>
      </div>
      <ApAddForm key={current.po_id} row={current} orderId={orderId} stage={stage} onChanged={reload} />
    </div>
  );
}

type ApForm = {
  bill_no: string;
  bill_date: string;
  currency: string;
  vat_rate: number;
  due_date: string;
  paid_amount: number;
  paid_date: string;
  items: TaxInvoiceItem[];
  charges: ChargeForm;
  notes: string;
  tax_received: boolean;
  tax_received_date: string;
  tax_invoice_no: string;
};

/** AP(매입 청구) 편집기 — ArAddForm 의 매입측 대응. 선택된 벤더 P/O 1건에 대한 대금청구서/
 *  거래명세서 금액을 확정 입력하고(품목은 P/O 자동 로드), 10단계에서 전자세금계산서 수취를 기록. */
function ApAddForm({
  row,
  orderId,
  stage,
  onChanged,
}: {
  row: ApByOrderRow;
  orderId: number;
  stage: StageTab;
  onChanged: () => void;
}) {
  const ap = row.ap;
  const editing = !!ap;
  const canEdit = can("ar", "create") || can("ar", "edit");
  const poItems = useMemo(() => workItemsToTax(row.items), [row.items]);
  const [form, setForm] = useState<ApForm>(() =>
    ap
      ? {
          bill_no: ap.bill_no,
          bill_date: ap.bill_date || today(),
          currency: ap.currency,
          vat_rate: ap.vat_rate,
          due_date: ap.due_date || today(),
          paid_amount: ap.paid_amount,
          paid_date: ap.paid_date || "",
          // 저장된 청구 품목이 기본. 비어 있으면(금액만 먼저 잡아둔 건 등) 벤더 P/O 품목으로
          // 채운다 — 빈 표를 보여주고 Load P/O 를 누르게 하는 것보다 낫다. 제외 표식도 따라온다.
          items: (ap.items?.length ? ap.items : poItems).map((it) => ({ ...it })),
          charges: chargesToForm(ap.charges),
          notes: ap.notes,
          tax_received: ap.tax_received,
          tax_received_date: ap.tax_received_date || today(),
          tax_invoice_no: ap.tax_invoice_no,
        }
      : {
          bill_no: "",
          bill_date: today(),
          currency: row.currency || "KRW",
          vat_rate: 0.1,
          due_date: today(),
          paid_amount: 0,
          paid_date: "",
          items: poItems.map((it) => ({ ...it })),
          charges: { ...emptyCharges },
          notes: "",
          tax_received: false,
          tax_received_date: today(),
          tax_invoice_no: "",
        }
  );
  const [busy, setBusy] = useState(false);
  const [delBusy, setDelBusy] = useState(false);
  const [err, setErr] = useState("");
  const sel = useRowSelection();

  // 합계 = 품목 소계 + 부대비용(Freight/Packing/Insurance) + VAT.
  // 소계는 "문서에서 제외"한 행을 뺀 값 — AR 청구서와 같은 규칙.
  const subtotal = taxSubtotal(form.items);
  const seqNos = includedSeqNos(form.items);
  const extras = chargesTotal(form.charges);
  const vat = (subtotal + extras) * num(form.vat_rate);
  const total = Math.round(subtotal + extras + vat);
  const setCharge = (key: keyof ChargeForm, v: string) =>
    setForm((f) => ({ ...f, charges: { ...f.charges, [key]: v } }));

  // 지급 상태 — 저장된 status 가 아니라 지금 입력된 청구 총액·지급액에서 매번 계산한다
  // (금액을 고치면 배지도 같이 따라와야 한다. 미수 목록도 같은 방식).
  const outstanding = Math.round(total - num(form.paid_amount));
  const payState = num(form.paid_amount) <= 0 ? "unpaid" : outstanding > 0 ? "partial" : "paid";
  const payInFull = () => setForm((f) => ({ ...f, paid_amount: total, paid_date: f.paid_date || today() }));
  const clearPayment = () => setForm((f) => ({ ...f, paid_amount: 0, paid_date: "" }));

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
  const loadPo = () => { setItems(poItems.map((it) => ({ ...it }))); sel.clear(); };

  async function save() {
    if (!(form.due_date || "").trim()) { setErr("Enter a due date."); return; }
    if (num(form.paid_amount) > 0 && !(form.paid_date || "").trim()) {
      setErr("Enter the date the payment was made."); return;
    }
    setBusy(true); setErr("");
    try {
      const body = {
        po_id: row.po_id,
        order_id: orderId,
        vendor_id: row.vendor_id,
        bill_no: form.bill_no,
        bill_date: form.bill_date,
        invoice_amount: total,
        paid_amount: form.paid_amount,
        // 지급액이 0 이면 지급일도 비운다 — 안 낸 건에 날짜만 남으면 Finance 실적이
        // 있지도 않은 출금을 그 달에 잡는다(서버도 같은 규칙으로 한 번 더 막는다).
        paid_date: form.paid_amount > 0 ? form.paid_date : "",
        currency: form.currency,
        vat_rate: form.vat_rate,
        due_date: form.due_date,
        items: form.items,
        charges: chargesToSave(form.charges),
        notes: form.notes,
        tax_received: form.tax_received,
        tax_received_date: form.tax_received ? form.tax_received_date : "",
        tax_invoice_no: form.tax_invoice_no,
      };
      if (ap) await updateApRecord(ap.id, body);
      else await createApRecord(body);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function removeRecord() {
    if (!ap) return;
    if (!confirm("Delete this vendor bill (AP record)?")) return;
    setDelBusy(true); setErr("");
    try {
      await deleteApRecord(ap.id);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDelBusy(false);
    }
  }

  const itemCols: ItemCol[] = [
    { key: "__sel", fixed: true },
    { key: "__seq", fixed: true, className: "seq" },
    { key: "description", label: "Description" },
    { key: "part_no", label: "Part No." },
    { key: "qty", label: "Qty", className: "num" },
    { key: "unit_price", label: "Unit Price", className: "num" },
    { key: "amount", label: "Amount", className: "num" },
  ];
  const grid = useItemGrid("ap-bill-items", itemCols);

  return (
    <fieldset className="form-fieldset" disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
      <div className="form-grid">
        <Field label="Bill No. (vendor)" value={form.bill_no} onChange={(v) => setForm({ ...form, bill_no: v })} />
        <Field label="Bill date" value={form.bill_date} onChange={(v) => setForm({ ...form, bill_date: v })} type="date" />
        <label className="form-field">
          <span>Currency</span>
          <CurrencyToggle value={form.currency || "KRW"} onChange={(v) => setForm({ ...form, currency: v })} />
        </label>
        <Field label="VAT %" value={String(Math.round(form.vat_rate * 100))} onChange={(v) => setForm({ ...form, vat_rate: (Number(v) || 0) / 100 })} type="number" />
        {/* 지급액·지급일은 아래 Payment 블록으로 옮겼다 — 청구서 내용(무엇을 얼마에 샀나)과
            지급 사실(언제 얼마를 냈나)은 다른 일이라 섞이면 어느 쪽도 눈에 안 들어온다. */}
        <Field label="Due date" value={form.due_date} onChange={(v) => setForm({ ...form, due_date: v })} type="date" />
      </div>

      <div className="tax-items">
        <div className="items-head">
          <div className="form-section-title" style={{ margin: 0 }}>Item list</div>
          <ExcludedCountNote items={form.items} />
          <div className="items-head-actions">
            <button type="button" className="btn sm" onClick={loadPo} disabled={poItems.length === 0}>Load P/O</button>
            <ItemColsButton grid={grid} />
            <ExcludeSelectedButton items={form.items} sel={sel} onChange={setItems} />
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
                <tr><td colSpan={7} className="tax-items-empty">No items — “+ Add” or “Load P/O”.</td></tr>
              ) : form.items.map((it, i) => (
                <tr key={i} className={itemRowClass(i, isRowExcluded(it))}>
                  <ItemSelectCell index={i} sel={sel} />
                  <td className="seq" title={isRowExcluded(it) ? "Excluded from this bill" : undefined}>
                    {seqNos[i] ?? "—"}
                  </td>
                  <td><textarea className="desc" rows={1} value={it.description} onChange={(e) => setItem(i, "description", e.target.value)} /></td>
                  <td><textarea className="wrapcell" rows={1} value={it.part_no} onChange={(e) => setItem(i, "part_no", e.target.value)} /></td>
                  <td><input className="num" value={amountInputValue(it.qty)} onChange={(e) => setItem(i, "qty", e.target.value)} /></td>
                  <td><input className="num" value={amountInputValue(it.unit_price)} onChange={(e) => setItem(i, "unit_price", e.target.value)} /></td>
                  <td className="num">{it.amount.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
            {/* Freight/Packing/Insurance 는 입력칸(부대비용) — 소계에 더해 VAT 를 매긴다. */}
            <tfoot>
              <tr>
                <td /><td /><td /><td /><td />
                <td className="total-label">Subtotal</td>
                <td className="num total-value">{subtotal.toLocaleString()}</td>
              </tr>
              {CHARGE_KEYS.map(({ key, label }) => (
                <tr key={key}>
                  <td /><td /><td /><td /><td />
                  <td className="total-label">{label}</td>
                  <td className="num total-value">
                    <input
                      className="foot-charge-input"
                      value={amountInputValue(form.charges[key])}
                      onChange={(e) => setCharge(key, String(parseAmountInput(e.target.value) ?? ""))}
                    />
                  </td>
                </tr>
              ))}
              <tr>
                <td /><td /><td /><td /><td />
                <td className="total-label">VAT ({Math.round(form.vat_rate * 100)}%)</td>
                <td className="num total-value">{Math.round(vat).toLocaleString()}</td>
              </tr>
              <tr className="foot-grand">
                <td /><td /><td /><td /><td />
                <td className="total-label">Total</td>
                <td className="num total-value">{total.toLocaleString()}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {stage === 10 ? (
        <div className="ar-milestone">
          <div className="form-section-title">e-Tax invoice received (from vendor)</div>
          <div className="milestone-row" style={{ marginBottom: 10 }}>
            <span className={`ar-badge${form.tax_received ? "" : " overdue"}`}>
              {form.tax_received ? `Received (${form.tax_received_date || "done"})` : "Not received"}
            </span>
          </div>
          <label className="check-chip" style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={form.tax_received} onChange={(e) => setForm({ ...form, tax_received: e.target.checked })} /> e-Tax invoice received
          </label>
          {form.tax_received ? (
            <div className="form-grid" style={{ marginTop: 8 }}>
              <Field label="Received date" value={form.tax_received_date} onChange={(v) => setForm({ ...form, tax_received_date: v })} type="date" />
              <Field label="e-Tax invoice No. (approval)" value={form.tax_invoice_no} onChange={(v) => setForm({ ...form, tax_invoice_no: v })} />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 지급 확인 — 11단계(Payment Completed) 전용. 9단계는 청구서를 받는 자리,
          10단계는 전자세금계산서 수취 자리라 각자 제 일만 한다. */}
      {stage === 11 ? (
        <div className="ar-milestone">
          <div className="form-section-title">Payment (to vendor)</div>
          <div className="milestone-row">
            <span className={`ar-badge${payState === "paid" ? "" : " overdue"}`}>
              {payState === "paid"
                ? `Paid${form.paid_date ? ` (${form.paid_date})` : ""}`
                : payState === "partial"
                  ? `Partly paid — ${outstanding.toLocaleString()} left`
                  : "Unpaid"}
            </span>
            {payState === "unpaid" ? (
              <button type="button" className="btn sm" onClick={payInFull}>
                Pay in full ({total.toLocaleString()})
              </button>
            ) : (
              <button type="button" className="btn sm" onClick={clearPayment}>Undo payment</button>
            )}
          </div>
          <div className="form-grid">
            <MoneyField label="Paid amount" value={form.paid_amount} onChange={(v) => setForm({ ...form, paid_amount: parseAmountInput(v) ?? 0 })} />
            <Field label="Paid date" value={form.paid_date} onChange={(v) => setForm({ ...form, paid_date: v })} type="date" />
          </div>
          <p className="hint-inline" style={{ display: "block", marginTop: 8 }}>
            The paid date is the day the money actually left, which may differ from the due date — Finance uses it to place this bill in the right month (Overview “Cash actually moved”, Cash Flow). Press Save to apply.
          </p>
        </div>
      ) : null}

      <label className="form-field ar-remarks" style={{ marginTop: 10 }}>
        <span>Notes</span>
        <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </label>

      <div className="form-actions doc-actions">
        <div className="doc-actions-left" />
        <div className="doc-actions-center">
          {err ? <span className="action-err">{err}</span> : null}
          {!canEdit ? <span className="hint-inline">{editBlockReason("ar", 0)}</span> : null}
        </div>
        <div className="doc-actions-right">
          {editing ? (
            <button className="btn danger" disabled={busy || delBusy} onClick={removeRecord}>
              {delBusy ? "Deleting…" : "Delete"}
            </button>
          ) : null}
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? "Working…" : "Save"}
          </button>
        </div>
      </div>
    </fieldset>
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
        {stage === 10 ? "Tax invoice issuance" : "Payment"}
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
              <MoneyField label="Payment amount" value={amount} onChange={setAmount} />
              <Field label="Payment date / due" value={payDue} onChange={setPayDue} type="date" />
              <Field label="Paid at" value={paidAt} onChange={setPaidAt} type="datetime-local" />
            </>
          )}
        </div>
        {stage === 11 ? (
          <p className="hint-inline" style={{ display: "block", margin: "6px 0 0" }}>
            Leave the amount empty to just mark it complete; enter an amount to record the payment and complete.
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

/** 작업 품목(CI·PI·P/O 공용) → 세금계산서 청구 품목(설명·Part No.·수량·단가·금액). */
function workItemsToTax(items: DocumentWorkItem[] | undefined | null): TaxInvoiceItem[] {
  return (items ?? []).map((it) => {
    const qty = num(it.qty);
    const unit_price = num(it.unit_price);
    return {
      description: it.description || "",
      part_no: it.part_no || "",
      qty,
      unit_price,
      amount: num(it.amount) || qty * unit_price,
      // 문서에서 제외(excluded)한 행도 표식째로 가져온다 — CI/PI 에서 뺀 품목이 청구서에서
      // 되살아나면 안 되고, 그렇다고 지워버리면 무엇을 뺐는지가 사라진다(표에서 Restore 가능).
      ...(it.excluded ? { excluded: true as const } : {}),
    };
  });
}

/** CI 품목 → 세금계산서 청구 품목. CI가 없으면 빈 배열. */
function ciItemsToTax(d: DocumentDetail | null): TaxInvoiceItem[] {
  return workItemsToTax(d?.ci?.items);
}

/** PI(프로포마) 품목 → 세금계산서 청구 품목. CI가 아직 없을 때의 대체 소스. */
function piItemsToTax(d: DocumentDetail | null): TaxInvoiceItem[] {
  return workItemsToTax(d?.pi?.items);
}

/** P/O(오더) 품목 → 세금계산서 청구 품목. CI·PI 가 모두 없을 때의 대체 소스. */
function poItemsToTax(d: DocumentDetail | null): TaxInvoiceItem[] {
  return workItemsToTax(d?.order?.items);
}

/** 청구 소계 — 문서에 실리는 행만 더한다(제외 행은 발행 문서에도 안 나가므로 청구액에서도 빠진다). */
const taxSubtotal = (items: TaxInvoiceItem[]) =>
  includedRows(items).reduce((s, it) => s + num(it.amount), 0);

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
    charges: chargesToForm(r.charges),
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
  // CI가 없을 때의 대체 소스 — PI(프로포마) 품목. "Load PI" 로 표에 채운다.
  const [piItems, setPiItems] = useState<TaxInvoiceItem[]>([]);
  // CI·PI 가 모두 없을 때의 대체 소스 — 오더(P/O) 품목. "Load P/O" 로 표에 채운다.
  const [poItems, setPoItems] = useState<TaxInvoiceItem[]>([]);
  // 청구처(Bill to) 선택지 — 저장된 고객 정보(담당자·이메일·연락처·세금계산서 수신메일).
  const [billOpts, setBillOpts] = useState<{
    taxInvoiceEmail: string;
    contactName: string;
    emails: string[];
    phones: string[];
    contacts: { name: string; email: string; phone: string; position: string }[];
  }>({ taxInvoiceEmail: "", contactName: "", emails: [], phones: [], contacts: [] });
  const sel = useRowSelection();

  // 오더 선택 시 해당 프로젝트/CI 정보를 불러와 빈 항목 자동 입력.
  useEffect(() => {
    if (form.order_id === "") return;
    let alive = true;
    fetchDocumentDetail(form.order_id)
      .then((d) => {
        if (!alive) return;
        const autoInv = d.order.po_no ? `${d.order.po_no}-INV` : "";
        const ci = ciItemsToTax(d);
        const pi = piItemsToTax(d);
        const po = poItemsToTax(d);
        // CI가 있으면 CI 품목이 기본값, 없으면 PI, 그것도 없으면 P/O 품목으로 대체.
        const auto = ci.length ? ci : pi.length ? pi : po;
        const contacts = d.order.customer_contacts ?? [];
        const primary = contacts[0];
        const flatContact = d.order.customer_contact || "";
        const taxInvoiceEmail = d.order.customer_tax_invoice_email || "";
        setAutoInvoiceNo(autoInv);
        setCiItems(ci);
        setPiItems(pi);
        setPoItems(po);
        setBillOpts({
          taxInvoiceEmail,
          contactName: flatContact,
          emails: d.order.customer_emails ?? [],
          phones: d.order.customer_phones ?? [],
          contacts,
        });
        setForm((f) => ({
          ...f,
          ci_no: f.ci_no || d.ci?.ci_no || "",
          currency: d.ci?.currency || f.currency,
          invoice_amount: f.invoice_amount || taxSubtotal(auto),
          // 송장번호 = P/O번호+"-INV"(비어있을 때만). 항목은 CI(없으면 P/O) 품목을 기본값으로 불러온다.
          invoice_no: f.invoice_no || autoInv,
          items: f.items.length ? f.items : auto,
          // 청구처는 고객 마스터값을 기본으로 채운다(사용자가 덮어쓰면 유지).
          // 세금계산서 수신메일을 최우선, 없으면 대표 이메일. 담당자/연락처는 대표(primary) 기준.
          bill_to_tax_id: f.bill_to_tax_id || d.order.customer_tax_id || "",
          bill_to_email: f.bill_to_email || taxInvoiceEmail || d.order.customer_email || "",
          bill_to_contact: f.bill_to_contact || (primary?.name ?? flatContact),
          bill_to_phone: f.bill_to_phone || (primary?.phone ?? (d.order.customer_phones ?? [])[0] ?? ""),
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
        // 청구 금액 = 품목 소계 + 부대비용 + VAT. 별도 입력란 없이 항상 품목표에서 계산.
        invoice_amount: total,
        currency: form.currency,
        due_date: form.due_date,
        invoice_no: form.invoice_no,
        invoice_date: form.invoice_date,
        vat_rate: form.vat_rate,
        items: form.items,
        charges: chargesToSave(form.charges),
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
  // Load CI / PI / P/O — 선택 오더의 품목을 표에 그대로 다시 채운다(현재 편집 내용 대체).
  // 상거래 문서에서 제외한 행은 제외 상태 그대로 들어온다 — 청구서에서 되살리려면 Restore.
  const loadItems = ciItems.length ? ciItems : piItems.length ? piItems : poItems;
  const loadLabel = ciItems.length ? "Load CI" : piItems.length ? "Load PI" : "Load P/O";
  const loadSource = () => { setItems(loadItems.map((it) => ({ ...it }))); sel.clear(); };
  const loadDisabled = loadItems.length === 0;
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

  // 합계 = 품목 소계 + 부대비용(Freight/Packing/Insurance), 여기에 VAT 를 매긴다.
  // 소계는 제외 행을 뺀 값이라 화면·PDF·저장 청구액이 언제나 같은 숫자가 된다.
  const subtotal = taxSubtotal(form.items);
  // 표시용 행 번호 — 제외 행은 번호를 건너뛴다(발행 PDF 의 No. 와 같아진다).
  const seqNos = includedSeqNos(form.items);
  const extras = chargesTotal(form.charges);
  const vat = (subtotal + extras) * num(form.vat_rate);
  const total = Math.round(subtotal + extras + vat);
  const setCharge = (key: keyof ChargeForm, v: string) =>
    setForm((f) => ({ ...f, charges: { ...f.charges, [key]: v } }));

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

      {/* 청구처(BILL TO) — 세금계산서에 인쇄. 저장된 고객 정보에서 고르거나 직접 입력. */}
      <div className="form-section-title">Bill to</div>
      <div className="form-grid">
        <Field label="Customer Tax ID" value={form.bill_to_tax_id} onChange={(v) => setForm({ ...form, bill_to_tax_id: v })} />
        <ComboField
          label="Contact"
          value={form.bill_to_contact}
          options={dedup([billOpts.contactName, ...billOpts.contacts.map((c) => c.name)])}
          onChange={(v) => {
            const c = billOpts.contacts.find((x) => x.name === v);
            setForm((f) => ({
              ...f,
              bill_to_contact: v,
              // 저장된 담당자를 고르면 이메일·연락처도 함께 채운다(직접 입력 시엔 그대로).
              ...(c ? { bill_to_email: c.email || f.bill_to_email, bill_to_phone: c.phone || f.bill_to_phone } : {}),
            }));
          }}
        />
        <ComboField
          label="Email"
          type="email"
          value={form.bill_to_email}
          options={dedup([billOpts.taxInvoiceEmail, ...billOpts.emails, ...billOpts.contacts.map((c) => c.email)])}
          onChange={(v) => setForm({ ...form, bill_to_email: v })}
        />
        <ComboField
          label="Phone"
          value={form.bill_to_phone}
          options={dedup([...billOpts.phones, ...billOpts.contacts.map((c) => c.phone)])}
          onChange={(v) => setForm({ ...form, bill_to_phone: v })}
        />
      </div>

      {/* 청구 품목(Item list) — TAX INVOICE 문서에 그대로 출력된다. CI 품목이 기본값. */}
      <div className="tax-items">
        <div className="items-head">
          <div className="form-section-title" style={{ margin: 0 }}>Item list</div>
          <ExcludedCountNote items={form.items} />
          <div className="items-head-actions">
            <button type="button" className="btn sm" onClick={loadSource} disabled={loadDisabled}>{loadLabel}</button>
            <ItemColsButton grid={grid} />
            <ExcludeSelectedButton items={form.items} sel={sel} onChange={setItems} />
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
                <tr><td colSpan={7} className="tax-items-empty">No items — “+ Add” or “{loadLabel}”.</td></tr>
              ) : form.items.map((it, i) => (
                <tr key={i} className={itemRowClass(i, isRowExcluded(it))}>
                  <ItemSelectCell index={i} sel={sel} />
                  {/* 제외 행은 번호를 비운다 — 발행 문서에는 그 줄이 없기 때문. */}
                  <td className="seq" title={isRowExcluded(it) ? "Excluded from this document" : undefined}>
                    {seqNos[i] ?? "—"}
                  </td>
                  <td><textarea className="desc" rows={1} value={it.description} onChange={(e) => setItem(i, "description", e.target.value)} /></td>
                  <td><textarea className="wrapcell" rows={1} value={it.part_no} onChange={(e) => setItem(i, "part_no", e.target.value)} /></td>
                  <td><input className="num" value={amountInputValue(it.qty)} onChange={(e) => setItem(i, "qty", e.target.value)} /></td>
                  <td><input className="num" value={amountInputValue(it.unit_price)} onChange={(e) => setItem(i, "unit_price", e.target.value)} /></td>
                  <td className="num">{it.amount.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
            {/* 합계행 — 컬럼당 1셀(폭조절/숨김 정렬 유지). 라벨=Unit Price열, 값=Amount열.
                Freight/Packing/Insurance 는 입력칸(부대비용) — 소계에 더해 VAT 를 매긴다. */}
            <tfoot>
              <tr>
                <td /><td /><td /><td /><td />
                <td className="total-label">Subtotal</td>
                <td className="num total-value">{subtotal.toLocaleString()}</td>
              </tr>
              {CHARGE_KEYS.map(({ key, label }) => (
                <tr key={key}>
                  <td /><td /><td /><td /><td />
                  <td className="total-label">{label}</td>
                  <td className="num total-value">
                    <input
                      className="foot-charge-input"
                      value={amountInputValue(form.charges[key])}
                      onChange={(e) => setCharge(key, String(parseAmountInput(e.target.value) ?? ""))}
                    />
                  </td>
                </tr>
              ))}
              <tr>
                <td /><td /><td /><td /><td />
                <td className="total-label">VAT ({Math.round(form.vat_rate * 100)}%)</td>
                <td className="num total-value">{Math.round(vat).toLocaleString()}</td>
              </tr>
              <tr className="foot-grand">
                <td /><td /><td /><td /><td />
                <td className="total-label">Total</td>
                <td className="num total-value">{total.toLocaleString()}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <label className="form-field ar-remarks">
        <span>Remarks</span>
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
        charges: chargesToSave(form.charges),
        remarks: form.remarks,
        bill_to_tax_id: form.bill_to_tax_id,
        bill_to_contact: form.bill_to_contact,
        bill_to_email: form.bill_to_email,
        bill_to_phone: form.bill_to_phone,
      });
      setUrl(URL.createObjectURL(blob));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to open the preview.");
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

/** 금액 입력 필드 — 천단위 콤마(회계 표기)로 표시하고, 저장값은 콤마 없는 원시 문자열. */
function MoneyField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | number;
  onChange: (raw: string) => void;
}) {
  return (
    <label className="form-field">
      <span>{label}</span>
      <input
        className="num"
        inputMode="decimal"
        value={amountInputValue(value)}
        onChange={(e) => onChange(e.target.value.replace(/,/g, ""))}
      />
    </label>
  );
}

/** 중복·빈 값 제거(입력 순서 유지). */
function dedup(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => (v || "").trim() !== "")));
}

/** 선택 겸 직접 입력 필드 — 저장된 옵션을 드롭다운으로 고르거나 "직접 입력"으로 자유 입력.
 *  (네이티브 datalist 는 팝업 글꼴을 CSS 로 못 바꿔, select + manual 토글로 구현) */
function ComboField({
  label,
  value,
  onChange,
  options,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  type?: string;
}) {
  const [manual, setManual] = useState(false);
  const useManual = manual || options.length === 0;
  // 현재 값(직접 입력·미리채운 값 포함)을 옵션에 넣어 항상 드롭다운에 그대로 보이게 한다.
  const allOptions = dedup([value, ...options]);

  return (
    <label className="form-field">
      <span>{label}</span>
      {useManual ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type={type} value={value} onChange={(e) => onChange(e.target.value)} style={{ flex: 1 }} autoFocus={manual} />
          {options.length ? (
            <button type="button" className="btn sm" title="Choose from saved" onClick={() => setManual(false)}>list</button>
          ) : null}
        </div>
      ) : (
        <select
          value={value}
          onChange={(e) => {
            if (e.target.value === "__manual__") { setManual(true); return; }
            onChange(e.target.value);
          }}
        >
          <option value="">— Select —</option>
          {allOptions.map((o) => <option key={o} value={o}>{o}</option>)}
          <option value="__manual__">✎ Enter manually…</option>
        </select>
      )}
    </label>
  );
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
