"use client";

import Link from "next/link";
import { getUser, logout } from "@/lib/auth";

const TABS = [
  { href: "/", label: "RFQ & Quotation", key: "rfq" },
  { href: "/po", label: "P/O 현황", key: "po" },
  { href: "/ar", label: "미수금", key: "ar" },
  { href: "/dashboard", label: "운영 현황", key: "dashboard" },
];

export default function Nav({ active }: { active: string }) {
  return (
    <div className="topbar">
      <h1>K-MARIS TMS</h1>
      <nav className="nav">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            className={`nav-link${t.key === active ? " on" : ""}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <span className="badge">Next.js pilot</span>
      <span className="user-chip">{getUser()?.username ?? ""}</span>
      <button className="logout" onClick={logout}>
        로그아웃
      </button>
    </div>
  );
}
