"use client";

import { useEffect, useState } from "react";
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

  function load() {
    setError(null);
    fetchArOverview()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "오류"));
  }

  useEffect(load, []);

  return (
    <>
      <SectionHead title="미수금 (AR)" sub="청구 · 수금 · 연체" />

      {error ? (
        <div className="state error">API 오류: {error}</div>
      ) : !data ? (
        <div className="state">불러오는 중…</div>
      ) : (
        <>
          <div className="kpi-row">
            <Kpi
              label="USD 미수금"
              value={`USD ${money(data.kpi.outstanding_usd)}`}
              sub="미완납 합계"
            />
            <Kpi
              label="USD 연체"
              value={`USD ${money(data.kpi.overdue_usd)}`}
              sub="만기 경과"
              accent="#dc3545"
            />
            <Kpi label="건수" value={data.kpi.count} sub="AR 레코드" />
          </div>

          {data.rows.length === 0 ? (
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
                  {data.rows.map((r) => (
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
