"use client";

import { useEffect, useState } from "react";
import { tr } from "@/lib/labels";
import {
  fetchCustomers,
  fetchSettingsVessels,
  createRfq,
  updateRfq,
  fetchRfqDetail,
  deleteRfq,
  parseRfqPdf,
  createSettingsCustomer,
  createSettingsVessel,
  fetchAssignableUsers,
} from "@/lib/api";
import type { CustomerOption, SettingsVessel, RfqSourceFile } from "@/lib/types";
import { can, canEditDeal, editBlockReason } from "@/lib/auth";
import CustomerName from "@/components/common/CustomerName";
import { useColumnLayout } from "@/components/common/useColumnLayout";
import { ColumnResizer } from "@/components/common/tableLayout";

// 품목 표에서 폭 조절 가능한 컬럼(관리번호·순번·삭제 열 제외)과 기본폭(px).
const RFQ_ITEM_COLS = [
  { key: "part_no", label: "Part No." },
  { key: "description", label: "Description" },
  { key: "type", label: "Type" },
  { key: "serial_no", label: "Serial No." },
  { key: "qty", label: "Qty" },
  { key: "remark", label: "Remark" },
];
const RFQ_ITEM_DEFAULT_W: Record<string, number> = {
  part_no: 160,
  description: 280,
  type: 96,
  serial_no: 130,
  qty: 84,
  remark: 160,
};

type ItemRow = {
  part_no: string;
  description: string;
  type: string;
  serial_no: string;
  qty: string;
  remark: string;
};

// 빈 품목 행 1개(초기값·+Add·reset 공용).
const EMPTY_ITEM: ItemRow = {
  part_no: "",
  description: "",
  type: "",
  serial_no: "",
  qty: "1",
  remark: "",
};

// 고객이 RFQ를 보내온 수단(요청 수단). 자유 텍스트 컬럼이라 프리셋 외 값도 저장 가능.
const REQUEST_CHANNELS = ["Email", "Phone", "SMS", "WhatsApp", "WeChat", "Other"];

/** 현재 시각 "YYYY-MM-DDTHH:MM" (datetime-local 기본값). */
function nowLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

export default function NewRfqForm({
  onCreated,
  onCancel,
  onDeleted,
  autoLoadId,
  embedded,
}: {
  onCreated?: (rfqNo: string) => void;
  onCancel?: () => void;
  onDeleted?: () => void;        // 삭제 후 콜백(있으면 삭제 버튼 표시)
  autoLoadId?: number | null;    // 마운트 시 해당 RFQ를 즉시 불러와 수정 모드 진입
  // embedded: 프로젝트 워크스페이스(단계 상세) 임베드용. 카드(.panel)·900px 제한을 빼고
  // 다른 단계(2~4) 처럼 컨테이너 폭에 꽉 차는 평면 레이아웃으로 렌더한다.
  embedded?: boolean;
}) {
  const [editId, setEditId] = useState<number | null>(null); // null=신규, >0=수정
  const [loadedRfqNo, setLoadedRfqNo] = useState("");        // 로드된 K-Maris RFQ No.(상단 헤드라인용)
  const [assigneeId, setAssigneeId] = useState<number>(0);   // 편집 대상 RFQ의 담당자(PIC)
  const [assigneeName, setAssigneeName] = useState("");      // 현재 담당자 이름(목록에 없을 때 fallback 라벨)
  const [users, setUsers] = useState<{ id: number; username: string }[]>([]); // PIC 재지정 후보
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [vessels, setVessels] = useState<SettingsVessel[]>([]);
  const [customerId, setCustomerId] = useState<number | "">("");
  const [vesselId, setVesselId] = useState<number | "">("");
  const [custRfqNo, setCustRfqNo] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [projectTitle, setProjectTitle] = useState("");
  const [workType, setWorkType] = useState("부품공급");
  const [requestChannel, setRequestChannel] = useState("");
  const [notes, setNotes] = useState("");
  const [receivedAt, setReceivedAt] = useState(nowLocal());
  const [items, setItems] = useState<ItemRow[]>([
    { ...EMPTY_ITEM },
  ]);
  const [busy, setBusy] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [ocrMsg, setOcrMsg] = useState<string | null>(null);
  // OCR 이 인식했지만 DB 에 없는 Customer/선박 — 빠른 등록 폼의 기본값/자동 열기에 사용
  const [custHint, setCustHint] = useState("");
  const [vesselHint, setVesselHint] = useState("");
  // Auto-fill 로 업로드·추출한 소스 파일 메타(RFQ 저장 시 함께 보관 → 재접속해도 유지).
  const [ocrFiles, setOcrFiles] = useState<RfqSourceFile[]>([]);
  // 품목 표 컬럼 폭(헤더 경계 드래그로 조절, localStorage 유지).
  const itemCols = useColumnLayout("rfq-item-cols", RFQ_ITEM_COLS);
  const itemColW = (k: string) => itemCols.widths[k] ?? RFQ_ITEM_DEFAULT_W[k];

  function reloadCustomers(): Promise<CustomerOption[]> {
    return fetchCustomers()
      .then((cs) => {
        setCustomers(cs);
        return cs;
      })
      .catch(() => {
        setCustomers([]);
        return [];
      });
  }
  function reloadVessels(): Promise<SettingsVessel[]> {
    return fetchSettingsVessels()
      .then((vs) => {
        setVessels(vs);
        return vs;
      })
      .catch(() => {
        setVessels([]);
        return [];
      });
  }

  useEffect(() => {
    reloadCustomers();
    reloadVessels();
    fetchAssignableUsers()
      .then(setUsers)
      .catch(() => setUsers([]));
  }, []);

  // 상세 모달 진입 시: 지정된 RFQ를 즉시 불러와 수정 모드로 전환.
  useEffect(() => {
    if (autoLoadId) loadRfq(autoLoadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoadId]);

  async function handleDelete() {
    if (!editId) return;
    if (
      !window.confirm(
        "Delete this RFQ?\nLinked Vendor RFQs/quotes will also be deleted.\n(RFQs already advanced to a quote/order cannot be deleted.)"
      )
    )
      return;
    setBusy(true);
    setErr(null);
    try {
      await deleteRfq(editId);
      onDeleted?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
      setBusy(false);
    }
  }

  const custUnmatched = custHint.trim() !== "" && !matchName(custHint, customers);
  const vesselUnmatched = vesselHint.trim() !== "" && !matchName(vesselHint, vessels);

  // 상단 도구(자동입력·빠른등록)는 기본 접힘 — 필요할 때만 버튼으로 펼친다.
  const [showOcr, setShowOcr] = useState(false);
  const [showCust, setShowCust] = useState(false);
  const [showVessel, setShowVessel] = useState(false);
  // OCR이 DB에 없는 Customer/선박을 인식하면 해당 빠른등록 패널을 자동으로 펼친다.
  useEffect(() => {
    if (custUnmatched) setShowCust(true);
  }, [custUnmatched]);
  useEffect(() => {
    if (vesselUnmatched) setShowVessel(true);
  }, [vesselUnmatched]);

  function setItem(i: number, key: keyof ItemRow, val: string) {
    setItems((prev) =>
      prev.map((it, idx) => (idx === i ? { ...it, [key]: val } : it))
    );
  }
  function addItem() {
    setItems((prev) => [...prev, { ...EMPTY_ITEM }]);
  }
  function removeItem(i: number) {
    setItems((prev) => prev.filter((_, idx) => idx !== i));
  }

  function matchName<T extends { name: string }>(hint: string | null | undefined, rows: T[]) {
    if (!hint) return undefined;
    const h = hint.trim().toLowerCase();
    return rows.find((r) => {
      const n = r.name.toLowerCase();
      return h === n || h.includes(n) || n.includes(h);
    });
  }

  // 편집 권한: 기존 RFQ 수정은 역할(rfq.edit) × 담당(PIC), 신규는 rfq.create.
  const canEditThis =
    editId != null
      ? can("rfq", "edit") && canEditDeal(assigneeId)
      : can("rfq", "create");
  const canDeleteThis = can("rfq", "delete") && canEditDeal(assigneeId);

  // 캡쳐본 붙여넣기(Ctrl+V) → 이미지면 바로 OCR (편집 권한 없으면 무시)
  function handlePaste(e: React.ClipboardEvent) {
    if (!canEditThis) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of Array.from(items)) {
      if (it.type.startsWith("image/")) {
        const blob = it.getAsFile();
        if (blob) {
          e.preventDefault();
          setShowOcr(true);
          uploadOcr(blob);
        }
        return;
      }
    }
  }

  // 복수 파일을 순차 분석해 아이템을 누적. 고객/선박/번호/담당자 등 헤더 정보는
  // 아직 비어 있을 때만 첫 파일의 추출값으로 채워, 뒤 파일이 덮어쓰지 않게 한다.
  async function uploadOcr(input: File | FileList | null) {
    if (!input) return;
    const files = input instanceof File ? [input] : Array.from(input);
    if (files.length === 0) return;
    setOcrBusy(true);
    setErr(null);
    setOcrMsg(null);
    try {
      const collected: ItemRow[] = [];
      const newFiles: RfqSourceFile[] = [];
      let firstHint = "";
      let ok = 0;
      let headerFilled = false;
      for (const file of files) {
        const r = await parseRfqPdf(file);
        ok++;
        // 업로드한 소스 파일 메타 기록(파일명·타입·추출 아이템수).
        newFiles.push({
          name: file.name || "(unnamed)",
          media_type: file.type || "",
          item_count: r.items?.length ?? 0,
          at: nowLocal(),
        });
        // 힌트 문구는 고객을 아직 수동 선택하지 않았을 때만(수동 입력 유지 시 혼란 방지).
        if (!headerFilled && !firstHint && customerId === "") firstHint = r.customer_hint ?? "";
        // 헤더 정보(고객/선박/번호/담당자)는 첫 유효 추출 1회만 반영.
        if (!headerFilled) {
          const cust = matchName(r.customer_hint, customers);
          const vessel = matchName(r.vessel_name, vessels);
          if (customerId === "") {
            setCustHint(cust ? "" : r.customer_hint ?? "");
            if (cust) setCustomerId(cust.id);
          }
          if (vesselId === "") {
            setVesselHint(vessel ? "" : r.vessel_name ?? "");
            if (vessel) setVesselId(vessel.id);
          }
          if (r.customer_rfq_no) setCustRfqNo((v) => v || r.customer_rfq_no!);
          // 담당자: OCR 추출값 우선, 없으면 매칭된 Customer의 담당자
          if (r.contact_person) setContactPerson((v) => v || r.contact_person!);
          else if (cust?.contact) setContactPerson((v) => v || cust.contact!);
          if (r.customer_hint || r.vessel_name || r.items?.length) headerFilled = true;
        }
        if (r.items?.length) {
          for (const it of r.items) {
            collected.push({
              part_no: it.part_no ?? "",
              description: it.description ?? "",
              type: it.type ?? "",
              serial_no: it.serial_no ?? "",
              qty: String(it.qty ?? 1),
              remark: it.remark ?? "",
            });
          }
        }
      }
      // 기존 아이템(빈 placeholder 행 제외)에 이번 추출분을 누적.
      const keptCount = items.filter(
        (it) => it.part_no.trim() || it.description.trim()
      ).length;
      const totalAfter = keptCount + collected.length;
      if (collected.length) {
        setItems((prev) => {
          const kept = prev.filter((it) => it.part_no.trim() || it.description.trim());
          return [...kept, ...collected];
        });
      }
      // 소스 파일 목록에 누적(중복 파일명은 그대로 추가 — 사용자가 개별 삭제 가능).
      if (newFiles.length) setOcrFiles((prev) => [...prev, ...newFiles]);
      setOcrMsg(
        `Extracted: +${collected.length} item(s)${
          files.length > 1 ? ` from ${ok} files` : ""
        } · ${totalAfter} total${firstHint ? ` · Customer hint ${firstHint}` : ""}`
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "OCR extraction failed");
    } finally {
      setOcrBusy(false);
    }
  }

  function resetForm() {
    setEditId(null);
    setAssigneeId(0);
    setAssigneeName("");
    setCustomerId("");
    setVesselId("");
    setCustRfqNo("");
    setContactPerson("");
    setProjectTitle("");
    setWorkType("부품공급");
    setRequestChannel("");
    setNotes("");
    setReceivedAt(nowLocal());
    setItems([{ ...EMPTY_ITEM }]);
    setOcrFiles([]);
    setErr(null);
    setMsg(null);
  }

  // 기존 RFQ를 불러와 폼에 채우고 수정 모드로 전환.
  async function loadRfq(id: number) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const d = await fetchRfqDetail(id);
      setEditId(id);
      // 미발급 RFQ 는 상세 API 가 "-" 로 내려준다 → 배지는 빈칸으로(번호는 2단계 발송 시 부여).
      setLoadedRfqNo(d.rfq_no && d.rfq_no !== "-" ? d.rfq_no : "");
      setAssigneeId(d.assignee_id ?? 0);
      setAssigneeName(d.assignee || "");
      setCustomerId(d.customer_id || "");
      setVesselId(d.vessel_id || "");
      setCustRfqNo(d.customer_rfq_no || "");
      setContactPerson(d.contact_person || "");
      setProjectTitle(d.project_title || "");
      setWorkType(d.work_type || "부품공급");
      setRequestChannel(d.request_channel || "");
      setNotes(d.notes || "");
      setReceivedAt(d.received_at || nowLocal());
      setItems(
        d.items.length
          ? d.items.map((it) => ({
              part_no: it.part_no || "",
              description: it.description || "",
              type: it.type ?? "",
              serial_no: it.serial_no ?? "",
              qty: String(it.qty ?? 1),
              remark: it.remark ?? "",
            }))
          : [{ ...EMPTY_ITEM }]
      );
      // 이전에 Auto-fill 로 저장해둔 소스 파일 목록 복원.
      setOcrFiles(Array.isArray(d.source_files) ? d.source_files : []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load RFQ");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (customerId === "") {
      setErr("Select a customer.");
      return;
    }
    setBusy(true);
    setErr(null);
    setMsg(null);
    const cleanItems = items
      .filter((it) => it.part_no.trim() || it.description.trim())
      .map((it) => ({
        part_no: it.part_no,
        description: it.description,
        type: it.type,
        serial_no: it.serial_no,
        qty: Number(it.qty) || 1,
        remark: it.remark,
      }));
    try {
      if (editId) {
        await updateRfq(editId, {
          customer_id: customerId,
          vessel_id: vesselId === "" ? 0 : vesselId,
          customer_rfq_no: custRfqNo,
          contact_person: contactPerson,
          received_at: receivedAt || undefined,
          project_title: projectTitle,
          work_type: workType,
          request_channel: requestChannel,
          notes,
          assignee_id: assigneeId,   // 담당자(PIC) 재지정. 0 → 미지정 해제
          items: cleanItems,
          source_files: ocrFiles,
        });
        setMsg("Updated");
        onCreated?.(""); // 목록·상위 새로고침
      } else {
        const r = await createRfq({
          customer_id: customerId,
          vessel_id: vesselId === "" ? undefined : vesselId,
          customer_rfq_no: custRfqNo,
          contact_person: contactPerson,
          received_at: receivedAt || undefined,
          project_title: projectTitle,
          work_type: workType,
          request_channel: requestChannel,
          notes,
          items: cleanItems,
          source_files: ocrFiles,
        });
        setMsg(`Created — ${r.rfq_no}`);
        resetForm();
        onCreated?.(r.rfq_no);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : editId ? "Update failed" : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  const customerName = customerId === "" ? "" : (customers.find((c) => c.id === customerId)?.name || "");

  return (
    <div className={embedded ? undefined : "panel form-panel"} onPaste={handlePaste}>
      {embedded && editId ? (
        <div className="embedded-record-bar">
          <span className="embedded-record-current">
            <CustomerName name={customerName} />
            <b className="rec-doc-no">{loadedRfqNo}</b>
          </span>
        </div>
      ) : null}
      <fieldset className="form-fieldset" disabled={!canEditThis}>
      <div className="sub-h" style={{ marginTop: 0, marginBottom: 8 }}>
        Basic info
      </div>
      {/* 도구 모음 — Basic info 바로 아래에 배치. 평소엔 접혀 있고, 버튼으로 필요한 패널만 펼친다. */}
      <div className="form-tools">
        <button
          type="button"
          className={`tool-btn${showOcr ? " on" : ""}`}
          onClick={() => setShowOcr((v) => !v)}
        >
          📄 Auto-fill
        </button>
        <button
          type="button"
          className={`tool-btn${showCust ? " on" : ""}`}
          onClick={() => setShowCust((v) => !v)}
        >
          ＋ New Customer
        </button>
        <button
          type="button"
          className={`tool-btn${showVessel ? " on" : ""}`}
          onClick={() => setShowVessel((v) => !v)}
        >
          ＋ New Vessel
        </button>
      </div>

      {showOcr ? (
        <div className="ocr-bar">
          <span className="ocr-bar-label">📄 RFQ auto-fill (PDF·image)</span>
          <input
            type="file"
            multiple
            accept="application/pdf,image/png,image/jpeg,image/webp"
            onChange={(e) => {
              const fl = e.target.files;
              uploadOcr(fl);
              // 같은 파일을 다시 선택해도 onChange 가 발생하도록 값 초기화(누적 업로드).
              e.target.value = "";
            }}
            disabled={ocrBusy}
          />
          {ocrBusy ? (
            <span className="hint-inline">AI analyzing…</span>
          ) : ocrMsg ? (
            <span className="action-ok">{ocrMsg}</span>
          ) : (
            <span className="hint-inline">
              Upload PDF/image files (multiple OK) or paste a screenshot with Ctrl+V → items accumulate
            </span>
          )}
        </div>
      ) : null}

      {ocrFiles.length > 0 ? (
        <div className="ocr-files">
          <div className="ocr-files-head">
            📎 Auto-fill source files ({ocrFiles.length})
          </div>
          <ul className="ocr-files-list">
            {ocrFiles.map((f, i) => (
              <li key={`${f.name}-${i}`} className="ocr-file">
                <span className="ocr-file-icon">
                  {(f.media_type || "").startsWith("image/") ? "🖼️" : "📄"}
                </span>
                <span className="ocr-file-name" title={f.name}>{f.name}</span>
                <span className="ocr-file-meta">
                  {f.item_count} item{f.item_count === 1 ? "" : "s"}
                  {f.at ? ` · ${f.at.slice(0, 10)}` : ""}
                </span>
                {canEditThis ? (
                  <button
                    type="button"
                    className="ocr-file-del"
                    title="Remove from list"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => setOcrFiles((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    ✕
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {showCust ? (
        <div className="quick-create-panel">
          <QuickCustomerCreate
            defaultName={custHint}
            unmatchedHint={custUnmatched ? custHint : ""}
            onCreated={async (id) => {
              await reloadCustomers();
              setCustomerId(id);
              setCustHint("");
              setShowCust(false);
            }}
          />
        </div>
      ) : null}

      {showVessel ? (
        <div className="quick-create-panel">
          <QuickVesselCreate
            defaultName={vesselHint}
            unmatchedHint={vesselUnmatched ? vesselHint : ""}
            customers={customers}
            defaultOwnerId={customerId === "" ? undefined : customerId}
            onCreated={async (id) => {
              await reloadVessels();
              setVesselId(id);
              setVesselHint("");
              setShowVessel(false);
            }}
          />
        </div>
      ) : null}

      <div className="form-grid">
        <Field label="RFQ received at">
          <input
            type="datetime-local"
            value={receivedAt}
            onChange={(e) => setReceivedAt(e.target.value)}
          />
        </Field>
        <Field label="Work type">
          <select value={workType} onChange={(e) => setWorkType(e.target.value)}>
            <option value="부품공급">{tr("부품공급")}</option>
            <option value="서비스">{tr("서비스")}</option>
          </select>
        </Field>
        <Field label="Customer *">
          <select
            value={customerId}
            onChange={(e) => {
              const id = e.target.value === "" ? "" : Number(e.target.value);
              setCustomerId(id);
              // 선택한 Customer의 담당자를 함께 채운다(있으면).
              const c = id === "" ? undefined : customers.find((x) => x.id === id);
              if (c?.contact) setContactPerson(c.contact);
            }}
          >
            <option value="">Select…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.contact ? ` — ${c.contact}` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Customer contact">
          <input
            value={contactPerson}
            onChange={(e) => setContactPerson(e.target.value)}
            placeholder="Contact name/title (optional)"
          />
        </Field>
        <Field label="Vessel">
          <select
            value={vesselId}
            onChange={(e) =>
              setVesselId(e.target.value === "" ? "" : Number(e.target.value))
            }
          >
            <option value="">Select…</option>
            {vessels.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Customer RFQ No.">
          <input
            value={custRfqNo}
            onChange={(e) => setCustRfqNo(e.target.value)}
            placeholder="Customer reference no. (optional)"
          />
        </Field>
        <Field label="Project title">
          <input
            value={projectTitle}
            onChange={(e) => setProjectTitle(e.target.value)}
            placeholder="Internal reference title (optional)"
          />
        </Field>
        <Field label="Request method">
          <select value={requestChannel} onChange={(e) => setRequestChannel(e.target.value)}>
            <option value="">Select…</option>
            {REQUEST_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        {editId != null ? (
          <Field label="PIC (담당자)">
            <select
              value={assigneeId}
              onChange={(e) => setAssigneeId(Number(e.target.value))}
            >
              <option value={0}>Unassigned</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                </option>
              ))}
              {/* 현재 담당자가 비활성/삭제되어 목록에 없으면 그대로 유지되도록 fallback 옵션 표시 */}
              {assigneeId > 0 && !users.some((u) => u.id === assigneeId) ? (
                <option value={assigneeId}>
                  {assigneeName || `User #${assigneeId}`} (inactive)
                </option>
              ) : null}
            </select>
          </Field>
        ) : null}
      </div>

      <div className="items-head" style={{ marginTop: 18 }}>
        <div className="sub-h">Item list</div>
        <button type="button" className="btn sm items-head-add" onClick={addItem}>+ Add</button>
      </div>
      <div className="table-wrap item-scroll">
      <table className="mini items-edit resizable-cols">
        <colgroup>
          <col style={{ width: 44 }} />
          <col style={{ width: 44 }} />
          {RFQ_ITEM_COLS.map((c) => (
            <col key={c.key} style={{ width: itemColW(c.key) }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="row-tools"></th>
            <th className="seq">#</th>
            {RFQ_ITEM_COLS.map((c) => (
              <th key={c.key} className={`col-resizable${c.key === "qty" ? " num" : ""}`}>
                {c.label}
                <ColumnResizer onResize={(px) => itemCols.setWidth(c.key, px)} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i}>
              <td className="row-tools">
                <button
                  type="button"
                  className="row-del"
                  onClick={() => removeItem(i)}
                  disabled={items.length === 1}
                  title="Delete"
                >
                  ✕
                </button>
              </td>
              <td className="seq">{i + 1}</td>
              <td>
                <textarea
                  className="wrapcell"
                  rows={1}
                  value={it.part_no}
                  onChange={(e) => setItem(i, "part_no", e.target.value)}
                />
              </td>
              <td>
                <textarea
                  className="desc"
                  rows={1}
                  value={it.description}
                  onChange={(e) => setItem(i, "description", e.target.value)}
                />
              </td>
              <td>
                <textarea
                  className="wrapcell"
                  rows={1}
                  value={it.type}
                  onChange={(e) => setItem(i, "type", e.target.value)}
                />
              </td>
              <td>
                <textarea
                  className="wrapcell"
                  rows={1}
                  value={it.serial_no}
                  onChange={(e) => setItem(i, "serial_no", e.target.value)}
                />
              </td>
              <td>
                <input
                  className="num"
                  value={it.qty}
                  onChange={(e) => setItem(i, "qty", e.target.value)}
                  inputMode="decimal"
                />
              </td>
              <td>
                <textarea
                  className="wrapcell"
                  rows={1}
                  value={it.remark}
                  onChange={(e) => setItem(i, "remark", e.target.value)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <div className="form-field" style={{ marginTop: 18 }}>
        <label>Notes</label>
        <textarea
          className="wrapcell"
          rows={3}
          style={{ minHeight: 120 }}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Internal memo (optional)"
        />
      </div>
      </fieldset>

      <div className="form-actions">
        {onCancel ? (
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        {!canEditThis ? (
          <span className="hint-inline">{editBlockReason("rfq", assigneeId)}</span>
        ) : (
          <button
            className="btn primary"
            onClick={submit}
            disabled={busy || customerId === ""}
          >
            {busy ? "Working…" : editId ? "Save RFQ" : "Create RFQ"}
          </button>
        )}
        {onDeleted && editId && canDeleteThis ? (
          <button className="btn danger" onClick={handleDelete} disabled={busy}>
            Delete
          </button>
        ) : null}
        {msg ? <span className="action-ok">{msg}</span> : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="form-field">
      <label>{label}</label>
      {children}
    </div>
  );
}

function QuickCustomerCreate({
  defaultName,
  unmatchedHint,
  onCreated,
}: {
  defaultName: string;
  unmatchedHint: string;
  onCreated: (id: number) => void | Promise<void>;
}) {
  const [name, setName] = useState(defaultName);
  const [country, setCountry] = useState("");
  const [contact, setContact] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setName(defaultName);
  }, [defaultName]);

  async function submit() {
    if (!name.trim()) {
      setErr("Enter a customer name.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await createSettingsCustomer({
        name: name.trim(),
        country,
        contact,
        email,
      });
      await onCreated(r.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="quick-create-body">
      {unmatchedHint ? (
        <span className="hint-inline">
          OCR detected: “{unmatchedHint}” — not in the DB. Creating it will auto-select it.
        </span>
      ) : null}
      <div className="form-grid">
        <Field label="Customer name *">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Country">
          <input value={country} onChange={(e) => setCountry(e.target.value)} />
        </Field>
        <Field label="Contact">
          <input value={contact} onChange={(e) => setContact(e.target.value)} />
        </Field>
        <Field label="Email">
          <input value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      </div>
      <div className="form-actions">
        <button className="btn primary" onClick={submit} disabled={busy || !name.trim()}>
          {busy ? "Saving…" : "Create Customer"}
        </button>
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  );
}

function QuickVesselCreate({
  defaultName,
  unmatchedHint,
  customers,
  defaultOwnerId,
  onCreated,
}: {
  defaultName: string;
  unmatchedHint: string;
  customers: CustomerOption[];
  defaultOwnerId?: number;
  onCreated: (id: number) => void | Promise<void>;
}) {
  const [name, setName] = useState(defaultName);
  const [imo, setImo] = useState("");
  const [engine, setEngine] = useState("");
  const [hull, setHull] = useState("");
  const [ownerId, setOwnerId] = useState<number | "">(defaultOwnerId ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setName(defaultName);
  }, [defaultName]);
  useEffect(() => {
    setOwnerId(defaultOwnerId ?? "");
  }, [defaultOwnerId]);

  async function submit() {
    if (!name.trim()) {
      setErr("Enter a vessel name.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await createSettingsVessel({
        name: name.trim(),
        imo,
        engine_type: engine,
        hull_no: hull,
        customer_id: ownerId === "" ? undefined : ownerId,
      });
      await onCreated(r.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="quick-create-body">
      {unmatchedHint ? (
        <span className="hint-inline">
          OCR detected: “{unmatchedHint}” — not in the DB. Creating it will auto-select it.
        </span>
      ) : null}
      <div className="form-grid">
        <Field label="Vessel name *">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="IMO No.">
          <input value={imo} onChange={(e) => setImo(e.target.value)} />
        </Field>
        <Field label="Main Engine Type">
          <input value={engine} onChange={(e) => setEngine(e.target.value)} />
        </Field>
        <Field label="Hull No.">
          <input value={hull} onChange={(e) => setHull(e.target.value)} />
        </Field>
        <Field label="Owner (Customer)">
          <select
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value === "" ? "" : Number(e.target.value))}
          >
            <option value="">— None —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="form-actions">
        <button className="btn primary" onClick={submit} disabled={busy || !name.trim()}>
          {busy ? "Saving…" : "Create Vessel"}
        </button>
        {err ? <span className="action-err">{err}</span> : null}
      </div>
    </div>
  );
}
