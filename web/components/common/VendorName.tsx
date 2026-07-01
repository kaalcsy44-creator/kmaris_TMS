"use client";

// 모든 목록 화면의 Vendor 컬럼에서 벤더명 좌측에 회사 로고를 작게 표시한다.
// 로고는 vendorLogos 캐시(벤더명→data URL)에서 조회한다. (CustomerName 미러)
// 한 셀에 여러 벤더가 개행("\n")으로 묶여 들어오는 경우(vrfq_vendors) 각 벤더마다
// 개별 로고를 붙여 준다.
import { useVendorLogo } from "@/lib/vendorLogos";

function VendorLine({ name, logoFor }: { name: string; logoFor: (n: string) => string | undefined }) {
  const logo = logoFor(name);
  return (
    <span className="cust-name">
      {logo ? <img className="cust-logo" src={logo} alt="" /> : null}
      <span className="cust-name-text">{name}</span>
    </span>
  );
}

export default function VendorName({ name }: { name: string }) {
  const logoFor = useVendorLogo();
  if (!name) return <span className="muted">—</span>;
  const names = name.split("\n").map((n) => n.trim()).filter(Boolean);
  if (names.length <= 1) return <VendorLine name={name} logoFor={logoFor} />;
  return (
    <span className="cust-name-multi">
      {names.map((n, i) => (
        <VendorLine key={i} name={n} logoFor={logoFor} />
      ))}
    </span>
  );
}
