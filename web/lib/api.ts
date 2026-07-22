import { API_BASE } from "./config";
import { getToken, clearAuth } from "./auth";
import type { PermGrid } from "./auth";
import type {
  RfqOverview,
  CustomerOption,
  VendorOption,
  RfqDetail,
  DashboardData,
  PoRow,
  PoDetail,
  PoWorkItem,
  PoWorkOptions,
  RfqOcrResult,
  RfqSourceFile,
  OrderOcrResult,
  VendorPoPreview,
  VendorRfqPreview,
  VendorQuoteItem,
  CustomerQuoteItem,
  QuotationTerms,
  VendorQuoteForImport,
  VendorQuoteOverviewRow,
  DocumentDetail,
  DocumentWorkItem,
  QtnRow,
  VrfqRow,
  DocRow,
  VendorPoRow,
  ArData,
  SettingsCustomer,
  SettingsVendor,
  SettingsVessel,
  SettingsItem,
  ItemCategory,
  SettingsUser,
  CompanyProfile,
  PipelineData,
  StageNote,
  VendorRfqDetail,
  VendorQuoteDetail,
  CustomerQuotationDetail,
  PurchaseOrderDetail,
  MarketingRow,
  MarketingOverview,
  ScheduleRow,
  StatisticsData,
  StatDebugData,
  SearchData,
} from "./types";

function authHeaders(json = false): HeadersInit {
  const token = getToken();
  const h: Record<string, string> = {};
  if (token) h.Authorization = `Bearer ${token}`;
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function handle<T>(res: Response, path: string): Promise<T> {
  if (res.status === 401) {
    clearAuth();
    if (typeof window !== "undefined") window.location.href = "/login";
    throw new Error("인증이 필요합니다.");
  }
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { detail?: unknown };
    throw new Error(errorDetailToString(e?.detail) || `API ${res.status} ${res.statusText} — ${path}`);
  }
  return res.json() as Promise<T>;
}

// FastAPI 오류 detail 을 사람이 읽을 문자열로. 문자열이면 그대로, 검증오류(배열)면 msg 결합,
// 객체면 JSON 으로. (예전엔 배열/객체를 new Error 에 그대로 넘겨 "[object Object]" 로 표시됐다.)
function errorDetailToString(detail: unknown): string {
  if (!detail) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => (d && typeof d === "object" && "msg" in d ? String((d as { msg: unknown }).msg) : JSON.stringify(d)))
      .filter(Boolean)
      .join("; ");
  }
  if (typeof detail === "object") {
    const d = detail as { msg?: unknown; detail?: unknown };
    if (typeof d.msg === "string") return d.msg;
    try {
      return JSON.stringify(detail);
    } catch {
      return "";
    }
  }
  return String(detail);
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: authHeaders(),
    cache: "no-store",
  });
  return handle<T>(res, path);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify(body),
  });
  return handle<T>(res, path);
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: authHeaders(true),
    body: JSON.stringify(body),
  });
  return handle<T>(res, path);
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers: authHeaders(true),
    body: JSON.stringify(body),
  });
  return handle<T>(res, path);
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  return handle<T>(res, path);
}

async function postForm<T>(path: string, body: FormData): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body,
  });
  return handle<T>(res, path);
}

export function fetchRfqOverview(customerId?: number): Promise<RfqOverview> {
  const q = customerId ? `?customer_id=${customerId}` : "";
  return get<RfqOverview>(`/api/admin/rfq-overview${q}`);
}

export function fetchCustomers(): Promise<CustomerOption[]> {
  return get<CustomerOption[]>("/api/admin/customers");
}

export function globalSearch(q: string): Promise<SearchData> {
  return get<SearchData>(`/api/admin/search?q=${encodeURIComponent(q)}`);
}

export function fetchRfqDetail(id: number): Promise<RfqDetail> {
  return get<RfqDetail>(`/api/admin/rfq/${id}`);
}

export function createRfq(body: {
  customer_id: number;
  vessel_id?: number;
  customer_rfq_no?: string;
  contact_person?: string;
  rfq_no?: string;
  received_at?: string;
  project_title?: string;
  work_type?: string;
  request_channel?: string;
  notes?: string;
  items: { part_no: string; description: string; type?: string; serial_no?: string; qty: number; remark?: string }[];
  source_files?: { name: string; media_type?: string; item_count: number; at?: string }[];
}): Promise<{ ok: boolean; id: number; rfq_no: string }> {
  return post("/api/admin/rfq", body);
}

export function updateRfq(
  rfqId: number,
  body: {
    customer_id?: number;
    vessel_id?: number;
    customer_rfq_no?: string;
    rfq_no?: string;
    contact_person?: string;
    project_title?: string;
    work_type?: string;
    request_channel?: string;
    notes?: string;
    received_at?: string;
    assignee_id?: number;
    items?: { part_no: string; description: string; type?: string; serial_no?: string; qty: number; remark?: string }[];
    source_files?: { name: string; media_type?: string; item_count: number; at?: string }[];
  }
): Promise<{ ok: boolean; id: number }> {
  return patch(`/api/admin/rfq/${rfqId}`, body);
}

export function fetchAssignableUsers(): Promise<{ id: number; username: string }[]> {
  return get<{ id: number; username: string }[]>("/api/admin/assignable-users");
}

export function addRfqStageNote(
  rfqId: number,
  stage: number,
  payload: { text: string; datetime?: string; party?: string; person?: string; channel?: string; direction?: string; star?: boolean; pic?: string }
): Promise<{ ok: boolean; stage: number; notes: StageNote[] }> {
  return post(`/api/admin/rfq/${rfqId}/stage-note`, { stage, ...payload });
}

export function updateRfqStageNote(
  rfqId: number,
  stage: number,
  index: number,
  payload: { text: string; datetime?: string; party?: string; person?: string; channel?: string; direction?: string; star?: boolean; pic?: string }
): Promise<{ ok: boolean; stage: number; notes: StageNote[] }> {
  return post(`/api/admin/rfq/${rfqId}/stage-note-update`, { stage, index, ...payload });
}

export function deleteRfqStageNote(
  rfqId: number,
  stage: number,
  index: number
): Promise<{ ok: boolean; stage: number; notes: StageNote[] }> {
  return post(`/api/admin/rfq/${rfqId}/stage-note-delete`, { stage, index });
}

export function assignRfqNo(
  rfqId: number,
  body: { mode: "auto" | "manual"; rfq_no?: string }
): Promise<{ ok: boolean; rfq_no: string }> {
  return post(`/api/admin/rfq/${rfqId}/assign-no`, body);
}

// 자동채번 미리보기 — 다음에 생성될 K-Maris RFQ No.(할당하지 않음).
export function fetchNextRfqNo(): Promise<{ rfq_no: string }> {
  return get(`/api/admin/rfq/next-no?_=${Date.now()}`);
}

// 자동채번 미리보기 — 다음에 생성될 Quotation No.(KMS-QUO-yymm-nnn, 할당하지 않음).
export function fetchNextQuotationNo(): Promise<{ qtn_no: string }> {
  return get(`/api/admin/quotation/next-no?_=${Date.now()}`);
}

// 자동채번 미리보기 — 다음에 생성될 K-Maris (Vendor) P/O No.(KMS-ORD-yymm-nnn, 할당하지 않음).
export function fetchNextPoNo(): Promise<{ po_no: string }> {
  return get(`/api/admin/vendor-po/next-no?_=${Date.now()}`);
}

export function updateRfqLevel(
  rfqId: number,
  followUpLevel: string
): Promise<{ ok: boolean; follow_up_level: string }> {
  return put(`/api/admin/rfq/${rfqId}/level`, { follow_up_level: followUpLevel });
}

// 딜 종결(취소/실주) 토글. cancelled=true → 종결, false → 재활성.
// 종결 시 사유(reason 코드 + 기타 직접입력 note)를 함께 보낸다.
export function setRfqCancelled(
  rfqId: number,
  cancelled: boolean,
  reason?: string,
  reasonNote?: string
): Promise<{ ok: boolean; cancelled: boolean; close_reason?: string; close_reason_note?: string }> {
  return put(`/api/admin/rfq/${rfqId}/cancel`, {
    cancelled,
    reason: reason ?? null,
    reason_note: reasonNote ?? null,
  });
}

// 딜 종결 사유 코드 → 라벨. Close deal 사유 선택/표시 공용.
export const CLOSE_REASONS: { code: string; label: string }[] = [
  { code: "schedule", label: "Project delayed or cancelled" },
  { code: "slow_response", label: "Slower response than competitors" },
  { code: "no_quote", label: "Unable to quote" },
  { code: "other", label: "Other (specify)" },
];
export function closeReasonLabel(code?: string | null): string {
  if (!code) return "";
  return CLOSE_REASONS.find((r) => r.code === code)?.label || code;
}

export function updateRfqStageDate(
  rfqId: number,
  stage: number,
  value: string | null
): Promise<{ ok: boolean; stage_dates: Record<string, string> }> {
  return put(`/api/admin/rfq/${rfqId}/stage-date`, { stage, value });
}

export function deleteRfq(rfqId: number): Promise<{ ok: boolean; rfq_no: string }> {
  return del(`/api/admin/rfq/${rfqId}`);
}

export function parseRfqPdf(file: File): Promise<RfqOcrResult> {
  const fd = new FormData();
  fd.append("file", file);
  return postForm<RfqOcrResult>("/api/admin/ocr/rfq", fd);
}

export function parseOrderPdf(file: File): Promise<OrderOcrResult> {
  const fd = new FormData();
  fd.append("file", file);
  return postForm<OrderOcrResult>("/api/admin/ocr/order", fd);
}

export function fetchPipeline(
  customerId?: number,
  owner?: { mine?: boolean; assignee?: number }
): Promise<PipelineData> {
  const p = new URLSearchParams();
  if (customerId) p.set("customer_id", String(customerId));
  if (owner?.mine) p.set("mine", "1");
  if (owner?.assignee) p.set("assignee", String(owner.assignee));
  const qs = p.toString();
  return get<PipelineData>(`/api/admin/pipeline${qs ? `?${qs}` : ""}`);
}

export function fetchDashboard(): Promise<DashboardData> {
  return get<DashboardData>("/api/admin/dashboard");
}

export function fetchStatistics(months = 12): Promise<StatisticsData> {
  return get<StatisticsData>(`/api/admin/statistics?months=${months}`);
}

// 금액 KPI 감사 — Orders Won/Quoted/Revenue 가 어떤 오더·견적·AR 에서 왔는지 행 단위.
export function fetchStatisticsDebug(month?: string): Promise<StatDebugData> {
  const q = month ? `?month=${encodeURIComponent(month)}` : "";
  return get<StatDebugData>(`/api/admin/statistics-debug${q}`);
}

export function fetchVendors(): Promise<VendorOption[]> {
  return get<VendorOption[]>("/api/admin/vendors");
}

export function fetchPoOverview(): Promise<{ rows: PoRow[] }> {
  return get<{ rows: PoRow[] }>("/api/admin/po-overview");
}

export function fetchPoDetail(id: number): Promise<PoDetail> {
  return get<PoDetail>(`/api/admin/order/${id}`);
}

export function fetchPoWorkOptions(): Promise<PoWorkOptions> {
  return get<PoWorkOptions>("/api/admin/po-work-options");
}

export function createOrder(body: {
  customer_id: number;
  vessel_id?: number | null;
  quotation_id?: number | null;
  rfq_id?: number | null;
  po_no?: string;
  date?: string;
  currency?: string;
  trade_type?: string;
  promised_delivery?: string | null;
  items: PoWorkItem[];
  terms?: QuotationTerms;
  source_files?: RfqSourceFile[];
}): Promise<{ ok: boolean; id: number; project_no: string }> {
  return post("/api/admin/orders", body);
}

export function createPurchaseOrder(body: {
  order_id: number;
  vendor_id: number;
  po_no?: string;
  date?: string;
  currency?: string;
  items: PoWorkItem[];
  terms?: QuotationTerms;
  source_files?: RfqSourceFile[];
}): Promise<{ ok: boolean; id: number; po_no: string }> {
  return post("/api/admin/vendor-pos", body);
}

// ── 단계 이메일(2·4·6) 공통 ────────────────────────────────────────────────
// 세 단계 모두 DocSendPanel 하나를 쓰고, 서버도 같은 폼 필드를 받는다.
// 본문은 body/notes/signature 세 조각으로 보내고 서버가 합친다(중복 서명 방지).
// 첨부는 multipart — 생성 문서(견적서 등)는 서버가 붙이고, files 는 사용자가 더한 것.
export interface DocEmailPreview {
  to: string;
  from?: string;
  subject: string;
  body: string;
  signature?: string;
  smtp_configured: boolean;
}

export interface DocEmailSend {
  to: string;
  from?: string;
  cc?: string;
  subject: string;
  body: string;
  notes?: string;
  signature?: string;
  includeSignature?: boolean;
  format?: "pdf" | "xlsx";
  /** 생성 문서(견적서 등)를 첨부할지. false 면 서버가 문서를 만들지 않는다. */
  includeDocument?: boolean;
  files?: File[];
}

function docEmailFormData(p: DocEmailSend): FormData {
  const fd = new FormData();
  fd.append("to", p.to);
  fd.append("from_email", p.from ?? "");
  fd.append("cc", p.cc ?? "");
  fd.append("subject", p.subject);
  fd.append("body", p.body);
  fd.append("notes", p.notes ?? "");
  fd.append("signature", p.signature ?? "");
  fd.append("include_signature", String(p.includeSignature ?? true));
  fd.append("format", p.format ?? "pdf");
  fd.append("include_document", String(p.includeDocument ?? true));
  for (const f of p.files ?? []) fd.append("files", f);
  return fd;
}

/** 담당자 이메일 서명 — 발송 화면 기본값(개인 → 회사 → 내장 기본 순으로 해석된 값). */
export function fetchEmailSignature(
  lang: "en" | "ko"
): Promise<{ lang: string; signature: string; is_personal: boolean }> {
  return get(`/api/admin/settings/email-signature?lang=${lang}`);
}

/** 개인 서명 저장(이후 모든 단계의 기본 서명). 빈 문자열이면 해제. */
export function saveEmailSignature(
  lang: "en" | "ko",
  signature: string
): Promise<{ ok: boolean; signature: string }> {
  return put(`/api/admin/settings/email-signature`, { lang, signature });
}

export function previewVendorPo(poId: number, lang: "en" | "ko"): Promise<VendorPoPreview> {
  return post(`/api/admin/vendor-pos/${poId}/preview`, { lang, notes: "" });
}

export function sendVendorPo(p: DocEmailSend & { poId: number }) {
  return postForm<{ ok: boolean; sent_date: string }>(
    `/api/admin/vendor-pos/${p.poId}/send`,
    docEmailFormData(p)
  );
}

export function vendorPoPdfUrl(poId: number): string {
  return `${API_BASE}/api/admin/vendor-pos/${poId}/pdf`;
}

export function vendorPoXlsxUrl(poId: number): string {
  return `${API_BASE}/api/admin/vendor-pos/${poId}/xlsx`;
}

export function fetchQuotationOverview(customerId?: number): Promise<{ rows: QtnRow[] }> {
  const q = customerId ? `?customer_id=${customerId}` : "";
  return get<{ rows: QtnRow[] }>(`/api/admin/quotation-overview${q}`);
}

export function fetchVrfqOverview(): Promise<{ rows: VrfqRow[] }> {
  return get<{ rows: VrfqRow[] }>("/api/admin/vrfq-overview");
}

export function fetchVendorQuoteOverview(): Promise<{
  rows: VendorQuoteOverviewRow[];
}> {
  return get<{ rows: VendorQuoteOverviewRow[] }>(
    `/api/admin/vendor-quote-overview?_=${Date.now()}`
  );
}

export function fetchDocumentsOverview(): Promise<{ rows: DocRow[] }> {
  return get<{ rows: DocRow[] }>("/api/admin/documents-overview");
}

export function fetchDocumentDetail(orderId: number): Promise<DocumentDetail> {
  return get<DocumentDetail>(`/api/admin/documents/${orderId}`);
}

export function updateDocumentMilestone(
  orderId: number,
  field: "consignee_confirmed_date" | "vendor_docs_sent_date",
  value: boolean
): Promise<{ ok: boolean; value: string }> {
  return post(`/api/admin/documents/${orderId}/milestone`, { field, value });
}

export function saveProformaInvoice(
  orderId: number,
  body: {
    pi_no?: string;
    date?: string;
    currency: string;
    vat_rate: number;
    items: DocumentWorkItem[];
    shipping: Record<string, string>;
    terms?: Record<string, string>;
  }
): Promise<{ ok: boolean; id: number; pi_no: string }> {
  return post(`/api/admin/documents/${orderId}/pi`, body);
}

export function deleteProformaInvoice(orderId: number): Promise<{ ok: boolean }> {
  return del(`/api/admin/documents/${orderId}/pi`);
}

export function saveCommercialInvoice(
  orderId: number,
  body: {
    ci_no?: string;
    date?: string;
    currency: string;
    vat_rate: number;
    items: DocumentWorkItem[];
    shipping: Record<string, string>;
    terms?: Record<string, string>;
  }
): Promise<{ ok: boolean; id: number; ci_no: string }> {
  return post(`/api/admin/documents/${orderId}/ci`, body);
}

export function deleteCommercialInvoice(orderId: number): Promise<{ ok: boolean }> {
  return del(`/api/admin/documents/${orderId}/ci`);
}

// 단계(7~11) 초기화 — 이 오더에서 해당 단계의 완료 근거를 한 번에 제거해 앞 단계로 되돌린다.
export function resetStage(orderId: number, stage: number): Promise<{ ok: boolean }> {
  return post(`/api/admin/documents/${orderId}/reset-stage/${stage}`, {});
}

export function saveServiceStage(
  orderId: number,
  stage: number,
  data: Record<string, unknown>,
  complete = true
): Promise<{ ok: boolean }> {
  return post(`/api/admin/documents/${orderId}/service`, { stage, data, complete });
}

export function deleteServiceStage(orderId: number, stage: number): Promise<{ ok: boolean }> {
  return del(`/api/admin/documents/${orderId}/service/${stage}`);
}

export function savePackingList(
  orderId: number,
  body: {
    pl_no?: string;
    date?: string;
    items: DocumentWorkItem[];
    packing_info?: string;
    shipping?: Record<string, string>;
  }
): Promise<{ ok: boolean; id: number; pl_no: string }> {
  return post(`/api/admin/documents/${orderId}/pl`, body);
}

export function deletePackingList(orderId: number): Promise<{ ok: boolean }> {
  return del(`/api/admin/documents/${orderId}/pl`);
}

export function saveShippingAdvice(
  orderId: number,
  body: { sa_no?: string; date?: string; shipping: Record<string, string> }
): Promise<{ ok: boolean; id: number; sa_no: string }> {
  return post(`/api/admin/documents/${orderId}/sa`, body);
}

export function deleteShippingAdvice(orderId: number): Promise<{ ok: boolean }> {
  return del(`/api/admin/documents/${orderId}/sa`);
}

export function sendShippingAdvice(
  orderId: number,
  to: string,
  subject: string,
  body: string
): Promise<{ ok: boolean; sent_date: string }> {
  return post(`/api/admin/documents/${orderId}/sa/send`, { to, subject, body });
}

export function saveTaxInvoice(
  orderId: number,
  body: {
    tax_no?: string;
    date?: string;
    supply_type: string;
    buyer_business_no: string;
    vat_rate: number;
    items?: DocumentWorkItem[];
  }
): Promise<{ ok: boolean; id: number; tax_no: string; ar_id: number }> {
  return post(`/api/admin/documents/${orderId}/tax`, body);
}

export function documentDownloadUrl(
  orderId: number,
  kind: "pi/pdf" | "ci/pdf" | "ci/xlsx" | "sm/pdf" | "sm/xlsx" | "pl/pdf" | "pl/xlsx" | "sa/pdf" | "tax/xlsx"
): string {
  return `${API_BASE}/api/admin/documents/${orderId}/${kind}`;
}

// ── 9) POD(인도 증빙) 파일 + 단계 완료 콜 ─────────────────────────────────────
export function uploadPod(
  orderId: number,
  file: File
): Promise<{ ok: boolean; filename: string; uploaded_at: string }> {
  const fd = new FormData();
  fd.append("file", file);
  return postForm(`/api/admin/documents/${orderId}/pod`, fd);
}

export function podDownloadUrl(orderId: number): string {
  return `${API_BASE}/api/admin/documents/${orderId}/pod/file`;
}

export function deletePod(orderId: number): Promise<{ ok: boolean; deleted: number }> {
  return del(`/api/admin/documents/${orderId}/pod`);
}

/** 11·12 등 수동 완료 단계 토글 — 완료 시 현황판 단계가 해당 단계로 진행. */
export function completeOrderStage(
  orderId: number,
  stage: number,
  done: boolean,
  at?: string
): Promise<{ ok: boolean; stage: number; done: boolean }> {
  return post(`/api/admin/orders/${orderId}/stage/${stage}/complete`, {
    done,
    at: at ?? null,
  });
}

export function fetchVendorPoOverview(): Promise<{ rows: VendorPoRow[] }> {
  return get<{ rows: VendorPoRow[] }>("/api/admin/vendor-po-overview");
}

export function fetchArOverview(): Promise<ArData> {
  return get<ArData>("/api/admin/ar-overview");
}

// ── 마케팅 활동(잠정 고객사) ──────────────────────────────────────────────────
export type MarketingSave = {
  customer_id?: number | null;
  prospect_name?: string;
  contact_person?: string;
  recipient_email?: string;
  activity_date?: string;
  channel?: string;
  activity_type?: string;
  subject?: string;
  notes?: string;
  next_action_date?: string;
  owner_id?: number | null;
};

export function fetchMarketing(): Promise<{ rows: MarketingRow[] }> {
  return get<{ rows: MarketingRow[] }>("/api/admin/marketing");
}
export function fetchMarketingOverview(): Promise<MarketingOverview> {
  return get<MarketingOverview>("/api/admin/marketing-overview");
}
export function createMarketing(body: MarketingSave): Promise<{ ok: boolean; id: number }> {
  return post("/api/admin/marketing", body);
}
export function updateMarketing(
  id: number,
  body: MarketingSave
): Promise<{ ok: boolean; id: number }> {
  return put(`/api/admin/marketing/${id}`, body);
}
export function deleteMarketing(id: number): Promise<{ ok: boolean }> {
  return del(`/api/admin/marketing/${id}`);
}

// ── 홍보 이메일(회사소개·브로슈어) 발송 + 첨부 자료 라이브러리 ────────────────────
export type MarketingAsset = {
  id: number;
  label: string;
  filename: string;
  mime: string;
  size: number;
  created_at: string;
};

export function fetchMarketingAssets(): Promise<{ rows: MarketingAsset[] }> {
  return get<{ rows: MarketingAsset[] }>("/api/admin/marketing-assets");
}

export function uploadMarketingAsset(
  file: File,
  label = ""
): Promise<{ ok: boolean; id: number }> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("label", label);
  return postForm("/api/admin/marketing-assets", fd);
}

export function deleteMarketingAsset(id: number): Promise<{ ok: boolean; deleted: number }> {
  return del(`/api/admin/marketing-assets/${id}`);
}

// 첨부 자료 표시 이름(label) 변경 — 파일 자체는 그대로 두고 목록 표시명만 수정.
export function renameMarketingAsset(id: number, label: string): Promise<{ ok: boolean; id: number; label: string }> {
  return patch(`/api/admin/marketing-assets/${id}`, { label });
}

export function marketingAssetDownloadUrl(id: number): string {
  return `${API_BASE}/api/admin/marketing-assets/${id}/file`;
}

// 첨부 자료 미리보기용 — 인증 헤더로 blob 을 받아 object URL 을 만든다.
// blob 의 MIME 은 응답 Content-Type(예: application/pdf) 이므로 iframe/img 로 인라인 표시 가능.
// (다운로드 강제하는 Content-Disposition 헤더는 blob URL 에는 영향 없음.) 호출측이 revoke.
export async function fetchMarketingAssetObjectUrl(id: number): Promise<string> {
  const res = await fetch(marketingAssetDownloadUrl(id), { headers: authHeaders() });
  if (!res.ok) throw new Error(`미리보기 실패 (${res.status})`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// 첨부 자료 다운로드 — 인증 헤더가 필요하므로 fetch→blob 방식으로 내려받는다.
export async function downloadMarketingAsset(id: number, filename: string): Promise<void> {
  const res = await fetch(marketingAssetDownloadUrl(id), { headers: authHeaders() });
  if (!res.ok) throw new Error(`다운로드 실패 (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "asset";
  a.click();
  URL.revokeObjectURL(url);
}

export function marketingComposeDefaults(opts: {
  kind?: "intro" | "brochure";
  lang?: "en" | "ko";
  contact?: string;
  customer?: string;
}): Promise<{
  from: string;
  subject: string;
  body: string;
  signature: string;
  saved: boolean;
  smtp_configured: boolean;
}> {
  const p = new URLSearchParams({
    kind: opts.kind ?? "intro",
    lang: opts.lang ?? "en",
    contact: opts.contact ?? "",
    customer: opts.customer ?? "",
  });
  return get(`/api/admin/marketing/compose-defaults?${p.toString()}`);
}

// 홍보 메일 제목·본문을 사용자 템플릿으로 저장(종류 × 언어별). 다음 작성 시 기본값으로 로드.
export function saveMarketingTemplate(input: {
  kind: "intro" | "brochure";
  lang: "en" | "ko";
  subject: string;
  body: string;
}): Promise<{ ok: boolean }> {
  return put("/api/admin/marketing/compose-template", input);
}

// 저장한 홍보 메일 템플릿 삭제 → 내장 기본값으로 복귀.
export function resetMarketingTemplate(kind: "intro" | "brochure", lang: "en" | "ko"): Promise<{ ok: boolean }> {
  return del(`/api/admin/marketing/compose-template?kind=${kind}&lang=${lang}`);
}

export function sendMarketingEmail(input: {
  to: string;
  subject: string;
  body: string;
  signature?: string;
  includeSignature?: boolean;
  cc?: string;
  from?: string;
  customerId?: number | null;
  prospectName?: string;
  contactPerson?: string;
  assetIds?: number[];
  files?: File[];
}): Promise<{ ok: boolean; id: number; sent_date: string }> {
  const fd = new FormData();
  fd.append("to", input.to);
  fd.append("subject", input.subject ?? "");
  fd.append("body", input.body ?? "");
  fd.append("signature", input.signature ?? "");
  fd.append("include_signature", String(input.includeSignature ?? true));
  fd.append("cc", input.cc ?? "");
  fd.append("from_email", input.from ?? "");
  fd.append("customer_id", input.customerId ? String(input.customerId) : "");
  fd.append("prospect_name", input.prospectName ?? "");
  fd.append("contact_person", input.contactPerson ?? "");
  fd.append("asset_ids", (input.assetIds ?? []).join(","));
  for (const f of input.files ?? []) fd.append("files", f);
  return postForm("/api/admin/marketing/send", fd);
}

// ── 일정(Schedule) ────────────────────────────────────────────────────────────
export type ScheduleSave = {
  date?: string;
  title?: string;
  event_type?: string;
  notes?: string;
  customer_id?: number | null;
};

export function fetchSchedule(): Promise<{ rows: ScheduleRow[] }> {
  return get<{ rows: ScheduleRow[] }>("/api/admin/schedule");
}
export function createSchedule(body: ScheduleSave): Promise<{ ok: boolean; id: number }> {
  return post("/api/admin/schedule", body);
}
export function updateSchedule(
  id: number,
  body: ScheduleSave
): Promise<{ ok: boolean; id: number }> {
  return put(`/api/admin/schedule/${id}`, body);
}
export function deleteSchedule(id: number): Promise<{ ok: boolean }> {
  return del(`/api/admin/schedule/${id}`);
}

export function fetchSettingsCustomers(): Promise<SettingsCustomer[]> {
  return get<SettingsCustomer[]>("/api/admin/settings/customers");
}
export function fetchSettingsVendors(): Promise<SettingsVendor[]> {
  return get<SettingsVendor[]>("/api/admin/settings/vendors");
}
export function fetchSettingsVessels(): Promise<SettingsVessel[]> {
  return get<SettingsVessel[]>("/api/admin/settings/vessels");
}
export function fetchSettingsItems(): Promise<SettingsItem[]> {
  return get<SettingsItem[]>("/api/admin/settings/items");
}
export function fetchSettingsUsers(): Promise<SettingsUser[]> {
  return get<SettingsUser[]>("/api/admin/settings/users");
}
export function fetchCompanyProfile(): Promise<CompanyProfile> {
  return get<CompanyProfile>("/api/admin/settings/company");
}
export function updateCompanyProfile(body: CompanyProfile): Promise<{ ok: boolean }> {
  return put("/api/admin/settings/company", body);
}
export function createSettingsCustomer(body: {
  name: string;
  contact?: string;
  contact_phone?: string;
  email?: string;
  country?: string;
  address?: string;
  tax_id?: string;
  payment_terms?: string;
  logo?: string;
  emails?: string[];
  phones?: string[];
  regions?: string[];
}): Promise<{ ok: boolean; id: number }> {
  return post("/api/admin/settings/customers", body);
}
export function updateSettingsCustomer(
  id: number,
  body: Omit<SettingsCustomer, "id">
): Promise<{ ok: boolean; id: number }> {
  return put(`/api/admin/settings/customers/${id}`, body);
}
export function deleteSettingsCustomer(id: number): Promise<{ ok: boolean }> {
  return del(`/api/admin/settings/customers/${id}`);
}
export function createSettingsVendor(body: {
  name: string;
  contact?: string;
  contact_phone?: string;
  email?: string;
  specialization?: string;
  country?: string;
  address?: string;
  payment_terms?: string;
  logo?: string;
  emails?: string[];
  phones?: string[];
  regions?: string[];
}): Promise<{ ok: boolean; id: number }> {
  return post("/api/admin/settings/vendors", body);
}
export function updateSettingsVendor(
  id: number,
  body: Omit<SettingsVendor, "id">
): Promise<{ ok: boolean; id: number }> {
  return put(`/api/admin/settings/vendors/${id}`, body);
}
export function deleteSettingsVendor(id: number): Promise<{ ok: boolean }> {
  return del(`/api/admin/settings/vendors/${id}`);
}
export function createSettingsVessel(body: {
  name: string;
  imo?: string;
  vessel_type?: string;
  ais_flag?: string;
  customer_id?: number;
  engine_type?: string;
  hull_no?: string;
}): Promise<{ ok: boolean; id: number }> {
  return post("/api/admin/settings/vessels", body);
}
export function updateSettingsVessel(
  id: number,
  body: Omit<SettingsVessel, "id" | "customer">
): Promise<{ ok: boolean; id: number }> {
  return put(`/api/admin/settings/vessels/${id}`, body);
}
export function deleteSettingsVessel(id: number): Promise<{ ok: boolean }> {
  return del(`/api/admin/settings/vessels/${id}`);
}

export function createSettingsItem(body: Omit<SettingsItem, "id">): Promise<{ ok: boolean; id: number }> {
  return post("/api/admin/settings/items", body);
}
export function updateSettingsItem(id: number, body: Omit<SettingsItem, "id">): Promise<{ ok: boolean; id: number }> {
  return put(`/api/admin/settings/items/${id}`, body);
}
export function deleteSettingsItem(id: number): Promise<{ ok: boolean }> {
  return del(`/api/admin/settings/items/${id}`);
}

// ── 이메일 템플릿(담당자별 초안) ──────────────────────────────────────────────
export type EmailTplRow = {
  subject_tpl: string;
  body_tpl: string;
  options: { item_cols?: string[] };
} | null;
export type EmailTemplatesData = {
  doc_type: string;
  is_admin: boolean;
  tokens: string[];
  item_cols: { key: string; label_en: string; label_ko: string }[];
  default_item_cols: string[];
  defaults: Record<"en" | "ko", { subject_tpl: string; body_tpl: string }>;
  user: Record<"en" | "ko", EmailTplRow>;
  company: Record<"en" | "ko", EmailTplRow>;
};
export function fetchEmailTemplates(docType = "vendor_rfq"): Promise<EmailTemplatesData> {
  return get<EmailTemplatesData>(`/api/admin/settings/email-templates?doc_type=${docType}`);
}
export function saveEmailTemplate(body: {
  scope: "user" | "company";
  doc_type: string;
  lang: "en" | "ko";
  subject_tpl: string;
  body_tpl: string;
  options: { item_cols: string[] };
}): Promise<{ ok: boolean; scope: string; lang: string }> {
  return put("/api/admin/settings/email-templates", body);
}
export function deleteEmailTemplate(
  scope: "user" | "company",
  docType: string,
  lang: "en" | "ko"
): Promise<{ ok: boolean }> {
  return del(`/api/admin/settings/email-templates?scope=${scope}&doc_type=${docType}&lang=${lang}`);
}
export function previewEmailTemplate(body: {
  lang: "en" | "ko";
  subject_tpl: string;
  body_tpl: string;
  options: { item_cols: string[] };
}): Promise<{ subject: string; body: string }> {
  return post("/api/admin/settings/email-templates/preview", body);
}

// ── 품목 분류 트리(대>중>소) ──────────────────────────────────────────────────
export function fetchItemCategories(): Promise<ItemCategory[]> {
  return get<ItemCategory[]>("/api/admin/settings/item-categories");
}
export function createItemCategory(body: {
  name: string;
  parent_id?: number | null;
  sort_order?: number;
  active?: boolean;
}): Promise<{ ok: boolean; id: number }> {
  return post("/api/admin/settings/item-categories", body);
}
export function updateItemCategory(
  id: number,
  body: { name?: string; sort_order?: number; active?: boolean }
): Promise<{ ok: boolean; id: number }> {
  return put(`/api/admin/settings/item-categories/${id}`, body);
}
export function deleteItemCategory(id: number): Promise<{ ok: boolean }> {
  return del(`/api/admin/settings/item-categories/${id}`);
}

export function createSettingsUser(body: {
  username: string;
  email?: string;
  password?: string;
  role: string;
  is_active: boolean;
}): Promise<{ ok: boolean; id: number }> {
  return post("/api/admin/settings/users", body);
}
export function updateSettingsUser(
  id: number,
  body: {
    username: string;
    email?: string;
    password?: string;
    role: string;
    is_active: boolean;
  }
): Promise<{ ok: boolean; id: number }> {
  return put(`/api/admin/settings/users/${id}`, body);
}
export function deleteSettingsUser(id: number): Promise<{ ok: boolean }> {
  return del(`/api/admin/settings/users/${id}`);
}
// ── 역할 권한 매트릭스 (admin 전용) ──────────────────────────────────────────
export type RolePermRow = {
  role: string;
  perms: PermGrid;
  scope: "own" | "all";
  editable: boolean;
};
export type PermissionsConfig = {
  roles: RolePermRow[];
  modules: string[];
  actions: string[];
  view_only: string[];
};

export function fetchRolePermissions(): Promise<PermissionsConfig> {
  return get<PermissionsConfig>("/api/admin/settings/permissions");
}
export function updateRolePermissions(body: {
  role: string;
  perms: PermGrid;
  scope: string;
}): Promise<{ ok: boolean; role: string; perms: PermGrid; scope: string }> {
  return put("/api/admin/settings/permissions", body);
}

export function changeMyPassword(
  oldPassword: string,
  newPassword: string
): Promise<{ ok: boolean }> {
  return post("/api/admin/me/password", {
    old_password: oldPassword,
    new_password: newPassword,
  });
}

export function arSoaXlsxUrl(status?: string, currency?: string): string {
  const p = new URLSearchParams();
  if (status && status !== "전체") p.set("status", status);
  if (currency && currency !== "전체") p.set("currency", currency);
  const qs = p.toString();
  return `${API_BASE}/api/admin/ar/soa.xlsx${qs ? `?${qs}` : ""}`;
}

export function recordArPayment(
  arId: number,
  amount: number,
  dueDate?: string
): Promise<{ ok: boolean; paid_amount: number; status: string }> {
  return post(`/api/admin/ar/${arId}/payment`, {
    amount,
    due_date: dueDate ?? null,
  });
}

export function createArRecord(body: {
  order_id: number;
  ci_no?: string;
  invoice_amount: number;
  paid_amount?: number;
  currency: string;
  due_date?: string;
  status?: string;
  notes?: string;
}): Promise<{ ok: boolean; id: number }> {
  return post("/api/admin/ar", body);
}

export function updateArRecord(
  arId: number,
  body: {
    order_id: number;
    ci_no?: string;
    invoice_amount: number;
    paid_amount?: number;
    currency: string;
    due_date?: string;
    status?: string;
    notes?: string;
  }
): Promise<{ ok: boolean; id: number; status: string }> {
  return put(`/api/admin/ar/${arId}`, body);
}

export function deleteArRecord(arId: number): Promise<{ ok: boolean }> {
  return del(`/api/admin/ar/${arId}`);
}

export function createVendorRfq(
  rfqId: number,
  vendorId: number
): Promise<{ ok: boolean; id: number; vendor: string }> {
  return post(`/api/admin/rfq/${rfqId}/vendor-rfq`, { vendor_id: vendorId });
}

// 발신 화면에서 선택·편집한 품목(오버라이드). 없으면 RFQ 원본을 사용.
export type VendorRfqItemOverride = {
  part_no: string;
  description: string;
  qty: number;
  unit?: string;
  remark?: string;
};

export function previewVendorRfq(
  rfqId: number,
  vendorIds: number[],
  lang: "en" | "ko",
  notes: string,
  rfqNo?: { mode: "auto" | "manual"; value: string },
  items?: VendorRfqItemOverride[]
): Promise<{ previews: VendorRfqPreview[]; smtp_configured: boolean }> {
  return post(`/api/admin/rfq/${rfqId}/vendor-rfq-preview`, {
    vendor_ids: vendorIds,
    lang,
    notes,
    rfq_no_mode: rfqNo?.mode ?? "auto",
    rfq_no: rfqNo?.value ?? "",
    items,
  });
}

export function sendVendorRfq(
  rfqId: number,
  items: { vendor_id: number; to: string; subject: string; body: string }[],
  rfqNo?: { mode: "auto" | "manual"; value: string },
  sentAt?: string,
  rfqItems?: VendorRfqItemOverride[]
): Promise<{
  ok: boolean;
  saved: number;
  rfq_no: string;
}> {
  return post(`/api/admin/rfq/${rfqId}/vendor-rfq-send`, {
    items,
    rfq_no_mode: rfqNo?.mode ?? "auto",
    rfq_no: rfqNo?.value ?? "",
    sent_at: sentAt ?? "",
    rfq_items: rfqItems,
  });
}

export function vendorRfqXlsxUrl(rfqId: number, vendorId: number): string {
  return `${API_BASE}/api/admin/rfq/${rfqId}/vendor-rfq-xlsx/${vendorId}`;
}

// 단일 Vendor RFQ(레코드 id 기준) — 상세편집 DocSendPanel용 문서·이메일
export function vendorRfqPdfUrl(vrfqId: number): string {
  return `${API_BASE}/api/admin/vendor-rfq/${vrfqId}/pdf`;
}
export function vendorRfqSheetXlsxUrl(vrfqId: number): string {
  return `${API_BASE}/api/admin/vendor-rfq/${vrfqId}/xlsx`;
}
export function previewVendorRfqEmail(
  vrfqId: number,
  lang: "en" | "ko"
): Promise<DocEmailPreview> {
  return post(`/api/admin/vendor-rfq/${vrfqId}/email-preview`, { lang });
}
export function sendVendorRfqEmail(p: DocEmailSend & { vrfqId: number }) {
  return postForm<{ ok: boolean; sent_date: string }>(
    `/api/admin/vendor-rfq/${p.vrfqId}/send`,
    docEmailFormData(p)
  );
}

export function createVendorQuote(
  rfqId: number,
  vendorRfqId: number,
  vendorQuoteNo: string,
  amount: number,
  currency: string,
  items?: VendorQuoteItem[],
  receivedAt?: string,
  notes?: string,
  terms?: QuotationTerms,
  sourceFiles?: RfqSourceFile[],
  fxRate?: number | null
): Promise<{ ok: boolean; vendor_quote_no: string }> {
  return post(`/api/admin/rfq/${rfqId}/vendor-quote`, {
    vendor_rfq_id: vendorRfqId,
    vendor_quote_no: vendorQuoteNo,
    amount,
    currency,
    items,
    received_at: receivedAt,
    notes,
    terms,
    source_files: sourceFiles,
    fx_rate: fxRate,
  });
}

export function parseVendorQuoteFile(file: File): Promise<{ items: Partial<VendorQuoteItem>[] }> {
  const fd = new FormData();
  fd.append("file", file);
  return postForm<{ items: Partial<VendorQuoteItem>[] }>("/api/admin/vendor-quote-parse", fd);
}

// 해당일의 매매기준율(수출입은행) 조회. source: "exim"(고시값) | "fixed"(폴백 고정환율).
export function fetchFxRate(
  date: string,
  cur = "USD"
): Promise<{ rate: number; date_used: string; cur: string; source: "exim" | "fixed" }> {
  const q = new URLSearchParams({ date: (date || "").slice(0, 10), cur }).toString();
  return get(`/api/admin/fx-rate?${q}`);
}

export function fetchRfqVendorQuotes(
  rfqId: number
): Promise<{ vendor_quotes: VendorQuoteForImport[] }> {
  return get(`/api/admin/rfq/${rfqId}/vendor-quotes`);
}

export function createCustomerQuote(
  rfqId: number,
  currency: string,
  amount: number,
  items?: CustomerQuoteItem[],
  validUntil?: string,
  remarks?: string,
  terms?: QuotationTerms,
  qtnNo?: string,
  sentAt?: string,
  costCurrency?: string,
  roundDigits?: number,
  discountPct?: number,
  fxRate?: number | null
): Promise<{ ok: boolean; id: number; qtn_no: string }> {
  return post(`/api/admin/rfq/${rfqId}/customer-quote`, {
    qtn_no: qtnNo,
    currency,
    cost_currency: costCurrency,
    round_digits: roundDigits,
    discount_pct: discountPct,
    fx_rate: fxRate,
    amount,
    items,
    sent_at: sentAt,
    valid_until: validUntil,
    remarks,
    terms,
  });
}

export function quotationPdfUrl(qtnId: number, docType = "quotation"): string {
  return `${API_BASE}/api/admin/quotations/${qtnId}/pdf?doc_type=${encodeURIComponent(docType)}`;
}

export function quotationXlsxUrl(qtnId: number, docType = "quotation"): string {
  return `${API_BASE}/api/admin/quotations/${qtnId}/xlsx?doc_type=${encodeURIComponent(docType)}`;
}

export function previewQuotationEmail(
  qtnId: number,
  lang: "en" | "ko"
): Promise<DocEmailPreview> {
  return post(`/api/admin/quotations/${qtnId}/email-preview`, { lang });
}

export function sendQuotationEmail(p: DocEmailSend & { qtnId: number; docType?: string }) {
  const fd = docEmailFormData(p);
  fd.append("doc_type", p.docType ?? "quotation");
  return postForm<{ ok: boolean; sent_date: string }>(`/api/admin/quotations/${p.qtnId}/send`, fd);
}

// ── 목록 행 클릭 상세(보기·수정·삭제) ───────────────────────────────────────

export function fetchVendorRfqDetail(id: number): Promise<VendorRfqDetail> {
  return get<VendorRfqDetail>(`/api/admin/vendor-rfq/${id}`);
}

export function updateVendorRfq(
  id: number,
  body: {
    vendor_id?: number;
    sent_date?: string;
    sent_at?: string;
    sent_to_email?: string;
    status?: string;
    items?: { part_no: string; description: string; qty: number; unit?: string; remark?: string }[];
  }
): Promise<{ ok: boolean; id: number }> {
  return put(`/api/admin/vendor-rfq/${id}`, body);
}

export function deleteVendorRfq(id: number): Promise<{ ok: boolean; id: number }> {
  return del(`/api/admin/vendor-rfq/${id}`);
}

// 이 Vendor RFQ 의 '견적 불가' 표시를 토글한다(프로젝트 Vendor 필드 취소선 처리용).
export function toggleVendorRfqDecline(
  vrfqId: number,
  body?: { datetime?: string; reason?: string }
): Promise<{ ok: boolean; declined: boolean; status: string }> {
  return post(`/api/admin/vendor-rfq/${vrfqId}/toggle-decline`, body ?? {});
}

export function fetchVendorQuoteDetail(id: number): Promise<VendorQuoteDetail> {
  return get<VendorQuoteDetail>(`/api/admin/vendor-quote/${id}`);
}

export function updateVendorQuote(
  id: number,
  body: {
    vendor_quote_no?: string;
    received_date?: string;
    received_at?: string;
    currency?: string;
    notes?: string;
    items?: VendorQuoteItem[];
    terms?: QuotationTerms;
    fx_rate?: number | null;
    source_files?: RfqSourceFile[];
  }
): Promise<{ ok: boolean; vendor_quote_no: string; currency?: string }> {
  return put(`/api/admin/vendor-quote/${id}`, body);
}

export function deleteVendorQuote(
  id: number
): Promise<{ ok: boolean; vendor_quote_no: string }> {
  return del(`/api/admin/vendor-quote/${id}`);
}

export function fetchCustomerQuotationDetail(
  id: number
): Promise<CustomerQuotationDetail> {
  return get<CustomerQuotationDetail>(`/api/admin/quotation/${id}`);
}

export function updateCustomerQuotation(
  id: number,
  body: {
    qtn_no?: string;
    currency?: string;
    cost_currency?: string;
    round_digits?: number;
    discount_pct?: number;
    fx_rate?: number | null;
    items?: CustomerQuoteItem[];
    sent_at?: string;
    valid_until?: string;
    status?: string;
    terms?: QuotationTerms;
  }
): Promise<{ ok: boolean; qtn_no: string }> {
  return put(`/api/admin/quotation/${id}`, body);
}

export function deleteCustomerQuotation(
  id: number
): Promise<{ ok: boolean; qtn_no: string }> {
  return del(`/api/admin/quotation/${id}`);
}

export function updateOrder(
  id: number,
  body: {
    customer_id?: number;
    vessel_id?: number;
    po_no?: string;
    date?: string;
    currency?: string;
    trade_type?: string;
    promised_delivery?: string | null;
    items?: PoWorkItem[];
    terms?: QuotationTerms;
    source_files?: RfqSourceFile[];
  }
): Promise<{ ok: boolean; id: number; project_no: string }> {
  return put(`/api/admin/orders/${id}`, body);
}

export function deleteOrder(id: number): Promise<{ ok: boolean; project_no: string }> {
  return del(`/api/admin/orders/${id}`);
}

export function fetchVendorPoDetail(id: number): Promise<PurchaseOrderDetail> {
  return get<PurchaseOrderDetail>(`/api/admin/vendor-pos/${id}`);
}

export function updatePurchaseOrder(
  id: number,
  body: {
    vendor_id?: number;
    po_no?: string;
    date?: string;
    sent_date?: string;
    currency?: string;
    status?: string;
    items?: PoWorkItem[];
    terms?: QuotationTerms;
    source_files?: RfqSourceFile[];
  }
): Promise<{ ok: boolean; id: number; po_no: string }> {
  return put(`/api/admin/vendor-pos/${id}`, body);
}

export function deletePurchaseOrder(
  id: number
): Promise<{ ok: boolean; po_no: string }> {
  return del(`/api/admin/vendor-pos/${id}`);
}
