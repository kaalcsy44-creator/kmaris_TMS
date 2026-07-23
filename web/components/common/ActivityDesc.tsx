"use client";

import type { Activity } from "@/lib/activity";

// 활동 1건의 설명 — 자동 단계 이벤트(라벨·party·PIC) / 노트(텍스트·메타·PIC) / 종결 사유.
// auto 배지는 거의 모든 행에 붙어 변별력이 없어 달지 않는다. closed 는 드물어 유지.
// 날짜는 호출부가 각자 배치하므로 여기선 설명만 렌더한다.
// metaBlock: 상대·채널·담당자를 내용 아래 줄로 내린다(개요 타임라인용). 기본은 인라인.
// hideStar: ★ 접두 표시를 생략한다 — 별도의 별표 토글 버튼이 있는 곳(개요 노트 편집)에서
//           같은 별이 두 번 보이지 않게 한다.
export default function ActivityDesc({
  act,
  metaBlock,
  hideStar,
}: {
  act: Activity;
  metaBlock?: boolean;
  hideStar?: boolean;
}) {
  if (act.kind === "auto") {
    return (
      <>
        {act.label}
        {act.party ? <span className="act-meta"> · {act.party}</span> : null}
        {act.pic ? <span className="act-note-pic">{act.pic}</span> : null}
      </>
    );
  }
  if (act.kind === "close") {
    return (
      <>
        <span className="act-tag close">closed</span> {act.reason || "Closed"}
      </>
    );
  }
  const n = act.note;
  const dl = n.direction === "in" ? "from" : n.direction === "out" ? "to" : "";
  const who = [dl, n.party].filter(Boolean).join(" ");
  const parts = [who, n.person, n.channel].filter(Boolean);
  if (metaBlock) {
    // 내용 뒤에 줄바꿔서 상대·채널·담당자를 배치한다(선행 불릿 없이).
    return (
      <>
        {n.star && !hideStar ? <span className="act-drow-star">★</span> : null}
        {n.text}
        {parts.length || n.pic ? (
          <span className="act-metaline">
            {parts.length ? <span className="act-meta">{parts.join(" · ")}</span> : null}
            {n.pic ? <span className="act-note-pic">{n.pic}</span> : null}
          </span>
        ) : null}
      </>
    );
  }
  return (
    <>
      {n.star && !hideStar ? <span className="act-drow-star">★</span> : null}
      {n.text}
      {parts.length ? <span className="act-meta"> · {parts.join(" · ")}</span> : null}
      {n.pic ? <span className="act-note-pic">{n.pic}</span> : null}
    </>
  );
}
