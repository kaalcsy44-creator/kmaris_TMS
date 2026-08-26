import { API_BASE } from "./config";
import { getToken, clearAuth } from "./auth";
import { invalidateCache } from "./useCachedData";
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
  BusinessCardOcr,
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
  TaxInvoiceItem,
  DocCharges,
  QtnRow,
  VrfqRow,
  DocRow,
  VendorPoRow,
  ArData,
  ApByOrderRow,
  ApSave,
  FinancePayable,
  FinancePayableSave,
  FinanceIncomeSave,
  FinanceReceivable,
  FxQuote,
  FinanceSummary,
  FinanceClosing,
  FinanceProfit,
  FinanceConsultingRow,
  SettingsConsultant,
  FinanceCashflow,
  FinanceCashflowItems,
  CashBucket,
  FinanceCalendarEvent,
  SettingsCustomer,
  SettingsVendor,
  SettingsVessel,
  SettingsItem,
  ItemCategory,
  ItemLedger,
  AutoCategoryProposal,
  ItemPriceRow,
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
  MailDateRow,
  MailDigest,
  MailMessage,
  MailStatus,
  MailUnknownAddr,
  MailAddrLink,
  MailAttachResult,
  MailRegisterResult,
  MailSyncResult,
  MailAutoMatchResult,
  UnmatchedMailGroup,
  ProjectMail,
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

async function postBlob(path: string, body: unknown): Promise<Blob> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    clearAuth();
    if (typeof window !== "undefined") window.location.href = "/login";
    throw new Error("인증이 필요합니다.");
  }
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { detail?: unknown };
    throw new Error(errorDetailToString(e?.detail) || `API ${res.status} ${res.statusText} — ${path}`);
  }
  return res.blob();
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
  consultant_id?: number;
  consultant_rate?: number | null;
  notes?: string;
  items: { part_no: string; description: string; type?: string; serial_no?: string; qty: number; remark?: string; category_id?: number | null }[];
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
    // 0 → 소개자 연결 해제. 요율은 음수를 '비우기'(컨설턴트 기본율로 되돌림)로 읽는다.
    consultant_id?: number;
    consultant_rate?: number;
    notes?: string;
    received_at?: string;
    assignee_id?: number;
    items?: { part_no: string; description: string; type?: string; serial_no?: string; qty: number; remark?: string; category_id?: number | null }[];
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

// 명함(사진·캡쳐·PDF) 인식 — Customer/Vendor 등록 폼 자동 입력용.
export function parseBusinessCard(file: File): Promise<BusinessCardOcr> {
  const fd = new FormData();
  fd.append("file", file);
  return postForm<BusinessCardOcr>("/api/admin/ocr/business-card", fd);
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

/** 표(HTML) 서명의 입력 필드. 여러 줄 칸(이메일·주소 등)은 배열로 오간다. */
export interface SignatureFields {
  closing: string;
  name: string;
  title: string;
  mobile_label: string;
  mobile: string;
  emails: string[];
  website: string;
  address: string[];
  tagline: string[];
  services: string[];
  disclaimer: string;
}

/** 담당자 이메일 서명 — 발송 화면 기본값(개인 → 회사 → 내장 기본 순으로 해석된 값).
 *  fields 는 표 서명의 입력값(없으면 폼을 채울 출발값), has_fields 로 구분한다.
 *  userId 를 주면 그 담당자의 서명을 본다(발송 화면의 서명 선택, 관리자의 대리 편집). */
export function fetchEmailSignature(lang: "en" | "ko", userId?: number | null): Promise<{
  lang: string;
  user_id: number;
  signature: string;
  is_personal: boolean;
  fields: SignatureFields;
  has_fields: boolean;
  html: string;
}> {
  const q = userId == null ? "" : `&user_id=${userId}`;
  return get(`/api/admin/settings/email-signature?lang=${lang}${q}`);
}

/** 담당자별 서명 목록 — 발송 화면에서 누구 이름으로 서명할지 고르는 선택지.
 *  평문까지 함께 와서 고르는 즉시 서명칸을 바꿀 수 있다. */
export interface SignatureOwner {
  user_id: number;
  username: string;
  name: string;
  signature: string;
  is_default: boolean;   // 개인 서명 없이 회사/내장 기본을 쓰는 사람
}
export function fetchEmailSignatures(
  lang: "en" | "ko" = "en"
): Promise<{ lang: string; me: number; rows: SignatureOwner[] }> {
  return get(`/api/admin/email/signatures?lang=${lang}`);
}

/** 개인 서명 저장(이후 모든 단계의 기본 서명). fields 를 주면 표 서명으로 저장한다.
 *  userId 는 관리자가 다른 담당자의 서명을 대신 만들 때만 준다. */
export function saveEmailSignature(
  lang: "en" | "ko",
  signature: string,
  fields?: SignatureFields | null,
  userId?: number | null
): Promise<{ ok: boolean; user_id: number; signature: string; html: string }> {
  return put(`/api/admin/settings/email-signature`, {
    lang,
    signature,
    fields,
    user_id: userId ?? null,
  });
}

/** 편집 중인 서명 필드 → 발송에 쓰일 HTML/평문 그대로(저장 전 미리보기). */
export function previewEmailSignature(
  lang: "en" | "ko",
  fields: SignatureFields
): Promise<{ html: string; text: string }> {
  return post(`/api/admin/settings/email-signature/preview`, { lang, fields });
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

/** 문서 API 의 대상 — 고객 P/O(오더) 단위이거나, 아직 오더가 없는 프로젝트(딜) 단위.
 *  Proforma Invoice 는 4단계(견적 발송·선급금 청구)에서도 만드는데 그때는 오더가 없어
 *  딜에 달아 둔다. 서버가 같은 한 장으로 이어 주므로 화면은 어느 쪽으로 불러도 된다. */
export type DocTarget = { orderId: number } | { rfqId: number };

export function docApiBase(t: DocTarget): string {
  return "orderId" in t ? `/api/admin/documents/${t.orderId}` : `/api/admin/projects/${t.rfqId}`;
}

/** 4단계 Proforma Invoice 화면의 문서 문맥 — 오더 상세와 같은 모양(오더 없으면 order.id = 0). */
export function fetchProjectDocContext(rfqId: number): Promise<DocumentDetail> {
  return get<DocumentDetail>(`/api/admin/projects/${rfqId}/doc-context`);
}

export function saveProformaInvoice(
  target: DocTarget,
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
  return post(`${docApiBase(target)}/pi`, body);
}

export function deleteProformaInvoice(target: DocTarget): Promise<{ ok: boolean }> {
  return del(`${docApiBase(target)}/pi`);
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
  target: DocTarget,
  kind: "pi/pdf" | "pi/xlsx" | "ci/pdf" | "ci/xlsx" | "sm/pdf" | "sm/xlsx" | "pl/pdf" | "pl/xlsx" | "tax/xlsx"
): string {
  return `${API_BASE}${docApiBase(target)}/${kind}`;
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

/** POD 화면 메모 저장 — 파일과 독립(파일을 지워도 메모는 남는다). */
export function savePodNotes(
  orderId: number,
  notes: string
): Promise<{ ok: boolean; notes: string }> {
  return post(`/api/admin/documents/${orderId}/pod/notes`, { notes });
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

// ── Finance(재무) — 수금/미수·지급대장·캘린더 ─────────────────────────────────
/** month(YYYY-MM)는 '실제로 오간 돈' 집계에만 걸린다 — 잔액 KPI 는 늘 오늘 기준. */
export function fetchFinanceSummary(month = ""): Promise<FinanceSummary> {
  return get<FinanceSummary>(
    `/api/admin/finance/summary${month ? `?month=${encodeURIComponent(month)}` : ""}`
  );
}
export function fetchFinanceReceivables(): Promise<{ rows: FinanceReceivable[]; fx: FxQuote }> {
  return get<{ rows: FinanceReceivable[]; fx: FxQuote }>("/api/admin/finance/receivables");
}
export function fetchFinancePayables(): Promise<{ rows: FinancePayable[]; fx: FxQuote }> {
  return get<{ rows: FinancePayable[]; fx: FxQuote }>("/api/admin/finance/payables");
}
export function createFinancePayable(body: FinancePayableSave): Promise<{ ok: boolean; id: number }> {
  return post("/api/admin/finance/payables", body);
}
export function updateFinancePayable(id: number, body: FinancePayableSave): Promise<{ ok: boolean; id: number }> {
  return put(`/api/admin/finance/payables/${id}`, body);
}
export function deleteFinancePayable(id: number): Promise<{ ok: boolean }> {
  return del(`/api/admin/finance/payables/${id}`);
}
// ── 기타 수입(수동 등록) — 지급대장과 같은 규약 ─────────────────────────────────
export function createFinanceIncome(body: FinanceIncomeSave): Promise<{ ok: boolean; id: number }> {
  return post("/api/admin/finance/incomes", body);
}
export function updateFinanceIncome(id: number, body: FinanceIncomeSave): Promise<{ ok: boolean; id: number }> {
  return put(`/api/admin/finance/incomes/${id}`, body);
}
export function deleteFinanceIncome(id: number): Promise<{ ok: boolean }> {
  return del(`/api/admin/finance/incomes/${id}`);
}
/** 입금 표시 토글. paidOn = 실제 입금일(예정일과 달라도 됨). */
export function receiveFinanceIncome(
  id: number,
  paid: boolean,
  occurrence?: string,
  paidOn?: string
): Promise<{ ok: boolean }> {
  return post(`/api/admin/finance/incomes/${id}/receive`, {
    paid,
    occurrence: occurrence ?? null,
    paid_on: paidOn ?? null,
  });
}
/** 납부 표시 토글. paidOn = 실제 납부일(예정일과 달라도 됨, 미지정 시 서버가 오늘로). */
export function payFinancePayable(
  id: number,
  paid: boolean,
  occurrence?: string,
  paidOn?: string
): Promise<{ ok: boolean }> {
  return post(`/api/admin/finance/payables/${id}/pay`, {
    paid,
    occurrence: occurrence ?? null,
    paid_on: paidOn ?? null,
  });
}
export function fetchFinanceCalendar(start: string, end: string): Promise<{ rows: FinanceCalendarEvent[]; start: string; end: string }> {
  return get<{ rows: FinanceCalendarEvent[]; start: string; end: string }>(
    `/api/admin/finance/calendar?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
  );
}
export function fetchFinanceClosing(start: string, end: string, year: number): Promise<FinanceClosing> {
  return get<FinanceClosing>(
    `/api/admin/finance/closing?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&year=${year}`
  );
}
/** full=true 면 칸별 내역을 접지 않고 전부 받는다(표 안에 줄로 펼쳐 보는 화면용). */
export function fetchFinanceProfit(year: number, full = false): Promise<FinanceProfit> {
  return get<FinanceProfit>(`/api/admin/finance/profit?year=${year}${full ? "&detail=full" : ""}`);
}
export function fetchFinanceConsulting(): Promise<{ rows: FinanceConsultingRow[]; usd_krw: number }> {
  return get<{ rows: FinanceConsultingRow[]; usd_krw: number }>("/api/admin/finance/consulting");
}
export function fetchFinanceCashflow(
  unit: "month" | "week",
  count: number,
  opening: number,
  includePo: boolean,
  currency = "KRW",
  start = "",
  /** 연체(예정일이 지난 미정산)를 잔고에 태울지 — 기본은 흐름 밖에 세워 둔다. */
  includeOverdue = false,
  /**
   * 예정(아직 안 오간 돈)을 잔고에 태울지 — 기본은 세워 둔다. 끄면 잔고가 통장을 그대로
   * 비추고(실제로 오간 돈만), 켜면 앞으로의 부족을 미리 보는 예측이 된다.
   * 연체는 예정의 부분집합이라 이걸 끄면 includeOverdue 는 뜻을 잃는다(서버가 함께 끈다).
   */
  includeExpected = false
): Promise<FinanceCashflow> {
  return get<FinanceCashflow>(
    `/api/admin/finance/cashflow?unit=${unit}&count=${count}&opening=${opening}` +
      `&include_po=${includePo ? 1 : 0}&currency=${encodeURIComponent(currency)}` +
      `&include_overdue=${includeOverdue ? 1 : 0}` +
      `&include_expected=${includeExpected ? 1 : 0}` +
      (start ? `&start=${encodeURIComponent(start)}` : "")
  );
}
/**
 * 현금흐름 한 구간의 건별 내역.
 * first=창의 첫 칸(앞선 연체를 흡수하는 칸)인지, bucket=여섯 갈래 중 하나만 볼 때.
 */
export function fetchFinanceCashflowItems(
  start: string,
  end: string,
  currency = "KRW",
  includePo = false,
  first = false,
  bucket: CashBucket | "" = ""
): Promise<FinanceCashflowItems> {
  return get<FinanceCashflowItems>(
    `/api/admin/finance/cashflow/items?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}` +
      `&currency=${encodeURIComponent(currency)}&include_po=${includePo ? 1 : 0}&first=${first ? 1 : 0}` +
      (bucket ? `&bucket=${bucket}` : "")
  );
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

// 제목·본문은 수신자 이름 자리에 {{contact}} 토큰이 남아 있는 '원본'으로 내려온다
// (실제 이름 치환은 작성 화면에서 — 수신자를 바꾸면 즉시 따라 바뀌게 하려고).
export function marketingComposeDefaults(opts: {
  kind?: "intro" | "brochure";
  lang?: "en" | "ko";
}): Promise<{
  from: string;
  subject: string;
  body: string;
  signature: string;
  saved: boolean;
  smtp_configured: boolean;
}> {
  const p = new URLSearchParams({ kind: opts.kind ?? "intro", lang: opts.lang ?? "en" });
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

// 자주 쓰는 CC 주소록(팀 공용) — 작성 화면에서 클릭으로 골라 넣는다.
export type CcPreset = { email: string; label: string };

export function fetchCcPresets(): Promise<{ rows: CcPreset[] }> {
  return get("/api/admin/marketing/cc-presets");
}

// 목록 전체 교체(추가·삭제 모두 이 경로).
export function saveCcPresets(rows: CcPreset[]): Promise<{ ok: boolean; rows: CcPreset[] }> {
  return put("/api/admin/marketing/cc-presets", { rows });
}

// 수신자 한 명 = 메일 한 통. 여러 명을 주면 서버가 인사말({{contact}})을 각자
// 이름으로 바꿔 따로 보낸다(서로의 주소는 노출되지 않는다).
export type MarketingRecipient = {
  email: string;
  customer_id: number | null;
  prospect_name: string;
  contact_person: string;
};

export function sendMarketingEmail(input: {
  to: string;
  recipients?: MarketingRecipient[];
  subject: string;
  body: string;
  signature?: string;
  includeSignature?: boolean;
  cc?: string;
  from?: string;
  customerId?: number | null;
  prospectName?: string;
  contactPerson?: string;
  lang?: "en" | "ko";
  assetIds?: number[];
  files?: File[];
}): Promise<{
  ok: boolean;
  id: number;
  sent_date: string;
  sent: string[];
  failed: string[];
}> {
  const fd = new FormData();
  fd.append("to", input.to);
  fd.append("recipients", JSON.stringify(input.recipients ?? []));
  fd.append("subject", input.subject ?? "");
  fd.append("body", input.body ?? "");
  fd.append("signature", input.signature ?? "");
  fd.append("include_signature", String(input.includeSignature ?? true));
  fd.append("cc", input.cc ?? "");
  fd.append("from_email", input.from ?? "");
  fd.append("customer_id", input.customerId ? String(input.customerId) : "");
  fd.append("prospect_name", input.prospectName ?? "");
  fd.append("contact_person", input.contactPerson ?? "");
  fd.append("lang", input.lang ?? "en");
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
  tax_invoice_email?: string;
  payment_terms?: string;
  logo?: string;
  addresses?: string[];
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
// 회사 공통정보(주소·사업자번호·결제조건·로고)를 같은 회사명의 담당자 레코드 전체에 일괄 반영.
// 값을 넘긴 필드만 바뀐다(빈 문자열 = 지우기). rename = 회사명 자체 변경.
// addresses = 본사·지사 주소 목록(첫 값=대표) — 서버가 대표를 flat address 로 미러링한다.
export type CompanyInfoSave = {
  name: string;
  rename?: string;
  addresses?: string[];
  tax_id?: string;
  tax_invoice_email?: string;
  payment_terms?: string;
  specialization?: string;
  logo?: string;
};
export function updateCustomerCompanyInfo(
  body: CompanyInfoSave
): Promise<{ ok: boolean; updated: number; name: string }> {
  return put("/api/admin/settings/customers/company-info", body);
}
export function updateVendorCompanyInfo(
  body: CompanyInfoSave
): Promise<{ ok: boolean; updated: number; name: string }> {
  return put("/api/admin/settings/vendors/company-info", body);
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
  addresses?: string[];
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

// 소개자(컨설턴트) 마스터 — 선박·품목과 같은 규약의 CRUD.
export function fetchSettingsConsultants(): Promise<SettingsConsultant[]> {
  return get<SettingsConsultant[]>("/api/admin/settings/consultants");
}
export function createSettingsConsultant(body: Omit<SettingsConsultant, "id">): Promise<{ ok: boolean; id: number }> {
  return post("/api/admin/settings/consultants", body);
}
export function updateSettingsConsultant(
  id: number,
  body: Omit<SettingsConsultant, "id">
): Promise<{ ok: boolean; id: number }> {
  return put(`/api/admin/settings/consultants/${id}`, body);
}
export function deleteSettingsConsultant(id: number): Promise<{ ok: boolean }> {
  return del(`/api/admin/settings/consultants/${id}`);
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
  // 편집 가능한 이메일 종류(탭) — 서버가 카탈로그를 그대로 내려준다.
  doc_types: { key: string; label: string }[];
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
  doc_type: string;
  lang: "en" | "ko";
  subject_tpl: string;
  body_tpl: string;
  options: { item_cols: string[] };
  // body_html = 실제 발송 HTML 파트와 같은 렌더 결과(수신자가 보는 모습)
}): Promise<{ subject: string; body: string; body_html?: string }> {
  return post("/api/admin/settings/email-templates/preview", body);
}
/** 편집 중인 본문(+서명)을 발송용 HTML 로 렌더 — 발송 화면 미리보기용.
 *  서명 처리도 발송과 같은 규칙(저장된 표 서명 그대로면 표, 손댔으면 평문)이다. */
export function renderEmailPreview(
  text: string,
  signature = "",
  includeSignature = true
): Promise<{ html: string }> {
  return post("/api/admin/email/render-preview", {
    text,
    signature,
    include_signature: includeSignature,
  });
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

/** 품목 식별키 → 마스터 분류. 품목표 Category 셀이 마스터 분류를 그대로 비추는 데 쓴다. */
export type ItemCategoryMap = Record<
  string,
  { item_id: number; category_id: number | null; category_path: string }
>;
export function fetchItemCategoryMap(): Promise<ItemCategoryMap> {
  return get<ItemCategoryMap>("/api/admin/settings/item-category-map");
}

// ── Item price ledger (품목별 구매가·판매가 이력) ─────────────────────────────
export function fetchItemLedger(): Promise<ItemLedger> {
  return get<ItemLedger>("/api/admin/settings/item-ledger");
}
export function fetchItemPriceHistory(params: {
  item_id?: number;
  part_no?: string;
  description?: string;
}): Promise<ItemPriceRow[]> {
  const qs = new URLSearchParams();
  if (params.item_id != null) qs.set("item_id", String(params.item_id));
  if (params.part_no != null) qs.set("part_no", params.part_no);
  if (params.description != null) qs.set("description", params.description);
  return get<ItemPriceRow[]>(`/api/admin/settings/item-ledger/history?${qs.toString()}`);
}
export function rebuildItemLedger(): Promise<{ ok: boolean; rows: number }> {
  return post("/api/admin/settings/item-ledger/rebuild", {});
}
export function assignItemLedgerCategory(body: {
  category_id: number | null;
  item_id?: number;      // 기존 마스터 재분류
  part_no?: string;      // 미연결 품목 배정(신규 생성/연결)
  description?: string;
  maker?: string;
}): Promise<{ ok: boolean; item_id: number; stamped: number }> {
  return post("/api/admin/settings/item-ledger/assign", body);
}
/** 여러 품목을 한 분류로 일괄 배정(목록에서 체크한 행들). 한 트랜잭션으로 처리된다. */
export function assignItemLedgerCategoryBulk(body: {
  category_id: number | null;
  targets: {
    item_id?: number;
    part_no?: string;
    description?: string;
    maker?: string;
  }[];
}): Promise<{ ok: boolean; assigned: number; stamped: number; skipped: number }> {
  return post("/api/admin/settings/item-ledger/assign-bulk", body);
}

/** 미분류 품목의 분류 제안(적용 전 미리보기). pending = 아직 분류가 빈 품목 수. */
export function previewAutoClassify(): Promise<{
  proposals: AutoCategoryProposal[];
  pending: number;
}> {
  return get("/api/admin/settings/item-ledger/auto-classify");
}
/** 고른 제안을 반영한다 — 행마다 제 분류로(일괄 배정과 달리 하나의 분류가 아니다). */
export function applyAutoClassify(body: {
  targets: {
    item_id?: number | null;
    part_no?: string;
    description?: string;
    maker?: string;
    category_id: number;
  }[];
}): Promise<{ ok: boolean; assigned: number; stamped: number; skipped: number }> {
  return post("/api/admin/settings/item-ledger/auto-classify", body);
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

// setTotal=true 면 amount 가 '지금까지 받은 총액'(멱등) — 같은 값을 다시 보내도 수금이
// 겹쳐 쌓이지 않고, 잘못 들어간 금액도 올바른 총액으로 고쳐 저장된다(0 = 수금 취소).
export function recordArPayment(
  arId: number,
  amount: number,
  dueDate?: string,
  setTotal = false,
  /** 실제로 돈이 들어온 날 — 수취수수료 환율의 기준일. 비우면 서버가 오늘로 본다. */
  paidOn?: string,
  /** 외화 입금에서 은행이 수수료를 떼고 넣어 주었는가(그만큼 모자란 입금도 완납으로 본다). */
  bankFee = true
): Promise<{
  ok: boolean;
  paid_amount: number;
  status: string;
  /** 완납 판정에 얹은 수취수수료(입금 통화). 원화 건은 0. */
  bank_fee: number;
  paid_date: string;
}> {
  return post(`/api/admin/ar/${arId}/payment`, {
    amount,
    due_date: dueDate ?? null,
    set_total: setTotal,
    paid_on: paidOn ?? null,
    bank_fee: bankFee,
  });
}

// 세금계산서(대금청구서) 문서 필드 — 선택적으로 함께 저장된다.
type ArDocFields = {
  invoice_no?: string;
  invoice_date?: string;
  vat_rate?: number;
  items?: TaxInvoiceItem[];
  charges?: DocCharges;
  remarks?: string;
  // 청구처(BILL TO) 오버라이드 — 비우면 고객 마스터값을 사용.
  bill_to_tax_id?: string;
  bill_to_contact?: string;
  bill_to_email?: string;
  bill_to_phone?: string;
};

export function createArRecord(body: {
  order_id: number;
  ci_no?: string;
  invoice_amount: number;
  paid_amount?: number;
  currency: string;
  due_date?: string;
  status?: string;
  notes?: string;
} & ArDocFields): Promise<{ ok: boolean; id: number }> {
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
  } & ArDocFields
): Promise<{ ok: boolean; id: number; status: string }> {
  return put(`/api/admin/ar/${arId}`, body);
}

/** TAX INVOICE(대금청구서) PDF 미리보기 — 현재 편집값으로 렌더(미저장). Blob 반환. */
export function previewTaxInvoicePdf(
  orderId: number,
  body: {
    invoice_no?: string;
    invoice_date?: string;
    due_date?: string;
    currency?: string;
    vat_rate?: number;
    items?: TaxInvoiceItem[];
    charges?: DocCharges;
    remarks?: string;
    bill_to_tax_id?: string;
    bill_to_contact?: string;
    bill_to_email?: string;
    bill_to_phone?: string;
  }
): Promise<Blob> {
  return postBlob(`/api/admin/documents/${orderId}/tax/pdf`, body);
}

export function deleteArRecord(arId: number): Promise<{ ok: boolean }> {
  return del(`/api/admin/ar/${arId}`);
}

// ── 매입 청구(AP) — 벤더 대금청구서/거래명세서·전자세금계산서 수취 ────────────────
export function fetchApByOrder(orderId: number): Promise<{ rows: ApByOrderRow[] }> {
  return get<{ rows: ApByOrderRow[] }>(`/api/admin/ap/by-order/${orderId}`);
}

export function createApRecord(body: ApSave): Promise<{ ok: boolean; id: number }> {
  return post("/api/admin/ap", body);
}

export function updateApRecord(
  apId: number,
  body: ApSave
): Promise<{ ok: boolean; id: number; status: string }> {
  return put(`/api/admin/ap/${apId}`, body);
}

export function deleteApRecord(apId: number): Promise<{ ok: boolean }> {
  return del(`/api/admin/ap/${apId}`);
}

export function recordApPayment(
  apId: number,
  amount: number,
  dueDate?: string
): Promise<{ ok: boolean; paid_amount: number; status: string }> {
  return post(`/api/admin/ap/${apId}/payment`, {
    amount,
    due_date: dueDate ?? null,
  });
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
  return post<{ ok: boolean; vendor_quote_no: string }>(`/api/admin/rfq/${rfqId}/vendor-quote`, {
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
  }).then((r) => {
    dropVendorQuoteCaches();
    return r;
  });
}

export function parseVendorQuoteFile(file: File): Promise<{ items: Partial<VendorQuoteItem>[] }> {
  const fd = new FormData();
  fd.append("file", file);
  return postForm<{ items: Partial<VendorQuoteItem>[] }>("/api/admin/vendor-quote-parse", fd);
}

// 해당일의 고시환율(수출입은행) 조회. source: "exim"(고시값) | "fixed"(폴백 고정환율).
// rate=매매기준율(계산용), tts=살 때(전신환 보내실 때), ttb=팔 때(전신환 받으실 때).
export function fetchFxRate(
  date: string,
  cur = "USD"
): Promise<{
  rate: number;
  /** 고시 단위 — JPY(100) 처럼 100단위로 고시되는 통화가 있다. 1단위당 환율은 rate/unit.
   *  구 백엔드는 이 값을 안 보낸다(없으면 1). */
  unit?: number;
  tts: number | null;
  ttb: number | null;
  date_used: string;
  cur: string;
  source: "exim" | "fixed";
  // 폴백 사유 — no_key(키 미설정) · bad_key(키 거부) · quota(일일한도) ·
  // network(요청 실패) · data_code(코드 오류) · no_data(그 날짜 고시 없음).
  reason?: "" | "no_key" | "bad_key" | "quota" | "network" | "data_code" | "no_data";
}> {
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
  fxRate?: number | null,
  vendorQuoteId?: number | null,
  marginPct?: number
): Promise<{ ok: boolean; id: number; qtn_no: string }> {
  return post<{ ok: boolean; id: number; qtn_no: string }>(`/api/admin/rfq/${rfqId}/customer-quote`, {
    qtn_no: qtnNo,
    currency,
    cost_currency: costCurrency,
    round_digits: roundDigits,
    margin_pct: marginPct,
    discount_pct: discountPct,
    fx_rate: fxRate,
    amount,
    items,
    sent_at: sentAt,
    valid_until: validUntil,
    remarks,
    terms,
    vendor_quote_id: vendorQuoteId ?? null,
  }).then((r) => {
    dropQuotationCaches();
    return r;
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
  return put<{ ok: boolean; vendor_quote_no: string; currency?: string }>(
    `/api/admin/vendor-quote/${id}`,
    body
  ).then((r) => {
    dropVendorQuoteCaches();
    return r;
  });
}

export function deleteVendorQuote(
  id: number
): Promise<{ ok: boolean; vendor_quote_no: string }> {
  return del<{ ok: boolean; vendor_quote_no: string }>(`/api/admin/vendor-quote/${id}`).then((r) => {
    dropVendorQuoteCaches();
    return r;
  });
}

/**
 * 견적을 고쳐 쓰면 그 견적을 읽고 있던 캐시를 버린다.
 *
 * 개요(Items 표)는 견적 상세를 `quotation:<id>` 로, 견적 목록을 `po:work-options` 로 캐시해
 * 두고 15초 안에 다시 마운트되면 재요청을 생략한다. 저장하고 곧바로 Overview 로 넘어가는
 * 건 몇 초짜리 동작이라 늘 그 15초 안에 들어가고, 그래서 방금 바꾼 원가 출처(벤더 견적
 * 링크)가 표에 반영되지 않은 채로 보였다 — "연결했는데 안 바뀐다".
 */
function dropQuotationCaches() {
  invalidateCache("quotation:");
  invalidateCache("po:work-options");
}

/** 벤더 견적을 고쳐 쓰면 개요가 읽는 수신 견적 목록도 버린다(번호·금액·통화가 바뀐다). */
function dropVendorQuoteCaches() {
  invalidateCache("rfq:vendor-quotes:");
  dropQuotationCaches();   // 견적 머리의 매입측 번호가 이 목록에서 온다
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
    margin_pct?: number;      // Pricing 밴드 기본 마진(%) — 다시 열 때 그대로 복원
    discount_pct?: number;
    fx_rate?: number | null;
    items?: CustomerQuoteItem[];
    sent_at?: string;
    valid_until?: string;
    status?: string;
    terms?: QuotationTerms;
    vendor_quote_id?: number | null; // 원가 출처 벤더 견적. null 이면 링크 해제.
  }
): Promise<{ ok: boolean; qtn_no: string }> {
  return put<{ ok: boolean; qtn_no: string }>(`/api/admin/quotation/${id}`, body).then((r) => {
    dropQuotationCaches();
    return r;
  });
}

export function deleteCustomerQuotation(
  id: number
): Promise<{ ok: boolean; qtn_no: string }> {
  return del<{ ok: boolean; qtn_no: string }>(`/api/admin/quotation/${id}`).then((r) => {
    dropQuotationCaches();
    return r;
  });
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

// ── 프로젝트 메일 이력 ────────────────────────────────────────────────────────
// 메일 본체는 회사 메일함에 있고, KTMS 는 거래처와 오간 것만 담아 딜에 붙여 둔다.
// summarize=true 면 아직 요약이 없는 메일을 이 호출에서 만든다(느리다 — 버튼에만 쓴다).
// 새 메일 요약은 동기화가 이미 채워 두므로 화면을 열 때는 false 로 곧장 받는다.
export function fetchProjectMail(rfqId: number, summarize = false): Promise<ProjectMail> {
  return get<ProjectMail>(`/api/admin/mail/project/${rfqId}${summarize ? "?summarize=1" : ""}`);
}
export function fetchMailStatus(): Promise<MailStatus> {
  return get<MailStatus>("/api/admin/mail/status");
}
// 등록되지 않은 상대 — 이 주소들의 메일은 지금 저장되지 않고 버려진다.
// links 는 그중 이미 딜에 붙여 둔 주소(그 주소의 메일은 담긴다).
export function fetchMailUnknownAddresses(): Promise<{
  rows: MailUnknownAddr[];
  links: MailAddrLink[];
}> {
  return get("/api/admin/mail/unknown-addresses");
}
// 거래처가 아닌 주소(뉴스레터·알림)를 목록에서 내린다 — 다음 동기화에서도 세지 않는다.
export function ignoreMailUnknownAddress(
  addr: string
): Promise<{ ok: boolean; rows: MailUnknownAddr[]; links: MailAddrLink[] }> {
  return post("/api/admin/mail/unknown-addresses/ignore", { addr });
}
// 이 주소의 메일은 이 딜의 것 — 거래처 등록 없이 붙인다. 붙이는 즉시 (1) 이미 담겨
// 있던 미분류 메일을 이 딜로 옮기고 (2) 메일함에서 지난 메일을 주소로 찾아 담는다.
export function attachMailAddressToProject(
  addr: string,
  rfqId: number
): Promise<MailAttachResult> {
  return post("/api/admin/mail/unknown-addresses/attach", { addr, rfq_id: rfqId });
}
// 미등록 주소를 고객·벤더로 올린다. partyId 를 주면 이미 있는 레코드에 주소만 더하고,
// 비우면 name 으로 새 레코드를 만든다. 등록 즉시 그 주소의 지난 메일을 찾아 담는다.
export function registerMailAddress(body: {
  addr: string;
  kind: "customer" | "vendor";
  party_id?: number;
  name?: string;
  contact?: string;
}): Promise<MailRegisterResult> {
  return post("/api/admin/mail/unknown-addresses/register", body);
}
// 붙여 둔 주소를 뗀다 — 앞으로 오는 메일만 멈추고, 이미 담은 이력은 지우지 않는다.
export function detachMailAddress(
  addr: string
): Promise<{ ok: boolean; rows: MailUnknownAddr[]; links: MailAddrLink[] }> {
  return post("/api/admin/mail/unknown-addresses/detach", { addr });
}
export function syncMail(): Promise<MailSyncResult> {
  return post<MailSyncResult>("/api/admin/mail/sync", {});
}
export function buildProjectMailRollup(rfqId: number): Promise<{ ok: boolean; rollup: string }> {
  return post(`/api/admin/mail/project/${rfqId}/rollup`, {});
}
// 업무일지 주간 캘린더 — 기간 안의 딜 메일을 날짜별로 훑기 위한 가벼운 목록.
export function fetchMailByDate(days = 120): Promise<{ days: number; rows: MailDateRow[] }> {
  return get(`/api/admin/mail/by-date?days=${days}`);
}
// 대시보드 Mail 탭 — 딜별 요약 카드를 한 번에. AI 는 부르지 않으므로 빠르다.
export function fetchMailDigest(days = 14): Promise<MailDigest> {
  return get<MailDigest>(`/api/admin/mail/digest?days=${days}`);
}
// 요약이 없거나 낡은 카드의 AI 롤업을 채운다(딜당 호출 1회라 상한을 두고 나눠 부른다).
// rfqIds 로 "지금 화면에서 요약이 빈 카드"를 짚어 준다 — 카드가 될 자격에는 단계
// 이벤트도 걸리는데 서버는 그걸 모르므로, 비워 두면 엉뚱한 딜의 요약을 만들 수 있다.
export function refreshMailDigests(
  rfqIds: number[] = [],
  limit = 10
): Promise<{ ok: boolean; written: number; remaining: number }> {
  return post("/api/admin/mail/digest/refresh", { rfq_ids: rfqIds, limit });
}
// 미분류 메일 — 대화(groups) 단위로 온다. 본문은 미리보기 길이까지만 실려 온다.
// filed=true 면 '딜 아님'으로 내려 둔 대화를 대신 본다(되돌리기용).
export function fetchUnmatchedMail(
  limit = 200,
  filed = false
): Promise<{ count: number; groups: UnmatchedMailGroup[]; filed: number }> {
  return get(`/api/admin/mail/unmatched?limit=${limit}${filed ? "&filed=1" : ""}`);
}
// 이 대화는 어느 딜에도 속하지 않는다(회사 소개·인사·자동회신) — 미분류 함에서 내린다.
// value=false 로 되돌린다. 지우는 게 아니라 표시만 바꾸는 것이다.
export function markMailNotDeal(
  ids: number[],
  value = true
): Promise<{ ok: boolean; updated: number; unmatched: number }> {
  return put("/api/admin/mail/not-deal", { ids, whole_thread: true, value });
}
// 근거(같은 대화·문서번호·같은 제목)가 분명한 미분류 메일을 서버가 스스로 붙인다.
export function autoMatchMail(): Promise<MailAutoMatchResult> {
  return post<MailAutoMatchResult>("/api/admin/mail/auto-match", {});
}
// 한 문의에서 갈라진 형제 딜의 메일 묶음 — groupWith=null 이면 이 딜을 묶음에서 뺀다.
// 메일 자체는 옮기지 않는다(읽을 때만 묶음이 펼쳐진다).
export function setProjectMailGroup(
  rfqId: number,
  groupWith: number | null
): Promise<{ ok: boolean; group: number[] }> {
  return put(`/api/admin/mail/project/${rfqId}/group`, { group_with: groupWith });
}

// rfqId=null 이면 연결을 끊어 미분류로 되돌린다. 기본은 같은 스레드 전체.
// ids 를 함께 넘기면 그 메일들(=화면에서 묶어 보여 준 대화 전체)이 같이 옮겨진다.
export function assignMail(
  msgId: number,
  rfqId: number | null,
  wholeThread = true,
  ids: number[] = []
): Promise<{ ok: boolean; updated: number; spread: number }> {
  return put(`/api/admin/mail/${msgId}/assign`, {
    rfq_id: rfqId,
    whole_thread: wholeThread,
    ids,
  });
}
