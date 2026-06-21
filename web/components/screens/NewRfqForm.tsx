"use client";

import { useEffect, useState } from "react";
import { fetchCustomers, fetchSettingsVessels, createRfq } from "@/lib/api";
import type { CustomerOption, SettingsVessel } from "@/lib/types";

type ItemRow = { part_no: string; description: string; qty: string };

export default function NewRfqForm({
  onCreated,
  onCancel,
}: {
  onCreated?: (rfqNo: string) => void;
  onCancel?: () => void;
}) {
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [vessels, setVessels] = useState<SettingsVessel[]>([]);
  const [customerId, setCustomerId] = useState<number | "">("");
  const [vesselId, setVesselId] = useState<number | "">("");
  const [custRfqNo, setCustRfqNo] = useState("");
  const [items, setItems] = useState<ItemRow[]>([
    { part_no: "", description: "", qty: "1" },
  ]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetchCustomers().then(setCustomers).catch(() => setCustomers([]));
    fetchSettingsVessels().then(setVessels).catch(() => setVessels([]));
  }, []);

  function setItem(i: number, key: keyof ItemRow, val: string) {
    setItems((prev) =>
      prev.map((it, idx) => (idx === i ? { ...it, [key]: val } : it))
    );
  }
  function addItem() {
    setItems((prev) => [...prev, { part_no: "", description: "", qty: "1" }]);
  }
  function removeItem(i: number) {
    setItems((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function submit() {
    if (customerId === "") {
      setErr("Customer를 선택하세요.");
      return;
    }
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await createRfq({
        customer_id: customerId,
        vessel_id: vesselId === "" ? undefined : vesselId,
        customer_rfq_no: custRfqNo,
        items: items
          .filter((it) => it.part_no.trim() || it.description.trim())
          .map((it) => ({
            part_no: it.part_no,
            description: it.description,
            qty: Number(it.qty) || 1,
          })),
      });
      setMsg(`등록 완료 — ${r.rfq_no}`);
      setCustomerId("");
      setVesselId("");
      setCustRfqNo("");
      setItems([{ part_no: "", description: "", qty: "1" }]);
      onCreated?.(r.rfq_no);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "등록 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel form-panel">
      <div className="form-grid">
        <Field label="Customer *">
          <select
            value={customerId}
            onChange={(e) =>
              setCustomerId(e.target.value === "" ? "" : Number(e.target.value))
            }
          >
            <option value="">선택…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="선박">
          <select
            value={vesselId}
            onChange={(e) =>
              setVesselId(e.target.value === "" ? "" : Number(e.target.value))
            }
          >
            <option value="">선택…</option>
            {vessels.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="고객 RFQ No.">
          <input
            value={custRfqNo}
            onChange={(e) => setCustRfqNo(e.target.value)}
            placeholder="고객사 고유 번호(선택)"
          />
        </Field>
      </div>

      <div className="sub-h" style={{ marginTop: 18 }}>
        품목
      </div>
      <table className="mini wide">
        <thead>
          <tr>
            <th style={{ width: 160 }}>Part No.</th>
            <th>품명</th>
            <th style={{ width: 90 }}>수량</th>
            <th style={{ width: 50 }}></th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i}>
              <td>
                <input
                  value={it.part_no}
                  onChange={(e) => setItem(i, "part_no", e.target.value)}
                />
              </td>
              <td>
                <input
                  value={it.description}
                  onChange={(e) => setItem(i, "description", e.target.value)}
                />
              </td>
              <td>
                <input
                  className="num"
                  value={it.qty}
                  onChange={(e) => setItem(i, "qty", e.target.value)}
                  inputMode="decimal"
                />
              </td>
              <td>
                <button
                  className="row-del"
                  onClick={() => removeItem(i)}
                  disabled={items.length === 1}
                  title="삭제"
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn" onClick={addItem} style={{ marginTop: 8 }}>
        + 품목 추가
      </button>

      <div className="form-actions">
        {onCancel ? (
          <button className="btn" onClick={onCancel}>
            취소
          </button>
        ) : null}
        <button
          className="btn primary"
          onClick={submit}
          disabled={busy || customerId === ""}
        >
          {busy ? "등록 중…" : "RFQ 등록"}
        </button>
        {msg ? <span className="action-ok">{msg}</span> : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="form-field">
      <label>{label}</label>
      {children}
    </div>
  );
}
