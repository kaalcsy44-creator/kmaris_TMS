"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { fetchRfqOverview } from "@/lib/api";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import RfqActionTabs from "@/components/RfqActionTabs";

// RFQ·견적 작업 화면. 각 탭 상단의 셀렉터로 진행중인 프로젝트(RFQ)를 선택해 작업한다.
// 진행현황에서 "RFQ·견적 작업"으로 넘어온 ?rfq=<id> 로도 선택된다.
export default function RfqScreen() {
  const params = useSearchParams();
  const rfqParam = params.get("rfq");
  const tabParam = params.get("tab");
  const [selectedId, setSelectedId] = useState<number | null>(
    rfqParam ? Number(rfqParam) : null
  );

  useEffect(() => {
    setSelectedId(rfqParam ? Number(rfqParam) : null);
  }, [rfqParam]);

  // 딥링크(?rfq=)로 특정 레코드를 자동으로 연 뒤에는 URL 에서 rfq 를 제거한다.
  // 그러지 않으면 F5 새로고침마다 같은 상세/편집 모달이 다시 열린다(1회만 의도).
  // tab 은 남겨 같은 목록 탭에 머무르게 하고, replaceState 라 재렌더는 없다.
  useEffect(() => {
    if (typeof window === "undefined" || !rfqParam) return;
    const sp = new URLSearchParams(window.location.search);
    sp.delete("rfq");
    const qs = sp.toString();
    window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
    // 최초 마운트에서 1회만 정리.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // overview 는 프로젝트 셀렉터 목록·rfqNo 표시용으로 사용한다.
  const { data: overview, refresh } = useCachedData("rfq:overview:", () =>
    fetchRfqOverview()
  );
  const rows = overview?.rows ?? [];

  // 액션(생성·수정·삭제) 후: overview 새로고침 + 대시보드/파이프라인 캐시 무효화
  const load = useCallback(() => {
    invalidateCache("dashboard");
    invalidateCache("pipeline");
    return refresh();
  }, [refresh]);

  return (
    <RfqActionTabs
      rfqId={selectedId}
      rows={rows}
      onSelect={setSelectedId}
      onChanged={load}
      initialTab={tabParam}
    />
  );
}
