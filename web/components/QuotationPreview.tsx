"use client";

import { createPortal } from "react-dom";
import { useResizable } from "@/lib/useResizable";

// 견적서 미리보기 — 저장된 문서와 동일한 A4 PDF 를 iframe 으로 인라인 표시한다.
// 7단계 Commercial Invoice 미리보기(DocPreviewButton)와 동일한 모달 구조·스타일.
export default function QuotationPreview({
  filename,
  pdfUrl,
  onClose,
  onDownloadPdf,
  onDownloadXlsx,
  busy,
  err,
}: {
  filename: string;
  pdfUrl: string;
  onClose: () => void;
  onDownloadPdf: () => void;
  onDownloadXlsx: () => void;
  busy?: boolean;
  err?: string | null;
}) {
  const resize = useResizable({ storageKey: "ktms:quote-preview-size", minW: 420, minH: 320 });
  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="doc-preview-backdrop" onClick={onClose}>
      <div
        ref={resize.ref}
        className="doc-preview-modal pl-modal--resizable"
        style={resize.style}
        onClick={(e) => e.stopPropagation()}
      >
        {resize.handles}
        <div className="doc-preview-head">
          <span className="doc-preview-title">{filename}</span>
          <div className="doc-preview-acts">
            <button className="btn sm" onClick={onDownloadXlsx} disabled={busy}>
              {busy ? "…" : "Excel Download (purchase·margin)"}
            </button>
            <button className="btn sm doc-preview-save" onClick={onDownloadPdf} disabled={busy}>
              PDF Download (sales)
            </button>
            <button className="btn sm" onClick={onClose}>Close</button>
          </div>
        </div>
        {err ? <div className="action-err" style={{ margin: "6px 10px" }}>{err}</div> : null}
        <iframe className="doc-preview-frame" src={pdfUrl} title="Quotation Preview" />
      </div>
    </div>,
    document.body,
  );
}
