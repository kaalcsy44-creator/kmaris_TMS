import { Suspense } from "react";
import AppShell from "@/components/AppShell";
import ScheduleScreen from "@/components/screens/ScheduleScreen";

// Office › Schedule — 일정은 팀 공용이라 Dashboard 를 볼 수 있으면 열린다(권한 모듈 dashboard).
export default function SchedulePage() {
  return (
    <AppShell active="schedule" perm="dashboard" wide>
      <Suspense fallback={<div className="state">Loading…</div>}>
        <ScheduleScreen />
      </Suspense>
    </AppShell>
  );
}
