"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import AppShell from "@/components/AppShell";
import Modal from "@/components/common/Modal";
import { can } from "@/lib/auth";
import { CustomersTab, VendorsTab, MakersTab, VesselsTab } from "@/app/settings/page";
import type { PartnerNewFlow } from "@/app/settings/page";
import PartnerNetworkScreen from "@/components/screens/PartnerNetworkScreen";

// 상대처 명부 — 예전 Settings › Partners(Customer·Vendor·Maker 알약 전환)와 Settings › Vessels
// 를 자주 쓰여 상단 메뉴로 승격했다. 알약 전환은 그대로 페이지 탭이 됐고 Vessel 이 맨 뒤에
// 붙는다. 접근 권한은 settings 와 동일(마스터 데이터). 옛 /settings?tab=partners|vessels
// 링크는 설정 화면이 이리로 보낸다.
type Side = "customers" | "vendors" | "makers" | "vessels" | "network";

const TABS: { key: Side; label: string }[] = [
  { key: "customers", label: "Customer" },
  { key: "vendors", label: "Vendor" },
  { key: "makers", label: "Maker" },
  { key: "vessels", label: "Vessel" },
  // 관계망 — 고객·K-MARIS·거래선·메이커 사이의 왕래와 약한 고리(PartnerNetworkScreen).
  { key: "network", label: "Network" },
];

export default function PartnersPage() {
  // 탭 상태가 여기 있는 건 껍데기(AppShell)가 fill 여부를 알아야 해서다 — 상대처 세 표는
  // 화면을 채우고 그 안에서 굴린다. 선박 표는 설정 시절처럼 보통 배치.
  const [side, setSide] = useState<Side | null>(null);
  return (
    <AppShell active="partners" perm="settings" wide fill={side !== "vessels" && side !== "network"}>
      {/* ?side= / ?company= 딥링크(알림의 거래선 태그 제안 등)를 읽으므로 Suspense 로 감싼다. */}
      <Suspense fallback={<div className="state">Loading…</div>}>
        <Partners side={side} setSide={setSide} />
      </Suspense>
    </AppShell>
  );
}

type Kind = "customers" | "vendors" | "makers" | "vessels";

const KIND_INFO: Record<Kind, { label: string; icon: string; hint: string }> = {
  customers: { label: "Customer", icon: "🏢", hint: "Buys from us — ship owners, managers, agents" },
  vendors: { label: "Vendor", icon: "🚚", hint: "Supplies to us — stockists, agents, service shops" },
  makers: { label: "Maker", icon: "🏭", hint: "Manufactures the equipment or parts" },
  vessels: { label: "Vessel", icon: "🚢", hint: "A ship (IMO) — registered on its own" },
};
// 여러 명부를 골랐을 때 창이 열리는 차례 — 고른 순서가 아니라 언제나 이 차례다.
const COMPANY_KINDS: Kind[] = ["customers", "vendors", "makers"];

// 다음 명부의 창으로 넘겨 줄 회사·담당자 공통값. 명부마다 뜻이 다른 칸(specialization =
// 사는 것/대 주는 것/만드는 것)과 그 명부만의 칸(세금계산서·은행·메이커 태그)은 넘기지 않는다.
const CARRY_KEYS = [
  "name", "contact", "duty", "email", "contact_phone", "country", "address", "website",
  "note", "logo", "addresses", "emails", "phones", "regions", "category_ids", "payment_terms",
];
function carry(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of CARRY_KEYS) if (k in body) out[k] = body[k];
  return out;
}

const NO_FLOW: PartnerNewFlow = { token: 0, seed: {}, onCreated: () => {}, onCancel: () => {} };

type Flow = { queue: Kind[]; at: number; token: number; seed: Record<string, unknown> };

function Partners({ side, setSide }: { side: Side | null; setSide: (s: Side) => void }) {
  const param = useSearchParams().get("side");
  const initial: Side = TABS.some((t) => t.key === param) ? (param as Side) : "customers";
  const cur = side ?? initial;
  const canCreate = can("settings", "create");
  const [choosing, setChoosing] = useState(false);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [toast, setToast] = useState("");

  function notify(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? "" : t)), 5000);
  }

  function start(kinds: Kind[]) {
    setChoosing(false);
    setToast("");
    setFlow({ queue: kinds, at: 0, token: Date.now(), seed: {} });
    setSide(kinds[0]);
  }

  // 표에 건네는 요청 — 지금 차례인 명부의 표에만 token 을 싣는다. 나머지 표도 값은
  // 받는데(token 0 = 요청 없음), 받았다는 것만으로 도구줄 + New 를 감춘다.
  function flowFor(kind: Kind): PartnerNewFlow {
    if (!flow || flow.queue[flow.at] !== kind) return NO_FLOW;
    const f = flow;
    const many = f.queue.length > 1;
    const next = f.queue[f.at + 1];
    const info = KIND_INFO[kind];
    return {
      token: f.token,
      seed: f.seed,
      title: `${info.icon} New ${info.label}${many ? ` (${f.at + 1}/${f.queue.length})` : ""}`,
      banner: many ? (
        <>
          <span className="pn-flow-steps">
            {f.queue.map((k, i) => (
              <span key={k} className={i < f.at ? "done" : i === f.at ? "on" : ""}>
                {i < f.at ? "✓ " : ""}{KIND_INFO[k].label}
              </span>
            ))}
          </span>
          <span className="pn-flow-note">
            {f.at > 0 ? "Company details carried over from the previous step. " : ""}
            {next ? `After Add, the ${KIND_INFO[next].label} form opens next.` : "Last step."}
          </span>
        </>
      ) : undefined,
      onCreated: (body) => {
        if (next) {
          setFlow({ ...f, at: f.at + 1, token: f.token + 1, seed: carry(body) });
          setSide(next);
          return;
        }
        setFlow(null);
        const name = String(body.name ?? "").trim() || "New record";
        notify(`✓ ${name} registered as ${f.queue.map((k) => KIND_INFO[k].label).join(" · ")}`);
      },
      onCancel: () => {
        setFlow(null);
        const saved = f.queue.slice(0, f.at).map((k) => KIND_INFO[k].label);
        if (saved.length) notify(`Stopped — saved as ${saved.join(" · ")} only`);
      },
    };
  }

  return (
    <>
      <div className="page-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={cur === t.key ? "on" : ""} onClick={() => setSide(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {cur === "customers" && <CustomersTab newFlow={flowFor("customers")} />}
      {cur === "vendors" && <VendorsTab newFlow={flowFor("vendors")} />}
      {cur === "makers" && <MakersTab newFlow={flowFor("makers")} />}
      {cur === "vessels" && <VesselsTab newFlow={flowFor("vessels")} />}
      {cur === "network" && <PartnerNetworkScreen />}

      {/* 등록의 문은 하나 — 표마다 있던 + New 대신 우하단에서 무엇으로 등록할지부터 고른다. */}
      {canCreate ? (
        <button
          className="compose-fab"
          onClick={() => setChoosing(true)}
          title="Register a new customer, vendor, maker or vessel"
        >
          <span className="compose-fab-plus">＋</span>
          <span className="compose-fab-label">New</span>
        </button>
      ) : null}
      {toast ? <div className="pn-flow-toast">{toast}</div> : null}
      {choosing ? (
        <NewKindChooser
          initial={cur === "network" ? [] : [cur as Kind]}
          onClose={() => setChoosing(false)}
          onStart={start}
        />
      ) : null}
    </>
  );
}

/** 무엇으로 등록할지 고르는 창. 회사 셋(Customer·Vendor·Maker)은 한 회사가 여러 갈래일 수
 *  있어 함께 고를 수 있고(사기도 하고 대 주기도 하는 곳, 만들면서 직접 파는 곳),
 *  Vessel 은 회사가 아니라 배라서 홀로만 고른다. */
function NewKindChooser({ initial, onClose, onStart }: {
  initial: Kind[];
  onClose: () => void;
  onStart: (kinds: Kind[]) => void;
}) {
  const [picked, setPicked] = useState<Set<Kind>>(new Set(initial));
  function toggle(k: Kind) {
    setPicked((prev) => {
      if (k === "vessels") return prev.has("vessels") ? new Set<Kind>() : new Set<Kind>(["vessels"]);
      const next = new Set(prev);
      next.delete("vessels");
      if (!next.delete(k)) next.add(k);
      return next;
    });
  }
  const kinds: Kind[] = picked.has("vessels") ? ["vessels"] : COMPANY_KINDS.filter((k) => picked.has(k));
  const card = (k: Kind) => {
    const info = KIND_INFO[k];
    const on = picked.has(k);
    return (
      <button key={k} type="button" className={`pn-kind${on ? " on" : ""}`} onClick={() => toggle(k)}>
        <span className="pn-kind-check">{k === "vessels" ? (on ? "◉" : "○") : on ? "☑" : "☐"}</span>
        <span className="pn-kind-icon">{info.icon}</span>
        <span className="pn-kind-text">
          <b>{info.label}</b>
          <small>{info.hint}</small>
        </span>
      </button>
    );
  };
  return (
    <Modal title="＋ New registration" onClose={onClose} form>
      <div className="pn-kind-label">Company — pick one or more</div>
      <div className="pn-kind-list">{COMPANY_KINDS.map(card)}</div>
      <div className="pn-kind-label">or</div>
      <div className="pn-kind-list">{card("vessels")}</div>
      {kinds.length > 1 ? (
        <div className="pn-kind-note">
          The forms open one after another ({kinds.map((k) => KIND_INFO[k].label).join(" → ")}).
          Company name, contact, address, website and logo carry over to the next form.
        </div>
      ) : null}
      <div className="form-actions">
        <button className="btn primary" disabled={!kinds.length} onClick={() => onStart(kinds)}>
          Next →
        </button>
        <button className="btn" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
