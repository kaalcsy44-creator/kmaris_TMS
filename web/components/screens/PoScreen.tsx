"use client";

import { useEffect, useState } from "react";
import { fetchPoOverview } from "@/lib/api";
import type { PoRow } from "@/lib/types";

const TOTAL_STEPS = 12;

function Cell({ main, sub, num }: { main: string; sub?: string; num?: boolean }) {
  const empty = !main || main === "—";
  return (
    <td className={`cell${num ? " num" : ""}`}>
      <div className="m">{empty ? <span className="dash">—</span> : main}</div>
      {sub ? <div className="s">{sub}</div> : null}
    </td>
  );
}

export default function PoScreen() {
  const [rows, setRows] = useState<PoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    fetchPoOverview()
      .then((d) => setRows(d.rows))
      .catch((e) => setError(e instanceof Error ? e.message : "오류"))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  return (
    <>
      <div className="toolbar">
        <button className="btn" onClick={load}>
          새로고침
        </button>
        <span className="hint-inline">
          고객 P/O 수신 → Vendor P/O 발신 흐름. 고객 PO No.는 PDF 자동 인식/수기 입력 값입니다.
        </span>
      </div>

      {loading ? (
        <div className="state">불러오는 중…</div>
      ) : error ? (
        <div className="state error">API 오류: {error}</div>
      ) : rows.length === 0 ? (
        <div className="state">표시할 P/O가 없습니다.</div>
      ) : (
        <div className="table-wrap">
          <table className="rfq">
            <thead>
              <tr>
                <th>고객 RFQ No.</th>
                <th>Customer</th>
                <th>선박</th>
                <th>고객 P/O No.</th>
                <th>오더 No.</th>
                <th className="num">품목수</th>
                <th>Vendor P/O No.</th>
                <th>Vendor</th>
                <th>수신자 이메일</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id || `r${i}`}>
                  <Cell main={r.customer_rfq_no} />
                  <Cell main={r.customer} />
                  <Cell main={r.vessel} />
                  <Cell
                    main={r.customer_po_no}
                    sub={r.customer_po_at ? `수신: ${r.customer_po_at}` : undefined}
                  />
                  <Cell main={r.ord_no} />
                  <Cell main={String(r.item_count)} num />
                  <Cell
                    main={r.vendor_po_no}
                    sub={r.vendor_po_at ? `발신: ${r.vendor_po_at}` : undefined}
                  />
                  <Cell main={r.vendor} />
                  <Cell main={r.vendor_email} />
                  <td className="status">
                    <div className="lbl">{r.status}</div>
                    <div className="bar">
                      {Array.from({ length: TOTAL_STEPS }).map((_, k) => (
                        <span key={k} className={`seg${k < r.stage ? " on" : ""}`} />
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
