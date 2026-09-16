"use client";

import { useState } from "react";

import { scanPartnerWebsite, type PartnerScan } from "@/lib/api";

/**
 * 홈페이지를 읽어 태그 후보를 내미는 칸 — 거래선의 🏢 Company info, 제조사의 🏭 Maker
 * 창에 함께 선다.
 *
 * 태그(취급 분류·대 줄 수 있는 제조사)는 RFQ 를 어디로 보낼지 정하는 축인데, 손으로
 * 채우게 두면 채워지지 않는다. 거래 실적에서 뽑는 제안이 이미 있지만(태그 칸의
 * 'Fill from history') 아직 거래해 본 적 없는 곳은 비어 있다 — 그 빈자리를 메우는 것이
 * 여기다.
 *
 * **고르는 것은 사람이 한다.** 홈페이지에 로고가 걸렸다고 그 메이커를 대 준다는 뜻은
 * 아니라서(한 번 납품한 실적일 수도, 호환품일 수도 있다), 받은 후보는 체크한 것만
 * 태그 칸으로 들어가고 저장은 평소의 Save 가 한다. 이 칸이 직접 쓰는 것은 없다.
 */
export function WebsiteScanPanel({
  kind,
  rowId,
  website,
  catIds,
  onCats,
  makerIds,
  onMakers,
  note,
  onNote,
}: {
  kind: "vendor" | "maker";
  /** 이 회사의 아무 담당자 줄 — 서버는 그 줄에서 회사 이름과 홈페이지만 읽는다. */
  rowId: number;
  /** 지금 폼에 적힌 홈페이지. 아직 저장 전이어도 이 값으로 읽는다. */
  website: string;
  catIds: number[];
  onCats: (ids: number[]) => void;
  /** 제조사 창에는 이 칸이 없다(그 회사가 곧 그 브랜드다) — 안 주면 그 줄이 안 선다. */
  makerIds?: number[];
  onMakers?: (ids: number[]) => void;
  note: string;
  onNote: (v: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<PartnerScan | null>(null);
  const [err, setErr] = useState("");
  // 체크된 후보. 처음에는 전부 켜 둔다 — 대개 맞고, 틀린 것을 빼는 편이 손이 덜 간다.
  const [pickCat, setPickCat] = useState<Set<number>>(new Set());
  const [pickMk, setPickMk] = useState<Set<number>>(new Set());

  const site = (website || "").trim();

  async function run() {
    setBusy(true);
    setErr("");
    setRes(null);
    try {
      const d = await scanPartnerWebsite(kind, rowId, site);
      setRes(d);
      // 이미 달려 있는 것은 뺀다 — 새로 고를 것만 남아야 무엇이 늘어나는지 보인다.
      setPickCat(new Set(d.categories.map((c) => c.id).filter((id) => !catIds.includes(id))));
      setPickMk(new Set(d.makers.map((m) => m.id).filter((id) => !(makerIds ?? []).includes(id))));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setBusy(false);
    }
  }

  function toggle(set: Set<number>, put: (s: Set<number>) => void, id: number) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    put(next);
  }

  function apply() {
    if (pickCat.size) onCats([...new Set([...catIds, ...pickCat])]);
    if (pickMk.size && onMakers) onMakers([...new Set([...(makerIds ?? []), ...pickMk])]);
    setPickCat(new Set());
    setPickMk(new Set());
  }

  const freshCats = (res?.categories ?? []).filter((c) => !catIds.includes(c.id));
  const freshMks = (res?.makers ?? []).filter((m) => !(makerIds ?? []).includes(m.id));
  const nothingNew = !!res && !res.error && !freshCats.length && !freshMks.length;

  return (
    <div className="form-field scan-panel">
      <span>Read the website</span>
      <div className="scan-bar">
        <button type="button" className="btn sm" disabled={busy || !site} onClick={run}
                title={site ? `Read ${site} and suggest tags` : "Enter a website address first"}>
          {busy ? "Reading…" : res ? "Scan again" : "Scan website"}
        </button>
        {!site ? <span className="hint-inline">No website on file yet.</span> : null}
        {res && !res.error ? (
          <span className="hint-inline">
            Read {res.pages.length} page{res.pages.length === 1 ? "" : "s"}
            {res.pages.length === 1 ? " — only the front page had text." : "."}
          </span>
        ) : null}
      </div>

      {err ? <span className="form-error">{err}</span> : null}
      {res?.error ? <span className="scan-warn">{res.error}</span> : null}

      {res && !res.error ? (
        <div className="scan-out">
          {res.evidence ? <p className="scan-why">{res.evidence}</p> : null}

          {freshMks.length ? (
            <div className="scan-group">
              <b>Makers supplied</b>
              {freshMks.map((m) => (
                <label key={m.id} className="scan-pick">
                  <input type="checkbox" checked={pickMk.has(m.id)}
                         onChange={() => toggle(pickMk, setPickMk, m.id)} />
                  <span>{m.name}{m.country ? <i> · {m.country}</i> : null}</span>
                </label>
              ))}
            </div>
          ) : null}

          {freshCats.length ? (
            <div className="scan-group">
              <b>Item categories</b>
              {freshCats.map((c) => (
                <label key={c.id} className="scan-pick" title={c.path}>
                  <input type="checkbox" checked={pickCat.has(c.id)}
                         onChange={() => toggle(pickCat, setPickCat, c.id)} />
                  <span>{c.code} {c.path.split(">").pop()?.trim()}</span>
                </label>
              ))}
            </div>
          ) : null}

          {nothingNew ? (
            <span className="hint-inline">
              Nothing new — everything the website mentions is already tagged.
            </span>
          ) : null}

          <div className="scan-actions">
            <button type="button" className="btn sm primary"
                    disabled={!pickCat.size && !pickMk.size} onClick={apply}>
              Add checked ({pickCat.size + pickMk.size})
            </button>
            {res.summary && res.summary !== note ? (
              <button type="button" className="btn sm" onClick={() => onNote(res.summary)}
                      title={res.summary}>
                {note.trim() ? "Replace About with this" : "Use as About"}
              </button>
            ) : null}
          </div>

          {res.unlisted_brands.length ? (
            <div className="scan-group scan-unlisted">
              <b>Brands not in our Maker book</b>
              {/* 태그로 달 수가 없다 — 명부에 없는 이름이라서다. 그래도 지우지 않고
                  보여 준다: 무엇을 명부에 올려야 하는지가 여기 적혀 있다. */}
              <span>{res.unlisted_brands.join(" · ")}</span>
              <i>Register these under Partners ▸ Maker first, then scan again.</i>
            </div>
          ) : null}
        </div>
      ) : null}

      <span className="hint-inline">
        Reads the front page and a few product pages, then proposes tags — it never saves
        on its own. A logo on a website is not proof they supply that brand, so check
        before adding.
      </span>
    </div>
  );
}
