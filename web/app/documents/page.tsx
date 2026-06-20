"use client";

import { useEffect, useState } from "react";
import { fetchDocumentsOverview } from "@/lib/api";
import type { DocRow } from "@/lib/types";
import AppShell, { SectionHead } from "@/components/AppShell";

export default function DocumentsPage() {
  return (
    <AppShell active="documents">
      <DocumentsOverview />
    </AppShell>
  );
}

function Cell({ main, num }: { main: string; num?: boolean }) {
  const empty = !main || main === "—";
  return (
    <td className={`cell${num ? " num" : ""}`}>
      <div className="m">{empty ? <span className="dash">—</span> : main}</div>
    </td>
  );
}

function DocPill({ has, no, label }: { has: boolean; no: string; label: string }) {
  return (
    <td className="cell">
      <span className={`doc-pill${has ? " on" : ""}`} title={no || `${label} 미생성`}>
        {has ? `✓ ${no || label}` : `· ${label}`}
      </span>
    </td>
  );
}

function DocumentsOverview() {
  const [rows, setRows] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    fetchDocumentsOverview()
      .then((d) => setRows(d.rows))
      .catch((e) => setError(e instanceof Error ? e.message : "오류"))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  return (
    <>
      <SectionHead title="문서 (Documents)" sub="오더별 CI · PL · SA · Tax 현황" />

      <div className="toolbar">
        <button className="btn" onClick={load}>
          새로고침
        </button>
        <span className="hint-inline">
          오더별 선적 문서(CI · PL · SA · Tax) 생성 현황. 문서 생성·PDF는 데스크톱 앱에서 진행합니다.
        </span>
      </div>

      {loading ? (
        <div className="state">불러오는 중…</div>
      ) : error ? (
        <div className="state error">API 오류: {error}</div>
      ) : rows.length === 0 ? (
        <div className="state">등록된 오더가 없습니다.</div>
      ) : (
        <div className="table-wrap">
          <table className="rfq">
            <thead>
              <tr>
                <th>오더 No.</th>
                <th>Customer</th>
                <th>선박</th>
                <th>PO No.</th>
                <th>Commercial Invoice</th>
                <th>Packing List</th>
                <th>Shipping Advice</th>
                <th>Tax Invoice</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Cell main={r.ord_no} />
                  <Cell main={r.customer} />
                  <Cell main={r.vessel} />
                  <Cell main={r.po_no} />
                  <DocPill has={r.has_ci} no={r.ci_no} label="CI" />
                  <DocPill has={r.has_pl} no={r.pl_no} label="PL" />
                  <DocPill has={r.has_sa} no={r.sa_no} label="SA" />
                  <DocPill has={r.has_tax} no={r.tax_no} label="Tax" />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
