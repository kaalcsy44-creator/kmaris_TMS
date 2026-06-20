"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getToken } from "@/lib/auth";

/**
 * Client-side gate: if no token is stored, bounce to /login.
 * (Pilot-grade guard — the API still enforces auth on every request.)
 */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    setReady(true);
  }, [router]);

  if (!ready) {
    return <div className="state">확인 중…</div>;
  }
  return <>{children}</>;
}
