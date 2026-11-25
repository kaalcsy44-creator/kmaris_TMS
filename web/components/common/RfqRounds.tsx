"use client";

// 재요청 RFQ — 견적을 내고 멈춘 딜에 같은 배·같은 품목의 RFQ 가 다시 온 경우(수량만 바뀌는 식).
// 딜은 하나로 두고 RFQ #1·#2… 를 쌓는다. 1단계 폼은 늘 마지막 RFQ 를 고치고, 앞선 RFQ 는
// 여기서 읽기 전용으로 본다(추가·품목 수정 창은 RfqRoundEditor). 2~4단계 문서가 몇 번째 RFQ 것인지는 서버가 날짜로 가린다.

import type { RfqRound } from "@/lib/types";
import RecordStrip from "@/components/common/RecordStrip";

/** 문서가 몇 번째 RFQ 것인가 — 재요청이 없는 딜(0)에서는 아무것도 그리지 않는다. */
export function RoundTag({ round, current }: { round?: number; current?: number }) {
  if (!round) return null;
  return (
    <span className={`rfq-round-tag${current && round < current ? " old" : ""}`} title={`Belongs to RFQ #${round}`}>
      RFQ #{round}
    </span>
  );
}

/** 2~4단계 머리 안내 — 지금 RFQ 에 대한 문서가 아직 없을 때. */
export function RoundTodo({ rows, text }: { rows: { round?: number; rfq_round?: number }[]; text: string }) {
  const current = Math.max(0, ...rows.map((r) => r.rfq_round || 0));
  if (current < 2 || rows.some((r) => (r.round || 0) >= current)) return null;
  return (
    <div className="rfq-round-todo">
      <b>RFQ #{current}</b> — {text} Records below belong to the earlier RFQ.
    </div>
  );
}

/** 처음 열 때 고를 레코드 — 재요청이 있으면 가장 나중 RFQ 의 것. */
export function latestRoundRow<T extends { round?: number }>(rows: T[]): T {
  const top = Math.max(0, ...rows.map((r) => r.round || 0));
  return rows.find((r) => (r.round || 0) === top) ?? rows[0];
}

export type DiffItem = {
  lid?: string; part_no: string; description: string; qty: number | string | null; row_kind?: string;
  type?: string; serial_no?: string; maker?: string; unit?: string;
};
const DIFF_FIELDS = [
  ["part_no", "Part No."], ["description", "Description"], ["type", "Type"], ["serial_no", "Serial No."],
  ["maker", "Maker"], ["unit", "Unit"],
] as const;
const same = (a?: string, b?: string) =>
  (a || "").trim().replace(/\s+/g, " ").toLowerCase() === (b || "").trim().replace(/\s+/g, " ").toLowerCase();

/** 같은 품목 줄에서 달라진 칸 — "Qty 1 → 2", "Part No. A → B". */
export function lineChanges(b: DiffItem, it: DiffItem): string[] {
  const out: string[] = [];
  if (Number(b.qty) !== Number(it.qty)) out.push(`Qty ${Number(b.qty)} → ${Number(it.qty)}`);
  for (const [k, label] of DIFF_FIELDS) if (!same(b[k], it[k])) out.push(`${label} ${b[k]?.trim() || "—"} → ${it[k]?.trim() || "—"}`);
  return out;
}

const nameOf = (it: DiffItem) => it.description || it.part_no || "—";
const counted = (it: DiffItem) => it.row_kind !== "option" && !!(it.part_no.trim() || it.description.trim());

/** 앞선 RFQ 와 달라진 점 — 수량·추가·빠짐. */
export function RoundDiff({ prevNo, prev, now }: { prevNo: number; prev: DiffItem[]; now: DiffItem[] }) {
  const before = prev.filter(counted);
  const after = now.filter(counted);
  const byLid = new Map(before.filter((b) => b.lid).map((b) => [b.lid as string, b]));
  const changed: string[] = [];
  const added: string[] = [];
  for (const it of after) {
    const b = it.lid ? byLid.get(it.lid) : undefined;
    if (!b) added.push(`${nameOf(it)} × ${Number(it.qty) || 1}`);
    else {
      const ch = lineChanges(b, it);
      if (ch.length) changed.push(`${nameOf(b)}: ${ch.join(" · ")}`);
    }
  }
  const kept = new Set(after.map((a) => a.lid).filter(Boolean));
  const gone = before.filter((b) => b.lid && !kept.has(b.lid)).map(nameOf);
  return (
    <div className="rfq-round-diff">
      <b>Compared with RFQ #{prevNo}</b>
      {!changed.length && !added.length && !gone.length ? <span> — no change in items or quantities.</span> : (
        <ul>
          {changed.map((t, i) => <li key={`c${i}`}>{t}</li>)}
          {added.map((t, i) => <li key={`a${i}`}><span className="rfq-round-add">New</span> {t}</li>)}
          {gone.map((t, i) => <li key={`g${i}`}><span className="rfq-round-gone">Not requested</span> {t}</li>)}
        </ul>
      )}
    </div>
  );
}

/** 1단계 맨 위 — RFQ 탭과 추가 버튼. 재요청이 없고 추가도 못 하면 그리지 않는다. */
export function RfqRoundBar({
  rounds, viewNo, onView, canAdd, addBlocked, onAdd, onRevise, onRemove, busy,
}: {
  rounds: RfqRound[];
  viewNo: number;
  onView: (no: number) => void;
  canAdd: boolean;
  /** 추가할 수 없는 까닭(고객 P/O 가 있음 등). 비면 추가할 수 있다. */
  addBlocked: string;
  onAdd: () => void;
  /** 지금 RFQ 의 품목을 앞선 RFQ 와 견주며 고친다. */
  onRevise: () => void;
  onRemove?: () => void;
  busy?: boolean;
}) {
  const many = rounds.length > 1;
  if (!many && !canAdd) return null;
  return (
    <div className="rfq-round-bar">
      {many ? (
        <RecordStrip activeKey={viewNo} ariaLabel="RFQs of this project">
          {rounds.map((r) => (
            <button key={r.no} type="button" className={r.no === viewNo ? "on" : ""} onClick={() => onView(r.no)}>
              RFQ #{r.no} · {r.received_at.slice(0, 10) || "—"}
              {r.customer_rfq_no ? <span className="rec-quote-no">{r.customer_rfq_no}</span> : null}
              {r.current ? <span className="rfq-round-tag">Current</span> : null}
            </button>
          ))}
        </RecordStrip>
      ) : null}
      {canAdd ? (
        <span className="rfq-round-acts">
          {many ? (
            <button type="button" className="btn sm" disabled={busy} onClick={onRevise}
                    title={`Change, remove, replace or add items of RFQ #${rounds.length}, compared with RFQ #${rounds.length - 1}`}>
              ✎ Items of RFQ #{rounds.length}
            </button>
          ) : null}
          {many && onRemove ? (
            <button type="button" className="btn sm" disabled={busy} onClick={onRemove}
                    title="Remove the latest RFQ and go back to the one before it">
              Remove RFQ #{rounds.length}
            </button>
          ) : null}
          <button type="button" className="btn sm" disabled={busy || !!addBlocked} onClick={onAdd}
                  title={addBlocked || "The customer sent the RFQ again (changed quantity, re-opened enquiry…)"}>
            ＋ Add RFQ
          </button>
        </span>
      ) : null}
    </div>
  );
}

/** 앞선 RFQ — 읽기 전용. */
export function PastRfqView({ round, prev }: { round: RfqRound; prev?: RfqRound }) {
  const cols: { key: "type" | "serial_no" | "maker" | "remark"; label: string }[] = (
    [
      { key: "type", label: "Type" }, { key: "serial_no", label: "Serial No." },
      { key: "maker", label: "Maker" }, { key: "remark", label: "Remark" },
    ] as const
  ).filter((c) => round.items.some((it) => it[c.key]));
  return (
    <div className="rfq-round-past">
      <p className="hint-inline">
        RFQ #{round.no} is kept as history and cannot be edited. Vendor RFQs and quotations made for it stay in stages 2–4, marked “RFQ #{round.no}”.
      </p>
      <dl className="rfq-round-meta">
        <div><dt>RFQ received at</dt><dd>{round.received_at.replace("T", " ") || "—"}</dd></div>
        <div><dt>Customer RFQ No.</dt><dd>{round.customer_rfq_no || "—"}</dd></div>
        <div><dt>Customer contact</dt><dd>{round.contact_person || "—"}</dd></div>
        <div><dt>Request method</dt><dd>{round.request_channel || "—"}</dd></div>
      </dl>
      {prev ? <RoundDiff prevNo={prev.no} prev={prev.items} now={round.items} /> : null}
      <div className="table-wrap item-box">
        <table className="mini">
          <thead>
            <tr>
              <th className="seq">#</th><th>Part No.</th><th>Description</th>
              {cols.map((c) => <th key={c.key}>{c.label}</th>)}
              <th className="num">Qty</th><th>Unit</th>
            </tr>
          </thead>
          <tbody>
            {round.items.map((it, i) => (
              <tr key={i}>
                <td className="seq">{i + 1}</td>
                <td className="wrapcell">{it.part_no || "—"}</td>
                <td className="desc">{it.description || "—"}</td>
                {cols.map((c) => <td key={c.key} className="wrapcell">{it[c.key] || ""}</td>)}
                <td className="num">{it.qty}</td>
                <td>{it.unit || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {round.notes ? <p className="rfq-round-notes"><b>Notes</b> {round.notes}</p> : null}
      {round.source_files.length ? (
        <p className="hint-inline">📎 {round.source_files.map((f) => f.name).join(", ")}</p>
      ) : null}
    </div>
  );
}
