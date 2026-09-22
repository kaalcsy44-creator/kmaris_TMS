"use client";

/**
 * 공급사 견적 취합 — 받은 견적 여러 장을 골라 고객 견적 한 장에 싣는다.
 *
 * 한 건에 물어볼 곳이 여럿이면(A/E 는 A, 보일러는 B, 소화장치는 C) 3단계에는 견적이
 * 두세 장 서고, 그 셋을 4단계에서 한 장으로 합쳐 내보낸다. 예전에는 드롭다운에서 한 장을
 * 고르면 품목표가 통째로 갈렸으므로, 두 번째 견적은 늘 손으로 옮겨 적어야 했다.
 *
 * 이 창이 하는 일은 셋이다.
 *   ① 받은 견적을 한 자리에 눕히고 — 무엇이 이미 실렸는지 배지로 알리고
 *   ② 붙일지(Append) 갈아 끼울지(Replace) 를 묻고
 *   ③ 통화가 다른 견적은 무엇이 환산되는지·무엇이 불가능한지 먼저 말한다.
 *
 * 줄이 겹치면(같은 라인 ID·같은 품번) 뒤에 부른 쪽을 건너뛴다 — 한 줄은 한 곳에서 산다.
 * 어느 곳에서 살지 고르는 일은 3단계 채택 매트릭스의 몫이다.
 */

import { useState } from "react";
import Modal from "@/components/common/Modal";
import VendorName from "@/components/common/VendorName";
import { costConvertible, hasSource } from "@/lib/quoteMerge";
import type { CostSource } from "@/lib/quoteMerge";
import type { CustomerQuoteItem, VendorQuoteForImport } from "@/lib/types";

export type MergeMode = "append" | "replace";

export default function VendorQuoteMergeModal({
  quotes,
  items,
  costCurrency,
  onLoad,
  onClose,
}: {
  quotes: VendorQuoteForImport[];
  /** 지금 품목표에 실려 있는 줄 — 이미 부른 견적에 배지를 달고, 기본 방식을 정한다. */
  items: CustomerQuoteItem[];
  /** 이 견적서의 원가 통화. 다른 통화의 견적은 이 통화로 환산해 싣는다. */
  costCurrency: string;
  onLoad: (ids: number[], mode: MergeMode) => void;
  onClose: () => void;
}) {
  const rows = items.filter((it) => String(it.row_kind || "") !== "option");
  const hasItems = rows.length > 0;
  // 딜 품목으로 미리 깔아 둔 빈 줄(원가 0·출처 없음)뿐이면 갈아 끼우기가 맞다 — 그 줄들은
  // 지킬 값이 아직 없다. 값이 실린 표에서는 붙이기가 기본이다(먼저 부른 견적을 지킨다).
  const seedOnly = hasItems && rows.every((it) => !Number(it.src_vq_id || 0) && !Number(it.cost_price || 0));
  const [mode, setMode] = useState<MergeMode>(hasItems && !seedOnly ? "append" : "replace");
  // 아직 안 실린 견적을 처음부터 골라 둔다 — 대개 그것을 부르려고 연 창이다.
  const [picked, setPicked] = useState<Set<number>>(
    () => new Set(quotes.filter((q) => !hasSource(items, q.id)).map((q) => q.id))
  );
  const cur = (costCurrency || "USD").toUpperCase();

  const toggle = (id: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const chosen = quotes.filter((q) => picked.has(q.id));
  const lines = chosen.reduce((n, q) => n + q.items.length, 0);
  // 환산할 수 없는 통화(USD·KRW 밖)는 숫자가 그대로 통과해 조용히 틀린 원가가 된다.
  const blocked = chosen.filter((q) => !costConvertible(q.currency, cur));
  const converted = chosen.filter((q) => costConvertible(q.currency, cur) && (q.currency || "").toUpperCase() !== cur);

  return (
    <Modal title="Load vendor quotes" onClose={onClose} maxWidth={860}>
      <div className="vqm">
        <p className="vqm-lead">
          Pick every vendor quote whose prices belong in this quotation. A line that is already
          priced here is left as it is, and a line still waiting for a price is filled in place —
          so the same line never lands twice.
        </p>

        <div className="table-wrap">
          <table className="mini wide">
            <thead>
              <tr>
                <th className="vqm-chk" />
                <th>Received</th>
                <th>Vendor</th>
                <th>Quote No.</th>
                <th>Cur.</th>
                <th className="num">Items</th>
                <th>In this quotation</th>
              </tr>
            </thead>
            <tbody>
              {quotes.length === 0 ? (
                <tr><td colSpan={7} className="vqm-empty">No vendor quote has been received for this deal yet.</td></tr>
              ) : quotes.map((q) => {
                const loaded = hasSource(items, q.id);
                const bad = picked.has(q.id) && !costConvertible(q.currency, cur);
                return (
                  <tr key={q.id} className={bad ? "vqm-bad" : undefined} onClick={() => toggle(q.id)}>
                    <td className="vqm-chk">
                      <input
                        type="checkbox"
                        checked={picked.has(q.id)}
                        onChange={() => toggle(q.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <td>{q.received_date || "—"}</td>
                    <td><VendorName name={q.vendor} /></td>
                    <td>{q.vendor_quote_no || "—"}</td>
                    <td>{(q.currency || "—").toUpperCase()}</td>
                    <td className="num">{q.items.length}</td>
                    <td>
                      {loaded
                        ? <span className="vqm-tag on">Already loaded</span>
                        : <span className="vqm-tag">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="vqm-mode">
          <label>
            <input type="radio" checked={mode === "append"} onChange={() => setMode("append")} />
            <b>Append</b> — keep what is in the list; rows waiting for a price are filled in place
          </label>
          <label>
            <input type="radio" checked={mode === "replace"} onChange={() => setMode("replace")} />
            <b>Replace</b> — clear the list first
          </label>
        </div>

        {converted.length > 0 ? (
          <p className="vqm-note">
            {converted.map((q) => `${q.vendor} (${(q.currency || "").toUpperCase()})`).join(" · ")} will be
            converted to {cur} at the FX rate on the Pricing band. The vendor&apos;s own figure is kept on
            each line, so changing the rate re-converts it.
          </p>
        ) : null}
        {chosen.length > 1 ? (
          <p className="vqm-note">
            Terms (Incoterms · Payment · Delivery …) are not merged when you load more than one quote —
            three vendors carry three sets of terms, and the customer must see one. Set them below.
          </p>
        ) : null}
        {blocked.length > 0 ? (
          <p className="vqm-err">
            {blocked.map((q) => `${q.vendor} (${(q.currency || "").toUpperCase()})`).join(" · ")} cannot be
            converted to {cur} — only USD↔KRW has a rate here. Unpick it, or set the cost currency to
            match, and enter those lines by hand.
          </p>
        ) : null}

        <div className="form-actions">
          <span className="vqm-count">
            {chosen.length} quote(s) · {lines} line(s)
          </span>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn primary"
            disabled={chosen.length === 0 || blocked.length > 0}
            onClick={() => onLoad(chosen.map((q) => q.id), mode)}
          >
            {mode === "replace" ? "Replace item list" : "Add to item list"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** 품목표 위에 서는 출처 띠 — 이 견적의 원가가 어디서 왔는지, 각각 몇 줄·얼마인지.
 *  합쳐 담을 수 있게 된 뒤로는 "이 견적서의 매입처"가 한 곳이 아니므로, 그 사실이
 *  화면 어딘가에 늘 보여야 한다. ×를 누르면 그 출처의 줄만 통째로 걷힌다. */
export function QuoteSourceBand({
  sources,
  manual,
  legacy,
  costCurrency,
  onDrop,
  onOpen,
  disabled,
}: {
  sources: CostSource[];
  /** 출처가 적혀 있지 않은 줄 수(손으로 친 줄·옛 견적). */
  manual: number;
  /** 문서에만 걸려 있고 어느 줄에도 닿지 않은 옛 링크 — 그래도 어느 견적을 보고 만든
   *  견적서인지는 말해 줘야 한다(줄과 맞지 않으면 값까지 옮겨 적을 수는 없다). */
  legacy?: { vendor: string; vq_no: string } | null;
  costCurrency: string;
  onDrop?: (vqId: number) => void;
  onOpen?: () => void;
  disabled?: boolean;
}) {
  if (sources.length === 0 && manual === 0 && !legacy) return null;
  const cur = (costCurrency || "USD").toUpperCase();
  return (
    <div className="qsb">
      <span className="qsb-t">Cost sources</span>
      {sources.map((s) => (
        <span key={s.vq_id} className="qsb-chip" title={`${s.lines} line(s) · ${Math.round(s.cost).toLocaleString()} ${cur}`}>
          <VendorName name={s.vendor} />
          <span className="qsb-no">{s.vq_no || "—"}</span>
          <span className="qsb-n">{s.lines} line{s.lines === 1 ? "" : "s"}</span>
          <span className="qsb-amt">{Math.round(s.cost).toLocaleString()} {cur}</span>
          {onDrop && !disabled ? (
            <button
              type="button"
              className="qsb-x"
              title="Remove every line that came from this vendor quote"
              onClick={() => onDrop(s.vq_id)}
            >
              ×
            </button>
          ) : null}
        </span>
      ))}
      {legacy ? (
        <span
          className="qsb-chip qsb-chip--legacy"
          title="This quotation is linked to that vendor quote, but none of its lines match the ones below — the prices here were edited or typed in."
        >
          <VendorName name={legacy.vendor} />
          <span className="qsb-no">{legacy.vq_no || "—"}</span>
          <span className="qsb-n">linked</span>
        </span>
      ) : null}
      {manual > 0 ? (
        <span
          className="qsb-chip qsb-chip--manual"
          title="Lines with no vendor quote behind them — typed by hand, waiting for a price, or loaded before cost sources were recorded"
        >
          No source · {manual} line{manual === 1 ? "" : "s"}
        </span>
      ) : null}
      {onOpen && !disabled ? (
        <button type="button" className="btn sm qsb-add" onClick={onOpen}>+ Vendor quote</button>
      ) : null}
    </div>
  );
}
