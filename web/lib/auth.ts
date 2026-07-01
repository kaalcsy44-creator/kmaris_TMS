import { API_BASE } from "./config";

const TOKEN_KEY = "ktms_token";
const USER_KEY = "ktms_user";
const PERMS_KEY = "ktms_perms";
const SCOPE_KEY = "ktms_scope";

export type AuthUser = {
  id: number;
  username: string;
  role: string;
  email?: string;
};

// 권한 그리드: {module: {action: bool}}
export type PermGrid = Record<string, Record<string, boolean>>;
export type PermModule =
  | "dashboard" | "progress" | "rfq" | "po" | "documents" | "ar" | "settings";
export type PermAction = "view" | "create" | "edit" | "delete";

export function getToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function getUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_KEY);
  return raw ? (JSON.parse(raw) as AuthUser) : null;
}

/** 현재 사용자 역할(admin | sales | viewer). 비로그인 시 빈 문자열. */
export function getRole(): string {
  return getUser()?.role ?? "";
}

/** 관리자 여부 — 사용자/권한/회사 설정 관리 권한. (항상 전체 권한) */
export function isAdmin(): boolean {
  return getRole() === "admin";
}

/** 현재 로그인 사용자 id(비로그인 시 0). */
export function getUserId(): number {
  return getUser()?.id ?? 0;
}

/**
 * 딜(건) 편집 가능 여부 — 담당자(PIC=assignee_id) 기준.
 * admin 은 전체 편집. 비관리자는 본인이 PIC 인 건만. PIC 미지정(null) 건은 열려 있음.
 * (백엔드가 최종 강제하며, 이 함수는 UI 버튼 활성/비활성용.)
 */
export function canEditDeal(assigneeId: number | null | undefined): boolean {
  if (isAdmin()) return true;
  if (assigneeId == null || assigneeId === 0) return true; // 담당자 미지정 = 열림(백엔드와 일치)
  return getUserId() === assigneeId;
}

/**
 * 편집이 막힌 정확한 사유 문구(편집 가능하면 ""). 역할 권한 부족과 담당(PIC) 불일치를
 * 구분해, "담당인데 왜 안 되지?" 같은 오해를 없앤다.
 */
export function editBlockReason(
  module: PermModule,
  assigneeId: number | null | undefined
): string {
  if (isAdmin()) return "";
  const roleOk = can(module, "edit");
  const ownOk = canEditDeal(assigneeId);
  if (roleOk && ownOk) return "";
  if (!ownOk) return "View only — assigned to another PIC";
  return "View only — your role has no edit permission for this page";
}

/** 저장된 권한 그리드. 없으면 null. */
export function getPerms(): PermGrid | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(PERMS_KEY);
  return raw ? (JSON.parse(raw) as PermGrid) : null;
}

/** 데이터 범위: "own"(본인 담당만) | "all"(전체). 기본 all. */
export function dataScope(): "own" | "all" {
  if (typeof window === "undefined") return "all";
  return localStorage.getItem(SCOPE_KEY) === "own" ? "own" : "all";
}

/** 본인 담당 건만 강제로 보이는 역할인지(데이터 범위 own). */
export function isOwnScoped(): boolean {
  return dataScope() === "own" && !isAdmin();
}

/**
 * 페이지×동작 권한 확인. admin 은 항상 true.
 * 권한 정보가 아직 없으면(구버전 토큰 등) 보수적으로 admin 만 허용.
 */
export function can(module: PermModule, action: PermAction): boolean {
  if (isAdmin()) return true;
  const perms = getPerms();
  if (!perms) return false;
  return !!perms[module]?.[action];
}

export function clearAuth(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(PERMS_KEY);
  localStorage.removeItem(SCOPE_KEY);
}

function storeAuth(data: {
  token?: string;
  user?: AuthUser;
  permissions?: PermGrid;
  scope?: string;
}): void {
  if (data.token) localStorage.setItem(TOKEN_KEY, data.token);
  if (data.user) localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  if (data.permissions)
    localStorage.setItem(PERMS_KEY, JSON.stringify(data.permissions));
  if (data.scope) localStorage.setItem(SCOPE_KEY, data.scope);
}

export async function login(
  username: string,
  password: string
): Promise<AuthUser> {
  const res = await fetch(`${API_BASE}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(e.detail ?? "로그인 실패");
  }
  const data = (await res.json()) as {
    token: string;
    user: AuthUser;
    permissions?: PermGrid;
    scope?: string;
  };
  storeAuth(data);
  return data.user;
}

/** 권한이 바뀌었을 수 있을 때 최신 권한을 다시 받아 저장. */
export async function refreshPermissions(): Promise<void> {
  const token = getToken();
  if (!token) return;
  const res = await fetch(`${API_BASE}/api/admin/me/permissions`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) return;
  const data = (await res.json()) as { permissions?: PermGrid; scope?: string };
  storeAuth({ permissions: data.permissions, scope: data.scope });
}

export function logout(): void {
  clearAuth();
  if (typeof window !== "undefined") window.location.href = "/login";
}
