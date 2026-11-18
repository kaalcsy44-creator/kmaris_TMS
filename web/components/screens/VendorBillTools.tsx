"use client";

// 9단계 Payable · Vendor (AP) — 공급사 거래명세서를 다루는 도구 셋.
//
// ① VendorBillReadButton : 거래명세서(PDF·사진)를 읽어 폼 초안으로 넘긴다(저장은 사람이).
// ② BillCompare          : 청구 품목을 벤더 P/O 또는 공급사 견적과 줄마다 맞대어 보인다 —
//                          명세서를 그대로 믿고 저장하면 수량·단가가 슬쩍 바뀐 줄을 못 본다.
// ③ VendorBankFields     : 입금 계좌. 거래선 회사 단위 값이라 거래선 명부에 저장되고,
//                          Finance 지급 상세가 같은 계좌를 읽는다.
import { useMemo, useRef, useState } from "react";
import { parseVendorBill } from "@/lib/api";
import { downscaleImageFile } from "@/lib/imagePaste";
import type { BankAccount, TaxInvoiceItem, VendorBillOcr } from "@/lib/types";

const n = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : Number(v) || 0);
const fmt = (v: number) => Math.round(v * 100) / 100 === Math.round(v) ? Math.round(v).toLocaleString() : (Math.round(v * 100) / 100).toLocaleString();

// ── ① 읽기 ──────────────────────────────────────────────────────────────────
export function VendorBillReadButton({
  onRead,
  disabled,
}: {
  onRead: (b: VendorBillOcr) => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [over, setOver] = useState(false);

  async function read(file: File | null | undefined) {
    if (!file || busy) return;
    setBusy(true);
    setErr("");
    try {
      onRead(await parseVendorBill(await downscaleImageFile(file, 2000)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  }

  return (
    <div
      className={`vbill-read${over ? " over" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); void read(e.dataTransfer.files?.[0]); }}
    >
      <button type="button" className="btn sm" disabled={disabled || busy} onClick={() => ref.current?.click()}>
        {busy ? "Reading…" : "📄 Read vendor bill (PDF·image)"}
      </button>
      <span className="hint-inline">
        {busy
          ? "Reading the statement — this takes a few seconds."
          : "Drop the 거래명세서 / invoice here — fills Bill No., dates, items, totals and the bank account. Nothing is saved until you press Save."}
      </span>
      {err ? <span className="action-err">{err}</span> : null}
      <input
        ref={ref}
        type="file"
        accept=".pdf,image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => void read(e.target.files?.[0])}
      />
    </div>
  );
}

// ── ② 대조 ──────────────────────────────────────────────────────────────────
export type CompareBase = { key: string; label: string; currency: string; items: TaxInvoiceItem[] };

type Status = "same" | "qty" | "price" | "both" | "extra" | "missing";
type Line = { status: Status; bill?: TaxInvoiceItem; base?: TaxInvoiceItem };

const normPart = (v: string) => (v || "").replace(/[^0-9a-z]/gi, "").toLowerCase();
const normDesc = (v: string) => (v || "").replace(/[^0-9a-z가-힣]+/gi, " ").trim().toLowerCase();
const live = (items: TaxInvoiceItem[]) => items.filter((it) => !it.excluded && (it.description || it.part_no || n(it.qty) || n(it.unit_price)));

/** 청구 줄을 기준 줄에 하나씩 짝짓는다 — Part No. 가 둘 다 있으면 그것으로, 아니면 품명으로.
 *  기준 줄은 한 번만 쓴다(같은 품명이 두 줄이면 차례대로 짝). */
function matchLines(bill: TaxInvoiceItem[], base: TaxInvoiceItem[]): Line[] {
  const used = new Set<number>();
  const out: Line[] = [];
  const find = (b: TaxInvoiceItem) => {
    const p = normPart(b.part_no);
    if (p) {
      const i = base.findIndex((x, j) => !used.has(j) && normPart(x.part_no) === p);
      if (i >= 0) return i;
    }
    const d = normDesc(b.description);
    if (d) {
      const i = base.findIndex((x, j) => !used.has(j) && normDesc(x.description) === d);
      if (i >= 0) return i;
    }
    return -1;
  };
  for (const b of bill) {
    const i = find(b);
    if (i < 0) { out.push({ status: "extra", bill: b }); continue; }
    used.add(i);
    const x = base[i];
    const qd = Math.abs(n(b.qty) - n(x.qty)) > 1e-9;
    const pd = Math.abs(n(b.unit_price) - n(x.unit_price)) > 0.005;
    out.push({ status: qd && pd ? "both" : qd ? "qty" : pd ? "price" : "same", bill: b, base: x });
  }
  base.forEach((x, j) => { if (!used.has(j)) out.push({ status: "missing", base: x }); });
  return out;
}

const STATUS_LABEL: Record<Status, string> = {
  same: "Same",
  qty: "Qty differs",
  price: "Price differs",
  both: "Qty & price differ",
  extra: "Not on base",
  missing: "Missing on bill",
};

export function BillCompare({
  items,
  bases,
  billCurrency,
  printed,
}: {
  items: TaxInvoiceItem[];
  bases: CompareBase[];
  billCurrency: string;
  /** 명세서에 찍혀 있던 합계(읽어 온 경우) — 품목을 옮겨 적다 생긴 어긋남을 잡는다. */
  printed?: { supply: number | null; total: number | null; computedSupply: number; computedTotal: number } | null;
}) {
  const [key, setKey] = useState(bases[0]?.key ?? "");
  const [onlyDiff, setOnlyDiff] = useState(false);
  const base = bases.find((b) => b.key === key) ?? bases[0];
  const lines = useMemo(() => (base ? matchLines(live(items), live(base.items)) : []), [items, base]);
  if (!base) {
    return <div className="vbill-cmp"><span className="hint-inline">Nothing to compare with — no vendor P/O or vendor quote on this deal.</span></div>;
  }
  const counts = lines.reduce<Record<Status, number>>(
    (m, l) => ({ ...m, [l.status]: m[l.status] + 1 }),
    { same: 0, qty: 0, price: 0, both: 0, extra: 0, missing: 0 },
  );
  const sum = (arr: TaxInvoiceItem[]) => arr.reduce((t, it) => t + n(it.qty) * n(it.unit_price), 0);
  const billSub = sum(live(items));
  const baseSub = sum(live(base.items));
  const diff = billSub - baseSub;
  const shown = onlyDiff ? lines.filter((l) => l.status !== "same") : lines;
  const curMismatch = (base.currency || "KRW") !== (billCurrency || "KRW");

  return (
    <div className="vbill-cmp">
      <div className="vbill-cmp-head">
        <b>Compare with</b>
        <select value={base.key} onChange={(e) => setKey(e.target.value)}>
          {bases.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
        </select>
        <span className="vbill-chips">
          <span className="vbill-chip same">{counts.same} same</span>
          {counts.qty + counts.price + counts.both ? (
            <span className="vbill-chip warn">{counts.qty + counts.price + counts.both} differ</span>
          ) : null}
          {counts.extra ? <span className="vbill-chip warn">{counts.extra} not on base</span> : null}
          {counts.missing ? <span className="vbill-chip warn">{counts.missing} missing on bill</span> : null}
        </span>
        <label className="vbill-only">
          <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> Differences only
        </label>
      </div>
      {curMismatch ? (
        <div className="vbill-warn">Currency differs — bill {billCurrency || "KRW"} vs {base.currency || "KRW"}. Amounts are compared as printed.</div>
      ) : null}
      <div className="table-wrap">
        <table className="mini vbill-cmp-table">
          <thead>
            <tr>
              <th>Description / Part No.</th>
              <th className="num">Bill qty</th>
              <th className="num">Base qty</th>
              <th className="num">Bill price</th>
              <th className="num">Base price</th>
              <th className="num">Amount diff</th>
              <th>Check</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr><td colSpan={7} className="mini-empty">{onlyDiff ? "No differences." : "No lines."}</td></tr>
            ) : shown.map((l, i) => {
              const it = l.bill ?? l.base!;
              const amtDiff = n(l.bill?.qty) * n(l.bill?.unit_price) - n(l.base?.qty) * n(l.base?.unit_price);
              return (
                <tr key={i} className={`vbill-row ${l.status}`}>
                  <td>
                    <div className="vbill-desc">{it.description || "—"}</div>
                    {it.part_no ? <div className="vbill-part">{it.part_no}</div> : null}
                  </td>
                  <td className={`num${l.status === "qty" || l.status === "both" ? " hl" : ""}`}>{l.bill ? fmt(n(l.bill.qty)) : "—"}</td>
                  <td className="num">{l.base ? fmt(n(l.base.qty)) : "—"}</td>
                  <td className={`num${l.status === "price" || l.status === "both" ? " hl" : ""}`}>{l.bill ? fmt(n(l.bill.unit_price)) : "—"}</td>
                  <td className="num">{l.base ? fmt(n(l.base.unit_price)) : "—"}</td>
                  <td className={`num${Math.abs(amtDiff) > 0.005 ? (amtDiff > 0 ? " up" : " down") : ""}`}>
                    {Math.abs(amtDiff) > 0.005 ? `${amtDiff > 0 ? "+" : ""}${fmt(amtDiff)}` : "—"}
                  </td>
                  <td><span className={`vbill-tag ${l.status}`}>{STATUS_LABEL[l.status]}</span></td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td className="total-label">Subtotal (before charges & VAT)</td>
              <td colSpan={2} />
              <td className="num">{fmt(billSub)}</td>
              <td className="num">{fmt(baseSub)}</td>
              <td className={`num${Math.abs(diff) > 0.005 ? (diff > 0 ? " up" : " down") : ""}`}>
                {Math.abs(diff) > 0.005 ? `${diff > 0 ? "+" : ""}${fmt(diff)}` : "—"}
              </td>
              <td>{Math.abs(diff) > 0.005 ? <span className="vbill-tag both">Total differs</span> : <span className="vbill-tag same">Total matches</span>}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {printed ? <PrintedCheck p={printed} /> : null}
    </div>
  );
}

/** 명세서에 찍힌 합계 vs 읽어 온 품목으로 다시 계산한 합계. */
function PrintedCheck({ p }: { p: { supply: number | null; total: number | null; computedSupply: number; computedTotal: number } }) {
  const rows: { label: string; printed: number; computed: number }[] = [];
  if (p.supply != null) rows.push({ label: "Supply amount", printed: p.supply, computed: p.computedSupply });
  if (p.total != null) rows.push({ label: "Total (incl. VAT)", printed: p.total, computed: p.computedTotal });
  if (!rows.length) return null;
  return (
    <div className="vbill-printed">
      {rows.map((r) => {
        const ok = Math.abs(r.printed - r.computed) <= 1;
        return (
          <span key={r.label} className={ok ? "ok" : "bad"}>
            {r.label}: printed {fmt(r.printed)} · this form {fmt(r.computed)} {ok ? "✓" : `(${fmt(r.computed - r.printed)})`}
          </span>
        );
      })}
    </div>
  );
}

// ── ③ 계좌 ──────────────────────────────────────────────────────────────────
export const emptyBank: BankAccount = { bank_name: "", bank_account: "", bank_holder: "", swift: "" };
export const sameBank = (a: BankAccount, b: BankAccount) =>
  (["bank_name", "bank_account", "bank_holder", "swift"] as const).every((k) => (a[k] || "").trim() === (b[k] || "").trim());

export function VendorBankFields({
  value,
  onChange,
  vendorName,
  fromBill,
}: {
  value: BankAccount;
  onChange: (b: BankAccount) => void;
  vendorName: string;
  /** 방금 명세서에서 읽어 와 바뀐 값인가 — 저장하면 거래선 계좌가 바뀐다는 것을 알린다. */
  fromBill?: boolean;
}) {
  const set = (k: keyof BankAccount) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="ar-milestone">
      <div className="form-section-title">Payment account (vendor)</div>
      <div className="form-grid">
        <label className="form-field"><span>Bank</span><input value={value.bank_name} onChange={set("bank_name")} /></label>
        <label className="form-field"><span>Account No.</span><input value={value.bank_account} onChange={set("bank_account")} /></label>
        <label className="form-field"><span>Account holder</span><input value={value.bank_holder} onChange={set("bank_holder")} /></label>
        <label className="form-field"><span>SWIFT (overseas)</span><input value={value.swift} onChange={set("swift")} /></label>
      </div>
      <p className="hint-inline" style={{ display: "block", marginTop: 6 }}>
        {fromBill ? "Read from the bill — check it. " : ""}
        Saved to {vendorName ? <b>{vendorName}</b> : "the vendor"}&apos;s company record (Partners) on Save; Finance shows the same
        account when you pay.
      </p>
    </div>
  );
}
