"use client";

import { Suspense } from "react";
import AppShell from "@/components/AppShell";
import ProjectsScreen from "@/components/screens/ProjectsScreen";

// 프로젝트 목록 — /project. 상세(/project/<id>)와 같은 경로 아래 놓아 목록→개요가
// 한 계층으로 읽힌다. 예전에는 목록이 /progress, 상세가 /project/<id> 로 갈라져 있었다.
// 내부확인용(단계 작업)·고객확인용 탭을 모두 품는다.
// perm="progress" 필수 — "projects" 는 권한 모듈이 아니라서 안 주면 열람 가드가 꺼진다.
// ProjectsScreen 이 useSearchParams(딥링크 ?rfq=·?order=)를 쓰므로 Suspense 로 감싼다.
export default function Page() {
  return (
    <AppShell active="projects" perm="progress" wide>
      <Suspense fallback={<div className="state">Loading…</div>}>
        <ProjectsScreen />
      </Suspense>
    </AppShell>
  );
}
