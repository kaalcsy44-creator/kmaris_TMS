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

// 프로젝트 메일 이력 — 이 딜에서 고객·벤더와 오간 메일을 대화(스레드) 단위로 보여준다.
// 메일 본체는 회사 메일함에 있고 여기 있는 건 사본이므로, 화면의 일은 세 가지다:
//   (1) 언제 누구와 무엇이 오갔는지 시간순으로 읽히게 하고
//   (2) 한 통 한 통의 용건을 요약 한 줄로 먼저 보여주고(원문은 접어 둔다)
//   (3) 딜 전체 흐름을 몇 줄로 갈무리해 "지금 공이 누구에게 있는지"를 알려 준다.
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
      setErr(e instanceof Error ? e.message : "메일을 불러오지 못했습니다.");
    }
  }, [rfqId]);

  useEffect(() => {
    load();
    fetchMailStatus()
      .then((st) => setConfigured(st.configured))
      .catch(() => setConfigured(false));
  }, [load]);

  async function run(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    setErr("");
    try {
      await fn();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : `${name} 실패`);
    } finally {
      setBusy("");
    }
  }

  // Sync 는 결과를 말해 줘야 한다 — 이 딜에 아무것도 안 붙었을 때, 메일함을 못 읽은
  // 것인지 / 거래처와 오간 메일이 없던 것인지 / 다른 딜로 갔는지가 갈리기 때문이다.
  async function sync() {
    setBusy("동기화");
    setErr("");
    setNote("");
    try {
      const r = await syncMail();
      const before = data?.count ?? 0;
      const after = await fetchProjectMail(rfqId);
      setData(after);
      const gained = after.count - before;
      const parts = [`메일함에서 ${r.scanned}통 확인`];
      if (r.stored) parts.push(`새로 보관 ${r.stored}통`);
      if (r.dup) parts.push(`이미 있던 것 ${r.dup}통`);
      if (r.skipped) parts.push(`등록된 거래처와 무관 ${r.skipped}통`);
      if (r.pending) parts.push(`아직 안 읽은 이전 메일 ${r.pending}통 — Sync 를 더 누르세요`);
      parts.push(gained > 0 ? `이 딜에 ${gained}통 연결` : "이 딜에 붙은 새 메일은 없음");
      setNote(parts.join(" · "));
      const st = await fetchMailStatus().catch(() => null);
      if (st) {
        setStatusNote(
          st.unmatched > 0 && gained === 0
            ? `보관된 메일 ${st.total}통 중 ${st.unmatched}통이 미분류입니다 — Activity → Mail (unmatched) 에서 이 딜로 배정할 수 있습니다.`
            : ""
        );
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "동기화 실패");
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
                ? "메일함이 연결되지 않았습니다 — IMAP_USER/IMAP_PASSWORD 를 설정하세요."
                : "회사 메일함에서 새 메일을 가져옵니다"
            }
            onClick={sync}
          >
            {busy === "동기화" ? "가져오는 중…" : "↻ Sync"}
          </button>
          {missingSummary ? (
            <button
              type="button"
              className="btn sm"
              disabled={!!busy}
              title="아직 요약이 없는 메일의 요약을 만듭니다"
              onClick={() => run("요약", () => fetchProjectMail(rfqId, true))}
            >
              {busy === "요약" ? "요약 중…" : "요약 채우기"}
            </button>
          ) : null}
          {data && data.count > 0 ? (
            <button
              type="button"
              className="btn sm"
              disabled={!!busy}
              title="이 딜의 메일 흐름을 3~5줄로 정리합니다"
              onClick={() => run("정리", () => buildProjectMailRollup(rfqId))}
            >
              {busy === "정리" ? "정리 중…" : data.rollup ? "다시 정리" : "AI 정리"}
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
            <span className="mail-stale">새 메일이 온 뒤라 아래 정리는 그 이전까지입니다.</span>
          ) : null}
          {data.rollup.split("\n").filter(Boolean).map((line, i) => (
            <p key={i}>{line.replace(/^[-•]\s*/, "")}</p>
          ))}
        </div>
      ) : null}

      {!data ? (
        <p className="mail-empty">불러오는 중…</p>
      ) : threads.length === 0 ? (
        <p className="mail-empty">
          {configured === false
            ? "메일함이 연결되지 않았습니다. 서버에 IMAP_USER · IMAP_PASSWORD 를 넣으면 고객·벤더와 오간 메일이 여기에 쌓입니다."
            : "이 딜에 연결된 메일이 아직 없습니다. Sync 로 메일함을 읽거나, Activity 화면의 미분류 메일에서 이 딜로 배정하세요."}
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
        <PartyTag name={thread.party} kind={thread.party_kind} />
        <span className="mail-subject">{thread.subject || "(제목 없음)"}</span>
        {thread.count > 1 ? <span className="mail-count">{thread.count}통</span> : null}
        <span className="mail-when">{when(thread.last_at)}</span>
        <span className="mail-dir" title={last?.direction === "out" ? "발신" : "수신"}>
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
        <span className="mail-dir" title={msg.direction === "out" ? "발신" : "수신"}>
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
          {raw ? "원문 접기" : "원문"}
        </button>
      </div>
      <p className="mail-sum">{msg.summary || snippet(msg)}</p>
      {raw ? (
        <pre className="mail-raw">
          {msg.body_text || "(본문 없음)"}
          {msg.truncated ? "\n\n… (본문이 길어 여기까지만 보관합니다 — 원본은 메일함에 있습니다)" : ""}
        </pre>
      ) : null}
    </li>
  );
}

function PartyTag({ name, kind }: { name: string; kind: string }) {
  return (
    <span className={`mail-party ${kind || "unknown"}`} title={kind === "vendor" ? "Vendor" : kind === "customer" ? "Customer" : ""}>
      {name || "—"}
    </span>
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
  return body ? `${body.slice(0, 120)}${body.length > 120 ? "…" : ""}` : "(요약 없음)";
}
