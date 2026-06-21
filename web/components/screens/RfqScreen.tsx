"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { fetchRfqOverview, fetchCustomers } from "@/lib/api";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import RfqTable from "@/components/RfqTable";
import RfqDetail from "@/components/RfqDetail";
import RfqActionTabs from "@/components/RfqActionTabs";

export default function RfqScreen() {
  const [customerId, setCustomerId] = useState<number | "">("");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const { data: customers = [] } = useCachedData("customers", fetchCustomers);

  const {
    data: overview,
    error,
    loading,
    refresh,
  } = useCachedData(`rfq:overview:${customerId}`, () =>
    fetchRfqOverview(customerId === "" ? undefined : customerId)
  );
  const rows = overview?.rows ?? [];

  // 액션(생성·수정·삭제) 후: 현재 RFQ 목록 강제 새로고침 + 대시보드 캐시 무효화
  const load = useCallback(() => {
    invalidateCache("dashboard");
    return refresh();
  }, [refresh]);

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
        <button className="btn" onClick={load}>
          새로고침
        </button>
        <Link className="btn primary" href="/rfq/new" style={{ marginLeft: "auto" }}>
          + 신규 RFQ
        </Link>
      </div>

      {loading && rows.length === 0 ? (
        <div className="state">불러오는 중…</div>
      ) : error && rows.length === 0 ? (
        <div className="state error">
          API 오류: {error.message}
          <br />
          백엔드(admin_api.py)가 실행 중인지, 토큰이 맞는지 확인하세요.
        </div>
      ) : rows.length === 0 ? (
        <div className="state">표시할 RFQ가 없습니다.</div>
      ) : (
        <RfqTable rows={rows} selectedId={selectedId} onSelect={setSelectedId} />
      )}

      <RfqDetail
        rfqId={selectedId}
        onChanged={load}
        onDeleted={() => {
          setSelectedId(null);
          load();
        }}
      />
      <RfqActionTabs
        rfqId={selectedId}
        rfqNo={rows.find((r) => r.id === selectedId)?.crfq_no}
        onChanged={load}
      />
    </>
  );
}
