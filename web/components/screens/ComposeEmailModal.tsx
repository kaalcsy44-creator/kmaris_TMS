"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchSettingsCustomers,
  fetchMarketingAssets,
  marketingComposeDefaults,
  saveMarketingTemplate,
  resetMarketingTemplate,
  renderEmailPreview,
  sendMarketingEmail,
  type MarketingAsset,
} from "@/lib/api";
import { useCachedData } from "@/lib/useCachedData";
import type { CustomerOption, SettingsCustomer } from "@/lib/types";
import Modal from "@/components/common/Modal";
import CustomerSelect from "@/components/common/CustomerSelect";

type TplKind = "intro" | "brochure";
type Lang = "en" | "ko";

function fmtSize(n: number): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ── 템플릿 토큰 ────────────────────────────────────────────────────────────────
// 저장한 템플릿에는 수신자 이름 대신 {{contact}}·{{customer}} 토큰이 들어간다.
// 화면에는 항상 치환된 결과(실제 이름)를 보여주고, 사용자가 고친 내용을 다시
// 토큰 형태로 되돌려 저장한다 — 그래서 수신자를 바꾸면 이름이 자동으로 따라 바뀐다.
const CONTACT_FALLBACK: Record<Lang, string> = { en: "Sir/Madam", ko: "담당자" };

function renderTokens(tpl: string, contact: string, customer: string, lang: Lang): string {
  return (tpl ?? "")
    .replaceAll("{{contact}}", contact.trim() || CONTACT_FALLBACK[lang])
    .replaceAll("{{customer}}", customer.trim());
}

// 화면 텍스트 → 템플릿 원본. 치환에 쓴 값과 똑같은 문자열을 토큰으로 되돌린다.
// 두 글자 이하 값은 본문 곳곳에 우연히 걸릴 수 있어 건드리지 않고, 영문 이름은
// 단어 경계를 확인해 "Sam" 이 "Sample" 안에서 잘리는 일이 없게 한다.
function backToToken(text: string, value: string, token: string): string {
  const v = value.trim();
  if (v.length < 3) return text;
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ascii = /^[\x20-\x7F]+$/.test(v);
  return text.replace(new RegExp(ascii ? `\\b${esc}\\b` : esc, "g"), token);
}

function toTokens(text: string, contact: string, customer: string, lang: Lang): string {
  let out = text ?? "";
  out = backToToken(out, contact.trim() || CONTACT_FALLBACK[lang], "{{contact}}");
  out = backToToken(out, customer, "{{customer}}");
  return out;
}

// Promotional / company-intro email composer. Left: recipient info. Right: content.
export default function ComposeEmailModal({
  customers,
  onClose,
  onSent,
}: {
  customers: CustomerOption[];
  onClose: () => void;
  onSent: () => void;
}) {
  // CustomerOption has no email, so load full customers for contact/email auto-fill.
  const { data: fullCustomers } = useCachedData("settings:customers-full", fetchSettingsCustomers);
  const { data: assetData, refresh: refreshAssets } = useCachedData(
    "marketing-assets",
    fetchMarketingAssets
  );
  const assets = useMemo(() => assetData?.rows ?? [], [assetData]);

  const [customerId, setCustomerId] = useState<number | "">("");
  const [prospectName, setProspectName] = useState("");
  const [contact, setContact] = useState("");
  const [email, setEmail] = useState("");
  const [ccList, setCcList] = useState<string[]>([]);
  const [ccInput, setCcInput] = useState("");

  const [kind, setKind] = useState<TplKind>("intro");
  const [lang, setLang] = useState<Lang>("en");
  const [from, setFrom] = useState("");
  // 제목·본문은 토큰이 든 '원본'으로 들고 있는다(화면 표시는 renderTokens 로 치환).
  const [subjectTpl, setSubjectTpl] = useState("");
  const [bodyTpl, setBodyTpl] = useState("");
  const [signature, setSignature] = useState("");
  const [includeSignature, setIncludeSignature] = useState(true);
  const [smtpConfigured, setSmtpConfigured] = useState(true);
  // 현재 종류·언어에 사용자가 저장한 템플릿이 있는지 + 저장/초기화 안내 문구.
  const [savedTpl, setSavedTpl] = useState(false);
  const [tplMsg, setTplMsg] = useState("");

  const [assetIds, setAssetIds] = useState<number[]>([]);
  const [files, setFiles] = useState<File[]>([]);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // 미리보기 — 수신자가 받게 될 HTML(서버가 발송과 같은 렌더러로 만든다).
  const [preview, setPreview] = useState(false);
  const [previewHtml, setPreviewHtml] = useState("");
  const previewSeq = useRef(0);
  // 서명 칸을 직접 고쳤는지 — 고쳤다면 종류·언어를 바꿔도 그 편집을 덮어쓰지 않는다.
  const sigDirty = useRef(false);

  const custById = useMemo(() => {
    const m = new Map<number, SettingsCustomer>();
    for (const c of fullCustomers ?? []) m.set(c.id, c);
    return m;
  }, [fullCustomers]);

  const selectedName =
    customerId === "" ? prospectName : custById.get(customerId)?.name ?? "";

  // 화면에 보이는 값 = 원본 템플릿에 현재 수신자를 끼워 넣은 결과.
  const subject = renderTokens(subjectTpl, contact, selectedName, lang);
  const body = renderTokens(bodyTpl, contact, selectedName, lang);

  // 종류·언어별로 편집 중인 초안을 기억한다 — Intro ↔ Brochure 를 오갈 때 각자
  // 내용이 살아 있어야 한다(예전엔 첫 로드 뒤 본문이 아예 바뀌지 않는 버그가 있었다).
  const drafts = useRef<Record<string, { subject: string; body: string; saved: boolean }>>({});
  function stash(subj: string, bd: string, saved = savedTpl) {
    drafts.current[`${kind}:${lang}`] = { subject: subj, body: bd, saved };
  }

  // 편집 결과는 다시 토큰으로 되돌려 보관 → 수신자를 바꾸면 이름만 갈아 끼워진다.
  function editSubject(v: string) {
    const t = toTokens(v, contact, selectedName, lang);
    setSubjectTpl(t);
    stash(t, bodyTpl);
    if (tplMsg) setTplMsg("");
  }
  function editBody(v: string) {
    const t = toTokens(v, contact, selectedName, lang);
    setBodyTpl(t);
    stash(subjectTpl, t);
    if (tplMsg) setTplMsg("");
  }

  // 종류·언어를 바꾸면 그쪽 템플릿(또는 편집 중이던 초안)을 불러온다.
  useEffect(() => {
    setTplMsg("");
    const cached = drafts.current[`${kind}:${lang}`];
    if (cached) {
      setSubjectTpl(cached.subject);
      setBodyTpl(cached.body);
      setSavedTpl(cached.saved);
      return;
    }
    let cancelled = false;
    marketingComposeDefaults({ kind, lang })
      .then((d) => {
        if (cancelled) return;
        setFrom((prev) => prev || d.from);
        setSmtpConfigured(d.smtp_configured);
        setSavedTpl(d.saved);
        setSubjectTpl(d.subject);
        setBodyTpl(d.body);
        // 서명은 손대기 전까진 항상 서버 값으로 맞춘다 — 그래야 Settings 에서 바꾼
        // 서명이나 EN↔KR 전환이 그대로 따라온다. 직접 고친 뒤에는 건드리지 않는다.
        setSignature((prev) => (sigDirty.current ? prev : d.signature));
        drafts.current[`${kind}:${lang}`] = { subject: d.subject, body: d.body, saved: d.saved };
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, lang]);

  // 현재 편집한 제목·본문을 이 종류·언어의 사용자 템플릿으로 저장 → 다음 작성 시 기본값.
  // 저장되는 건 화면 텍스트가 아니라 토큰이 든 원본이라, 수신자 이름은 박히지 않는다.
  async function saveTpl() {
    setBusy(true);
    setErr("");
    setTplMsg("");
    try {
      await saveMarketingTemplate({ kind, lang, subject: subjectTpl, body: bodyTpl });
      setSavedTpl(true);
      stash(subjectTpl, bodyTpl, true);
      setTplMsg("Saved as template.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save template.");
    } finally {
      setBusy(false);
    }
  }

  // 저장한 템플릿 삭제 후 내장 기본값을 다시 불러온다.
  async function resetTpl() {
    if (!confirm("Reset this email to the built-in default?")) return;
    setBusy(true);
    setErr("");
    setTplMsg("");
    try {
      await resetMarketingTemplate(kind, lang);
      const d = await marketingComposeDefaults({ kind, lang });
      setSubjectTpl(d.subject);
      setBodyTpl(d.body);
      setSavedTpl(false);
      stash(d.subject, d.body, false);
      setTplMsg("Reset to default.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to reset template.");
    } finally {
      setBusy(false);
    }
  }

  function pickCustomer(id: number | "") {
    setCustomerId(id);
    if (id !== "") {
      const c = custById.get(id);
      if (c) {
        setProspectName("");
        setContact(c.contact || "");
        setEmail(c.email || "");
      }
    }
  }

  // ── CC: multiple addresses as chips ──────────────────────────────
  function commitCc(raw: string) {
    // allow pasting several at once (comma / semicolon / whitespace separated)
    const parts = raw.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return;
    setCcList((cur) => {
      const next = [...cur];
      for (const p of parts) if (!next.includes(p)) next.push(p);
      return next;
    });
    setCcInput("");
  }
  function onCcKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "," || e.key === ";") {
      e.preventDefault();
      commitCc(ccInput);
    } else if (e.key === "Backspace" && !ccInput && ccList.length) {
      setCcList((cur) => cur.slice(0, -1));
    }
  }

  function toggleAsset(id: number) {
    setAssetIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  function addFiles(list: FileList | null) {
    if (!list) return;
    setFiles((cur) => [...cur, ...Array.from(list)]);
    if (fileRef.current) fileRef.current.value = "";
  }

  function clearDraft() {
    if (!confirm("Clear all content?")) return;
    setSubjectTpl("");
    setBodyTpl("");
    stash("", "");
    setAssetIds([]);
    setFiles([]);
    setErr("");
  }

  // 미리보기가 열려 있을 때만, 입력이 멈추면 서버 렌더를 갱신한다. 본문과 서명을
  // 따로 넘겨야 서버가 발송과 똑같은 규칙으로 서명을 표/평문 중 하나로 그린다.
  useEffect(() => {
    if (!preview) return;
    const seq = ++previewSeq.current;
    const t = setTimeout(async () => {
      try {
        const r = await renderEmailPreview(body, signature, includeSignature);
        if (seq === previewSeq.current) setPreviewHtml(r.html);
      } catch {
        /* 편집 중 일시적 실패는 무시 — 다음 입력에서 다시 시도된다. */
      }
    }, 300);
    return () => clearTimeout(t);
  }, [preview, body, signature, includeSignature]);

  async function send() {
    if (!email.trim()) {
      setErr("Enter a recipient email.");
      return;
    }
    const cc = [...ccList, ...(ccInput.trim() ? [ccInput.trim()] : [])].join(", ");
    setBusy(true);
    setErr("");
    try {
      await sendMarketingEmail({
        to: email.trim(),
        subject,
        body,
        signature,
        includeSignature,
        cc,
        from,
        customerId: customerId === "" ? null : customerId,
        prospectName,
        contactPerson: contact,
        lang,
        assetIds,
        files,
      });
      onSent();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to send.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Compose Email" onClose={onClose} form wide>
      {!smtpConfigured ? (
        <div className="state error" style={{ marginBottom: 12 }}>
          SMTP is not configured, so emails will not actually be sent. Check the server
          environment variables (SMTP_USER / SMTP_PASSWORD).
        </div>
      ) : null}

      <div className="compose-split">
        {/* ── Left: recipient info ───────────────────────────── */}
        <div className="compose-col">
          <div className="compose-section-title">Recipient</div>
          <div className="project-select">
            <label>Customer (registered)</label>
            {/* 같은 회사가 담당자 수만큼 나오므로 담당자 이름을 함께 보여준다. */}
            <CustomerSelect
              value={customerId}
              options={customers}
              onChange={pickCustomer}
              emptyLabel="— Prospect (not registered) —"
              showContact
            />
          </div>
          {customerId === "" ? (
            <label className="form-field">
              <span>Prospect name</span>
              <input value={prospectName} onChange={(e) => setProspectName(e.target.value)} />
            </label>
          ) : null}
          <label className="form-field">
            <span>Contact</span>
            <input value={contact} onChange={(e) => setContact(e.target.value)} />
          </label>
          <label className="form-field">
            <span>Email *</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="form-field">
            <span>From</span>
            <input value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <div className="form-field">
            <span>CC (multiple)</span>
            <div className="cc-chips" onClick={() => document.getElementById("cc-input")?.focus()}>
              {ccList.map((addr) => (
                <span key={addr} className="cc-chip">
                  {addr}
                  <button
                    type="button"
                    className="cc-chip-x"
                    onClick={() => setCcList((cur) => cur.filter((x) => x !== addr))}
                    aria-label={`Remove ${addr}`}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                id="cc-input"
                className="cc-chip-input"
                type="email"
                value={ccInput}
                placeholder={ccList.length ? "" : "Add address, Enter"}
                onChange={(e) => setCcInput(e.target.value)}
                onKeyDown={onCcKeyDown}
                onBlur={() => commitCc(ccInput)}
              />
            </div>
          </div>
        </div>

        {/* ── Right: message ───────────────────────────── */}
        <div className="compose-col">
          <div className="compose-section-title">
            Message
            <span className="compose-tpl">
              <button
                type="button"
                className={`chip-btn${kind === "intro" ? " on" : ""}`}
                onClick={() => setKind("intro")}
              >
                Company Intro
              </button>
              <button
                type="button"
                className={`chip-btn${kind === "brochure" ? " on" : ""}`}
                onClick={() => setKind("brochure")}
              >
                Brochure
              </button>
              <span className="compose-tpl-sep" />
              <button
                type="button"
                className={`chip-btn${lang === "en" ? " on" : ""}`}
                onClick={() => setLang("en")}
              >
                EN
              </button>
              <button
                type="button"
                className={`chip-btn${lang === "ko" ? " on" : ""}`}
                onClick={() => setLang("ko")}
              >
                KR
              </button>
              {savedTpl ? <span className="compose-tpl-flag">saved</span> : null}
              <span className="compose-tpl-sep" />
              {/* 편집 ↔ 미리보기. 미리보기는 서버가 발송용 HTML 로 렌더한 결과라
                  수신자가 실제로 보게 될 글꼴·크기·목록 그대로다. */}
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
                수신자가 보게 될 모습입니다{includeSignature ? " (서명 포함)" : ""}. 첨부는
                아래에서 확인하세요.
              </div>
            </div>
          ) : (
            <>
              <label className="form-field">
                <span>Subject</span>
                <input value={subject} onChange={(e) => editSubject(e.target.value)} />
              </label>
              <label className="form-field">
                <span>Body</span>
                <textarea rows={9} value={body} onChange={(e) => editBody(e.target.value)} />
              </label>
              <div className="compose-hint">
                Recipient names sync automatically — “{contact.trim() || CONTACT_FALLBACK[lang]}” is
                stored as a placeholder, so a saved template greets whoever you pick next.
              </div>

              <label className="form-field">
                <span className="compose-sig-head">
                  Signature
                  <label className="compose-sig-toggle">
                    <input
                      type="checkbox"
                      checked={includeSignature}
                      onChange={(e) => setIncludeSignature(e.target.checked)}
                    />
                    Include in email
                  </label>
                </span>
                <textarea
                  rows={4}
                  value={signature}
                  onChange={(e) => {
                    sigDirty.current = true;
                    setSignature(e.target.value);
                  }}
                  disabled={!includeSignature}
                />
              </label>
              <div className="compose-hint">
                Settings → Email Templates → Signature 에 저장한 서명입니다. 여기서 고치면
                이번 발송에만 적용되며, 표 서명 대신 고친 평문이 나갑니다.
              </div>
            </>
          )}

          <div className="form-field">
            <span>Attachments</span>
            {assets.length ? (
              <div className="compose-assets">
                {assets.map((a: MarketingAsset) => (
                  <label key={a.id} className={`compose-asset${assetIds.includes(a.id) ? " on" : ""}`}>
                    <input
                      type="checkbox"
                      checked={assetIds.includes(a.id)}
                      onChange={() => toggleAsset(a.id)}
                    />
                    <span className="compose-asset-name">{a.label}</span>
                    <span className="compose-asset-size">{fmtSize(a.size)}</span>
                  </label>
                ))}
              </div>
            ) : (
              <div className="hint-inline">
                No saved files. Register brochures in Settings, or attach a file below.
              </div>
            )}
            <div className="compose-upload">
              <button type="button" className="btn ghost" onClick={() => fileRef.current?.click()}>
                + Attach file
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                onChange={(e) => addFiles(e.target.files)}
              />
              <button
                type="button"
                className="btn ghost"
                onClick={() => refreshAssets()}
                title="Refresh library"
              >
                ↻
              </button>
            </div>
            {files.length ? (
              <ul className="compose-files">
                {files.map((f, i) => (
                  <li key={i}>
                    {f.name} <span className="compose-asset-size">{fmtSize(f.size)}</span>
                    <button
                      type="button"
                      className="compose-file-x"
                      onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      </div>

      <div className="form-actions compose-actions">
        <button className="btn primary" disabled={busy || !email.trim()} onClick={send}>
          {busy ? "Sending…" : "Send"}
        </button>
        <button className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button className="btn danger" disabled={busy} onClick={clearDraft}>
          Clear
        </button>
        {/* 템플릿 저장 — 지금 화면의 제목·본문을 이 종류(Intro/Brochure) × 언어의 기본값으로. */}
        <span className="compose-foot-tpl">
          <button
            className="btn ghost"
            disabled={busy}
            onClick={saveTpl}
            title={`Save this subject & body as the default for ${
              kind === "intro" ? "Company Intro" : "Brochure"
            } · ${lang === "en" ? "EN" : "KR"}`}
          >
            💾 Save as template
          </button>
          {savedTpl ? (
            <button
              className="btn ghost"
              disabled={busy}
              onClick={resetTpl}
              title="Reset to the built-in default"
            >
              ↺ Reset
            </button>
          ) : null}
          {tplMsg ? <span className="compose-tpl-msg">{tplMsg}</span> : null}
        </span>
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </Modal>
  );
}
