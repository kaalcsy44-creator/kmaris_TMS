"use client";

// 재요청 RFQ — 견적을 내고 멈춘 딜에 같은 배·같은 품목의 RFQ 가 다시 온 경우(수량만 바뀌는 식).
// 딜은 하나로 두고 RFQ #1·#2… 를 쌓는다. 1단계 폼은 늘 마지막 RFQ 를 고치고, 앞선 RFQ 는
// 여기서 읽기 전용으로 본다. 2~4단계 문서가 몇 번째 RFQ 것인지는 서버가 날짜로 가린다.

import { useEffect, useMemo, useState } from "react";
import { addRfqRound, fetchRfqDetail } from "@/lib/api";
import type { CustomerOption, RfqItem, RfqRound } from "@/lib/types";
import Modal from "@/components/common/Modal";
import RecordStrip from "@/components/common/RecordStrip";

const CHANNELS = ["Email", "Phone", "SMS", "WhatsApp", "WeChat", "Other"];

function nowLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 문서가 몇 번째 RFQ 것인가 — 재요청이 없는 딜(0)에서는 아무것도 그리지 않는다. */
export function RoundTag({ round, current }: { round?: number; current?: number }) {
  if (!round) return null;
  return (
    <span className={`rfq-round-tag${current && round < current ? " old" : ""}`} title={`Belongs to RFQ #${round}`}>
      RFQ #{round}
    </span>
  );
}

/** 2~4단계 머리 안내 — 지금 RFQ 에 대한 문서가 아직 없을 때. */
export function RoundTodo({ rows, text }: { rows: { round?: number; rfq_round?: number }[]; text: string }) {
  const current = Math.max(0, ...rows.map((r) => r.rfq_round || 0));
  if (current < 2 || rows.some((r) => (r.round || 0) >= current)) return null;
  return (
    <div className="rfq-round-todo">
      <b>RFQ #{current}</b> — {text} Records below belong to the earlier RFQ.
    </div>
  );
}

/** 처음 열 때 고를 레코드 — 재요청이 있으면 가장 나중 RFQ 의 것. */
export function latestRoundRow<T extends { round?: number }>(rows: T[]): T {
  const top = Math.max(0, ...rows.map((r) => r.round || 0));
  return rows.find((r) => (r.round || 0) === top) ?? rows[0];
}

type DiffItem = { lid?: string; part_no: string; description: string; qty: number | string | null; row_kind?: string };
const nameOf = (it: DiffItem) => it.description || it.part_no || "—";
const counted = (it: DiffItem) => it.row_kind !== "option" && !!(it.part_no.trim() || it.description.trim());

/** 앞선 RFQ 와 달라진 점 — 수량·추가·빠짐. */
export function RoundDiff({ prevNo, prev, now }: { prevNo: number; prev: DiffItem[]; now: DiffItem[] }) {
  const before = prev.filter(counted);
  const after = now.filter(counted);
  const byLid = new Map(before.filter((b) => b.lid).map((b) => [b.lid as string, b]));
  const changed: string[] = [];
  const added: string[] = [];
  for (const it of after) {
    const b = it.lid ? byLid.get(it.lid) : undefined;
    if (!b) added.push(`${nameOf(it)} × ${Number(it.qty) || 1}`);
    else if (Number(b.qty) !== Number(it.qty)) changed.push(`${nameOf(it)}: Qty ${Number(b.qty)} → ${Number(it.qty)}`);
  }
  const kept = new Set(after.map((a) => a.lid).filter(Boolean));
  const gone = before.filter((b) => b.lid && !kept.has(b.lid)).map(nameOf);
  return (
    <div className="rfq-round-diff">
      <b>Compared with RFQ #{prevNo}</b>
      {!changed.length && !added.length && !gone.length ? <span> — no change in items or quantities.</span> : (
        <ul>
          {changed.map((t, i) => <li key={`c${i}`}>{t}</li>)}
          {added.map((t, i) => <li key={`a${i}`}><span className="rfq-round-add">New</span> {t}</li>)}
          {gone.map((t, i) => <li key={`g${i}`}><span className="rfq-round-gone">Not requested</span> {t}</li>)}
        </ul>
      )}
    </div>
  );
}

/** 1단계 맨 위 — RFQ 탭과 추가 버튼. 재요청이 없고 추가도 못 하면 그리지 않는다. */
export function RfqRoundBar({
  rounds, viewNo, onView, canAdd, addBlocked, onAdd, onRemove, busy,
}: {
  rounds: RfqRound[];
  viewNo: number;
  onView: (no: number) => void;
  canAdd: boolean;
  /** 추가할 수 없는 까닭(고객 P/O 가 있음 등). 비면 추가할 수 있다. */
  addBlocked: string;
  onAdd: () => void;
  onRemove?: () => void;
  busy?: boolean;
}) {
  const many = rounds.length > 1;
  if (!many && !canAdd) return null;
  return (
    <div className="rfq-round-bar">
      {many ? (
        <RecordStrip activeKey={viewNo} ariaLabel="RFQs of this project">
          {rounds.map((r) => (
            <button key={r.no} type="button" className={r.no === viewNo ? "on" : ""} onClick={() => onView(r.no)}>
              RFQ #{r.no} · {r.received_at.slice(0, 10) || "—"}
              {r.customer_rfq_no ? <span className="rec-quote-no">{r.customer_rfq_no}</span> : null}
              {r.current ? <span className="rfq-round-tag">Current</span> : null}
            </button>
          ))}
        </RecordStrip>
      ) : null}
      {canAdd ? (
        <span className="rfq-round-acts">
          {many && onRemove ? (
            <button type="button" className="btn sm" disabled={busy} onClick={onRemove}
                    title="Remove the latest RFQ and go back to the one before it">
              Remove RFQ #{rounds.length}
            </button>
          ) : null}
          <button type="button" className="btn sm" disabled={busy || !!addBlocked} onClick={onAdd}
                  title={addBlocked || "The customer sent the RFQ again (changed quantity, re-opened enquiry…)"}>
            ＋ Add RFQ
          </button>
        </span>
      ) : null}
    </div>
  );
}

/** 앞선 RFQ — 읽기 전용. */
export function PastRfqView({ round, prev }: { round: RfqRound; prev?: RfqRound }) {
  const cols: { key: "type" | "serial_no" | "maker" | "remark"; label: string }[] = (
    [
      { key: "type", label: "Type" }, { key: "serial_no", label: "Serial No." },
      { key: "maker", label: "Maker" }, { key: "remark", label: "Remark" },
    ] as const
  ).filter((c) => round.items.some((it) => it[c.key]));
  return (
    <div className="rfq-round-past">
      <p className="hint-inline">
        RFQ #{round.no} is kept as history and cannot be edited. Vendor RFQs and quotations made for it stay in stages 2–4, marked “RFQ #{round.no}”.
      </p>
      <dl className="rfq-round-meta">
        <div><dt>RFQ received at</dt><dd>{round.received_at.replace("T", " ") || "—"}</dd></div>
        <div><dt>Customer RFQ No.</dt><dd>{round.customer_rfq_no || "—"}</dd></div>
        <div><dt>Customer contact</dt><dd>{round.contact_person || "—"}</dd></div>
        <div><dt>Request method</dt><dd>{round.request_channel || "—"}</dd></div>
      </dl>
      {prev ? <RoundDiff prevNo={prev.no} prev={prev.items} now={round.items} /> : null}
      <div className="table-wrap item-box">
        <table className="mini">
          <thead>
            <tr>
              <th className="seq">#</th><th>Part No.</th><th>Description</th>
              {cols.map((c) => <th key={c.key}>{c.label}</th>)}
              <th className="num">Qty</th><th>Unit</th>
            </tr>
          </thead>
          <tbody>
            {round.items.map((it, i) => (
              <tr key={i}>
                <td className="seq">{i + 1}</td>
                <td className="wrapcell">{it.part_no || "—"}</td>
                <td className="desc">{it.description || "—"}</td>
                {cols.map((c) => <td key={c.key} className="wrapcell">{it[c.key] || ""}</td>)}
                <td className="num">{it.qty}</td>
                <td>{it.unit || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {round.notes ? <p className="rfq-round-notes"><b>Notes</b> {round.notes}</p> : null}
      {round.source_files.length ? (
        <p className="hint-inline">📎 {round.source_files.map((f) => f.name).join(", ")}</p>
      ) : null}
    </div>
  );
}

type Line = RfqItem & { use: boolean; newQty: string };

/** RFQ 추가 창 — 앞선 RFQ 의 품목을 그대로 깔고 바뀐 수량만 고친다. */
export function AddRfqRoundModal({
  rfqId, contacts, contactId, onClose, onAdded,
}: {
  rfqId: number;
  contacts: CustomerOption[];
  contactId: number | "";
  onClose: () => void;
  onAdded: (roundNo: number) => void;
}) {
  const [prevNo, setPrevNo] = useState(0);
  const [prevAt, setPrevAt] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [at, setAt] = useState(nowLocal());
  const [refNo, setRefNo] = useState("");
  const [channel, setChannel] = useState("");
  const [contact, setContact] = useState<number | "">(contactId);
  const [notes, setNotes] = useState("");
  const [mode, setMode] = useState<"same" | "empty">("same");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 저장된 값에서 시작한다 — 폼에 아직 저장하지 않은 수정이 섞이지 않게.
  useEffect(() => {
    let alive = true;
    fetchRfqDetail(rfqId)
      .then((d) => {
        if (!alive) return;
        setPrevNo(d.round_no || 1);
        setPrevAt(d.received_at || d.first_rfq_at || "");
        setChannel(d.request_channel || "");
        setLines(d.items.map((it) => ({ ...it, use: true, newQty: String(it.qty ?? 1) })));
      })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Failed to load the RFQ"); });
    return () => { alive = false; };
  }, [rfqId]);

  const patch = (i: number, p: Partial<Line>) => setLines((v) => v.map((l, x) => (x === i ? { ...l, ...p } : l)));
  const picked = useMemo(() => lines.filter((l) => l.use), [lines]);
  const badQty = mode === "same" && picked.some((l) => l.row_kind !== "option" && !(Number(l.newQty) > 0));
  const early = !!prevAt && !!at && at <= prevAt;

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const r = await addRfqRound(rfqId, {
        received_at: at,
        customer_rfq_no: refNo,
        request_channel: channel,
        customer_id: contact === "" ? undefined : contact,
        notes,
        items: mode === "empty" ? [] : picked.map((l) => ({
          part_no: l.part_no || "", description: l.description || "", type: l.type || "", serial_no: l.serial_no || "",
          maker: l.maker || "", grade: l.grade || "", qty: Number(l.newQty) || 1, unit: l.unit || "", remark: l.remark || "",
          category_id: l.category_id ?? null, applied_to: l.applied_to ?? null, row_kind: l.row_kind || "", lid: l.lid || "",
        })),
      });
      onAdded(r.round_no);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to add the RFQ");
      setBusy(false);
    }
  }

  return (
    <Modal title={`＋ Add RFQ${prevNo ? ` #${prevNo + 1}` : ""}`} onClose={onClose} form maxWidth={820}>
      <p className="hint-inline">
        The customer asked again for the same project. RFQ #{prevNo || 1} with its vendor RFQs and quotations is kept as history,
        and stages 2–4 start again for this RFQ.
      </p>
      <div className="form-grid" style={{ marginTop: 10 }}>
        <div className="form-field">
          <label>RFQ received at *</label>
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
          {early ? <div className="action-err">Must be after RFQ #{prevNo} ({prevAt.replace("T", " ")}).</div> : null}
        </div>
        <div className="form-field">
          <label>Customer RFQ No.</label>
          <input value={refNo} onChange={(e) => setRefNo(e.target.value)} placeholder="Reference of this RFQ (optional)" />
        </div>
        <div className="form-field">
          <label>Request method</label>
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">Select…</option>
            {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        {contacts.length > 1 ? (
          <div className="form-field">
            <label>Customer contact</label>
            <select value={contact} onChange={(e) => setContact(e.target.value === "" ? "" : Number(e.target.value))}>
              {contacts.map((c) => <option key={c.id} value={c.id}>{c.contact?.trim() || "(no contact)"}</option>)}
            </select>
          </div>
        ) : null}
      </div>

      <div className="items-head" style={{ marginTop: 14 }}>
        <div className="sub-h">Items</div>
        <div className="rfq-round-mode" role="group" aria-label="How to fill the items">
          <label><input type="radio" checked={mode === "same"} onChange={() => setMode("same")} /> Same items as RFQ #{prevNo || 1}</label>
          <label><input type="radio" checked={mode === "empty"} onChange={() => setMode("empty")} /> Empty — fill in later (Auto-fill)</label>
        </div>
      </div>
      {mode === "same" ? (
        <div className="table-wrap item-box">
          <table className="mini">
            <thead>
              <tr>
                <th style={{ width: 32 }} /><th className="seq">#</th><th>Part No.</th><th>Description</th>
                <th className="num">RFQ #{prevNo || 1}</th><th className="num">New qty</th><th>Unit</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const head = l.row_kind === "option";
                return (
                  <tr key={i} className={l.use ? "" : "rfq-round-off"}>
                    <td><input type="checkbox" checked={l.use} onChange={(e) => patch(i, { use: e.target.checked })}
                               aria-label={`Request line ${i + 1} again`} /></td>
                    <td className="seq">{i + 1}</td>
                    <td className="wrapcell">{l.part_no || "—"}</td>
                    <td className="desc">{l.description || "—"}</td>
                    <td className="num">{head ? "" : l.qty}</td>
                    <td className="num">{head ? "" : (
                      <input className={`num rfq-round-qty${Number(l.newQty) !== Number(l.qty) ? " changed" : ""}`} inputMode="decimal"
                             value={l.newQty} disabled={!l.use} onChange={(e) => patch(i, { newQty: e.target.value })}
                             aria-label={`New quantity of line ${i + 1}`} />
                    )}</td>
                    <td>{l.unit || ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="hint-inline">After adding, press Edit and use Auto-fill. Lines with the same part number are linked to the earlier RFQ when saved.</p>
      )}
      <p className="hint-inline">Untick a line that is not requested this time. New lines can be added after saving.</p>

      <div className="form-field" style={{ marginTop: 10 }}>
        <label>Notes</label>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Why it came back, what changed (optional)" />
      </div>
      <div className="form-actions stage-actions">
        <button type="button" className="btn primary" onClick={submit}
                disabled={busy || !prevNo || !at || early || badQty || (mode === "same" && !picked.length)}>
          {busy ? "Adding…" : `Add RFQ #${(prevNo || 1) + 1}`}
        </button>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        {badQty ? <span className="action-err">Enter a quantity for every ticked line.</span> : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </Modal>
  );
}
