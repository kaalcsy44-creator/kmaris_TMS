"use client";

import { useEffect, useRef, useState } from "react";
import {
  fetchMarketingAssets,
  uploadMarketingAsset,
  deleteMarketingAsset,
  downloadMarketingAsset,
  fetchMarketingAssetObjectUrl,
  renameMarketingAsset,
  type MarketingAsset,
} from "@/lib/api";
import Modal from "@/components/common/Modal";

// 홍보 이메일 첨부용 자료 라이브러리(회사소개서·브로슈어). 여기 등록한 파일을
// Marketing 화면의 이메일 작성 모달에서 골라 첨부한다.

// Inline action icons (16px, stroke = currentColor so .icon-btn controls color).
function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function fmtBytes(n: number): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function BrochuresPanel() {
  const [rows, setRows] = useState<MarketingAsset[]>([]);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  // 미리보기: 인증 헤더로 받은 blob 의 object URL 을 모달에 표시. 닫을 때 revoke.
  const [preview, setPreview] = useState<{ asset: MarketingAsset; url: string } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  // 표시 이름 인라인 편집(파일명이 아니라 라벨만 변경).
  const [editId, setEditId] = useState<number | null>(null);
  const [editVal, setEditVal] = useState("");

  async function load() {
    setLoading(true);
    try {
      const d = await fetchMarketingAssets();
      setRows(d.rows);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load the list.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // 열려 있던 미리보기 URL 은 컴포넌트가 사라질 때 정리한다.
  useEffect(() => () => {
    setPreview((p) => {
      if (p) URL.revokeObjectURL(p.url);
      return null;
    });
  }, []);

  async function openPreview(a: MarketingAsset) {
    setErr("");
    setPreviewBusy(true);
    try {
      const url = await fetchMarketingAssetObjectUrl(a.id);
      setPreview((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { asset: a, url };
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Preview failed.");
    } finally {
      setPreviewBusy(false);
    }
  }

  function closePreview() {
    setPreview((p) => {
      if (p) URL.revokeObjectURL(p.url);
      return null;
    });
  }

  async function onUpload(list: FileList | null) {
    if (!list || !list.length) return;
    setBusy(true);
    setErr("");
    try {
      // 여러 파일 선택 시 각각 업로드. label 은 단일 파일일 때만 적용.
      const files = Array.from(list);
      for (const f of files) {
        await uploadMarketingAsset(f, files.length === 1 ? label.trim() : "");
      }
      setLabel("");
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(a: MarketingAsset) {
    if (!confirm(`Delete "${a.label}"?`)) return;
    setBusy(true);
    setErr("");
    try {
      await deleteMarketingAsset(a.id);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setBusy(false);
    }
  }

  function startRename(a: MarketingAsset) {
    setEditId(a.id);
    setEditVal(a.label);
  }
  function cancelRename() {
    setEditId(null);
    setEditVal("");
  }
  async function saveRename(a: MarketingAsset) {
    const name = editVal.trim();
    if (!name || name === a.label) {
      cancelRename();
      return;
    }
    setBusy(true);
    setErr("");
    try {
      await renameMarketingAsset(a.id, name);
      cancelRename();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Rename failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h3 className="form-title">Brochures &amp; company profile</h3>
      <p className="hint-inline" style={{ display: "block", marginBottom: 12 }}>
        Register the company profiles and brochures you want to attach to marketing emails. You can pick and attach them from the email composer on the Marketing page.
      </p>

      <div className="form-grid" style={{ alignItems: "end", marginBottom: 14 }}>
        <label className="form-field">
          <span>Display name (optional)</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Corporate Profile 2026"
          />
        </label>
        <div className="form-field">
          <span>&nbsp;</span>
          <div>
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              {busy ? "Uploading…" : "+ Upload file"}
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => onUpload(e.target.files)}
            />
          </div>
        </div>
      </div>

      {err ? <div className="action-err" style={{ marginBottom: 10 }}>{err}</div> : null}

      {loading ? (
        <div className="muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="muted">No items registered.</div>
      ) : (
        <table className="mini">
          <thead>
            <tr>
              <th>Name</th>
              <th>File name</th>
              <th>Size</th>
              <th>Registered</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td>
                  {editId === a.id ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <input
                        value={editVal}
                        autoFocus
                        style={{ width: "100%", maxWidth: 260 }}
                        onChange={(e) => setEditVal(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveRename(a);
                          else if (e.key === "Escape") cancelRename();
                        }}
                      />
                      <button
                        type="button"
                        className="icon-btn"
                        title="Save"
                        disabled={busy}
                        onClick={() => saveRename(a)}
                      >
                        <CheckIcon />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Cancel"
                        disabled={busy}
                        onClick={cancelRename}
                      >
                        <XIcon />
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span>{a.label}</span>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Rename"
                        disabled={busy}
                        onClick={() => startRename(a)}
                      >
                        <PencilIcon />
                      </button>
                    </div>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    className="linklike"
                    title="Preview"
                    disabled={previewBusy}
                    onClick={() => openPreview(a)}
                  >
                    {a.filename}
                  </button>
                </td>
                <td>{fmtBytes(a.size)}</td>
                <td>{(a.created_at || "").replace("T", " ")}</td>
                <td>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button
                      type="button"
                      className="icon-btn danger"
                      title="Delete"
                      disabled={busy}
                      onClick={() => remove(a)}
                    >
                      <XIcon />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {preview ? (
        <Modal title={`Preview — ${preview.asset.label || preview.asset.filename}`} onClose={closePreview} wide>
          <div style={{ width: "100%" }}>
            {preview.asset.mime.startsWith("image/") ? (
              <img
                src={preview.url}
                alt={preview.asset.filename}
                style={{ maxWidth: "100%", maxHeight: "calc(100vh - 200px)", display: "block", margin: "0 auto" }}
              />
            ) : preview.asset.mime.startsWith("application/pdf") ? (
              <iframe
                src={preview.url}
                title={preview.asset.filename}
                style={{ width: "100%", height: "calc(100vh - 200px)", minHeight: 400, border: "1px solid var(--line)", borderRadius: 6 }}
              />
            ) : (
              <div className="muted" style={{ padding: 16 }}>
                This format ({preview.asset.mime || "unknown"}) can't be previewed in the browser. Download it to view.
                <div style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() =>
                      downloadMarketingAsset(preview.asset.id, preview.asset.filename).catch(() =>
                        setErr("Download failed.")
                      )
                    }
                  >
                    Download
                  </button>
                </div>
              </div>
            )}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
