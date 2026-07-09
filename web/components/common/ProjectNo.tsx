"use client";

// 프로젝트 관리번호(예: "P-004(260622)")를 두 조각으로 나눠 표시한다:
//  · 앞부분(P-004)  → 진하고 크게(.proj-no-main)
//  · 괄호 날짜((260622)) → 비볼드 + 프로젝트 번호보다 1px 작게(.proj-no-date)
// 값이 없으면 "—". 목록·상세·보드 등 번호를 노출하는 모든 곳에서 공용으로 쓴다.
export default function ProjectNo({ value }: { value?: string | null }) {
  const v = (value || "").trim();
  if (!v) return <span className="muted">—</span>;
  const i = v.indexOf("(");
  const main = i >= 0 ? v.slice(0, i).trim() : v;
  const date = i >= 0 ? v.slice(i) : "";
  return (
    <span className="proj-no">
      <span className="proj-no-main">{main}</span>
      {date ? <span className="proj-no-date">{date}</span> : null}
    </span>
  );
}
