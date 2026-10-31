"use client";

import { useState } from "react";
import AppShell from "@/components/AppShell";
import { ItemsTab, CategoriesTab, type ItemFocus } from "@/app/settings/page";
import ShipMapTab from "@/components/screens/ShipMapTab";

// 품목 관리 — Item Master(품목 마스터)와 Item Category(분류)를 설정에서 분리해 전용
// 상단 메뉴 "Item" 으로 관리한다. 접근 권한은 settings 와 동일.
// 물품과 용역은 한 탭(Parts & Services)에서 본다 — 둘을 가르던 Parts·Service 탭은 분류
// 칩과 같은 일을 두 번 했다. 용역은 Technical service coordination 등 용역 대분류로 갈린다.
// 역할은 셋으로 나뉜다: Parts & Services = 가격 비교, Item Category = 분류 작업,
// Ship View = 같은 분류를 배 한 척으로 펼친 보기.
type ItemTab = "items" | "categories" | "ship";

export default function ItemPage() {
  // 세 탭 모두 화면을 채우고 그 안에서 굴리는 배치(fill)를 쓴다 — 표는 가로 막대가
  // 표 바로 아래에, Ship View 는 옆으로 미는 막대가 화면 아래에 늘 보이도록.
  const [tab, setTab] = useState<ItemTab>("items");
  return (
    <AppShell active="item" perm="settings" wide fill>
      <ItemManager tab={tab} setTab={setTab} />
    </AppShell>
  );
}

function ItemManager({ tab, setTab }: { tab: ItemTab; setTab: (t: ItemTab) => void }) {
  // Item Category 에서 "Prices →" 를 누르면 그 분류로 걸린 채 품목 탭으로 건너간다.
  const [focus, setFocus] = useState<ItemFocus | null>(null);
  const tabs: { key: ItemTab; label: string }[] = [
    { key: "items", label: "Parts & Services" },
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
      {tab === "items" && <ItemsTab focus={focus} />}
      {tab === "categories" && (
        <CategoriesTab
          onOpenItems={(f) => {
            setFocus({ ...f, n: (focus?.n ?? 0) + 1 });
            setTab("items");
          }}
        />
      )}
      {tab === "ship" && <ShipMapTab />}
    </>
  );
}
