"use client";

import { useEffect, useState } from "react";
import { fetchDashboard } from "@/lib/api";
import type { DashboardData } from "@/lib/types";
import AppShell, { SectionHead } from "@/components/AppShell";

function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="stepper">
      {steps.map((label, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        return (
          <div className={`step ${state}`} key={i}>
            <span className="dot">{i < current ? "✓" : i + 1}</span>
            <span className="lbl">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

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

      {/* 고객 트래킹용 현황 — 고객에게 노출되는 RFQ/Order 추적 단계 */}
      <SectionHead
        title="RFQ · Order 진행 현황"
        sub="고객 추적 단계 (k-maris.com/track 미리보기)"
      />
      {data.snapshot.length === 0 ? (
        <div className="state">등록된 RFQ가 없습니다.</div>
      ) : (
        data.snapshot.map((r) => (
          <div className="track-row" key={`t-${r.rfq_no}`}>
            <div className="track-card">
              <div className="track-card-head">
                <span className="track-card-title">
                  {r.rfq_no}
                  {r.customer_rfq_no ? (
                    <small> · Customer RFQ {r.customer_rfq_no}</small>
                  ) : null}
                </span>
                <span className="track-card-badge">{r.status}</span>
              </div>
              <div className="track-card-sub">{r.customer_vessel}</div>
              <div className="track-card-meta">
                Items {r.item_count} · Level {r.follow_up_level} · {r.date}
              </div>
              <Stepper steps={data.rfq_steps} current={r.step} />
            </div>

            {r.order ? (
              <div className="track-card">
                <div className="track-card-head">
                  <span className="track-card-title">{r.order.ord_no}</span>
                  <span className="track-card-badge">{r.order.status}</span>
                </div>
                <div className="track-card-sub">{r.order.customer_vessel}</div>
                <div className="track-card-meta">
                  Items {r.order.item_count} · {r.order.date}
                </div>
                <Stepper steps={data.order_steps} current={r.order.step} />
              </div>
            ) : (
              <div className="track-card empty">
                <div className="track-card-head">
                  <span className="track-card-title">No linked order</span>
                </div>
                <div className="track-card-sub">아직 오더가 생성되지 않았습니다.</div>
                <Stepper steps={data.order_steps} current={-1} />
              </div>
            )}
          </div>
        ))
      )}

      {/* 회사 내부 확인용 현황판 — 내부 12단계 */}
      <div style={{ marginTop: 22 }}>
        <SectionHead title="내부 진행 현황 (12단계)" sub="회사 내부 확인용" />
      </div>
      {data.snapshot.length === 0 ? (
        <div className="state">등록된 RFQ가 없습니다.</div>
      ) : (
        data.snapshot.map((r) => (
          <div className="intl-card" key={`i-${r.rfq_no}`}>
            <div className="intl-head">
              {r.rfq_no} <span className="gray">· {r.customer_vessel}</span> ·{" "}
              {r.stage}/12 {data.steps[r.stage - 1]}
            </div>
            <div className="intl-bar">
              {Array.from({ length: 12 }).map((_, k) => (
                <span key={k} className={`seg${k < r.stage ? " on" : ""}`} />
              ))}
            </div>
          </div>
        ))
      )}
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
