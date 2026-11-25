"use client";

// 프로젝트 ↔ 공유 드라이브 폴더. 연결돼 있으면 "Folder" 로 바로 열고, 없으면
// "Create folder" → 확인 창(이름·위치·하위 폴더 미리보기, 만들 하위 폴더 고르기) → 승인해야 만든다.
// 사람이 드라이브에서 먼저 만든 폴더는 "Link existing" 탭에서 고르거나 링크를 붙여 잇는다.
// 2026-11-17: 폴더는 자동으로 만들지 않는다 — 사람이 원할 때, 원하는 것만, 만든 뒤 목록을 보여 준다.
// 서버에 드라이브 연동이 설정돼 있지 않으면 아무것도 그리지 않는다.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  createRfqDriveFolder,
  fetchDriveFolderCandidates,
  fetchRfqDriveFolder,
  linkRfqDriveFolder,
  previewRfqDriveFolder,
  unlinkRfqDriveFolder,
  type DriveFolderCandidate,
  type DriveSubKey,
  type RfqDriveFolder,
  type RfqDriveFolderPreview,
} from "@/lib/api";

type Done = { folder_url: string; folder_name: string; created: string[] };

export default function DriveFolderChip({ rfqId, className = "" }: { rfqId: number; className?: string }) {
  const [st, setSt] = useState<RfqDriveFolder | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setSt(null);
    fetchRfqDriveFolder(rfqId)
      .then((r) => { if (alive) setSt(r); })
      .catch(() => { if (alive) setSt(null); });
    return () => { alive = false; };
  }, [rfqId]);

  if (!st || !st.enabled) return null;

  return (
    <>
      {st.folder_url ? (
        <span className={`drive-chip-pair ${className}`}>
          <a
            className="drive-chip"
            href={st.folder_url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open this project's Google Drive folder"
          >
            📁 Folder
          </a>
          <button
            type="button"
            className="drive-chip-more"
            aria-label="Change the linked folder"
            title="Change or unlink the folder"
            onClick={() => setOpen(true)}
          >
            ▾
          </button>
        </span>
      ) : (
        <button
          type="button"
          className={`drive-chip create ${className}`}
          onClick={() => setOpen(true)}
          title="This project has no Google Drive folder yet — create one, or link a folder you already made"
        >
          📁 Create / link folder
        </button>
      )}
      {open ? (
        <FolderDialog
          rfqId={rfqId}
          linked={!!st.folder_url}
          onClose={() => setOpen(false)}
          onChanged={(url) => setSt({ enabled: true, folder_id: "", folder_url: url })}
        />
      ) : null}
    </>
  );
}

function FolderDialog({
  rfqId, linked, onClose, onChanged,
}: { rfqId: number; linked: boolean; onClose: () => void; onChanged: (url: string) => void }) {
  const [tab, setTab] = useState<"create" | "link">(linked ? "link" : "create");
  // 이 창을 연 때의 상태로 고정 — 잇고 난 뒤 결과를 보여 주는 동안 화면이 바뀌지 않게.
  const [wasLinked] = useState(linked);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return createPortal(
    <div className="dfc-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="dfc-dialog" role="dialog" aria-modal="true" aria-label="Project Drive folder">
        <div className="dfc-title">📁 Google Drive folder</div>
        {wasLinked ? null : (
          <span className="pl-view-toggle dfc-tabs" role="group" aria-label="Create or link">
            <button type="button" className={tab === "create" ? "on" : ""} aria-pressed={tab === "create"} disabled={busy} onClick={() => setTab("create")}>Create new</button>
            <button type="button" className={tab === "link" ? "on" : ""} aria-pressed={tab === "link"} disabled={busy} onClick={() => setTab("link")}>Link existing</button>
          </span>
        )}
        {tab === "create"
          ? <CreateFolder rfqId={rfqId} busy={busy} setBusy={setBusy} onClose={onClose} onCreated={(d) => onChanged(d.folder_url)} />
          : <LinkFolder rfqId={rfqId} linked={wasLinked} busy={busy} setBusy={setBusy} onClose={onClose} onChanged={onChanged} />}
      </div>
    </div>,
    document.body,
  );
}

/** 이미 있는 폴더 잇기 — 목록에서 고르거나 링크를 붙인다. 드라이브에는 아무것도 쓰지 않는다. */
function LinkFolder({
  rfqId, linked, busy, setBusy, onClose, onChanged,
}: { rfqId: number; linked: boolean; busy: boolean; setBusy: (b: boolean) => void; onClose: () => void; onChanged: (url: string) => void }) {
  const [rows, setRows] = useState<DriveFolderCandidate[] | null>(null);
  const [q, setQ] = useState("");
  const [pick, setPick] = useState("");
  const [url, setUrl] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState<{ name: string; url: string } | null>(null);

  useEffect(() => {
    let alive = true;
    fetchDriveFolderCandidates(rfqId)
      .then((r) => { if (alive) setRows(r.folders ?? []); })
      // 목록을 못 읽어도 링크 붙여넣기로는 이을 수 있다.
      .catch((e) => { if (alive) { setRows([]); setErr(e instanceof Error ? e.message : "Could not read Drive."); } });
    return () => { alive = false; };
  }, [rfqId]);

  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (rows ?? []).filter((r) => words.every((w) => `${r.name} ${r.where}`.toLowerCase().includes(w))).slice(0, 60);
  }, [rows, q]);

  async function save() {
    setBusy(true);
    setErr("");
    try {
      const r = await linkRfqDriveFolder(rfqId, url.trim() || pick, linked);
      setDone({ name: r.folder_name, url: r.folder_url });
      onChanged(r.folder_url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not link the folder.");
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    if (!confirm("Unlink this folder from the project?\n\nThe folder and its files stay in Google Drive.")) return;
    setBusy(true);
    setErr("");
    try {
      await unlinkRfqDriveFolder(rfqId);
      onChanged("");
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not unlink the folder.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <>
        <div className="action-ok">✓ Linked: {done.name}</div>
        <div className="dfc-actions">
          <a className="btn sm" href={done.url} target="_blank" rel="noopener noreferrer">Open folder</a>
          <button type="button" className="btn sm primary" onClick={onClose}>Close</button>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="hint-inline">
        {linked ? "Pick another folder to replace the current link. " : "Pick the folder you made in K-MARIS PROJECTS. "}
        Only the link is saved — nothing in Drive is created, moved or renamed.
      </div>
      <label className="dfc-field">
        <span>Find folder</span>
        <input value={q} disabled={busy || !rows} placeholder="Customer, vessel, date (261125)…" onChange={(e) => setQ(e.target.value)} />
      </label>
      {!rows ? <div className="state">Reading Drive…</div> : (
        <div className="dfc-pick" role="radiogroup" aria-label="Drive folders">
          {shown.length ? shown.map((r) => {
            const off = !!r.linked_to || r.current;
            return (
              <label key={r.id} className={`dfc-pick-row${off ? " off" : ""}${pick === r.id && !url.trim() ? " on" : ""}`}>
                <input type="radio" name="dfc-pick" checked={pick === r.id && !url.trim()} disabled={busy || off}
                       onChange={() => { setPick(r.id); setUrl(""); setErr(""); }} />
                <span className="dfc-pick-name">
                  {r.where ? <i>{r.where} / </i> : null}{r.name}
                  {r.current ? <em>Linked to this project</em> : r.linked_to ? <em>Used by {r.linked_to}</em> : null}
                </span>
                <a href={r.url} target="_blank" rel="noopener noreferrer" title="Open in Drive" aria-label={`Open ${r.name} in Drive`}>↗</a>
              </label>
            );
          }) : <div className="hint-inline">No folder matches.</div>}
        </div>
      )}
      <label className="dfc-field">
        <span>Or paste the folder link</span>
        <input value={url} disabled={busy} placeholder="https://drive.google.com/drive/folders/…" onChange={(e) => { setUrl(e.target.value); setErr(""); }} />
      </label>
      {err ? <div className="action-err">{err}</div> : null}
      <div className="dfc-actions">
        {linked ? <button type="button" className="btn sm dfc-unlink" onClick={() => void unlink()} disabled={busy}>Unlink</button> : null}
        <button type="button" className="btn sm" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn sm primary" onClick={() => void save()} disabled={busy || !(url.trim() || pick)}>
          {busy ? "Saving…" : linked ? "Change link" : "Link folder"}
        </button>
      </div>
    </>
  );
}

function CreateFolder({
  rfqId, busy, setBusy, onClose, onCreated,
}: { rfqId: number; busy: boolean; setBusy: (b: boolean) => void; onClose: () => void; onCreated: (d: Done) => void }) {
  const [pv, setPv] = useState<RfqDriveFolderPreview | null>(null);
  const [name, setName] = useState("");
  const [subs, setSubs] = useState<Record<DriveSubKey, boolean>>({ RFQ: true, QTN: true, PO: true, INV: true });
  const [err, setErr] = useState("");
  const [done, setDone] = useState<Done | null>(null);

  useEffect(() => {
    let alive = true;
    previewRfqDriveFolder(rfqId)
      .then((p) => { if (alive) { setPv(p); setName(p.name); } })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Could not check Drive."); });
    return () => { alive = false; };
  }, [rfqId]);

  const picked = (Object.keys(subs) as DriveSubKey[]).filter((k) => subs[k]);

  async function create() {
    setBusy(true);
    setErr("");
    try {
      const r = await createRfqDriveFolder(rfqId, {
        name: pv && name.trim() !== pv.name ? name.trim() : "",
        subfolders: picked,
      });
      const d = { folder_url: r.folder_url, folder_name: r.folder_name, created: r.created ?? [] };
      setDone(d);
      onCreated(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not create the folder.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
        {done ? (
          <>
            <div className="action-ok">
              {done.created.length ? `Created ${done.created.length} folder(s):` : "Nothing new was created — existing folders were linked."}
            </div>
            {done.created.length ? (
              <ul className="dfc-list">
                {done.created.map((c) => <li key={c}>✓ {c}</li>)}
              </ul>
            ) : null}
            <div className="dfc-actions">
              <a className="btn sm" href={done.folder_url} target="_blank" rel="noopener noreferrer">Open folder</a>
              <button type="button" className="btn sm primary" onClick={onClose}>Close</button>
            </div>
          </>
        ) : !pv ? (
          err ? (
            <>
              <div className="action-err">{err}</div>
              <div className="dfc-actions"><button type="button" className="btn sm" onClick={onClose}>Close</button></div>
            </>
          ) : (
            <div className="state">Checking Drive…</div>
          )
        ) : (
          <>
            <div className="hint-inline">
              Nothing is created until you press <b>Create</b>. Location: <b>{pv.root === "SERVICE" ? "PROJECT_SERVICE" : "PROJECT_PARTS"}</b>
            </div>
            <label className="dfc-field">
              <span>Folder name</span>
              <input
                value={name}
                disabled={busy || pv.reuse_existing}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {pv.reuse_existing ? (
              <div className="hint-inline warn">
                A folder with this name already exists and is not linked to any project — it will be linked, not duplicated.
              </div>
            ) : null}
            <div className="dfc-field">
              <span>Subfolders to create (missing ones only)</span>
              <div className="dfc-subs">
                {pv.subfolders.map((s) => (
                  <label key={s.key} className="dfc-sub">
                    <input
                      type="checkbox"
                      checked={subs[s.key]}
                      disabled={busy}
                      onChange={(e) => setSubs((p) => ({ ...p, [s.key]: e.target.checked }))}
                    />
                    {s.name}
                  </label>
                ))}
              </div>
            </div>
            {err ? <div className="action-err">{err}</div> : null}
            <div className="dfc-actions">
              <button type="button" className="btn sm" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="button" className="btn sm primary" onClick={create} disabled={busy || !name.trim()}>
                {busy ? "Creating…" : "Create"}
              </button>
            </div>
          </>
        )}
    </>
  );
}
