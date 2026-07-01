"use client";

// 모든 목록 화면의 Customer 컬럼에서 고객명 좌측에 회사 로고를 작게 표시한다.
// 로고는 customerLogos 캐시(고객명→data URL)에서 조회한다.
import { useCustomerLogo } from "@/lib/customerLogos";

export default function CustomerName({ name }: { name: string }) {
  const logoFor = useCustomerLogo();
  const logo = logoFor(name);
  if (!name) return <span className="muted">—</span>;
  return (
    <span className="cust-name">
      {logo ? <img className="cust-logo" src={logo} alt="" /> : null}
      <span className="cust-name-text">{name}</span>
    </span>
  );
}
