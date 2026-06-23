"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { fetchRfqOverview } from "@/lib/api";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import RfqActionTabs from "@/components/RfqActionTabs";

// 목록 테이블은 진행현황(내부확인용) 통합 목록으로 이전됨. 이 화면은 작업(상세·액션)
// 전용이며, 대상 RFQ는 진행현황에서 "RFQ·견적 작업"으로 넘어온 ?rfq=<id> 로 선택된다.
export default function RfqScreen() {
  const params = useSearchParams();
  const rfqParam = params.get("rfq");
  const [selectedId, setSelectedId] = useState<number | null>(
    rfqParam ? Number(rfqParam) : null
  );

  useEffect(() => {
    setSelectedId(rfqParam ? Number(rfqParam) : null);
  }, [rfqParam]);

  // rfqNo 표시·검증용으로만 overview 를 사용한다(테이블은 렌더하지 않음).
  const { data: overview, refresh } = useCachedData("rfq:overview:", () =>
    fetchRfqOverview()
  );
  const rows = overview?.rows ?? [];
  const selected = rows.find((r) => r.id === selectedId);

  // 액션(생성·수정·삭제) 후: overview 새로고침 + 대시보드/파이프라인 캐시 무효화
  const load = useCallback(() => {
    invalidateCache("dashboard");
    invalidateCache("pipeline");
    return refresh();
  }, [refresh]);

  return (
    <RfqActionTabs
      rfqId={selectedId}
      rfqNo={selected?.crfq_no}
      onChanged={load}
    />
  );
}
