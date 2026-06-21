"use client";

import AppShell, { SectionHead } from "@/components/AppShell";
import PoScreen from "@/components/screens/PoScreen";

// 원본 Streamlit 5_PO.py 와 동일한 매크로 구조: 고객 P/O 수신 + Vendor P/O 발신을
// 거래(RFQ/오더) 1건당 한 행으로 병합한 통합 현황 테이블. (분리된 Vendor P/O
// 목록 탭은 이 한 테이블의 Vendor P/O 컬럼으로 병합됨)
export default function PoPage() {
  return (
    <AppShell active="po">
      <SectionHead
        title="P/O"
        sub="고객 P/O 수신 → Vendor P/O 발신 통합 현황"
      />
      <PoScreen />
    </AppShell>
  );
}
