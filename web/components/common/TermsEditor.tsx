"use client";

import type { QuotationTerms } from "@/lib/types";
import { TERM_PRESETS, QUOTATION_CLAUSES, selectedClauseIds } from "@/lib/terms";
import { fetchTermValues } from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";
import ComboBox, { type ComboSection } from "./ComboBox";

/** 목록에서 같은 값(공백·대소문자만 다른 것 포함)을 한 번만 — 앞에 나온 묶음이 이긴다. */
const normTerm = (v: string) => v.split(/\s+/).join(" ").trim().toLowerCase();

// 거래조건(Terms & Conditions) 편집기 — 견적(3·4단계)·오더(5)·발주서(6)에서 공통 사용.
// 각 필드는 콤보박스(선택 + 자유입력). 필수 항목은 라벨에 " *" 를 붙여 표시한다.
// clauses=true 면 견적서에 찍히는 표준 문장 목록을 함께 보여 준다(4단계 전용) —
// 다른 문서(벤더 견적·발주서)는 이 문장들을 쓰지 않으므로 기본은 숨김.
// omit 은 문서 양식이 그 조건을 자기 섹션에서 이미 묻고 있을 때 쓴다(발주서의
// Payment Terms·Place 는 "Order/Supplier information" 칸에 있으므로 여기선 뺀다).
export default function TermsEditor({
  terms,
  onChange,
  clauses,
  omit,
  suggest,
}: {
  terms: QuotationTerms;
  onChange: (terms: QuotationTerms) => void;
  clauses?: boolean;
  omit?: (keyof QuotationTerms)[];
  /** 이 딜에서 받은 견적들이 적어 보낸 값 — 목록 맨 앞 "From vendor quotes" 묶음에 선다. */
  suggest?: Partial<Record<keyof QuotationTerms, string[]>>;
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

  // 체크한 문장만 문서에 찍힌다. 저장은 항상 id 배열로 — 문장 안의 거래조건 값
  // (Incoterms·결제·보증)은 인쇄 시점에 다시 채워지므로 나중에 조건을 바꿔도 따라간다.
  const picked = new Set(selectedClauseIds(terms));
  const toggleClause = (id: string) => {
    const next = QUOTATION_CLAUSES.filter((c) => (c.id === id ? !picked.has(c.id) : picked.has(c.id)));
    onChange({ ...terms, clauses: next.map((c) => c.id) });
  };
  const allOn = picked.size === QUOTATION_CLAUSES.length;

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

      {clauses ? (
        <div className="clause-picker">
          <div className="clause-head">
            <span className="clause-title">Clauses printed on the quotation</span>
            <span className="clause-count">{picked.size} / {QUOTATION_CLAUSES.length}</span>
            {/* 전체 선택/해제 — 값을 바꾸는 조작이라 읽기모드에선 CSS 가 감춘다(.clause-all). */}
            <button
              type="button"
              className="btn sm clause-all"
              onClick={() =>
                onChange({ ...terms, clauses: allOn ? [] : QUOTATION_CLAUSES.map((c) => c.id) })
              }
            >
              {allOn ? "Clear all" : "Select all"}
            </button>
          </div>
          <ul className="clause-list">
            {QUOTATION_CLAUSES.map((c) => (
              <li key={c.id}>
                <label className={"clause-item" + (picked.has(c.id) ? " on" : "")}>
                  <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggleClause(c.id)} />
                  {/* 위 거래조건 필드가 들어간 문장은 지금 값 그대로 보여 준다 — 보이는 문장이 곧 찍힐 문장. */}
                  <span>{c.text(terms)}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="form-field" style={{ marginTop: 8 }}>
            <label>Additional clauses (one per line)</label>
            <textarea
              rows={2}
              value={(terms.extra_clauses || []).join("\n")}
              onChange={(e) =>
                onChange({
                  ...terms,
                  extra_clauses: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean),
                })
              }
              placeholder="Printed after the standard clauses above."
            />
          </div>
        </div>
      ) : null}

      <div className="form-field" style={{ marginTop: 8 }}>
        <label>Remarks{clauses ? " — printed as its own Remark section above Terms & Conditions" : ""}</label>
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
