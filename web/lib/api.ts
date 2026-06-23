import { API_BASE } from "./config";
import { getToken, clearAuth } from "./auth";
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
  OrderOcrResult,
  VendorPoPreview,
  VendorRfqPreview,
  VendorQuoteItem,
  CustomerQuoteItem,
  QuotationTerms,
  VendorQuoteForImport,
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
  SettingsUser,
  CompanyProfile,
  PipelineData,
  StageNote,
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
    const e = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(e.detail ?? `API ${res.status} ${res.statusText} — ${path}`);
  }
  return res.json() as Promise<T>;
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
  items: { part_no: string; description: string; qty: number }[];
}): Promise<{ ok: boolean; id: number; rfq_no: string }> {
  return post("/api/admin/rfq", body);
}

export function updateRfq(
  rfqId: number,
  body: {
    customer_id?: number;
    vessel_id?: number;
    customer_rfq_no?: string;
    contact_person?: string;
    project_title?: string;
    work_type?: string;
    received_at?: string;
    items?: { part_no: string; description: string; qty: number }[];
  }
): Promise<{ ok: boolean; id: number }> {
  return patch(`/api/admin/rfq/${rfqId}`, body);
}

export function addRfqStageNote(
  rfqId: number,
  stage: number,
  payload: { text: string; datetime?: string; party?: string; channel?: string }
): Promise<{ ok: boolean; stage: number; notes: StageNote[] }> {
  return post(`/api/admin/rfq/${rfqId}/stage-note`, { stage, ...payload });
}

export function updateRfqStageNote(
  rfqId: number,
  stage: number,
  index: number,
  payload: { text: string; datetime?: string; party?: string; channel?: string }
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

export function updateRfqLevel(
  rfqId: number,
  followUpLevel: string
): Promise<{ ok: boolean; follow_up_level: string }> {
  return put(`/api/admin/rfq/${rfqId}/level`, { follow_up_level: followUpLevel });
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

export function fetchPipeline(customerId?: number): Promise<PipelineData> {
  const qs = customerId ? `?customer_id=${customerId}` : "";
  return get<PipelineData>(`/api/admin/pipeline${qs}`);
}

export function fetchDashboard(): Promise<DashboardData> {
  return get<DashboardData>("/api/admin/dashboard");
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
  promised_delivery?: string | null;
  items: PoWorkItem[];
}): Promise<{ ok: boolean; id: number; ord_no: string }> {
  return post("/api/admin/orders", body);
}

export function createPurchaseOrder(body: {
  order_id: number;
  vendor_id: number;
  date?: string;
  items: PoWorkItem[];
}): Promise<{ ok: boolean; id: number; po_no: string }> {
  return post("/api/admin/vendor-pos", body);
}

export function previewVendorPo(
  poId: number,
  lang: "en" | "ko",
  notes: string
): Promise<VendorPoPreview> {
  return post(`/api/admin/vendor-pos/${poId}/preview`, { lang, notes });
}

export function sendVendorPo(
  poId: number,
  to: string,
  subject: string,
  body: string
): Promise<{ ok: boolean; sent_date: string }> {
  return post(`/api/admin/vendor-pos/${poId}/send`, { to, subject, body });
}

export function vendorPoPdfUrl(poId: number): string {
  return `${API_BASE}/api/admin/vendor-pos/${poId}/pdf`;
}

export function fetchQuotationOverview(customerId?: number): Promise<{ rows: QtnRow[] }> {
  const q = customerId ? `?customer_id=${customerId}` : "";
  return get<{ rows: QtnRow[] }>(`/api/admin/quotation-overview${q}`);
}

export function fetchVrfqOverview(): Promise<{ rows: VrfqRow[] }> {
  return get<{ rows: VrfqRow[] }>("/api/admin/vrfq-overview");
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

export function saveCommercialInvoice(
  orderId: number,
  body: {
    date?: string;
    currency: string;
    vat_rate: number;
    items: DocumentWorkItem[];
    shipping: Record<string, string>;
  }
): Promise<{ ok: boolean; id: number; ci_no: string }> {
  return post(`/api/admin/documents/${orderId}/ci`, body);
}

export function savePackingList(
  orderId: number,
  body: { date?: string; items: DocumentWorkItem[] }
): Promise<{ ok: boolean; id: number; pl_no: string }> {
  return post(`/api/admin/documents/${orderId}/pl`, body);
}

export function saveShippingAdvice(
  orderId: number,
  body: { date?: string; shipping: Record<string, string> }
): Promise<{ ok: boolean; id: number; sa_no: string }> {
  return post(`/api/admin/documents/${orderId}/sa`, body);
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
    date?: string;
    supply_type: string;
    buyer_business_no: string;
    vat_rate: number;
  }
): Promise<{ ok: boolean; id: number; tax_no: string; ar_id: number }> {
  return post(`/api/admin/documents/${orderId}/tax`, body);
}

export function documentDownloadUrl(
  orderId: number,
  kind: "ci/pdf" | "pl/pdf" | "sa/pdf" | "tax/xlsx"
): string {
  return `${API_BASE}/api/admin/documents/${orderId}/${kind}`;
}

export function fetchVendorPoOverview(): Promise<{ rows: VendorPoRow[] }> {
  return get<{ rows: VendorPoRow[] }>("/api/admin/vendor-po-overview");
}

export function fetchArOverview(): Promise<ArData> {
  return get<ArData>("/api/admin/ar-overview");
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
): Promise<{ ok: boolean; vrfq_no: string; vendor: string }> {
  return post(`/api/admin/rfq/${rfqId}/vendor-rfq`, { vendor_id: vendorId });
}

export function previewVendorRfq(
  rfqId: number,
  vendorIds: number[],
  lang: "en" | "ko",
  notes: string,
  rfqNo?: { mode: "auto" | "manual"; value: string }
): Promise<{ previews: VendorRfqPreview[]; smtp_configured: boolean }> {
  return post(`/api/admin/rfq/${rfqId}/vendor-rfq-preview`, {
    vendor_ids: vendorIds,
    lang,
    notes,
    rfq_no_mode: rfqNo?.mode ?? "auto",
    rfq_no: rfqNo?.value ?? "",
  });
}

export function sendVendorRfq(
  rfqId: number,
  items: { vendor_id: number; to: string; subject: string; body: string }[],
  rfqNo?: { mode: "auto" | "manual"; value: string },
  sentAt?: string
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
  });
}

export function vendorRfqXlsxUrl(rfqId: number, vendorId: number): string {
  return `${API_BASE}/api/admin/rfq/${rfqId}/vendor-rfq-xlsx/${vendorId}`;
}

export function createVendorQuote(
  rfqId: number,
  vendorRfqId: number,
  vendorQuoteNo: string,
  amount: number,
  items?: VendorQuoteItem[],
  receivedDate?: string,
  notes?: string
): Promise<{ ok: boolean; vendor_quote_no: string }> {
  return post(`/api/admin/rfq/${rfqId}/vendor-quote`, {
    vendor_rfq_id: vendorRfqId,
    vendor_quote_no: vendorQuoteNo,
    amount,
    items,
    received_date: receivedDate,
    notes,
  });
}

export function parseVendorQuoteFile(file: File): Promise<{ items: Partial<VendorQuoteItem>[] }> {
  const fd = new FormData();
  fd.append("file", file);
  return postForm<{ items: Partial<VendorQuoteItem>[] }>("/api/admin/vendor-quote-parse", fd);
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
  terms?: QuotationTerms
): Promise<{ ok: boolean; id: number; qtn_no: string }> {
  return post(`/api/admin/rfq/${rfqId}/customer-quote`, {
    currency,
    amount,
    items,
    valid_until: validUntil,
    remarks,
    terms,
  });
}

export function quotationPdfUrl(qtnId: number, docType = "quotation"): string {
  return `${API_BASE}/api/admin/quotations/${qtnId}/pdf?doc_type=${encodeURIComponent(docType)}`;
}

export function previewQuotationEmail(
  qtnId: number,
  lang: "en" | "ko"
): Promise<{ to: string; subject: string; body: string; smtp_configured: boolean }> {
  return post(`/api/admin/quotations/${qtnId}/email-preview`, { lang });
}

export function sendQuotationEmail(
  qtnId: number,
  to: string,
  subject: string,
  body: string,
  docType = "quotation"
): Promise<{ ok: boolean; sent_date: string }> {
  return post(`/api/admin/quotations/${qtnId}/send`, {
    to,
    subject,
    body,
    doc_type: docType,
  });
}
