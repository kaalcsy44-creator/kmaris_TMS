"use client";

// 모든 목록 화면의 Vendor 컬럼에서 벤더명 좌측에 회사 로고를 작게 표시한다.
// 로고는 vendorLogos 캐시(벤더명→data URL)에서 조회한다. (CustomerName 미러)
import { useVendorLogo } from "@/lib/vendorLogos";

export default function VendorName({ name }: { name: string }) {
  const logoFor = useVendorLogo();
  const logo = logoFor(name);
  if (!name) return <span className="muted">—</span>;
  return (
    <span className="cust-name">
      {logo ? <img className="cust-logo" src={logo} alt="" /> : null}
      <span className="cust-name-text">{name}</span>
    </span>
  );
}
