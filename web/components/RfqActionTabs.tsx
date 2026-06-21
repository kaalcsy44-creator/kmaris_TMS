"use client";

import { useEffect, useState } from "react";
import {
  fetchVendors,
  fetchRfqDetail,
  createVendorRfq,
  createVendorQuote,
  createCustomerQuote,
} from "@/lib/api";
import type { VendorOption, RfqDetail as RfqDetailT } from "@/lib/types";
import NewRfqForm from "./screens/NewRfqForm";

// 원본 rfq_quotation.py 하단의 작업 segmented control(4탭)을 복원.
const TABS = [
  { key: "new", label: "1. Customer RFQ 수신" },
  { key: "vrfq", label: "2. Vendor RFQ 발신" },
  { key: "vquote", label: "3. Vendor Quot. 수신" },
  { key: "cquote", label: "4. Customer Quot. 발신" },
];

export default function RfqActionTabs({
  rfqId,
  rfqNo,
  onChanged,
}: {
  rfqId: number | null;
  rfqNo?: string;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState("new");
  const [vendors, setVendors] = useState<VendorOption[]>([]);
  const [vendorRfqs, setVendorRfqs] = useState<RfqDetailT["vendor_rfqs"]>([]);

  useEffect(() => {
    fetchVendors().then(setVendors).catch(() => setVendors([]));
  }, []);

  function reloadVrfqs() {
    if (rfqId === null) {
      setVendorRfqs([]);
      return;
    }
    fetchRfqDetail(rfqId)
      .then((d) => setVendorRfqs(d.vendor_rfqs))
      .catch(() => setVendorRfqs([]));
  }

  useEffect(() => {
    reloadVrfqs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfqId]);

  const needsRfq = tab !== "new";
  const after = () => {
    onChanged();
    reloadVrfqs();
  };

  return (
    <div className="action-tabs">
      <div className="page-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? "on" : ""}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {needsRfq && rfqNo ? (
        <div className="action-ctx">
          대상 RFQ: <b>{rfqNo}</b>
        </div>
      ) : null}

      {tab === "new" ? (
        <NewRfqForm onCreated={() => onChanged()} />
      ) : rfqId === null ? (
        <div className="panel">
          <div className="empty">위 표에서 RFQ를 먼저 선택하세요.</div>
        </div>
      ) : (
        <div className="panel action-panel">
          {tab === "vrfq" && (
            <VendorRfqAction rfqId={rfqId} vendors={vendors} onDone={after} />
          )}
          {tab === "vquote" && (
            <VendorQuoteAction
              rfqId={rfqId}
              vendorRfqs={vendorRfqs}
              onDone={after}
            />
          )}
          {tab === "cquote" && (
            <CustomerQuoteAction rfqId={rfqId} onDone={onChanged} />
          )}
        </div>
      )}
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

function VendorQuoteAction({
  rfqId,
  vendorRfqs,
  onDone,
}: {
  rfqId: number;
  vendorRfqs: RfqDetailT["vendor_rfqs"];
  onDone: () => void;
}) {
  const [vrfqId, setVrfqId] = useState<number | "">("");
  const [no, setNo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const disabled = vendorRfqs.length === 0;

  async function submit() {
    if (vrfqId === "" || !no.trim() || amount === "") return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await createVendorQuote(rfqId, vrfqId, no.trim(), Number(amount));
      setMsg(`수신 등록 완료 — ${r.vendor_quote_no}`);
      setNo("");
      setAmount("");
      setVrfqId("");
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "등록 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="action-row">
      <span className="action-name">Vendor Quote 수신</span>
      {disabled ? (
        <span className="hint-inline">먼저 Vendor RFQ를 발신하세요.</span>
      ) : (
        <>
          <select
            value={vrfqId}
            onChange={(e) =>
              setVrfqId(e.target.value === "" ? "" : Number(e.target.value))
            }
          >
            <option value="">Vendor RFQ 선택…</option>
            {vendorRfqs.map((v) => (
              <option key={v.id} value={v.id}>
                {v.vrfq_no} · {v.vendor}
              </option>
            ))}
          </select>
          <input
            className="action-input"
            placeholder="Vendor 견적번호"
            value={no}
            onChange={(e) => setNo(e.target.value)}
          />
          <input
            className="action-input num"
            placeholder="총액(USD)"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
          />
          <button
            className="btn primary"
            onClick={submit}
            disabled={busy || vrfqId === "" || !no.trim() || amount === ""}
          >
            {busy ? "등록 중…" : "등록"}
          </button>
        </>
      )}
      {msg ? <span className="action-ok">{msg}</span> : null}
      {err ? <span className="action-err">{err}</span> : null}
    </div>
  );
}

function CustomerQuoteAction({
  rfqId,
  onDone,
}: {
  rfqId: number;
  onDone: () => void;
}) {
  const [currency, setCurrency] = useState("USD");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (amount === "") return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await createCustomerQuote(rfqId, currency, Number(amount));
      setMsg(`발신 완료 — ${r.qtn_no}`);
      setAmount("");
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "발신 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="action-row">
      <span className="action-name">Customer Quote 발신</span>
      <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
        <option>USD</option>
        <option>EUR</option>
        <option>KRW</option>
        <option>SGD</option>
      </select>
      <input
        className="action-input num"
        placeholder="견적 총액"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        inputMode="decimal"
      />
      <button
        className="btn primary"
        onClick={submit}
        disabled={busy || amount === ""}
      >
        {busy ? "발신 중…" : "발신"}
      </button>
      {msg ? <span className="action-ok">{msg}</span> : null}
      {err ? <span className="action-err">{err}</span> : null}
    </div>
  );
}
