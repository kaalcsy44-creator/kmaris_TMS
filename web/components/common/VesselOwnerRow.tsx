"use client";

/**
 * 1단계 Vessel 밑의 한 줄 — 이 배의 등록 선주와 ISM 관리사, 그리고 그중 우리 고객이 있으면 제안.
 *
 * 선주·관리사는 선박 마스터에 붙어 있는 값이다(Partners › Vessel). 아직 비어 있으면 그 자리에서
 * IMO 로 찾아 볼 수 있고, 찾은 값은 "Save to vessel" 을 눌러야 마스터에 들어간다(웹 검색이라
 * 틀릴 수 있어 사람이 보고 넣는다 — 선박 화면과 같은 규칙).
 *
 * 고객 제안은 고객이 아직 비어 있을 때만 한다. 이미 골라 둔 고객이 관리사와 다른 것은 흔한
 * 일이다(중개·대리점이 들고 오는 딜) — 그걸 틀렸다고 알리면 소음이 된다.
 */

import { useMemo, useState } from "react";
import type { CustomerOption, SettingsVessel } from "@/lib/types";
import { lookupVessel, updateSettingsVessel, type VesselLookupResult } from "@/lib/api";
import { matchCompany } from "@/lib/companyMatch";
import CustomerName from "@/components/common/CustomerName";

function todayYmd(): string {
  return new Date().toLocaleDateString("sv-SE");
}

export default function VesselOwnerRow({
  vessel,
  companies,
  companyName,
  editable,
  onPickCompany,
  onVesselSaved,
}: {
  vessel: SettingsVessel;
  /** 회사 단위 고객 목록(회사당 하나) — 이름 맞대기 대상. */
  companies: CustomerOption[];
  /** 지금 고른 고객 회사 — 비어 있을 때만 제안한다. */
  companyName: string;
  editable: boolean;
  onPickCompany: (name: string) => void;
  onVesselSaved: () => void | Promise<void>;
}) {
  const [found, setFound] = useState<VesselLookupResult | null>(null);
  const [busy, setBusy] = useState<"" | "lookup" | "save">("");
  const [err, setErr] = useState<string | null>(null);

  // 조회 결과가 이 배의 것일 때만 쓴다(다른 배로 바꾸면 사라진다).
  const fresh = found && found.imo === (vessel.imo || "").replace(/\D/g, "") ? found : null;
  const owner = vessel.registered_owner || fresh?.registered_owner || "";
  const manager = vessel.ism_manager || fresh?.ism_manager || "";
  const unsaved = !!fresh && (
    (!!fresh.registered_owner && fresh.registered_owner !== vessel.registered_owner)
    || (!!fresh.ism_manager && fresh.ism_manager !== vessel.ism_manager));

  // 관리사가 먼저다 — 부품을 사는 쪽이 관리사이고, 선주는 대개 1척짜리 회사라 고객일 일이 드물다.
  const suggest = useMemo(() => {
    if (companyName) return null;
    const m = manager ? matchCompany(manager, companies) : null;
    if (m) return { c: m, role: "ISM manager" };
    const o = owner ? matchCompany(owner, companies) : null;
    return o ? { c: o, role: "Owner" } : null;
  }, [companyName, manager, owner, companies]);

  const hasImo = /\d{7}/.test(vessel.imo || "");
  if (!owner && !manager && !hasImo) return null;

  async function runLookup() {
    setBusy("lookup");
    setErr(null);
    try {
      const r = await lookupVessel(vessel.imo, vessel.name);
      setFound(r);
      if (!r.registered_owner && !r.ism_manager) setErr("Owner / manager not found on public pages.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Lookup failed");
    } finally {
      setBusy("");
    }
  }

  async function save() {
    if (!fresh) return;
    setBusy("save");
    setErr(null);
    try {
      const { id, customer: _c, sanctions: _s, ...rest } = vessel;
      await updateSettingsVessel(id, {
        ...rest,
        registered_owner: fresh.registered_owner || vessel.registered_owner || "",
        ism_manager: fresh.ism_manager || vessel.ism_manager || "",
        owner_checked: todayYmd(),
      });
      await onVesselSaved();
      setFound(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="vs-owner-row">
      {owner || manager ? (
        <span className="vs-owner-vals">
          <span><small>Owner</small> {owner || <span className="dash">—</span>}</span>
          <span><small>ISM manager</small> {manager || <span className="dash">—</span>}</span>
          {vessel.owner_checked && !unsaved ? <span className="muted">checked {vessel.owner_checked}</span> : null}
        </span>
      ) : (
        <span className="muted">Owner / ISM manager not looked up yet.</span>
      )}
      {editable && hasImo && (!vessel.registered_owner || !vessel.ism_manager) && !unsaved ? (
        <button type="button" className="btn xs" disabled={!!busy} onClick={runLookup}
                title="Find the registered owner and ISM manager by IMO on public ship pages">
          {busy === "lookup" ? "Looking up… (~20s)" : "🔍 Look up"}
        </button>
      ) : null}
      {editable && unsaved ? (
        <>
          <span className={`vs-conf vs-conf-${fresh!.confidence}`}>{fresh!.confidence}</span>
          {fresh!.sources[0] ? (
            <a href={fresh!.sources[0].url} target="_blank" rel="noopener noreferrer" title={fresh!.note}>source</a>
          ) : null}
          <button type="button" className="btn xs primary" disabled={!!busy} onClick={save}
                  title="Save this owner / manager to the vessel master (Partners › Vessel)">
            {busy === "save" ? "Saving…" : "Save to vessel"}
          </button>
        </>
      ) : null}
      {editable && suggest ? (
        <span className="vs-owner-suggest">
          {suggest.role} is our customer <CustomerName name={suggest.c.name} /> —
          <button type="button" className="btn xs" onClick={() => onPickCompany(suggest.c.name)}>
            Use as customer
          </button>
        </span>
      ) : null}
      {err ? <span className="action-err">{err}</span> : null}
    </div>
  );
}
