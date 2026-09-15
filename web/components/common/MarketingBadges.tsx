"use client";

import { useEffect, useState } from "react";
import { fetchMarketingThread, type MarketingThread, type MarketingThreadMail } from "@/lib/api";
import { followUpState, replyBadge } from "@/lib/marketing";

/** 목록의 Reply 칸 — 답장 종류를 한 낱말 배지로.
 *  분류가 아직 없고 답장만 찾아 둔 줄은 "Replied?" 로 사람을 부른다. 기계가 고른
 *  값에는 점(·)을 찍어 둔다 — 아직 사람이 확인하지 않은 값이라는 뜻이다. */
export function ReplyBadge({
  status,
  detected = false,
  auto = false,
}: {
  status: string;
  detected?: boolean;
  auto?: boolean;
}) {
  const info = replyBadge(status, detected, auto);
  if (!info) return <span className="muted">—</span>;
  return (
    <span className={`reply-badge ${info.tone}`} title={info.title}>
      {info.label}
      {auto ? <span className="reply-auto-dot" aria-hidden="true" /> : null}
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

/** 편집창에 붙는 대화 — 그 주소와 오간 메일을 시간순으로 전부 세운다.
 *
 *  전에는 답장 한 통만 보여 줬다. 활동이 들고 있는 값이 그 한 통이고(reply_email_id),
 *  자동 분류의 근거로는 그것이면 충분했기 때문이다. 그런데 사람이 이 창을 여는 까닭은
 *  대개 그 다음을 알기 위해서다 — 우리가 뭐라고 답했더라, 그 뒤로 뭐가 왔더라. 그
 *  왕복은 이미 메일함에 담겨 있었고(보낸 메일도 담는다), 화면에만 없었다.
 *
 *  읽기만 하는 자리다. 여기서 활동에 새로 붙이거나 분류를 고치지 않는다 — 분류를
 *  정하는 값은 위의 Reply 칸이고, 그 근거가 된 한 통에는 ★ 표시가 붙는다. */
export function ReplyThreadPanel({ rowId }: { rowId: number }) {
  const [thread, setThread] = useState<MarketingThread | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    fetchMarketingThread(rowId)
      .then((t) => alive && setThread(t))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : "Could not load the conversation"));
    return () => {
      alive = false;
    };
  }, [rowId]);

  if (err) return <span className="hint-inline">{err}</span>;
  if (!thread?.messages?.length) return null;

  const { counts } = thread;
  return (
    <div className="mail-thread">
      <div className="mail-thread-hd">
        <b>Conversation</b>
        <span className="muted">
          {thread.address}
          {" · "}
          {counts.in} in · {counts.out} out
          {thread.since ? ` · since ${thread.since}` : ""}
        </span>
      </div>
      {thread.omitted ? (
        <div className="mail-thread-more">
          {thread.omitted} older message{thread.omitted === 1 ? "" : "s"} not shown
        </div>
      ) : null}
      {thread.messages.map((m) => <ThreadMail key={m.id} mail={m} />)}
    </div>
  );
}

/** 대화 속 한 통. 긴 본문은 접어 둔다 — 답장은 첫 몇 줄이 전부이고 그 아래는 대개
 *  우리가 보낸 원문의 인용이라, 전부 펼쳐 두면 왕복이 몇 번이었는지가 안 보인다. */
function ThreadMail({ mail }: { mail: MarketingThreadMail }) {
  const [open, setOpen] = useState(false);
  const out = mail.direction === "out";
  const body = (mail.body || "").trim();
  const long = body.length > 400;
  const who = out
    ? `To ${mail.to.join(", ") || "—"}`
    : `${mail.from_name ? `${mail.from_name} · ` : ""}${mail.from_addr}`;
  return (
    <div className={`mail-msg ${out ? "is-out" : "is-in"}${mail.detected ? " is-detected" : ""}`}>
      <div className="mail-msg-hd">
        <span className={`mail-dir ${out ? "out" : "in"}`}>{out ? "Sent" : "Received"}</span>
        <span className="mail-when">{(mail.sent_at || "").replace("T", " ")}</span>
        <span className="mail-who">{who}</span>
        {/* 이 한 통이 위 Reply 분류의 근거다 — 어느 메일을 보고 그렇게 찍혔는지
            모르면 사람이 그 분류를 확인할 수가 없다. */}
        {mail.detected ? <span className="mail-detected" title="The reply this activity was classified from">★ classified from this</span> : null}
      </div>
      <div className="mail-msg-subj">{mail.subject || "(no subject)"}</div>
      {mail.attachments?.length ? (
        <div className="reply-mail-files">📎 {mail.attachments.join(", ")}</div>
      ) : null}
      <pre className="reply-mail-body">
        {(open || !long ? body : body.slice(0, 400)) || "(empty message)"}
      </pre>
      {long ? (
        <button type="button" className="linklike" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show full message"}
        </button>
      ) : null}
      {open && mail.truncated ? (
        <span className="hint-inline">Only the beginning of this message is stored.</span>
      ) : null}
    </div>
  );
}
