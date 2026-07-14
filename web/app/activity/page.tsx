"use client";

import AppShell from "@/components/AppShell";
import ActivityScreen from "@/components/screens/ActivityScreen";

// 업무일지(Activity Log) — 프로젝트별·단계별 활동을 한 화면에 모아 매일 갱신·회의 공유.
export default function Page() {
  return (
    <AppShell active="activity" wide>
      <ActivityScreen />
    </AppShell>
  );
}
