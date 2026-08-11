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

// 미분류 메일 — 거래처와 오갔지만 어느 딜 것인지 아직 정해지지 않은 메일.
//
// 다루는 단위는 '한 통'이 아니라 '한 대화'다. 같은 제목의 회신이 열 통씩 쌓이는데
// 판단은 어차피 한 번이라 — 한 줄에서 딜을 고르면 그 대화 전체가 함께 옮겨간다.
// 서버는 근거(같은 대화·문서번호·같은 제목)가 분명한 것은 Auto-match 로 스스로
// 붙이고, 근거가 모자란 대화에는 추천 딜만 달아 둔다(붙이지는 않는다) — 추측으로
// 붙은 이력은 비어 있는 것보다 나쁘기 때문이다. 확정은 사람이 한 번 누른다.
export default function UnmatchedMailPanel({
  projects,
}: {
  /** 배정 대상 목록(최근 딜이 위). */
  projects: { rfqId: number; label: string }[];
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
      setErr(e instanceof Error ? e.message : "미분류 메일을 불러오지 못했습니다.");
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
        `메일함에서 ${r.scanned}통 확인 · 새로 보관 ${r.stored}통 · 이미 있던 것 ${r.dup}통 · `
        + `등록된 거래처와 무관 ${r.skipped}통`
        + (r.auto_matched ? ` · 자동 배정 ${r.auto_matched}통` : "")
        + (r.summarized ? ` · 요약 ${r.summarized}건` : "")
        + (r.pending ? ` · 아직 안 읽은 이전 메일 ${r.pending}통(Sync 를 더 누르세요)` : "")
      );
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "동기화 실패");
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
          ? `${r.total}통을 자동으로 배정했습니다 — 같은 대화 ${r.thread} · 문서번호 ${r.docno} · `
            + `같은 제목 ${r.subject}. 남은 미분류 ${r.unmatched}통.`
          : `자동으로 붙일 근거가 있는 메일이 없습니다 — 남은 ${r.unmatched}통은 아래에서 골라 주세요.`
      );
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "자동 배정 실패");
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
        `메일 ${r.updated}통을 이 딜로 옮겼습니다(대화 전체).`
        + (r.spread ? ` 같은 근거로 ${r.spread}통이 따라 들어갔습니다.` : "")
      );
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "배정 실패");
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
          {status ? <span className="umail-total"> / {status.total} 보관</span> : null}
          {groups ? <span className="umail-total"> · {groups.length} 대화</span> : null}
        </span>
        <div className="umail-actions">
          {status && !status.configured ? (
            <span className="hint-inline">
              메일함이 연결되지 않았습니다 — 서버에 IMAP_USER · IMAP_PASSWORD 를 넣으세요.
            </span>
          ) : (
            <span className="hint-inline">
              {status?.account}
              {lastSync(status) ? ` · 마지막 동기화 ${lastSync(status)}` : ""}
            </span>
          )}
          <button
            className="btn sm"
            disabled={busy || !groups?.length}
            title="같은 대화·문서번호·같은 제목처럼 근거가 분명한 메일을 한 번에 붙입니다."
            onClick={autoMatch}
          >
            ✨ Auto-match
          </button>
          <button className="btn sm" disabled={busy || status?.configured === false} onClick={sync}>
            {busy ? "가져오는 중…" : "↻ Sync"}
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
          미분류 메일이 없습니다 — 가져온 메일이 모두 딜에 붙었습니다.
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
                    <div className="umail-since">부터 {md(g.first_at)}</div>
                  ) : null}
                </td>
                <td className="umail-c-party">
                  {g.parties.length === 0 ? <span className="mail-party unknown">—</span> : null}
                  {g.parties.map((p, i) => (
                    <span key={p} className={`mail-party ${i === 0 ? g.party_kind || "unknown" : "unknown"}`}>
                      {p}
                    </span>
                  ))}
                </td>
                <td>
                  <button
                    type="button"
                    className="umail-subject as-link"
                    onClick={() => setOpen((o) => ({ ...o, [g.key]: !o[g.key] }))}
                    title="이 대화의 메일 보기"
                  >
                    {g.subject}
                    {g.count > 1 ? <span className="umail-count">{g.count}통</span> : null}
                    <span className="umail-caret">{open[g.key] ? "▾" : "▸"}</span>
                  </button>
                  {open[g.key] ? (
                    <ul className="umail-msgs">
                      {g.messages.map((m) => (
                        <li key={m.id}>
                          <span className="mail-dir">{m.direction === "out" ? "→" : "←"}</span>
                          <span className="umail-msg-when">{when(m.sent_at)}</span>
                          <span className="umail-msg-subj">{m.subject || "(제목 없음)"}</span>
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
                  <select
                    value={picked[g.key] ?? ""}
                    onChange={(e) =>
                      setPicked((p) => ({ ...p, [g.key]: Number(e.target.value) }))
                    }
                  >
                    <option value="">— 프로젝트 선택 —</option>
                    {projects.map((p) => (
                      <option key={p.rfqId} value={p.rfqId}>{p.label}</option>
                    ))}
                  </select>
                  <button
                    className="btn sm primary"
                    disabled={busy || !picked[g.key]}
                    onClick={() => assign(g)}
                  >
                    배정
                  </button>
                  {/* 추천은 골라만 두고 붙이지 않는다 — 왜 그 딜인지 근거를 함께 보여 준다. */}
                  {g.suggest && picked[g.key] === g.suggest.rfq_id ? (
                    <div className="umail-why" title={g.suggest.why}>추천 · {g.suggest.why}</div>
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
  return body ? `${body.slice(0, 140)}${body.length > 140 ? "…" : ""}` : "(본문 없음)";
}
