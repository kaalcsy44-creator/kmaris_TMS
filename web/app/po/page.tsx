"use client";

import { useState } from "react";
import AppShell, { SectionHead } from "@/components/AppShell";
import PoScreen from "@/components/screens/PoScreen";
import VendorPoScreen from "@/components/screens/VendorPoScreen";

const TABS = [
  { key: "customer", label: "고객 P/O" },
  { key: "vendor", label: "Vendor P/O" },
];

export default function PoPage() {
  const [tab, setTab] = useState("customer");
  return (
    <AppShell active="po">
      <SectionHead title="P/O" sub="고객 P/O 수신 · Vendor P/O 발신" />
      <div className="page-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? "on" : ""}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "customer" && <PoScreen />}
      {tab === "vendor" && <VendorPoScreen />}
    </AppShell>
  );
}
