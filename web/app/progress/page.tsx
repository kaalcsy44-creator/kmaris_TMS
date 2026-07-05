"use client";

import { Suspense } from "react";
import AppShell from "@/components/AppShell";
import ProgressScreen from "@/components/screens/ProgressScreen";

// 진행 현황(Progress) 화면 = 고객확인용 / 내부확인용 탭.
// 기존 Dashboard 의 진행 현황 탭을 좌측 메뉴 별도 페이지로 분리했다.
// ProgressScreen 이 useSearchParams(딥링크 ?rfq=·?order=)를 쓰므로 Suspense 로 감싼다.
export default function Page() {
  return (
    <AppShell active="progress" wide>
      <Suspense fallback={<div className="state">Loading…</div>}>
        <ProgressScreen />
      </Suspense>
    </AppShell>
  );
}
