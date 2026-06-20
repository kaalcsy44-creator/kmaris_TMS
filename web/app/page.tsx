"use client";

import { useEffect, useState } from "react";
import { fetchRfqOverview, fetchCustomers } from "@/lib/api";
import type { RfqRow, CustomerOption } from "@/lib/types";
import RfqTable from "@/components/RfqTable";
import RfqDetail from "@/components/RfqDetail";
import AuthGate from "@/components/AuthGate";
import Nav from "@/components/Nav";

export default function Page() {
  return (
    <AuthGate>
      <Overview />
    </AuthGate>
  );
}

function Overview() {
  const [rows, setRows] = useState<RfqRow[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [customerId, setCustomerId] = useState<number | "">("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchRfqOverview(
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

  return (
    <div className="page">
      <Nav active="rfq" />

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
        <button className="btn" onClick={load}>
          새로고침
        </button>
      </div>

      {loading ? (
        <div className="state">불러오는 중…</div>
      ) : error ? (
        <div className="state error">
          API 오류: {error}
          <br />
          백엔드(admin_api.py)가 실행 중인지, 토큰이 맞는지 확인하세요.
        </div>
      ) : rows.length === 0 ? (
        <div className="state">표시할 RFQ가 없습니다.</div>
      ) : (
        <RfqTable
          rows={rows}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}

      <RfqDetail rfqId={selectedId} onChanged={load} />
    </div>
  );
}
