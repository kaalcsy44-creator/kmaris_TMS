"use client";

import { useRouter } from "next/navigation";
import AppShell, { SectionHead } from "@/components/AppShell";
import NewRfqForm from "@/components/screens/NewRfqForm";

export default function NewRfqPage() {
  const router = useRouter();
  return (
    <AppShell active="rfq">
      <SectionHead title="New Customer RFQ" sub="RFQ & Quotation" />
      <NewRfqForm
        onCreated={(rfqNo) =>
          router.replace(`/rfq?created=${encodeURIComponent(rfqNo)}`)
        }
        onCancel={() => router.replace("/rfq")}
      />
    </AppShell>
  );
}
