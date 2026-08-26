"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  attachMailAddressToProject,
  detachMailAddress,
  fetchCustomers,
  fetchMailUnknownAddresses,
  fetchVendors,
  ignoreMailUnknownAddress,
  registerMailAddress,
} from "@/lib/api";
import type { CustomerOption, MailAddrLink, MailUnknownAddr, VendorOption } from "@/lib/types";
import ProjectPicker, { type ProjectPickOption } from "@/components/common/ProjectPicker";

// 등록되지 않은 상대 — 메일은 오갔지만 고객·벤더 어느 쪽으로도 등록돼 있지 않아
// **한 통도 저장되지 않은** 주소들.
//
// 미분류 메일(UnmatchedMailPanel)과 같은 깔때기의 한 칸 앞이다. 저쪽은 "담긴 메일인데
// 어느 딜인가"를 정하고, 여기는 "이 상대의 메일을 담을까"를 정한다. 두 판단이 같은
// 자리에 있어야 사람이 한 번 앉아 메일함을 비울 수 있어서 Mail 탭 안에 함께 둔다
// (연결 설정 — 계정·자동 실행·폴더 오류 — 만 Settings › Mailbox 에 남는다).
//
// 길은 셋이다. ① 진짜 거래처면 **여기서 바로** 고객·벤더로 올린다(Register) — 이미
// 있는 회사면 그 레코드에 주소만 더하고, 없으면 새로 만든다. ② 검사관·선주 대리인처럼
// **한 딜에서만 만나는 상대**면 그 딜에 바로 붙인다(Attach — 거래처 목록을 한 번 쓰고
// 버릴 이름으로 불리지 않으려고 낸 길). ③ 뉴스레터·알림이면 내린다(Dismiss).
// 셋 다 그 자리에서 지난 메일까지 찾아 담는다. 정기 동기화는 이미 지나친 UID 구간을
// 다시 읽지 않아서, 등록만 해 두면 "오늘부터" 만 들어오고 지난 대화는 영영 안 온다.
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
  // 등록 폼을 펼쳐 둔 주소(한 번에 하나). 표 아래 줄로 펼친다 — 팝업을 띄우면
  // 어느 주소를 등록하는 중인지 표에서 사라진다.
  const [regFor, setRegFor] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  // 등록 폼이 고를 기존 거래처 — 폼을 처음 열 때 한 번만 읽는다.
  const [parties, setParties] = useState<{ customer: PartyOption[]; vendor: PartyOption[] } | null>(
    null
  );

  useEffect(() => {
    if (!regFor || parties) return;
    Promise.all([fetchCustomers(), fetchVendors()])
      .then(([cs, vs]) =>
        setParties({
          customer: cs.map((c: CustomerOption) => ({ id: c.id, name: c.name, sub: c.contact || "" })),
          vendor: vs.map((v: VendorOption) => ({ id: v.id, name: v.name, sub: v.email || "" })),
        })
      )
      .catch(() => setParties({ customer: [], vendor: [] }));
  }, [regFor, parties]);

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

  // 고객·벤더로 올린다 — 있는 레코드에 주소만 더하거나, 새 레코드를 만든다.
  async function register(addr: string, body: RegisterInput) {
    setBusy(addr);
    setErr("");
    setNote("");
    try {
      const r = await registerMailAddress({
        addr,
        kind: body.kind,
        ...(body.partyId ? { party_id: body.partyId } : { name: body.name, contact: body.contact }),
      });
      const what = r.created ? "Registered" : "Added to";
      const parts = [`${what} ${r.kind} ${r.party.name}`];
      if (r.fetched.stored) parts.push(`fetched ${r.fetched.stored} past mails`);
      if (r.spread) parts.push(`${r.spread} more followed on the same evidence`);
      if (!r.fetched.stored) parts.push("new mail arrives from the next sync");
      setNote(`${parts.join(" · ")}.`);
      if (r.warn) setErr(r.warn);
      setRows(r.rows);
      setLinks(r.links || []);
      setRegFor("");
      // 방금 만든 레코드가 다음 폼의 후보가 되어야 한다 — 목록을 다시 읽게 비운다.
      setParties(null);
      onChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not register this address");
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
        vendor, so <b>none of it is being stored.</b> Three ways out, all of them here:{" "}
        <b>Register</b> a real counterpart as a customer or vendor, <b>Attach</b> a one-deal
        contact — surveyor, owner&apos;s rep, yard staff — straight to its project, or{" "}
        <b>Dismiss</b> the rest. Registering and attaching also fetch that address&apos;s past
        mail right away.
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
              <th style={{ width: 170 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.addr}>
              <tr>
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
                <td className="uaddr-c-end">
                  {/* 진짜 거래처인 경우 — 여기서 고객·벤더로 올린다. 폼은 아래 줄에 펼친다. */}
                  <button
                    className={`btn sm${regFor === r.addr ? " primary" : ""}`}
                    disabled={!!busy}
                    title="Register this counterpart as a customer or vendor"
                    onClick={() => setRegFor((a) => (a === r.addr ? "" : r.addr))}
                  >
                    Register
                  </button>
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
              {/* 펼친 등록 폼 — 그 주소 줄 바로 아래에 붙는다. 팝업으로 띄우면 어느
                  주소를 등록하는 중인지 표에서 사라진다. */}
              {regFor === r.addr ? (
                <tr className="uaddr-regrow">
                  <td colSpan={7}>
                    <RegisterForm
                      row={r}
                      parties={parties}
                      busy={busy === r.addr}
                      onCancel={() => setRegFor("")}
                      onSubmit={(body) => register(r.addr, body)}
                    />
                  </td>
                </tr>
              ) : null}
              </Fragment>
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


type PartyOption = { id: number; name: string; sub: string };
type RegisterInput = {
  kind: "customer" | "vendor";
  partyId: number;      // 0 = 새로 만든다
  name: string;
  contact: string;
};

/** 주소 → 회사명 짐작. "no-reply@sign.sleek.sg" → "Sleek". 도메인의 끝(co.kr·com·sg)과
 *  앞머리(mail·smtp·www)를 걷어내고 남는 가장 긴 조각을 쓴다. 어차피 사람이 고칠 값이라
 *  정확할 필요는 없고, 빈칸으로 두어 타이핑을 시키지 않는 것이 목적이다. */
function guessCompany(addr: string, displayName: string): string {
  const shown = (displayName || "").trim();
  // 표시이름이 사람 이름이 아닌 회사명처럼 보이면(괄호·소속 표기가 없으면) 그대로 쓴다.
  if (shown && !/[(),]/.test(shown) && shown.split(/\s+/).length <= 3) return shown;
  const host = (addr.split("@")[1] || "").toLowerCase();
  const parts = host.split(".").filter((p) => p && !["mail", "smtp", "www", "email"].includes(p));
  const skip = new Set(["com", "net", "org", "co", "kr", "sg", "jp", "cn", "hk", "biz", "info"]);
  const core = parts.filter((p) => !skip.has(p)).sort((a, b) => b.length - a.length)[0] || host;
  return core ? core.charAt(0).toUpperCase() + core.slice(1) : "";
}

// 한 주소를 고객·벤더로 올리는 폼. 두 길을 한 폼에 둔다 — 이미 있는 회사에 주소를
// **더하는** 쪽이 실제로는 더 흔한데(대표 주소 + 담당자 주소), 새로 만들기만 있으면
// 같은 회사가 두 벌 생긴다.
function RegisterForm({
  row,
  parties,
  busy,
  onCancel,
  onSubmit,
}: {
  row: MailUnknownAddr;
  parties: { customer: PartyOption[]; vendor: PartyOption[] } | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: RegisterInput) => void;
}) {
  const [kind, setKind] = useState<"customer" | "vendor">("customer");
  const [partyId, setPartyId] = useState(0);
  const [name, setName] = useState(() => guessCompany(row.addr, row.name));
  const contact = (row.name || "").trim();
  const options = parties ? parties[kind] : [];
  // 같은 회사가 담당자 수만큼 여러 줄이라 이름순으로 세워 둔다(고를 때 붙어 보이게).
  const sorted = useMemo(
    () => [...options].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    [options]
  );
  const creating = partyId === 0;

  return (
    <div className="uaddr-reg">
      <span className="uaddr-reg-addr">{row.addr}</span>
      <div className="uaddr-reg-kind">
        {(["customer", "vendor"] as const).map((k) => (
          <button
            key={k}
            type="button"
            className={`btn sm${kind === k ? " primary" : ""}`}
            disabled={busy}
            onClick={() => {
              setKind(k);
              setPartyId(0);
            }}
          >
            {k === "customer" ? "Customer" : "Vendor"}
          </button>
        ))}
      </div>
      <select
        className="uaddr-reg-party"
        value={partyId}
        disabled={busy || !parties}
        onChange={(e) => setPartyId(Number(e.target.value))}
      >
        <option value={0}>{parties ? "— Create a new record —" : "Loading…"}</option>
        {sorted.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
            {o.sub ? ` · ${o.sub}` : ""}
          </option>
        ))}
      </select>
      {creating ? (
        <input
          className="uaddr-reg-name"
          value={name}
          disabled={busy}
          placeholder="Company name"
          onChange={(e) => setName(e.target.value)}
        />
      ) : null}
      <button
        className="btn sm primary"
        disabled={busy || (creating && !name.trim()) || (!creating && !partyId)}
        onClick={() => onSubmit({ kind, partyId, name: name.trim(), contact })}
      >
        {busy ? "Registering…" : creating ? "Create & fetch mail" : "Add address"}
      </button>
      <button className="btn sm" disabled={busy} onClick={onCancel}>
        Cancel
      </button>
      <span className="hint-inline uaddr-reg-hint">
        {creating
          ? `A new ${kind} record with this address${contact ? ` · contact ${contact}` : ""}.`
          : "Adds this address to the record — the existing primary address is unchanged."}
      </span>
    </div>
  );
}
