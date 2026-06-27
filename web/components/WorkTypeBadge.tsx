// Work-type badge (Parts/Service), color-coded for quick scanning.
import { tr } from "@/lib/labels";

export default function WorkTypeBadge({ type }: { type?: string }) {
  const t = type || "부품공급";
  const cls = t === "서비스" ? "wt-badge service" : "wt-badge parts";
  return <span className={cls}>{tr(t)}</span>;
}
