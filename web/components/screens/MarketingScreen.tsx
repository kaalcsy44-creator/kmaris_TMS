"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  fetchMarketing,
  fetchCustomers,
  fetchAssignableUsers,
  createMarketing,
  updateMarketing,
  deleteMarketing,
  type MarketingSave,
} from "@/lib/api";
import { useCachedData, invalidateCache } from "@/lib/useCachedData";
import type { MarketingRow, CustomerOption } from "@/lib/types";
import { can, canEditDeal, editBlockReason, getUser } from "@/lib/auth";
import FilterTable, { ColumnDef } from "@/components/common/FilterTable";
import CustomerName from "@/components/common/CustomerName";
import CustomerSelect from "@/components/common/CustomerSelect";
import Modal from "@/components/common/Modal";
import ComposeEmailModal from "@/components/screens/ComposeEmailModal";

const today = () => new Date().toISOString().slice(0, 10);

// 발송수단·활동유형 선택지 — RFQ request_channel 과 톤을 맞춘다(자유 확장 가능).
const CHANNELS = ["Email", "Phone", "Visit", "Exhibition", "WhatsApp", "WeChat", "Other"];
const ACTIVITY_TYPES = ["Brochure sent", "Intro email", "Visit", "Meeting", "Sample sent", "Follow-up", "Other"];

// 활동유형은 복수 선택 가능 — 내부적으로 ", " join 문자열로 저장한다.
function parseTypes(s: string): string[] {
  return s ? s.split(",").map((x) => x.trim()).filter(Boolean) : [];
}
function toggleType(s: string, t: string): string {
  const cur = parseTypes(s);
  const next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t];
  // 정규 순서(ACTIVITY_TYPES)로 정렬해 join — 표시 일관성 유지.
  return ACTIVITY_TYPES.filter((x) => next.includes(x)).join(", ");
}

export type Form = {
  customer_id: number | "";
  prospect_name: string;
  contact_person: string;
  recipient_email: string;
  activity_date: string;
  channel: string;
  activity_type: string;
  subject: string;
  notes: string;
  next_action_date: string;
  owner_id: number | "";
};

export const emptyForm: Form = {
  customer_id: "",
  prospect_name: "",
  contact_person: "",
  recipient_email: "",
  activity_date: today(),
  channel: "Email",
  activity_type: "Brochure sent",
  subject: "",
  notes: "",
  next_action_date: "",
  owner_id: "",
};

function rowToForm(r: MarketingRow): Form {
  // 구버전 응답(신규 필드 누락)에도 안전하도록 모든 문자열 필드를 ?? "" 로 보정.
  return {
    customer_id: r.customer_id ?? "",
    prospect_name: r.prospect_name ?? "",
    contact_person: r.contact_person ?? "",
    recipient_email: r.recipient_email ?? "",
    activity_date: r.activity_date || today(),
    channel: r.channel ?? "",
    activity_type: r.activity_type ?? "",
    subject: r.subject ?? "",
    notes: r.notes ?? "",
    next_action_date: r.next_action_date ?? "",
    owner_id: r.owner_id || "",
  };
}

function formToBody(f: Form): MarketingSave {
  return {
    customer_id: f.customer_id === "" ? null : f.customer_id,
    prospect_name: f.prospect_name.trim(),
    contact_person: f.contact_person.trim(),
    recipient_email: f.recipient_email.trim(),
    activity_date: f.activity_date,
    channel: f.channel,
    activity_type: f.activity_type,
    subject: f.subject,
    notes: f.notes,
    next_action_date: f.next_action_date,
    owner_id: f.owner_id === "" ? null : f.owner_id,
  };
}

export default function MarketingScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const idParam = params.get("id");
  const { data, error, refresh } = useCachedData("marketing", fetchMarketing);
  const { data: customers } = useCachedData("settings:customers", fetchCustomers);
  const [editing, setEditing] = useState<MarketingRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [composing, setComposing] = useState(false);

  const rows = useMemo(() => data?.rows ?? [], [data]);

  // 대시보드 Marketing 카드에서 ?id=<id> 로 넘어오면 해당 활동을 자동으로 연다.
  useEffect(() => {
    if (!idParam) return;
    const match = rows.find((r) => r.id === Number(idParam));
    if (match) setEditing(match);
  }, [idParam, rows]);

  function reload() {
    invalidateCache("marketing-overview");
    invalidateCache("home:marketing");
    return refresh();
  }

  function close() {
    setEditing(null);
    setAdding(false);
    if (idParam) router.replace("/marketing");
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
    { key: "contact_person", label: "Contact", text: (r) => r.contact_person || "" },
    { key: "recipient_email", label: "Email", text: (r) => r.recipient_email || "" },
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
        <Modal title="Add marketing activity" onClose={close} form>
          <MarketingForm
            initial={{ ...emptyForm, owner_id: getUser()?.id ?? "" }}
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
        <Modal title={`Marketing — ${editing.customer || "activity"}`} onClose={close} form>
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

      {/* 우하단 FAB — 홍보/회사소개 이메일 작성·발송 */}
      {can("marketing", "create") ? (
        <button
          type="button"
          className="compose-fab"
          title="Compose promotional email"
          onClick={() => setComposing(true)}
        >
          <span className="compose-fab-plus">＋</span>
          <span className="compose-fab-label">Email</span>
        </button>
      ) : null}

      {composing ? (
        <ComposeEmailModal
          customers={customers ?? []}
          onClose={() => setComposing(false)}
          onSent={() => {
            setComposing(false);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

export function MarketingForm({
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
  const { data: users } = useCachedData("assignable-users", fetchAssignableUsers);

  const valid = form.customer_id !== "" || form.prospect_name.trim() !== "";

  async function save() {
    if (!valid) {
      setErr("Select a target customer or enter a prospect name.");
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
          <CustomerSelect
            value={form.customer_id}
            options={customers}
            onChange={(id) => setForm({ ...form, customer_id: id })}
            emptyLabel="— Prospect (not registered) —"
            disabled={!canEdit}
          />
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
            label="Contact person"
            value={form.contact_person}
            onChange={(v) => setForm({ ...form, contact_person: v })}
          />
          <Field
            label="Recipient email"
            type="email"
            value={form.recipient_email}
            onChange={(v) => setForm({ ...form, recipient_email: v })}
          />
          <Field
            label="Activity date"
            type="date"
            value={form.activity_date}
            onChange={(v) => setForm({ ...form, activity_date: v })}
          />
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
          <label className="form-field">
            <span>PIC</span>
            <select
              value={form.owner_id}
              onChange={(e) =>
                setForm({ ...form, owner_id: e.target.value === "" ? "" : Number(e.target.value) })
              }
            >
              <option value="">— Unassigned —</option>
              {(users ?? []).map((u) => (
                <option key={u.id} value={u.id}>{u.username}</option>
              ))}
            </select>
          </label>
          <div className="form-field" style={{ gridColumn: "1 / -1" }}>
            <span>Activity type (multiple)</span>
            <div className="check-group">
              {ACTIVITY_TYPES.map((t) => {
                const checked = parseTypes(form.activity_type).includes(t);
                return (
                  <label key={t} className={`check-chip${checked ? " on" : ""}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => setForm({ ...form, activity_type: toggleType(form.activity_type, t) })}
                    />
                    {t}
                  </label>
                );
              })}
            </div>
          </div>
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
