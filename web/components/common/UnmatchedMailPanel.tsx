"use client";

import { useCallback, useEffect, useState } from "react";
import { assignMail, fetchMailStatus, fetchUnmatchedMail, syncMail } from "@/lib/api";
import type { MailMessage, MailStatus } from "@/lib/types";
import { hm, md } from "@/lib/activity";

// 미분류 메일 — 거래처와 오갔지만 어느 딜 것인지 시스템이 정하지 못한 메일.
// 스레드(회신)나 문서번호로 붙지 않으면 여기 남는다. 추측으로 붙이면 남의 딜 이력이
// 되므로, 마지막 판단은 사람이 한 번 눌러서 한다 — 한 번 붙이면 그 대화의 답장은
// 스레드를 타고 자동으로 같은 딜에 들어온다.
export default function UnmatchedMailPanel({
  projects,
}: {
  /** 배정 대상 목록(최근 딜이 위). */
  projects: { rfqId: number; label: string }[];
}) {
  const [msgs, setMsgs] = useState<MailMessage[] | null>(null);
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  // 메일별로 고른 프로젝트(아직 배정 전).
  const [picked, setPicked] = useState<Record<number, number>>({});

  const load = useCallback(async () => {
    try {
      const [list, st] = await Promise.all([fetchUnmatchedMail(200), fetchMailStatus()]);
      setMsgs(list.messages);
      setStatus(st);
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

  async function assign(msg: MailMessage) {
    const rfqId = picked[msg.id];
    if (!rfqId) return;
    setBusy(true);
    setErr("");
    try {
      const r = await assignMail(msg.id, rfqId);
      setNote(`메일 ${r.updated}통을 이 딜로 옮겼습니다(같은 대화 전체).`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "배정 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="umail">
      <div className="umail-head">
        <span className="act-count">
          unmatched mail · {status?.unmatched ?? msgs?.length ?? 0}
          {status ? <span className="umail-total"> / {status.total} 보관</span> : null}
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

      {!msgs ? (
        <div className="state">Loading…</div>
      ) : msgs.length === 0 ? (
        <p className="mail-empty">
          미분류 메일이 없습니다 — 가져온 메일이 모두 딜에 붙었습니다.
        </p>
      ) : (
        <table className="mini wide umail-table">
          <thead>
            <tr>
              <th className="umail-c-when">When</th>
              <th className="umail-c-dir"></th>
              <th className="umail-c-party">Counterpart</th>
              <th>Subject · summary</th>
              <th className="umail-c-assign">Assign to project</th>
            </tr>
          </thead>
          <tbody>
            {msgs.map((m) => (
              <tr key={m.id}>
                <td className="umail-c-when">{when(m.sent_at)}</td>
                <td className="umail-c-dir">
                  <span className="mail-dir">{m.direction === "out" ? "→" : "←"}</span>
                </td>
                <td className="umail-c-party">
                  <span className={`mail-party ${m.party_kind || "unknown"}`}>{m.party || "—"}</span>
                </td>
                <td>
                  <div className="umail-subject">{m.subject || "(제목 없음)"}</div>
                  <div className="umail-sum">{m.summary || snippet(m)}</div>
                </td>
                <td className="umail-c-assign">
                  <select
                    value={picked[m.id] ?? ""}
                    onChange={(e) =>
                      setPicked((p) => ({ ...p, [m.id]: Number(e.target.value) }))
                    }
                  >
                    <option value="">— 프로젝트 선택 —</option>
                    {projects.map((p) => (
                      <option key={p.rfqId} value={p.rfqId}>{p.label}</option>
                    ))}
                  </select>
                  <button
                    className="btn sm primary"
                    disabled={busy || !picked[m.id]}
                    onClick={() => assign(m)}
                  >
                    배정
                  </button>
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
