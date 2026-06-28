// 모든 단계(1~12 + AR) 목록 표에 공통으로 들어가는 "거래 식별" 컬럼 블록.
// 어느 페이지에서든 같은 순서/형식으로 노출해 규칙성을 준다:
//   First RFQ at · Customer · Vessel · Type ( · Trade)
// 각 화면은 행 타입에 맞는 접근자만 넘기면 된다(클릭 시 상세는 기존대로).
import { ColumnDef } from "./FilterTable";
import { tr } from "@/lib/labels";
import WorkTypeBadge from "@/components/WorkTypeBadge";

/** "YYYY-MM-DDTHH:MM" → "yy-mm-dd HH:MM". 시각 없으면 날짜만. 빈값이면 "". */
export function fmtRfqDateTime(iso: string): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return iso;
  const [, y, mo, d, h, mi] = m;
  return `${y.slice(2)}-${mo}-${d}${h ? ` ${h}:${mi}` : ""}`;
}

/** 모든 표의 좌측 첫 컬럼 — 내부 관리번호(yymmdd-nn) + 그 아래 최초 RFQ 수신 일시(회색).
 *  관리번호 문자열로 정렬 시 곧 수신일시 순(yymmdd 접두)이 된다. */
export function projectNoColumn<T>(a: {
  projectNo: (r: T) => string;
  firstRfqAt: (r: T) => string;
}): ColumnDef<T> {
  return {
    key: "project_no",
    label: "Project No.",
    text: (r) => a.projectNo(r) || "",
    render: (r) => (
      <div className="proj-cell">
        <div className="pn">{a.projectNo(r) || <span className="muted">—</span>}</div>
        {a.firstRfqAt(r) ? <div className="pn-at">{fmtRfqDateTime(a.firstRfqAt(r))}</div> : null}
      </div>
    ),
  };
}

export type IdentityAccessors<T> = {
  customer: (r: T) => string;
  vessel: (r: T) => string;
  /** 업무유형 원문("부품공급"/"서비스"). */
  workType: (r: T) => string;
  /** 거래구분 원문("수출"/"내수"). 주면 Trade 컬럼 추가(오더 존재 단계 5~12). */
  tradeType?: (r: T) => string;
};

/** 공통 식별 컬럼(Customer · Vessel · Type · [Trade]). 최초 RFQ 수신 일시는
 *  projectNoColumn 에서 관리번호 아래에 병기하므로 여기에는 포함하지 않는다. */
export function identityColumns<T>(a: IdentityAccessors<T>): ColumnDef<T>[] {
  const cols: ColumnDef<T>[] = [
    { key: "customer", label: "Customer", filter: "facet", text: (r) => a.customer(r) || "" },
    { key: "vessel", label: "Vessel", filter: "facet", text: (r) => a.vessel(r) || "" },
    {
      key: "work_type",
      label: "Type",
      filter: "facet",
      text: (r) => a.workType(r) || "부품공급",
      render: (r) => <WorkTypeBadge type={a.workType(r)} />,
    },
  ];
  if (a.tradeType) {
    const trade = a.tradeType;
    cols.push({
      key: "trade_type",
      label: "Trade",
      filter: "facet",
      text: (r) => trade(r) || "수출",
      render: (r) => <span className="ar-badge">{tr(trade(r) || "수출")}</span>,
    });
  }
  return cols;
}
