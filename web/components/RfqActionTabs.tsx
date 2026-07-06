"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchVendors,
  fetchRfqDetail,
  fetchRfqVendorQuotes,
  createVendorRfq,
  assignRfqNo,
  fetchNextRfqNo,
  fetchNextQuotationNo,
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
import { getToken, can, canEditDeal, editBlockReason } from "@/lib/auth";
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
import { identityColumns, projectNoColumn, statusColumns } from "./common/identityColumns";
import VendorName from "./common/VendorName";
import { imageFromClipboard } from "@/lib/imagePaste";
import Modal from "./common/Modal";
import BaseMetaRows, { ModalTitle } from "./common/BaseMeta";
import CurrencyToggle from "./common/CurrencyToggle";
import {
  amountInputValue,
  convertCurrency,
  DualCurrencyAmount,
  dualCurrencyText,
  fxRateText,
  gridCellProps,
  itemRowClass,
  parseAmountInput,
  roundUp,
  StageTotal,
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

function money(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function RfqActionTabs({
  rfqId,
  rows,
  onSelect,
  onChanged,
  initialTab,
  embedded,
}: {
  rfqId: number | null;
  rows: RfqRow[];
  onSelect: (id: number | null) => void;
  onChanged: () => void;
  initialTab?: string | null;
  // embedded: 프로젝트 워크스페이스 내부. 내부 탭바·전역 목록·생성 없이 이 프로젝트(rfqId)의
  // 단건 상세를 인라인으로 표시. 단계(new/vrfq/vquote/cquote)는 initialTab이 결정.
  embedded?: boolean;
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

  // 프로젝트 워크스페이스: 내부 탭바 없이 이 프로젝트(rfqId)의 해당 단계 상세를 인라인으로.
  if (embedded) {
    const project = rows.find((p) => p.id === rfqId);
    return (
      <div className="action-tabs embedded">
        {tab === "new" && (
          <EmbeddedCustomerRfq rfqId={rfqId} onChanged={onChanged} />
        )}
        {tab === "vrfq" && (
          <EmbeddedVendorRfq rfqId={rfqId} project={project} vendors={vendors} onChanged={onChanged} />
        )}
        {tab === "vquote" && (
          <EmbeddedVendorQuote rfqId={rfqId} onChanged={onChanged} />
        )}
        {tab === "cquote" && (
          <EmbeddedCustomerQuote rfqId={rfqId} onChanged={onChanged} />
        )}
      </div>
    );
  }

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

// ── 프로젝트 워크스페이스 임베드 뷰(단건 인라인) ────────────────────────────────
// 각 단계에서 이 프로젝트의 레코드만 조회해 상세 편집 폼을 인라인으로 렌더한다.
// 여러 벤더가 있을 수 있는 vrfq/vquote는 컴팩트 선택기 + 인라인 상세.

function EmptyStage({ text }: { text: string }) {
  return (
    <div className="project-work-panel">
      <div className="project-work-empty">{text}</div>
    </div>
  );
}

function RecordPicker<T extends { id: number }>({
  rows,
  selectedId,
  label,
  onSelect,
}: {
  rows: T[];
  selectedId: number;
  label: (r: T) => React.ReactNode;
  onSelect: (id: number) => void;
}) {
  if (rows.length <= 1) return null;
  return (
    <div className="embedded-record-picker" role="tablist">
      {rows.map((r) => (
        <button
          key={r.id}
          type="button"
          className={r.id === selectedId ? "on" : ""}
          onClick={() => onSelect(r.id)}
        >
          {label(r)}
        </button>
      ))}
    </div>
  );
}

// 1. Customer RFQ — 프로젝트 자체 레코드이므로 rfqId로 상세 폼을 바로 로드.
function EmbeddedCustomerRfq({ rfqId, onChanged }: { rfqId: number | null; onChanged: () => void }) {
  if (!rfqId) return <EmptyStage text="No Customer RFQ for this project." />;
  return (
    <div className="embedded-detail">
      <NewRfqForm
        autoLoadId={rfqId}
        onCreated={onChanged}
        onCancel={() => undefined}
        onDeleted={onChanged}
      />
    </div>
  );
}

// 등록 폼 상단 바(뒤로 가기) — 레코드가 있는데 신규 추가로 진입한 경우.
function EmbeddedAddBar({ label, onBack }: { label: string; onBack?: () => void }) {
  return (
    <div className="embedded-add-head">
      {onBack ? (
        <button type="button" className="btn" onClick={onBack}>
          ← Back
        </button>
      ) : null}
      <span className="form-section-title" style={{ margin: 0 }}>{label}</span>
    </div>
  );
}

// 2. Vendor RFQ — 멀티벤더. 없으면(또는 +New) 등록 폼, 있으면 선택 + 인라인 상세.
function EmbeddedVendorRfq({
  rfqId,
  project,
  vendors,
  onChanged,
}: {
  rfqId: number | null;
  project?: RfqRow;
  vendors: VendorOption[];
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<VrfqRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selId, setSelId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => {
    fetchVrfqOverview()
      .then((d) => setRows(d.rows))
      .catch(() => setRows([]))
      .finally(() => setLoaded(true));
  }, []);
  useEffect(() => { load(); }, [load]);
  const mine = rows.filter((r) => r.rfq_id === rfqId);
  if (!loaded) return <div className="state">Loading details…</div>;

  if (adding || mine.length === 0) {
    return (
      <div className="embedded-detail">
        {mine.length ? (
          <div className="embedded-add-head">
            <button type="button" className="btn" onClick={() => setAdding(false)}>← Back</button>
          </div>
        ) : null}
        <VendorRfqAction
          rfqId={rfqId ?? 0}
          vendors={vendors}
          kmarisNo={project?.crfq_no ?? ""}
          onDone={() => { setAdding(false); load(); onChanged(); }}
        />
      </div>
    );
  }
  const selected = mine.find((r) => r.id === selId) ?? mine[0];
  return (
    <div className="embedded-record-wrap">
      <div className="embedded-record-bar">
        <RecordPicker rows={mine} selectedId={selected.id} label={(r) => r.vendor ? <VendorName name={r.vendor} /> : `RFQ ${r.id}`} onSelect={setSelId} />
        <button type="button" className="btn primary sm" onClick={() => setAdding(true)}>+ Send another</button>
      </div>
      <VendorRfqDetailModal
        id={selected.id}
        vendors={vendors}
        onClose={() => { load(); onChanged(); }}
        onChanged={() => { load(); onChanged(); }}
        inline
      />
    </div>
  );
}

// 3. Vendor Quote — 멀티벤더. 등록 폼(이 프로젝트의 Vendor RFQ에서 선택) 또는 인라인 상세.
function EmbeddedVendorQuote({ rfqId, onChanged }: { rfqId: number | null; onChanged: () => void }) {
  const [rows, setRows] = useState<VendorQuoteOverviewRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selId, setSelId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [vendorRfqs, setVendorRfqs] = useState<RfqDetailT["vendor_rfqs"]>([]);
  const load = useCallback(() => {
    fetchVendorQuoteOverview()
      .then((d) => setRows(d.rows))
      .catch(() => setRows([]))
      .finally(() => setLoaded(true));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!rfqId) return;
    fetchRfqDetail(rfqId).then((d) => setVendorRfqs(d.vendor_rfqs)).catch(() => setVendorRfqs([]));
  }, [rfqId]);
  const mine = rows.filter((r) => r.rfq_id === rfqId);
  if (!loaded) return <div className="state">Loading details…</div>;

  if (adding || mine.length === 0) {
    if (vendorRfqs.length === 0)
      return <EmptyStage text="Send a Vendor RFQ first (stage 2) — a quote is registered against a sent RFQ." />;
    return (
      <div className="embedded-detail">
        <EmbeddedAddBar label="Register a Vendor quote" onBack={mine.length ? () => setAdding(false) : undefined} />
        <VendorQuoteAction
          rfqId={rfqId ?? 0}
          vendorRfqs={vendorRfqs}
          onDone={() => { setAdding(false); load(); onChanged(); }}
        />
      </div>
    );
  }
  const selected = mine.find((r) => r.id === selId) ?? mine[0];
  return (
    <div className="embedded-record-wrap">
      <div className="embedded-record-bar">
        {mine.length > 1 ? (
          <RecordPicker
            rows={mine}
            selectedId={selected.id}
            label={(r) => (
              <span className="rec-tab-label">
                {r.vendor ? <VendorName name={r.vendor} /> : `Quote ${r.id}`}
                {r.vendor_quote_no ? <span className="rec-quote-no">{r.vendor_quote_no}</span> : null}
              </span>
            )}
            onSelect={setSelId}
          />
        ) : (
          <span className="embedded-record-current">
            <VendorName name={selected.vendor || ""} />
            {selected.vendor_quote_no ? <span className="rec-quote-no">{selected.vendor_quote_no}</span> : null}
          </span>
        )}
        <button type="button" className="btn primary sm" onClick={() => setAdding(true)}>+ Register another</button>
      </div>
      <VendorQuoteDetailModal id={selected.id} onClose={() => { load(); onChanged(); }} onChanged={() => { load(); onChanged(); }} inline />
    </div>
  );
}

// 4. Customer Quote — 대개 1건. 없으면 등록 폼, 있으면 인라인 상세.
function EmbeddedCustomerQuote({ rfqId, onChanged }: { rfqId: number | null; onChanged: () => void }) {
  const [rows, setRows] = useState<QtnRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selId, setSelId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  // Cancel(첫 견적) 시 폼을 초기화하려고 remount 하기 위한 key.
  const [formSeq, setFormSeq] = useState(0);
  const load = useCallback(() => {
    fetchQuotationOverview()
      .then((d) => setRows(d.rows))
      .catch(() => setRows([]))
      .finally(() => setLoaded(true));
  }, []);
  useEffect(() => { load(); }, [load]);
  const mine = rows.filter((r) => r.rfq_id === rfqId);
  if (!loaded) return <div className="state">Loading details…</div>;

  if (adding || mine.length === 0) {
    return (
      <div className="embedded-detail">
        <EmbeddedAddBar label="Create & send a Customer quotation" onBack={mine.length ? () => setAdding(false) : undefined} />
        <CustomerQuoteAction
          key={formSeq}
          rfqId={rfqId ?? 0}
          onDone={() => { setAdding(false); load(); onChanged(); }}
          onCancel={mine.length ? () => setAdding(false) : () => setFormSeq((s) => s + 1)}
        />
      </div>
    );
  }
  const selected = mine.find((r) => r.id === selId) ?? mine[0];
  return (
    <div className="embedded-record-wrap">
      <div className="embedded-record-bar">
        {mine.length > 1 ? (
          <RecordPicker rows={mine} selectedId={selected.id} label={(r) => r.qtn_no || `Quote ${r.id}`} onSelect={setSelId} />
        ) : (
          <span className="embedded-record-current">
            <span className="rec-doc-label">Quotation No.</span>
            <b className="rec-doc-no">{selected.qtn_no || `Quote ${selected.id}`}</b>
          </span>
        )}
        <button type="button" className="btn primary sm" onClick={() => setAdding(true)}>+ New quotation</button>
      </div>
      <CustomerQuoteDetailModal id={selected.id} onClose={() => { load(); onChanged(); }} onChanged={() => { load(); onChanged(); }} inline />
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
      projectTitle: (r) => r.project_title,
      contactPerson: (r) => r.contact_person || "",
      vessel: (r) => (r.vessel && r.vessel !== "—" ? r.vessel : ""),
      workType: (r) => r.work_type,
      pic: (r) => r.assignee || "",
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
    ...statusColumns<RfqRow>({ level: (r) => r.level || "", status: (r) => r.status || "" }),
  ];

  return (
    <>
      <FilterTable
        tableId="rfq-list"
        rows={rows}
        columns={columns}
        getRowKey={(r) => r.id}
        onRowClick={(r) => setDetailId(r.id)}
        defaultSortKey="project_no"
        defaultSortDir="desc"
        empty="No RFQs registered."
        actions={
          can("rfq", "create") ? (
            <button className="btn primary" onClick={() => setAdding(true)}>
              + New
            </button>
          ) : null
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
      projectTitle: (r) => r.project_title || "",
      contactPerson: (r) => r.contact_person || "",
      vessel: (r) => r.vessel,
      workType: (r) => r.work_type,
      pic: (r) => r.assignee || "",
    }),
    { key: "customer_rfq_no", label: "Customer RFQ No.", text: (r) => r.customer_rfq_no || "" },
    { key: "vendor", label: "Vendor", text: (r) => r.vendor || "", filter: "facet", render: (r) => <VendorName name={r.vendor || ""} /> },
    { key: "vendor_email", label: "Recipient email", text: (r) => r.vendor_email || "" },
    { key: "sent_date", label: "Sent date", text: (r) => r.sent_date || "", filter: "date" },
    { key: "item_count", label: "Items", numeric: true, text: (r) => String(r.item_count), sortValue: (r) => r.item_count },
    { key: "quote_count", label: "Quotes received", numeric: true, text: (r) => `${r.quote_count}`, sortValue: (r) => r.quote_count },
    ...statusColumns<VrfqRow>({ level: (r) => r.level || "", status: (r) => r.status || "" }),
  ];

  if (error) return <div className="state error">API error: {error}</div>;

  const kmarisNo = pickRfqId !== null ? projects.find((p) => p.id === pickRfqId)?.crfq_no ?? "" : "";

  return (
    <>
      <FilterTable
        tableId="vendor-rfq-list"
        rows={rows}
        columns={columns}
        getRowKey={(r) => r.id}
        onRowClick={(r) => { setAutoEdit(true); setDetailId(r.id); }}
        defaultSortKey="project_no"
        defaultSortDir="desc"
        groupBy={(r) => r.rfq_id ?? `row-${r.id}`}
        groupMergeKeys={["project_no", "customer", "project_title", "contact_person", "vessel", "work_type", "trade_type", "customer_rfq_no"]}
        empty="No Vendor RFQs sent."
        actions={
          <button className="btn primary" onClick={() => { setPickRfqId(null); setAdding(true); }}>
            + New
          </button>
        }
      />

      {adding ? (
        <Modal title="Vendor RFQ Sent" onClose={() => setAdding(false)} wide>
          {/* 대상 = 고객 RFQ가 있고 아직 미수주(고객 P/O 전, stage<5)인 프로젝트.
              이미 Vendor RFQ를 보낸 건도 계속 노출 — 여러 벤더에 반복 발송 가능. */}
          <ProjectPicker projects={projects.filter((p) => p.stage >= 1 && p.stage < 5)} rfqId={pickRfqId} onSelect={setPickRfqId} />
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
  inline,
}: {
  id: number;
  vendors: VendorOption[];
  autoEdit?: boolean;
  onClose: () => void;
  onChanged: () => void;
  inline?: boolean;
}) {
  const [d, setD] = useState<VendorRfqDetail | null>(null);
  // 프로젝트 모달 내 임베드(inline)에서는 읽기전용 개요를 건너뛰고 바로 편집 화면으로.
  const [editing, setEditing] = useState(!!autoEdit || !!inline);
  // 편집 권한 = 역할 권한(rfq.edit) × 담당(PIC) 소유권. 없으면 읽기전용(뷰어) 모드.
  const canEditThis = can("rfq", "edit") && canEditDeal(d?.assignee_id);
  const canDeleteThis = can("rfq", "delete") && canEditDeal(d?.assignee_id);
  const showEdit = editing && canEditThis;
  const [vendorId, setVendorId] = useState<number | "">("");
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("");
  const [sentAt, setSentAt] = useState("");
  const [items, setItems] = useState<RfqItem[]>([]);
  // K-Maris RFQ No. — 자동생성 / 직접 입력 토글. 미지정이면 auto 기본.
  const [noMode, setNoMode] = useState<"auto" | "manual">("auto");
  const [manualNo, setManualNo] = useState("");
  const [autoNo, setAutoNo] = useState(""); // 자동채번 미리보기(다음 KMS-RFQ 번호)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 미지정이면 다음 자동채번 번호를 미리 불러와 토글에서 보여준다.
  useEffect(() => {
    const cur = (d?.kmaris_rfq_no || "").trim();
    if (!d || (cur && cur !== "-")) return;
    fetchNextRfqNo().then((r) => setAutoNo(r.rfq_no)).catch(() => setAutoNo(""));
  }, [d?.kmaris_rfq_no, d]);

  useEffect(() => {
    fetchVendorRfqDetail(id)
      .then((data) => {
        setD(data);
        setVendorId(data.vendor_id || "");
        setEmail(data.vendor_email || "");
        setStatus(data.status || "");
        setSentAt(toLocalDt(data.sent_at));
        setItems(data.items || []);
        const cur = (data.kmaris_rfq_no || "").trim();
        const assigned = !!cur && cur !== "-";
        setNoMode(assigned ? "manual" : "auto");
        setManualNo(assigned ? cur : "");
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Error"));
  }, [id]);

  async function loadCustomerRfqItems() {
    if (!d?.rfq_id) return;
    setBusy(true);
    setErr(null);
    try {
      const rfq = await fetchRfqDetail(d.rfq_id);
      setItems(rfq.items || []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load Customer RFQ items");
    } finally {
      setBusy(false);
    }
  }

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
      // K-Maris RFQ No. 배정: manual 은 값이 바뀐 경우만, auto 는 미지정일 때만(오배정 방지).
      if (d?.rfq_id) {
        const cur = (d.kmaris_rfq_no || "").trim();
        const unassigned = !cur || cur === "-";
        if (noMode === "manual" && manualNo.trim() && manualNo.trim() !== cur) {
          await assignRfqNo(d.rfq_id, { mode: "manual", rfq_no: manualNo.trim() });
        } else if (noMode === "auto" && unassigned) {
          await assignRfqNo(d.rfq_id, { mode: "auto" });
        }
      }
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
    <Modal title={d ? <ModalTitle label="Vendor RFQ" projectNo={d.project_no} /> : "Vendor RFQ details"} onClose={onClose} wide inline={inline}>
      {!d ? (
        <div className="state">Loading details…</div>
      ) : (
        <>
          {showEdit ? (
            <>
              {!inline ? (
                <>
                  <div className="form-section-title">Project info</div>
                  <dl className="intl-meta">
                    <BaseMetaRows info={d} />
                    <div><dt>Customer RFQ No.</dt><dd>{d.customer_rfq_no || "—"}</dd></div>
                    <div><dt>K-Maris RFQ No.</dt><dd>{d.kmaris_rfq_no || "—"}</dd></div>
                    <div><dt>Items</dt><dd>{items.length}</dd></div>
                  </dl>
                </>
              ) : null}

              <div className="form-section-title">This vendor send info</div>
              <div className="form-grid">
                <div className="form-field">
                  <label>Vendor</label>
                  <select
                    value={vendorId}
                    onChange={(e) => {
                      const id = e.target.value === "" ? "" : Number(e.target.value);
                      setVendorId(id);
                      // 벤더 선택 시 저장된 해당 벤더 이메일로 자동 변경.
                      const v = vendors.find((x) => x.id === id);
                      if (v) setEmail(v.email || "");
                    }}
                  >
                    <option value="">Select…</option>
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <label>K-Maris RFQ No.</label>
                  {d.kmaris_rfq_no && d.kmaris_rfq_no !== "-" ? (
                    <input value={d.kmaris_rfq_no} disabled />
                  ) : noMode === "auto" ? (
                    <select value="auto" onChange={(e) => { if (e.target.value === "manual") setNoMode("manual"); }}>
                      <option value="auto">{autoNo ? `${autoNo} (auto)` : "Auto-generate"}</option>
                      <option value="manual">Manual entry…</option>
                    </select>
                  ) : (
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input value={manualNo} onChange={(e) => setManualNo(e.target.value)} placeholder="KMS-RFQ-…" autoFocus style={{ flex: 1 }} />
                      <button type="button" className="btn sm" onClick={() => setNoMode("auto")} title="Use auto number">auto</button>
                    </div>
                  )}
                </div>
                <div className="form-field">
                  <label>Recipient email</label>
                  <input value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div className="form-field">
                  <label>Sent at</label>
                  <input type="datetime-local" value={sentAt} onChange={(e) => setSentAt(e.target.value)} />
                </div>
              </div>

              <VendorRfqItemEditor
                items={items}
                onChange={setItems}
                headerActions={
                  d.rfq_id ? (
                    <button className="btn sm" onClick={loadCustomerRfqItems} disabled={busy} title="Load items from the Customer RFQ">
                      Load customer RFQ
                    </button>
                  ) : null
                }
              />
            </>
          ) : (
            <>
              {!inline ? (
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
                </>
              ) : null}

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
            {!canEditThis ? (
              <span className="hint-inline" style={{ marginLeft: "auto" }}>{editBlockReason("rfq", d?.assignee_id)}</span>
            ) : showEdit ? (
              <>
                <button className="btn primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
                <button className="btn" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
              </>
            ) : (
              <button className="btn" onClick={() => setEditing(true)} style={{ marginLeft: "auto" }}>✎ Edit</button>
            )}
            {canDeleteThis ? (
              <button className="btn danger" onClick={remove} disabled={busy || showEdit}>Delete</button>
            ) : null}
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
  headerActions,
}: {
  items: RfqItem[];
  onChange: (items: RfqItem[]) => void;
  // 품목표 헤더의 "+ Add" 옆 보조 액션(예: "Load customer RFQ").
  headerActions?: React.ReactNode;
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
  function add() {
    const last = items[items.length - 1];
    onChange([
      ...items,
      { part_no: "", description: "", qty: 1, unit: last?.unit || "PCS", unit_price: null, amount: null, remark: "" },
    ]);
  }

  return (
    <>
      <div className="items-head">
        <div className="form-section-title">Item list</div>
        <div className="items-head-actions">
          {headerActions}
          <button className="btn sm items-head-add" onClick={add}>+ Add</button>
        </div>
      </div>
      <div className="table-wrap compact item-scroll">
        <table className="mini wide lead-tools">
          <thead>
            <tr>
              <th className="row-tools"></th>
              <th className="seq">No.</th>
              <th>Part No.</th>
              <th>Description</th>
              <th>Qty</th>
              <th>Unit</th>
              <th>Remark</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={7} className="mini-empty">No items (service request).</td>
              </tr>
            ) : (
              items.map((it, i) => (
                <tr key={i} className={itemRowClass(i)}>
                  <td className="row-tools">
                    <button className="row-del" onClick={() => onChange(items.filter((_, idx) => idx !== i))}>×</button>
                  </td>
                  <td className="seq">{i + 1}</td>
                  <td><textarea {...gridCellProps(i, 0)} className="wrapcell" rows={1} value={it.part_no || ""} onChange={(e) => patch(i, "part_no", e.target.value)} /></td>
                  <td><textarea {...gridCellProps(i, 1)} className="desc" rows={1} value={it.description || ""} onChange={(e) => patch(i, "description", e.target.value)} /></td>
                  <td><input {...gridCellProps(i, 2)} className="num" value={amountInputValue(it.qty)} onChange={(e) => patch(i, "qty", e.target.value)} /></td>
                  <td><input {...gridCellProps(i, 3)} value={it.unit || ""} onChange={(e) => patch(i, "unit", e.target.value)} /></td>
                  <td><textarea {...gridCellProps(i, 4)} className="wrapcell" rows={1} value={it.remark ?? ""} onChange={(e) => patch(i, "remark", e.target.value)} /></td>
                </tr>
              ))
            )}
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

  // 딥링크로만 1회 자동 오픈(탭 전환 시 재오픈 방지).
  useEffect(() => {
    if (!autoEditId || rows.length === 0) return;
    const match = rows.find((r) => r.rfq_id === autoEditId);
    if (match) setDetailId(match.id);
    onAutoConsumed?.();
  }, [autoEditId, rows, onAutoConsumed]);

  function load() {
    fetchVendorQuoteOverview()
      .then((d) => setRows(d.rows))
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
      projectTitle: (r) => r.project_title || "",
      contactPerson: (r) => r.contact_person || "",
      vessel: (r) => r.vessel,
      workType: (r) => r.work_type,
      pic: (r) => r.assignee || "",
    }),
    { key: "vendor_quote_no", label: "Vendor quote no.", text: (r) => r.vendor_quote_no || "" },
    {
      key: "received_at",
      label: "Quote received",
      text: (r) => (r.received_at && r.received_at.length >= 16 ? `${r.received_at.slice(2, 10)} ${r.received_at.slice(11, 16)}` : r.received_date || ""),
      filter: "date",
      sortValue: (r) => Date.parse(r.received_at || r.received_date || "") || 0,
    },
    { key: "vendor", label: "Vendor", text: (r) => r.vendor || "", filter: "facet", render: (r) => <VendorName name={r.vendor || ""} /> },
    { key: "item_count", label: "Items", numeric: true, text: (r) => String(r.item_count), sortValue: (r) => r.item_count },
    {
      key: "amount",
      label: "Amount",
      numeric: true,
      text: (r) => dualCurrencyText(r.amount, r.currency),
      render: (r) => <DualCurrencyAmount value={r.amount} currency={r.currency} />,
      sortValue: (r) => r.amount,
    },
    ...statusColumns<VendorQuoteOverviewRow>({ level: (r) => r.level || "", status: (r) => r.status || "" }),
  ];

  if (error) return <div className="state error">API error: {error}</div>;

  return (
    <>
      <FilterTable
        tableId="vendor-quote-list"
        rows={rows}
        columns={columns}
        getRowKey={(r) => r.id}
        onRowClick={(r) => setDetailId(r.id)}
        defaultSortKey="project_no"
        defaultSortDir="desc"
        empty="No Vendor quotes received."
        actions={
          <button className="btn primary" onClick={() => { setPickRfqId(null); setAdding(true); }}>
            + New
          </button>
        }
      />

      {adding ? (
        <Modal title="Register Vendor Quote" onClose={() => setAdding(false)} wide>
          {/* 대상 = Vendor RFQ를 보낸(stage>=2) 미수주 프로젝트. 이미 일부 견적을
              받은 건도 계속 노출 — 여러 벤더에서 추가 견적 수신 가능. */}
          <ProjectPicker projects={projects.filter((p) => p.stage >= 2 && p.stage < 5)} rfqId={pickRfqId} onSelect={setPickRfqId} />
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
        <VendorQuoteDetailModal id={detailId} onClose={() => setDetailId(null)} onChanged={refresh} />
      ) : null}
    </>
  );
}

function VendorQuoteDetailModal({
  id,
  onClose,
  onChanged,
  inline,
}: {
  id: number;
  onClose: () => void;
  onChanged: () => void;
  inline?: boolean;
}) {
  const [d, setD] = useState<VendorQuoteDetail | null>(null);
  const [no, setNo] = useState("");
  const [receivedAt, setReceivedAt] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<VendorQuoteItem[]>([]);
  const [terms, setTerms] = useState<QuotationTerms>({});
  const [parseMsg, setParseMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showOcr, setShowOcr] = useState(false); // Auto-fill 도구 접힘/펼침(1단계와 동일 포맷)
  // 편집 권한 = 역할 권한(rfq.edit) × 담당(PIC) 소유권. 없으면 읽기전용.
  const canEditThis = can("rfq", "edit") && canEditDeal(d?.assignee_id);
  const canDeleteThis = can("rfq", "delete") && canEditDeal(d?.assignee_id);

  useEffect(() => {
    fetchVendorQuoteDetail(id)
      .then((data) => {
        setD(data);
        setNo(data.vendor_quote_no || "");
        setReceivedAt(data.received_at || "");
        setCurrency(data.currency || "USD");
        setNotes(data.notes || "");
        setItems((data.items || []).map(normalizeVendorQuoteItem));
        setTerms(data.terms || {});
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

  // 캡쳐본 붙여넣기(Ctrl+V) → 이미지면 바로 파싱 (편집 권한 없으면 무시)
  function handlePaste(e: React.ClipboardEvent) {
    if (!canEditThis) return;
    const img = imageFromClipboard(e);
    if (img) {
      e.preventDefault();
      parseFile(img);
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
    <Modal title={d ? <ModalTitle label={`Vendor quote — ${d.vendor_quote_no}`} projectNo={d.project_no} /> : "Vendor quote details"} onClose={onClose} wide inline={inline}>
      {!d ? (
        <div className="state">Loading details…</div>
      ) : (
        <div onPaste={handlePaste}>
          {!inline ? (
            <>
              <div className="form-section-title">Project info</div>
              <dl className="intl-meta">
                <BaseMetaRows info={d} />
                <div><dt>Vendor</dt><dd>{d.vendor}</dd></div>
                <div><dt>Items</dt><dd>{items.length}</dd></div>
              </dl>
            </>
          ) : null}

          <fieldset className="form-fieldset" disabled={!canEditThis}>
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
              <span className="ocr-bar-label">📄 Vendor quote auto-fill (PDF·Excel·image)</span>
              <input
                type="file"
                accept=".pdf,.xlsx,.xls,.png,.jpg,.jpeg,.webp,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/*"
                disabled={busy}
                onChange={(e) => parseFile(e.target.files?.[0] ?? null)}
              />
              {busy ? (
                <span className="hint-inline">Analyzing…</span>
              ) : parseMsg ? (
                <span className="action-ok">{parseMsg}</span>
              ) : (
                <span className="hint-inline">Upload a file or paste a screenshot with Ctrl+V → auto-fill</span>
              )}
            </div>
          ) : null}
          <VendorQuoteItemEditor
            items={items}
            onChange={setItems}
            currency={currency}
            headerActions={
              <button className="btn sm" onClick={loadVendorRfqItems} disabled={busy}>
                Load Vendor RFQ items
              </button>
            }
          />
          <QuotationTermsEditor terms={terms} onChange={setTerms} />
          </fieldset>
          <div className="form-actions">
            <StageTotal
              label="Total"
              value={items.reduce((s, it) => s + Number(it.cost_price || 0) * Number(it.qty || 1), 0)}
              currency={currency}
            />
            {!canEditThis ? (
              <span className="hint-inline" style={{ marginRight: "auto" }}>{editBlockReason("rfq", d?.assignee_id)}</span>
            ) : null}
            {canDeleteThis ? (
              <button className="btn danger" onClick={remove} disabled={busy} style={{ marginRight: "auto" }}>Delete</button>
            ) : null}
            {canEditThis ? (
              <button className="btn primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
            ) : null}
            <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          </div>
          {err ? <span className="action-err">{err}</span> : null}
        </div>
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

  // 딥링크로만 1회 자동 오픈(탭 전환 시 재오픈 방지).
  useEffect(() => {
    if (!autoEditId || rows.length === 0) return;
    const match = rows.find((r) => r.rfq_id === autoEditId);
    if (match) setDetailId(match.id);
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
      projectTitle: (r) => r.project_title || "",
      contactPerson: (r) => r.contact_person || "",
      vessel: (r) => r.vessel,
      workType: (r) => r.work_type,
      pic: (r) => r.assignee || "",
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
    { key: "valid_until", label: "Valid until", text: (r) => r.valid_until || "", filter: "date" },
    ...statusColumns<QtnRow>({ level: (r) => r.level || "", status: (r) => r.status || "" }),
  ];

  if (error) return <div className="state error">API error: {error}</div>;

  return (
    <>
      <FilterTable
        tableId="quotation-list"
        rows={rows}
        columns={columns}
        getRowKey={(r) => r.id}
        onRowClick={(r) => setDetailId(r.id)}
        defaultSortKey="project_no"
        defaultSortDir="desc"
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
        <CustomerQuoteDetailModal id={detailId} onClose={() => setDetailId(null)} onChanged={refresh} />
      ) : null}
    </>
  );
}

function CustomerQuoteDetailModal({
  id,
  onClose,
  onChanged,
  inline,
}: {
  id: number;
  onClose: () => void;
  onChanged: () => void;
  inline?: boolean;
}) {
  const [d, setD] = useState<CustomerQuotationDetail | null>(null);
  const [qtnNo, setQtnNo] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [costCurrency, setCostCurrency] = useState("USD");
  const [roundDigits, setRoundDigits] = useState<number>(DEFAULT_ROUND_DIGITS);
  const [discountPct, setDiscountPct] = useState<number>(0);
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
  // 편집 권한 = 역할 권한(rfq.edit) × 담당(PIC) 소유권. 없으면 읽기전용.
  const canEditThis = can("rfq", "edit") && canEditDeal(d?.assignee_id);
  const canDeleteThis = can("rfq", "delete") && canEditDeal(d?.assignee_id);

  useEffect(() => {
    fetchCustomerQuotationDetail(id)
      .then((data) => {
        setD(data);
        setQtnNo(data.qtn_no || "");
        setCurrency(data.currency || "USD");
        setCostCurrency(data.cost_currency || data.currency || "USD");
        setRoundDigits(
          typeof data.round_digits === "number" ? data.round_digits : DEFAULT_ROUND_DIGITS
        );
        setDiscountPct(Number(data.discount_pct || 0));
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
  const finalTotal = total * (1 - Number(discountPct || 0) / 100);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await updateCustomerQuotation(id, {
        qtn_no: qtnNo,
        currency,
        cost_currency: costCurrency,
        round_digits: roundDigits,
        discount_pct: discountPct,
        sent_at: sentAt,
        valid_until: validUntil,
        status,
        terms,
        items,
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
    // 원가 통화 = 공급사 견적 통화. 판매 통화(currency)는 사용자가 정한 값을 유지하고
    // 단가는 판매 통화로 환산해 계산한다.
    setItems(customerQuoteItemsFromVendorQuote(vq, defaultMargin, currency, roundDigits));
    if (vq.currency) setCostCurrency(vq.currency);
    setTerms((prev) => mergeTermsFromVendorQuote(prev, vq.terms));
    setMsg(`Loaded ${vq.items.length} item(s) from quote ${vq.vendor_quote_no} (${vq.vendor}).`);
  }

  const STATUSES = ["초안", "발송완료", "협상중", "수주확정", "실주", "만료"];

  return (
    <Modal title={d ? <ModalTitle label={`Quotation — ${d.qtn_no}`} projectNo={d.project_no} /> : "Quotation details"} onClose={onClose} wide inline={inline}>
      {!d ? (
        <div className="state">Loading details…</div>
      ) : (
        <>
          {!inline ? (
            <>
              <div className="form-section-title">Project info</div>
              <dl className="intl-meta">
                <BaseMetaRows info={d} />
                <div><dt>RFQ No.</dt><dd>{d.rfq_no || "—"}</dd></div>
                <div><dt>Items</dt><dd>{items.length}</dd></div>
              </dl>
            </>
          ) : null}

          <fieldset className="form-fieldset" disabled={!canEditThis}>
          <div className="form-section-title">Quotation info</div>
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
              <button
                className="btn"
                onClick={() => setItems((prev) => applyMarginToAll(prev, defaultMargin, costCurrency, currency, roundDigits))}
                disabled={items.length === 0}
              >
                Apply margin to all
              </button>
            </div>
          </div>

          <div className="form-grid">
            <div className="form-field">
              <label>Quotation No.</label>
              <input value={qtnNo} onChange={(e) => setQtnNo(e.target.value)} placeholder="KMS-QUO-2606-001" />
            </div>
            <div className="form-field">
              <label>Cost currency (vendor)</label>
              <CurrencyToggle
                value={costCurrency}
                onChange={(c) => { setCostCurrency(c); setItems((prev) => recomputeCustomerQuoteItems(prev, c, currency, roundDigits)); }}
              />
            </div>
            <div className="form-field">
              <label>Sale currency (unit price)</label>
              <CurrencyToggle
                value={currency}
                onChange={(c) => { setCurrency(c); setItems((prev) => recomputeCustomerQuoteItems(prev, costCurrency, c, roundDigits)); }}
              />
            </div>
            <div className="form-field">
              <label>Round unit price up to</label>
              <RoundUnitSelect
                value={roundDigits}
                onChange={(d) => { setRoundDigits(d); setItems((prev) => recomputeCustomerQuoteItems(prev, costCurrency, currency, d)); }}
              />
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
          <CustomerQuoteItemEditor
            items={items}
            onChange={setItems}
            currency={currency}
            costCurrency={costCurrency}
            roundDigits={roundDigits}
            headerActions={
              <button className="btn sm" onClick={importFromVendorQuote} disabled={importVqId === ""}>
                Load Vendor quote
              </button>
            }
          />
          <DiscountSummary
            subtotal={total}
            discountPct={discountPct}
            onDiscountChange={setDiscountPct}
            currency={currency}
          />
          <QuotationTermsEditor terms={terms} onChange={setTerms} />
          </fieldset>
          <div className="form-actions">
            <StageTotal label="Final" value={finalTotal} currency={currency} />
            {!canEditThis ? (
              <span className="hint-inline" style={{ marginRight: "auto" }}>{editBlockReason("rfq", d?.assignee_id)}</span>
            ) : null}
            {canDeleteThis ? (
              <button className="btn danger" onClick={remove} disabled={busy} style={{ marginRight: "auto" }}>Delete</button>
            ) : null}
            {canEditThis ? (
              <button className="btn primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
            ) : null}
            <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          </div>
          {msg ? <span className="action-ok">{msg}</span> : null}
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
  // 선택한 프로젝트(Customer RFQ)의 품목 — 벤더에게 보낼 품목을 편집한다(행 삭제로 제외).
  const [rfqItems, setRfqItems] = useState<RfqItem[]>([]);
  // 케이마리스 RFQ No.는 이 단계(Vendor RFQ 발신)에서 부여된다.
  const unassigned = !kmarisNo || kmarisNo === "Not issued" || kmarisNo === "-";
  const [noMode, setNoMode] = useState<"auto" | "manual">("auto");
  const [manualNo, setManualNo] = useState("");
  const [autoNo, setAutoNo] = useState(""); // 자동채번 미리보기(다음 KMS-RFQ 번호)
  // manual 은 빈값이어도 명시적으로 manual 로 보내 백엔드 기본값(auto)으로 새지 않게 한다
  // (manual+빈값 = 아직 미지정 유지, auto = 자동채번).
  const rfqNoArg = unassigned
    ? noMode === "manual"
      ? { mode: "manual" as const, value: manualNo.trim() }
      : { mode: "auto" as const, value: "" }
    : undefined;
  const [sentAt, setSentAt] = useState(nowLocalDt());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // 프로젝트 선택 시 해당 Customer RFQ의 품목 목록을 불러온다(수동 재적재 가능).
  useEffect(() => {
    if (!rfqId) {
      setRfqItems([]);
      return;
    }
    let alive = true;
    fetchRfqDetail(rfqId)
      .then((d) => { if (alive) setRfqItems(d.items || []); })
      .catch(() => { if (alive) setRfqItems([]); });
    return () => { alive = false; };
  }, [rfqId]);

  // 미지정이면 다음 자동채번 번호를 미리 불러와 토글에서 보여준다.
  useEffect(() => {
    if (!unassigned) return;
    let alive = true;
    fetchNextRfqNo().then((r) => { if (alive) setAutoNo(r.rfq_no); }).catch(() => undefined);
    return () => { alive = false; };
  }, [unassigned]);

  // "Load customer RFQ" — Customer RFQ 품목으로 다시 채운다(편집·삭제 후 원복용).
  function loadCustomerRfqItems() {
    if (!rfqId) return;
    fetchRfqDetail(rfqId)
      .then((d) => setRfqItems(d.items || []))
      .catch(() => undefined);
  }

  // 실제 내용이 있는 품목만 벤더에게 보낸다(행을 삭제해 제외).
  const effectiveItems = rfqItems
    .map(({ part_no, description, qty, unit, remark }) => ({
      part_no: part_no || "",
      description: description || "",
      qty: qty || 0,
      unit: unit || "",
      remark: remark || "",
    }))
    .filter((it) => it.part_no || it.description || it.qty);

  function patchItem(i: number, key: keyof RfqItem, value: string) {
    setRfqItems((prev) =>
      prev.map((it, idx) =>
        idx === i ? { ...it, [key]: key === "qty" ? parseAmountInput(value) || 0 : value } : it
      )
    );
  }
  function addItem() {
    setRfqItems((prev) => [
      ...prev,
      { part_no: "", description: "", qty: 1, unit: "", unit_price: null, amount: null, remark: "" },
    ]);
  }
  function removeItem(i: number) {
    setRfqItems((prev) => prev.filter((_, idx) => idx !== i));
  }

  function toggleVendor(id: number) {
    setVendorIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  // RFQ 생성 — 케이마리스 RFQ No. 단독 발번(자동생성 / 직접 입력)
  async function generateRfqNo() {
    if (noMode === "manual" && !manualNo.trim()) {
      setErr("Enter the K-Maris RFQ No. or switch to Auto-generate.");
      return;
    }
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await assignRfqNo(
        rfqId,
        noMode === "manual" ? { mode: "manual", rfq_no: manualNo.trim() } : { mode: "auto" }
      );
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
      const r = await previewVendorRfq(rfqId, vendorIds, lang, notes, rfqNoArg, effectiveItems);
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
    // POST 로 선택·편집한 품목을 함께 보내 XLSX 양식에 반영한다.
    const res = await fetch(vendorRfqXlsxUrl(rfqId, p.vendor_id), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items: effectiveItems }),
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
      const r = await sendVendorRfq(rfqId, items, rfqNoArg, sentAt || undefined, effectiveItems);
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

      <div className="form-field">
        <label>K-Maris RFQ No.</label>
        {unassigned ? (
          noMode === "auto" ? (
            <select value="auto" onChange={(e) => { if (e.target.value === "manual") setNoMode("manual"); }} style={{ maxWidth: 320 }}>
              <option value="auto">{autoNo ? `${autoNo} (auto)` : "Auto-generate"}</option>
              <option value="manual">Manual entry…</option>
            </select>
          ) : (
            <div style={{ display: "flex", gap: 6, alignItems: "center", maxWidth: 320 }}>
              <input value={manualNo} onChange={(e) => setManualNo(e.target.value)} placeholder="KMS-RFQ-…" autoFocus style={{ flex: 1 }} />
              <button type="button" className="btn sm" onClick={() => setNoMode("auto")} title="Use auto number">auto</button>
            </div>
          )
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
      {rfqId ? (
        <>
          <div className="items-head">
            <div className="form-section-title">Item list</div>
            <div className="items-head-actions">
              <button className="btn sm" onClick={loadCustomerRfqItems}>Load customer RFQ</button>
              <button className="btn sm items-head-add" onClick={addItem}>+ Add</button>
            </div>
          </div>
          <div className="table-wrap compact item-scroll">
            <table className="mini wide lead-tools">
              <thead>
                <tr>
                  <th className="row-tools"></th>
                  <th className="seq">No.</th>
                  <th>Part No.</th>
                  <th>Description</th>
                  <th>Qty</th>
                  <th>Unit</th>
                  <th>Remark</th>
                </tr>
              </thead>
              <tbody>
                {rfqItems.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="mini-empty">No items (service request).</td>
                  </tr>
                ) : (
                  rfqItems.map((it, i) => (
                    <tr key={i} className={itemRowClass(i)}>
                      <td className="row-tools">
                        <button className="row-del" title="Remove row" onClick={() => removeItem(i)}>×</button>
                      </td>
                      <td className="seq">{i + 1}</td>
                      <td><textarea {...gridCellProps(i, 0)} className="wrapcell" rows={1} value={it.part_no || ""} onChange={(e) => patchItem(i, "part_no", e.target.value)} /></td>
                      <td><textarea {...gridCellProps(i, 1)} className="desc" rows={1} value={it.description || ""} onChange={(e) => patchItem(i, "description", e.target.value)} /></td>
                      <td><input {...gridCellProps(i, 2)} className="num" value={amountInputValue(it.qty)} onChange={(e) => patchItem(i, "qty", e.target.value)} /></td>
                      <td><input {...gridCellProps(i, 3)} value={it.unit || ""} onChange={(e) => patchItem(i, "unit", e.target.value)} /></td>
                      <td><textarea {...gridCellProps(i, 4)} className="wrapcell" rows={1} value={it.remark ?? ""} onChange={(e) => patchItem(i, "remark", e.target.value)} /></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

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
  const [terms, setTerms] = useState<QuotationTerms>({});
  const [parseMsg, setParseMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showOcr, setShowOcr] = useState(false); // Auto-fill 도구 접힘/펼침(1단계와 동일 포맷)

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

  // 캡쳐본 붙여넣기(Ctrl+V) → 이미지면 바로 파싱
  function handlePaste(e: React.ClipboardEvent) {
    const img = imageFromClipboard(e);
    if (img) {
      e.preventDefault();
      parseFile(img);
    }
  }

  // "Load Vendor RFQ" — 선택한 Vendor RFQ에 보낸 품목을 그대로 불러와 단가만 입력하게 한다.
  async function loadVendorRfqItems() {
    if (vrfqId === "") return;
    const hasData = items.some((it) => it.part_no || it.description || Number(it.qty) || Number(it.cost_price));
    if (hasData && !confirm("Replace the current items with the selected Vendor RFQ items?")) return;
    setBusy(true);
    setErr(null);
    setParseMsg(null);
    try {
      const d = await fetchVendorRfqDetail(vrfqId);
      const loaded: VendorQuoteItem[] = (d.items || [])
        .filter((it) => it.part_no || it.description || it.qty)
        .map((it) => ({
          part_no: it.part_no || "",
          description: it.description || "",
          maker: "",
          origin: "",
          qty: it.qty || 1,
          unit: it.unit || "PCS",
          cost_price: null,
          lead_time: "",
          remark: it.remark || "",
        }));
      setItems(loaded);
      setParseMsg(
        loaded.length
          ? `Loaded ${loaded.length} item(s) from Vendor RFQ — enter unit prices`
          : "The selected Vendor RFQ has no items."
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load Vendor RFQ items");
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
        notes,
        terms
      );
      setMsg(`Registered — ${r.vendor_quote_no}`);
      setNo("");
      setCurrency("USD");
      setNotes("");
      setItems([]);
      setTerms({});
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
    <div onPaste={handlePaste}>
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
              <span className="ocr-bar-label">📄 Vendor quote auto-fill (PDF·Excel·image)</span>
              <input
                type="file"
                accept=".pdf,.xlsx,.xls,.png,.jpg,.jpeg,.webp,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/*"
                disabled={busy || vrfqId === ""}
                onChange={(e) => parseFile(e.target.files?.[0] ?? null)}
              />
              {busy ? (
                <span className="hint-inline">Analyzing…</span>
              ) : parseMsg ? (
                <span className="action-ok">{parseMsg}</span>
              ) : (
                <span className="hint-inline">Select a Vendor RFQ, then upload a file or paste with Ctrl+V → auto-fill</span>
              )}
            </div>
          ) : null}

          <VendorQuoteItemEditor
            items={items}
            onChange={setItems}
            currency={currency}
            headerActions={
              <button
                type="button"
                className="btn sm"
                onClick={loadVendorRfqItems}
                disabled={busy || vrfqId === ""}
                title={vrfqId === "" ? "Select a Vendor RFQ first" : "Load items from the selected Vendor RFQ"}
              >
                Load Vendor RFQ
              </button>
            }
          />

          <QuotationTermsEditor terms={terms} onChange={setTerms} />

          <div className="form-field" style={{ marginTop: 12 }}>
            <label>Notes</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          <div className="form-actions">
            <StageTotal
              label="Total"
              value={items.reduce((s, it) => s + Number(it.cost_price || 0) * Number(it.qty || 1), 0)}
              currency={currency}
            />
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
  headerActions,
}: {
  items: VendorQuoteItem[];
  onChange: (items: VendorQuoteItem[]) => void;
  currency?: string;
  // 품목표 헤더의 "+ Add" 옆 보조 액션(예: "Load Vendor RFQ items").
  headerActions?: React.ReactNode;
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
      <div className="items-head">
        <div className="sub-h">Item list</div>
        <div className="items-head-actions">
          {headerActions}
          <button className="btn sm items-head-add" onClick={add}>+ Add</button>
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
              <th>Origin</th>
              <th className="num">Qty</th>
              <th>Unit</th>
              <th className="num">Unit Price</th>
              <th className="num">Amount</th>
              <th>Lead Time</th>
              <th>Remark</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i} className={itemRowClass(i)}>
                <td className="row-tools">
                  <button className="row-del" disabled={items.length === 1} onClick={() => onChange(items.filter((_, idx) => idx !== i))}>×</button>
                </td>
                <td className="seq">{i + 1}</td>
                <td><textarea {...gridCellProps(i, 0)} className="wrapcell" rows={1} value={it.part_no} onChange={(e) => patch(i, "part_no", e.target.value)} /></td>
                <td><textarea {...gridCellProps(i, 1)} className="desc" rows={1} value={it.description} onChange={(e) => patch(i, "description", e.target.value)} /></td>
                <td><textarea {...gridCellProps(i, 2)} className="wrapcell" rows={1} value={it.maker ?? ""} onChange={(e) => patch(i, "maker", e.target.value)} /></td>
                <td><textarea {...gridCellProps(i, 3)} className="wrapcell" rows={1} value={it.origin ?? ""} onChange={(e) => patch(i, "origin", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 4)} className="num" value={amountInputValue(it.qty)} onChange={(e) => patch(i, "qty", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 5)} value={it.unit} onChange={(e) => patch(i, "unit", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 6)} className="num" value={amountInputValue(it.cost_price)} onChange={(e) => patch(i, "cost_price", e.target.value)} /></td>
                <td className="num">{amountInputValue(Number(it.cost_price || 0) * Number(it.qty || 1))}</td>
                <td><textarea {...gridCellProps(i, 7)} className="wrapcell" rows={1} value={it.lead_time ?? ""} onChange={(e) => patch(i, "lead_time", e.target.value)} /></td>
                <td><textarea {...gridCellProps(i, 8)} className="wrapcell" rows={1} value={it.remark ?? ""} onChange={(e) => patch(i, "remark", e.target.value)} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={9} className="total-label">Total</td>
              <td className="num total-value">
                <DualCurrencyAmount value={total} currency={currency} />
                <span className="fx-note">{fxRateText()}</span>
              </td>
              <td colSpan={2}></td>
            </tr>
          </tfoot>
        </table>
      </div>
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

// 공급사 견적의 거래조건을 고객 견적으로 병합 — 값이 있는 항목만 덮어써
// 사용자가 이미 입력한 조건을 빈 값으로 지우지 않는다.
function mergeTermsFromVendorQuote(
  prev: QuotationTerms,
  vqTerms?: QuotationTerms
): QuotationTerms {
  if (!vqTerms) return prev;
  const next = { ...prev };
  (Object.keys(vqTerms) as (keyof QuotationTerms)[]).forEach((k) => {
    const v = vqTerms[k];
    if (v != null && String(v).trim() !== "") next[k] = v;
  });
  return next;
}

function customerQuoteItemsFromVendorQuote(
  vq: VendorQuoteForImport,
  defaultMargin: number,
  saleCurrency = "USD",
  roundDigits: number = DEFAULT_ROUND_DIGITS
): CustomerQuoteItem[] {
  // 원가는 공급사 견적 통화(vq.currency), 단가는 판매 통화 기준으로 환산해 계산.
  return vq.items.map((it) => {
    const cost = Number(it.cost_price ?? 0);
    const unit = calcUnitPrice(cost, defaultMargin, vq.currency, saleCurrency, roundDigits);
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
      lead_time: it.lead_time ?? "",
      remark: it.remark ?? "",
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
  onCancel,
}: {
  rfqId: number;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [qtnNo, setQtnNo] = useState("");
  // Quotation No. 채번 방식: auto(자동 KMS-QUO-yymm-nnn) / manual(직접 입력).
  const [noMode, setNoMode] = useState<"auto" | "manual">("auto");
  const [autoNo, setAutoNo] = useState(""); // 자동채번 미리보기(다음 KMS-QUO 번호)
  const [currency, setCurrency] = useState("USD");
  const [costCurrency, setCostCurrency] = useState("USD");
  const [roundDigits, setRoundDigits] = useState<number>(DEFAULT_ROUND_DIGITS);
  const [discountPct, setDiscountPct] = useState<number>(0);
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

  // 자동채번 미리보기(다음 Quotation No.) 로드.
  useEffect(() => {
    fetchNextQuotationNo().then((r) => setAutoNo(r.qtn_no)).catch(() => setAutoNo(""));
  }, []);

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
    // 원가 통화 = 공급사 견적 통화. 판매 통화(currency)는 사용자 선택값을 유지.
    setItems(customerQuoteItemsFromVendorQuote(vq, defaultMargin, currency, roundDigits));
    if (vq.currency) setCostCurrency(vq.currency);
    setTerms((prev) => mergeTermsFromVendorQuote(prev, vq.terms));
    setMsg(`Loaded ${vq.items.length} item(s) from quote ${vq.vendor_quote_no} (${vq.vendor}).`);
  }

  const total = items.reduce((sum, it) => sum + Number(it.amount || 0), 0);
  const finalTotal = total * (1 - Number(discountPct || 0) / 100);

  async function submit() {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await createCustomerQuote(rfqId, currency, finalTotal, items, validUntil, undefined, terms, qtnNo, sentAt, costCurrency, roundDigits, discountPct);
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
          <button
            className="btn"
            onClick={() => setItems((prev) => applyMarginToAll(prev, defaultMargin, costCurrency, currency, roundDigits))}
            disabled={items.length === 0}
          >
            Apply
          </button>
        </div>
      </div>

      <div className="form-grid">
        <div className="form-field">
          <label>Quotation No.</label>
          {noMode === "auto" ? (
            <select
              value="auto"
              onChange={(e) => { if (e.target.value === "manual") { setNoMode("manual"); setQtnNo(""); } }}
            >
              <option value="auto">{autoNo ? `${autoNo} (auto)` : "Auto-generate"}</option>
              <option value="manual">Manual entry…</option>
            </select>
          ) : (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input value={qtnNo} onChange={(e) => setQtnNo(e.target.value)} placeholder="KMS-QUO-…" autoFocus style={{ flex: 1 }} />
              <button type="button" className="btn sm" onClick={() => { setNoMode("auto"); setQtnNo(""); }} title="Use auto number">auto</button>
            </div>
          )}
        </div>
        <div className="form-field">
          <label>Cost currency (vendor)</label>
          <CurrencyToggle
            value={costCurrency}
            onChange={(c) => { setCostCurrency(c); setItems((prev) => recomputeCustomerQuoteItems(prev, c, currency, roundDigits)); }}
          />
        </div>
        <div className="form-field">
          <label>Sale currency (unit price)</label>
          <CurrencyToggle
            value={currency}
            onChange={(c) => { setCurrency(c); setItems((prev) => recomputeCustomerQuoteItems(prev, costCurrency, c, roundDigits)); }}
          />
        </div>
        <div className="form-field">
          <label>Round unit price up to</label>
          <RoundUnitSelect
            value={roundDigits}
            onChange={(d) => { setRoundDigits(d); setItems((prev) => recomputeCustomerQuoteItems(prev, costCurrency, currency, d)); }}
          />
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

      <CustomerQuoteItemEditor
        items={items}
        onChange={setItems}
        currency={currency}
        costCurrency={costCurrency}
        roundDigits={roundDigits}
        headerActions={
          <button className="btn sm" onClick={importFromVendorQuote} disabled={importVqId === ""}>
            Load Vendor quote
          </button>
        }
      />

      <DiscountSummary
        subtotal={total}
        discountPct={discountPct}
        onDiscountChange={setDiscountPct}
        currency={currency}
      />

      <QuotationTermsEditor terms={terms} onChange={setTerms} />

      <div className="form-actions">
        <StageTotal label="Final" value={finalTotal} currency={currency} />
        <button
          className="btn danger"
          disabled
          title="No saved quotation to delete yet"
          style={{ marginRight: "auto" }}
        >
          Delete
        </button>
        <button className="btn primary" onClick={submit} disabled={busy || items.length === 0}>
          {busy ? "Saving…" : "Save"}
        </button>
        {onCancel ? (
          <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        ) : null}
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
        <textarea
          rows={3}
          style={{ minHeight: 72 }}
          value={terms.remarks ?? ""}
          onChange={(e) => onChange({ ...terms, remarks: e.target.value })}
        />
      </div>
    </div>
  );
}

function CustomerQuoteItemEditor({
  items,
  onChange,
  currency = "USD",
  costCurrency = "USD",
  roundDigits = DEFAULT_ROUND_DIGITS,
  headerActions,
}: {
  items: CustomerQuoteItem[];
  onChange: (items: CustomerQuoteItem[]) => void;
  currency?: string;
  costCurrency?: string;
  roundDigits?: number;
  // 품목표 헤더의 "+ Add" 옆 보조 액션(예: "Load Vendor quote").
  headerActions?: React.ReactNode;
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
          const unit = calcUnitPrice(Number(next.cost_price || 0), Number(next.margin_pct || 0), costCurrency, currency, roundDigits);
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
  // 새 품목은 마지막 행의 단위·마진을 이어받아 견적 기준과 맞춘다.
  function add() {
    const last = items[items.length - 1];
    onChange([
      ...items,
      {
        part_no: "",
        description: "",
        qty: 1,
        unit: last?.unit || "PCS",
        cost_price: 0,
        margin_pct: last?.margin_pct ?? 0,
        unit_price: 0,
        amount: 0,
        lead_time: "",
        remark: "",
      },
    ]);
  }
  const costCur = (costCurrency || "USD").toUpperCase();
  const saleCur = (currency || "USD").toUpperCase();
  const total = items.reduce((sum, it) => sum + Number(it.amount || 0), 0);

  return (
    <div style={{ marginTop: 12 }}>
      <div className="items-head">
        <div className="sub-h">Item list</div>
        <div className="items-head-actions">
          {headerActions}
          <button className="btn sm items-head-add" onClick={add}>+ Add</button>
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
              <th className="num">Qty</th>
              <th>Unit</th>
              <th className="num">Cost ({costCur})</th>
              <th className="num">Margin %</th>
              <th className="num">Unit Price ({saleCur})</th>
              <th className="num">Amount ({saleCur})</th>
              <th>Lead Time</th>
              <th>Remark</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i} className={itemRowClass(i)}>
                <td className="row-tools">
                  <button className="row-del" disabled={items.length === 1} onClick={() => onChange(items.filter((_, idx) => idx !== i))}>×</button>
                </td>
                <td className="seq">{i + 1}</td>
                <td><textarea {...gridCellProps(i, 0)} className="wrapcell" rows={1} value={it.part_no} onChange={(e) => patch(i, "part_no", e.target.value)} /></td>
                <td><textarea {...gridCellProps(i, 1)} className="desc" rows={1} value={it.description} onChange={(e) => patch(i, "description", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 2)} className="num" value={amountInputValue(it.qty)} onChange={(e) => patch(i, "qty", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 3)} value={it.unit} onChange={(e) => patch(i, "unit", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 4)} className="num" value={amountInputValue(it.cost_price)} onChange={(e) => patch(i, "cost_price", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 5)} className="num" value={amountInputValue(it.margin_pct)} onChange={(e) => patch(i, "margin_pct", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 6)} className="num" value={amountInputValue(it.unit_price)} onChange={(e) => patch(i, "unit_price", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 7)} className="num" value={amountInputValue(it.amount)} onChange={(e) => patch(i, "amount", e.target.value)} /></td>
                <td><textarea {...gridCellProps(i, 8)} className="wrapcell" rows={1} value={it.lead_time ?? ""} onChange={(e) => patch(i, "lead_time", e.target.value)} /></td>
                <td><textarea {...gridCellProps(i, 9)} className="wrapcell" rows={1} value={it.remark ?? ""} onChange={(e) => patch(i, "remark", e.target.value)} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={9} className="total-label">Total</td>
              <td className="num total-value">
                <DualCurrencyAmount value={total} currency={currency} />
                <span className="fx-note">{fxRateText()}</span>
              </td>
              <td colSpan={2}></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// 소계 · 할인율 입력 · 최종금액 요약. 할인율은 견적 총액(소계)에 적용된다.
function DiscountSummary({
  subtotal,
  discountPct,
  onDiscountChange,
  currency = "USD",
}: {
  subtotal: number;
  discountPct: number;
  onDiscountChange: (v: number) => void;
  currency?: string;
}) {
  const discountAmt = subtotal * (Number(discountPct || 0) / 100);
  const finalTotal = subtotal - discountAmt;
  return (
    <div className="form-grid" style={{ marginTop: 12 }}>
      <div className="form-field">
        <label>Subtotal</label>
        <div className="static-value"><DualCurrencyAmount value={subtotal} currency={currency} /></div>
      </div>
      <div className="form-field">
        <label>Discount (%)</label>
        <input
          className="num"
          type="number"
          value={discountPct}
          onChange={(e) => onDiscountChange(Number(e.target.value) || 0)}
        />
      </div>
      <div className="form-field">
        <label>Discount amount</label>
        <div className="static-value">- {dualCurrencyText(discountAmt, currency)}</div>
      </div>
      <div className="form-field">
        <label>Final total</label>
        <div className="static-value"><b><DualCurrencyAmount value={finalTotal} currency={currency} /></b></div>
      </div>
    </div>
  );
}

// 자릿수(ROUNDUP num_digits) 기본값 — 엑셀 템플릿과 동일하게 1,000단위 올림.
const DEFAULT_ROUND_DIGITS = -3;

// 단가 = ROUNDUP( (원가를 판매통화로 환산) / (1 - 마진%), roundDigits ).
// 엑셀 =ROUNDUP(cost/(1-markup), -3) 방식(판매가 기준 마진). costCur/saleCur 로 환율 적용.
function calcUnitPrice(
  cost: number,
  marginPct: number,
  costCur?: string,
  saleCur?: string,
  roundDigits: number = DEFAULT_ROUND_DIGITS
) {
  const converted = convertCurrency(cost, costCur, saleCur);
  const denom = 1 - Number(marginPct || 0) / 100;
  const priced = denom > 0 ? converted / denom : converted;
  return roundUp(priced, roundDigits);
}

// 단가 올림 단위 선택지 — 값은 Excel ROUNDUP 의 num_digits.
const ROUND_DIGIT_OPTIONS: { value: number; label: string }[] = [
  { value: -3, label: "1,000" },
  { value: -2, label: "100" },
  { value: -1, label: "10" },
  { value: 0, label: "1" },
  { value: 2, label: "0.01" },
];

function RoundUnitSelect({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <select className="currency-select" value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {ROUND_DIGIT_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

// 모든 품목 마진을 지정값으로 통일하고 단가·금액을 재계산.
function applyMarginToAll(
  items: CustomerQuoteItem[],
  marginPct: number,
  costCur: string,
  saleCur: string,
  roundDigits: number
): CustomerQuoteItem[] {
  return items.map((it) => {
    const unit = calcUnitPrice(Number(it.cost_price || 0), marginPct, costCur, saleCur, roundDigits);
    return { ...it, margin_pct: marginPct, unit_price: unit, amount: unit * Number(it.qty || 1) };
  });
}

// 통화·자릿수·마진 변경 시 단가·금액을 판매통화 기준으로 재환산.
function recomputeCustomerQuoteItems(
  items: CustomerQuoteItem[],
  costCur: string,
  saleCur: string,
  roundDigits: number = DEFAULT_ROUND_DIGITS
): CustomerQuoteItem[] {
  return items.map((it) => {
    const unit = calcUnitPrice(Number(it.cost_price || 0), Number(it.margin_pct || 0), costCur, saleCur, roundDigits);
    return { ...it, unit_price: unit, amount: unit * Number(it.qty || 1) };
  });
}
