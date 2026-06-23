"use client";

import { Suspense } from "react";
import AppShell, { SectionHead } from "@/components/AppShell";
import RfqScreen from "@/components/screens/RfqScreen";

// RFQ & 견적 작업 화면. 목록은 진행현황(내부확인용) 통합 목록으로 이전됨. 대상 RFQ는
// 진행현황에서 넘어온 ?rfq=<id> 로 선택된다.
export default function Page() {
  return (
    <AppShell active="rfq">
      <SectionHead
        title="RFQ & Quotation"
        sub="RFQ 수신 → Vendor RFQ → Vendor 견적 → Customer 견적 작업"
      />
      <Suspense fallback={<div className="state">불러오는 중…</div>}>
        <RfqScreen />
      </Suspense>
    </AppShell>
  );
}
