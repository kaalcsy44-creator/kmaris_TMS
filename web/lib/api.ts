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
  QtnRow,
  VrfqRow,
  DocRow,
  VendorPoRow,
  ArData,
  SettingsCustomer,
  SettingsVendor,
  SettingsVessel,
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
  items: { part_no: string; description: string; qty: number }[];
}): Promise<{ ok: boolean; id: number; rfq_no: string }> {
  return post("/api/admin/rfq", body);
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
export function createSettingsCustomer(body: {
  name: string;
  contact?: string;
  email?: string;
  country?: string;
}): Promise<{ ok: boolean; id: number }> {
  return post("/api/admin/settings/customers", body);
}
export function createSettingsVendor(body: {
  name: string;
  contact?: string;
  email?: string;
  specialization?: string;
}): Promise<{ ok: boolean; id: number }> {
  return post("/api/admin/settings/vendors", body);
}
export function createSettingsVessel(body: {
  name: string;
  imo?: string;
  customer_id?: number;
}): Promise<{ ok: boolean; id: number }> {
  return post("/api/admin/settings/vessels", body);
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

export function createVendorRfq(
  rfqId: number,
  vendorId: number
): Promise<{ ok: boolean; vrfq_no: string; vendor: string }> {
  return post(`/api/admin/rfq/${rfqId}/vendor-rfq`, { vendor_id: vendorId });
}

export function createVendorQuote(
  rfqId: number,
  vendorRfqId: number,
  vendorQuoteNo: string,
  amount: number
): Promise<{ ok: boolean; vendor_quote_no: string }> {
  return post(`/api/admin/rfq/${rfqId}/vendor-quote`, {
    vendor_rfq_id: vendorRfqId,
    vendor_quote_no: vendorQuoteNo,
    amount,
  });
}

export function createCustomerQuote(
  rfqId: number,
  currency: string,
  amount: number
): Promise<{ ok: boolean; qtn_no: string }> {
  return post(`/api/admin/rfq/${rfqId}/customer-quote`, { currency, amount });
}
