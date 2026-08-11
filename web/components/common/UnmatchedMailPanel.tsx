"use client";

import { useCallback, useEffect, useState } from "react";
import {
  assignMail,
  autoMatchMail,
  fetchMailStatus,
  fetchUnmatchedMail,
  syncMail,
} from "@/lib/api";
import type { MailMessage, MailStatus, UnmatchedMailGroup } from "@/lib/types";
import { hm, md } from "@/lib/activity";
import ProjectPicker, { type ProjectPickOption } from "@/components/common/ProjectPicker";

// 미분류 메일 — 거래처와 오갔지만 어느 딜 것인지 아직 정해지지 않은 메일.
//
// 다루는 단위는 '한 통'이 아니라 '한 대화'다. 같은 제목의 회신이 열 통씩 쌓이는데
// 판단은 어차피 한 번이라 — 한 줄에서 딜을 고르면 그 대화 전체가 함께 옮겨간다.
// 서버는 근거(같은 대화·문서번호·같은 제목)가 분명한 것은 Auto-match 로 스스로
// 붙이고, 근거가 모자란 대화에는 추천 딜만 달아 둔다(붙이지는 않는다) — 추측으로
// 붙은 이력은 비어 있는 것보다 나쁘기 때문이다. 확정은 사람이 한 번 누른다.
// 화면 문구는 나머지 화면과 같이 영문으로 쓴다(주석만 국문).
export default function UnmatchedMailPanel({
  projects,
}: {
  /** 배정 대상 목록(최근 딜이 위). 번호만으로는 고르기 어려워 고객·프로젝트명·선박까지 함께 넘긴다. */
  projects: ProjectPickOption[];
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

  const load = useCallback(async () => {
    try {
      const [list, st] = await Promise.all([fetchUnmatchedMail(300), fetchMailStatus()]);
      setGroups(list.groups);
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
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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

  const total = groups?.reduce((n, g) => n + g.count, 0) ?? 0;

  return (
    <div className="umail">
      <div className="umail-head">
        <span className="act-count">
          unmatched mail · {status?.unmatched ?? total}
          {status ? <span className="umail-total"> / {status.total} stored</span> : null}
          {groups ? <span className="umail-total"> · {groups.length} conversations</span> : null}
        </span>
        <div className="umail-actions">
          {status && !status.configured ? (
            <span className="hint-inline">
              The mailbox is not connected — set IMAP_USER · IMAP_PASSWORD on the server.
            </span>
          ) : (
            <span className="hint-inline">
              {status?.account}
              {lastSync(status) ? ` · last sync ${lastSync(status)}` : ""}
            </span>
          )}
          <button
            className="btn sm"
            disabled={busy || !groups?.length}
            title="File every mail whose deal is a matter of record — same thread, deal document number, or the same subject."
            onClick={autoMatch}
          >
            ✨ Auto-match
          </button>
          <button className="btn sm" disabled={busy || status?.configured === false} onClick={sync}>
            {busy ? "Fetching…" : "↻ Sync"}
          </button>
        </div>
      </div>
      {err ? <div className="action-err">{err}</div> : null}
      {note ? <div className="action-ok">{note}</div> : null}
      {syncErrors(status).map((e) => (
        <div key={e} className="action-err">{e}</div>
      ))}

      {!groups ? (
        <div className="state">Loading…</div>
      ) : groups.length === 0 ? (
        <p className="mail-empty">
          No unmatched mail — every mail we fetched is filed under a deal.
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
                    {g.parties.length === 0 ? <span className="mail-party unknown">—</span> : null}
                    {g.parties.map((p, i) => (
                      <span key={p} className={`mail-party ${i === 0 ? g.party_kind || "unknown" : "unknown"}`}>
                        {p}
                      </span>
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
                  {/* 추천은 골라만 두고 붙이지 않는다 — 왜 그 딜인지 근거를 함께 보여 준다. */}
                  {g.suggest && picked[g.key] === g.suggest.rfq_id ? (
                    <div className="umail-why" title={g.suggest.why}>Suggested · {g.suggest.why}</div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
