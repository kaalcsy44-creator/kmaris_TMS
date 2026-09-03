"use client";

import { useState } from "react";
import Modal from "@/components/common/Modal";
import { PrintBook, printBookPdf, printBookXlsx } from "@/lib/api";

/** 미리보기에 그리는 최대 줄 수 — 파일에는 전부 들어간다(아래 안내 문구로 밝힌다). */
const PREVIEW_ROWS = 500;

/** 받은 Blob 을 파일로 내려 준다(Excel·PDF 공통). */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // 브라우저가 다 읽고 난 뒤에 놓아 준다 — 바로 revoke 하면 빈 파일이 떨어진다.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * 목록 인쇄 단추 — 지금 화면에 보이는 표를 미리 보고 Excel·PDF 로 받는다.
 *
 * build() 를 누를 때마다 새로 부르는 이유: 검색어나 열 필터로 좁혀 놓은 결과가 곧
 * 인쇄물이어야 한다. 표를 그리는 쪽이 이미 걸러 둔 줄을 그대로 넘겨받아, 미리보기와
 * 파일과 화면 셋이 같은 목록을 말하게 한다.
 */
export default function PrintListButton({ build }: { build: () => PrintBook }) {
  const [book, setBook] = useState<PrintBook | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn"
        title="Preview and download this list (Excel · PDF)"
        onClick={() => setBook(build())}
      >
        🖨 Print
      </button>
      {book ? <PrintPreview book={book} onClose={() => setBook(null)} /> : null}
    </>
  );
}

function PrintPreview({ book, onClose }: { book: PrintBook; onClose: () => void }) {
  const [busy, setBusy] = useState<"" | "xlsx" | "pdf">("");
  const [err, setErr] = useState("");
  const shown = book.rows.slice(0, PREVIEW_ROWS);

  async function download(kind: "xlsx" | "pdf") {
    setBusy(kind);
    setErr("");
    try {
      const blob = kind === "xlsx" ? await printBookXlsx(book) : await printBookPdf(book);
      const stem = (book.title || "List").replace(/[^A-Za-z0-9 \-_]/g, "_").trim().replace(/\s+/g, "_");
      saveBlob(blob, `${stem || "List"}_List_${stamp()}.${kind}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Download failed");
    } finally {
      setBusy("");
    }
  }

  return (
    <Modal title={`🖨 ${book.title} list`} onClose={onClose} maxWidth={1240}>
      <div className="plist">
        <div className="plist-bar">
          <span className="plist-sub">
            {[book.subtitle, `${book.rows.length} rows`].filter(Boolean).join(" · ")}
          </span>
          <button className="btn" disabled={!!busy} onClick={() => download("xlsx")}>
            {busy === "xlsx" ? "Preparing…" : "⬇ Excel"}
          </button>
          <button className="btn primary" disabled={!!busy} onClick={() => download("pdf")}>
            {busy === "pdf" ? "Preparing…" : "⬇ PDF"}
          </button>
          {err ? <span className="action-err">{err}</span> : null}
        </div>

        <div className="plist-page">
          <div className="plist-head">
            <b>{book.title.toUpperCase()} LIST</b>
            <span>{new Date().toISOString().slice(0, 10)}</span>
          </div>
          <div className="table-wrap plist-wrap">
            <table className="mini wide plist-table">
              <thead>
                <tr>
                  {book.columns.map((c, i) => (
                    <th key={i} style={c.align === "right" ? { textAlign: "right" } : undefined}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r, ri) => (
                  <tr key={ri}>
                    {book.columns.map((c, ci) => (
                      <td key={ci} style={c.align === "right" ? { textAlign: "right" } : undefined}>
                        {r[ci] || <span className="dash">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
                {shown.length === 0 ? (
                  <tr>
                    <td colSpan={book.columns.length}>No rows to print.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {book.rows.length > shown.length ? (
            <div className="plist-more">
              Showing the first {shown.length} of {book.rows.length} rows — the file has them all.
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
