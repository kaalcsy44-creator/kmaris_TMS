"use client";

import { Suspense } from "react";
import AppShell from "@/components/AppShell";
import ActivityScreen from "@/components/screens/ActivityScreen";

// 업무일지(Activity Log) — 프로젝트별·단계별 활동을 한 화면에 모아 매일 갱신·회의 공유.
// ActivityScreen 이 useSearchParams(?q= 딥링크)를 쓰므로 Suspense 로 감싼다.
// perm="progress" 필수 — "activity" 는 권한 모듈이 아니라서 안 주면 열람 가드가 꺼진다.
export default function Page() {
  return (
    <AppShell active="activity" perm="progress" wide>
      <Suspense fallback={<div className="state">Loading…</div>}>
        <ActivityScreen />
      </Suspense>
    </AppShell>
  );
}
