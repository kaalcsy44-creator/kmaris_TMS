"use client";

import { useEffect, useState } from "react";
import { fetchVendorQuoteOverview } from "@/lib/api";
import type { VendorQuoteOverviewRow } from "@/lib/types";

function money(n: number) {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** "YYYY-MM-DDTHH:MM" → "YY-MM-DD HH:MM" (없으면 received_date). */
function fmtReceived(r: VendorQuoteOverviewRow): string {
  const iso = r.received_at;
  if (iso && iso.length >= 16) return `${iso.slice(2, 10)} ${iso.slice(11, 16)}`;
  return r.received_date || "—";
}

function Cell({ main, sub, num }: { main: string; sub?: string; num?: boolean }) {
  const empty = !main || main === "—";
  return (
    <td className={`cell${num ? " num" : ""}`}>
      <div className="m">{empty ? <span className="dash">—</span> : main}</div>
      {sub ? <div className="s">{sub}</div> : null}
    </td>
  );
}

export default function VendorQuoteScreen({
  onSelect,
}: {
  onSelect?: (rfqId: number) => void;
}) {
  const [rows, setRows] = useState<VendorQuoteOverviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    fetchVendorQuoteOverview()
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
          Vendor 견적 수신 내역(전체)
          {onSelect ? " — 행을 클릭하면 해당 프로젝트의 작업 화면으로 이동합니다." : "."}
        </span>
      </div>

      {loading ? (
        <div className="state">불러오는 중…</div>
      ) : error ? (
        <div className="state error">API 오류: {error}</div>
      ) : rows.length === 0 ? (
        <div className="state">수신된 Vendor 견적이 없습니다.</div>
      ) : (
        <div className="table-wrap">
          <table className="rfq">
            <thead>
              <tr>
                <th>수신일시</th>
                <th>Vendor 견적번호</th>
                <th>Vendor</th>
                <th>VRFQ No.</th>
                <th>고객 RFQ No.</th>
                <th className="num">품목수</th>
                <th className="num">금액</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={
                    onSelect && r.rfq_id ? () => onSelect(r.rfq_id!) : undefined
                  }
                  style={onSelect && r.rfq_id ? { cursor: "pointer" } : undefined}
                >
                  <Cell main={fmtReceived(r)} />
                  <Cell main={r.vendor_quote_no} />
                  <Cell main={r.vendor} />
                  <Cell main={r.vrfq_no} />
                  <Cell main={r.customer_rfq_no} />
                  <Cell main={String(r.item_count)} num />
                  <Cell main={`${r.currency} ${money(r.amount)}`} num />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
