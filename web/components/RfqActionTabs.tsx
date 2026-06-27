"use client";

import { useEffect, useRef, useState } from "react";
import {
  fetchVendors,
  fetchRfqDetail,
  fetchRfqVendorQuotes,
  createVendorRfq,
  assignRfqNo,
  previewVendorRfq,
  sendVendorRfq,
  vendorRfqXlsxUrl,
  createVendorQuote,
  parseVendorQuoteFile,
  createCustomerQuote,
  quotationPdfUrl,
  previewQuotationEmail,
  sendQuotationEmail,
  fetchVrfqOverview,
  fetchVendorQuoteOverview,
  fetchQuotationOverview,
  fetchVendorRfqDetail,
  updateVendorRfq,
  deleteVendorRfq,
  fetchVendorQuoteDetail,
  updateVendorQuote,
  deleteVendorQuote,
  fetchCustomerQuotationDetail,
  updateCustomerQuotation,
  deleteCustomerQuotation,
} from "@/lib/api";
import { getToken } from "@/lib/auth";
import type {
  VendorOption,
  RfqRow,
  RfqDetail as RfqDetailT,
  VendorRfqPreview,
  VendorQuoteItem,
  CustomerQuoteItem,
  QuotationTerms,
  VendorQuoteForImport,
  VrfqRow,
  VendorQuoteOverviewRow,
  QtnRow,
  VendorRfqDetail,
  VendorQuoteDetail,
  CustomerQuotationDetail,
  RfqItem,
} from "@/lib/types";
import NewRfqForm from "./screens/NewRfqForm";
import WorkTypeBadge from "./WorkTypeBadge";
import FilterTable, { ColumnDef } from "./common/FilterTable";
import Modal from "./common/Modal";

/** 현재 시각 "YYYY-MM-DDTHH:MM" (datetime-local 기본값). */
function nowLocalDt(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

// 원본 rfq_quotation.py 하단의 작업 segmented control(4탭)을 복원.
const TABS = [
  { key: "new", label: "1. Customer RFQ 수신" },
  { key: "vrfq", label: "2. Vendor RFQ 발신" },
  { key: "vquote", label: "3. Vendor Quot. 수신" },
  { key: "cquote", label: "4. Customer Quot. 발신" },
];

function money(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function RfqActionTabs({
  rfqId,
  rows,
  onSelect,
  onChanged,
}: {
  rfqId: number | null;
  rows: RfqRow[];
  onSelect: (id: number | null) => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState("new");
  const [vendors, setVendors] = useState<VendorOption[]>([]);

  useEffect(() => {
    fetchVendors().then(setVendors).catch(() => setVendors([]));
  }, []);

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

      {tab === "new" && (
        <CustomerRfqList rows={rows} deepLinkId={rfqId} onSelect={onSelect} onChanged={onChanged} />
      )}
      {tab === "vrfq" && (
        <VendorRfqList projects={rows} vendors={vendors} onChanged={onChanged} />
      )}
      {tab === "vquote" && <VendorQuoteList projects={rows} onChanged={onChanged} />}
      {tab === "cquote" && <CustomerQuoteList projects={rows} onChanged={onChanged} />}
    </div>
  );
}

// 신규 등록 모달 상단의 '진행중인 프로젝트(RFQ)' 선택기 — 2~4번 탭 등록 폼에서 사용.
function ProjectPicker({
  projects,
  rfqId,
  onSelect,
}: {
  projects: RfqRow[];
  rfqId: number | null;
  onSelect: (id: number | null) => void;
}) {
  return <ProjectSelect rows={projects} rfqId={rfqId} onSelect={onSelect} />;
}

// ── 1. Customer RFQ 수신 ────────────────────────────────────────────────────
function CustomerRfqList({
  rows,
  deepLinkId,
  onSelect,
  onChanged,
}: {
  rows: RfqRow[];
  deepLinkId: number | null;
  onSelect: (id: number | null) => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(deepLinkId);

  useEffect(() => {
    setDetailId(deepLinkId);
  }, [deepLinkId]);

  const columns: ColumnDef<RfqRow>[] = [
    {
      key: "customer_rfq_no",
      label: "고객 RFQ No.",
      text: (r) => r.customer_rfq_no || "",
      render: (r) => (
        <div>
          <div className="m">{r.customer_rfq_no || <span className="dash">—</span>}</div>
          {r.crfq_at ? <div className="s">{r.crfq_at}</div> : null}
        </div>
      ),
    },
    { key: "customer", label: "Customer", text: (r) => r.customer || "", filter: "facet" },
    {
      key: "work_type",
      label: "업무 타입",
      text: (r) => r.work_type || "부품공급",
      filter: "facet",
      render: (r) => <WorkTypeBadge type={r.work_type} />,
    },
    { key: "vessel", label: "선박", text: (r) => (r.vessel && r.vessel !== "—" ? r.vessel : ""), filter: "facet" },
    {
      key: "item_count",
      label: "품목수",
      numeric: true,
      text: (r) => String(r.item_count),
      sortValue: (r) => r.item_count,
    },
  ];

  return (
    <>
      <FilterTable
        rows={rows}
        columns={columns}
        getRowKey={(r) => r.id}
        onRowClick={(r) => setDetailId(r.id)}
        empty="등록된 RFQ가 없습니다."
        actions={
          <button className="btn primary" onClick={() => setAdding(true)}>
            + 신규 등록
          </button>
        }
      />

      {adding ? (
        <Modal title="Customer RFQ 신규 등록" onClose={() => setAdding(false)} wide>
          <NewRfqForm
            onCreated={() => {
              setAdding(false);
              onChanged();
            }}
            onCancel={() => setAdding(false)}
          />
        </Modal>
      ) : null}

      {detailId !== null ? (
        <Modal title="Customer RFQ 상세" onClose={() => setDetailId(null)} wide>
          <NewRfqForm
            autoLoadId={detailId}
            onCreated={() => {
              setDetailId(null);
              onSelect(null);
              onChanged();
            }}
            onCancel={() => {
              setDetailId(null);
              onSelect(null);
            }}
            onDeleted={() => {
              setDetailId(null);
              onSelect(null);
              onChanged();
            }}
          />
        </Modal>
      ) : null}
    </>
  );
}

// ── 2. Vendor RFQ 발신 ──────────────────────────────────────────────────────
function VendorRfqList({
  projects,
  vendors,
  onChanged,
}: {
  projects: RfqRow[];
  vendors: VendorOption[];
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<VrfqRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [pickRfqId, setPickRfqId] = useState<number | null>(null);

  function load() {
    fetchVrfqOverview()
      .then((d) => setRows(d.rows))
      .catch((e) => setError(e instanceof Error ? e.message : "오류"));
  }
  useEffect(load, []);

  const refresh = () => {
    load();
    onChanged();
  };

  const columns: ColumnDef<VrfqRow>[] = [
    { key: "vrfq_no", label: "VRFQ No.", text: (r) => r.vrfq_no || "" },
    { key: "customer_rfq_no", label: "고객 RFQ No.", text: (r) => r.customer_rfq_no || "" },
    { key: "vendor", label: "Vendor", text: (r) => r.vendor || "", filter: "facet" },
    { key: "vendor_email", label: "수신자 이메일", text: (r) => r.vendor_email || "" },
    { key: "sent_date", label: "발송일", text: (r) => r.sent_date || "", filter: "date" },
    { key: "item_count", label: "품목수", numeric: true, text: (r) => String(r.item_count), sortValue: (r) => r.item_count },
    { key: "quote_count", label: "수신 견적", numeric: true, text: (r) => `${r.quote_count}건`, sortValue: (r) => r.quote_count },
    {
      key: "status",
      label: "상태",
      text: (r) => r.status || "",
      filter: "facet",
      render: (r) => <span className="ar-badge">{r.status}</span>,
    },
  ];

  if (error) return <div className="state error">API 오류: {error}</div>;

  const kmarisNo = pickRfqId !== null ? projects.find((p) => p.id === pickRfqId)?.crfq_no ?? "" : "";

  return (
    <>
      <FilterTable
        rows={rows}
        columns={columns}
        getRowKey={(r) => r.id}
        onRowClick={(r) => setDetailId(r.id)}
        empty="발송된 Vendor RFQ가 없습니다."
        actions={
          <button className="btn primary" onClick={() => { setPickRfqId(null); setAdding(true); }}>
            + 신규 등록
          </button>
        }
      />

      {adding ? (
        <Modal title="Vendor RFQ 발신" onClose={() => setAdding(false)} wide>
          <ProjectPicker projects={projects} rfqId={pickRfqId} onSelect={setPickRfqId} />
          {pickRfqId === null ? (
            <div className="empty">진행중인 프로젝트를 먼저 선택하세요.</div>
          ) : (
            <VendorRfqAction
              rfqId={pickRfqId}
              vendors={vendors}
              kmarisNo={kmarisNo}
              onDone={() => {
                setAdding(false);
                refresh();
              }}
            />
          )}
        </Modal>
      ) : null}

      {detailId !== null ? (
        <VendorRfqDetailModal
          id={detailId}
          vendors={vendors}
          onClose={() => setDetailId(null)}
          onChanged={refresh}
        />
      ) : null}
    </>
  );
}

function VendorRfqDetailModal({
  id,
  vendors,
  onClose,
  onChanged,
}: {
  id: number;
  vendors: VendorOption[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [d, setD] = useState<VendorRfqDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [vrfqNo, setVrfqNo] = useState("");
  const [vendorId, setVendorId] = useState<number | "">("");
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("");
  const [sentAt, setSentAt] = useState("");
  const [items, setItems] = useState<RfqItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchVendorRfqDetail(id)
      .then((data) => {
        setD(data);
        setVrfqNo(data.vrfq_no || "");
        setVendorId(data.vendor_id || "");
        setEmail(data.vendor_email || "");
        setStatus(data.status || "");
        setSentAt(data.sent_at || "");
        setItems(data.items || []);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "오류"));
  }, [id]);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await updateVendorRfq(id, {
        vrfq_no: vrfqNo,
        vendor_id: vendorId === "" ? undefined : vendorId,
        sent_to_email: email,
        status,
        sent_at: sentAt,
        items,
      });
      setEditing(false);
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "수정 실패");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("이 Vendor RFQ를 삭제할까요?")) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteVendorRfq(id);
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "삭제 실패");
      setBusy(false);
    }
  }

  return (
    <Modal title={d ? `Vendor RFQ — ${d.vrfq_no}` : "Vendor RFQ 상세"} onClose={onClose} wide>
      {!d ? (
        <div className="empty">불러오는 중…</div>
      ) : (
        <>
          {editing ? (
            <>
              <div className="form-section-title">프로젝트 기본 정보</div>
              <dl className="intl-meta">
                <div><dt>고객사</dt><dd>{d.customer || "—"}</dd></div>
                <div><dt>선박</dt><dd>{d.vessel || "—"}</dd></div>
                <div><dt>프로젝트명</dt><dd>{d.project_title || "—"}</dd></div>
                <div><dt>품목 수</dt><dd>{items.length}</dd></div>
                <div><dt>Customer RFQ No.</dt><dd>{d.customer_rfq_no || "—"}</dd></div>
                <div><dt>K-Maris RFQ No.</dt><dd>{d.kmaris_rfq_no || "—"}</dd></div>
                <div><dt>수신일</dt><dd>{d.received_at || "—"}</dd></div>
                <div><dt>업무 유형</dt><dd>{d.work_type || "—"}</dd></div>
              </dl>

              <div className="form-section-title">이 Vendor 발송 정보</div>
              <div className="form-grid">
                <div className="form-field">
                  <label>VRFQ No.</label>
                  <input value={vrfqNo} onChange={(e) => setVrfqNo(e.target.value)} />
                </div>
                <div className="form-field">
                  <label>Vendor</label>
                  <select value={vendorId} onChange={(e) => setVendorId(e.target.value === "" ? "" : Number(e.target.value))}>
                    <option value="">선택…</option>
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <label>수신 담당자 이메일</label>
                  <input value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div className="form-field">
                  <label>발신 일시</label>
                  <input type="datetime-local" value={sentAt} onChange={(e) => setSentAt(e.target.value)} />
                </div>
                <div className="form-field">
                  <label>상태</label>
                  <input value={status} onChange={(e) => setStatus(e.target.value)} />
                </div>
              </div>

              <VendorRfqItemEditor items={items} onChange={setItems} />
            </>
          ) : (
            <>
              <div className="form-section-title">프로젝트 기본 정보</div>
              <dl className="intl-meta">
                <div><dt>고객사</dt><dd>{d.customer || "—"}</dd></div>
                <div><dt>선박</dt><dd>{d.vessel || "—"}</dd></div>
                <div><dt>프로젝트명</dt><dd>{d.project_title || "—"}</dd></div>
                <div><dt>품목 수</dt><dd>{d.items.length}</dd></div>
                <div><dt>Customer RFQ No.</dt><dd>{d.customer_rfq_no || "—"}</dd></div>
                <div><dt>K-Maris RFQ No.</dt><dd>{d.kmaris_rfq_no || "—"}</dd></div>
                <div><dt>수신 담당자</dt><dd>{d.customer_contact || "—"}</dd></div>
                <div><dt>수신 이메일</dt><dd>{d.customer_email || "—"}</dd></div>
              </dl>

              <div className="form-section-title">이 Vendor 발송 정보</div>
              <dl className="intl-meta">
                <div><dt>VRFQ No.</dt><dd>{d.vrfq_no || "—"}</dd></div>
                <div><dt>Vendor</dt><dd>{d.vendor}</dd></div>
                <div><dt>수신 담당자 이메일</dt><dd>{d.vendor_email || "—"}</dd></div>
                <div><dt>발신 일시</dt><dd>{d.sent_at || d.sent_date || "—"}</dd></div>
                <div><dt>상태</dt><dd>{d.status}</dd></div>
                <div><dt>수신 견적</dt><dd>{d.quote_count}건</dd></div>
              </dl>

              <ProjectVendorRfqList rows={d.project_vendor_rfqs || []} />
            </>
          )}

          <div className="form-actions">
            {editing ? (
              <>
                <button className="btn primary" onClick={save} disabled={busy}>{busy ? "저장 중…" : "저장"}</button>
                <button className="btn" onClick={() => setEditing(false)} disabled={busy}>취소</button>
              </>
            ) : (
              <button className="btn" onClick={() => setEditing(true)} style={{ marginLeft: "auto" }}>✎ 수정</button>
            )}
            <button className="btn danger" onClick={remove} disabled={busy || editing}>삭제</button>
          </div>
          {err ? <span className="action-err">{err}</span> : null}
        </>
      )}
    </Modal>
  );
}

function ProjectVendorRfqList({
  rows,
}: {
  rows: VendorRfqDetail["project_vendor_rfqs"];
}) {
  if (!rows.length) return null;
  return (
    <>
      <div className="form-section-title">같은 프로젝트 Vendor 발송 현황</div>
      <div className="table-wrap compact">
        <table className="mini wide">
          <thead>
            <tr>
              <th>VRFQ No.</th>
              <th>Vendor</th>
              <th>수신 담당자</th>
              <th>발신 일시</th>
              <th>견적</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.current ? "sel" : ""}>
                <td>{r.vrfq_no}</td>
                <td>{r.vendor}</td>
                <td>{r.vendor_email || "—"}</td>
                <td>{r.sent_at || "—"}</td>
                <td>{r.quote_count}건</td>
                <td>{r.status || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function VendorRfqItemEditor({
  items,
  onChange,
}: {
  items: RfqItem[];
  onChange: (items: RfqItem[]) => void;
}) {
  function patch(i: number, key: keyof RfqItem, value: string) {
    onChange(
      items.map((it, idx) =>
        idx === i
          ? {
              ...it,
              [key]: key === "qty" ? Number(value) || 0 : value,
            }
          : it
      )
    );
  }

  return (
    <>
      <div className="form-section-title">발송 품목</div>
      <div className="table-wrap compact">
        <table className="mini wide">
          <thead>
            <tr>
              <th>Part No.</th>
              <th>Description</th>
              <th>Qty</th>
              <th>Unit</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i}>
                <td><input value={it.part_no || ""} onChange={(e) => patch(i, "part_no", e.target.value)} /></td>
                <td><input value={it.description || ""} onChange={(e) => patch(i, "description", e.target.value)} /></td>
                <td><input className="num" type="number" value={it.qty || 0} onChange={(e) => patch(i, "qty", e.target.value)} /></td>
                <td><input value={it.unit || ""} onChange={(e) => patch(i, "unit", e.target.value)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── 3. Vendor Quot. 수신 ────────────────────────────────────────────────────
function VendorQuoteList({
  projects,
  onChanged,
}: {
  projects: RfqRow[];
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<VendorQuoteOverviewRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [pickRfqId, setPickRfqId] = useState<number | null>(null);
  const [vendorRfqs, setVendorRfqs] = useState<RfqDetailT["vendor_rfqs"]>([]);

  function load() {
    fetchVendorQuoteOverview()
      .then((d) => setRows(d.rows))
      .catch((e) => setError(e instanceof Error ? e.message : "오류"));
  }
  useEffect(load, []);

  // 모달에서 프로젝트 선택 시 해당 RFQ의 Vendor RFQ 목록 로드
  useEffect(() => {
    if (pickRfqId === null) {
      setVendorRfqs([]);
      return;
    }
    fetchRfqDetail(pickRfqId)
      .then((d) => setVendorRfqs(d.vendor_rfqs))
      .catch(() => setVendorRfqs([]));
  }, [pickRfqId]);

  const refresh = () => {
    load();
    onChanged();
  };

  const columns: ColumnDef<VendorQuoteOverviewRow>[] = [
    {
      key: "received_at",
      label: "수신일시",
      text: (r) => (r.received_at && r.received_at.length >= 16 ? `${r.received_at.slice(2, 10)} ${r.received_at.slice(11, 16)}` : r.received_date || ""),
      filter: "date",
      sortValue: (r) => Date.parse(r.received_at || r.received_date || "") || 0,
    },
    { key: "vendor_quote_no", label: "Vendor 견적번호", text: (r) => r.vendor_quote_no || "" },
    { key: "vendor", label: "Vendor", text: (r) => r.vendor || "", filter: "facet" },
    { key: "vrfq_no", label: "VRFQ No.", text: (r) => r.vrfq_no || "" },
    { key: "customer_rfq_no", label: "고객 RFQ No.", text: (r) => r.customer_rfq_no || "" },
    { key: "item_count", label: "품목수", numeric: true, text: (r) => String(r.item_count), sortValue: (r) => r.item_count },
    {
      key: "amount",
      label: "금액",
      numeric: true,
      text: (r) => `${r.currency} ${money(r.amount)}`,
      sortValue: (r) => r.amount,
    },
  ];

  if (error) return <div className="state error">API 오류: {error}</div>;

  return (
    <>
      <FilterTable
        rows={rows}
        columns={columns}
        getRowKey={(r) => r.id}
        onRowClick={(r) => setDetailId(r.id)}
        empty="수신된 Vendor 견적이 없습니다."
        actions={
          <button className="btn primary" onClick={() => { setPickRfqId(null); setAdding(true); }}>
            + 신규 등록
          </button>
        }
      />

      {adding ? (
        <Modal title="Vendor Quote 수신 등록" onClose={() => setAdding(false)} wide>
          <ProjectPicker projects={projects} rfqId={pickRfqId} onSelect={setPickRfqId} />
          {pickRfqId === null ? (
            <div className="empty">진행중인 프로젝트를 먼저 선택하세요.</div>
          ) : (
            <VendorQuoteAction
              rfqId={pickRfqId}
              vendorRfqs={vendorRfqs}
              onDone={() => {
                setAdding(false);
                refresh();
              }}
            />
          )}
        </Modal>
      ) : null}

      {detailId !== null ? (
        <VendorQuoteDetailModal id={detailId} onClose={() => setDetailId(null)} onChanged={refresh} />
      ) : null}
    </>
  );
}

function VendorQuoteDetailModal({
  id,
  onClose,
  onChanged,
}: {
  id: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [d, setD] = useState<VendorQuoteDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [no, setNo] = useState("");
  const [receivedAt, setReceivedAt] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<VendorQuoteItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchVendorQuoteDetail(id)
      .then((data) => {
        setD(data);
        setNo(data.vendor_quote_no || "");
        setReceivedAt(data.received_at || "");
        setNotes(data.notes || "");
        setItems((data.items || []).map(normalizeVendorQuoteItem));
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "오류"));
  }, [id]);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await updateVendorQuote(id, {
        vendor_quote_no: no.trim(),
        received_at: receivedAt,
        notes,
        items: cleanVendorQuoteItems(items),
      });
      setEditing(false);
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "수정 실패");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("이 Vendor 견적을 삭제할까요?")) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteVendorQuote(id);
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "삭제 실패");
      setBusy(false);
    }
  }

  return (
    <Modal title={d ? `Vendor 견적 — ${d.vendor_quote_no}` : "Vendor 견적 상세"} onClose={onClose} wide>
      {!d ? (
        <div className="empty">불러오는 중…</div>
      ) : editing ? (
        <>
          <div className="form-grid">
            <div className="form-field">
              <label>Vendor 견적번호</label>
              <input value={no} onChange={(e) => setNo(e.target.value)} />
            </div>
            <div className="form-field">
              <label>견적 수신일시</label>
              <input type="datetime-local" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
            </div>
            <div className="form-field">
              <label>비고</label>
              <input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
          <VendorQuoteItemEditor items={items} onChange={setItems} />
          <div className="form-actions">
            <button className="btn primary" onClick={save} disabled={busy}>{busy ? "저장 중…" : "저장"}</button>
            <button className="btn" onClick={() => setEditing(false)} disabled={busy}>취소</button>
          </div>
          {err ? <span className="action-err">{err}</span> : null}
        </>
      ) : (
        <>
          <dl className="intl-meta">
            <div><dt>Vendor</dt><dd>{d.vendor}</dd></div>
            <div><dt>VRFQ No.</dt><dd>{d.vrfq_no}</dd></div>
            <div><dt>고객 RFQ No.</dt><dd>{d.customer_rfq_no || "—"}</dd></div>
            <div><dt>수신일</dt><dd>{d.received_date || "—"}</dd></div>
            <div><dt>비고</dt><dd>{d.notes || "—"}</dd></div>
            <div><dt>품목 수</dt><dd>{d.items.length}</dd></div>
          </dl>
          <div className="form-actions">
            <button className="btn" onClick={() => setEditing(true)} style={{ marginLeft: "auto" }}>✎ 수정</button>
            <button className="btn danger" onClick={remove} disabled={busy}>삭제</button>
          </div>
          {err ? <span className="action-err">{err}</span> : null}
        </>
      )}
    </Modal>
  );
}

// ── 4. Customer Quot. 발신 ──────────────────────────────────────────────────
function CustomerQuoteList({
  projects,
  onChanged,
}: {
  projects: RfqRow[];
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<QtnRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [pickRfqId, setPickRfqId] = useState<number | null>(null);

  function load() {
    fetchQuotationOverview()
      .then((d) => setRows(d.rows))
      .catch((e) => setError(e instanceof Error ? e.message : "오류"));
  }
  useEffect(load, []);

  const refresh = () => {
    load();
    onChanged();
  };

  const columns: ColumnDef<QtnRow>[] = [
    {
      key: "qtn_no",
      label: "견적 No.",
      text: (r) => r.qtn_no || "",
      render: (r) => (
        <div>
          <div className="m">{r.qtn_no || <span className="dash">—</span>}</div>
          {r.sent_date ? <div className="s">발신: {r.sent_date}</div> : null}
        </div>
      ),
    },
    { key: "rfq_no", label: "RFQ No.", text: (r) => r.rfq_no || "" },
    { key: "customer", label: "Customer", text: (r) => r.customer || "", filter: "facet" },
    { key: "vessel", label: "선박", text: (r) => r.vessel || "", filter: "facet" },
    { key: "item_count", label: "품목수", numeric: true, text: (r) => String(r.item_count), sortValue: (r) => r.item_count },
    { key: "amount", label: "합계", numeric: true, text: (r) => `${r.currency} ${money(r.amount)}`, sortValue: (r) => r.amount },
    { key: "level", label: "Level", text: (r) => r.level || "" },
    { key: "valid_until", label: "유효기간", text: (r) => r.valid_until || "", filter: "date" },
    { key: "status", label: "상태", text: (r) => r.status || "", filter: "facet", render: (r) => <span className="ar-badge">{r.status}</span> },
  ];

  if (error) return <div className="state error">API 오류: {error}</div>;

  return (
    <>
      <FilterTable
        rows={rows}
        columns={columns}
        getRowKey={(r) => r.id}
        onRowClick={(r) => setDetailId(r.id)}
        empty="표시할 견적이 없습니다."
        actions={
          <button className="btn primary" onClick={() => { setPickRfqId(null); setAdding(true); }}>
            + 신규 등록
          </button>
        }
      />

      {adding ? (
        <Modal title="Customer Quotation 작성·발신" onClose={() => setAdding(false)} wide>
          <ProjectPicker projects={projects} rfqId={pickRfqId} onSelect={setPickRfqId} />
          {pickRfqId === null ? (
            <div className="empty">진행중인 프로젝트를 먼저 선택하세요.</div>
          ) : (
            <CustomerQuoteAction
              rfqId={pickRfqId}
              onDone={() => {
                setAdding(false);
                refresh();
              }}
            />
          )}
        </Modal>
      ) : null}

      {detailId !== null ? (
        <CustomerQuoteDetailModal id={detailId} onClose={() => setDetailId(null)} onChanged={refresh} />
      ) : null}
    </>
  );
}

function CustomerQuoteDetailModal({
  id,
  onClose,
  onChanged,
}: {
  id: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [d, setD] = useState<CustomerQuotationDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [currency, setCurrency] = useState("USD");
  const [validUntil, setValidUntil] = useState("");
  const [status, setStatus] = useState("");
  const [terms, setTerms] = useState<QuotationTerms>({});
  const [items, setItems] = useState<CustomerQuoteItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchCustomerQuotationDetail(id)
      .then((data) => {
        setD(data);
        setCurrency(data.currency || "USD");
        setValidUntil(data.valid_until || "");
        setStatus(data.status || "");
        setTerms(data.terms || {});
        setItems(data.items || []);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "오류"));
  }, [id]);

  const total = items.reduce((sum, it) => sum + Number(it.amount || 0), 0);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await updateCustomerQuotation(id, {
        currency,
        valid_until: validUntil,
        status,
        terms,
        items,
      });
      setEditing(false);
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "수정 실패");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("이 견적서를 삭제할까요?")) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteCustomerQuotation(id);
      onChanged();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "삭제 실패");
      setBusy(false);
    }
  }

  const STATUSES = ["초안", "발송완료", "협상중", "수주확정", "실주", "만료"];

  return (
    <Modal title={d ? `견적서 — ${d.qtn_no}` : "견적서 상세"} onClose={onClose} wide>
      {!d ? (
        <div className="empty">불러오는 중…</div>
      ) : editing ? (
        <>
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
            <div className="form-field">
              <label>상태</label>
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>
          <CustomerQuoteItemEditor items={items} onChange={setItems} />
          <QuotationTermsEditor terms={terms} onChange={setTerms} />
          <div className="form-actions">
            <span className="action-name">합계: {currency} {money(total)}</span>
            <button className="btn primary" onClick={save} disabled={busy}>{busy ? "저장 중…" : "저장"}</button>
            <button className="btn" onClick={() => setEditing(false)} disabled={busy}>취소</button>
          </div>
          {err ? <span className="action-err">{err}</span> : null}
        </>
      ) : (
        <>
          <dl className="intl-meta">
            <div><dt>RFQ No.</dt><dd>{d.rfq_no || "—"}</dd></div>
            <div><dt>Customer</dt><dd>{d.customer}</dd></div>
            <div><dt>선박</dt><dd>{d.vessel || "—"}</dd></div>
            <div><dt>합계</dt><dd>{d.currency} {money(d.amount)}</dd></div>
            <div><dt>유효기간</dt><dd>{d.valid_until || "—"}</dd></div>
            <div><dt>상태</dt><dd>{d.status}</dd></div>
            <div><dt>품목 수</dt><dd>{d.items.length}</dd></div>
          </dl>
          <div className="form-actions">
            <button className="btn" onClick={() => setEditing(true)} style={{ marginLeft: "auto" }}>✎ 수정</button>
            <button className="btn danger" onClick={remove} disabled={busy}>삭제</button>
          </div>
          {err ? <span className="action-err">{err}</span> : null}
        </>
      )}
    </Modal>
  );
}

// 옵션 한 줄을 세그먼트별로 색·굵기를 달리해 표시한다. 기본 <select>는 옵션
// 내부 스타일링을 지원하지 않으므로 커스텀 드롭다운(ProjectSelect)에서 쓴다.
// RFQ번호=회색, 고객사=진하게, 선박명=기본, 프로젝트명=회색.
function ProjectOptionLabel({ r }: { r: RfqRow }) {
  const no = r.crfq_no || r.customer_rfq_no || `RFQ-${r.id}`;
  const vessel = r.vessel && r.vessel !== "—" ? r.vessel : "";
  const title = r.project_title || "";
  return (
    <span className="proj-label">
      <span className="proj-no">{no}</span>
      <span className="proj-sep"> · </span>
      <span className="proj-cust">{r.customer}</span>
      {vessel ? (
        <>
          <span className="proj-sep"> · </span>
          <span className="proj-vessel">{vessel}</span>
        </>
      ) : null}
      {title ? (
        <>
          <span className="proj-sep"> · </span>
          <span className="proj-title">{title}</span>
        </>
      ) : null}
    </span>
  );
}

// 각 탭 상단에 위치하는 "진행중인 프로젝트" 셀렉터. 선택한 RFQ가 2~4번 탭의 작업 대상이 된다.
// 세그먼트별 색 구분을 위해 기본 <select> 대신 커스텀 드롭다운으로 구현했다.
function ProjectSelect({
  rows,
  rfqId,
  onSelect,
}: {
  rows: RfqRow[];
  rfqId: number | null;
  onSelect: (id: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = rows.find((r) => r.id === rfqId) ?? null;

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="project-select">
      <label>진행중인 프로젝트</label>
      <div className="proj-combo" ref={ref}>
        <button
          type="button"
          className="proj-combo-btn"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          {selected ? (
            <ProjectOptionLabel r={selected} />
          ) : (
            <span className="proj-placeholder">선택…</span>
          )}
          <span className="proj-caret" aria-hidden>
            ▾
          </span>
        </button>
        {open ? (
          <ul className="proj-combo-list" role="listbox">
            <li
              className="proj-combo-item"
              role="option"
              aria-selected={rfqId === null}
              onClick={() => {
                onSelect(null);
                setOpen(false);
              }}
            >
              <span className="proj-placeholder">선택…</span>
            </li>
            {rows.map((r) => (
              <li
                key={r.id}
                className={"proj-combo-item" + (r.id === rfqId ? " on" : "")}
                role="option"
                aria-selected={r.id === rfqId}
                onClick={() => {
                  onSelect(r.id);
                  setOpen(false);
                }}
              >
                <ProjectOptionLabel r={r} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <span className="hint-inline">등록된 프로젝트가 없습니다.</span>
      ) : null}
    </div>
  );
}

function VendorRfqAction({
  rfqId,
  vendors,
  kmarisNo,
  onDone,
}: {
  rfqId: number;
  vendors: VendorOption[];
  kmarisNo: string;
  onDone: () => void;
}) {
  const [vendorIds, setVendorIds] = useState<number[]>([]);
  const [lang, setLang] = useState<"en" | "ko">("en");
  const [notes, setNotes] = useState("");
  const [previews, setPreviews] = useState<VendorRfqPreview[]>([]);
  // 케이마리스 RFQ No.는 이 단계(Vendor RFQ 발신)에서 부여된다.
  const unassigned = !kmarisNo || kmarisNo === "미발급";
  const [rfqNoMode, setRfqNoMode] = useState<"auto" | "manual">("auto");
  const [manualNo, setManualNo] = useState("");
  const rfqNoArg = unassigned ? { mode: rfqNoMode, value: manualNo.trim() } : undefined;
  const [sentAt, setSentAt] = useState(nowLocalDt());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function toggleVendor(id: number) {
    setVendorIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  // RFQ 생성 — 케이마리스 RFQ No. 단독 발번(선택)
  async function generateRfqNo() {
    if (rfqNoMode === "manual" && !manualNo.trim()) {
      setErr("케이마리스 RFQ No.를 입력하세요. (또는 자동으로 변경)");
      return;
    }
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await assignRfqNo(rfqId, { mode: rfqNoMode, rfq_no: manualNo.trim() });
      setMsg(`케이마리스 RFQ No. 발급: ${r.rfq_no}`);
      onDone(); // 목록 새로고침 → 발급 상태 반영
    } catch (e) {
      setErr(e instanceof Error ? e.message : "RFQ 생성 실패");
    } finally {
      setBusy(false);
    }
  }

  async function makePreview() {
    if (vendorIds.length === 0) return;
    if (unassigned && rfqNoMode === "manual" && !manualNo.trim()) {
      setErr("케이마리스 RFQ No.를 입력하세요. (또는 자동으로 변경)");
      return;
    }
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await previewVendorRfq(rfqId, vendorIds, lang, notes, rfqNoArg);
      setPreviews(r.previews);
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

  // 발신 완료 — 선택한 Vendor의 RFQ 발신을 기록(이메일 생성 여부와 무관). 초안이 있으면 그 내용을 함께 보낸다.
  async function sendAll() {
    if (vendorIds.length === 0) {
      setErr("Vendor를 선택하세요.");
      return;
    }
    if (unassigned && rfqNoMode === "manual" && !manualNo.trim()) {
      setErr("케이마리스 RFQ No.를 입력하세요. (또는 자동으로 변경)");
      return;
    }
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const items = vendorIds.map((vid) => {
        const p = previews.find((x) => x.vendor_id === vid);
        return {
          vendor_id: vid,
          to: p?.to ?? "",
          subject: p?.subject ?? "",
          body: p?.body ?? "",
        };
      });
      const r = await sendVendorRfq(rfqId, items, rfqNoArg, sentAt || undefined);
      setMsg(`케이마리스 RFQ No. ${r.rfq_no} · 발신 완료 (Vendor RFQ ${r.saved}건 기록)`);
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
        <span>이메일 초안과 견적 응답용 Excel 양식을 생성합니다. 메일은 직접 발송하고, 보낸 뒤 "발신 완료"로 기록하세요.</span>
      </div>
      <div className="form-field">
        <label>케이마리스 RFQ No.</label>
        {unassigned ? (
          <>
            <div className="seg-tabs">
              {(
                [
                  ["auto", "자동 생성"],
                  ["manual", "직접 입력"],
                ] as const
              ).map(([m, lbl]) => (
                <button
                  key={m}
                  type="button"
                  className={rfqNoMode === m ? "on" : ""}
                  onClick={() => setRfqNoMode(m)}
                >
                  {lbl}
                </button>
              ))}
            </div>
            {rfqNoMode === "manual" ? (
              <input
                style={{ marginTop: 8, maxWidth: 320 }}
                value={manualNo}
                onChange={(e) => setManualNo(e.target.value)}
                placeholder="예: KMS-RFQ-2606-001"
              />
            ) : (
              <span className="hint-inline" style={{ marginTop: 8, display: "inline-block" }}>
                "RFQ 생성" 또는 발신 시 KMS-RFQ-yymm-NNN 형식으로 부여됩니다.
              </span>
            )}
          </>
        ) : (
          <div className="action-ctx" style={{ margin: 0 }}>
            발급됨: <b>{kmarisNo}</b>
          </div>
        )}
      </div>
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
        <div className="form-field">
          <label>발신 일시 (발신 완료 기록)</label>
          <input
            type="datetime-local"
            value={sentAt}
            onChange={(e) => setSentAt(e.target.value)}
          />
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

      {/* 3개 버튼 동시 표시: RFQ 생성(선택) · 이메일 생성(선택) · 발신 완료(필수) */}
      <div className="form-actions">
        <button className="btn" onClick={generateRfqNo} disabled={busy || !unassigned}>
          RFQ 생성
        </button>
        <button className="btn" onClick={makePreview} disabled={busy || vendorIds.length === 0}>
          이메일 생성
        </button>
        <button className="btn primary" onClick={sendAll} disabled={busy || vendorIds.length === 0}>
          발신 완료
        </button>
        <span className="hint-inline">
          RFQ 생성·이메일 생성은 선택, 발신 완료는 필수입니다.
        </span>
      </div>

      {previews.length > 0 ? (
        <div style={{ marginTop: 14 }}>
          <div className="po-work-note">
            <b>이메일 직접 발송</b>
            <span>아래 초안(제목·본문)을 복사하고 Excel 양식을 첨부해 직접 발송한 뒤, "발신 완료"를 눌러 기록하세요. 시스템은 메일을 발송하지 않습니다.</span>
          </div>
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
            <button className="btn" onClick={() => setPreviews([])}>
              초안 닫기
            </button>
          </div>
        </div>
      ) : null}
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
  const [receivedAt, setReceivedAt] = useState(nowLocalDt());
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
      setParseMsg(
        parsed.length
          ? `${parsed.length}개 품목 자동 입력 완료 — 내용을 확인·수정하세요`
          : "품목을 추출하지 못했습니다. 직접 입력하거나 다른 파일을 시도하세요."
      );
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
        receivedAt,
        notes
      );
      setMsg(`수신 등록 완료 — ${r.vendor_quote_no}`);
      setNo("");
      setNotes("");
      setItems([]);
      setVrfqId("");
      setReceivedAt(nowLocalDt());
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
              <label>견적 수신일시</label>
              <input
                type="datetime-local"
                value={receivedAt}
                onChange={(e) => setReceivedAt(e.target.value)}
              />
            </div>
          </div>

          <div className="po-work-note" style={{ marginTop: 12 }}>
            <b>Vendor 견적 파일 업로드</b>
            <span>Vendor가 반환한 PDF · Excel · 이미지(스크린샷/사진)를 업로드하면 품명·Part No.·Maker·Origin·Unit Price·Lead Time 등 품목 리스트가 자동으로 채워집니다.</span>
          </div>
          <div className="action-row">
            <input
              type="file"
              accept=".pdf,.xlsx,.xls,.png,.jpg,.jpeg,.webp,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/*"
              disabled={busy || vrfqId === ""}
              onChange={(e) => parseFile(e.target.files?.[0] ?? null)}
            />
            {busy ? <span className="hint-inline">분석 중…</span> : null}
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

// Streamlit 4_Quotation.py 의 거래 조건 프리셋 — datalist 로 드롭다운 + 자유 입력 모두 지원.
const TERM_PRESETS = {
  incoterms: ["FCA Busan, Korea", "FOB Busan, Korea", "CIF (지정 목적항)", "CFR (지정 목적항)", "DAP (지정 목적지)", "EXW Busan"],
  shipment_method: ["Air courier / Sea freight", "By Air (Courier)", "By Sea (FCL)", "By Sea (LCL)"],
  payment_terms: ["100% T/T in advance", "T/T 30 days after delivery", "T/T 50% in advance, 50% before shipment", "L/C at sight"],
  packing: ["Standard export packing", "Seaworthy export packing", "Wooden case packing"],
  delivery_place: ["Busan, Republic of Korea", "Incheon, Republic of Korea"],
  warranty: ["Manufacturer's standard warranty", "12 months from delivery", "6 months from delivery", "No warranty"],
} as const;

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
  const [defaultMargin, setDefaultMargin] = useState(20);
  const [terms, setTerms] = useState<QuotationTerms>({
    remarks: "Bank charges outside Korea shall be borne by Buyer.",
  });
  const [vendorQuotes, setVendorQuotes] = useState<VendorQuoteForImport[]>([]);
  const [importVqId, setImportVqId] = useState<number | "">("");
  const [docType, setDocType] = useState<"quotation" | "proforma_invoice">("quotation");
  const [qtn, setQtn] = useState<{ id: number; qtn_no: string } | null>(null);
  const [email, setEmail] = useState<{ to: string; subject: string; body: string; smtp_configured: boolean } | null>(null);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // RFQ 품목 정보로 기본 seed (cost 없음) — 공급사 견적을 불러오면 cost 가 채워진다.
  useEffect(() => {
    fetchRfqDetail(rfqId)
      .then((d) =>
        setItems(
          d.items.map((it) => ({
            part_no: it.part_no,
            description: it.description,
            qty: Number(it.qty || 1),
            unit: it.unit || "PCS",
            cost_price: 0,
            margin_pct: 20,
            unit_price: 0,
            amount: 0,
          }))
        )
      )
      .catch(() => setItems([]));
    fetchRfqVendorQuotes(rfqId)
      .then((d) => setVendorQuotes(d.vendor_quotes))
      .catch(() => setVendorQuotes([]));
  }, [rfqId]);

  // 선택한 공급사 견적의 품목·cost_price 를 불러와 기본 마진을 적용한다.
  function importFromVendorQuote() {
    if (importVqId === "") return;
    const vq = vendorQuotes.find((v) => v.id === importVqId);
    if (!vq) return;
    setItems(
      vq.items.map((it) => {
        const cost = Number(it.cost_price ?? 0);
        const unit = calcUnitPrice(cost, defaultMargin);
        const qty = Number(it.qty || 1);
        return {
          part_no: it.part_no || "",
          description: it.description || "",
          qty,
          unit: it.unit || "PCS",
          cost_price: cost,
          margin_pct: defaultMargin,
          unit_price: unit,
          amount: unit * qty,
        };
      })
    );
    if (vq.currency) setCurrency(vq.currency);
    setMsg(`${vq.vendor_quote_no} (${vq.vendor}) 견적에서 ${vq.items.length}개 품목을 불러왔습니다.`);
  }

  const total = items.reduce((sum, it) => sum + Number(it.amount || 0), 0);

  async function submit() {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await createCustomerQuote(rfqId, currency, total, items, validUntil, undefined, terms);
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
    const res = await fetch(quotationPdfUrl(qtn.id, docType), {
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
    a.download = `${qtn.qtn_no}_${docType}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function sendEmail() {
    if (!qtn) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await sendQuotationEmail(qtn.id, to, subject, body, docType);
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

      <div className="po-work-note">
        <b>Vendor 견적에서 불러오기 — 권장</b>
        <span>공급사 견적을 선택하면 품목과 원가(cost)를 그대로 불러와 기본 마진을 적용합니다.</span>
      </div>
      <div className="form-grid">
        <div className="form-field">
          <label>Vendor 견적 선택</label>
          <select
            value={importVqId}
            onChange={(e) => setImportVqId(e.target.value === "" ? "" : Number(e.target.value))}
            disabled={vendorQuotes.length === 0}
          >
            <option value="">
              {vendorQuotes.length === 0 ? "수신된 Vendor 견적 없음" : "— 직접 입력 —"}
            </option>
            {vendorQuotes.map((v) => (
              <option key={v.id} value={v.id}>
                {v.received_date || "—"} · {v.vendor} · {v.vendor_quote_no}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label>기본 마진율 (%)</label>
          <input
            className="num"
            type="number"
            value={defaultMargin}
            onChange={(e) => setDefaultMargin(Number(e.target.value))}
          />
        </div>
        <div className="form-field" style={{ alignSelf: "end" }}>
          <button className="btn" onClick={importFromVendorQuote} disabled={importVqId === ""}>
            Vendor 견적 불러오기
          </button>
        </div>
      </div>

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

      <QuotationTermsEditor terms={terms} onChange={setTerms} />

      <div className="form-actions">
        <span className="action-name">합계: {currency} {total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        <button className="btn primary" onClick={submit} disabled={busy || items.length === 0}>
          {busy ? "저장 중…" : "견적 저장"}
        </button>
      </div>

      {qtn ? (
        <div className="panel" style={{ boxShadow: "none" }}>
          <div className="sub-h">발신 — {qtn.qtn_no}</div>
          <div className="form-grid">
            <div className="form-field">
              <label>문서 종류</label>
              <select value={docType} onChange={(e) => setDocType(e.target.value as "quotation" | "proforma_invoice")}>
                <option value="quotation">Quotation (견적서)</option>
                <option value="proforma_invoice">Proforma Invoice (PI)</option>
              </select>
            </div>
          </div>
          <div className="form-actions">
            <button className="btn" onClick={downloadPdf}>PDF 다운로드</button>
            <button className="btn" onClick={makeEmailPreview} disabled={busy}>이메일 미리보기</button>
          </div>
        </div>
      ) : null}

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
            {docType === "proforma_invoice" ? "PI 이메일 발송" : "견적서 이메일 발송"}
          </button>
        </div>
      ) : null}
      {msg ? <span className="action-ok">{msg}</span> : null}
      {err ? <span className="action-err">{err}</span> : null}
    </div>
  );
}

function QuotationTermsEditor({
  terms,
  onChange,
}: {
  terms: QuotationTerms;
  onChange: (terms: QuotationTerms) => void;
}) {
  function field(key: keyof QuotationTerms, label: string) {
    const presets = (TERM_PRESETS as Record<string, readonly string[]>)[key];
    const listId = `qtn-term-${key}`;
    return (
      <div className="form-field">
        <label>{label}</label>
        <input
          list={presets ? listId : undefined}
          value={terms[key] ?? ""}
          onChange={(e) => onChange({ ...terms, [key]: e.target.value })}
        />
        {presets ? (
          <datalist id={listId}>
            {presets.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        ) : null}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div className="sub-h">거래 조건</div>
      <div className="form-grid">
        {field("incoterms", "Incoterms")}
        {field("shipment_method", "Shipment Method")}
        {field("payment_terms", "Payment Terms")}
        {field("packing", "Packing")}
        {field("delivery_place", "Delivery Place")}
        {field("warranty", "Warranty")}
      </div>
      <div className="form-field" style={{ marginTop: 8 }}>
        <label>Remarks</label>
        <input value={terms.remarks ?? ""} onChange={(e) => onChange({ ...terms, remarks: e.target.value })} />
      </div>
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
