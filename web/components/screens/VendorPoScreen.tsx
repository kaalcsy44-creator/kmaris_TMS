"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchVendorPoOverview } from "@/lib/api";
import type { VendorPoRow } from "@/lib/types";
import { tr } from "@/lib/labels";

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
      .catch((e) => setError(e instanceof Error ? e.message : "Error"))
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
          Refresh
        </button>
        <label className="check-inline">
          <input
            type="checkbox"
            checked={sentOnly}
            onChange={(e) => setSentOnly(e.target.checked)}
          />
          Email sent only
        </label>
        <span className="hint-inline">
          Purchase Order send history. PO creation & email sending are done in the desktop app.
        </span>
      </div>

      {loading ? (
        <div className="state">Loading…</div>
      ) : error ? (
        <div className="state error">API error: {error}</div>
      ) : filtered.length === 0 ? (
        <div className="state">No purchase orders to display.</div>
      ) : (
        <div className="table-wrap">
          <table className="rfq">
            <thead>
              <tr>
                <th>PO No.</th>
                <th>Customer</th>
                <th>Vendor</th>
                <th>Recipient email</th>
                <th>PO date</th>
                <th className="num">Items</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <Cell main={r.po_no} />
                  <Cell main={r.customer} />
                  <Cell main={r.vendor} />
                  <Cell main={r.vendor_email} />
                  <Cell
                    main={r.date}
                    sub={r.sent_date ? `Sent: ${r.sent_date}` : undefined}
                  />
                  <Cell main={String(r.item_count)} num />
                  <td className="cell">
                    <span className={`doc-pill${r.sent ? " on" : ""}`}>
                      {r.sent ? `✓ ${tr(r.status)}` : tr(r.status)}
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
