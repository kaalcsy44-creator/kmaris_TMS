"use client";

import { useState } from "react";
import Link from "next/link";
import { getUser, logout } from "@/lib/auth";

type Item = { href: string; label: string; key: string };

// 평면 상단 메뉴 — 페이지 자체가 주요 메뉴. 설정은 우측 톱니 아이콘으로 분리.
const ITEMS: Item[] = [
  { href: "/", label: "Dashboard", key: "dashboard" },
  { href: "/progress", label: "Progress", key: "progress" },
  { href: "/rfq", label: "RFQ & Quotation", key: "rfq" },
  { href: "/po", label: "P/O", key: "po" },
  { href: "/documents", label: "Documents", key: "documents" },
  { href: "/ar", label: "AR", key: "ar" },
];

export default function TopNav({ active }: { active: string }) {
  const [open, setOpen] = useState(false); // 모바일 메뉴 토글
  const user = getUser();
  const initial = (user?.username ?? "?").charAt(0).toUpperCase();

  return (
    <header className={`topnav${open ? " open" : ""}`}>
      <div className="topnav-inner">
        <Link href="/" className="topnav-brand" onClick={() => setOpen(false)}>
          <span className="mark">TMS</span>
          <span className="name">
            K-MARIS
            <small>Trade Management</small>
          </span>
        </Link>

        <button
          type="button"
          className="topnav-burger"
          aria-label="메뉴 열기"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span />
          <span />
          <span />
        </button>

        <nav className="topnav-menu">
          {ITEMS.map((it) => (
            <Link
              key={it.key}
              href={it.href}
              className={`topnav-link${it.key === active ? " on" : ""}`}
              onClick={() => setOpen(false)}
            >
              {it.label}
            </Link>
          ))}
        </nav>

        <div className="topnav-right">
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
          <span className="topnav-user">
            <span className="avatar">{initial}</span>
            <span className="uname">{user?.username ?? ""}</span>
          </span>
          <button className="topnav-logout" onClick={logout}>
            로그아웃
          </button>
        </div>
      </div>
    </header>
  );
}
