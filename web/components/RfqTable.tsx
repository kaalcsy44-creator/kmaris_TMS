import type { RfqRow } from "@/lib/types";
import WorkTypeBadge from "@/components/WorkTypeBadge";

// 등록된 RFQ 목록 — 1열 고객 RFQ No., 2열 Customer 만 표시. 행 선택 시 작업 대상이 된다.
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
            <th className="chk"></th>
            <th>고객 RFQ No.</th>
            <th>Customer</th>
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
                <td className="cell">
                  <div className="m">
                    {r.customer_rfq_no || <span className="dash">—</span>}
                  </div>
                  {r.crfq_at ? <div className="s">{r.crfq_at}</div> : null}
                </td>
                <td className="cell">
                  <div
                    className="m"
                    style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}
                  >
                    {r.customer || <span className="dash">—</span>}
                    <WorkTypeBadge type={r.work_type} />
                  </div>
                  {r.vessel && r.vessel !== "—" ? (
                    <div className="s">{r.vessel}</div>
                  ) : null}
                  <div className="s">품목 {r.item_count}</div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
