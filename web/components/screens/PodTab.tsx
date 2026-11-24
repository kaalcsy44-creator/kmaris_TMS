"use client";

// 8단계 Delivery Complete · POD.
// 포장(CI)별로 나눠 보낸 오더는 포장마다 운송장이 다르고 POD 도 따로 나온다 — 포장별 표에서
// 하나씩 올리고, 다 모여야 8단계가 끝난다. 나누지 않은 오더는 오더에 한 건이다.
// POD(DHL 등)를 올리면 내용을 읽어 그 포장의 빈 칸을 채우고 함께 저장한다.

import { useEffect, useRef, useState } from "react";
import {
  deletePod,
  parsePod,
  podDownloadUrl,
  savePodNotes,
  uploadPod,
  type PodParse,
} from "@/lib/api";
import { editBlockReason, getToken } from "@/lib/auth";
import { useEditGate } from "@/lib/viewMode";
import type { DocumentDetail } from "@/lib/types";

const KEYS = [
  "handover_date", "handover_place", "handed_to",
  "evidence_type", "carrier", "transport_ref", "ship_status", "service",
  "delivered_date", "delivered_time", "received_by", "destination",
  "picked_date", "picked_time", "origin", "piece_ids", "shipper_ref",
] as const;
type Key = (typeof KEYS)[number];
type Form = Record<Key, string>;

// 서버 pdf_parser.POD_TYPES 와 짝 — 읽은 문서 종류가 이 중 하나로 온다.
const EVIDENCE_TYPES = [
  "Courier proof of delivery",
  "Signed POD / delivery note",
  "Bill of Lading (on board)",
  "Sea Waybill",
  "Air Waybill",
  "Forwarder's Cargo Receipt (FCR)",
  "Mate's / dock receipt",
  "CMR / road waybill",
  "Pickup receipt (EXW)",
  "Other",
];

export type IncotermRule = { point: string; evidence: string; placeHint: string; partyHint: string } | null;
type Ci = NonNullable<DocumentDetail["cis"]>[number];
type Slot = { key: string; ciId: number; label: string; ci: Ci | null };

/** "YYYY-MM-DDTHH:MM" → "yy-mm-dd HH:MM". */
const shortDt = (iso: string) => (iso && iso.length >= 16 ? `${iso.slice(2, 10)} ${iso.slice(11, 16)}` : iso || "");
/** 운송장번호 비교용 — 띄어쓰기·하이픈 차이는 같은 번호로 본다. */
const refKey = (v: string) => v.replace(/[^0-9a-z]/gi, "").toUpperCase();

export default function PodTab({
  data,
  onChanged,
  rule,
  carriers,
  canEdit,
}: {
  data: DocumentDetail;
  onChanged: () => void;
  rule: IncotermRule;
  carriers: string[];
  canEdit: boolean;
}) {
  const orderId = data.order.id;
  const pods = data.pods ?? (data.pod ? [{ ...data.pod, ci_id: 0 }] : []);
  const cis = data.cis ?? [];
  const split = cis.length > 1;
  // 나눈 오더 = 포장(CI)마다 한 자리, 아니면 오더 전체 한 자리(key "").
  const slots: Slot[] = split
    ? cis.map((c, i) => ({ key: String(c.id), ciId: c.id, label: `#${i + 1}`, ci: c }))
    : [{ key: "", ciId: 0, label: "", ci: cis[0] ?? null }];
  const podOf = (slot: Slot) =>
    split ? pods.find((p) => p.ci_id === slot.ciId) : pods[pods.length - 1];
  // 포장별 POD 가 생기기 전에 올린(또는 나누기 전의) 오더 전체 파일.
  const wholePod = split ? pods.find((p) => !p.ci_id) : undefined;
  const complete = data.pods_complete ?? pods.length > 0;

  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const { editing: editable, readMode, fieldsetProps } = useEditGate(canEdit);
  const [sel, setSel] = useState(slots[0].key);
  const cur = slots.find((s) => s.key === sel) ?? slots[0];

  const incoterms = (data.order.doc_defaults?.incoterms || "").trim();
  const namedPlace = (data.order.doc_defaults?.delivery_place || "").trim();
  // D 조건(DAP·DPU·DDP)은 목적지 인도, 나머지는 운송사에 넘긴 때가 우리 책임의 끝이다.
  const toDestination = incoterms.slice(0, 1).toUpperCase() === "D";

  // ── 입력값: 저장본 + 기본값(지정 장소·CI 운송사). 포장마다 따로 들고 있는다. ──
  const savedNotes = data.order.pod_notes || "";
  const savedInfo = data.order.pod_info;
  const initForm = (slot: Slot): Form => {
    const flat = (savedInfo ?? {}) as Record<string, unknown>;
    const own = slot.key ? (savedInfo?.packages?.[slot.key] as Record<string, unknown> | undefined) : flat;
    // 나누기 전에 오더에 적어 둔 기록은 첫 포장의 시작값으로 이어받는다.
    const src = own ?? (slot.key && slot.key === slots[0].key ? flat : {});
    const f = Object.fromEntries(KEYS.map((k) => [k, String(src[k] ?? "")])) as Form;
    if (!f.handover_place && namedPlace) f.handover_place = namedPlace;
    const carrier = String(slot.ci?.shipping?.carrier ?? "").trim();
    if (!f.carrier && carrier && carrier !== "TBD") f.carrier = carrier;
    // CI 의 B/L·AWB 칸에는 "TBD"·"Original B/L" 같은 말도 들어간다 — 번호일 때만 가져온다.
    const awb = String(slot.ci?.shipping?.bl_awb_no ?? "").trim();
    if (!f.transport_ref && /\d{4,}/.test(awb)) f.transport_ref = awb;
    return f;
  };
  const initAll = () => Object.fromEntries(slots.map((s) => [s.key, initForm(s)])) as Record<string, Form>;
  const savedKey = JSON.stringify([savedNotes, savedInfo ?? null, slots.map((s) => s.key)]);
  const [forms, setForms] = useState<Record<string, Form>>(initAll);
  const [notes, setNotes] = useState(savedNotes);
  const lastInit = useRef<{ forms: Record<string, Form>; notes: string }>({ forms, notes });
  useEffect(() => {
    // 저장본이 바뀌면 다시 맞추되, 다른 포장에 아직 저장 안 한 편집이 있으면 그것은 지킨다
    // (한 포장의 POD 를 올리면 그 포장만 저장된다).
    const fresh = initAll();
    const prev = lastInit.current;
    setForms((now) => {
      const out: Record<string, Form> = {};
      for (const k of Object.keys(fresh)) {
        const mine = now[k];
        out[k] = mine && prev.forms[k] && KEYS.some((f) => mine[f] !== prev.forms[k][f]) && !justSaved.current.has(k) ? mine : fresh[k];
      }
      return out;
    });
    setNotes((n) => (n !== prev.notes && !justSaved.current.has("notes") ? n : savedNotes));
    justSaved.current.clear();
    lastInit.current = { forms: fresh, notes: savedNotes };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);
  const justSaved = useRef<Set<string>>(new Set());

  const form = forms[cur.key] ?? initForm(cur);
  const setF = (k: Key, v: string) => setForms((p) => ({ ...p, [cur.key]: { ...(p[cur.key] ?? initForm(cur)), [k]: v } }));
  const changed = (slot: Slot) => {
    const a = forms[slot.key];
    const b = initForm(slot);
    return !!a && KEYS.some((k) => a[k] !== b[k]);
  };
  const dirty = notes !== savedNotes || slots.some(changed);
  const hasEntry = !!savedNotes || Object.keys(savedInfo ?? {}).length > 0 || pods.length > 0;

  /** 저장 요청 — 나눈 오더는 포장별로, 아니면 오더 기록으로. */
  const payload = (list: Slot[], src: Record<string, Form>) =>
    split
      ? { packages: Object.fromEntries(list.map((s) => [s.key, src[s.key] ?? initForm(s)])) }
      : { info: src[""] ?? initForm(slots[0]) };

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setErr("");
    setMsg("");
    try {
      await fn();
    } catch (x) {
      setErr(x instanceof Error ? x.message : "Failed");
    } finally {
      setBusy("");
    }
  }

  /** POD 에서 읽은 값을 빈 칸에만 얹는다 — 사람이 적은 값은 두고, 다르면 알려 준다. */
  function applyParsed(base: Form, p: PodParse): { next: Form; filled: number; differ: string[] } {
    const next = { ...base };
    let filled = 0;
    const differ: string[] = [];
    const put = (k: Key, v: string, label: string) => {
      if (!v) return;
      if (!next[k].trim()) {
        next[k] = v;
        filled++;
      } else if (refKey(next[k]) !== refKey(v)) differ.push(`${label}: “${next[k]}” kept, POD says “${v}”`);
    };
    put("transport_ref", p.waybill_no, "Waybill");
    put("carrier", p.carrier, "Carrier");
    put("ship_status", p.ship_status, "Status");
    put("service", p.service, "Service");
    put("delivered_date", p.delivered_date, "Delivered date");
    put("delivered_time", p.delivered_time, "Delivered time");
    put("received_by", p.signed_by, "Signed by");
    put("destination", p.destination, "Destination");
    put("picked_date", p.picked_date, "Picked up date");
    put("picked_time", p.picked_time, "Picked up time");
    put("origin", p.origin, "Origin");
    put("piece_ids", p.piece_ids, "Piece ID(s)");
    put("shipper_ref", p.shipper_ref, "Shipper reference");
    put("evidence_type", EVIDENCE_TYPES.includes(p.document_type) ? p.document_type : "", "Evidence document");
    // 책임 종료 시점 — D 조건은 배달된 때·받은 사람, 나머지는 운송사가 가져간 때·운송사.
    if (!next.handover_date) next.handover_date = toDestination ? p.delivered_date : p.picked_date;
    if (!next.handed_to) next.handed_to = toDestination ? p.signed_by : p.carrier;
    return { next, filled, differ };
  }

  function upload(slot: Slot, file: File) {
    setSel(slot.key);
    return run("Reading…", async () => {
      let parsed: PodParse | null = null;
      let readErr = "";
      try {
        parsed = await parsePod(file);
      } catch (x) {
        readErr = x instanceof Error ? x.message : "could not be read";
      }
      const no = parsed ? refKey(parsed.waybill_no) : "";
      // 같은 운송장이 다른 포장에 이미 적혀 있으면 잘못 올린 것이기 쉽다.
      const twin = no
        ? slots.find((s) => s.key !== slot.key && refKey((forms[s.key] ?? initForm(s)).transport_ref) === no)
        : undefined;
      if (twin && !confirm(`Waybill ${parsed?.waybill_no} is already on package ${twin.label}. Upload this POD to package ${slot.label} anyway?`)) return;
      setBusy("Uploading…");
      await uploadPod(orderId, file, slot.ciId);
      const bits: string[] = [];
      const base = forms[slot.key] ?? initForm(slot);
      if (parsed) {
        const { next, filled, differ } = applyParsed(base, parsed);
        const src = { ...forms, [slot.key]: next };
        setForms(src);
        justSaved.current.add(slot.key);
        justSaved.current.add("notes");
        await savePodNotes(orderId, notes, payload([slot], src));
        bits.push(filled ? `POD uploaded — ${filled} field(s) read and saved.` : "POD uploaded.");
        if (parsed.ship_status && !/deliver/i.test(parsed.ship_status)) bits.push(`Status on the POD: ${parsed.ship_status}.`);
        if (differ.length) bits.push(`Check — ${differ.join("; ")}.`);
      } else {
        bits.push(`POD uploaded. It could not be read automatically (${readErr}) — fill in the fields by hand.`);
      }
      onChanged();
      setMsg(bits.join(" "));
    });
  }

  const pickFile = (slot: Slot) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file && orderId) void upload(slot, file);
  };

  const save = () => run("Saving…", async () => {
    slots.forEach((s) => justSaved.current.add(s.key));
    justSaved.current.add("notes");
    // 나눈 오더에서 손대지 않은 포장은 보내지 않는다 — 기본값만으로 기록이 생기지 않게.
    await savePodNotes(orderId, notes, payload(split ? slots.filter(changed) : slots, forms));
    onChanged();
  });

  function cancel() {
    setForms(initAll());
    setNotes(savedNotes);
    setErr("");
    setMsg("");
  }

  const removeFile = (proof: { id: number; filename: string }) => {
    if (!confirm(`Delete the POD file “${proof.filename}”? (stage 8 completion may be undone)`)) return;
    void run("Deleting…", async () => {
      await deletePod(orderId, proof.id);
      onChanged();
    });
  };

  // 단계 기록 전체 삭제 — 인도 기록·메모·증빙 파일(→ 8단계 완료도 풀린다).
  const removeEntry = () => {
    if (!confirm(`Delete this stage's entry? (handover records, notes and ${pods.length || "any"} POD file(s) — stage 8 completion will be undone)`)) return;
    void run("Deleting…", async () => {
      [...slots.map((s) => s.key), "notes"].forEach((k) => justSaved.current.add(k));
      await savePodNotes(orderId, "", { info: {}, packages: Object.fromEntries(cis.map((c) => [String(c.id), {}])) });
      if (pods.length) await deletePod(orderId);
      onChanged();
    });
  };

  const download = (proof: { id: number; filename: string }) =>
    run("Opening…", async () => {
      const res = await fetch(podDownloadUrl(orderId, proof.id), {
        headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
      });
      if (!res.ok) throw new Error("Download failed");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = proof.filename || "POD";
      a.click();
      URL.revokeObjectURL(url);
    });

  const uploadBtn = (slot: Slot, has: boolean) =>
    editable ? (
      <label className={`btn sm${has ? "" : " primary"}`} style={{ cursor: busy ? "default" : "pointer" }}>
        {busy && cur.key === slot.key ? busy : has ? "Replace" : "Upload POD"}
        <input type="file" hidden accept=".pdf,image/*" onChange={pickFile(slot)} disabled={!!busy} />
      </label>
    ) : null;

  const text = (k: Key, label: string, opt: { type?: string; placeholder?: string; span2?: boolean; list?: string[] } = {}) => (
    <label className={`form-field${opt.span2 ? " form-field--span2" : ""}`}>
      <span>{label}</span>
      <input
        type={opt.type ?? "text"}
        value={form[k]}
        placeholder={opt.placeholder}
        list={opt.list?.length ? `pod-${k}` : undefined}
        onChange={(e) => setF(k, e.target.value)}
      />
      {opt.list?.length ? <datalist id={`pod-${k}`}>{opt.list.map((o) => <option key={o} value={o} />)}</datalist> : null}
    </label>
  );

  const got = slots.filter((s) => podOf(s)).length;
  const singlePod = split ? undefined : podOf(slots[0]);
  const pkgTitle = split ? ` — package ${cur.label}${cur.ci?.ci_no ? ` · ${cur.ci.ci_no}` : ""}` : "";

  return (
    <div className="doc-tab">
      <div className="milestone-row" style={{ marginBottom: 12 }}>
        <span className={`ar-badge${complete ? "" : " overdue"}`}>{complete ? "Done" : "Pending"}</span>
        {split ? (
          <span className="hint-inline">
            {wholePod ? "One POD covers the whole order." : `${got} / ${slots.length} PODs received — stage 8 completes when every package has its POD.`}
          </span>
        ) : null}
      </div>

      {/* ① 거래조건 — 어디서 우리 책임이 끝나는지(Incoterms 인도 지점). 읽기 전용: 값의 정본은 P/O·견적. */}
      <div className="stage-card">
        <div className="form-section-title">Delivery terms (Incoterms® 2020)</div>
        <dl className="intl-meta">
          <div><dt>Incoterms</dt><dd>{incoterms || "—"}</dd></div>
          <div><dt>Named place</dt><dd>{namedPlace || "—"}</dd></div>
          <div>
            <dt>Our responsibility ends</dt>
            <dd>{rule ? rule.point : "Set Incoterms on the customer P/O (stage 5) or quotation."}</dd>
          </div>
          {rule ? <div><dt>Typical evidence</dt><dd>{rule.evidence}</dd></div> : null}
        </dl>
      </div>

      {/* ② POD 파일 — 올리면 읽어서 아래 칸을 채운다. 다운로드는 읽기모드에서도 되도록 fieldset 밖에 둔다. */}
      <div className="stage-card">
        <div className="form-section-title">{split ? "Proof of delivery by package" : "Proof of delivery"}</div>
        {split ? (
          <div className="table-wrap pod-table-wrap">
            <table className="pod-table">
              <thead>
                <tr><th>Package</th><th>Waybill / AWB No.</th><th>Delivered</th><th>Signed by</th><th>POD file</th><th /></tr>
              </thead>
              <tbody>
                {slots.map((s) => {
                  const f = forms[s.key] ?? initForm(s);
                  const p = podOf(s);
                  return (
                    <tr key={s.key} className={s.key === cur.key ? "on" : ""} onClick={() => setSel(s.key)}>
                      <td><b>{s.label}</b> {s.ci?.ci_no || ""}</td>
                      <td>{[f.carrier, f.transport_ref].filter(Boolean).join(" ") || "—"}</td>
                      <td>{[f.delivered_date, f.delivered_time].filter(Boolean).join(" ") || "—"}</td>
                      <td>{f.received_by || "—"}</td>
                      <td>
                        {p ? (
                          <button type="button" className="pod-file-link" title={p.uploaded_at ? `Uploaded ${shortDt(p.uploaded_at)} — download` : "Download"}
                                  onClick={(e) => { e.stopPropagation(); void download(p); }}>
                            📄 {p.filename}
                          </button>
                        ) : <span className="pod-none">{wholePod ? "—" : "Not uploaded"}</span>}
                      </td>
                      <td className="pod-act" onClick={(e) => e.stopPropagation()}>
                        {uploadBtn(s, !!p)}
                        {p && editable ? (
                          <button type="button" className="btn sm danger" disabled={!!busy} onClick={() => removeFile(p)}>Remove</button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
                {wholePod ? (
                  <tr>
                    <td colSpan={4}>Whole order (uploaded before the packages were split)</td>
                    <td><button type="button" className="pod-file-link" onClick={() => void download(wholePod)}>📄 {wholePod.filename}</button></td>
                    <td className="pod-act">
                      {editable ? <button type="button" className="btn sm danger" disabled={!!busy} onClick={() => removeFile(wholePod)}>Remove</button> : null}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="pod-current">
            {singlePod ? (
              <>
                <span className="pod-file">📄 {singlePod.filename}</span>
                {singlePod.uploaded_at ? <span className="pod-when">Uploaded {shortDt(singlePod.uploaded_at)}</span> : null}
                <button type="button" className="btn sm" onClick={() => void download(singlePod)} disabled={!!busy}>Download</button>
              </>
            ) : (
              <span className="hint-inline">No POD (proof of delivery) file yet.</span>
            )}
            <span style={{ marginLeft: "auto" }} />
            {uploadBtn(slots[0], !!singlePod)}
            {singlePod && editable ? (
              <button type="button" className="btn sm danger" onClick={() => removeFile(singlePod)} disabled={!!busy}>Remove file</button>
            ) : null}
          </div>
        )}
        <div className="pod-msgs">
          {msg ? <span className="action-ok">{msg}</span> : null}
          {err ? <span className="action-err">{err}</span> : null}
          <span className="hint-inline">
            {rule ? `${rule.evidence} — ` : ""}PDF · image. The POD (DHL, FedEx, UPS …) is read automatically and fills the empty fields below
            {split ? "; select a row to see or edit that package." : ". Uploading completes stage 8."}
          </span>
        </div>
      </div>

      <fieldset {...fieldsetProps}>
        {/* ③ 운송사 POD 에 찍힌 값 — 고른 포장의 것. */}
        <div className="stage-card">
          <div className="form-section-title">Delivery record{pkgTitle}</div>
          <div className="form-grid form-grid--cols4">
            {text("carrier", "Carrier", { list: carriers, placeholder: "DHL" })}
            {text("transport_ref", "Waybill · AWB · B/L No.", { placeholder: "7000133921" })}
            {text("service", "Service", { placeholder: "EXPRESS WORLDWIDE" })}
            {text("ship_status", "Shipment status", { placeholder: "Delivered", list: ["Delivered", "In transit", "Out for delivery", "Returned"] })}
            {text("delivered_date", "Delivered date", { type: "date" })}
            {text("delivered_time", "Delivered time", { type: "time" })}
            {text("received_by", "Signed by", { placeholder: "Name on the POD" })}
            {text("destination", "Destination", { placeholder: "BATAM, INDONESIA" })}
            {text("picked_date", "Picked up date", { type: "date" })}
            {text("picked_time", "Picked up time", { type: "time" })}
            {text("origin", "Origin", { placeholder: "BUSAN, KOREA", span2: true })}
            {text("piece_ids", "Piece ID(s)", { span2: true })}
            {text("shipper_ref", "Shipper reference")}
            <label className="form-field">
              <span>Evidence document</span>
              <select value={form.evidence_type} onChange={(e) => setF("evidence_type", e.target.value)}>
                <option value="">Select…</option>
                {(EVIDENCE_TYPES.includes(form.evidence_type) || !form.evidence_type ? EVIDENCE_TYPES : [form.evidence_type, ...EVIDENCE_TYPES])
                  .map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
          </div>
        </div>

        {/* ④ 인도 기록 — Incoterms 책임 종료 시점의 날짜·장소·상대. */}
        <div className="stage-card">
          <div className="form-section-title">Handover — end of our responsibility{pkgTitle}</div>
          <div className="form-grid form-grid--cols4">
            {text("handover_date", "Handover date", { type: "date" })}
            {text("handover_place", "Handover place", { placeholder: rule?.placeHint || "Port / warehouse / vessel", list: namedPlace ? [namedPlace] : [] })}
            {text("handed_to", "Handed over to", { placeholder: rule?.partyHint || "Carrier / forwarder / consignee", span2: true })}
            <label className="form-field form-field--full">
              <span>Notes{split ? " (whole order)" : ""}</span>
              <textarea
                className="po-textarea small"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Delivery remarks (carrier, consignee contact, damage, etc.)"
              />
            </label>
          </div>
        </div>
      </fieldset>

      <div className="form-actions stage-actions" style={{ marginTop: 14 }}>
        {!editable ? (
          readMode ? null : <span className="hint-inline">{editBlockReason("documents", data.order.assignee_id)}</span>
        ) : (
          <button className="btn primary" disabled={!!busy || !dirty || orderId === 0} onClick={save}>
            {busy || (dirty ? "Save" : "Saved")}
          </button>
        )}
        <button className="btn" disabled={!!busy || !dirty} onClick={cancel}>
          Cancel
        </button>
        {hasEntry && editable ? (
          <button className="btn danger" disabled={!!busy} onClick={removeEntry}>
            Delete
          </button>
        ) : null}
      </div>
    </div>
  );
}
