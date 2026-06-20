import { API_BASE } from "./config";
import { getToken, clearAuth } from "./auth";
import type {
  RfqOverview,
  CustomerOption,
  RfqDetail,
  DashboardData,
} from "./types";

async function get<T>(path: string): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    cache: "no-store",
  });
  if (res.status === 401) {
    clearAuth();
    if (typeof window !== "undefined") window.location.href = "/login";
    throw new Error("인증이 필요합니다.");
  }
  if (!res.ok) {
    throw new Error(`API ${res.status} ${res.statusText} — ${path}`);
  }
  return res.json() as Promise<T>;
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

export function fetchDashboard(): Promise<DashboardData> {
  return get<DashboardData>("/api/admin/dashboard");
}
