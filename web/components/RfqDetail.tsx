"use client";

import { useEffect, useState } from "react";
import { fetchRfqDetail, fetchVendors, createVendorRfq } from "@/lib/api";
import type { RfqDetail as RfqDetailT, VendorOption } from "@/lib/types";

function money(n: number | null): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function RfqDetail({
  rfqId,
  onChanged,
}: {
  rfqId: number | null;
  onChanged?: () => void;
}) {
  const [data, setData] = useState<RfqDetailT | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vendors, setVendors] = useState<VendorOption[]>([]);

  function reload() {
    if (rfqId === null) return;
    setLoading(true);
    setError(null);
    fetchRfqDetail(rfqId)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "오류"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (rfqId === null) {
      setData(null);
      return;
    }
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfqId]);

  useEffect(() => {
    fetchVendors()
      .then(setVendors)
      .catch(() => setVendors([]));
  }, []);

  return (
    <div className="detail">
      <h2>선택한 건 상세 · 액션</h2>

      {rfqId === null ? (
        <div className="empty">위 표에서 행을 선택하면 상세가 표시됩니다.</div>
      ) : loading ? (
        <div className="empty">불러오는 중…</div>
      ) : error ? (
        <div className="empty" style={{ color: "#b42318" }}>
          상세 불러오기 오류: {error}
        </div>
      ) : !data ? null : (
        <div className="detail-body">
          {/* 요약 */}
          <div className="grid">
            <KV k="K-Maris RFQ No." v={data.rfq_no} />
            <KV k="고객 RFQ No." v={data.customer_rfq_no} />
            <KV k="Customer" v={data.customer} />
            <KV k="담당자" v={data.customer_contact} />
            <KV k="이메일" v={data.customer_email} />
            <KV k="선박" v={data.vessel} />
            <KV k="접수일" v={data.date} />
            <KV k="상태" v={data.status} />
          </div>

          <div className="detail-cols">
            {/* 12-step stepper */}
            <div className="stepper">
              <div className="sub-h">진행 단계 (12)</div>
              {data.steps.map((st) => (
                <div key={st.no} className={`step ${st.state}`}>
                  <span className="dot">
                    {st.state === "done" ? "✓" : st.state === "current" ? "●" : "○"}
                  </span>
                  <span className="nm">
                    {st.no}. {st.name}
                  </span>
                </div>
              ))}
            </div>

            {/* 품목 + 연결문서 */}
            <div className="detail-right">
              <div className="sub-h">품목 ({data.items.length})</div>
              {data.items.length === 0 ? (
                <div className="empty">등록된 품목이 없습니다.</div>
              ) : (
                <table className="mini">
                  <thead>
                    <tr>
                      <th>Part No.</th>
                      <th>품명</th>
                      <th className="num">수량</th>
                      <th className="num">단가</th>
                      <th className="num">금액</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((it, i) => (
                      <tr key={i}>
                        <td>{it.part_no || "—"}</td>
                        <td>{it.description || "—"}</td>
                        <td className="num">
                          {it.qty}
                          {it.unit ? ` ${it.unit}` : ""}
                        </td>
                        <td className="num">{money(it.unit_price)}</td>
                        <td className="num">{money(it.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <div className="sub-h" style={{ marginTop: 14 }}>
                연결 문서
              </div>
              <div className="chain">
                <ChainLine
                  label="Vendor RFQ"
                  rows={data.vendor_rfqs.map(
                    (v) => `${v.vrfq_no} · ${v.vendor} · ${v.at}`
                  )}
                />
                <ChainLine
                  label="Vendor Quote"
                  rows={data.vendor_quotes.map(
                    (v) => `${v.vendor_quote_no} · ${v.amount} · ${v.at}`
                  )}
                />
                <ChainLine
                  label="Customer Quote"
                  rows={
                    data.quotation
                      ? [
                          `${data.quotation.qtn_no} · ${data.quotation.amount} · ${data.quotation.status} · ${data.quotation.at}`,
                        ]
                      : []
                  }
                />
              </div>
            </div>
          </div>

          <div className="action-block">
            <div className="sub-h">액션</div>
            <VendorRfqAction
              rfqId={data.id}
              vendors={vendors}
              onDone={() => {
                reload();
                onChanged?.();
              }}
            />
            <div className="actions">
              <button className="btn" disabled title="다음 액션에서 연결">
                Vendor Quote 수신 등록
              </button>
              <button className="btn" disabled title="다음 액션에서 연결">
                Customer Quote 발신
              </button>
              <span className="hint-inline">위 두 액션은 이어서 연결합니다.</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="kv">
      <div className="k">{k}</div>
      <div className="v">{v && v !== "—" ? v : "—"}</div>
    </div>
  );
}

function VendorRfqAction({
  rfqId,
  vendors,
  onDone,
}: {
  rfqId: number;
  vendors: VendorOption[];
  onDone: () => void;
}) {
  const [vendorId, setVendorId] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function send() {
    if (vendorId === "") return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await createVendorRfq(rfqId, vendorId);
      setMsg(`발신 완료 — ${r.vrfq_no} (${r.vendor})`);
      setVendorId("");
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "발신 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="action-row">
      <span className="action-name">Vendor RFQ 발신</span>
      <select
        value={vendorId}
        onChange={(e) =>
          setVendorId(e.target.value === "" ? "" : Number(e.target.value))
        }
      >
        <option value="">Vendor 선택…</option>
        {vendors.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
      <button
        className="btn primary"
        onClick={send}
        disabled={busy || vendorId === ""}
      >
        {busy ? "발신 중…" : "발신"}
      </button>
      {msg ? <span className="action-ok">{msg}</span> : null}
      {err ? <span className="action-err">{err}</span> : null}
    </div>
  );
}

function ChainLine({ label, rows }: { label: string; rows: string[] }) {
  return (
    <div className="chain-line">
      <span className="chain-label">{label}</span>
      {rows.length === 0 ? (
        <span className="chain-empty">—</span>
      ) : (
        <span className="chain-vals">
          {rows.map((r, i) => (
            <span key={i} className="chain-pill">
              {r}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
