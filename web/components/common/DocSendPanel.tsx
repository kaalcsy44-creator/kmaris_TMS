"use client";

import { useEffect, useRef, useState } from "react";
import { getToken } from "@/lib/auth";
import { renderEmailPreview } from "@/lib/api";
import CcField from "@/components/common/CcField";
import SignaturePicker from "@/components/common/SignaturePicker";
import { toggleBold, onBoldKey } from "@/lib/mdEdit";

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
//
// 작성 화면의 구조(Message 머리줄 · Edit↔Preview · 굵게 · 서명 미리보기 · 첨부 목록)는
// 홍보 메일 작성창(ComposeEmailModal)과 맞춘다 — 같은 일을 하는 두 화면이 서로 다르게
// 생겼을 이유가 없고, 미리보기 렌더도 서버의 같은 엔드포인트를 쓴다.
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
  // 메일 언어는 EN 고정(단계별 발송 화면에서 언어 선택 UI 제거). 서버 API 는 여전히
  // lang 을 받으므로 값만 넘긴다.
  const [lang] = useState<"en" | "ko">("en");
  const [format, setFormat] = useState<DocFormat>(formats[0] ?? "pdf");
  const [to, setTo] = useState("");
  const [from, setFrom] = useState("");
  // CC 는 칩(주소 배열)으로 다루고, 서버로는 예전처럼 쉼표 문자열로 넘긴다.
  // ccPending = 아직 Enter 로 확정하지 않고 입력칸에 남은 글자(발송 시 함께 싣는다).
  const [ccList, setCcList] = useState<string[]>([]);
  const [ccPending, setCcPending] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [notes, setNotes] = useState("");
  const [signature, setSignature] = useState("");
  const [includeSignature, setIncludeSignature] = useState(true);
  // 어느 담당자의 서명을 싣고 있는지(null = 로그인 사용자 = 서버가 준 기본값).
  const [sigOwner, setSigOwner] = useState<number | null>(null);
  // 생성 문서(견적서·발주서 등) 첨부 여부. 기본은 붙임 — 이 화면의 본래 목적이 문서 발송이다.
  const [includeDoc, setIncludeDoc] = useState(true);
  const [files, setFiles] = useState<File[]>([]);
  const [smtpConfigured, setSmtpConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const autoRan = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // 미리보기 — 수신자가 받게 될 HTML(서버가 발송과 같은 렌더러로 만든다).
  const [preview, setPreview] = useState(false);
  const [previewHtml, setPreviewHtml] = useState("");
  const previewSeq = useRef(0);
  // 서명만 따로 보는 미리보기(본문 전체 미리보기와 별개).
  const [sigPreview, setSigPreview] = useState(false);
  const [sigHtml, setSigHtml] = useState("");
  const sigSeq = useRef(0);
  // 첨부 미리보기(패널 안 인라인) — 만든 object URL 은 닫을 때/떠날 때 정리한다.
  const [filePreview, setFilePreview] =
    useState<{ name: string; mime: string; url: string } | null>(null);
  const objectUrls = useRef<string[]>([]);
  useEffect(
    () => () => {
      for (const u of objectUrls.current) URL.revokeObjectURL(u);
    },
    []
  );

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

  async function fetchDoc(fmt: DocFormat): Promise<Blob> {
    const res = await fetch(downloadUrl(fmt), {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) throw new Error("File download failed");
    return res.blob();
  }

  async function download(fmt: DocFormat) {
    setErr(null);
    try {
      const url = URL.createObjectURL(await fetchDoc(fmt));
      const a = document.createElement("a");
      a.href = url;
      a.download = downloadName(fmt);
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "File download failed");
    }
  }

  // ── 첨부 미리보기 ─────────────────────────────────────────────────
  // 새 탭은 팝업 차단에 걸려 아무 반응도 없어 보이므로 이 패널 안에서 연다.
  // PDF·이미지는 브라우저가 그대로 그려 준다.
  function showPreview(name: string, mime: string, url: string) {
    objectUrls.current.push(url);
    setFilePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { name, mime, url };
    });
  }
  function closeFilePreview() {
    setFilePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
  }
  // 생성 문서는 서버가 그 자리에서 만든다 — 내려받은 것과 같은 파일을 그대로 띄운다.
  async function previewGenerated() {
    setErr(null);
    try {
      const blob = await fetchDoc(format);
      showPreview(downloadName(format), blob.type || "application/pdf", URL.createObjectURL(blob));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not open the preview.");
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
      setSigOwner(null);   // 초안을 다시 만들면 서명도 로그인 사용자 것으로 돌아간다
      setSmtpConfigured(p.smtp_configured);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Preview generation failed");
    } finally {
      setBusy(false);
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

  // 실제 발송되는 본문 = body + notes(서버 compose_body 와 같은 규칙: 빈 조각은 건너뛰고
  // 사이에 빈 줄 하나). 서명은 서버가 표/평문 규칙으로 따로 붙이므로 여기서 합치지 않는다.
  const composedBody = [body.trim(), notes.trim()].filter(Boolean).join("\n\n");

  // 미리보기가 열려 있을 때만, 입력이 멈추면 서버 렌더를 갱신한다.
  useEffect(() => {
    if (!preview) return;
    const seq = ++previewSeq.current;
    const t = setTimeout(async () => {
      try {
        const r = await renderEmailPreview(composedBody, signature, includeSignature);
        if (seq === previewSeq.current) setPreviewHtml(r.html);
      } catch {
        /* 편집 중 일시적 실패는 무시 — 다음 입력에서 다시 시도된다. */
      }
    }, 300);
    return () => clearTimeout(t);
  }, [preview, composedBody, signature, includeSignature]);

  // 서명 미리보기 — 본문 없이 서명만 같은 렌더러로 그린다(평문 칸이라 실제 표 서명을 확인).
  useEffect(() => {
    if (!sigPreview) return;
    const n = ++sigSeq.current;
    const t = setTimeout(async () => {
      try {
        const r = await renderEmailPreview("", signature, true);
        if (n === sigSeq.current) setSigHtml(r.html);
      } catch {
        /* 편집 중 일시적 실패는 무시 */
      }
    }, 300);
    return () => clearTimeout(t);
  }, [sigPreview, signature]);

  async function send() {
    if (!onSend) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const cc = [...ccList, ...(ccPending.trim() ? [ccPending.trim()] : [])].join(", ");
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

  // 첨부 — 이 메일에 무엇이 붙는지 한 곳에서 다 보이게 한다. 생성 문서도 체크를 끄면
  // 빠진다(서버가 아예 만들지 않는다). "무엇을 보내는가"는 수신자와 같은 편이라
  // 왼쪽 칸(봉투)에 둔다 — 본문을 길게 편집하는 동안에도 눈에 남아 있어야 한다.
  const attachBlock = (
    <div className="form-field">
      <label className="mail-attach-head">
        <span>Attachments</span>
        <span className={`mail-attach-size${overSize ? " over" : ""}`}>
          {fmtSize(attachTotal)} / {fmtSize(MAX_ATTACH_TOTAL)}
        </span>
      </label>
      {/* 생성 문서는 홍보 메일의 '저장된 파일' 자리에 해당한다 — 같은 목록 행 구조로,
          체크로 붙이고 끄며 Preview 로 실제 파일을 확인한다. */}
      <div className="compose-assets">
        {/* 체크박스+파일명만 <label> 로 묶는다 — 포맷 셀렉트·버튼까지 감싸면 그것들을
            누를 때 첨부 체크가 함께 뒤집힌다. */}
        <div className={`compose-asset generated${includeDoc ? " on" : ""}`}>
          <label className="compose-asset-pick" title="이 문서를 첨부합니다(끄면 본문만 발송)">
            <input
              type="checkbox"
              checked={includeDoc}
              onChange={(e) => setIncludeDoc(e.target.checked)}
            />
            <span className="compose-asset-name">{downloadName(format)}</span>
          </label>
          {formats.length > 1 ? (
            <select
              className="compose-asset-fmt"
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
          {format === "pdf" ? (
            <button
              type="button"
              className="compose-asset-eye"
              title="Preview"
              onClick={previewGenerated}
            >
              Preview
            </button>
          ) : null}
          <button
            type="button"
            className="compose-asset-eye"
            title="이 문서를 내려받아 확인"
            onClick={() => download(format)}
          >
            ↓
          </button>
        </div>
      </div>
      <div className="compose-upload">
        <button
          type="button"
          className="btn ghost"
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
      {files.length ? (
        <ul className="compose-files">
          {files.map((f, i) => (
            <li key={`${f.name}:${f.size}:${i}`}>
              📎 {f.name} <span className="compose-asset-size">{fmtSize(f.size)}</span>
              <button
                type="button"
                className="compose-asset-eye"
                title="Preview"
                onClick={() => showPreview(f.name, f.type, URL.createObjectURL(f))}
              >
                Preview
              </button>
              <button
                type="button"
                className="compose-file-x"
                title="Remove"
                onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {filePreview ? (
        <div className="compose-file-preview">
          <div className="compose-file-preview-head">
            <span className="compose-asset-name">{filePreview.name}</span>
            <button type="button" className="compose-file-x" onClick={closeFilePreview}>
              ×
            </button>
          </div>
          {filePreview.mime.startsWith("image/") ? (
            <img src={filePreview.url} alt={filePreview.name} />
          ) : filePreview.mime.includes("pdf") ? (
            <iframe src={filePreview.url} title={filePreview.name} />
          ) : (
            <div className="hint-inline" style={{ padding: 12 }}>
              This file type ({filePreview.mime || "unknown"}) cannot be previewed in the
              browser.
            </div>
          )}
        </div>
      ) : null}
      {overSize ? (
        <div className="action-err" style={{ marginTop: 4 }}>
          첨부 용량이 한도를 넘었습니다 — 파일을 줄여주세요.
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="doc-send-panel">
      <div className="sub-h">{title}</div>
      {disabled && disabledReason ? (
        <div className="hint-inline" style={{ marginBottom: 8 }}>{disabledReason}</div>
      ) : null}

      {/* 이메일을 쓰지 않는 다운로드 전용 모드에만 남는 줄(포맷별 내려받기).
          이메일 모드에서는 첨부 목록의 Preview·↓ 로 같은 파일을 보고 받고, 초안 재생성은
          Message 머리줄에 있다. */}
      {!emailEnabled ? (
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
        </div>
      ) : null}

      {!emailEnabled ? (
        err ? <div className="action-err" style={{ marginTop: 8 }}>{err}</div> : null
      ) : (
        <>
        {/* 좌: 봉투(누구에게·무엇을 붙여) · 우: 내용(제목·본문·서명).
            홍보 메일 작성창과 같은 2단이다 — 세로로만 쌓으면 본문을 보려고 스크롤하는
            동안 수신자·첨부가 화면에서 사라진다. 각 칸 안에서는 1열로 쌓는다. */}
        <div className="compose-split doc-send-split">
          <div className="compose-col">
            <div className="compose-section-title">Recipients</div>
            <div className="form-field">
              <label>From (sender)</label>
              <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="sales@k-maris.com" />
            </div>
            <div className="hint-inline doc-send-from-hint">
              From only changes the sender if it is a verified send-as alias on the SMTP account; otherwise the provider keeps the configured sender.
            </div>
            <div className="form-field">
              <label>Recipient email</label>
              <input value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <CcField
              value={ccList}
              onChange={setCcList}
              onPendingChange={setCcPending}
              label="CC"
              inputId="doc-cc-input"
            />
            {attachBlock}
          </div>

          <div className="compose-col">
            {/* Message 머리줄 — 초안 재생성 + 편집↔미리보기. 홍보 메일 작성창과 같은 구조로,
                미리보기는 서버가 발송용 HTML 로 렌더한 결과라 수신자가 볼 모습 그대로다. */}
            <div className="compose-section-title doc-send-msg-head">
              Message
              <span className="compose-tpl">
                <button
                  type="button"
                  className="chip-btn"
                  onClick={makePreview}
                  disabled={disabled || busy}
                  title="Regenerate the draft from the template (overwrites your edits)"
                >
                  {busy ? "…" : "↻ Regenerate draft"}
                </button>
                <span className="compose-tpl-sep" />
                <button
                  type="button"
                  className={`chip-btn${preview ? "" : " on"}`}
                  onClick={() => setPreview(false)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={`chip-btn${preview ? " on" : ""}`}
                  onClick={() => setPreview(true)}
                >
                  Preview
                </button>
              </span>
            </div>

            {preview ? (
              <div className="compose-preview">
                <div className="compose-preview-subj">
                  <b>Subject:</b> {subject}
                </div>
                {previewHtml ? (
                  <div
                    className="compose-preview-body"
                    dangerouslySetInnerHTML={{ __html: previewHtml }}
                  />
                ) : (
                  <div className="hint-inline">Rendering…</div>
                )}
                <div className="compose-hint">
                  This is what the recipient will see
                  {includeSignature ? " (signature included)" : ""}. Attachments are listed
                  under Recipients.
                </div>
              </div>
            ) : (
              <>
                <div className="form-field">
                  <label>Subject</label>
                  <input value={subject} onChange={(e) => setSubject(e.target.value)} />
                </div>
                <div className="form-field">
                  <label className="mail-sig-head">
                    <span>Body</span>
                    <span className="mail-sig-tools">
                      <button
                        type="button"
                        className="chip-btn md-bold"
                        title="Bold the selection (Ctrl+B) — stored in the body as **text**"
                        onClick={() => toggleBold(bodyRef.current, setBody)}
                      >
                        B
                      </button>
                    </span>
                  </label>
                  <textarea
                    ref={bodyRef}
                    className="po-textarea"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    onKeyDown={(e) => onBoldKey(e, setBody)}
                  />
                </div>
                <div className="compose-hint">
                  Bold shows as <code>**text**</code> (select, then B or Ctrl+B).
                </div>

                {/* Notes(본문 뒤 문단) · Signature — 오른쪽 칸 안에서는 1열로 쌓는다. */}
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
                    <span className="mail-sig-title">
                      Signature
                      {/* 담당자별 서명 — 고르면 그 사람의 서명이 그대로 실린다. */}
                      <SignaturePicker
                        lang={lang}
                        value={sigOwner}
                        disabled={!includeSignature}
                        onPick={(id, text) => {
                          setSigOwner(id);
                          setSignature(text);
                        }}
                      />
                    </span>
                    <span className="mail-sig-tools">
                      <label className="mail-sig-toggle">
                        <input
                          type="checkbox"
                          checked={includeSignature}
                          onChange={(e) => setIncludeSignature(e.target.checked)}
                        />
                        Include
                      </label>
                      {/* 서명 칸은 평문이라 실제 모습(표 서명)을 여기서 바로 확인한다. */}
                      <button
                        type="button"
                        className={`chip-btn${sigPreview ? "" : " on"}`}
                        onClick={() => setSigPreview(false)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className={`chip-btn${sigPreview ? " on" : ""}`}
                        onClick={() => setSigPreview(true)}
                      >
                        Preview
                      </button>
                    </span>
                  </label>
                  {sigPreview ? (
                    <div
                      className="compose-preview-body sig"
                      dangerouslySetInnerHTML={{ __html: sigHtml }}
                    />
                  ) : (
                    <textarea
                      className="mail-sig"
                      value={signature}
                      onChange={(e) => setSignature(e.target.value)}
                      disabled={!includeSignature}
                    />
                  )}
                </div>
                <div className="compose-hint">
                  This is the signature saved under Settings → Email Templates → Signature.
                  Editing it here applies to this send only, and sends the edited plain text
                  instead of the table signature.
                </div>
              </>
            )}
          </div>
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
