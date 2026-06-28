"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getToken, refreshPermissions } from "@/lib/auth";

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
    // 권한이 admin 에 의해 바뀌었을 수 있으므로 최신값으로 갱신(실패해도 진행).
    refreshPermissions().finally(() => setReady(true));
  }, [router]);

  if (!ready) {
    return <div className="state">Checking…</div>;
  }
  return <>{children}</>;
}
