"use client";

import { useCallback, useEffect, useState } from "react";
import {
  assignMail,
  autoMatchMail,
  fetchMailStatus,
  fetchUnmatchedMail,
  markMailNotDeal,
  syncMail,
} from "@/lib/api";
import type { MailMessage, MailStatus, UnmatchedMailGroup } from "@/lib/types";
import { hm, md } from "@/lib/activity";
import { isAdmin } from "@/lib/auth";
import ProjectPicker, { type ProjectPickOption } from "@/components/common/ProjectPicker";
import PartyName from "@/components/common/PartyName";
import UnknownAddressPanel from "@/components/common/UnknownAddressPanel";

// 메일 정리함 — 메일함에서 가져왔지만 아직 딜에 자리 잡지 못한 것들.
//
// 함은 셋이고, 하나의 깔때기를 앞에서부터 뒤로 나눈 것이다.
//   Unmatched    — 담겼는데 어느 딜인지 못 정한 대화(기본).
//   Not deal     — 딜이 있을 수 없어 내려 둔 대화(회사 소개·인사·자동회신).
//   Unregistered — 상대가 등록되지 않아 **한 통도 담기지 않은** 주소(admin 전용).
// 셋을 한 화면에 둔 이유: 같은 물음("이 메일은 어디로 가나")의 단계만 다른데, 갈라
// 놓으면 메일함 한 번 비우려고 두 메뉴를 오가야 한다. 연결 상태(계정·매일 실행·폴더
// 오류)도 여기 있다 — 머리줄의 "last sync" 를 누르면 펼쳐진다(admin). 예전엔 Settings
// › Mailbox 에 따로 있었는데, "왜 안 들어오나"는 바로 이 함을 보다가 드는 물음이라
// 설정 화면까지 갔다 오게 할 까닭이 없었다.
// Unregistered 는 회사 메일함 전체의 상대 주소가 드러나는 자리라 admin 에게만 연다.
//
// 아래는 그중 첫 함(미분류)의 이야기다.
//
// 다루는 단위는 '한 통'이 아니라 '한 대화'다. 같은 제목의 회신이 열 통씩 쌓이는데
// 판단은 어차피 한 번이라 — 한 줄에서 딜을 고르면 그 대화 전체가 함께 옮겨간다.
// 서버는 근거(같은 대화·문서번호·같은 제목)가 분명한 것은 Auto-match 로 스스로
// 붙이고, 근거가 모자란 대화에는 추천 딜만 달아 둔다(붙이지는 않는다) — 추측으로
// 붙은 이력은 비어 있는 것보다 나쁘기 때문이다. 확정은 사람이 한 번 누른다.
// 화면 문구는 나머지 화면과 같이 영문으로 쓴다(주석만 국문).
export type MailQueue = "unmatched" | "filed" | "unknown";

export default function UnmatchedMailPanel({
  projects,
  initialQueue = "unmatched",
  initialConn = false,
}: {
  /** 배정 대상 목록(최근 딜이 위). 번호만으로는 고르기 어려워 고객·프로젝트명·선박까지 함께 넘긴다. */
  projects: ProjectPickOption[];
  /** 처음 열 함 — 주소(?queue=unknown)로 들어온 링크가 곧장 그 함을 편다. */
  initialQueue?: MailQueue;
  /** 연결 상태를 펼친 채로 연다 — 옛 Settings › Mailbox 링크(?conn=1)가 여기로 온다. */
  initialConn?: boolean;
}) {
  const [groups, setGroups] = useState<UnmatchedMailGroup[] | null>(null);
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  // 대화별로 고른 프로젝트(아직 배정 전). 추천이 있으면 그것으로 채워 둔다.
  const [picked, setPicked] = useState<Record<string, number>>({});
  // 펼쳐 놓은 대화 — 안에 어떤 메일이 들어 있는지 확인하고 고를 수 있게.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // 지금 보고 있는 함. 'filed' 는 되돌릴 수 있어야 마음 놓고 내리기 때문에,
  // 'unknown' 은 담기지도 않는 메일이 어디로 사라지는지 보이게 하려고 둔다.
  const [queue, setQueue] = useState<MailQueue>(initialQueue);
  const showFiled = queue === "filed";
  const [filedCount, setFiledCount] = useState(0);
  const admin = isAdmin();
  // 연결 상태 펼침(admin 전용) — 매일 할 일이 아니라 접어 두고, 필요할 때만 연다.
  const [showConn, setShowConn] = useState(initialConn);

  const load = useCallback(async () => {
    try {
      const [list, st] = await Promise.all([
        fetchUnmatchedMail(300, showFiled),
        fetchMailStatus(),
      ]);
      setGroups(list.groups);
      setFiledCount(list.filed);
      setStatus(st);
      setPicked((prev) => {
        const next = { ...prev };
        for (const g of list.groups) {
          if (!next[g.key] && g.suggest) next[g.key] = g.suggest.rfq_id;
        }
        return next;
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load unmatched mail.");
    }
  }, [showFiled]);

  useEffect(() => {
    load();
  }, [load]);

  // admin 이 아닌데 주소로 unknown 함을 열려 한 경우 — 조용히 기본 함으로 돌린다.
  useEffect(() => {
    if (queue === "unknown" && !admin) setQueue("unmatched");
  }, [queue, admin]);

  async function sync() {
    setBusy(true);
    setErr("");
    setNote("");
    try {
      const r = await syncMail();
      setNote(
        `Scanned ${r.scanned} in the mailbox · kept ${r.stored} new · ${r.dup} already stored · `
        + `${r.skipped} unrelated to registered parties`
        + (r.auto_matched ? ` · auto-matched ${r.auto_matched}` : "")
        + (r.summarized ? ` · summarized ${r.summarized}` : "")
        + (r.pending ? ` · ${r.pending} older mails still unread (press Sync again)` : "")
      );
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  }

  async function autoMatch() {
    setBusy(true);
    setErr("");
    setNote("");
    try {
      const r = await autoMatchMail();
      setNote(
        r.total
          ? `Matched ${r.total} automatically — same thread ${r.thread} · document no. ${r.docno} · `
            + `same subject ${r.subject}. ${r.unmatched} still unmatched.`
          : `Nothing left with hard evidence to match — pick a deal for the remaining ${r.unmatched} below.`
      );
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Auto-match failed");
    } finally {
      setBusy(false);
    }
  }

  async function assign(g: UnmatchedMailGroup) {
    const rfqId = picked[g.key];
    if (!rfqId) return;
    setBusy(true);
    setErr("");
    try {
      const r = await assignMail(g.ids[g.ids.length - 1], rfqId, true, g.ids);
      setNote(
        `Moved ${r.updated} mails to this deal (the whole conversation).`
        + (r.spread ? ` ${r.spread} more followed on the same evidence.` : "")
      );
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Assign failed");
    } finally {
      setBusy(false);
    }
  }

  // 딜에 붙일 수 없는 대화(회사 소개·인사·자동회신)를 함에서 내린다. 지우지 않는다.
  async function notDeal(g: UnmatchedMailGroup, value: boolean) {
    setBusy(true);
    setErr("");
    try {
      const r = await markMailNotDeal(g.ids, value);
      setNote(
        value
          ? `Filed ${r.updated} mails as not deal-related. ${r.unmatched} still unmatched.`
          : `Put ${r.updated} mails back in the unmatched list.`
      );
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not file this conversation");
    } finally {
      setBusy(false);
    }
  }

  const total = groups?.reduce((n, g) => n + g.count, 0) ?? 0;
  const unknownCount = status?.unknown ?? 0;

  return (
    <div className="umail">
      <div className="umail-head">
        <span className="act-count">
          {queue === "unknown" ? (
            <>
              unregistered counterparts · {unknownCount}
              <span className="umail-total"> · none of their mail is stored</span>
            </>
          ) : (
            <>
              {showFiled ? "not deal-related · " : "unmatched mail · "}
              {showFiled ? total : status?.unmatched ?? total}
              {status && !showFiled ? <span className="umail-total"> / {status.total} stored</span> : null}
              {groups ? <span className="umail-total"> · {groups.length} conversations</span> : null}
            </>
          )}
        </span>
        <div className="umail-actions">
          {status && !status.configured ? (
            <span className="hint-inline">
              The mailbox is not connected — set IMAP_USER · IMAP_PASSWORD on the server.
            </span>
          ) : admin ? (
            <button
              type="button"
              className={`hint-inline umail-conn-toggle${showConn ? " on" : ""}`}
              title="Show the mailbox connection — daily run, last runs, folder errors"
              onClick={() => setShowConn((v) => !v)}
            >
              {status?.account}
              {lastSync(status) ? ` · last sync ${lastSync(status)}` : ""}
              <span className="umail-caret">{showConn ? "▾" : "▸"}</span>
            </button>
          ) : (
            <span className="hint-inline">
              {status?.account}
              {lastSync(status) ? ` · last sync ${lastSync(status)}` : ""}
            </span>
          )}
          {/* 함 고르기. 셋을 한 줄에 두면 "무엇이 얼마나 남았나"가 한눈에 보이고,
              내려 둔 대화도 등록 안 된 상대도 되돌릴 수 있는 것이 된다. */}
          <div className="umail-queues" role="tablist">
            <button
              className={`btn sm${queue === "unmatched" ? " primary" : ""}`}
              disabled={busy}
              title="Conversations we have but could not file under a deal"
              onClick={() => setQueue("unmatched")}
            >
              Unmatched{status ? ` (${status.unmatched})` : ""}
            </button>
            {filedCount > 0 || showFiled ? (
              <button
                className={`btn sm${showFiled ? " primary" : ""}`}
                disabled={busy}
                title="Conversations filed as not deal-related"
                onClick={() => setQueue("filed")}
              >
                Not deal-related ({filedCount})
              </button>
            ) : null}
            {/* 회사 메일함 전체의 상대 주소가 드러나는 자리 — admin 에게만 연다. */}
            {admin ? (
              <button
                className={`btn sm${queue === "unknown" ? " primary" : ""}`}
                disabled={busy}
                title="Addresses we exchanged mail with that are registered nowhere — none of it is stored"
                onClick={() => setQueue("unknown")}
              >
                Unregistered ({unknownCount})
              </button>
            ) : null}
          </div>
          <button
            className="btn sm"
            disabled={busy || !groups?.length || queue !== "unmatched"}
            title="File every mail whose deal is a matter of record — same thread, deal document number, or the same subject."
            onClick={autoMatch}
          >
            ✨ Auto-match
          </button>
          {/* 아침 자동 실행이 돌고 있으면 누르게 두지 않는다 — 눌러도 거절만 당한다. */}
          <button
            className="btn sm"
            disabled={busy || status?.configured === false || !!status?.auto.running_since}
            onClick={sync}
          >
            {busy || status?.auto.running_since ? "Fetching…" : "↻ Sync"}
          </button>
        </div>
      </div>
      {admin && status && (showConn || !status.configured) ? (
        <MailboxConnection status={status} onRefresh={load} />
      ) : null}
      {err ? <div className="action-err">{err}</div> : null}
      {note ? <div className="action-ok">{note}</div> : null}
      {syncErrors(status).map((e) => (
        <div key={e} className="action-err">{e}</div>
      ))}

      {queue === "unknown" ? (
        // 등록되지 않은 상대 — 담기지도 않은 메일이라 표 모양이 아주 다르다(대화가
        // 아니라 주소 단위). 같은 함 줄 아래에 두되 그리는 일은 따로 맡긴다.
        <UnknownAddressPanel projects={projects} onChanged={load} />
      ) : !groups ? (
        <div className="state">Loading…</div>
      ) : groups.length === 0 ? (
        <p className="mail-empty">
          {showFiled
            ? "Nothing filed as not deal-related."
            : "No unmatched mail — every mail we fetched is filed under a deal."}
        </p>
      ) : (
        <table className="mini wide umail-table">
          <thead>
            <tr>
              <th className="umail-c-when">When</th>
              <th className="umail-c-party">Counterpart</th>
              <th>Conversation</th>
              <th className="umail-c-assign">Assign to project</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.key}>
                <td className="umail-c-when">
                  {when(g.last_at)}
                  {g.count > 1 && g.first_at !== g.last_at ? (
                    <div className="umail-since">since {md(g.first_at)}</div>
                  ) : null}
                </td>
                <td className="umail-c-party">
                  {/* 상대가 여럿인 대화(전달·참조)는 한 줄에 늘어놓지 않고 쌓는다 —
                      가로로 늘어나면 그만큼 대화 칸이 오른쪽으로 밀린다. */}
                  <div className="umail-parties">
                    {g.parties.length === 0 ? <PartyName name="" /> : null}
                    {g.parties.map((p, i) => (
                      <PartyName key={p} name={p} kind={i === 0 ? g.party_kind : undefined} />
                    ))}
                  </div>
                </td>
                <td>
                  <button
                    type="button"
                    className="umail-subject as-link"
                    onClick={() => setOpen((o) => ({ ...o, [g.key]: !o[g.key] }))}
                    title="Show the mails in this conversation"
                  >
                    {g.subject}
                    {g.count > 1 ? <span className="umail-count">{g.count} mails</span> : null}
                    <span className="umail-caret">{open[g.key] ? "▾" : "▸"}</span>
                  </button>
                  {open[g.key] ? (
                    <ul className="umail-msgs">
                      {g.messages.map((m) => (
                        <li key={m.id}>
                          <span className="mail-dir">{m.direction === "out" ? "→" : "←"}</span>
                          <span className="umail-msg-when">{when(m.sent_at)}</span>
                          <span className="umail-msg-subj">{m.subject || "(no subject)"}</span>
                          <span className="umail-sum">{m.summary || snippet(m)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="umail-sum">
                      {g.messages[g.messages.length - 1].summary || snippet(g.messages[g.messages.length - 1])}
                    </div>
                  )}
                </td>
                <td className="umail-c-assign">
                  {showFiled ? (
                    <button className="btn sm" disabled={busy} onClick={() => notDeal(g, false)}>
                      ↩ Put back
                    </button>
                  ) : (
                    <>
                      <ProjectPicker
                        value={picked[g.key] ?? ""}
                        options={projects}
                        onChange={(id) =>
                          setPicked((p) => ({ ...p, [g.key]: id === "" ? 0 : id }))
                        }
                      />
                      <button
                        className="btn sm primary"
                        disabled={busy || !picked[g.key]}
                        onClick={() => assign(g)}
                      >
                        Assign
                      </button>
                      {/* 딜이 있을 수 없는 대화 — 회사 소개·인사·자동회신. 내려 두지
                          않으면 아무리 눌러도 줄지 않는 목록이 되어 함이 방치된다. */}
                      <button
                        className="btn sm umail-notdeal"
                        disabled={busy}
                        title="No deal to file this under — introductions, greetings, auto-replies"
                        onClick={() => notDeal(g, true)}
                      >
                        Not a deal
                      </button>
                      {/* 추천은 골라만 두고 붙이지 않는다 — 왜 그 딜인지 근거를 함께 보여 준다. */}
                      {g.suggest && picked[g.key] === g.suggest.rfq_id ? (
                        <div className="umail-why" title={g.suggest.why}>Suggested · {g.suggest.why}</div>
                      ) : null}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* 메일함 연결 상태 — 어느 계정을 언제 읽는지, 마지막 자동 실행·수동 Sync 가 무엇을
   했는지. 폴더 오류는 펼치지 않아도 머리줄 아래 늘 보인다(여기선 되풀이하지 않는다). */
function MailboxConnection({ status, onRefresh }: { status: MailStatus; onRefresh: () => void }) {
  const auto = status.auto;
  const last = auto.last_result || {};
  const resultParts = (r: Record<string, number | string>) =>
    Object.entries(r || {})
      .filter(([k, v]) => k !== "at" && k !== "error" && k !== "ok" && v)
      .map(([k, v]) => `${k} ${v}`);
  const lastParts = resultParts(last);
  const manual = status.manual || { last_at: "", last_result: {} };
  const manualParts = resultParts(manual.last_result);

  return (
    <div className="umail-conn">
      {!status.configured ? (
        <p className="hint-inline" style={{ display: "block", marginBottom: 8 }}>
          The mailbox is not connected. Set <b>IMAP_USER</b> and <b>IMAP_PASSWORD</b> on the
          server (they fall back to SMTP_USER / SMTP_PASSWORD), then press Sync.
        </p>
      ) : null}
      <table className="mini wide kv-table">
        <tbody>
          <tr>
            <th>Account</th>
            <td>{status.account || "—"} <span className="muted">@ {status.host}</span></td>
          </tr>
          <tr>
            <th>Stored mail</th>
            <td>{status.total} kept · {status.unmatched} unmatched · {status.unknown} unregistered counterparts</td>
          </tr>
          <tr>
            <th>Daily run</th>
            <td>
              {auto.enabled ? (
                <>
                  every day at <b>{auto.at}</b> KST
                  {auto.next_run ? <span className="muted"> · next {auto.next_run}</span> : null}
                </>
              ) : (
                <span className="muted">off (MAIL_AUTO_SYNC=0)</span>
              )}
            </td>
          </tr>
          {/* 아침 자동 실행과 사람이 누른 Sync 를 한 줄에 섞지 않는다 — 섞으면 Sync 를
              눌러도 값이 그대로라 아무 일도 안 일어난 것처럼 보인다. */}
          <tr>
            <th>Last daily run</th>
            <td>
              {auto.running_since ? (
                <>
                  <b>running now — started {auto.running_since}</b>{" "}
                  <button type="button" className="as-link" onClick={onRefresh}>Refresh</button>
                </>
              ) : auto.last_run_at ? (
                <>
                  {auto.last_run_at}
                  {lastParts.length ? <span className="muted"> · {lastParts.join(" · ")}</span> : null}
                  {last.error ? <div className="action-err">{String(last.error)}</div> : null}
                </>
              ) : (
                <span className="muted">has not run yet</span>
              )}
            </td>
          </tr>
          <tr>
            <th>Last manual sync</th>
            <td>
              {manual.last_at ? (
                <>
                  {manual.last_at}
                  {manualParts.length ? <span className="muted"> · {manualParts.join(" · ")}</span> : null}
                  {/* 수동 Sync 는 카드 요약을 만들지 않는다 — 브리핑 요약이 비어 있을 때
                      "동기화는 됐는데 요약이 없구나"를 여기서 알 수 있어야 한다. */}
                  <span className="muted"> · digests are written by the daily run</span>
                </>
              ) : (
                <span className="muted">not pressed yet</span>
              )}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function lastSync(status: MailStatus | null): string {
  const times = (status?.folders ?? []).map((f) => f.last_synced_at).filter(Boolean);
  if (!times.length) return "";
  return times.reduce((a, b) => (a > b ? a : b)).replace("T", " ").slice(0, 16);
}

function syncErrors(status: MailStatus | null): string[] {
  return (status?.folders ?? [])
    .filter((f) => f.last_error)
    .map((f) => `${f.folder}: ${f.last_error}`);
}

function when(iso: string): string {
  const t = hm(iso);
  return t ? `${md(iso)} ${t}` : md(iso) || "—";
}

function snippet(msg: MailMessage): string {
  const body = (msg.body_text || "").replace(/\s+/g, " ").trim();
  return body ? `${body.slice(0, 140)}${body.length > 140 ? "…" : ""}` : "(no body)";
}
