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
import BrochuresPanel from "@/components/screens/BrochuresPanel";
import { BounceBadge } from "@/components/common/BouncedEmail";
import { ReplyBadge, FollowUpCell, ReplyMailPanel } from "@/components/common/MarketingBadges";
import { REPLY_STATUSES, replyText, suggestFollowUp } from "@/lib/marketing";
import { detectMarketingReplies, type MarketingDetectResult } from "@/lib/api";

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
  email_bounced: boolean;
  reply_status: string;
  reply_date: string;
  reply_note: string;
  reply_email_id: number;
  /** 지금 화면에 뜬 분류를 기계가 골랐는가(저장하면 사람이 확인한 값이 된다). */
  reply_auto: boolean;
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
  email_bounced: false,
  reply_status: "",
  reply_date: "",
  reply_note: "",
  reply_email_id: 0,
  reply_auto: false,
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
    email_bounced: r.email_bounced ?? false,
    reply_status: r.reply_status ?? "",
    reply_date: r.reply_date ?? "",
    reply_note: r.reply_note ?? "",
    reply_email_id: r.reply_email_id ?? 0,
    reply_auto: r.reply_auto ?? false,
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
    email_bounced: f.email_bounced,
    reply_status: f.reply_status,
    reply_date: f.reply_date,
    reply_note: f.reply_note.trim(),
    reply_email_id: f.reply_email_id || null,
    owner_id: f.owner_id === "" ? null : f.owner_id,
  };
}

export default function MarketingScreen({ onFill }: { onFill?: (v: boolean) => void }) {
  const router = useRouter();
  const params = useSearchParams();
  const idParam = params.get("id");
  const { data, error, refresh } = useCachedData("marketing", fetchMarketing);
  const { data: customers } = useCachedData("settings:customers", fetchCustomers);
  const [editing, setEditing] = useState<MarketingRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [composing, setComposing] = useState(false);
  // 화면 탭: 활동 목록(List) / 브로슈어·회사소개서 라이브러리(Brochures).
  const [view, setView] = useState<"list" | "brochures">("list");
  // 표가 본문인 탭에서만 화면을 채우는 배치를 쓴다(껍데기가 알아야 하는 값).
  useEffect(() => { onFill?.(view === "list"); }, [view, onFill]);

  const rows = useMemo(() => data?.rows ?? [], [data]);

  // 대시보드 Marketing 카드에서 ?id=<id> 로 넘어오면 해당 활동을 자동으로 연다.
  useEffect(() => {
    if (!idParam) return;
    const match = rows.find((r) => r.id === Number(idParam));
    if (match) {
      setView("list");
      setEditing(match);
    }
  }, [idParam, rows]);

  function reload() {
    invalidateCache("marketing-overview");
    invalidateCache("home:marketing");
    // 반송 표시는 고객 담당자 명부에도 옮겨 붙는다 — 홍보 메일 작성 화면이 들고 있는
    // 담당자 목록을 버려야 방금 찍은 표시가 다음에 열 때 바로 보인다.
    invalidateCache("settings:customers-full");
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
    {
      key: "recipient_email",
      label: "Email",
      text: (r) => r.recipient_email || "",
      render: (r) => (
        <span className={`mail-addr${r.email_bounced ? " bounced" : ""}`}>
          <span>{r.recipient_email || "—"}</span>
          {r.email_bounced ? <BounceBadge /> : null}
        </span>
      ),
    },
    { key: "activity_type", label: "Activity", text: (r) => r.activity_type || "", filter: "facet" },
    { key: "channel", label: "Channel", text: (r) => r.channel || "", filter: "facet" },
    { key: "subject", label: "Subject", text: (r) => r.subject || "" },
    {
      key: "reply_status",
      label: "Reply",
      text: (r) => replyText(r.reply_status, !!r.reply_email_id),
      filter: "facet",
      emptyLabel: "No reply logged",
      render: (r) => (
        <ReplyBadge
          status={r.reply_status || ""}
          detected={!!r.reply_email_id}
          auto={!!r.reply_auto}
        />
      ),
    },
    {
      key: "next_action_date",
      label: "Follow-up",
      text: (r) => r.next_action_date || "",
      filter: "date",
      render: (r) => <FollowUpCell date={r.next_action_date || ""} />,
    },
    { key: "owner", label: "PIC", text: (r) => r.owner || "", filter: "facet" },
  ];

  return (
    <div className="action-tabs">
      <div className="page-tabs">
        <button className={view === "list" ? "on" : ""} onClick={() => setView("list")}>
          List
        </button>
        <button className={view === "brochures" ? "on" : ""} onClick={() => setView("brochures")}>
          Brochures
        </button>
      </div>

      {view === "brochures" ? (
        <BrochuresPanel />
      ) : (
        <>
      {error && !data ? (
        <div className="state error">API error: {error.message}</div>
      ) : null}

      {!data ? (
        <div className="state">Loading…</div>
      ) : (
        <FilterTable
          tableId="marketing"
          // 205줄짜리 표다 — 페이지가 아니라 표가 굴러야 머리줄이 남고, 가로 막대가
          // 표 바로 아래(화면 안)에 선다.
          scrollBody
          rows={rows}
          columns={columns}
          getRowKey={(r) => r.id}
          onRowClick={(r) => setEditing(r)}
          defaultSortKey="activity_date"
          defaultSortDir="desc"
          empty="No marketing activities yet."
          actions={
            <>
              {can("marketing", "edit") ? (
                <DetectRepliesButton onDone={reload} />
              ) : null}
              {can("marketing", "create") ? (
                <button className="btn" onClick={() => setAdding(true)}>
                  + Add activity
                </button>
              ) : null}
            </>
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
        </>
      )}
    </div>
  );
}

/** 이미 담아 둔 수신 메일에서 홍보 메일의 답장을 찾아 붙인다.
 *
 *  메일을 새로 가져오는 것은 Mail 화면의 Sync 몫이고, 그 뒤에(그리고 매일 도는 자동
 *  정리 뒤에) 같은 일이 서버에서 저절로 돌아간다. 이 버튼은 "방금 들어온 답장을 지금
 *  당장 표에 반영하라"는 자리다. */
function DetectRepliesButton({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function run() {
    setBusy(true);
    setMsg("");
    try {
      const r: MarketingDetectResult = await detectMarketingReplies();
      const kinds = Object.entries(r.classified || {})
        .map(([k, n]) => `${k.replace("_", " ")} ${n}`)
        .join(" · ");
      const parts = [
        r.linked ? `${r.linked} repl${r.linked === 1 ? "y" : "ies"} linked` : "no new replies",
        kinds,
        r.unclassified ? `${r.unclassified} to classify` : "",
        r.no_reply ? `${r.no_reply} marked no reply` : "",
      ].filter(Boolean);
      setMsg(parts.join(" · "));
      onDone();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Detection failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="detect-replies">
      <button className="btn" onClick={run} disabled={busy}
              title="Scan the synced mailbox for replies to these emails">
        {busy ? "Scanning…" : "Detect replies"}
      </button>
      {msg ? <span className="hint-inline">{msg}</span> : null}
    </span>
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
  const replyPick = REPLY_STATUSES.find((r) => r.value === form.reply_status) ?? null;

  /** 답장 종류 선택 — 받은 날과 후속일, 그리고 죽은 주소 표시까지 한 번에 세운다. */
  function pickReply(value: string) {
    // 무응답은 "답장 받은 날"이 없다 — 확인한 날을 적되 비워 둘 수도 있게 둔다.
    const date = value === "no_reply" ? form.reply_date : form.reply_date || today();
    setForm({
      ...form,
      reply_status: value,
      reply_date: date,
      next_action_date: suggestFollowUp(value, date),
      // 더는 쓰지 않는 주소라는 답장은 반송과 같은 사실 — 명부까지 닿도록 함께 켠다.
      email_bounced: value === "invalid" ? true : form.email_bounced,
    });
  }

  function clearReply() {
    // 반송 표시는 손대지 않는다 — 주소의 사정은 답장 분류와 별개로 남을 수 있다.
    setForm({ ...form, reply_status: "", reply_date: "", reply_note: "", reply_email_id: 0 });
  }

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
          {/* 수신 주소와 그 주소의 사정(반송)을 한 칸에 둔다 — 반송은 발송 건이 아니라
              주소에 붙는 사실이라, 체크하면 같은 주소를 쓰는 고객 담당자 명부와 홍보
              메일 작성 화면에도 그대로 표시된다. */}
          <div className="form-field">
            <span>Recipient email</span>
            <input
              type="email"
              className={form.email_bounced ? "mail-bad" : ""}
              value={form.recipient_email}
              onChange={(e) => setForm({ ...form, recipient_email: e.target.value })}
            />
            <label className={`bounce-check${form.email_bounced ? " on" : ""}`}>
              <input
                type="checkbox"
                checked={form.email_bounced}
                disabled={!canEdit || form.reply_status === "invalid"}
                onChange={(e) => setForm({ ...form, email_bounced: e.target.checked })}
              />
              ⚠ Address not found (bounced)
            </label>
            {form.email_bounced ? (
              <span className="hint-inline">
                {form.reply_status === "invalid"
                  ? "Kept on because the reply said this address is no longer in use."
                  : "Also flagged on this address in the customer contact list."}
              </span>
            ) : null}
          </div>
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
          {/* 답장 — 보낸 뒤 무엇이 돌아왔는가. 종류마다 다시 두드릴 시기가 달라서,
              하나를 고르면 위 Follow-up date 가 그 종류에 맞는 날로 함께 채워진다
              (그 자리에서 다시 고쳐 적을 수 있다). */}
          <div className="form-field reply-block" style={{ gridColumn: "1 / -1" }}>
            <span>Reply received</span>
            <div className="check-group">
              {REPLY_STATUSES.map((r) => (
                <label
                  key={r.value}
                  className={`check-chip reply-chip ${r.tone}${form.reply_status === r.value ? " on" : ""}`}
                  title={r.hint}
                >
                  <input
                    type="radio"
                    name="reply_status"
                    checked={form.reply_status === r.value}
                    onChange={() => pickReply(r.value)}
                  />
                  {r.label}
                </label>
              ))}
              {form.reply_status ? (
                <button type="button" className="chip-clear" onClick={clearReply} disabled={!canEdit}>
                  Clear
                </button>
              ) : null}
            </div>
            {replyPick ? <span className="hint-inline">{replyPick.hint}</span> : null}
            {form.reply_email_id ? (
              <>
                {initial.reply_auto ? (
                  <span className="hint-inline auto-note">
                    Read from the reply below — check it and save to confirm.
                  </span>
                ) : null}
                {rowId ? <ReplyMailPanel rowId={rowId} /> : null}
              </>
            ) : null}
          </div>
          {form.reply_status || form.reply_email_id ? (
            <>
              <Field
                label={form.reply_status === "no_reply" ? "Checked on" : "Reply date"}
                type="date"
                value={form.reply_date}
                onChange={(v) =>
                  setForm({
                    ...form,
                    reply_date: v,
                    // 답장 날짜를 고쳐 적으면 후속일도 그 날 기준으로 다시 센다.
                    next_action_date: suggestFollowUp(form.reply_status, v) || form.next_action_date,
                  })
                }
              />
              <Field
                label={
                  form.reply_status === "auto_reply"
                    ? "Alternate contact (from the auto-reply)"
                    : "Reply note"
                }
                value={form.reply_note}
                onChange={(v) => setForm({ ...form, reply_note: v })}
              />
            </>
          ) : null}
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
