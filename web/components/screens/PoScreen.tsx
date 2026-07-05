"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  createOrder,
  createPurchaseOrder,
  fetchPoDetail,
  fetchPoWorkOptions,
  previewVendorPo,
  parseOrderPdf,
  sendVendorPo,
  vendorPoPdfUrl,
  updateOrder,
  deleteOrder,
  fetchVendorPoDetail,
  updatePurchaseOrder,
  deletePurchaseOrder,
} from "@/lib/api";
import { getToken, can, canEditDeal, editBlockReason } from "@/lib/auth";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import FilterTable, { ColumnDef } from "@/components/common/FilterTable";
import { identityColumns, projectNoColumn } from "@/components/common/identityColumns";
import VendorName from "@/components/common/VendorName";
import Modal from "@/components/common/Modal";
import BaseMetaRows, { ModalTitle } from "@/components/common/BaseMeta";
import {
  amountInputValue,
  DualCurrencyAmount,
  dualCurrencyText,
  fxRateText,
  gridCellProps,
  itemRowClass,
  parseAmountInput,
  StageTotal,
} from "@/components/common/itemTable";
import { tr } from "@/lib/labels";
import type {
  PoDetail as PoDetailT,
  PoWorkItem,
  PoWorkOptions,
  VendorPoPreview,
  PurchaseOrderDetail,
} from "@/lib/types";

type OrderOpt = PoWorkOptions["orders"][number];
type PoOpt = PoWorkOptions["purchase_orders"][number];

export default function PoScreen() {
  const params = useSearchParams();
  const orderParam = params.get("order");
  const tabParam = params.get("tab");
  const deepOrderId = orderParam ? Number(orderParam) : null;

  const { data: options, refresh } = useCachedData(
    "po:work-options",
    fetchPoWorkOptions
  );

  // 액션 후: 옵션 새로고침 + 대시보드/파이프라인 캐시 무효화
  function load() {
    invalidateCache("dashboard");
    invalidateCache("pipeline");
    return refresh();
  }

  if (!options) return <div className="state">Loading details…</div>;

  return <PoActionTabs options={options} deepOrderId={deepOrderId} initialTab={tabParam} onChanged={load} />;
}

export function PoActionTabs({
  options,
  deepOrderId,
  initialTab,
  onChanged,
  embedded,
}: {
  options: PoWorkOptions;
  deepOrderId: number | null;
  initialTab?: string | null;
  onChanged: () => void;
  // embedded: 프로젝트 워크스페이스 내부. 내부 탭바·전역 목록·생성 없이 이 프로젝트의
  // 단건 상세를 인라인으로 보여준다. 어느 단계(customer/vendor)인지는 initialTab이 결정.
  embedded?: boolean;
}) {
  const [tab, setTab] = useState(initialTab === "vendor" ? "vendor" : "customer");
  useEffect(() => {
    if (initialTab === "vendor" || initialTab === "customer") setTab(initialTab);
  }, [initialTab]);
  const tabs = [
    { key: "customer", label: "5. Customer P/O Received" },
    { key: "vendor", label: "6. Vendor P/O Sent" },
  ];

  return (
    <div className="action-tabs">
      {embedded ? null : (
        <div className="page-tabs">
          {tabs.map((t) => (
            <button
              key={t.key}
              className={tab === t.key ? "on" : ""}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {tab === "customer" ? (
        <CustomerPoTab options={options} deepOrderId={deepOrderId} onChanged={onChanged} embedded={embedded} />
      ) : (
        <VendorPoTab options={options} deepOrderId={deepOrderId} onChanged={onChanged} embedded={embedded} />
      )}
    </div>
  );
}

// ── 5. Customer P/O 수신 ────────────────────────────────────────────────────
function CustomerPoTab({
  options,
  deepOrderId,
  onChanged,
  embedded,
}: {
  options: PoWorkOptions;
  deepOrderId: number | null;
  onChanged: () => void;
  embedded?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(deepOrderId);

  useEffect(() => {
    setDetailId(deepOrderId);
  }, [deepOrderId]);

  // 프로젝트 워크스페이스: 오더가 있으면 편집, 없으면 이 자리에서 바로 등록(주문 생성).
  if (embedded) {
    return deepOrderId && deepOrderId > 0 ? (
      <OrderDetailModal
        orderId={deepOrderId}
        options={options}
        onClose={onChanged}
        onChanged={onChanged}
        inline
      />
    ) : (
      <div className="embedded-detail">
        <div className="form-section-title" style={{ marginTop: 0 }}>Register Customer P/O (create order)</div>
        <CustomerPoNewForm options={options} onChanged={onChanged} />
      </div>
    );
  }

  const columns: ColumnDef<OrderOpt>[] = [
    projectNoColumn<OrderOpt>({ projectNo: (o) => o.project_no, firstRfqAt: (o) => o.first_rfq_at }),
    ...identityColumns<OrderOpt>({
      customer: (o) => o.customer,
      projectTitle: (o) => o.project_title || "",
      contactPerson: (o) => o.contact_person || "",
      vessel: (o) => o.vessel,
      workType: (o) => o.work_type,
      tradeType: (o) => o.trade_type,
      pic: (o) => o.assignee || "",
    }),
    {
      key: "po_no",
      label: "PO No.",
      text: (o) => o.po_no || "",
      render: (o) => (
        <div className="proj-cell">
          <div className="pn">{o.po_no || <span className="muted">—</span>}</div>
          {o.date ? <div className="pn-at">{o.date}</div> : null}
        </div>
      ),
    },
    { key: "items", label: "Items", numeric: true, text: (o) => String(o.items.length), sortValue: (o) => o.items.length },
    { key: "status", label: "Status", text: (o) => o.status || "", filter: "facet", render: (o) => <span className="ar-badge">{o.status}</span> },
  ];

  return (
    <>
      <FilterTable
        tableId="po-orders"
        rows={options.orders}
        columns={columns}
        getRowKey={(o) => o.id}
        onRowClick={(o) => setDetailId(o.id)}
        defaultSortKey="project_no"
        defaultSortDir="desc"
        empty="No orders registered."
        actions={
          can("po", "create") ? (
            <button className="btn primary" onClick={() => setAdding(true)}>
              + New order
            </button>
          ) : null
        }
      />

      {adding ? (
        <Modal title="New order" onClose={() => setAdding(false)} wide>
          <CustomerPoNewForm
            options={options}
            onChanged={() => {
              setAdding(false);
              onChanged();
            }}
          />
        </Modal>
      ) : null}

      {detailId !== null ? (
        <OrderDetailModal
          orderId={detailId}
          options={options}
          onClose={() => setDetailId(null)}
          onChanged={onChanged}
        />
      ) : null}
    </>
  );
}

// 오더 상세(보기 → 수정 → 저장 / 삭제)
function OrderDetailModal({
  orderId,
  options,
  onClose,
  onChanged,
  inline,
}: {
  orderId: number;
  options: PoWorkOptions;
  onClose: () => void;
  onChanged: () => void;
  inline?: boolean;
}) {
  const order = options.orders.find((o) => o.id === orderId);
  const [detail, setDetail] = useState<PoDetailT | null>(null);
  const [customerId, setCustomerId] = useState<number | "">("");
  const [vesselId, setVesselId] = useState<number | "">("");
  const [poNo, setPoNo] = useState("");
  const [date, setDate] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [tradeType, setTradeType] = useState("수출");
  const [promised, setPromised] = useState("");
  const [items, setItems] = useState<PoWorkItem[]>([]);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrMsg, setOcrMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showOcr, setShowOcr] = useState(false); // Auto-fill 도구 접힘/펼침(1단계와 동일 포맷)

  // 행 클릭 시 읽기전용 단계를 건너뛰고 바로 편집: 상세를 불러와 필드를 채운다.
  useEffect(() => {
    fetchPoDetail(orderId)
      .then((d) => {
        const cust = options.customers.find((c) => c.name === d.customer);
        const ves = options.vessels.find((v) => v.name === d.vessel);
        setDetail(d);
        setCustomerId(cust?.id ?? "");
        setVesselId(ves?.id ?? "");
        setPoNo(d.customer_po_no || "");
        setDate(d.customer_po_at || "");
        setTradeType(d.trade_type || "수출");
        setCurrency(d.currency || "USD");
        setPromised(d.promised_delivery || "");
        setItems(d.items.length ? d.items.map(normalizeItem) : [blankItem()]);
        setOcrMsg(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  // "Load customer RFQ" — 연결된 Customer RFQ(1단계) 품목으로 채운다.
  // (별도 Customer P/O 파일이 없을 때, RFQ 요청 품목을 그대로 불러오기 위함.)
  function loadCustomerRfqItems() {
    const rno = detail?.rfq_no && detail.rfq_no !== "-" ? detail.rfq_no : "";
    const crno = detail?.customer_rfq_no && detail.customer_rfq_no !== "-" ? detail.customer_rfq_no : "";
    const rfq = options.rfqs.find(
      (r) => (rno && r.rfq_no === rno) || (crno && r.customer_rfq_no === crno)
    );
    if (!rfq) {
      setErr("Linked Customer RFQ not found.");
      return;
    }
    setItems(rfq.items.length ? rfq.items.map(normalizeItem) : [blankItem()]);
    setOcrMsg(`Loaded ${rfq.items.length} item(s) from Customer RFQ.`);
  }

  function matchByName<T extends { name: string }>(
    hint: string | null | undefined,
    rows: T[]
  ) {
    if (!hint) return undefined;
    const h = hint.trim().toLowerCase();
    return rows.find((r) => {
      const n = r.name.toLowerCase();
      return h === n || h.includes(n) || n.includes(h);
    });
  }

  async function uploadOrderFile(file: File | null) {
    if (!file) return;
    setOcrBusy(true);
    setErr(null);
    setOcrMsg(null);
    try {
      const r = await parseOrderPdf(file);
      const cust = matchByName(r.customer_hint, options.customers);
      if (cust) setCustomerId(cust.id);
      const vessel = matchByName(r.vessel_name, options.vessels);
      if (vessel) setVesselId(vessel.id);
      if (r.po_no) setPoNo(r.po_no);
      if (r.order_date) setDate(r.order_date);
      if (r.promised_delivery) setPromised(r.promised_delivery);
      if (r.items?.length) {
        setItems(
          r.items.map((it) =>
            normalizeItem({
              part_no: it.part_no ?? "",
              description: it.description ?? "",
              maker: it.maker ?? "",
              qty: it.qty ?? 1,
              unit: it.unit ?? "PCS",
              unit_price: it.unit_price ?? 0,
              amount: (it.qty ?? 1) * (it.unit_price ?? 0),
            })
          )
        );
      }
      setOcrMsg(`Extracted ${r.items?.length ?? 0} item(s) from file.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "File parsing failed");
    } finally {
      setOcrBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await updateOrder(orderId, {
        customer_id: customerId === "" ? undefined : customerId,
        vessel_id: vesselId === "" ? 0 : vesselId,
        po_no: poNo,
        date,
        trade_type: tradeType,
        promised_delivery: promised || null,
        items: cleanItems(items),
      });
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("Delete this order?\nIt cannot be deleted if linked to a PO, document, or AR.")) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteOrder(orderId);
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
      setBusy(false);
    }
  }

  const vessels = options.vessels.filter((v) => customerId === "" || v.customer_id === customerId);
  // 편집 권한 = 역할 권한(po.edit) × 담당(PIC) 소유권. 없으면 읽기전용.
  const canEditThis = can("po", "edit") && canEditDeal(detail?.assignee_id);
  const canDeleteThis = can("po", "delete") && canEditDeal(detail?.assignee_id);

  return (
    <Modal title={<ModalTitle label="Edit order" projectNo={order?.project_no} />} onClose={onClose} wide inline={inline}>
      {!detail ? (
        <div className="state">Loading details…</div>
      ) : (
        <>
          {!inline ? (
            <>
              <div className="form-section-title">Order info</div>
              <dl className="intl-meta">
                <BaseMetaRows info={detail} />
                <div><dt>Customer P/O No.</dt><dd>{detail.customer_po_no || "—"}</dd></div>
                <div><dt>Customer P/O received</dt><dd>{detail.customer_po_at || "—"}</dd></div>
                <div><dt>Customer RFQ No.</dt><dd>{detail.customer_rfq_no || "—"}</dd></div>
                <div><dt>K-Maris RFQ No.</dt><dd>{detail.rfq_no || "—"}</dd></div>
                <div><dt>Quotation No.</dt><dd>{detail.quotation_no || "—"}</dd></div>
                <div><dt>Contact</dt><dd>{detail.customer_contact || "—"}</dd></div>
                <div><dt>Email</dt><dd>{detail.customer_email || "—"}</dd></div>
                <div><dt>Order status</dt><dd>{tr(detail.order_status)}</dd></div>
                <div><dt>Pipeline status</dt><dd>{detail.status || "—"}</dd></div>
                <div><dt>Shipped date</dt><dd>{detail.shipped_date || "—"}</dd></div>
                <div><dt>Delivered date</dt><dd>{detail.delivered_date || "—"}</dd></div>
              </dl>
            </>
          ) : null}

          <fieldset className="form-fieldset" disabled={!canEditThis}>
          <div className="form-tools">
            <button
              type="button"
              className={`tool-btn${showOcr ? " on" : ""}`}
              onClick={() => setShowOcr((v) => !v)}
            >
              📄 Auto-fill
            </button>
          </div>
          {showOcr ? (
            <div className="ocr-bar">
              <span className="ocr-bar-label">📄 Customer P/O auto-fill</span>
              <input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*"
                onChange={(e) => uploadOrderFile(e.target.files?.[0] ?? null)}
                disabled={ocrBusy || busy}
              />
              {ocrBusy ? (
                <span className="hint-inline">Analyzing…</span>
              ) : ocrMsg ? (
                <span className="action-ok">{ocrMsg}</span>
              ) : (
                <span className="hint-inline">Upload a customer P/O PDF/image → auto-fill</span>
              )}
            </div>
          ) : null}

          <div className="form-grid">
            <div className="form-field">
              <label>Customer</label>
              <select value={customerId} onChange={(e) => { setCustomerId(e.target.value ? Number(e.target.value) : ""); setVesselId(""); }}>
                <option value="">Select…</option>
                {options.customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label>Vessel</label>
              <select value={vesselId} onChange={(e) => setVesselId(e.target.value ? Number(e.target.value) : "")}>
                <option value="">— None —</option>
                {vessels.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label>Customer PO No.</label>
              <input value={poNo} onChange={(e) => setPoNo(e.target.value)} />
            </div>
            <div className="form-field">
              <label>Order date</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="form-field">
              <label>Trade type</label>
              <select value={tradeType} onChange={(e) => setTradeType(e.target.value)}>
                <option value="수출">{tr("수출")}</option>
                <option value="내수">{tr("내수")}</option>
              </select>
            </div>
            <div className="form-field">
              <label>Promised delivery</label>
              <input type="date" value={promised} onChange={(e) => setPromised(e.target.value)} />
            </div>
          </div>
          <ItemEditor
            items={items}
            onChange={setItems}
            currency={currency}
            headerActions={
              canEditThis ? (
                <button
                  className="btn sm"
                  onClick={loadCustomerRfqItems}
                  disabled={busy}
                  title="Load items from the linked Customer RFQ (when there is no separate P/O file)"
                >
                  Load customer RFQ
                </button>
              ) : null
            }
          />
          </fieldset>
          <div className="form-actions">
            <StageTotal
              label="Total"
              value={items.reduce((s, it) => s + Number(it.amount || 0), 0)}
              currency={currency}
            />
            {!canEditThis ? (
              <span className="hint-inline">{editBlockReason("po", detail?.assignee_id)}</span>
            ) : (
              <button className="btn primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
            )}
            <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            {canDeleteThis ? (
              <button className="btn danger" onClick={remove} disabled={busy}>Delete</button>
            ) : null}
            {err ? <span className="action-err">{err}</span> : null}
          </div>
        </>
      )}
    </Modal>
  );
}

// ── 6. Vendor P/O 발신 ──────────────────────────────────────────────────────
function VendorPoTab({
  options,
  deepOrderId,
  onChanged,
  embedded,
}: {
  options: PoWorkOptions;
  deepOrderId?: number | null;
  onChanged: () => void;
  embedded?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [sending, setSending] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const autoRef = useRef<number | null>(null);

  // Progress 6단계 진입 → 해당 오더의 최신 발주서 상세를 1회 자동 오픈.
  useEffect(() => {
    if (!deepOrderId || autoRef.current === deepOrderId) return;
    const match = options.purchase_orders.find((p) => p.order_id === deepOrderId);
    autoRef.current = deepOrderId;
    if (match) setDetailId(match.id);
  }, [deepOrderId, options.purchase_orders]);

  // 프로젝트 워크스페이스: 이 오더의 발주서(POs). 없거나 +New면 등록 폼, 있으면 선택 + 상세.
  if (embedded) {
    if (!deepOrderId || deepOrderId <= 0) {
      return (
        <div className="project-work-panel">
          <div className="project-work-empty">
            Register the Customer P/O (stage 5) first — a Vendor P/O is issued against an order.
          </div>
        </div>
      );
    }
    const pos = options.purchase_orders.filter((p) => p.order_id === deepOrderId);
    if (pos.length === 0 || adding) {
      return (
        <div className="embedded-detail">
          <div className="embedded-add-head">
            {pos.length ? (
              <button type="button" className="btn" onClick={() => setAdding(false)}>← Back</button>
            ) : null}
            <span className="form-section-title" style={{ margin: 0 }}>Issue a Vendor P/O</span>
          </div>
          <VendorPoCreate
            options={options}
            selectedOrderId={deepOrderId}
            onChanged={() => { setAdding(false); onChanged(); }}
          />
        </div>
      );
    }
    const selected = pos.find((p) => p.id === detailId) ?? pos[0];
    return (
      <div className="embedded-po-list">
        <div className="embedded-record-bar">
          {pos.length > 1 ? (
            <div className="embedded-record-picker" role="tablist" aria-label="Vendor POs">
              {pos.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={p.id === selected.id ? "on" : ""}
                  onClick={() => setDetailId(p.id)}
                >
                  {p.vendor || p.po_no || `PO ${p.id}`}
                </button>
              ))}
            </div>
          ) : <span />}
          <button type="button" className="btn primary sm" onClick={() => setAdding(true)}>+ Issue another</button>
        </div>
        <VendorPoDetailModal
          id={selected.id}
          options={options}
          onClose={onChanged}
          onChanged={onChanged}
          inline
        />
      </div>
    );
  }

  const columns: ColumnDef<PoOpt>[] = [
    projectNoColumn<PoOpt>({ projectNo: (p) => p.project_no, firstRfqAt: (p) => p.first_rfq_at }),
    ...identityColumns<PoOpt>({
      customer: (p) => p.customer,
      projectTitle: (p) => p.project_title || "",
      contactPerson: (p) => p.contact_person || "",
      vessel: (p) => p.vessel,
      workType: (p) => p.work_type,
      tradeType: (p) => p.trade_type,
      pic: (p) => p.assignee || "",
    }),
    { key: "customer_po_no", label: "PO No.", text: (p) => p.customer_po_no || "" },
    { key: "po_no", label: "K-Maris PO No.", text: (p) => p.po_no || "" },
    { key: "vendor", label: "Vendor", text: (p) => p.vendor || "", filter: "facet", render: (p) => <VendorName name={p.vendor || ""} /> },
    { key: "vendor_email", label: "Recipient email", text: (p) => p.vendor_email || "" },
    { key: "sent_date", label: "Sent date", text: (p) => p.sent_date || "", filter: "date" },
    { key: "status", label: "Status", text: (p) => p.status || "", filter: "facet", render: (p) => <span className="ar-badge">{tr(p.status)}</span> },
    { key: "items", label: "Items", numeric: true, text: (p) => String(p.items.length), sortValue: (p) => p.items.length },
  ];

  return (
    <>
      <FilterTable
        tableId="po-purchase-orders"
        rows={options.purchase_orders}
        columns={columns}
        getRowKey={(p) => p.id}
        onRowClick={(p) => setDetailId(p.id)}
        defaultSortKey="project_no"
        defaultSortDir="desc"
        empty="No purchase orders issued."
        actions={
          <>
            {can("po", "edit") ? (
              <button className="btn" onClick={() => setSending(true)} style={{ marginRight: 8 }}>
                ✉ Send email
              </button>
            ) : null}
            {can("po", "create") ? (
              <button className="btn primary" onClick={() => setAdding(true)}>
                + New
              </button>
            ) : null}
          </>
        }
      />

      {adding ? (
        <Modal title="Create PO" onClose={() => setAdding(false)} wide>
          <VendorPoCreate
            options={options}
            selectedOrderId={null}
            onChanged={() => {
              setAdding(false);
              onChanged();
            }}
          />
        </Modal>
      ) : null}

      {sending ? (
        <Modal title="Send PO email" onClose={() => setSending(false)} wide>
          <VendorPoSend
            options={options}
            onChanged={() => {
              setSending(false);
              onChanged();
            }}
          />
        </Modal>
      ) : null}

      {detailId !== null ? (
        <VendorPoDetailModal
          id={detailId}
          options={options}
          onClose={() => setDetailId(null)}
          onChanged={onChanged}
        />
      ) : null}
    </>
  );
}

function VendorPoDetailModal({
  id,
  options,
  onClose,
  onChanged,
  inline,
}: {
  id: number;
  options: PoWorkOptions;
  onClose: () => void;
  onChanged: () => void;
  inline?: boolean;
}) {
  const [d, setD] = useState<PurchaseOrderDetail | null>(null);
  const [vendorId, setVendorId] = useState<number | "">("");
  const [poNo, setPoNo] = useState("");
  const [sentDate, setSentDate] = useState("");
  const [status, setStatus] = useState("");
  const [items, setItems] = useState<PoWorkItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 편집 권한 = 역할 권한(po.edit) × 담당(PIC) 소유권. 없으면 읽기전용.
  const canEditThis = can("po", "edit") && canEditDeal(d?.assignee_id);
  const canDeleteThis = can("po", "delete") && canEditDeal(d?.assignee_id);

  useEffect(() => {
    fetchVendorPoDetail(id)
      .then((data) => {
        setD(data);
        setVendorId(data.vendor_id || "");
        // 5단계 PO No. → "KM-" 형태로 자동 제안. 이미 KM-로 저장돼 있으면 그대로 유지.
        const kmFromStage5 = data.customer_po_no ? `KM-${data.customer_po_no}` : "";
        setPoNo(
          data.po_no && data.po_no.startsWith("KM-")
            ? data.po_no
            : kmFromStage5 || data.po_no || ""
        );
        setSentDate(data.sent_date || "");
        setStatus(data.status || "");
        setItems(data.items.length ? data.items.map(normalizeItem) : [blankItem()]);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Error"));
  }, [id]);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await updatePurchaseOrder(id, {
        vendor_id: vendorId === "" ? undefined : vendorId,
        po_no: poNo.trim() || undefined,
        sent_date: sentDate,
        status,
        items: cleanItems(items),
      });
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("Delete this purchase order?")) return;
    setBusy(true);
    setErr(null);
    try {
      await deletePurchaseOrder(id);
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
      setBusy(false);
    }
  }

  function loadOrderItems() {
    if (!d) return;
    const order = options.orders.find((o) => o.id === d.order_id);
    if (!order) {
      setErr("Linked order items are not available.");
      return;
    }
    setItems(order.items.length ? order.items.map(normalizeItem) : [blankItem()]);
  }

  return (
    <Modal title={d ? <ModalTitle label={`Edit purchase order — ${d.po_no}`} projectNo={d.project_no} /> : "PO details"} onClose={onClose} wide inline={inline}>
      {!d ? (
        <div className="state">Loading details…</div>
      ) : (
        <>
          {!inline ? (
            <>
              <div className="form-section-title">Purchase order info</div>
              <dl className="intl-meta">
                <BaseMetaRows info={d} />
                <div><dt>PO No.</dt><dd>{d.customer_po_no || "—"}</dd></div>
                <div><dt>K-Maris PO No.</dt><dd>{d.po_no || "—"}</dd></div>
                <div><dt>Vendor</dt><dd>{d.vendor}</dd></div>
                <div><dt>Recipient email</dt><dd>{d.vendor_email || "—"}</dd></div>
                <div><dt>Sent date</dt><dd>{d.sent_date || "—"}</dd></div>
                <div><dt>Status</dt><dd>{tr(d.status)}</dd></div>
                <div><dt>Items</dt><dd>{d.items.length}</dd></div>
              </dl>
            </>
          ) : null}

          <fieldset className="form-fieldset" disabled={!canEditThis}>
          <div className="form-grid">
            <div className="form-field">
              <label>Vendor</label>
              <select value={vendorId} onChange={(e) => setVendorId(e.target.value ? Number(e.target.value) : "")}>
                <option value="">Select…</option>
                {options.vendors.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label>K-Maris PO No.</label>
              <input
                value={poNo}
                onChange={(e) => setPoNo(e.target.value)}
                placeholder={d.customer_po_no ? `KM-${d.customer_po_no}` : "KM-…"}
              />
            </div>
            <div className="form-field">
              <label>Sent date</label>
              <input type="date" value={sentDate} onChange={(e) => setSentDate(e.target.value)} />
            </div>
            <div className="form-field">
              <label>Status</label>
              <input value={status} onChange={(e) => setStatus(e.target.value)} />
            </div>
          </div>
          <ItemEditor
            items={items}
            onChange={setItems}
            currency={d.currency || "USD"}
            headerActions={
              canEditThis ? (
                <button className="btn sm" onClick={loadOrderItems} disabled={busy} title="Reload items from the linked Customer P/O">
                  Load order items
                </button>
              ) : null
            }
          />
          </fieldset>
          <div className="form-actions">
            <StageTotal
              label="Total"
              value={items.reduce((s, it) => s + Number(it.amount || 0), 0)}
              currency={d.currency || "USD"}
            />
            {!canEditThis ? (
              <span className="hint-inline">{editBlockReason("po", d?.assignee_id)}</span>
            ) : (
              <button className="btn primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
            )}
            <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            {canDeleteThis ? (
              <button className="btn danger" onClick={remove} disabled={busy}>Delete</button>
            ) : null}
            {err ? <span className="action-err">{err}</span> : null}
          </div>
        </>
      )}
    </Modal>
  );
}

function CustomerPoNewForm({
  options,
  onChanged,
}: {
  options: PoWorkOptions;
  onChanged: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [quotationId, setQuotationId] = useState<number | "">("");
  const [customerId, setCustomerId] = useState<number | "">(
    options.customers[0]?.id ?? ""
  );
  const [vesselId, setVesselId] = useState<number | "">("");
  const [rfqId, setRfqId] = useState<number | "">("");
  const [poNo, setPoNo] = useState("");
  const [date, setDate] = useState(today);
  const [currency, setCurrency] = useState("USD");
  const [tradeType, setTradeType] = useState("수출");
  const [promised, setPromised] = useState("");
  const [items, setItems] = useState<PoWorkItem[]>([blankItem()]);
  const [busy, setBusy] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [showOcr, setShowOcr] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ocrMsg, setOcrMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const vessels = options.vessels.filter(
    (v) => customerId === "" || v.customer_id === customerId
  );

  function loadQuotation(id: number | "") {
    setQuotationId(id);
    if (id === "") return;
    const q = options.quotations.find((x) => x.id === id);
    if (!q) return;
    setCustomerId(q.customer_id);
    setVesselId(q.vessel_id ?? "");
    setRfqId(q.rfq_id ?? "");
    setCurrency(q.currency || "USD");
    setItems(q.items.length ? q.items.map(normalizeItem) : [blankItem()]);
  }

  function matchByName<T extends { name: string }>(
    hint: string | null | undefined,
    rows: T[]
  ) {
    if (!hint) return undefined;
    const h = hint.trim().toLowerCase();
    return rows.find((r) => {
      const n = r.name.toLowerCase();
      return h === n || h.includes(n) || n.includes(h);
    });
  }

  async function uploadOrderPdf(file: File | null) {
    if (!file) return;
    setOcrBusy(true);
    setErr(null);
    setOcrMsg(null);
    try {
      const r = await parseOrderPdf(file);
      const cust = matchByName(r.customer_hint, options.customers);
      if (cust) setCustomerId(cust.id);
      const vessel = matchByName(r.vessel_name, options.vessels);
      if (vessel) setVesselId(vessel.id);
      if (r.po_no) setPoNo(r.po_no);
      if (r.order_date) setDate(r.order_date);
      if (r.promised_delivery) setPromised(r.promised_delivery);
      if (r.items?.length) {
        setItems(
          r.items.map((it) => ({
            part_no: it.part_no ?? "",
            description: it.description ?? "",
            maker: it.maker ?? "",
            qty: it.qty ?? 1,
            unit: it.unit ?? "PCS",
            unit_price: it.unit_price ?? 0,
            amount: (it.qty ?? 1) * (it.unit_price ?? 0),
          }))
        );
      }
      setOcrMsg(
        `Extracted: ${r.items?.length ?? 0} item(s)${
          r.customer_hint ? ` · Customer hint ${r.customer_hint}` : ""
        }`
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "OCR extraction failed");
    } finally {
      setOcrBusy(false);
    }
  }

  async function submit() {
    if (customerId === "") return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await createOrder({
        customer_id: customerId,
        vessel_id: vesselId === "" ? null : vesselId,
        quotation_id: quotationId === "" ? null : quotationId,
        rfq_id: rfqId === "" ? null : rfqId,
        po_no: poNo,
        date,
        trade_type: tradeType,
        promised_delivery: promised || null,
        items: cleanItems(items),
      });
      setMsg(`Order created: ${r.project_no}`);
      setPoNo("");
      setPromised("");
      setItems([blankItem()]);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Order creation failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="form-tools">
        <button
          type="button"
          className={`tool-btn${showOcr ? " on" : ""}`}
          onClick={() => setShowOcr((v) => !v)}
        >
          📄 Auto-fill from PDF
        </button>
      </div>

      {showOcr ? (
        <div className="ocr-bar">
          <span className="ocr-bar-label">📄 Auto-fill from order PDF</span>
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => uploadOrderPdf(e.target.files?.[0] ?? null)}
            disabled={ocrBusy}
          />
          {ocrBusy ? (
            <span className="hint-inline">AI is analyzing the PDF…</span>
          ) : ocrMsg ? (
            <span className="action-ok">{ocrMsg}</span>
          ) : (
            <span className="hint-inline">
              Upload a customer P/O PDF → auto-extract customer, PO no., vessel, delivery, items
            </span>
          )}
        </div>
      ) : null}

      <div className="form-grid">
        <div className="form-field">
          <label>Load from quotation</label>
          <select
            value={quotationId}
            onChange={(e) => loadQuotation(e.target.value ? Number(e.target.value) : "")}
          >
            <option value="">— None —</option>
            {options.quotations.map((q) => (
              <option key={q.id} value={q.id}>
                {q.qtn_no} · {q.customer} · {dualCurrencyText(q.amount, q.currency)}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label>Customer *</label>
          <select
            value={customerId}
            onChange={(e) => {
              setCustomerId(e.target.value ? Number(e.target.value) : "");
              setVesselId("");
            }}
          >
            {options.customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label>Order date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="form-field">
          <label>Trade type *</label>
          <select value={tradeType} onChange={(e) => setTradeType(e.target.value)}>
            <option value="수출">{tr("수출")}</option>
            <option value="내수">{tr("내수")}</option>
          </select>
        </div>
        <div className="form-field">
          <label>Customer PO No.</label>
          <input value={poNo} onChange={(e) => setPoNo(e.target.value)} />
        </div>
        <div className="form-field">
          <label>Vessel</label>
          <select
            value={vesselId}
            onChange={(e) => setVesselId(e.target.value ? Number(e.target.value) : "")}
          >
            <option value="">— None —</option>
            {vessels.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label>Promised delivery</label>
          <input
            type="date"
            value={promised}
            onChange={(e) => setPromised(e.target.value)}
          />
        </div>
      </div>

      <div className="form-field" style={{ marginTop: 14 }}>
        <label>Link RFQ</label>
        <select value={rfqId} onChange={(e) => setRfqId(e.target.value ? Number(e.target.value) : "")}>
          <option value="">— None —</option>
          {options.rfqs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.rfq_no} · {r.customer} · {r.vessel || "—"} · {tr(r.status)}
            </option>
          ))}
        </select>
      </div>

      <ItemEditor items={items} onChange={setItems} currency={currency} />

      <div className="form-actions">
        <StageTotal
          label="Total"
          value={items.reduce((s, it) => s + Number(it.amount || 0), 0)}
          currency={currency}
        />
        <button
          className="btn primary"
          onClick={submit}
          disabled={busy || customerId === ""}
        >
          {busy ? "Saving…" : "Create order"}
        </button>
        {msg ? <span className="action-ok">{msg}</span> : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </>
  );
}

function VendorPoCreate({
  options,
  selectedOrderId,
  onChanged,
}: {
  options: PoWorkOptions;
  selectedOrderId: number | null;
  onChanged: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const defaultOrder = selectedOrderId ?? options.orders[0]?.id ?? "";
  const [orderId, setOrderId] = useState<number | "">(defaultOrder);
  const [vendorId, setVendorId] = useState<number | "">("");
  const [poNo, setPoNo] = useState("");
  const [date, setDate] = useState(today);
  const [items, setItems] = useState<PoWorkItem[]>([blankItem()]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (selectedOrderId) setOrderId(selectedOrderId);
  }, [selectedOrderId]);

  const order = options.orders.find((o) => o.id === orderId);

  useEffect(() => {
    if (order) {
      setItems(order.items.length ? order.items.map(normalizeItem) : [blankItem()]);
      setPoNo(order.po_no ? `KM-${order.po_no}` : "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  async function submit() {
    if (orderId === "" || vendorId === "") return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await createPurchaseOrder({
        order_id: orderId,
        vendor_id: vendorId,
        po_no: poNo.trim() || undefined,
        date,
        items: cleanItems(items),
      });
      setMsg(`PO created: ${r.po_no}`);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "PO creation failed");
    } finally {
      setBusy(false);
    }
  }

  if (options.orders.length === 0) {
    return <div className="empty">No orders registered. Register an order in the Customer P/O Received tab first.</div>;
  }

  return (
    <>
      <div className="form-grid">
        <div className="form-field">
          <label>Select target order</label>
          <select value={orderId} onChange={(e) => setOrderId(Number(e.target.value))}>
            {options.orders.map((o) => (
              <option key={o.id} value={o.id}>
                {o.project_no} · {o.customer} · {tr(o.status)}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label>Select vendor</label>
          <select value={vendorId} onChange={(e) => setVendorId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">— None —</option>
            {options.vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label>K-Maris PO No.</label>
          <input
            value={poNo}
            onChange={(e) => setPoNo(e.target.value)}
            placeholder={order?.po_no ? `KM-${order.po_no}` : "KM-…"}
          />
        </div>
        <div className="form-field">
          <label>PO date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>

      {order ? (
        <div className="action-ctx">
          Target order: <b>{order.project_no || "—"}</b> · PO No. {order.po_no || "—"} · {order.customer} · {order.vessel || "—"} · {order.items.length} item(s)
        </div>
      ) : null}

      <ItemEditor items={items} onChange={setItems} currency={order?.currency || "USD"} />

      <div className="form-actions">
        <StageTotal
          label="Total"
          value={items.reduce((s, it) => s + Number(it.amount || 0), 0)}
          currency={order?.currency || "USD"}
        />
        <button
          className="btn primary"
          onClick={submit}
          disabled={busy || orderId === "" || vendorId === ""}
        >
          {busy ? "Creating…" : "Create PO"}
        </button>
        {msg ? <span className="action-ok">{msg}</span> : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>

      <IssuedPoTable purchaseOrders={options.purchase_orders.filter((p) => p.order_id === orderId)} />
    </>
  );
}

function VendorPoSend({
  options,
  onChanged,
}: {
  options: PoWorkOptions;
  onChanged: () => void;
}) {
  const [poId, setPoId] = useState<number | "">(options.purchase_orders[0]?.id ?? "");
  const [lang, setLang] = useState<"en" | "ko">("en");
  const [notes, setNotes] = useState("");
  const [preview, setPreview] = useState<VendorPoPreview | null>(null);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const po = options.purchase_orders.find((p) => p.id === poId);

  async function makePreview() {
    if (poId === "") return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const p = await previewVendorPo(poId, lang, notes);
      setPreview(p);
      setTo(p.to);
      setSubject(p.subject);
      setBody(p.body);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Preview generation failed");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (poId === "") return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await sendVendorPo(poId, to, subject, body);
      setMsg(`Email sent: ${r.sent_date}`);
      setPreview(null);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Email sending failed");
    } finally {
      setBusy(false);
    }
  }

  async function downloadPdf() {
    if (poId === "") return;
    const res = await fetch(vendorPoPdfUrl(poId), {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) {
      setErr("PDF download failed");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = preview?.pdf_filename ?? `${po?.po_no ?? "PurchaseOrder"}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (options.purchase_orders.length === 0) {
    return <div className="empty">No purchase orders issued. Create one in the Create PO tab first.</div>;
  }

  return (
    <>
      <div className="form-grid">
        <div className="form-field">
          <label>Select PO to send</label>
          <select
            value={poId}
            onChange={(e) => {
              setPoId(Number(e.target.value));
              setPreview(null);
            }}
          >
            {options.purchase_orders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.po_no} · {p.vendor} · {tr(p.status)}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label>Email language</label>
          <select value={lang} onChange={(e) => setLang(e.target.value as "en" | "ko")}>
            <option value="en">English</option>
            <option value="ko">Korean</option>
          </select>
        </div>
      </div>

      {po ? (
        <div className="action-ctx">
          PO: <b>{po.po_no}</b> · {po.vendor} · {po.project_no} · {po.items.length} item(s)
        </div>
      ) : null}

      <div className="form-field">
        <label>Note to vendor</label>
        <textarea
          className="po-textarea small"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      {!preview ? (
        <div className="form-actions">
          <button className="btn" onClick={makePreview} disabled={busy || poId === ""}>
            {busy ? "Creating…" : "Preview email"}
          </button>
          {err ? <span className="action-err">{err}</span> : null}
        </div>
      ) : (
        <>
          <div className="po-work-note">
            <b>Email preview</b>
            <span>Review and edit the email below before sending. It is recorded only after a successful send.</span>
          </div>
          <div className="form-grid">
            <div className="form-field">
              <label>Recipient email</label>
              <input value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="form-field">
              <label>Subject</label>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
          </div>
          <div className="form-field">
            <label>Body</label>
            <textarea
              className="po-textarea"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          {!preview.smtp_configured ? (
            <div className="action-err">
              SMTP not configured: without SMTP_USER / SMTP_PASSWORD, real sending is unavailable.
            </div>
          ) : null}
          <div className="form-actions">
            <button className="btn" onClick={downloadPdf} disabled={poId === ""}>
              Download PO PDF
            </button>
            <button
              className="btn primary"
              onClick={send}
              disabled={busy || !to || !preview.smtp_configured}
            >
              {busy ? "Sending…" : "Send email"}
            </button>
            <button className="btn" onClick={() => setPreview(null)}>
              Cancel
            </button>
            {msg ? <span className="action-ok">{msg}</span> : null}
            {err ? <span className="action-err">{err}</span> : null}
          </div>
        </>
      )}
    </>
  );
}

function IssuedPoTable({
  purchaseOrders,
}: {
  purchaseOrders: PoWorkOptions["purchase_orders"];
}) {
  if (purchaseOrders.length === 0) return null;
  return (
    <>
      <div className="sub-h" style={{ marginTop: 16 }}>
        Issued purchase orders
      </div>
      <table className="mini wide">
        <thead>
          <tr>
            <th>K-Maris PO No.</th>
            <th>Vendor</th>
            <th>PO date</th>
            <th>Status</th>
            <th className="num">Items</th>
          </tr>
        </thead>
        <tbody>
          {purchaseOrders.map((p) => (
            <tr key={p.id}>
              <td>{p.po_no}</td>
              <td>{p.vendor}</td>
              <td>{p.date || "—"}</td>
              <td>{p.status}</td>
              <td className="num">{p.items.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function ItemEditor({
  items,
  onChange,
  currency = "USD",
  headerActions,
}: {
  items: PoWorkItem[];
  onChange: (items: PoWorkItem[]) => void;
  currency?: string;
  // 품목표 헤더의 "+ Add" 옆에 넣을 보조 액션(예: "Load order items").
  headerActions?: React.ReactNode;
}) {
  function patch(i: number, key: keyof PoWorkItem, value: string) {
    onChange(
      items.map((it, idx) => {
        if (idx !== i) return it;
        if (key === "qty" || key === "unit_price" || key === "amount") {
          return { ...it, [key]: parseAmountInput(value) };
        }
        return { ...it, [key]: value };
      })
    );
  }
  const total = items.reduce((sum, it) => sum + Number(it.amount || 0), 0);

  return (
    <div style={{ marginTop: 16 }}>
      <div className="items-head">
        <div className="sub-h">Item list</div>
        <div className="items-head-actions">
          {headerActions}
          <button className="btn sm items-head-add" onClick={() => onChange([...items, blankItem()])}>+ Add</button>
        </div>
      </div>
      <div className="table-wrap item-scroll">
        <table className="mini wide lead-tools">
          <thead>
            <tr>
              <th className="row-tools"></th>
              <th className="seq">No.</th>
              <th>Part No.</th>
              <th>Description</th>
              <th>Maker</th>
              <th className="num">Qty</th>
              <th>Unit</th>
              <th className="num">Unit price</th>
              <th className="num">Amount</th>
              <th>Remark</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i} className={itemRowClass(i)}>
                <td className="row-tools">
                  <button
                    className="row-del"
                    onClick={() => onChange(items.filter((_, idx) => idx !== i))}
                    disabled={items.length === 1}
                  >
                    ×
                  </button>
                </td>
                <td className="seq">{i + 1}</td>
                <td>
                  <textarea {...gridCellProps(i, 0)} className="wrapcell" rows={1} value={it.part_no} onChange={(e) => patch(i, "part_no", e.target.value)} />
                </td>
                <td>
                  <textarea {...gridCellProps(i, 1)} className="desc" rows={1} value={it.description} onChange={(e) => patch(i, "description", e.target.value)} />
                </td>
                <td>
                  <textarea {...gridCellProps(i, 2)} className="wrapcell" rows={1} value={it.maker ?? ""} onChange={(e) => patch(i, "maker", e.target.value)} />
                </td>
                <td>
                  <input
                    {...gridCellProps(i, 3)}
                    className="num"
                    value={amountInputValue(it.qty)}
                    onChange={(e) => patch(i, "qty", e.target.value)}
                  />
                </td>
                <td>
                  <input {...gridCellProps(i, 4)} value={it.unit} onChange={(e) => patch(i, "unit", e.target.value)} />
                </td>
                <td>
                  <input
                    {...gridCellProps(i, 5)}
                    className="num"
                    value={amountInputValue(it.unit_price)}
                    onChange={(e) => patch(i, "unit_price", e.target.value)}
                  />
                </td>
                <td>
                  <input
                    {...gridCellProps(i, 6)}
                    className="num"
                    value={amountInputValue(it.amount)}
                    onChange={(e) => patch(i, "amount", e.target.value)}
                  />
                </td>
                <td>
                  <textarea {...gridCellProps(i, 7)} className="wrapcell" rows={1} value={it.remark ?? ""} onChange={(e) => patch(i, "remark", e.target.value)} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={8} className="total-label">Total</td>
              <td className="num total-value">
                <DualCurrencyAmount value={total} currency={currency} />
                <span className="fx-note">{fxRateText()}</span>
              </td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function blankItem(): PoWorkItem {
  return {
    part_no: "",
    description: "",
    maker: "",
    qty: 1,
    unit: "PCS",
    unit_price: 0,
    amount: 0,
    remark: "",
  };
}

function normalizeItem(it: Partial<PoWorkItem>): PoWorkItem {
  const qty = Number(it.qty ?? 1) || 1;
  const unitPrice = it.unit_price ?? 0;
  return {
    part_no: it.part_no ?? "",
    description: it.description ?? "",
    maker: it.maker ?? "",
    qty,
    unit: it.unit ?? "PCS",
    unit_price: unitPrice,
    amount: it.amount ?? qty * Number(unitPrice ?? 0),
    remark: it.remark ?? "",
  };
}

function cleanItems(items: PoWorkItem[]): PoWorkItem[] {
  return items
    .map(normalizeItem)
    .filter((it) => it.part_no.trim() || it.description.trim());
}
