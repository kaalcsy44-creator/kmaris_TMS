"use client";

import { useState } from "react";
import { lookupVessel, type VesselLookupResult } from "@/lib/api";
import type { VesselSanction } from "@/lib/types";

/* 제재 선박 표시 · IMO 조회 — 선박 목록(Partners › Vessel), 새 선박 등록, RFQ 의 선박 선택이
   같은 모양을 쓴다. 제재는 **경고만** 한다(거래를 막지 않는다 — 2026-10-21 결정).
   명부: US OFAC SDN · UK Sanctions List, IMO 번호로 맞춘다(ktms/services/sanctions.py). */

/** "US OFAC (RUSSIA-EO14024, listed as ALEXEY KOSYGIN)" — 명부마다 한 줄. */
function hitText(h: VesselSanction): string {
  const bits = [h.program, h.name ? `listed as ${h.name}` : ""].filter(Boolean);
  return bits.length ? `${h.source} (${bits.join(", ")})` : h.source;
}

/** 목록 칸 안의 작은 표지. 마우스를 올리면 어느 명부에 어떻게 올랐는지. */
export function SanctionBadge({ hits }: { hits?: VesselSanction[] }) {
  if (!hits?.length) return null;
  return (
    <span className="vs-badge" title={`Sanctioned — ${hits.map(hitText).join(" · ")}`}>
      ⚠ Sanctioned
    </span>
  );
}

/** 선박을 고르거나 등록하는 자리에 서는 경고 상자. */
export function SanctionWarning({ hits }: { hits?: VesselSanction[] }) {
  if (!hits?.length) return null;
  return (
    <div className="vs-warn" role="alert">
      <b>⚠ Sanctioned vessel</b> — on {hits.map(hitText).join("; ")}.
      <span className="vs-warn-sub">
        Matched by IMO number. Check with compliance before quoting or supplying.
      </span>
    </div>
  );
}

/** IMO 로 선종·기국·선주·관리사를 찾는 단추 — 결과를 넘겨줄 뿐 저장하지 않는다(채운 칸을 사람이 저장). */
export function VesselLookupButton({
  imo,
  name,
  onResult,
}: {
  imo: string;
  name?: string;
  onResult: (r: VesselLookupResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = /\d{7}/.test(imo || "");
  async function run() {
    setBusy(true);
    setErr(null);
    try {
      onResult(await lookupVessel(imo, name || ""));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Lookup failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="vs-lookup">
      <button
        type="button"
        className="btn sm"
        disabled={!ok || busy}
        title={ok ? "Find vessel type, flag, registered owner and ISM manager on the web, and check the sanctions lists" : "Enter the 7-digit IMO number first"}
        onClick={run}
      >
        {busy ? "Looking up… (~15s)" : "🔍 Look up by IMO"}
      </button>
      {err ? <span className="action-err">{err}</span> : null}
    </span>
  );
}

/** 조회 결과 — 무엇을 찾았고 어디서 봤는지. 웹 검색이라 틀릴 수 있어 출처를 늘 함께 보인다. */
export function LookupNote({ r }: { r: VesselLookupResult | null }) {
  if (!r) return null;
  const found = [r.vessel_type, r.flag].filter(Boolean).join(" · ");
  return (
    <div className="vs-note">
      <SanctionWarning hits={r.sanctions} />
      <div>
        {found ? (
          <>
            Found: <b>{found}</b>
            {r.name ? <> — {r.name}</> : null}
            <span className={`vs-conf vs-conf-${r.confidence}`}>{r.confidence}</span>
          </>
        ) : (
          <>Could not confirm type or flag for IMO {r.imo}.</>
        )}
        {!r.sanctions.length ? <span className="vs-clear">✓ Not on US OFAC / UK lists</span> : null}
      </div>
      {r.registered_owner || r.ism_manager ? (
        <div className="vs-owner">
          {r.registered_owner ? <>Owner: <b>{r.registered_owner}</b></> : null}
          {r.registered_owner && r.ism_manager ? " · " : null}
          {r.ism_manager ? <>ISM manager: <b>{r.ism_manager}</b></> : null}
        </div>
      ) : null}
      {r.note ? <div className="muted">{r.note}</div> : null}
      {r.sources.length ? (
        <div className="vs-src">
          Sources:{" "}
          {r.sources.map((s, i) => (
            <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer" title={s.title}>
              {i + 1}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}
