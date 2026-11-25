"use client";

// 재요청 RFQ 추가 · 품목 수정 창 — 앞선 RFQ 와 나란히 놓고 고친다.
// 재요청은 수량만 바뀌어 오지 않는다: 내용 수정, 일부 삭제, 다른 품목으로 교체, 추가, 새 문서로
// 통째 갱신. 줄마다 "앞선 RFQ 의 어느 품목인가"를 쥐고 있어야 벤더 견적·가격 이력이 이어진다 —
// 같은 품목이면 이름(lid)을 잇고, 다른 품목으로 바뀌었으면 새 이름을 받는다.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  addRfqRound, fetchRfqDetail, matchRfqRoundItems, parseRfqPdf, updateRfq, uploadRfqDriveFiles, DRIVE_MAX_UPLOAD,
  type RfqItemBody,
} from "@/lib/api";
import type { CustomerOption, RfqItem, RfqSourceFile } from "@/lib/types";
import Modal from "@/components/common/Modal";
import MakerCell from "@/components/common/MakerCell";
import { ItemGridHint, useItemGridKeys } from "@/components/common/itemTable";
import { lineChanges } from "@/components/common/RfqRounds";
import { imageFromClipboard } from "@/lib/imagePaste";
import { orCancelled, useScanCancel } from "@/lib/useScanCancel";

const CHANNELS = ["Email", "Phone", "SMS", "WhatsApp", "WeChat", "Other"];

function nowLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

type Field = "part_no" | "description" | "type" | "serial_no" | "maker" | "qty" | "unit" | "remark";

type Line = {
  key: number;
  /** 앞선 RFQ 의 그 품목 — 없으면 새 줄. */
  base: RfqItem | null;
  /** 이번에도 요청하는가(끄면 이번 RFQ 에서 빠진다). */
  use: boolean;
  /** 같은 품목인가 다른 품목으로 바뀌었나. null = 내용을 보고 짐작. */
  kind: "same" | "other" | null;
  /** 자동 입력 문서에 있던 줄. */
  scanned: boolean;
  part_no: string; description: string; type: string; serial_no: string; maker: string;
  qty: string; unit: string; remark: string;
  grade: string; category_id: number | null; applied_to: number | null; row_kind: string; lid: string;
};

let seq = 0;
function toLine(it: RfqItem, base: RfqItem | null, use = true): Line {
  return {
    key: ++seq, base, use, kind: null, scanned: false,
    part_no: it.part_no || "", description: it.description || "", type: it.type || "", serial_no: it.serial_no || "",
    maker: it.maker || "", qty: String(it.qty ?? 1), unit: it.unit || "", remark: it.remark || "", grade: it.grade || "",
    category_id: it.category_id ?? null, applied_to: it.applied_to ?? null, row_kind: it.row_kind || "", lid: it.lid || "",
  };
}
const blankLine = (): Line => ({
  key: ++seq, base: null, use: true, kind: null, scanned: false, part_no: "", description: "", type: "", serial_no: "",
  maker: "", qty: "1", unit: "", remark: "", grade: "", category_id: null, applied_to: null, row_kind: "", lid: "",
});

const filled = (l: Line) => !!(l.part_no.trim() || l.description.trim());
const isHead = (l: Line) => l.row_kind === "option";
const code = (v: string) => v.replace(/[^0-9a-z가-힣]/gi, "").toLowerCase();
const words = (v: string) => new Set(v.toLowerCase().split(/[^0-9a-z가-힣]+/).filter((w) => w.length > 1));

/** 품번·품명이 앞선 품목과 거의 겹치지 않으면 다른 품목으로 본다(화면에서 바꿀 수 있다). */
function looksOther(b: RfqItem, l: Line): boolean {
  const x = words(b.description || ""), y = words(l.description);
  let hit = 0;
  for (const w of x) if (y.has(w)) hit++;
  const overlap = x.size && y.size ? hit / Math.min(x.size, y.size) : 1;
  const p = code(b.part_no || ""), q = code(l.part_no);
  if (p && q && p === q) return false;
  const partDiff = !!p && !!q && !p.includes(q) && !q.includes(p);
  return partDiff ? overlap < 0.8 : overlap < 0.34;
}
const changesOf = (l: Line) => (l.base ? lineChanges(l.base, l) : []);
const contentChanged = (l: Line) => changesOf(l).some((c) => !c.startsWith("Qty ") && !c.startsWith("Unit "));
/** 이 줄이 다른 품목으로 바뀌었나. */
const isOther = (l: Line) => !!l.base && contentChanged(l) && (l.kind ? l.kind === "other" : looksOther(l.base, l));

export default function RfqRoundEditor({
  rfqId, mode, contacts, contactId, driveOn, onClose, onDone,
}: {
  rfqId: number;
  /** add = 새 RFQ 를 쌓는다 · edit = 지금 RFQ(#2~)의 품목을 앞선 RFQ 와 견주며 고친다. */
  mode: "add" | "edit";
  contacts: CustomerOption[];
  contactId: number | "";
  driveOn: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [prevNo, setPrevNo] = useState(0);   // 견주는 앞선 RFQ
  const [prevAt, setPrevAt] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const start = useRef<Line[]>([]);
  const [oldFiles, setOldFiles] = useState<RfqSourceFile[]>([]);
  const [at, setAt] = useState(nowLocal());
  const [refNo, setRefNo] = useState("");
  const [channel, setChannel] = useState("");
  const [contact, setContact] = useState<number | "">(contactId);
  const [notes, setNotes] = useState("");
  const [more, setMore] = useState(false);       // Type · Serial No. 칸
  const [files, setFiles] = useState<RfqSourceFile[]>([]);
  const raw = useRef<File[]>([]);
  const [toDrive, setToDrive] = useState(true);
  const [dropMissing, setDropMissing] = useState(true);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const scan = useScanCancel();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const thisNo = prevNo + 1;

  // 저장된 값에서 시작한다 — 폼에 아직 저장하지 않은 수정이 섞이지 않게.
  useEffect(() => {
    let alive = true;
    fetchRfqDetail(rfqId)
      .then((d) => {
        if (!alive) return;
        const no = d.round_no || 1;
        const prevRound = mode === "edit" ? d.rounds?.[no - 2] : undefined;
        const base = prevRound ? prevRound.items : d.items;
        let rows: Line[];
        if (mode === "add") {
          rows = base.map((it) => toLine(it, it));
        } else {
          const byLid = new Map(base.filter((b) => b.lid).map((b) => [b.lid as string, b]));
          const here = new Set(d.items.map((it) => it.lid).filter(Boolean));
          rows = [
            ...d.items.map((it) => toLine(it, (it.lid && byLid.get(it.lid)) || null)),
            ...base.filter((b) => b.lid && !here.has(b.lid)).map((b) => toLine(b, b, false)),
          ];
        }
        start.current = rows;
        setLines(rows);
        setPrevNo(mode === "add" ? no : no - 1);
        setPrevAt(d.received_at || d.first_rfq_at || "");
        setChannel(d.request_channel || "");
        setOldFiles(mode === "edit" ? d.source_files || [] : []);
        setMore(rows.some((l) => l.type || l.serial_no));
      })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Failed to load the RFQ"); });
    return () => { alive = false; };
  }, [rfqId, mode]);

  const patch = (i: number, p: Partial<Line>) => setLines((v) => v.map((l, x) => (x === i ? { ...l, ...p } : l)));
  const fields: Field[] = ["part_no", "description", ...(more ? (["type", "serial_no"] as const) : []), "maker", "qty", "unit", "remark"];
  const LABEL: Record<string, string> = {
    part_no: "Part No.", description: "Description", type: "Type", serial_no: "Serial No.", maker: "Maker",
    qty: "Qty", unit: "Unit", remark: "Remark",
  };
  const W: Record<string, number> = { part_no: 130, type: 90, serial_no: 110, maker: 120, qty: 72, unit: 70, remark: 130 };
  const grid = useItemGridKeys<Line>({
    items: lines, onChange: setLines, fields: [...fields], blank: blankLine, headers: fields.map((f) => LABEL[f]),
  });

  const live = useMemo(() => lines.filter((l) => l.use && filled(l)), [lines]);
  const sum = useMemo(() => ({
    lines: live.filter((l) => !isHead(l)).length,
    changed: live.filter((l) => l.base && !isOther(l) && changesOf(l).length).length,
    replaced: live.filter(isOther).length,
    added: live.filter((l) => !l.base && !isHead(l)).length,
    gone: lines.filter((l) => l.base && !l.use && !isHead(l)).length,
  }), [live, lines]);
  const badQty = live.some((l) => !isHead(l) && !(Number(l.qty) > 0));
  const early = mode === "add" && !!prevAt && !!at && at <= prevAt;

  /** 문서 읽기 — 같은 품목은 그 줄을 고치고, 없던 품목은 새 줄로, 문서에 없는 품목은 이번 요청에서 뺀다. */
  async function readDocs(input: File[]) {
    if (!input.length) return;
    const sig = scan.begin();
    setErr(null);
    setScanMsg(null);
    try {
      const got: RfqItem[] = [];
      const done: RfqSourceFile[] = [];
      for (const f of input) {
        const r = await orCancelled(parseRfqPdf(f, sig), sig);
        if (!r) break;
        done.push({ name: f.name || "(unnamed)", media_type: f.type || "", item_count: r.items?.length ?? 0, at: nowLocal() });
        if (mode === "add" && r.customer_rfq_no) setRefNo((v) => v || r.customer_rfq_no!);
        for (const it of r.items ?? []) {
          got.push({
            part_no: it.part_no ?? "", description: it.description ?? "", type: it.type ?? "", serial_no: it.serial_no ?? "",
            maker: it.maker ?? "", qty: it.qty ?? 1, unit: it.unit ?? "", remark: it.remark ?? "", unit_price: null, amount: null,
          });
        }
      }
      if (!done.length) { setScanMsg("Cancelled — nothing was filled."); return; }
      raw.current = [...raw.current, ...input.slice(0, done.length)];
      setFiles((v) => [...v, ...done]);
      if (!got.length) { setScanMsg("No items were found in the document."); return; }
      const { lids } = await matchRfqRoundItems(rfqId, got.map((g) => ({
        part_no: g.part_no, description: g.description, type: g.type, serial_no: g.serial_no, qty: Number(g.qty) || 1,
      })));
      const byLid = new Map(lids.map((l, i) => [l, got[i]] as const).filter(([l]) => l));
      const known = new Set(lines.map((l) => l.lid).filter(Boolean));
      const hit = [...byLid.keys()].filter((l) => known.has(l)).length;
      const gone = dropMissing ? lines.filter((l) => l.base && !l.scanned && !isHead(l) && !byLid.has(l.lid)).length : 0;
      setLines((prev) => [
        ...prev.filter((l) => l.base || filled(l)).map((l) => {
          const g = l.lid ? byLid.get(l.lid) : undefined;
          if (g) {
            return {
              ...l, use: true, scanned: true, kind: "same" as const,
              part_no: g.part_no || l.part_no, description: g.description || l.description, type: g.type || l.type,
              serial_no: g.serial_no || l.serial_no, maker: g.maker || l.maker, qty: String(g.qty ?? l.qty),
              unit: g.unit || l.unit, remark: g.remark || l.remark,
            };
          }
          // 이번 문서에 없는 앞선 품목 — 앞서 읽은 문서에 있던 줄은 그대로 둔다.
          return dropMissing && l.base && !l.scanned && !isHead(l) ? { ...l, use: false } : l;
        }),
        ...got.map((g, i) => ({ g, lid: lids[i] || "" })).filter(({ lid }) => !lid || !known.has(lid))
          .map(({ g, lid }) => ({ ...toLine({ ...g, lid }, null), scanned: true })),
      ]);
      if (got.some((g) => g.type || g.serial_no)) setMore(true);
      setScanMsg(`${sig.aborted ? "Cancelled · " : ""}${hit} matched · ${got.length - hit} new${gone ? ` · ${gone} not in the document` : ""} — check the Change column.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Auto-fill failed");
    } finally {
      scan.end(sig);
    }
  }

  function onPaste(e: React.ClipboardEvent) {
    const blob = imageFromClipboard(e);
    if (!blob) return;
    e.preventDefault();
    void readDocs([blob]);
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    const items: RfqItemBody[] = live.map((l) => ({
      part_no: l.part_no, description: l.description, type: l.type, serial_no: l.serial_no, maker: l.maker, grade: l.grade,
      qty: Number(l.qty) || 1, unit: l.unit, remark: l.remark, applied_to: l.applied_to, row_kind: l.row_kind,
      // 다른 품목으로 바뀐 줄 — 이름과 분류를 물려주지 않는다(서버가 새 이름을 붙인다).
      category_id: isOther(l) ? null : l.category_id,
      lid: isOther(l) ? "" : l.lid,
    }));
    try {
      let text: string;
      if (mode === "add") {
        const r = await addRfqRound(rfqId, {
          received_at: at, customer_rfq_no: refNo, request_channel: channel,
          customer_id: contact === "" ? undefined : contact, notes, items, source_files: files,
        });
        text = `RFQ #${r.round_no} added — stages 2–4 start again for this RFQ`;
      } else {
        await updateRfq(rfqId, { items, match_lines: false, ...(files.length ? { source_files: [...oldFiles, ...files] } : {}) });
        text = `Items of RFQ #${thisNo} saved`;
      }
      const send = driveOn && toDrive ? raw.current.filter((f) => f.size <= DRIVE_MAX_UPLOAD) : [];
      if (send.length) {
        try {
          await uploadRfqDriveFiles(rfqId, send);
          text += ` · ${send.length} file(s) saved to Drive (01 RFQ)`;
        } catch (e) {
          text += ` · Drive upload failed (${e instanceof Error ? e.message : "error"}) — use 📁 Drive files`;
        }
      }
      onDone(text);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
      setBusy(false);
    }
  }

  const nothing = mode === "edit" && !live.length;
  return (
    <Modal title={mode === "add" ? `＋ Add RFQ${prevNo ? ` #${thisNo}` : ""}` : `✎ Items of RFQ #${thisNo}`} onClose={onClose} form maxWidth={1280}>
      <div onPaste={onPaste}>
        <p className="hint-inline">
          {mode === "add"
            ? `The customer asked again for the same project. RFQ #${prevNo || 1} with its vendor RFQs and quotations is kept as history, and stages 2–4 start again for this RFQ.`
            : `Compared with RFQ #${prevNo || 1}. Vendor RFQs and quotations already made for RFQ #${thisNo} are not changed.`}
        </p>
        {mode === "add" ? (
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
        ) : null}

        <div className="items-head" style={{ marginTop: 14 }}>
          <div className="sub-h">Items</div>
          <div className="items-head-actions rre-tools">
            <ItemGridHint />
            <input ref={fileRef} type="file" multiple hidden accept="application/pdf,image/png,image/jpeg,image/webp"
                   onChange={(e) => { const fl = Array.from(e.target.files ?? []); e.target.value = ""; void readDocs(fl); }} />
            {scan.active
              ? <><span className="hint-inline">AI analyzing…</span><button type="button" className="btn sm ocr-cancel" onClick={scan.cancel}>✕ Cancel</button></>
              : <button type="button" className="btn sm" disabled={busy || !prevNo} onClick={() => fileRef.current?.click()}
                        title="Read the new RFQ (PDF or image, or paste a screenshot with Ctrl+V) and compare it with the earlier RFQ">📄 Auto-fill from document</button>}
            <button type="button" className="btn sm" onClick={() => setMore((v) => !v)}>{more ? "Hide" : "Show"} Type · Serial No.</button>
            <button type="button" className="btn sm" disabled={busy} title="Discard every change in this window"
                    onClick={() => { setLines(start.current); setFiles([]); raw.current = []; setScanMsg(null); }}>↺ Reset</button>
            <button type="button" className="btn sm items-head-add" onClick={() => setLines((v) => [...v, blankLine()])}>+ Add line</button>
          </div>
        </div>
        {scanMsg ? <p className="action-ok" style={{ margin: "6px 0" }}>{scanMsg}</p> : null}
        <div className="table-wrap item-box">
          <table className="mini items-edit rre-table">
            <colgroup>
              <col style={{ width: 36 }} /><col style={{ width: 40 }} />
              {fields.map((f) => [
                f === "qty" ? <col key="prev" style={{ width: 68 }} /> : null,
                <col key={f} style={W[f] ? { width: W[f] } : undefined} />,
              ])}
              <col style={{ width: 172 }} /><col style={{ width: 40 }} />
            </colgroup>
            <thead>
              <tr>
                <th title="Ticked = requested in this RFQ" />
                <th className="seq">#</th>
                {fields.map((f) => [
                  f === "qty" ? <th key="prev" className="num">RFQ #{prevNo || 1}</th> : null,
                  <th key={f} className={f === "qty" ? "num" : ""}>{f === "qty" ? `Qty #${thisNo}` : LABEL[f]}</th>,
                ])}
                <th>Change</th><th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const head = isHead(l);
                const other = isOther(l);
                const ch = changesOf(l);
                return (
                  <tr key={l.key} className={l.use ? "" : "off"}>
                    <td><input type="checkbox" checked={l.use} onChange={(e) => patch(i, { use: e.target.checked })}
                               aria-label={`Line ${i + 1} is requested`} /></td>
                    <td className="seq">{i + 1}</td>
                    {fields.map((f, c) => {
                      const diff = l.use && l.base && f !== "remark"
                        && (f === "qty" ? Number(l.base.qty) !== Number(l.qty)
                          : String(l.base[f] || "").trim().toLowerCase() !== l[f].trim().toLowerCase());
                      const cls = diff ? " changed" : "";
                      const prevTd = f === "qty" ? <td key="prev" className="rre-prev">{l.base && !head ? Number(l.base.qty) : ""}</td> : null;
                      if (head && f !== "description") return [prevTd, <td key={f} />];
                      if (f === "maker") {
                        return [prevTd, <td key={f}><MakerCell value={l.maker} onChange={(v) => patch(i, { maker: v })} disabled={!l.use} inputProps={grid.cell(i, c)} /></td>];
                      }
                      return [prevTd, (
                        <td key={f}>
                          {f === "qty" ? (
                            <input {...grid.cell(i, c)} className={`num${cls}`} inputMode="decimal" value={l.qty} readOnly={!l.use}
                                   onChange={(e) => patch(i, { qty: e.target.value })} aria-label={`Qty of line ${i + 1}`} />
                          ) : (
                            <textarea {...grid.cell(i, c)} className={cls.trim()} rows={1} value={l[f]} readOnly={!l.use}
                                      onChange={(e) => patch(i, { [f]: e.target.value })} aria-label={`${LABEL[f]} of line ${i + 1}`} />
                          )}
                        </td>
                      )];
                    })}
                    <td className="rre-st">
                      {head ? <span className="rre-chip">Option title</span>
                        : !l.use ? <span className="rre-chip off">Not requested</span>
                        : !l.base ? <span className="rre-chip new">New</span>
                        : contentChanged(l) ? (
                          <select value={other ? "other" : "same"} title={ch.join("\n")}
                                  onChange={(e) => patch(i, { kind: e.target.value as "same" | "other" })}
                                  aria-label={`Is line ${i + 1} the same item as in RFQ #${prevNo}?`}>
                            <option value="same">Same item, edited</option>
                            <option value="other">Different item</option>
                          </select>
                        ) : ch.length ? <span className="rre-chip chg" title={ch.join("\n")}>{ch[0]}</span>
                        : <span className="rre-chip">No change</span>}
                    </td>
                    <td>
                      {l.base
                        ? l.use && (ch.length || l.kind) ? (
                          <button type="button" className="btn tiny" title={`Back to RFQ #${prevNo}`} aria-label={`Restore line ${i + 1}`}
                                  onClick={() => patch(i, { ...toLine(l.base!, l.base), key: l.key, lid: l.lid })}>↺</button>
                        ) : null
                        : <button type="button" className="btn tiny" title="Delete this new line" aria-label={`Delete line ${i + 1}`}
                                  onClick={() => setLines((v) => v.filter((_, x) => x !== i))}>✕</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="hint-inline">
          Edit any cell. Untick a line that is not requested this time. “Same item” keeps its price history and earlier vendor quotes
          next to it; “Different item” starts as a new line and the old one becomes not requested.
        </p>
        <label className="hint-inline" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={dropMissing} onChange={(e) => setDropMissing(e.target.checked)} />
          Auto-fill: lines that are not in the document become “Not requested”
        </label>
        {files.length ? (
          <div className="hint-inline" style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", alignItems: "center" }}>
            <span>📎 {files.map((f) => f.name).join(", ")}</span>
            {driveOn ? (
              <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={toDrive} onChange={(e) => setToDrive(e.target.checked)} /> Save to the Drive folder (01 RFQ)
              </label>
            ) : null}
          </div>
        ) : null}

        {mode === "add" ? (
          <div className="form-field rre-notes" style={{ marginTop: 10 }}>
            <label>Notes</label>
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Why it came back, what changed (optional)" />
          </div>
        ) : null}
        <div className="form-actions stage-actions">
          <span className="rre-sum">
            {[`${sum.lines} line${sum.lines === 1 ? "" : "s"}`, sum.changed ? `${sum.changed} changed` : "", sum.replaced ? `${sum.replaced} replaced` : "",
              sum.added ? `${sum.added} new` : "", sum.gone ? `${sum.gone} not requested` : ""].filter(Boolean).join(" · ")}
            {mode === "add" && !live.length ? " — items can also be filled in later" : ""}
          </span>
          {badQty ? <span className="action-err">Enter a quantity for every ticked line.</span> : null}
          {err ? <span className="action-err">{err}</span> : null}
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" onClick={submit}
                  disabled={busy || scan.active || !prevNo || early || badQty || nothing || (mode === "add" && !at)}>
            {busy ? "Saving…" : mode === "add" ? `Add RFQ #${thisNo}` : "Save items"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
