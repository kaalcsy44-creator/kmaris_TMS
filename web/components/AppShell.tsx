"use client";

import { useState } from "react";
import AuthGate from "./AuthGate";
import Sidebar from "./Sidebar";

/**
 * Authed layout shell: left navy sidebar + main content area.
 * Replaces the old top `Nav`. `active` is the sidebar item key.
 * On mobile the sidebar collapses into an off-canvas drawer toggled
 * from the top bar hamburger.
 */
export default function AppShell({
  active,
  children,
}: {
  active: string;
  children: React.ReactNode;
}) {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <AuthGate>
      <div className="shell">
        <header className="mobile-topbar">
          <button
            type="button"
            className="mobile-burger"
            aria-label="메뉴 열기"
            onClick={() => setNavOpen(true)}
          >
            <span />
            <span />
            <span />
          </button>
          <span className="mobile-brand">
            <span className="mark">TMS</span>
            K-MARIS
          </span>
        </header>
        <Sidebar
          active={active}
          open={navOpen}
          onClose={() => setNavOpen(false)}
        />
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
