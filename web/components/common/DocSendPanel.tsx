"use client";

import { useState } from "react";
import { getToken } from "@/lib/auth";

// 문서 생성(다운로드) + 이메일 미리보기 + 발송(생성파일 첨부) 공통 패널.
// 2·4·6단계 상세편집 페이지에서 공유한다. 단계별 API 차이는 콜백(onPreview/onSend/
// downloadUrl)으로 주입해 흡수한다.
export type DocFormat = "pdf" | "xlsx";

export interface DocPreview {
  to: string;
  subject: string;
  body: string;
  smtp_configured: boolean;
}

export default function DocSendPanel({
  title = "Document & Email",
  formats,
  downloadUrl,
  downloadName,
  onPreview,
  onSend,
  showNote = false,
  disabled = false,
  disabledReason,
  onSent,
}: {
  title?: string;
  formats: DocFormat[]; // 지원 포맷(다운로드·첨부 선택지)
  downloadUrl: (fmt: DocFormat) => string; // 인증 GET URL
  downloadName: (fmt: DocFormat) => string;
  // onPreview/onSend 를 주지 않으면 이메일 섹션은 감추고 파일 다운로드만 노출한다.
  onPreview?: (lang: "en" | "ko", note: string) => Promise<DocPreview>;
  onSend?: (p: {
    to: string;
    subject: string;
    body: string;
    format: DocFormat;
    lang: "en" | "ko";
    note: string;
  }) => Promise<{ sent_date?: string }>;
  showNote?: boolean; // 벤더/고객 메모 입력칸 노출(미리보기에 반영)
  disabled?: boolean;
  disabledReason?: string;
  onSent?: () => void;
}) {
  const emailEnabled = !!onPreview && !!onSend;
  const [lang, setLang] = useState<"en" | "ko">("en");
  const [note, setNote] = useState("");
  const [format, setFormat] = useState<DocFormat>(formats[0] ?? "pdf");
  const [preview, setPreview] = useState<DocPreview | null>(null);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function download(fmt: DocFormat) {
    setErr(null);
    try {
      const res = await fetch(downloadUrl(fmt), {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) throw new Error("File download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = downloadName(fmt);
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "File download failed");
    }
  }

  async function makePreview() {
    if (!onPreview) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const p = await onPreview(lang, note);
      setPreview(p);
      setTo(p.to);
      setSubject(p.subject);
      setBody(p.body);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Preview generation failed");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!onSend) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await onSend({ to, subject, body, format, lang, note });
      setMsg(`Email sent${r.sent_date ? `: ${r.sent_date}` : ""}`);
      setPreview(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Email sending failed");
      setBusy(false);
      return;
    }
    setBusy(false);
    onSent?.();
  }

  return (
    <div className="doc-send-panel">
      <div className="sub-h">{title}</div>
      {disabled && disabledReason ? (
        <div className="hint-inline" style={{ marginBottom: 8 }}>{disabledReason}</div>
      ) : null}

      <div className="doc-send-row">
        {formats.map((f) => (
          <button
            key={f}
            type="button"
            className="btn sm"
            disabled={disabled}
            onClick={() => download(f)}
            title={`Download ${f.toUpperCase()}`}
          >
            ↓ {f.toUpperCase()}
          </button>
        ))}
        <span className="doc-send-spacer" />
        <label className="doc-send-inline">
          Attach
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value as DocFormat)}
            disabled={disabled || formats.length <= 1}
          >
            {formats.map((f) => (
              <option key={f} value={f}>{f.toUpperCase()}</option>
            ))}
          </select>
        </label>
        {emailEnabled ? (
          <label className="doc-send-inline">
            Lang
            <select value={lang} onChange={(e) => setLang(e.target.value as "en" | "ko")} disabled={disabled}>
              <option value="en">EN</option>
              <option value="ko">KO</option>
            </select>
          </label>
        ) : null}
      </div>

      {showNote && emailEnabled ? (
        <div className="form-field" style={{ marginTop: 8 }}>
          <label>Note (optional)</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} disabled={disabled} />
        </div>
      ) : null}

      {!emailEnabled ? (
        err ? <div className="action-err" style={{ marginTop: 8 }}>{err}</div> : null
      ) : !preview ? (
        <div className="form-actions" style={{ marginTop: 8 }}>
          <button className="btn" onClick={makePreview} disabled={disabled || busy}>
            {busy ? "Preparing…" : "✉ Preview email"}
          </button>
          {msg ? <span className="action-ok">{msg}</span> : null}
          {err ? <span className="action-err">{err}</span> : null}
        </div>
      ) : (
        <>
          <div className="form-grid" style={{ marginTop: 8 }}>
            <div className="form-field">
              <label>Recipient email</label>
              <input value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="form-field">
              <label>Subject</label>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
          </div>
          <div className="form-field">
            <label>Body</label>
            <textarea className="po-textarea" value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          {!preview.smtp_configured ? (
            <div className="action-err">
              SMTP not configured — set SMTP_USER / SMTP_PASSWORD to enable sending.
            </div>
          ) : null}
          <div className="form-actions">
            <button
              className="btn primary"
              onClick={send}
              disabled={busy || !to || !preview.smtp_configured}
            >
              {busy ? "Sending…" : `Send (attach ${format.toUpperCase()})`}
            </button>
            <button className="btn" onClick={() => setPreview(null)} disabled={busy}>
              Cancel
            </button>
            {msg ? <span className="action-ok">{msg}</span> : null}
            {err ? <span className="action-err">{err}</span> : null}
          </div>
        </>
      )}
    </div>
  );
}
