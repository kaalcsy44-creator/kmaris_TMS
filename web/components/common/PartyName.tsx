"use client";

// 메일 상대(고객·벤더) 이름 한 조각 — 등록된 회사 로고를 앞에 붙인다.
// 색 배지로 고객/벤더를 구분하던 것을 그만뒀다: 목록에서 눈에 먼저 들어와야 하는 건
// 메일 제목이고, 상대는 로고와 이름만으로 충분히 알아본다.
import { useCustomerLogo } from "@/lib/customerLogos";
import { useVendorLogo } from "@/lib/vendorLogos";

export default function PartyName({ name, kind }: { name: string; kind?: string }) {
  const customerLogo = useCustomerLogo();
  const vendorLogo = useVendorLogo();
  if (!name) return <span className="mail-party">—</span>;
  // 같은 이름이 고객·벤더 양쪽에 등록돼 있을 수 있어, 아는 쪽을 먼저 본다.
  const logo =
    kind === "vendor"
      ? vendorLogo(name) || customerLogo(name)
      : customerLogo(name) || vendorLogo(name);
  return (
    <span className="mail-party" title={name}>
      {logo ? <img className="cust-logo" src={logo} alt="" /> : null}
      <span className="mail-party-name">{name}</span>
    </span>
  );
}
