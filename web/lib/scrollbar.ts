/** 마우스 위치가 그 요소의 스크롤바 위인지 판정한다.
 *  clientWidth/clientHeight 는 스크롤바를 뺀 안쪽 영역이라, 그 밖이면 스크롤바다.
 *
 *  용도 — "빈 배경을 누르면 닫히는" 팝업 오버레이(.pl-modal-backdrop)는 오버레이 자신이
 *  세로 스크롤을 갖는다. 그 스크롤바를 잡아 끌면 mousedown/click 의 target 이 오버레이라
 *  배경 클릭으로 오인되어 창이 닫혀 버린다(= 스크롤바로는 화면을 못 내리고 창만 닫힘).
 *  닫기 판정에서 이 위치를 먼저 걸러 낸다. */
export function isOnScrollbar(el: HTMLElement, clientX: number, clientY: number) {
  const r = el.getBoundingClientRect();
  return (
    clientX >= r.left + el.clientLeft + el.clientWidth ||
    clientY >= r.top + el.clientTop + el.clientHeight
  );
}
