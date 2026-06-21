"use client";

import { useEffect, useState } from "react";
import {
  createOrder,
  createPurchaseOrder,
  fetchPoDetail,
  fetchPoOverview,
  fetchPoWorkOptions,
  previewVendorPo,
  parseOrderPdf,
  sendVendorPo,
  vendorPoPdfUrl,
} from "@/lib/api";
import { getToken } from "@/lib/auth";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import type {
  PoDetail as PoDetailT,
  PoWorkItem,
  PoWorkOptions,
  VendorPoPreview,
} from "@/lib/types";

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
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const {
    data: overview,
    error,
    loading,
    refresh,
  } = useCachedData("po:overview", fetchPoOverview);
  const rows = overview?.rows ?? [];

  // 목록 갱신 시 선택 행이 사라졌으면 선택 해제
  useEffect(() => {
    if (!overview) return;
    setSelectedId((cur) =>
      cur && overview.rows.some((r) => r.id === cur) ? cur : null
    );
  }, [overview]);

  // 새로고침 / 액션 후: P/O 목록 강제 새로고침 + 대시보드 캐시 무효화
  function load() {
    invalidateCache("dashboard");
    return refresh();
  }

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

      {loading && rows.length === 0 ? (
        <div className="state">불러오는 중…</div>
      ) : error && rows.length === 0 ? (
        <div className="state error">API 오류: {error.message}</div>
      ) : rows.length === 0 ? (
        <div className="state">표시할 P/O가 없습니다.</div>
      ) : (
        <div className="table-wrap">
          <table className="rfq">
            <thead>
              <tr>
                <th className="chk" rowSpan={2}></th>
                <th className="grp" colSpan={2}>1. Customer RFQ 수신</th>
                <th className="grp">2. Vendor RFQ 발신</th>
                <th className="grp">5. Customer P/O 수신</th>
                <th className="grp" colSpan={3}>6. Vendor P/O 발신</th>
                <th rowSpan={2}>상태</th>
              </tr>
              <tr className="grp-sub">
                <th>고객 RFQ No.</th>
                <th>Customer</th>
                <th>K-Maris RFQ No.</th>
                <th>고객 P/O No.</th>
                <th>K-Maris ORD No.</th>
                <th>Vendor</th>
                <th>수신자 이메일</th>
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
                    <Cell main={r.customer_rfq_no} sub={r.crfq_at} />
                    <td className="cell">
                      <div className="m">
                        {r.customer || <span className="dash">—</span>}
                      </div>
                      {r.vessel && r.vessel !== "—" ? (
                        <div className="s">{r.vessel}</div>
                      ) : null}
                      <div className="s">품목 {r.item_count}</div>
                    </td>
                    <Cell main={r.kmaris_rfq_no} />
                    <Cell
                      main={r.customer_po_no}
                      sub={r.customer_po_at ? `수신: ${r.customer_po_at}` : undefined}
                    />
                    <Cell main={r.ord_no} />
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
      <PoActionTabs
        orderId={selectedId}
        orderNo={rows.find((r) => r.id === selectedId)?.ord_no}
        onChanged={load}
      />
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
  onChanged,
}: {
  orderId: number | null;
  orderNo?: string;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState("customer");
  const [options, setOptions] = useState<PoWorkOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const tabs = [
    { key: "customer", label: "5. Customer P/O 수신" },
    { key: "vendor", label: "6. Vendor P/O 발신" },
  ];

  function reloadOptions() {
    setLoading(true);
    setError(null);
    fetchPoWorkOptions()
      .then(setOptions)
      .catch((e) => setError(e instanceof Error ? e.message : "오류"))
      .finally(() => setLoading(false));
  }

  useEffect(reloadOptions, []);

  function changed() {
    reloadOptions();
    onChanged();
  }

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

      {loading ? (
        <div className="panel">
          <div className="empty">작업 데이터를 불러오는 중…</div>
        </div>
      ) : error ? (
        <div className="panel">
          <div className="empty" style={{ color: "#b42318" }}>
            작업 데이터 오류: {error}
          </div>
        </div>
      ) : !options ? null : tab === "customer" ? (
        <CustomerPoWork options={options} onChanged={changed} />
      ) : (
        <VendorPoWork
          options={options}
          selectedOrderId={orderId}
          onChanged={changed}
        />
      )}
    </div>
  );
}

function CustomerPoWork({
  options,
  onChanged,
}: {
  options: PoWorkOptions;
  onChanged: () => void;
}) {
  const [sub, setSub] = useState("new");

  return (
    <div className="panel action-panel">
      <div className="seg-tabs">
        <button className={sub === "new" ? "on" : ""} onClick={() => setSub("new")}>
          신규 등록
        </button>
        <button className={sub === "list" ? "on" : ""} onClick={() => setSub("list")}>
          오더 목록
        </button>
      </div>
      {sub === "new" ? (
        <CustomerPoNewForm options={options} onChanged={onChanged} />
      ) : (
        <OrderList orders={options.orders} />
      )}
    </div>
  );
}

function CustomerPoNewForm({
  options,
  onChanged,
}: {
  options: PoWorkOptions;
  onChanged: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [quotationId, setQuotationId] = useState<number | "">("");
  const [customerId, setCustomerId] = useState<number | "">(
    options.customers[0]?.id ?? ""
  );
  const [vesselId, setVesselId] = useState<number | "">("");
  const [rfqId, setRfqId] = useState<number | "">("");
  const [poNo, setPoNo] = useState("");
  const [date, setDate] = useState(today);
  const [promised, setPromised] = useState("");
  const [items, setItems] = useState<PoWorkItem[]>([blankItem()]);
  const [busy, setBusy] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [ocrMsg, setOcrMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const vessels = options.vessels.filter(
    (v) => customerId === "" || v.customer_id === customerId
  );

  function loadQuotation(id: number | "") {
    setQuotationId(id);
    if (id === "") return;
    const q = options.quotations.find((x) => x.id === id);
    if (!q) return;
    setCustomerId(q.customer_id);
    setVesselId(q.vessel_id ?? "");
    setRfqId(q.rfq_id ?? "");
    setItems(q.items.length ? q.items.map(normalizeItem) : [blankItem()]);
  }

  function matchByName<T extends { name: string }>(
    hint: string | null | undefined,
    rows: T[]
  ) {
    if (!hint) return undefined;
    const h = hint.trim().toLowerCase();
    return rows.find((r) => {
      const n = r.name.toLowerCase();
      return h === n || h.includes(n) || n.includes(h);
    });
  }

  async function uploadOrderPdf(file: File | null) {
    if (!file) return;
    setOcrBusy(true);
    setErr(null);
    setOcrMsg(null);
    try {
      const r = await parseOrderPdf(file);
      const cust = matchByName(r.customer_hint, options.customers);
      if (cust) setCustomerId(cust.id);
      const vessel = matchByName(r.vessel_name, options.vessels);
      if (vessel) setVesselId(vessel.id);
      if (r.po_no) setPoNo(r.po_no);
      if (r.order_date) setDate(r.order_date);
      if (r.promised_delivery) setPromised(r.promised_delivery);
      if (r.items?.length) {
        setItems(
          r.items.map((it) => ({
            part_no: it.part_no ?? "",
            description: it.description ?? "",
            maker: it.maker ?? "",
            qty: it.qty ?? 1,
            unit: it.unit ?? "PCS",
            unit_price: it.unit_price ?? 0,
            amount: (it.qty ?? 1) * (it.unit_price ?? 0),
          }))
        );
      }
      setOcrMsg(
        `추출 완료: ${r.items?.length ?? 0}개 품목${
          r.customer_hint ? ` · Customer 힌트 ${r.customer_hint}` : ""
        }`
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "OCR 추출 실패");
    } finally {
      setOcrBusy(false);
    }
  }

  async function submit() {
    if (customerId === "") return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await createOrder({
        customer_id: customerId,
        vessel_id: vesselId === "" ? null : vesselId,
        quotation_id: quotationId === "" ? null : quotationId,
        rfq_id: rfqId === "" ? null : rfqId,
        po_no: poNo,
        date,
        promised_delivery: promised || null,
        items: cleanItems(items),
      });
      setMsg(`오더 등록 완료: ${r.ord_no}`);
      setPoNo("");
      setPromised("");
      setItems([blankItem()]);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "오더 등록 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="sub-h">신규 오더 등록</div>
      <div className="po-work-note">
        <b>오더 PDF 자동 입력</b>
        <span>
          고객 P/O PDF를 업로드하면 Customer, PO번호, 선박, 납기, 품목을 자동 추출해 아래 폼에 반영합니다.
        </span>
      </div>
      <div className="action-row">
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => uploadOrderPdf(e.target.files?.[0] ?? null)}
          disabled={ocrBusy}
        />
        {ocrBusy ? <span className="hint-inline">AI가 PDF를 분석 중…</span> : null}
        {ocrMsg ? <span className="action-ok">{ocrMsg}</span> : null}
      </div>

      <div className="form-grid">
        <div className="form-field">
          <label>견적서에서 불러오기</label>
          <select
            value={quotationId}
            onChange={(e) => loadQuotation(e.target.value ? Number(e.target.value) : "")}
          >
            <option value="">— 없음 —</option>
            {options.quotations.map((q) => (
              <option key={q.id} value={q.id}>
                {q.qtn_no} · {q.customer} · {q.currency} {money(q.amount)}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label>Customer *</label>
          <select
            value={customerId}
            onChange={(e) => {
              setCustomerId(e.target.value ? Number(e.target.value) : "");
              setVesselId("");
            }}
          >
            {options.customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label>수주일</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="form-field">
          <label>고객 PO No.</label>
          <input value={poNo} onChange={(e) => setPoNo(e.target.value)} />
        </div>
        <div className="form-field">
          <label>선박</label>
          <select
            value={vesselId}
            onChange={(e) => setVesselId(e.target.value ? Number(e.target.value) : "")}
          >
            <option value="">— 없음 —</option>
            {vessels.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label>약속 납기일</label>
          <input
            type="date"
            value={promised}
            onChange={(e) => setPromised(e.target.value)}
          />
        </div>
      </div>

      <div className="form-field" style={{ marginTop: 14 }}>
        <label>연결할 RFQ</label>
        <select value={rfqId} onChange={(e) => setRfqId(e.target.value ? Number(e.target.value) : "")}>
          <option value="">— 연결 안 함 —</option>
          {options.rfqs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.rfq_no} · {r.customer} · {r.vessel || "—"} · {r.status}
            </option>
          ))}
        </select>
      </div>

      <ItemEditor items={items} onChange={setItems} />

      <div className="form-actions">
        <button
          className="btn primary"
          onClick={submit}
          disabled={busy || customerId === ""}
        >
          {busy ? "등록 중…" : "오더 등록"}
        </button>
        {msg ? <span className="action-ok">{msg}</span> : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </>
  );
}

function OrderList({ orders }: { orders: PoWorkOptions["orders"] }) {
  if (orders.length === 0) {
    return <div className="empty">등록된 오더가 없습니다.</div>;
  }
  return (
    <table className="mini wide">
      <thead>
        <tr>
          <th>K-Maris ORD No.</th>
          <th>Customer</th>
          <th>선박</th>
          <th>PO No.</th>
          <th className="num">품목수</th>
          <th>상태</th>
          <th>날짜</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id}>
            <td>{o.ord_no}</td>
            <td>{o.customer}</td>
            <td>{o.vessel || "—"}</td>
            <td>{o.po_no || "—"}</td>
            <td className="num">{o.items.length}</td>
            <td>{o.status}</td>
            <td>{o.date || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function VendorPoWork({
  options,
  selectedOrderId,
  onChanged,
}: {
  options: PoWorkOptions;
  selectedOrderId: number | null;
  onChanged: () => void;
}) {
  const [sub, setSub] = useState("create");

  return (
    <div className="panel action-panel">
      <div className="seg-tabs">
        <button className={sub === "create" ? "on" : ""} onClick={() => setSub("create")}>
          발주서 생성
        </button>
        <button className={sub === "send" ? "on" : ""} onClick={() => setSub("send")}>
          발주서 이메일 발송
        </button>
        <button className={sub === "sent" ? "on" : ""} onClick={() => setSub("sent")}>
          발신 내역
        </button>
      </div>
      {sub === "create" ? (
        <VendorPoCreate
          options={options}
          selectedOrderId={selectedOrderId}
          onChanged={onChanged}
        />
      ) : sub === "send" ? (
        <VendorPoSend options={options} onChanged={onChanged} />
      ) : (
        <VendorPoSent purchaseOrders={options.purchase_orders} />
      )}
    </div>
  );
}

function VendorPoCreate({
  options,
  selectedOrderId,
  onChanged,
}: {
  options: PoWorkOptions;
  selectedOrderId: number | null;
  onChanged: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const defaultOrder = selectedOrderId ?? options.orders[0]?.id ?? "";
  const [orderId, setOrderId] = useState<number | "">(defaultOrder);
  const [vendorId, setVendorId] = useState<number | "">("");
  const [date, setDate] = useState(today);
  const [items, setItems] = useState<PoWorkItem[]>([blankItem()]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (selectedOrderId) setOrderId(selectedOrderId);
  }, [selectedOrderId]);

  const order = options.orders.find((o) => o.id === orderId);

  useEffect(() => {
    if (order) setItems(order.items.length ? order.items.map(normalizeItem) : [blankItem()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  async function submit() {
    if (orderId === "" || vendorId === "") return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await createPurchaseOrder({
        order_id: orderId,
        vendor_id: vendorId,
        date,
        items: cleanItems(items),
      });
      setMsg(`발주서 생성 완료: ${r.po_no}`);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "발주서 생성 실패");
    } finally {
      setBusy(false);
    }
  }

  if (options.orders.length === 0) {
    return <div className="empty">등록된 오더가 없습니다. 먼저 Customer P/O 수신 탭에서 수주를 등록하세요.</div>;
  }

  return (
    <>
      <div className="form-grid">
        <div className="form-field">
          <label>대상 오더 선택</label>
          <select value={orderId} onChange={(e) => setOrderId(Number(e.target.value))}>
            {options.orders.map((o) => (
              <option key={o.id} value={o.id}>
                {o.ord_no} · {o.customer} · {o.status}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label>Vendor 선택</label>
          <select value={vendorId} onChange={(e) => setVendorId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">— 없음 —</option>
            {options.vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label>발주일</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>

      {order ? (
        <div className="action-ctx">
          대상 오더: <b>{order.ord_no}</b> · {order.customer} · {order.vessel || "—"} · 품목 {order.items.length}개
        </div>
      ) : null}

      <ItemEditor items={items} onChange={setItems} />

      <div className="form-actions">
        <button
          className="btn primary"
          onClick={submit}
          disabled={busy || orderId === "" || vendorId === ""}
        >
          {busy ? "생성 중…" : "발주서 생성"}
        </button>
        {msg ? <span className="action-ok">{msg}</span> : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>

      <IssuedPoTable purchaseOrders={options.purchase_orders.filter((p) => p.order_id === orderId)} />
    </>
  );
}

function VendorPoSend({
  options,
  onChanged,
}: {
  options: PoWorkOptions;
  onChanged: () => void;
}) {
  const [poId, setPoId] = useState<number | "">(options.purchase_orders[0]?.id ?? "");
  const [lang, setLang] = useState<"en" | "ko">("en");
  const [notes, setNotes] = useState("");
  const [preview, setPreview] = useState<VendorPoPreview | null>(null);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const po = options.purchase_orders.find((p) => p.id === poId);

  async function makePreview() {
    if (poId === "") return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const p = await previewVendorPo(poId, lang, notes);
      setPreview(p);
      setTo(p.to);
      setSubject(p.subject);
      setBody(p.body);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "미리보기 생성 실패");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (poId === "") return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await sendVendorPo(poId, to, subject, body);
      setMsg(`이메일 발송 완료: ${r.sent_date}`);
      setPreview(null);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "이메일 발송 실패");
    } finally {
      setBusy(false);
    }
  }

  async function downloadPdf() {
    if (poId === "") return;
    const res = await fetch(vendorPoPdfUrl(poId), {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) {
      setErr("PDF 다운로드 실패");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = preview?.pdf_filename ?? `${po?.po_no ?? "PurchaseOrder"}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (options.purchase_orders.length === 0) {
    return <div className="empty">발행된 발주서가 없습니다. 먼저 발주서 생성 탭에서 발주서를 생성하세요.</div>;
  }

  return (
    <>
      <div className="form-grid">
        <div className="form-field">
          <label>발송할 발주서 선택</label>
          <select
            value={poId}
            onChange={(e) => {
              setPoId(Number(e.target.value));
              setPreview(null);
            }}
          >
            {options.purchase_orders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.po_no} · {p.vendor} · {p.status}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label>이메일 언어</label>
          <select value={lang} onChange={(e) => setLang(e.target.value as "en" | "ko")}>
            <option value="en">English (영문)</option>
            <option value="ko">Korean (국문)</option>
          </select>
        </div>
      </div>

      {po ? (
        <div className="action-ctx">
          발주서: <b>{po.po_no}</b> · {po.vendor} · 오더 {po.ord_no} · 품목 {po.items.length}개
        </div>
      ) : null}

      <div className="form-field">
        <label>Vendor에게 전달할 메모</label>
        <textarea
          className="po-textarea small"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      {!preview ? (
        <div className="form-actions">
          <button className="btn" onClick={makePreview} disabled={busy || poId === ""}>
            {busy ? "생성 중…" : "이메일 미리보기"}
          </button>
          {err ? <span className="action-err">{err}</span> : null}
        </div>
      ) : (
        <>
          <div className="po-work-note">
            <b>이메일 미리보기</b>
            <span>아래 이메일을 검토·수정 후 발송하세요. 실제 발송에 성공해야 발신 내역에 기록됩니다.</span>
          </div>
          <div className="form-grid">
            <div className="form-field">
              <label>수신자 이메일</label>
              <input value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="form-field">
              <label>제목</label>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
          </div>
          <div className="form-field">
            <label>본문</label>
            <textarea
              className="po-textarea"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          {!preview.smtp_configured ? (
            <div className="action-err">
              SMTP 미설정: SMTP_USER / SMTP_PASSWORD가 없으면 실제 발송할 수 없습니다.
            </div>
          ) : null}
          <div className="form-actions">
            <button className="btn" onClick={downloadPdf} disabled={poId === ""}>
              발주서 PDF 다운로드
            </button>
            <button
              className="btn primary"
              onClick={send}
              disabled={busy || !to || !preview.smtp_configured}
            >
              {busy ? "발송 중…" : "이메일 발송"}
            </button>
            <button className="btn" onClick={() => setPreview(null)}>
              취소
            </button>
            {msg ? <span className="action-ok">{msg}</span> : null}
            {err ? <span className="action-err">{err}</span> : null}
          </div>
        </>
      )}
    </>
  );
}

function VendorPoSent({
  purchaseOrders,
}: {
  purchaseOrders: PoWorkOptions["purchase_orders"];
}) {
  const sent = purchaseOrders.filter((p) => p.sent);
  if (sent.length === 0) {
    return <div className="empty">아직 이메일로 발송된 발주서가 없습니다.</div>;
  }
  return (
    <>
      <div className="hint-inline">실제로 이메일이 발송된 발주서만 표시됩니다.</div>
      <table className="mini wide" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th>PO No.</th>
            <th>K-Maris ORD No.</th>
            <th>Vendor</th>
            <th>수신자 이메일</th>
            <th>발송일</th>
            <th>상태</th>
            <th className="num">품목수</th>
          </tr>
        </thead>
        <tbody>
          {sent.map((p) => (
            <tr key={p.id}>
              <td>{p.po_no}</td>
              <td>{p.ord_no}</td>
              <td>{p.vendor}</td>
              <td>{p.vendor_email || "—"}</td>
              <td>{p.sent_date || "—"}</td>
              <td>{p.status}</td>
              <td className="num">{p.items.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function IssuedPoTable({
  purchaseOrders,
}: {
  purchaseOrders: PoWorkOptions["purchase_orders"];
}) {
  if (purchaseOrders.length === 0) return null;
  return (
    <>
      <div className="sub-h" style={{ marginTop: 16 }}>
        발행된 발주서
      </div>
      <table className="mini wide">
        <thead>
          <tr>
            <th>PO No.</th>
            <th>Vendor</th>
            <th>발주일</th>
            <th>상태</th>
            <th className="num">품목수</th>
          </tr>
        </thead>
        <tbody>
          {purchaseOrders.map((p) => (
            <tr key={p.id}>
              <td>{p.po_no}</td>
              <td>{p.vendor}</td>
              <td>{p.date || "—"}</td>
              <td>{p.status}</td>
              <td className="num">{p.items.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function ItemEditor({
  items,
  onChange,
}: {
  items: PoWorkItem[];
  onChange: (items: PoWorkItem[]) => void;
}) {
  function patch(i: number, key: keyof PoWorkItem, value: string) {
    onChange(
      items.map((it, idx) => {
        if (idx !== i) return it;
        if (key === "qty" || key === "unit_price" || key === "amount") {
          return { ...it, [key]: value === "" ? null : Number(value) };
        }
        return { ...it, [key]: value };
      })
    );
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div className="sub-h">품목 리스트</div>
      <div className="table-wrap">
        <table className="mini wide">
          <thead>
            <tr>
              <th>Part No.</th>
              <th>품명</th>
              <th>Maker</th>
              <th className="num">수량</th>
              <th>Unit</th>
              <th className="num">단가</th>
              <th className="num">금액</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i}>
                <td>
                  <input value={it.part_no} onChange={(e) => patch(i, "part_no", e.target.value)} />
                </td>
                <td>
                  <input value={it.description} onChange={(e) => patch(i, "description", e.target.value)} />
                </td>
                <td>
                  <input value={it.maker ?? ""} onChange={(e) => patch(i, "maker", e.target.value)} />
                </td>
                <td>
                  <input
                    className="num"
                    value={it.qty ?? ""}
                    onChange={(e) => patch(i, "qty", e.target.value)}
                  />
                </td>
                <td>
                  <input value={it.unit} onChange={(e) => patch(i, "unit", e.target.value)} />
                </td>
                <td>
                  <input
                    className="num"
                    value={it.unit_price ?? ""}
                    onChange={(e) => patch(i, "unit_price", e.target.value)}
                  />
                </td>
                <td>
                  <input
                    className="num"
                    value={it.amount ?? ""}
                    onChange={(e) => patch(i, "amount", e.target.value)}
                  />
                </td>
                <td>
                  <button
                    className="row-del"
                    onClick={() => onChange(items.filter((_, idx) => idx !== i))}
                    disabled={items.length === 1}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn" style={{ marginTop: 10 }} onClick={() => onChange([...items, blankItem()])}>
        품목 추가
      </button>
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

function blankItem(): PoWorkItem {
  return {
    part_no: "",
    description: "",
    maker: "",
    qty: 1,
    unit: "PCS",
    unit_price: 0,
    amount: 0,
  };
}

function normalizeItem(it: Partial<PoWorkItem>): PoWorkItem {
  const qty = Number(it.qty ?? 1) || 1;
  const unitPrice = it.unit_price ?? 0;
  return {
    part_no: it.part_no ?? "",
    description: it.description ?? "",
    maker: it.maker ?? "",
    qty,
    unit: it.unit ?? "PCS",
    unit_price: unitPrice,
    amount: it.amount ?? qty * Number(unitPrice ?? 0),
  };
}

function cleanItems(items: PoWorkItem[]): PoWorkItem[] {
  return items
    .map(normalizeItem)
    .filter((it) => it.part_no.trim() || it.description.trim());
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
