"use client";

import { useEffect, useState } from "react";
import { fetchRfqDetail, updateRfqLevel, deleteRfq } from "@/lib/api";
import type { RfqDetail as RfqDetailT } from "@/lib/types";

const LEVELS = ["A", "B", "C"];

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
  onDeleted,
}: {
  rfqId: number | null;
  onChanged?: () => void;
  onDeleted?: () => void;
}) {
  const [data, setData] = useState<RfqDetailT | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState("B");
  const [busy, setBusy] = useState(false);
  const [actMsg, setActMsg] = useState<string | null>(null);
  const [actErr, setActErr] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);

  function reload() {
    if (rfqId === null) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    fetchRfqDetail(rfqId)
      .then((d) => {
        setData(d);
        setLevel(d.follow_up_level || "B");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "오류"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    setActMsg(null);
    setActErr(null);
    setConfirmDel(false);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfqId]);

  async function saveLevel() {
    if (rfqId === null) return;
    setBusy(true);
    setActMsg(null);
    setActErr(null);
    try {
      await updateRfqLevel(rfqId, level);
      setActMsg("Level 업데이트 완료");
      reload();
      onChanged?.();
    } catch (e) {
      setActErr(e instanceof Error ? e.message : "Level 업데이트 실패");
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    if (rfqId === null) return;
    setBusy(true);
    setActMsg(null);
    setActErr(null);
    try {
      const r = await deleteRfq(rfqId);
      setConfirmDel(false);
      onDeleted?.();
      setActMsg(`${r.rfq_no} 삭제 완료`);
    } catch (e) {
      setActErr(e instanceof Error ? e.message : "삭제 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="detail">
      <h2>선택한 건 상세</h2>

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
            <KV k="Follow-up" v={data.follow_up_level} />
            <KV k="비고" v={data.notes} />
          </div>

          {/* 액션: Level 변경 / 삭제 (Streamlit 2_CRFQ render_rfq_detail 패리티) */}
          <div className="detail-actions">
            <div className="form-field">
              <label>Level 변경</label>
              <div className="action-row">
                <select value={level} onChange={(e) => setLevel(e.target.value)} disabled={busy}>
                  {LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
                <button className="btn" onClick={saveLevel} disabled={busy || level === data.follow_up_level}>
                  Level 업데이트
                </button>
              </div>
              <span className="hint-inline">상태(12단계)는 진행에 따라 자동 반영됩니다.</span>
            </div>
            <div className="form-field">
              <label>삭제</label>
              {!confirmDel ? (
                <button className="btn danger" onClick={() => setConfirmDel(true)} disabled={busy}>
                  RFQ 삭제
                </button>
              ) : (
                <div className="action-row">
                  <span className="action-err">연결된 Vendor RFQ/Quote도 함께 삭제됩니다. 진행하시겠습니까?</span>
                  <button className="btn danger" onClick={doDelete} disabled={busy}>
                    확인 삭제
                  </button>
                  <button className="btn" onClick={() => setConfirmDel(false)} disabled={busy}>
                    취소
                  </button>
                </div>
              )}
            </div>
            {actMsg ? <span className="action-ok">{actMsg}</span> : null}
            {actErr ? <span className="action-err">{actErr}</span> : null}
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
