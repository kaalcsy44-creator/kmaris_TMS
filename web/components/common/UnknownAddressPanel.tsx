"use client";

import { useCallback, useEffect, useState } from "react";
import {
  attachMailAddressToProject,
  detachMailAddress,
  fetchMailUnknownAddresses,
  ignoreMailUnknownAddress,
} from "@/lib/api";
import type { MailAddrLink, MailUnknownAddr } from "@/lib/types";
import ProjectPicker, { type ProjectPickOption } from "@/components/common/ProjectPicker";

// 등록되지 않은 상대 — 메일은 오갔지만 고객·벤더 어느 쪽으로도 등록돼 있지 않아
// **한 통도 저장되지 않은** 주소들.
//
// 미분류 메일(UnmatchedMailPanel)과 같은 깔때기의 한 칸 앞이다. 저쪽은 "담긴 메일인데
// 어느 딜인가"를 정하고, 여기는 "이 상대의 메일을 담을까"를 정한다. 두 판단이 같은
// 자리에 있어야 사람이 한 번 앉아 메일함을 비울 수 있어서 Mail 탭 안에 함께 둔다
// (연결 설정 — 계정·자동 실행·폴더 오류 — 만 Settings › Mailbox 에 남는다).
//
// 길은 셋이다. ① 진짜 거래처면 Customer/Vendor 탭에 등록 → 다음 동기화부터 들어온다.
// ② 검사관·선주 대리인처럼 **한 딜에서만 만나는 상대**면 그 딜에 바로 붙인다(거래처
// 목록을 한 번 쓰고 버릴 이름으로 불리지 않으려고 낸 길). ③ 뉴스레터·알림이면 내린다.
export default function UnknownAddressPanel({
  projects,
  onChanged,
}: {
  /** 붙일 대상 딜 목록(최근 딜이 위) — 미분류 화면과 같은 것을 쓴다. */
  projects: ProjectPickOption[];
  /** 메일이 새로 담겼을 때(통수·미분류 수가 바뀐다) 바깥 화면이 다시 읽게 알린다. */
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<MailUnknownAddr[] | null>(null);
  // 딜에 붙여 둔 주소 — 거래처로 등록하지 않고 딜 하나에 매어 둔 상대.
  const [links, setLinks] = useState<MailAddrLink[]>([]);
  // 주소 줄마다 고른 딜. 아직 붙이기 전의 선택이다.
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const un = await fetchMailUnknownAddresses();
      setRows(un.rows);
      setLinks(un.links || []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load unregistered counterparts");
      setRows([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function ignore(addr: string) {
    setBusy(addr);
    setErr("");
    try {
      const r = await ignoreMailUnknownAddress(addr);
      setRows(r.rows);
      setLinks(r.links || []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not dismiss this address");
    } finally {
      setBusy("");
    }
  }

  // 주소를 딜에 붙인다 — 그 자리에서 지난 메일까지 찾아 담으므로 몇 초 걸린다.
  async function attach(addr: string) {
    const rfqId = picked[addr];
    if (!rfqId) return;
    setBusy(addr);
    setErr("");
    setNote("");
    try {
      const r = await attachMailAddressToProject(addr, rfqId);
      const no = projects.find((p) => p.rfqId === rfqId)?.no || `#${rfqId}`;
      const parts = [`Linked ${addr} to ${no}`];
      if (r.fetched.stored) parts.push(`fetched ${r.fetched.stored} past mails`);
      if (r.adopted) parts.push(`moved ${r.adopted} already-stored mails`);
      if (r.spread) parts.push(`${r.spread} more followed on the same evidence`);
      if (!r.fetched.stored && !r.adopted) {
        parts.push("nothing found in the mailbox window — new mail arrives from the next sync");
      }
      setNote(`${parts.join(" · ")}.`);
      if (r.warn) setErr(r.warn);
      setRows(r.rows);
      setLinks(r.links || []);
      setPicked((p) => {
        const next = { ...p };
        delete next[addr];
        return next;
      });
      onChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not attach this address");
    } finally {
      setBusy("");
    }
  }

  async function detach(addr: string) {
    setBusy(addr);
    setErr("");
    setNote("");
    try {
      const r = await detachMailAddress(addr);
      setRows(r.rows);
      setLinks(r.links || []);
      setNote(`${addr} is no longer linked — mail already filed under the deal stays.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not unlink this address");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="uaddr">
      <p className="hint-inline uaddr-hint">
        Mail was exchanged with these addresses but they are not registered as a customer or
        vendor, so <b>none of it is being stored.</b> Three ways out: <b>register</b> the real
        counterparts on Settings › Customer / Vendor (their mail arrives from the next sync),
        <b> attach</b> one-deal contacts — surveyors, owner&apos;s reps, yard staff — straight to
        the project here, or <b>dismiss</b> the rest.
      </p>
      {err ? <div className="action-err">{err}</div> : null}
      {note ? <div className="action-ok">{note}</div> : null}

      {rows === null ? (
        <div className="state">Loading…</div>
      ) : rows.length === 0 ? (
        <p className="mail-empty">
          Every counterpart we exchanged mail with is registered, attached, or dismissed. 🎉
        </p>
      ) : (
        <table className="mini wide">
          <thead>
            <tr>
              <th>Address</th>
              <th>Name</th>
              <th className="num">Mails</th>
              <th>Last</th>
              <th>Latest subject</th>
              <th className="uaddr-c-attach">Attach to project</th>
              <th style={{ width: 90 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.addr}>
                <td>{r.addr}</td>
                <td>{r.name || "—"}</td>
                <td className="num">{r.count}</td>
                <td>{(r.last_at || "").slice(0, 10) || "—"}</td>
                <td className="muted">{r.subject || "—"}</td>
                {/* 거래처로 올릴 상대는 아니지만 딜 하나에는 속하는 사람 — 여기서 곧장
                    그 딜에 붙인다. 붙이면 지난 메일도 그 자리에서 찾아 담는다. */}
                <td className="uaddr-c-attach">
                  <ProjectPicker
                    value={picked[r.addr] ?? ""}
                    options={projects}
                    onChange={(id) => setPicked((p) => ({ ...p, [r.addr]: id === "" ? 0 : id }))}
                    disabled={!!busy || projects.length === 0}
                  />
                  <button
                    className="btn sm primary"
                    disabled={!!busy || !picked[r.addr]}
                    title="Store this address's mail under the chosen project — past mail included"
                    onClick={() => attach(r.addr)}
                  >
                    {busy === r.addr ? "Fetching…" : "Attach"}
                  </button>
                </td>
                <td>
                  <button
                    className="btn sm"
                    disabled={!!busy}
                    title="Not a counterpart — stop counting this address"
                    onClick={() => ignore(r.addr)}
                  >
                    {busy === r.addr ? "…" : "Dismiss"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* 붙여 둔 주소 — 되돌릴 수 있어야 사람이 마음 놓고 붙인다. Stored 가 0 이면
          주소를 잘못 골랐거나 기간(IMAP_SINCE_DAYS) 밖의 메일이라는 뜻이다. */}
      {links.length > 0 ? (
        <>
          <h3 className="form-title uaddr-title">
            Attached to a project<span className="muted"> — {links.length}</span>
          </h3>
          <p className="hint-inline uaddr-hint">
            These addresses are not customers or vendors, but their mail is kept and filed under
            the deal below. Evidence still wins — a mail carrying another deal&apos;s document
            number goes to that deal instead.
          </p>
          <table className="mini wide">
            <thead>
              <tr>
                <th>Address</th>
                <th>Name</th>
                <th>Project</th>
                <th className="num">Stored</th>
                <th>Linked</th>
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.addr}>
                  <td>{l.addr}</td>
                  <td>{l.name || "—"}</td>
                  <td>
                    <a href={`/project?rfq=${l.rfq_id}&view=overview`}>
                      {l.project_no || `#${l.rfq_id}`}
                    </a>
                  </td>
                  <td className="num">{l.stored || "—"}</td>
                  <td className="muted">{l.linked_at || "—"}</td>
                  <td>
                    <button
                      className="btn sm"
                      disabled={!!busy}
                      title="Stop storing this address — mail already filed under the deal stays"
                      onClick={() => detach(l.addr)}
                    >
                      {busy === l.addr ? "…" : "Unlink"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </div>
  );
}
