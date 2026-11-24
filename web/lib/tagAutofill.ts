// 거래처의 두 태그(취급 분류 · Makers supplied)를 채울 값을 모은다 — 거래 기록과 홈페이지.
//
// 기록은 셀 수 있는 사실이고 홈페이지는 그 회사의 주장이다. 둘 다 '왜'를 붙여 돌려주고,
// 화면은 태그 칸(아직 저장 전)에만 넣는다 — 틀린 것은 ×로 빼고 저장은 사람이 한다.
// 메일에 이름이 나온 것은 넣지 않는다(물어본 말을 되풀이했을 수도 있다) — 그쪽은
// 회사 정보 창의 제안 목록이 근거를 펼쳐 놓고 하나씩 묻는다.

import { fetchVendorMakerHistory, findPartnerWebsite, scanPartnerWebsite } from "@/lib/api";

export type AutofillTag = { id: number; name: string; why: string };
export type TagAutofillResult = {
  categories: AutofillTag[];
  makers: AutofillTag[];
  /** 명부에 없는 브랜드 — 등록해야 태그로 달 수 있다. */
  unlisted: { name: string; why: string }[];
  /** 무엇을 읽었고 무엇을 못 읽었는지(화면에 그대로 적는다). */
  notes: string[];
};
export type TagAutofill = () => Promise<TagAutofillResult>;

type Source = {
  kind: "vendor" | "maker";
  company: string;
  website: string;
  rowId: number | null;
  /** 실적에서 뽑아 둔 분류 제안(거래선). */
  history?: { id: number; path: string; kind: string; count: number }[];
};

const leaf = (path: string) => path.split(">").pop()?.trim() || path;

async function collect(src: Source): Promise<TagAutofillResult> {
  const out: TagAutofillResult = { categories: [], makers: [], unlisted: [], notes: [] };
  const push = (list: AutofillTag[], t: AutofillTag) => {
    const hit = list.find((x) => x.id === t.id);
    if (hit) hit.why = `${hit.why} · ${t.why}`;
    else list.push(t);
  };
  const company = src.company.trim();

  for (const h of src.history ?? []) {
    push(out.categories, { id: h.id, name: leaf(h.path), why: `${h.kind === "bought" ? "bought" : "quoted"} ×${h.count}` });
  }

  const records = async () => {
    if (src.kind !== "vendor" || !company) return;
    try {
      const d = await fetchVendorMakerHistory(company);
      for (const m of d.makers) {
        push(out.makers, { id: m.id, name: m.name, why: `${m.kind === "po" ? "bought" : "quoted"} ×${m.count}` });
      }
      for (const u of d.unlisted) out.unlisted.push({ name: u.name, why: `on our documents ×${u.count}` });
    } catch {
      out.notes.push("Past quotes and orders could not be read.");
    }
  };

  const web = async () => {
    let site = src.website.trim();
    try {
      let byName = false;
      if (!site && company) {
        const f = await findPartnerWebsite(company, src.kind);
        site = f.website;
        byName = !!site;
        if (!site && f.categories.length) {
          // 홈페이지가 없는 회사 — 검색에서 확인된 분류만이라도 얹는다.
          for (const c of f.categories) push(out.categories, { id: c.id, name: leaf(c.path), why: "web search" });
          out.notes.push("No website found — used web search and past records.");
          return;
        }
      }
      if (!site) {
        out.notes.push("No website found — history only.");
        return;
      }
      const s = await scanPartnerWebsite(src.kind, src.website.trim() ? src.rowId : null, site, company);
      if (s.error) {
        out.notes.push(s.error);
        return;
      }
      const host = site.replace(/^https?:\/\//, "").replace(/\/$/, "");
      out.notes.push(byName ? `Read ${host} — found by name, check it is this company.` : `Read ${host}.`);
      for (const c of s.categories) push(out.categories, { id: c.id, name: leaf(c.path), why: "website" });
      for (const m of s.makers) push(out.makers, { id: m.id, name: m.name, why: "website" });
      for (const b of s.unlisted_brands) {
        if (!out.unlisted.some((u) => u.name.toLowerCase() === b.toLowerCase())) {
          out.unlisted.push({ name: b, why: "website" });
        }
      }
    } catch (e) {
      out.notes.push(e instanceof Error ? e.message : "The website could not be read.");
    }
  };

  // 기록을 먼저 얹는다 — 근거가 겹치면 "bought ×3 · website" 순으로 읽힌다.
  await records();
  await web();
  return out;
}

/** 두 태그 칸이 함께 쓰는 자동 입력. 같은 회사·주소를 또 부르면 읽어 둔 것을 다시 쓴다
 *  (분류에서 읽은 홈페이지를 메이커 칸이 한 번 더 읽지 않게 — 한 번에 30초다). */
let memo: { key: string; at: number; p: Promise<TagAutofillResult> } | null = null;

export function tagAutofill(src: Source): TagAutofill {
  return () => {
    const key = JSON.stringify([src.kind, src.company.trim(), src.website.trim(), src.rowId, src.history?.length]);
    if (memo && memo.key === key && Date.now() - memo.at < 300_000) return memo.p;
    const p = collect(src);
    memo = { key, at: Date.now(), p };
    return p;
  };
}
