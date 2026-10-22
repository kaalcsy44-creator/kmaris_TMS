"use client";

// 프로젝트 요약 창 — 돈 한 건(Finance 캘린더 상세 창)을 보다가 "이게 무슨 딜이었지"를
// 단계 창으로 넘어가지 않고 한 장에서 읽는다. 고객·선박·견적·고객 P/O·품목·거래선·청구/수금·마진.
// 값은 전부 서버(/finance/project-summary)가 기존 레코드에서 모아 준 것이다.
import { useEffect, useState } from "react";
import Modal from "@/components/common/Modal";
import { fetchProjectSummary } from "@/lib/api";
import type { ProjectSummary } from "@/lib/types";

const SYM: Record<string, string> = { KRW: "₩", USD: "$", EUR: "€", JPY: "¥", CNY: "¥", GBP: "£" };

function amt(v: number | null | undefined, cur: string): string {
  if (v === null || v === undefined) return "—";
  const c = (cur || "").toUpperCase();
  const digits = c === "KRW" || c === "JPY" || Number.isInteger(v) ? 0 : 2;
  const n = v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return SYM[c] ? `${SYM[c]}${n}` : `${n} ${c}`.trim();
}

const WORK_TYPE: Record<string, string> = { 부품공급: "Parts", 서비스: "Service" };
const TRADE: Record<string, string> = { 수출: "Export", 내수: "Domestic" };

function Row({ k, v }: { k: string; v?: React.ReactNode }) {
  if (v === undefined || v === null || v === "") return null;
  return (
    <tr>
      <th>{k}</th>
      <td>{v}</td>
    </tr>
  );
}

export default function ProjectSummaryModal({ rfqId, onClose }: { rfqId: number; onClose: () => void }) {
  const [d, setD] = useState<ProjectSummary | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    fetchProjectSummary(rfqId)
      .then((r) => live && setD(r))
      .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => { live = false; };
  }, [rfqId]);

  const title = d ? `${d.project_no.split("(")[0] || "Project"} · ${d.title || d.customer.name}` : "Project summary";
  const m = d?.money;

  return (
    <Modal title={title} onClose={onClose} form maxWidth={860}>
      <div className="psum">
        {err ? <div className="action-err">{err}</div> : null}
        {!d && !err ? <div className="state">Loading…</div> : null}
        {d ? (
          <>
            <div className="psum-band">
              <span className={`psum-stage${d.closed ? " closed" : ""}`}>
                {d.closed ? `Closed ${d.closed_at.slice(0, 10)}` : d.stage_label}
              </span>
              <span>{d.project_no}</span>
              <span>{WORK_TYPE[d.work_type] || d.work_type}</span>
              {d.pic ? <span>PIC {d.pic}</span> : null}
              {d.received_at ? <span>RFQ {d.received_at.replace("T", " ")}</span> : null}
            </div>

            <div className="psum-grid">
              <section>
                <h4>Customer</h4>
                <table className="psum-kv"><tbody>
                  <Row k="Company" v={<b>{d.customer.name}</b>} />
                  <Row k="Contact" v={d.customer.contact} />
                  <Row k="Email" v={d.customer.email} />
                  <Row k="Country" v={d.customer.country} />
                  <Row k="Customer RFQ" v={d.customer_rfq_no} />
                  <Row k="Introduced by" v={d.consultant} />
                </tbody></table>
              </section>
              <section>
                <h4>Vessel</h4>
                {d.vessel ? (
                  <table className="psum-kv"><tbody>
                    <Row k="Name" v={<b>{d.vessel.name}</b>} />
                    <Row k="IMO" v={d.vessel.imo} />
                    <Row k="Type" v={d.vessel.type} />
                    <Row k="Flag" v={d.vessel.flag} />
                    <Row k="Hull No." v={d.vessel.hull_no} />
                    <Row k="Engine" v={d.vessel.engine} />
                  </tbody></table>
                ) : <div className="psum-none">No vessel</div>}
              </section>
            </div>

            <section>
              <h4>Deal amount</h4>
              <div className="psum-money">
                <div>
                  <span>Sales</span>
                  <b>{m && m.sales_krw ? amt(m.sales_krw, "KRW") : "—"}</b>
                  <small>{m?.sales_basis}</small>
                </div>
                <div>
                  <span>Purchase</span>
                  <b>{m && m.cost_krw ? amt(m.cost_krw, "KRW") : "—"}</b>
                  <small>Vendor bills (net) or P/O</small>
                </div>
                <div className={m && m.margin_krw !== null && m.margin_krw < 0 ? "neg" : ""}>
                  <span>Margin</span>
                  <b>{m && m.margin_krw !== null ? amt(m.margin_krw, "KRW") : "—"}</b>
                  <small>{m && m.margin_pct !== null ? `${m.margin_pct}%` : "needs sales and purchase"}</small>
                </div>
              </div>
              <table className="psum-kv"><tbody>
                {d.quote ? (
                  <Row k="Quotation" v={<>
                    <b>{amt(d.quote.total, d.quote.currency)}</b>
                    {` · ${d.quote.no || "—"} · ${d.quote.sent ? `sent ${d.quote.sent}` : d.quote.date}`}
                    {d.quote.count > 1 ? ` · ${d.quote.count} versions` : ""}
                  </>} />
                ) : null}
                {d.orders.map((o) => (
                  <Row key={o.id} k="Customer P/O" v={<>
                    <b>{amt(o.amount, o.currency)}</b>
                    {` · ${o.po_no || "—"} · ${o.date}`}
                    {o.trade_type ? ` · ${TRADE[o.trade_type] || o.trade_type}` : ""}
                    {o.incoterms ? ` · ${o.incoterms}` : ""}
                    {o.payment_terms ? ` · ${o.payment_terms}` : ""}
                    {o.delivered_date ? ` · delivered ${o.delivered_date}`
                      : o.promised_delivery ? ` · promised ${o.promised_delivery}` : ""}
                  </>} />
                ))}
              </tbody></table>
            </section>

            <section>
              <h4>Items <small>{d.items.length} · from {d.items_source}</small></h4>
              {d.items.length ? (
                <div className="psum-scroll">
                  <table className="psum-table">
                    <thead><tr>
                      <th>#</th><th>Description</th><th>Part No.</th><th>Maker</th>
                      <th className="num">Qty</th><th className="num">Unit price</th><th className="num">Amount</th>
                    </tr></thead>
                    <tbody>
                      {d.items.map((it, i) => (
                        <tr key={i}>
                          <td>{i + 1}</td>
                          <td className="psum-desc">{it.description}</td>
                          <td>{it.part_no}</td>
                          <td>{[it.maker, it.model].filter(Boolean).join(" · ")}</td>
                          <td className="num">{it.qty}{it.unit ? ` ${it.unit}` : ""}</td>
                          <td className="num">{it.unit_price !== null && d.items_currency ? amt(it.unit_price, d.items_currency) : ""}</td>
                          <td className="num">{it.amount !== null && d.items_currency ? amt(it.amount, d.items_currency) : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <div className="psum-none">No items</div>}
            </section>

            <section>
              <h4>Vendors</h4>
              {d.vendors.length ? (
                <table className="psum-table">
                  <thead><tr>
                    <th>Vendor</th><th>Quote</th><th>Vendor P/O</th>
                    <th className="num">P/O amount</th><th className="num">Billed</th><th className="num">Paid</th><th>Tax inv.</th>
                  </tr></thead>
                  <tbody>
                    {d.vendors.map((v, i) => {
                      const quote = v.quoted
                        ? (v.quote_total !== null ? amt(v.quote_total, v.quote_currency) : "Quoted")
                        : v.asked ? <span className="psum-muted">No reply</span> : "";
                      if (!v.pos.length) {
                        return (
                          <tr key={i}>
                            <td><b>{v.name}</b></td><td>{quote}</td>
                            <td colSpan={5} className="psum-muted">Not ordered</td>
                          </tr>
                        );
                      }
                      return v.pos.map((p, j) => (
                        <tr key={`${i}-${j}`}>
                          <td>{j === 0 ? <b>{v.name}</b> : ""}</td>
                          <td>{j === 0 ? quote : ""}</td>
                          <td>{p.po_no}{p.date ? <small className="psum-muted"> {p.date}</small> : null}</td>
                          <td className="num">{p.amount ? amt(p.amount, p.currency) : ""}</td>
                          <td className="num">{p.billed ? amt(p.billed, p.bill_currency) : <span className="psum-muted">—</span>}</td>
                          <td className="num">{p.paid ? amt(p.paid, p.bill_currency) : <span className="psum-muted">—</span>}</td>
                          <td>{p.tax_received ? "✓" : <span className="psum-muted">—</span>}</td>
                        </tr>
                      ));
                    })}
                  </tbody>
                </table>
              ) : <div className="psum-none">No vendors yet</div>}
            </section>

            <section>
              <h4>Customer invoices</h4>
              {d.ar.length ? (
                <table className="psum-table">
                  <thead><tr>
                    <th>Invoice</th><th>Date</th><th>Due</th>
                    <th className="num">Amount</th><th className="num">Received</th><th className="num">Outstanding</th>
                  </tr></thead>
                  <tbody>
                    {d.ar.map((r, i) => (
                      <tr key={i}>
                        <td>{r.invoice_no || "—"}{r.kind === "extra" ? " · Extra" : ""}</td>
                        <td>{r.date}</td>
                        <td>{r.due}</td>
                        <td className="num">{amt(r.amount, r.currency)}</td>
                        <td className="num">{r.paid ? amt(r.paid, r.currency) : <span className="psum-muted">—</span>}</td>
                        <td className={`num${r.outstanding > 0 ? " psum-due" : ""}`}>
                          {r.outstanding > 0 ? amt(r.outstanding, r.currency) : `Paid${r.paid_date ? ` ${r.paid_date}` : ""}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <div className="psum-none">Not invoiced yet</div>}
            </section>
            <p className="psum-foot">
              Amounts in foreign currency are converted to KRW at the month-end base rate of each document&apos;s month.
            </p>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
