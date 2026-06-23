"use client";

import { useEffect, useState } from "react";
import {
  fetchCustomers,
  fetchSettingsVessels,
  createRfq,
  parseRfqPdf,
  createSettingsCustomer,
  createSettingsVessel,
} from "@/lib/api";
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
  const [projectTitle, setProjectTitle] = useState("");
  const [workType, setWorkType] = useState("부품공급");
  const [items, setItems] = useState<ItemRow[]>([
    { part_no: "", description: "", qty: "1" },
  ]);
  const [busy, setBusy] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [ocrMsg, setOcrMsg] = useState<string | null>(null);
  // OCR 이 인식했지만 DB 에 없는 Customer/선박 — 빠른 등록 폼의 기본값/자동 열기에 사용
  const [custHint, setCustHint] = useState("");
  const [vesselHint, setVesselHint] = useState("");

  function reloadCustomers(): Promise<CustomerOption[]> {
    return fetchCustomers()
      .then((cs) => {
        setCustomers(cs);
        return cs;
      })
      .catch(() => {
        setCustomers([]);
        return [];
      });
  }
  function reloadVessels(): Promise<SettingsVessel[]> {
    return fetchSettingsVessels()
      .then((vs) => {
        setVessels(vs);
        return vs;
      })
      .catch(() => {
        setVessels([]);
        return [];
      });
  }

  useEffect(() => {
    reloadCustomers();
    reloadVessels();
  }, []);

  const custUnmatched = custHint.trim() !== "" && !matchName(custHint, customers);
  const vesselUnmatched = vesselHint.trim() !== "" && !matchName(vesselHint, vessels);

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

  function matchName<T extends { name: string }>(hint: string | null | undefined, rows: T[]) {
    if (!hint) return undefined;
    const h = hint.trim().toLowerCase();
    return rows.find((r) => {
      const n = r.name.toLowerCase();
      return h === n || h.includes(n) || n.includes(h);
    });
  }

  async function uploadOcr(file: File | null) {
    if (!file) return;
    setOcrBusy(true);
    setErr(null);
    setOcrMsg(null);
    try {
      const r = await parseRfqPdf(file);
      const cust = matchName(r.customer_hint, customers);
      const vessel = matchName(r.vessel_name, vessels);
      setCustHint(cust ? "" : r.customer_hint ?? "");
      setVesselHint(vessel ? "" : r.vessel_name ?? "");
      if (cust) setCustomerId(cust.id);
      if (vessel) setVesselId(vessel.id);
      if (r.customer_rfq_no) setCustRfqNo(r.customer_rfq_no);
      if (r.items?.length) {
        setItems(
          r.items.map((it) => ({
            part_no: it.part_no ?? "",
            description: it.description ?? "",
            qty: String(it.qty ?? 1),
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
        project_title: projectTitle,
        work_type: workType,
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
      setProjectTitle("");
      setWorkType("부품공급");
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
      <div className="po-work-note">
        <b>PDF로 자동 입력 (AI OCR)</b>
        <span>RFQ PDF를 업로드하면 Customer, 선박, 고객 RFQ No., 품목을 자동 추출해 아래 폼에 반영합니다.</span>
      </div>
      <div className="action-row">
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => uploadOcr(e.target.files?.[0] ?? null)}
          disabled={ocrBusy}
        />
        {ocrBusy ? <span className="hint-inline">AI가 PDF를 분석 중…</span> : null}
        {ocrMsg ? <span className="action-ok">{ocrMsg}</span> : null}
      </div>

      <details className="quick-create" open={custUnmatched}>
        <summary>신규 Customer 빠른 등록</summary>
        <QuickCustomerCreate
          defaultName={custHint}
          unmatchedHint={custUnmatched ? custHint : ""}
          onCreated={async (id) => {
            await reloadCustomers();
            setCustomerId(id);
            setCustHint("");
          }}
        />
      </details>

      <details className="quick-create" open={vesselUnmatched}>
        <summary>신규 선박 빠른 등록</summary>
        <QuickVesselCreate
          defaultName={vesselHint}
          unmatchedHint={vesselUnmatched ? vesselHint : ""}
          customers={customers}
          defaultOwnerId={customerId === "" ? undefined : customerId}
          onCreated={async (id) => {
            await reloadVessels();
            setVesselId(id);
            setVesselHint("");
          }}
        />
      </details>

      <div className="form-field" style={{ marginBottom: 4 }}>
        <label>업무 타입</label>
        <div className="seg-tabs">
          {["부품공급", "서비스"].map((t) => (
            <button
              key={t}
              type="button"
              className={workType === t ? "on" : ""}
              onClick={() => setWorkType(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

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
        <Field label="프로젝트 제목">
          <input
            value={projectTitle}
            onChange={(e) => setProjectTitle(e.target.value)}
            placeholder="내부 식별용 제목(선택)"
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

function QuickCustomerCreate({
  defaultName,
  unmatchedHint,
  onCreated,
}: {
  defaultName: string;
  unmatchedHint: string;
  onCreated: (id: number) => void | Promise<void>;
}) {
  const [name, setName] = useState(defaultName);
  const [country, setCountry] = useState("");
  const [contact, setContact] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setName(defaultName);
  }, [defaultName]);

  async function submit() {
    if (!name.trim()) {
      setErr("Customer명을 입력하세요.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await createSettingsCustomer({
        name: name.trim(),
        country,
        contact,
        email,
      });
      await onCreated(r.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "등록 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="quick-create-body">
      {unmatchedHint ? (
        <span className="hint-inline">
          OCR 인식: “{unmatchedHint}” — DB에 없는 Customer입니다. 등록하면 자동 선택됩니다.
        </span>
      ) : null}
      <div className="form-grid">
        <Field label="Customer명 *">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="국가">
          <input value={country} onChange={(e) => setCountry(e.target.value)} />
        </Field>
        <Field label="담당자">
          <input value={contact} onChange={(e) => setContact(e.target.value)} />
        </Field>
        <Field label="이메일">
          <input value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      </div>
      <div className="form-actions">
        <button className="btn primary" onClick={submit} disabled={busy || !name.trim()}>
          {busy ? "등록 중…" : "Customer 등록"}
        </button>
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  );
}

function QuickVesselCreate({
  defaultName,
  unmatchedHint,
  customers,
  defaultOwnerId,
  onCreated,
}: {
  defaultName: string;
  unmatchedHint: string;
  customers: CustomerOption[];
  defaultOwnerId?: number;
  onCreated: (id: number) => void | Promise<void>;
}) {
  const [name, setName] = useState(defaultName);
  const [imo, setImo] = useState("");
  const [engine, setEngine] = useState("");
  const [hull, setHull] = useState("");
  const [ownerId, setOwnerId] = useState<number | "">(defaultOwnerId ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setName(defaultName);
  }, [defaultName]);
  useEffect(() => {
    setOwnerId(defaultOwnerId ?? "");
  }, [defaultOwnerId]);

  async function submit() {
    if (!name.trim()) {
      setErr("선박명을 입력하세요.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await createSettingsVessel({
        name: name.trim(),
        imo,
        engine_type: engine,
        hull_no: hull,
        customer_id: ownerId === "" ? undefined : ownerId,
      });
      await onCreated(r.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "등록 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="quick-create-body">
      {unmatchedHint ? (
        <span className="hint-inline">
          OCR 인식: “{unmatchedHint}” — DB에 없는 선박입니다. 등록하면 자동 선택됩니다.
        </span>
      ) : null}
      <div className="form-grid">
        <Field label="선박명 *">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="IMO No.">
          <input value={imo} onChange={(e) => setImo(e.target.value)} />
        </Field>
        <Field label="Main Engine Type">
          <input value={engine} onChange={(e) => setEngine(e.target.value)} />
        </Field>
        <Field label="Hull No.">
          <input value={hull} onChange={(e) => setHull(e.target.value)} />
        </Field>
        <Field label="선주 (Customer)">
          <select
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value === "" ? "" : Number(e.target.value))}
          >
            <option value="">— 없음 —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="form-actions">
        <button className="btn primary" onClick={submit} disabled={busy || !name.trim()}>
          {busy ? "등록 중…" : "선박 등록"}
        </button>
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  );
}
