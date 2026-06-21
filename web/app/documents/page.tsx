"use client";

import { useEffect, useMemo, useState } from "react";
import {
  documentDownloadUrl,
  fetchDocumentDetail,
  fetchDocumentsOverview,
  saveCommercialInvoice,
  savePackingList,
  saveShippingAdvice,
  saveTaxInvoice,
  sendShippingAdvice,
  updateDocumentMilestone,
} from "@/lib/api";
import { getToken } from "@/lib/auth";
import type { DocumentDetail, DocumentWorkItem } from "@/lib/types";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import AppShell, { SectionHead } from "@/components/AppShell";

const today = () => new Date().toISOString().slice(0, 10);

export default function DocumentsPage() {
  return (
    <AppShell active="documents">
      <DocumentsOverview />
    </AppShell>
  );
}

function Cell({ main }: { main: string }) {
  return (
    <td className="cell">
      <div className="m">{main ? main : <span className="dash">-</span>}</div>
    </td>
  );
}

function DocPill({ has, no, label }: { has: boolean; no: string; label: string }) {
  return (
    <td className="cell">
      <span className={`doc-pill${has ? " on" : ""}`} title={no || `${label} 미생성`}>
        {has ? no || label : `- ${label}`}
      </span>
    </td>
  );
}

function DocumentsOverview() {
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const {
    data: overview,
    error,
    loading,
    refresh,
  } = useCachedData("documents:overview", fetchDocumentsOverview);
  const rows = overview?.rows ?? [];

  useEffect(() => {
    if (!overview) return;
    setSelectedId((prev) => prev ?? overview.rows[0]?.id ?? null);
  }, [overview]);

  function load() {
    invalidateCache("dashboard");
    return refresh();
  }

  const selected = rows.find((r) => r.id === selectedId) ?? null;

  return (
    <>
      <SectionHead title="문서 (Documents)" sub="오더별 CI · PL · SA · Tax 생성 및 발송" />

      <div className="toolbar">
        <button className="btn" onClick={load}>
          새로고침
        </button>
        <span className="hint-inline">
          행을 선택하면 아래에서 Commercial Invoice, Packing List, Shipping Advice, Tax Invoice Data를 생성합니다.
        </span>
      </div>

      {loading && rows.length === 0 ? (
        <div className="state">불러오는 중...</div>
      ) : error && rows.length === 0 ? (
        <div className="state error">API 오류: {error.message}</div>
      ) : rows.length === 0 ? (
        <div className="state">등록된 오더가 없습니다.</div>
      ) : (
        <div className="table-wrap">
          <table className="rfq">
            <thead>
              <tr>
                <th style={{ width: 44 }}></th>
                <th>오더 No.</th>
                <th>Customer</th>
                <th>선박</th>
                <th>PO No.</th>
                <th>Commercial Invoice</th>
                <th>Packing List</th>
                <th>Shipping Advice</th>
                <th>Tax Invoice</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const sel = r.id === selectedId;
                return (
                  <tr key={r.id} className={sel ? "sel" : ""} onClick={() => setSelectedId(sel ? null : r.id)}>
                    <td className="select-cell">
                      <input
                        type="checkbox"
                        checked={sel}
                        onChange={() => setSelectedId(sel ? null : r.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <Cell main={r.ord_no} />
                    <Cell main={r.customer} />
                    <Cell main={r.vessel} />
                    <Cell main={r.po_no} />
                    <DocPill has={r.has_ci} no={r.ci_no} label="CI" />
                    <DocPill has={r.has_pl} no={r.pl_no} label="PL" />
                    <DocPill has={r.has_sa} no={r.sa_no} label="SA" />
                    <DocPill has={r.has_tax} no={r.tax_no} label="Tax" />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <DocumentWorkPanel orderId={selectedId} ordNo={selected?.ord_no ?? ""} onChanged={load} />
    </>
  );
}

function DocumentWorkPanel({
  orderId,
  ordNo,
  onChanged,
}: {
  orderId: number | null;
  ordNo: string;
  onChanged: () => void;
}) {
  const [data, setData] = useState<DocumentDetail | null>(null);
  const [tab, setTab] = useState<"ci" | "pl" | "sa" | "tax">("ci");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    if (orderId === null) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    fetchDocumentDetail(orderId)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "오류"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [orderId]);

  function afterChange() {
    load();
    onChanged();
  }

  if (orderId === null) {
    return (
      <div className="action-tabs">
        <h3>선택한 오더 상세</h3>
        <p className="muted">위 목록에서 체크박스를 선택하면 상세 작업이 표시됩니다.</p>
      </div>
    );
  }

  return (
    <div className="action-tabs">
      <div className="po-work-note">
        <b>대상 오더: {ordNo}</b>
        <span>{data ? `${data.order.customer} · ${data.order.vessel || "-"}` : "상세 로딩 중"}</span>
      </div>

      {error ? <div className="state error">API 오류: {error}</div> : null}
      {loading && !data ? <div className="state">상세 불러오는 중...</div> : null}

      {data ? (
        <>
          <OrderMilestones data={data} onChanged={afterChange} />
          <DocumentSummary data={data} />

          <div className="page-tabs">
            {[
              ["ci", "Commercial Invoice"],
              ["pl", "Packing List"],
              ["sa", "Shipping Advice"],
              ["tax", "Tax Invoice Data"],
            ].map(([key, label]) => (
              <button key={key} className={tab === key ? "on" : ""} onClick={() => setTab(key as typeof tab)}>
                {label}
              </button>
            ))}
          </div>

          {tab === "ci" && <CommercialInvoiceTab key={`ci-${data.order.id}-${data.ci?.id ?? 0}`} data={data} onChanged={afterChange} />}
          {tab === "pl" && <PackingListTab key={`pl-${data.order.id}-${data.pl?.id ?? 0}`} data={data} onChanged={afterChange} />}
          {tab === "sa" && <ShippingAdviceTab key={`sa-${data.order.id}-${data.sa?.id ?? 0}`} data={data} onChanged={afterChange} />}
          {tab === "tax" && <TaxInvoiceTab key={`tax-${data.order.id}-${data.tax?.id ?? 0}`} data={data} onChanged={afterChange} />}
        </>
      ) : null}
    </div>
  );
}

function DocumentSummary({ data }: { data: DocumentDetail }) {
  return (
    <div className="doc-summary">
      <KV k="Customer" v={data.order.customer} />
      <KV k="선박" v={data.order.vessel || "-"} />
      <KV k="Customer PO No." v={data.order.po_no || "-"} />
      <KV k="Status" v={data.order.status} />
      <KV k="CI" v={data.ci?.ci_no || "미생성"} />
      <KV k="PL" v={data.pl?.pl_no || "미생성"} />
      <KV k="SA" v={data.sa?.sa_no || "미생성"} />
      <KV k="Tax" v={data.tax?.tax_no || "미생성"} />
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="kv">
      <span>{k}</span>
      <b>{v}</b>
    </div>
  );
}

function OrderMilestones({ data, onChanged }: { data: DocumentDetail; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);

  async function toggle(field: "consignee_confirmed_date" | "vendor_docs_sent_date", value: boolean) {
    setBusy(true);
    try {
      await updateDocumentMilestone(data.order.id, field, value);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="milestone-row">
      <button
        className="btn"
        disabled={busy}
        onClick={() => toggle("consignee_confirmed_date", !data.order.consignee_confirmed_date)}
      >
        Customer 확인 {data.order.consignee_confirmed_date || "미완료"}
      </button>
      <button
        className="btn"
        disabled={busy}
        onClick={() => toggle("vendor_docs_sent_date", !data.order.vendor_docs_sent_date)}
      >
        Vendor 서류 확인 {data.order.vendor_docs_sent_date || "미완료"}
      </button>
    </div>
  );
}

function CommercialInvoiceTab({ data, onChanged }: { data: DocumentDetail; onChanged: () => void }) {
  const [date, setDate] = useState(data.ci?.date || today());
  const [currency, setCurrency] = useState(data.ci?.currency || "USD");
  const [vatRate, setVatRate] = useState(data.ci?.vat_rate ?? 0);
  const [items, setItems] = useState<DocumentWorkItem[]>(normalizeItems(data.ci?.items || data.order.items));
  const [shipping, setShipping] = useState<Record<string, string>>({
    port_loading: "Busan, Korea",
    port_discharge: "",
    carrier: "TBD",
    bl_awb_no: "TBD",
    etd: "",
    eta: "",
    shipping_marks: `K-MARIS / ${data.order.vessel || ""} / ${data.order.po_no || ""}`,
    ...(data.ci?.shipping || {}),
  });
  const [busy, setBusy] = useState(false);
  const total = useMemo(() => items.reduce((sum, i) => sum + num(i.amount), 0), [items]);

  async function save() {
    setBusy(true);
    try {
      await saveCommercialInvoice(data.order.id, { date, currency, vat_rate: vatRate, items, shipping });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="doc-tab">
      <div className="form-grid">
        <Field label="CI Date" value={date} onChange={setDate} type="date" />
        <Field label="Currency" value={currency} onChange={setCurrency} />
        <Field label="VAT Rate" value={String(vatRate)} onChange={(v) => setVatRate(num(v))} type="number" />
      </div>
      <ShippingFields shipping={shipping} setShipping={setShipping} />
      <ItemEditor items={items} setItems={setItems} packing={false} />
      <MissingWarning missing={data.ci?.missing || []} />
      <div className="form-actions">
        <button className="btn primary" disabled={busy} onClick={save}>
          CI 저장
        </button>
        <DownloadButton orderId={data.order.id} kind="ci/pdf" disabled={!data.ci} label="CI PDF 다운로드" />
        <span className="hint-inline">합계 {currency} {total.toLocaleString()}</span>
      </div>
    </div>
  );
}

function PackingListTab({ data, onChanged }: { data: DocumentDetail; onChanged: () => void }) {
  const [date, setDate] = useState(data.pl?.date || today());
  const seed = data.pl?.items || data.ci?.items || data.order.items;
  const [items, setItems] = useState<DocumentWorkItem[]>(normalizeItems(seed, true));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await savePackingList(data.order.id, { date, items });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  if (!data.ci) {
    return <div className="state">먼저 Commercial Invoice를 생성하세요.</div>;
  }

  return (
    <div className="doc-tab">
      <div className="form-grid">
        <Field label="PL Date" value={date} onChange={setDate} type="date" />
      </div>
      <ItemEditor items={items} setItems={setItems} packing />
      <MissingWarning missing={data.pl?.missing || []} />
      <div className="form-actions">
        <button className="btn primary" disabled={busy} onClick={save}>
          PL 저장
        </button>
        <DownloadButton orderId={data.order.id} kind="pl/pdf" disabled={!data.pl} label="PL PDF 다운로드" />
      </div>
    </div>
  );
}

function ShippingAdviceTab({ data, onChanged }: { data: DocumentDetail; onChanged: () => void }) {
  const [date, setDate] = useState(data.sa?.date || today());
  const [shipping, setShipping] = useState<Record<string, string>>({
    port_loading: data.ci?.shipping.port_loading || "Busan, Korea",
    port_discharge: data.ci?.shipping.port_discharge || "",
    carrier: data.ci?.shipping.carrier || "TBD",
    bl_awb_no: data.ci?.shipping.bl_awb_no || "TBD",
    etd: data.ci?.shipping.etd || "",
    eta: data.ci?.shipping.eta || "",
    shipping_marks: data.ci?.shipping.shipping_marks || `K-MARIS / ${data.order.vessel || ""} / ${data.order.po_no || ""}`,
    ...(data.sa?.shipping || {}),
  });
  const [to, setTo] = useState(data.order.customer_email || "");
  const [subject, setSubject] = useState(data.sa?.sa_no ? `[K-MARIS] Shipping Advice ${data.sa.sa_no}` : "");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [ackMissing, setAckMissing] = useState(false);

  // SA 는 CI 기준으로 발송되므로 CI 가 오더와 일치하는지 발송 전 검증한다.
  const ciMissing = data.ci?.missing || [];

  async function save() {
    setBusy(true);
    try {
      await saveShippingAdvice(data.order.id, { date, shipping });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    setBusy(true);
    try {
      await sendShippingAdvice(data.order.id, to, subject, body);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="doc-tab">
      <div className="form-grid">
        <Field label="SA Date" value={date} onChange={setDate} type="date" />
      </div>
      <ShippingFields shipping={shipping} setShipping={setShipping} />
      {data.ci ? (
        <MissingWarning missing={ciMissing} />
      ) : (
        <div className="alert-warn">CI가 아직 없습니다. SA는 CI 품목 기준으로 발송됩니다 — 먼저 CI를 생성하세요.</div>
      )}
      <div className="form-grid">
        <Field label="수신자 이메일" value={to} onChange={setTo} />
        <Field label="제목" value={subject} onChange={setSubject} />
      </div>
      <textarea
        className="po-textarea small"
        placeholder="본문을 비워두면 기본 Shipping Advice 메일 본문으로 발송합니다."
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      {ciMissing.length > 0 ? (
        <label className="check-inline" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={ackMissing} onChange={(e) => setAckMissing(e.target.checked)} />
          누락/수량부족 품목 {ciMissing.length}건을 확인했으며 그대로 발송합니다.
        </label>
      ) : null}
      <div className="form-actions">
        <button className="btn primary" disabled={busy} onClick={save}>
          SA 저장
        </button>
        <DownloadButton orderId={data.order.id} kind="sa/pdf" disabled={!data.sa} label="SA PDF 다운로드" />
        <button
          className="btn"
          disabled={busy || !data.sa || !to.trim() || (ciMissing.length > 0 && !ackMissing)}
          onClick={send}
        >
          SA 이메일 발송
        </button>
        <span className="hint-inline">
          SMTP {data.smtp_configured ? "설정됨" : "미설정"} {data.sa?.sent_date ? `· 발송 ${data.sa.sent_date}` : ""}
        </span>
      </div>
    </div>
  );
}

function TaxInvoiceTab({ data, onChanged }: { data: DocumentDetail; onChanged: () => void }) {
  const [date, setDate] = useState(data.tax?.date || today());
  const [supplyType, setSupplyType] = useState("Export / Zero-rated");
  const [buyerNo, setBuyerNo] = useState(data.order.customer_tax_id || "");
  const [vatRate, setVatRate] = useState(0);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await saveTaxInvoice(data.order.id, {
        date,
        supply_type: supplyType,
        buyer_business_no: buyerNo,
        vat_rate: vatRate,
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  if (!data.ci) {
    return <div className="state">먼저 Commercial Invoice를 생성하세요.</div>;
  }

  return (
    <div className="doc-tab">
      <div className="form-grid">
        <Field label="Issue Date" value={date} onChange={setDate} type="date" />
        <Field label="Supply Type" value={supplyType} onChange={setSupplyType} />
        <Field label="Buyer Business No." value={buyerNo} onChange={setBuyerNo} />
        <Field label="VAT Rate" value={String(vatRate)} onChange={(v) => setVatRate(num(v))} type="number" />
      </div>
      <div className="form-actions">
        <button className="btn primary" disabled={busy} onClick={save}>
          Tax Invoice Data 생성 + AR 등록
        </button>
        <DownloadButton orderId={data.order.id} kind="tax/xlsx" disabled={!data.tax} label="Tax XLSX 다운로드" />
      </div>
    </div>
  );
}

function ShippingFields({
  shipping,
  setShipping,
}: {
  shipping: Record<string, string>;
  setShipping: (v: Record<string, string>) => void;
}) {
  const fields = [
    ["port_loading", "Port of Loading"],
    ["port_discharge", "Port of Discharge"],
    ["carrier", "Carrier"],
    ["bl_awb_no", "B/L or AWB No."],
    ["etd", "ETD"],
    ["eta", "ETA"],
    ["shipping_marks", "Shipping Marks"],
  ];
  return (
    <div className="form-grid">
      {fields.map(([key, label]) => (
        <Field
          key={key}
          label={label}
          value={shipping[key] || ""}
          onChange={(v) => setShipping({ ...shipping, [key]: v })}
        />
      ))}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="form-field">
      <span>{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function ItemEditor({
  items,
  setItems,
  packing,
}: {
  items: DocumentWorkItem[];
  setItems: (items: DocumentWorkItem[]) => void;
  packing: boolean;
}) {
  function patch(i: number, key: keyof DocumentWorkItem, value: string) {
    const next = [...items];
    const item = { ...next[i], [key]: ["qty", "unit_price", "amount"].includes(String(key)) ? num(value) : value };
    if (!packing && (key === "qty" || key === "unit_price")) {
      item.amount = num(item.qty) * num(item.unit_price);
    }
    next[i] = item;
    setItems(next);
  }

  return (
    <div className="table-wrap">
      <table className="mini wide">
        <thead>
          <tr>
            <th>Part No.</th>
            <th>Description</th>
            <th>Maker</th>
            <th className="num">Qty</th>
            <th>Unit</th>
            {packing ? (
              <>
                <th>Package</th>
                <th>N.W.</th>
                <th>G.W.</th>
                <th>Dimension</th>
              </>
            ) : (
              <>
                <th className="num">Unit Price</th>
                <th className="num">Amount</th>
                <th>HS Code</th>
              </>
            )}
            <th>Remark</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <tr key={i}>
              <td><input value={item.part_no || ""} onChange={(e) => patch(i, "part_no", e.target.value)} /></td>
              <td><input value={item.description || ""} onChange={(e) => patch(i, "description", e.target.value)} /></td>
              <td><input value={item.maker || ""} onChange={(e) => patch(i, "maker", e.target.value)} /></td>
              <td><input className="num" value={item.qty ?? 0} onChange={(e) => patch(i, "qty", e.target.value)} /></td>
              <td><input value={item.unit || "PCS"} onChange={(e) => patch(i, "unit", e.target.value)} /></td>
              {packing ? (
                <>
                  <td><input value={item.package || ""} onChange={(e) => patch(i, "package", e.target.value)} /></td>
                  <td><input value={String(item.net_weight || "")} onChange={(e) => patch(i, "net_weight", e.target.value)} /></td>
                  <td><input value={String(item.gross_weight || "")} onChange={(e) => patch(i, "gross_weight", e.target.value)} /></td>
                  <td><input value={item.dimension || ""} onChange={(e) => patch(i, "dimension", e.target.value)} /></td>
                </>
              ) : (
                <>
                  <td><input className="num" value={item.unit_price ?? 0} onChange={(e) => patch(i, "unit_price", e.target.value)} /></td>
                  <td><input className="num" value={item.amount ?? 0} onChange={(e) => patch(i, "amount", e.target.value)} /></td>
                  <td><input value={item.hs_code || ""} onChange={(e) => patch(i, "hs_code", e.target.value)} /></td>
                </>
              )}
              <td><input value={item.remark || ""} onChange={(e) => patch(i, "remark", e.target.value)} /></td>
              <td>
                <button className="row-del" onClick={() => setItems(items.filter((_, idx) => idx !== i))}>×</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn" style={{ marginTop: 10 }} onClick={() => setItems([...items, blankItem(packing)])}>
        행 추가
      </button>
    </div>
  );
}

function MissingWarning({
  missing,
}: {
  missing: { part_no: string; description: string; order_qty: number; doc_qty: number }[];
}) {
  if (missing.length === 0) return <div className="alert-ok">문서 품목이 오더와 일치합니다.</div>;
  return (
    <div className="state error">
      누락 또는 수량 부족 품목 {missing.length}건:{" "}
      {missing.map((m) => `${m.part_no || m.description} (${m.doc_qty}/${m.order_qty})`).join(", ")}
    </div>
  );
}

function DownloadButton({
  orderId,
  kind,
  label,
  disabled,
}: {
  orderId: number;
  kind: "ci/pdf" | "pl/pdf" | "sa/pdf" | "tax/xlsx";
  label: string;
  disabled: boolean;
}) {
  async function download() {
    const res = await fetch(documentDownloadUrl(orderId, kind), {
      headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
    });
    if (!res.ok) throw new Error("download failed");
    const blob = await res.blob();
    const disposition = res.headers.get("content-disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match?.[1] || `${kind.replace("/", "_")}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <button className="btn" disabled={disabled} onClick={download}>
      {label}
    </button>
  );
}

function normalizeItems(items: DocumentWorkItem[], packing = false): DocumentWorkItem[] {
  return (items || []).map((item, idx) => ({
    item_no: item.item_no || idx + 1,
    part_no: item.part_no || "",
    description: item.description || "",
    maker: item.maker || "",
    origin: item.origin || "",
    qty: num(item.qty || 1),
    unit: item.unit || "PCS",
    unit_price: packing ? item.unit_price ?? null : num(item.unit_price || 0),
    amount: packing ? item.amount ?? null : num(item.amount || num(item.qty || 1) * num(item.unit_price || 0)),
    hs_code: item.hs_code || "",
    remark: item.remark || "",
    package: item.package || "",
    net_weight: item.net_weight || "",
    gross_weight: item.gross_weight || "",
    dimension: item.dimension || "",
  }));
}

function blankItem(packing: boolean): DocumentWorkItem {
  return normalizeItems([{ part_no: "", description: "", qty: 1, unit: "PCS" }], packing)[0];
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
