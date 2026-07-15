"use client";

import { use } from "react";
import AppShell from "@/components/AppShell";
import ProjectOverviewScreen from "@/components/screens/ProjectOverviewScreen";

// 프로젝트 개요(읽기 전용) — /project/<rfq_id>. 팀원과 링크로 공유하는 한 장짜리 현황.
// 상단 네비에는 넣지 않는다: 항상 특정 프로젝트를 골라야 열리는 종속 화면이라
// 메뉴로 진입할 착지점이 없다. 진입은 진행현황 팝업·보드 카드·업무일지 카드에서.
// active="progress" → 진행현황 열람 권한으로 가드하고 네비도 Progress 로 표시된다.
export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <AppShell active="progress" wide>
      <ProjectOverviewScreen rfqId={Number(id)} />
    </AppShell>
  );
}
