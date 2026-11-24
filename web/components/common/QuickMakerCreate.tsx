"use client";

// 메이커를 고르던 그 자리에서 새 메이커를 등록한다 — Makers supplied 칸(MakerTagPicker)과
// 홈페이지에서 나온 "명부에 없는 브랜드"가 함께 쓴다.
//
// 이름만 적어도 등록되지만, ✨ Auto-fill 을 누르면 홈페이지(비어 있으면 이름으로 찾아서)를
// 읽어 회사 정보와 만드는 품목 분류를 빈 칸에 채운다. 등록은 사람이 누를 때만 한다.

import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Modal from "./Modal";
import { CategoryTagPicker } from "./CategoryTags";
import { createSettingsMaker, fetchSiteProfile, findPartnerWebsite, scanPartnerWebsite } from "@/lib/api";
import { fileToLogoDataUrl } from "@/lib/imagePaste";
import type { SettingsMaker } from "@/lib/types";

/** 이름 비교용 — 대소문자·구두점·법인 표기를 지운다("Hanshin Co., Ltd." = "HANSHIN"). */
function key(v: string): string {
  return v
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]+/g, " ")
    .replace(/\b(co|ltd|limited|inc|corp|corporation|company|gmbh|plc|llc|pte)\b|주식회사/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type Draft = Omit<SettingsMaker, "id">;
const EMPTY: Draft = {
  name: "", contact: "", duty: "", email: "", contact_phone: "", country: "", address: "",
  website: "", specialization: "", note: "", logo: "",
  addresses: [], emails: [], phones: [], regions: [], category_ids: [],
};

export default function QuickMakerCreate({
  defaultName,
  makers,
  onPickExisting,
  onCreated,
  onClose,
}: {
  defaultName: string;
  /** 회사 단위 메이커 명부 — 같은 회사를 두 번 세우지 않게 견준다. */
  makers: SettingsMaker[];
  onPickExisting: (id: number) => void;
  onCreated: (m: SettingsMaker) => void;
  onClose: () => void;
}) {
  const [d, setD] = useState<Draft>({ ...EMPTY, name: defaultName });
  const [busy, setBusy] = useState("");   // 자동 입력의 지금 단계
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  // 읽는 데 30초 남짓 걸린다 — 그사이 사람이 적은 값을 덮지 않도록 끝난 시점의 값에 얹는다.
  const latest = useRef(d);
  latest.current = d;
  const put = (p: Partial<Draft>) => {
    const next = { ...latest.current, ...p };
    latest.current = next;
    setD(next);
  };

  const k = key(d.name);
  const { same, similar } = useMemo(() => {
    const hits = k
      ? makers.filter((m) => {
          const mk = key(m.name);
          return mk === k || (k.length >= 4 && mk.length >= 4 && (mk.startsWith(k + " ") || k.startsWith(mk + " ")));
        })
      : [];
    return { same: hits.find((m) => key(m.name) === k) ?? null, similar: hits.filter((m) => key(m.name) !== k).slice(0, 4) };
  }, [k, makers]);

  async function autofill() {
    const name = d.name.trim();
    if (busy || (!name && !d.website.trim())) return;
    setErr("");
    setNote("");
    try {
      let site = d.website.trim();
      let found = "";
      if (!site) {
        setBusy("Finding website…");
        const f = await findPartnerWebsite(name, "maker");
        if (!f.website) {
          // 홈페이지가 없는 회사 — 검색에서 확인된 것만 채운다.
          const cur = latest.current;
          const patch: Partial<Draft> = {};
          const got: string[] = [];
          if (f.region && !cur.country.trim()) { patch.country = f.region; got.push("Region"); }
          if (f.products && !cur.specialization.trim()) { patch.specialization = f.products; got.push("Specialization"); }
          const add = f.categories.map((c) => c.id).filter((id) => !cur.category_ids.includes(id));
          if (add.length) {
            patch.category_ids = [...cur.category_ids, ...add];
            got.push(`Item categories (${add.length})`);
          }
          put(patch);
          if (got.length) setNote(`No official website found. From web search, check before saving: ${got.join(", ")}.`);
          else setErr(`Website not found${f.reason ? ` — ${f.reason}` : "."} Enter the address and try again.`);
          return;
        }
        site = f.website;
        found = f.reason;
        if (!latest.current.website.trim()) put({ website: site });
      }
      setBusy("Reading website…");
      const [prof, scan] = await Promise.allSettled([
        fetchSiteProfile(site, "maker"),
        scanPartnerWebsite("maker", null, site, name),
      ]);
      const filled: string[] = [];
      if (prof.status === "fulfilled") {
        const p = prof.value;
        const cur = latest.current;
        const patch: Partial<Draft> = {};
        const set = (f: "name" | "specialization" | "note" | "logo" | "country" | "address" | "email" | "contact_phone",
                     label: string, v?: string) => {
          if (v?.trim() && !cur[f].trim()) {
            patch[f] = v.trim();
            filled.push(label);
          }
        };
        let logo = "";
        if (p.logo) {
          try {
            const blob = await (await fetch(p.logo)).blob();
            logo = await fileToLogoDataUrl(new File([blob], "logo", { type: blob.type }));
          } catch {
            logo = "";   // 그림이 깨졌으면 로고만 건너뛴다
          }
        }
        set("name", "Name", p.company);
        set("country", "Region", p.regions?.[0]);
        set("address", "Address", p.addresses?.[0]);
        set("email", "Email", p.emails?.[0]);
        set("contact_phone", "Phone", p.phones?.[0]);
        set("specialization", "Specialization", p.specialization);
        set("note", "About", p.about);
        set("logo", "Logo", logo);
        // 나머지 값(둘째 주소·메일…)은 대표 값이 이 홈페이지에서 왔을 때만 함께 담는다.
        if (patch.address) patch.addresses = p.addresses;
        if (patch.email) patch.emails = p.emails;
        if (patch.contact_phone) patch.phones = p.phones;
        if (patch.country) patch.regions = p.regions;
        put(patch);
      }
      if (scan.status === "fulfilled" && !scan.value.error) {
        const have = latest.current.category_ids;
        const add = scan.value.categories.map((c) => c.id).filter((id) => !have.includes(id));
        if (add.length) {
          put({ category_ids: [...have, ...add] });
          filled.push(`Item categories (${add.length})`);
        }
      }
      if (filled.length) {
        setNote(`Filled: ${filled.join(", ")}.${found ? ` Site found by name — ${found}` : ""}`);
      } else if (prof.status === "rejected") {
        setErr(prof.reason instanceof Error ? prof.reason.message : "Could not read the website.");
      } else {
        setErr("Nothing new was found on the website.");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Auto-fill failed");
    } finally {
      setBusy("");
    }
  }

  async function submit() {
    const name = d.name.trim();
    if (!name || saving || same) return;
    setSaving(true);
    setErr("");
    const list = (first: string, rest: string[]) =>
      [...new Set([first.trim(), ...rest.map((v) => v.trim())].filter(Boolean))];
    const body: Draft = {
      ...d,
      name,
      email: d.email.trim(),
      contact_phone: d.contact_phone.trim(),
      country: d.country.trim(),
      address: d.address.trim(),
      website: d.website.trim(),
      addresses: list(d.address, d.addresses),
      emails: list(d.email, d.emails),
      phones: list(d.contact_phone, d.phones),
      regions: list(d.country, d.regions),
    };
    try {
      const r = await createSettingsMaker(body);
      onCreated({ ...body, id: r.id });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
      setSaving(false);
    }
  }

  if (typeof document === "undefined") return null;
  const locked = saving || !!busy;
  const text = (f: "website" | "country" | "address" | "email" | "contact_phone", label: string, placeholder = "") => (
    <label className="form-field">
      <span>{label}</span>
      <input value={d[f]} placeholder={placeholder}
             onChange={(e) => put({ [f]: e.target.value,
               // 대표 값을 손으로 바꾸면 홈페이지에서 함께 온 나머지 목록은 버린다.
               ...(f === "country" ? { regions: [] } : f === "address" ? { addresses: [] }
                 : f === "email" ? { emails: [] } : f === "contact_phone" ? { phones: [] } : {}) })} />
    </label>
  );

  return createPortal(
    // 회사 정보 창 위에 겹쳐 뜬다 — 창 안에 두면 창의 스크롤 상자에 갇힌다.
    <Modal title="🏭 New maker — quick register" onClose={() => { if (!saving) onClose(); }} form maxWidth={680}>
      <div className="form-grid">
        <label className="form-field">
          <span>Maker name *</span>
          <input autoFocus value={d.name} onChange={(e) => put({ name: e.target.value })}
                 onKeyDown={(e) => {
                   if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
                 }} />
        </label>
        {text("website", "Website", "Leave blank to find it by name")}
        <div className="form-field full qmk-fill">
          <div className="scan-bar">
            <button type="button" className="btn sm" disabled={locked || (!d.name.trim() && !d.website.trim())}
                    onClick={() => void autofill()}
                    title="Find and read the maker's website, then fill the empty fields and item categories">
              {busy || "✨ Auto-fill maker & items"}
            </button>
            <span className="hint-inline">
              {busy ? "Takes 30–60 s." : "Website · region · address · contact · logo · about · item categories — only empty fields."}
            </span>
          </div>
          {note ? <span className="action-ok">{note}</span> : null}
          {err ? <span className="action-err">{err}</span> : null}
        </div>
        {same || similar.length ? (
          <div className="form-field full qmk-dup">
            <span>{same ? "Already in the maker list:" : "Similar makers in the list — is it one of these?"}</span>
            {(same ? [same] : similar).map((m) => (
              <button key={m.id} type="button" className="btn sm" onClick={() => onPickExisting(m.id)}>
                Use “{m.name}”
              </button>
            ))}
          </div>
        ) : null}
        {text("country", "Region", "Busan, Korea")}
        {text("address", "Address")}
        {text("email", "Email")}
        {text("contact_phone", "Phone")}
        <label className="form-field full qmk-area">
          <span>Specialization</span>
          <textarea rows={2} value={d.specialization} onChange={(e) => put({ specialization: e.target.value })} />
        </label>
        <label className="form-field full qmk-area">
          <span>About</span>
          <textarea rows={3} value={d.note} onChange={(e) => put({ note: e.target.value })} />
        </label>
        {d.logo ? (
          <div className="form-field full qmk-logo">
            <span>Logo</span>
            <img src={d.logo} alt="logo" />
            <button type="button" className="btn sm" onClick={() => put({ logo: "" })}>Remove</button>
          </div>
        ) : null}
        <div className="full">
          <CategoryTagPicker value={d.category_ids} onChange={(category_ids) => put({ category_ids })}
                             hint="What this maker builds." />
        </div>
      </div>
      <div className="form-actions">
        <button type="button" className="btn primary" disabled={locked || !d.name.trim() || !!same}
                onClick={() => void submit()}>
          {saving ? "Saving…" : "Register & add"}
        </button>
        <button type="button" className="btn" disabled={saving} onClick={onClose}>Cancel</button>
      </div>
    </Modal>,
    document.body
  );
}
