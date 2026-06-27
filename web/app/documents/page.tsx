"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  documentDownloadUrl,
  fetchDocumentDetail,
  saveCommercialInvoice,
  savePackingList,
  saveShippingAdvice,
  saveTaxInvoice,
  sendShippingAdvice,
  updateDocumentMilestone,
  uploadPod,
  podDownloadUrl,
  deletePod,
  completeOrderStage,
  addRfqStageNote,
} from "@/lib/api";
import { getToken } from "@/lib/auth";
import type { DocRow, DocumentDetail, DocumentWorkItem } from "@/lib/types";
import { fetchDocumentsOverview } from "@/lib/api";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import AppShell, { SectionHead } from "@/components/AppShell";
import FilterTable, { ColumnDef } from "@/components/common/FilterTable";
import Modal from "@/components/common/Modal";

const today = () => new Date().toISOString().slice(0, 10);

// 목록은 진행현황(내부확인용) 통합 목록으로 이전됨. 이 화면은 문서(CI/PL/SA/Tax) 작업
// 전용이며, 대상 오더는 진행현황의 "문서 작업"으로 넘어온 ?order=<id> 로 선택된다.
export default function DocumentsPage() {
  return (
    <AppShell active="documents" wide>
      <SectionHead title="Documents" sub="Create & send CI · PL · SA · Tax per order" />
      <Suspense fallback={<div className="state">Loading…</div>}>
        <DocumentsOverview />
      </Suspense>
    </AppShell>
  );
}

type StageTab = "s7" | "s8" | "s9" | "s10";
type WorkView = "parts" | "service";
const STAGE_KEYS: StageTab[] = ["s7", "s8", "s9", "s10"];
// 업무유형(부품공급/서비스)에 따라 7~9단계 명칭이 달라진다(10은 공통).
const STAGE_LABELS: Record<WorkView, Record<StageTab, string>> = {
  parts: {
    s7: "7. Delivery Readiness",
    s8: "8. Delivery arrangement",
    s9: "9. Delivery Complete · POD",
    s10: "10. Tax Invoice · Billing",
  },
  service: {
    s7: "7. Service Readiness",
    s8: "8. Service Arrangement",
    s9: "9. Service Complete · Report",
    s10: "10. Tax Invoice · Billing",
  },
};

// 문서 종류별 목록 설정 — 각 단계 목록의 컬럼/존재여부/라벨을 한 곳에서 정의한다.
type DocKind = "ci" | "pl" | "sa" | "pod" | "tax";
const KIND_CFG: Record<
  DocKind,
  {
    label: string;
    short: string;
    has: (r: DocRow) => boolean;
    docCol: ColumnDef<DocRow>;
    extra?: ColumnDef<DocRow>[];
  }
> = {
  ci: {
    label: "Commercial Invoice",
    short: "CI",
    has: (r) => r.has_ci,
    docCol: { key: "ci_no", label: "CI No.", text: (r) => r.ci_no || "" },
  },
  pl: {
    label: "Packing List",
    short: "PL",
    has: (r) => r.has_pl,
    docCol: { key: "pl_no", label: "PL No.", text: (r) => r.pl_no || "" },
  },
  sa: {
    label: "Shipping Advice",
    short: "SA",
    has: (r) => r.has_sa,
    docCol: { key: "sa_no", label: "SA No.", text: (r) => r.sa_no || "" },
    extra: [
      {
        key: "sa_sent",
        label: "Sent date",
        text: (r) => r.sa_sent_date || "",
        filter: "date",
        render: (r) => r.sa_sent_date || <span className="muted">Not sent</span>,
      },
    ],
  },
  pod: {
    label: "POD",
    short: "POD",
    has: (r) => r.has_pod,
    docCol: { key: "pod", label: "POD file", text: (r) => r.pod_filename || "" },
  },
  tax: {
    label: "Tax Invoice",
    short: "Tax",
    has: (r) => r.has_tax,
    docCol: { key: "tax_no", label: "Tax No.", text: (r) => r.tax_no || "" },
  },
};

type SvcStage = 7 | 8 | 9;
type Editing =
  | { orderId: number; kind: DocKind }
  | { orderId: number; svc: SvcStage };

function DocumentsOverview() {
  const params = useSearchParams();
  const router = useRouter();
  const orderParam = params.get("order");
  const viewParam = params.get("view");

  const [workView, setWorkView] = useState<WorkView>(viewParam === "service" ? "service" : "parts");
  const [stage, setStage] = useState<StageTab>("s7");
  const [readyDoc, setReadyDoc] = useState<"ci" | "pl">("ci"); // 7단계 하위(CI/PL)
  const [editing, setEditing] = useState<Editing | null>(null);

  const { data: overview, refresh } = useCachedData(
    "documents:overview",
    fetchDocumentsOverview
  );
  const orders = overview?.rows ?? [];
  const partsOrders = orders.filter((o) => o.work_type !== "서비스");
  const serviceOrders = orders.filter((o) => o.work_type === "서비스");

  // 상단 Documents 호버 메뉴(?view=parts|service)로 업무유형 전환.
  useEffect(() => {
    if (viewParam === "service" || viewParam === "parts") setWorkView(viewParam);
  }, [viewParam]);

  // 진행현황 등에서 ?order=<id> 로 들어오면 해당 오더 작업 모달을 연다(업무유형 자동 선택).
  useEffect(() => {
    if (!orderParam) return;
    const id = Number(orderParam);
    const row = orders.find((o) => o.id === id);
    if (row?.work_type === "서비스") {
      setWorkView("service");
      setEditing({ orderId: id, svc: 7 });
    } else {
      setWorkView("parts");
      setEditing({ orderId: id, kind: "ci" });
    }
  }, [orderParam, overview]); // eslint-disable-line react-hooks/exhaustive-deps

  function load() {
    invalidateCache("dashboard");
    invalidateCache("pipeline");
    return refresh();
  }

  function open(orderId: number, kind: DocKind) {
    setEditing({ orderId, kind });
  }
  function openSvc(orderId: number, svc: SvcStage) {
    setEditing({ orderId, svc });
  }
  function close() {
    setEditing(null);
    if (orderParam) router.replace("/documents");
  }

  // 현재 단계에 해당하는 (부품공급) 문서 종류. 7단계는 CI/PL seg-tab.
  const stageKinds: DocKind[] =
    stage === "s7" ? [readyDoc] : stage === "s8" ? ["sa"] : stage === "s9" ? ["pod"] : ["tax"];
  const svcStage: SvcStage | null =
    stage === "s7" ? 7 : stage === "s8" ? 8 : stage === "s9" ? 9 : null;

  return (
    <div className="action-tabs">
      <div className="page-tabs">
        {STAGE_KEYS.map((key) => (
          <button key={key} className={stage === key ? "on" : ""} onClick={() => setStage(key)}>
            {STAGE_LABELS[workView][key]}
          </button>
        ))}
      </div>

      {workView === "parts" ? (
        <>
          {stage === "s7" ? (
            <div className="seg-tabs" style={{ margin: "14px 0" }}>
              <button className={readyDoc === "ci" ? "on" : ""} onClick={() => setReadyDoc("ci")}>
                Commercial Invoice
              </button>
              <button className={readyDoc === "pl" ? "on" : ""} onClick={() => setReadyDoc("pl")}>
                Packing List
              </button>
            </div>
          ) : null}

          {partsOrders.some((o) => o.trade_type === "내수") ? (
            <div className="alert-warn" style={{ margin: "12px 0" }}>
              Domestic orders skip CI · PL · SA · POD. Handle billing (tax invoice · payment) in the{" "}
              <b>AR</b> menu.
            </div>
          ) : null}

          {stageKinds.map((kind) => (
            <StageList key={kind} kind={kind} orders={partsOrders} onOpen={open} />
          ))}
        </>
      ) : svcStage ? (
        <div style={{ marginTop: 14 }}>
          <ServiceStageList svc={svcStage} orders={serviceOrders} onOpen={openSvc} />
        </div>
      ) : (
        <div className="alert-warn" style={{ margin: "14px 0" }}>
          Tax invoice · billing for service orders (stages 10–12) is handled in the <b>AR</b> menu.
        </div>
      )}

      {editing ? (
        "kind" in editing ? (
          <DocEditorModal
            orderId={editing.orderId}
            kind={editing.kind}
            ordNo={orders.find((o) => o.id === editing.orderId)?.ord_no}
            onClose={close}
            onChanged={load}
          />
        ) : (
          <ServiceEditorModal
            orderId={editing.orderId}
            svc={editing.svc}
            ordNo={orders.find((o) => o.id === editing.orderId)?.ord_no}
            onClose={close}
            onChanged={load}
          />
        )
      ) : null}
    </div>
  );
}

// ── 서비스 업무 7·8·9단계 ──────────────────────────────────────────────────
const SVC_CFG: Record<SvcStage, { label: string; done: (r: DocRow) => boolean }> = {
  7: { label: "Service Readiness", done: (r) => r.svc_ready_done },
  8: { label: "Service Arrangement", done: (r) => r.svc_arr_done },
  9: { label: "Service Complete · Report", done: (r) => r.has_pod },
};

function ServiceStageList({
  svc,
  orders,
  onOpen,
}: {
  svc: SvcStage;
  orders: DocRow[];
  onOpen: (orderId: number, svc: SvcStage) => void;
}) {
  const cfg = SVC_CFG[svc];
  const columns: ColumnDef<DocRow>[] = [
    { key: "ord_no", label: "ORD No.", text: (r) => r.ord_no || "" },
    { key: "customer", label: "Customer", text: (r) => r.customer || "", filter: "facet" },
    { key: "vessel", label: "Vessel", text: (r) => r.vessel || "", filter: "facet" },
    { key: "po_no", label: "PO No.", text: (r) => r.po_no || "" },
    ...(svc === 9
      ? [{ key: "report", label: "Report file", text: (r: DocRow) => r.pod_filename || "" }]
      : []),
    {
      key: "done",
      label: "Status",
      text: (r) => (cfg.done(r) ? "Done" : "Pending"),
      filter: "facet",
      render: (r) => (
        <span className={`ar-badge${cfg.done(r) ? "" : " overdue"}`}>
          {cfg.done(r) ? "Done" : "Pending"}
        </span>
      ),
    },
  ];

  return (
    <FilterTable
      rows={orders}
      columns={columns}
      getRowKey={(r) => r.id}
      onRowClick={(r) => onOpen(r.id, svc)}
      empty={`No service orders for ${cfg.label}.`}
    />
  );
}

// 서비스 단계 작업 모달 — 7·8단계는 완료체크+메모, 9단계는 리포트 파일 업로드.
function ServiceEditorModal({
  orderId,
  svc,
  ordNo,
  onClose,
  onChanged,
}: {
  orderId: number;
  svc: SvcStage;
  ordNo?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<DocumentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    fetchDocumentDetail(orderId)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Error"))
      .finally(() => setLoading(false));
  }
  useEffect(load, [orderId]);

  function afterChange() {
    load();
    onChanged();
  }

  const title = `${SVC_CFG[svc].label}${ordNo ? ` — ${ordNo}` : ""}`;

  return (
    <Modal title={title} onClose={onClose} wide>
      {error ? <div className="state error">API error: {error}</div> : null}
      {loading && !data ? <div className="state">Loading details...</div> : null}
      {data ? (
        svc === 9 ? (
          <PodTab key={`rep-${data.order.id}`} data={data} onChanged={afterChange} docLabel="Service Report" />
        ) : (
          <ServiceMilestoneTab key={`svc${svc}-${data.order.id}`} data={data} svc={svc} onChanged={afterChange} />
        )
      ) : null}
    </Modal>
  );
}

// 서비스 7·8단계 — 단계 완료 토글 + 메모(활동 기록으로 저장).
function ServiceMilestoneTab({
  data,
  svc,
  onChanged,
}: {
  data: DocumentDetail;
  svc: 7 | 8;
  onChanged: () => void;
}) {
  const done = Boolean(data.stage_done[String(svc) as "7" | "8"]);
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(complete: boolean) {
    setBusy(true);
    setErr(null);
    try {
      if (memo.trim() && data.order.rfq_id) {
        await addRfqStageNote(data.order.rfq_id, svc, { text: memo.trim() });
      }
      await completeOrderStage(data.order.id, svc, complete);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="doc-tab">
      <div className="milestone-row" style={{ marginBottom: 12 }}>
        <span className={`ar-badge${done ? "" : " overdue"}`}>{done ? "Done" : "Pending"}</span>
      </div>
      <label className="form-field">
        <span>Note (added to activity log)</span>
        <textarea
          className="po-textarea small"
          placeholder="A note here is added to the Progress activity log for this stage. (optional)"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
        />
      </label>
      <div className="form-actions">
        <button className="btn primary" disabled={busy} onClick={() => save(true)}>
          {busy ? "Working…" : "Complete this stage"}
        </button>
        {done ? (
          <button className="btn" disabled={busy} onClick={() => save(false)}>
            Undo completion
          </button>
        ) : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  );
}

// 단계별 문서 목록 — RFQ·P/O 와 동일한 FilterTable 정렬·필터 UX.
// 행 클릭 시 해당 오더 작업 모달, "+ 등록" 으로 아직 없는 오더를 골라 작성한다.
function StageList({
  kind,
  orders,
  onOpen,
}: {
  kind: DocKind;
  orders: DocRow[];
  onOpen: (orderId: number, kind: DocKind) => void;
}) {
  const cfg = KIND_CFG[kind];
  const [registering, setRegistering] = useState(false);

  const columns: ColumnDef<DocRow>[] = [
    cfg.docCol,
    { key: "ord_no", label: "ORD No.", text: (r) => r.ord_no || "" },
    { key: "customer", label: "Customer", text: (r) => r.customer || "", filter: "facet" },
    { key: "vessel", label: "Vessel", text: (r) => r.vessel || "", filter: "facet" },
    { key: "po_no", label: "PO No.", text: (r) => r.po_no || "" },
    ...(cfg.extra ?? []),
  ];

  // 내수(국내공급) 오더는 CI/PL/SA/POD/Tax(수출 문서)를 생략 → 목록·등록 대상에서 제외.
  const exportOrders = orders.filter((r) => r.trade_type !== "내수");
  const listRows = exportOrders.filter(cfg.has);
  const registerable = exportOrders.filter((r) => !cfg.has(r));

  return (
    <>
      <FilterTable
        rows={listRows}
        columns={columns}
        getRowKey={(r) => r.id}
        onRowClick={(r) => onOpen(r.id, kind)}
        empty={`No ${cfg.label} registered.`}
        actions={
          <button className="btn primary" onClick={() => setRegistering(true)}>
            + New {cfg.short}
          </button>
        }
      />

      {registering ? (
        <Modal title={`New ${cfg.label} — select order`} onClose={() => setRegistering(false)} wide>
          <p className="state" style={{ marginTop: 0 }}>
            Select an order to create a {cfg.label} for.
          </p>
          <FilterTable
            rows={registerable}
            columns={[
              { key: "ord_no", label: "ORD No.", text: (r) => r.ord_no || "" },
              { key: "customer", label: "Customer", text: (r) => r.customer || "", filter: "facet" },
              { key: "vessel", label: "Vessel", text: (r) => r.vessel || "", filter: "facet" },
              { key: "po_no", label: "PO No.", text: (r) => r.po_no || "" },
            ]}
            getRowKey={(r) => r.id}
            onRowClick={(r) => {
              setRegistering(false);
              onOpen(r.id, kind);
            }}
            empty={`No orders available to create a ${cfg.label}.`}
          />
        </Modal>
      ) : null}
    </>
  );
}

// 오더 작업 모달 — 클릭한 문서 한 종류의 편집기만 띄운다(다른 단계 탭은 보이지 않음).
function DocEditorModal({
  orderId,
  kind,
  ordNo,
  onClose,
  onChanged,
}: {
  orderId: number;
  kind: DocKind;
  ordNo?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<DocumentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    fetchDocumentDetail(orderId)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Error"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [orderId]);

  function afterChange() {
    load();
    onChanged();
  }

  const title = `${KIND_CFG[kind].label}${ordNo ? ` — ${ordNo}` : ""}`;

  return (
    <Modal title={title} onClose={onClose} wide>
      {error ? <div className="state error">API error: {error}</div> : null}
      {loading && !data ? <div className="state">Loading details...</div> : null}
      {data ? (
        kind === "ci" ? (
          <CommercialInvoiceTab key={`ci-${data.order.id}-${data.ci?.id ?? 0}`} data={data} onChanged={afterChange} />
        ) : kind === "pl" ? (
          <PackingListTab key={`pl-${data.order.id}-${data.pl?.id ?? 0}`} data={data} onChanged={afterChange} />
        ) : kind === "sa" ? (
          <ShippingAdviceTab key={`sa-${data.order.id}-${data.sa?.id ?? 0}`} data={data} onChanged={afterChange} />
        ) : kind === "pod" ? (
          <PodTab key={`pod-${data.order.id}`} data={data} onChanged={afterChange} />
        ) : (
          <TaxInvoiceTab key={`tax-${data.order.id}-${data.tax?.id ?? 0}`} data={data} onChanged={afterChange} />
        )
      ) : null}
    </Modal>
  );
}

/** 9) 운송 완료 · POD 수취 — 인도 증빙(POD) 파일 업로드/다운로드/삭제. 업로드 시 9단계 완료. */
function PodTab({
  data,
  onChanged,
  docLabel = "POD (proof of delivery)",
}: {
  data: DocumentDetail;
  onChanged: () => void;
  docLabel?: string;
}) {
  const pod = data.pod;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      await uploadPod(data.order.id, file);
      onChanged();
    } catch (x) {
      setErr(x instanceof Error ? x.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    const res = await fetch(podDownloadUrl(data.order.id), {
      headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
    });
    if (!res.ok) {
      setErr("Download failed");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = pod?.filename || "POD";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function remove() {
    if (!confirm("Delete the POD file? (stage 9 completion will be undone)")) return;
    setBusy(true);
    setErr(null);
    try {
      await deletePod(data.order.id);
      onChanged();
    } catch (x) {
      setErr(x instanceof Error ? x.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="doc-tab">
      <h3>{docLabel}</h3>
      {pod ? (
        <div className="pod-current">
          <span className="pod-file">📄 {pod.filename}</span>
          {pod.uploaded_at ? <span className="pod-when">Uploaded {fmtDateTime(pod.uploaded_at)}</span> : null}
          <button className="btn" onClick={download} disabled={busy}>
            Download
          </button>
          <button className="btn danger" onClick={remove} disabled={busy}>
            Delete
          </button>
        </div>
      ) : (
        <div className="state">
          No {docLabel} file yet. Uploading a file (PDF · image) will <b>complete stage 9</b>.
        </div>
      )}
      <div className="form-actions">
        <label className="btn primary" style={{ cursor: busy ? "default" : "pointer" }}>
          {busy ? "Working…" : pod ? `Replace ${docLabel} file` : `Upload ${docLabel} file`}
          <input type="file" hidden accept=".pdf,image/*" onChange={onPick} disabled={busy} />
        </label>
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  );
}

/** "YYYY-MM-DDTHH:MM" → "yy-mm-dd HH:MM". */
function fmtDateTime(iso: string): string {
  if (!iso || iso.length < 16) return iso || "";
  return `${iso.slice(2, 10)} ${iso.slice(11, 16)}`;
}

function OrderMilestones({ data, onChanged }: { data: DocumentDetail; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);

  async function toggle(field: "consignee_confirmed_date" | "vendor_docs_sent_date", value: boolean) {
    setBusy(true);
    try {
      await updateDocumentMilestone(data.order.id, field, value);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="milestone-row">
      <button
        className="btn"
        disabled={busy}
        onClick={() => toggle("consignee_confirmed_date", !data.order.consignee_confirmed_date)}
      >
        Customer confirmed {data.order.consignee_confirmed_date || "pending"}
      </button>
      <button
        className="btn"
        disabled={busy}
        onClick={() => toggle("vendor_docs_sent_date", !data.order.vendor_docs_sent_date)}
      >
        Vendor docs confirmed {data.order.vendor_docs_sent_date || "pending"}
      </button>
    </div>
  );
}

function CommercialInvoiceTab({ data, onChanged }: { data: DocumentDetail; onChanged: () => void }) {
  const [date, setDate] = useState(data.ci?.date || today());
  const [currency, setCurrency] = useState(data.ci?.currency || "USD");
  const [vatRate, setVatRate] = useState(data.ci?.vat_rate ?? 0);
  const [items, setItems] = useState<DocumentWorkItem[]>(normalizeItems(data.ci?.items || data.order.items));
  const [shipping, setShipping] = useState<Record<string, string>>({
    port_loading: "Busan, Korea",
    port_discharge: "",
    carrier: "TBD",
    bl_awb_no: "TBD",
    etd: "",
    eta: "",
    shipping_marks: `K-MARIS / ${data.order.vessel || ""} / ${data.order.po_no || ""}`,
    ...(data.ci?.shipping || {}),
  });
  const [busy, setBusy] = useState(false);
  const total = useMemo(() => items.reduce((sum, i) => sum + num(i.amount), 0), [items]);

  async function save() {
    setBusy(true);
    try {
      await saveCommercialInvoice(data.order.id, { date, currency, vat_rate: vatRate, items, shipping });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="doc-tab">
      <div className="form-grid">
        <Field label="CI Date" value={date} onChange={setDate} type="date" />
        <Field label="Currency" value={currency} onChange={setCurrency} />
        <Field label="VAT Rate" value={String(vatRate)} onChange={(v) => setVatRate(num(v))} type="number" />
      </div>
      <ShippingFields shipping={shipping} setShipping={setShipping} />
      <ItemEditor items={items} setItems={setItems} packing={false} />
      <MissingWarning missing={data.ci?.missing || []} />
      <div className="form-actions">
        <button className="btn primary" disabled={busy} onClick={save}>
          Save CI
        </button>
        <DownloadButton orderId={data.order.id} kind="ci/pdf" disabled={!data.ci} label="Download CI PDF" />
        <span className="hint-inline">Total {currency} {total.toLocaleString()}</span>
      </div>
    </div>
  );
}

function PackingListTab({ data, onChanged }: { data: DocumentDetail; onChanged: () => void }) {
  const [date, setDate] = useState(data.pl?.date || today());
  const seed = data.pl?.items || data.ci?.items || data.order.items;
  const [items, setItems] = useState<DocumentWorkItem[]>(normalizeItems(seed, true));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await savePackingList(data.order.id, { date, items });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  if (!data.ci) {
    return <div className="state">Create a Commercial Invoice first.</div>;
  }

  return (
    <div className="doc-tab">
      <div className="form-grid">
        <Field label="PL Date" value={date} onChange={setDate} type="date" />
      </div>
      <ItemEditor items={items} setItems={setItems} packing />
      <MissingWarning missing={data.pl?.missing || []} />
      <div className="form-actions">
        <button className="btn primary" disabled={busy} onClick={save}>
          Save PL
        </button>
        <DownloadButton orderId={data.order.id} kind="pl/pdf" disabled={!data.pl} label="Download PL PDF" />
      </div>
    </div>
  );
}

function ShippingAdviceTab({ data, onChanged }: { data: DocumentDetail; onChanged: () => void }) {
  const [date, setDate] = useState(data.sa?.date || today());
  const [shipping, setShipping] = useState<Record<string, string>>({
    port_loading: data.ci?.shipping.port_loading || "Busan, Korea",
    port_discharge: data.ci?.shipping.port_discharge || "",
    carrier: data.ci?.shipping.carrier || "TBD",
    bl_awb_no: data.ci?.shipping.bl_awb_no || "TBD",
    etd: data.ci?.shipping.etd || "",
    eta: data.ci?.shipping.eta || "",
    shipping_marks: data.ci?.shipping.shipping_marks || `K-MARIS / ${data.order.vessel || ""} / ${data.order.po_no || ""}`,
    ...(data.sa?.shipping || {}),
  });
  const [to, setTo] = useState(data.order.customer_email || "");
  const [subject, setSubject] = useState(data.sa?.sa_no ? `[K-MARIS] Shipping Advice ${data.sa.sa_no}` : "");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [ackMissing, setAckMissing] = useState(false);

  // SA 는 CI 기준으로 발송되므로 CI 가 오더와 일치하는지 발송 전 검증한다.
  const ciMissing = data.ci?.missing || [];

  async function save() {
    setBusy(true);
    try {
      await saveShippingAdvice(data.order.id, { date, shipping });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    setBusy(true);
    try {
      await sendShippingAdvice(data.order.id, to, subject, body);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="doc-tab">
      {/* 8단계(Delivery arrangement) 마일스톤 — Customer 확인 / Vendor 서류 확인 */}
      <OrderMilestones data={data} onChanged={onChanged} />
      <div className="form-grid">
        <Field label="SA Date" value={date} onChange={setDate} type="date" />
      </div>
      <ShippingFields shipping={shipping} setShipping={setShipping} />
      {data.ci ? (
        <MissingWarning missing={ciMissing} />
      ) : (
        <div className="alert-warn">No CI yet. The SA is sent based on CI items — create a CI first.</div>
      )}
      <div className="form-grid">
        <Field label="Recipient email" value={to} onChange={setTo} />
        <Field label="Subject" value={subject} onChange={setSubject} />
      </div>
      <textarea
        className="po-textarea small"
        placeholder="Leave the body empty to send the default Shipping Advice email body."
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      {ciMissing.length > 0 ? (
        <label className="check-inline" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={ackMissing} onChange={(e) => setAckMissing(e.target.checked)} />
          I have reviewed {ciMissing.length} missing/short-quantity item(s) and will send as is.
        </label>
      ) : null}
      <div className="form-actions">
        <button className="btn primary" disabled={busy} onClick={save}>
          Save SA
        </button>
        <DownloadButton orderId={data.order.id} kind="sa/pdf" disabled={!data.sa} label="Download SA PDF" />
        <button
          className="btn"
          disabled={busy || !data.sa || !to.trim() || (ciMissing.length > 0 && !ackMissing)}
          onClick={send}
        >
          Send SA email
        </button>
        <span className="hint-inline">
          SMTP {data.smtp_configured ? "configured" : "not configured"} {data.sa?.sent_date ? `· sent ${data.sa.sent_date}` : ""}
        </span>
      </div>
    </div>
  );
}

function TaxInvoiceTab({ data, onChanged }: { data: DocumentDetail; onChanged: () => void }) {
  const [date, setDate] = useState(data.tax?.date || today());
  const [supplyType, setSupplyType] = useState("Export / Zero-rated");
  const [buyerNo, setBuyerNo] = useState(data.order.customer_tax_id || "");
  const [vatRate, setVatRate] = useState(0);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await saveTaxInvoice(data.order.id, {
        date,
        supply_type: supplyType,
        buyer_business_no: buyerNo,
        vat_rate: vatRate,
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  if (!data.ci) {
    return <div className="state">Create a Commercial Invoice first.</div>;
  }

  return (
    <div className="doc-tab">
      <div className="form-grid">
        <Field label="Issue Date" value={date} onChange={setDate} type="date" />
        <Field label="Supply Type" value={supplyType} onChange={setSupplyType} />
        <Field label="Buyer Business No." value={buyerNo} onChange={setBuyerNo} />
        <Field label="VAT Rate" value={String(vatRate)} onChange={(v) => setVatRate(num(v))} type="number" />
      </div>
      <div className="form-actions">
        <button className="btn primary" disabled={busy} onClick={save}>
          Create Tax Invoice Data + register AR
        </button>
        <DownloadButton orderId={data.order.id} kind="tax/xlsx" disabled={!data.tax} label="Download Tax XLSX" />
      </div>
    </div>
  );
}

function ShippingFields({
  shipping,
  setShipping,
}: {
  shipping: Record<string, string>;
  setShipping: (v: Record<string, string>) => void;
}) {
  const fields = [
    ["port_loading", "Port of Loading"],
    ["port_discharge", "Port of Discharge"],
    ["carrier", "Carrier"],
    ["bl_awb_no", "B/L or AWB No."],
    ["etd", "ETD"],
    ["eta", "ETA"],
    ["shipping_marks", "Shipping Marks"],
  ];
  return (
    <div className="form-grid">
      {fields.map(([key, label]) => (
        <Field
          key={key}
          label={label}
          value={shipping[key] || ""}
          onChange={(v) => setShipping({ ...shipping, [key]: v })}
        />
      ))}
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
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="form-field">
      <span>{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function ItemEditor({
  items,
  setItems,
  packing,
}: {
  items: DocumentWorkItem[];
  setItems: (items: DocumentWorkItem[]) => void;
  packing: boolean;
}) {
  function patch(i: number, key: keyof DocumentWorkItem, value: string) {
    const next = [...items];
    const item = { ...next[i], [key]: ["qty", "unit_price", "amount"].includes(String(key)) ? num(value) : value };
    if (!packing && (key === "qty" || key === "unit_price")) {
      item.amount = num(item.qty) * num(item.unit_price);
    }
    next[i] = item;
    setItems(next);
  }

  return (
    <div className="table-wrap">
      <table className="mini wide">
        <thead>
          <tr>
            <th>Part No.</th>
            <th>Description</th>
            <th>Maker</th>
            <th className="num">Qty</th>
            <th>Unit</th>
            {packing ? (
              <>
                <th>Package</th>
                <th>N.W.</th>
                <th>G.W.</th>
                <th>Dimension</th>
              </>
            ) : (
              <>
                <th className="num">Unit Price</th>
                <th className="num">Amount</th>
                <th>HS Code</th>
              </>
            )}
            <th>Remark</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <tr key={i}>
              <td><input value={item.part_no || ""} onChange={(e) => patch(i, "part_no", e.target.value)} /></td>
              <td><input value={item.description || ""} onChange={(e) => patch(i, "description", e.target.value)} /></td>
              <td><input value={item.maker || ""} onChange={(e) => patch(i, "maker", e.target.value)} /></td>
              <td><input className="num" value={item.qty ?? 0} onChange={(e) => patch(i, "qty", e.target.value)} /></td>
              <td><input value={item.unit || "PCS"} onChange={(e) => patch(i, "unit", e.target.value)} /></td>
              {packing ? (
                <>
                  <td><input value={item.package || ""} onChange={(e) => patch(i, "package", e.target.value)} /></td>
                  <td><input value={String(item.net_weight || "")} onChange={(e) => patch(i, "net_weight", e.target.value)} /></td>
                  <td><input value={String(item.gross_weight || "")} onChange={(e) => patch(i, "gross_weight", e.target.value)} /></td>
                  <td><input value={item.dimension || ""} onChange={(e) => patch(i, "dimension", e.target.value)} /></td>
                </>
              ) : (
                <>
                  <td><input className="num" value={item.unit_price ?? 0} onChange={(e) => patch(i, "unit_price", e.target.value)} /></td>
                  <td><input className="num" value={item.amount ?? 0} onChange={(e) => patch(i, "amount", e.target.value)} /></td>
                  <td><input value={item.hs_code || ""} onChange={(e) => patch(i, "hs_code", e.target.value)} /></td>
                </>
              )}
              <td><input value={item.remark || ""} onChange={(e) => patch(i, "remark", e.target.value)} /></td>
              <td>
                <button className="row-del" onClick={() => setItems(items.filter((_, idx) => idx !== i))}>×</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn" style={{ marginTop: 10 }} onClick={() => setItems([...items, blankItem(packing)])}>
        Add row
      </button>
    </div>
  );
}

function MissingWarning({
  missing,
}: {
  missing: { part_no: string; description: string; order_qty: number; doc_qty: number }[];
}) {
  if (missing.length === 0) return <div className="alert-ok">Document items match the order.</div>;
  return (
    <div className="state error">
      {missing.length} missing or short-quantity item(s):{" "}
      {missing.map((m) => `${m.part_no || m.description} (${m.doc_qty}/${m.order_qty})`).join(", ")}
    </div>
  );
}

function DownloadButton({
  orderId,
  kind,
  label,
  disabled,
}: {
  orderId: number;
  kind: "ci/pdf" | "pl/pdf" | "sa/pdf" | "tax/xlsx";
  label: string;
  disabled: boolean;
}) {
  async function download() {
    const res = await fetch(documentDownloadUrl(orderId, kind), {
      headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
    });
    if (!res.ok) throw new Error("download failed");
    const blob = await res.blob();
    const disposition = res.headers.get("content-disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match?.[1] || `${kind.replace("/", "_")}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <button className="btn" disabled={disabled} onClick={download}>
      {label}
    </button>
  );
}

function normalizeItems(items: DocumentWorkItem[], packing = false): DocumentWorkItem[] {
  return (items || []).map((item, idx) => ({
    item_no: item.item_no || idx + 1,
    part_no: item.part_no || "",
    description: item.description || "",
    maker: item.maker || "",
    origin: item.origin || "",
    qty: num(item.qty || 1),
    unit: item.unit || "PCS",
    unit_price: packing ? item.unit_price ?? null : num(item.unit_price || 0),
    amount: packing ? item.amount ?? null : num(item.amount || num(item.qty || 1) * num(item.unit_price || 0)),
    hs_code: item.hs_code || "",
    remark: item.remark || "",
    package: item.package || "",
    net_weight: item.net_weight || "",
    gross_weight: item.gross_weight || "",
    dimension: item.dimension || "",
  }));
}

function blankItem(packing: boolean): DocumentWorkItem {
  return normalizeItems([{ part_no: "", description: "", qty: 1, unit: "PCS" }], packing)[0];
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
