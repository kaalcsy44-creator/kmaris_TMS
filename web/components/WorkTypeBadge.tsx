// 업무 타입(부품공급/서비스) 배지. 색상으로 한눈에 구분한다.
export default function WorkTypeBadge({ type }: { type?: string }) {
  const t = type || "부품공급";
  const cls = t === "서비스" ? "wt-badge service" : "wt-badge parts";
  return <span className={cls}>{t}</span>;
}
