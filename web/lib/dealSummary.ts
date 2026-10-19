// 진행 중인 딜 현황을 **글**로 — 카톡·메일 본문에 그대로 붙여 넣는 요약.
//
// 화면(브리핑 카드)이 이미 가진 두 덩이만 쓴다: 파이프라인 행(단계·금액·상대)과 메일
// 다이제스트의 AI 롤업(Progress/Terms/Issue/Next). 새로 묻는 서버 호출은 없다 — 화면에
// 보이는 것과 글이 어긋나면 어느 쪽을 믿어야 할지 모르게 되기 때문이다.
//
// 순수 함수로 둔다. 나중에 같은 요약을 서버가 매일 아침 보내게 될 때, 규칙이 이 한
// 곳에 모여 있어야 옮길 수 있다.

import type { MailDigestRow, PipelineRow } from "@/lib/types";
import { parseRollupLine, type RollupKind } from "@/lib/rollup";
import { INTERNAL_STAGE_COUNT } from "@/lib/deal";

/** 10단계를 다섯 묶음으로. 0단계(아직 아무것도 안 찍힌 딜)는 RFQ 에 든다. */
export const SUMMARY_GROUPS = [
  { key: "rfq", label: "RFQ", stages: [0, 1, 2] },
  { key: "quote", label: "QUOTE", stages: [3, 4] },
  { key: "po", label: "PO", stages: [5, 6] },
  { key: "doc", label: "DOCUMENT", stages: [7, 8] },
  { key: "ar", label: "AR", stages: [9, 10] },
] as const;
export type SummaryGroupKey = (typeof SUMMARY_GROUPS)[number]["key"];

export const SUMMARY_FIELDS = [
  { key: "no", label: "Project No." },
  { key: "title", label: "Project name" },
  { key: "customer", label: "Customer" },
  { key: "contact", label: "Customer contact" },
  { key: "vessel", label: "Vessel" },
  { key: "vendor", label: "Vendors" },
  { key: "pic", label: "PIC" },
  { key: "stage", label: "Stage (detail)" },
  { key: "amount", label: "Amounts (Purchase/Sales/Margin)" },
  { key: "last", label: "Last activity" },
  { key: "progress", label: "Progress" },
  { key: "terms", label: "Terms" },
  { key: "issue", label: "Issue" },
  { key: "next", label: "Next" },
] as const;
export type SummaryFieldKey = (typeof SUMMARY_FIELDS)[number]["key"];

export type SummaryFormat = "kakao" | "email";
export type SummaryScope = "open" | "briefing";

export type SummaryOptions = {
  format: SummaryFormat;
  scope: SummaryScope;
  fields: SummaryFieldKey[];
  groups: SummaryGroupKey[];
  includeSettled: boolean;
  pic: string;                 // "" = 전체
};

export const DEFAULT_SUMMARY_OPTIONS: SummaryOptions = {
  format: "kakao",
  scope: "open",
  fields: ["no", "title", "customer", "stage", "issue", "next"],
  groups: ["rfq", "quote", "po", "doc", "ar"],
  includeSettled: false,
  pic: "",
};

/** 요약에 들어갈 딜 하나 — 행과 그 딜의 메일 집계(없으면 null), 마지막 움직임. */
export type SummaryDeal = {
  row: PipelineRow;
  mail: MailDigestRow | null;
  lastAt?: string;
};

type Rollup = Partial<Record<RollupKind, string>>;

/** 롤업 글 → 종류별 본문. 같은 종류가 두 줄이면 " / " 로 잇는다. 라벨 없는 옛 서술형
 *  요약은 어느 칸에도 넣지 않는다(그 딜은 "요약 없음"으로 나간다). */
function parseRollup(text: string): Rollup {
  const out: Rollup = {};
  for (const raw of text.split("\n")) {
    const p = parseRollupLine(raw);
    if (!p) continue;
    out[p.kind] = out[p.kind] ? `${out[p.kind]} / ${p.body}` : p.body;
  }
  return out;
}

/** "USD 12,500 KRW 17,000,000" → "USD 12,500" (브리핑 카드와 같은 규칙). */
function primaryAmount(value: string): string {
  return value.trim().split(/\s+(?=[A-Z]{3}\s)/)[0] || value;
}

function groupOfStage(stage: number): SummaryGroupKey {
  for (const g of SUMMARY_GROUPS) if ((g.stages as readonly number[]).includes(stage)) return g.key;
  return stage > 10 ? "ar" : "rfq";
}

/** 결제 완료(10단계) — 끝난 딜. 고르지 않으면 요약에서 뺀다. */
export function isSettled(row: PipelineRow): boolean {
  return row.stage >= INTERNAL_STAGE_COUNT;
}

function settledOn(row: PipelineRow): string {
  return (row.stage_dates?.["10"] || row.stage_auto?.["10"] || "").slice(0, 10);
}

/** ISO 일시 → "10/20". */
function md(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${Number(m[1])}/${Number(m[2])}` : "";
}

function daysSince(iso: string, today: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso.slice(0, 10));
  if (Number.isNaN(t)) return null;
  const d0 = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.max(0, Math.round((d0 - t) / 86_400_000));
}

/** 한 딜의 글 재료 — 형식(카톡/메일)과 무관하게 먼저 뽑아 둔다. */
type DealLines = {
  head: string;                       // "P-049 NIIGATA … "
  meta: string[];                     // 고객 · 단계 · 선박 … (한 줄로 이어 붙일 것들)
  details: { label: string; body: string }[];
};

function dealLines(d: SummaryDeal, f: Set<SummaryFieldKey>, steps: string[], today: Date): DealLines {
  const { row, mail } = d;
  const head = [
    f.has("no") ? row.project_no || `#${row.rfq_id}` : "",
    f.has("title") ? row.project_title || "(untitled)" : "",
  ].filter(Boolean).join(" ");

  const meta: string[] = [];
  if (f.has("customer") && row.customer) {
    meta.push(f.has("contact") && row.contact_person ? `${row.customer}(${row.contact_person})` : row.customer);
  } else if (f.has("contact") && row.contact_person) {
    meta.push(row.contact_person);
  }
  if (f.has("stage")) {
    const name = row.stage > 0 ? steps[row.stage - 1] || "" : "Not started";
    meta.push(row.stage > 0 ? `${row.stage} ${name}` : name);
  }
  if (f.has("vessel")) {
    const v = (row.vessels || row.vessel || "").split("\n").filter(Boolean).join(", ");
    if (v) meta.push(v);
  }
  if (f.has("pic") && row.assignee) meta.push(`PIC ${row.assignee}`);

  const details: { label: string; body: string }[] = [];
  if (f.has("vendor")) {
    const v = (row.rfq_vendors ?? []).map((x) => x.name).filter(Boolean);
    const list = v.length ? v : (row.vendor || row.vrfq_vendors || "").split(/\n|,\s*/).filter(Boolean);
    if (list.length) details.push({ label: "Vendors", body: Array.from(new Set(list)).join(", ") });
  }
  if (f.has("amount")) {
    const parts = [
      row.purchase_total ? `Purchase ${primaryAmount(row.purchase_total)}` : "",
      row.sales_total ? `Sales ${primaryAmount(row.sales_total)}` : "",
      row.margin_amount
        ? `Margin ${primaryAmount(row.margin_amount)}${row.margin_pct != null ? ` (${row.margin_pct}%)` : ""}`
        : "",
    ].filter(Boolean);
    if (parts.length) details.push({ label: "Amount", body: parts.join(" / ") });
  }
  if (f.has("last")) {
    const at = d.lastAt || mail?.last_at || "";
    const n = daysSince(at, today);
    if (at) details.push({ label: "Last", body: `${md(at)}${n != null ? ` (${n}d ago)` : ""}` });
  }

  const wantsRollup = f.has("progress") || f.has("terms") || f.has("issue") || f.has("next");
  const r = mail?.rollup ? parseRollup(mail.rollup) : {};
  const hasRollup = Object.keys(r).length > 0;
  if (f.has("progress") && r.flow) details.push({ label: "Progress", body: r.flow });
  if (f.has("terms") && r.terms) details.push({ label: "Terms", body: r.terms });
  if (f.has("issue") && r.issue) details.push({ label: "Issue", body: r.issue });
  if (f.has("next")) {
    // 결제까지 끝난 딜의 Next 는 메일이 모르는 사실로 덮는다(브리핑 카드와 같은 규칙).
    if (isSettled(row)) {
      const on = settledOn(row);
      details.push({ label: "Next", body: `Settled${on ? ` on ${md(on)}` : ""} — payment complete` });
    } else if (r.next) {
      details.push({ label: "Next", body: r.next });
    }
  }
  // 요약이 아예 없으면 빈칸으로 두지 않고 그렇다고 적는다 — 빠진 줄이 "문제 없음"으로
  // 읽히면 안 된다. 요약은 있는데 Issue 줄만 없다면 그건 정말 쟁점이 없다는 뜻이다.
  if (wantsRollup && !hasRollup && !isSettled(row)) {
    details.push({ label: "Note", body: mail ? "메일 요약 없음" : "연결된 메일 없음" });
  }
  return { head, meta, details };
}

function sortDeals(a: SummaryDeal, b: SummaryDeal): number {
  // 묶음 안에서는 더 나아간 단계가 먼저, 같으면 프로젝트 번호순.
  if (a.row.stage !== b.row.stage) return b.row.stage - a.row.stage;
  return (a.row.project_no || "").localeCompare(b.row.project_no || "");
}

/** 옵션에 맞는 딜만 골라 묶음별로 나눈다. */
export function groupDeals(deals: SummaryDeal[], opt: SummaryOptions) {
  const want = new Set(opt.groups);
  const out = SUMMARY_GROUPS.filter((g) => want.has(g.key)).map((g) => ({
    key: g.key,
    label: g.label,
    deals: [] as SummaryDeal[],
  }));
  const at = new Map(out.map((g) => [g.key, g]));
  for (const d of deals) {
    if (d.row.cancelled) continue;
    if (!opt.includeSettled && isSettled(d.row)) continue;
    if (opt.pic && d.row.assignee !== opt.pic) continue;
    at.get(groupOfStage(d.row.stage))?.deals.push(d);
  }
  for (const g of out) g.deals.sort(sortDeals);
  return out;
}

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 요약 본문 — text 는 어디에나 붙는 평문, html 은 메일 본문용(메일 형식일 때만). */
export function buildDealSummary(
  deals: SummaryDeal[],
  steps: string[],
  opt: SummaryOptions,
  today = new Date(),
): { text: string; html: string; count: number } {
  const groups = groupDeals(deals, opt).filter((g) => g.deals.length);
  const f = new Set(opt.fields);
  const count = groups.reduce((n, g) => n + g.deals.length, 0);
  const title = `[KTMS] Active Deals 현황 — ${ymd(today)}${opt.pic ? ` · ${opt.pic}` : ""}`;
  const tally = groups.map((g) => `${g.label} ${g.deals.length}`).join(" · ");

  if (!count) return { text: `${title}\n\n해당하는 딜이 없습니다.`, html: "", count };

  const out: string[] = [];
  // 딜마다 일련번호를 달지 않는다 — 프로젝트 번호가 이미 이름이다. 대신 제목 줄을
  // <<…>> 로 감싸 세우고 딜 사이에 빈 줄을 둬, 긴 목록에서도 딜의 시작이 눈에 걸리게.
  const pushDeal = (d: SummaryDeal) => {
    const l = dealLines(d, f, steps, today);
    out.push("", `<<${l.head || "-"}>>`);
    if (l.meta.length) out.push(l.meta.join(" · "));
    for (const x of l.details) out.push(`- ${x.label}: ${x.body}`);
  };
  if (opt.format === "kakao") {
    out.push(title, `총 ${count}건 (${tally})`);
    for (const g of groups) {
      out.push("", `■ ${g.label} (${g.deals.length})`);
      g.deals.forEach(pushDeal);
    }
  } else {
    const rule = "─".repeat(32);
    out.push(title, `총 ${count}건 (${tally})`);
    for (const g of groups) {
      out.push("", rule, `${g.label}  (${g.deals.length}건)`, rule);
      g.deals.forEach(pushDeal);
    }
  }
  const text = out.join("\n").trimEnd();
  return { text, html: opt.format === "email" ? emailHtml(groups, f, steps, today, title, count, tally) : "", count };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 메일 본문용 HTML — Gmail·Outlook 에 붙였을 때 굵기·간격이 살아 있게. 스타일은
 *  인라인으로만(메일 클라이언트는 <style> 을 버린다). */
function emailHtml(
  groups: ReturnType<typeof groupDeals>,
  f: Set<SummaryFieldKey>,
  steps: string[],
  today: Date,
  title: string,
  count: number,
  tally: string,
): string {
  const font = "font-family:'Malgun Gothic',Arial,sans-serif;font-size:13px;color:#111827;";
  const h: string[] = [`<div style="${font}">`];
  h.push(`<div style="font-size:15px;font-weight:700;margin:0 0 2px">${esc(title)}</div>`);
  h.push(`<div style="color:#6b7280;margin:0 0 12px">총 ${count}건 (${esc(tally)})</div>`);
  for (const g of groups) {
    h.push(
      `<div style="font-weight:700;color:#0055a8;border-bottom:2px solid #0055a8;padding:2px 0;margin:14px 0 6px">` +
      `${esc(g.label)} <span style="color:#6b7280;font-weight:400">(${g.deals.length}건)</span></div>`
    );
    g.deals.forEach((d) => {
      const l = dealLines(d, f, steps, today);
      h.push(`<div style="margin:0 0 14px">`);
      h.push(`<div style="font-weight:700;font-size:14px">${esc(`<<${l.head || "-"}>>`)}</div>`);
      if (l.meta.length) h.push(`<div style="color:#6b7280">${esc(l.meta.join(" · "))}</div>`);
      for (const x of l.details) {
        const strong = x.label === "Next" || x.label === "Issue";
        const color = x.label === "Issue" ? "#a06a1c" : x.label === "Next" ? "#0055a8" : "#6b7280";
        h.push(
          `<div style="padding-left:16px"><span style="color:${color};font-weight:${strong ? 700 : 400}">` +
          `${esc(x.label)}</span>: ${esc(x.body)}</div>`
        );
      }
      h.push(`</div>`);
    });
  }
  h.push(`</div>`);
  return h.join("");
}
