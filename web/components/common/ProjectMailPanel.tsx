"use client";

import { useCallback, useEffect, useState } from "react";
import {
  buildProjectMailRollup,
  fetchMailStatus,
  fetchProjectMail,
  syncMail,
} from "@/lib/api";
import type { MailMessage, MailThread, ProjectMail } from "@/lib/types";
import { hm, md } from "@/lib/activity";
import PartyName from "@/components/common/PartyName";

// 프로젝트 메일 이력 — 이 딜에서 고객·벤더와 오간 메일을 대화(스레드) 단위로 보여준다.
// 메일 본체는 회사 메일함에 있고 여기 있는 건 사본이므로, 화면의 일은 세 가지다:
//   (1) 언제 누구와 무엇이 오갔는지 시간순으로 읽히게 하고
//   (2) 한 통 한 통의 용건을 요약 한 줄로 먼저 보여주고(원문은 접어 둔다)
//   (3) 딜 전체 흐름을 몇 줄로 갈무리해 "지금 공이 누구에게 있는지"를 알려 준다.
// 화면 문구는 나머지 화면과 같이 영문으로 쓴다(주석만 국문).
export default function ProjectMailPanel({ rfqId }: { rfqId: number }) {
  const [data, setData] = useState<ProjectMail | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState("");   // 진행 중 작업 이름(버튼 비활성 + 안내)
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");   // 마지막 Sync 결과 한 줄
  const [statusNote, setStatusNote] = useState("");  // 미분류 안내(있을 때만)
  const [open, setOpen] = useState<string[]>([]);   // 펼친 스레드 키

  const load = useCallback(async () => {
    try {
      setData(await fetchProjectMail(rfqId));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load mail.");
    }
  }, [rfqId]);

  useEffect(() => {
    load();
    fetchMailStatus()
      .then((st) => setConfigured(st.configured))
      .catch(() => setConfigured(false));
  }, [load]);

  async function run(name: string, label: string, fn: () => Promise<unknown>) {
    setBusy(name);
    setErr("");
    try {
      await fn();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : `${label} failed`);
    } finally {
      setBusy("");
    }
  }

  // Sync 는 결과를 말해 줘야 한다 — 이 딜에 아무것도 안 붙었을 때, 메일함을 못 읽은
  // 것인지 / 거래처와 오간 메일이 없던 것인지 / 다른 딜로 갔는지가 갈리기 때문이다.
  async function sync() {
    setBusy("sync");
    setErr("");
    setNote("");
    try {
      const r = await syncMail();
      const before = data?.count ?? 0;
      const after = await fetchProjectMail(rfqId);
      setData(after);
      const gained = after.count - before;
      const parts = [`Scanned ${r.scanned} in the mailbox`];
      if (r.stored) parts.push(`kept ${r.stored} new`);
      if (r.dup) parts.push(`${r.dup} already stored`);
      if (r.skipped) parts.push(`${r.skipped} unrelated to registered parties`);
      if (r.auto_matched) parts.push(`auto-matched ${r.auto_matched}`);
      if (r.pending) parts.push(`${r.pending} older mails still unread — press Sync again`);
      parts.push(gained > 0 ? `${gained} linked to this deal` : "no new mail for this deal");
      setNote(parts.join(" · "));
      const st = await fetchMailStatus().catch(() => null);
      if (st) {
        setStatusNote(
          st.unmatched > 0 && gained === 0
            ? `${st.unmatched} of ${st.total} stored mails are still unmatched — assign them to this deal in Activity → Mail (unmatched).`
            : ""
        );
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setBusy("");
    }
  }

  const threads = data?.threads ?? [];
  const missingSummary = threads.some((t) => t.messages.some((m) => !m.summary));

  return (
    <section className="proj-ov-sec proj-mail">
      <h2 className="proj-ov-h">
        Mail
        <span className="proj-ov-cnt">{data?.count ?? 0}</span>
        <span className="proj-mail-acts">
          <button
            type="button"
            className="btn sm"
            disabled={!!busy || configured === false}
            title={
              configured === false
                ? "Mailbox is not connected — set IMAP_USER / IMAP_PASSWORD."
                : "Fetch new mail from the company mailbox"
            }
            onClick={sync}
          >
            {busy === "sync" ? "Fetching…" : "↻ Sync"}
          </button>
          {missingSummary ? (
            <button
              type="button"
              className="btn sm"
              disabled={!!busy}
              title="Write summaries for the mails that do not have one yet"
              onClick={() => run("summary", "Summarize", () => fetchProjectMail(rfqId, true))}
            >
              {busy === "summary" ? "Summarizing…" : "Fill summaries"}
            </button>
          ) : null}
          {data && data.count > 0 ? (
            <button
              type="button"
              className="btn sm"
              disabled={!!busy}
              title="Sum up how this deal's mail has gone, in 3–5 lines"
              onClick={() => run("digest", "Digest", () => buildProjectMailRollup(rfqId))}
            >
              {busy === "digest" ? "Writing…" : data.rollup ? "Redo digest" : "AI digest"}
            </button>
          ) : null}
        </span>
      </h2>

      {err ? <div className="action-err">{err}</div> : null}
      {note ? <div className="mail-note">{note}</div> : null}
      {statusNote ? <div className="mail-note">{statusNote}</div> : null}

      {data?.rollup ? (
        <div className="mail-rollup">
          {data.rollup_stale ? (
            <span className="mail-stale">New mail has arrived since this digest was written.</span>
          ) : null}
          {data.rollup.split("\n").filter(Boolean).map((line, i) => (
            <p key={i}>{line.replace(/^[-•]\s*/, "")}</p>
          ))}
        </div>
      ) : null}

      {!data ? (
        <p className="mail-empty">Loading…</p>
      ) : threads.length === 0 ? (
        <p className="mail-empty">
          {configured === false
            ? "The mailbox is not connected. Set IMAP_USER · IMAP_PASSWORD on the server and mail exchanged with customers and vendors will collect here."
            : "No mail is linked to this deal yet. Run Sync to read the mailbox, or assign it from the unmatched mail on the Activity screen."}
        </p>
      ) : (
        <ol className="mail-threads">
          {threads.map((t) => (
            <MailThreadRow
              key={t.thread_key}
              thread={t}
              open={open.includes(t.thread_key)}
              onToggle={() =>
                setOpen((prev) =>
                  prev.includes(t.thread_key)
                    ? prev.filter((k) => k !== t.thread_key)
                    : [...prev, t.thread_key]
                )
              }
            />
          ))}
        </ol>
      )}
    </section>
  );
}

// 대화 한 묶음 — 머리줄(상대·제목·통수·마지막 시각)만 보이고, 펼치면 메일이 시간순으로.
function MailThreadRow({
  thread,
  open,
  onToggle,
}: {
  thread: MailThread;
  open: boolean;
  onToggle: () => void;
}) {
  const last = thread.messages[thread.messages.length - 1];
  return (
    <li className={`mail-thread${open ? " open" : ""}`}>
      <button type="button" className="mail-thread-h" onClick={onToggle}>
        <span className="mail-caret" aria-hidden>{open ? "▾" : "▸"}</span>
        <PartyName name={thread.party} kind={thread.party_kind} />
        <span className="mail-subject">{thread.subject || "(no subject)"}</span>
        {thread.count > 1 ? <span className="mail-count">{thread.count} mails</span> : null}
        <span className="mail-when">{when(thread.last_at)}</span>
        <span className="mail-dir" title={last?.direction === "out" ? "Sent" : "Received"}>
          {last?.direction === "out" ? "→" : "←"}
        </span>
      </button>
      {open ? (
        <ol className="mail-msgs">
          {thread.messages.map((m) => (
            <MailRow key={m.id} msg={m} />
          ))}
        </ol>
      ) : (
        // 접힌 상태에서도 마지막 메일 요약 한 줄은 보여준다 — 펼치지 않고도 근황을 안다.
        <p className="mail-peek">{last?.summary || snippet(last)}</p>
      )}
    </li>
  );
}

// 메일 1통 — 방향·시각·상대가 한 줄, 그 아래 요약. 원문은 눌러서 편다.
function MailRow({ msg }: { msg: MailMessage }) {
  const [raw, setRaw] = useState(false);
  return (
    <li className={`mail-msg ${msg.direction}`}>
      <div className="mail-msg-h">
        <span className="mail-dir" title={msg.direction === "out" ? "Sent" : "Received"}>
          {msg.direction === "out" ? "→" : "←"}
        </span>
        <span className="mail-when">{when(msg.sent_at)}</span>
        <span className="mail-who">
          {msg.direction === "out"
            ? `to ${(msg.to_addrs || []).join(", ") || msg.party}`
            : `from ${msg.from_name || msg.from_addr}`}
        </span>
        {msg.attachments.length ? (
          <span className="mail-att" title={msg.attachments.map((a) => a.name).join("\n")}>
            📎 {msg.attachments.length}
          </span>
        ) : null}
        <button type="button" className="mail-raw-btn" onClick={() => setRaw((v) => !v)}>
          {raw ? "Hide original" : "Original"}
        </button>
      </div>
      <p className="mail-sum">{msg.summary || snippet(msg)}</p>
      {raw ? (
        <pre className="mail-raw">
          {msg.body_text || "(no body)"}
          {msg.truncated ? "\n\n… (kept up to here — the full message is in the mailbox)" : ""}
        </pre>
      ) : null}
    </li>
  );
}

/** "2026-08-11T09:30" → "8/11 09:30"(시각이 없으면 날짜만). */
function when(iso: string): string {
  const t = hm(iso);
  return t ? `${md(iso)} ${t}` : md(iso);
}

/** 요약이 아직 없을 때 대신 보여줄 본문 앞머리. */
function snippet(msg: MailMessage | undefined): string {
  const body = (msg?.body_text || "").replace(/\s+/g, " ").trim();
  return body ? `${body.slice(0, 120)}${body.length > 120 ? "…" : ""}` : "(no summary yet)";
}
