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

export default function VendorSuggest({
  rfqId,
  value,
  onPick,
}: {
  rfqId: number;
  /** 현재 폼에서 고른 벤더 — 추천 카드에 선택 표시를 맞춘다. */
  value: number | "";
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
          Suggested vendors
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
          No vendor matched these items by specialization or past deals — pick one below.
          {data && data.already_sent > 0
            ? ` (${data.already_sent} vendor(s) already asked on this deal.)`
            : ""}
        </div>
      ) : (
        <ul className="vsug-list">
          {vendors.map((v) => {
            const logo = v.logo || logoFor(v.name);
            return (
              <li key={v.id}>
                <button
                  type="button"
                  className={"vsug-card" + (v.id === value ? " on" : "")}
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
                    <span className={"vsug-dots " + (v.strength || "low")} title={`Match ${v.score}`}>
                      {DOTS[v.strength || "low"]}
                    </span>
                    <span className="vsug-pick">{v.id === value ? "Selected" : "Select"}</span>
                  </span>
                  <span className="vsug-why">
                    {v.reasons.map((r, i) => (
                      <span key={i} className={"vsug-reason " + r.kind}>{r.text}</span>
                    ))}
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
