"use client";

// 딜의 배송비 — 누가 내나 · 운송사 견적 · 실제 비용(Finance 지급) · 고객 청구(PI·CI·별도 청구서).
// 4단계(견적 때 운임 조사)와 7단계(선적 준비)가 같은 한 벌을 연다.
//
// 돈의 장부를 새로 만들지 않는다. 실제 비용은 Finance 지급대장의 한 줄(거래선지급 + 이 딜)이고,
// 지급 예정·지급 여부는 그 줄에서 읽는다. 청구는 PI·CI 의 Freight 칸이나 추가 청구서(AR)다.

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  chargeFreight,
  deleteFreight,
  fetchFreight,
  fetchVendors,
  freightFileUrl,
  parseFreight,
  payFinancePayable,
  pickFreightDoc,
  removeFreightPayable,
  saveFreight,
  saveFreightInfo,
  saveFreightPayable,
  setCarryNext,
  uploadFreightFile,
  type Freight,
  type FreightParse,
  type FreightPayer,
  type FreightRow,
  type FreightRowSave,
} from "@/lib/api";
import { can, getToken } from "@/lib/auth";
import { useEditGate } from "@/lib/viewMode";
import { invalidateCache } from "@/lib/useCachedData";

const PAYERS: { v: Exclude<FreightPayer, "">; label: string; hint: string }[] = [
  { v: "buyer", label: "Buyer pays the carrier", hint: "Freight collect or the buyer's own courier account — no cost or charge on our side." },
  { v: "rebill", label: "We pay, charge the buyer", hint: "We pay the carrier and charge it on the PI / CI or with a separate invoice." },
  { v: "included", label: "We pay, included in price", hint: "We pay the carrier; the buyer is not charged separately." },
];
const CURRENCIES = ["KRW", "USD", "EUR", "SGD", "JPY", "CNY"];
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const num = (v: string) => Number(String(v).replace(/,/g, "")) || 0;
const fmt = (n: number, cur: string) =>
  `${cur} ${n.toLocaleString("en-US", { maximumFractionDigits: cur === "KRW" || cur === "JPY" ? 0 : 2 })}`;

const EMPTY: FreightRowSave = {
  order_id: null, ci_id: null, carrier: "", vendor_id: null, service: "", quote_no: "", quote_date: "",
  valid_until: "", transit: "", weight: "", tracking_no: "", bill_no: "", currency: "KRW", amount: 0,
  vat_amount: 0, awarded: false, notes: "",
};
const toSave = (r: FreightRow): FreightRowSave => ({
  order_id: r.order_id || null, ci_id: r.ci_id || null, carrier: r.carrier, vendor_id: r.vendor_id,
  service: r.service, quote_no: r.quote_no, quote_date: r.quote_date, valid_until: r.valid_until,
  transit: r.transit, weight: r.weight, tracking_no: r.tracking_no, bill_no: r.bill_no,
  currency: r.currency, amount: r.amount, vat_amount: r.vat_amount, awarded: r.awarded, notes: r.notes,
});

export default function FreightPanel({
  rfqId,
  orderId = 0,
  canEdit,
  carriers = [],
  onChanged,
}: {
  rfqId: number;
  /** 7단계에서 연 오더 — 새 견적을 이 오더에 매단다. 4단계(오더 없음)는 0. */
  orderId?: number;
  canEdit: boolean;
  carriers?: string[];
  onChanged?: () => void;
}) {
  const [d, setD] = useState<Freight | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");
  const [edit, setEdit] = useState<{ id: number; form: FreightRowSave; file: File | null } | null>(null);
  const [bill, setBill] = useState<number | null>(null);
  const { editing: editable } = useEditGate(canEdit);
  const canPay = can("finance", "edit");

  const load = () =>
    fetchFreight(rfqId).then(setD).catch((e) => setErr(e instanceof Error ? e.message : "Error"));
  useEffect(() => {
    setD(null);
    setErr("");
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfqId]);

  async function run(label: string, fn: () => Promise<string | void>) {
    setBusy(label);
    setErr("");
    setMsg("");
    try {
      const m = await fn();
      // 지급·청구가 바뀌면 Finance·AP·AR·문서 화면의 캐시도 낡는다.
      ["finance:", "ap:", "ar", "documents", `freight:${rfqId}`].forEach((k) => invalidateCache(k));
      await load();
      onChanged?.();
      setMsg(m || (label === "file" ? "" : "Saved ✓"));
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
      return false;
    } finally {
      setBusy("");
    }
  }

  if (!d) return err ? <div className="state error">{err}</div> : <div className="state">Loading freight…</div>;

  const cur = d.currency;
  const inCur = (krw: number) => (d.krw_per ? krw / d.krw_per : krw);
  const payer = d.info.payer;
  const buyerPays = payer === "buyer";
  const packages = d.orders.flatMap((o) => o.packages.map((p, i) => ({ ...p, order_id: o.id, label: `#${i + 1} ${p.ci_no || "CI"}` })));
  // 포장이 둘 이상이면 포장마다 견적·비용·청구를 따로 본다.
  const byPkg = packages.length >= 2;
  const pkgOrder = (ci: number) => { const i = packages.findIndex((p) => p.ci_id === ci); return i < 0 ? packages.length : i; };
  const rows = byPkg ? [...d.rows].sort((a, b) => pkgOrder(a.ci_id) - pkgOrder(b.ci_id) || a.id - b.id) : d.rows;
  const pkgLabel = (id: number) => packages.find((p) => p.ci_id === id)?.label ?? "Whole shipment";
  const t = d.totals;
  const diff = t.charged_krw - t.cost_krw;
  const active = rows.filter((r) => r.payable || (r.awarded && !buyerPays));
  const unpaid = active.filter((r) => !r.payable?.paid);
  const cis = d.docs.filter((x) => x.kind === "ci");
  const incoterms = d.orders.find((o) => o.incoterms)?.incoterms ?? "";
  const term = incoterms.slice(0, 3).toUpperCase();

  const warnings: string[] = [];
  if (buyerPays && t.charged_krw > 0) warnings.push("Buyer pays the carrier, but freight is still charged on the PI / CI — check it.");
  if (buyerPays && active.length) warnings.push("Buyer pays the carrier, but a freight payment is registered in Finance for this deal.");
  if (payer === "rebill" && t.cost_krw > 0 && t.charged_krw <= 0) warnings.push("Freight cost is not charged to the buyer yet — set it on the PI / CI or create a separate invoice.");
  if (payer !== "buyer" && t.charged_krw > 0 && t.cost_krw <= 0) warnings.push("Freight is charged to the buyer, but the actual cost is not recorded — this deal's profit looks larger than it is.");
  // 청구액에는 들어가지만 매출채권이 없어 수금 대장에 안 보이는 운임.
  const unbilled = (d.billing ?? []).filter((b) => b.unbilled > 0 && b.order_id);
  for (const u of unbilled) {
    warnings.push(`${fmt(u.unbilled, u.currency)} of freight is charged on the document but not in receivables (AR) — register it under "Charged to the buyer".`);
  }

  const wholeActive = active.some((r) => !r.ci_id);
  const pkgMissing = byPkg && !buyerPays && !wholeActive && active.length
    ? packages.filter((p) => !active.some((r) => r.ci_id === p.ci_id)) : [];
  if (pkgMissing.length) warnings.push(`No freight cost yet for package ${pkgMissing.map((p) => p.label).join(", ")}.`);
  if (byPkg && wholeActive && active.length && !buyerPays) {
    warnings.push(active.some((r) => r.ci_id)
      ? "Freight is in use both for the whole shipment and for a single package — check that the same cost is not counted twice."
      : `This shipment has ${packages.length} packages, but the freight in use is set to "Whole shipment". If it covers one package only, change "For" in the quotation list.`);
  }

  const setInfo = (p: Partial<Freight["info"]>) =>
    run("info", async () => { await saveFreightInfo(rfqId, { ...d.info, ...p }); });

  async function saveRow() {
    if (!edit) return;
    const ok = await run("row", async () => {
      const r = await saveFreight(rfqId, edit.id, edit.form);
      if (edit.file) await uploadFreightFile(rfqId, r.id, edit.file);
    });
    if (ok) setEdit(null);
  }

  const openFile = (r: FreightRow) =>
    run("file", async () => {
      const res = await fetch(freightFileUrl(rfqId, r.id), { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} });
      if (!res.ok) throw new Error("Could not open the file");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      a.click();
      URL.revokeObjectURL(url);
    });

  /** 새 견적 — 포장이 여럿이면 아직 비용이 없는 첫 포장부터. */
  const newRow = (ci?: number) => {
    const target = ci ?? (byPkg ? packages.find((p) => !d.rows.some((r) => r.ci_id === p.ci_id))?.ci_id ?? 0 : 0);
    const own = packages.find((p) => p.ci_id === target);
    setBill(null);
    setEdit({
      id: 0, file: null,
      form: { ...EMPTY, order_id: own?.order_id ?? (orderId || null), ci_id: target || null, quote_date: today(),
              awarded: !d.rows.some((r) => (r.ci_id || 0) === target) },
    });
  };
  /** 이 견적을 다른 포장으로 — 그 포장에 이미 쓰는 견적이 있으면 고르지 않은 견적으로 옮긴다. */
  const moveRow = (r: FreightRow, ci: number) => run("row", async () => {
    const own = packages.find((p) => p.ci_id === ci);
    const clash = d.rows.some((x) => x.id !== r.id && (x.awarded || x.payable) && (x.ci_id || 0) === ci);
    await saveFreight(rfqId, r.id, { ...toSave(r), ci_id: ci || null, order_id: own?.order_id ?? (r.order_id || null), awarded: r.awarded && !clash });
    return clash ? `Moved to ${pkgLabel(ci)} — another quotation is already in use there, so this one is not ticked.` : "Saved ✓";
  });

  return (
    <div className="doc-tab frt">
      {/* ① 누가 내나 */}
      <div className="stage-card">
        <div className="form-section-title">Who pays the freight</div>
        <div className="frt-payers">
          {PAYERS.map((p) => (
            <button key={p.v} type="button" className={`frt-payer${payer === p.v ? " on" : ""}`} disabled={!editable || !!busy}
                    onClick={() => void setInfo({ payer: payer === p.v ? "" : p.v })}>
              <b>{payer === p.v ? "✓ " : ""}{p.label}</b>
              <span>{p.hint}</span>
            </button>
          ))}
        </div>
        {incoterms ? (
          <p className="hint-inline frt-note">
            Incoterms on this deal: {incoterms}
            {["EXW", "FCA", "FAS", "FOB"].includes(term) ? " — main carriage is normally on the buyer."
              : /^[CD]/.test(term) ? " — main carriage is normally on us." : ""}
          </p>
        ) : null}
        {buyerPays || d.info.account_no || d.info.note || editable ? (
          <div className="form-grid form-grid--cols4">
            {buyerPays || d.info.account_no ? (
              <BlurField label="Buyer's carrier account No." value={d.info.account_no} disabled={!editable}
                         placeholder="DHL 950…" onSave={(v) => void setInfo({ account_no: v })} />
            ) : null}
            <BlurField label="Note" value={d.info.note} disabled={!editable} span2
                       placeholder="e.g. agreed by email on 20 Nov" onSave={(v) => void setInfo({ note: v })} />
          </div>
        ) : null}
      </div>

      {/* ② 한눈에 — 쓴 돈과 받은 돈 */}
      <div className="frt-kpis">
        <Kpi label={unpaid.length || !active.length ? "Freight cost" : "Freight cost (paid)"} krw={t.cost_krw} cur={cur} v={inCur(t.cost_krw)} />
        <Kpi label="Charged to buyer" krw={t.charged_krw} cur={cur} v={inCur(t.charged_krw)} />
        <Kpi label="Difference" krw={diff} cur={cur} v={inCur(diff)} tone={diff < 0 ? "bad" : diff > 0 ? "good" : ""} />
        <div className="frt-kpi">
          <span>Payment</span>
          <b className={active.length && !unpaid.length ? "good" : ""}>
            {!active.length ? "—" : unpaid.length ? `${active.length - unpaid.length} / ${active.length} paid` : "Paid to carrier ✓"}
          </b>
          <em>{t.charged_krw <= 0 ? "Not charged" : t.collected_krw >= t.charged_krw - 1 ? "Collected from buyer ✓"
            : t.collected_krw > 0 ? `Collected ${fmt(Math.round(inCur(t.collected_krw) * 100) / 100, cur)} so far` : "Not collected yet"}</em>
        </div>
      </div>
      {warnings.length ? <div className="frt-warn">{warnings.map((w) => <div key={w}>⚠ {w}</div>)}</div> : null}
      {msg || err ? (
        <div className="pod-msgs">
          {msg ? <span className="action-ok">{msg}</span> : null}
          {err ? <span className="action-err">{err}</span> : null}
        </div>
      ) : null}

      {editable ? (
        <p className="hint-inline frt-note">Ticks and choices on this page are saved right away. Only the open forms (quotation, bill, invoice) have their own Save button.</p>
      ) : null}

      {/* 포장별 한눈에 — 포장이 둘 이상일 때만 */}
      {byPkg ? (
        <div className="stage-card">
          <div className="form-section-title">By package</div>
          <div className="table-wrap pod-table-wrap">
            <table className="pod-table frt-table">
              <thead>
                <tr><th>Package</th><th>Carrier</th><th className="num">Cost</th><th className="num">Charged to buyer</th><th className="num">Difference</th><th>Payment</th><th /></tr>
              </thead>
              <tbody>
                {[...packages, ...(wholeActive ? [{ ci_id: 0, ci_no: "", order_id: 0, label: "Whole shipment" }] : [])].map((p) => {
                  const own = active.filter((r) => (r.ci_id || 0) === p.ci_id);
                  const cost = own.reduce((s, r) => s + r.cost_krw, 0);
                  const doc = cis.find((x) => x.id === p.ci_id && x.counted && x.freight);
                  // 문서 통화가 화면 통화와 같을 때만 차액을 낸다.
                  const gap = doc && own.length && doc.currency === cur ? Math.round((doc.freight - inCur(cost)) * 100) / 100 : null;
                  const open = own.filter((r) => !r.payable?.paid);
                  return (
                    <tr key={p.ci_id}>
                      <td><b>{p.label}</b></td>
                      <td>{own.length ? [...new Set(own.map((r) => r.carrier))].join(", ") : buyerPays ? "—" : p.ci_id && wholeActive ? <span className="muted">In whole shipment</span> : <span className="pod-none">No freight yet</span>}
                        {own.some((r) => r.tracking_no) ? <div className="muted">{own.map((r) => r.tracking_no).filter(Boolean).join(", ")}</div> : null}</td>
                      <td className="num">{own.length ? fmt(Math.round(inCur(cost) * 100) / 100, cur) : "—"}{own.length && cur !== "KRW" ? <div className="muted">{fmt(Math.round(cost), "KRW")}</div> : null}</td>
                      <td className="num">{doc ? fmt(doc.freight, doc.currency) : "—"}</td>
                      <td className="num">{gap === null ? "—" : fmt(gap, cur)}</td>
                      <td>{!own.length ? "—" : !open.length ? <span className="ar-badge">Paid ✓</span>
                        : open.every((r) => r.payable) ? <span className={`ar-badge${open.some((r) => r.payable?.overdue) ? " overdue" : ""}`}>Unpaid</span> : <span className="pod-none">Not registered</span>}</td>
                      <td className="pod-act">
                        {editable && p.ci_id && !buyerPays ? <button type="button" className="btn sm" disabled={!!busy} onClick={() => newRow(p.ci_id)}>＋ Quotation</button> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* ③ 운송사 견적 */}
      <div className="stage-card">
        <div className="embedded-add-head frt-head">
          <div className="form-section-title">Freight quotations</div>
          {editable && !edit ? <button type="button" className="btn sm primary" onClick={() => newRow()}>＋ Add quotation</button> : null}
        </div>
        {d.rows.length ? (
          <div className="table-wrap pod-table-wrap">
            <table className="pod-table frt-table">
              <thead>
                <tr>
                  <th title="The quotation we ship with">Use</th><th>Carrier / forwarder</th><th>For</th><th>Quote</th>
                  <th>Transit</th><th className="num">Amount (ex. VAT)</th><th className="num">≈ {cur}</th><th>File</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.awarded || r.payable ? "on" : ""}>
                    <td>
                      <input type="checkbox" checked={r.awarded || !!r.payable} disabled={!editable || !!busy || !!r.payable}
                             aria-label={`Use ${r.carrier}`}
                             onChange={(e) => void run("row", async () => { await saveFreight(rfqId, r.id, { ...toSave(r), awarded: e.target.checked }); })} />
                    </td>
                    <td><b>{r.carrier}</b>{r.service ? <div className="muted">{r.service}</div> : null}</td>
                    <td>{editable && byPkg ? (
                      <select className="frt-for" value={r.ci_id || 0} disabled={!!busy} aria-label={`Package of the ${r.carrier} quotation`}
                              onChange={(e) => void moveRow(r, Number(e.target.value))}>
                        <option value={0}>Whole shipment</option>
                        {packages.map((p) => <option key={p.ci_id} value={p.ci_id}>{p.label}</option>)}
                      </select>
                    ) : pkgLabel(r.ci_id)}{r.weight ? <div className="muted">{r.weight}</div> : null}</td>
                    <td>{r.quote_no || "—"}<div className="muted">{[r.quote_date, r.valid_until ? `valid ${r.valid_until}` : ""].filter(Boolean).join(" · ")}</div></td>
                    <td>{r.transit || "—"}</td>
                    <td className="num">{fmt(r.amount, r.currency)}{r.vat_amount ? <div className="muted">VAT {fmt(r.vat_amount, r.currency)}</div> : null}</td>
                    <td className="num">{inCur(r.cost_krw).toLocaleString("en-US", { maximumFractionDigits: 2 })}</td>
                    <td>{r.filename ? <button type="button" className="pod-file-link" onClick={() => void openFile(r)}>📄 {r.filename}</button> : "—"}</td>
                    <td className="pod-act">
                      {editable ? (
                        <>
                          <button type="button" className="btn sm" disabled={!!busy} onClick={() => { setEdit({ id: r.id, form: toSave(r), file: null }); setBill(null); }}>Edit</button>
                          {r.payable ? null : (
                            <button type="button" className="btn sm danger" disabled={!!busy}
                                    onClick={() => { if (confirm(`Delete the ${r.carrier} quotation?`)) void run("row", async () => { await deleteFreight(rfqId, r.id); }); }}>
                              Delete
                            </button>
                          )}
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !edit ? (
          <p className="hint-inline frt-note">No freight quotation yet. Add what DHL, FedEx or a forwarder quoted, tick the one you ship with, then register its actual cost below.</p>
        ) : null}
        {edit ? (
          <QuoteForm edit={edit} setEdit={setEdit} packages={packages} carriers={carriers} busy={!!busy} onSave={saveRow} onError={setErr} />
        ) : null}
      </div>

      {/* ④ 실제 비용 — Finance 지급 */}
      <div className="stage-card">
        <div className="form-section-title">Actual freight cost — Finance payment</div>
        {buyerPays && !d.rows.some((r) => r.payable) ? (
          <p className="hint-inline frt-note">The buyer pays the carrier directly, so there is nothing to pay from our account.</p>
        ) : active.length ? (
          active.map((r) => (
            <div key={r.id} className="frt-pay">
              <div className="frt-pay-head">
                <b>{r.carrier}</b>
                <span className="muted">{pkgLabel(r.ci_id)}{r.tracking_no ? ` · ${r.tracking_no}` : ""}</span>
                {r.payable ? (
                  <>
                    <span>{fmt(r.payable.amount, r.payable.currency)}{r.payable.vat_amount ? ` (VAT ${fmt(r.payable.vat_amount, r.payable.currency)} incl.)` : ""}</span>
                    {r.amount && r.payable.currency === r.currency && Math.abs(r.payable.supply_amount - r.amount) >= 1 ? (
                      <span className="pod-none">{r.payable.supply_amount > r.amount ? "+" : "−"}{fmt(Math.abs(r.payable.supply_amount - r.amount), r.currency)} vs quote</span>
                    ) : null}
                    <span className={`ar-badge${r.payable.paid ? "" : r.payable.overdue ? " overdue" : ""}`}>
                      {r.payable.paid ? `Paid${r.payable.paid_date ? ` ${r.payable.paid_date}` : ""}` : `Unpaid · due ${r.payable.due_date || "—"}`}
                    </span>
                  </>
                ) : (
                  <span className="pod-none">Not registered in Finance</span>
                )}
                <span className="frt-pay-act">
                  {editable && !r.payable?.paid ? (
                    <button type="button" className={`btn sm${r.payable ? "" : " primary"}`} disabled={!!busy} onClick={() => { setBill(bill === r.id ? null : r.id); setEdit(null); }}>
                      {r.payable ? "Edit bill" : "Register in Finance"}
                    </button>
                  ) : null}
                  {r.payable && editable && canPay ? <PayButton paid={r.payable.paid} busy={!!busy} onPay={(paid, on) =>
                    void run("pay", async () => { await payFinancePayable(r.payable!.id, paid, undefined, on); })} /> : null}
                  {r.payable && !r.payable.paid && editable ? (
                    <button type="button" className="btn sm danger" disabled={!!busy}
                            onClick={() => { if (confirm("Remove this freight payment from Finance? The quotation stays here.")) void run("pay", async () => { await removeFreightPayable(rfqId, r.id); }); }}>
                      Remove from Finance
                    </button>
                  ) : null}
                </span>
              </div>
              {r.payable && bill !== r.id ? <PayTo bank={r.payable.bank} notes={r.payable.notes} paid={r.payable.paid} /> : null}
              {bill === r.id ? (
                <BillForm row={r} rfqId={rfqId} others={r.payable ? [] : d.other_payables} busy={!!busy} onError={setErr}
                          onCancel={() => setBill(null)}
                          onSave={async (b) => {
                            const ok = await run("bill", async () => {
                              if (b.file) await uploadFreightFile(rfqId, r.id, b.file);
                              await saveFreightPayable(rfqId, r.id, b.body);
                              return "Registered in Finance — payment status shown here follows Finance.";
                            });
                            if (ok) setBill(null);
                          }} />
              ) : null}
            </div>
          ))
        ) : (
          <p className="hint-inline frt-note">Tick the quotation you use above, then register its bill here. It becomes a payment in Finance → Outflow (calendar, cash flow) and this deal&apos;s cost in Profit.</p>
        )}
        {d.vendor_freight.length ? (
          <p className="hint-inline frt-note">
            Already inside vendor bills (do not register again): {d.vendor_freight.map((v) => `${v.vendor || "Vendor"} ${fmt(v.freight, v.currency)}`).join(" · ")}
          </p>
        ) : null}
        {d.rows.some((r) => r.payable) ? (
          <p className="hint-inline frt-note"><a href="/finance?tab=outflow&view=payables">Open Finance → Outflow</a> to see due dates and bank accounts.</p>
        ) : null}
      </div>

      {/* ⑤ 고객 청구 */}
      <div className="stage-card">
        <div className="form-section-title">Charged to the buyer</div>
        {d.docs.length ? (
          <div className="table-wrap pod-table-wrap">
            <table className="pod-table frt-table">
              <thead><tr><th>Charge</th><th>Document</th><th>Date</th><th className="num">Freight</th><th className="num">Packing · Insurance</th><th>Receivable (AR)</th><th /></tr></thead>
              <tbody>
                {d.docs.map((x) => {
                  const own = x.kind === "ci" ? active.filter((r) => r.ci_id === x.id) : [];
                  const base = own.length ? own.reduce((s, r) => s + r.cost_krw, 0) : x.kind === "pi" || cis.length === 1 ? t.cost_krw : 0;
                  // 매출채권 상태는 P/O(통화)별 한 번 — 고른 문서의 첫 줄에 단다.
                  const first = d.docs.find((y) => y.order_id === x.order_id && y.currency === x.currency && y.counted && y.freight);
                  const bill = first === x ? (d.billing ?? []).find((b) => b.order_id === x.order_id && b.currency === x.currency) : undefined;
                  return (
                    <ChargeRow key={`${x.kind}${x.id}`} doc={x} bill={bill}
                               onPick={(include) => void run("charge", async () => { await pickFreightDoc(rfqId, { kind: x.kind, doc_id: x.id, include }); })}
                               onRegister={(amount, due, carry) => run("charge", async () => {
                                 const r = await chargeFreight(rfqId, {
                                   target: "invoice", order_id: x.order_id, amount, currency: x.currency, due_date: due,
                                   description: `Freight charge — ${x.no}`,
                                 });
                                 if (carry && r.ar_id) {
                                   await setCarryNext(r.ar_id, true, carry.note);
                                   return `Invoice ${r.invoice_no} registered — it will show on this customer's next PI / CI.`;
                                 }
                                 return `Invoice ${r.invoice_no} registered — print and collect it in stage 9 (AR).`;
                               })} suggest={d.krw_per ? base / d.krw_per : 0} editable={editable} busy={!!busy}
                               onSet={(amount) => run("charge", async () => {
                                 const r = await chargeFreight(rfqId, { target: x.kind, doc_id: x.id, amount });
                                 return x.kind === "pi"
                                   ? r.ar_updated ? "PI updated — the AR invoice follows it." : r.ar_manual ? "PI updated. The AR invoice in stage 9 was entered by hand — update it there too." : "PI updated."
                                   : "CI updated.";
                               })} />
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="hint-inline frt-note">No PI or CI yet.</p>}

        {d.ar.length ? (
          <div className="table-wrap pod-table-wrap" style={{ marginTop: 10 }}>
            <table className="pod-table frt-table">
              <thead><tr><th>Invoice (AR)</th><th>Due</th><th className="num">Invoice</th><th className="num">of which freight</th><th>Collection</th><th>Next order</th></tr></thead>
              <tbody>
                {d.ar.map((a) => (
                  <tr key={a.id}>
                    <td><a href={`/project?rfq=${rfqId}&stage=9`}>{a.invoice_no || `AR ${a.id}`}</a>{a.freight_only ? <div className="muted">Freight only</div> : null}</td>
                    <td>{a.due_date || "—"}</td>
                    <td className="num">{fmt(a.amount, a.currency)}</td>
                    <td className="num">{a.freight ? fmt(a.freight, a.currency) : "—"}</td>
                    <td><span className={`ar-badge${a.paid ? "" : a.carry_next ? " carry" : " overdue"}`}>{a.paid ? `Collected${a.paid_date ? ` ${a.paid_date}` : ""}` : `Outstanding ${fmt(a.outstanding, a.currency)}`}</span></td>
                    <td>
                      <CarryCell a={a} editable={editable} busy={!!busy}
                                 onSave={(on, note) => run("carry", async () => {
                                   await setCarryNext(a.id, on, note);
                                   return on ? "Marked — it will show on this customer's next PI / CI." : "Cleared.";
                                 })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {editable && d.orders.length && !buyerPays ? (
          <SeparateInvoice d={d} orderId={orderId || d.orders[0].id} busy={!!busy}
                           suggest={Math.max(0, inCur(t.cost_krw - t.charged_krw))}
                           defaultDesc={`Freight charge${active[0] ? ` — ${active[0].carrier}${active[0].tracking_no ? ` ${active[0].tracking_no}` : ""}` : ""}`}
                           onCreate={(b) => run("charge", async () => {
                             const r = await chargeFreight(rfqId, { target: "invoice", ...b });
                             return `Invoice ${r.invoice_no} created — print and collect it in stage 9 (AR).`;
                           })} />
        ) : null}
        <p className="hint-inline frt-note">The PI and the CI carry the same freight, so one of them is counted — the CI by default, the PI when no CI has freight. Use the Charge boxes to change it. Freight-only invoices are added only for what they charge beyond the document.</p>
      </div>
    </div>
  );
}

function Kpi({ label, krw, v, cur, tone = "" }: { label: string; krw: number; v: number; cur: string; tone?: string }) {
  return (
    <div className="frt-kpi">
      <span>{label}</span>
      <b className={tone}>{fmt(Math.round(v * 100) / 100, cur)}</b>
      <em>{cur === "KRW" ? "" : fmt(Math.round(krw), "KRW")}</em>
    </div>
  );
}

/** 칸을 벗어날 때 저장하는 글자 칸. */
function BlurField({ label, value, onSave, disabled, placeholder, span2 }: {
  label: string; value: string; onSave: (v: string) => void; disabled?: boolean; placeholder?: string; span2?: boolean;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className={`form-field${span2 ? " form-field--span2" : ""}`}>
      <span>{label}</span>
      <input value={v} disabled={disabled} placeholder={placeholder} onChange={(e) => setV(e.target.value)}
             onBlur={() => { if (v.trim() !== value) onSave(v.trim()); }} />
    </label>
  );
}

type EditState = { id: number; form: FreightRowSave; file: File | null };

function QuoteForm({ edit, setEdit, packages, carriers, busy, onSave, onError }: {
  edit: EditState;
  setEdit: (e: EditState | null) => void;
  packages: { ci_id: number; label: string }[];
  carriers: string[];
  busy: boolean;
  onSave: () => void;
  onError: (m: string) => void;
}) {
  const [reading, setReading] = useState(false);
  const [vendors, setVendors] = useState<{ id: number; name: string }[]>([]);
  useEffect(() => { fetchVendors().then((v) => setVendors(v)).catch(() => {}); }, []);
  const live = useRef(edit);
  live.current = edit;
  const f = edit.form;
  const set = (p: Partial<FreightRowSave>) => setEdit({ ...live.current, form: { ...live.current.form, ...p } });
  const text = (k: "carrier" | "service" | "quote_no" | "quote_date" | "valid_until" | "transit" | "weight" | "tracking_no", label: string, opt: { type?: string; placeholder?: string; list?: string[] } = {}) => (
    <label className="form-field">
      <span>{label}</span>
      <input type={opt.type ?? "text"} value={f[k]} placeholder={opt.placeholder} list={opt.list?.length ? `frt-${k}` : undefined}
             onChange={(e) => set({ [k]: e.target.value })} />
      {opt.list?.length ? <datalist id={`frt-${k}`}>{opt.list.map((o) => <option key={o} value={o} />)}</datalist> : null}
    </label>
  );

  async function read(file: File | undefined) {
    if (!file) return;
    setEdit({ ...live.current, file });
    setReading(true);
    onError("");
    try {
      const p = await parseFreight(file);
      const c = live.current.form;
      const next: Partial<FreightRowSave> = {};
      const put = (k: "carrier" | "service" | "quote_no" | "quote_date" | "valid_until" | "transit" | "weight" | "tracking_no", v: string) => {
        if (v && (!c[k] || (k === "quote_date" && c[k] === today()))) next[k] = v;
      };
      put("carrier", p.carrier); put("service", p.service); put("quote_no", p.doc_no || p.bill_no);
      put("quote_date", p.quote_date || p.bill_date); put("valid_until", p.valid_until); put("transit", p.transit);
      put("weight", p.weight); put("tracking_no", p.tracking_no);
      if (!c.amount && p.amount) {
        next.amount = p.amount;
        next.vat_amount = p.vat_amount;
        if (p.currency) next.currency = p.currency;
      }
      set(next);
    } catch (e) {
      onError(`The file is kept, but it could not be read: ${e instanceof Error ? e.message : "error"}`);
    } finally {
      setReading(false);
    }
  }

  return (
    <div className="frt-form">
      <div className="scan-bar">
        <label className="btn sm" style={{ cursor: "pointer" }}>
          {reading ? "Reading…" : "📄 Read quotation (PDF · image)"}
          <input type="file" hidden accept=".pdf,image/*" disabled={reading || busy} onChange={(e) => { const x = e.target.files?.[0]; e.target.value = ""; void read(x); }} />
        </label>
        <span className="hint-inline">{edit.file ? `📎 ${edit.file.name} — saved with this quotation` : "Fills the empty fields and keeps the file."}</span>
      </div>
      <div className="form-grid form-grid--cols4">
        {text("carrier", "Carrier / forwarder *", { list: [...new Set([...carriers, ...vendors.map((v) => v.name)])], placeholder: "DHL" })}
        {text("service", "Service", { placeholder: "EXPRESS WORLDWIDE" })}
        <label className="form-field">
          <span>For</span>
          <select value={f.ci_id ?? ""} onChange={(e) => set({ ci_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Whole shipment</option>
            {packages.map((p) => <option key={p.ci_id} value={p.ci_id}>{p.label}</option>)}
          </select>
        </label>
        <label className="form-field">
          <span>Vendor link (bank account)</span>
          <select value={f.vendor_id ?? ""} onChange={(e) => {
            const id = e.target.value ? Number(e.target.value) : null;
            set({ vendor_id: id, ...(f.carrier ? {} : { carrier: vendors.find((v) => v.id === id)?.name ?? "" }) });
          }}>
            <option value="">— None —</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
        {text("quote_no", "Quote No.")}
        {text("quote_date", "Quote date", { type: "date" })}
        {text("valid_until", "Valid until", { type: "date" })}
        {text("transit", "Transit time", { placeholder: "3–4 working days" })}
        <label className="form-field">
          <span>Amount (ex. VAT) *</span>
          <div className="frt-amt">
            <select value={f.currency} onChange={(e) => set({ currency: e.target.value })}>
              {[...new Set([...CURRENCIES, f.currency])].map((c) => <option key={c}>{c}</option>)}
            </select>
            <Amount value={f.amount} onChange={(amount) => set({ amount })} />
          </div>
        </label>
        <label className="form-field"><span>VAT (0 for export freight)</span><Amount value={f.vat_amount} onChange={(vat_amount) => set({ vat_amount })} /></label>
        {text("weight", "Weight / size", { placeholder: "12.5 kg · 40×30×30 cm" })}
        {text("tracking_no", "Waybill / AWB No.")}
        <label className="form-field form-field--full"><span>Notes</span>
          <input value={f.notes} placeholder="Surcharges, pickup conditions…" onChange={(e) => set({ notes: e.target.value })} /></label>
      </div>
      <div className="frt-form-act">
        <label className="dfc-sub"><input type="checkbox" checked={f.awarded} onChange={(e) => set({ awarded: e.target.checked })} /> Use this quotation</label>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn sm" disabled={busy} onClick={() => setEdit(null)}>Cancel</button>
        <button type="button" className="btn sm primary" disabled={busy || reading || !(f.carrier.trim() || f.vendor_id)} onClick={onSave}>{busy ? "Saving…" : "Save quotation"}</button>
      </div>
    </div>
  );
}

function Amount({ value, onChange, autoFocus }: { value: number; onChange: (n: number) => void; autoFocus?: boolean }) {
  const [v, setV] = useState(value ? String(value) : "");
  useEffect(() => { setV((x) => (num(x) === value ? x : value ? String(value) : "")); }, [value]);
  return (
    <input inputMode="decimal" className="num" autoFocus={autoFocus} value={v} placeholder="0"
           onChange={(e) => { setV(e.target.value); onChange(num(e.target.value)); }}
           onBlur={() => setV(value ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "")} />
  );
}

/** 실제 청구서 → Finance 지급. 처음엔 견적 금액에서 시작한다. */
function BillForm({ row, rfqId, others, busy, onSave, onCancel, onError }: {
  row: FreightRow;
  rfqId: number;
  others: Freight["other_payables"];
  busy: boolean;
  onSave: (b: { body: Parameters<typeof saveFreightPayable>[2]; file: File | null }) => void;
  onCancel: () => void;
  onError: (m: string) => void;
}) {
  const p = row.payable;
  const bank0 = p?.bank ?? row.bank_hint;
  const [f, setF] = useState({
    supply_amount: p?.supply_amount ?? row.amount, vat_amount: p?.vat_amount ?? row.vat_amount,
    currency: p?.currency ?? row.currency, bill_no: row.bill_no, bill_date: p?.bill_date ?? "", due_date: p?.due_date ?? "",
    bank_name: bank0?.bank_name ?? "", bank_account: bank0?.bank_account ?? "", bank_holder: bank0?.bank_holder ?? "",
    pay_ref: p?.notes ?? "",
  });
  // 청구서에서 읽은 계좌들 — 은행이 여럿이면 하나를 고른다. readBank = 읽은 값이 칸에 들어갔나.
  const [accounts, setAccounts] = useState<NonNullable<FreightParse["accounts"]>>([]);
  const [readBank, setReadBank] = useState(false);
  const [link, setLink] = useState("");
  const [reading, setReading] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const set = (x: Partial<typeof f>) => setF((c) => ({ ...c, ...x }));

  /** 이미 붙여 둔 원본을 다시 읽는다 — 파일을 또 고르지 않아도 되게. */
  async function readAttached() {
    setReading(true);
    onError("");
    try {
      const res = await fetch(freightFileUrl(rfqId, row.id), { headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} });
      if (!res.ok) throw new Error("could not open the attached file");
      const b = await res.blob();
      await fill(new File([b], row.filename, { type: b.type }));
    } catch (e) {
      onError(`The bill could not be read: ${e instanceof Error ? e.message : "error"}`);
    } finally {
      setReading(false);
    }
  }

  async function read(x: File | undefined) {
    if (!x) return;
    setFile(x);
    setReading(true);
    onError("");
    try {
      await fill(x);
    } catch (e) {
      onError(`The bill could not be read: ${e instanceof Error ? e.message : "error"}`);
    } finally {
      setReading(false);
    }
  }

  async function fill(x: File) {
    const r = await parseFreight(x);
    const accs = r.accounts ?? [];
    setAccounts(accs);
    // 지금 적힌 계좌가 청구서에도 있으면 그대로 두고, 아니면 청구서의 첫 계좌로.
    const pick = accs.find((a) => a.bank_account === f.bank_account) ?? accs[0];
    setReadBank(!!pick);
    // 실제 청구서의 숫자가 견적보다 맞다 — 읽힌 값으로 바꾼다.
    set({
      ...(r.amount ? { supply_amount: r.amount, vat_amount: r.vat_amount } : {}),
      ...(r.currency ? { currency: r.currency } : {}),
      ...(r.bill_no || r.doc_no ? { bill_no: r.bill_no || r.doc_no } : {}),
      ...(r.bill_date || r.quote_date ? { bill_date: r.bill_date || r.quote_date } : {}),
      ...(r.due_date ? { due_date: r.due_date } : {}),
      ...(pick ? { ...pick, bank_holder: pick.bank_holder || (pick.bank_account === f.bank_account ? f.bank_holder : "") } : {}),
      ...(r.pay_ref ? { pay_ref: r.pay_ref } : {}),
    });
  }

  const total = f.supply_amount + f.vat_amount;
  return (
    <div className="frt-form">
      {others.length ? (
        <label className="form-field">
          <span>Already recorded as a direct payment on this deal? Link it instead of registering twice</span>
          <select value={link} onChange={(e) => setLink(e.target.value)}>
            <option value="">— Register a new payment —</option>
            {others.map((o) => <option key={o.id} value={o.id}>{o.counterparty} · {o.description} · {fmt(o.amount, o.currency)}{o.paid ? " · paid" : ""}</option>)}
          </select>
        </label>
      ) : null}
      {link ? null : (
        <>
          <div className="scan-bar">
            <label className="btn sm" style={{ cursor: "pointer" }}>
              {reading ? "Reading…" : "📄 Read freight bill"}
              <input type="file" hidden accept=".pdf,image/*" disabled={reading || busy} onChange={(e) => { const x = e.target.files?.[0]; e.target.value = ""; void read(x); }} />
            </label>
            {row.filename && !file ? (
              <button type="button" className="btn sm" disabled={reading || busy} title={row.filename} onClick={() => void readAttached()}>↻ Read attached file</button>
            ) : null}
            <span className="hint-inline">{file ? `📎 ${file.name} — replaces the attached file` : "Starts from the quoted amount; the carrier's bill overrides it."}</span>
          </div>
          <div className="form-grid form-grid--cols4">
            <label className="form-field"><span>Bill No.</span><input value={f.bill_no} onChange={(e) => set({ bill_no: e.target.value })} /></label>
            <label className="form-field"><span>Bill date</span><input type="date" value={f.bill_date} onChange={(e) => set({ bill_date: e.target.value })} /></label>
            <label className="form-field"><span>Due date *</span><input type="date" value={f.due_date} onChange={(e) => set({ due_date: e.target.value })} /></label>
            <label className="form-field"><span>Currency</span>
              <select value={f.currency} onChange={(e) => set({ currency: e.target.value })}>
                {[...new Set([...CURRENCIES, f.currency])].map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
            <label className="form-field"><span>Actual amount (ex. VAT) *</span><Amount value={f.supply_amount} onChange={(v) => set({ supply_amount: v })} /></label>
            <label className="form-field"><span>VAT</span><Amount value={f.vat_amount} onChange={(v) => set({ vat_amount: v })} /></label>
            <div className="form-field"><span>Total to pay</span><b className="frt-total">{fmt(total, f.currency)}</b></div>
          </div>
          <div className="frt-bank">
            <div className="frt-bank-h">Pay to — carrier&apos;s bank account</div>
            {accounts.length > 1 ? (
              <div className="frt-bank-pick">
                {accounts.map((a) => (
                  <label key={a.bank_account}>
                    <input type="radio" checked={a.bank_account === f.bank_account} onChange={() => { set(a); setReadBank(true); }} />
                    {a.bank_name} {a.bank_account}
                  </label>
                ))}
              </div>
            ) : null}
            <div className="form-grid form-grid--cols4">
              <label className="form-field"><span>Bank</span><input value={f.bank_name} onChange={(e) => set({ bank_name: e.target.value })} /></label>
              <label className="form-field"><span>Account No.</span><input value={f.bank_account} onChange={(e) => set({ bank_account: e.target.value })} /></label>
              <label className="form-field form-field--span2"><span>Account holder</span><input value={f.bank_holder} onChange={(e) => set({ bank_holder: e.target.value })} /></label>
              <label className="form-field form-field--full"><span>Payment note (remitter name, giro / e-payment No.)</span>
                <input value={f.pay_ref} onChange={(e) => set({ pay_ref: e.target.value })} /></label>
            </div>
            <p className="hint-inline">
              {readBank ? "Read from the bill — check it. "
                : bank0?.from === "previous" ? `Filled from the last ${row.carrier} payment. `
                : bank0?.from === "vendor" ? "From the linked vendor's record (Partners). " : ""}
              Finance shows this account when you pay.
            </p>
          </div>
        </>
      )}
      <div className="frt-form-act">
        <span style={{ flex: 1 }} />
        <button type="button" className="btn sm" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="btn sm primary" disabled={busy || reading || (!link && (!f.due_date || f.supply_amount <= 0))}
                onClick={() => onSave({ body: link ? { payable_id: Number(link) } : f, file: link ? null : file })}>
          {busy ? "Saving…" : link ? "Link payment" : p ? "Save bill" : "Register in Finance"}
        </button>
      </div>
    </div>
  );
}

/** 등록된 청구서의 입금 계좌 한 줄 — 지급할 때 바로 복사한다. */
function PayTo({ bank, notes, paid }: { bank?: { bank_name: string; bank_account: string; bank_holder: string; swift: string } | null; notes?: string; paid: boolean }) {
  const [copied, setCopied] = useState(false);
  if (!bank && !notes && paid) return null;
  return (
    <div className="frt-payto">
      <span className="muted">Pay to</span>
      {bank ? (
        <>
          <b>{[bank.bank_name, bank.bank_account].filter(Boolean).join(" ")}</b>
          {bank.bank_holder ? <span>({bank.bank_holder})</span> : null}
          {bank.swift ? <span>SWIFT {bank.swift}</span> : null}
          {bank.bank_account ? (
            <button type="button" className="btn xs" onClick={() => {
              void navigator.clipboard?.writeText(bank.bank_account).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined);
            }}>{copied ? "Copied ✓" : "Copy"}</button>
          ) : null}
        </>
      ) : <span className="pod-none">No account on the bill — add it with Edit bill</span>}
      {notes ? <div className="muted frt-payto-note">{notes}</div> : null}
    </div>
  );
}

function PayButton({ paid, busy, onPay }: { paid: boolean; busy: boolean; onPay: (paid: boolean, on?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(today());
  if (paid) {
    return <button type="button" className="btn sm" disabled={busy} onClick={() => { if (confirm("Undo the payment of this freight?")) onPay(false); }}>Undo payment</button>;
  }
  return open ? (
    <span className="frt-paydate">
      <input type="date" value={on} onChange={(e) => setOn(e.target.value)} aria-label="Payment date" />
      <button type="button" className="btn sm primary" disabled={busy || !on} onClick={() => { setOpen(false); onPay(true, on); }}>Paid</button>
      <button type="button" className="btn sm" onClick={() => setOpen(false)}>Cancel</button>
    </span>
  ) : (
    <button type="button" className="btn sm" disabled={busy} onClick={() => setOpen(true)}>Mark paid</button>
  );
}

function ChargeRow({ doc, bill, suggest, editable, busy, onPick, onRegister, onSet }: {
  doc: Freight["docs"][number];
  /** 고른 운임이 매출채권에 선 상태(P/O 의 첫 줄에만). */
  bill?: Freight["billing"][number];
  onPick: (include: boolean) => void;
  /** carry — 고객이 다음 오더 때 함께 내기로 했으면 그 표시(메모)까지 한 번에. */
  onRegister: (amount: number, due: string, carry?: { note: string }) => Promise<boolean>;
  /** 이 문서에 실을 만한 금액(실제 비용을 문서 통화로) — 0 이면 제안하지 않는다. */
  suggest: number;
  editable: boolean;
  busy: boolean;
  onSet: (amount: number) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(0);
  const [reg, setReg] = useState(false);
  const [due, setDue] = useState(today());
  const [carry, setCarry] = useState(false);
  const [note, setNote] = useState("");
  const extra: ReactNode = doc.packing || doc.insurance ? fmt(doc.packing + doc.insurance, doc.currency) : "—";
  const tip = Math.round(suggest * 100) / 100;
  return (
    <>
    <tr>
      <td>
        <input type="checkbox" checked={doc.counted && !!doc.freight} disabled={!editable || busy || !doc.freight}
               aria-label={`Charge the freight on ${doc.no}`} title={doc.freight ? "Count this document's freight as charged to the buyer" : "No freight on this document"}
               onChange={(e) => onPick(e.target.checked)} />
      </td>
      <td><b>{doc.kind === "pi" ? "PI" : "CI"}</b> {doc.no}</td>
      <td>{doc.date || "—"}</td>
      <td className="num">{doc.freight ? fmt(doc.freight, doc.currency) : "—"}</td>
      <td className="num">{extra}</td>
      <td>
        {!doc.freight ? "—" : !doc.counted ? <span className="muted">Not counted</span> : !bill ? "—"
          : bill.unbilled > 0 ? (
            <span className="frt-reg">
              <span className="ar-badge overdue">Not in AR · {fmt(bill.unbilled, bill.currency)}</span>
              {/* 등록 폼은 이 칸이 아니라 바로 아래 한 줄(frt-reg-row)에 연다 — 칸 안에서 펼치면
                  표 열 폭이 통째로 다시 잡혀 화면이 크게 흔들린다. 버튼 자리는 그대로 둔다. */}
              {!editable || !bill.order_id ? null : (
                <button type="button" className={`btn sm${reg ? "" : " primary"}`} disabled={busy || reg}
                        onClick={() => { setDue(today()); setCarry(false); setNote(""); setReg(true); }}>＋ Register in AR</button>
              )}
            </span>
          ) : bill.has_main ? <span className="ar-badge">In AR ✓</span> : <span className="muted">No AR invoice yet</span>}
      </td>
      <td className="pod-act">
        {!editable ? null : open ? (
          <span className="frt-paydate">
            {tip > 0 && tip !== v ? <button type="button" className="btn sm" title="Actual cost in this document's currency" onClick={() => setV(tip)}>Cost {tip.toLocaleString("en-US")}</button> : null}
            <span>{doc.currency}</span>
            <Amount value={v} onChange={setV} autoFocus />
            <button type="button" className="btn sm primary" disabled={busy} onClick={async () => { if (await onSet(v)) setOpen(false); }}>Save</button>
            <button type="button" className="btn sm" onClick={() => setOpen(false)}>Cancel</button>
          </span>
        ) : (
          <button type="button" className="btn sm" disabled={busy} onClick={() => { setV(doc.freight); setOpen(true); }}>Set freight</button>
        )}
      </td>
    </tr>
    {reg && bill && bill.unbilled > 0 ? (
      <tr className="frt-reg-row">
        <td colSpan={7}>
          <div className="frt-reg-form">
            <b>Register {fmt(bill.unbilled, bill.currency)} in AR</b>
            <label className="frt-reg-f">
              <span>Due</span>
              <input type="date" value={due} aria-label="Due date" onChange={(e) => setDue(e.target.value)} />
            </label>
            <label className="frt-carry-chk" title="The customer will pay this with their next order — it shows on their next PI / CI instead of due-date alerts">
              <input type="checkbox" checked={carry} onChange={(e) => setCarry(e.target.checked)} />
              Collect with next order
            </label>
            {/* 메모 칸은 늘 자리를 잡아 둔다 — 체크할 때 칸이 생겼다 사라지면 줄이 흔들린다. */}
            <input className="frt-reg-note" value={note} disabled={!carry} onChange={(e) => setNote(e.target.value)}
                   placeholder={carry ? "Note — who agreed, when (optional)" : "Note (with next order only)"} />
            <span className="frt-reg-act">
              <button type="button" className="btn sm primary" disabled={busy || !due}
                      onClick={async () => { if (await onRegister(bill.unbilled, due, carry ? { note } : undefined)) setReg(false); }}>Register</button>
              <button type="button" className="btn sm" onClick={() => setReg(false)}>Cancel</button>
            </span>
          </div>
        </td>
      </tr>
    ) : null}
    </>
  );
}

function SeparateInvoice({ d, orderId, suggest, defaultDesc, busy, onCreate }: {
  d: Freight; orderId: number; suggest: number; defaultDesc: string; busy: boolean;
  onCreate: (b: { order_id: number; amount: number; currency: string; due_date: string; description: string }) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [oid, setOid] = useState(orderId);
  const [amount, setAmount] = useState(0);
  const [due, setDue] = useState("");
  const [desc, setDesc] = useState("");
  if (!open) {
    return (
      <div className="frt-sep">
        <button type="button" className="btn sm" disabled={busy}
                onClick={() => { setOid(orderId); setAmount(Math.round(suggest * 100) / 100); setDue(today()); setDesc(defaultDesc); setOpen(true); }}>
          ＋ Separate freight invoice
        </button>
        <span className="hint-inline">For freight that came up after the PI was issued or paid. Creates an extra invoice in stage 9 (AR) and Finance receivables.</span>
      </div>
    );
  }
  return (
    <div className="frt-form">
      <div className="form-grid form-grid--cols4">
        {d.orders.length > 1 ? (
          <label className="form-field"><span>Customer P/O</span>
            <select value={oid} onChange={(e) => setOid(Number(e.target.value))}>{d.orders.map((o) => <option key={o.id} value={o.id}>{o.po_no || `#${o.id}`}</option>)}</select>
          </label>
        ) : null}
        <label className="form-field"><span>Freight to charge ({d.currency}) *</span><Amount value={amount} onChange={setAmount} /></label>
        <label className="form-field"><span>Due date</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
        <label className="form-field form-field--span2"><span>Description</span><input value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
      </div>
      <div className="frt-form-act">
        <span style={{ flex: 1 }} />
        <button type="button" className="btn sm" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
        <button type="button" className="btn sm primary" disabled={busy || amount <= 0}
                onClick={async () => { if (await onCreate({ order_id: oid, amount, currency: d.currency, due_date: due, description: desc })) setOpen(false); }}>
          Create invoice
        </button>
      </div>
    </div>
  );
}


/** 청구서 한 장의 "다음 오더 때 받기" 칸 — 고객이 다음 발주 때 함께 내기로 한 돈.
 *  켜면 연체 알림 대신 이월 알림으로 돌고, 같은 고객사 다음 딜의 PI·CI 편집기가 한 줄로 얹으라고 띄운다. */
function CarryCell({ a, editable, busy, onSave }: {
  a: Freight["ar"][number]; editable: boolean; busy: boolean;
  onSave: (on: boolean, note: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  if (a.paid) return <span className="muted">—</span>;
  const put = a.carried_in ?? [];
  if (a.carry_next) {
    return (
      <span className="frt-carry">
        <span className="ar-badge carry" title={a.carry_note || undefined}>⇢ Collect with next order</span>
        {put.length ? (
          <span className="hint-inline">
            Added to {put.map((p) => (
              <a key={`${p.kind}${p.id}`} href={`/project?rfq=${p.rfq_id}&stage=7`}>{[p.project_no, p.no].filter(Boolean).join(" ")}</a>
            )).reduce<ReactNode[]>((acc, el, i) => (i ? [...acc, ", ", el] : [el]), [])}
          </span>
        ) : <span className="hint-inline">Not on a later PI / CI yet</span>}
        {a.carry_note ? <span className="hint-inline">“{a.carry_note}”</span> : null}
        {editable ? (
          <button type="button" className="btn xs" disabled={busy} onClick={() => void onSave(false, "")}
                  title="Collect this on its own again (back to normal due-date alerts)">Undo</button>
        ) : null}
      </span>
    );
  }
  if (!editable) return <span className="muted">—</span>;
  return open ? (
    <span className="frt-carry">
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note — who agreed, when (optional)" style={{ minWidth: 220 }} />
      <button type="button" className="btn sm primary" disabled={busy}
              onClick={async () => { if (await onSave(true, note)) setOpen(false); }}>Save</button>
      <button type="button" className="btn sm" onClick={() => setOpen(false)}>Cancel</button>
    </span>
  ) : (
    <button type="button" className="btn sm" disabled={busy} onClick={() => { setNote(""); setOpen(true); }}
            title="The customer will pay this with their next order — remind me on their next PI / CI">
      ⇢ Collect with next order
    </button>
  );
}
