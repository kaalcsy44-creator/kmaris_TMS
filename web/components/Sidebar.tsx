"use client";

import Link from "next/link";
import { getUser, logout } from "@/lib/auth";

type Item = { href: string; label: string; key: string };
type Group = { title?: string; items: Item[] };

// Mirrors the original Streamlit navigation (app/Home.py st.navigation):
//   (no group) Dashboard · RFQ & Quotation · P/O
//   선적 · 정산  Documents · AR
//   시스템      Settings
const GROUPS: Group[] = [
  {
    items: [
      { href: "/dashboard", label: "Dashboard", key: "dashboard" },
      { href: "/", label: "RFQ & Quotation", key: "rfq" },
      { href: "/po", label: "P/O", key: "po" },
    ],
  },
  {
    title: "선적 · 정산",
    items: [
      { href: "/documents", label: "Documents", key: "documents" },
      { href: "/ar", label: "AR", key: "ar" },
    ],
  },
  {
    title: "시스템",
    items: [{ href: "/settings", label: "Settings", key: "settings" }],
  },
];

export default function Sidebar({ active }: { active: string }) {
  const user = getUser();
  const initial = (user?.username ?? "?").charAt(0).toUpperCase();

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="mark">TMS</span>
        <span className="name">
          K-MARIS
          <small>Trade Management</small>
        </span>
      </div>

      <nav className="sidebar-nav">
        {GROUPS.map((g, gi) => (
          <div className="sidebar-group" key={g.title ?? `g${gi}`}>
            {g.title ? <div className="sidebar-group-title">{g.title}</div> : null}
            {g.items.map((it) => (
              <Link
                key={it.key}
                href={it.href}
                className={`sidebar-link${it.key === active ? " on" : ""}`}
              >
                {it.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-foot">
        <span className="avatar">{initial}</span>
        <span className="uname">{user?.username ?? ""}</span>
        <button className="logout" onClick={logout}>
          로그아웃
        </button>
      </div>
    </aside>
  );
}
