"use client";

import { useState } from "react";
import AppShell from "@/components/AppShell";
import { ItemsTab, CategoriesTab } from "@/app/settings/page";

// 품목 관리 — Item Master(품목 마스터)와 Item Category(분류·가격 이력)를
// 설정에서 분리해 전용 상단 메뉴 "Item" 으로 관리한다. 접근 권한은 settings 와 동일.
type ItemTab = "master" | "categories";

export default function ItemPage() {
  return (
    <AppShell active="item" perm="settings" wide>
      <ItemManager />
    </AppShell>
  );
}

function ItemManager() {
  const [tab, setTab] = useState<ItemTab>("master");
  const tabs: { key: ItemTab; label: string }[] = [
    { key: "master", label: "Item Master" },
    { key: "categories", label: "Item Category" },
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
      {tab === "master" && <ItemsTab />}
      {tab === "categories" && <CategoriesTab />}
    </>
  );
}
