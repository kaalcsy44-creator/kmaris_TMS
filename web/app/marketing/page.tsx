import { Suspense } from "react";
import AppShell from "@/components/AppShell";
import MarketingScreen from "@/components/screens/MarketingScreen";

export default function MarketingPage() {
  return (
    <AppShell active="marketing" wide>
      <Suspense fallback={<div className="state">Loading…</div>}>
        <MarketingScreen />
      </Suspense>
    </AppShell>
  );
}
