import AppShell from "@/components/AppShell";
import MarketingScreen from "@/components/screens/MarketingScreen";

export default function MarketingPage() {
  return (
    <AppShell active="marketing" wide>
      <MarketingScreen />
    </AppShell>
  );
}
