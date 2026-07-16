"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { fetchPipeline } from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";
import { resolveSteps, vendorOf } from "@/lib/deal";
import { splitProjectNo } from "@/lib/activity";
import { tr } from "@/lib/labels";
import type { PipelineRow } from "@/lib/types";
import WorkTypeBadge from "@/components/WorkTypeBadge";
import CustomerName from "@/components/common/CustomerName";
import VendorName from "@/components/common/VendorName";

/**
 * 프로젝트 색인(읽기 전용) — /project.
 *
 * 진행현황(Progress)과 목록이 겹쳐 보이지만 목적이 다르다: Progress 는 단계를 진행시키는
 * 작업 화면이라 행을 누르면 편집 팝업이 열린다. 여기는 "무슨 프로젝트가 있고 어디까지
 * 왔고 얼마짜리인가"를 훑고 개요로 들어가는 문이라, 행을 누르면 개요가 열린다.
 * 그래서 필터·보드·열 편집 같은 작업용 장치를 두지 않는다 — 훑고 고르는 데만 쓴다.
 */
export default function ProjectsScreen() {
  const { data, error } = useCachedData("pipeline", () => fetchPipeline());
  const [q, setQ] = useState("");
  const [showClosed, setShowClosed] = useState(false);

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    const needle = q.trim().toLowerCase();
    return all.filter((r) => {
      if (!showClosed && r.cancelled) return false;
      if (!needle) return true;
      return [
        r.project_no,
        r.project_title,
        r.customer,
        r.contact_person,
        r.vessels || r.vessel,
        vendorOf(r),
        r.assignee,
      ].some((f) => (f || "").toLowerCase().includes(needle));
    });
  }, [data, q, showClosed]);

  const closedCount = (data?.rows ?? []).filter((r) => r.cancelled).length;

  if (error) return <div className="state">Could not load projects.</div>;
  if (!data) return <div className="state">Loading projects…</div>;

  return (
    <div className="pjx">
      <div className="pjx-bar">
        <input
          className="pjx-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by project no, title, customer, vessel, PIC…"
          aria-label="Filter projects"
        />
        <span className="pjx-count">
          {rows.length} project{rows.length === 1 ? "" : "s"}
        </span>
        {closedCount > 0 ? (
          <label className="pjx-closed">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(e) => setShowClosed(e.target.checked)}
            />
            Show closed ({closedCount})
          </label>
        ) : null}
      </div>

      <div className="pjx-wrap">
        <table className="pjx-table">
          <thead>
            <tr>
              <th className="pjx-c-no">Project No.</th>
              <th className="pjx-c-type">Type</th>
              <th className="pjx-c-cust">Customer</th>
              <th className="pjx-c-contact">Contact</th>
              <th className="pjx-c-vessel">Vessel</th>
              <th className="pjx-c-title">Project</th>
              <th className="pjx-c-stage">Stage</th>
              <th className="pjx-c-vendor">Vendor</th>
              <th className="pjx-c-amt num">Sales</th>
              <th className="pjx-c-amt num">Purchase</th>
              <th className="pjx-c-margin num">Margin</th>
              <th className="pjx-c-pic">PIC</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="pjx-empty" colSpan={12}>
                  {q.trim() ? `No projects match “${q.trim()}”.` : "No projects yet."}
                </td>
              </tr>
            ) : (
              rows.map((r) => <ProjectRow key={r.rfq_id} r={r} steps={data.steps} />)
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * 이중통화 금액("USD 8,000 KRW 12,347,280")을 통화 단위로 끊어 각 줄에 놓는다.
 * 좁은 열에서 그냥 wrap 시키면 "12,347,280" 같은 숫자 한가운데가 잘리는데, 통화 코드
 * (대문자 3글자) 앞에서만 끊으면 "USD 8,000" / "KRW 12,347,280" 이 한 덩어리씩 유지된다.
 * 단일 통화면 조각이 하나라 그대로 한 줄.
 */
function DualAmount({ value }: { value: string }) {
  const parts = value.trim().split(/\s+(?=[A-Z]{3}\s)/);
  return (
    <span className="pjx-amt">
      {parts.map((p, i) => (
        <span key={i} className="pjx-amt-cur">
          {p}
        </span>
      ))}
    </span>
  );
}

function ProjectRow({ r, steps }: { r: PipelineRow; steps: string[] }) {
  const { code, date } = splitProjectNo(r.project_no || r.kmaris_rfq_no || "—");
  const rSteps = resolveSteps(steps, r.work_type);
  const stage = Math.max(0, Math.min(r.stage, rSteps.length));
  const label = rSteps[stage - 1] || "—";
  // 선박은 오더별로 여러 척일 수 있다(vessels = 줄바꿈 구분).
  const vessels = (r.vessels || r.vessel || "").split("\n").filter(Boolean).join(" · ");
  // 확정 벤더(P/O) 우선, 없으면 RFQ 발송 벤더 목록 — 목록·보드와 같은 규칙(vendorOf).
  const vendor = vendorOf(r);

  return (
    <tr className={r.cancelled ? "closed" : undefined}>
      <td className="pjx-c-no">
        {/* 행 전체가 아니라 번호를 링크로 — 행 전체를 <Link> 로 감싸면 표 구조가 깨지고,
            onClick 라우팅은 새 탭(⌘·Ctrl 클릭)·링크 복사를 잃는다. */}
        <Link className="pjx-open" href={`/project/${r.rfq_id}`} title="Open project overview">
          <b>{code}</b>
          {date ? <span className="pjx-nodate">{date}</span> : null}
        </Link>
      </td>
      <td className="pjx-c-type">
        <WorkTypeBadge type={r.work_type} />
      </td>
      <td className="pjx-c-cust">
        {r.customer ? <CustomerName name={r.customer} /> : <span className="muted">—</span>}
      </td>
      <td className="pjx-c-contact">
        {r.contact_person || <span className="muted">—</span>}
      </td>
      <td className="pjx-c-vessel">{vessels || <span className="muted">—</span>}</td>
      <td className="pjx-c-title">
        {r.project_title || <span className="muted">(untitled project)</span>}
      </td>
      <td className="pjx-c-stage">
        <span className="pjx-stage-no">
          {stage}/{rSteps.length}
        </span>
        <span className="pjx-stage-label">{r.cancelled ? tr(r.status) : label}</span>
      </td>
      <td className="pjx-c-vendor">
        {vendor ? <VendorName name={vendor} /> : <span className="muted">—</span>}
      </td>
      <td className="pjx-c-amt num">
        {r.sales_total ? <DualAmount value={r.sales_total} /> : <span className="muted">—</span>}
      </td>
      <td className="pjx-c-amt num">
        {r.purchase_total ? (
          <DualAmount value={r.purchase_total} />
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="pjx-c-margin num">
        {r.margin_amount ? (
          <span className="pjx-margin-wrap">
            <DualAmount value={r.margin_amount} />
            {r.margin_pct != null ? (
              <span className="pjx-margin-pct">{r.margin_pct}%</span>
            ) : null}
          </span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="pjx-c-pic">{r.assignee || <span className="muted">—</span>}</td>
    </tr>
  );
}
