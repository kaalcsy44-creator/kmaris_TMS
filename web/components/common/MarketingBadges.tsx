"use client";

import { useEffect, useState } from "react";
import { fetchMarketingReplyMail, type MarketingReplyMail } from "@/lib/api";
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

/** 편집창에 붙는 답장 원문 — 기계가 고른 분류가 맞는지 눈으로 확인하는 자리.
 *  메일함에서 찾아 붙인 것이 없으면 아무것도 그리지 않는다. */
export function ReplyMailPanel({ rowId }: { rowId: number }) {
  const [mail, setMail] = useState<MarketingReplyMail | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchMarketingReplyMail(rowId)
      .then((m) => alive && setMail(m))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : "Could not load the reply"));
    return () => {
      alive = false;
    };
  }, [rowId]);

  if (err) return <span className="hint-inline">{err}</span>;
  if (!mail?.found) return null;

  const body = (mail.body || "").trim();
  const preview = open ? body : body.slice(0, 600);
  return (
    <div className="reply-mail">
      <div className="reply-mail-head">
        <b>{mail.subject || "(no subject)"}</b>
        <span className="muted">
          {mail.from_name ? `${mail.from_name} · ` : ""}
          {mail.from_addr} · {(mail.sent_at || "").replace("T", " ")}
        </span>
      </div>
      {mail.attachments?.length ? (
        <div className="reply-mail-files">📎 {mail.attachments.join(", ")}</div>
      ) : null}
      <pre className="reply-mail-body">{preview || "(empty message)"}</pre>
      {body.length > 600 ? (
        <button type="button" className="linklike" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show full message"}
        </button>
      ) : null}
    </div>
  );
}
