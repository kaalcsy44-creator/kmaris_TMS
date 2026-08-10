"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { login } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-box" onSubmit={submit}>
        <div className="login-brand">
          <img className="login-logo" src="/brand/ktms-logo.png" alt="KTMS" />
          <div className="login-brand-name">K-Maris Trade Management System</div>
        </div>
        {/* 로그인 폼임을 autocomplete 로 밝혀 둔다 — 비밀번호 관리자가 아이디·비밀번호를
            여기에 맞춰 저장하고 채우면, 다른 화면의 입력칸을 아이디 칸으로 착각할 일이
            없다(설정 → Users 에서 머리줄 검색창이 채워지던 문제와 같은 뿌리). */}
        <label>Username</label>
        <input
          name="username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="username"
          autoFocus
        />
        <label>Password</label>
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="password"
        />
        {error ? <div className="login-error">{error}</div> : null}
        <button className="login-btn" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
