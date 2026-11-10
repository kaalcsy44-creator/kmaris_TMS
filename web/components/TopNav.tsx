"use client";

import { useState } from "react";
import Link from "next/link";
import { getUser, isAdmin, can, logout } from "@/lib/auth";
import type { PermModule } from "@/lib/auth";
import GlobalSearch from "./GlobalSearch";
import NotificationBell from "./NotificationBell";

// perm: 열람 권한 확인에 쓸 모듈(생략 시 key 를 모듈로 사용).
type SubItem = { href: string; label: string; key: string; perm?: PermModule };
// sub 가 있으면 묶음 메뉴 — 누르면 볼 수 있는 첫 하위 화면으로, 호버하면 하위 목록이 펼쳐진다.
type Item = { href: string; label: string; key: string; perm?: PermModule; sub?: SubItem[] };

// 상단 메뉴 — Dashboard · Projects · Sales▾ · Finance · Data▾ · Settings.
// RFQ·견적 / P/O / Documents / AR 은 진행현황(Progress) 프로젝트 팝업의 단계별 작업으로
// 통합되어 상단 메뉴에서 제거했다. 라우트(/rfq·/po·/documents·/ar)는 딥링크용으로 유지된다.
const ITEMS: Item[] = [
  { href: "/", label: "Dashboard", key: "dashboard" },
  // 프로젝트 — 목록(/project)과 개요(/project/<id>)가 한 계층. 예전에는 같은 표를
  // 진행현황(/progress)과 색인(/project)으로 나눠 뒀는데, 같은 파이프라인 데이터를
  // 두 번 그리는 중복이라 하나로 합쳤다. 권한은 progress 모듈을 그대로 쓴다.
  // Projects 는 딜을 다루는 화면을 탭으로 품는다: Pipeline | Activity | Documents | Mail.
  // (2026-11 재편 — 예전 상단 Activity 와 Dashboard 의 Documents 탭을 흡수)
  { href: "/project", label: "Projects", key: "projects", perm: "progress" },
  // 메뉴 순서 = 왼쪽부터 매일 쓰는 것 → 가끔 → 관리. 묶음은 같은 성격끼리만 묶는다.
  // Sales — 고객을 상대하는 바깥 일(홍보·미팅·출장).
  {
    href: "/marketing", label: "Sales", key: "sales",
    sub: [
      { href: "/marketing", label: "Marketing", key: "marketing" },
      // 일정은 팀 공용 — Dashboard 를 볼 수 있으면 열린다.
      { href: "/schedule", label: "Schedule", key: "schedule", perm: "dashboard" },
    ],
  },
  { href: "/finance", label: "Finance", key: "finance" },
  // Data — 기준정보(상대처·선박 명부와 품목 마스터). 둘 다 settings 권한으로 연다.
  {
    href: "/partners", label: "Data", key: "data",
    sub: [
      { href: "/partners", label: "Partners", key: "partners", perm: "settings" },
      { href: "/item", label: "Items", key: "item", perm: "settings" },
    ],
  },
];

export default function TopNav({ active }: { active: string }) {
  const [open, setOpen] = useState(false); // 모바일 메뉴 토글
  const user = getUser();
  const admin = isAdmin();
  const initial = (user?.username ?? "?").charAt(0).toUpperCase();
  // 열람(view) 권한이 있는 메뉴만 노출. (item.key 가 권한 모듈명과 동일)
  // 묶음은 볼 수 있는 하위 화면만 남기고, 하나도 없으면 묶음째 숨긴다.
  const canView = (it: { key: string; perm?: PermModule }) => can((it.perm ?? it.key) as PermModule, "view");
  const items = ITEMS.flatMap((it): Item[] => {
    if (!it.sub) return canView(it) ? [it] : [];
    const sub = it.sub.filter(canView);
    return sub.length ? [{ ...it, href: sub[0].href, sub }] : [];
  });
  const showSettings = admin || can("settings", "view");

  return (
    <header className={`topnav${open ? " open" : ""}`}>
      <div className="topnav-inner">
        <Link href="/" className="topnav-brand" onClick={() => setOpen(false)}>
          {/* 네비바(네이비 배경) 전용 반전본 — 흰 글자 + 메뉴 활성색과 같은 파랑.
              밝은 배경(로그인)에는 원본 ktms-logo.png 를 쓴다. */}
          <img
            className="topnav-logo"
            src="/brand/ktms-logo-nav.png"
            alt="KTMS"
          />
        </Link>

        <button
          type="button"
          className="topnav-burger"
          aria-label="Open menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span />
          <span />
          <span />
        </button>

        <nav className="topnav-menu">
          {items.map((it) =>
            it.sub ? (
              <div key={it.key} className="topnav-item has-sub">
                <Link
                  href={it.href}
                  className={`topnav-link${it.sub.some((s) => s.key === active) ? " on" : ""}`}
                  onClick={() => setOpen(false)}
                >
                  {it.label}
                  <span className="topnav-caret" aria-hidden>▾</span>
                </Link>
                <div className="topnav-sub">
                  {it.sub.map((s) => (
                    <Link
                      key={s.href}
                      href={s.href}
                      className={`topnav-sub-link${s.key === active ? " on" : ""}`}
                      onClick={() => setOpen(false)}
                    >
                      {s.label}
                    </Link>
                  ))}
                </div>
              </div>
            ) : (
              <Link
                key={it.key}
                href={it.href}
                className={`topnav-link${it.key === active ? " on" : ""}`}
                onClick={() => setOpen(false)}
              >
                {it.label}
              </Link>
            )
          )}
          {/* 설정 — Marketing 우측 메뉴 항목으로 합류(구 우측 톱니 아이콘 대체). */}
          {showSettings ? (
            <Link
              href="/settings"
              className={`topnav-link${active === "settings" ? " on" : ""}`}
              onClick={() => setOpen(false)}
            >
              Settings
            </Link>
          ) : null}
        </nav>

        <div className="topnav-right">
          <GlobalSearch />
          <NotificationBell />
          <span className="topnav-user">
            <span className="avatar">{initial}</span>
            <span className="uname">{user?.username ?? ""}</span>
          </span>
          <button
            className="topnav-logout"
            onClick={logout}
            title="Logout"
            aria-label="Logout"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                fill="currentColor"
                d="M16 13v-2H7V8l-5 4 5 4v-3h9Zm3-10H11a2 2 0 0 0-2 2v3h2V5h8v14h-8v-3H9v3a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Z"
              />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}
