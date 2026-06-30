"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchVendors,
  fetchRfqDetail,
  fetchRfqVendorQuotes,
  createVendorRfq,
  assignRfqNo,
  previewVendorRfq,
  sendVendorRfq,
  vendorRfqXlsxUrl,
  createVendorQuote,
  parseVendorQuoteFile,
  createCustomerQuote,
  quotationPdfUrl,
  previewQuotationEmail,
  sendQuotationEmail,
  fetchVrfqOverview,
  fetchVendorQuoteOverview,
  fetchQuotationOverview,
  fetchVendorRfqDetail,
  updateVendorRfq,
  deleteVendorRfq,
  fetchVendorQuoteDetail,
  updateVendorQuote,
  deleteVendorQuote,
  fetchCustomerQuotationDetail,
  updateCustomerQuotation,
  deleteCustomerQuotation,
} from "@/lib/api";
import { getToken } from "@/lib/auth";
import { tr } from "@/lib/labels";
import type {
  VendorOption,
  RfqRow,
  RfqDetail as RfqDetailT,
  VendorRfqPreview,
  VendorQuoteItem,
  CustomerQuoteItem,
  QuotationTerms,
  VendorQuoteForImport,
  VrfqRow,
  VendorQuoteOverviewRow,
  QtnRow,
  VendorRfqDetail,
  VendorQuoteDetail,
  CustomerQuotationDetail,
  RfqItem,
} from "@/lib/types";
import NewRfqForm from "./screens/NewRfqForm";
import WorkTypeBadge from "./WorkTypeBadge";
import FilterTable, { ColumnDef } from "./common/FilterTable";
import { identityColumns, projectNoColumn } from "./common/identityColumns";
import Modal from "./common/Modal";
import BaseMetaRows, { ModalTitle } from "./common/BaseMeta";
import CurrencyToggle from "./common/CurrencyToggle";
import {
  amountInputValue,
  DualCurrencyAmount,
  dualCurrencyText,
  fxRateText,
  gridCellProps,
  itemRowClass,
  parseAmountInput,
} from "./common/itemTable";

/** 현재 시각 "YYYY-MM-DDTHH:MM" (datetime-local 기본값). */
function nowLocalDt(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

// datetime-local 입력은 "YYYY-MM-DDTHH:mm" 형식만 표시한다.
// 옛 데이터처럼 날짜만("YYYY-MM-DD") 들어오면 자정 시각을 붙여 편집 가능하게 만든다.
function toLocalDt(v?: string): string {
  const s = (v || "").trim();
  if (!s) return "";
  if (s.length === 10) return `${s}T00:00`;
  return s.slice(0, 16);
}

// 원본 rfq_quotation.py 하단의 작업 segmented control(4탭)을 복원.
const TABS = [
  { key: "new", label: "1. Customer RFQ Received" },
  { key: "vrfq", label: "2. Vendor RFQ Sent" },
  { key: "vquote", label: "3. Vendor Quote Received" },
  { key: "cquote", label: "4. Customer Quote Sent" },
];
const VENDOR_QUOTE_CURRENCY_OVERRIDES = "ktms:vendorQuoteCurrencyOverrides";

function readVendorQuoteCurrencyOverrides(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(VENDOR_QUOTE_CURRENCY_OVERRIDES) || "{}");
  } catch {
    return {};
  }
}

function vendorQuoteCurrencyOverride(id: number): string | undefined {
  return readVendorQuoteCurrencyOverrides()[String(id)];
}

function setVendorQuoteCurrencyOverride(id: number, currency: string | null) {
  if (typeof window === "undefined") return;
  const overrides = readVendorQuoteCurrencyOverrides();
  if (currency) overrides[String(id)] = currency;
  else delete overrides[String(id)];
  window.localStorage.setItem(VENDOR_QUOTE_CURRENCY_OVERRIDES, JSON.stringify(overrides));
}

function money(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function RfqActionTabs({
  rfqId,
  rows,
  onSelect,
  onChanged,
  initialTab,
}: {
  rfqId: number | null;
  rows: RfqRow[];
  onSelect: (id: number | null) => void;
  onChanged: () => void;
  initialTab?: string | null;
}) {
  const validTab = TABS.some((t) => t.key === initialTab) ? (initialTab as string) : "new";
  const [tab, setTab] = useState(validTab);
  const [vendors, setVendors] = useState<VendorOption[]>([]);

  // 딥링크(URL ?tab=&rfq=)로 특정 단계에 직접 들어온 경우에만 1회 자동으로 해당
  // 레코드를 연다. 마운트 시점의 값만 사용하므로, 사용자가 단순히 탭을 전환할 때는
  // (목록 컴포넌트가 remount 되어도) 자동으로 열리지 않는다.
  const [autoOpen, setAutoOpen] = useState<{ tab: string; id: number } | null>(
    rfqId ? { tab: validTab, id: rfqId } : null
  );
  const consumeAutoOpen = useCallback(() => setAutoOpen(null), []);
  const autoFor = (key: string) =>
    autoOpen && autoOpen.tab === key ? autoOpen.id : null;

  // 진행현황 단계 행에서 ?tab=... 으로 들어오면 해당 탭으로 전환.
  useEffect(() => {
    if (initialTab && TABS.some((t) => t.key === initialTab)) setTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    fetchVendors().then(setVendors).catch(() => setVendors([]));
  }, []);

  return (
    <div className="action-tabs">
      <div className="page-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? "on" : ""}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "new" && (
        <CustomerRfqList
          rows={rows}
          autoOpenId={autoFor("new")}
          onAutoConsumed={consumeAutoOpen}
          onSelect={onSelect}
          onChanged={onChanged}
        />
      )}
      {tab === "vrfq" && (
        <VendorRfqList
          projects={rows}
          vendors={vendors}
          onChanged={onChanged}
          autoEditId={autoFor("vrfq")}
          onAutoConsumed={consumeAutoOpen}
        />
      )}
      {tab === "vquote" && (
        <VendorQuoteList
          projects={rows}
          onChanged={onChanged}
          autoEditId={autoFor("vquote")}
          onAutoConsumed={consumeAutoOpen}
        />
      )}
      {tab === "cquote" && (
        <CustomerQuoteList
          projects={rows}
          onChanged={onChanged}
          autoEditId={autoFor("cquote")}
          onAutoConsumed={consumeAutoOpen}
        />
      )}
    </div>
  );
}

// 신규 등록 모달 상단의 '진행중인 프로젝트(RFQ)' 선택기 — 2~4번 탭 등록 폼에서 사용.
// 선택한 프로젝트(RFQ)의 기본 정보 — Active project 드롭다운과 입력 폼 사이에 표시.
function RfqProjectInfo({ project }: { project?: RfqRow }) {
  if (!project) return null;
  return (
    <dl className="intl-meta" style={{ margin: "12px 0" }}>
      <div><dt>First RFQ received</dt><dd>{project.crfq_at || "—"}</dd></div>
      <div><dt>Customer</dt><dd>{project.customer || "—"}</dd></div>
      <div><dt>Work type</dt><dd>{tr(project.work_type)}</dd></div>
      <div><dt>Vessel</dt><dd>{project.vessel || "—"}</dd></div>
      <div><dt>Project title</dt><dd>{project.project_title || "—"}</dd></div>
      <div><dt>Items</dt><dd>{project.item_count}</dd></div>
      <div><dt>Current stage</dt><dd>{project.status || "—"}</dd></div>
      <div><dt>Vendor</dt><dd>{project.vrfq_vendors || "—"}</dd></div>
    </dl>
  );
}

function ProjectPicker({
  projects,
  rfqId,
  onSelect,
}: {
  projects: RfqRow[];
  rfqId: number | null;
  onSelect: (id: number | null) => void;
}) {
  return <ProjectSelect rows={projects} rfqId={rfqId} onSelect={onSelect} />;
}

// ── 1. Customer RFQ 수신 ────────────────────────────────────────────────────
function CustomerRfqList({
  rows,
  autoOpenId,
  onAutoConsumed,
  onSelect,
  onChanged,
}: {
  rows: RfqRow[];
  autoOpenId: number | null;
  onAutoConsumed: () => void;
  onSelect: (id: number | null) => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  // 딥링크 도착 시 1회만 상세를 연다(탭 전환으로 인한 재오픈 방지).
  useEffect(() => {
    if (!autoOpenId) return;
    setDetailId(autoOpenId);
    onAutoConsumed();
  }, [autoOpenId, onAutoConsumed]);

  const columns: ColumnDef<RfqRow>[] = [
    projectNoColumn<RfqRow>({ projectNo: (r) => r.project_no, firstRfqAt: (r) => r.first_rfq_at }),
    ...identityColumns<RfqRow>({
      customer: (r) => r.customer,
      vessel: (r) => (r.vessel && r.vessel !== "—" ? r.vessel : ""),
      workType: (r) => r.work_type,
    }),
    {
      key: "customer_rfq_no",
      label: "Customer RFQ No.",
      text: (r) => r.customer_rfq_no || "",
      render: (r) => r.customer_rfq_no || <span className="dash">—</span>,
    },
    {
      key: "item_count",
      label: "Items",
      numeric: true,
      text: (r) => String(r.item_count),
      sortValue: (r) => r.item_count,
    },
  ];

  return (
    <>
      <FilterTable
        rows={rows}
        columns={columns}
        getRowKey={(r) => r.id}
        onRowClick={(r) => setDetailId(r.id)}
        empty="No RFQs registered."
        actions={
          <button className="btn primary" onClick={() => setAdding(true)}>
            + New
          </button>
        }
      />

      {adding ? (
        <Modal title="New Customer RFQ" onClose={() => setAdding(false)} wide>
          <NewRfqForm
            onCreated={() => {
              setAdding(false);
              onChanged();
            }}
            onCancel={() => setAdding(false)}
          />
        </Modal>
      ) : null}

      {detailId !== null ? (
        <Modal title="Customer RFQ details" onClose={() => setDetailId(null)} wide>
          <NewRfqForm
            autoLoadId={detailId}
            onCreated={() => {
              setDetailId(null);
              onSelect(null);
              onChanged();
            }}
            onCancel={() => {
              setDetailId(null);
              onSelect(null);
            }}
            onDeleted={() => {
              setDetailId(null);
              onSelect(null);
              onChanged();
            }}
          />
        </Modal>
      ) : null}
    </>
  );
}

// ── 2. Vendor RFQ 발신 ──────────────────────────────────────────────────────
function VendorRfqList({
  projects,
  vendors,
  onChanged,
  autoEditId,
  onAutoConsumed,
}: {
  projects: RfqRow[];
  vendors: VendorOption[];
  onChanged: () => void;
  autoEditId?: number | null;
  onAutoConsumed?: () => void;
}) {
  const [rows, setRows] = useState<VrfqRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [pickRfqId, setPickRfqId] = useState<number | null>(null);
  const [autoEdit, setAutoEdit] = useState(false);

  function load() {
    fetchVrfqOverview()
      .then((d) => setRows(d.rows))
      .catch((e) => setError(e instanceof Error ? e.message : "Error"));
  }
  useEffect(load, []);

  // 딥링크(Progress 단계 진입)로만 1회 자동 편집 오픈. 행이 로드된 뒤 처리.
  useEffect(() => {
    if (!autoEditId || rows.length === 0) return;
    const match = rows.find((r) => r.rfq_id === autoEditId);
    if (match) { setAutoEdit(true); setDetailId(match.id); }
    else { setPickRfqId(autoEditId); setAdding(true); }
    onAutoConsumed?.();
  }, [autoEditId, rows, onAutoConsumed]);

  const refresh = () => {
    load();
    onChanged();
  };

  const columns: ColumnDef<VrfqRow>[] = [
    projectNoColumn<VrfqRow>({ projectNo: (r) => r.project_no, firstRfqAt: (r) => r.first_rfq_at }),
    ...identityColumns<VrfqRow>({
      customer: (r) => r.customer,
      vessel: (r) => r.vessel,
      workType: (r) => r.work_type,
    }),
    { key: "customer_rfq_no", label: "Customer RFQ No.", text: (r) => r.customer_rfq_no || "" },
    { key: "vendor", label: "Vendor", text: (r) => r.vendor || "", filter: "facet" },
    { key: "vendor_email", label: "Recipient email", text: (r) => r.vendor_email || "" },
    { key: "sent_date", label: "Sent date", text: (r) => r.sent_date || "", filter: "date" },
    { key: "item_count", label: "Items", numeric: true, text: (r) => String(r.item_count), sortValue: (r) => r.item_count },
    { key: "quote_count", label: "Quotes received", numeric: true, text: (r) => `${r.quote_count}`, sortValue: (r) => r.quote_count },
    {
      key: "status",
      label: "Status",
      text: (r) => tr(r.status) || "",
      filter: "facet",
      render: (r) => <span className="ar-badge">{tr(r.status)}</span>,
    },
  ];

  if (error) return <div className="state error">API error: {error}</div>;

  const kmarisNo = pickRfqId !== null ? projects.find((p) => p.id === pickRfqId)?.crfq_no ?? "" : "";

  return (
    <>
      <FilterTable
        rows={rows}
        columns={columns}
        getRowKey={(r) => r.id}
        onRowClick={(r) => { setAutoEdit(true); setDetailId(r.id); }}
        empty="No Vendor RFQs sent."
        actions={
          <button className="btn primary" onClick={() => { setPickRfqId(null); setAdding(true); }}>
            + New
          </button>
        }
      />

      {adding ? (
        <Modal title="Vendor RFQ Sent" onClose={() => setAdding(false)} wide>
          {/* 신규 등록 대상 = 아직 1단계(Customer RFQ)에만 머문 프로젝트 */}
          <ProjectPicker projects={projects.filter((p) => p.stage < 2)} rfqId={pickRfqId} onSelect={setPickRfqId} />
          <RfqProjectInfo project={projects.find((p) => p.id === pickRfqId)} />
          <VendorRfqAction
            rfqId={pickRfqId ?? 0}
            vendors={vendors}
            kmarisNo={kmarisNo}
            onDone={() => {
              setAdding(false);
              refresh();
            }}
          />
        </Modal>
      ) : null}

      {detailId !== null ? (
        <VendorRfqDetailModal
          id={detailId}
          vendors={vendors}
          autoEdit={autoEdit}
          onClose={() => { setDetailId(null); setAutoEdit(false); }}
          onChanged={refresh}
        />
      ) : null}
    </>
  );
}

function VendorRfqDetailModal({
  id,
  vendors,
  autoEdit,
  onClose,
  onChanged,
}: {
  id: number;
  vendors: VendorOption[];
  autoEdit?: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [d, setD] = useState<VendorRfqDetail | null>(null);
  const [editing, setEditing] = useState(!!autoEdit);
  const [vendorId, setVendorId] = useState<number | "">("");
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("");
  const [sentAt, setSentAt] = useState("");
  const [items, setItems] = useState<RfqItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchVendorRfqDetail(id)
      .then((data) => {
        setD(data);
        setVendorId(data.vendor_id || "");
        setEmail(data.vendor_email || "");
        setStatus(data.status || "");
        setSentAt(toLocalDt(data.sent_at));
        setItems(data.items || []);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Error"));
  }, [id]);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await updateVendorRfq(id, {
        vendor_id: vendorId === "" ? undefined : vendorId,
        sent_to_email: email,
        status,
        sent_at: sentAt,
        items,
      });
      setEditing(false);
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("Delete this Vendor RFQ?")) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteVendorRfq(id);
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
      setBusy(false);
    }
  }

  return (
    <Modal title={d ? <ModalTitle label="Vendor RFQ" projectNo={d.project_no} /> : "Vendor RFQ details"} onClose={onClose} wide>
      {!d ? (
        <div className="empty">Loading…</div>
      ) : (
        <>
          {editing ? (
            <>
              <div className="form-section-title">Project info</div>
              <dl className="intl-meta">
                <BaseMetaRows info={d} />
                <div><dt>Customer RFQ No.</dt><dd>{d.customer_rfq_no || "—"}</dd></div>
                <div><dt>K-Maris RFQ No.</dt><dd>{d.kmaris_rfq_no || "—"}</dd></div>
                <div><dt>Items</dt><dd>{items.length}</dd></div>
              </dl>

              <div className="form-section-title">This vendor send info</div>
              <div className="form-grid">
                <div className="form-field">
                  <label>Vendor</label>
                  <select value={vendorId} onChange={(e) => setVendorId(e.target.value === "" ? "" : Number(e.target.value))}>
                    <option value="">Select…</option>
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <label>Recipient email</label>
                  <input value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div className="form-field">
                  <label>Sent at</label>
                  <input type="datetime-local" value={sentAt} onChange={(e) => setSentAt(e.target.value)} />
                </div>
                <div className="form-field">
                  <label>Status</label>
                  <input value={status} onChange={(e) => setStatus(e.target.value)} />
                </div>
              </div>

              <VendorRfqItemEditor items={items} onChange={setItems} />
            </>
          ) : (
            <>
              <div className="form-section-title">Project info</div>
              <dl className="intl-meta">
                <BaseMetaRows info={d} />
                <div><dt>Customer RFQ No.</dt><dd>{d.customer_rfq_no || "—"}</dd></div>
                <div><dt>K-Maris RFQ No.</dt><dd>{d.kmaris_rfq_no || "—"}</dd></div>
                <div><dt>Contact</dt><dd>{d.customer_contact || "—"}</dd></div>
                <div><dt>Email</dt><dd>{d.customer_email || "—"}</dd></div>
                <div><dt>Items</dt><dd>{d.items.length}</dd></div>
              </dl>

              <div className="form-section-title">This vendor send info</div>
              <dl className="intl-meta">
                <div><dt>Vendor</dt><dd>{d.vendor}</dd></div>
                <div><dt>Recipient email</dt><dd>{d.vendor_email || "—"}</dd></div>
                <div><dt>Sent at</dt><dd>{d.sent_at || d.sent_date || "—"}</dd></div>
                <div><dt>Status</dt><dd>{tr(d.status)}</dd></div>
                <div><dt>Quotes received</dt><dd>{d.quote_count}</dd></div>
              </dl>

              <ProjectVendorRfqList rows={d.project_vendor_rfqs || []} />
            </>
          )}

          <div className="form-actions">
            {editing ? (
              <>
                <button className="btn primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
                <button className="btn" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
              </>
            ) : (
              <button className="btn" onClick={() => setEditing(true)} style={{ marginLeft: "auto" }}>✎ Edit</button>
            )}
            <button className="btn danger" onClick={remove} disabled={busy || editing}>Delete</button>
          </div>
          {err ? <span className="action-err">{err}</span> : null}
        </>
      )}
    </Modal>
  );
}

function ProjectVendorRfqList({
  rows,
}: {
  rows: VendorRfqDetail["project_vendor_rfqs"];
}) {
  if (!rows.length) return null;
  return (
    <>
      <div className="form-section-title">Vendor sends for this project</div>
      <div className="table-wrap compact">
        <table className="mini wide">
          <thead>
            <tr>
              <th>Vendor</th>
              <th>Contact</th>
              <th>Sent at</th>
              <th>Quote</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.current ? "sel" : ""}>
                <td>{r.vendor}</td>
                <td>{r.vendor_email || "—"}</td>
                <td>{r.sent_at || "—"}</td>
                <td>{r.quote_count}</td>
                <td>{tr(r.status) || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function VendorRfqItemEditor({
  items,
  onChange,
}: {
  items: RfqItem[];
  onChange: (items: RfqItem[]) => void;
}) {
  function patch(i: number, key: keyof RfqItem, value: string) {
    onChange(
      items.map((it, idx) =>
        idx === i
          ? {
              ...it,
              [key]: key === "qty" ? parseAmountInput(value) || 0 : value,
            }
          : it
      )
    );
  }

  return (
    <>
      <div className="form-section-title">Items sent</div>
      <div className="table-wrap compact">
        <table className="mini wide">
          <thead>
            <tr>
              <th className="seq">No.</th>
              <th>Part No.</th>
              <th>Description</th>
              <th>Qty</th>
              <th>Unit</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i} className={itemRowClass(i)}>
                <td className="seq">{i + 1}</td>
                <td><input {...gridCellProps(i, 0)} value={it.part_no || ""} onChange={(e) => patch(i, "part_no", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 1)} value={it.description || ""} onChange={(e) => patch(i, "description", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 2)} className="num" value={amountInputValue(it.qty)} onChange={(e) => patch(i, "qty", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 3)} value={it.unit || ""} onChange={(e) => patch(i, "unit", e.target.value)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── 3. Vendor Quot. 수신 ────────────────────────────────────────────────────
function VendorQuoteList({
  projects,
  onChanged,
  autoEditId,
  onAutoConsumed,
}: {
  projects: RfqRow[];
  onChanged: () => void;
  autoEditId?: number | null;
  onAutoConsumed?: () => void;
}) {
  const [rows, setRows] = useState<VendorQuoteOverviewRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [pickRfqId, setPickRfqId] = useState<number | null>(null);
  const [vendorRfqs, setVendorRfqs] = useState<RfqDetailT["vendor_rfqs"]>([]);
  const [autoEdit, setAutoEdit] = useState(false);

  // 딥링크로만 1회 자동 편집 오픈(탭 전환 시 재오픈 방지).
  useEffect(() => {
    if (!autoEditId || rows.length === 0) return;
    const match = rows.find((r) => r.rfq_id === autoEditId);
    if (match) { setAutoEdit(true); setDetailId(match.id); }
    onAutoConsumed?.();
  }, [autoEditId, rows, onAutoConsumed]);

  function load() {
    fetchVendorQuoteOverview()
      .then((d) => {
        const overrides = readVendorQuoteCurrencyOverrides();
        setRows(d.rows.map((row) => ({ ...row, currency: overrides[String(row.id)] || row.currency })));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Error"));
  }
  useEffect(load, []);

  // 모달에서 프로젝트 선택 시 해당 RFQ의 Vendor RFQ 목록 로드
  useEffect(() => {
    if (pickRfqId === null) {
      setVendorRfqs([]);
      return;
    }
    fetchRfqDetail(pickRfqId)
      .then((d) => setVendorRfqs(d.vendor_rfqs))
      .catch(() => setVendorRfqs([]));
  }, [pickRfqId]);

  const refresh = () => {
    load();
    onChanged();
  };

  const columns: ColumnDef<VendorQuoteOverviewRow>[] = [
    projectNoColumn<VendorQuoteOverviewRow>({ projectNo: (r) => r.project_no, firstRfqAt: (r) => r.first_rfq_at }),
    ...identityColumns<VendorQuoteOverviewRow>({
      customer: (r) => r.customer,
      vessel: (r) => r.vessel,
      workType: (r) => r.work_type,
    }),
    { key: "vendor_quote_no", label: "Vendor quote no.", text: (r) => r.vendor_quote_no || "" },
    {
      key: "received_at",
      label: "Quote received",
      text: (r) => (r.received_at && r.received_at.length >= 16 ? `${r.received_at.slice(2, 10)} ${r.received_at.slice(11, 16)}` : r.received_date || ""),
      filter: "date",
      sortValue: (r) => Date.parse(r.received_at || r.received_date || "") || 0,
    },
    { key: "vendor", label: "Vendor", text: (r) => r.vendor || "", filter: "facet" },
    { key: "item_count", label: "Items", numeric: true, text: (r) => String(r.item_count), sortValue: (r) => r.item_count },
    {
      key: "amount",
      label: "Amount",
      numeric: true,
      text: (r) => dualCurrencyText(r.amount, r.currency),
      render: (r) => <DualCurrencyAmount value={r.amount} currency={r.currency} />,
      sortValue: (r) => r.amount,
    },
  ];

  if (error) return <div className="state error">API error: {error}</div>;

  return (
    <>
      <FilterTable
        rows={rows}
        columns={columns}
        getRowKey={(r) => r.id}
        onRowClick={(r) => { setAutoEdit(true); setDetailId(r.id); }}
        empty="No Vendor quotes received."
        actions={
          <button className="btn primary" onClick={() => { setPickRfqId(null); setAdding(true); }}>
            + New
          </button>
        }
      />

      {adding ? (
        <Modal title="Register Vendor Quote" onClose={() => setAdding(false)} wide>
          {/* 신규 등록 대상 = Vendor RFQ까지(2단계) 진행, 견적 미수신 프로젝트 */}
          <ProjectPicker projects={projects.filter((p) => p.stage === 2)} rfqId={pickRfqId} onSelect={setPickRfqId} />
          <RfqProjectInfo project={projects.find((p) => p.id === pickRfqId)} />
          <VendorQuoteAction
            rfqId={pickRfqId ?? 0}
            vendorRfqs={vendorRfqs}
            onDone={() => {
              setAdding(false);
              refresh();
            }}
          />
        </Modal>
      ) : null}

      {detailId !== null ? (
        <VendorQuoteDetailModal id={detailId} autoEdit={autoEdit} onClose={() => { setDetailId(null); setAutoEdit(false); }} onChanged={refresh} />
      ) : null}
    </>
  );
}

function VendorQuoteDetailModal({
  id,
  autoEdit,
  onClose,
  onChanged,
}: {
  id: number;
  autoEdit?: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [d, setD] = useState<VendorQuoteDetail | null>(null);
  const [editing, setEditing] = useState(!!autoEdit);
  const [no, setNo] = useState("");
  const [receivedAt, setReceivedAt] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<VendorQuoteItem[]>([]);
  const [parseMsg, setParseMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchVendorQuoteDetail(id)
      .then((data) => {
        const overrideCurrency = vendorQuoteCurrencyOverride(data.id);
        const effectiveCurrency = overrideCurrency || data.currency || "USD";
        setD(data);
        setNo(data.vendor_quote_no || "");
        setReceivedAt(data.received_at || "");
        setCurrency(effectiveCurrency);
        setNotes(data.notes || "");
        setItems((data.items || []).map(normalizeVendorQuoteItem));
        setParseMsg(null);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Error"));
  }, [id]);

  async function parseFile(file: File | null) {
    if (!file) return;
    setBusy(true);
    setErr(null);
    setParseMsg(null);
    try {
      const r = await parseVendorQuoteFile(file);
      const parsed = r.items || [];
      setItems((prev) => mergeParsedItems(prev.length ? prev : [], parsed));
      setParseMsg(
        parsed.length
          ? `Auto-filled ${parsed.length} item(s) — review and edit`
          : "Could not extract items. Enter manually or try another file."
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "File parsing failed");
    } finally {
      setBusy(false);
    }
  }

  async function loadVendorRfqItems() {
    if (!d) return;
    setBusy(true);
    setErr(null);
    setParseMsg(null);
    try {
      const vrfq = await fetchVendorRfqDetail(d.vendor_rfq_id);
      setItems(
        (vrfq.items || []).map((it) =>
          normalizeVendorQuoteItem({
            part_no: it.part_no,
            description: it.description,
            qty: it.qty,
            unit: it.unit,
            cost_price: 0,
          })
        )
      );
      setParseMsg(`Loaded ${vrfq.items.length} item(s) from Vendor RFQ.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load Vendor RFQ items");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await updateVendorQuote(id, {
        vendor_quote_no: no.trim(),
        received_at: receivedAt,
        currency,
        notes,
        items: cleanVendorQuoteItems(items),
      });
      const persisted = await fetchVendorQuoteDetail(id);
      if ((persisted.currency || "USD") !== currency) {
        setVendorQuoteCurrencyOverride(id, currency);
      } else {
        setVendorQuoteCurrencyOverride(id, null);
      }
      setD({ ...persisted, currency });
      setEditing(false);
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("Delete this Vendor quote?")) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteVendorQuote(id);
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
      setBusy(false);
    }
  }

  return (
    <Modal title={d ? <ModalTitle label={`Vendor quote — ${d.vendor_quote_no}`} projectNo={d.project_no} /> : "Vendor quote details"} onClose={onClose} wide>
      {!d ? (
        <div className="empty">Loading…</div>
      ) : editing ? (
        <>
          <div className="form-section-title">Project info</div>
          <dl className="intl-meta">
            <BaseMetaRows info={d} />
            <div><dt>Vendor</dt><dd>{d.vendor}</dd></div>
            <div><dt>Items</dt><dd>{items.length}</dd></div>
          </dl>

          <div className="form-section-title">Vendor quote info</div>
          <div className="form-grid">
            <div className="form-field">
              <label>Vendor quote no.</label>
              <input value={no} onChange={(e) => setNo(e.target.value)} />
            </div>
            <div className="form-field">
              <label>Quote received at</label>
              <input type="datetime-local" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
            </div>
            <div className="form-field">
              <label>Currency</label>
              <CurrencyToggle value={currency} onChange={setCurrency} />
            </div>
            <div className="form-field">
              <label>Notes</label>
              <input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>

          <div className="po-work-note" style={{ marginTop: 12 }}>
            <b>Auto-fill quote items</b>
            <span>Upload the vendor quote file (PDF, JPG/PNG, Excel) or load the original Vendor RFQ item list.</span>
          </div>
          <div className="action-row">
            <input
              type="file"
              accept=".pdf,.xlsx,.xls,.png,.jpg,.jpeg,.webp,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/*"
              disabled={busy}
              onChange={(e) => parseFile(e.target.files?.[0] ?? null)}
            />
            <button className="btn" onClick={loadVendorRfqItems} disabled={busy}>
              Load Vendor RFQ items
            </button>
            {busy ? <span className="hint-inline">Analyzing…</span> : null}
            {parseMsg ? <span className="action-ok">{parseMsg}</span> : null}
          </div>
          <VendorQuoteItemEditor items={items} onChange={setItems} currency={currency} />
          <div className="form-actions">
            <button className="btn primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
            <button className="btn" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
          </div>
          {err ? <span className="action-err">{err}</span> : null}
        </>
      ) : (
        <>
          <dl className="intl-meta">
            <BaseMetaRows info={d} />
            <div><dt>Vendor</dt><dd>{d.vendor}</dd></div>
            <div><dt>Received</dt><dd>{d.received_date || "—"}</dd></div>
            <div><dt>Notes</dt><dd>{d.notes || "—"}</dd></div>
            <div><dt>Currency</dt><dd>{d.currency || "USD"}</dd></div>
            <div><dt>Items</dt><dd>{d.items.length}</dd></div>
          </dl>
          <div className="form-actions">
            <button className="btn" onClick={() => setEditing(true)} style={{ marginLeft: "auto" }}>✎ Edit</button>
            <button className="btn danger" onClick={remove} disabled={busy}>Delete</button>
          </div>
          {err ? <span className="action-err">{err}</span> : null}
        </>
      )}
    </Modal>
  );
}

// ── 4. Customer Quot. 발신 ──────────────────────────────────────────────────
function CustomerQuoteList({
  projects,
  onChanged,
  autoEditId,
  onAutoConsumed,
}: {
  projects: RfqRow[];
  onChanged: () => void;
  autoEditId?: number | null;
  onAutoConsumed?: () => void;
}) {
  const [rows, setRows] = useState<QtnRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [pickRfqId, setPickRfqId] = useState<number | null>(null);
  const [autoEdit, setAutoEdit] = useState(false);

  // 딥링크로만 1회 자동 편집 오픈(탭 전환 시 재오픈 방지).
  useEffect(() => {
    if (!autoEditId || rows.length === 0) return;
    const match = rows.find((r) => r.rfq_id === autoEditId);
    if (match) { setAutoEdit(true); setDetailId(match.id); }
    onAutoConsumed?.();
  }, [autoEditId, rows, onAutoConsumed]);

  function load() {
    fetchQuotationOverview()
      .then((d) => setRows(d.rows))
      .catch((e) => setError(e instanceof Error ? e.message : "Error"));
  }
  useEffect(load, []);

  const refresh = () => {
    load();
    onChanged();
  };

  const columns: ColumnDef<QtnRow>[] = [
    projectNoColumn<QtnRow>({ projectNo: (r) => r.project_no, firstRfqAt: (r) => r.first_rfq_at }),
    ...identityColumns<QtnRow>({
      customer: (r) => r.customer,
      vessel: (r) => r.vessel,
      workType: (r) => r.work_type,
    }),
    {
      key: "qtn_no",
      label: "Quote No.",
      text: (r) => r.qtn_no || "",
      render: (r) => {
        const sent = (r.sent_at || r.sent_date || "").slice(0, 10);
        return (
          <div>
            <div className="m">{r.qtn_no || <span className="dash">—</span>}</div>
            {sent ? <div className="s">Sent: {sent}</div> : null}
          </div>
        );
      },
    },
    { key: "item_count", label: "Items", numeric: true, text: (r) => String(r.item_count), sortValue: (r) => r.item_count },
    {
      key: "amount",
      label: "Total",
      numeric: true,
      text: (r) => dualCurrencyText(r.amount, r.currency),
      render: (r) => <DualCurrencyAmount value={r.amount} currency={r.currency} />,
      sortValue: (r) => r.amount,
    },
    { key: "level", label: "Level", text: (r) => r.level || "" },
    { key: "valid_until", label: "Valid until", text: (r) => r.valid_until || "", filter: "date" },
    { key: "status", label: "Status", text: (r) => tr(r.status) || "", filter: "facet", render: (r) => <span className="ar-badge">{tr(r.status)}</span> },
  ];

  if (error) return <div className="state error">API error: {error}</div>;

  return (
    <>
      <FilterTable
        rows={rows}
        columns={columns}
        getRowKey={(r) => r.id}
        onRowClick={(r) => { setAutoEdit(true); setDetailId(r.id); }}
        empty="No quotations to display."
        actions={
          <button className="btn primary" onClick={() => { setPickRfqId(null); setAdding(true); }}>
            + New
          </button>
        }
      />

      {adding ? (
        <Modal title="Create & Send Customer Quotation" onClose={() => setAdding(false)} wide>
          {/* 신규 등록 대상 = Vendor 견적까지(3단계) 진행, 고객 견적 미발송 프로젝트 */}
          <ProjectPicker projects={projects.filter((p) => p.stage === 3)} rfqId={pickRfqId} onSelect={setPickRfqId} />
          <RfqProjectInfo project={projects.find((p) => p.id === pickRfqId)} />
          <CustomerQuoteAction
            rfqId={pickRfqId ?? 0}
            onDone={() => {
              setAdding(false);
              refresh();
            }}
          />
        </Modal>
      ) : null}

      {detailId !== null ? (
        <CustomerQuoteDetailModal id={detailId} autoEdit={autoEdit} onClose={() => { setDetailId(null); setAutoEdit(false); }} onChanged={refresh} />
      ) : null}
    </>
  );
}

function CustomerQuoteDetailModal({
  id,
  autoEdit,
  onClose,
  onChanged,
}: {
  id: number;
  autoEdit?: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [d, setD] = useState<CustomerQuotationDetail | null>(null);
  const [editing, setEditing] = useState(!!autoEdit);
  const [qtnNo, setQtnNo] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [sentAt, setSentAt] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [status, setStatus] = useState("");
  const [terms, setTerms] = useState<QuotationTerms>({});
  const [items, setItems] = useState<CustomerQuoteItem[]>([]);
  const [vendorQuotes, setVendorQuotes] = useState<VendorQuoteForImport[]>([]);
  const [importVqId, setImportVqId] = useState<number | "">("");
  const [defaultMargin, setDefaultMargin] = useState(20);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchCustomerQuotationDetail(id)
      .then((data) => {
        setD(data);
        setQtnNo(data.qtn_no || "");
        setCurrency(data.currency || "USD");
        setSentAt(toLocalDt(data.sent_at || data.sent_date));
        setValidUntil(data.valid_until || "");
        setStatus(data.status || "");
        setTerms(data.terms || {});
        setItems(data.items || []);
        setMsg(null);
        if (data.rfq_id) {
          fetchRfqVendorQuotes(data.rfq_id)
            .then((r) => setVendorQuotes(r.vendor_quotes))
            .catch(() => setVendorQuotes([]));
        } else {
          setVendorQuotes([]);
        }
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Error"));
  }, [id]);

  const total = items.reduce((sum, it) => sum + Number(it.amount || 0), 0);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await updateCustomerQuotation(id, {
        qtn_no: qtnNo,
        currency,
        sent_at: sentAt,
        valid_until: validUntil,
        status,
        terms,
        items,
      });
      setEditing(false);
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("Delete this quotation?")) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteCustomerQuotation(id);
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
      setBusy(false);
    }
  }

  function importFromVendorQuote() {
    if (importVqId === "") return;
    const vq = vendorQuotes.find((v) => v.id === importVqId);
    if (!vq) return;
    setItems(customerQuoteItemsFromVendorQuote(vq, defaultMargin));
    if (vq.currency) setCurrency(vq.currency);
    setMsg(`Loaded ${vq.items.length} item(s) from quote ${vq.vendor_quote_no} (${vq.vendor}).`);
  }

  const STATUSES = ["초안", "발송완료", "협상중", "수주확정", "실주", "만료"];

  return (
    <Modal title={d ? <ModalTitle label={`Quotation — ${d.qtn_no}`} projectNo={d.project_no} /> : "Quotation details"} onClose={onClose} wide>
      {!d ? (
        <div className="empty">Loading…</div>
      ) : editing ? (
        <>
          <div className="form-section-title">Project info</div>
          <dl className="intl-meta">
            <BaseMetaRows info={d} />
            <div><dt>RFQ No.</dt><dd>{d.rfq_no || "—"}</dd></div>
            <div><dt>Items</dt><dd>{items.length}</dd></div>
          </dl>

          <div className="form-section-title">Quotation info</div>
          <div className="po-work-note" style={{ marginTop: 12 }}>
            <b>Load from Vendor quote</b>
            <span>Select a previous Vendor Quote to auto-fill item costs, sales prices, and amounts using the default margin.</span>
          </div>
          <div className="form-grid">
            <div className="form-field">
              <label>Select Vendor quote</label>
              <select
                value={importVqId}
                onChange={(e) => setImportVqId(e.target.value === "" ? "" : Number(e.target.value))}
                disabled={vendorQuotes.length === 0}
              >
                <option value="">
                  {vendorQuotes.length === 0 ? "No Vendor quote received" : "Manual entry"}
                </option>
                {vendorQuotes.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.received_date || "—"} · {v.vendor} · {v.vendor_quote_no}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label>Default margin (%)</label>
              <input
                className="num"
                type="number"
                value={defaultMargin}
                onChange={(e) => setDefaultMargin(Number(e.target.value))}
              />
            </div>
            <div className="form-field" style={{ alignSelf: "end" }}>
              <button className="btn" onClick={importFromVendorQuote} disabled={importVqId === ""}>
                Load Vendor quote
              </button>
            </div>
          </div>

          <div className="form-grid">
            <div className="form-field">
              <label>Quotation No.</label>
              <input value={qtnNo} onChange={(e) => setQtnNo(e.target.value)} placeholder="KMS-QUO-2606-001" />
            </div>
            <div className="form-field">
              <label>Currency</label>
              <CurrencyToggle value={currency} onChange={setCurrency} />
            </div>
            <div className="form-field">
              <label>Sent at</label>
              <input type="datetime-local" value={sentAt} onChange={(e) => setSentAt(e.target.value)} />
            </div>
            <div className="form-field">
              <label>Valid until</label>
              <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
            </div>
            <div className="form-field">
              <label>Status</label>
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>{tr(s)}</option>
                ))}
              </select>
            </div>
          </div>
          <CustomerQuoteItemEditor items={items} onChange={setItems} currency={currency} />
          <QuotationTermsEditor terms={terms} onChange={setTerms} />
          <div className="form-actions">
            <span className="action-name">Total: {dualCurrencyText(total, currency)} · {fxRateText()}</span>
            <button className="btn primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
            <button className="btn" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
          </div>
          {msg ? <span className="action-ok">{msg}</span> : null}
          {err ? <span className="action-err">{err}</span> : null}
        </>
      ) : (
        <>
          <dl className="intl-meta">
            <BaseMetaRows info={d} />
            <div><dt>RFQ No.</dt><dd>{d.rfq_no || "—"}</dd></div>
            <div><dt>Total</dt><dd>{dualCurrencyText(d.amount, d.currency)}<br /><span className="fx-note">{fxRateText()}</span></dd></div>
            <div><dt>Sent at</dt><dd>{d.sent_at || d.sent_date || "—"}</dd></div>
            <div><dt>Valid until</dt><dd>{d.valid_until || "—"}</dd></div>
            <div><dt>Status</dt><dd>{tr(d.status)}</dd></div>
            <div><dt>Items</dt><dd>{d.items.length}</dd></div>
          </dl>
          <div className="form-actions">
            <button className="btn" onClick={() => setEditing(true)} style={{ marginLeft: "auto" }}>✎ Edit</button>
            <button className="btn danger" onClick={remove} disabled={busy}>Delete</button>
          </div>
          {err ? <span className="action-err">{err}</span> : null}
        </>
      )}
    </Modal>
  );
}

// 옵션 한 줄을 세그먼트별로 색·굵기를 달리해 표시한다. 기본 <select>는 옵션
// 내부 스타일링을 지원하지 않으므로 커스텀 드롭다운(ProjectSelect)에서 쓴다.
// RFQ번호=회색, 고객사=진하게, 선박명=기본, 프로젝트명=회색.
function ProjectOptionLabel({ r }: { r: RfqRow }) {
  const no = r.crfq_no || r.customer_rfq_no || `RFQ-${r.id}`;
  const vessel = r.vessel && r.vessel !== "—" ? r.vessel : "";
  const title = r.project_title || "";
  return (
    <span className="proj-label">
      <span className="proj-no">{no}</span>
      <span className="proj-sep"> · </span>
      <span className="proj-cust">{r.customer}</span>
      {vessel ? (
        <>
          <span className="proj-sep"> · </span>
          <span className="proj-vessel">{vessel}</span>
        </>
      ) : null}
      {title ? (
        <>
          <span className="proj-sep"> · </span>
          <span className="proj-title">{title}</span>
        </>
      ) : null}
    </span>
  );
}

// 각 탭 상단에 위치하는 "진행중인 프로젝트" 셀렉터. 선택한 RFQ가 2~4번 탭의 작업 대상이 된다.
// 세그먼트별 색 구분을 위해 기본 <select> 대신 커스텀 드롭다운으로 구현했다.
function ProjectSelect({
  rows,
  rfqId,
  onSelect,
}: {
  rows: RfqRow[];
  rfqId: number | null;
  onSelect: (id: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = rows.find((r) => r.id === rfqId) ?? null;

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="project-select">
      <label>Active project</label>
      <div className="proj-combo" ref={ref}>
        <button
          type="button"
          className="proj-combo-btn"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          {selected ? (
            <ProjectOptionLabel r={selected} />
          ) : (
            <span className="proj-placeholder">Select…</span>
          )}
          <span className="proj-caret" aria-hidden>
            ▾
          </span>
        </button>
        {open ? (
          <ul className="proj-combo-list" role="listbox">
            <li
              className="proj-combo-item"
              role="option"
              aria-selected={rfqId === null}
              onClick={() => {
                onSelect(null);
                setOpen(false);
              }}
            >
              <span className="proj-placeholder">Select…</span>
            </li>
            {rows.map((r) => (
              <li
                key={r.id}
                className={"proj-combo-item" + (r.id === rfqId ? " on" : "")}
                role="option"
                aria-selected={r.id === rfqId}
                onClick={() => {
                  onSelect(r.id);
                  setOpen(false);
                }}
              >
                <ProjectOptionLabel r={r} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <span className="hint-inline">No projects registered.</span>
      ) : null}
    </div>
  );
}

function VendorRfqAction({
  rfqId,
  vendors,
  kmarisNo,
  onDone,
}: {
  rfqId: number;
  vendors: VendorOption[];
  kmarisNo: string;
  onDone: () => void;
}) {
  const [vendorIds, setVendorIds] = useState<number[]>([]);
  const [lang, setLang] = useState<"en" | "ko">("en");
  const [notes, setNotes] = useState("");
  const [previews, setPreviews] = useState<VendorRfqPreview[]>([]);
  // 케이마리스 RFQ No.는 이 단계(Vendor RFQ 발신)에서 부여된다.
  const unassigned = !kmarisNo || kmarisNo === "Not issued" || kmarisNo === "-";
  const [manualNo, setManualNo] = useState("");
  const rfqNoArg = unassigned && manualNo.trim() ? { mode: "manual" as const, value: manualNo.trim() } : undefined;
  const [sentAt, setSentAt] = useState(nowLocalDt());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function toggleVendor(id: number) {
    setVendorIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  // RFQ 생성 — 케이마리스 RFQ No. 단독 발번(선택)
  async function generateRfqNo() {
    if (!manualNo.trim()) {
      setErr("Enter the K-Maris RFQ No. or leave it as '-'.");
      return;
    }
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await assignRfqNo(rfqId, { mode: "manual", rfq_no: manualNo.trim() });
      setMsg(`K-Maris RFQ No. saved: ${r.rfq_no}`);
      onDone(); // 목록 새로고침 → 발급 상태 반영
    } catch (e) {
      setErr(e instanceof Error ? e.message : "RFQ creation failed");
    } finally {
      setBusy(false);
    }
  }

  async function makePreview() {
    if (vendorIds.length === 0) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await previewVendorRfq(rfqId, vendorIds, lang, notes, rfqNoArg);
      setPreviews(r.previews);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Preview generation failed");
    } finally {
      setBusy(false);
    }
  }

  function patchPreview(i: number, key: keyof VendorRfqPreview, value: string) {
    setPreviews((prev) =>
      prev.map((p, idx) => (idx === i ? { ...p, [key]: value } : p))
    );
  }

  async function downloadXlsx(p: VendorRfqPreview) {
    const res = await fetch(vendorRfqXlsxUrl(rfqId, p.vendor_id), {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) {
      setErr("XLSX download failed");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = p.xlsx_filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // 발신 완료 — 선택한 Vendor의 RFQ 발신을 기록(이메일 생성 여부와 무관). 초안이 있으면 그 내용을 함께 보낸다.
  async function sendAll() {
    if (vendorIds.length === 0) {
      setErr("Select a vendor.");
      return;
    }
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const items = vendorIds.map((vid) => {
        const p = previews.find((x) => x.vendor_id === vid);
        return {
          vendor_id: vid,
          to: p?.to ?? "",
          subject: p?.subject ?? "",
          body: p?.body ?? "",
        };
      });
      const r = await sendVendorRfq(rfqId, items, rfqNoArg, sentAt || undefined);
      setMsg(`K-Maris RFQ No. ${r.rfq_no || "-"} · sent (${r.saved} Vendor RFQ recorded)`);
      setPreviews([]);
      setVendorIds([]);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="sub-h">Create & Send Vendor RFQ</div>
      <div className="po-work-note">
        <b>RFQ request email</b>
        <span>Generates an email draft and an Excel response form. Send the email yourself, then mark it as "Sent".</span>
      </div>
      <div className="form-field">
        <label>K-Maris RFQ No.</label>
        {unassigned ? (
          <>
            <input
              style={{ maxWidth: 320 }}
              value={manualNo}
              onChange={(e) => setManualNo(e.target.value)}
              placeholder="Optional"
            />
            <span className="hint-inline" style={{ marginTop: 8, display: "inline-block" }}>
              Leave blank to keep K-Maris RFQ No. as "-".
            </span>
          </>
        ) : (
          <div className="action-ctx" style={{ margin: 0 }}>
            Issued: <b>{kmarisNo}</b>
          </div>
        )}
      </div>
      <div className="form-field">
        <label>Select vendor</label>
        <div className="vendor-checks">
          {vendors.map((v) => (
            <label key={v.id} className="check-inline">
              <input
                type="checkbox"
                checked={vendorIds.includes(v.id)}
                onChange={() => toggleVendor(v.id)}
              />
              {v.name}
            </label>
          ))}
        </div>
      </div>
      <div className="form-grid">
        <div className="form-field">
          <label>Email language</label>
          <select value={lang} onChange={(e) => setLang(e.target.value as "en" | "ko")}>
            <option value="en">English</option>
            <option value="ko">Korean</option>
          </select>
        </div>
        <div className="form-field">
          <label>Sent at (mark as sent)</label>
          <input
            type="datetime-local"
            value={sentAt}
            onChange={(e) => setSentAt(e.target.value)}
          />
        </div>
      </div>
      <div className="form-field">
        <label>Note to vendor</label>
        <textarea
          className="po-textarea small"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      {/* 3개 버튼 동시 표시: RFQ 생성(선택) · 이메일 생성(선택) · 발신 완료(필수) */}
      <div className="form-actions">
        <button className="btn" onClick={generateRfqNo} disabled={busy || !unassigned}>
          Create RFQ
        </button>
        <button className="btn" onClick={makePreview} disabled={busy || vendorIds.length === 0}>
          Generate email
        </button>
        <button className="btn primary" onClick={sendAll} disabled={busy || vendorIds.length === 0}>
          Mark as sent
        </button>
        <span className="hint-inline">
          Create RFQ and Generate email are optional; Mark as sent is required.
        </span>
      </div>

      {previews.length > 0 ? (
        <div style={{ marginTop: 14 }}>
          <div className="po-work-note">
            <b>Send email yourself</b>
            <span>Copy the draft (subject/body), attach the Excel form, send it yourself, then click "Sent" to record it. The system does not send mail.</span>
          </div>
          {previews.map((p, i) => (
            <div key={p.vendor_id} className="panel" style={{ boxShadow: "none" }}>
              <div className="sub-h">{p.vendor_name}</div>
              <div className="form-grid">
                <div className="form-field">
                  <label>Recipient email</label>
                  <input value={p.to} onChange={(e) => patchPreview(i, "to", e.target.value)} />
                </div>
                <div className="form-field">
                  <label>Subject</label>
                  <input value={p.subject} onChange={(e) => patchPreview(i, "subject", e.target.value)} />
                </div>
              </div>
              <div className="form-field">
                <label>Body</label>
                <textarea
                  className="po-textarea"
                  value={p.body}
                  onChange={(e) => patchPreview(i, "body", e.target.value)}
                />
              </div>
              <button className="btn" onClick={() => downloadXlsx(p)}>
                Download quote form XLSX
              </button>
            </div>
          ))}
          <div className="form-actions">
            <button className="btn" onClick={() => setPreviews([])}>
              Close draft
            </button>
          </div>
        </div>
      ) : null}
      {msg ? <span className="action-ok">{msg}</span> : null}
      {err ? <span className="action-err">{err}</span> : null}
    </>
  );
}

function VendorQuoteAction({
  rfqId,
  vendorRfqs,
  onDone,
}: {
  rfqId: number;
  vendorRfqs: RfqDetailT["vendor_rfqs"];
  onDone: () => void;
}) {
  const [vrfqId, setVrfqId] = useState<number | "">("");
  const [no, setNo] = useState("");
  const [receivedAt, setReceivedAt] = useState(nowLocalDt());
  const [currency, setCurrency] = useState("USD");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<VendorQuoteItem[]>([]);
  const [parseMsg, setParseMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (vrfqId === "") {
      setItems([]);
      return;
    }
    setItems([]);
    setParseMsg(null);
  }, [vrfqId]);

  async function parseFile(file: File | null) {
    if (!file) return;
    setBusy(true);
    setErr(null);
    setParseMsg(null);
    try {
      const r = await parseVendorQuoteFile(file);
      const parsed = r.items || [];
      setItems((prev) => mergeParsedItems(prev.length ? prev : [], parsed));
      setParseMsg(
        parsed.length
          ? `Auto-filled ${parsed.length} item(s) — review and edit`
          : "Could not extract items. Enter manually or try another file."
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "File parsing failed");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (vrfqId === "") return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const clean = cleanVendorQuoteItems(items);
      const amount = clean.reduce(
        (sum, it) => sum + (Number(it.cost_price || 0) * Number(it.qty || 1)),
        0
      );
      const r = await createVendorQuote(
        rfqId,
        vrfqId,
        no.trim(),
        amount,
        currency,
        clean,
        receivedAt,
        notes
      );
      setMsg(`Registered — ${r.vendor_quote_no}`);
      setNo("");
      setCurrency("USD");
      setNotes("");
      setItems([]);
      setVrfqId("");
      setReceivedAt(nowLocalDt());
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="sub-h">Register Vendor Quote</div>
      {vendorRfqs.length === 0 ? (
        <span className="hint-inline">Select a project with a sent Vendor RFQ to enable saving.</span>
      ) : null}
      <>
          <div className="form-grid">
            <div className="form-field">
              <label>Select Vendor RFQ</label>
              <select
                value={vrfqId}
                onChange={(e) =>
                  setVrfqId(e.target.value === "" ? "" : Number(e.target.value))
                }
              >
                <option value="">Select Vendor RFQ…</option>
                {vendorRfqs.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.vendor}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label>Vendor quote no.</label>
              <input value={no} onChange={(e) => setNo(e.target.value)} />
            </div>
            <div className="form-field">
              <label>Quote received at</label>
              <input
                type="datetime-local"
                value={receivedAt}
                onChange={(e) => setReceivedAt(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label>Currency</label>
              <CurrencyToggle value={currency} onChange={setCurrency} />
            </div>
          </div>

          <div className="po-work-note" style={{ marginTop: 12 }}>
            <b>Upload Vendor quote file</b>
            <span>Upload the PDF · Excel · image (screenshot/photo) returned by the vendor to auto-fill the item list (Description, Part No., Maker, Origin, Unit Price, Lead Time, etc.).</span>
          </div>
          <div className="action-row">
            <input
              type="file"
              accept=".pdf,.xlsx,.xls,.png,.jpg,.jpeg,.webp,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/*"
              disabled={busy || vrfqId === ""}
              onChange={(e) => parseFile(e.target.files?.[0] ?? null)}
            />
            {busy ? <span className="hint-inline">Analyzing…</span> : null}
            {parseMsg ? <span className="action-ok">{parseMsg}</span> : null}
          </div>

          <VendorQuoteItemEditor items={items} onChange={setItems} currency={currency} />

          <div className="form-field" style={{ marginTop: 12 }}>
            <label>Notes</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          <div className="form-actions">
            <button
              className="btn primary"
              onClick={submit}
              disabled={busy || vrfqId === ""}
            >
              {busy ? "Saving…" : "Save quote"}
            </button>
          </div>
        </>
      {msg ? <span className="action-ok">{msg}</span> : null}
      {err ? <span className="action-err">{err}</span> : null}
    </div>
  );
}

function VendorQuoteItemEditor({
  items,
  onChange,
  currency = "USD",
}: {
  items: VendorQuoteItem[];
  onChange: (items: VendorQuoteItem[]) => void;
  currency?: string;
}) {
  function add() {
    onChange([
      ...items,
      {
        part_no: "",
        description: "",
        maker: "",
        origin: "",
        qty: 1,
        unit: "PCS",
        cost_price: 0,
        lead_time: "",
        remark: "",
      },
    ]);
  }
  function patch(i: number, key: keyof VendorQuoteItem, value: string) {
    onChange(
      items.map((it, idx) => {
        if (idx !== i) return it;
        if (key === "qty" || key === "cost_price") {
          return { ...it, [key]: parseAmountInput(value) };
        }
        return { ...it, [key]: value };
      })
    );
  }

  const total = items.reduce(
    (sum, it) => sum + Number(it.cost_price || 0) * Number(it.qty || 1),
    0
  );

  return (
    <div style={{ marginTop: 12 }}>
      <div className="sub-h">Quote items</div>
      <div className="table-wrap">
        <table className="mini wide">
          <thead>
            <tr>
              <th className="seq">No.</th>
              <th>Part No.</th>
              <th>Description</th>
              <th>Maker</th>
              <th>Origin</th>
              <th className="num">Qty</th>
              <th>Unit</th>
              <th className="num">Unit Price</th>
              <th>Lead Time</th>
              <th>Remark</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i} className={itemRowClass(i)}>
                <td className="seq">{i + 1}</td>
                <td><input {...gridCellProps(i, 0)} value={it.part_no} onChange={(e) => patch(i, "part_no", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 1)} value={it.description} onChange={(e) => patch(i, "description", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 2)} value={it.maker ?? ""} onChange={(e) => patch(i, "maker", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 3)} value={it.origin ?? ""} onChange={(e) => patch(i, "origin", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 4)} className="num" value={amountInputValue(it.qty)} onChange={(e) => patch(i, "qty", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 5)} value={it.unit} onChange={(e) => patch(i, "unit", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 6)} className="num" value={amountInputValue(it.cost_price)} onChange={(e) => patch(i, "cost_price", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 7)} value={it.lead_time ?? ""} onChange={(e) => patch(i, "lead_time", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 8)} value={it.remark ?? ""} onChange={(e) => patch(i, "remark", e.target.value)} /></td>
                <td>
                  <button className="row-del" disabled={items.length === 0} onClick={() => onChange(items.filter((_, idx) => idx !== i))}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={7} className="total-label">Total</td>
              <td className="num total-value">
                <DualCurrencyAmount value={total} currency={currency} />
                <span className="fx-note">{fxRateText()}</span>
              </td>
              <td colSpan={3}></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <button className="btn" style={{ marginTop: 8 }} onClick={add}>Add item</button>
    </div>
  );
}

function mergeParsedItems(
  base: VendorQuoteItem[],
  parsed: Partial<VendorQuoteItem>[]
): VendorQuoteItem[] {
  if (!base.length) {
    return parsed.map(normalizeVendorQuoteItem);
  }
  const pmap = new Map(
    parsed
      .filter((p) => p.part_no)
      .map((p) => [String(p.part_no).trim(), p])
  );
  return base.map((row) => {
    const p = pmap.get(row.part_no.trim());
    if (!p) return row;
    return normalizeVendorQuoteItem({ ...row, ...p, maker: p.maker ?? p.manufacturer ?? row.maker });
  });
}

function normalizeVendorQuoteItem(raw: Partial<VendorQuoteItem> & { manufacturer?: string }): VendorQuoteItem {
  return {
    item_no: raw.item_no,
    part_no: raw.part_no ?? "",
    description: raw.description ?? "",
    maker: raw.maker ?? raw.manufacturer ?? "",
    origin: raw.origin ?? "",
    qty: Number(raw.qty ?? 1) || 1,
    unit: raw.unit ?? "PCS",
    cost_price: raw.cost_price === undefined || raw.cost_price === null ? 0 : Number(raw.cost_price),
    lead_time: raw.lead_time ?? "",
    remark: raw.remark ?? "",
  };
}

function cleanVendorQuoteItems(items: VendorQuoteItem[]): VendorQuoteItem[] {
  return items.map(normalizeVendorQuoteItem).filter((it) => it.part_no || it.description);
}

function customerQuoteItemsFromVendorQuote(
  vq: VendorQuoteForImport,
  defaultMargin: number
): CustomerQuoteItem[] {
  return vq.items.map((it) => {
    const cost = Number(it.cost_price ?? 0);
    const unit = calcUnitPrice(cost, defaultMargin);
    const qty = Number(it.qty || 1);
    return {
      part_no: it.part_no || "",
      description: it.description || "",
      qty,
      unit: it.unit || "PCS",
      cost_price: cost,
      margin_pct: defaultMargin,
      unit_price: unit,
      amount: unit * qty,
    };
  });
}

// Streamlit 4_Quotation.py 의 거래 조건 프리셋 — datalist 로 드롭다운 + 자유 입력 모두 지원.
const TERM_PRESETS = {
  incoterms: ["FCA Busan, Korea", "FOB Busan, Korea", "CIF (named port of destination)", "CFR (named port of destination)", "DAP (named destination)", "EXW Busan"],
  shipment_method: ["Air courier / Sea freight", "By Air (Courier)", "By Sea (FCL)", "By Sea (LCL)"],
  payment_terms: ["100% T/T in advance", "T/T 30 days after delivery", "T/T 50% in advance, 50% before shipment", "L/C at sight"],
  packing: ["Standard export packing", "Seaworthy export packing", "Wooden case packing"],
  delivery_place: ["Busan, Republic of Korea", "Incheon, Republic of Korea"],
  warranty: ["Manufacturer's standard warranty", "12 months from delivery", "6 months from delivery", "No warranty"],
} as const;

function CustomerQuoteAction({
  rfqId,
  onDone,
}: {
  rfqId: number;
  onDone: () => void;
}) {
  const [qtnNo, setQtnNo] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [sentAt, setSentAt] = useState(nowLocalDt());
  const [items, setItems] = useState<CustomerQuoteItem[]>([]);
  const [validUntil, setValidUntil] = useState("");
  const [defaultMargin, setDefaultMargin] = useState(20);
  const [terms, setTerms] = useState<QuotationTerms>({
    remarks: "Bank charges outside Korea shall be borne by Buyer.",
  });
  const [vendorQuotes, setVendorQuotes] = useState<VendorQuoteForImport[]>([]);
  const [importVqId, setImportVqId] = useState<number | "">("");
  const [docType, setDocType] = useState<"quotation" | "proforma_invoice">("quotation");
  const [qtn, setQtn] = useState<{ id: number; qtn_no: string } | null>(null);
  const [email, setEmail] = useState<{ to: string; subject: string; body: string; smtp_configured: boolean } | null>(null);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // RFQ 품목 정보로 기본 seed (cost 없음) — 공급사 견적을 불러오면 cost 가 채워진다.
  useEffect(() => {
    if (!rfqId) {
      setItems([]);
      setVendorQuotes([]);
      return;
    }
    fetchRfqDetail(rfqId)
      .then((d) =>
        setItems(
          d.items.map((it) => ({
            part_no: it.part_no,
            description: it.description,
            qty: Number(it.qty || 1),
            unit: it.unit || "PCS",
            cost_price: 0,
            margin_pct: 20,
            unit_price: 0,
            amount: 0,
          }))
        )
      )
      .catch(() => setItems([]));
    fetchRfqVendorQuotes(rfqId)
      .then((d) => setVendorQuotes(d.vendor_quotes))
      .catch(() => setVendorQuotes([]));
  }, [rfqId]);

  // 선택한 공급사 견적의 품목·cost_price 를 불러와 기본 마진을 적용한다.
  function importFromVendorQuote() {
    if (importVqId === "") return;
    const vq = vendorQuotes.find((v) => v.id === importVqId);
    if (!vq) return;
    setItems(customerQuoteItemsFromVendorQuote(vq, defaultMargin));
    if (vq.currency) setCurrency(vq.currency);
    setMsg(`Loaded ${vq.items.length} item(s) from quote ${vq.vendor_quote_no} (${vq.vendor}).`);
  }

  const total = items.reduce((sum, it) => sum + Number(it.amount || 0), 0);

  async function submit() {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await createCustomerQuote(rfqId, currency, total, items, validUntil, undefined, terms, qtnNo, sentAt);
      setQtn({ id: r.id, qtn_no: r.qtn_no });
      setMsg(`Sent — ${r.qtn_no}`);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(false);
    }
  }

  async function makeEmailPreview() {
    if (!qtn) return;
    setBusy(true);
    setErr(null);
    try {
      const p = await previewQuotationEmail(qtn.id, "en");
      setEmail(p);
      setTo(p.to);
      setSubject(p.subject);
      setBody(p.body);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Email preview failed");
    } finally {
      setBusy(false);
    }
  }

  async function downloadPdf() {
    if (!qtn) return;
    const res = await fetch(quotationPdfUrl(qtn.id, docType), {
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
    a.download = `${qtn.qtn_no}_${docType}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function sendEmail() {
    if (!qtn) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await sendQuotationEmail(qtn.id, to, subject, body, docType);
      setMsg(`Email sent: ${r.sent_date}`);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Email sending failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="sub-h">Create & Send Customer Quotation</div>

      <div className="po-work-note">
        <b>Load from Vendor quote — recommended</b>
        <span>Selecting a supplier quote loads its items and cost, then applies the default margin.</span>
      </div>
      <div className="form-grid">
        <div className="form-field">
          <label>Select Vendor quote</label>
          <select
            value={importVqId}
            onChange={(e) => setImportVqId(e.target.value === "" ? "" : Number(e.target.value))}
            disabled={vendorQuotes.length === 0}
          >
            <option value="">
              {vendorQuotes.length === 0 ? "No Vendor quote received" : "— Manual entry —"}
            </option>
            {vendorQuotes.map((v) => (
              <option key={v.id} value={v.id}>
                {v.received_date || "—"} · {v.vendor} · {v.vendor_quote_no}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label>Default margin (%)</label>
          <input
            className="num"
            type="number"
            value={defaultMargin}
            onChange={(e) => setDefaultMargin(Number(e.target.value))}
          />
        </div>
        <div className="form-field" style={{ alignSelf: "end" }}>
          <button className="btn" onClick={importFromVendorQuote} disabled={importVqId === ""}>
            Load Vendor quote
          </button>
        </div>
      </div>

      <div className="form-grid">
        <div className="form-field">
          <label>Quotation No.</label>
          <input value={qtnNo} onChange={(e) => setQtnNo(e.target.value)} placeholder="Blank = auto-generate" />
        </div>
        <div className="form-field">
          <label>Currency</label>
          <CurrencyToggle value={currency} onChange={setCurrency} />
        </div>
        <div className="form-field">
          <label>Sent at</label>
          <input type="datetime-local" value={sentAt} onChange={(e) => setSentAt(e.target.value)} />
        </div>
        <div className="form-field">
          <label>Valid until</label>
          <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
        </div>
      </div>

      <CustomerQuoteItemEditor items={items} onChange={setItems} currency={currency} />

      <QuotationTermsEditor terms={terms} onChange={setTerms} />

      <div className="form-actions">
        <span className="action-name">Total: {dualCurrencyText(total, currency)} · {fxRateText()}</span>
        <button className="btn primary" onClick={submit} disabled={busy || items.length === 0}>
          {busy ? "Saving…" : "Save quote"}
        </button>
      </div>

      {qtn ? (
        <div className="panel" style={{ boxShadow: "none" }}>
          <div className="sub-h">Send — {qtn.qtn_no}</div>
          <div className="form-grid">
            <div className="form-field">
              <label>Document type</label>
              <select value={docType} onChange={(e) => setDocType(e.target.value as "quotation" | "proforma_invoice")}>
                <option value="quotation">Quotation</option>
                <option value="proforma_invoice">Proforma Invoice (PI)</option>
              </select>
            </div>
          </div>
          <div className="form-actions">
            <button className="btn" onClick={downloadPdf}>Download PDF</button>
            <button className="btn" onClick={makeEmailPreview} disabled={busy}>Preview email</button>
          </div>
        </div>
      ) : null}

      {email ? (
        <div className="panel" style={{ boxShadow: "none" }}>
          {!email.smtp_configured ? <div className="action-err">SMTP not configured: real sending is unavailable.</div> : null}
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
            <textarea className="po-textarea" value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          <button className="btn primary" onClick={sendEmail} disabled={busy || !to || !email.smtp_configured}>
            {docType === "proforma_invoice" ? "Send PI email" : "Send quotation email"}
          </button>
        </div>
      ) : null}
      {msg ? <span className="action-ok">{msg}</span> : null}
      {err ? <span className="action-err">{err}</span> : null}
    </div>
  );
}

function QuotationTermsEditor({
  terms,
  onChange,
}: {
  terms: QuotationTerms;
  onChange: (terms: QuotationTerms) => void;
}) {
  function field(key: keyof QuotationTerms, label: string) {
    const presets = (TERM_PRESETS as Record<string, readonly string[]>)[key];
    const listId = `qtn-term-${key}`;
    return (
      <div className="form-field">
        <label>{label}</label>
        <input
          list={presets ? listId : undefined}
          value={terms[key] ?? ""}
          onChange={(e) => onChange({ ...terms, [key]: e.target.value })}
        />
        {presets ? (
          <datalist id={listId}>
            {presets.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        ) : null}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div className="sub-h">Terms</div>
      <div className="form-grid">
        {field("incoterms", "Incoterms")}
        {field("shipment_method", "Shipment Method")}
        {field("payment_terms", "Payment Terms")}
        {field("packing", "Packing")}
        {field("delivery_place", "Delivery Place")}
        {field("warranty", "Warranty")}
      </div>
      <div className="form-field" style={{ marginTop: 8 }}>
        <label>Remarks</label>
        <input value={terms.remarks ?? ""} onChange={(e) => onChange({ ...terms, remarks: e.target.value })} />
      </div>
    </div>
  );
}

function CustomerQuoteItemEditor({
  items,
  onChange,
  currency = "USD",
}: {
  items: CustomerQuoteItem[];
  onChange: (items: CustomerQuoteItem[]) => void;
  currency?: string;
}) {
  function patch(i: number, key: keyof CustomerQuoteItem, value: string) {
    onChange(
      items.map((it, idx) => {
        if (idx !== i) return it;
        const next: CustomerQuoteItem = { ...it };
        if (key === "qty" || key === "cost_price" || key === "margin_pct" || key === "unit_price" || key === "amount") {
          (next[key] as number | null) = parseAmountInput(value);
        } else {
          (next[key] as string) = value;
        }
        if (key === "cost_price" || key === "margin_pct" || key === "qty") {
          const unit = calcUnitPrice(Number(next.cost_price || 0), Number(next.margin_pct || 0));
          next.unit_price = unit;
          next.amount = unit * Number(next.qty || 1);
        }
        if (key === "unit_price" || key === "qty") {
          next.amount = Number(next.unit_price || 0) * Number(next.qty || 1);
        }
        return next;
      })
    );
  }
  const total = items.reduce((sum, it) => sum + Number(it.amount || 0), 0);

  return (
    <div style={{ marginTop: 12 }}>
      <div className="sub-h">Quote items</div>
      <div className="table-wrap">
        <table className="mini wide">
          <thead>
            <tr>
              <th className="seq">No.</th>
              <th>Part No.</th>
              <th>Description</th>
              <th className="num">Qty</th>
              <th>Unit</th>
              <th className="num">Cost</th>
              <th className="num">Margin %</th>
              <th className="num">Unit Price</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i} className={itemRowClass(i)}>
                <td className="seq">{i + 1}</td>
                <td><input {...gridCellProps(i, 0)} value={it.part_no} onChange={(e) => patch(i, "part_no", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 1)} value={it.description} onChange={(e) => patch(i, "description", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 2)} className="num" value={amountInputValue(it.qty)} onChange={(e) => patch(i, "qty", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 3)} value={it.unit} onChange={(e) => patch(i, "unit", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 4)} className="num" value={amountInputValue(it.cost_price)} onChange={(e) => patch(i, "cost_price", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 5)} className="num" value={amountInputValue(it.margin_pct)} onChange={(e) => patch(i, "margin_pct", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 6)} className="num" value={amountInputValue(it.unit_price)} onChange={(e) => patch(i, "unit_price", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 7)} className="num" value={amountInputValue(it.amount)} onChange={(e) => patch(i, "amount", e.target.value)} /></td>
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
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function calcUnitPrice(cost: number, marginPct: number) {
  return Number((cost * (1 + marginPct / 100)).toFixed(2));
}
