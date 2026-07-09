"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchSettingsCustomers,
  fetchMarketingAssets,
  marketingComposeDefaults,
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

// 홍보/회사소개 이메일 작성·발송 모달. 좌: 수신정보 / 우: 메일 내용·서명·첨부.
export default function ComposeEmailModal({
  customers,
  onClose,
  onSent,
}: {
  customers: CustomerOption[];
  onClose: () => void;
  onSent: () => void;
}) {
  // 이메일 자동 채움용 상세 고객사(email 포함) — CustomerOption 엔 email 이 없어 별도 로드.
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
  const [cc, setCc] = useState("");

  const [kind, setKind] = useState<TplKind>("intro");
  const [lang, setLang] = useState<Lang>("en");
  const [from, setFrom] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [signature, setSignature] = useState("");
  const [includeSignature, setIncludeSignature] = useState(true);
  const [smtpConfigured, setSmtpConfigured] = useState(true);

  const [assetIds, setAssetIds] = useState<number[]>([]);
  const [files, setFiles] = useState<File[]>([]);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const custById = useMemo(() => {
    const m = new Map<number, SettingsCustomer>();
    for (const c of fullCustomers ?? []) m.set(c.id, c);
    return m;
  }, [fullCustomers]);

  const selectedName =
    customerId === "" ? prospectName : custById.get(customerId)?.name ?? "";

  // 템플릿 기본값 로드 — 템플릿 종류·언어·수신 담당자/고객사명이 바뀌면 다시 채운다.
  // 사용자가 이미 손댄 값은 덮지 않도록, 직전 템플릿 값과 같을 때만 교체한다.
  const lastTpl = useRef<{ subject: string; body: string; signature: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    marketingComposeDefaults({ kind, lang, contact, customer: selectedName })
      .then((d) => {
        if (cancelled) return;
        setFrom((prev) => prev || d.from);
        setSmtpConfigured(d.smtp_configured);
        setSubject((prev) => (!prev || prev === lastTpl.current?.subject ? d.subject : prev));
        setBody((prev) => (!prev || prev === lastTpl.current?.body ? d.body : prev));
        setSignature((prev) => (!prev || prev === lastTpl.current?.signature ? d.signature : prev));
        lastTpl.current = { subject: d.subject, body: d.body, signature: d.signature };
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, lang, contact, selectedName]);

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

  function toggleAsset(id: number) {
    setAssetIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  function addFiles(list: FileList | null) {
    if (!list) return;
    setFiles((cur) => [...cur, ...Array.from(list)]);
    if (fileRef.current) fileRef.current.value = "";
  }

  function clearDraft() {
    if (!confirm("작성 중인 내용을 모두 지울까요?")) return;
    setSubject("");
    setBody("");
    setAssetIds([]);
    setFiles([]);
    setErr("");
    lastTpl.current = null;
  }

  async function send() {
    if (!email.trim()) {
      setErr("수신자 이메일을 입력하세요.");
      return;
    }
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
        assetIds,
        files,
      });
      onSent();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "발송에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="홍보 이메일 작성" onClose={onClose} wide>
      {!smtpConfigured ? (
        <div className="state error" style={{ marginBottom: 12 }}>
          SMTP가 설정되지 않아 실제 발송이 되지 않습니다. 서버 환경변수(SMTP_USER/SMTP_PASSWORD)를 확인하세요.
        </div>
      ) : null}

      <div className="compose-split">
        {/* ── 좌: 수신 정보 ───────────────────────────── */}
        <div className="compose-col">
          <div className="compose-section-title">수신 정보</div>
          <div className="project-select">
            <label>고객사 (등록)</label>
            <CustomerSelect
              value={customerId}
              options={customers}
              onChange={pickCustomer}
              emptyLabel="— 미등록 잠정사 —"
            />
          </div>
          {customerId === "" ? (
            <label className="form-field">
              <span>잠정사 이름</span>
              <input value={prospectName} onChange={(e) => setProspectName(e.target.value)} />
            </label>
          ) : null}
          <label className="form-field">
            <span>담당자</span>
            <input value={contact} onChange={(e) => setContact(e.target.value)} />
          </label>
          <label className="form-field">
            <span>이메일 *</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="form-field">
            <span>참조 (CC)</span>
            <input
              type="email"
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              placeholder="쉼표로 구분"
            />
          </label>
          <label className="form-field">
            <span>발신 (From)</span>
            <input value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
        </div>

        {/* ── 우: 메일 내용 ───────────────────────────── */}
        <div className="compose-col">
          <div className="compose-section-title">
            메일 내용
            <span className="compose-tpl">
              <button
                type="button"
                className={`chip-btn${kind === "intro" ? " on" : ""}`}
                onClick={() => setKind("intro")}
              >
                회사소개
              </button>
              <button
                type="button"
                className={`chip-btn${kind === "brochure" ? " on" : ""}`}
                onClick={() => setKind("brochure")}
              >
                브로슈어
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
            </span>
          </div>

          <label className="form-field">
            <span>제목</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <label className="form-field">
            <span>본문</span>
            <textarea rows={9} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>

          <label className="form-field">
            <span className="compose-sig-head">
              서명
              <label className="compose-sig-toggle">
                <input
                  type="checkbox"
                  checked={includeSignature}
                  onChange={(e) => setIncludeSignature(e.target.checked)}
                />
                메일에 포함
              </label>
            </span>
            <textarea
              rows={4}
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              disabled={!includeSignature}
            />
          </label>

          <div className="form-field">
            <span>첨부 파일</span>
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
                등록된 자료가 없습니다. 설정에서 회사소개서·브로슈어를 등록하거나 아래에서 파일을 첨부하세요.
              </div>
            )}
            <div className="compose-upload">
              <button type="button" className="btn ghost" onClick={() => fileRef.current?.click()}>
                + 파일 첨부
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
                title="라이브러리 새로고침"
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

      <div className="form-actions">
        <button className="btn primary" disabled={busy || !email.trim()} onClick={send}>
          {busy ? "발송 중…" : "보내기"}
        </button>
        <button className="btn" disabled={busy} onClick={onClose}>
          취소
        </button>
        <button className="btn danger" disabled={busy} onClick={clearDraft} style={{ marginLeft: "auto" }}>
          삭제
        </button>
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </Modal>
  );
}
