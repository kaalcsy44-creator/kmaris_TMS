"use client";

// 접수 첨부 → 드라이브 프로젝트 폴더 `01 RFQ`. RFQ 저장 때 함께 올라간다(저장된 딜이면
// "Upload now" 로 바로 올릴 수도 있다). 메신저로 받은 건은 대화를 붙여넣으면
// `00 접수내용.md` 로 남는다 — 메신저 대화는 다른 곳에 기록이 남지 않기 때문이다.
// 상태(고른 파일·글)는 폼이 들고 있다: 저장 버튼이 그것을 함께 보내야 해서다.

import { DRIVE_MAX_UPLOAD, type DriveUploadResult } from "@/lib/api";

export type DriveIntake = { files: File[]; text: string };
export const EMPTY_INTAKE: DriveIntake = { files: [], text: "" };

function fmtSize(n: number) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
}

/** 결과 한 줄 요약 — 저장 메시지 옆에 붙인다. */
export function intakeSummary(r: DriveUploadResult): string {
  const parts = [`Drive: ${r.saved.length} saved to 01 RFQ`];
  if (r.skipped.length) parts.push(`${r.skipped.length} skipped (over 50MB)`);
  if (r.failed.length) parts.push(`${r.failed.length} failed`);
  return parts.join(" · ");
}

export default function DriveIntakePanel({
  value,
  onChange,
  canUploadNow,
  onUploadNow,
  busy,
  result,
  error,
}: {
  value: DriveIntake;
  onChange: (v: DriveIntake) => void;
  /** 이미 저장된 딜이면 저장 없이 바로 올리는 버튼을 보인다. */
  canUploadNow: boolean;
  onUploadNow: () => void;
  busy: boolean;
  result: DriveUploadResult | null;
  error: string | null;
}) {
  const tooBig = value.files.filter((f) => f.size > DRIVE_MAX_UPLOAD);

  function add(list: FileList | null) {
    if (!list || !list.length) return;
    onChange({ ...value, files: [...value.files, ...Array.from(list)] });
  }

  return (
    <div className="drive-intake">
      <div className="drive-intake-head">
        <span className="ocr-bar-label">📁 Intake files → Drive · 01 RFQ</span>
        <input type="file" multiple onChange={(e) => { add(e.target.files); e.target.value = ""; }} disabled={busy} />
      </div>
      <div className="hint-inline">
        Saved with their original names when you save this RFQ (same name → “(2)”, never overwritten).
        Files used for Auto-fill are added here too. Over 50MB is skipped.
      </div>

      {value.files.length ? (
        <ul className="ocr-files-list">
          {value.files.map((f, i) => (
            <li key={`${f.name}-${i}`} className={`ocr-file${f.size > DRIVE_MAX_UPLOAD ? " too-big" : ""}`}>
              <span className="ocr-file-icon">{(f.type || "").startsWith("image/") ? "🖼️" : "📄"}</span>
              <span className="ocr-file-name" title={f.name}>{f.name || "(pasted image)"}</span>
              <span className="ocr-file-meta">
                {fmtSize(f.size)}{f.size > DRIVE_MAX_UPLOAD ? " · over 50MB — will be skipped" : ""}
              </span>
              <button
                type="button"
                className="ocr-file-del"
                aria-label={`Remove ${f.name}`}
                title="Remove"
                disabled={busy}
                onClick={() => onChange({ ...value, files: value.files.filter((_, k) => k !== i) })}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <label className="drive-intake-text">
        <span>Messenger conversation (WhatsApp · WeChat · KakaoTalk…) → saved as “00 접수내용.md”</span>
        <textarea
          rows={4}
          value={value.text}
          disabled={busy}
          placeholder="Paste the chat that carried this RFQ — it is kept nowhere else."
          onChange={(e) => onChange({ ...value, text: e.target.value })}
        />
      </label>

      {canUploadNow ? (
        <button
          type="button"
          className="btn sm"
          disabled={busy || (!value.files.length && !value.text.trim())}
          onClick={onUploadNow}
        >
          {busy ? "Uploading…" : "⬆ Upload now"}
        </button>
      ) : null}
      {tooBig.length ? (
        <div className="hint-inline warn">{tooBig.length} file(s) over 50MB will not be uploaded.</div>
      ) : null}

      {error ? <div className="action-err">{error}</div> : null}
      {result ? (
        <div className="drive-intake-result">
          <div className="action-ok">
            {intakeSummary(result)} ·{" "}
            <a href={result.rfq_folder_url} target="_blank" rel="noopener noreferrer">open folder</a>
          </div>
          {[...result.skipped, ...result.failed].map((x, i) => (
            <div key={i} className="hint-inline warn">⚠ {x.name} — {x.reason}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
