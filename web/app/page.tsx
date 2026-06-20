"use client";

import { useState } from "react";
import AppShell, { SectionHead } from "@/components/AppShell";
import RfqScreen from "@/components/screens/RfqScreen";
import VrfqScreen from "@/components/screens/VrfqScreen";
import QuotationScreen from "@/components/screens/QuotationScreen";

const TABS = [
  { key: "rfq", label: "RFQ 현황" },
  { key: "vrfq", label: "Vendor RFQ 발신" },
  { key: "quotation", label: "견적 현황" },
];

export default function Page() {
  const [tab, setTab] = useState("rfq");
  return (
    <AppShell active="rfq">
      <SectionHead title="RFQ & Quotation" sub="고객 RFQ · Vendor RFQ · 견적" />
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
      {tab === "rfq" && <RfqScreen />}
      {tab === "vrfq" && <VrfqScreen />}
      {tab === "quotation" && <QuotationScreen />}
    </AppShell>
  );
}
