"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { tr } from "@/lib/labels";
import {
  fetchCustomers,
  fetchSettingsVessels,
  fetchSettingsConsultants,
  createRfq,
  updateRfq,
  fetchRfqDetail,
  deleteRfq,
  parseRfqPdf,
  createSettingsCustomer,
  createSettingsVessel,
} from "@/lib/api";
import type { CustomerOption, SettingsVessel, SettingsConsultant, RfqSourceFile } from "@/lib/types";
import { can, canEditDeal, editBlockReason } from "@/lib/auth";
import Modal from "@/components/common/Modal";
import CustomerName from "@/components/common/CustomerName";
import CustomerSelect from "@/components/common/CustomerSelect";
import { useColumnLayout } from "@/components/common/useColumnLayout";
import CategoryCell from "@/components/common/CategoryCell";
import { ColumnResizer, ColumnsButton } from "@/components/common/tableLayout";
import {
  CopyRowsButton,
  ItemGridHint,
  useItemGridKeys,
  DeleteSelectedButton,
  ItemSelectCell,
  ItemSelectHeaderCell,
  useRowSelection,
} from "@/components/common/itemTable";

// 품목 표에서 폭 조절·숨김 가능한 컬럼(관리번호·순번 열 제외)과 셀 렌더 메타.
// category 는 텍스트 입력이 아니라 분류 select 셀이다(kind: "category").
type RfqTextColKey = "part_no" | "description" | "type" | "serial_no" | "qty" | "remark";
type RfqItemColKey = RfqTextColKey | "category";
const RFQ_ITEM_COLS: {
  key: RfqItemColKey;
  label: string;
  cellClass: string;
  num?: boolean;
  kind?: "category";
}[] = [
  { key: "part_no", label: "Part No.", cellClass: "wrapcell" },
  { key: "description", label: "Description", cellClass: "desc" },
  { key: "type", label: "Type", cellClass: "wrapcell" },
  { key: "serial_no", label: "Serial No.", cellClass: "wrapcell" },
  { key: "qty", label: "Qty", cellClass: "num", num: true },
  { key: "remark", label: "Remark", cellClass: "wrapcell" },
  { key: "category", label: "Category", cellClass: "", kind: "category" },
];
const RFQ_ITEM_DEFAULT_W: Record<string, number> = {
  part_no: 160,
  description: 280,
  type: 96,
  serial_no: 130,
  qty: 84,
  remark: 160,
  category: 150,
};

type ItemRow = {
  part_no: string;
  description: string;
  type: string;
  serial_no: string;
  qty: string;
  remark: string;
  /** 품목 분류(선택). 저장 시 품목 마스터 분류로 반영된다. */
  category_id: number | null;
};

// 빈 품목 행 1개(초기값·+Add·reset 공용).
const EMPTY_ITEM: ItemRow = {
  part_no: "",
  description: "",
  type: "",
  serial_no: "",
  qty: "1",
  remark: "",
  category_id: null,
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
  onWorkTypeChange,
}: {
  onCreated?: (rfqNo: string) => void;
  onCancel?: () => void;
  onDeleted?: () => void;        // 삭제 후 콜백(있으면 삭제 버튼 표시)
  autoLoadId?: number | null;    // 마운트 시 해당 RFQ를 즉시 불러와 수정 모드 진입
  // embedded: 프로젝트 워크스페이스(단계 상세) 임베드용. 카드(.panel)·900px 제한을 빼고
  // 다른 단계(2~4) 처럼 컨테이너 폭에 꽉 차는 평면 레이아웃으로 렌더한다.
  embedded?: boolean;
  // 업무타입(부품공급/서비스)이 바뀔 때 알린다 — 감싼 모달이 저장 전에도 업무타입 색
  // (부품=블루 / 서비스=그린)으로 테마를 맞추는 데 쓴다.
  onWorkTypeChange?: (workType: string) => void;
}) {
  const [editId, setEditId] = useState<number | null>(null); // null=신규, >0=수정
  const [loadedRfqNo, setLoadedRfqNo] = useState("");        // 로드된 K-Maris RFQ No.(상단 헤드라인용)
  const [assigneeId, setAssigneeId] = useState<number>(0);   // 편집 대상 RFQ의 담당자(PIC) — 저장 시 보존(재지정은 상세 헤더에서)
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [vessels, setVessels] = useState<SettingsVessel[]>([]);
  // customerId 는 "고객사+담당자" 레코드 1건의 id(레코드1=담당자1). 화면에서는 회사명과
  // 담당자를 두 개의 select 로 나눠 고르며, companyName 이 선택한 회사(1단계)를 들고 있다.
  const [customerId, setCustomerId] = useState<number | "">("");
  const [companyName, setCompanyName] = useState("");
  const [vesselId, setVesselId] = useState<number | "">("");
  const [custRfqNo, setCustRfqNo] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [projectTitle, setProjectTitle] = useState("");
  const [workType, setWorkType] = useState("부품공급");
  const [requestChannel, setRequestChannel] = useState("");
  // 소개자(컨설턴트)와 이 딜만의 수수료율. rate 는 빈 문자열이면 컨설턴트 기본율을 따른다.
  const [consultants, setConsultants] = useState<SettingsConsultant[]>([]);
  const [consultantId, setConsultantId] = useState<number | "">("");
  const [consultantRate, setConsultantRate] = useState("");
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
  // Copy as new — 이 RFQ 를 새 딜로 복제(품목 선택 가능). 성격이 다른 품목을 여러 딜로
  // 쪼갤 때 쓴다. move=true 면 고른 품목을 원본에서 빼내 "분할"이 된다.
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyPick, setCopyPick] = useState<Set<number>>(() => new Set());
  const [copyMove, setCopyMove] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyErr, setCopyErr] = useState<string | null>(null);
  // 품목 표 컬럼 폭(헤더 경계 드래그로 조절, localStorage 유지).
  const itemCols = useColumnLayout("rfq-item-cols", RFQ_ITEM_COLS);
  const itemColW = (k: string) => itemCols.widths[k] ?? RFQ_ITEM_DEFAULT_W[k];
  const visibleItemCols = RFQ_ITEM_COLS.filter((c) => !itemCols.hidden.has(c.key));

  // 업무타입 변경을 부모에 알린다 — select 선택뿐 아니라 불러오기·초기화도 함께 태운다.
  // 콜백은 ref 로 들고 있어 부모가 인라인 함수를 넘겨도 effect 가 재실행되지 않는다.
  const workTypeCbRef = useRef(onWorkTypeChange);
  workTypeCbRef.current = onWorkTypeChange;
  useEffect(() => {
    workTypeCbRef.current?.(workType);
  }, [workType]);

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
    // 소개자 목록 — 없으면(마스터 미등록) 칸은 그대로 두고 안내만 바뀐다.
    fetchSettingsConsultants().then(setConsultants).catch(() => setConsultants([]));
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
  function setItemCategory(i: number, id: number | null) {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, category_id: id } : it)));
  }
  function addItem() {
    setItems((prev) => [...prev, { ...EMPTY_ITEM }]);
  }
  const itemSel = useRowSelection(items.length);
  function deleteSelectedItems() {
    if (itemSel.count === 0) return;
    setItems((prev) => prev.filter((_, idx) => !itemSel.selected.has(idx)));
    itemSel.clear();
  }
  // 엑셀식 편집. 이 표는 숨긴 컬럼이 렌더에서 아예 빠지므로, 열 번호 = visibleItemCols 위치이고
  // fields 도 거기서 그대로 뽑으면 된다. 값은 전부 문자열로 담기므로 numeric 은 없다.
  // 분류(select) 컬럼은 텍스트 필드가 아니므로 빈 키로 둔다 — 붙여넣기·Ctrl+D·Copy 가
  // 그 자리를 건너뛴다(useItemGridKeys 가 falsy 필드 키를 무시).
  const itemKeys = useItemGridKeys<ItemRow>({
    items,
    onChange: setItems,
    fields: visibleItemCols.map((c) => (c.kind === "category" ? "" : c.key)),
    blank: () => ({ ...EMPTY_ITEM }),
    headers: visibleItemCols.map((c) => c.label),
    sel: itemSel,
  });

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
              category_id: null,   // OCR 은 분류를 알 수 없다 — 필요하면 수동 선택
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
    setCustomerId("");
    setCompanyName("");
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
      setCustomerId(d.customer_id || "");
      setCompanyName(customers.find((c) => c.id === d.customer_id)?.name || "");
      setVesselId(d.vessel_id || "");
      setCustRfqNo(d.customer_rfq_no || "");
      setContactPerson(d.contact_person || "");
      setProjectTitle(d.project_title || "");
      setWorkType(d.work_type || "부품공급");
      setRequestChannel(d.request_channel || "");
      setConsultantId(d.consultant_id || "");
      setConsultantRate(d.consultant_rate == null ? "" : String(d.consultant_rate));
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
              category_id: it.category_id ?? null,
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

  // 화면의 품목 행 → API 페이로드(내용 없는 행은 버린다).
  function toApiItems(rows: ItemRow[]) {
    return rows
      .filter((it) => it.part_no.trim() || it.description.trim())
      .map((it) => ({
        part_no: it.part_no,
        description: it.description,
        type: it.type,
        serial_no: it.serial_no,
        qty: Number(it.qty) || 1,
        remark: it.remark,
        category_id: it.category_id,
      }));
  }

  // 품목을 뺀 헤더 필드 — 저장·복사가 같은 값을 쓰도록 한 곳에서 만든다.
  function headerPayload() {
    return {
      customer_rfq_no: custRfqNo,
      contact_person: contactPerson,
      received_at: receivedAt || undefined,
      project_title: projectTitle,
      work_type: workType,
      request_channel: requestChannel,
      // 0 = 소개자 없음(연결 해제). 요율은 비우면 -1 로 보내 컨설턴트 기본율로 되돌린다
      // (0 은 '수수료 0%'라는 뜻이 있는 값이라 '비움'의 표시로 쓸 수 없다).
      consultant_id: consultantId === "" ? 0 : consultantId,
      consultant_rate: consultantRate.trim() === "" ? -1 : Number(consultantRate),
      notes,
    };
  }

  async function submit() {
    if (customerId === "") {
      setErr(companyName ? "Select a customer contact." : "Select a customer.");
      return;
    }
    setBusy(true);
    setErr(null);
    setMsg(null);
    const cleanItems = toApiItems(items);
    try {
      if (editId) {
        await updateRfq(editId, {
          ...headerPayload(),
          customer_id: customerId,
          vessel_id: vesselId === "" ? 0 : vesselId,
          assignee_id: assigneeId,   // 담당자(PIC) 재지정. 0 → 미지정 해제
          items: cleanItems,
          source_files: ocrFiles,
        });
        setMsg("Updated");
        onCreated?.(""); // 목록·상위 새로고침
      } else {
        const r = await createRfq({
          ...headerPayload(),
          customer_id: customerId,
          vessel_id: vesselId === "" ? undefined : vesselId,
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

  // 내용이 있는 품목 행의 인덱스 — 복사 대화상자의 선택 대상.
  const copyableRows = items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => it.part_no.trim() || it.description.trim());

  function openCopy() {
    // 표에서 이미 체크해 둔 행이 있으면 그대로 가져오고, 없으면 전체를 고른 상태로 연다.
    const preset = itemSel.count
      ? copyableRows.filter(({ i }) => itemSel.selected.has(i)).map(({ i }) => i)
      : copyableRows.map(({ i }) => i);
    setCopyPick(new Set(preset));
    setCopyMove(false);
    setCopyErr(null);
    setCopyOpen(true);
  }

  function toggleCopyPick(i: number) {
    setCopyPick((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  // 지금 화면의 헤더 + 고른 품목으로 새 RFQ(=새 딜)를 만든다.
  // move 면 고른 품목을 원본에서 빼고 원본도 함께 저장한다(딜 분할).
  async function runCopy() {
    if (customerId === "") {
      setCopyErr(companyName ? "Select a customer contact." : "Select a customer.");
      return;
    }
    const picked = toApiItems(items.filter((_, i) => copyPick.has(i)));
    if (!picked.length) {
      setCopyErr("Select at least one item to copy.");
      return;
    }
    const restRows = items.filter((_, i) => !copyPick.has(i));
    const rest = toApiItems(restRows);
    if (copyMove && !rest.length) {
      setCopyErr("Moving every item would leave the source RFQ empty. Leave one behind, or uncheck Move.");
      return;
    }
    setCopyBusy(true);
    setCopyErr(null);
    try {
      const r = await createRfq({
        ...headerPayload(),
        customer_id: customerId,
        vessel_id: vesselId === "" ? undefined : vesselId,
        items: picked,
        source_files: ocrFiles,
      });
      // 신규 생성은 로그인 사용자를 담당자로 잡으므로, 원본 담당자(PIC)에 맞춰준다.
      if (assigneeId > 0) {
        try {
          await updateRfq(r.id, { assignee_id: assigneeId });
        } catch {
          /* 담당자 보정 실패는 복사 자체를 되돌릴 만한 일이 아니다 */
        }
      }
      if (copyMove && editId) {
        await updateRfq(editId, {
          ...headerPayload(),
          customer_id: customerId,
          vessel_id: vesselId === "" ? 0 : vesselId,
          assignee_id: assigneeId,
          items: rest,
          source_files: ocrFiles,
        });
        setItems(restRows.length ? restRows : [{ ...EMPTY_ITEM }]);
        itemSel.clear();
      }
      setCopyOpen(false);
      setMsg(
        `${copyMove ? "Split" : "Copied"} — ${r.rfq_no} · ${picked.length} item${
          picked.length === 1 ? "" : "s"
        }`
      );
      onCreated?.(""); // 목록·상위 새로고침 — 새 딜이 보이도록
    } catch (e) {
      setCopyErr(e instanceof Error ? e.message : "Copy failed");
    } finally {
      setCopyBusy(false);
    }
  }

  const customerName = customerId === "" ? "" : (customers.find((c) => c.id === customerId)?.name || "");

  // 회사 목록(중복 제거) — Customer select 는 회사명만 보여준다. 로고는 같은 회사의
  // 담당자 레코드 중 로고가 등록된 첫 건에서 가져온다(레코드마다 비어 있을 수 있다).
  // 거래 빈도(uses)는 담당자 레코드별로 매겨지므로 회사 단위로 합산한다 — 그래야
  // 담당자가 여럿인 회사가 실제 거래량대로 목록 위쪽에 올라온다.
  const companyOptions = useMemo(() => {
    const out: CustomerOption[] = [];
    for (const c of customers) {
      const hit = out.find((o) => o.name === c.name);
      if (!hit) out.push({ id: c.id, name: c.name, logo: c.logo || "", uses: c.uses || 0 });
      else {
        if (!hit.logo && c.logo) hit.logo = c.logo;
        hit.uses = (hit.uses || 0) + (c.uses || 0);
      }
    }
    return out;
  }, [customers]);
  // 선택한 회사에 속한 담당자 레코드들 — Customer contact select 의 선택지.
  const companyContacts = useMemo(
    () => (companyName ? customers.filter((c) => c.name === companyName) : []),
    [customers, companyName]
  );
  // 목록 로드·불러오기·빠른등록 등으로 customerId 가 밖에서 정해지면 회사 select 를 맞춰준다.
  useEffect(() => {
    if (customerId === "") return;
    const c = customers.find((x) => x.id === customerId);
    if (c && c.name !== companyName) setCompanyName(c.name);
  }, [customerId, customers, companyName]);

  // 회사를 고르면 담당자 후보를 좁힌다. 담당자가 1명뿐이면 그대로 확정.
  function pickCompany(name: string) {
    setCompanyName(name);
    const list = name ? customers.filter((c) => c.name === name) : [];
    if (list.length === 1) {
      setCustomerId(list[0].id);
      setContactPerson(list[0].contact || "");
    } else {
      setCustomerId("");
      setContactPerson("");
    }
  }

  // 담당자를 고르면 해당 레코드가 이 RFQ 의 Customer 가 된다.
  function pickContact(id: number | "") {
    setCustomerId(id);
    const c = id === "" ? undefined : customers.find((x) => x.id === id);
    setContactPerson(c?.contact || "");
  }

  return (
    <div className={embedded ? undefined : "panel form-panel"} onPaste={handlePaste}>
      {embedded && editId ? (
        <div className="embedded-record-bar pane-row">
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
      {/* 좌: 입력 필드 / 우: Auto-fill 도구·소스파일. 소스상 도구가 먼저 와도 CSS order 로 우측 배치. */}
      <div className="received-split">
      <aside className="received-tools">
      {/* 도구 모음 — Auto-fill · 빠른등록. 평소엔 접혀 있고, 버튼으로 필요한 패널만 펼친다. */}
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

      </aside>
      {/* 좌측: 입력 필드 — 그룹 제목 없이 3열 그리드에 위에서부터 채운다(제목 두 줄이
          차지하던 높이를 없애 항목이 한눈에 들어온다). 프로젝트명만 한 행 전체를 쓴다. */}
      <div className="received-fields">
        <div className="basic-col">
          <Field label="Customer *">
            {/* 회사 로고를 함께 보여주려고 공용 CustomerSelect(버튼+팝오버)를 쓴다.
                이 컴포넌트는 id 로 값을 주고받으므로 회사 대표 레코드의 id 로 매핑한다. */}
            <CustomerSelect
              value={companyOptions.find((o) => o.name === companyName)?.id ?? ""}
              options={companyOptions}
              onChange={(id) =>
                pickCompany(id === "" ? "" : companyOptions.find((o) => o.id === id)?.name || "")
              }
              emptyLabel="Select…"
              disabled={!canEditThis}
            />
          </Field>
          <Field label={companyContacts.length > 1 ? "Customer contact *" : "Customer contact"}>
            <select
              value={customerId}
              disabled={!companyName}
              onChange={(e) =>
                pickContact(e.target.value === "" ? "" : Number(e.target.value))
              }
            >
              <option value="">
                {companyName ? "Select contact…" : "Select a customer first"}
              </option>
              {companyContacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.contact || "(no contact)"}
                </option>
              ))}
            </select>
            {/* Auto-fill·기존 저장값이 선택한 담당자와 다를 때만 원래 값을 알려준다. */}
            {contactPerson &&
            customerId !== "" &&
            contactPerson !== (customers.find((c) => c.id === customerId)?.contact || "") ? (
              <div className="hint-inline" style={{ marginTop: 3 }}>
                Saved as “{contactPerson}”
              </div>
            ) : null}
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
          {/* 소개자 — 딜이 어디서 왔는지는 지금이 아니면 남지 않는다. 수수료를 낼 때가
              되면(매출이 확정된 뒤) 누가 물어다 준 건인지 아무도 기억하지 못한다. */}
          <Field label="Consultant (introducer)">
            <select
              value={consultantId}
              onChange={(e) => setConsultantId(e.target.value === "" ? "" : Number(e.target.value))}
            >
              <option value="">None</option>
              {consultants.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.company ? ` · ${c.company}` : ""}
                </option>
              ))}
            </select>
            {consultants.length === 0 ? (
              <div className="hint-inline" style={{ marginTop: 3 }}>
                Register consultants in Settings → Consultant.
              </div>
            ) : null}
          </Field>
          {/* 요율은 소개자를 고른 뒤에만 묻는다 — 그 전에는 대답할 것이 없는 칸이다. */}
          {consultantId !== "" ? (
            <Field label="Fee rate (%)">
              <input
                className="num"
                inputMode="decimal"
                value={consultantRate}
                placeholder={String(consultants.find((c) => c.id === consultantId)?.default_rate ?? 10)}
                onChange={(e) => setConsultantRate(e.target.value)}
              />
              <div className="hint-inline" style={{ marginTop: 3 }}>
                Of this project&apos;s sales. Leave blank to use the consultant&apos;s default.
              </div>
            </Field>
          ) : null}
          {/* 프로젝트명은 문장에 가까운 긴 값이라 3열을 다 쓴다. */}
          <Field label="Project title" full>
            <input
              value={projectTitle}
              onChange={(e) => setProjectTitle(e.target.value)}
              placeholder="Internal reference title (optional)"
            />
          </Field>
          {/* 담당자(PIC) 재지정은 상세 팝업 우측 상단 PIC 칩에서(admin 전용) 처리한다. */}
        </div>
      </div>
      </div>

      <div className="items-head" style={{ marginTop: 18 }}>
        <div className="sub-h">Item list</div>
        <div className="items-head-actions">
          <ColumnsButton cols={RFQ_ITEM_COLS} layout={itemCols} />
          <ItemGridHint />
          <CopyRowsButton grid={itemKeys} sel={itemSel} />
          <DeleteSelectedButton sel={itemSel} onDelete={deleteSelectedItems} />
          <button type="button" className="btn sm items-head-add" onClick={addItem}>+ Add</button>
        </div>
      </div>
      <div className="table-wrap item-box">
      <table className="mini items-edit resizable-cols">
        <colgroup>
          <col style={{ width: 32 }} />
          <col style={{ width: 44 }} />
          {visibleItemCols.map((c) => (
            <col key={c.key} style={{ width: itemColW(c.key) }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <ItemSelectHeaderCell count={items.length} sel={itemSel} />
            <th className="seq">#</th>
            {visibleItemCols.map((c) => {
              const lastShown = itemCols.visibleKeys.length <= 1;
              return (
                <th key={c.key} className={`col-resizable ig-th${c.num ? " num" : ""}`}>
                  <span className="ig-th-label">{c.label}</span>
                  {!lastShown ? (
                    <button type="button" className="ig-hide" title="Hide column" onClick={() => itemCols.toggleHidden(c.key)}>✕</button>
                  ) : null}
                  <ColumnResizer onResize={(px) => itemCols.setWidth(c.key, px)} />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i}>
              <ItemSelectCell index={i} sel={itemSel} />
              <td className="seq">{i + 1}</td>
              {visibleItemCols.map((c, ci) => {
                if (c.kind === "category") {
                  return (
                    <td key={c.key}>
                      <CategoryCell
                        value={it.category_id}
                        partNo={it.part_no}
                        description={it.description}
                        onChange={(id) => setItemCategory(i, id)}
                        disabled={!canEditThis}
                      />
                    </td>
                  );
                }
                // 나머지는 모두 문자열 필드(컬럼 key = ItemRow 필드명).
                const tk = c.key as RfqTextColKey;
                return (
                  <td key={c.key}>
                    {c.num ? (
                      <input
                        {...itemKeys.cell(i, ci)}
                        className={c.cellClass}
                        value={it[tk]}
                        onChange={(e) => setItem(i, tk, e.target.value)}
                        inputMode="decimal"
                      />
                    ) : (
                      <textarea
                        {...itemKeys.cell(i, ci)}
                        className={c.cellClass}
                        rows={1}
                        value={it[tk]}
                        onChange={(e) => setItem(i, tk, e.target.value)}
                      />
                    )}
                  </td>
                );
              })}
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
        {/* 이 RFQ 를 새 딜로 복제 — 품목을 골라 복사하거나, 골라서 떼어내(분할) 다른 딜로 보낸다. */}
        {editId && can("rfq", "create") ? (
          <button
            className="btn"
            onClick={openCopy}
            disabled={busy || customerId === ""}
            title="Copy this RFQ into a new deal (pick which items go with it)"
          >
            📋 Copy as new
          </button>
        ) : null}
        {onDeleted && editId && canDeleteThis ? (
          <button className="btn danger" onClick={handleDelete} disabled={busy}>
            Delete
          </button>
        ) : null}
        {msg ? <span className="action-ok">{msg}</span> : null}
        {err ? <span className="action-err">{err}</span> : null}
      </div>

      {copyOpen ? (
        <Modal title="📋 Copy RFQ as a new deal" onClose={() => setCopyOpen(false)} form maxWidth={720}>
          <div className="hint-inline">
            Creates a new Customer RFQ with this deal’s header ({customerName || "—"}
            {projectTitle ? ` · ${projectTitle}` : ""}) and the items you pick below. Stage 2+
            records (vendor RFQs, quotes) are not copied — the new deal starts at stage 1.
          </div>

          <div className="items-head" style={{ marginTop: 14 }}>
            <div className="sub-h">Items to copy ({copyPick.size}/{copyableRows.length})</div>
            <div className="items-head-actions">
              <button
                type="button"
                className="btn sm"
                onClick={() => setCopyPick(new Set(copyableRows.map(({ i }) => i)))}
              >
                All
              </button>
              <button type="button" className="btn sm" onClick={() => setCopyPick(new Set())}>
                None
              </button>
            </div>
          </div>
          <div className="table-wrap item-box">
            <table className="mini">
              <thead>
                <tr>
                  <th style={{ width: 32 }} />
                  <th className="seq">#</th>
                  <th>Part No.</th>
                  <th>Description</th>
                  <th className="num">Qty</th>
                </tr>
              </thead>
              <tbody>
                {copyableRows.map(({ it, i }) => (
                  <tr key={i}>
                    <td>
                      <input
                        type="checkbox"
                        checked={copyPick.has(i)}
                        onChange={() => toggleCopyPick(i)}
                        aria-label={`Copy item ${i + 1}`}
                      />
                    </td>
                    <td className="seq">{i + 1}</td>
                    <td className="wrapcell">{it.part_no || "—"}</td>
                    <td className="desc">{it.description || "—"}</td>
                    <td className="num">{it.qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <label className="form-field" style={{ marginTop: 14, flexDirection: "row", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={copyMove}
              onChange={(e) => setCopyMove(e.target.checked)}
              disabled={!canEditThis}
            />
            <span>
              Move — remove the picked items from this RFQ (split the deal). This saves the
              current form to the source RFQ as well.
            </span>
          </label>

          <div className="form-actions">
            <button
              className="btn primary"
              onClick={runCopy}
              disabled={copyBusy || copyPick.size === 0 || (copyMove && !canEditThis)}
            >
              {copyBusy ? "Working…" : copyMove ? "Split into new deal" : "Create copy"}
            </button>
            <button className="btn" onClick={() => setCopyOpen(false)} disabled={copyBusy}>
              Cancel
            </button>
            {copyErr ? <span className="action-err">{copyErr}</span> : null}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function Field({
  label,
  full,
  children,
}: {
  label: string;
  // full: 3열 그리드에서 한 행 전체를 쓰는 필드(긴 텍스트 입력).
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`form-field${full ? " field-full" : ""}`}>
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
