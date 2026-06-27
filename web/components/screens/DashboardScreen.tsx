"use client";

import { fetchDashboard } from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";
import { tr } from "@/lib/labels";

function num(n: number) {
  return n.toLocaleString();
}

/** 탭(대제목) 아래 한 단계 낮은 섹션 소제목 (작은 회색 라벨). */
function SubHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="dash-subhead">
      <span className="t">{title}</span>
      {sub ? <span className="s">{sub}</span> : null}
    </div>
  );
}

export default function DashboardScreen() {
  const { data, error } = useCachedData("dashboard", fetchDashboard);

  if (error && !data) {
    return <div className="state error">API error: {error.message}</div>;
  }
  if (!data) {
    return <div className="state">Loading…</div>;
  }

  const { kpi, ops, perf, alerts } = data;
  const tat = perf.quotation_tat_h;

  return (
    <>
      <SubHead title="Operational Status" sub="Operational status" />
      <div className="kpi-row">
        <Kpi
          label="Open RFQ"
          value={kpi.open_rfq}
          sub="In progress"
          chip={{ text: `Urgent ${ops.urgent}`, tone: ops.urgent ? "red" : "gray" }}
        />
        <Kpi
          label="Active Orders"
          value={kpi.active_orders}
          sub="Preparing/in progress"
          chip={{
            text: `PO pending ${ops.pending_po}`,
            tone: ops.pending_po ? "amber" : "gray",
          }}
        />
        <Kpi
          label="AR Outstanding"
          value={`USD ${num(Math.round(kpi.ar_outstanding_usd))}`}
          sub="Outstanding"
          accent={ops.overdue ? "#dc3545" : "#0055a8"}
          chip={{ text: `Overdue ${ops.overdue}`, tone: ops.overdue ? "red" : "gray" }}
        />
        <Kpi
          label="This Month Quotes"
          value={kpi.monthly_quotes}
          sub="Quotes"
          chip={{
            text: `Expiring ${ops.expiring}`,
            tone: ops.expiring ? "amber" : "gray",
          }}
        />
      </div>

      <SubHead title="Sales Performance KPIs" sub="Sales performance" />
      <div className="kpi-row">
        <Kpi
          label="RFQ Handling Rate"
          value={`${perf.handling_rate}%`}
          sub="Quote submission rate"
        />
        <Kpi
          label="Quotation TAT"
          value={tat === null ? "—" : `${num(tat)}h`}
          sub="Avg. response time"
          accent="#2e8b57"
        />
        <Kpi
          label="Hit Rate"
          value={`${perf.hit_rate}%`}
          sub="PO conversion rate"
          accent="#e8830c"
          chip={{
            text: `Negotiating USD ${num(Math.round(perf.negotiating_value_usd))}`,
            tone: "blue",
          }}
        />
        <Kpi
          label="Gross Margin"
          value={`${perf.gross_margin_pct}%`}
          sub="Gross margin %"
          accent="#1a7a4a"
        />
      </div>

      <div className="dash-two">
        <div>
          <SubHead title="Urgent Follow-up · Level A Quotes" />
          {alerts.urgent_quotes.length === 0 ? (
            <div className="alert-ok">No urgent follow-up quotes.</div>
          ) : (
            alerts.urgent_quotes.map((q) => (
              <div className="alert-card" key={q.qtn_no}>
                <div>
                  <div className="a-main">{q.qtn_no}</div>
                  <div className="a-sub">Status: {tr(q.status)}</div>
                </div>
                <div className="a-right">Valid until: {q.valid_until || "—"}</div>
              </div>
            ))
          )}
        </div>

        <div>
          <SubHead title="Overdue AR" />
          {alerts.overdue_ar.length === 0 ? (
            <div className="alert-ok">No overdue AR.</div>
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
