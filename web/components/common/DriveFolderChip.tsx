"use client";

// 프로젝트 ↔ 공유 드라이브 폴더. 연결돼 있으면 "Folder" 로 바로 열고, 없으면
// "Create folder" → 확인 창(이름·위치·하위 폴더 미리보기, 만들 하위 폴더 고르기) → 승인해야 만든다.
// 2026-11-17: 폴더는 자동으로 만들지 않는다 — 사람이 원할 때, 원하는 것만, 만든 뒤 목록을 보여 준다.
// 서버에 드라이브 연동이 설정돼 있지 않으면 아무것도 그리지 않는다.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  createRfqDriveFolder,
  fetchRfqDriveFolder,
  previewRfqDriveFolder,
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
        <a
          className={`drive-chip ${className}`}
          href={st.folder_url}
          target="_blank"
          rel="noopener noreferrer"
          title="Open this project's Google Drive folder"
        >
          📁 Folder
        </a>
      ) : (
        <button
          type="button"
          className={`drive-chip create ${className}`}
          onClick={() => setOpen(true)}
          title="This project has no Google Drive folder yet — review and create it"
        >
          📁 Create folder
        </button>
      )}
      {open ? (
        <CreateFolderDialog
          rfqId={rfqId}
          onClose={() => setOpen(false)}
          onCreated={(d) => setSt({ enabled: true, folder_id: "", folder_url: d.folder_url })}
        />
      ) : null}
    </>
  );
}

function CreateFolderDialog({
  rfqId, onClose, onCreated,
}: { rfqId: number; onClose: () => void; onCreated: (d: Done) => void }) {
  const [pv, setPv] = useState<RfqDriveFolderPreview | null>(null);
  const [name, setName] = useState("");
  const [subs, setSubs] = useState<Record<DriveSubKey, boolean>>({ RFQ: true, QTN: true, PO: true, INV: true });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<Done | null>(null);

  useEffect(() => {
    let alive = true;
    previewRfqDriveFolder(rfqId)
      .then((p) => { if (alive) { setPv(p); setName(p.name); } })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Could not check Drive."); });
    return () => { alive = false; };
  }, [rfqId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

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

  const body = (
    <div className="dfc-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="dfc-dialog" role="dialog" aria-modal="true" aria-label="Create Drive folder">
        <div className="dfc-title">📁 Create Google Drive folder</div>

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
      </div>
    </div>
  );
  return createPortal(body, document.body);
}
