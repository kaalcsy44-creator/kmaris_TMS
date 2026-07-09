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

  // Load template defaults — refetched when template kind / language / recipient changes.
  // Only replace fields the user hasn't edited (still equal to the last template value).
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
    setSubject("");
    setBody("");
    setAssetIds([]);
    setFiles([]);
    setErr("");
    lastTpl.current = null;
  }

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
            <CustomerSelect
              value={customerId}
              options={customers}
              onChange={pickCustomer}
              emptyLabel="— Prospect (not registered) —"
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
            </span>
          </div>

          <label className="form-field">
            <span>Subject</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <label className="form-field">
            <span>Body</span>
            <textarea rows={9} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>

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
              onChange={(e) => setSignature(e.target.value)}
              disabled={!includeSignature}
            />
          </label>

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

      <div className="form-actions">
        <button className="btn primary" disabled={busy || !email.trim()} onClick={send}>
          {busy ? "Sending…" : "Send"}
        </button>
        <button className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button className="btn danger" disabled={busy} onClick={clearDraft}>
          Clear
        </button>
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </Modal>
  );
}
