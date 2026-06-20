"use client";

import AuthGate from "./AuthGate";
import Sidebar from "./Sidebar";

/**
 * Authed layout shell: left navy sidebar + main content area.
 * Replaces the old top `Nav`. `active` is the sidebar item key.
 */
export default function AppShell({
  active,
  children,
}: {
  active: string;
  children: React.ReactNode;
}) {
  return (
    <AuthGate>
      <div className="shell">
        <Sidebar active={active} />
        <main className="shell-main">
          <div className="page">{children}</div>
        </main>
      </div>
    </AuthGate>
  );
}

/** Page title header (mirrors Streamlit section_header). */
export function SectionHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      {sub ? <span className="sub">{sub}</span> : null}
    </div>
  );
}
