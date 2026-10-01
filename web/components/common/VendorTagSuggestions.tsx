"use client";

import { useEffect, useRef, useState } from "react";
import { decideVendorTag, fetchMailMessage } from "@/lib/api";
import type { MailMessageFull, VendorTagSource, VendorTagSuggestion } from "@/lib/types";

// 거래선 태그 제안 목록 — "이 메이커/분류가 견적·메일에서 확인됐는데 추가할까요?"
// 알림(종)과 Company info 창이 같은 목록을 쓴다. 근거(어느 견적·메일의 어느 문장)를
// 함께 보여 주어야 사람이 판단할 수 있다 — 이름만 내밀면 눌러 보고 확인하러 가야 한다.

const SRC_LABEL: Record<VendorTagSource["type"], string> = {
  quote: "Quote",
  po: "P/O",
  email: "Email",
  bought: "Bought",
};

export default function VendorTagSuggestions({
  company,
  items,
  onDecided,
  compact = false,
}: {
  company: string;
  items: VendorTagSuggestion[];
  /** 한 건을 처리했다 — accepted=true 면 태그에 들어갔다. */
  onDecided?: (s: VendorTagSuggestion, accepted: boolean) => void;
  /** 근거를 한 줄만(종 안처럼 좁은 자리). */
  compact?: boolean;
}) {
  const [busy, setBusy] = useState<string>("");
  const [done, setDone] = useState<Record<string, "added" | "dismissed">>({});
  const [err, setErr] = useState("");
  // 펼친 근거 메일(한 번에 하나) · 근거를 전부 펼친 제안
  const [openSrc, setOpenSrc] = useState("");
  const [allSrc, setAllSrc] = useState<Record<string, boolean>>({});

  async function decide(s: VendorTagSuggestion, accept: boolean) {
    const key = `${s.kind}:${s.ref_id}`;
    setBusy(key);
    setErr("");
    try {
      await decideVendorTag(accept ? "accept" : "dismiss", { company, kind: s.kind, ref_id: s.ref_id });
      setDone((d) => ({ ...d, [key]: accept ? "added" : "dismissed" }));
      onDecided?.(s, accept);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className={`vts${compact ? " compact" : ""}`}>
      {items.map((s) => {
        const key = `${s.kind}:${s.ref_id}`;
        const state = done[key];
        const limit = compact ? 1 : 3;
        const srcs = allSrc[key] ? s.sources : s.sources.slice(0, limit);
        const hidden = s.sources.length - srcs.length;
        return (
          <div key={key} className={`vts-row${state ? " decided" : ""}`}>
            <div className="vts-main">
              <span className={`vts-kind ${s.kind}`}>{s.kind === "maker" ? "Maker" : "Category"}</span>
              <b className="vts-label">{s.label}</b>
              {s.sources.length > 1 ? <span className="vts-count">×{s.sources.length}</span> : null}
              <span className="vts-actions">
                {state ? (
                  <span className={`vts-state ${state}`}>{state === "added" ? "✓ Added" : "Dismissed"}</span>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn tiny primary"
                      disabled={!!busy}
                      onClick={(e) => { e.stopPropagation(); decide(s, true); }}
                      title={`Add ${s.label} to ${company}'s ${s.kind === "maker" ? "Makers supplied" : "Item categories"}`}
                    >
                      ＋ Add
                    </button>
                    <button
                      type="button"
                      className="btn tiny"
                      disabled={!!busy}
                      onClick={(e) => { e.stopPropagation(); decide(s, false); }}
                      title="Not relevant — don't suggest this again for this company"
                    >
                      Dismiss
                    </button>
                  </>
                )}
              </span>
            </div>
            {srcs.map((src, i) => {
              const sk = `${key}:${src.ref}`;
              const isOpen = openSrc === sk;
              const canOpen = src.type === "email" && !!src.email_id;
              return (
                <div key={i}>
                  <div
                    className={`vts-src${canOpen ? " openable" : ""}${isOpen ? " open" : ""}`}
                    role={canOpen ? "button" : undefined}
                    tabIndex={canOpen ? 0 : undefined}
                    title={canOpen ? (isOpen ? "Hide email" : "Read the full email") : src.subject || src.text}
                    onClick={canOpen ? (e) => { e.stopPropagation(); setOpenSrc(isOpen ? "" : sk); } : undefined}
                    onKeyDown={canOpen ? (e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setOpenSrc(isOpen ? "" : sk); }
                    } : undefined}
                  >
                    <span className="vts-src-type">{SRC_LABEL[src.type] ?? src.type}</span>
                    {src.project_no ? <span className="vts-src-proj">{src.project_no}</span> : null}
                    {src.date ? <span className="vts-src-date">{src.date}</span> : null}
                    <span className="vts-src-text">{src.text}</span>
                    {canOpen ? <span className="vts-src-toggle">{isOpen ? "▾ Hide" : "▸ Full email"}</span> : null}
                  </div>
                  {isOpen && src.email_id ? (
                    <MailPreview id={src.email_id} terms={[src.term || "", s.kind === "maker" ? s.label : ""]} />
                  ) : null}
                </div>
              );
            })}
            {hidden > 0 || (allSrc[key] && s.sources.length > limit) ? (
              <button
                type="button"
                className="vts-more"
                onClick={(e) => { e.stopPropagation(); setAllSrc((m) => ({ ...m, [key]: !m[key] })); }}
              >
                {allSrc[key] ? "Show less" : `+${hidden} more evidence`}
              </button>
            ) : null}
          </div>
        );
      })}
      {err ? <div className="vts-err">{err}</div> : null}
    </div>
  );
}

// 근거 메일 전문 — 제안이 짚은 낱말을 강조하고 그 자리로 스크롤해 둔다.
function MailPreview({ id, terms }: { id: number; terms: string[] }) {
  const [mail, setMail] = useState<MailMessageFull | null>(null);
  const [err, setErr] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setMail(null);
    setErr("");
    fetchMailMessage(id)
      .then((m) => { if (alive) setMail(m); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : "Failed to load email"); });
    return () => { alive = false; };
  }, [id]);

  useEffect(() => {
    const box = boxRef.current;
    const mark = box?.querySelector("mark");
    if (box && mark instanceof HTMLElement) box.scrollTop = Math.max(0, mark.offsetTop - 48);
  }, [mail]);

  if (err) return <div className="vts-mail vts-err">{err}</div>;
  if (!mail) return <div className="vts-mail vts-mail-loading">Loading email…</div>;

  const from = mail.from_name ? `${mail.from_name} <${mail.from_addr}>` : mail.from_addr;
  return (
    <div className="vts-mail" onClick={(e) => e.stopPropagation()}>
      <div className="vts-mail-head">
        <b className="vts-mail-subj">{mail.subject || "(no subject)"}</b>
        <div><span>From</span>{from}</div>
        {mail.to_addrs.length ? <div><span>To</span>{mail.to_addrs.join(", ")}</div> : null}
        {mail.cc_addrs.length ? <div><span>Cc</span>{mail.cc_addrs.join(", ")}</div> : null}
        <div>
          <span>Date</span>{mail.sent_at.replace("T", " ")}
          {mail.project_no ? <em className="vts-mail-proj">{mail.project_no}</em> : null}
        </div>
        {mail.attachments.length ? (
          <div><span>Files</span>{mail.attachments.map((a) => a.name).join(", ")}</div>
        ) : null}
      </div>
      <div ref={boxRef} className="vts-mail-body">
        {highlight(mail.body_text || "(empty body)", terms)}
        {mail.truncated ? <div className="vts-mail-trunc">… (body was cut off when stored)</div> : null}
      </div>
    </div>
  );
}

function highlight(text: string, terms: string[]) {
  const pats = Array.from(new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 2)))
    .sort((a, b) => b.length - a.length)
    .map((t) => t.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"));
  if (!pats.length) return text;
  const re = new RegExp(`(${pats.join("|")})`, "gi");
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}
