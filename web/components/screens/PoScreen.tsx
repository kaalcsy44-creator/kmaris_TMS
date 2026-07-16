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
  vendorPoXlsxUrl,
  updateOrder,
  deleteOrder,
  fetchVendorPoDetail,
  updatePurchaseOrder,
  deletePurchaseOrder,
  fetchNextPoNo,
  fetchRfqVendorQuotes,
} from "@/lib/api";
import { getToken, can, canEditDeal, editBlockReason } from "@/lib/auth";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import FilterTable, { ColumnDef } from "@/components/common/FilterTable";
import { identityColumns, projectNoColumn } from "@/components/common/identityColumns";
import VendorName from "@/components/common/VendorName";
import CustomerName from "@/components/common/CustomerName";
import Modal from "@/components/common/Modal";
import BaseMetaRows, { ModalTitle } from "@/components/common/BaseMeta";
import CurrencyToggle from "@/components/common/CurrencyToggle";
import TermsEditor from "@/components/common/TermsEditor";
import DocSendPanel from "@/components/common/DocSendPanel";
import DetailTabBar, { DetailTab } from "@/components/common/DetailTabBar";
import { sortByDocNo } from "@/lib/sort";
import {
  amountInputValue,
  DeleteSelectedButton,
  deleteSelectedRows,
  DualCurrencyAmount,
  fxRateText,
  useItemGridKeys,
  CopyRowsButton,
  ItemGridHint,
  ItemSelectCell,
  ItemSelectHeaderCell,
  itemRowClass,
  parseAmountInput,
  StageTotal,
  useRowSelection,
} from "@/components/common/itemTable";
import { useItemGrid, ItemTh, ItemGridStyle, ItemColsButton, type ItemCol } from "@/components/common/itemGrid";
import { tr } from "@/lib/labels";
import type {
  PoDetail as PoDetailT,
  PoWorkItem,
  PoWorkOptions,
  VendorPoPreview,
  PurchaseOrderDetail,
  VendorQuoteForImport,
  QuotationTerms,
  RfqSourceFile,
} from "@/lib/types";
import SourceFilesList from "@/components/common/SourceFilesList";
import { withDefaultTerms } from "@/lib/terms";

type OrderOpt = PoWorkOptions["orders"][number];
type PoOpt = PoWorkOptions["purchase_orders"][number];

// Auto-fill 소스 파일 메타 시각용 로컬 "YYYY-MM-DDTHH:MM".
function nowLocalMeta(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

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
  deepRfqId,
  initialTab,
  onChanged,
  embedded,
}: {
  options: PoWorkOptions;
  deepOrderId: number | null;
  // 프로젝트 워크스페이스에서 이 프로젝트(RFQ)로 신규 오더를 자동 연결하기 위한 rfq_id.
  deepRfqId?: number | null;
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
    { key: "customer", label: "5. P/O Received" },
    { key: "vendor", label: "6. P/O Sent" },
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
        <CustomerPoTab options={options} deepOrderId={deepOrderId} deepRfqId={deepRfqId} onChanged={onChanged} embedded={embedded} />
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
  deepRfqId,
  onChanged,
  embedded,
}: {
  options: PoWorkOptions;
  deepOrderId: number | null;
  deepRfqId?: number | null;
  onChanged: () => void;
  embedded?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(deepOrderId);

  useEffect(() => {
    setDetailId(deepOrderId);
  }, [deepOrderId]);

  // 프로젝트 워크스페이스: 이 프로젝트(RFQ)의 고객 P/O(오더)들. 여러 건이면 선택기 +
  // '+ Add another P/O'. 없거나 신규 추가면 등록 폼(현재 프로젝트로 자동 연결).
  if (embedded) {
    // 복수 P/O는 K-Maris PO 번호 오름차순(숫자 빠른 순)으로 좌→우 배치.
    const projectOrders = sortByDocNo(
      deepRfqId != null
        ? options.orders.filter((o) => o.rfq_id === deepRfqId)
        : deepOrderId
        ? options.orders.filter((o) => o.id === deepOrderId)
        : [],
      (o) => o.po_no,
      (o) => o.id
    );

    if (projectOrders.length === 0 || adding) {
      return (
        <div className="embedded-detail">
          <div className="embedded-add-head">
            {projectOrders.length ? (
              <button type="button" className="btn" onClick={() => setAdding(false)}>← Back</button>
            ) : null}
            <span className="form-section-title" style={{ margin: 0 }}>Basic Info</span>
          </div>
          <CustomerPoNewForm
            options={options}
            projectRfqId={deepRfqId ?? null}
            onChanged={() => { setAdding(false); onChanged(); }}
          />
        </div>
      );
    }

    const selected = projectOrders.find((o) => o.id === detailId) ?? projectOrders[0];
    return (
      <div className="embedded-po-list">
        <div className="embedded-record-bar">
          {projectOrders.length > 1 ? (
            <div className="embedded-record-picker" role="tablist" aria-label="Customer POs">
              {projectOrders.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={o.id === selected.id ? "on" : ""}
                  onClick={() => setDetailId(o.id)}
                >
                  {o.po_no || o.vessel || `PO ${o.id}`}
                </button>
              ))}
            </div>
          ) : (
            <span className="embedded-record-current">
              <CustomerName name={selected.customer || ""} />
              <b className="rec-doc-no">{selected.po_no || ""}</b>
            </span>
          )}
          <button type="button" className="btn primary sm" onClick={() => setAdding(true)}>+ Add another P/O</button>
        </div>
        <OrderDetailModal
          orderId={selected.id}
          options={options}
          onClose={onChanged}
          onChanged={onChanged}
          inline
        />
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
  const [terms, setTerms] = useState<QuotationTerms>(withDefaultTerms());
  const [ocrFiles, setOcrFiles] = useState<RfqSourceFile[]>([]); // Auto-fill 소스 파일 목록(영구 보관)
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
        // 선박은 id 우선 매칭(이름 정확일치는 취약). id 없으면 이름으로 폴백.
        const ves =
          (d.vessel_id ? options.vessels.find((v) => v.id === d.vessel_id) : undefined) ??
          options.vessels.find((v) => v.name === d.vessel);
        setDetail(d);
        setCustomerId(cust?.id ?? "");
        setVesselId(ves?.id ?? "");
        setPoNo(d.customer_po_no || "");
        setDate(d.customer_po_at || "");
        setTradeType(d.trade_type || "수출");
        setCurrency(d.currency || "USD");
        setPromised(d.promised_delivery || "");
        setItems(d.items.length ? d.items.map(normalizeItem) : [blankItem()]);
        setTerms(withDefaultTerms(d.terms));
        setOcrFiles(Array.isArray(d.source_files) ? d.source_files : []);
        setOcrMsg(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Load failed"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  // "Load customer quote" — 이 프로젝트의 고객 견적(4단계) 품목·금액으로 채운다.
  // (별도 Customer P/O 파일이 없을 때, 견적 그대로 주문 품목으로 불러오기 위함.)
  function loadCustomerQuoteItems() {
    const qno = detail?.quotation_no && detail.quotation_no !== "-" ? detail.quotation_no : "";
    const rno = detail?.rfq_no && detail.rfq_no !== "-" ? detail.rfq_no : "";
    const rfqIdOfProject = rno ? options.rfqs.find((r) => r.rfq_no === rno)?.id : undefined;
    const q = options.quotations.find(
      (x) => (qno && x.qtn_no === qno) || (rfqIdOfProject != null && x.rfq_id === rfqIdOfProject)
    );
    if (!q) {
      setErr("Linked customer quotation not found.");
      return;
    }
    setCurrency(q.currency || currency);
    setItems(q.items.length ? q.items.map(normalizeItem) : [blankItem()]);
    setOcrMsg(`Loaded ${q.items.length} item(s) from quotation ${q.qtn_no}.`);
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

  // 복수 파일 지원 — 여러 개를 순차 분석해 아이템을 누적하고, 헤더 정보(고객·선박·
  // PO번호·일자·납기)는 첫 유효 추출 1회만 반영해 뒤 파일이 덮어쓰지 않게 한다.
  async function uploadOrderFile(input: File | FileList | null) {
    if (!input) return;
    const files = input instanceof File ? [input] : Array.from(input);
    if (!files.length) return;
    setOcrBusy(true);
    setErr(null);
    setOcrMsg(null);
    try {
      const collected: PoWorkItem[] = [];
      const newFiles: RfqSourceFile[] = [];
      let ok = 0;
      let headerFilled = false;
      let hint = "";
      for (const file of files) {
        const r = await parseOrderPdf(file);
        ok++;
        newFiles.push({
          name: file.name || "(unnamed)",
          media_type: file.type || "",
          item_count: r.items?.length ?? 0,
          at: nowLocalMeta(),
        });
        if (!headerFilled) {
          const cust = matchByName(r.customer_hint, options.customers);
          if (cust) setCustomerId(cust.id);
          const vessel = matchByName(r.vessel_name, options.vessels);
          if (vessel) setVesselId(vessel.id);
          if (r.po_no) setPoNo(r.po_no);
          if (r.order_date) setDate(r.order_date);
          if (r.promised_delivery) setPromised(r.promised_delivery);
          if (r.customer_hint) hint = r.customer_hint;
          if (r.customer_hint || r.vessel_name || r.po_no || r.items?.length) headerFilled = true;
        }
        for (const it of r.items ?? []) {
          collected.push(
            normalizeItem({
              part_no: it.part_no ?? "",
              description: it.description ?? "",
              maker: it.maker ?? "",
              qty: it.qty ?? 1,
              unit: it.unit ?? "PCS",
              unit_price: it.unit_price ?? 0,
              amount: (it.qty ?? 1) * (it.unit_price ?? 0),
            })
          );
        }
      }
      setOcrFiles((prev) => [...prev, ...newFiles]);
      if (collected.length) {
        setItems((prev) => {
          const kept = prev.filter((it) => it.part_no.trim() || it.description.trim());
          return [...kept, ...collected];
        });
      }
      setOcrMsg(
        `Extracted: +${collected.length} item(s)${files.length > 1 ? ` from ${ok} files` : ""}${
          hint ? ` · Customer hint ${hint}` : ""
        }`
      );
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
        currency,
        trade_type: tradeType,
        promised_delivery: promised || null,
        items: cleanItems(items),
        terms,
        source_files: ocrFiles,
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

  // 편집 권한 = 역할 권한(po.edit) × 담당(PIC) 소유권. 없으면 읽기전용.
  const canEditThis = can("po", "edit") && canEditDeal(detail?.assignee_id);
  const canDeleteThis = can("po", "delete") && canEditDeal(detail?.assignee_id);

  // 선택 고객사에 속한 선박만 노출(고객 미선택이면 전체).
  // 고객사 기준으로 거르되, (a) 현재 선택된 선박과 (b) 이 프로젝트(RFQ)의 선박은
  // 다른 고객사 소속이거나 마스터 등록이 안 돼 있어도 항상 후보에 포함해,
  // 프로젝트 선박이 목록에서 빠져 엉뚱한 선박만 보이는 일이 없도록 한다.
  const projRfq = options.rfqs.find((r) => r.rfq_no === detail?.rfq_no);
  const projVesselId = detail?.vessel_id || projRfq?.vessel_id || 0;
  const projVesselName = (detail?.vessel || projRfq?.vessel || "").trim();
  const vessels = options.vessels.filter(
    (v) =>
      customerId === "" ||
      v.customer_id === customerId ||
      v.id === vesselId ||
      (projVesselId ? v.id === projVesselId : false) ||
      (projVesselName ? v.name === projVesselName : false)
  );
  // 프로젝트 선박 이름이 선박 마스터에 아예 없으면, 안내용(선택 불가) 옵션으로라도
  // 노출해 "이 프로젝트 선박은 미등록"임을 알리고 설정에서 추가하도록 유도한다.
  const projVesselUnregistered =
    !!projVesselName && !vessels.some((v) => v.name === projVesselName);

  return (
    <Modal title={<ModalTitle label="Edit order" projectNo={order?.project_no} />} onClose={onClose} wide inline={inline}>
      {!detail ? (
        <div className="state">Loading details…</div>
      ) : (
        <>
          {/* 인라인(임베드) 상세는 상위 CustomerPoTab이 레코드 바(선택기·+ Add)를
              그리므로 여기서는 중복 표시하지 않는다. */}
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
          {/* 좌: 입력 필드 / 우: Auto-fill 도구·소스파일(CSS order 로 우측 배치). */}
          <div className="received-split">
          <aside className="received-tools">
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
                multiple
                accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*"
                onChange={(e) => {
                  uploadOrderFile(e.target.files);
                  e.target.value = "";
                }}
                disabled={ocrBusy || busy}
              />
              {ocrBusy ? (
                <span className="hint-inline">Analyzing…</span>
              ) : ocrMsg ? (
                <span className="action-ok">{ocrMsg}</span>
              ) : (
                <span className="hint-inline">Upload customer P/O files (multiple OK) → items accumulate</span>
              )}
            </div>
          ) : null}
          <SourceFilesList
            files={ocrFiles}
            onRemove={canEditThis ? (i) => setOcrFiles((prev) => prev.filter((_, idx) => idx !== i)) : undefined}
          />
          </aside>
          {/* 좌측: 입력 필드(세로 1열, 성격별 그룹 스택). */}
          <div className="received-fields">
            <div className="basic-col">
              <div className="basic-col-title">Customer &amp; vessel</div>
              <div className="form-field">
                <label>Customer</label>
                <select
                  value={customerId}
                  onChange={(e) => {
                    setCustomerId(e.target.value ? Number(e.target.value) : "");
                    setVesselId("");
                  }}
                >
                  <option value="">— Select customer —</option>
                  {options.customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-field">
                <label>Vessel</label>
                <select
                  value={vesselId}
                  onChange={(e) => setVesselId(e.target.value ? Number(e.target.value) : "")}
                >
                  <option value="">— None —</option>
                  {vessels.map((v) => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                  {projVesselUnregistered && (
                    <option value="" disabled>
                      {projVesselName} (미등록 — 설정에서 추가)
                    </option>
                  )}
                </select>
              </div>
              <div className="form-field">
                <label>Trade type</label>
                <select value={tradeType} onChange={(e) => setTradeType(e.target.value)}>
                  <option value="수출">{tr("수출")}</option>
                  <option value="내수">{tr("내수")}</option>
                </select>
              </div>
            </div>
            <div className="basic-col">
              <div className="basic-col-title">Order details</div>
              <div className="form-field">
                <label>Customer PO No.</label>
                <input value={poNo} onChange={(e) => setPoNo(e.target.value)} />
              </div>
              <div className="form-field">
                <label>Order date</label>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div className="form-field">
                <label>Currency</label>
                <CurrencyToggle value={currency} onChange={setCurrency} />
              </div>
              <div className="form-field">
                <label>Promised delivery</label>
                <input type="date" value={promised} onChange={(e) => setPromised(e.target.value)} />
              </div>
            </div>
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
                  onClick={loadCustomerQuoteItems}
                  disabled={busy}
                  title="Load items and amounts from this project's customer quotation (when there is no separate P/O file)"
                >
                  Load customer quote
                </button>
              ) : null
            }
          />
          <TermsEditor terms={terms} onChange={setTerms} />
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
    // 복수 Vendor PO는 K-Maris PO 번호 오름차순(숫자 빠른 순)으로 좌→우 배치.
    const pos = sortByDocNo(
      options.purchase_orders.filter((p) => p.order_id === deepOrderId),
      (p) => p.po_no,
      (p) => p.id
    );
    if (pos.length === 0 || adding) {
      return (
        <div className="embedded-detail">
          <div className="embedded-add-head">
            {pos.length ? (
              <button type="button" className="btn" onClick={() => setAdding(false)}>← Back</button>
            ) : null}
            <span className="form-section-title" style={{ margin: 0 }}>Basic Info</span>
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
          ) : (
            <span className="embedded-record-current">
              <VendorName name={selected.vendor || ""} />
              <b className="rec-doc-no">{selected.po_no || ""}</b>
            </span>
          )}
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
  const [tab, setTab] = useState<DetailTab>("edit");
  const [vendorId, setVendorId] = useState<number | "">("");
  const [poNo, setPoNo] = useState("");
  const [poDate, setPoDate] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [status, setStatus] = useState("");
  const [items, setItems] = useState<PoWorkItem[]>([]);
  const [terms, setTerms] = useState<QuotationTerms>(withDefaultTerms());
  const [vendorQuotes, setVendorQuotes] = useState<VendorQuoteForImport[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 편집 권한 = 역할 권한(po.edit) × 담당(PIC) 소유권. 없으면 읽기전용.
  const canEditThis = can("po", "edit") && canEditDeal(d?.assignee_id);
  const canDeleteThis = can("po", "delete") && canEditDeal(d?.assignee_id);

  // Vendor 드롭다운은 모든 벤더를 노출(견적 제출 벤더로 제한하지 않음).
  const vendorChoices = options.vendors;

  useEffect(() => {
    fetchVendorPoDetail(id)
      .then((data) => {
        setD(data);
        setVendorId(data.vendor_id || "");
        // 이미 채번되어 저장된 K-Maris PO No.(KMS-ORD-…)를 그대로 보여준다.
        setPoNo(data.po_no || "");
        setPoDate(data.date || "");
        setCurrency(data.currency || "USD");
        setStatus(data.status || "");
        setItems(data.items.length ? data.items.map(normalizeItem) : [blankItem()]);
        setTerms(withDefaultTerms(data.terms));
        // 이 발주서가 속한 오더의 프로젝트(RFQ)에서 수신한 공급사 견적들.
        const ord = options.orders.find((o) => o.id === data.order_id);
        if (ord) {
          fetchRfqVendorQuotes(ord.rfq_id)
            .then((r) => setVendorQuotes(r.vendor_quotes))
            .catch(() => setVendorQuotes([]));
        } else {
          setVendorQuotes([]);
        }
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // 선택한 공급사 견적의 품목·단가를 발주서 품목으로 불러온다.
  function loadVendorQuote(vq: VendorQuoteForImport) {
    setItems(poItemsFromVendorQuote(vq));
    const v = options.vendors.find((x) => x.name === vq.vendor);
    if (v) setVendorId(v.id);
    setErr(null);
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await updatePurchaseOrder(id, {
        vendor_id: vendorId === "" ? undefined : vendorId,
        po_no: poNo.trim() || undefined,
        date: poDate,
        currency,
        status,
        items: cleanItems(items),
        terms,
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

  return (
    <Modal title={d ? <ModalTitle label={`Edit purchase order — ${d.po_no}`} projectNo={d.project_no} /> : "PO details"} onClose={onClose} wide inline={inline}>
      {!d ? (
        <div className="state">Loading details…</div>
      ) : (
        <>
          <DetailTabBar tab={tab} onTab={setTab} />
          {tab === "edit" ? (
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
                <div><dt>PO date</dt><dd>{d.date || "—"}</dd></div>
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
                {vendorChoices.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label>K-Maris PO No.</label>
              <input
                value={poNo}
                onChange={(e) => setPoNo(e.target.value)}
                placeholder="KMS-ORD-…"
              />
            </div>
            <div className="form-field">
              <label>PO date</label>
              <input type="date" value={poDate} onChange={(e) => setPoDate(e.target.value)} />
            </div>
            <div className="form-field">
              <label>Currency</label>
              <CurrencyToggle value={currency} onChange={setCurrency} />
            </div>
          </div>
          <ItemEditor
            items={items}
            onChange={setItems}
            currency={currency}
            headerActions={
              canEditThis ? (
                <LoadVendorQuoteControl
                  vendorQuotes={vendorQuotes}
                  onLoad={loadVendorQuote}
                  disabled={busy}
                />
              ) : null
            }
          />
          <TermsEditor terms={terms} onChange={setTerms} />
          </fieldset>
          <div className="form-actions">
            <StageTotal
              label="Total"
              value={items.reduce((s, it) => s + Number(it.amount || 0), 0)}
              currency={currency}
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
          ) : (
          /* 발주서 파일 생성(PDF/Excel) + 벤더 이메일 발송(선택 포맷 첨부). 저장본 기준. */
          <DocSendPanel
            title="Purchase Order · Email to Vendor"
            formats={["pdf", "xlsx"]}
            downloadUrl={(f) => (f === "xlsx" ? vendorPoXlsxUrl(id) : vendorPoPdfUrl(id))}
            downloadName={(f) => `${d.po_no || "PurchaseOrder"}.${f}`}
            onPreview={(lang) => previewVendorPo(id, lang)}
            onSend={(p) => sendVendorPo({ ...p, poId: id })}
            disabled={!canEditThis}
            disabledReason={!canEditThis ? editBlockReason("po", d?.assignee_id) : "Generated from the last saved version — save your edits first."}
            onSent={onChanged}
          />
          )}
        </>
      )}
    </Modal>
  );
}

function CustomerPoNewForm({
  options,
  onChanged,
  projectRfqId,
}: {
  options: PoWorkOptions;
  onChanged: () => void;
  // 프로젝트 워크스페이스(임베드)에서 주어지면 이 RFQ로 자동 연결하고 Link RFQ 셀렉터는 숨긴다.
  projectRfqId?: number | null;
}) {
  const today = new Date().toISOString().slice(0, 10);
  // 기본값은 미선택("") — 사용자가 명시적으로 고객사를 고르도록 한다.
  const [customerId, setCustomerId] = useState<number | "">("");
  const [vesselId, setVesselId] = useState<number | "">("");
  // 임베드 모드면 현재 프로젝트 RFQ로 고정, 아니면 사용자가 Link RFQ에서 선택.
  const [rfqId, setRfqId] = useState<number | "">(projectRfqId ?? "");
  const [poNo, setPoNo] = useState("");
  const [date, setDate] = useState(today);
  const [currency, setCurrency] = useState("USD");
  const [tradeType, setTradeType] = useState("수출");
  const [promised, setPromised] = useState("");
  const [items, setItems] = useState<PoWorkItem[]>([blankItem()]);
  const [terms, setTerms] = useState<QuotationTerms>(withDefaultTerms());
  const [ocrFiles, setOcrFiles] = useState<RfqSourceFile[]>([]); // Auto-fill 소스 파일 목록(영구 보관)
  const [busy, setBusy] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [showOcr, setShowOcr] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ocrMsg, setOcrMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // 고객사 기준으로 거르되, (a) 현재 선택된 선박과 (b) 연결된 RFQ의 선박은 다른
  // 고객사 소속이거나 미등록이어도 항상 후보에 포함(편집 모달과 동일 규칙).
  const projRfq = options.rfqs.find(
    (r) => r.id === (rfqId === "" ? projectRfqId : rfqId)
  );
  const projVesselId = projRfq?.vessel_id || 0;
  const projVesselName = (projRfq?.vessel || "").trim();
  const vessels = options.vessels.filter(
    (v) =>
      customerId === "" ||
      v.customer_id === customerId ||
      v.id === vesselId ||
      (projVesselId ? v.id === projVesselId : false) ||
      (projVesselName ? v.name === projVesselName : false)
  );
  const projVesselUnregistered =
    !!projVesselName && !vessels.some((v) => v.name === projVesselName);

  // 프로젝트(임베드) 등록 시 해당 RFQ의 고객·선박을 기본값으로 채운다 → 오더에 선박이
  // 비지 않도록. 사용자가 이미 값을 바꿨으면 덮어쓰지 않는다.
  useEffect(() => {
    if (projectRfqId == null) return;
    const rfq = options.rfqs.find((r) => r.id === projectRfqId);
    if (!rfq) return;
    setCustomerId((prev) => (prev === "" ? rfq.customer_id ?? "" : prev));
    setVesselId((prev) => (prev === "" && rfq.vessel_id ? rfq.vessel_id : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRfqId, options.rfqs]);

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

  // 복수 파일 지원 — 여러 개를 순차 분석해 아이템을 누적하고, 헤더 정보는 첫 유효 추출 1회만 반영.
  async function uploadOrderPdf(input: File | FileList | null) {
    if (!input) return;
    const files = input instanceof File ? [input] : Array.from(input);
    if (!files.length) return;
    setOcrBusy(true);
    setErr(null);
    setOcrMsg(null);
    try {
      const collected: PoWorkItem[] = [];
      const newFiles: RfqSourceFile[] = [];
      let ok = 0;
      let headerFilled = false;
      let hint = "";
      for (const file of files) {
        const r = await parseOrderPdf(file);
        ok++;
        newFiles.push({
          name: file.name || "(unnamed)",
          media_type: file.type || "",
          item_count: r.items?.length ?? 0,
          at: nowLocalMeta(),
        });
        if (!headerFilled) {
          const cust = matchByName(r.customer_hint, options.customers);
          if (cust) setCustomerId(cust.id);
          const vessel = matchByName(r.vessel_name, options.vessels);
          if (vessel) setVesselId(vessel.id);
          if (r.po_no) setPoNo(r.po_no);
          if (r.order_date) setDate(r.order_date);
          if (r.promised_delivery) setPromised(r.promised_delivery);
          if (r.customer_hint) hint = r.customer_hint;
          if (r.customer_hint || r.vessel_name || r.po_no || r.items?.length) headerFilled = true;
        }
        for (const it of r.items ?? []) {
          collected.push(
            normalizeItem({
              part_no: it.part_no ?? "",
              description: it.description ?? "",
              maker: it.maker ?? "",
              qty: it.qty ?? 1,
              unit: it.unit ?? "PCS",
              unit_price: it.unit_price ?? 0,
              amount: (it.qty ?? 1) * (it.unit_price ?? 0),
            })
          );
        }
      }
      setOcrFiles((prev) => [...prev, ...newFiles]);
      if (collected.length) {
        setItems((prev) => {
          const kept = prev.filter((it) => it.part_no.trim() || it.description.trim());
          return [...kept, ...collected];
        });
      }
      setOcrMsg(
        `Extracted: +${collected.length} item(s)${files.length > 1 ? ` from ${ok} files` : ""}${
          hint ? ` · Customer hint ${hint}` : ""
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
        quotation_id: null,
        rfq_id: rfqId === "" ? null : rfqId,
        po_no: poNo,
        date,
        currency,
        trade_type: tradeType,
        promised_delivery: promised || null,
        items: cleanItems(items),
        terms,
        source_files: ocrFiles,
      });
      setMsg(`Order created: ${r.project_no}`);
      setPoNo("");
      setPromised("");
      setItems([blankItem()]);
      setTerms(withDefaultTerms());
      setOcrFiles([]);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Order creation failed");
    } finally {
      setBusy(false);
    }
  }

  // 이 프로젝트(임베드) 또는 선택한 Link RFQ의 고객 견적 — 품목·통화를 그대로 불러온다.
  const linkedRfqId = projectRfqId ?? (rfqId === "" ? null : rfqId);
  const linkedQuote =
    linkedRfqId != null ? options.quotations.find((q) => q.rfq_id === linkedRfqId) : undefined;

  function loadCustomerQuote() {
    if (!linkedQuote) {
      setErr("Linked customer quotation not found for this project.");
      return;
    }
    setCurrency(linkedQuote.currency || currency);
    setItems(linkedQuote.items.length ? linkedQuote.items.map(normalizeItem) : [blankItem()]);
    setOcrMsg(`Loaded ${linkedQuote.items.length} item(s) from quotation ${linkedQuote.qtn_no}.`);
    setErr(null);
  }

  return (
    <>
      {/* 좌: 입력 필드 / 우: Auto-fill 도구·소스파일(CSS order 로 우측 배치). */}
      <div className="received-split">
      <aside className="received-tools">
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
          <span className="ocr-bar-label">📄 Auto-fill from order PDF</span>
          <input
            type="file"
            multiple
            accept="application/pdf"
            onChange={(e) => {
              uploadOrderPdf(e.target.files);
              e.target.value = "";
            }}
            disabled={ocrBusy}
          />
          {ocrBusy ? (
            <span className="hint-inline">AI is analyzing the PDF…</span>
          ) : ocrMsg ? (
            <span className="action-ok">{ocrMsg}</span>
          ) : (
            <span className="hint-inline">
              Upload customer P/O PDFs (multiple OK) → auto-extract customer, PO no., vessel, delivery; items accumulate
            </span>
          )}
        </div>
      ) : null}
      <SourceFilesList
        files={ocrFiles}
        onRemove={(i) => setOcrFiles((prev) => prev.filter((_, idx) => idx !== i))}
      />
      </aside>
      {/* 좌측: 입력 필드(세로 1열, 성격별 그룹 스택). */}
      <div className="received-fields">
        <div className="basic-col">
          <div className="basic-col-title">Customer &amp; vessel</div>
          <div className="form-field">
            <label>Customer *</label>
            <select
              value={customerId}
              onChange={(e) => {
                setCustomerId(e.target.value ? Number(e.target.value) : "");
                setVesselId("");
              }}
            >
              <option value="">— Select customer —</option>
              {options.customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
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
              {projVesselUnregistered && (
                <option value="" disabled>
                  {projVesselName} (미등록 — 설정에서 추가)
                </option>
              )}
            </select>
          </div>
          <div className="form-field">
            <label>Trade type *</label>
            <select value={tradeType} onChange={(e) => setTradeType(e.target.value)}>
              <option value="수출">{tr("수출")}</option>
              <option value="내수">{tr("내수")}</option>
            </select>
          </div>
        </div>
        <div className="basic-col">
          <div className="basic-col-title">Order details</div>
          <div className="form-field">
            <label>Customer PO No.</label>
            <input value={poNo} onChange={(e) => setPoNo(e.target.value)} />
          </div>
          <div className="form-field">
            <label>Order date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="form-field">
            <label>Currency</label>
            <CurrencyToggle value={currency} onChange={setCurrency} />
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
        {/* 임베드(프로젝트 워크스페이스)에선 이 프로젝트로 자동 연결되므로 Link RFQ 셀렉터 불필요. */}
        {projectRfqId == null ? (
          <div className="form-field">
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
        ) : null}
      </div>
      </div>

      <ItemEditor
        items={items}
        onChange={setItems}
        currency={currency}
        headerActions={
          linkedRfqId != null ? (
            <button
              className="btn sm"
              onClick={loadCustomerQuote}
              disabled={busy || !linkedQuote}
              title={linkedQuote ? "Load items and amounts from this project's customer quotation" : "No customer quotation for this project"}
            >
              Load customer quote
            </button>
          ) : null
        }
      />

      <TermsEditor terms={terms} onChange={setTerms} />

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
  // 대상 오더가 상위(상단 P/O 선택기)에서 정해지면(embedded) 그 값으로 고정하고
  // 자체 선택기는 숨긴다. 전역 "Create PO" 모달에서는 selectedOrderId 가 없으므로
  // 사용자가 직접 고르도록 드롭다운을 노출한다.
  const fixedOrder = selectedOrderId != null;
  const [orderId, setOrderId] = useState<number | "">(selectedOrderId ?? "");
  const [vendorId, setVendorId] = useState<number | "">("");
  const [poNo, setPoNo] = useState("");
  // K-Maris PO No. 채번: auto(자동 KMS-ORD-yymm-nnn) / manual(직접 입력).
  const [noMode, setNoMode] = useState<"auto" | "manual">("auto");
  const [autoNo, setAutoNo] = useState("");
  const [date, setDate] = useState(today);
  const [currency, setCurrency] = useState("USD");
  const [items, setItems] = useState<PoWorkItem[]>([blankItem()]);
  const [terms, setTerms] = useState<QuotationTerms>(withDefaultTerms());
  const [vendorQuotes, setVendorQuotes] = useState<VendorQuoteForImport[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 편집 뷰(VendorPoDetailModal)와 동일한 Detail/Email 탭 구조.
  const [tab, setTab] = useState<DetailTab>("edit");

  const order = options.orders.find((o) => o.id === orderId);
  // Vendor 드롭다운은 모든 벤더를 노출(견적 제출 벤더로 제한하지 않음).
  const vendorChoices = options.vendors;

  // 상단 P/O 선택기에서 대상 오더가 바뀌면 폼도 그 오더로 맞춘다.
  useEffect(() => {
    if (selectedOrderId != null) setOrderId(selectedOrderId);
  }, [selectedOrderId]);

  useEffect(() => {
    if (order) {
      setItems(order.items.length ? order.items.map(normalizeItem) : [blankItem()]);
      // 발주 통화 기본값은 오더 통화(KRW 오더면 KRW). 사용자가 토글로 바꿀 수 있다.
      setCurrency(order.currency || "USD");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  // 선택 오더의 프로젝트(RFQ)에서 3단계에 수신한 공급사 견적들 — "Load vendor quote"용.
  useEffect(() => {
    if (!order) {
      setVendorQuotes([]);
      return;
    }
    fetchRfqVendorQuotes(order.rfq_id)
      .then((r) => setVendorQuotes(r.vendor_quotes))
      .catch(() => setVendorQuotes([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  // 선택한 공급사 견적의 품목·단가를 발주서 품목으로 불러오고, 수신 벤더도 맞춘다.
  function loadVendorQuote(vq: VendorQuoteForImport) {
    setItems(poItemsFromVendorQuote(vq));
    const v = options.vendors.find((x) => x.name === vq.vendor);
    if (v) setVendorId(v.id);
    setErr(null);
    setMsg(`Loaded ${vq.items.length} item(s) from vendor quote ${vq.vendor_quote_no} (${vq.vendor}).`);
  }

  // 자동채번 미리보기(다음 K-Maris PO No.) 로드.
  useEffect(() => {
    fetchNextPoNo().then((r) => setAutoNo(r.po_no)).catch(() => setAutoNo(""));
  }, []);

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
        currency,
        items: cleanItems(items),
        terms,
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
    return <div className="empty">No orders registered. Register an order in the P/O Received tab first.</div>;
  }

  return (
    <>
      <DetailTabBar tab={tab} onTab={setTab} />
      {tab === "email" ? (
        <span className="hint-inline">
          Create the P/O in the Detail tab first — the vendor email is generated from the saved P/O.
        </span>
      ) : (
      <>
      <div className="form-grid">
        {fixedOrder ? (
          <>
            {/* 대상 오더는 상단 P/O 선택기가 정한다. 여기서는 선박·프로젝트명을
                해당 고객 P/O에서 자동으로 불러와 읽기전용으로 보여준다. */}
            <div className="form-field">
              <label>Vessel</label>
              <input value={order?.vessel || "—"} readOnly />
            </div>
            <div className="form-field">
              <label>Project name</label>
              <input value={order?.project_title || order?.project_no || "—"} readOnly />
            </div>
          </>
        ) : (
          <div className="form-field">
            <label>Select target order</label>
            <select value={orderId} onChange={(e) => setOrderId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">— Select target order —</option>
              {options.orders.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.project_no} · {o.customer} · {o.po_no || "—"} · {tr(o.status)}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="form-field">
          <label>Vendor</label>
          <select value={vendorId} onChange={(e) => setVendorId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Select…</option>
            {vendorChoices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label>K-Maris PO No.</label>
          {noMode === "auto" ? (
            <select
              value="auto"
              onChange={(e) => { if (e.target.value === "manual") { setNoMode("manual"); setPoNo(""); } }}
            >
              <option value="auto">{autoNo ? `${autoNo} (auto)` : "Auto-generate"}</option>
              <option value="manual">Manual entry…</option>
            </select>
          ) : (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input value={poNo} onChange={(e) => setPoNo(e.target.value)} placeholder="KMS-ORD-…" autoFocus style={{ flex: 1 }} />
              <button type="button" className="btn sm" onClick={() => { setNoMode("auto"); setPoNo(""); }} title="Use auto number">auto</button>
            </div>
          )}
        </div>
        <div className="form-field">
          <label>PO date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="form-field">
          <label>Currency</label>
          <CurrencyToggle value={currency} onChange={setCurrency} />
        </div>
      </div>

      {order ? (
        <div className="action-ctx">
          {fixedOrder
            ? <>Customer P/O <b>{order.po_no || "—"}</b> · {order.customer} · {order.items.length} item(s)</>
            : <>Target order: <b>{order.project_no || "—"}</b> · PO No. {order.po_no || "—"} · {order.customer} · {order.vessel || "—"} · {order.items.length} item(s)</>}
        </div>
      ) : null}

      <ItemEditor
        items={items}
        onChange={setItems}
        currency={currency}
        headerActions={
          order ? (
            <LoadVendorQuoteControl
              vendorQuotes={vendorQuotes}
              onLoad={loadVendorQuote}
              disabled={busy}
            />
          ) : null
        }
      />

      <TermsEditor terms={terms} onChange={setTerms} />

      <div className="form-actions">
        <StageTotal
          label="Total"
          value={items.reduce((s, it) => s + Number(it.amount || 0), 0)}
          currency={currency}
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
      )}
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
  const [signature, setSignature] = useState("");
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
      // notes 는 더 이상 본문 템플릿에 짜넣지 않고 발송 시 본문 뒤에 붙는다(단계 이메일과 동일 규칙).
      const p = await previewVendorPo(poId, lang);
      setPreview(p);
      setTo(p.to);
      setSubject(p.subject);
      setBody(p.body);
      setSignature(p.signature ?? "");
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
      const r = await sendVendorPo({ poId, to, subject, body, notes, signature });
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
  const sel = useRowSelection();
  const cur = (currency || "USD").toUpperCase();
  const cols: ItemCol[] = [
    { key: "__sel", fixed: true },
    { key: "__seq", fixed: true, className: "seq" },
    { key: "part_no", label: "Part No." },
    { key: "description", label: "Description" },
    { key: "type", label: "Type" },
    { key: "serial_no", label: "Serial No." },
    { key: "maker", label: "Maker" },
    { key: "qty", label: "Qty", className: "num" },
    { key: "unit", label: "Unit" },
    { key: "unit_price", label: `Unit price (${cur})`, className: "num" },
    { key: "amount", label: `Amount (${cur})`, className: "num" },
    { key: "remark", label: "Remark" },
  ];
  const grid = useItemGrid("po-items", cols);
  // fields 순서 = 아래 keys.cell(i, 0..9) 열 번호. 여기 Amount 는 계산 컬럼이 아니라 직접 입력이라
  // fields 에 포함하고 재계산(normalizeRow)도 두지 않는다 — patch() 도 다시 계산하지 않는다.
  const keys = useItemGridKeys<PoWorkItem>({
    items,
    onChange,
    fields: ["part_no", "description", "type", "serial_no", "maker", "qty", "unit", "unit_price", "amount", "remark"],
    numeric: ["qty", "unit_price", "amount"],
    blank: blankItem,
    headers: ["Part No.", "Description", "Type", "Serial No.", "Maker", "Qty", "Unit", `Unit price (${cur})`, `Amount (${cur})`, "Remark"],
    sel,
  });

  return (
    <div style={{ marginTop: 16 }}>
      <div className="items-head">
        <div className="sub-h">Item list</div>
        <div className="items-head-actions">
          {headerActions}
          <ItemColsButton grid={grid} />
          <ItemGridHint />
          <CopyRowsButton grid={keys} sel={sel} />
          <DeleteSelectedButton sel={sel} onDelete={() => deleteSelectedRows(items, sel, onChange)} />
          <button className="btn sm items-head-add" onClick={() => onChange([...items, blankItem()])}>+ Add</button>
        </div>
      </div>
      <div className="table-wrap item-scroll">
        <ItemGridStyle grid={grid} />
        <table className={`mini wide lead-tools ${grid.tableClass}`}>
          <thead>
            <tr>
              <ItemSelectHeaderCell count={items.length} sel={sel} />
              <th className="seq">No.</th>
              <ItemTh grid={grid} k="part_no">Part No.</ItemTh>
              <ItemTh grid={grid} k="description">Description</ItemTh>
              <ItemTh grid={grid} k="type">Type</ItemTh>
              <ItemTh grid={grid} k="serial_no">Serial No.</ItemTh>
              <ItemTh grid={grid} k="maker">Maker</ItemTh>
              <ItemTh grid={grid} k="qty" className="num">Qty</ItemTh>
              <ItemTh grid={grid} k="unit">Unit</ItemTh>
              <ItemTh grid={grid} k="unit_price" className="num">Unit price ({cur})</ItemTh>
              <ItemTh grid={grid} k="amount" className="num">Amount ({cur})</ItemTh>
              <ItemTh grid={grid} k="remark">Remark</ItemTh>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i} className={itemRowClass(i)}>
                <ItemSelectCell index={i} sel={sel} />
                <td className="seq">{i + 1}</td>
                <td>
                  <textarea {...keys.cell(i, 0)} className="wrapcell" rows={1} value={it.part_no} onChange={(e) => patch(i, "part_no", e.target.value)} />
                </td>
                <td>
                  <textarea {...keys.cell(i, 1)} className="desc" rows={1} value={it.description} onChange={(e) => patch(i, "description", e.target.value)} />
                </td>
                <td>
                  <textarea {...keys.cell(i, 2)} className="wrapcell" rows={1} value={it.type ?? ""} onChange={(e) => patch(i, "type", e.target.value)} />
                </td>
                <td>
                  <textarea {...keys.cell(i, 3)} className="wrapcell" rows={1} value={it.serial_no ?? ""} onChange={(e) => patch(i, "serial_no", e.target.value)} />
                </td>
                <td>
                  <textarea {...keys.cell(i, 4)} className="wrapcell" rows={1} value={it.maker ?? ""} onChange={(e) => patch(i, "maker", e.target.value)} />
                </td>
                <td>
                  <input
                    {...keys.cell(i, 5)}
                    className="num"
                    value={amountInputValue(it.qty)}
                    onChange={(e) => patch(i, "qty", e.target.value)}
                  />
                </td>
                <td>
                  <input {...keys.cell(i, 6)} value={it.unit} onChange={(e) => patch(i, "unit", e.target.value)} />
                </td>
                <td>
                  <input
                    {...keys.cell(i, 7)}
                    className="num"
                    value={amountInputValue(it.unit_price)}
                    onChange={(e) => patch(i, "unit_price", e.target.value)}
                  />
                </td>
                <td>
                  <input
                    {...keys.cell(i, 8)}
                    className="num"
                    value={amountInputValue(it.amount)}
                    onChange={(e) => patch(i, "amount", e.target.value)}
                  />
                </td>
                <td>
                  <textarea {...keys.cell(i, 9)} className="wrapcell" rows={1} value={it.remark ?? ""} onChange={(e) => patch(i, "remark", e.target.value)} />
                </td>
              </tr>
            ))}
          </tbody>
          {/* 합계행 — 컬럼당 1셀(숨김/폭 조절 정렬 유지). Total=Unit price(10열), 값=Amount(11열). */}
          <tfoot>
            <tr>
              <td></td>{/* 1 sel */}
              <td></td>{/* 2 No. */}
              <td></td>{/* 3 part_no */}
              <td></td>{/* 4 description */}
              <td></td>{/* 5 type */}
              <td></td>{/* 6 serial_no */}
              <td></td>{/* 7 maker */}
              <td></td>{/* 8 qty */}
              <td></td>{/* 9 unit */}
              <td className="total-label">Total</td>{/* 10 unit_price */}
              <td className="num total-value">{/* 11 amount */}
                <DualCurrencyAmount value={total} currency={currency} />
                <span className="fx-note">{fxRateText()}</span>
              </td>
              <td></td>{/* 12 remark */}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// 3단계에서 수신한 공급사 견적 → 발주서 품목으로 변환.
// 공급사 견적의 cost_price 가 발주서의 unit price(= 우리가 벤더에 지불하는 단가)가 된다.
function poItemsFromVendorQuote(vq: VendorQuoteForImport): PoWorkItem[] {
  if (!vq.items.length) return [blankItem()];
  return vq.items.map((it) => {
    const qty = Number(it.qty ?? 1) || 1;
    const cost = it.cost_price == null ? 0 : Number(it.cost_price);
    return {
      part_no: it.part_no ?? "",
      description: it.description ?? "",
      type: it.type ?? "",
      serial_no: it.serial_no ?? "",
      maker: it.maker ?? it.manufacturer ?? "",
      qty,
      unit: it.unit ?? "PCS",
      unit_price: cost,
      amount: qty * cost,
      remark: it.remark ?? "",
    };
  });
}

// "Load vendor quote" — 품목표 헤더의 "+ Add" 옆 보조 액션.
// 이 프로젝트에서 수신한 공급사 견적이 여러 건이면 선택기를, 한 건이면 버튼만 노출한다.
function LoadVendorQuoteControl({
  vendorQuotes,
  onLoad,
  disabled,
}: {
  vendorQuotes: VendorQuoteForImport[];
  onLoad: (vq: VendorQuoteForImport) => void;
  disabled?: boolean;
}) {
  const [vqId, setVqId] = useState<number | "">(
    vendorQuotes.length === 1 ? vendorQuotes[0].id : ""
  );
  // 견적 목록이 바뀌면(오더 변경 등) 선택 초기화. 한 건이면 자동 선택.
  useEffect(() => {
    setVqId(vendorQuotes.length === 1 ? vendorQuotes[0].id : "");
  }, [vendorQuotes]);

  if (vendorQuotes.length === 0) return null;

  return (
    <span className="load-vq-control">
      {vendorQuotes.length > 1 ? (
        <select
          className="load-vq-select"
          value={vqId}
          onChange={(e) => setVqId(e.target.value ? Number(e.target.value) : "")}
          title="Choose which received vendor quote to load"
        >
          <option value="">— Select vendor quote —</option>
          {vendorQuotes.map((v) => (
            <option key={v.id} value={v.id}>
              {v.received_date || "—"} · {v.vendor} · {v.vendor_quote_no}
            </option>
          ))}
        </select>
      ) : null}
      <button
        type="button"
        className="btn sm"
        disabled={disabled || vqId === ""}
        title="Load items and unit prices from the vendor quote received at stage 3"
        onClick={() => {
          const vq = vendorQuotes.find((v) => v.id === vqId);
          if (vq) onLoad(vq);
        }}
      >
        Load vendor quote
      </button>
    </span>
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
