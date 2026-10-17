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
import { fetchFxRate, fetchLineBoard, saveLineAwards, type PrintBook } from "@/lib/api";
import type { BoardLine, LineBoard as LineBoardData, LineCell } from "@/lib/types";
import VendorName from "@/components/common/VendorName";
import PrintListButton from "@/components/common/PrintListModal";

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

/** 비교 통화 선택지 — 견적에 실제로 나온 통화가 여기에 없으면 목록 끝에 붙는다. */
const CMP_CHOICES = ["USD", "KRW", "EUR", "JPY", "CNY", "SGD", "GBP"];
const CMP_KEY = "lb-cmp-cur";
/** 소수 없이 읽는 통화 — 환산값을 원 단위까지만 보인다. */
const WHOLE = new Set(["KRW", "JPY"]);

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 환산값 — 통화에 맞는 자리로 반올림해 보인다. */
function cmpMoney(v: number, cur: string): string {
  const r = WHOLE.has(cur) ? Math.round(v) : Math.round(v * 100) / 100;
  return money(r, cur);
}

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
  sendLabel = "→ Ask a vendor",
  onChanged,
  reloadKey,
}: {
  rfqId: number;
  mode: LineBoardMode;
  /** 2단계 — 고른 줄로 다음 벤더 RFQ 를 연다. 없으면 고르기 자체를 숨긴다. */
  onSendSelected?: (lids: string[]) => void;
  /** 그 버튼의 말 — 발신 폼을 새로 여는 자리와, 이미 열린 폼의 품목을 바꾸는 자리는
   *  같은 동작이지만 사용자가 서 있는 곳이 달라 같은 말로 부를 수 없다. */
  sendLabel?: string;
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
  // 비교 통화 — 빈 값이면 받은 통화 그대로만. 견적 통화는 언제나 칸의 주 표시로 남고,
  // 고르면 그 아래에 환산값이 붙는다(오늘자 매매기준율, KRW 를 거쳐 교차 환산).
  const [cmpCur, setCmpCur] = useState("");
  useEffect(() => {
    try { setCmpCur(localStorage.getItem(CMP_KEY) || ""); } catch { /* 저장소 없음 */ }
  }, []);
  const chooseCmp = (c: string) => {
    setCmpCur(c);
    try { if (c) localStorage.setItem(CMP_KEY, c); else localStorage.removeItem(CMP_KEY); } catch { /* 무시 */ }
  };
  // 통화별 1단위 = ? KRW. null = 고시를 못 받아 환산 불가(폴백 고정환율은 USD 전용이라 쓰지 않는다).
  const [rates, setRates] = useState<Record<string, number | null>>({ KRW: 1 });
  const [rateDate, setRateDate] = useState("");

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
      setData((prev) => ({ ...d, meta: d.meta ?? prev?.meta }));
      setMsg(vendorQuoteId ? `${lid} awarded.` : `${lid} cleared.`);
      onChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save the award");
    } finally {
      setBusy(false);
    }
  }

  /** 값이 온 줄마다 최저가를 한 번에 고른다. 이미 고른 줄은 건드리지 않는다.
   *  비교 통화를 골랐으면 환산한 값으로 고른다 — 통화가 섞인 줄도 빠지지 않게. */
  async function awardAllBest() {
    const todo = bestTodo;
    if (!todo.length) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const d = await saveLineAwards(rfqId, todo);
      setData((prev) => ({ ...d, meta: d.meta ?? prev?.meta }));
      setMsg(`${todo.length} line(s) awarded to the lowest quote. Change any of them below.`);
      onChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save the awards");
    } finally {
      setBusy(false);
    }
  }

  const awardTotals = useMemo(() => {
    const by = new Map<string, number>();
    for (const l of lines) {
      if (!l.award || l.award.unit_cost == null) continue;
      const cur = l.award.currency || "USD";
      by.set(cur, (by.get(cur) ?? 0) + l.award.unit_cost * Number(l.qty || 1));
    }
    return [...by.entries()];
  }, [lines]);

  // 이 보드에 나온 통화들 — 비교 통화 목록과 환율 조회 대상.
  const quoteCurs = useMemo(() => {
    const set = new Set<string>();
    for (const row of Object.values(cells))
      for (const c of Object.values(row))
        if (c.state === "quoted") set.add((c.currency || "USD").toUpperCase());
    for (const l of lines) if (l.award) set.add((l.award.currency || "USD").toUpperCase());
    return [...set].sort();
  }, [cells, lines]);
  const cmpChoices = useMemo(
    () => [...CMP_CHOICES, ...quoteCurs.filter((c) => !CMP_CHOICES.includes(c))],
    [quoteCurs]
  );
  const neededCurs = useMemo(
    () => (cmpCur ? [...new Set([cmpCur, ...quoteCurs])].filter((c) => c !== "KRW") : []),
    [cmpCur, quoteCurs]
  );
  useEffect(() => {
    const date = today();
    for (const c of neededCurs) {
      if (c in rates) continue;
      fetchFxRate(date, c)
        .then((r) => {
          // 고시를 못 받으면 서버가 USD 고정환율로 폴백한다 — USD 가 아니면 그 값은 쓸 수 없다.
          const ok = (r.source === "exim" || c === "USD") && r.rate > 0;
          setRates((prev) => ({ ...prev, [c]: ok ? r.rate / (r.unit || 1) : null }));
          if (r.date_used) setRateDate(r.date_used);
        })
        .catch(() => setRates((prev) => ({ ...prev, [c]: null })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neededCurs]);

  /** v(from 통화) → 비교 통화. 환율이 없으면 null. */
  const conv = useCallback(
    (v: number | null | undefined, from?: string): number | null => {
      if (v == null || !cmpCur) return null;
      const f = (from || "USD").toUpperCase();
      if (f === cmpCur) return Number(v);
      const a = rates[f], b = rates[cmpCur];
      if (!a || !b) return null;
      return (Number(v) * a) / b;
    },
    [cmpCur, rates]
  );
  /** 환산 표시 한 줄 — 같은 통화거나 환산할 수 없으면 빈 문자열. */
  const cmpText = useCallback(
    (v: number | null | undefined, from?: string): string => {
      if (!cmpCur || v == null || (from || "USD").toUpperCase() === cmpCur) return "";
      const x = conv(v, from);
      return x == null ? "rate n/a" : `≈ ${cmpMoney(x, cmpCur)}`;
    },
    [cmpCur, conv]
  );

  // 비교 통화로 본 줄별 최저가(통화가 섞여 서버가 최저가를 못 고른 줄도 여기선 고른다).
  // 값이 온 칸 중 하나라도 환산이 안 되면 그 줄은 고르지 않는다.
  const cmpBest = useMemo(() => {
    const m = new Map<string, number>();
    if (!cmpCur) return m;
    for (const l of lines) {
      let best: number | null = null;
      let bestV: number | null = null;
      let ok = true;
      for (const v of vendors) {
        const c = cells[l.lid]?.[String(v.vrfq_id)];
        if (c?.state !== "quoted" || c.unit_cost == null || Number(c.unit_cost) <= 0) continue;
        const x = conv(c.unit_cost, c.currency);
        if (x == null) { ok = false; break; }
        if (bestV == null || x < bestV) { bestV = x; best = v.vrfq_id; }
      }
      if (ok && best != null) m.set(l.lid, best);
    }
    return m;
  }, [cmpCur, lines, vendors, cells, conv]);
  // "Take lowest" 대상 — 이름 있는 줄 중 아직 안 고른 줄의 최저가 견적.
  const bestTodo = useMemo(() => {
    const out: { lid: string; vendor_quote_id: number }[] = [];
    for (const l of lines) {
      if (!l.named || l.award) continue;
      if (cmpCur) {
        const vr = cmpBest.get(l.lid);
        const id = vr != null ? cells[l.lid]?.[String(vr)]?.vendor_quote_id : undefined;
        if (id) out.push({ lid: l.lid, vendor_quote_id: id });
      } else if (l.best?.vendor_quote_id) {
        out.push({ lid: l.lid, vendor_quote_id: l.best.vendor_quote_id });
      }
    }
    return out;
  }, [lines, cells, cmpCur, cmpBest]);
  const bestCount = bestTodo.length;
  const isBestCell = (l: BoardLine, vrfqId: number) =>
    cmpCur ? cmpBest.get(l.lid) === vrfqId : !!l.best && l.best.vrfq_id === vrfqId;

  const cmpTotal = useMemo(() => {
    if (!cmpCur || !awardTotals.length) return null;
    let sum = 0;
    for (const [cur, v] of awardTotals) {
      const x = conv(v, cur);
      if (x == null) return null;
      sum += x;
    }
    return sum;
  }, [cmpCur, awardTotals, conv]);

  const rateNote = cmpCur
    ? [...new Set([...quoteCurs, cmpCur])]
        .filter((c) => c !== "KRW")
        .map((c) =>
          rates[c] === undefined ? `1 ${c} = …` : rates[c] == null ? `1 ${c}: rate n/a` :
          `1 ${c} = ${rates[c]!.toLocaleString(undefined, { maximumFractionDigits: 2 })} KRW`)
        .join(" · ")
    : "";

  function buildPrint(): PrintBook {
    const meta = data?.meta;
    const cellText = (l: BoardLine, vrfqId: number): string => {
      const c = cells[l.lid]?.[String(vrfqId)];
      if (!c) return "";
      if (c.state === "declined") return "✕ declined";
      if (c.state === "omitted") return "– not quoted";
      if (c.state === "no_price") return "no price";
      if (c.state === "sent") return "• waiting";
      // ✓(U+2713) — PDF 글꼴(Noto Sans KR)에 ✔(U+2714) 글리프가 없어 빈 네모로 찍힌다.
      const marks = [
        l.award && c.vendor_quote_id && l.award.vendor_quote_id === c.vendor_quote_id ? "✓" : "",
        isBestCell(l, vrfqId) ? "★" : "",
      ].filter(Boolean).join(" ");
      return [
        `${marks ? marks + " " : ""}${money(c.unit_cost, c.currency)}`,
        cmpText(c.unit_cost, c.currency),
        c.lead_time ? `LT ${c.lead_time}` : "",
      ].filter(Boolean).join("\n");
    };
    const lastLabel = mode === "award" ? "Buying from" : "Status";
    const rows: string[][] = lines.map((l) => [
      String(l.no),
      l.part_no || "",
      l.description || "",
      `${Number(l.qty || 1)}${l.unit ? ` ${l.unit}` : ""}`,
      ...vendors.map((v) => cellText(l, v.vrfq_id)),
      l.award
        ? [l.award.vendor, money(l.award.unit_cost, l.award.currency), cmpText(l.award.unit_cost, l.award.currency)]
            .filter(Boolean).join("\n")
        : STATE_LABEL[l.state],
    ]);
    if (mode === "award" && awardTotals.length) {
      rows.push([
        "", "", "Awarded purchase total", "",
        ...vendors.map(() => ""),
        [
          ...awardTotals.map(([cur, v]) => money(v, cur)),
          cmpTotal != null && (awardTotals.length > 1 || awardTotals[0][0] !== cmpCur) ? `≈ ${cmpMoney(cmpTotal, cmpCur)}` : "",
        ].filter(Boolean).join("\n"),
      ]);
    }
    const head = [meta?.project_no, meta?.project_title, meta?.customer && meta.customer !== "—" ? meta.customer : "", meta?.vessel]
      .filter(Boolean).join(" · ");
    const legend = [
      cmpCur ? `Compared in ${cmpCur} (base rate${rateDate ? ` ${rateDate}` : ""}: ${rateNote || "same currency"})` : "Quoted currencies as received",
      "★ lowest" + (cmpCur ? ` in ${cmpCur}` : ""),
      mode === "award" ? "✓ awarded" : "",
      "LT = lead time",
    ].filter(Boolean).join(" · ");
    return {
      title: `Quote Comparison ${meta?.project_no || ""}`.trim(),
      heading: "Quote Comparison",
      subtitle: [head, legend].filter(Boolean).join(" — "),
      columns: [
        // 가중치 — 번호·수량은 좁게, 품번(18자 안팎)·품명은 한 줄에 서게, 벤더 칸은
        // "✓ ★ $341.50 / ≈ 460,513 KRW" 가 꺾이지 않게, 마지막 칸은 벤더명이 안 갈리게.
        { label: "#", width: 2.5, align: "center" },
        { label: "Part No.", width: 11 },
        { label: "Description", width: 16 },
        { label: "Qty", width: 4, align: "right" },
        ...vendors.map((v) => ({ label: `${v.vendor}\n${v.kmaris_rfq_no}`, width: 11, align: "right" as const })),
        { label: lastLabel, width: 13 },
      ],
      rows,
    };
  }

  if (err && !data) return <div className="state error">API error: {err}</div>;
  if (!data) return <div className="state">Loading the sourcing board…</div>;
  if (!lines.length)
    return <div className="state">This project has no items yet — add them in stage 1.</div>;

  const s = data.summary;
  /* 고르기 칸이 있는지 — 왼쪽 붙박이 칸들의 left 오프셋이 이 한 칸만큼 밀린다. */
  const pickable = mode === "coverage" && !!onSendSelected;

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
          <label className="lb-cmp" title="Show every quote converted to one currency as well — the quoted currency stays as it is">
            Compare in
            <select value={cmpCur} onChange={(e) => chooseCmp(e.target.value)}>
              <option value="">— quoted ccy only —</option>
              {cmpChoices.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <PrintListButton small label="🖨 Preview / Print" build={buildPrint} />
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
                {sendLabel} ({picked.size})
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

      {cmpCur ? (
        <div className="lb-cmp-note">
          Converted to <b>{cmpCur}</b> at the base rate{rateDate ? ` of ${rateDate}` : ""} — {rateNote || "same currency"}.
          {" "}★ = lowest in {cmpCur}.
        </div>
      ) : null}
      {unnamed ? (
        <div className="lb-note">
          {unnamed} line(s) from before line IDs existed. They read fine here, but to award
          them, open stage 1 and save the item list once — that gives each line its ID.
        </div>
      ) : null}
      {msg ? <div className="state ok lb-msg">{msg}</div> : null}
      {err ? <div className="state error lb-msg">{err}</div> : null}

      <div className="lb-scroll">
        <table className={"lb-table" + (pickable ? " has-pick" : "")}>
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
                      isBest={!!c && isBestCell(l, v.vrfq_id)}
                      cmp={c?.state === "quoted" ? cmpText(c.unit_cost, c.currency) : ""}
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
                      {cmpText(l.award.unit_cost, l.award.currency) ? (
                        <span className="lb-cmpv">{cmpText(l.award.unit_cost, l.award.currency)}</span>
                      ) : null}
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
                  {cmpTotal != null && (awardTotals.length > 1 || awardTotals[0][0] !== cmpCur) ? (
                    <div className="lb-cmpv">≈ {cmpMoney(cmpTotal, cmpCur)}</div>
                  ) : null}
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
  cmp = "",
}: {
  cell?: LineCell;
  /** 비교 통화 환산 한 줄("≈ $134.28") — 받은 통화 값 아래에 작게. */
  cmp?: string;
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
        {cmp ? <span className="lb-cmpv">{cmp}</span> : null}
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
