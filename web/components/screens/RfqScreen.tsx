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
  const [selectedId, setSelectedId] = useState<number | null>(
    rfqParam ? Number(rfqParam) : null
  );

  useEffect(() => {
    setSelectedId(rfqParam ? Number(rfqParam) : null);
  }, [rfqParam]);

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
    />
  );
}
