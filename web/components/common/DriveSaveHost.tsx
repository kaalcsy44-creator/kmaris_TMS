"use client";

// 견적을 저장하면 뜨는 "드라이브 02 QTN 에 저장할까요?" 창.
// 위치는 02 QTN / 상대 이름(고객사·공급사) / (선택) 하위 폴더 하나 더. 사람이 Save 를 눌러야
// 올리고, 폴더도 그때 필요한 것만 만든다. 덮어쓰지 않는다 — 내용이 바뀌면 " (2)", 같으면 건너뛴다.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  DRIVE_MAX_UPLOAD,
  fetchDriveTarget,
  saveToDrive,
  type DriveSaveResult,
  type DriveTarget,
} from "@/lib/api";
import {
  getDriveSave,
  muteDriveSave,
  openDriveSave,
  subscribeDriveSave,
  type DriveSaveRequest,
} from "@/lib/driveSave";

export default function DriveSaveHost() {
  const req = useSyncExternalStore(subscribeDriveSave, getDriveSave, () => null);
  if (!req || typeof document === "undefined") return null;
  return createPortal(<SaveDialog key={req.n} req={req} onClose={() => openDriveSave(null)} />, document.body);
}

const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function SaveDialog({ req, onClose }: { req: DriveSaveRequest; onClose: () => void }) {
  const [target, setTarget] = useState<DriveTarget | null>(null);
  const [useParty, setUseParty] = useState(true);
  const [party, setParty] = useState("");
  const [useExtra, setUseExtra] = useState(false);
  const [extra, setExtra] = useState("");
  const [picked, setPicked] = useState<boolean[]>(() => req.files.map((f) => f.on));
  const [attach, setAttach] = useState<File[]>(req.attach ?? []);
  const [mute, setMute] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState<DriveSaveResult | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    fetchDriveTarget(req.rfqId, req.ref)
      .then((t) => {
        if (!alive) return;
        setTarget(t);
        setParty(t.party);
        setUseParty(!!t.party);
      })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Could not check Drive."); });
    boxRef.current?.focus();
    return () => { alive = false; };
  }, [req]);

  function close() {
    if (busy) return;
    if (mute) muteDriveSave(req);
    onClose();
  }

  // ESC 는 이 창만 닫는다 — 뒤의 프로젝트 창도 document 에서 ESC 를 듣고 있어 먼저 붙잡는다.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const addFiles = (list: FileList | File[] | null) => {
    if (!list || !req.allowAttach) return;
    const fresh = Array.from(list);
    setAttach((cur) => [...cur, ...fresh.filter((f) => !cur.some((c) => c.name === f.name && c.size === f.size))]);
  };

  const folders = [useParty ? party.trim() : "", useExtra ? extra.trim() : ""].filter(Boolean);
  const count = picked.filter(Boolean).length + attach.length;
  const folderMissing = (useParty && !party.trim()) || (useExtra && !extra.trim());

  async function save() {
    setErr("");
    try {
      const files: { blob: Blob; name: string }[] = [];
      setBusy("Preparing…");
      for (let i = 0; i < req.files.length; i++) {
        if (picked[i]) files.push({ blob: await req.files[i].get(), name: req.files[i].name });
      }
      for (const f of attach) files.push({ blob: f, name: f.name || "file" });
      setBusy("Saving…");
      const r = await saveToDrive(req.rfqId, folders, files);
      setDone(r);
      if (mute) muteDriveSave(req);
      if (!r.failed.length) req.onSaved?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save to Drive.");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="dfc-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div
        ref={boxRef}
        tabIndex={-1}
        className="dfc-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Save to Google Drive"
        onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
        onDragOver={(e) => { if (req.allowAttach) e.preventDefault(); }}
        onDrop={(e) => { if (req.allowAttach) { e.preventDefault(); addFiles(e.dataTransfer.files); } }}
      >
        <div className="dfc-title">📁 {req.title}</div>

        {done ? (
          <>
            {done.saved.length ? (
              <>
                <div className="action-ok">Saved to {done.path}</div>
                <ul className="dfc-list">
                  {done.saved.map((f) => (
                    <li key={f.url}>
                      ✓ <a href={f.url} target="_blank" rel="noopener noreferrer">{f.name}</a>
                      {f.same ? " — already there, unchanged" : ""}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {done.created.length ? <div className="hint-inline">New folder: {done.created.join(", ")}</div> : null}
            {[...done.skipped, ...done.failed].map((f) => (
              <div className="action-err" key={f.name}>{f.name}: {f.reason}</div>
            ))}
            <div className="dfc-actions">
              <a className="btn sm" href={done.folder_url} target="_blank" rel="noopener noreferrer">Open folder</a>
              <button type="button" className="btn sm primary" onClick={close}>Close</button>
            </div>
          </>
        ) : !target ? (
          err ? (
            <>
              <div className="action-err">{err}</div>
              <div className="dfc-actions"><button type="button" className="btn sm" onClick={close}>Close</button></div>
            </>
          ) : (
            <div className="state">Checking Drive…</div>
          )
        ) : (
          <>
            <div className="dfc-path">
              {target.project} / <b>{target.sub}</b>
              {folders.map((f, i) => <span key={i}> / <b>{f}</b></span>)}
            </div>
            <div className="dfc-field">
              <label className="dfc-sub">
                <input type="checkbox" checked={useParty} disabled={!!busy} onChange={(e) => setUseParty(e.target.checked)} />
                Folder in {target.sub} ({req.ref.startsWith("vq:") ? "vendor" : "customer"} name)
              </label>
              {useParty ? (
                <>
                  <input value={party} list="dfc-existing" disabled={!!busy} onChange={(e) => setParty(e.target.value)} />
                  <datalist id="dfc-existing">
                    {target.existing.map((n) => <option key={n} value={n} />)}
                  </datalist>
                  <span className="hint-inline">
                    {target.existing.some((n) => n.toLowerCase() === party.trim().toLowerCase())
                      ? "Existing folder — files are added to it."
                      : party.trim() ? "New folder — created when you save." : "Enter a folder name."}
                  </span>
                </>
              ) : null}
            </div>
            <div className="dfc-field">
              <label className="dfc-sub">
                <input type="checkbox" checked={useExtra} disabled={!!busy} onChange={(e) => setUseExtra(e.target.checked)} />
                Add one more subfolder
              </label>
              {useExtra ? (
                <input autoFocus value={extra} placeholder="Rev.1" disabled={!!busy} onChange={(e) => setExtra(e.target.value)} />
              ) : null}
            </div>
            <div className="dfc-field">
              <span>Files</span>
              {req.files.map((f, i) => (
                <label className="dfc-sub" key={f.name}>
                  <input
                    type="checkbox"
                    checked={picked[i]}
                    disabled={!!busy}
                    onChange={(e) => setPicked((p) => p.map((v, j) => (j === i ? e.target.checked : v)))}
                  />
                  {f.name}
                </label>
              ))}
              {attach.map((f, i) => (
                <span className="dfc-file" key={`${f.name}-${f.size}`}>
                  📄 {f.name} <i>{fmtSize(f.size)}{f.size > DRIVE_MAX_UPLOAD ? " · over 50MB — will be skipped" : ""}</i>
                  <button type="button" className="trow-btn del" aria-label={`Remove ${f.name}`} disabled={!!busy}
                          onClick={() => setAttach((cur) => cur.filter((_, j) => j !== i))}>✕</button>
                </span>
              ))}
              {req.allowAttach ? (
                <>
                  <input type="file" multiple disabled={!!busy}
                         onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
                  <span className="hint-inline">Choose, drop or paste (Ctrl+V) the quotation the vendor sent.</span>
                </>
              ) : null}
            </div>
            {req.note ? <div className="hint-inline warn">{req.note}</div> : null}
            {err ? <div className="action-err">{err}</div> : null}
            <label className="dfc-sub hint-inline">
              <input type="checkbox" checked={mute} onChange={(e) => setMute(e.target.checked)} />
              Do not ask again for this project until the page is reloaded
            </label>
            <div className="dfc-actions">
              <button type="button" className="btn sm" onClick={close} disabled={!!busy}>Not now</button>
              <button type="button" className="btn sm primary" onClick={save} disabled={!!busy || !count || folderMissing}>
                {busy || `Save to Drive${count ? ` (${count})` : ""}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
