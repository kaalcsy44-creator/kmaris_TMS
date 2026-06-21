"use client";

import { useEffect, useState } from "react";
import {
  fetchVendors,
  fetchRfqDetail,
  createVendorRfq,
  previewVendorRfq,
  sendVendorRfq,
  vendorRfqXlsxUrl,
  createVendorQuote,
  parseVendorQuoteFile,
  createCustomerQuote,
  quotationPdfUrl,
  previewQuotationEmail,
  sendQuotationEmail,
} from "@/lib/api";
import { getToken } from "@/lib/auth";
import type {
  VendorOption,
  RfqDetail as RfqDetailT,
  VendorRfqPreview,
  VendorQuoteItem,
  CustomerQuoteItem,
} from "@/lib/types";
import NewRfqForm from "./screens/NewRfqForm";

// 원본 rfq_quotation.py 하단의 작업 segmented control(4탭)을 복원.
const TABS = [
  { key: "new", label: "1. Customer RFQ 수신" },
  { key: "vrfq", label: "2. Vendor RFQ 발신" },
  { key: "vquote", label: "3. Vendor Quot. 수신" },
  { key: "cquote", label: "4. Customer Quot. 발신" },
];

export default function RfqActionTabs({
  rfqId,
  rfqNo,
  onChanged,
}: {
  rfqId: number | null;
  rfqNo?: string;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState("new");
  const [vendors, setVendors] = useState<VendorOption[]>([]);
  const [vendorRfqs, setVendorRfqs] = useState<RfqDetailT["vendor_rfqs"]>([]);

  useEffect(() => {
    fetchVendors().then(setVendors).catch(() => setVendors([]));
  }, []);

  function reloadVrfqs() {
    if (rfqId === null) {
      setVendorRfqs([]);
      return;
    }
    fetchRfqDetail(rfqId)
      .then((d) => setVendorRfqs(d.vendor_rfqs))
      .catch(() => setVendorRfqs([]));
  }

  useEffect(() => {
    reloadVrfqs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfqId]);

  const needsRfq = tab !== "new";
  const after = () => {
    onChanged();
    reloadVrfqs();
  };

  return (
    <div className="action-tabs">
      <div className="page-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? "on" : ""}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {needsRfq && rfqNo ? (
        <div className="action-ctx">
          대상 RFQ: <b>{rfqNo}</b>
        </div>
      ) : null}

      {tab === "new" ? (
        <NewRfqForm onCreated={() => onChanged()} />
      ) : rfqId === null ? (
        <div className="panel">
          <div className="empty">위 표에서 RFQ를 먼저 선택하세요.</div>
        </div>
      ) : (
        <div className="panel action-panel">
          {tab === "vrfq" && (
            <VendorRfqAction rfqId={rfqId} vendors={vendors} onDone={after} />
          )}
          {tab === "vquote" && (
            <VendorQuoteAction
              rfqId={rfqId}
              vendorRfqs={vendorRfqs}
              onDone={after}
            />
          )}
          {tab === "cquote" && (
            <CustomerQuoteAction rfqId={rfqId} onDone={onChanged} />
          )}
        </div>
      )}
    </div>
  );
}

function VendorRfqAction({
  rfqId,
  vendors,
  onDone,
}: {
  rfqId: number;
  vendors: VendorOption[];
  onDone: () => void;
}) {
  const [vendorIds, setVendorIds] = useState<number[]>([]);
  const [lang, setLang] = useState<"en" | "ko">("en");
  const [notes, setNotes] = useState("");
  const [previews, setPreviews] = useState<VendorRfqPreview[]>([]);
  const [smtpConfigured, setSmtpConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function toggleVendor(id: number) {
    setVendorIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  async function makePreview() {
    if (vendorIds.length === 0) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await previewVendorRfq(rfqId, vendorIds, lang, notes);
      setPreviews(r.previews);
      setSmtpConfigured(r.smtp_configured);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "미리보기 생성 실패");
    } finally {
      setBusy(false);
    }
  }

  function patchPreview(i: number, key: keyof VendorRfqPreview, value: string) {
    setPreviews((prev) =>
      prev.map((p, idx) => (idx === i ? { ...p, [key]: value } : p))
    );
  }

  async function downloadXlsx(p: VendorRfqPreview) {
    const res = await fetch(vendorRfqXlsxUrl(rfqId, p.vendor_id), {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) {
      setErr("XLSX 다운로드 실패");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = p.xlsx_filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function sendAll() {
    if (previews.length === 0) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await sendVendorRfq(
        rfqId,
        previews.map((p) => ({
          vendor_id: p.vendor_id,
          to: p.to,
          subject: p.subject,
          body: p.body,
        }))
      );
      setMsg(
        `DB 저장 ${r.saved}건 완료` +
          (r.sent_ok ? ` · 이메일 발송 ${r.sent_ok}건` : "") +
          (r.sent_fail ? ` · 실패 ${r.sent_fail}건` : "")
      );
      setPreviews([]);
      setVendorIds([]);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "발신 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="sub-h">Vendor RFQ 작성·발신</div>
      <div className="po-work-note">
        <b>견적 요청 메일</b>
        <span>Vendor별 이메일을 미리보고, 견적 응답용 Excel 양식을 첨부해 발송/DB 저장합니다.</span>
      </div>
      {previews.length === 0 ? (
        <>
          <div className="form-field">
            <label>Vendor 선택</label>
            <div className="vendor-checks">
              {vendors.map((v) => (
                <label key={v.id} className="check-inline">
                  <input
                    type="checkbox"
                    checked={vendorIds.includes(v.id)}
                    onChange={() => toggleVendor(v.id)}
                  />
                  {v.name}
                </label>
              ))}
            </div>
          </div>
          <div className="form-grid">
            <div className="form-field">
              <label>이메일 언어</label>
              <select value={lang} onChange={(e) => setLang(e.target.value as "en" | "ko")}>
                <option value="en">English (영문)</option>
                <option value="ko">Korean (국문)</option>
              </select>
            </div>
          </div>
          <div className="form-field">
            <label>Vendor에게 전달할 메모</label>
            <textarea
              className="po-textarea small"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <div className="form-actions">
            <button className="btn" onClick={makePreview} disabled={busy || vendorIds.length === 0}>
              {busy ? "생성 중…" : "이메일 미리보기"}
            </button>
          </div>
        </>
      ) : (
        <>
          {!smtpConfigured ? (
            <div className="action-err">
              SMTP 미설정: 이메일은 발송되지 않고 DB 저장만 가능합니다.
            </div>
          ) : null}
          {previews.map((p, i) => (
            <div key={p.vendor_id} className="panel" style={{ boxShadow: "none" }}>
              <div className="sub-h">{p.vendor_name}</div>
              <div className="form-grid">
                <div className="form-field">
                  <label>수신자 이메일</label>
                  <input value={p.to} onChange={(e) => patchPreview(i, "to", e.target.value)} />
                </div>
                <div className="form-field">
                  <label>제목</label>
                  <input value={p.subject} onChange={(e) => patchPreview(i, "subject", e.target.value)} />
                </div>
              </div>
              <div className="form-field">
                <label>본문</label>
                <textarea
                  className="po-textarea"
                  value={p.body}
                  onChange={(e) => patchPreview(i, "body", e.target.value)}
                />
              </div>
              <button className="btn" onClick={() => downloadXlsx(p)}>
                견적서 양식 XLSX 다운로드
              </button>
            </div>
          ))}
          <div className="form-actions">
            <button className="btn primary" onClick={sendAll} disabled={busy}>
              {busy ? "처리 중…" : "발송 + DB 저장"}
            </button>
            <button className="btn" onClick={() => setPreviews([])}>
              취소
            </button>
          </div>
        </>
      )}
      {msg ? <span className="action-ok">{msg}</span> : null}
      {err ? <span className="action-err">{err}</span> : null}
    </>
  );
}

function VendorQuoteAction({
  rfqId,
  vendorRfqs,
  onDone,
}: {
  rfqId: number;
  vendorRfqs: RfqDetailT["vendor_rfqs"];
  onDone: () => void;
}) {
  const [vrfqId, setVrfqId] = useState<number | "">("");
  const [no, setNo] = useState("");
  const [receivedDate, setReceivedDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<VendorQuoteItem[]>([]);
  const [parseMsg, setParseMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const disabled = vendorRfqs.length === 0;

  useEffect(() => {
    if (vrfqId === "") {
      setItems([]);
      return;
    }
    setItems([]);
    setParseMsg(null);
  }, [vrfqId]);

  async function parseFile(file: File | null) {
    if (!file) return;
    setBusy(true);
    setErr(null);
    setParseMsg(null);
    try {
      const r = await parseVendorQuoteFile(file);
      const parsed = r.items || [];
      setItems((prev) => mergeParsedItems(prev.length ? prev : [], parsed));
      setParseMsg(`${parsed.length}개 품목의 가격·납기·원산지 추출 완료`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "파일 파싱 실패");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (vrfqId === "" || !no.trim()) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const clean = cleanVendorQuoteItems(items);
      const amount = clean.reduce(
        (sum, it) => sum + (Number(it.cost_price || 0) * Number(it.qty || 1)),
        0
      );
      const r = await createVendorQuote(
        rfqId,
        vrfqId,
        no.trim(),
        amount,
        clean,
        receivedDate,
        notes
      );
      setMsg(`수신 등록 완료 — ${r.vendor_quote_no}`);
      setNo("");
      setNotes("");
      setItems([]);
      setVrfqId("");
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "등록 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="sub-h">Vendor Quote 수신 등록</div>
      {disabled ? (
        <span className="hint-inline">먼저 Vendor RFQ를 발신하세요.</span>
      ) : (
        <>
          <div className="form-grid">
            <div className="form-field">
              <label>Vendor RFQ 선택</label>
              <select
                value={vrfqId}
                onChange={(e) =>
                  setVrfqId(e.target.value === "" ? "" : Number(e.target.value))
                }
              >
                <option value="">Vendor RFQ 선택…</option>
                {vendorRfqs.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.vrfq_no} · {v.vendor}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label>Vendor 견적번호</label>
              <input value={no} onChange={(e) => setNo(e.target.value)} />
            </div>
            <div className="form-field">
              <label>견적 수신일</label>
              <input
                type="date"
                value={receivedDate}
                onChange={(e) => setReceivedDate(e.target.value)}
              />
            </div>
          </div>

          <div className="po-work-note" style={{ marginTop: 12 }}>
            <b>Vendor 견적 파일 업로드</b>
            <span>Vendor가 반환한 PDF 또는 Excel 파일을 업로드하면 Unit Price, Lead Time, Origin 등이 자동으로 채워집니다.</span>
          </div>
          <div className="action-row">
            <input
              type="file"
              accept=".pdf,.xlsx,.xls,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              disabled={busy || vrfqId === ""}
              onChange={(e) => parseFile(e.target.files?.[0] ?? null)}
            />
            {parseMsg ? <span className="action-ok">{parseMsg}</span> : null}
          </div>

          <VendorQuoteItemEditor items={items} onChange={setItems} />

          <div className="form-field" style={{ marginTop: 12 }}>
            <label>비고</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          <div className="form-actions">
            <button
              className="btn primary"
              onClick={submit}
              disabled={busy || vrfqId === "" || !no.trim()}
            >
              {busy ? "등록 중…" : "견적 저장"}
            </button>
          </div>
        </>
      )}
      {msg ? <span className="action-ok">{msg}</span> : null}
      {err ? <span className="action-err">{err}</span> : null}
    </div>
  );
}

function VendorQuoteItemEditor({
  items,
  onChange,
}: {
  items: VendorQuoteItem[];
  onChange: (items: VendorQuoteItem[]) => void;
}) {
  function add() {
    onChange([
      ...items,
      {
        part_no: "",
        description: "",
        maker: "",
        origin: "",
        qty: 1,
        unit: "PCS",
        cost_price: 0,
        lead_time: "",
        remark: "",
      },
    ]);
  }
  function patch(i: number, key: keyof VendorQuoteItem, value: string) {
    onChange(
      items.map((it, idx) => {
        if (idx !== i) return it;
        if (key === "qty" || key === "cost_price") {
          return { ...it, [key]: value === "" ? null : Number(value) };
        }
        return { ...it, [key]: value };
      })
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div className="sub-h">견적 품목</div>
      <div className="table-wrap">
        <table className="mini wide">
          <thead>
            <tr>
              <th>Part No.</th>
              <th>품명</th>
              <th>Maker</th>
              <th>Origin</th>
              <th className="num">Qty</th>
              <th>Unit</th>
              <th className="num">Unit Price</th>
              <th>Lead Time</th>
              <th>Remark</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i}>
                <td><input value={it.part_no} onChange={(e) => patch(i, "part_no", e.target.value)} /></td>
                <td><input value={it.description} onChange={(e) => patch(i, "description", e.target.value)} /></td>
                <td><input value={it.maker ?? ""} onChange={(e) => patch(i, "maker", e.target.value)} /></td>
                <td><input value={it.origin ?? ""} onChange={(e) => patch(i, "origin", e.target.value)} /></td>
                <td><input className="num" value={it.qty ?? ""} onChange={(e) => patch(i, "qty", e.target.value)} /></td>
                <td><input value={it.unit} onChange={(e) => patch(i, "unit", e.target.value)} /></td>
                <td><input className="num" value={it.cost_price ?? ""} onChange={(e) => patch(i, "cost_price", e.target.value)} /></td>
                <td><input value={it.lead_time ?? ""} onChange={(e) => patch(i, "lead_time", e.target.value)} /></td>
                <td><input value={it.remark ?? ""} onChange={(e) => patch(i, "remark", e.target.value)} /></td>
                <td>
                  <button className="row-del" disabled={items.length === 0} onClick={() => onChange(items.filter((_, idx) => idx !== i))}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn" style={{ marginTop: 8 }} onClick={add}>품목 추가</button>
    </div>
  );
}

function mergeParsedItems(
  base: VendorQuoteItem[],
  parsed: Partial<VendorQuoteItem>[]
): VendorQuoteItem[] {
  if (!base.length) {
    return parsed.map(normalizeVendorQuoteItem);
  }
  const pmap = new Map(
    parsed
      .filter((p) => p.part_no)
      .map((p) => [String(p.part_no).trim(), p])
  );
  return base.map((row) => {
    const p = pmap.get(row.part_no.trim());
    if (!p) return row;
    return normalizeVendorQuoteItem({ ...row, ...p, maker: p.maker ?? p.manufacturer ?? row.maker });
  });
}

function normalizeVendorQuoteItem(raw: Partial<VendorQuoteItem> & { manufacturer?: string }): VendorQuoteItem {
  return {
    item_no: raw.item_no,
    part_no: raw.part_no ?? "",
    description: raw.description ?? "",
    maker: raw.maker ?? raw.manufacturer ?? "",
    origin: raw.origin ?? "",
    qty: Number(raw.qty ?? 1) || 1,
    unit: raw.unit ?? "PCS",
    cost_price: raw.cost_price === undefined || raw.cost_price === null ? 0 : Number(raw.cost_price),
    lead_time: raw.lead_time ?? "",
    remark: raw.remark ?? "",
  };
}

function cleanVendorQuoteItems(items: VendorQuoteItem[]): VendorQuoteItem[] {
  return items.map(normalizeVendorQuoteItem).filter((it) => it.part_no || it.description);
}

function CustomerQuoteAction({
  rfqId,
  onDone,
}: {
  rfqId: number;
  onDone: () => void;
}) {
  const [currency, setCurrency] = useState("USD");
  const [items, setItems] = useState<CustomerQuoteItem[]>([]);
  const [validUntil, setValidUntil] = useState("");
  const [remarks, setRemarks] = useState("Bank charges outside Korea shall be borne by Buyer.");
  const [qtn, setQtn] = useState<{ id: number; qtn_no: string } | null>(null);
  const [email, setEmail] = useState<{ to: string; subject: string; body: string; smtp_configured: boolean } | null>(null);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchRfqDetail(rfqId)
      .then((d) =>
        setItems(
          d.items.map((it) => ({
            part_no: it.part_no,
            description: it.description,
            qty: Number(it.qty || 1),
            unit: it.unit || "PCS",
            cost_price: it.unit_price || 0,
            margin_pct: 20,
            unit_price: calcUnitPrice(it.unit_price || 0, 20),
            amount: calcUnitPrice(it.unit_price || 0, 20) * Number(it.qty || 1),
          }))
        )
      )
      .catch(() => setItems([]));
  }, [rfqId]);

  const total = items.reduce((sum, it) => sum + Number(it.amount || 0), 0);

  async function submit() {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await createCustomerQuote(rfqId, currency, total, items, validUntil, remarks);
      setQtn({ id: r.id, qtn_no: r.qtn_no });
      setMsg(`발신 완료 — ${r.qtn_no}`);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "발신 실패");
    } finally {
      setBusy(false);
    }
  }

  async function makeEmailPreview() {
    if (!qtn) return;
    setBusy(true);
    setErr(null);
    try {
      const p = await previewQuotationEmail(qtn.id, "en");
      setEmail(p);
      setTo(p.to);
      setSubject(p.subject);
      setBody(p.body);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "이메일 미리보기 실패");
    } finally {
      setBusy(false);
    }
  }

  async function downloadPdf() {
    if (!qtn) return;
    const res = await fetch(quotationPdfUrl(qtn.id), {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) {
      setErr("PDF 다운로드 실패");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${qtn.qtn_no}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function sendEmail() {
    if (!qtn) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await sendQuotationEmail(qtn.id, to, subject, body);
      setMsg(`이메일 발송 완료: ${r.sent_date}`);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "이메일 발송 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="sub-h">Customer Quotation 작성·발신</div>
      <div className="form-grid">
        <div className="form-field">
          <label>통화</label>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option>USD</option>
            <option>EUR</option>
            <option>KRW</option>
            <option>SGD</option>
          </select>
        </div>
        <div className="form-field">
          <label>유효기간</label>
          <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
        </div>
      </div>
      <CustomerQuoteItemEditor items={items} onChange={setItems} />
      <div className="form-field" style={{ marginTop: 12 }}>
        <label>Remarks</label>
        <input value={remarks} onChange={(e) => setRemarks(e.target.value)} />
      </div>
      <div className="form-actions">
        <span className="action-name">합계: {currency} {total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        <button className="btn primary" onClick={submit} disabled={busy || items.length === 0}>
          {busy ? "저장 중…" : "견적 저장"}
        </button>
        {qtn ? <button className="btn" onClick={downloadPdf}>PDF 다운로드</button> : null}
        {qtn ? <button className="btn" onClick={makeEmailPreview}>이메일 미리보기</button> : null}
      </div>

      {email ? (
        <div className="panel" style={{ boxShadow: "none" }}>
          {!email.smtp_configured ? <div className="action-err">SMTP 미설정: 실제 발송할 수 없습니다.</div> : null}
          <div className="form-grid">
            <div className="form-field">
              <label>수신자 이메일</label>
              <input value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="form-field">
              <label>제목</label>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
          </div>
          <div className="form-field">
            <label>본문</label>
            <textarea className="po-textarea" value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          <button className="btn primary" onClick={sendEmail} disabled={busy || !to || !email.smtp_configured}>
            이메일 발송
          </button>
        </div>
      ) : null}
      {msg ? <span className="action-ok">{msg}</span> : null}
      {err ? <span className="action-err">{err}</span> : null}
    </div>
  );
}

function CustomerQuoteItemEditor({
  items,
  onChange,
}: {
  items: CustomerQuoteItem[];
  onChange: (items: CustomerQuoteItem[]) => void;
}) {
  function patch(i: number, key: keyof CustomerQuoteItem, value: string) {
    onChange(
      items.map((it, idx) => {
        if (idx !== i) return it;
        const next: CustomerQuoteItem = { ...it };
        if (key === "qty" || key === "cost_price" || key === "margin_pct" || key === "unit_price" || key === "amount") {
          (next[key] as number | null) = value === "" ? null : Number(value);
        } else {
          (next[key] as string) = value;
        }
        if (key === "cost_price" || key === "margin_pct" || key === "qty") {
          const unit = calcUnitPrice(Number(next.cost_price || 0), Number(next.margin_pct || 0));
          next.unit_price = unit;
          next.amount = unit * Number(next.qty || 1);
        }
        if (key === "unit_price" || key === "qty") {
          next.amount = Number(next.unit_price || 0) * Number(next.qty || 1);
        }
        return next;
      })
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div className="sub-h">견적 품목</div>
      <div className="table-wrap">
        <table className="mini wide">
          <thead>
            <tr>
              <th>Part No.</th>
              <th>품명</th>
              <th className="num">Qty</th>
              <th>Unit</th>
              <th className="num">Cost</th>
              <th className="num">Margin %</th>
              <th className="num">Unit Price</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i}>
                <td><input value={it.part_no} onChange={(e) => patch(i, "part_no", e.target.value)} /></td>
                <td><input value={it.description} onChange={(e) => patch(i, "description", e.target.value)} /></td>
                <td><input className="num" value={it.qty ?? ""} onChange={(e) => patch(i, "qty", e.target.value)} /></td>
                <td><input value={it.unit} onChange={(e) => patch(i, "unit", e.target.value)} /></td>
                <td><input className="num" value={it.cost_price ?? ""} onChange={(e) => patch(i, "cost_price", e.target.value)} /></td>
                <td><input className="num" value={it.margin_pct ?? ""} onChange={(e) => patch(i, "margin_pct", e.target.value)} /></td>
                <td><input className="num" value={it.unit_price ?? ""} onChange={(e) => patch(i, "unit_price", e.target.value)} /></td>
                <td><input className="num" value={it.amount ?? ""} onChange={(e) => patch(i, "amount", e.target.value)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function calcUnitPrice(cost: number, marginPct: number) {
  return Number((cost * (1 + marginPct / 100)).toFixed(2));
}
