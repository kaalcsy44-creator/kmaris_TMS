"use client";

import { useState } from "react";
import Link from "next/link";
import { getUser, isAdmin, can, logout } from "@/lib/auth";
import type { PermModule } from "@/lib/auth";
import GlobalSearch from "./GlobalSearch";

type SubItem = { href: string; label: string };
type Item = { href: string; label: string; key: string; sub?: SubItem[] };

// 평면 상단 메뉴 — 페이지 자체가 주요 메뉴. 설정은 우측 톱니 아이콘으로 분리.
// RFQ·견적 / P/O / Documents / AR 은 진행현황(Progress) 프로젝트 팝업의 단계별 작업으로
// 통합되어 상단 메뉴에서 제거했다. 라우트(/rfq·/po·/documents·/ar)는 딥링크용으로 유지된다.
const ITEMS: Item[] = [
  { href: "/", label: "Dashboard", key: "dashboard" },
  { href: "/progress", label: "Progress", key: "progress" },
  { href: "/marketing", label: "Marketing", key: "marketing" },
];

export default function TopNav({ active }: { active: string }) {
  const [open, setOpen] = useState(false); // 모바일 메뉴 토글
  const user = getUser();
  const admin = isAdmin();
  const initial = (user?.username ?? "?").charAt(0).toUpperCase();
  // 열람(view) 권한이 있는 메뉴만 노출. (item.key 가 권한 모듈명과 동일)
  const items = ITEMS.filter((it) => can(it.key as PermModule, "view"));
  const showSettings = admin || can("settings", "view");

  return (
    <header className={`topnav${open ? " open" : ""}`}>
      <div className="topnav-inner">
        <Link href="/" className="topnav-brand" onClick={() => setOpen(false)}>
          <img
            className="topnav-logo"
            src="/brand/ktms-logo.png"
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
                  className={`topnav-link${it.key === active ? " on" : ""}`}
                  onClick={() => setOpen(false)}
                >
                  {it.label}
                </Link>
                <div className="topnav-sub">
                  {it.sub.map((s) => (
                    <Link
                      key={s.href}
                      href={s.href}
                      className="topnav-sub-link"
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
        </nav>

        <div className="topnav-right">
          <GlobalSearch />
          {showSettings ? (
            <Link
              href="/settings"
              className={`topnav-gear${active === "settings" ? " on" : ""}`}
              title="Settings"
              aria-label="Settings"
              onClick={() => setOpen(false)}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.74 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.42.34.61.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54c.05.24.25.42.5.42h3.84c.25 0 .45-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.19.12.47.02.61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2Z"
                />
              </svg>
            </Link>
          ) : null}
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
