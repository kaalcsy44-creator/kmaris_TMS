"use client";

// 2단계(RFQ Sent) 거래선 추천 — "이 품목은 어디에 물어볼까"를 화면이 먼저 짚어 준다.
// 근거는 1단계 품목의 분류·품번과 벤더의 취급품목(Settings > Vendor > Specialization)·
// 거래이력이다. 고르는 건 사람이므로 순위만 내밀지 않고 '왜'를 함께 적는다 —
// 근거가 납득되지 않으면 무시하고 아래 Vendor 드롭다운에서 직접 고르면 된다.
import { useEffect, useState } from "react";
import { fetchVendorSuggestions } from "@/lib/api";
import type { VendorSuggestData, VendorSuggestion } from "@/lib/api";
import { useVendorLogo } from "@/lib/vendorLogos";

const DOTS: Record<string, string> = { high: "●●●", medium: "●●", low: "●" };

// 카드에 세우는 연관 낱말 수. 근거 문장을 전부 늘어놓으면 등록된 태그·대리점 목록이
// 통째로 딸려 와, 이 딜과 무엇이 맞았는지가 그 속에 묻혔다. 낱말만, 겹치지 않게, 몇 개만.
const TAG_MAX = 5;

/** 근거 → 겹치지 않는 연관 낱말들(센 근거가 먼저 — 서버가 그 차례로 준다). */
function reasonTags(reasons: VendorSuggestion["reasons"]) {
  const seen = new Set<string>();
  const out: { kind: string; tag: string; text: string[] }[] = [];
  for (const r of reasons) {
    const tag = (r.tag || r.text || "").trim();
    const key = tag.toLowerCase();
    if (!tag) continue;
    const hit = out.find((x) => x.tag.toLowerCase() === key);
    if (hit) { hit.text.push(r.text); continue; }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: r.kind, tag, text: [r.text] });
  }
  return out;
}

export default function VendorSuggest({
  rfqId,
  value,
  makerValue = "",
  onPick,
}: {
  rfqId: number;
  /** 현재 폼에서 고른 벤더 — 추천 카드에 선택 표시를 맞춘다. */
  value: number | "";
  /** 현재 폼에서 고른 메이커 담당자(메이커 카드의 선택 표시). */
  makerValue?: number | "";
  onPick: (v: VendorSuggestion) => void;
}) {
  const [data, setData] = useState<VendorSuggestData | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(true);
  const logoFor = useVendorLogo();

  useEffect(() => {
    if (!rfqId) {
      setData(null);
      return;
    }
    let alive = true;
    setLoading(true);
    fetchVendorSuggestions(rfqId)
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setData(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [rfqId]);

  // 품목이 없으면 볼 것이 없다(서비스 요청 등) — 자리만 차지하지 않게 통째로 숨긴다.
  if (!rfqId || (!loading && (!data || data.items === 0))) return null;

  const vendors = data?.vendors ?? [];
  return (
    <div className="vsug">
      <div className="vsug-head">
        <button type="button" className="vsug-toggle" onClick={() => setOpen((v) => !v)}>
          <span className="vsug-caret" aria-hidden>{open ? "▾" : "▸"}</span>
          Suggested vendors &amp; makers
          {vendors.length ? <b className="vsug-count">{vendors.length}</b> : null}
        </button>
        {data && data.categories.length ? (
          <span className="vsug-basis">
            {data.categories.map((c) => (
              <span key={c.id} className={"vsug-cat" + (c.guessed ? " guess" : "")} title={c.path}>
                {c.path || c.name}
                <i>{c.items}</i>
              </span>
            ))}
          </span>
        ) : null}
      </div>
      {!open ? null : loading ? (
        <div className="vsug-empty">Looking for vendors that handle these items…</div>
      ) : vendors.length === 0 ? (
        <div className="vsug-empty">
          No vendor or maker matched these items by specialization or past deals — pick one below.
          {data && data.already_sent > 0
            ? ` (${data.already_sent} vendor(s) already asked on this deal.)`
            : ""}
        </div>
      ) : (
        <ul className="vsug-list">
          {vendors.map((v) => {
            const logo = v.logo || logoFor(v.name);
            const ids = v.contact_ids?.length ? v.contact_ids : [v.id];
            const isMaker = v.party === "maker";
            const cur = isMaker ? makerValue : value;
            const on = cur !== "" && ids.includes(cur);
            const tags = reasonTags(v.reasons);
            const shown = tags.slice(0, TAG_MAX);
            const rest = tags.slice(TAG_MAX);
            const people = (v.contacts ?? [])
              .map((c) => c.contact || c.email)
              .filter(Boolean);
            return (
              <li key={`${v.party || "vendor"}-${v.id}`}>
                <button
                  type="button"
                  className={"vsug-card" + (on ? " on" : "")}
                  onClick={() => onPick(v)}
                  title={v.specialization || ""}
                >
                  <span className="vsug-card-top">
                    {logo ? (
                      <img className="vsug-logo" src={logo} alt="" />
                    ) : (
                      <span className="vsug-logo vsug-logo-blank" aria-hidden />
                    )}
                    <b className="vsug-name">{v.name}</b>
                    {/* 메이커 명부에서 온 후보 — 고르면 아래가 Maker 로 바뀐다(직접 문의). */}
                    {isMaker ? (
                      <span className="vsug-party" title="From the Maker book — asking the manufacturer directly">
                        Maker
                      </span>
                    ) : null}
                    <span className={"vsug-dots " + (v.strength || "low")} title={`Match ${v.score}`}>
                      {DOTS[v.strength || "low"]}
                    </span>
                    <span className="vsug-pick">{on ? "Selected" : "Select"}</span>
                  </span>
                  {people.length > 1 ? (
                    <span className="vsug-people" title={people.join(", ")}>
                      {people.length} contacts · {people.join(", ")}
                    </span>
                  ) : null}
                  <span className="vsug-why">
                    {shown.map((r) => (
                      <span key={r.tag} className={"vsug-reason " + r.kind} title={r.text.join("\n")}>
                        {r.tag}
                      </span>
                    ))}
                    {rest.length ? (
                      <span className="vsug-reason vsug-more"
                            title={rest.map((r) => r.text.join("\n")).join("\n")}>
                        +{rest.length}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
