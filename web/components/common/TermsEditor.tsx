"use client";

import type { QuotationTerms } from "@/lib/types";
import { TERM_PRESETS } from "@/lib/terms";
import ComboBox from "./ComboBox";

// 거래조건(Terms & Conditions) 편집기 — 견적(3·4단계)·오더(5)·발주서(6)에서 공통 사용.
// 각 필드는 콤보박스(선택 + 자유입력). 필수 항목은 라벨에 " *" 를 붙여 표시한다.
export default function TermsEditor({
  terms,
  onChange,
}: {
  terms: QuotationTerms;
  onChange: (terms: QuotationTerms) => void;
}) {
  function field(key: keyof QuotationTerms, label: string) {
    const presets = (TERM_PRESETS as Record<string, readonly string[]>)[key];
    return (
      <div className="form-field">
        <label>{label}</label>
        {presets ? (
          <ComboBox
            value={terms[key] ?? ""}
            onChange={(v) => onChange({ ...terms, [key]: v })}
            options={presets}
          />
        ) : (
          <input
            value={terms[key] ?? ""}
            onChange={(e) => onChange({ ...terms, [key]: e.target.value })}
          />
        )}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div className="sub-h">Terms &amp; Conditions</div>
      <div className="form-grid">
        {field("incoterms", "Incoterms *")}
        {field("delivery_place", "Place *")}
        {field("payment_terms", "Payment Terms *")}
        {field("packing", "Packing (optional)")}
        {field("warranty", "Warranty *")}
      </div>
      <div className="form-field" style={{ marginTop: 8 }}>
        <label>Remarks</label>
        <textarea
          rows={3}
          style={{ minHeight: 72 }}
          value={terms.remarks ?? ""}
          onChange={(e) => onChange({ ...terms, remarks: e.target.value })}
        />
      </div>
    </div>
  );
}
