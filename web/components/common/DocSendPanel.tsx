"use client";

import { useEffect, useRef, useState } from "react";
import { getToken } from "@/lib/auth";
import { saveEmailSignature } from "@/lib/api";

// 문서 생성(다운로드) + 이메일 미리보기 + 발송(첨부) 공통 패널.
// 2·4·6단계 상세편집 페이지에서 공유한다. 단계별 API 차이는 콜백(onPreview/onSend/
// downloadUrl)으로 주입해 흡수한다.
//
// 메일 본문은 세 조각으로 나눠 다룬다 — 서버가 발송 시 이 순서로 합친다:
//     body(템플릿 초안) → notes(이번 건에만 덧붙일 문단) → signature(포함 여부 토글)
// 서버 미리보기는 서명을 뺀 body 와 signature 를 따로 내려준다(합치면 기존 메일과 동일).
//
// 첨부는 생성 문서(Attach 포맷으로 고른 PDF/XLSX — 서버가 붙인다) + 여기서 올린 파일.
// 올린 파일은 보관하지 않고 발송 시에만 붙는다.
export type DocFormat = "pdf" | "xlsx";

export interface DocPreview {
  to: string;
  from?: string;     // 서버가 제안하는 기본 발신자(From)
  subject: string;
  body: string;
  signature?: string;
  smtp_configured: boolean;
}

const MAX_ATTACH_TOTAL = 18 * 1024 * 1024;  // 서버(mail_compose.MAX_ATTACH_TOTAL)와 같은 값

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function DocSendPanel({
  title = "Document & Email",
  formats,
  downloadUrl,
  downloadName,
  onPreview,
  onSend,
  disabled = false,
  disabledReason,
  onSent,
}: {
  title?: string;
  formats: DocFormat[]; // 지원 포맷(다운로드·첨부 선택지)
  downloadUrl: (fmt: DocFormat) => string; // 인증 GET URL
  downloadName: (fmt: DocFormat) => string;
  // onPreview/onSend 를 주지 않으면 이메일 섹션은 감추고 파일 다운로드만 노출한다.
  onPreview?: (lang: "en" | "ko") => Promise<DocPreview>;
  onSend?: (p: {
    to: string;
    from: string;
    cc: string;
    subject: string;
    body: string;
    notes: string;
    signature: string;
    includeSignature: boolean;
    format: DocFormat;
    includeDocument: boolean;
    lang: "en" | "ko";
    files: File[];
  }) => Promise<{ sent_date?: string }>;
  disabled?: boolean;
  disabledReason?: string;
  onSent?: () => void;
}) {
  const emailEnabled = !!onPreview && !!onSend;
  const [lang, setLang] = useState<"en" | "ko">("en");
  const [format, setFormat] = useState<DocFormat>(formats[0] ?? "pdf");
  const [to, setTo] = useState("");
  const [from, setFrom] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [notes, setNotes] = useState("");
  const [signature, setSignature] = useState("");
  const [includeSignature, setIncludeSignature] = useState(true);
  const [sigMsg, setSigMsg] = useState("");
  // 생성 문서(견적서·발주서 등) 첨부 여부. 기본은 붙임 — 이 화면의 본래 목적이 문서 발송이다.
  const [includeDoc, setIncludeDoc] = useState(true);
  const [files, setFiles] = useState<File[]>([]);
  const [smtpConfigured, setSmtpConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const autoRan = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 표시 용량은 업로드분만 — 생성 문서는 발송 시점에 서버가 만들어 크기를 미리 알 수 없다.
  const attachTotal = files.reduce((n, f) => n + f.size, 0);
  const overSize = attachTotal > MAX_ATTACH_TOTAL;
  const attachCount = files.length + (includeDoc ? 1 : 0);

  function addFiles(picked: FileList | null) {
    if (!picked?.length) return;
    // 같은 파일을 두 번 고르면 한 번만 남긴다(이름+크기 기준).
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      const next = [...prev];
      for (const f of Array.from(picked)) {
        if (!seen.has(`${f.name}:${f.size}`)) next.push(f);
      }
      return next;
    });
    setErr(null);
  }

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

  // 미리보기(초안 생성) — to/from/subject/body/signature 를 서버 기본값으로 채운다.
  // 미리보기 전에도 필드가 기본값으로 보이도록 마운트 시 1회 자동 실행(아래 useEffect).
  // Notes·첨부는 사용자가 넣은 것이므로 초안을 다시 만들어도 건드리지 않는다.
  async function makePreview() {
    if (!onPreview) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const p = await onPreview(lang);
      setTo(p.to);
      setFrom(p.from ?? "");
      setSubject(p.subject);
      setBody(p.body);
      setSignature(p.signature ?? "");
      setSmtpConfigured(p.smtp_configured);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Preview generation failed");
    } finally {
      setBusy(false);
    }
  }

  /** 지금 서명을 내 기본 서명으로 저장 — 이후 모든 단계 발송 화면에 채워진다. */
  async function saveSignatureAsDefault() {
    setSigMsg("");
    try {
      await saveEmailSignature(lang, signature);
      setSigMsg("Saved as your default.");
      setTimeout(() => setSigMsg(""), 2000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Signature save failed");
    }
  }

  // 이메일 탭 진입 시 서버 기본값으로 필드를 자동 채운다(1회).
  useEffect(() => {
    if (emailEnabled && !disabled && !autoRan.current) {
      autoRan.current = true;
      makePreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailEnabled, disabled]);

  async function send() {
    if (!onSend) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await onSend({
        to, from, cc, subject, body, notes, signature, includeSignature,
        format, includeDocument: includeDoc, lang, files,
      });
      setMsg(`Email sent${r.sent_date ? `: ${r.sent_date}` : ""}`);
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

      {/* 이메일을 쓰지 않는 다운로드 전용 모드에서만 포맷별 내려받기 버튼을 둔다.
          이메일 모드에서는 첨부 칩 안의 ↓ 로 같은 파일을 받을 수 있어 중복이다. */}
      <div className="doc-send-row">
        {!emailEnabled
          ? formats.map((f) => (
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
            ))
          : null}
        <span className="doc-send-spacer" />
        {emailEnabled ? (
          <label className="doc-send-inline">
            Lang
            <select value={lang} onChange={(e) => setLang(e.target.value as "en" | "ko")} disabled={disabled}>
              <option value="en">EN</option>
              <option value="ko">KO</option>
            </select>
          </label>
        ) : null}
        {emailEnabled ? (
          <button
            type="button"
            className="btn sm"
            onClick={makePreview}
            disabled={disabled || busy}
            title="Regenerate the draft from the template (overwrites your edits)"
          >
            {busy ? "…" : "↻ Regenerate draft"}
          </button>
        ) : null}
      </div>

      {!emailEnabled ? (
        err ? <div className="action-err" style={{ marginTop: 8 }}>{err}</div> : null
      ) : (
        <>
          {/* 주소 3열 → Subject 는 아래 전폭 단독 행(제목이 길어 잘리던 문제). */}
          <div className="mail-addr-grid">
            <div className="form-field">
              <label>From (sender)</label>
              <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="sales@k-maris.com" />
            </div>
            <div className="form-field">
              <label>Recipient email</label>
              <input value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="form-field">
              <label>CC</label>
              <input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="comma-separated (optional)" />
            </div>
          </div>
          <div className="hint-inline" style={{ marginTop: 2 }}>
            From only changes the sender if it is a verified send-as alias on the SMTP account; otherwise the provider keeps the configured sender.
          </div>
          <div className="form-field" style={{ marginTop: 8 }}>
            <label>Subject</label>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div className="form-field" style={{ marginTop: 8 }}>
            <label>Body</label>
            <textarea className="po-textarea" value={body} onChange={(e) => setBody(e.target.value)} />
          </div>

          {/* Notes(본문 뒤 문단) · Signature 는 본문만큼 길 일이 없어 좌우 2열 · 절반 높이. */}
          <div className="mail-compose-2col">
            <div className="form-field">
              <label>Notes (optional)</label>
              <textarea
                className="mail-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Added after the body, before the signature."
              />
            </div>

            <div className="form-field">
              <label className="mail-sig-head">
                <span>Signature</span>
                <span className="mail-sig-tools">
                  {sigMsg ? <span className="action-ok">{sigMsg}</span> : null}
                  <label className="mail-sig-toggle">
                    <input
                      type="checkbox"
                      checked={includeSignature}
                      onChange={(e) => setIncludeSignature(e.target.checked)}
                    />
                    Include
                  </label>
                  <button
                    type="button"
                    className="btn ghost xs"
                    onClick={saveSignatureAsDefault}
                    disabled={!includeSignature}
                    title="이 서명을 내 기본 서명으로 저장 — 이후 모든 단계 발송 화면에 채워집니다"
                  >
                    Save as default
                  </button>
                </span>
              </label>
              <textarea
                className="mail-sig"
                value={signature}
                onChange={(e) => setSignature(e.target.value)}
                disabled={!includeSignature}
              />
            </div>
          </div>

          {/* 첨부 — 이 메일에 무엇이 붙는지 한 곳에서 다 보이게 한다.
              생성 문서도 체크를 끄면 빠진다(서버가 아예 만들지 않는다). 포맷 선택·내려받기도
              이 칩 위에 둬서 상단에 따로 두던 Attach 드롭다운·다운로드 버튼을 없앴다. */}
          <div className="form-field" style={{ marginTop: 8 }}>
            <label className="mail-attach-head">
              <span>Attachments</span>
              <span className={`mail-attach-size${overSize ? " over" : ""}`}>
                {fmtSize(attachTotal)} / {fmtSize(MAX_ATTACH_TOTAL)}
              </span>
            </label>
            <div className="mail-attach-list">
              <span className={`mail-attach generated${includeDoc ? "" : " off"}`}>
                <label className="mail-attach-pick" title="이 문서를 첨부합니다(끄면 본문만 발송)">
                  <input
                    type="checkbox"
                    checked={includeDoc}
                    onChange={(e) => setIncludeDoc(e.target.checked)}
                  />
                  <span className="mail-attach-name">{downloadName(format)}</span>
                </label>
                {formats.length > 1 ? (
                  <select
                    className="mail-attach-fmt"
                    value={format}
                    onChange={(e) => setFormat(e.target.value as DocFormat)}
                    disabled={!includeDoc}
                    title="첨부 형식"
                  >
                    {formats.map((f) => (
                      <option key={f} value={f}>{f.toUpperCase()}</option>
                    ))}
                  </select>
                ) : null}
                <button
                  type="button"
                  className="mail-attach-dl"
                  title="이 문서를 내려받아 확인"
                  onClick={() => download(format)}
                >
                  ↓
                </button>
              </span>
              {files.map((f, i) => (
                <span key={`${f.name}:${f.size}:${i}`} className="mail-attach">
                  <span className="mail-attach-name">📎 {f.name}</span>
                  <span className="mail-attach-size-sm">{fmtSize(f.size)}</span>
                  <button
                    type="button"
                    className="mail-attach-x"
                    title="Remove"
                    onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    ✕
                  </button>
                </span>
              ))}
              <button
                type="button"
                className="btn ghost xs"
                onClick={() => fileRef.current?.click()}
                disabled={disabled}
              >
                + Attach file
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = "";  // 같은 파일을 지웠다 다시 고를 수 있게 초기화
                }}
              />
            </div>
            {overSize ? (
              <div className="action-err" style={{ marginTop: 4 }}>
                첨부 용량이 한도를 넘었습니다 — 파일을 줄여주세요.
              </div>
            ) : null}
          </div>

          {!smtpConfigured ? (
            <div className="action-err">
              SMTP not configured — set SMTP_USER / SMTP_PASSWORD to enable sending.
            </div>
          ) : null}
          <div className="form-actions">
            <button
              className="btn primary"
              onClick={send}
              disabled={disabled || busy || !to || !smtpConfigured || overSize}
            >
              {busy ? "Sending…" : attachCount ? `Send (${attachCount} attached)` : "Send"}
            </button>
            {msg ? <span className="action-ok">{msg}</span> : null}
            {err ? <span className="action-err">{err}</span> : null}
          </div>
        </>
      )}
    </div>
  );
}
