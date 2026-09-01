"use client";

import { useState } from "react";
import AppShell from "@/components/AppShell";
import { ItemsTab, CategoriesTab } from "@/app/settings/page";
import ShipMapTab from "@/components/screens/ShipMapTab";

// 품목 관리 — Item Master(품목 마스터)와 Item Category(분류·가격 이력)를
// 설정에서 분리해 전용 상단 메뉴 "Item" 으로 관리한다. 접근 권한은 settings 와 동일.
// 마스터는 다시 Parts(물품)·Service(용역) 두 탭으로 나뉜다 — 같은 표를 쓰면 서로의
// 빈칸(용역의 품번·HS 코드)만 늘어난다.
// Ship View 는 같은 분류를 목록이 아니라 배 한 척으로 펼친 보기다 — 분류를 하나씩
// 골라 보는 창으로는 "어느 계통에 어느 프로젝트가 걸려 있나"가 끝내 안 보인다.
type ItemTab = "parts" | "service" | "categories" | "ship";

export default function ItemPage() {
  // 탭 상태가 여기 있는 건 껍데기(AppShell)가 알아야 하기 때문이다 — 마스터 두 탭은
  // 표가 화면을 채우고 그 안에서 굴리는 배치(fill)를, 분류·도면 탭은 제 길이대로
  // 흐르는 보통 배치를 쓴다.
  const [tab, setTab] = useState<ItemTab>("parts");
  return (
    <AppShell active="item" perm="settings" wide fill={tab === "parts" || tab === "service"}>
      <ItemManager tab={tab} setTab={setTab} />
    </AppShell>
  );
}

function ItemManager({ tab, setTab }: { tab: ItemTab; setTab: (t: ItemTab) => void }) {
  const tabs: { key: ItemTab; label: string }[] = [
    { key: "parts", label: "Parts" },
    { key: "service", label: "Service" },
    { key: "categories", label: "Item Category" },
    { key: "ship", label: "Ship View" },
  ];
  return (
    <>
      <div className="page-tabs">
        {tabs.map((t) => (
          <button key={t.key} className={tab === t.key ? "on" : ""} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "parts" && <ItemsTab kind="part" />}
      {tab === "service" && <ItemsTab kind="service" />}
      {tab === "categories" && <CategoriesTab />}
      {tab === "ship" && <ShipMapTab />}
    </>
  );
}
