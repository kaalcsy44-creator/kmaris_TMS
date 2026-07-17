import { redirect } from "next/navigation";

// 프로젝트 개요(읽기 전용) — /project/<rfq_id>. 팀원과 링크로 공유하는 한 장짜리 현황.
// 이 화면은 id 가 있어야 열리는 종속 화면이라 오래도록 메뉴에 넣지 않았는데(착지점이 없어서),
// 색인(/project)이 생기면서 그 착지점이 마련됐다 → 네비의 Projects 아래에 놓는다.
// 진입: Projects 색인 · 진행현황 목록의 ⤢ · 팝업/보드/업무일지 카드 · 전역 검색의 ⤢.
// perm="progress" 필수 — active("projects")는 권한 모듈이 아니라 가드 대상이 아니다.
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/project?rfq=${encodeURIComponent(id)}&view=overview`);
}
