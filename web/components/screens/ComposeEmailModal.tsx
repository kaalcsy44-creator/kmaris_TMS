"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchSettingsCustomers,
  fetchMarketingAssets,
  fetchMarketingAssetObjectUrl,
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
import CcField from "@/components/common/CcField";
import CustomerSelect from "@/components/common/CustomerSelect";
import { toggleBold, onBoldKey } from "@/lib/mdEdit";

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

// 수신자 한 명 = 메일 한 통. customerId 가 없으면 미등록(잠정) 고객이다.
type Recipient = {
  key: string;
  customerId: number | null;
  name: string;      // 회사명(등록 고객) 또는 잠정사 이름
  contact: string;   // 인사말에 들어갈 담당자 이름
  email: string;
};

let recipSeq = 0;
function newKey(): string {
  recipSeq += 1;
  return `r${recipSeq}`;
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

  // 수신자 목록 — 한 명이면 예전과 같고, 여러 명이면 인사말만 각자 이름으로 바꿔
  // 한 통씩 따로 나간다(서로의 주소는 보이지 않는다).
  const [recips, setRecips] = useState<Recipient[]>([]);
  // 미등록(잠정) 고객을 직접 넣을 때 쓰는 입력 줄.
  const [draft, setDraft] = useState({ name: "", contact: "", email: "" });
  const [ccList, setCcList] = useState<string[]>([]);
  // 아직 Enter 로 확정하지 않고 CC 입력칸에 남아 있는 글자 — 바로 Send 를 눌러도
  // 그 주소가 빠지지 않게 발송 때 함께 싣는다.
  const [ccInput, setCcInput] = useState("");

  // 홍보 메일은 회사소개 한 종류다 — 브로슈어는 별도 템플릿 없이 파일만 첨부한다.
  const kind: TplKind = "intro";
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
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // 미리보기 — 수신자가 받게 될 HTML(서버가 발송과 같은 렌더러로 만든다).
  const [preview, setPreview] = useState(false);
  const [previewHtml, setPreviewHtml] = useState("");
  const previewSeq = useRef(0);
  // 서명 칸을 직접 고쳤는지 — 고쳤다면 종류·언어를 바꿔도 그 편집을 덮어쓰지 않는다.
  const sigDirty = useRef(false);
  // 서명만 따로 보는 미리보기(본문 전체 미리보기와 별개).
  const [sigPreview, setSigPreview] = useState(false);
  const [sigHtml, setSigHtml] = useState("");
  const sigSeq = useRef(0);
  // 첨부 미리보기(모달 안 인라인) — 만든 object URL 은 닫을 때 정리한다.
  const [filePreview, setFilePreview] =
    useState<{ name: string; mime: string; url: string } | null>(null);
  const objectUrls = useRef<string[]>([]);
  useEffect(
    () => () => {
      for (const u of objectUrls.current) URL.revokeObjectURL(u);
    },
    []
  );

  const custById = useMemo(() => {
    const m = new Map<number, SettingsCustomer>();
    for (const c of fullCustomers ?? []) m.set(c.id, c);
    return m;
  }, [fullCustomers]);

  // 제목·본문 화면 표시는 첫 번째 수신자 기준 — 나머지 수신자에게는 서버가 각자
  // 이름으로 다시 치환해 보낸다(미리보기는 "첫 수신자가 받을 모습"이다).
  const lead = recips[0];
  const contact = lead?.contact ?? "";
  const selectedName = lead?.name ?? "";

  // 화면에 보이는 값 = 원본 템플릿에 현재 수신자를 끼워 넣은 결과.
  const subject = renderTokens(subjectTpl, contact, selectedName, lang);
  const body = renderTokens(bodyTpl, contact, selectedName, lang);

  // 언어별로 편집 중인 초안을 기억한다 — EN ↔ KR 을 오갈 때 각자 내용이 살아
  // 있어야 한다(예전엔 첫 로드 뒤 본문이 아예 바뀌지 않는 버그가 있었다).
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

  // ── 수신자 목록 ────────────────────────────────────────────────────
  // 드롭다운은 '고르는' 칸이 아니라 '추가하는' 칸이다 — 고르면 바로 목록에 들어간다.
  function addCustomer(id: number | "") {
    if (id === "") return;
    const c = custById.get(id);
    if (!c) return;
    setErr("");
    setRecips((cur) => {
      // 같은 담당자(고객 레코드)를 두 번 넣지 않는다.
      if (cur.some((r) => r.customerId === id)) return cur;
      return [...cur, {
        key: newKey(),
        customerId: id,
        name: c.name || "",
        contact: c.contact || "",
        email: c.email || "",
      }];
    });
  }

  function addProspect() {
    const email = draft.email.trim();
    if (!email) return;
    setErr("");
    setRecips((cur) => [...cur, {
      key: newKey(),
      customerId: null,
      name: draft.name.trim(),
      contact: draft.contact.trim(),
      email,
    }]);
    setDraft({ name: "", contact: "", email: "" });
  }

  function editRecip(key: string, patch: Partial<Recipient>) {
    setRecips((cur) => cur.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function removeRecip(key: string) {
    setRecips((cur) => cur.filter((r) => r.key !== key));
  }

  // 보낼 수 있는 상태인지 — 주소가 빈 줄이 하나라도 있으면 막는다.
  const missingEmail = recips.some((r) => !r.email.trim());
  const canSend = recips.length > 0 && !missingEmail;

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

  // 서명 미리보기 — 본문 없이 서명만 같은 렌더러로 그린다.
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

  // 첨부 미리보기 — 새 탭은 팝업 차단에 걸려 아무 반응도 없어 보이므로, 이 모달
  // 안에서 연다. PDF·이미지는 브라우저가 그대로 그려 준다.
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
  async function previewAsset(a: MarketingAsset) {
    setErr("");
    try {
      showPreview(a.label || a.filename, a.mime, await fetchMarketingAssetObjectUrl(a.id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "미리보기를 열지 못했습니다.");
    }
  }

  async function send() {
    if (!recips.length) {
      setErr("수신자를 한 명 이상 추가하세요.");
      return;
    }
    if (missingEmail) {
      setErr("이메일 주소가 비어 있는 수신자가 있습니다.");
      return;
    }
    // 여러 명에게 나가는 건 되돌릴 수 없으니 한 번 확인한다.
    if (recips.length > 1 && !confirm(`${recips.length}명에게 각각 개별 발송합니다. 계속할까요?`)) {
      return;
    }
    const cc = [...ccList, ...(ccInput.trim() ? [ccInput.trim()] : [])].join(", ");
    setBusy(true);
    setErr("");
    try {
      const r = await sendMarketingEmail({
        to: recips[0].email.trim(),
        recipients: recips.map((x) => ({
          email: x.email.trim(),
          customer_id: x.customerId,
          prospect_name: x.customerId ? "" : x.name.trim(),
          contact_person: x.contact.trim(),
        })),
        // 제목·본문은 토큰이 든 원본을 보낸다 — 수신자 이름 치환은 서버가 각자에게 한다.
        subject: subjectTpl,
        body: bodyTpl,
        signature,
        includeSignature,
        cc,
        from,
        lang,
        assetIds,
        files,
      });
      const failed = r.failed ?? [];
      if (failed.length) {
        // 보낸 사람은 목록에서 빼고 실패한 사람만 남긴다 — 그대로 다시 누르면 재시도.
        const done = new Set((r.sent ?? []).map((e) => e.toLowerCase()));
        setRecips((cur) => cur.filter((x) => !done.has(x.email.trim().toLowerCase())));
        setErr(`${(r.sent ?? []).length}건 발송, ${failed.length}건 실패: ${failed.join(", ")}`);
        return;
      }
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
          <div className="compose-section-title">
            Recipients
            {recips.length ? <span className="recip-count">{recips.length}</span> : null}
          </div>
          <div className="project-select">
            <label>Customer (registered)</label>
            {/* 고르면 바로 아래 목록에 추가된다(여러 명 선택 가능). 같은 회사가 담당자
                수만큼 나오므로 담당자 이름을 함께 보여준다. */}
            <CustomerSelect
              value=""
              options={customers}
              onChange={addCustomer}
              emptyLabel="+ 고객을 골라 목록에 추가"
              showContact
            />
          </div>

          {recips.length ? (
            <ul className="recip-list">
              {recips.map((r, i) => (
                <li key={r.key} className={`recip-row${r.email.trim() ? "" : " bad"}`}>
                  <div className="recip-head">
                    <span className="recip-name">
                      {r.name || (r.customerId ? "(unnamed)" : "(미등록 고객)")}
                    </span>
                    {i === 0 ? <span className="recip-lead">미리보기 기준</span> : null}
                    <button
                      type="button"
                      className="cc-chip-x"
                      onClick={() => removeRecip(r.key)}
                      aria-label={`Remove ${r.email || r.name}`}
                    >
                      ×
                    </button>
                  </div>
                  <div className="recip-fields">
                    <input
                      value={r.contact}
                      placeholder="담당자 (Dear …)"
                      onChange={(e) => editRecip(r.key, { contact: e.target.value })}
                    />
                    <input
                      type="email"
                      value={r.email}
                      placeholder="email@company.com"
                      onChange={(e) => editRecip(r.key, { email: e.target.value })}
                    />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="hint-inline" style={{ margin: "6px 0" }}>
              위에서 고객을 고르거나, 아래에 직접 입력해 수신자를 추가하세요.
            </div>
          )}

          {/* 미등록(잠정) 고객 직접 추가 */}
          <div className="recip-add">
            <input
              value={draft.name}
              placeholder="회사명 (미등록)"
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
            <input
              value={draft.contact}
              placeholder="담당자"
              onChange={(e) => setDraft((d) => ({ ...d, contact: e.target.value }))}
            />
            <input
              type="email"
              value={draft.email}
              placeholder="email@company.com"
              onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addProspect();
                }
              }}
            />
            <button
              type="button"
              className="btn ghost"
              disabled={!draft.email.trim()}
              onClick={addProspect}
            >
              + Add
            </button>
          </div>
          <div className="compose-hint">
            수신자가 여러 명이면 한 통에 묶지 않고 <b>각자에게 따로</b> 보냅니다 — 인사말의
            이름(Dear …)도 각 담당자 이름으로 바뀝니다. 다른 수신자 주소는 서로 보이지
            않습니다. CC 주소는 메일마다 함께 나갑니다.
          </div>

          <label className="form-field">
            <span>From</span>
            <input value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <CcField value={ccList} onChange={setCcList} onPendingChange={setCcInput} />
        </div>

        {/* ── Right: message ───────────────────────────── */}
        <div className="compose-col">
          <div className="compose-section-title">
            Message
            <span className="compose-tpl">
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
              <div className="form-field">
                <span className="compose-sig-head">
                  Body
                  <span className="compose-sig-actions">
                    <button
                      type="button"
                      className="chip-btn md-bold"
                      title="선택한 부분을 굵게 (Ctrl+B) — 본문에는 **텍스트** 로 남습니다"
                      onClick={() => toggleBold(bodyRef.current, editBody)}
                    >
                      B
                    </button>
                  </span>
                </span>
                <textarea
                  ref={bodyRef}
                  rows={9}
                  value={body}
                  onChange={(e) => editBody(e.target.value)}
                  onKeyDown={(e) => onBoldKey(e, editBody)}
                />
              </div>
              <div className="compose-hint">
                Recipient names sync automatically — “{contact.trim() || CONTACT_FALLBACK[lang]}” is
                stored as a placeholder, so a saved template greets whoever you pick next.
                {recips.length > 1
                  ? ` 지금은 ${recips.length}명이라 화면에는 첫 번째 수신자 이름으로 보이고, 나머지는 각자 이름으로 나갑니다.`
                  : ""}{" "}
                굵게는 <code>**텍스트**</code> 로 표시됩니다(선택 후 B 또는 Ctrl+B).
              </div>

              <div className="form-field">
                <span className="compose-sig-head">
                  Signature
                  <span className="compose-sig-actions">
                    <label className="compose-sig-toggle">
                      <input
                        type="checkbox"
                        checked={includeSignature}
                        onChange={(e) => setIncludeSignature(e.target.checked)}
                      />
                      Include in email
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
                </span>
                {sigPreview ? (
                  <div
                    className="compose-preview-body sig"
                    dangerouslySetInnerHTML={{ __html: sigHtml }}
                  />
                ) : (
                  <textarea
                    className="compose-sig-text"
                    rows={4}
                    value={signature}
                    onChange={(e) => {
                      sigDirty.current = true;
                      setSignature(e.target.value);
                    }}
                    disabled={!includeSignature}
                  />
                )}
              </div>
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
                    {/* label 안이라 기본 동작(체크박스 토글)을 막고 미리보기만 연다. */}
                    <button
                      type="button"
                      className="compose-asset-eye"
                      title="새 탭에서 미리보기"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        previewAsset(a);
                      }}
                    >
                      Preview
                    </button>
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
                      className="compose-asset-eye"
                      title="미리보기"
                      onClick={() => showPreview(f.name, f.type, URL.createObjectURL(f))}
                    >
                      Preview
                    </button>
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
                    이 형식({filePreview.mime || "unknown"})은 브라우저에서 미리보기가 안 됩니다.
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="form-actions compose-actions">
        <button className="btn primary" disabled={busy || !canSend} onClick={send}>
          {busy
            ? "Sending…"
            : recips.length > 1
              ? `Send to ${recips.length}`
              : "Send"}
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
            title={`Save this subject & body as the default · ${
              lang === "en" ? "EN" : "KR"
            }`}
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
