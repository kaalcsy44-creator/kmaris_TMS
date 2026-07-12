"use client";

import { useEffect, useId, useMemo, useState } from "react";
import {
  documentDownloadUrl,
  fetchDocumentDetail,
  saveCommercialInvoice,
  deleteCommercialInvoice,
  savePackingList,
  deletePackingList,
  saveShippingAdvice,
  deleteShippingAdvice,
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
import Modal from "@/components/common/Modal";
import { ModalTitle } from "@/components/common/BaseMeta";
import ProjectNo from "@/components/common/ProjectNo";
import CurrencyToggle from "@/components/common/CurrencyToggle";
import {
  amountInputValue,
  DeleteSelectedButton,
  deleteSelectedRows,
  DualCurrencyAmount,
  dualCurrencyText,
  fxRateText,
  gridCellProps,
  ItemSelectCell,
  ItemSelectHeaderCell,
  itemRowClass,
  parseAmountInput,
  useRowSelection,
} from "@/components/common/itemTable";
import {
  useItemGrid,
  ItemTh,
  ItemGridStyle,
  ItemColsButton,
  type ItemCol,
} from "@/components/common/itemGrid";

const today = () => new Date().toISOString().slice(0, 10);

// 문서 편집 권한 = 역할 권한(documents.edit) × 담당(PIC) 소유권. 없으면 읽기전용.
function canEditDoc(data: DocumentDetail | null | undefined): boolean {
  return can("documents", "edit") && canEditDeal(data?.order.assignee_id);
}

type StageTab = "s7" | "s8" | "s9";
type WorkView = "parts" | "service";

// 문서 종류 → 표시 라벨(작업 모달 제목 등).
type DocKind = "ci" | "pl" | "sa" | "pod" | "tax";
const KIND_CFG: Record<DocKind, { label: string }> = {
  ci: { label: "Commercial Invoice" },
  pl: { label: "Packing List" },
  sa: { label: "Shipping Advice" },
  pod: { label: "POD" },
  tax: { label: "Tax Invoice" },
};

type SvcStage = 7 | 8 | 9;

// 프로젝트 팝업(진행현황) 내 문서 작업 — 이 오더의 문서(CI/PL/SA/POD/Tax) 또는 서비스
// 단계를 인라인으로 편집한다. 전역 목록·신규 등록은 진행현황 통합 목록으로 이전됨.
export function DocumentsOverview({
  initialOrderId = null,
  initialStage = null,
  initialView = null,
}: {
  initialOrderId?: number | null;
  initialStage?: number | null;
  initialView?: WorkView | null;
} = {}) {
  const stageFromProp = (s: number | null): StageTab =>
    s === 8 ? "s8" : s === 9 ? "s9" : "s7";
  const [workView, setWorkView] = useState<WorkView>(initialView === "service" ? "service" : "parts");
  const [stage, setStage] = useState<StageTab>(stageFromProp(initialStage));
  const [readyDoc, setReadyDoc] = useState<"ci" | "pl" | "sa">("ci"); // 7단계 하위(CI/PL/SA)

  const { data: overview, refresh } = useCachedData(
    "documents:overview",
    fetchDocumentsOverview
  );
  const orders = overview?.rows ?? [];
  const orderId = initialOrderId ?? 0;

  // 딥링크(업무유형·단계) 변화 시 동기화.
  useEffect(() => {
    if (initialView === "service" || initialView === "parts") setWorkView(initialView);
  }, [initialView]);
  useEffect(() => {
    if (initialStage && initialStage >= 7 && initialStage <= 9) setStage(stageFromProp(initialStage));
  }, [initialStage]);

  function load() {
    invalidateCache("dashboard");
    invalidateCache("pipeline");
    return refresh();
  }

  const svcStage: SvcStage = stage === "s7" ? 7 : stage === "s8" ? 8 : 9;

  if (!orderId) {
    return (
      <div className="project-work-panel">
        <div className="project-work-empty">No order for this project yet.</div>
      </div>
    );
  }
  const projectNo = orders.find((o) => o.id === orderId)?.project_no;
  if (workView === "service") {
    return (
      <div className="action-tabs embedded">
        <ServiceEditorModal
          orderId={orderId}
          svc={svcStage}
          projectNo={projectNo}
          onClose={load}
          onChanged={load}
          inline
        />
      </div>
    );
  }
  const kind: DocKind = stage === "s7" ? readyDoc : stage === "s8" ? "pod" : "tax";
  return (
    <div className="action-tabs embedded">
      {stage === "s7" ? (
        <div className="seg-tabs" style={{ marginBottom: 12 }}>
          <button className={readyDoc === "ci" ? "on" : ""} onClick={() => setReadyDoc("ci")}>
            Commercial Invoice
          </button>
          <button className={readyDoc === "pl" ? "on" : ""} onClick={() => setReadyDoc("pl")}>
            Packing List
          </button>
          <button className={readyDoc === "sa" ? "on" : ""} onClick={() => setReadyDoc("sa")}>
            Shipping Advice
          </button>
        </div>
      ) : null}
      <DocEditorModal
        key={kind}
        orderId={orderId}
        kind={kind}
        projectNo={projectNo}
        onClose={load}
        onChanged={load}
        inline
      />
    </div>
  );
}

// ── 서비스 업무 7·8·9단계 (구 8 'Arrangement'는 7 Readiness 로 흡수) ─────────────
const SVC_CFG: Record<SvcStage, { label: string; btn: string; done: (r: DocRow) => boolean }> = {
  7: { label: "Service Readiness", btn: "Service Readiness", done: (r) => r.svc_ready_done },
  8: { label: "Service Complete · Report", btn: "Service Report", done: (r) => r.has_pod },
  9: { label: "Tax Invoice · Billing", btn: "Tax Invoice · Billing", done: (r) => r.svc_billed },
};

// 서비스 단계별 입력 필드 스키마(7·8). 9는 청구 폼으로 별도 처리.
type SvcField = { key: string; label: string; type?: "text" | "date" | "number" | "textarea" | "select"; options?: string[] };
const SVC_FIELDS: Record<7 | 8, SvcField[]> = {
  7: [
    { key: "service_type", label: "Service type", type: "select", options: ["Inspection", "Repair", "Commissioning", "Overhaul", "Survey", "Other"] },
    { key: "scope", label: "Scope", type: "textarea" },
    { key: "scheduled_from", label: "Scheduled from", type: "date" },
    { key: "scheduled_to", label: "Scheduled to", type: "date" },
    { key: "location", label: "Location (port / yard / onboard)" },
    { key: "engineers", label: "Assigned engineer(s)" },
    { key: "materials", label: "Required spares / tools", type: "textarea" },
    // 구 8 'Service Arrangement' 흡수 — 파견/비자/숙소/현장연락/확정일정
    { key: "dispatch_from", label: "Dispatch from", type: "date" },
    { key: "dispatch_to", label: "Return on", type: "date" },
    { key: "visa_status", label: "Visa / permit status" },
    { key: "accommodation", label: "Accommodation / logistics" },
    { key: "site_contact", label: "On-site contact" },
    { key: "confirmed_schedule", label: "Confirmed schedule" },
    { key: "notes", label: "Notes", type: "textarea" },
  ],
  8: [
    { key: "performed_date", label: "Service performed date", type: "date" },
    { key: "work_summary", label: "Work performed summary", type: "textarea" },
    { key: "findings", label: "Findings / recommendations", type: "textarea" },
    { key: "man_hours", label: "Man-hours", type: "number" },
    { key: "customer_accepted", label: "Customer acceptance (name / date)" },
    { key: "notes", label: "Notes", type: "textarea" },
  ],
};

// 서비스 단계 편집기(모달 없는 본문) — 상세 로드 후 단계별 폼 렌더. 신규/수정 공용.
function ServiceStageEditor({
  orderId,
  svc,
  onChanged,
  onClose,
  hideInfo,
}: {
  orderId: number;
  svc: SvcStage;
  onChanged: () => void;
  onClose: () => void;
  hideInfo?: boolean;
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
      {loading && !data ? <div className="state">Loading details…</div> : null}
      {data ? (
        <>
          {hideInfo ? null : <DocOrderInfo order={data.order} />}
          {svc === 9 ? (
            <ServiceBillingForm key={`svc9-${data.order.id}`} data={data} onChanged={afterChange} onClose={onClose} />
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
  inline,
}: {
  orderId: number;
  svc: SvcStage;
  projectNo?: string;
  onClose: () => void;
  onChanged: () => void;
  inline?: boolean;
}) {
  const title = `${SVC_CFG[svc].label}${projectNo ? ` — ${projectNo}` : ""}`;
  return (
    <Modal title={<ModalTitle label={title} projectNo={projectNo} />} onClose={onClose} wide inline={inline}>
      <ServiceStageEditor orderId={orderId} svc={svc} onChanged={onChanged} onClose={onClose} hideInfo={inline} />
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
        <span className="hint-inline">PDF · image. Uploading completes stage 8.</span>
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
  const fields = SVC_FIELDS[svc as 7 | 8];
  const saved = data.order.service_info?.[String(svc)] ?? {};
  const hasSaved = !!data.order.service_info?.[String(svc)];
  const [form, setForm] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of fields) init[f.key] = String(saved[f.key] ?? "");
    return init;
  });
  const done = Boolean(data.stage_done[String(svc) as "7" | "8"]) || (svc === 8 && !!data.pod);
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
      // 8단계(Complete·Report)는 리포트 파일(POD) 업로드가 완료 근거이므로 stage_dates 완료는 생략(파일 기준).
      await saveServiceStage(data.order.id, svc, form, svc === 8 ? false : complete);
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
      {svc === 8 ? <ServiceReportUpload data={data} onChanged={onChanged} /> : null}

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
      <ItemEditor
        items={items}
        setItems={setItems}
        packing={false}
        currency={currency}
        tableId="svc-billing-items"
        headerActions={
          <button className="btn sm" disabled={busy} onClick={() => setItems(normalizeItems(data.order.items))}>
            Load order items
          </button>
        }
      />
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

// 오더 작업 모달 — 클릭한 문서 한 종류의 편집기만 띄운다(다른 단계 탭은 보이지 않음).
// 문서 편집기 본문(모달 없음) — 상세 로드 후 종류별 편집기 렌더. 행 클릭·신규 추가 공용.
function DocEditorContent({
  orderId,
  kind,
  onChanged,
  hideInfo,
}: {
  orderId: number;
  kind: DocKind;
  onChanged: () => void;
  hideInfo?: boolean;
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
      {loading && !data ? <div className="state">Loading details…</div> : null}
      {data ? (
        <>
          {hideInfo ? null : <DocOrderInfo order={data.order} />}
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
  inline,
}: {
  orderId: number;
  kind: DocKind;
  projectNo?: string;
  onClose: () => void;
  onChanged: () => void;
  inline?: boolean;
}) {
  const title = `${KIND_CFG[kind].label}${projectNo ? ` — ${projectNo}` : ""}`;
  return (
    <Modal title={<ModalTitle label={title} projectNo={projectNo} />} onClose={onClose} wide inline={inline}>
      <DocEditorContent orderId={orderId} kind={kind} onChanged={onChanged} hideInfo={inline} />
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
    if (!confirm("Delete the POD file? (stage 8 completion will be undone)")) return;
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
          No {docLabel} file yet. Uploading a file (PDF · image) will <b>complete stage 8</b>.
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
  // HS Code 는 문서 단위 단일 값(선적 단위) — shipping.hs_code 에 저장하고 저장 시 전 품목에 반영.
  const firstHs = (data.ci?.items || data.order.items || []).find((i) => i.hs_code)?.hs_code || "";
  const [shipping, setShipping] = useState<Record<string, string>>({
    port_loading: "Busan, Korea",
    port_discharge: "",
    carrier: "TBD",
    bl_awb_no: "TBD",
    etd: "",
    eta: "",
    hs_code: firstHs,
    ...defaultMarkFields(data.order),
    ...(data.ci?.shipping || {}),
  });
  const [busy, setBusy] = useState(false);
  const total = useMemo(() => items.reduce((sum, i) => sum + num(i.amount), 0), [items]);
  const editable = canEditDoc(data);

  async function save() {
    setBusy(true);
    try {
      // 단일 HS Code 를 모든 품목에 반영해 PDF(품목별 HS 열)와 일관되게 유지.
      const outItems = items.map((it) => ({ ...it, hs_code: shipping.hs_code || it.hs_code || "" }));
      // 구조화 Shipping Marks → PDF 출력용 문자열로 합성해 함께 저장.
      const outShipping = { ...shipping, shipping_marks: composeShippingMarks(shipping) };
      await saveCommercialInvoice(data.order.id, { ci_no: ciNo, date, currency, vat_rate: vatRate, items: outItems, shipping: outShipping });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  // 저장하지 않은 편집을 마지막 저장값으로 되돌린다.
  function cancel() {
    setCiNo(data.ci?.ci_no || "");
    setDate(data.ci?.date || today());
    setCurrency(data.ci?.currency || "USD");
    setVatRate(data.ci?.vat_rate ?? 0);
    setItems(normalizeItems(data.ci?.items || data.order.items));
    setShipping({
      port_loading: "Busan, Korea",
      port_discharge: "",
      carrier: "TBD",
      bl_awb_no: "TBD",
      etd: "",
      eta: "",
      hs_code: firstHs,
      ...defaultMarkFields(data.order),
      ...(data.ci?.shipping || {}),
    });
  }

  async function del() {
    if (!data.ci) return;
    if (!confirm("Delete this Commercial Invoice? (its Packing List is also removed)")) return;
    setBusy(true);
    try {
      await deleteCommercialInvoice(data.order.id);
      onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="doc-tab">
      <fieldset className="form-fieldset" disabled={!editable}>
      <div className="doc-cols">
      <div className="doc-col">
      <div className="sub-h">Basic info</div>
      {/* 좌열: 문서정보(4)·선적정보(7)·HS Code(1) = 12필드, 절반폭 2열 배치. */}
      <div className="form-grid doc-form-grid">
        <Field label="CI No." value={ciNo} onChange={setCiNo} />
        <Field label="CI Date" value={date} onChange={setDate} type="date" />
        <label className="form-field">
          <span>Currency</span>
          <CurrencyToggle value={currency} onChange={setCurrency} />
        </label>
        <VatRateSelect value={String(vatRate)} onChange={(v) => setVatRate(num(v))} />
        <ShippingFields shipping={shipping} setShipping={setShipping} />
        <Field label="HS Code (optional)" value={shipping.hs_code || ""} onChange={(v) => setShipping({ ...shipping, hs_code: v })} />
      </div>
      </div>
      <ShippingMarksSection shipping={shipping} setShipping={setShipping} />
      </div>
      <ItemEditor
        items={items}
        setItems={setItems}
        packing={false}
        currency={currency}
        tableId="ci-items"
        headerActions={
          <button className="btn sm" disabled={busy} onClick={() => setItems(normalizeItems(data.order.items))}>
            Load order items
          </button>
        }
      />
      <MissingWarning missing={data.ci?.missing || []} />
      </fieldset>
      <div className="form-actions">
        <DocPreviewButton orderId={data.order.id} kind="ci/pdf" filename="Commercial Invoice.pdf" disabled={!data.ci} />
        {editable ? (
          <>
            <button className="btn primary" disabled={busy || data.order.id === 0} onClick={save}>
              Save
            </button>
            <button className="btn" disabled={busy} onClick={cancel}>
              Cancel
            </button>
            {data.ci ? (
              <button className="btn danger" disabled={busy} onClick={del}>
                Delete
              </button>
            ) : null}
          </>
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

  function cancel() {
    setPlNo(data.pl?.pl_no || "");
    setDate(data.pl?.date || today());
    setItems(normalizeItems(data.pl?.items || data.ci?.items || data.order.items, true));
  }

  async function del() {
    if (!data.pl) return;
    if (!confirm("Delete this Packing List?")) return;
    setBusy(true);
    try {
      await deletePackingList(data.order.id);
      onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
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
      <ItemEditor
        items={items}
        setItems={setItems}
        packing
        tableId="pl-items"
        headerActions={
          <button className="btn sm" disabled={busy} onClick={() => setItems(normalizeItems(data.ci?.items || data.order.items, true))}>
            Load CI items
          </button>
        }
      />
      <MissingWarning missing={data.pl?.missing || []} />
      </fieldset>
      <div className="form-actions">
        <DocPreviewButton orderId={data.order.id} kind="pl/pdf" filename="Packing List.pdf" disabled={!data.pl} />
        {editable ? (
          <>
            <button className="btn primary" disabled={busy} onClick={save}>
              Save
            </button>
            <button className="btn" disabled={busy} onClick={cancel}>
              Cancel
            </button>
            {data.pl ? (
              <button className="btn danger" disabled={busy} onClick={del}>
                Delete
              </button>
            ) : null}
          </>
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
    port_loading: "Busan, Korea",
    port_discharge: "",
    carrier: "TBD",
    bl_awb_no: "TBD",
    etd: "",
    eta: "",
    ...defaultMarkFields(data.order),
    ...(data.ci?.shipping || {}), // CI 의 선적정보·Shipping Marks(sm_*) 상속
    ...(data.sa?.shipping || {}), // SA 자체 저장값 우선
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
      const outShipping = { ...shipping, shipping_marks: composeShippingMarks(shipping) };
      await saveShippingAdvice(data.order.id, { sa_no: saNo, date, shipping: outShipping });
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

  function cancel() {
    setSaNo(data.sa?.sa_no || "");
    setDate(data.sa?.date || today());
    setShipping({
      port_loading: "Busan, Korea",
      port_discharge: "",
      carrier: "TBD",
      bl_awb_no: "TBD",
      etd: "",
      eta: "",
      ...defaultMarkFields(data.order),
      ...(data.ci?.shipping || {}),
      ...(data.sa?.shipping || {}),
    });
  }

  async function del() {
    if (!data.sa) return;
    if (!confirm("Delete this Shipping Advice?")) return;
    setBusy(true);
    try {
      await deleteShippingAdvice(data.order.id);
      onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="doc-tab">
      {/* 8단계(Delivery arrangement) 마일스톤 — Customer 확인 / Vendor 서류 확인 */}
      <OrderMilestones data={data} onChanged={onChanged} />
      <fieldset className="form-fieldset" disabled={!editable}>
      <div className="doc-cols">
      <div className="doc-col">
      <div className="sub-h">Basic info</div>
      <div className="form-grid doc-form-grid">
        <Field label="SA No." value={saNo} onChange={setSaNo} />
        <Field label="SA Date" value={date} onChange={setDate} type="date" />
        <ShippingFields shipping={shipping} setShipping={setShipping} />
      </div>
      </div>
      <ShippingMarksSection shipping={shipping} setShipping={setShipping} />
      </div>
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
        <DocPreviewButton orderId={data.order.id} kind="sa/pdf" filename="Shipping Advice.pdf" disabled={!data.sa} />
        {editable ? (
          <>
            <button className="btn primary" disabled={busy || data.order.id === 0} onClick={save}>
              Save
            </button>
            <button className="btn" disabled={busy} onClick={cancel}>
              Cancel
            </button>
            {data.sa ? (
              <button className="btn danger" disabled={busy} onClick={del}>
                Delete
              </button>
            ) : null}
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
      <div className="form-grid doc-form-grid">
        <Field label="Tax No." value={taxNo} onChange={setTaxNo} />
        <Field label="Issue Date" value={date} onChange={setDate} type="date" />
        <Field label="Supply Type" value={supplyType} onChange={setSupplyType} />
        <Field label="Buyer Business No." value={buyerNo} onChange={setBuyerNo} />
        <VatRateSelect value={String(vatRate)} onChange={(v) => setVatRate(num(v))} />
      </div>
      <ItemEditor
        items={items}
        setItems={setItems}
        packing={false}
        currency={currency}
        tableId="tax-items"
        headerActions={
          <button className="btn sm" disabled={busy} onClick={() => setItems(normalizeItems(data.ci?.items || data.order.items))}>
            Load CI items
          </button>
        }
      />
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

// 선적정보 입력 필드들 — 래핑 그리드 없이 Field 조각만 반환해 상위 폼 그리드에
// 함께 배치(문서정보와 같은 4열 트랙에 정렬)한다.
function ShippingFields({
  shipping,
  setShipping,
}: {
  shipping: Record<string, string>;
  setShipping: (v: Record<string, string>) => void;
}) {
  const set = (key: string) => (v: string) => setShipping({ ...shipping, [key]: v });
  return (
    <>
      <ComboField label="Port of Loading" value={shipping.port_loading || ""} onChange={set("port_loading")} options={PORT_OPTIONS} />
      <ComboField label="Port of Discharge" value={shipping.port_discharge || ""} onChange={set("port_discharge")} options={PORT_OPTIONS} />
      <ComboField label="Carrier" value={shipping.carrier || ""} onChange={set("carrier")} options={CARRIER_OPTIONS} />
      <Field label="B/L or AWB No." value={shipping.bl_awb_no || ""} onChange={set("bl_awb_no")} />
      <Field label="ETD" value={shipping.etd || ""} onChange={set("etd")} type="date" />
      <Field label="ETA" value={shipping.eta || ""} onChange={set("eta")} type="date" />
    </>
  );
}

// 선적 마크(Shipping Marks) — 구조화 입력 섹션(Item list 와 동일 위계의 제목).
// 각 항목은 shipping.sm_* 키에 저장하고, 저장 시 composeShippingMarks 로 여러 줄
// 문자열(shipping.shipping_marks)을 만들어 PDF 에 출력한다.
function ShippingMarksSection({
  shipping,
  setShipping,
}: {
  shipping: Record<string, string>;
  setShipping: (v: Record<string, string>) => void;
}) {
  const set = (key: string) => (v: string) => setShipping({ ...shipping, [key]: v });
  const handling = (shipping.sm_handling || "").split(",").map((s) => s.trim()).filter(Boolean);
  const toggleHandling = (opt: string) => {
    const next = handling.includes(opt) ? handling.filter((h) => h !== opt) : [...handling, opt];
    setShipping({ ...shipping, sm_handling: next.join(", ") });
  };
  return (
    <div className="sm-section">
      <div className="sub-h">Shipping Marks</div>
      <div className="form-grid doc-form-grid">
        <ComboField label="Shipping mark type" value={shipping.sm_type ?? ""} onChange={set("sm_type")} options={SM_TYPE_OPTIONS} />
        <Field label="Vessel Name" value={shipping.sm_vessel ?? ""} onChange={set("sm_vessel")} />
        <Field label="C/O Company / Ship Agent" value={shipping.sm_consignee ?? ""} onChange={set("sm_consignee")} />
        <Field label="P.O. No." value={shipping.sm_po_no ?? ""} onChange={set("sm_po_no")} />
        <Field label="Reference No." value={shipping.sm_ref_no ?? ""} onChange={set("sm_ref_no")} />
        <Field label="Description of Goods" value={shipping.sm_desc ?? ""} onChange={set("sm_desc")} />
        <ComboField label="Case No." value={shipping.sm_case_no ?? ""} onChange={set("sm_case_no")} options={CASE_NO_OPTIONS} />
        <Field label="Total Number of Cases" value={shipping.sm_total_cases ?? ""} onChange={set("sm_total_cases")} type="number" />
        {/* 무게·치수는 넓은 폭이 필요 없어 한 행에 좁은 입력란으로 모아 배치. */}
        <div className="form-field sm-metrics">
          <span>Weight (kg) &amp; Dimension (mm)</span>
          <div className="sm-metrics-row">
            <span className="sm-metric"><em>N.W.</em><input type="number" value={shipping.sm_net_weight ?? ""} onChange={(e) => set("sm_net_weight")(e.target.value)} /></span>
            <span className="sm-metric"><em>G.W.</em><input type="number" value={shipping.sm_gross_weight ?? ""} onChange={(e) => set("sm_gross_weight")(e.target.value)} /></span>
            <span className="sm-metrics-sep" />
            <span className="sm-metric"><em>L</em><input type="number" value={shipping.sm_dim_l ?? ""} onChange={(e) => set("sm_dim_l")(e.target.value)} /></span>
            <em className="sm-times">×</em>
            <span className="sm-metric"><em>W</em><input type="number" value={shipping.sm_dim_w ?? ""} onChange={(e) => set("sm_dim_w")(e.target.value)} /></span>
            <em className="sm-times">×</em>
            <span className="sm-metric"><em>H</em><input type="number" value={shipping.sm_dim_h ?? ""} onChange={(e) => set("sm_dim_h")(e.target.value)} /></span>
          </div>
        </div>
        <ComboField label="Port of Delivery" value={shipping.sm_port_delivery ?? ""} onChange={set("sm_port_delivery")} options={PORT_DELIVERY_OPTIONS} />
        <ComboField label="Final Destination" value={shipping.sm_final_dest ?? ""} onChange={set("sm_final_dest")} options={FINAL_DEST_OPTIONS} />
        <ComboField label="Country of Origin" value={shipping.sm_origin ?? ""} onChange={set("sm_origin")} options={ORIGIN_OPTIONS} />
        <div className="form-field sm-handling">
          <span>Handling Instructions</span>
          <div className="sm-handling-opts">
            {HANDLING_OPTIONS.map((opt) => (
              <label key={opt} className="sm-check">
                <input type="checkbox" checked={handling.includes(opt)} onChange={() => toggleHandling(opt)} />
                <span>{opt}</span>
              </label>
            ))}
          </div>
        </div>
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

// 자주 쓰는 값 제안 목록(datalist) — 목록 선택도, 직접 입력도 모두 가능한 콤보박스.
const PORT_OPTIONS = [
  "Busan, Korea", "Incheon, Korea", "Gwangyang, Korea", "Ulsan, Korea", "Pyeongtaek, Korea",
  "Shanghai, China", "Ningbo, China", "Qingdao, China", "Hong Kong",
  "Singapore", "Port Klang, Malaysia", "Tokyo, Japan", "Kobe, Japan",
  "Rotterdam, Netherlands", "Hamburg, Germany", "Antwerp, Belgium",
  "Los Angeles, USA", "Long Beach, USA", "Jebel Ali, UAE",
];
const CARRIER_OPTIONS = [
  "TBD", "Maersk", "MSC", "CMA CGM", "HMM", "ONE", "Hapag-Lloyd", "Evergreen", "COSCO", "Yang Ming",
  "Korean Air Cargo", "Asiana Cargo", "DHL", "FedEx", "UPS",
];
const UNIT_OPTIONS = ["PCS", "SET", "EA", "UNIT", "KG", "M", "M2", "M3", "L", "ROLL", "BOX", "PAIR", "LOT"];

// ── Shipping Marks 섹션 선택지 ─────────────────────────────────────────────
const SM_TYPE_OPTIONS = ["SHIP'S SPARES IN TRANSIT", "SHIP'S STORES", "COMMERCIAL CARGO"];
const PORT_DELIVERY_OPTIONS = ["Busan, Korea", "Incheon, Korea", "Gwangyang, Korea", "Ulsan, Korea", "Pyeongtaek, Korea"];
const FINAL_DEST_OPTIONS = [
  "Hong Kong", "Singapore", "Shanghai, China", "Ningbo, China", "Tokyo, Japan",
  "Kaohsiung, Taiwan", "Rotterdam, Netherlands", "Hamburg, Germany", "Los Angeles, USA", "Jebel Ali, UAE",
];
const ORIGIN_OPTIONS = ["Made in Korea", "Made in China", "Made in Japan", "Made in Germany", "Made in USA"];
const CASE_NO_OPTIONS = ["1-UP", "1 OF 1", "1-2", "1-3", "1-5", "1-10"];
const HANDLING_OPTIONS = ["THIS SIDE UP", "KEEP DRY", "FRAGILE", "HANDLE WITH CARE", "DO NOT STACK", "USE NO HOOKS", "KEEP AWAY FROM HEAT"];

// Shipping Marks 구조화 필드 기본값(오더 정보로 프리필). 저장값이 있으면 덮어쓴다.
function defaultMarkFields(order: { vessel?: string; po_no?: string; customer?: string; kms_order_no?: string }): Record<string, string> {
  return {
    sm_type: "SHIP'S SPARES IN TRANSIT",
    sm_vessel: order.vessel || "",
    sm_consignee: order.customer || "",
    sm_po_no: order.po_no || "",
    // Reference No. = 해당 오더의 KMS-ORD 번호(발주서 P/O No.). 없으면 템플릿 안내값.
    sm_ref_no: order.kms_order_no || "KMS-ORD-yymm-nnn",
    sm_desc: "MARINE SPARE PARTS",
    sm_case_no: "1-UP",
    sm_port_delivery: "Busan, Korea",
    sm_origin: "Made in Korea",
  };
}

// 구조화 Shipping Marks 필드 → PDF 출력용 여러 줄 마크 문자열(비어있는 항목은 생략).
function composeShippingMarks(s: Record<string, string>): string {
  const lines: string[] = [];
  const push = (v?: string) => { if (v && v.trim()) lines.push(v.trim()); };
  push(s.sm_type);
  if (s.sm_consignee) push(`C/O ${s.sm_consignee}`);
  if (s.sm_vessel) push(`M/V ${s.sm_vessel.toUpperCase()}`);
  if (s.sm_po_no) push(`P.O. NO.: ${s.sm_po_no}`);
  if (s.sm_ref_no) push(`REF. NO.: ${s.sm_ref_no}`);
  push(s.sm_desc);
  if (s.sm_case_no) push(`CASE NO.: ${s.sm_case_no}`);
  if (s.sm_total_cases) push(`TOTAL: ${s.sm_total_cases} CASE(S)`);
  if (s.sm_net_weight) push(`N.W.: ${s.sm_net_weight} KG`);
  if (s.sm_gross_weight) push(`G.W.: ${s.sm_gross_weight} KG`);
  const dim = [s.sm_dim_l, s.sm_dim_w, s.sm_dim_h];
  if (dim.some((v) => v && v.trim())) push(`DIM.: ${dim.map((v) => (v && v.trim()) || "-").join(" × ")} MM`);
  if (s.sm_port_delivery) push(`PORT OF DELIVERY: ${s.sm_port_delivery}`);
  if (s.sm_final_dest) push(`FINAL DESTINATION: ${s.sm_final_dest}`);
  push(s.sm_origin);
  push(s.sm_handling);
  return lines.join("\n");
}

// 콤보박스 입력(목록 제안 + 자유 입력). Field 와 동일한 form-field 레이아웃.
function ComboField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  const listId = useId();
  return (
    <label className="form-field">
      <span>{label}</span>
      <input list={listId} value={value} onChange={(e) => onChange(e.target.value)} />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </label>
  );
}

// VAT 세율 선택(0% 영세율 / 10% 표준). 기존 값이 목록에 없으면 그 값도 노출.
function VatRateSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const known = ["0", "10"];
  return (
    <label className="form-field">
      <span>VAT Rate</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="0">0%</option>
        <option value="10">10%</option>
        {known.includes(value) ? null : <option value={value}>{value}%</option>}
      </select>
    </label>
  );
}

function ItemEditor({
  items,
  setItems,
  packing,
  currency = "USD",
  tableId,
  headerActions,
}: {
  items: DocumentWorkItem[];
  setItems: (items: DocumentWorkItem[]) => void;
  packing: boolean;
  currency?: string;
  tableId: string;
  // 품목표 헤더의 "+ Add" 옆에 넣을 보조 액션(예: "Load order items").
  headerActions?: React.ReactNode;
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
  const sel = useRowSelection();
  const cur = (currency || "USD").toUpperCase();
  const unitListId = useId();
  const cols: ItemCol[] = [
    { key: "__sel", fixed: true },
    { key: "__seq", fixed: true, className: "seq" },
    { key: "part_no", label: "Part No." },
    { key: "description", label: "Description" },
    { key: "maker", label: "Maker" },
    { key: "qty", label: "Qty", className: "num" },
    { key: "unit", label: "Unit" },
    ...(packing
      ? [
          { key: "package", label: "Package" },
          { key: "net_weight", label: "N.W." },
          { key: "gross_weight", label: "G.W." },
          { key: "dimension", label: "Dimension" },
        ]
      : [
          { key: "unit_price", label: `Unit Price (${cur})`, className: "num" },
          { key: "amount", label: `Amount (${cur})`, className: "num" },
        ]),
    { key: "remark", label: "Remark" },
  ];
  const grid = useItemGrid(tableId, cols);

  return (
    <div style={{ marginTop: 16 }}>
      <div className="items-head">
        <div className="sub-h">Item list</div>
        <div className="items-head-actions">
          {headerActions}
          <ItemColsButton grid={grid} />
          <DeleteSelectedButton sel={sel} onDelete={() => deleteSelectedRows(items, sel, setItems)} />
          <button className="btn sm items-head-add" onClick={() => setItems([...items, blankItem(packing)])}>+ Add</button>
        </div>
      </div>
      <datalist id={unitListId}>
        {UNIT_OPTIONS.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      <div className="table-wrap item-scroll">
        <ItemGridStyle grid={grid} />
        <table className={`mini wide lead-tools ${grid.tableClass}`}>
          <thead>
            <tr>
              <ItemSelectHeaderCell count={items.length} sel={sel} />
              <th className="seq">No.</th>
              <ItemTh grid={grid} k="part_no">Part No.</ItemTh>
              <ItemTh grid={grid} k="description">Description</ItemTh>
              <ItemTh grid={grid} k="maker">Maker</ItemTh>
              <ItemTh grid={grid} k="qty" className="num">Qty</ItemTh>
              <ItemTh grid={grid} k="unit">Unit</ItemTh>
              {packing ? (
                <>
                  <ItemTh grid={grid} k="package">Package</ItemTh>
                  <ItemTh grid={grid} k="net_weight">N.W.</ItemTh>
                  <ItemTh grid={grid} k="gross_weight">G.W.</ItemTh>
                  <ItemTh grid={grid} k="dimension">Dimension</ItemTh>
                </>
              ) : (
                <>
                  <ItemTh grid={grid} k="unit_price" className="num">Unit Price ({cur})</ItemTh>
                  <ItemTh grid={grid} k="amount" className="num">Amount ({cur})</ItemTh>
                </>
              )}
              <ItemTh grid={grid} k="remark">Remark</ItemTh>
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => (
              <tr key={i} className={itemRowClass(i)}>
                <ItemSelectCell index={i} sel={sel} />
                <td className="seq">{i + 1}</td>
                <td><textarea {...gridCellProps(i, 0)} className="wrapcell" rows={1} value={item.part_no || ""} onChange={(e) => patch(i, "part_no", e.target.value)} /></td>
                <td><textarea {...gridCellProps(i, 1)} className="desc" rows={1} value={item.description || ""} onChange={(e) => patch(i, "description", e.target.value)} /></td>
                <td><textarea {...gridCellProps(i, 2)} className="wrapcell" rows={1} value={item.maker || ""} onChange={(e) => patch(i, "maker", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 3)} className="num" value={amountInputValue(item.qty)} onChange={(e) => patch(i, "qty", e.target.value)} /></td>
                <td><input {...gridCellProps(i, 4)} list={unitListId} value={item.unit || "PCS"} onChange={(e) => patch(i, "unit", e.target.value)} /></td>
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
                  </>
                )}
                <td><textarea {...gridCellProps(i, packing ? 9 : 7)} className="wrapcell" rows={1} value={item.remark || ""} onChange={(e) => patch(i, "remark", e.target.value)} /></td>
              </tr>
            ))}
          </tbody>
          {/* 합계행 — 컬럼당 1셀(숨김/폭 조절 정렬 유지). Total=Unit price(8열), 값=Amount(9열). */}
          {!packing ? (
            <tfoot>
              <tr>
                <td></td>{/* 1 sel */}
                <td></td>{/* 2 No. */}
                <td></td>{/* 3 part_no */}
                <td></td>{/* 4 description */}
                <td></td>{/* 5 maker */}
                <td></td>{/* 6 qty */}
                <td></td>{/* 7 unit */}
                <td className="total-label">Total</td>{/* 8 unit_price */}
                <td className="num total-value">{/* 9 amount */}
                  <DualCurrencyAmount value={total} currency={currency} />
                  <span className="fx-note">{fxRateText()}</span>
                </td>
                <td></td>{/* 10 remark */}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
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

// 문서 미리보기 — 다운로드와 동일한 PDF 를 받아 모달 iframe 으로 인라인 표시한다.
// PDF 는 저장된 문서 기준으로 생성되므로 저장 전에는 비활성(Download 와 동일 규약).
function DocPreviewButton({
  orderId,
  kind,
  filename,
  disabled,
}: {
  orderId: number;
  kind: "ci/pdf" | "pl/pdf" | "sa/pdf";
  filename: string;
  disabled: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function open() {
    setBusy(true);
    try {
      const res = await fetch(documentDownloadUrl(orderId, kind), {
        headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
      });
      if (!res.ok) throw new Error("preview failed");
      setUrl(URL.createObjectURL(await res.blob()));
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
    a.download = filename;
    a.click();
  }

  return (
    <>
      <button className="btn doc-preview-btn" disabled={disabled || busy} onClick={open}>
        {busy ? "여는 중…" : "미리보기"}
      </button>
      {url ? (
        <div className="doc-preview-backdrop" onClick={close}>
          <div className="doc-preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="doc-preview-head">
              <span className="doc-preview-title">{filename}</span>
              <div className="doc-preview-acts">
                <button className="btn sm doc-preview-save" onClick={savePdf}>PDF 저장</button>
                <button className="btn sm" onClick={close}>닫기</button>
              </div>
            </div>
            <iframe className="doc-preview-frame" src={url} title="미리보기" />
          </div>
        </div>
      ) : null}
    </>
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
      <div><dt>Project No.</dt><dd><b><ProjectNo value={order.project_no} /></b></dd></div>
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
      id: 0, rfq_id: 0, assignee_id: 0, po_no: "", kms_order_no: "", date: "", status: "",
      customer: "", customer_email: "", customer_tax_id: "", vessel: "",
      project_title: "", project_no: "", first_rfq_at: "", work_type: "", vendor: "", trade_type: "", service_info: {},
      tracking_token: "", consignee_confirmed_date: "", vendor_docs_sent_date: "",
      items: [],
    },
    pod: null,
    stage_done: { "7": false, "8": false, "10": false, "11": false },
    ci: null, pl: null, sa: null, tax: null,
    smtp_configured: false,
  };
}
