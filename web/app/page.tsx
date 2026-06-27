"use client";

import AppShell from "@/components/AppShell";
import DashboardScreen from "@/components/screens/DashboardScreen";

// 메인(홈) 화면 = Dashboard. RFQ & Quotation 은 /rfq 로 이동했다.
export default function Page() {
  return (
    <AppShell active="dashboard" wide>
      <DashboardScreen />
    </AppShell>
  );
}
