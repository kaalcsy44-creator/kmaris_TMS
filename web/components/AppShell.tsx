"use client";

import AuthGate from "./AuthGate";
import TopNav from "./TopNav";

/**
 * Authed layout shell: top navy nav bar + main content area below.
 * `active` is the nav item key. The horizontal menu collapses into a
 * hamburger-toggled panel on mobile.
 */
export default function AppShell({
  active,
  children,
  wide = false,
}: {
  active: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <AuthGate>
      <div className="shell">
        <TopNav active={active} />
        <main className="shell-main">
          <div className={`page${wide ? " page-wide" : ""}`}>{children}</div>
        </main>
      </div>
    </AuthGate>
  );
}

/**
 * Page title header — 상단 네비게이션이 이미 현재 페이지를 표시하므로 제목 바는 비표시.
 * (호출부 호환을 위해 시그니처는 유지하고 아무것도 렌더하지 않는다.)
 */
export function SectionHead(_props: { title: string; sub?: string }) {
  return null;
}
