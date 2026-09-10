"use client";

// 모든 목록 화면의 Vendor 컬럼에서 벤더명 좌측에 회사 로고를 작게 표시한다.
// 로고는 vendorLogos 캐시(벤더명→data URL)에서 조회한다. (CustomerName 미러)
// 한 셀에 여러 벤더가 개행("\n")으로 묶여 들어오는 경우(vrfq_vendors) 각 벤더마다
// 개별 로고를 붙여 준다.
//
// entries 를 주면(딜 화면) 이름마다 표시 상태(vendorEntriesOf)가 함께 온다 — 견적을
// 받은 곳에 체크, 기다리는 곳은 회색, 빠진 곳은 취소선. 상태를 모르는 화면(거래선
// 목록·문서 표)은 지금까지처럼 name 만 준다.
import { useVendorLogo } from "@/lib/vendorLogos";
import type { VendorEntry, VendorState } from "@/lib/deal";

// 상태별 툴팁 — 칸이 좁아 표시가 기호 하나로 줄어드는 자리에서 말로 확인할 수 있게.
const STATE_TITLE: Record<VendorState, string> = {
  quoted: "Quote received",
  waiting: "Awaiting quote",
  out: "No quote received",
  declined: "No quote (declined)",
  plain: "",
};

function VendorLine({
  name,
  state,
  logoFor,
}: {
  name: string;
  state: VendorState;
  logoFor: (n: string) => string | undefined;
}) {
  const logo = logoFor(name);
  const note = STATE_TITLE[state];
  return (
    <span
      // '견적 불가'는 통보를 받은 곳이라 칩 표시(검정 선)를 그대로 쓴다.
      className={`cust-name vendor-${state}${state === "declined" ? " vendor-out-chip" : ""}`}
      title={note ? `${name} — ${note}` : undefined}
    >
      {logo ? <img className="cust-logo" src={logo} alt="" /> : null}
      <span className="cust-name-text">{name}</span>
      {state === "quoted" ? (
        <span className="vendor-quoted-mark" aria-hidden="true">
          ✓
        </span>
      ) : null}
    </span>
  );
}

export default function VendorName({
  name,
  entries,
}: {
  /** 벤더명. 여러 곳이면 개행("\n")으로 이어 준다. entries 를 주면 무시된다. */
  name?: string;
  /** 이름 + 표시 상태 목록(deal.vendorEntriesOf). */
  entries?: VendorEntry[];
}) {
  const logoFor = useVendorLogo();
  const list: VendorEntry[] =
    entries ??
    (name || "")
      .split("\n")
      .map((n) => n.trim())
      .filter(Boolean)
      .map((n) => ({ name: n, state: "plain" as VendorState }));
  if (!list.length) return <span className="muted">—</span>;
  if (list.length === 1) return <VendorLine {...list[0]} logoFor={logoFor} />;
  return (
    <span className="cust-name-multi">
      {list.map((e, i) => (
        <VendorLine key={i} name={e.name} state={e.state} logoFor={logoFor} />
      ))}
    </span>
  );
}
