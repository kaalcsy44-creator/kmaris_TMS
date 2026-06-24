"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchQuotationOverview, fetchCustomers } from "@/lib/api";
import type { QtnRow, CustomerOption } from "@/lib/types";

const TOTAL_STEPS = 12;
const STATUSES = ["초안", "발송완료", "협상중", "수주확정", "실주", "만료"];

function money(n: number) {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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

export default function QuotationScreen({
  onSelect,
}: {
  onSelect?: (rfqId: number) => void;
}) {
  const [rows, setRows] = useState<QtnRow[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [customerId, setCustomerId] = useState<number | "">("");
  const [status, setStatus] = useState<string>("전체");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchQuotationOverview(
        customerId === "" ? undefined : customerId
      );
      setRows(data.rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchCustomers()
      .then(setCustomers)
      .catch(() => setCustomers([]));
  }, []);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  const filtered = useMemo(
    () => (status === "전체" ? rows : rows.filter((r) => r.status === status)),
    [rows, status]
  );

  return (
    <>
      <div className="toolbar">
        <div className="field">
          <label>Customer 필터</label>
          <select
            value={customerId}
            onChange={(e) =>
              setCustomerId(e.target.value === "" ? "" : Number(e.target.value))
            }
          >
            <option value="">전체</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>상태 필터</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="전체">전체</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <button className="btn" onClick={load}>
          새로고침
        </button>
        <span className="hint-inline" style={{ marginLeft: "auto" }}>
          {onSelect
            ? "행을 클릭하면 해당 프로젝트의 작업 화면으로 이동합니다."
            : "견적 신규 작성·발송은 RFQ 탭의 Customer Quote 액션에서 진행합니다."}
        </span>
      </div>

      {loading ? (
        <div className="state">불러오는 중…</div>
      ) : error ? (
        <div className="state error">API 오류: {error}</div>
      ) : filtered.length === 0 ? (
        <div className="state">표시할 견적이 없습니다.</div>
      ) : (
        <div className="table-wrap">
          <table className="rfq">
            <thead>
              <tr>
                <th>견적 No.</th>
                <th>RFQ No.</th>
                <th>Customer</th>
                <th>선박</th>
                <th className="num">품목수</th>
                <th className="num">합계</th>
                <th>Level</th>
                <th>유효기간</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  onClick={
                    onSelect && r.rfq_id ? () => onSelect(r.rfq_id!) : undefined
                  }
                  style={onSelect && r.rfq_id ? { cursor: "pointer" } : undefined}
                >
                  <Cell
                    main={r.qtn_no}
                    sub={r.sent_date ? `발신: ${r.sent_date}` : undefined}
                  />
                  <Cell main={r.rfq_no} />
                  <Cell main={r.customer} />
                  <Cell main={r.vessel} />
                  <Cell main={String(r.item_count)} num />
                  <Cell main={`${r.currency} ${money(r.amount)}`} num />
                  <Cell main={r.level} />
                  <Cell main={r.valid_until} />
                  <td className="status">
                    <div className="lbl">{r.status}</div>
                    {r.stage ? (
                      <div className="bar">
                        {Array.from({ length: TOTAL_STEPS }).map((_, k) => (
                          <span key={k} className={`seg${k < r.stage ? " on" : ""}`} />
                        ))}
                      </div>
                    ) : null}
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
