"use client";

import { Suspense, useState } from "react";
import AppShell from "@/components/AppShell";
import MarketingScreen from "@/components/screens/MarketingScreen";

export default function MarketingPage() {
  // 표가 본문인 List 탭에서만 화면을 채우는 배치(fill)를 쓴다 — 그래야 표 상자가
  // 남은 높이를 정확히 가져가고, 가로 스크롤 막대가 표 바로 아래(화면 안)에 선다.
  // Brochures 는 표가 아니라 자료 목록이라 보통 배치가 맞다.
  const [fill, setFill] = useState(true);
  return (
    <AppShell active="marketing" wide fill={fill}>
      <Suspense fallback={<div className="state">Loading…</div>}>
        <MarketingScreen onFill={setFill} />
      </Suspense>
    </AppShell>
  );
}
