"use client";

import AppShell, { SectionHead } from "@/components/AppShell";
import RfqScreen from "@/components/screens/RfqScreen";

// 원본 Streamlit rfq_quotation.py 와 동일한 매크로 구조:
//   거래(RFQ) 1건당 한 행으로 12단계(Customer RFQ 수신 → Vendor RFQ 발신 →
//   Vendor Quot. 수신 → Customer Quot. 발신)를 병합한 통합 현황 테이블 + 선택 상세/액션.
//   (기존의 분리된 VRFQ/견적 목록 탭은 이 한 테이블로 병합됨)
export default function Page() {
  return (
    <AppShell active="rfq">
      <SectionHead
        title="RFQ & Quotation"
        sub="거래(RFQ)별 통합 파이프라인 현황 · 행을 선택하면 상세/액션"
      />
      <RfqScreen />
    </AppShell>
  );
}
