// 활동(Activity) 공용 로직 — Activity Log 화면과 프로젝트 개요 페이지가 공유한다.
// 한 딜의 활동 = 자동 단계 이벤트 + 수동 stage_notes + 종결 이벤트.
//
// auto 이벤트는 단계 날짜에서 파생돼 "작성자"가 따로 없다. 그래서 PIC 는 딜 담당자(row.assignee)
// 를 쓴다 — 기록자가 아니라 그 건의 책임자라는 의미. 딜이 재배정되면 과거 auto 행의 PIC 도
// 새 담당자로 함께 바뀐다(수기 노트는 작성 시점 작성자를 그대로 보존).

import type { PipelineRow, StageNote } from "@/lib/types";
import { closeReasonLabel } from "@/lib/api";
import { vendorOf } from "@/lib/deal";

export type Activity =
  // at: 정렬용 전체 일시(iso). 같은 날 여러 발송을 시각순으로 잇는다. 없으면 date(YYYY-MM-DD)로 정렬.
  | { kind: "auto"; date: string; stage: number; label: string; party: string; pic?: string; at?: string }
  | { kind: "note"; date: string; stage: number; index: number; note: StageNote }
  | { kind: "close"; date: string; reason: string };

/** "2026-07-14T09:30" | "2026-07-14" → "7/14" */
export function md(iso: string): string {
  const s = (iso || "").slice(0, 10);
  const m = s.match(/^\d{4}-(\d{2})-(\d{2})/);
  if (!m) return s;
  return `${Number(m[1])}/${Number(m[2])}`;
}

/** "2026-07-14T09:30" → "09:30". 시각이 없거나 자정(00:00, 날짜만 아는 항목)이면 "". */
export function hm(iso: string): string {
  const m = (iso || "").match(/T(\d{2}):(\d{2})/);
  if (!m || (m[1] === "00" && m[2] === "00")) return "";
  return `${m[1]}:${m[2]}`;
}

/** 프로젝트 번호 "P-010(260713)" → { code: "P-010", date: "(260713)" } */
export function splitProjectNo(pno: string): { code: string; date: string } {
  const m = (pno || "").match(/^(.*?)\s*(\(.*\))\s*$/);
  return m ? { code: m[1], date: m[2] } : { code: pno || "—", date: "" };
}

/** 최신 활동 일시(iso) — 단계 완료(수동/자동)·단계 노트 중 최신. 백엔드 _last_activity_iso 와 동일 규칙. */
export function lastActivityISO(row: PipelineRow): string {
  const times: string[] = [];
  for (const m of [row.stage_dates, row.stage_auto]) {
    for (const v of Object.values(m ?? {})) if (v) times.push(v);
  }
  for (const notes of Object.values(row.stage_notes ?? {})) {
    for (const n of notes ?? []) {
      const v = n.datetime || n.at || "";
      if (v) times.push(v);
    }
  }
  return times.length ? times.reduce((a, b) => (a > b ? a : b)) : "";
}

/** iso 로부터 오늘까지 경과 일수(≥0). 파싱 불가면 null. */
export function daysSinceISO(iso: string): number | null {
  const t = Date.parse((iso || "").slice(0, 10));
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

/** 자동 단계 이벤트의 From/To 상대 — 단계별로 고객/벤더를 붙인다. */
export function autoParty(stage: number, row: PipelineRow): string {
  const cust = row.customer || "";
  const vend = vendorOf(row);
  switch (stage) {
    case 1: return cust ? `from ${cust}` : "";   // RFQ Received
    case 2: return vend ? `to ${vend}` : "";     // RFQ Sent
    case 3: return vend ? `from ${vend}` : "";   // Quote Received
    case 4: return cust ? `to ${cust}` : "";     // Quote Sent
    case 5: return cust ? `from ${cust}` : "";   // P/O Received
    case 6: return vend ? `to ${vend}` : "";     // P/O Sent
    case 8: return cust ? `to ${cust}` : "";     // Delivery Complete
    case 9: return cust ? `to ${cust}` : "";     // Tax Invoice · Billing
    case 10: return cust ? `to ${cust}` : "";    // Tax Invoice Issued
    case 11: return cust ? `from ${cust}` : "";  // Payment
    default: return "";
  }
}

/** 한 딜의 전체 활동을 시간순으로. 종결 이벤트는 항상 맨 뒤. */
export function buildActivities(row: PipelineRow, steps: string[]): Activity[] {
  const out: Activity[] = [];
  for (let n = 1; n <= steps.length; n++) {
    const key = String(n);
    // 2단계(RFQ Sent): 벤더 RFQ 발송 1건 = 활동 1건. 여러 벤더/여러 번 보냈으면(같은
    // 시각이어도) 각각 별도 행으로 남긴다. rfq_sends 가 없는 옛 데이터는 아래 단일 처리로 폴백.
    if (n === 2 && row.rfq_sends?.length) {
      for (const send of row.rfq_sends) {
        const at = send.sent_at || "";
        const date = at.slice(0, 10);
        if (!date) continue;
        out.push({
          kind: "auto",
          date,
          stage: 2,
          label: steps[1] || "Stage 2",
          party: send.vendor ? `to ${send.vendor}` : "",
          pic: row.assignee,
          at,
        });
      }
      continue;
    }
    const full = row.stage_dates?.[key] || row.stage_auto?.[key] || "";
    const date = full.slice(0, 10);
    if (date)
      out.push({
        kind: "auto",
        date,
        stage: n,
        label: steps[n - 1] || `Stage ${n}`,
        party: autoParty(n, row),
        pic: row.assignee,
        at: full,
      });
  }
  for (const [stage, list] of Object.entries(row.stage_notes ?? {})) {
    (list ?? []).forEach((note, index) => {
      const date = (note.datetime || note.at || "").slice(0, 10);
      out.push({ kind: "note", date, stage: Number(stage), index, note });
    });
  }
  const sortKey = (x: Activity): string =>
    x.kind === "note" ? (x.note.datetime || x.note.at || x.date) : x.kind === "auto" ? (x.at || x.date) : x.date;
  out.sort((a, b) => {
    const da = sortKey(a);
    const db = sortKey(b);
    return da < db ? -1 : da > db ? 1 : 0;
  });
  // 종결 이벤트 — 항상 맨 아래에 붙인다(날짜 없으면 날짜칸 비움).
  if (row.cancelled) {
    const reason = closeReasonLabel(row.close_reason);
    const note = (row.close_reason_note || "").trim();
    out.push({
      kind: "close",
      date: (row.closed_at || "").slice(0, 10),
      reason: [reason, note].filter(Boolean).join(" — "),
    });
  }
  return out;
}
