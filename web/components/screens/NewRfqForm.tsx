"use client";

import { useEffect, useState } from "react";
import { tr } from "@/lib/labels";
import {
  fetchCustomers,
  fetchSettingsVessels,
  createRfq,
  updateRfq,
  fetchRfqDetail,
  deleteRfq,
  parseRfqPdf,
  createSettingsCustomer,
  createSettingsVessel,
} from "@/lib/api";
import type { CustomerOption, SettingsVessel } from "@/lib/types";
import { can, canEditDeal, editBlockReason } from "@/lib/auth";

type ItemRow = { part_no: string; description: string; qty: string; remark: string };

// 고객이 RFQ를 보내온 수단(요청 수단). 자유 텍스트 컬럼이라 프리셋 외 값도 저장 가능.
const REQUEST_CHANNELS = ["Email", "Phone", "SMS", "WhatsApp", "WeChat", "Other"];

/** 현재 시각 "YYYY-MM-DDTHH:MM" (datetime-local 기본값). */
function nowLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

export default function NewRfqForm({
  onCreated,
  onCancel,
  onDeleted,
  selectedRfqId,
  autoLoadId,
}: {
  onCreated?: (rfqNo: string) => void;
  onCancel?: () => void;
  onDeleted?: () => void;        // 삭제 후 콜백(있으면 삭제 버튼 표시)
  selectedRfqId?: number | null; // 상단에서 선택된 RFQ — 불러와 수정 가능
  autoLoadId?: number | null;    // 마운트 시 해당 RFQ를 즉시 불러와 수정 모드 진입
}) {
  const [editId, setEditId] = useState<number | null>(null); // null=신규, >0=수정
  const [assigneeId, setAssigneeId] = useState<number>(0);   // 편집 대상 RFQ의 담당자(PIC)
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [vessels, setVessels] = useState<SettingsVessel[]>([]);
  const [customerId, setCustomerId] = useState<number | "">("");
  const [vesselId, setVesselId] = useState<number | "">("");
  const [custRfqNo, setCustRfqNo] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [projectTitle, setProjectTitle] = useState("");
  const [workType, setWorkType] = useState("부품공급");
  const [requestChannel, setRequestChannel] = useState("");
  const [notes, setNotes] = useState("");
  const [receivedAt, setReceivedAt] = useState(nowLocal());
  const [items, setItems] = useState<ItemRow[]>([
    { part_no: "", description: "", qty: "1", remark: "" },
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

  // 상세 모달 진입 시: 지정된 RFQ를 즉시 불러와 수정 모드로 전환.
  useEffect(() => {
    if (autoLoadId) loadRfq(autoLoadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoadId]);

  async function handleDelete() {
    if (!editId) return;
    if (
      !window.confirm(
        "Delete this RFQ?\nLinked Vendor RFQs/quotes will also be deleted.\n(RFQs already advanced to a quote/order cannot be deleted.)"
      )
    )
      return;
    setBusy(true);
    setErr(null);
    try {
      await deleteRfq(editId);
      onDeleted?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
      setBusy(false);
    }
  }

  const custUnmatched = custHint.trim() !== "" && !matchName(custHint, customers);
  const vesselUnmatched = vesselHint.trim() !== "" && !matchName(vesselHint, vessels);

  // 상단 도구(자동입력·빠른등록)는 기본 접힘 — 필요할 때만 버튼으로 펼친다.
  const [showOcr, setShowOcr] = useState(false);
  const [showCust, setShowCust] = useState(false);
  const [showVessel, setShowVessel] = useState(false);
  // OCR이 DB에 없는 Customer/선박을 인식하면 해당 빠른등록 패널을 자동으로 펼친다.
  useEffect(() => {
    if (custUnmatched) setShowCust(true);
  }, [custUnmatched]);
  useEffect(() => {
    if (vesselUnmatched) setShowVessel(true);
  }, [vesselUnmatched]);

  function setItem(i: number, key: keyof ItemRow, val: string) {
    setItems((prev) =>
      prev.map((it, idx) => (idx === i ? { ...it, [key]: val } : it))
    );
  }
  function addItem() {
    setItems((prev) => [...prev, { part_no: "", description: "", qty: "1", remark: "" }]);
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

  // 편집 권한: 기존 RFQ 수정은 역할(rfq.edit) × 담당(PIC), 신규는 rfq.create.
  const canEditThis =
    editId != null
      ? can("rfq", "edit") && canEditDeal(assigneeId)
      : can("rfq", "create");
  const canDeleteThis = can("rfq", "delete") && canEditDeal(assigneeId);

  // 캡쳐본 붙여넣기(Ctrl+V) → 이미지면 바로 OCR (편집 권한 없으면 무시)
  function handlePaste(e: React.ClipboardEvent) {
    if (!canEditThis) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of Array.from(items)) {
      if (it.type.startsWith("image/")) {
        const blob = it.getAsFile();
        if (blob) {
          e.preventDefault();
          setShowOcr(true);
          uploadOcr(blob);
        }
        return;
      }
    }
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
      // 담당자: OCR 추출값 우선, 없으면 매칭된 Customer의 담당자
      if (r.contact_person) setContactPerson(r.contact_person);
      else if (cust?.contact) setContactPerson(cust.contact);
      if (r.items?.length) {
        setItems(
          r.items.map((it) => ({
            part_no: it.part_no ?? "",
            description: it.description ?? "",
            qty: String(it.qty ?? 1),
            remark: it.remark ?? "",
          }))
        );
      }
      setOcrMsg(
        `Extracted: ${r.items?.length ?? 0} item(s)${
          r.customer_hint ? ` · Customer hint ${r.customer_hint}` : ""
        }`
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "OCR extraction failed");
    } finally {
      setOcrBusy(false);
    }
  }

  function resetForm() {
    setEditId(null);
    setAssigneeId(0);
    setCustomerId("");
    setVesselId("");
    setCustRfqNo("");
    setContactPerson("");
    setProjectTitle("");
    setWorkType("부품공급");
    setRequestChannel("");
    setNotes("");
    setReceivedAt(nowLocal());
    setItems([{ part_no: "", description: "", qty: "1", remark: "" }]);
    setErr(null);
    setMsg(null);
  }

  // 기존 RFQ를 불러와 폼에 채우고 수정 모드로 전환.
  async function loadRfq(id: number) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const d = await fetchRfqDetail(id);
      setEditId(id);
      setAssigneeId(d.assignee_id ?? 0);
      setCustomerId(d.customer_id || "");
      setVesselId(d.vessel_id || "");
      setCustRfqNo(d.customer_rfq_no || "");
      setContactPerson(d.contact_person || "");
      setProjectTitle(d.project_title || "");
      setWorkType(d.work_type || "부품공급");
      setRequestChannel(d.request_channel || "");
      setNotes(d.notes || "");
      setReceivedAt(d.received_at || nowLocal());
      setItems(
        d.items.length
          ? d.items.map((it) => ({
              part_no: it.part_no || "",
              description: it.description || "",
              qty: String(it.qty ?? 1),
              remark: it.remark ?? "",
            }))
          : [{ part_no: "", description: "", qty: "1", remark: "" }]
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load RFQ");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (customerId === "") {
      setErr("Select a customer.");
      return;
    }
    setBusy(true);
    setErr(null);
    setMsg(null);
    const cleanItems = items
      .filter((it) => it.part_no.trim() || it.description.trim())
      .map((it) => ({
        part_no: it.part_no,
        description: it.description,
        qty: Number(it.qty) || 1,
        remark: it.remark,
      }));
    try {
      if (editId) {
        await updateRfq(editId, {
          customer_id: customerId,
          vessel_id: vesselId === "" ? 0 : vesselId,
          customer_rfq_no: custRfqNo,
          contact_person: contactPerson,
          received_at: receivedAt || undefined,
          project_title: projectTitle,
          work_type: workType,
          request_channel: requestChannel,
          notes,
          items: cleanItems,
        });
        setMsg("Updated");
        onCreated?.(""); // 목록·상위 새로고침
      } else {
        const r = await createRfq({
          customer_id: customerId,
          vessel_id: vesselId === "" ? undefined : vesselId,
          customer_rfq_no: custRfqNo,
          contact_person: contactPerson,
          received_at: receivedAt || undefined,
          project_title: projectTitle,
          work_type: workType,
          request_channel: requestChannel,
          notes,
          items: cleanItems,
        });
        setMsg(`Created — ${r.rfq_no}`);
        resetForm();
        onCreated?.(r.rfq_no);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : editId ? "Update failed" : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel form-panel" onPaste={handlePaste}>
      <div className="rfq-mode-bar">
        {editId ? (
          <>
            {canEditThis ? (
              <>
                <span className="rfq-mode-tag edit">✎ Edit mode</span>
                <span className="hint-inline">Editing an existing RFQ.</span>
              </>
            ) : (
              <>
                <span className="rfq-mode-tag">🔒 View only</span>
                <span className="hint-inline">{editBlockReason("rfq", assigneeId).replace(/^View only — /, "")}</span>
              </>
            )}
            {can("rfq", "create") ? (
              <button className="btn" style={{ marginLeft: "auto" }} onClick={resetForm}>
                + New RFQ
              </button>
            ) : null}
          </>
        ) : (
          <>
            <span className="rfq-mode-tag new">+ New</span>
            {selectedRfqId ? (
              <button
                className="btn"
                style={{ marginLeft: "auto" }}
                onClick={() => loadRfq(selectedRfqId)}
                disabled={busy}
              >
                📂 Load & edit selected RFQ
              </button>
            ) : (
              <span className="hint-inline">
                Pick an "Active project" above to load and edit it.
              </span>
            )}
          </>
        )}
      </div>
      <fieldset className="form-fieldset" disabled={!canEditThis}>
      {/* 도구 모음 — 평소엔 접혀 있고, 버튼으로 필요한 패널만 펼친다. */}
      <div className="form-tools">
        <button
          type="button"
          className={`tool-btn${showOcr ? " on" : ""}`}
          onClick={() => setShowOcr((v) => !v)}
        >
          📄 Auto-fill
        </button>
        <button
          type="button"
          className={`tool-btn${showCust ? " on" : ""}`}
          onClick={() => setShowCust((v) => !v)}
        >
          ＋ New Customer
        </button>
        <button
          type="button"
          className={`tool-btn${showVessel ? " on" : ""}`}
          onClick={() => setShowVessel((v) => !v)}
        >
          ＋ New Vessel
        </button>
      </div>

      {showOcr ? (
        <div className="ocr-bar">
          <span className="ocr-bar-label">📄 RFQ auto-fill (PDF·image)</span>
          <input
            type="file"
            accept="application/pdf,image/png,image/jpeg,image/webp"
            onChange={(e) => uploadOcr(e.target.files?.[0] ?? null)}
            disabled={ocrBusy}
          />
          {ocrBusy ? (
            <span className="hint-inline">AI analyzing…</span>
          ) : ocrMsg ? (
            <span className="action-ok">{ocrMsg}</span>
          ) : (
            <span className="hint-inline">Upload a PDF/image or paste a screenshot with Ctrl+V → auto-fill</span>
          )}
        </div>
      ) : null}

      {showCust ? (
        <div className="quick-create-panel">
          <QuickCustomerCreate
            defaultName={custHint}
            unmatchedHint={custUnmatched ? custHint : ""}
            onCreated={async (id) => {
              await reloadCustomers();
              setCustomerId(id);
              setCustHint("");
              setShowCust(false);
            }}
          />
        </div>
      ) : null}

      {showVessel ? (
        <div className="quick-create-panel">
          <QuickVesselCreate
            defaultName={vesselHint}
            unmatchedHint={vesselUnmatched ? vesselHint : ""}
            customers={customers}
            defaultOwnerId={customerId === "" ? undefined : customerId}
            onCreated={async (id) => {
              await reloadVessels();
              setVesselId(id);
              setVesselHint("");
              setShowVessel(false);
            }}
          />
        </div>
      ) : null}

      <div className="sub-h" style={{ marginTop: 16 }}>
        Basic info
      </div>
      <div className="form-grid">
        <Field label="RFQ received at">
          <input
            type="datetime-local"
            value={receivedAt}
            onChange={(e) => setReceivedAt(e.target.value)}
          />
        </Field>
        <Field label="Work type">
          <select value={workType} onChange={(e) => setWorkType(e.target.value)}>
            <option value="부품공급">{tr("부품공급")}</option>
            <option value="서비스">{tr("서비스")}</option>
          </select>
        </Field>
        <Field label="Customer *">
          <select
            value={customerId}
            onChange={(e) => {
              const id = e.target.value === "" ? "" : Number(e.target.value);
              setCustomerId(id);
              // 선택한 Customer의 담당자를 함께 채운다(있으면).
              const c = id === "" ? undefined : customers.find((x) => x.id === id);
              if (c?.contact) setContactPerson(c.contact);
            }}
          >
            <option value="">Select…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.contact ? ` — ${c.contact}` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Customer contact">
          <input
            value={contactPerson}
            onChange={(e) => setContactPerson(e.target.value)}
            placeholder="Contact name/title (optional)"
          />
        </Field>
        <Field label="Vessel">
          <select
            value={vesselId}
            onChange={(e) =>
              setVesselId(e.target.value === "" ? "" : Number(e.target.value))
            }
          >
            <option value="">Select…</option>
            {vessels.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Customer RFQ No.">
          <input
            value={custRfqNo}
            onChange={(e) => setCustRfqNo(e.target.value)}
            placeholder="Customer reference no. (optional)"
          />
        </Field>
        <Field label="Project title">
          <input
            value={projectTitle}
            onChange={(e) => setProjectTitle(e.target.value)}
            placeholder="Internal reference title (optional)"
          />
        </Field>
        <Field label="Request method">
          <select value={requestChannel} onChange={(e) => setRequestChannel(e.target.value)}>
            <option value="">Select…</option>
            {REQUEST_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="form-field" style={{ marginTop: 12 }}>
        <label>Notes</label>
        <textarea
          className="wrapcell"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Internal memo (optional)"
        />
      </div>

      <div className="sub-h" style={{ marginTop: 18 }}>
        Items
      </div>
      <table className="mini items-edit">
        <colgroup>
          <col style={{ width: 44 }} />
          <col style={{ width: 160 }} />
          <col />
          <col style={{ width: 84 }} />
          <col style={{ width: 160 }} />
          <col style={{ width: 44 }} />
        </colgroup>
        <thead>
          <tr>
            <th className="seq">#</th>
            <th>Part No.</th>
            <th>Description</th>
            <th className="num">Qty</th>
            <th>Remark</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i}>
              <td className="seq">{i + 1}</td>
              <td>
                <textarea
                  className="wrapcell"
                  rows={1}
                  value={it.part_no}
                  onChange={(e) => setItem(i, "part_no", e.target.value)}
                />
              </td>
              <td>
                <textarea
                  className="desc"
                  rows={1}
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
                <textarea
                  className="wrapcell"
                  rows={1}
                  value={it.remark}
                  onChange={(e) => setItem(i, "remark", e.target.value)}
                />
              </td>
              <td>
                <button
                  className="row-del"
                  onClick={() => removeItem(i)}
                  disabled={items.length === 1}
                  title="Delete"
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn" onClick={addItem} style={{ marginTop: 8 }}>
        + Add item
      </button>
      </fieldset>

      <div className="form-actions">
        {onCancel ? (
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        {!canEditThis ? (
          <span className="hint-inline">{editBlockReason("rfq", assigneeId)}</span>
        ) : (
          <button
            className="btn primary"
            onClick={submit}
            disabled={busy || customerId === ""}
          >
            {busy ? "Working…" : editId ? "Save RFQ" : "Create RFQ"}
          </button>
        )}
        {onDeleted && editId && canDeleteThis ? (
          <button className="btn danger" onClick={handleDelete} disabled={busy}>
            Delete
          </button>
        ) : null}
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
      setErr("Enter a customer name.");
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
      setErr(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="quick-create-body">
      {unmatchedHint ? (
        <span className="hint-inline">
          OCR detected: “{unmatchedHint}” — not in the DB. Creating it will auto-select it.
        </span>
      ) : null}
      <div className="form-grid">
        <Field label="Customer name *">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Country">
          <input value={country} onChange={(e) => setCountry(e.target.value)} />
        </Field>
        <Field label="Contact">
          <input value={contact} onChange={(e) => setContact(e.target.value)} />
        </Field>
        <Field label="Email">
          <input value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      </div>
      <div className="form-actions">
        <button className="btn primary" onClick={submit} disabled={busy || !name.trim()}>
          {busy ? "Saving…" : "Create Customer"}
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
      setErr("Enter a vessel name.");
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
      setErr(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="quick-create-body">
      {unmatchedHint ? (
        <span className="hint-inline">
          OCR detected: “{unmatchedHint}” — not in the DB. Creating it will auto-select it.
        </span>
      ) : null}
      <div className="form-grid">
        <Field label="Vessel name *">
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
        <Field label="Owner (Customer)">
          <select
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value === "" ? "" : Number(e.target.value))}
          >
            <option value="">— None —</option>
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
          {busy ? "Saving…" : "Create Vessel"}
        </button>
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  );
}
