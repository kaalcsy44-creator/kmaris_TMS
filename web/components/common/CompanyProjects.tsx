"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchCompanyProjects } from "@/lib/api";
import type { CompanyProject } from "@/lib/api";

type Kind = "vendors" | "customers";

/** 결과 칸 하나 — 벤더는 회신 여부, 고객은 성사/실주/진행 중. 필터 칩도 같은 값으로 가른다. */
type Outcome = "quoted" | "waiting" | "won" | "lost" | "open";

function outcomeOf(kind: Kind, r: CompanyProject): Outcome {
  if (kind === "vendors") return r.answered ? "quoted" : "waiting";
  return r.won ? "won" : r.lost ? "lost" : "open";
}

const OUTCOME_LABEL: Record<Outcome, string> = {
  quoted: "Quoted", waiting: "No reply", won: "Won", lost: "Lost", open: "Open",
};
const OUTCOME_TONE: Record<Outcome, string> = {
  quoted: "all", waiting: "none", won: "all", lost: "none", open: "part",
};
const FILTERS: Record<Kind, Outcome[]> = {
  vendors: ["quoted", "waiting"],
  customers: ["won", "open", "lost"],
};

/**
 * Company info 창의 프로젝트 이력 — 배지(개수)를 눌러 펼친다.
 *
 * 배지는 "몇 건"만 말해서, 그 한 건이 무엇이었는지 보려면 프로젝트 화면을 뒤져야 했다.
 * 번호·제목·고객·선박·단계를 여기서 읽고, 줄을 누르면 그 프로젝트의 개요로 간다.
 * 목록은 펼칠 때만 불러온다 — 명부 목록 API 에 실으면 열지도 않을 표를 매번 나른다.
 */
export default function CompanyProjects({ kind, name }: { kind: Kind; name: string }) {
  const [rows, setRows] = useState<CompanyProject[] | null>(null);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState<Outcome | "">("");

  useEffect(() => {
    let live = true;
    setRows(null);
    setErr("");
    fetchCompanyProjects(kind, name)
      .then((d) => { if (live) setRows(d.rows); })
      .catch((e) => { if (live) setErr(String(e?.message ?? e)); });
    return () => { live = false; };
  }, [kind, name]);

  if (err) return <div className="co-proj"><span className="action-err">{err}</span></div>;
  if (!rows) return <div className="co-proj"><span className="hint-inline">Loading projects…</span></div>;
  if (!rows.length) return <div className="co-proj"><span className="hint-inline">No projects yet.</span></div>;

  const count = (o: Outcome) => rows.filter((r) => outcomeOf(kind, r) === o).length;
  const shown = filter ? rows.filter((r) => outcomeOf(kind, r) === filter) : rows;
  const vendor = kind === "vendors";

  return (
    <div className="co-proj">
      <div className="co-proj-chips">
        <button type="button" className={`co-proj-chip${filter === "" ? " on" : ""}`}
                onClick={() => setFilter("")}>
          All <b>{rows.length}</b>
        </button>
        {FILTERS[kind].map((o) => (
          <button key={o} type="button" className={`co-proj-chip${filter === o ? " on" : ""}`}
                  onClick={() => setFilter(filter === o ? "" : o)}>
            {OUTCOME_LABEL[o]} <b>{count(o)}</b>
          </button>
        ))}
      </div>
      <table className="mini co-proj-table">
        <thead>
          <tr>
            <th>Project No.</th>
            <th>Project</th>
            {vendor ? <th>Customer</th> : null}
            <th>Vessel</th>
            <th>{vendor ? "Asked" : "Received"}</th>
            <th>Stage</th>
            <th>{vendor ? "Reply" : "Result"}</th>
            <th aria-label="Open" />
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const o = outcomeOf(kind, r);
            const href = `/project?rfq=${r.rfq_id}&view=overview`;
            return (
              <tr key={r.rfq_id}>
                <td className="co-proj-no">
                  <Link href={href}>{r.project_no || `#${r.rfq_id}`}</Link>
                  {r.customer_rfq_no ? <div className="co-proj-sub">{r.customer_rfq_no}</div> : null}
                </td>
                <td>{r.title || <span className="dash">—</span>}</td>
                {vendor ? <td>{r.customer || <span className="dash">—</span>}</td> : null}
                <td>{r.vessel || <span className="dash">—</span>}</td>
                <td className="co-proj-date">{(vendor ? r.sent || r.date : r.date) || "—"}</td>
                <td className="co-proj-stage">{r.stage}. {r.stage_label}</td>
                <td>
                  <span className={`pt-stat pt-stat--${OUTCOME_TONE[o]}`}>
                    <span className="pt-stat-dot" aria-hidden />
                    {OUTCOME_LABEL[o]}
                  </span>
                </td>
                <td className="co-proj-go">
                  <Link href={href} title="Open project overview">→</Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
