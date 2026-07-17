"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import AuthGate from "./AuthGate";
import TopNav from "./TopNav";
import { can, isAdmin } from "@/lib/auth";
import type { PermModule } from "@/lib/auth";

// active 키 → 권한 모듈(동일). 가드 대상 메뉴 목록.
const NAV_MODULES: PermModule[] = [
  "dashboard", "progress", "rfq", "po", "documents", "ar", "marketing", "settings",
];
// 열람 권한이 있는 첫 메뉴로 보낸다(차단된 페이지 접근 시). RFQ·P/O·Documents·AR 은
// 프로젝트 팝업의 단계별 작업으로 통합되어 전용 페이지가 없으므로, 그 권한만 있는
// 사용자는 프로젝트 목록으로 보낸다(단계 작업은 모두 거기서 수행).
function firstAllowed(): string {
  const order: { key: PermModule; href: string }[] = [
    { key: "dashboard", href: "/" },
    { key: "progress", href: "/project" },
    { key: "rfq", href: "/project" },
    { key: "po", href: "/project" },
    { key: "documents", href: "/project" },
    { key: "ar", href: "/project" },
    { key: "marketing", href: "/marketing" },
  ];
  const hit = order.find((o) => can(o.key, "view"));
  return hit ? hit.href : "/login";
}

/**
 * Authed layout shell: top navy nav bar + main content area below.
 * `active` is the nav item key (= permission module).
 */
export default function AppShell({
  active,
  perm,
  children,
  wide = false,
}: {
  active: string;
  /** 열람 가드에 쓸 권한 모듈. 생략하면 active 를 모듈로 본다(TopNav 의 perm 과 같은 규칙).
   *  active 가 권한 모듈이 아닌 화면(예: projects)은 반드시 이걸 줘야 한다 — 안 주면
   *  NAV_MODULES 에 없어서 가드가 통째로 건너뛰어진다. */
  perm?: PermModule;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <AuthGate>
      <ShellInner active={active} perm={perm} wide={wide}>
        {children}
      </ShellInner>
    </AuthGate>
  );
}

/** AuthGate(권한 로드 완료) 내부에서만 마운트 → 최신 권한으로 열람 가드. */
function ShellInner({
  active,
  perm,
  wide,
  children,
}: {
  active: string;
  perm?: PermModule;
  wide: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const mod = (perm ?? active) as PermModule;
  const guarded = NAV_MODULES.includes(mod);
  const settingsOk =
    mod === "settings" ? isAdmin() || can("settings", "view") : true;
  const allowed = !guarded || (can(mod, "view") && settingsOk);

  useEffect(() => {
    if (!allowed) router.replace(firstAllowed());
  }, [allowed, router]);

  if (!allowed) return <div className="state">Redirecting…</div>;

  return (
    <div className="shell">
      <TopNav active={active} />
      <main className="shell-main">
        <div className={`page${wide ? " page-wide" : ""}`}>{children}</div>
      </main>
    </div>
  );
}

/**
 * Page title header — 상단 네비게이션이 이미 현재 페이지를 표시하므로 제목 바는 비표시.
 * (호출부 호환을 위해 시그니처는 유지하고 아무것도 렌더하지 않는다.)
 */
export function SectionHead(_props: { title: string; sub?: string }) {
  return null;
}
