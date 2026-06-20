import type { RfqRow } from "@/lib/types";

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="kv">
      <div className="k">{k}</div>
      <div className="v">{v && v !== "—" ? v : "—"}</div>
    </div>
  );
}

export default function RfqDetail({ row }: { row: RfqRow | null }) {
  return (
    <div className="detail">
      <h2>선택한 건 상세 · 액션</h2>
      {!row ? (
        <div className="empty">
          위 표에서 행을 선택하면 상세가 표시됩니다.
        </div>
      ) : (
        <div className="grid">
          <KV k="K-Maris RFQ No." v={row.crfq_no} />
          <KV k="고객 RFQ No." v={row.customer_rfq_no} />
          <KV k="Customer" v={row.customer} />
          <KV k="선박" v={row.vessel} />
          <KV k="품목수" v={String(row.item_count)} />
          <KV k="상태" v={row.status} />
          <KV k="Vendor RFQ" v={`${row.vrfq_no} ${row.vrfq_at}`.trim()} />
          <KV k="Vendor Quot." v={`${row.vquote_no} ${row.vquote_at}`.trim()} />
          <KV k="Vendor 견적 금액" v={row.vendor_amount} />
          <KV k="Customer Quot." v={`${row.cquote_no} ${row.cquote_at}`.trim()} />
          <KV k="Customer 견적 금액" v={row.customer_amount} />
        </div>
      )}
    </div>
  );
}
