"use client";

import { useEffect, useState } from "react";
import { fetchPoDetail, fetchPoOverview } from "@/lib/api";
import type { PoDetail as PoDetailT, PoRow } from "@/lib/types";

const TOTAL_STEPS = 12;

function Cell({ main, sub, num }: { main: string; sub?: string; num?: boolean }) {
  const empty = !main || main === "—";
  return (
    <td className={`cell${num ? " num" : ""}`}>
      <div className="m">{empty ? <span className="dash">—</span> : main}</div>
      {sub ? <div className="s">{sub}</div> : null}
    </td>
  );
}

export default function PoScreen() {
  const [rows, setRows] = useState<PoRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    fetchPoOverview()
      .then((d) => {
        setRows(d.rows);
        setSelectedId((cur) =>
          cur && d.rows.some((r) => r.id === cur) ? cur : null
        );
      })
      .catch((e) => setError(e instanceof Error ? e.message : "오류"))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  return (
    <>
      <div className="toolbar">
        <button className="btn" onClick={load}>
          새로고침
        </button>
        <span className="hint-inline">
          고객 P/O 수신 → Vendor P/O 발신 흐름. 고객 PO No.는 PDF 자동 인식/수기 입력 값입니다.
        </span>
      </div>

      {loading ? (
        <div className="state">불러오는 중…</div>
      ) : error ? (
        <div className="state error">API 오류: {error}</div>
      ) : rows.length === 0 ? (
        <div className="state">표시할 P/O가 없습니다.</div>
      ) : (
        <div className="table-wrap">
          <table className="rfq">
            <thead>
              <tr>
                <th className="chk"></th>
                <th>K-Maris RFQ No.</th>
                <th>Customer</th>
                <th>선박</th>
                <th>고객 P/O No.</th>
                <th>K-Maris ORD No.</th>
                <th className="num">품목수</th>
                <th>Vendor P/O No.</th>
                <th>Vendor</th>
                <th>수신자 이메일</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const selectable = r.id > 0;
                const sel = selectable && r.id === selectedId;
                const toggle = () => {
                  if (selectable) setSelectedId(sel ? null : r.id);
                };
                return (
                  <tr
                    key={r.id || `r${i}`}
                    className={sel ? "sel" : ""}
                    onClick={toggle}
                  >
                    <td className="chk">
                      <input
                        type="checkbox"
                        checked={sel}
                        disabled={!selectable}
                        onChange={toggle}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <Cell main={r.customer_rfq_no} />
                    <Cell main={r.customer} />
                    <Cell main={r.vessel} />
                    <Cell
                      main={r.customer_po_no}
                      sub={r.customer_po_at ? `수신: ${r.customer_po_at}` : undefined}
                    />
                    <Cell main={r.ord_no} />
                    <Cell main={String(r.item_count)} num />
                    <Cell
                      main={r.vendor_po_no}
                      sub={r.vendor_po_at ? `발신: ${r.vendor_po_at}` : undefined}
                    />
                    <Cell main={r.vendor} />
                    <Cell main={r.vendor_email} />
                    <td className="status">
                      <div className="lbl">{r.status}</div>
                      <div className="bar">
                        {Array.from({ length: TOTAL_STEPS }).map((_, k) => (
                          <span key={k} className={`seg${k < r.stage ? " on" : ""}`} />
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <PoDetail orderId={selectedId} />
      <PoActionTabs orderId={selectedId} orderNo={rows.find((r) => r.id === selectedId)?.ord_no} />
    </>
  );
}

function PoDetail({ orderId }: { orderId: number | null }) {
  const [data, setData] = useState<PoDetailT | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (orderId === null) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    fetchPoDetail(orderId)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "오류"))
      .finally(() => setLoading(false));
  }, [orderId]);

  return (
    <div className="detail">
      <h2>선택한 오더 상세</h2>

      {orderId === null ? (
        <div className="empty">위 목록에서 체크박스를 선택하면 상세가 표시됩니다.</div>
      ) : loading ? (
        <div className="empty">불러오는 중…</div>
      ) : error ? (
        <div className="empty" style={{ color: "#b42318" }}>
          상세 불러오기 오류: {error}
        </div>
      ) : !data ? null : (
        <div className="detail-body">
          <div className="grid">
            <KV k="오더 No." v={data.ord_no} />
            <KV k="고객 P/O No." v={data.customer_po_no} />
            <KV k="고객 P/O 수신일" v={data.customer_po_at} />
            <KV k="고객 RFQ No." v={data.customer_rfq_no} />
            <KV k="K-Maris RFQ No." v={data.rfq_no} />
            <KV k="Quotation No." v={data.quotation_no} />
            <KV k="Customer" v={data.customer} />
            <KV k="담당자" v={data.customer_contact} />
            <KV k="이메일" v={data.customer_email} />
            <KV k="선박" v={data.vessel} />
            <KV k="오더 상태" v={data.order_status} />
            <KV k="통합 상태" v={data.status} />
            <KV k="약속 납기일" v={data.promised_delivery} />
            <KV k="출고일" v={data.shipped_date} />
            <KV k="인도일" v={data.delivered_date} />
          </div>

          <div className="detail-cols">
            <div className="stepper">
              <div className="sub-h">진행 단계 (12)</div>
              {data.steps.map((st) => (
                <div key={st.no} className={`step ${st.state}`}>
                  <span className="dot">
                    {st.state === "done" ? "✓" : st.state === "current" ? "•" : ""}
                  </span>
                  <span className="nm">
                    {st.no}. {st.name}
                  </span>
                </div>
              ))}
            </div>

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
                  label="Vendor P/O"
                  rows={data.vendor_pos.map(
                    (p) =>
                      `${p.po_no || "—"} · ${p.vendor} · ${p.status || "—"}${
                        p.sent_date ? ` · 발신 ${p.sent_date}` : ""
                      }`
                  )}
                />
                <ChainLine
                  label="Shipping"
                  rows={data.documents.sa_no ? [data.documents.sa_no] : []}
                />
                <ChainLine
                  label="Invoice"
                  rows={[data.documents.ci_no, data.documents.pl_no, data.documents.tax_no].filter(Boolean)}
                />
                <ChainLine
                  label="AR"
                  rows={data.documents.ar.map(
                    (a) =>
                      `${a.ci_no || "—"} · ${a.currency} ${money(a.paid_amount)}/${money(
                        a.invoice_amount
                      )} · ${a.status}`
                  )}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PoActionTabs({
  orderId,
  orderNo,
}: {
  orderId: number | null;
  orderNo?: string;
}) {
  const [tab, setTab] = useState("customer");
  const tabs = [
    { key: "customer", label: "5. Customer P/O 수신" },
    { key: "vendor", label: "6. Vendor P/O 발신" },
  ];

  return (
    <div className="action-tabs">
      <div className="page-tabs">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? "on" : ""}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {orderId && orderNo ? (
        <div className="action-ctx">
          대상 오더: <b>{orderNo}</b>
        </div>
      ) : null}

      <div className="panel action-panel">
        {tab === "customer" ? (
          <div className="action-row">
            <span className="action-name">Customer P/O 수신</span>
            <span className="hint-inline">
              고객 P/O 등록, PDF 자동 인식, 견적서 불러오기 작업 탭입니다.
            </span>
          </div>
        ) : (
          <>
            <div className="action-row">
              <span className="action-name">Vendor P/O 생성</span>
              <span className="hint-inline">
                선택한 오더 기준으로 Vendor 발주서 생성 작업을 진행하는 탭입니다.
              </span>
            </div>
            <div className="action-row">
              <span className="action-name">Vendor P/O 발신</span>
              <span className="hint-inline">
                생성된 발주서 이메일 미리보기와 발신 작업을 진행하는 탭입니다.
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function money(n: number | null): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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
