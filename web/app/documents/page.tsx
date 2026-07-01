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
  saveServiceStage,
  deleteServiceStage,
} from "@/lib/api";
import { getToken, can, canEditDeal, editBlockReason } from "@/lib/auth";
import type { DocRow, DocumentDetail, DocumentWorkItem } from "@/lib/types";
import { fetchDocumentsOverview } from "@/lib/api";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import { tr } from "@/lib/labels";
import AppShell, { SectionHead } from "@/components/AppShell";
import FilterTable, { ColumnDef } from "@/components/common/FilterTable";
import { identityColumns, projectNoColumn } from "@/components/common/identityColumns";
import VendorName from "@/components/common/VendorName";
import Modal from "@/components/common/Modal";
import { ModalTitle } from "@/components/common/BaseMeta";
import CurrencyToggle from "@/components/common/CurrencyToggle";
import {
  amountInputValue,
  DualCurrencyAmount,
  dualCurrencyText,
  fxRateText,
  gridCellProps,
  itemRowClass,
  parseAmountInput,
} from "@/components/common/itemTable";

const today = () => new Date().toISOString().slice(0, 10);

// 문서 편집 권한 = 역할 권한(documents.edit) × 담당(PIC) 소유권. 없으면 읽기전용.
function canEditDoc(data: DocumentDetail | null | undefined): boolean {
  return can("documents", "edit") && canEditDeal(data?.order.assignee_id);
}

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

type SvcStage = 7 | 8 | 9 | 10;
type Editing =
  | { orderId: number; kind: DocKind }
  | { orderId: number; svc: SvcStage };

function DocumentsOverview() {
  const params = useSearchParams();
  const router = useRouter();
  const orderParam = params.get("order");
  const viewParam = params.get("view");
  const stageParam = params.get("stage");

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

  // 진행현황 등에서 ?order=<id>(&stage=7~10) 로 들어오면 해당 단계 작업 모달을 연다.
  useEffect(() => {
    if (!orderParam) return;
    const id = Number(orderParam);
    const row = orders.find((o) => o.id === id);
    const isSvc = row?.work_type === "서비스";
    const sn = Number(stageParam); // 7~10, 없으면 NaN
    setWorkView(isSvc ? "service" : "parts");
    if (sn >= 7 && sn <= 9) setStage((`s${sn}` as StageTab));
    else if (sn === 10) setStage("s10");
    if (isSvc) {
      // 서비스: 7·8·9 단계 편집기(10단계는 AR에서 처리하므로 기본 7)
      setEditing({ orderId: id, svc: (sn >= 7 && sn <= 9 ? (sn as SvcStage) : 7) });
    } else {
      // 부품공급: 단계 → 문서 종류 매핑
      const kind: DocKind = sn === 8 ? "sa" : sn === 9 ? "pod" : sn === 10 ? "tax" : "ci";
      setEditing({ orderId: id, kind });
    }
  }, [orderParam, stageParam, overview]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const svcStage: SvcStage =
    stage === "s7" ? 7 : stage === "s8" ? 8 : stage === "s9" ? 9 : 10;

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
          {partsOrders.some((o) => o.trade_type === "내수") ? (
            <div className="alert-warn" style={{ margin: "12px 0" }}>
              Domestic orders skip CI · PL · SA · POD. Handle billing (tax invoice · payment) in the{" "}
              <b>AR</b> menu.
            </div>
          ) : null}

          {stageKinds.map((kind) => (
            <StageList
              key={kind}
              kind={kind}
              orders={partsOrders}
              onOpen={open}
              onChanged={load}
              leftActions={
                stage === "s7" ? (
                  <div className="seg-tabs">
                    <button className={readyDoc === "ci" ? "on" : ""} onClick={() => setReadyDoc("ci")}>
                      Commercial Invoice
                    </button>
                    <button className={readyDoc === "pl" ? "on" : ""} onClick={() => setReadyDoc("pl")}>
                      Packing List
                    </button>
                  </div>
                ) : undefined
              }
            />
          ))}
        </>
      ) : (
        <div style={{ marginTop: 14 }}>
          <ServiceStageList svc={svcStage} orders={serviceOrders} onOpen={openSvc} onChanged={load} />
        </div>
      )}

      {editing ? (
        "kind" in editing ? (
          <DocEditorModal
            orderId={editing.orderId}
            kind={editing.kind}
            projectNo={orders.find((o) => o.id === editing.orderId)?.project_no}
            onClose={close}
            onChanged={load}
          />
        ) : (
          <ServiceEditorModal
            orderId={editing.orderId}
            svc={editing.svc}
            projectNo={orders.find((o) => o.id === editing.orderId)?.project_no}
            onClose={close}
            onChanged={load}
          />
        )
      ) : null}
    </div>
  );
}

// ── 서비스 업무 7·8·9·10단계 ─────────────────────────────────────────────────
const SVC_CFG: Record<SvcStage, { label: string; btn: string; done: (r: DocRow) => boolean }> = {
  7: { label: "Service Readiness", btn: "Service Readiness", done: (r) => r.svc_ready_done },
  8: { label: "Service Arrangement", btn: "Service Arrangement", done: (r) => r.svc_arr_done },
  9: { label: "Service Complete · Report", btn: "Service Report", done: (r) => r.has_pod },
  10: { label: "Tax Invoice · Billing", btn: "Tax Invoice · Billing", done: (r) => r.svc_billed },
};

// 서비스 단계별 입력 필드 스키마(7·8·9·10). 10은 청구 폼으로 별도 처리.
type SvcField = { key: string; label: string; type?: "text" | "date" | "number" | "textarea" | "select"; options?: string[] };
const SVC_FIELDS: Record<7 | 8 | 9, SvcField[]> = {
  7: [
    { key: "service_type", label: "Service type", type: "select", options: ["Inspection", "Repair", "Commissioning", "Overhaul", "Survey", "Other"] },
    { key: "scope", label: "Scope", type: "textarea" },
    { key: "scheduled_from", label: "Scheduled from", type: "date" },
    { key: "scheduled_to", label: "Scheduled to", type: "date" },
    { key: "location", label: "Location (port / yard / onboard)" },
    { key: "engineers", label: "Assigned engineer(s)" },
    { key: "materials", label: "Required spares / tools", type: "textarea" },
    { key: "notes", label: "Notes", type: "textarea" },
  ],
  8: [
    { key: "dispatch_from", label: "Dispatch from", type: "date" },
    { key: "dispatch_to", label: "Return on", type: "date" },
    { key: "visa_status", label: "Visa / permit status" },
    { key: "accommodation", label: "Accommodation / logistics" },
    { key: "site_contact", label: "On-site contact" },
    { key: "confirmed_schedule", label: "Confirmed schedule" },
    { key: "notes", label: "Notes", type: "textarea" },
  ],
  9: [
    { key: "performed_date", label: "Service performed date", type: "date" },
    { key: "work_summary", label: "Work performed summary", type: "textarea" },
    { key: "findings", label: "Findings / recommendations", type: "textarea" },
    { key: "man_hours", label: "Man-hours", type: "number" },
    { key: "customer_accepted", label: "Customer acceptance (name / date)" },
    { key: "notes", label: "Notes", type: "textarea" },
  ],
};

function ServiceStageList({
  svc,
  orders,
  onOpen,
  onChanged,
}: {
  svc: SvcStage;
  orders: DocRow[];
  onOpen: (orderId: number, svc: SvcStage) => void;
  onChanged: () => void;
}) {
  const cfg = SVC_CFG[svc];
  const [registering, setRegistering] = useState(false);
  const listRows = orders.filter(cfg.done); // 입력 완료된 오더 → 클릭해 수정/삭제
  // 신규 등록 대상 = 직전 서비스 단계까지 완료, 이 단계는 미완료인 오더만.
  const svcPriorOk = (r: DocRow) =>
    svc === 8 ? r.svc_ready_done : svc === 9 ? r.svc_arr_done : svc === 10 ? r.has_pod : true;
  const registerable = orders.filter((r) => !cfg.done(r) && svcPriorOk(r));
  const columns: ColumnDef<DocRow>[] = [
    projectNoColumn<DocRow>({ projectNo: (r) => r.project_no, firstRfqAt: (r) => r.first_rfq_at }),
    ...identityColumns<DocRow>({
      customer: (r) => r.customer,
      vessel: (r) => r.vessel,
      workType: (r) => r.work_type,
      tradeType: (r) => r.trade_type,
    }),
    { key: "vendor", label: "Vendor", text: (r) => r.vendor || "", filter: "facet", render: (r) => <VendorName name={r.vendor || ""} /> },
    { key: "po_no", label: "PO No.", text: (r) => r.po_no || "" },
    ...(svc === 9
      ? [{ key: "report", label: "Report file", text: (r: DocRow) => r.pod_filename || "" }]
      : []),
    ...(svc === 10
      ? [{ key: "tax_no", label: "Tax No.", text: (r: DocRow) => r.tax_no || "" }]
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
    <>
      <FilterTable
        tableId={`docs-svc-${svc}`}
        rows={listRows}
        columns={columns}
        getRowKey={(r) => r.id}
        onRowClick={(r) => onOpen(r.id, svc)}
        defaultSortKey="project_no"
        defaultSortDir="desc"
        empty={`No ${cfg.label} entered yet.`}
        actions={
          can("documents", "create") ? (
            <button className="btn primary" onClick={() => setRegistering(true)} disabled={registerable.length === 0}>
              + {cfg.btn}
            </button>
          ) : null
        }
      />

      {registering ? (
        <ServiceNewModal svc={svc} orders={registerable} onClose={() => setRegistering(false)} onChanged={onChanged} />
      ) : null}
    </>
  );
}

// 신규 입력 — 추가 버튼 클릭 시 바로 편집 폼 팝업. 상단 드롭다운으로 대상 오더 선택
// (후보가 1건이면 자동 선택). 선택하면 해당 단계 편집기가 바로 표시된다.
function ServiceNewModal({
  svc,
  orders,
  onClose,
  onChanged,
}: {
  svc: SvcStage;
  orders: DocRow[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [orderId, setOrderId] = useState<number | "">(orders.length === 1 ? orders[0].id : "");
  const selectedOrder = orderId === "" ? null : orders.find((o) => o.id === orderId);

  return (
    <Modal title={<ModalTitle label={`${SVC_CFG[svc].label} — new entry`} projectNo={selectedOrder?.project_no} />} onClose={onClose} wide>
      <div className="project-select">
        <label>Service order *</label>
        <select value={orderId} onChange={(e) => setOrderId(e.target.value ? Number(e.target.value) : "")}>
          <option value="">Select…</option>
          {orders.map((o) => (
            <option key={o.id} value={o.id}>
              {o.project_no} · {o.customer} · {o.vessel || "-"}
            </option>
          ))}
        </select>
      </div>
      <ServiceStageEditor
        key={`${svc}-${orderId || 0}`}
        orderId={orderId === "" ? 0 : orderId}
        svc={svc}
        onChanged={onChanged}
        onClose={onClose}
      />
    </Modal>
  );
}

// 서비스 단계 편집기(모달 없는 본문) — 상세 로드 후 단계별 폼 렌더. 신규/수정 공용.
function ServiceStageEditor({
  orderId,
  svc,
  onChanged,
  onClose,
}: {
  orderId: number;
  svc: SvcStage;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<DocumentDetail | null>(orderId ? null : emptyDocDetail());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    if (!orderId) {
      setData(emptyDocDetail()); // 오더 미선택 → 빈 폼
      return;
    }
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

  return (
    <>
      {error ? <div className="state error">API error: {error}</div> : null}
      {loading && !data ? <div className="state">Loading details...</div> : null}
      {data ? (
        <>
          <DocOrderInfo order={data.order} />
          {svc === 10 ? (
            <ServiceBillingForm key={`svc10-${data.order.id}`} data={data} onChanged={afterChange} onClose={onClose} />
          ) : (
            <ServiceStageForm key={`svc${svc}-${data.order.id}`} data={data} svc={svc} onChanged={afterChange} onClose={onClose} />
          )}
        </>
      ) : null}
    </>
  );
}

// 서비스 단계 작업 모달(행 클릭 수정용) — 편집기를 모달로 감싼다.
function ServiceEditorModal({
  orderId,
  svc,
  projectNo,
  onClose,
  onChanged,
}: {
  orderId: number;
  svc: SvcStage;
  projectNo?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const title = `${SVC_CFG[svc].label}${projectNo ? ` — ${projectNo}` : ""}`;
  return (
    <Modal title={<ModalTitle label={title} projectNo={projectNo} />} onClose={onClose} wide>
      <ServiceStageEditor orderId={orderId} svc={svc} onChanged={onChanged} onClose={onClose} />
    </Modal>
  );
}

// 9단계 리포트 파일 업로드 — Auto-fill 과 동일한 tool-btn 스타일(컴팩트), Pending 아래 배치.
function ServiceReportUpload({ data, onChanged }: { data: DocumentDetail; onChanged: () => void }) {
  const pod = data.pod;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !data.order.id) return;
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
    a.download = pod?.filename || "Service Report";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function remove() {
    if (!confirm("Delete the report file?")) return;
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
    <div className="form-tools" style={{ marginBottom: 14 }}>
      <label className={`tool-btn${pod ? " on" : ""}`} style={{ cursor: busy ? "default" : "pointer" }}>
        📄 {busy ? "Uploading…" : pod ? "Replace Service Report file" : "Upload Service Report file"}
        <input type="file" hidden accept=".pdf,image/*" onChange={onPick} disabled={busy} />
      </label>
      {pod ? (
        <span className="hint-inline">
          📎 {pod.filename}
          <button type="button" className="btn" onClick={download} disabled={busy} style={{ marginLeft: 8 }}>
            Download
          </button>
          <button type="button" className="btn danger" onClick={remove} disabled={busy} style={{ marginLeft: 6 }}>
            Delete
          </button>
        </span>
      ) : (
        <span className="hint-inline">PDF · image. Uploading completes stage 9.</span>
      )}
      {err ? <span className="action-err">{err}</span> : null}
    </div>
  );
}

// 서비스 7·8·9단계 — 구조화 입력 필드 + (9단계) 리포트 파일. 저장 시 단계 완료.
function ServiceStageForm({
  data,
  svc,
  onChanged,
  onClose,
}: {
  data: DocumentDetail;
  svc: 7 | 8 | 9;
  onChanged: () => void;
  onClose: () => void;
}) {
  const fields = SVC_FIELDS[svc];
  const saved = data.order.service_info?.[String(svc)] ?? {};
  const hasSaved = !!data.order.service_info?.[String(svc)];
  const [form, setForm] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of fields) init[f.key] = String(saved[f.key] ?? "");
    return init;
  });
  const done = Boolean(data.stage_done[String(svc) as "7" | "8" | "9"]) || (svc === 9 && !!data.pod);
  const [complete, setComplete] = useState(done); // 7·8단계: 저장 시 단계 완료 여부
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const editable = canEditDoc(data);

  function set(key: string, v: string) {
    setForm((p) => ({ ...p, [key]: v }));
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      // 9단계는 리포트 파일(POD) 업로드가 완료 근거이므로 stage_dates 완료는 생략(파일 기준).
      await saveServiceStage(data.order.id, svc, form, svc === 9 ? false : complete);
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm("Delete this stage's entry?")) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteServiceStage(data.order.id, svc);
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="doc-tab">
      <div className="milestone-row" style={{ marginBottom: 12 }}>
        <span className={`ar-badge${done ? "" : " overdue"}`}>{done ? "Done" : "Pending"}</span>
      </div>

      <fieldset className="form-fieldset" disabled={!editable}>
      {svc === 9 ? <ServiceReportUpload data={data} onChanged={onChanged} /> : null}

      <div className="form-grid">
        {fields.map((f) => (
          <SvcFieldInput key={f.key} field={f} value={form[f.key] ?? ""} onChange={(v) => set(f.key, v)} />
        ))}
      </div>

      {svc !== 9 ? (
        <label className="stage-complete-check">
          <input type="checkbox" checked={complete} onChange={(e) => setComplete(e.target.checked)} />
          <span>Mark this stage as complete</span>
        </label>
      ) : null}
      </fieldset>

      <div className="form-actions" style={{ marginTop: 14 }}>
        {!editable ? (
          <span className="hint-inline">{editBlockReason("documents", data.order.assignee_id)}</span>
        ) : (
          <button className="btn primary" disabled={busy || data.order.id === 0} onClick={save}>
            {busy ? "Working…" : "Save"}
          </button>
        )}
        <button className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        {hasSaved && editable ? (
          <button className="btn danger" disabled={busy} onClick={remove}>
            Delete
          </button>
        ) : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  );
}

// 서비스 10단계 — 청구 요금 내역 입력 → 저장 시 AR 레코드 자동 생성.
function ServiceBillingForm({ data, onChanged, onClose }: { data: DocumentDetail; onChanged: () => void; onClose: () => void }) {
  const saved = data.order.service_info?.["10"] ?? {};
  const savedText = (key: string, fallback = "") => String(saved[key] ?? fallback);
  const savedItems = Array.isArray(saved.items) ? (saved.items as DocumentWorkItem[]) : [];
  const [labor, setLabor] = useState(savedText("labor_cost"));
  const [travel, setTravel] = useState(savedText("travel_cost"));
  const [material, setMaterial] = useState(savedText("material_cost"));
  const [other, setOther] = useState(savedText("other_cost"));
  const [currency, setCurrency] = useState(savedText("currency", "USD"));
  const [vatRate, setVatRate] = useState(savedText("vat_rate", "0"));
  const [items, setItems] = useState<DocumentWorkItem[]>(
    normalizeItems(savedItems.length ? savedItems : data.order.items)
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const editable = canEditDoc(data);

  const itemTotal = useMemo(() => items.reduce((sum, item) => sum + num(item.amount), 0), [items]);
  const extraTotal = useMemo(
    () => num(labor) + num(travel) + num(material) + num(other),
    [labor, travel, material, other]
  );
  const total = itemTotal + extraTotal;
  const billed = !!data.order.service_info?.["10"];

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await saveServiceStage(data.order.id, 10, {
        labor_cost: labor,
        travel_cost: travel,
        material_cost: material,
        other_cost: other,
        currency,
        vat_rate: vatRate,
        items,
      });
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm("Delete the billing entry? (the linked AR record will be removed)")) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteServiceStage(data.order.id, 10);
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="doc-tab">
      <div className="milestone-row" style={{ marginBottom: 12 }}>
        <span className={`ar-badge${billed ? "" : " overdue"}`}>{billed ? "Billed" : "Pending"}</span>
      </div>
      <fieldset className="form-fieldset" disabled={!editable}>
      <div className="form-grid">
        <label className="form-field">
          <span>Currency</span>
          <CurrencyToggle value={currency} onChange={setCurrency} />
        </label>
        <Field label="VAT Rate" value={String(vatRate)} onChange={setVatRate} type="number" />
      </div>
      <div className="po-work-note">
        <b>Load from previous step</b>
        <span>Reload item and amount data from the linked order.</span>
      </div>
      <div className="form-actions" style={{ marginTop: 0 }}>
        <button className="btn" disabled={busy} onClick={() => setItems(normalizeItems(data.order.items))}>
          Load order items
        </button>
      </div>
      <ItemEditor items={items} setItems={setItems} packing={false} currency={currency} />
      <div className="sub-h" style={{ marginTop: 14 }}>Additional cost</div>
      <div className="form-grid">
        <Field label="Labor cost" value={String(labor)} onChange={setLabor} type="number" />
        <Field label="Travel cost" value={String(travel)} onChange={setTravel} type="number" />
        <Field label="Material cost" value={String(material)} onChange={setMaterial} type="number" />
        <Field label="Other cost" value={String(other)} onChange={setOther} type="number" />
      </div>
      </fieldset>
      <div className="form-actions" style={{ marginTop: 14 }}>
        {!editable ? (
          <span className="hint-inline">{editBlockReason("documents", data.order.assignee_id)}</span>
        ) : (
          <button className="btn primary" disabled={busy || data.order.id === 0} onClick={save}>
            {busy ? "Working…" : "Save billing + register AR"}
          </button>
        )}
        <span className="hint-inline">Total {dualCurrencyText(total, currency)} · {fxRateText()}</span>
        {billed && editable ? (
          <button className="btn danger" disabled={busy} onClick={remove} style={{ marginLeft: "auto" }}>
            Delete
          </button>
        ) : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
      <p className="hint-inline" style={{ display: "block", marginTop: 6 }}>
        Saving creates/updates the AR record for this order; collection & payment are tracked in the <b>AR</b> menu.
      </p>
    </div>
  );
}

// 서비스 단계 입력 필드 1개(텍스트/날짜/숫자/멀티라인/셀렉트).
function SvcFieldInput({
  field,
  value,
  onChange,
}: {
  field: SvcField;
  value: string;
  onChange: (v: string) => void;
}) {
  if (field.type === "textarea") {
    return (
      <label className="form-field" style={{ gridColumn: "1 / -1" }}>
        <span>{field.label}</span>
        <textarea className="po-textarea small" value={value} onChange={(e) => onChange(e.target.value)} />
      </label>
    );
  }
  if (field.type === "select") {
    return (
      <label className="form-field">
        <span>{field.label}</span>
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Select…</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </label>
    );
  }
  return <Field label={field.label} value={value} onChange={onChange} type={field.type ?? "text"} />;
}

// 단계별 문서 목록 — RFQ·P/O 와 동일한 FilterTable 정렬·필터 UX.
// 행 클릭 시 해당 오더 작업 모달, "+ 등록" 으로 아직 없는 오더를 골라 작성한다.
function StageList({
  kind,
  orders,
  onOpen,
  onChanged,
  leftActions,
}: {
  kind: DocKind;
  orders: DocRow[];
  onOpen: (orderId: number, kind: DocKind) => void;
  onChanged: () => void;
  leftActions?: React.ReactNode;
}) {
  const cfg = KIND_CFG[kind];
  const [registering, setRegistering] = useState(false);

  const columns: ColumnDef<DocRow>[] = [
    projectNoColumn<DocRow>({ projectNo: (r) => r.project_no, firstRfqAt: (r) => r.first_rfq_at }),
    ...identityColumns<DocRow>({
      customer: (r) => r.customer,
      vessel: (r) => r.vessel,
      workType: (r) => r.work_type,
      tradeType: (r) => r.trade_type,
    }),
    { key: "vendor", label: "Vendor", text: (r) => r.vendor || "", filter: "facet", render: (r) => <VendorName name={r.vendor || ""} /> },
    cfg.docCol,
    { key: "po_no", label: "PO No.", text: (r) => r.po_no || "" },
    ...(cfg.extra ?? []),
  ];

  // 내수(국내공급) 오더는 CI/PL/SA/POD/Tax(수출 문서)를 생략 → 목록·등록 대상에서 제외.
  const exportOrders = orders.filter((r) => r.trade_type !== "내수");
  const listRows = exportOrders.filter(cfg.has);
  // 신규 등록 대상 = 아직 이 문서가 없고, 선행 조건(CI 존재)을 충족한 오더만.
  const priorOk = (r: DocRow) =>
    kind === "pl" || kind === "sa" || kind === "tax" ? r.has_ci : true;
  const registerable = exportOrders.filter((r) => !cfg.has(r) && priorOk(r));

  return (
    <>
      <FilterTable
        tableId={`docs-${kind}`}
        rows={listRows}
        columns={columns}
        getRowKey={(r) => r.id}
        onRowClick={(r) => onOpen(r.id, kind)}
        defaultSortKey="project_no"
        defaultSortDir="desc"
        empty={`No ${cfg.label} registered.`}
        leftActions={leftActions}
        actions={
          can("documents", "create") ? (
            <button className="btn primary" onClick={() => setRegistering(true)}>
              + New {cfg.short}
            </button>
          ) : null
        }
      />

      {registering ? (
        <DocNewModal kind={kind} orders={registerable} onClose={() => setRegistering(false)} onChanged={onChanged} />
      ) : null}
    </>
  );
}

// 오더 작업 모달 — 클릭한 문서 한 종류의 편집기만 띄운다(다른 단계 탭은 보이지 않음).
// 문서 편집기 본문(모달 없음) — 상세 로드 후 종류별 편집기 렌더. 행 클릭·신규 추가 공용.
function DocEditorContent({
  orderId,
  kind,
  onChanged,
}: {
  orderId: number;
  kind: DocKind;
  onChanged: () => void;
}) {
  const [data, setData] = useState<DocumentDetail | null>(orderId ? null : emptyDocDetail());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    if (!orderId) {
      setData(emptyDocDetail()); // 오더 미선택 → 빈 폼
      return;
    }
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

  return (
    <>
      {error ? <div className="state error">API error: {error}</div> : null}
      {loading && !data ? <div className="state">Loading details...</div> : null}
      {data ? (
        <>
          <DocOrderInfo order={data.order} />
          {kind === "ci" ? (
            <CommercialInvoiceTab key={`ci-${data.order.id}-${data.ci?.id ?? 0}`} data={data} onChanged={afterChange} />
          ) : kind === "pl" ? (
            <PackingListTab key={`pl-${data.order.id}-${data.pl?.id ?? 0}`} data={data} onChanged={afterChange} />
          ) : kind === "sa" ? (
            <ShippingAdviceTab key={`sa-${data.order.id}-${data.sa?.id ?? 0}`} data={data} onChanged={afterChange} />
          ) : kind === "pod" ? (
            <PodTab key={`pod-${data.order.id}`} data={data} onChanged={afterChange} />
          ) : (
            <TaxInvoiceTab key={`tax-${data.order.id}-${data.tax?.id ?? 0}`} data={data} onChanged={afterChange} />
          )}
        </>
      ) : null}
    </>
  );
}

// 오더 작업 모달(행 클릭 수정용).
function DocEditorModal({
  orderId,
  kind,
  projectNo,
  onClose,
  onChanged,
}: {
  orderId: number;
  kind: DocKind;
  projectNo?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const title = `${KIND_CFG[kind].label}${projectNo ? ` — ${projectNo}` : ""}`;
  return (
    <Modal title={<ModalTitle label={title} projectNo={projectNo} />} onClose={onClose} wide>
      <DocEditorContent orderId={orderId} kind={kind} onChanged={onChanged} />
    </Modal>
  );
}

// 신규 추가 — 서비스 신규추가와 동일 패턴: 상단 오더 드롭다운(후보 1건이면 자동 선택)
// → 선택 시 해당 문서 편집기를 바로 표시.
function DocNewModal({
  kind,
  orders,
  onClose,
  onChanged,
}: {
  kind: DocKind;
  orders: DocRow[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const cfg = KIND_CFG[kind];
  const [orderId, setOrderId] = useState<number | "">(orders.length === 1 ? orders[0].id : "");
  const selectedOrder = orderId === "" ? null : orders.find((o) => o.id === orderId);

  return (
    <Modal title={<ModalTitle label={`New ${cfg.label} — new entry`} projectNo={selectedOrder?.project_no} />} onClose={onClose} wide>
      <div className="project-select">
        <label>Order *</label>
        <select value={orderId} onChange={(e) => setOrderId(e.target.value ? Number(e.target.value) : "")}>
          <option value="">Select…</option>
          {orders.map((o) => (
            <option key={o.id} value={o.id}>
              {o.project_no} · {o.customer} · {o.vessel || "-"}
            </option>
          ))}
        </select>
      </div>
      <DocEditorContent key={`${kind}-${orderId || 0}`} orderId={orderId === "" ? 0 : orderId} kind={kind} onChanged={onChanged} />
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
  const editable = canEditDoc(data);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !data.order.id) return;
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
          {editable ? (
            <button className="btn danger" onClick={remove} disabled={busy}>
              Delete
            </button>
          ) : null}
        </div>
      ) : (
        <div className="state">
          No {docLabel} file yet. Uploading a file (PDF · image) will <b>complete stage 9</b>.
        </div>
      )}
      <div className="form-actions">
        {editable ? (
          <label className="btn primary" style={{ cursor: busy ? "default" : "pointer" }}>
            {busy ? "Working…" : pod ? `Replace ${docLabel} file` : `Upload ${docLabel} file`}
            <input type="file" hidden accept=".pdf,image/*" onChange={onPick} disabled={busy} />
          </label>
        ) : (
          <span className="hint-inline">{editBlockReason("documents", data.order.assignee_id)}</span>
        )}
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
  const editable = canEditDoc(data);

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
        disabled={busy || !editable}
        onClick={() => toggle("consignee_confirmed_date", !data.order.consignee_confirmed_date)}
      >
        Customer confirmed {data.order.consignee_confirmed_date || "pending"}
      </button>
      <button
        className="btn"
        disabled={busy || !editable}
        onClick={() => toggle("vendor_docs_sent_date", !data.order.vendor_docs_sent_date)}
      >
        Vendor docs confirmed {data.order.vendor_docs_sent_date || "pending"}
      </button>
    </div>
  );
}

function CommercialInvoiceTab({ data, onChanged }: { data: DocumentDetail; onChanged: () => void }) {
  const [ciNo, setCiNo] = useState(data.ci?.ci_no || "");
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
  const editable = canEditDoc(data);

  async function save() {
    setBusy(true);
    try {
      await saveCommercialInvoice(data.order.id, { ci_no: ciNo, date, currency, vat_rate: vatRate, items, shipping });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="doc-tab">
      <fieldset className="form-fieldset" disabled={!editable}>
      <div className="form-grid">
        <Field label="CI No." value={ciNo} onChange={setCiNo} />
        <Field label="CI Date" value={date} onChange={setDate} type="date" />
        <label className="form-field">
          <span>Currency</span>
          <CurrencyToggle value={currency} onChange={setCurrency} />
        </label>
        <Field label="VAT Rate" value={String(vatRate)} onChange={(v) => setVatRate(num(v))} type="number" />
      </div>
      <ShippingFields shipping={shipping} setShipping={setShipping} />
      <div className="po-work-note">
        <b>Load from previous step</b>
        <span>Reload item and amount data from the linked order.</span>
      </div>
      <div className="form-actions" style={{ marginTop: 0 }}>
        <button className="btn" disabled={busy} onClick={() => setItems(normalizeItems(data.order.items))}>
          Load order items
        </button>
      </div>
      <ItemEditor items={items} setItems={setItems} packing={false} currency={currency} />
      <MissingWarning missing={data.ci?.missing || []} />
      </fieldset>
      <div className="form-actions">
        {editable ? (
          <button className="btn primary" disabled={busy || data.order.id === 0} onClick={save}>
            Save CI
          </button>
        ) : (
          <span className="hint-inline">{editBlockReason("documents", data.order.assignee_id)}</span>
        )}
        <DownloadButton orderId={data.order.id} kind="ci/pdf" disabled={!data.ci} label="Download CI PDF" />
        <span className="hint-inline">Total {dualCurrencyText(total, currency)} · {fxRateText()}</span>
      </div>
    </div>
  );
}

function PackingListTab({ data, onChanged }: { data: DocumentDetail; onChanged: () => void }) {
  const [plNo, setPlNo] = useState(data.pl?.pl_no || "");
  const [date, setDate] = useState(data.pl?.date || today());
  const seed = data.pl?.items || data.ci?.items || data.order.items;
  const [items, setItems] = useState<DocumentWorkItem[]>(normalizeItems(seed, true));
  const [busy, setBusy] = useState(false);
  const editable = canEditDoc(data);

  async function save() {
    setBusy(true);
    try {
      await savePackingList(data.order.id, { pl_no: plNo, date, items });
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
      <fieldset className="form-fieldset" disabled={!editable}>
      <div className="form-grid">
        <Field label="PL No." value={plNo} onChange={setPlNo} />
        <Field label="PL Date" value={date} onChange={setDate} type="date" />
      </div>
      <div className="po-work-note">
        <b>Load from previous step</b>
        <span>Reload packing items from the Commercial Invoice.</span>
      </div>
      <div className="form-actions" style={{ marginTop: 0 }}>
        <button className="btn" disabled={busy} onClick={() => setItems(normalizeItems(data.ci?.items || data.order.items, true))}>
          Load CI items
        </button>
      </div>
      <ItemEditor items={items} setItems={setItems} packing />
      <MissingWarning missing={data.pl?.missing || []} />
      </fieldset>
      <div className="form-actions">
        {editable ? (
          <button className="btn primary" disabled={busy} onClick={save}>
            Save PL
          </button>
        ) : (
          <span className="hint-inline">{editBlockReason("documents", data.order.assignee_id)}</span>
        )}
        <DownloadButton orderId={data.order.id} kind="pl/pdf" disabled={!data.pl} label="Download PL PDF" />
      </div>
    </div>
  );
}

function ShippingAdviceTab({ data, onChanged }: { data: DocumentDetail; onChanged: () => void }) {
  const [saNo, setSaNo] = useState(data.sa?.sa_no || "");
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
  const editable = canEditDoc(data);

  // SA 는 CI 기준으로 발송되므로 CI 가 오더와 일치하는지 발송 전 검증한다.
  const ciMissing = data.ci?.missing || [];

  async function save() {
    setBusy(true);
    try {
      await saveShippingAdvice(data.order.id, { sa_no: saNo, date, shipping });
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
      <fieldset className="form-fieldset" disabled={!editable}>
      <div className="form-grid">
        <Field label="SA No." value={saNo} onChange={setSaNo} />
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
      </fieldset>
      <div className="form-actions">
        {editable ? (
          <>
            <button className="btn primary" disabled={busy || data.order.id === 0} onClick={save}>
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
          </>
        ) : (
          <>
            <span className="hint-inline">{editBlockReason("documents", data.order.assignee_id)}</span>
            <DownloadButton orderId={data.order.id} kind="sa/pdf" disabled={!data.sa} label="Download SA PDF" />
          </>
        )}
        <span className="hint-inline">
          SMTP {data.smtp_configured ? "configured" : "not configured"} {data.sa?.sent_date ? `· sent ${data.sa.sent_date}` : ""}
        </span>
      </div>
    </div>
  );
}

function TaxInvoiceTab({ data, onChanged }: { data: DocumentDetail; onChanged: () => void }) {
  const [taxNo, setTaxNo] = useState(data.tax?.tax_no || "");
  const [date, setDate] = useState(data.tax?.date || today());
  const [supplyType, setSupplyType] = useState("Export / Zero-rated");
  const [buyerNo, setBuyerNo] = useState(data.order.customer_tax_id || "");
  const [vatRate, setVatRate] = useState(0);
  const [items, setItems] = useState<DocumentWorkItem[]>(normalizeItems(data.tax?.items || data.ci?.items || data.order.items));
  const [busy, setBusy] = useState(false);
  const currency = data.ci?.currency || "USD";
  const total = useMemo(() => items.reduce((sum, item) => sum + num(item.amount), 0), [items]);
  const editable = canEditDoc(data);

  async function save() {
    setBusy(true);
    try {
      await saveTaxInvoice(data.order.id, {
        tax_no: taxNo,
        date,
        supply_type: supplyType,
        buyer_business_no: buyerNo,
        vat_rate: vatRate,
        items,
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
      <fieldset className="form-fieldset" disabled={!editable}>
      <div className="form-grid">
        <Field label="Tax No." value={taxNo} onChange={setTaxNo} />
        <Field label="Issue Date" value={date} onChange={setDate} type="date" />
        <Field label="Supply Type" value={supplyType} onChange={setSupplyType} />
        <Field label="Buyer Business No." value={buyerNo} onChange={setBuyerNo} />
        <Field label="VAT Rate" value={String(vatRate)} onChange={(v) => setVatRate(num(v))} type="number" />
      </div>
      <div className="po-work-note">
        <b>Load from previous step</b>
        <span>Reload item and amount data from the Commercial Invoice.</span>
      </div>
      <div className="form-actions" style={{ marginTop: 0 }}>
        <button className="btn" disabled={busy} onClick={() => setItems(normalizeItems(data.ci?.items || data.order.items))}>
          Load CI items
        </button>
      </div>
      <ItemEditor items={items} setItems={setItems} packing={false} currency={currency} />
      </fieldset>
      <div className="form-actions">
        {editable ? (
          <button className="btn primary" disabled={busy} onClick={save}>
            Create Tax Invoice Data + register AR
          </button>
        ) : (
          <span className="hint-inline">{editBlockReason("documents", data.order.assignee_id)}</span>
        )}
        <DownloadButton orderId={data.order.id} kind="tax/xlsx" disabled={!data.tax} label="Download Tax XLSX" />
        <span className="hint-inline">Total {dualCurrencyText(total, currency)} · {fxRateText()}</span>
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
  currency = "USD",
}: {
  items: DocumentWorkItem[];
  setItems: (items: DocumentWorkItem[]) => void;
  packing: boolean;
  currency?: string;
}) {
  function patch(i: number, key: keyof DocumentWorkItem, value: string) {
    const next = [...items];
    const item = { ...next[i], [key]: ["qty", "unit_price", "amount"].includes(String(key)) ? parseAmountInput(value) || 0 : value };
    if (!packing && (key === "qty" || key === "unit_price")) {
      item.amount = num(item.qty) * num(item.unit_price);
    }
    next[i] = item;
    setItems(next);
  }
  const total = items.reduce((sum, item) => sum + num(item.amount), 0);

  return (
    <div className="table-wrap">
      <table className="mini wide">
        <thead>
          <tr>
            <th className="seq">No.</th>
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
            <tr key={i} className={itemRowClass(i)}>
              <td className="seq">{i + 1}</td>
              <td><textarea {...gridCellProps(i, 0)} className="wrapcell" rows={1} value={item.part_no || ""} onChange={(e) => patch(i, "part_no", e.target.value)} /></td>
              <td><textarea {...gridCellProps(i, 1)} className="desc" rows={1} value={item.description || ""} onChange={(e) => patch(i, "description", e.target.value)} /></td>
              <td><textarea {...gridCellProps(i, 2)} className="wrapcell" rows={1} value={item.maker || ""} onChange={(e) => patch(i, "maker", e.target.value)} /></td>
              <td><input {...gridCellProps(i, 3)} className="num" value={amountInputValue(item.qty)} onChange={(e) => patch(i, "qty", e.target.value)} /></td>
              <td><input {...gridCellProps(i, 4)} value={item.unit || "PCS"} onChange={(e) => patch(i, "unit", e.target.value)} /></td>
              {packing ? (
                <>
                  <td><input {...gridCellProps(i, 5)} value={item.package || ""} onChange={(e) => patch(i, "package", e.target.value)} /></td>
                  <td><input {...gridCellProps(i, 6)} value={String(item.net_weight || "")} onChange={(e) => patch(i, "net_weight", e.target.value)} /></td>
                  <td><input {...gridCellProps(i, 7)} value={String(item.gross_weight || "")} onChange={(e) => patch(i, "gross_weight", e.target.value)} /></td>
                  <td><input {...gridCellProps(i, 8)} value={item.dimension || ""} onChange={(e) => patch(i, "dimension", e.target.value)} /></td>
                </>
              ) : (
                <>
                  <td><input {...gridCellProps(i, 5)} className="num" value={amountInputValue(item.unit_price)} onChange={(e) => patch(i, "unit_price", e.target.value)} /></td>
                  <td><input {...gridCellProps(i, 6)} className="num" value={amountInputValue(item.amount)} onChange={(e) => patch(i, "amount", e.target.value)} /></td>
                  <td><input {...gridCellProps(i, 7)} value={item.hs_code || ""} onChange={(e) => patch(i, "hs_code", e.target.value)} /></td>
                </>
              )}
              <td><textarea {...gridCellProps(i, packing ? 9 : 8)} className="wrapcell" rows={1} value={item.remark || ""} onChange={(e) => patch(i, "remark", e.target.value)} /></td>
              <td>
                <button className="row-del" onClick={() => setItems(items.filter((_, idx) => idx !== i))}>×</button>
              </td>
            </tr>
          ))}
        </tbody>
        {!packing ? (
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
        ) : null}
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

// 선택한 오더의 기본정보 — Order 드롭다운과 편집 영역 사이(편집기 상단)에 표시.
// 진행현황 상세 모달과 동일한 intl-meta(대문자 라벨 + 값) 디자인 패턴.
function DocOrderInfo({ order }: { order: DocumentDetail["order"] }) {
  if (!order.id) return null;
  return (
    <dl className="intl-meta" style={{ margin: "0 0 14px" }}>
      <div><dt>Project No.</dt><dd><b>{order.project_no || "—"}</b></dd></div>
      <div><dt>First RFQ at</dt><dd>{(order.first_rfq_at || "").replace("T", " ") || "—"}</dd></div>
      <div><dt>Type</dt><dd>{tr(order.work_type) || "—"}</dd></div>
      <div><dt>Trade type</dt><dd>{tr(order.trade_type) || "—"}</dd></div>
      <div><dt>Project</dt><dd>{order.project_title || "—"}</dd></div>
      <div><dt>Customer</dt><dd>{order.customer || "—"}</dd></div>
      <div><dt>Vendor</dt><dd>{order.vendor || "—"}</dd></div>
      <div><dt>Vessel</dt><dd>{order.vessel || "—"}</dd></div>
      <div><dt>PO No.</dt><dd>{order.po_no || "—"}</dd></div>
      <div><dt>Items</dt><dd>{order.items.length}</dd></div>
      <div><dt>Customer Tax ID</dt><dd>{order.customer_tax_id || "—"}</dd></div>
    </dl>
  );
}

// 오더 미선택 시 편집 폼을 빈칸으로 보여주기 위한 합성 빈 상세(order.id===0).
function emptyDocDetail(): DocumentDetail {
  return {
    order: {
      id: 0, rfq_id: 0, assignee_id: 0, po_no: "", date: "", status: "",
      customer: "", customer_email: "", customer_tax_id: "", vessel: "",
      project_title: "", project_no: "", first_rfq_at: "", work_type: "", vendor: "", trade_type: "", service_info: {},
      tracking_token: "", consignee_confirmed_date: "", vendor_docs_sent_date: "",
      items: [],
    },
    pod: null,
    stage_done: { "7": false, "8": false, "9": false, "11": false, "12": false },
    ci: null, pl: null, sa: null, tax: null,
    smtp_configured: false,
  };
}
