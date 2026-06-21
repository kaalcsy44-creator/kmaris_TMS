"use client";

import { useRouter } from "next/navigation";
import AppShell, { SectionHead } from "@/components/AppShell";
import NewRfqForm from "@/components/screens/NewRfqForm";

export default function NewRfqPage() {
  const router = useRouter();
  return (
    <AppShell active="rfq">
      <SectionHead title="Customer RFQ 신규 등록" sub="RFQ & Quotation" />
      <NewRfqForm
        onCreated={(rfqNo) =>
          router.replace(`/?created=${encodeURIComponent(rfqNo)}`)
        }
        onCancel={() => router.replace("/")}
      />
    </AppShell>
  );
}
