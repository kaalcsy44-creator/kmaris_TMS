"use client";

import type { QuotationTerms } from "@/lib/types";
import {
  TERM_PRESETS,
  QUOTATION_CLAUSES,
  clauseRows,
  remarkRows,
  withClauseRows,
  withRemarkRows,
  type ClauseContext,
} from "@/lib/terms";
import { fetchTermValues } from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";
import ComboBox, { type ComboSection } from "./ComboBox";
import TermRowsEditor from "./TermRowsEditor";

/** 목록에서 같은 값(공백·대소문자만 다른 것 포함)을 한 번만 — 앞에 나온 묶음이 이긴다. */
const normTerm = (v: string) => v.split(/\s+/).join(" ").trim().toLowerCase();

// 거래조건(Terms & Conditions) 편집기 — 견적(3·4단계)·오더(5)·발주서(6)에서 공통 사용.
// 각 필드는 콤보박스(선택 + 자유입력). 필수 항목은 라벨에 " *" 를 붙여 표시한다.
// clauses=true 면 견적서에 찍히는 Remark·T&C 를 행 단위로 편집한다(4단계 전용) —
// 다른 문서(벤더 견적·발주서)는 이 문장들을 쓰지 않으므로 기본은 숨김.
// omit 은 문서 양식이 그 조건을 자기 섹션에서 이미 묻고 있을 때 쓴다(발주서의
// Payment Terms·Place 는 "Order/Supplier information" 칸에 있으므로 여기선 뺀다).
export default function TermsEditor({
  terms,
  onChange,
  clauses,
  omit,
  suggest,
  clauseContext,
}: {
  terms: QuotationTerms;
  onChange: (terms: QuotationTerms) => void;
  clauses?: boolean;
  omit?: (keyof QuotationTerms)[];
  /** 이 딜에서 받은 견적들이 적어 보낸 값 — 목록 맨 앞 "From vendor quotes" 묶음에 선다. */
  suggest?: Partial<Record<keyof QuotationTerms, string[]>>;
  /** 문장에 끼울 문서 값(Valid until·견적일) — 유효기간 문장이 입력한 날짜를 따른다. */
  clauseContext?: ClauseContext;
}) {
  // 지금까지 문서에 적힌 값 — 코드에 박힌 기본값만으로는 벤더가 보낸 "Shanghai, China" 가
  // 목록에 없었다. 한 번 쓴 값은 다음부터 선택지에 선다(서버 집계, 저장하면 새로 받는다).
  const { data: learned } = useCachedData("term-values", fetchTermValues, 10 * 60_000);

  function sectionsFor(key: keyof QuotationTerms, presets: readonly string[]): ComboSection[] {
    const seen = new Set<string>();
    const take = (vals: readonly string[] | undefined) =>
      (vals ?? []).filter((v) => {
        const k = normTerm(v || "");
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    const groups: ComboSection[] = [
      { label: "From vendor quotes", options: take(suggest?.[key]) },
      { label: "Standard", options: take(presets) },
      { label: "Used before", options: take(learned?.[key as string]) },
    ];
    return groups.filter((g) => g.options.length > 0);
  }

  function field(key: keyof QuotationTerms, label: string) {
    if (omit?.includes(key)) return null;
    const presets = (TERM_PRESETS as Record<string, readonly string[]>)[key];
    const value = (terms[key] as string) ?? "";
    return (
      <div className="form-field">
        <label>{label}</label>
        {presets ? (
          <ComboBox
            value={value}
            onChange={(v) => onChange({ ...terms, [key]: v })}
            sections={sectionsFor(key, presets)}
          />
        ) : (
          <input value={value} onChange={(e) => onChange({ ...terms, [key]: e.target.value })} />
        )}
      </div>
    );
  }

  // 견적서(clauses)는 인쇄본과 같은 세 섹션(Remark → Terms & Conditions → Payment)을
  // 같은 급의 제목 띠로 세운다 — 입력란이 한 덩어리로 섞여 있으면 어느 칸이 문서의
  // 어느 섹션으로 가는지 알 수 없다. Remark·T&C 본문은 행 편집기(체크한 행만 인쇄).
  // 표준 문장 안의 거래조건 값(Incoterms·보증)은 문구를 고치지 않은 한 인쇄 시점에 다시 채워진다.
  if (clauses) {
    return (
      <div className="stage-card terms-doc" style={{ marginTop: 12 }}>
        <section className="terms-sec">
          <div className="terms-sec-h">Remark</div>
          <TermRowsEditor
            kind="remark"
            rows={remarkRows(terms)}
            onChange={(rows) => onChange(withRemarkRows(terms, rows))}
          />
        </section>

        <section className="terms-sec">
          <div className="terms-sec-h">Terms &amp; Conditions</div>
          <div className="form-grid">
            {field("incoterms", "Incoterms *")}
            {field("delivery_place", "Place *")}
            {field("packing", "Packing (optional)")}
            {field("warranty", "Warranty *")}
          </div>
          <TermRowsEditor
            kind="terms"
            rows={clauseRows(terms)}
            onChange={(rows) => onChange(withClauseRows(terms, rows))}
            standard={QUOTATION_CLAUSES.map((c) => ({ id: c.id, text: c.text(terms, clauseContext) }))}
          />
        </section>

        <section className="terms-sec">
          <div className="terms-sec-h">Payment</div>
          <div className="form-grid">{field("payment_terms", "Payment Terms *")}</div>
        </section>
      </div>
    );
  }

  return (
    <div className="stage-card" style={{ marginTop: 12 }}>
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
