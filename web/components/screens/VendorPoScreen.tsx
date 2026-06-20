"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchVendorPoOverview } from "@/lib/api";
import type { VendorPoRow } from "@/lib/types";

function Cell({ main, sub, num }: { main: string; sub?: string; num?: boolean }) {
  const empty = !main || main === "—";
  return (
    <td className={`cell${num ? " num" : ""}`}>
      <div className="m">{empty ? <span className="dash">—</span> : main}</div>
      {sub ? <div className="s">{sub}</div> : null}
    </td>
  );
}

export default function VendorPoScreen() {
  const [rows, setRows] = useState<VendorPoRow[]>([]);
  const [sentOnly, setSentOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    fetchVendorPoOverview()
      .then((d) => setRows(d.rows))
      .catch((e) => setError(e instanceof Error ? e.message : "오류"))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  const filtered = useMemo(
    () => (sentOnly ? rows.filter((r) => r.sent) : rows),
    [rows, sentOnly]
  );

  return (
    <>
      <div className="toolbar">
        <button className="btn" onClick={load}>
          새로고침
        </button>
        <label className="check-inline">
          <input
            type="checkbox"
            checked={sentOnly}
            onChange={(e) => setSentOnly(e.target.checked)}
          />
          이메일 발송완료만
        </label>
        <span className="hint-inline">
          발주서(Purchase Order) 발신 내역. 발주서 생성·이메일 발송은 데스크톱 앱에서 진행합니다.
        </span>
      </div>

      {loading ? (
        <div className="state">불러오는 중…</div>
      ) : error ? (
        <div className="state error">API 오류: {error}</div>
      ) : filtered.length === 0 ? (
        <div className="state">표시할 발주서가 없습니다.</div>
      ) : (
        <div className="table-wrap">
          <table className="rfq">
            <thead>
              <tr>
                <th>PO No.</th>
                <th>오더 No.</th>
                <th>Customer</th>
                <th>Vendor</th>
                <th>수신자 이메일</th>
                <th>발주일</th>
                <th className="num">품목수</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <Cell main={r.po_no} />
                  <Cell main={r.ord_no} />
                  <Cell main={r.customer} />
                  <Cell main={r.vendor} />
                  <Cell main={r.vendor_email} />
                  <Cell
                    main={r.date}
                    sub={r.sent_date ? `발송: ${r.sent_date}` : undefined}
                  />
                  <Cell main={String(r.item_count)} num />
                  <td className="cell">
                    <span className={`doc-pill${r.sent ? " on" : ""}`}>
                      {r.sent ? `✓ ${r.status}` : r.status}
                    </span>
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
