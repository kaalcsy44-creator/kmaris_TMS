"use client";

import { Suspense } from "react";
import AppShell, { SectionHead } from "@/components/AppShell";
import PoScreen from "@/components/screens/PoScreen";

// P/O 작업 화면. 목록은 진행현황(내부확인용) 통합 목록으로 이전됨. 대상 오더는
// 진행현황에서 넘어온 ?order=<id> 로 선택된다.
export default function PoPage() {
  return (
    <AppShell active="po" wide>
      <SectionHead
        title="P/O"
        sub="Customer P/O received → Vendor P/O sent"
      />
      <Suspense fallback={<div className="state">Loading…</div>}>
        <PoScreen />
      </Suspense>
    </AppShell>
  );
}
