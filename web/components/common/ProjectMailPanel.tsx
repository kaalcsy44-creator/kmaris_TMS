"use client";

import { useEffect, useMemo, useState } from "react";
import {
  assignMail,
  buildProjectMailRollup,
  fetchMailStatus,
  fetchPipeline,
  fetchProjectMail,
  setProjectMailGroup,
  syncMail,
} from "@/lib/api";
import type { MailMessage, MailThread, ProjectMail } from "@/lib/types";
import { hm, md } from "@/lib/activity";
import { parseRollupLine } from "@/lib/rollup";
import PartyName from "@/components/common/PartyName";
import ProjectPicker, { toPickOptions, type ProjectPickOption } from "@/components/common/ProjectPicker";
import { FoldTitle, useSectionFold } from "@/components/common/SectionFold";
import { invalidateCache, useCachedData } from "@/lib/useCachedData";

/** 이 딜의 메일 캐시 키 — 개요의 단계 보드도 같은 키로 읽어 한 번만 조회한다. */
export const projectMailKey = (rfqId: number) => `mail:project:${rfqId}`;

// 프로젝트 메일 이력 — 이 딜에서 고객·벤더와 오간 메일을 대화(스레드) 단위로 보여준다.
// 메일 본체는 회사 메일함에 있고 여기 있는 건 사본이므로, 화면의 일은 세 가지다:
//   (1) 언제 누구와 무엇이 오갔는지 시간순으로 읽히게 하고
//   (2) 한 통 한 통의 용건을 요약 한 줄로 먼저 보여주고(원문은 접어 둔다)
//   (3) 딜 전체 흐름을 몇 줄로 갈무리해 "지금 공이 누구에게 있는지"를 알려 준다.
// 화면 문구는 나머지 화면과 같이 영문으로 쓴다(주석만 국문).
export default function ProjectMailPanel({ rfqId }: { rfqId: number }) {
  // 단계 보드와 같은 캐시 키를 쓴다 — 한 화면에서 같은 목록을 두 번 받아 올 이유가 없고,
  // 여기서 Sync 를 눌러 새로 고치면 위 보드의 메일 줄도 함께 최신이 된다.
  const { data, error: loadErr, refresh } = useCachedData(projectMailKey(rfqId), () =>
    fetchProjectMail(rfqId));
  const fold = useSectionFold("proj-ov.mail");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState("");   // 진행 중 작업 이름(버튼 비활성 + 안내)
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");   // 마지막 Sync 결과 한 줄
  const [statusNote, setStatusNote] = useState("");  // 미분류 안내(있을 때만)
  const [open, setOpen] = useState<string[]>([]);   // 펼친 스레드 키
  // 메일을 옮길 딜 목록. 개요 화면이 이미 같은 키로 받아 둔 것을 나눠 쓴다(요청이 늘지 않는다).
  const { data: pipeline } = useCachedData("pipeline", () => fetchPipeline());
  const projects = useMemo(() => toPickOptions(pipeline?.rows ?? []), [pipeline]);
  // 지금 옮기려고 펼쳐 둔 줄 — "t:<thread_key>"(대화 전체) 또는 "m:<id>"(한 통).
  const [moveKey, setMoveKey] = useState<string | null>(null);
  // 목록 자체를 접어 둔다. 개요에서 먼저 읽어야 하는 건 위 단계 보드와 AI 정리이고,
  // 메일 목록은 15~40줄로 길어 그 아래 것(품목·금액)을 화면 밖으로 밀어낸다. 근황은
  // 정리 네 줄이 이미 말해 주니, 한 통씩 확인하고 싶을 때만 펼친다.
  const [listOpen, setListOpen] = useState(false);

  useEffect(() => {
    fetchMailStatus()
      .then((st) => setConfigured(st.configured))
      .catch(() => setConfigured(false));
  }, []);

  async function run(name: string, label: string, fn: () => Promise<unknown>) {
    setBusy(name);
    setErr("");
    try {
      await fn();
      await refresh();
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
      const after = await refresh();
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

  // 잘못 붙은 메일을 제자리로 — 다른 딜로 옮기거나(rfqId) 연결을 끊는다(null).
  // 자동 배정은 근거(같은 대화·문서번호·같은 제목)로 붙이는데, 근거가 사람의 판단과
  // 어긋나는 일이 있다. 그때 고칠 자리가 없으면 틀린 이력이 그대로 남는다.
  // 옮긴 뒤에는 메일을 읽는 다른 화면(대시보드 Mail·업무일지·미분류함)의 캐시도 함께
  // 비운다 — 한 통이 두 딜에 동시에 보이면 어느 쪽이 맞는지 알 수 없다.
  async function move(msgId: number, rfqId: number | null, wholeThread: boolean, ids: number[]) {
    setBusy("move");
    setErr("");
    setNote("");
    try {
      const r = await assignMail(msgId, rfqId, wholeThread, ids);
      const n = `${r.updated} mail${r.updated === 1 ? "" : "s"}`;
      if (rfqId) {
        const to = projects.find((p) => p.rfqId === rfqId)?.no || `#${rfqId}`;
        setNote(
          `Moved ${n} to ${to}.`
          + (r.spread ? ` ${r.spread} more followed on the same evidence.` : "")
        );
      } else {
        setNote(
          `Unlinked ${n} — pick a deal for them in Activity › Mail (unmatched).`
          // 한 통만 뗀 경우의 경고. 같은 대화의 나머지가 이 딜에 남아 있으면 그것이
          // 근거가 되어 다음 자동 배정 때 다시 끌려 들어온다.
          + (wholeThread ? "" : " The rest of this conversation stays here, so auto-match may pull it back —"
             + " move it to the right deal instead of unlinking.")
        );
      }
      setMoveKey(null);
      invalidateCache("mail:");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Move failed");
    } finally {
      setBusy("");
    }
  }

  const moveCtl: MoveCtl = {
    openKey: moveKey,
    busy: !!busy,
    projects,
    toggle: (key) => setMoveKey((cur) => (cur === key ? null : key)),
    cancel: () => setMoveKey(null),
    run: move,
  };

  const threads = data?.threads ?? [];
  const missingSummary = threads.some((t) => t.messages.some((m) => !m.summary));
  // 한 문의를 품목·제조사별로 쪼개 세운 형제 딜 — 대화는 하나뿐이라 여기 함께 실린다.
  // 그 사실을 말해 주지 않으면 "왜 다른 딜 얘기가 섞여 있지?"가 된다.
  const sharedWith = data?.shared_with ?? [];

  return (
    <section className={`proj-ov-sec proj-mail${fold.open ? "" : " folded"}`}>
      <h2 className="proj-ov-h">
        <FoldTitle fold={fold} label="mail">
          Mail
          <span className="proj-ov-cnt">{data?.count ?? 0}</span>
        </FoldTitle>
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

      {err || loadErr ? <div className="action-err">{err || loadErr?.message}</div> : null}
      {sharedWith.length ? (
        <div className="mail-note">
          Shared conversation with{" "}
          {sharedWith.map((x) => x.no || `#${x.rfq_id}`).join(" · ")} — these deals were split
          from one customer inquiry, so their mail is listed here too.{" "}
          {/* 잘못 묶였을 때 되돌릴 자리. 묶음은 수신일시가 같다는 근거로 자동으로 서므로,
              사람이 아니라고 말할 수 있어야 한다. */}
          <button
            type="button"
            className="linklike"
            disabled={!!busy}
            title="Show only this deal's own mail"
            onClick={() => run("unshare", "Unshare", () => setProjectMailGroup(rfqId, null))}
          >
            {busy === "unshare" ? "Unsharing…" : "Unshare"}
          </button>
        </div>
      ) : null}
      {note ? <div className="mail-note">{note}</div> : null}
      {statusNote ? <div className="mail-note">{statusNote}</div> : null}

      {data?.rollup ? (
        <div className="mail-rollup">
          {data.rollup_stale ? (
            <span className="mail-stale">New mail has arrived since this digest was written.</span>
          ) : null}
          {/* 라벨(Progress·Issue·Terms·Next)은 Briefing 카드와 같은 규칙으로 떼어
              세운다 — 같은 텍스트가 화면마다 다른 꼴로 나오면 같은 것으로 안 읽힌다. */}
          {data.rollup.split("\n").filter(Boolean).map((line, i) => {
            const p = parseRollupLine(line);
            return p ? (
              <p key={i} className={`mail-rollup-${p.kind}`}>
                <b className="mail-rollup-label">{p.label}</b>
                {p.body}
              </p>
            ) : (
              <p key={i}>{line.replace(/^[-•]\s*/, "")}</p>
            );
          })}
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
        <>
          {/* 목록을 여는 자리. 감추기는 CSS 가 한다(DOM 에는 남긴다) — 종이는 펼칠 수가
              없으니 인쇄물에는 접힌 것도 다 나와야 한다(아래 @media print). */}
          <button
            type="button"
            className={`mail-listtoggle${listOpen ? " on" : ""}`}
            onClick={() => setListOpen((v) => !v)}
            title={listOpen ? "Collapse the mail list" : "Show every mail in this deal"}
          >
            <span className="mail-caret" aria-hidden>{listOpen ? "▾" : "▸"}</span>
            {listOpen
              ? "Hide mail list"
              : `Show ${threads.length} conversation${threads.length === 1 ? "" : "s"}`}
          </button>
          <ol className={`mail-threads${listOpen ? " open" : ""}`}>
            {threads.map((t) => (
              <MailThreadRow
                key={t.thread_key}
                thread={t}
                ctl={moveCtl}
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
        </>
      )}
    </section>
  );
}

// 옮기기 조작을 줄마다 넘기는 묶음 — 상태는 패널 하나가 갖는다(한 번에 한 줄만 편다).
type MoveCtl = {
  openKey: string | null;
  busy: boolean;
  projects: ProjectPickOption[];
  toggle: (key: string) => void;
  cancel: () => void;
  run: (msgId: number, rfqId: number | null, wholeThread: boolean, ids: number[]) => Promise<void>;
};

// 대화 한 묶음 — 머리줄(상대·제목·통수·마지막 시각)만 보이고, 펼치면 메일이 시간순으로.
function MailThreadRow({
  thread,
  ctl,
  open,
  onToggle,
}: {
  thread: MailThread;
  ctl: MoveCtl;
  open: boolean;
  onToggle: () => void;
}) {
  const last = thread.messages[thread.messages.length - 1];
  const key = `t:${thread.thread_key}`;
  const moving = ctl.openKey === key;
  return (
    <li className={`mail-thread${open ? " open" : ""}`}>
      {/* 머리줄 전체가 펼침 버튼이라 옮기기 버튼은 그 바깥에 나란히 둔다(버튼 안의 버튼은 없다). */}
      <div className="mail-thread-hrow">
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
        <button
          type="button"
          className={`mail-move-btn${moving ? " on" : ""}`}
          disabled={ctl.busy}
          title="This conversation belongs to another deal — move it"
          onClick={() => ctl.toggle(key)}
        >
          ↪ Move
        </button>
      </div>
      {moving ? (
        <MailMoveBar
          ctl={ctl}
          label={`Move this conversation (${thread.count} mail${thread.count === 1 ? "" : "s"}) to`}
          hint="One conversation belongs to one deal, so every mail in it moves together."
          onRun={(to) => ctl.run(last.id, to, true, thread.messages.map((m) => m.id))}
        />
      ) : null}
      {open ? (
        <ol className="mail-msgs">
          {thread.messages.map((m) => (
            <MailRow key={m.id} msg={m} ctl={ctl} />
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
function MailRow({ msg, ctl }: { msg: MailMessage; ctl: MoveCtl }) {
  const [raw, setRaw] = useState(false);
  const key = `m:${msg.id}`;
  const moving = ctl.openKey === key;
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
        {/* 한 대화 안에 다른 딜의 메일이 한 통 섞여 들어오는 일이 있다(같은 제목으로
            다른 건을 물어 온 회신). 그 한 통만 떼어 옮긴다. */}
        <button
          type="button"
          className={`mail-move-btn${moving ? " on" : ""}`}
          disabled={ctl.busy}
          title="Move just this mail to another deal"
          onClick={() => ctl.toggle(key)}
        >
          ↪ Move
        </button>
        <button type="button" className="mail-raw-btn" onClick={() => setRaw((v) => !v)}>
          {raw ? "Hide original" : "Original"}
        </button>
      </div>
      {moving ? (
        <MailMoveBar
          ctl={ctl}
          label="Move this mail only to"
          hint="Only this one moves — the rest of the conversation stays in this deal."
          onRun={(to) => ctl.run(msg.id, to, false, [])}
        />
      ) : null}
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

// 옮길 딜을 고르는 줄 — 머리줄 바로 아래에 편다.
//
// 고를 것은 둘이다. Move 는 갈 곳이 분명할 때(대개 이쪽이다), Unassign 은 어느 딜인지
// 아직 모를 때 — 미분류함으로 되돌려 놓고 나중에 정한다. 지우는 문은 두지 않는다:
// 메일은 오간 사실이라 여기서 없앨 것이 아니고, 자리를 잘못 잡았을 뿐이다.
function MailMoveBar({
  ctl,
  label,
  hint,
  onRun,
}: {
  ctl: MoveCtl;
  label: string;
  hint: string;
  onRun: (rfqId: number | null) => void;
}) {
  const [target, setTarget] = useState<number | "">("");
  return (
    <div className="mail-movebar">
      <span className="mail-movebar-l">{label}</span>
      <ProjectPicker
        value={target}
        options={ctl.projects}
        onChange={setTarget}
        disabled={ctl.busy}
        placeholder="— Select deal —"
      />
      <button
        type="button"
        className="btn sm primary"
        disabled={ctl.busy || target === ""}
        onClick={() => onRun(target as number)}
      >
        {ctl.busy ? "Moving…" : "Move"}
      </button>
      <button
        type="button"
        className="btn sm"
        disabled={ctl.busy}
        title="Unlink from this deal and put it back in the unmatched mail box"
        onClick={() => onRun(null)}
      >
        Unassign
      </button>
      <button type="button" className="btn sm" disabled={ctl.busy} onClick={ctl.cancel}>
        Cancel
      </button>
      <p className="mail-movebar-hint">{hint}</p>
    </div>
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
