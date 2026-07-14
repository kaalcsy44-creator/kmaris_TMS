"use client";

import { useMemo } from "react";
import type { CustomerQuoteItem, QuotationTerms } from "@/lib/types";
import Modal from "@/components/common/Modal";

// 견적서(QUOTATION / COSTING SHEET) 미리보기 데이터 — 편집기 현재 상태에서 조립.
export type QuotationPreviewData = {
  qtnNo: string;
  refNo: string;
  date: string;         // 표기용(YYYY-MM-DD 또는 표시 문자열)
  currency: string;
  vatLabel: string;     // "VAT excluded" 등
  validUntil: string;
  validityDays?: number;
  customerName: string;
  attn: string;
  shipName: string;
  project: string;
  items: CustomerQuoteItem[];
  terms: QuotationTerms;
};

function fmtNum(n: number): string {
  return (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// 첨부 양식 하단의 표준 K-MARIS Terms & Conditions 보일러플레이트.
// 일부 문구는 편집된 terms 값을 끼워 넣어 동기화한다.
function standardTerms(t: QuotationTerms, validityDays: number): string[] {
  const incoterms = t.incoterms || "EXW";
  const place = t.delivery_place || "Busan";
  const payment = t.payment_terms || "T/T in advance";
  const warranty = t.warranty || "supplier's/manufacturer's standard warranty terms";
  const lines = [
    `Quotation validity: ${validityDays} days from quotation date.`,
    "Price, availability, and delivery time are subject to final confirmation upon order placement.",
    `Delivery term: ${incoterms} ${place}, Incoterms 2020.`,
    "Freight, customs duty, local tax, and other logistics charges are excluded unless otherwise stated.",
    `Payment term: ${payment}`,
    "Buyer to confirm part number, description, quantity, engine type, and technical suitability before order.",
    "Certificates are excluded unless specifically stated.",
    "Cancellation or return may not be accepted after order confirmation, especially for specially ordered or non-stock items.",
    `Warranty follows ${warranty}.`,
    "The unit price suggested is based on the complete order with complete quantities. In case of reduction for qty, it may constitute a variation to the contract, subject to mutual agreement.",
  ];
  if (t.remarks && t.remarks.trim()) lines.push(t.remarks.trim());
  return lines;
}

export default function QuotationPreview({
  data,
  onClose,
  onDownload,
  busy,
  err,
}: {
  data: QuotationPreviewData;
  onClose: () => void;
  onDownload: (format: "pdf" | "xlsx") => void;
  busy?: boolean;
  err?: string | null;
}) {
  const total = useMemo(
    () => data.items.reduce((s, it) => s + (Number(it.amount) || 0), 0),
    [data.items]
  );
  const validityDays = data.validityDays ?? 30;
  const terms = standardTerms(data.terms, validityDays);
  const payment = data.terms.payment_terms || "T/T in advance";

  return (
    <Modal title="Quotation Preview" onClose={onClose} wide>
      <div className="qprev-toolbar">
        <span className="qprev-note">
          다운로드 시 현재 편집 내용이 먼저 저장된 뒤 문서가 생성됩니다.
        </span>
        <div className="qprev-actions">
          <button className="btn" onClick={() => onDownload("xlsx")} disabled={busy}>
            {busy ? "…" : "Excel 다운로드 (purchase·margin 포함)"}
          </button>
          <button className="btn primary" onClick={() => onDownload("pdf")} disabled={busy}>
            {busy ? "…" : "PDF 다운로드 (sales)"}
          </button>
        </div>
      </div>
      {err ? <div className="action-err">{err}</div> : null}

      <div className="qsheet">
        {/* 헤더 */}
        <div className="qsheet-top">
          <div className="qsheet-brand">⚓ K-MARIS</div>
          <div className="qsheet-org">K-MARIS ENERGY &amp; SOLUTIONS</div>
        </div>
        <h2 className="qsheet-title">QUOTATION / COSTING SHEET</h2>

        {/* 정보 박스 2단 */}
        <div className="qsheet-info">
          <table className="qsheet-meta">
            <tbody>
              <tr><th>User</th><td>{data.customerName || "—"}</td></tr>
              <tr><th>Messrs</th><td>{data.attn ? "Ms./Mr." : ""}</td></tr>
              <tr><th>Attn.</th><td>{data.attn || ""}</td></tr>
              <tr><th>Ship Name</th><td>{data.shipName || ""}</td></tr>
              <tr><th>Project</th><td>{data.project || ""}</td></tr>
            </tbody>
          </table>
          <table className="qsheet-meta">
            <tbody>
              <tr><th>Quotation No.</th><td>{data.qtnNo || "—"}</td></tr>
              <tr><th>Ref. No.</th><td>{data.refNo || ""}</td></tr>
              <tr><th>Date</th><td>{data.date || ""}</td></tr>
              <tr><th>Currency</th><td>{data.currency || "USD"}</td></tr>
              <tr><th>VAT</th><td>{data.vatLabel || "VAT excluded"}</td></tr>
            </tbody>
          </table>
        </div>

        {/* 품목표 (sales only) */}
        <table className="qsheet-items">
          <thead>
            <tr>
              <th>No.</th><th>Part No.</th><th className="l">Description</th>
              <th>Qty</th><th>U/Price</th><th>Amount</th><th>Lead Time</th><th>Remark</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((it, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>{it.part_no}</td>
                <td className="l">{it.description}</td>
                <td>{fmtNum(Number(it.qty))}</td>
                <td className="r">{fmtNum(Number(it.unit_price))}</td>
                <td className="r">{fmtNum(Number(it.amount))}</td>
                <td>{it.lead_time || ""}</td>
                <td>{it.remark || ""}</td>
              </tr>
            ))}
            {data.items.length === 0 ? (
              <tr><td colSpan={8} className="qsheet-empty">품목이 없습니다.</td></tr>
            ) : null}
            <tr className="qsheet-total">
              <td colSpan={5} className="r">Total</td>
              <td className="r">{fmtNum(total)}</td>
              <td colSpan={2} />
            </tr>
          </tbody>
        </table>

        {/* Terms & Conditions */}
        <div className="qsheet-section">Terms &amp; Conditions</div>
        <ul className="qsheet-terms">
          {terms.map((t, i) => <li key={i}>{t}</li>)}
        </ul>

        {/* Payment */}
        <div className="qsheet-section">Payment</div>
        <ul className="qsheet-terms">
          <li>{payment}</li>
          <li>Once order is confirmed by the supplier, the order is unable to be cancelled without cancellation charge of 100% of the ordered amount.</li>
        </ul>
        <p className="qsheet-closing">
          We hope this quotation meets your requirement and to receive your order confirmation at your earliest convenience.
        </p>

        {/* 서명 */}
        <div className="qsheet-sign">
          <div>Your sincerely</div>
          <div className="qsheet-sign-line" />
          <div className="qsheet-sign-name">Sam Cho, Managing Director</div>
        </div>
        <div className="qsheet-foot">
          K-MARIS Energy &amp; Solutions | Seoul, Korea | www.k-maris.com
        </div>
      </div>
    </Modal>
  );
}
