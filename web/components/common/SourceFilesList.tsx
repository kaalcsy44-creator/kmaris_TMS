"use client";

import type { RfqSourceFile } from "@/lib/types";

// Auto-fill 로 업로드한 소스 파일 목록(파일명·아이템수·시각)을 계속 보여준다.
// 1단계(RFQ)와 동일 포맷 — 3·5단계에서 재사용. onRemove 없으면 읽기전용.
export default function SourceFilesList({
  files,
  onRemove,
}: {
  files: RfqSourceFile[];
  onRemove?: (index: number) => void;
}) {
  if (!files || files.length === 0) return null;
  return (
    <div className="ocr-files">
      <div className="ocr-files-head">📎 Auto-fill source files ({files.length})</div>
      <ul className="ocr-files-list">
        {files.map((f, i) => (
          <li key={`${f.name}-${i}`} className="ocr-file">
            <span className="ocr-file-icon">
              {(f.media_type || "").startsWith("image/") ? "🖼️" : "📄"}
            </span>
            <span className="ocr-file-name" title={f.name}>{f.name}</span>
            <span className="ocr-file-meta">
              {f.item_count} item{f.item_count === 1 ? "" : "s"}
              {f.at ? ` · ${f.at.slice(0, 10)}` : ""}
            </span>
            {onRemove ? (
              <button
                type="button"
                className="ocr-file-del"
                title="Remove from list"
                aria-label={`Remove ${f.name}`}
                onClick={() => onRemove(i)}
              >
                ✕
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
