"use client";

import { useEffect, useMemo, useState } from "react";
import {
  fetchMarketing,
  fetchCustomers,
  createMarketing,
  updateMarketing,
  deleteMarketing,
  type MarketingSave,
} from "@/lib/api";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import type { MarketingRow, CustomerOption } from "@/lib/types";
import { can, canEditDeal, editBlockReason } from "@/lib/auth";
import FilterTable, { ColumnDef } from "@/components/common/FilterTable";
import CustomerName from "@/components/common/CustomerName";
import Modal from "@/components/common/Modal";

const today = () => new Date().toISOString().slice(0, 10);

// 발송수단·활동유형 선택지 — RFQ request_channel 과 톤을 맞춘다(자유 확장 가능).
const CHANNELS = ["Email", "전화", "방문", "전시회", "WhatsApp", "WeChat", "기타"];
const ACTIVITY_TYPES = ["홍보자료 발송", "소개메일", "방문", "미팅", "샘플 발송", "팔로업", "기타"];

type Form = {
  customer_id: number | "";
  prospect_name: string;
  activity_date: string;
  channel: string;
  activity_type: string;
  subject: string;
  notes: string;
  next_action_date: string;
};

const emptyForm: Form = {
  customer_id: "",
  prospect_name: "",
  activity_date: today(),
  channel: "Email",
  activity_type: "홍보자료 발송",
  subject: "",
  notes: "",
  next_action_date: "",
};

function rowToForm(r: MarketingRow): Form {
  return {
    customer_id: r.customer_id ?? "",
    prospect_name: r.prospect_name,
    activity_date: r.activity_date || today(),
    channel: r.channel,
    activity_type: r.activity_type,
    subject: r.subject,
    notes: r.notes,
    next_action_date: r.next_action_date,
  };
}

function formToBody(f: Form): MarketingSave {
  return {
    customer_id: f.customer_id === "" ? null : f.customer_id,
    prospect_name: f.prospect_name.trim(),
    activity_date: f.activity_date,
    channel: f.channel,
    activity_type: f.activity_type,
    subject: f.subject,
    notes: f.notes,
    next_action_date: f.next_action_date,
  };
}

export default function MarketingScreen() {
  const { data, error, refresh } = useCachedData("marketing", fetchMarketing);
  const { data: customers } = useCachedData("settings:customers", fetchCustomers);
  const [editing, setEditing] = useState<MarketingRow | null>(null);
  const [adding, setAdding] = useState(false);

  const rows = useMemo(() => data?.rows ?? [], [data]);

  function reload() {
    invalidateCache("marketing-overview");
    invalidateCache("home:marketing");
    return refresh();
  }

  function close() {
    setEditing(null);
    setAdding(false);
  }

  const columns: ColumnDef<MarketingRow>[] = [
    { key: "activity_date", label: "Date", text: (r) => r.activity_date || "", filter: "date" },
    {
      key: "customer",
      label: "Target",
      text: (r) => r.customer || "",
      filter: "facet",
      render: (r) => (
        <span className="cust-name">
          {r.is_prospect ? (
            <span className="cust-name-text">{r.customer || "—"}</span>
          ) : (
            <CustomerName name={r.customer || ""} />
          )}
          {r.is_prospect ? <span className="wt-badge" style={{ marginLeft: 6 }}>Prospect</span> : null}
        </span>
      ),
    },
    { key: "activity_type", label: "Activity", text: (r) => r.activity_type || "", filter: "facet" },
    { key: "channel", label: "Channel", text: (r) => r.channel || "", filter: "facet" },
    { key: "subject", label: "Subject", text: (r) => r.subject || "" },
    { key: "next_action_date", label: "Follow-up", text: (r) => r.next_action_date || "", filter: "date" },
    { key: "owner", label: "PIC", text: (r) => r.owner || "", filter: "facet" },
  ];

  return (
    <div className="action-tabs">
      {error && !data ? (
        <div className="state error">API error: {error.message}</div>
      ) : null}

      {!data ? (
        <div className="state">Loading…</div>
      ) : (
        <FilterTable
          tableId="marketing"
          rows={rows}
          columns={columns}
          getRowKey={(r) => r.id}
          onRowClick={(r) => setEditing(r)}
          defaultSortKey="activity_date"
          defaultSortDir="desc"
          empty="No marketing activities yet."
          actions={
            can("marketing", "create") ? (
              <button className="btn" onClick={() => setAdding(true)}>
                + Add activity
              </button>
            ) : null
          }
        />
      )}

      {adding ? (
        <Modal title="Add marketing activity" onClose={close} wide>
          <MarketingForm
            initial={emptyForm}
            customers={customers ?? []}
            canEdit
            onChanged={() => {
              close();
              reload();
            }}
          />
        </Modal>
      ) : null}

      {editing ? (
        <Modal title={`Marketing — ${editing.customer || "activity"}`} onClose={close} wide>
          <MarketingForm
            initial={rowToForm(editing)}
            customers={customers ?? []}
            canEdit={can("marketing", "edit") && canEditDeal(editing.owner_id)}
            canDelete={can("marketing", "delete") && canEditDeal(editing.owner_id)}
            blockReason={editBlockReason("marketing", editing.owner_id)}
            rowId={editing.id}
            onChanged={() => {
              close();
              reload();
            }}
          />
        </Modal>
      ) : null}
    </div>
  );
}

function MarketingForm({
  initial,
  customers,
  canEdit,
  canDelete,
  blockReason,
  rowId,
  onChanged,
}: {
  initial: Form;
  customers: CustomerOption[];
  canEdit: boolean;
  canDelete?: boolean;
  blockReason?: string;
  rowId?: number;
  onChanged: () => void;
}) {
  const [form, setForm] = useState<Form>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const valid = form.customer_id !== "" || form.prospect_name.trim() !== "";

  async function save() {
    if (!valid) {
      setErr("대상 고객사를 선택하거나 잠정사 이름을 입력하세요.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      if (rowId) await updateMarketing(rowId, formToBody(form));
      else await createMarketing(formToBody(form));
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!rowId) return;
    if (!confirm("Delete this marketing activity?")) return;
    setBusy(true);
    setErr("");
    try {
      await deleteMarketing(rowId);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <fieldset className="form-fieldset" disabled={!canEdit}>
        <div className="project-select">
          <label>Customer (registered)</label>
          <select
            value={form.customer_id}
            onChange={(e) =>
              setForm({ ...form, customer_id: e.target.value ? Number(e.target.value) : "" })
            }
          >
            <option value="">— Prospect (not registered) —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-grid">
          {form.customer_id === "" ? (
            <Field
              label="Prospect name *"
              value={form.prospect_name}
              onChange={(v) => setForm({ ...form, prospect_name: v })}
            />
          ) : null}
          <Field
            label="Activity date"
            type="date"
            value={form.activity_date}
            onChange={(v) => setForm({ ...form, activity_date: v })}
          />
          <label className="form-field">
            <span>Activity type</span>
            <select
              value={form.activity_type}
              onChange={(e) => setForm({ ...form, activity_type: e.target.value })}
            >
              {ACTIVITY_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>Channel</span>
            <select
              value={form.channel}
              onChange={(e) => setForm({ ...form, channel: e.target.value })}
            >
              {CHANNELS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <Field
            label="Subject"
            value={form.subject}
            onChange={(v) => setForm({ ...form, subject: v })}
          />
          <Field
            label="Follow-up date"
            type="date"
            value={form.next_action_date}
            onChange={(v) => setForm({ ...form, next_action_date: v })}
          />
        </div>
        <label className="form-field" style={{ marginTop: 10 }}>
          <span>Notes</span>
          <textarea
            rows={3}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </label>
      </fieldset>

      <div className="form-actions">
        {!canEdit ? (
          <span className="hint-inline">{blockReason}</span>
        ) : (
          <button className="btn primary" disabled={busy || !valid} onClick={save}>
            {busy ? "Working…" : rowId ? "Save" : "Add activity"}
          </button>
        )}
        {canDelete ? (
          <button
            className="btn danger"
            disabled={busy}
            onClick={remove}
            style={{ marginLeft: "auto" }}
          >
            Delete
          </button>
        ) : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
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
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="form-field">
      <span>{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
