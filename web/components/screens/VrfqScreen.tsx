"use client";

import { useEffect, useState } from "react";
import { fetchVrfqOverview } from "@/lib/api";
import type { VrfqRow } from "@/lib/types";

function Cell({ main, sub, num }: { main: string; sub?: string; num?: boolean }) {
  const empty = !main || main === "—";
  return (
    <td className={`cell${num ? " num" : ""}`}>
      <div className="m">{empty ? <span className="dash">—</span> : main}</div>
      {sub ? <div className="s">{sub}</div> : null}
    </td>
  );
}

export default function VrfqScreen() {
  const [rows, setRows] = useState<VrfqRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    fetchVrfqOverview()
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
          Vendor RFQ 발신 내역. 신규 발신은 RFQ 탭의 상세 패널에서 진행합니다.
        </span>
      </div>

      {loading ? (
        <div className="state">불러오는 중…</div>
      ) : error ? (
        <div className="state error">API 오류: {error}</div>
      ) : rows.length === 0 ? (
        <div className="state">발송된 Vendor RFQ가 없습니다.</div>
      ) : (
        <div className="table-wrap">
          <table className="rfq">
            <thead>
              <tr>
                <th>VRFQ No.</th>
                <th>고객 RFQ No.</th>
                <th>Vendor</th>
                <th>수신자 이메일</th>
                <th>발송일</th>
                <th className="num">품목수</th>
                <th className="num">수신 견적</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Cell main={r.vrfq_no} />
                  <Cell main={r.customer_rfq_no} />
                  <Cell main={r.vendor} />
                  <Cell main={r.vendor_email} />
                  <Cell main={r.sent_date} />
                  <Cell main={String(r.item_count)} num />
                  <Cell main={`${r.quote_count}건`} num />
                  <td className="cell">
                    <span className="ar-badge">{r.status}</span>
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
