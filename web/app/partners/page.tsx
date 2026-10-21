"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import AppShell from "@/components/AppShell";
import { CustomersTab, VendorsTab, MakersTab, VesselsTab } from "@/app/settings/page";

// 상대처 명부 — 예전 Settings › Partners(Customer·Vendor·Maker 알약 전환)와 Settings › Vessels
// 를 자주 쓰여 상단 메뉴로 승격했다. 알약 전환은 그대로 페이지 탭이 됐고 Vessel 이 맨 뒤에
// 붙는다. 접근 권한은 settings 와 동일(마스터 데이터). 옛 /settings?tab=partners|vessels
// 링크는 설정 화면이 이리로 보낸다.
type Side = "customers" | "vendors" | "makers" | "vessels";

const TABS: { key: Side; label: string }[] = [
  { key: "customers", label: "Customer" },
  { key: "vendors", label: "Vendor" },
  { key: "makers", label: "Maker" },
  { key: "vessels", label: "Vessel" },
];

export default function PartnersPage() {
  // 탭 상태가 여기 있는 건 껍데기(AppShell)가 fill 여부를 알아야 해서다 — 상대처 세 표는
  // 화면을 채우고 그 안에서 굴린다. 선박 표는 설정 시절처럼 보통 배치.
  const [side, setSide] = useState<Side | null>(null);
  return (
    <AppShell active="partners" perm="settings" wide fill={side !== "vessels"}>
      {/* ?side= / ?company= 딥링크(알림의 거래선 태그 제안 등)를 읽으므로 Suspense 로 감싼다. */}
      <Suspense fallback={<div className="state">Loading…</div>}>
        <Partners side={side} setSide={setSide} />
      </Suspense>
    </AppShell>
  );
}

function Partners({ side, setSide }: { side: Side | null; setSide: (s: Side) => void }) {
  const param = useSearchParams().get("side");
  const initial: Side = TABS.some((t) => t.key === param) ? (param as Side) : "customers";
  const cur = side ?? initial;
  return (
    <>
      <div className="page-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={cur === t.key ? "on" : ""} onClick={() => setSide(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {cur === "customers" && <CustomersTab />}
      {cur === "vendors" && <VendorsTab />}
      {cur === "makers" && <MakersTab />}
      {cur === "vessels" && <VesselsTab />}
    </>
  );
}
