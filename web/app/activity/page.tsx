"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// 옛 주소 — 업무일지(Activity)와 메일 정리함은 2026-11 메뉴 재편으로 Projects 의 탭이 됐다.
// 알림·메일·북마크에 남은 /activity(?view=mail&queue=…·?q=…) 링크가 깨지지 않게
// 같은 조건으로 /project?tab=activity|mail 로 넘긴다.
export default function Page() {
  return (
    <Suspense fallback={<div className="state">Loading…</div>}>
      <Redirect />
    </Suspense>
  );
}

function Redirect() {
  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => {
    const p = new URLSearchParams(params.toString());
    const view = p.get("view");
    p.delete("view");
    p.set("tab", view === "mail" ? "mail" : "activity");
    router.replace(`/project?${p.toString()}`);
  }, [params, router]);
  return <div className="state">Loading…</div>;
}
