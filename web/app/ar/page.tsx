"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchArOverview, recordArPayment } from "@/lib/api";
import type { ArData, ArRow } from "@/lib/types";
import AppShell, { SectionHead } from "@/components/AppShell";

export default function ArPage() {
  return (
    <AppShell active="ar">
      <ArOverview />
    </AppShell>
  );
}

function money(n: number) {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function ArOverview() {
  const [data, setData] = useState<ArData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("전체");
  const [currency, setCurrency] = useState("전체");

  function load() {
    setError(null);
    fetchArOverview()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "오류"));
  }

  useEffect(load, []);

  const statuses = useMemo(
    () => (data ? Array.from(new Set(data.rows.map((r) => r.status))) : []),
    [data]
  );
  const currencies = useMemo(
    () => (data ? Array.from(new Set(data.rows.map((r) => r.currency))) : []),
    [data]
  );
  const rows = useMemo(
    () =>
      (data?.rows ?? []).filter(
        (r) =>
          (status === "전체" || r.status === status) &&
          (currency === "전체" || r.currency === currency)
      ),
    [data, status, currency]
  );
  // 원본 7_AR.py 처럼 필터된 레코드 기준으로 KPI 재계산
  const kpi = useMemo(() => {
    let out = 0;
    let over = 0;
    for (const r of rows) {
      if (r.currency === "USD") {
        out += r.outstanding;
        if (r.overdue) over += r.outstanding;
      }
    }
    return { outstanding_usd: out, overdue_usd: over, count: rows.length };
  }, [rows]);

  return (
    <>
      <SectionHead title="AR 관리" sub="Accounts Receivable / SOA · 청구·수금·연체" />

      {error ? (
        <div className="state error">API 오류: {error}</div>
      ) : !data ? (
        <div className="state">불러오는 중…</div>
      ) : (
        <>
          <div className="toolbar">
            <div className="field">
              <label>상태 필터</label>
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="전체">전체</option>
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>통화 필터</label>
              <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                <option value="전체">전체</option>
                {currencies.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn" onClick={load}>
              새로고침
            </button>
          </div>

          <div className="kpi-row">
            <Kpi
              label="USD 미수금"
              value={`USD ${money(kpi.outstanding_usd)}`}
              sub="미완납 합계"
            />
            <Kpi
              label="USD 연체"
              value={`USD ${money(kpi.overdue_usd)}`}
              sub="만기 경과"
              accent="#dc3545"
            />
            <Kpi label="건수" value={kpi.count} sub="AR 레코드" />
          </div>

          {rows.length === 0 ? (
            <div className="state">AR 레코드가 없습니다.</div>
          ) : (
            <div className="table-wrap">
              <table className="rfq">
                <thead>
                  <tr>
                    <th>CI No.</th>
                    <th>Customer</th>
                    <th>오더</th>
                    <th>통화</th>
                    <th className="num">Invoice</th>
                    <th className="num">수금</th>
                    <th className="num">미수금</th>
                    <th>만기일</th>
                    <th>상태</th>
                    <th>수금 등록</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <ArRowView key={r.id} r={r} onPaid={load} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}

function ArRowView({ r, onPaid }: { r: ArRow; onPaid: () => void }) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function pay() {
    if (amount === "") return;
    setBusy(true);
    setErr(null);
    try {
      await recordArPayment(r.id, Number(amount));
      setAmount("");
      onPaid();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "수금 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td className="cell">{r.ci_no || <span className="dash">—</span>}</td>
      <td className="cell">{r.customer}</td>
      <td className="cell">{r.ord_no || <span className="dash">—</span>}</td>
      <td className="cell">{r.currency}</td>
      <td className="cell num">{money(r.invoice_amount)}</td>
      <td className="cell num">{money(r.paid_amount)}</td>
      <td className="cell num">
        <b>{money(r.outstanding)}</b>
      </td>
      <td className="cell">{r.due_date || "—"}</td>
      <td className="cell">
        <span className={`ar-badge${r.overdue ? " overdue" : ""}`}>
          {r.status}
        </span>
      </td>
      <td className="cell">
        {r.status === "완납" ? (
          <span className="dash">—</span>
        ) : (
          <span className="pay-cell">
            <input
              className="action-input num"
              placeholder="수금액"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
            />
            <button
              className="btn primary"
              onClick={pay}
              disabled={busy || amount === ""}
            >
              {busy ? "…" : "등록"}
            </button>
            {err ? <span className="action-err">{err}</span> : null}
          </span>
        )}
      </td>
    </tr>
  );
}

function Kpi({
  label,
  value,
  sub,
  accent = "#0055a8",
}: {
  label: string;
  value: string | number;
  sub: string;
  accent?: string;
}) {
  return (
    <div className="kpi-card" style={{ borderLeftColor: accent }}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{sub}</div>
    </div>
  );
}
