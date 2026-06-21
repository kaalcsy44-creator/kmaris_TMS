import type { RfqRow } from "@/lib/types";

const TOTAL_STEPS = 12;

function Cell({ main, sub, num }: { main: string; sub?: string; num?: boolean }) {
  const empty = !main || main === "—" || main === "";
  return (
    <td className={`cell${num ? " num" : ""}`}>
      <div className="m">{empty ? <span className="dash">—</span> : main}</div>
      {sub ? <div className="s">{sub}</div> : null}
    </td>
  );
}

function Status({ stage, label }: { stage: number; label: string }) {
  return (
    <td className="status">
      <div className="lbl">{label}</div>
      <div className="bar">
        {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
          <span key={i} className={`seg${i < stage ? " on" : ""}`} />
        ))}
      </div>
    </td>
  );
}

export default function RfqTable({
  rows,
  selectedId,
  onSelect,
}: {
  rows: RfqRow[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}) {
  return (
    <div className="table-wrap">
      <table className="rfq">
        <thead>
          <tr>
            <th className="chk" rowSpan={2}></th>
            <th className="grp" colSpan={4}>1. Customer RFQ 수신</th>
            <th className="grp" colSpan={2}>2. Vendor RFQ 발신</th>
            <th className="grp" colSpan={2}>3. Vendor Quot. 수신</th>
            <th className="grp" colSpan={2}>4. Customer Quot. 발신</th>
            <th rowSpan={2}>상태</th>
          </tr>
          <tr className="grp-sub">
            <th>고객 RFQ No.</th>
            <th>Customer</th>
            <th>선박</th>
            <th className="num">품목수</th>
            <th>K-Maris RFQ No.</th>
            <th>Vendor</th>
            <th>Vendor Quot. No.</th>
            <th className="num">Vendor 견적 금액</th>
            <th>K-Maris Quot. No.</th>
            <th className="num">견적 금액</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const sel = r.id === selectedId;
            return (
              <tr
                key={r.id}
                className={sel ? "sel" : ""}
                onClick={() => onSelect(sel ? null : r.id)}
              >
                <td className="chk">
                  <input
                    type="checkbox"
                    checked={sel}
                    onChange={() => onSelect(sel ? null : r.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </td>
                <Cell main={r.customer_rfq_no} sub={r.crfq_at} />
                <Cell main={r.customer} />
                <Cell main={r.vessel} />
                <Cell main={String(r.item_count)} num />
                <Cell main={r.vrfq_kmaris_no} sub={r.vrfq_at} />
                <Cell main={r.vrfq_vendors} />
                <Cell main={r.vquote_no} sub={r.vquote_at} />
                <Cell main={r.vendor_amount} num />
                <Cell main={r.cquote_no} sub={r.cquote_at} />
                <Cell main={r.customer_amount} num />
                <Status stage={r.stage} label={r.status} />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
