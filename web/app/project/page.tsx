"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import AppShell from "@/components/AppShell";
import ProjectsScreen from "@/components/screens/ProjectsScreen";
import ActivityScreen from "@/components/screens/ActivityScreen";
import { HomeTab as DocumentsTab } from "@/components/screens/DashboardScreen";

// 프로젝트 — /project. 딜을 다루는 화면을 한 메뉴 아래 탭으로 모았다(2026-11 메뉴 재편).
//   Pipeline  : 딜 목록(Internal/Customer 전환은 표 도구줄 맨 앞)
//   Activity  : 단계 활동 기록 — 예전 상단 메뉴 Activity(/activity)
//   Documents : 견적·P/O·PI·CI·PL 문서 목록 — 예전 Dashboard 의 Documents 탭
//   Mail      : 메일 정리함 — 예전 Activity 안의 Mail 탭
// 상세(/project/<id>)와 같은 경로 아래 놓아 목록→개요가 한 계층으로 읽힌다.
// perm="progress" 필수 — "projects" 는 권한 모듈이 아니라서 안 주면 열람 가드가 꺼진다.
// 화면들이 useSearchParams(딥링크 ?rfq=·?order=·?tab=·?q=·?queue=)를 쓰므로 Suspense 로 감싼다.
type HubTab = "pipeline" | "activity" | "documents" | "mail";
const TABS: { key: HubTab; label: string }[] = [
  { key: "pipeline", label: "Pipeline" },
  { key: "activity", label: "Activity" },
  { key: "documents", label: "Documents" },
  { key: "mail", label: "Mail" },
];
const LAST_TAB_KEY = "ktms_project_tab";
const isTab = (v: string | null): v is HubTab => TABS.some((t) => t.key === v);

export default function Page() {
  // 표 보기에서만 화면을 채우는 배치(fill)를 쓴다 — 그래야 표 상자가 남은 높이를
  // 정확히 가져가 세로는 표 안에서 굴러가고, 가로 막대가 표 바로 아래(화면 안)에 선다.
  // 보드는 칸마다 길이가 달라 페이지째 굴러야 하므로 보통 배치 그대로 둔다.
  const [fill, setFill] = useState(false);
  return (
    <AppShell active="projects" perm="progress" wide fill={fill}>
      <Suspense fallback={<div className="state">Loading…</div>}>
        <ProjectsHub onFill={setFill} />
      </Suspense>
    </AppShell>
  );
}

function ProjectsHub({ onFill }: { onFill: (fill: boolean) => void }) {
  const router = useRouter();
  const params = useSearchParams();
  const paramTab = params.get("tab");
  // 첫 탭: 주소의 ?tab= → 딜 딥링크(?rfq=·?order=)면 Pipeline → 마지막에 본 탭 → Pipeline.
  // 마지막 탭을 기억하는 건 Activity 가 상단 메뉴에서 탭으로 내려오며 늘어난 한 번의 클릭을 덜기 위해서다.
  // 탭은 주소에서 매번 계산하지 않고 상태로 든다 — Pipeline 이 딥링크를 처리한 뒤 주소를
  // /project 로 비우는데, 그때 기억된 다른 탭으로 튀면 열린 팝업이 사라진다.
  const [tab, setTab] = useState<HubTab>(() => {
    if (isTab(paramTab)) return paramTab;
    if (params.get("rfq") || params.get("order")) return "pipeline";
    try {
      const last = localStorage.getItem(LAST_TAB_KEY);
      if (isTab(last)) return last;
    } catch {}
    return "pipeline";
  });
  // 같은 화면 안에서 ?tab= 링크를 누른 경우(예: Pipeline 의 "RFQs in mail" → Mail 탭).
  useEffect(() => {
    if (isTab(paramTab)) setTab(paramTab);
  }, [paramTab]);
  useEffect(() => {
    try { localStorage.setItem(LAST_TAB_KEY, tab); } catch {}
  }, [tab]);

  function pick(t: HubTab) {
    setTab(t);
    router.replace(`/project?tab=${t}`, { scroll: false });
  }

  return (
    <>
      <div className="page-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? "on" : ""} onClick={() => pick(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "pipeline" && <ProjectsScreen onFill={onFill} />}
      {tab === "activity" && <ActivityScreen mode="activity" />}
      {tab === "documents" && <DocumentsTab />}
      {tab === "mail" && <ActivityScreen mode="mail" />}
    </>
  );
}
