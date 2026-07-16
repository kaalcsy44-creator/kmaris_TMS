"use client";

import AppShell from "@/components/AppShell";
import ProjectsScreen from "@/components/screens/ProjectsScreen";

// 프로젝트 색인 — /project. 개요(/project/<id>)의 착지점: 상단 메뉴로 들어와 프로젝트를
// 고르면 그 개요로 간다.
// perm="progress" 필수 — "projects" 는 권한 모듈이 아니라서 안 주면 열람 가드가 꺼진다.
export default function Page() {
  return (
    <AppShell active="projects" perm="progress" wide>
      <ProjectsScreen />
    </AppShell>
  );
}
