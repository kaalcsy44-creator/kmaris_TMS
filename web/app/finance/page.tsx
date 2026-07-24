import { Suspense } from "react";
import AppShell from "@/components/AppShell";
import FinanceScreen from "@/components/screens/FinanceScreen";

export default function FinancePage() {
  return (
    <AppShell active="finance" wide>
      <Suspense fallback={<div className="state">Loading…</div>}>
        <FinanceScreen />
      </Suspense>
    </AppShell>
  );
}
