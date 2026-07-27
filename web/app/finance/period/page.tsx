import { Suspense } from "react";
import AppShell from "@/components/AppShell";
import FinancePeriodScreen from "@/components/screens/FinancePeriodScreen";

// 현금흐름 한 구간(달/주)의 건별 내역. 기간·통화가 주소에 담겨 있어(?start=&end=&cur=)
// FinancePeriodScreen 이 useSearchParams 를 쓰므로 Suspense 로 감싼다.
export default function FinancePeriodPage() {
  return (
    <AppShell active="finance" wide>
      <Suspense fallback={<div className="state">Loading…</div>}>
        <FinancePeriodScreen />
      </Suspense>
    </AppShell>
  );
}
