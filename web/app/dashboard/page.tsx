"use client";

import { useEffect, useState } from "react";
import { fetchDashboard } from "@/lib/api";
import type { DashboardData } from "@/lib/types";
import AppShell, { SectionHead } from "@/components/AppShell";

export default function DashboardPage() {
  return (
    <AppShell active="dashboard">
      <Dashboard />
    </AppShell>
  );
}

function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchDashboard()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "오류"));
  }, []);

  return (
    <>
      <SectionHead title="운영 현황" sub="Dashboard" />

      {error ? (
        <div className="state error">API 오류: {error}</div>
      ) : !data ? (
        <div className="state">불러오는 중…</div>
      ) : (
        <>
          <div className="kpi-row">
            <Kpi label="Open RFQ" value={data.kpi.open_rfq} sub="진행 중" />
            <Kpi label="전체 RFQ" value={data.kpi.total_rfq} sub="누적" />
            <Kpi
              label="Active Orders"
              value={data.kpi.active_orders}
              sub="배송 준비/진행"
            />
            <Kpi
              label="이달 견적"
              value={data.kpi.monthly_quotes}
              sub="Quotation"
            />
            <Kpi
              label="AR Outstanding"
              value={`USD ${data.kpi.ar_outstanding_usd.toLocaleString()}`}
              sub="미수금"
              accent="#dc3545"
            />
          </div>

          <div className="dash-cols">
            <div className="panel">
              <div className="sub-h">12단계 분포</div>
              {data.steps.map((name, i) => {
                const n = data.stage_distribution[i] ?? 0;
                const max = Math.max(1, ...data.stage_distribution);
                return (
                  <div key={i} className="dist-row">
                    <span className="dist-label">
                      {i + 1}. {name}
                    </span>
                    <span className="dist-track">
                      <span
                        className="dist-fill"
                        style={{ width: `${(n / max) * 100}%` }}
                      />
                    </span>
                    <span className="dist-n">{n}</span>
                  </div>
                );
              })}
            </div>

            <div className="panel">
              <div className="sub-h">최근 RFQ</div>
              <table className="mini">
                <thead>
                  <tr>
                    <th>RFQ No.</th>
                    <th>Customer</th>
                    <th>상태</th>
                    <th>접수</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((r) => (
                    <tr key={r.rfq_no}>
                      <td>{r.rfq_no}</td>
                      <td>{r.customer}</td>
                      <td>{r.status}</td>
                      <td>{r.at}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
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
