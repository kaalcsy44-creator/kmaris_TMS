// 홍보 메일에 돌아온 답장의 종류와, 그 종류가 정하는 다음 할 일.
//
// 회사소개 메일은 한 번에 수십 통씩 나가고, 돌아오는 답은 몇 가지로 갈린다 —
// 문의를 바로 보내오거나, 나중에 건수가 생기면 주겠다거나, 부재중 자동응답이
// 다른 담당자를 알려 주거나, 더는 쓰지 않는 주소라고 하거나, 아무 답이 없거나.
// 어느 쪽이냐에 따라 다시 두드릴 시기가 다르므로, 답장을 고르면 후속일
// (Follow-up)까지 함께 정해진다.

export type ReplyStatus = "" | "inquiry" | "later" | "auto_reply" | "invalid" | "no_reply";

export type ReplyMeta = {
  value: Exclude<ReplyStatus, "">;
  /** 편집창 선택지 라벨. */
  label: string;
  /** 목록 배지에 넣는 짧은 이름. */
  short: string;
  /** 선택했을 때 아래에 보여 주는 한 줄 설명(무엇이 따라 일어나는지). */
  hint: string;
  /** 배지 색 구분(globals.css 의 .reply-badge.<tone>). */
  tone: "win" | "warm" | "info" | "bad" | "mute";
  /** 답장일로부터 며칠 뒤에 다시 볼 것인가. null = 후속 없음(주소가 죽었다). */
  followUpDays: number | null;
};

export const REPLY_STATUSES: ReplyMeta[] = [
  {
    value: "inquiry",
    label: "Inquiry received",
    short: "Inquiry",
    hint: "They sent an inquiry — follow up today and open an RFQ.",
    tone: "win",
    followUpDays: 0,
  },
  {
    value: "later",
    label: "Will inquire later",
    short: "Later",
    hint: "No requirement right now — check back in about 3 months.",
    tone: "warm",
    followUpDays: 90,
  },
  {
    value: "auto_reply",
    label: "Auto-reply (out of office)",
    short: "Auto-reply",
    hint: "Out of office — resend to the alternate contact, then check back in a week.",
    tone: "info",
    followUpDays: 7,
  },
  {
    value: "invalid",
    label: "Address no longer in use",
    short: "Invalid",
    hint: "Dead address — flagged as bounced on the customer contact list too. No follow-up.",
    tone: "bad",
    followUpDays: null,
  },
  {
    value: "no_reply",
    label: "No reply",
    short: "No reply",
    hint: "Nothing came back — knock once more in 2 weeks.",
    tone: "mute",
    followUpDays: 14,
  },
];

export function replyMeta(v: string | null | undefined): ReplyMeta | null {
  return REPLY_STATUSES.find((r) => r.value === v) ?? null;
}

/** 답장은 왔지만 기계가 종류를 못 가른 줄 — 사람이 한 번 봐야 한다는 표시. */
export const REPLY_REVIEW_LABEL = "Replied — classify";

/** 목록 필터·검색에 쓰는 셀 텍스트(아무것도 없으면 빈 문자열 → 패싯의 emptyLabel). */
export function replyText(v: string | null | undefined, detected = false): string {
  return replyMeta(v)?.short ?? (detected ? REPLY_REVIEW_LABEL : "");
}

export type ReplyBadgeInfo = { label: string; tone: string; title: string };

/** 목록 배지 한 칸에 들어갈 것 — 분류가 있으면 그 이름, 없고 답장만 왔으면 확인 요청.
 *  기계가 고른 값(auto)은 제목에 그렇다고 밝혀 둔다 — 확인 전의 값이기 때문이다. */
export function replyBadge(
  status: string | null | undefined,
  detected = false,
  auto = false
): ReplyBadgeInfo | null {
  const meta = replyMeta(status);
  if (meta) {
    return {
      label: meta.short,
      tone: meta.tone,
      title: auto ? `${meta.label} — auto-detected from the reply, not yet confirmed` : meta.label,
    };
  }
  if (detected) {
    return {
      label: "Replied?",
      tone: "review",
      title: "A reply arrived but its kind is unclear — open the row and classify it.",
    };
  }
  return null;
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" + n일. 잘못된 날짜면 빈 문자열. */
export function addDays(iso: string, n: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 답장 종류가 정하는 후속일. 답장일(없으면 오늘) 기준. */
export function suggestFollowUp(status: string, replyDate?: string): string {
  const meta = replyMeta(status);
  if (!meta || meta.followUpDays === null) return "";
  const base = /^\d{4}-\d{2}-\d{2}$/.test(replyDate || "") ? (replyDate as string) : todayISO();
  return addDays(base, meta.followUpDays);
}

export type FollowUpState = {
  /** 배지 문구: "Overdue 3d" · "Today" · "D-5". */
  label: string;
  tone: "overdue" | "today" | "soon" | "later";
  days: number; // 남은 일수(음수 = 지났다)
};

/** 후속일이 지금 어떤 상태인지 — 목록의 Follow-up 칸 배지에 쓴다. */
export function followUpState(date: string, base?: string): FollowUpState | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return null;
  const t = base || todayISO();
  const days = Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${t}T00:00:00Z`)) / 86400000
  );
  if (Number.isNaN(days)) return null;
  if (days < 0) return { label: `Overdue ${-days}d`, tone: "overdue", days };
  if (days === 0) return { label: "Today", tone: "today", days };
  return { label: `D-${days}`, tone: days <= 7 ? "soon" : "later", days };
}
