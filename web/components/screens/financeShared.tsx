"use client";

import Link from "next/link";

/**
 * Finance 화면들이 함께 쓰는 표기·조각들.
 *
 * 원래는 FinanceScreen 에 있었고 다른 화면이 거기서 가져다 썼다. 탭 하나가 파일로
 * 떨어져 나오면서(Daybook) 서로를 부르는 고리가 생겨, 화면에 매이지 않는 것들만
 * 여기로 옮겼다 — 통화 표기, 달 이름, 그리고 어느 표에서나 같은 모양이어야 하는
 * KPI 타일과 문서번호 링크.
 */

// 분류 코드는 저장값(한글)이고 아래 라벨은 표시 전용이다 — 번역하지 않는다.
export const INCOME_CATEGORY_LABEL: Record<string, string> = {
  이자수입: "Interest",
  환급: "Refund",
  잡수입: "Misc income",
  기타: "Other",
};
export const CATEGORY_LABEL: Record<string, string> = {
  거래선지급: "Vendor payment",
  컨설팅비: "Consulting fee",
  임차료: "Rent",
  급여: "Payroll",
  공과금: "Utilities",
  세금: "Tax",
  기타: "Other",
};

export function sym(currency: string): string {
  return currency === "KRW" ? "₩" : currency === "USD" ? "$" : `${currency} `;
}
export function money(amount: number, currency: string): string {
  return `${sym(currency)}${Math.round(amount).toLocaleString()}`;
}

/** "2026-07" → "Jul 2026". 실적 KPI·기초잔고 기준일처럼 기간을 밝혀야 할 때 쓴다. */
export function monthLabel(ym: string): string {
  const [y, m] = (ym || "").split("-").map(Number);
  if (!y || !m) return ym || "";
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

/** 로컬 기준 오늘 — toISOString(UTC)은 KST 아침에 하루 전으로 밀린다. */
export const localDayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** 기간 선택기의 월 이름 — 화면이 영문이라 브라우저 로캘을 타지 않게 직접 적는다. */
export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 고를 수 있는 시작 연도 — 지난 5년부터 다음 2년까지(예정은 그보다 멀리 잡히지 않는다). */
export function startYears(): number[] {
  const y = new Date().getFullYear();
  return Array.from({ length: 8 }, (_, i) => y - 5 + i);
}

/** "2026-07" → ["2026-07-01", "2026-07-31"]. */
export function monthBounds(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return [`${ym}-01`, `${ym}-${String(last).padStart(2, "0")}`];
}

export function KpiTile({ label, main, sub, tone }: {
  label: string;
  main: React.ReactNode;
  sub?: string;
  tone: "blue" | "red" | "amber" | "green";
}) {
  return (
    <div className={`fin-kpi fin-kpi--${tone}`}>
      <div className="fin-kpi-label">{label}</div>
      <div className="fin-kpi-main">{main}</div>
      {sub ? <div className="fin-kpi-sub">{sub}</div> : null}
    </div>
  );
}

/**
 * 프로젝트 문서번호 → 그 프로젝트의 9단계(AR/AP 작업 화면) 링크.
 * 수금(AR)·매입청구(AP) 행은 여기서 편집할 수 없고 프로젝트 단계에서 관리하므로,
 * 번호를 눌러 그 자리로 바로 갈 수 있어야 한다. 오더 id 로 딥링크하면 목록이
 * rfq_id 를 찾아 팝업을 열어 준다(ProjectsScreen 의 ?order= 처리).
 */
export function ProjectDocLink({
  orderId,
  rfqId,
  label,
  hint,
  apPoId,
}: {
  orderId?: number;
  /** 이 문서가 속한 프로젝트(RFQ). 목록에서 프로젝트를 찾는 기준값 — order_id 보다 우선. */
  rfqId?: number;
  label?: string;
  /** 표 우측의 안내 문구 자리 — 링크를 못 걸 때 옅은 안내 문구로 남긴다. */
  hint?: boolean;
  /** 지급(AP) 행 전용 — AP 탭 + 이 벤더 P/O 가 선택된 상태로 연다. */
  apPoId?: number;
}) {
  const text = label || "—";
  // 프로젝트를 특정할 수 없는 행(오더·프로젝트 연결 없음)은 링크 없이 원래 표기로 둔다.
  if (!orderId && !rfqId) return hint ? <span className="hint-inline">{text}</span> : <>{text}</>;
  // rfq 와 order 를 함께 넘긴다 — rfq 로 프로젝트를 찾고, order 로 그 프로젝트 안에서
  // 이 문서의 고객 P/O 를 고른다. (한 프로젝트에 P/O 가 여러 건일 수 있다.)
  // 지급(AP) 행은 11단계(Payment Completed)로 연다 — 지급 확인 칸이 붙어 있는 단계라,
  // 목록에서 누르면 바로 그 칸이 보인다. 수입(AR) 행은 청구서를 편집하는 9단계 그대로.
  const params = [
    rfqId ? `rfq=${rfqId}` : "",
    orderId ? `order=${orderId}` : "",
    apPoId ? "stage=11" : "stage=9",
    apPoId ? `ap=${apPoId}` : "",
  ].filter(Boolean).join("&");
  return (
    <Link
      className={`fin-doc-link${hint ? " hint" : ""}`}
      href={`/project?${params}`}
      title={apPoId ? "Open this vendor bill · stage 11 Payable (AP)" : "Open this project's billing · AR/AP stage"}
    >
      {text}
    </Link>
  );
}
