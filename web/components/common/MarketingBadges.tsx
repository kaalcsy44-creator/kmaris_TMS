"use client";

import { followUpState, replyMeta } from "@/lib/marketing";

/** 목록의 Reply 칸 — 답장 종류를 한 낱말 배지로. 미분류는 자리만 비워 둔다. */
export function ReplyBadge({ status }: { status: string }) {
  const meta = replyMeta(status);
  if (!meta) return <span className="muted">—</span>;
  return (
    <span className={`reply-badge ${meta.tone}`} title={meta.label}>
      {meta.short}
    </span>
  );
}

/** 목록의 Follow-up 칸 — 날짜와 함께 "언제인지"를 배지로 붙인다(지났는지·오늘인지). */
export function FollowUpCell({ date }: { date: string }) {
  const st = followUpState(date || "");
  if (!st) return <span className="muted">—</span>;
  return (
    <span className="fu-cell">
      <span>{date.replace(/^\d{2}(\d{2}-)/, "$1")}</span>
      <span className={`fu-badge ${st.tone}`}>{st.label}</span>
    </span>
  );
}
