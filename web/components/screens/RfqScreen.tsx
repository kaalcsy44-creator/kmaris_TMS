"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { fetchRfqOverview } from "@/lib/api";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import RfqActionTabs from "@/components/RfqActionTabs";

// RFQ·견적 작업 화면. 각 탭 상단의 셀렉터로 진행중인 프로젝트(RFQ)를 선택해 작업한다.
// 진행현황에서 "RFQ·견적 작업"으로 넘어온 ?rfq=<id> 로도 선택된다.
export default function RfqScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const rfqParam = params.get("rfq");
  const tabParam = params.get("tab");
  const [selectedId, setSelectedId] = useState<number | null>(
    rfqParam ? Number(rfqParam) : null
  );

  // 새 딥링크(?rfq=)가 오면 선택 레코드를 갱신한다. URL 정리로 rfq 가 사라져도
  // 이미 연 레코드를 닫지 않도록, 값이 있을 때만 반영한다(null 로 되돌리지 않음).
  useEffect(() => {
    if (rfqParam) setSelectedId(Number(rfqParam));
  }, [rfqParam]);

  // 딥링크(?rfq=)로 특정 레코드를 자동으로 연 뒤에는 URL 에서 rfq 를 제거한다.
  // 그러지 않으면 F5 새로고침마다 같은 상세/편집 모달이 다시 열린다(1회만 의도).
  // tab 은 남겨 같은 목록 탭에 머무른다. Next 라우터(router.replace)로 정리해야
  // useSearchParams 가 동기화되어, 이후 다른 단계 링크(?tab=)가 올바르게 적용된다.
  // (과거 window.history.replaceState 는 라우터 상태를 어긋나게 해 ?tab 이 stale 되었다.)
  useEffect(() => {
    if (!rfqParam) return;
    const sp = new URLSearchParams(Array.from(params.entries()));
    sp.delete("rfq");
    const qs = sp.toString();
    router.replace(qs ? `/rfq?${qs}` : "/rfq", { scroll: false });
    // rfqParam 이 채워진 최초 진입에서만 정리(이후 rfqParam=null 이면 no-op).
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      initialTab={tabParam}
    />
  );
}
