"use client";

import { Suspense } from "react";
import AppShell from "@/components/AppShell";
import ActivityScreen from "@/components/screens/ActivityScreen";

// 업무일지(Activity Log) — 프로젝트별·단계별 활동을 한 화면에 모아 매일 갱신·회의 공유.
// ActivityScreen 이 useSearchParams(?q= 딥링크)를 쓰므로 Suspense 로 감싼다.
export default function Page() {
  return (
    <AppShell active="activity" wide>
      <Suspense fallback={<div className="state">Loading…</div>}>
        <ActivityScreen />
      </Suspense>
    </AppShell>
  );
}
