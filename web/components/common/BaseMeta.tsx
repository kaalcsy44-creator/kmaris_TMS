import { tr } from "@/lib/labels";

/** 모달 제목 옆에 붙는 Project No. 칩. 단계별 팝업 제목 공통 표기. */
export function ProjectChip({ no }: { no?: string }) {
  return <span className="modal-proj-chip">Project No. {no || "—"}</span>;
}

/** 단계 팝업 제목 = 단계명 + Project No. 칩. */
export function ModalTitle({ label, projectNo }: { label: string; projectNo?: string }) {
  return (
    <span className="modal-title-row">
      <span>{label}</span>
      <ProjectChip no={projectNo} />
    </span>
  );
}

/** 모든 상세 팝업이 공통으로 표시하는 거래 기본정보 필드. */
export type BaseMetaInfo = {
  project_no?: string;
  first_rfq_at?: string;
  customer?: string;
  vessel?: string;
  work_type?: string;
  trade_type?: string;
  project_title?: string;
};

/** "YYYY-MM-DDTHH:MM" → "yy-mm-dd HH:MM" (표시용). 빈값이면 "". */
function fmtAt(iso?: string): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return iso;
  const [, y, mo, d, h, mi] = m;
  return `${y.slice(2)}-${mo}-${d} ${h}:${mi}`;
}

/**
 * 상세 팝업 공통 기본정보 행들. `<dl className="intl-meta">` 안에 넣어 쓴다.
 * 값이 없는 항목은 "—" 로 표기하되, 거래구분(trade)·선박은 값이 있을 때만 노출.
 */
export default function BaseMetaRows({ info }: { info: BaseMetaInfo }) {
  return (
    <>
      <div>
        <dt>Project No.</dt>
        <dd>{info.project_no || "—"}</dd>
      </div>
      <div>
        <dt>First RFQ at</dt>
        <dd>{fmtAt(info.first_rfq_at) || "—"}</dd>
      </div>
      <div>
        <dt>Customer</dt>
        <dd>{info.customer || "—"}</dd>
      </div>
      <div>
        <dt>Vessel</dt>
        <dd>{info.vessel || "—"}</dd>
      </div>
      <div>
        <dt>Project</dt>
        <dd>{info.project_title || "—"}</dd>
      </div>
      <div>
        <dt>Type</dt>
        <dd>{info.work_type ? tr(info.work_type) : "—"}</dd>
      </div>
      {info.trade_type ? (
        <div>
          <dt>Trade</dt>
          <dd>{tr(info.trade_type)}</dd>
        </div>
      ) : null}
    </>
  );
}
