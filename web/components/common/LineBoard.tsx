"use client";

/**
 * 라인 소싱 보드 — 품목 줄(행) × 물어본 곳(열).
 *
 * 한 딜에 품목이 열일곱 줄이라고 그 열일곱 줄이 모두 한 곳에서 오지는 않는다.
 * 여섯 줄은 A, 아홉 줄은 B, 두 줄은 아직 아무도 못 준다고 한다. 그 사정은 여태
 * 벤더 RFQ 문서 세 장에 흩어져 있었고, "무엇이 아직 안 나갔나"를 알려면 세 장을
 * 다 열어 봐야 했다. 이 표는 그 세 장을 한 화면에 눕힌다.
 *
 * 같은 표를 두 단계가 쓴다. 쓰임이 다를 뿐 보는 사실은 같아야 하기 때문이다.
 *   mode="coverage"(2단계) — 어디까지 나갔나. 줄을 골라 다음 벤더에게 보낸다.
 *   mode="award"(3단계)   — 어디서 살까. 줄마다 벤더 견적 하나를 고른다.
 *
 * 한 줄은 한 곳에서 산다(서버의 rfq_id+lid 유일 제약). 쪼개 사야 하면 1단계에서
 * 줄을 둘로 나눈다.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchLineBoard, saveLineAwards } from "@/lib/api";
import type { BoardLine, LineBoard as LineBoardData, LineCell } from "@/lib/types";
import VendorName from "@/components/common/VendorName";

export type LineBoardMode = "coverage" | "award";

const STATE_LABEL: Record<BoardLine["state"], string> = {
  not_sourced: "Not sourced",
  sourcing: "Waiting",
  quoted: "Quoted",
  awarded: "Awarded",
  declined: "No quote",
};

/** 칸 하나가 뜻하는 것 — 마우스를 올렸을 때 읽히는 말. */
const CELL_TITLE: Record<LineCell["state"], string> = {
  sent: "Asked — no reply yet",
  quoted: "Quoted",
  no_price: "Replied, but this line has no price",
  omitted: "Quote received, but this line was left out",
  declined: "Declined to quote",
};

function money(v: number | null | undefined, cur?: string): string {
  if (v == null) return "—";
  const n = Number(v);
  const s = n.toLocaleString(undefined, {
    minimumFractionDigits: n % 1 ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return cur && cur !== "USD" ? `${s} ${cur}` : `$${s}`;
}

export default function LineBoard({
  rfqId,
  mode,
  onSendSelected,
  onChanged,
  reloadKey,
}: {
  rfqId: number;
  mode: LineBoardMode;
  /** 2단계 — 고른 줄로 다음 벤더 RFQ 를 연다. 없으면 고르기 자체를 숨긴다. */
  onSendSelected?: (lids: string[]) => void;
  /** 채택이 바뀌면 알린다(상위 목록·배지 새로고침). */
  onChanged?: () => void;
  /** 값이 바뀌면 다시 불러온다 — 벤더 RFQ 를 하나 더 보낸 직후 등. */
  reloadKey?: number;
}) {
  const [data, setData] = useState<LineBoardData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());

  const load = useCallback(() => {
    if (!rfqId) return;
    fetchLineBoard(rfqId)
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed to load the sourcing board"));
  }, [rfqId]);
  useEffect(() => { load(); }, [load, reloadKey]);

  const lines = data?.lines ?? [];
  const vendors = data?.vendors ?? [];
  const cells = data?.cells ?? {};

  // 옛 딜은 품목 줄에 이름이 없다 — 보기는 되지만 채택은 저장할 곳이 없다.
  const unnamed = data ? data.lines_total - data.lines_named : 0;

  const toggle = (lid: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(lid)) next.delete(lid); else next.add(lid);
      return next;
    });

  /** 아직 아무 데도 안 물어본 줄만 고른다 — 다음 벤더에게 보낼 후보. */
  const pickUnsourced = () =>
    setPicked(new Set(lines.filter((l) => l.state === "not_sourced").map((l) => l.lid)));

  async function award(lid: string, vendorQuoteId: number | null) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const d = await saveLineAwards(rfqId, [{ lid, vendor_quote_id: vendorQuoteId }]);
      setData(d);
      setMsg(vendorQuoteId ? `${lid} awarded.` : `${lid} cleared.`);
      onChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save the award");
    } finally {
      setBusy(false);
    }
  }

  /** 값이 온 줄마다 최저가를 한 번에 고른다. 이미 고른 줄은 건드리지 않는다. */
  async function awardAllBest() {
    const todo = lines
      .filter((l) => l.named && !l.award && l.best?.vendor_quote_id)
      .map((l) => ({ lid: l.lid, vendor_quote_id: l.best!.vendor_quote_id! }));
    if (!todo.length) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const d = await saveLineAwards(rfqId, todo);
      setData(d);
      setMsg(`${todo.length} line(s) awarded to the lowest quote. Change any of them below.`);
      onChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save the awards");
    } finally {
      setBusy(false);
    }
  }

  const bestCount = useMemo(
    () => lines.filter((l) => l.named && !l.award && l.best?.vendor_quote_id).length,
    [lines]
  );
  const awardTotals = useMemo(() => {
    const by = new Map<string, number>();
    for (const l of lines) {
      if (!l.award || l.award.unit_cost == null) continue;
      const cur = l.award.currency || "USD";
      by.set(cur, (by.get(cur) ?? 0) + l.award.unit_cost * Number(l.qty || 1));
    }
    return [...by.entries()];
  }, [lines]);

  if (err && !data) return <div className="state error">API error: {err}</div>;
  if (!data) return <div className="state">Loading the sourcing board…</div>;
  if (!lines.length)
    return <div className="state">This project has no items yet — add them in stage 1.</div>;

  const s = data.summary;

  return (
    <div className="lb">
      <div className="lb-bar">
        <div className="lb-counts">
          <Badge n={s.not_sourced} label="not sourced" tone="warn" />
          <Badge n={s.sourcing} label="waiting" tone="idle" />
          <Badge n={s.quoted} label="quoted" tone="ok" />
          {mode === "award" ? <Badge n={s.awarded} label="awarded" tone="award" /> : null}
          <Badge n={s.declined} label="no quote" tone="out" />
          <span className="lb-total">of {data.lines_total} lines</span>
        </div>
        <div className="lb-actions">
          {mode === "coverage" && onSendSelected ? (
            <>
              {s.not_sourced ? (
                <button type="button" className="btn sm" onClick={pickUnsourced}>
                  Select not sourced ({s.not_sourced})
                </button>
              ) : null}
              <button
                type="button"
                className="btn primary sm"
                disabled={picked.size === 0}
                onClick={() => onSendSelected([...picked])}
                title="Open the Vendor RFQ form with just these lines"
              >
                → Ask a vendor ({picked.size})
              </button>
            </>
          ) : null}
          {mode === "award" && bestCount ? (
            <button type="button" className="btn sm" disabled={busy} onClick={awardAllBest}
                    title="Award every un-awarded line to its lowest quote — change any of them afterwards">
              Take lowest for {bestCount}
            </button>
          ) : null}
        </div>
      </div>

      {unnamed ? (
        <div className="lb-note">
          {unnamed} line(s) from before line IDs existed. They read fine here, but to award
          them, open stage 1 and save the item list once — that gives each line its ID.
        </div>
      ) : null}
      {msg ? <div className="state ok lb-msg">{msg}</div> : null}
      {err ? <div className="state error lb-msg">{err}</div> : null}

      <div className="lb-scroll">
        <table className="lb-table">
          <thead>
            <tr>
              {mode === "coverage" && onSendSelected ? <th className="lb-pick" /> : null}
              <th className="lb-no">#</th>
              <th className="lb-part">Part No.</th>
              <th className="lb-desc">Description</th>
              <th className="lb-qty">Qty</th>
              {vendors.map((v) => (
                <th key={v.vrfq_id} className={"lb-v" + (v.declined ? " out" : "")}>
                  <VendorName entries={[{ name: v.vendor, state: v.declined ? "declined" : v.quotes.length ? "quoted" : "plain" }]} />
                  <span className="lb-v-no">{v.kmaris_rfq_no}</span>
                </th>
              ))}
              <th className="lb-state">{mode === "award" ? "Buying from" : "Status"}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.lid} className={"lb-row s-" + l.state}>
                {mode === "coverage" && onSendSelected ? (
                  <td className="lb-pick">
                    <input
                      type="checkbox"
                      checked={picked.has(l.lid)}
                      onChange={() => toggle(l.lid)}
                      aria-label={`Select line ${l.no}`}
                    />
                  </td>
                ) : null}
                <td className="lb-no">
                  {l.no}
                  <span className="lb-lid" title="Line ID — this line's name across every stage">
                    {l.named ? l.lid : "—"}
                  </span>
                </td>
                <td className="lb-part">{l.part_no || <span className="muted">—</span>}</td>
                <td className="lb-desc">{l.description || <span className="muted">—</span>}</td>
                <td className="lb-qty">{Number(l.qty || 1)}{l.unit ? ` ${l.unit}` : ""}</td>
                {vendors.map((v) => {
                  const c = cells[l.lid]?.[String(v.vrfq_id)];
                  return (
                    <Cell
                      key={v.vrfq_id}
                      cell={c}
                      isBest={!!c && !!l.best && l.best.vrfq_id === v.vrfq_id}
                      isAward={!!l.award && !!c?.vendor_quote_id && l.award.vendor_quote_id === c.vendor_quote_id}
                      canAward={mode === "award" && l.named && !busy && c?.state === "quoted"}
                      onAward={() => {
                        if (!c?.vendor_quote_id) return;
                        const on = l.award?.vendor_quote_id === c.vendor_quote_id;
                        award(l.lid, on ? null : c.vendor_quote_id);
                      }}
                    />
                  );
                })}
                <td className="lb-state">
                  {l.award ? (
                    <span className="lb-award">
                      <VendorName name={l.award.vendor} />
                      <b>{money(l.award.unit_cost, l.award.currency)}</b>
                    </span>
                  ) : (
                    <span className={"lb-chip s-" + l.state}>{STATE_LABEL[l.state]}</span>
                  )}
                  {l.mixed_currency ? (
                    <span className="lb-mixed" title="Quotes for this line are in different currencies — compare them yourself">
                      mixed ccy
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
          {mode === "award" && awardTotals.length ? (
            <tfoot>
              <tr>
                <td className="lb-foot" colSpan={4 + vendors.length}>
                  Awarded purchase total
                </td>
                <td className="lb-foot num">
                  {awardTotals.map(([cur, v]) => (
                    <div key={cur}>{money(v, cur)}</div>
                  ))}
                </td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </div>
  );
}

function Badge({ n, label, tone }: { n: number; label: string; tone: string }) {
  if (!n) return null;
  return (
    <span className={"lb-badge t-" + tone}>
      <b>{n}</b> {label}
    </span>
  );
}

function Cell({
  cell,
  isBest,
  isAward,
  canAward,
  onAward,
}: {
  cell?: LineCell;
  isBest: boolean;
  isAward: boolean;
  canAward: boolean;
  onAward: () => void;
}) {
  // 빈 칸 = 이 벤더에게 이 줄을 묻지 않았다. 0 이나 "없음"과 다른 뜻이라 비워 둔다.
  if (!cell) return <td className="lb-c empty" />;
  const cls =
    "lb-c c-" + cell.state + (isBest ? " best" : "") + (isAward ? " award" : "");
  const body =
    cell.state === "quoted" ? (
      <>
        <b>{money(cell.unit_cost, cell.currency)}</b>
        {cell.lead_time ? <span className="lb-lt">{cell.lead_time}</span> : null}
      </>
    ) : cell.state === "declined" ? (
      <span className="lb-mark">✕</span>
    ) : cell.state === "omitted" ? (
      <span className="lb-mark">–</span>
    ) : cell.state === "no_price" ? (
      <span className="lb-mark">?</span>
    ) : (
      <span className="lb-mark">•</span>
    );
  if (!canAward)
    return (
      <td className={cls} title={CELL_TITLE[cell.state]}>
        {body}
      </td>
    );
  return (
    <td className={cls + " pick"}>
      <button
        type="button"
        onClick={onAward}
        title={isAward ? "Awarded — click to clear" : "Buy this line here"}
      >
        {body}
      </button>
    </td>
  );
}
