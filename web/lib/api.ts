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
  body: string,
  format: "pdf" | "xlsx" = "pdf",
  cc = "",
  from = ""
): Promise<{ ok: boolean; sent_date: string }> {
  return post(`/api/admin/vendor-pos/${poId}/send`, { to, subject, body, format, cc, from_email: from });
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

export function saveCommercialInvoice(
  orderId: number,
  body: {
    ci_no?: string;
    date?: string;
    currency: string;
    vat_rate: number;
    items: DocumentWorkItem[];
    shipping: Record<string, string>;
  }
): Promise<{ ok: boolean; id: number; ci_no: string }> {
  return post(`/api/admin/documents/${orderId}/ci`, body);
}

export function deleteCommercialInvoice(orderId: number): Promise<{ ok: boolean }> {
  return del(`/api/admin/documents/${orderId}/ci`);
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
  body: { pl_no?: string; date?: string; items: DocumentWorkItem[] }
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
  kind: "ci/pdf" | "pl/pdf" | "sa/pdf" | "tax/xlsx"
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
): Promise<{ to: string; from: string; subject: string; body: string; smtp_configured: boolean }> {
  return post(`/api/admin/vendor-rfq/${vrfqId}/email-preview`, { lang });
}
export function sendVendorRfqEmail(
  vrfqId: number,
  to: string,
  subject: string,
  body: string,
  format: "xlsx" | "pdf" = "xlsx",
  cc = "",
  from = ""
): Promise<{ ok: boolean; sent_date: string }> {
  return post(`/api/admin/vendor-rfq/${vrfqId}/send`, { to, subject, body, format, cc, from_email: from });
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
  terms?: QuotationTerms
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
  terms?: QuotationTerms,
  qtnNo?: string,
  sentAt?: string,
  costCurrency?: string,
  roundDigits?: number,
  discountPct?: number
): Promise<{ ok: boolean; id: number; qtn_no: string }> {
  return post(`/api/admin/rfq/${rfqId}/customer-quote`, {
    qtn_no: qtnNo,
    currency,
    cost_currency: costCurrency,
    round_digits: roundDigits,
    discount_pct: discountPct,
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
): Promise<{ to: string; from: string; subject: string; body: string; smtp_configured: boolean }> {
  return post(`/api/admin/quotations/${qtnId}/email-preview`, { lang });
}

export function sendQuotationEmail(
  qtnId: number,
  to: string,
  subject: string,
  body: string,
  docType = "quotation",
  format: "pdf" | "xlsx" = "pdf",
  cc = "",
  from = ""
): Promise<{ ok: boolean; sent_date: string }> {
  return post(`/api/admin/quotations/${qtnId}/send`, {
    to,
    subject,
    body,
    doc_type: docType,
    format,
    cc,
    from_email: from,
  });
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
  }
): Promise<{ ok: boolean; id: number; po_no: string }> {
  return put(`/api/admin/vendor-pos/${id}`, body);
}

export function deletePurchaseOrder(
  id: number
): Promise<{ ok: boolean; po_no: string }> {
  return del(`/api/admin/vendor-pos/${id}`);
}
