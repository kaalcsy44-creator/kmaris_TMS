"use client";

import { useState } from "react";
import Link from "next/link";
import { getUser, isAdmin, can, logout } from "@/lib/auth";
import type { PermModule } from "@/lib/auth";
import GlobalSearch from "./GlobalSearch";

type SubItem = { href: string; label: string };
// perm: 열람 권한 확인에 쓸 모듈(생략 시 key 를 모듈로 사용).
type Item = { href: string; label: string; key: string; perm?: PermModule; sub?: SubItem[] };

// 평면 상단 메뉴 — 페이지 자체가 주요 메뉴. 설정은 우측 톱니 아이콘으로 분리.
// RFQ·견적 / P/O / Documents / AR 은 진행현황(Progress) 프로젝트 팝업의 단계별 작업으로
// 통합되어 상단 메뉴에서 제거했다. 라우트(/rfq·/po·/documents·/ar)는 딥링크용으로 유지된다.
const ITEMS: Item[] = [
  { href: "/", label: "Dashboard", key: "dashboard" },
  // 프로젝트 — 목록(/project)과 개요(/project/<id>)가 한 계층. 예전에는 같은 표를
  // 진행현황(/progress)과 색인(/project)으로 나눠 뒀는데, 같은 파이프라인 데이터를
  // 두 번 그리는 중복이라 하나로 합쳤다. 권한은 progress 모듈을 그대로 쓴다.
  { href: "/project", label: "Projects", key: "projects", perm: "progress" },
  // 업무일지 — 파이프라인(progress) 열람 권한 사용자면 접근 가능.
  { href: "/activity", label: "Activity", key: "activity", perm: "progress" },
  { href: "/marketing", label: "Marketing", key: "marketing" },
];

export default function TopNav({ active }: { active: string }) {
  const [open, setOpen] = useState(false); // 모바일 메뉴 토글
  const user = getUser();
  const admin = isAdmin();
  const initial = (user?.username ?? "?").charAt(0).toUpperCase();
  // 열람(view) 권한이 있는 메뉴만 노출. (item.key 가 권한 모듈명과 동일)
  const items = ITEMS.filter((it) => can((it.perm ?? it.key) as PermModule, "view"));
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
