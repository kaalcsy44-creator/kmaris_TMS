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

function num(n: number) {
  return n.toLocaleString();
}

function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchDashboard()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "오류"));
  }, []);

  if (error) {
    return (
      <>
        <SectionHead title="운영 현황" sub="Dashboard" />
        <div className="state error">API 오류: {error}</div>
      </>
    );
  }
  if (!data) {
    return (
      <>
        <SectionHead title="운영 현황" sub="Dashboard" />
        <div className="state">불러오는 중…</div>
      </>
    );
  }

  const { kpi, ops, perf, alerts } = data;
  const tat = perf.quotation_tat_h;

  return (
    <>
      <SectionHead title="운영 현황" sub="Dashboard" />

      {/* 운영 KPI */}
      <div className="kpi-row">
        <Kpi
          label="Open RFQ"
          value={kpi.open_rfq}
          sub="진행 중"
          chip={{ text: `Urgent ${ops.urgent}`, tone: ops.urgent ? "red" : "gray" }}
        />
        <Kpi
          label="Active Orders"
          value={kpi.active_orders}
          sub="배송 준비/진행"
          chip={{
            text: `PO pending ${ops.pending_po}`,
            tone: ops.pending_po ? "amber" : "gray",
          }}
        />
        <Kpi
          label="AR Outstanding"
          value={`USD ${num(Math.round(kpi.ar_outstanding_usd))}`}
          sub="미수금"
          accent={ops.overdue ? "#dc3545" : "#0055a8"}
          chip={{ text: `Overdue ${ops.overdue}`, tone: ops.overdue ? "red" : "gray" }}
        />
        <Kpi
          label="This Month Quotes"
          value={kpi.monthly_quotes}
          sub="견적"
          chip={{
            text: `Expiring ${ops.expiring}`,
            tone: ops.expiring ? "amber" : "gray",
          }}
        />
      </div>

      <SectionHead title="영업 성과 KPI" sub="Sales performance" />
      <div className="kpi-row">
        <Kpi
          label="RFQ Handling Rate"
          value={`${perf.handling_rate}%`}
          sub="견적 제출률"
        />
        <Kpi
          label="Quotation TAT"
          value={tat === null ? "—" : `${num(tat)}h`}
          sub="평균 응답시간"
          accent="#2e8b57"
        />
        <Kpi
          label="Hit Rate"
          value={`${perf.hit_rate}%`}
          sub="PO 전환율"
          accent="#e8830c"
          chip={{
            text: `Negotiating USD ${num(Math.round(perf.negotiating_value_usd))}`,
            tone: "blue",
          }}
        />
        <Kpi
          label="Gross Margin"
          value={`${perf.gross_margin_pct}%`}
          sub="매출이익률"
          accent="#1a7a4a"
        />
      </div>

      <div className="dash-two">
        <div>
          <SectionHead title="긴급 Follow-up · Level A 견적" />
          {alerts.urgent_quotes.length === 0 ? (
            <div className="alert-ok">긴급 follow-up 견적이 없습니다.</div>
          ) : (
            alerts.urgent_quotes.map((q) => (
              <div className="alert-card" key={q.qtn_no}>
                <div>
                  <div className="a-main">{q.qtn_no}</div>
                  <div className="a-sub">상태: {q.status}</div>
                </div>
                <div className="a-right">Valid until: {q.valid_until || "—"}</div>
              </div>
            ))
          )}
        </div>

        <div>
          <SectionHead title="연체 AR" />
          {alerts.overdue_ar.length === 0 ? (
            <div className="alert-ok">연체 AR이 없습니다.</div>
          ) : (
            alerts.overdue_ar.map((ar, i) => (
              <div className="alert-card danger" key={`${ar.ci_no}-${i}`}>
                <div>
                  <div className="a-main">{ar.ci_no || "N/A"}</div>
                  <div className="a-sub">Due: {ar.due_date || "—"}</div>
                </div>
                <div className="a-right">
                  {ar.currency} {ar.outstanding.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="dash-cols" style={{ marginTop: 22 }}>
        <div className="panel">
          <div className="sub-h">내부 진행 12단계 분포</div>
          {data.steps.map((name, i) => {
            const n = data.stage_distribution[i] ?? 0;
            const max = Math.max(1, ...data.stage_distribution);
            return (
              <div key={i} className="dist-row">
                <span className="dist-label">
                  {i + 1}. {name}
                </span>
                <span className="dist-track">
                  <span className="dist-fill" style={{ width: `${(n / max) * 100}%` }} />
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
  );
}

type Chip = { text: string; tone: "red" | "amber" | "blue" | "gray" };

function Kpi({
  label,
  value,
  sub,
  accent = "#0055a8",
  chip,
}: {
  label: string;
  value: string | number;
  sub: string;
  accent?: string;
  chip?: Chip;
}) {
  return (
    <div className="kpi-card" style={{ borderLeftColor: accent }}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{sub}</div>
      {chip ? (
        <div className="kc-foot">
          <span className={`kc-chip ${chip.tone}`}>{chip.text}</span>
        </div>
      ) : null}
    </div>
  );
}
