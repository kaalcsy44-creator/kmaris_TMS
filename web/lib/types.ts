export type RfqRow = {
  id: number;
  customer_rfq_no: string;
  project_title: string;
  contact_person?: string;
  assignee?: string;      // 담당자(PIC) username
  assignee_id?: number;   // 담당자(PIC) = RFQ.created_by (0 = 미지정)
  level?: string;
  work_type: string;
  customer: string;
  vessel: string;
  item_count: number;
  crfq_no: string;
  crfq_at: string;
  vrfq_kmaris_no: string;
  vrfq_vendors: string;
  vrfq_at: string;
  vquote_no: string;
  vquote_at: string;
  vendor_amount: string;
  cquote_no: string;
  cquote_at: string;
  customer_amount: string;
  stage: number;
  status: string;
  first_rfq_at: string;
  project_no: string;
};

export type RfqOverview = {
  steps: string[];
  rows: RfqRow[];
};

// uses = 거래 빈도(받은 RFQ + 고객 P/O 건수). 드롭다운에서 자주 거래하는 고객사를
// 위쪽 그룹으로 올리는 데 쓴다(CustomerSelect).
export type CustomerOption = { id: number; name: string; contact?: string; logo?: string; uses?: number };

// 레코드 1건 = 담당자 1명(person-centric). 이메일·연락처·지역은 여러 개 등록 가능하며
// 각 리스트의 첫 값(대표)이 flat contact 필드로 미러링돼 문서·메일에 쓰인다.
export type SettingsCustomer = {
  id: number;
  name: string;
  contact: string;
  contact_phone: string;
  email: string;
  country: string;
  address: string;   // 대표 주소(addresses[0] 미러링 — 문서·PDF 가 쓰는 값)
  tax_id: string;
  tax_invoice_email: string;
  specialization: string;   // 주로 무엇을 사는 곳인가(벤더의 취급품목과 같은 자리)
  website: string;          // 회사 홈페이지(회사 단위)
  note: string;      // 회사 소개 요약(회사 단위 — Company info 창에서 편집)
  payment_terms: string;
  logo: string;
  addresses: string[];   // 본사·지사 주소(첫 값=대표)
  emails: string[];
  phones: string[];
  regions: string[];
  /** 이 담당자가 준 문의(RFQ) 수. */
  inquiries?: number;
  /** 그중 오더(고객 P/O)까지 간 수. */
  won?: number;
  /** 그중 실주로 닫힌 수(나머지는 아직 진행 중). */
  lost?: number;
};
export type SettingsVendor = {
  id: number;
  name: string;
  contact: string;
  contact_phone: string;
  email: string;
  specialization: string;
  website: string;   // 회사 홈페이지(회사 단위)
  note: string;      // 회사 소개 요약(회사 단위 — Company info 창에서 편집)
  country: string;
  address: string;   // 대표 주소(addresses[0] 미러링)
  payment_terms: string;
  logo: string;
  addresses: string[];   // 본사·지사 주소(첫 값=대표)
  emails: string[];
  phones: string[];
  regions: string[];
  /** 이 회사가 다루는 품목 분류(item_categories.id, 중분류까지). 회사 단위 값이라
   *  Company info 창에서 편집하고, 같은 회사의 모든 담당자 레코드에 함께 반영된다. */
  category_ids: number[];
  /** 이 담당자에게 Vendor RFQ 를 보낸 프로젝트 수(중복 문의는 한 건으로). */
  deals?: number;
  /** 그중 벤더 견적이 돌아온 프로젝트 수. */
  deals_answered?: number;
  /** 같은 회사 전체의 값 — 담당자별 수를 더하면 같은 프로젝트를 겹쳐 세므로 따로 받는다. */
  co_deals?: number;
  co_deals_answered?: number;
};
export type SettingsVessel = {
  id: number;
  name: string;
  imo: string;
  vessel_type: string;
  ais_flag: string;
  engine_type: string;
  hull_no: string;
  customer_id: number | null;
  customer: string;
};

export type SettingsItem = {
  id: number;
  part_no: string;
  description: string;
  maker: string;
  origin: string;
  unit: string;
  hs_code: string;
  std_price: number;
  category_id: number | null;    // 분류 노드 id(가장 깊은 선택). null=미분류
  category_path: string;         // 표시용 "대 > 중 > 소" (백엔드 계산, 읽기전용)
  item_type: "part" | "service"; // 물품 / 용역 — Parts·Service 탭을 가르는 값
  // ↓ 거래 실적(가격 이력)에서 뽑은 읽기전용 파생값 — 편집 폼에는 나오지 않는다.
  customer: string;              // 가장 최근 판매 건의 고객(없으면 RFQ 로 물어본 고객)
  vendor: string;                // 가장 최근 구매 건의 공급사(없으면 견적 의뢰한 공급사)
  vendor_quote_at?: string;      // 공급사 견적 수신일 "YYYY-MM-DD"
  quoted_at?: string;            // 고객 견적 제출일 "YYYY-MM-DD"
  buy: ItemLedgerPrice | null;   // 최근 구매가
  sell: ItemLedgerPrice | null;  // 최근 판매가
  margin_pct?: number | null;    // 구매가 대비 판매가 마진%(USD 환산)
  margin_cross?: boolean;        // 매입·매출 통화가 달라 환산으로 계산된 값인지
  // 이 품목이 등장한 딜의 관리번호 — 최근 딜 순. 재발주 품목은 여럿이라 목록은
  // 가장 최근 하나(project_no)를 세우고, 머리행 필터는 전부(project_nos)를 본다.
  project_no?: string;           // "P-024(260622)" — project_nos[0]
  project_nos?: string[];
  // 그 딜들이 다룬 선박 — 같은 부품이 여러 척에 들어가기도 한다. 규칙은 위와 같다.
  vessel?: string;               // vessels[0]
  vessels?: string[];
  // 가장 최근 딜(project_no 와 같은 딜)의 결말. state 는 어디까지 갔는지,
  // note 는 그 까닭 한 줄 — 종결 사유 / 미수 사유(수금 메모·연체일) / 완납일.
  deal_state?: "open" | "quoted" | "ordered" | "paid" | "closed" | "";
  deal_note?: string;
};

// 품목 분류 트리 노드(대>중>소). parent_id 로 계층 구성.
export type ItemCategory = {
  id: number;
  parent_id: number | null;
  level: number;      // 1=대, 2=중, 3=소
  name: string;
  sort_order: number;
  active: boolean;
  path: string;       // "대 > 중 > 소"
};

// 품목별 구매가·판매가 이력(item_price_history) 롤업
export type ItemLedgerPrice = {
  unit_price: number;
  currency: string;
  date: string | null;
  fx_rate?: number | null;   // 딜 저장 환율(1 USD=? KRW) — 마진 환산에 사용
  // 이 가격이 실려 온 문서 — 견적·발주·인보이스. 금액과 마진은 프로젝트가 아니라
  // 문서가 낳은 값이라, 어느 문서인지가 붙어야 숫자를 되짚을 수 있다(Ship View 만 채운다).
  doc?: { kind: string; no: string } | null;
  /** 이 가격의 상대 — buy 면 공급사, sell 이면 고객. 그 행에 없으면 품목의 최근 상대. */
  party?: string;
};
export type ItemLedgerRow = {
  item_id?: number;              // 마스터 연결 시. unmatched 행은 없음
  part_no: string;
  description: string;
  maker?: string;
  customer?: string;             // 최근 판매 상대(고객사)
  vendor?: string;               // 최근 구매 상대(공급사 — 견적·발주를 준 곳)
  category_id?: number | null;
  category_path?: string;        // "대 > 중 > 소"
  buy: ItemLedgerPrice | null;   // 최근 구매가
  sell: ItemLedgerPrice | null;  // 최근 판매가
  margin_pct?: number | null;    // 최근 구매가 대비 판매가 마진%(USD 환산, 백엔드 계산)
  margin_cross?: boolean;        // 매입·매출 통화가 달라 환산으로 계산된 값인지
  buy_count: number;
  sell_count: number;
  last_date: string | null;
};
export type ItemLedger = {
  items: ItemLedgerRow[];        // 마스터 연결 품목
  unmatched: ItemLedgerRow[];    // part_no 미연결(마스터 없음)
  built_at: string | null;       // 마지막 재구축 일시(ISO)
};
/** 미분류 품목 자동 분류 제안 1건 — 그대로 적용 요청에 실어 보낼 수 있는 모양. */
export type AutoCategoryProposal = {
  item_id?: number | null;       // 마스터에 있는 품목. 없으면 배정 시 마스터가 생긴다
  part_no: string;
  description: string;
  maker?: string;
  category_id: number;
  category_path: string;         // "대 > 중 > 소"
  reason: string;                // 왜 이 분류인지(같은 품명 / 품번 계열 / 품명 낱말)
};
/* 선박 도면 보기(Item > Ship View) — 분류 트리 한 장에 품목과 그 품목이 나온 딜을 얹는다.
   목록(ItemLedgerRow)과 달리 품목마다 프로젝트가 딸려 온다: 이 화면의 물음이
   "이 계통에 어느 프로젝트가 걸려 있나"라서, 분류가 아니라 딜이 잎이 된다. */
export type ShipDeal = {
  rfq_id: number;
  rfq_no: string;                // RFQ 문서번호 KMS-RFQ-yymm-NNN(수동 입력이라 빌 수 있다)
  project_no: string;            // 화면이 부르는 이름 P-001(yymmdd) / S-001(yymmdd)
  title: string;                 // 프로젝트 제목(있으면)
  customer: string;
  vessel: string;
  date: string;
  status: string;
  lines: number;                 // 이 딜에서 이 품목이 나온 줄 수
  amount: number;                // 그중 매출 금액 합
};
export type ShipItem = {
  item_id: number;
  part_no: string;
  description: string;
  maker: string;
  unit: string;
  item_type: string;             // part | service
  category_id: number | null;    // null = 아직 미분류(배에 싣지 못한 품목)
  deals: ShipDeal[];
  buy: ItemLedgerPrice | null;
  sell: ItemLedgerPrice | null;
  customer: string;
  vendor: string;
  buy_count: number;
  sell_count: number;
  last_date: string | null;
  margin_pct?: number | null;
  margin_cross?: boolean;
};
export type ShipMap = {
  categories: {
    id: number;
    parent_id: number | null;
    level: number;
    name: string;
    sort_order: number;
    active: boolean;
  }[];
  items: ShipItem[];
  /** 분류마다 '누구에게 물어볼 수 있나'. traded=그 계통에서 실제로 산 이력이 있는 곳,
   *  아니면 취급한다고 적어만 둔 곳(Settings > Vendor 의 Item categories). */
  vendor_marks?: { category_id: number; name: string; traded: boolean }[];
  unmatched: number;             // 마스터에 연결조차 안 된 이력 줄 수(안내용)
  built_at: string | null;
};

export type ItemPriceRow = {
  id: number;
  price_type: "buy" | "sell";
  source_type: string;           // vendor_quote|po|quotation|order|ci|ar
  source_id: number;
  rfq_id: number | null;
  customer: string;
  vendor: string;
  vessel: string;
  part_no: string;
  description: string;
  currency: string;
  fx_rate: number | null;
  unit_price: number;
  qty: number;
  amount: number;
  doc_date: string | null;
};

export type SettingsUser = {
  id: number;
  username: string;
  email: string;
  role: "admin" | "sales" | "viewer" | string;
  is_active: boolean;
};

export type CompanyProfile = {
  company_name_en: string;
  company_name_kr: string;
  address: string;            // 국문 주소
  address_en: string;         // 영문 주소
  business_no: string;
  phone: string;
  general_email: string;
  sales_email: string;
  tax_email: string;
  website: string;
  bank_name: string;          // 국내계좌 은행명
  bank_account: string;       // 국내계좌 번호
  bank_holder: string;        // 국내계좌 예금주
  fx_bank_name: string;       // 외화계좌 은행명
  fx_bank_account: string;    // 외화계좌 번호
  fx_bank_holder: string;     // 외화계좌 예금주
  swift: string;              // 외화계좌 SWIFT
  tagline: string;
  email_signature: string;   // 이메일 본문 하단 공용 서명(비우면 기본 서명)
};

// uses = 거래 빈도(보낸 Vendor RFQ + 발행한 Vendor P/O 건수). 드롭다운에서
// 자주 거래하는 벤더를 위쪽 그룹으로 올리는 데 쓴다.
export type VendorOption = {
  id: number;
  name: string;
  email: string;
  /** 담당자 이름 · 대표 연락처 · 대표 주소 — 발주서 "Supplier information" 칸을 채운다. */
  contact?: string;
  phone?: string;
  address?: string;
  logo?: string;
  uses?: number;
};

export type PoRow = {
  id: number;
  customer_rfq_no: string;
  crfq_at: string;
  kmaris_rfq_no: string;
  vrfq_at: string;
  customer: string;
  project_title: string;
  vessel: string;
  customer_po_no: string;
  customer_po_at: string;
  item_count: number;
  vendor_po_no: string;
  vendor_po_at: string;
  vendor: string;
  vendor_email: string;
  stage: number;
  status: string;
};

export type PoDetail = {
  id: number;
  assignee_id: number; // 담당자(PIC) = RFQ.created_by (0 = 미지정)
  customer_po_no: string;
  customer_po_at: string;
  rfq_no: string;
  customer_rfq_no: string;
  quotation_no: string;
  currency: string;
  project_no: string;
  first_rfq_at: string;
  customer: string;
  customer_contact: string;
  customer_email: string;
  vessel_id: number;
  vessel: string;
  work_type: string;
  trade_type: string;
  project_title: string;
  status: string;
  order_status: string;
  stage: number;
  promised_delivery: string;
  shipped_date: string;
  delivered_date: string;
  tracking_token: string;
  steps: RfqStep[];
  items: RfqItem[];
  terms?: QuotationTerms;
  source_files: RfqSourceFile[]; // Auto-fill 소스 파일 메타(영구 보관)
  vendor_pos: {
    id: number;
    po_no: string;
    vendor: string;
    vendor_email: string;
    date: string;
    sent_date: string;
    status: string;
    item_count: number;
  }[];
  documents: {
    ci_no: string;
    pl_no: string;
    sa_no: string;
    tax_no: string;
    ar: {
      ci_no: string;
      currency: string;
      invoice_amount: number;
      paid_amount: number;
      due_date: string;
      status: string;
    }[];
  };
};

export type PoWorkItem = {
  part_no: string;
  description: string;
  type?: string;
  serial_no?: string;
  maker?: string;
  qty: number;
  unit: string;
  unit_price: number | null;
  amount: number | null;
  remark?: string;
  /** 품목 분류(선택). 저장 시 품목 마스터 분류로 반영된다. */
  category_id?: number | null;
  /** 용역이 닿은 선박 계통(선택). 건마다 달라 품목 마스터로는 올리지 않고 라인에만 남는다. */
  applied_to?: number | null;
  /** 문서에서 제외한 행 — DocumentWorkItem.excluded 와 같은 규칙(표에는 남고 발행 문서·합계에서 빠짐). */
  excluded?: boolean;
};

export type RfqOcrResult = {
  vessel_name?: string | null;
  rfq_date?: string | null;
  customer_rfq_no?: string | null;
  customer_hint?: string | null;
  contact_person?: string | null;
  notes?: string | null;
  items?: {
    part_no?: string;
    description?: string;
    type?: string;
    serial_no?: string;
    maker?: string;
    qty?: number;
    unit?: string;
    lead_time_req?: string;
    remark?: string;
  }[];
};

// 명함(사진·캡쳐·PDF) 인식 결과 — Customer/Vendor 등록 폼 자동 채우기용.
export type BusinessCardOcr = {
  company?: string;
  contact_name?: string;
  job_title?: string;
  address?: string;
  tax_id?: string;
  website?: string;
  emails?: string[];
  phones?: string[];
  regions?: string[];
};

export type OrderOcrResult = {
  customer_hint?: string | null;
  po_no?: string | null;
  order_date?: string | null;
  vessel_name?: string | null;
  promised_delivery?: string | null;
  items?: {
    part_no?: string;
    description?: string;
    maker?: string;
    qty?: number;
    unit?: string;
    unit_price?: number;
    remark?: string;
  }[];
};

export type PoWorkOptions = {
  customers: CustomerOption[];
  vessels: { id: number; name: string; customer_id: number | null }[];
  vendors: VendorOption[];
  rfqs: {
    id: number;
    rfq_no: string;
    customer_rfq_no: string;
    customer_id: number;
    customer: string;
    vessel_id: number | null;
    vessel: string;
    status: string;
    items: PoWorkItem[];
  }[];
  quotations: {
    id: number;
    qtn_no: string;
    rfq_id: number | null;
    customer_id: number;
    customer: string;
    vessel_id: number | null;
    vessel: string;
    status: string;
    currency: string;
    amount: number;
    vendor_quote_no: string; // 이 견적이 링크한 벤더 견적번호(미링크면 "")
    items: PoWorkItem[];
  }[];
  orders: {
    id: number;
    rfq_id: number;
    /** 이 오더가 나온 견적. 견적 없이 등록된 오더는 0(= 개요에서 "견적 없음"). */
    quotation_id: number;
    customer_id: number;
    customer: string;
    vessel_id: number | null;
    vessel: string;
    po_no: string;
    date: string;
    trade_type: string;
    currency: string;
    status: string;
    items: PoWorkItem[];
    project_title?: string;
    contact_person?: string;
    assignee?: string;
    assignee_id?: number;
    work_type: string;
    first_rfq_at: string;
  project_no: string;
  }[];
  purchase_orders: {
    id: number;
    po_no: string;
    order_id: number;
    customer_po_no: string;
    vendor_id: number;
    vendor: string;
    vendor_email: string;
    date: string;
    sent_date: string;
    status: string;
    sent: boolean;
    items: PoWorkItem[];
    customer: string;
    project_title?: string;
    contact_person?: string;
    assignee?: string;
    assignee_id?: number;
    vessel: string;
    trade_type: string;
    currency: string;
    work_type: string;
    first_rfq_at: string;
  project_no: string;
  }[];
  smtp_configured: boolean;
};

export type VendorPoPreview = {
  to: string;
  from?: string;
  subject: string;
  body: string;
  signature?: string;   // 본문과 분리해 내려온다 — 발송 시 본문 뒤에 다시 붙는다
  pdf_filename: string;
  smtp_configured: boolean;
};

export type VendorRfqPreview = {
  vendor_id: number;
  vendor_name: string;
  to: string;
  subject: string;
  body: string;
  xlsx_filename: string;
};

export type VendorQuoteItem = {
  item_no?: number | string;
  part_no: string;
  description: string;
  type?: string;
  serial_no?: string;
  maker?: string;
  manufacturer?: string;
  origin?: string;
  qty: number;
  unit: string;
  cost_price: number | null;
  lead_time?: string;
  remark?: string;
};

export type CustomerQuoteItem = {
  part_no: string;
  description: string;
  type?: string;
  serial_no?: string;
  qty: number;
  unit: string;
  cost_price: number | null;
  margin_pct: number | null;
  unit_price: number | null;
  amount: number | null;
  lead_time?: string;
  remark?: string;
  /** 품목 분류(선택). 저장 시 품목 마스터 분류로 반영된다. */
  category_id?: number | null;
  /** 용역이 닿은 선박 계통(선택). 건마다 달라 품목 마스터로는 올리지 않고 라인에만 남는다. */
  applied_to?: number | null;
  /** 문서에서 제외한 행 — 서버 _item_view 가 늘 실어 보낸다. 금액 0 과 다른 상태다
   *  (0 = 이 문서에 들어 있고 값이 0, 제외 = 이 문서에 나가지 않음). */
  excluded?: boolean;
};

export type QuotationTerms = {
  incoterms?: string;
  payment_terms?: string;
  delivery_place?: string;
  shipment_method?: string;
  packing?: string;
  warranty?: string;
  remarks?: string;          // 견적서 Remark 섹션(품목표와 T&C 사이) 본문
  // 견적서에 찍을 표준 T&C 문장 id 목록(web/lib/terms.ts QUOTATION_CLAUSES).
  // 값이 없으면 "고른 적 없음" = 전체 문장 인쇄(기존 견적 그대로).
  clauses?: string[];
  extra_clauses?: string[];  // 사용자가 직접 추가한 T&C 문장(표준 문장 뒤에 붙는다)
  // 견적서 헤더 문서 필드(첨부 양식) — terms JSON 에 함께 보관.
  messrs?: string;
  attn?: string;
  ref_no?: string;
  // 발주서(6단계) 헤더 문서 필드 — 마찬가지로 terms JSON 에 함께 보관한다.
  /** 견적번호 — 이 발주의 근거가 된 공급사 견적서 번호(Quotation No.). */
  vendor_quote_no?: string;
  /** 납기요청일 — 발주서 "Requested Delivery / Service Date"(YYYY-MM-DD). */
  requested_date?: string;
};

// Customer Quotation 작성 시 공급사 견적에서 cost 불러오기용
export type VendorQuoteOverviewRow = {
  id: number;
  rfq_id: number | null;
  vendor_quote_no: string;
  customer_rfq_no: string;
  vendor: string;
  received_at: string;
  received_date: string;
  item_count: number;
  amount: number;
  currency: string;
  customer: string;
  project_title?: string;
  contact_person?: string;
  assignee?: string;      // 담당자(PIC) username
  assignee_id?: number;   // 담당자(PIC) = RFQ.created_by (0 = 미지정)
  level?: string;
  status?: string;
  vessel: string;
  work_type: string;
  first_rfq_at: string;
  project_no: string;
};

export type VendorQuoteForImport = {
  id: number;
  /** 이 견적이 답한 Vendor RFQ. 개요의 번호 링크가 그 벤더 탭을 열 때 쓴다. */
  vendor_rfq_id?: number | null;
  vendor_quote_no: string;
  vendor: string;
  received_date: string;
  received_at?: string;
  currency: string;
  items: VendorQuoteItem[];
  terms?: QuotationTerms;
};

export type QtnRow = {
  id: number;
  rfq_id: number | null;
  qtn_no: string;
  rfq_no: string;
  customer: string;
  assignee?: string;      // 담당자(PIC) username
  assignee_id?: number;   // 담당자(PIC) = RFQ.created_by (0 = 미지정)
  project_title?: string;
  contact_person?: string;
  vessel: string;
  currency: string;
  amount: number;
  item_count: number;
  status: string;
  level: string;
  valid_until: string;
  sent_at: string;
  sent_date: string;
  date: string;
  stage: number;
  pipeline: string;
  work_type: string;
  first_rfq_at: string;
  project_no: string;
};

export type VrfqRow = {
  id: number;
  rfq_id: number | null;
  customer_rfq_no: string;
  kmaris_rfq_no: string;   // 이 Vendor RFQ 고유의 K-Maris RFQ No.
  vendor: string;
  vendor_email: string;
  sent_date: string;
  status: string;
  item_count: number;
  quote_count: number;
  customer: string;
  project_title?: string;
  contact_person?: string;
  assignee?: string;      // 담당자(PIC) username
  assignee_id?: number;   // 담당자(PIC) = RFQ.created_by (0 = 미지정)
  level?: string;
  vessel: string;
  work_type: string;
  first_rfq_at: string;
  project_no: string;
};

export type DocRow = {
  id: number;
  customer: string;
  project_title?: string;
  contact_person?: string;
  assignee?: string;      // 담당자(PIC) username
  assignee_id?: number;   // 담당자(PIC) = RFQ.created_by (0 = 미지정)
  vessel: string;
  po_no: string;
  trade_type: string;
  work_type: string;
  vendor: string;
  ci_no: string;
  pl_no: string;
  sa_no: string;
  sa_sent_date: string;
  tax_no: string;
  pod_filename: string;
  has_ci: boolean;
  has_pl: boolean;
  has_sa: boolean;
  has_pod: boolean;
  has_tax: boolean;
  svc_ready_done: boolean;
  svc_billed: boolean;
  first_rfq_at: string;
  project_no: string;
};

export type DocumentWorkItem = {
  item_no?: number | string;
  part_no?: string;
  description?: string;
  maker?: string;
  origin?: string;
  qty: number;
  unit?: string;
  unit_price?: number | null;
  amount?: number | null;
  hs_code?: string;
  remark?: string;
  package?: string;
  pkg_qty?: string | number;
  pkg_kind?: string;
  net_weight?: string | number;
  gross_weight?: string | number;
  measurement?: string | number;
  dimension?: string;
  // 문서에서 제외한 행 — 삭제와 달리 편집표에는 남고(회색) 언제든 되살릴 수 있다.
  // 저장은 되지만 합계와 발행 문서(PDF·Excel)에서는 빠진다(서버 normalize_items 가 거른다).
  excluded?: boolean;
};

export type DocumentDetail = {
  order: {
    id: number;
    rfq_id: number;
    assignee_id: number; // 담당자(PIC) = RFQ.created_by (0 = 미지정)
    po_no: string;
    kms_order_no: string; // K-Maris (Vendor) P/O No.(KMS-ORD-…) — Shipping Marks Reference No. 자동입력
    /** 고객 견적번호 — 오더가 아직 없는 4단계 문서 문맥에서만 채워진다(PI 번호 자동채번용). */
    quotation_no?: string;
    date: string;
    status: string;
    customer: string;
    customer_email: string;
    customer_address: string;   // 문서의 BUYER 칸 주소(고객 마스터의 대표 주소)
    customer_addresses?: string[];   // 본사·지사 주소 목록(BUYER 칸에서 골라 쓴다)
    customer_tax_id: string;
    // 청구서(Bill to) 선택지 — 저장된 고객 정보에서 고르거나 직접 입력.
    customer_contact?: string;   // 대표 담당자명(person-centric flat 필드)
    customer_tax_invoice_email?: string;
    customer_emails?: string[];
    customer_phones?: string[];
    customer_contacts?: { name: string; email: string; phone: string; position: string }[];
    vessel: string;
    project_title: string;
    project_no: string;
    first_rfq_at: string;
    work_type: string;
    vendor: string;
    trade_type: string;
    service_info: Record<string, Record<string, unknown>>;
    tracking_token: string;
    consignee_confirmed_date: string;
    vendor_docs_sent_date: string;
    pod_notes?: string;          // 8) Delivery Complete · POD 메모
    items: DocumentWorkItem[];
    // 상위 단계에서 이미 입력한 값 — 문서(PI/CI)의 빈 칸을 채우는 기본값.
    // 우선순위는 고객 P/O(5단계) > 견적(3·4단계)이며, sources 는 각 값이 어느 단계에서 왔는지.
    doc_defaults?: {
      incoterms: string;
      payment_terms: string;
      packing: string;        // 포장 방법 — 문서에서는 terms.packing_type 칸에 들어간다
      delivery_place: string; // Incoterms 의 지정 장소(규칙에 따라 출발지/도착지)
      currency: string;
      sources: Record<string, "order" | "quotation">;
    };
  };
  pod: null | { id: number; filename: string; uploaded_at: string };
  stage_done: { "7": boolean; "8": boolean; "10": boolean; "11": boolean };
  pi: null | {
    id: number;
    pi_no: string;
    date: string;
    currency: string;
    vat_rate: number;
    items: DocumentWorkItem[];
    shipping: Record<string, string>;
    terms?: Record<string, string>;
    missing: { part_no: string; description: string; order_qty: number; doc_qty: number }[];
  };
  ci: null | {
    id: number;
    ci_no: string;
    date: string;
    currency: string;
    vat_rate: number;
    items: DocumentWorkItem[];
    shipping: Record<string, string>;
    terms?: Record<string, string>;
    missing: { part_no: string; description: string; order_qty: number; doc_qty: number }[];
  };
  pl: null | {
    id: number;
    pl_no: string;
    date: string;
    items: DocumentWorkItem[];
    packing_info?: string;
    shipping?: Record<string, string>;
    missing: { part_no: string; description: string; order_qty: number; doc_qty: number }[];
  };
  sa: null | {
    id: number;
    sa_no: string;
    date: string;
    shipping: Record<string, string>;
    sent_date: string;
  };
  tax: null | {
    id: number;
    tax_no: string;
    date: string;
    items: DocumentWorkItem[];
  };
  smtp_configured: boolean;
};

export type VendorPoRow = {
  id: number;
  po_no: string;
  customer: string;
  vendor: string;
  vendor_email: string;
  date: string;
  sent_date: string;
  status: string;
  item_count: number;
  sent: boolean;
};

export type ArRow = {
  id: number;
  order_id: number;
  assignee_id: number; // 담당자(PIC) = RFQ.created_by (0 = 미지정)
  assignee?: string;   // 담당자(PIC) username
  project_title?: string;
  contact_person?: string;
  ci_no: string;
  customer: string;
  currency: string;
  invoice_amount: number;
  paid_amount: number;
  /** 크레딧 노트(클레임 상계)로 깎아 준 금액 — 받을 돈 = 청구액 − 수금액 − 이 값. */
  credit_amount?: number;
  outstanding: number;
  due_date: string;
  status: string;
  overdue: boolean;
  notes: string;
  tax_issued: boolean;
  tax_issued_date: string;
  /** 프로포마 인보이스로 갈음한 발행 — 수동 완료 표시가 아니라 PI 존재가 근거다. */
  tax_covered_by_pi?: boolean;
  tax_pi_no?: string;
  paid_done: boolean;
  paid_date: string;
  // 매입(AP) 진척 — 이 P/O 의 벤더 P/O 총건수 대비 완료 건수. 9·10·11 단계는
  // 매출(AR)·매입(AP)이 모두 끝나야 완료라, 남은 쪽을 화면에 표시하는 데 쓴다.
  ap_total: number;
  ap_billed: number;   // 벤더 대금청구서 수취(9단계)
  ap_tax: number;      // 벤더 전자세금계산서 수취(10단계)
  ap_paid: number;     // 벤더 지급 완료(11단계)
  vessel: string;
  work_type: string;
  trade_type: string;
  vendor: string;
  first_rfq_at: string;
  project_no: string;
  // 세금계산서(대금청구서) 문서 필드
  invoice_no: string;
  invoice_date: string;
  vat_rate: number;
  items: TaxInvoiceItem[];
  charges?: DocCharges;
  remarks: string;
  // 청구처(BILL TO) 오버라이드 — 비우면 고객 마스터값 사용.
  bill_to_tax_id: string;
  bill_to_contact: string;
  bill_to_email: string;
  bill_to_phone: string;
};

/** 부대비용 — 품목 소계에 더해 VAT·합계를 계산한다(PI/CI 의 terms 와 같은 3개 값). */
export type DocCharges = {
  freight?: number | string;
  packing?: number | string;
  insurance?: number | string;
};

/** 세금계산서(대금청구서) 청구 품목 1줄. */
export type TaxInvoiceItem = {
  description: string;
  part_no: string;
  qty: number;
  unit_price: number;
  amount: number;
  // 문서에서 제외한 행 — DocumentWorkItem.excluded 와 같은 규칙(표에는 남고 발행 문서·합계에서 빠짐).
  excluded?: boolean;
};

/** 클레임 비용 라인 — 누가 부담하고(bearer) 어떻게 정산했는지(settlement)를 함께 적는다.
 *  이 둘이 있어야 같은 금액이 매출 차감과 비용 계상으로 두 번 잡히지 않는다. */
export type ClaimCost = {
  kind: string;         // labor(공임) / parts(부품) / freight / inspection / other
  description: string;
  amount: number;
  currency: string;
  bearer: string;       // us(당사) / customer(고객) / vendor / shared
  settlement: string;   // credit_note(AR 상계) / cash(현금지급) / vendor_ap / none(정보성)
};

/** 크레딧 노트 문서의 감액 내역 한 줄 — 금액은 상계 대상 청구서 통화로 적는다.
 *  실제 발행 양식의 표(No./Description/Reference/Qty/Unit Price/Amount)와 같은 칸이다. */
export type CreditNoteItem = {
  description: string;
  reference: string;
  qty: number;
  unit_price: number;
  amount: number;
};

/** 크레딧 노트(감액 증서) — 반드시 상계 대상 청구서(ar_id)에 붙는다. */
export type CreditNoteRow = {
  id: number;
  cn_no: string;
  claim_id: number;
  ar_id: number;
  order_id: number;
  customer_id: number;
  issue_date: string;
  currency: string;       // 발행 통화(현장 비용 통화 그대로)
  amount: number;
  fx_rate: number;        // 1 발행통화 = ? 청구서통화
  applied_amount: number; // 청구서 통화 기준 상계액
  vat_rate: number;
  vat_amount: number;
  reason: string;
  status: string;         // issued / void
  // ── 발행 문서(CREDIT NOTE)에 찍히는 칸 — 실제 발행 양식과 같은 항목.
  items: CreditNoteItem[];
  vessel_name: string;        // Reference Vessel
  settlement_method: string;  // 예: "Set-off against outstanding balance"
  cash_refund: string;        // "No" / "Yes"
  rate_basis: string;         // 환율 근거(예: "Shinhan Bank Basic Exchange Rate")
  fx_quotation: string;       // 고시 회차·시각
  terms: string[];            // SET-OFF / OFFSET TERMS 조항(한 줄 = 한 조항)
  invoice_no: string;     // 상계 대상 청구서 번호(표시용)
  invoice_date: string;
  invoice_currency: string;
};

/** 납품 후 클레임 1건 — 비용 라인(costs)과 그 클레임으로 발행한 크레딧 노트를 함께 담는다. */
export type ClaimRow = {
  id: number;
  rfq_id: number;
  order_id: number;
  claim_no: string;
  occurred_date: string;
  reported_date: string;
  site: string;
  title: string;
  description: string;
  status: string;         // open / settled / closed
  costs: ClaimCost[];
  owner_id: number;
  owner: string;
  project_no: string;
  credit_notes: CreditNoteRow[];
};

/** Finance 클레임 대장 한 줄 — 금액은 전부 KRW 환산(사건이 난 달의 말일 매매기준율). */
export type FinanceClaimRow = {
  id: number;
  rfq_id: number;
  order_id: number;
  project_no: string;
  customer: string;
  claim_no: string;
  date: string;
  site: string;
  title: string;
  status: string;
  owner: string;
  /** 당사 부담 합계. */
  ours_krw: number;
  /** 고객·벤더가 부담한 몫 — 사건의 크기이지 우리 손익은 아니다. */
  theirs_krw: number;
  /** 크레딧 노트로 상계한 금액. */
  credited_krw: number;
  /** 현금으로 물어 준 금액. */
  cash_krw: number;
  /** 아직 정산하지 않은 당사 부담분 = ours − credited − cash. */
  open_krw: number;
  credit_notes: {
    id: number;
    cn_no: string;
    issue_date: string;
    invoice_no: string;
    currency: string;
    total: number;
    issue_currency: string;
    issue_amount: number;
    fx_rate: number;
    ar_id: number;
    /** 깎아 준 청구서가 속한 딜 — 클레임의 딜과 다를 수 있다(다른 프로젝트의 미수 상계). */
    order_id: number;
    rfq_id: number;
  }[];
};

export type FinanceClaimsData = {
  rows: FinanceClaimRow[];
  totals: {
    count: number;
    ours_krw: number;
    theirs_krw: number;
    credited_krw: number;
    cash_krw: number;
    open_krw: number;
  };
  /** 원화로 옮길 때 쓴 환율 — entered=true 는 고시가 아니라 크레딧 노트에 적어 둔 값이다. */
  fx?: FxNote;
};

/** 상계 대상이 될 수 있는 청구서 — 그 고객의 청구서 전부(다른 프로젝트 건도 포함). */
export type ArCandidate = {
  ar_id: number;
  order_id: number;
  po_no: string;
  invoice_no: string;
  invoice_date: string;
  currency: string;
  invoice_amount: number;
  paid_amount: number;
  credit_amount: number;
  outstanding: number;
  status: string;
  project_no: string;
  /** 이 청구서에 이미 붙은 크레딧 노트 수 — 번호 자동 제안(-CN2)에 쓴다. */
  credit_count: number;
  same_order: boolean;
};

export type ArData = {
  kpi: { outstanding_usd: number; overdue_usd: number; count: number };
  rows: ArRow[];
};

/** 매입 청구(AP) 레코드 — ARRecord 의 매입측 대응. 벤더 P/O 1건에 1:1. */
export type ApRow = {
  id: number;
  po_id: number;
  order_id: number;
  vendor_id: number | null;
  po_no: string;
  vendor: string;
  bill_no: string;
  bill_date: string;
  invoice_amount: number;
  paid_amount: number;
  /** 실제 지급일 — 예정일(due_date)과 달리 돈이 나간 날. Finance 실적 집계의 기준. */
  paid_date: string;
  outstanding: number;
  currency: string;
  vat_rate: number;
  due_date: string;
  status: string;
  items: TaxInvoiceItem[];
  charges?: DocCharges;
  notes: string;
  tax_received: boolean;
  tax_received_date: string;
  tax_invoice_no: string;
};

/** AP 탭의 벤더 P/O 1행 — 선택기 + (있으면) 그 P/O 의 AP 레코드. */
export type ApByOrderRow = {
  po_id: number;
  po_no: string;
  vendor_id: number | null;
  vendor: string;
  currency: string;
  date: string;
  items: DocumentWorkItem[];   // 원본 P/O 품목(Load P/O 로 청구 품목에 채움)
  ap: ApRow | null;
};

/** AP 저장 바디(부분 저장 허용). */
export type ApSave = {
  po_id: number;
  order_id: number;
  vendor_id?: number | null;
  bill_no?: string;
  bill_date?: string;
  invoice_amount?: number;
  paid_amount?: number;
  paid_date?: string;
  currency?: string;
  vat_rate?: number | null;
  due_date?: string;
  status?: string;
  items?: TaxInvoiceItem[];
  charges?: DocCharges;
  notes?: string;
  tax_received?: boolean;
  tax_received_date?: string;
  tax_invoice_no?: string;
};

// ── Finance(재무) ──────────────────────────────────────────────────────────────
export type FinancePayable = {
  id: number;
  category: string;
  counterparty: string;
  vendor_id: number | null;
  description: string;
  amount: number;               // 지급 총액(공급가액 + 부가세)
  vat_amount?: number;          // 총액에 포함된 부가세(매입세액). AP 유래 행은 없음
  supply_amount?: number;       // 공급가액 = amount − vat_amount
  // 미수 목록과 같은 3열(청구·지급·미지급). 반복 항목은 1회차 금액 기준.
  invoice_amount: number;
  paid_amount: number;
  outstanding: number;
  currency: string;
  due_date: string;
  recurrence: "none" | "monthly" | "quarterly" | "yearly";
  recur_until: string;
  /** 이 비용이 걸리는 기간 'YYYY-MM' — 여러 달을 덮는 고지서를 그 달들에 나눠 싣는다. */
  accrual_from?: string;
  accrual_to?: string;
  paid: boolean;
  // 미납인 채 지급 예정일이 지난 건(미수 목록의 같은 이름 필드와 대칭).
  // 반복 항목은 오늘까지 도래한 회차 중 미납이 하나라도 있으면 true.
  overdue?: boolean;
  paid_date: string;            // 실제 납부일(반복 항목은 가장 최근 납부일)
  paid_dates: string[];         // 반복 항목의 납부 완료 회차일
  payments?: Record<string, string>;  // {회차일: 실제 납부일}
  /** 외화 지급에 적용한 환율(1 외화 = ? KRW). 0 = 미입력(그 달 매매기준율로 환산된다). */
  fx_rate?: number;
  notes: string;
  owner_id: number;
  owner: string;
  // "ap" = 매입 청구(APRecord) 유래, "bankfee" = 외화 수금에서 떼인 은행 수취수수료를
  // 계산해 세운 행. 둘 다 읽기전용이다(등록해서 만든 행이 아니다).
  source?: "manual" | "ap" | "bankfee";
  bill_date?: string;         // 청구서·고지서 발행일(AP=9단계 입력값, 수동 등록=직접 입력)
  po_no?: string;             // source==="ap" 일 때 연결된 벤더 P/O 번호
  po_id?: number;             // source==="ap" 일 때 그 벤더 P/O id — 9단계 AP 탭 딥링크용
  order_id?: number;          // source==="ap" 일 때 이 청구가 속한 프로젝트(오더) — 딥링크용
  // 이 지급이 걸린 프로젝트(RFQ). AP 유래 행은 그 오더의 프로젝트, 수동 등록은 컨설팅
  // 수수료처럼 '어느 딜의 매출에서 나온 지급인가'가 금액의 근거인 항목에만 채워진다.
  rfq_id?: number;
};

/** 한 딜에 직접 걸린 지급(벤더 P/O 없는 매입) — 프로젝트 9~11단계 Payable 탭이 읽는다. */
export type DealPayables = {
  rfq_id: number;
  project_no: string;
  /** 이 오더의 벤더 P/O 수 — 0 이 아니면 같은 원가를 두 번 세고 있을 수 있다. */
  ap_count: number;
  rows: FinancePayable[];
};

export type FinancePayableSave = {
  category?: string;
  counterparty?: string;
  vendor_id?: number | null;
  /** 이 지급이 걸린 프로젝트(RFQ). 컨설팅 수수료는 어느 딜의 매출에서 나왔는지,
   *  거래선지급은 어느 딜의 매입 원가인지(벤더 P/O 없이 나간 지급). */
  rfq_id?: number | null;
  description?: string;
  amount?: number;      // 지급 총액(공급가액 + 부가세)
  vat_amount?: number;  // 그 중 부가세 — 결산·부가세의 매입세액으로 집계된다
  currency?: string;
  /** 외화 지급에 적용한 환율(1 외화 = ? KRW). 원화 건은 비운다. */
  fx_rate?: number;
  bill_date?: string;
  due_date?: string;
  recurrence?: string;
  recur_until?: string;
  /** 이 비용이 걸리는 기간 'YYYY-MM' — 비우면 청구일 한 달에 통째로 선다. */
  accrual_from?: string;
  accrual_to?: string;
  notes?: string;
};

/** 소개자(컨설턴트) 마스터 — Settings 의 Consultant 탭이 쓰는 한 행. */
export type SettingsConsultant = {
  id: number;
  name: string;
  company: string;
  phone: string;
  email: string;
  country: string;
  tax_id: string;
  bank_name: string;
  bank_account: string;
  bank_holder: string;
  swift: string;
  /** 기본 수수료율(%) — 딜에서 따로 정하지 않으면 이 값. */
  default_rate: number;
  currency: string;
  notes: string;
};

/**
 * 소개 수수료 한 줄 = 소개자가 걸린 프로젝트 하나. 금액은 우리가 정하는 값이 아니라
 * 매출에서 계산되는 값이라, 지급 목록이 아니라 그 근거(매출·요율)를 먼저 담는다.
 */
export type FinanceConsultingRow = {
  rfq_id: number;
  project_no: string;
  rfq_no: string;
  project_title: string;
  customer: string;
  consultant_id: number;
  consultant: string;
  /** 지급 계좌 한 줄 표기(은행 + 계좌번호). 미등록이면 빈값. */
  bank: string;
  rate: number;              // %
  currency: string;          // 매출 통화
  sales_amount: number;
  /** invoiced = 고객 청구 합계, order = 아직 청구 전이라 오더 금액으로 잡은 임시값. */
  basis: "invoiced" | "order" | "none";
  fee: number;               // 매출 통화 기준 수수료
  pay_currency: string;      // 컨설턴트 계좌 통화로 환산한 지급액
  pay_amount: number;
  invoice_date: string;      // 마지막 청구일
  /** 그 프로젝트 매출이 전액 입금된 날 — 지급 예정일(입금 + 1주일)의 출발점. 미입금이면 빈값. */
  collected_date: string;
  registered: MoneyByCurrency;   // 이미 등록한 수수료 지급 합계
  registered_count: number;
};

export type FinanceReceivable = {
  id: number;
  order_id: number;
  rfq_id?: number;       // 이 청구서가 속한 프로젝트 — 목록 → 프로젝트 팝업 딥링크용
  customer: string;
  ci_no: string;
  invoice_no: string;
  currency: string;
  invoice_amount: number;
  paid_amount: number;
  outstanding: number;
  invoice_date?: string; // 청구서 발행일(9단계 대금청구서). 기타 수입은 없음
  due_date: string;
  paid_date?: string;    // 완납 건의 수금 완료일(11단계 완료일 / 기타 수입은 실제 입금일)
  status: string;
  overdue: boolean;
  // "ar" = 프로젝트 매출(ARRecord), "income" = 수동 등록한 기타 수입.
  source?: "ar" | "income";
  category?: string;
  counterparty?: string;
  customer_id?: number | null;
  description?: string;
  amount?: number;
  recurrence?: "none" | "monthly" | "quarterly" | "yearly";
  recur_until?: string;
  paid?: boolean;
  paid_dates?: string[];
  payments?: Record<string, string>;
  notes?: string;
};

/** 기타 수입 등록/수정 바디 — 지급대장(FinancePayableSave)의 수입측 대응. */
export type FinanceIncomeSave = {
  category?: string;
  counterparty?: string;
  customer_id?: number | null;
  description?: string;
  amount?: number;
  currency?: string;
  due_date?: string;
  recurrence?: "none" | "monthly" | "quarterly" | "yearly";
  recur_until?: string;
  notes?: string;
};

// 통화별 합계 맵(예: { KRW: 1000000, USD: 500 }).
export type MoneyByCurrency = Record<string, number>;

/** 참고용 환산에 쓰는 환율 — source="exim" 이면 그날 매매기준율, "fixed" 면 고정환율 폴백. */
export type FxQuote = { rate: number; date: string; source: "exim" | "fixed" };

/** 재무 요약 — 금액은 모두 통화별 분리(환산 없음). */
export type FinanceSummary = {
  receivable: {
    outstanding: MoneyByCurrency;
    overdue: MoneyByCurrency;
    count: number;
  };
  payable: {
    upcoming_30d: MoneyByCurrency;
    overdue: MoneyByCurrency;
    total: MoneyByCurrency;
  };
  /** 실적 KPI 가 가리키는 달(YYYY-MM). 잔액 KPI 와 달리 기간이 있는 값이라 함께 준다. */
  month: string;
  /** 그 달의 [1일, 말일] — 화면이 기간 상세 링크를 만들 때 쓴다. */
  month_start: string;
  month_end: string;
  /** 이번 달에 실제로 들어온/나간 돈 — 잔액 KPI 에서는 완납 즉시 사라지는 값. */
  collected_month: { amount: MoneyByCurrency; count: number };
  paid_month: { amount: MoneyByCurrency; count: number };
  by_customer: { name: string; outstanding: MoneyByCurrency }[];
  by_category: { name: string; amount: MoneyByCurrency }[];
};

/**
 * 원화로 옮길 때 실제로 쓴 환율 — 화면 각주용. 외화 거래가 없으면 rates 는 빈 배열이다.
 * fallback=true 는 고시를 못 받아 고정환율로 옮긴 건이 섞여 있다는 뜻(EXIM_API_KEY 미설정 등).
 */
export type FxNote = {
  basis: "month_end";
  rates: { month: string; cur: string; rate: number; date: string; entered?: boolean }[];
  fallback: boolean;
  fixed: number;
};

export type FinanceClosing = {
  period: { start: string; end: string; year: number };
  sales: { supply_krw: number; vat_krw: number; total_krw: number; count: number };
  purchase: { cost_krw: number; vat_krw: number; count: number };
  /** 기타 지출(수동 등록) — 마진에는 넣지 않고 매입세액 계산에만 쓰는 값. */
  other_costs?: { supply_krw: number; vat_krw: number; count: number };
  /** 크레딧 노트로 깎아 준 매출 — 위 sales 는 이미 이만큼 뺀 값이다. */
  credit_notes?: { supply_krw: number; vat_krw: number; total_krw: number; count: number };
  margin_krw: number;
  margin_pct: number;
  vat: {
    output_krw: number;
    input_krw: number;
    /** 매입세액의 출처 — 프로젝트 매입(10% 추정) / 기타 지출(입력값). */
    input_purchase_krw?: number;
    input_other_krw?: number;
    payable_krw: number;
  };
  by_customer: { name: string; sales_krw: number }[];
  monthly: {
    labels: string[];
    sales: number[];
    purchase: number[];
    /** 월별 매출세액·매입세액. 구 API 에는 없으므로 없으면 표에서 부가세 줄을 접는다. */
    output_vat?: number[];
    input_vat?: number[];
  };
  fx?: FxNote;
  usd_krw: number;
};

/**
 * 월별 손익 — 매출 − 비용 − 세금. 모든 줄이 12칸(1~12월) 배열이고 단위는 KRW.
 * 합계·순수익은 화면에서 더한다(추정 부가세를 세금에 넣고 빼는 스위치가 화면에 있다).
 */
export type FinanceProfit = {
  year: number;
  labels: string[];
  revenue: {
    sales: number[];
    other_income: number[];
    /** 투자금(자본 유입) — 통장에는 들어오지만 매출이 아니라 합계 밖에 세우는 줄. */
    investment: number[];
  };
  costs: {
    purchase: number[];
    /** 소개 수수료 — 매출이 선 달에 요율만큼 잡은 발생분(합계에 든다). */
    consulting: number[];
    /** 그 의무를 실제로 등록한 지급 건 — 같은 돈이라 합계 밖에 세워 두는 줄. */
    consulting_booked: number[];
    /** 수동 지급대장의 분류별 운영비(공급가액). key 는 저장값(한글 코드). */
    operating: { key: string; values: number[] }[];
    /** '거래선지급' 분류 — 벤더 P/O 원가와 겹쳐 합계 밖에 세워 두는 줄. */
    vendor_manual: number[];
  };
  taxes: {
    vat: number[];
    payments: number[];
    /** 연간 추정 법인세를 이익 난 달에 나눠 실은 값(화면 스위치로 켜고 끈다). */
    corporate: number[];
  };
  /** 법인세 시뮬레이션의 근거 — 세전이익과 그 위에서 나온 세액. */
  corporate_tax: {
    base: number;
    national: number;
    local: number;
    total: number;
    top_rate: number;
  };
  vat_detail: { output: number[]; input: number[] };
  /**
   * 칸별 내역 — details["sales"]["5"] = 6월 매출을 이룬 거래선/금액. 운영비는 "op:임차료"
   * 처럼 분류 코드를 붙인 key 를 쓴다. 큰 것부터 몇 개만 담고 나머지는 건수로 접는다.
   */
  details?: Record<string, Record<string, {
    rows: { name: string; amount: number }[];
    more: number;
    more_amount: number;
  }>>;
  fx?: FxNote;
  usd_krw: number;
};

export type FinanceCashflowRow = {
  label: string;
  start: string;
  end: string;
  inflow: number;
  outflow: number;
  /** 위 유입·유출 중 이미 오간 금액(나머지가 아직 안 온 예정). */
  actual_inflow: number;
  actual_outflow: number;
  /**
   * 그 실적의 출처별 내역 — 예정 쪽 in_ar·in_income·out_ap·out_other 와 같은 갈래.
   * actual_in_ar + actual_in_income = actual_inflow (유출도 같다). 화면의 세 기둥이
   * '미수·실적 × 매출·기타' 격자라 실적도 같은 갈래로 갈라져야 한다.
   * 옛 백엔드는 보내지 않는다(그때 격자 아랫줄은 합계 칸만 채워진다).
   */
  actual_in_ar?: number;
  actual_in_income?: number;
  actual_out_ap?: number;
  actual_out_other?: number;
  /**
   * 예정분의 출처별 내역. in_ar + in_income + actual_inflow = inflow (유출도 같다).
   * 단 예정을 잔고 밖에 세워 두면(include_expected=0) 이 갈래들은 inflow 밖에 있는
   * '잔고에 넣지 않은 예정'이 된다 — 내역은 그대로 보여 주되 잔고는 건드리지 않는다.
   */
  in_ar: number;
  in_income: number;
  out_ap: number;
  out_other: number;
  /**
   * 예정일이 지났는데 아직 안 오간 돈. 기본은 위 inflow/outflow **밖에** 있다 —
   * 오지 않은 돈으로 잔고를 굴리면 그 뒤 모든 구간이 함께 틀어지기 때문이다.
   * include_overdue=1 로 부르면 흐름 안에 들어가고, 이 값은 '그중 연체분'이 된다.
   */
  overdue_in: number;
  overdue_out: number;
  /**
   * 아직 예정일이 오지 않은 미정산(연체와 겹치지 않는다). include_expected=0 이면 위
   * inflow/outflow **밖에** 있고 — 잔고는 실제로 오간 돈만으로 굴러간다 — 1 이면 그
   * 안에 든 예정분이다. 옛 백엔드는 이 필드를 보내지 않는다(그때는 늘 굴린 값).
   */
  expected_in?: number;
  expected_out?: number;
  /**
   * 클레임 상계(크레딧 노트)로 지워진 미수 — 돈이 오간 적이 없어 inflow **밖**이고
   * 잔고를 움직이지 않는다. 이 줄이 없으면 미수가 왜 줄었는지가 표에서 사라진다.
   * 건별 내역은 장부(/cashflow/items)의 set-off 줄. 옛 백엔드는 보내지 않는다.
   */
  offset_in?: number;
  net: number;
  cumulative: number;
};

/** 현금흐름 — 잔고는 한 통화 안에서만 의미가 있어 통화 1개 기준으로만 낸다. */
export type FinanceCashflow = {
  unit: "month" | "week";
  currency: string;
  opening: number;
  /** 기초잔고 기준일 — 첫 구간 시작일(월 단위면 이번 달 1일). */
  opening_as_of: string;
  rows: FinanceCashflowRow[];
  total_inflow: number;
  total_outflow: number;
  actual_inflow: number;
  actual_outflow: number;
  /** 창 전체에 묶여 있는 연체 — 기말잔고 밖의 돈(include_overdue=1 이면 그 안의 연체분). */
  overdue_in: number;
  overdue_out: number;
  overdue_included: boolean;
  /** 창 전체의 예정(아직 예정일 전) — 잔고 밖에 세워 두었을 때 그 크기. */
  expected_in?: number;
  expected_out?: number;
  /**
   * 이 집계가 예정을 굴렸는가. 스위치가 아니라 이 값으로 화면이 정한다 — 옛 백엔드는
   * 이 필드가 없고(undefined), 그때 집계는 예정을 그대로 굴린 값이라 화면만 빼면 어긋난다.
   */
  expected_included?: boolean;
  ending: number;
};

/** 현금흐름 한 구간을 건별로 펼친 내역 — 표의 한 칸을 눌러 들어가는 화면용. */
export type FinanceCashflowItem = {
  /**
   * ar=매출채권, income=기타수입, payable=지급대장, ap=벤더청구, po=발주원가(추정),
   * credit=클레임 상계(크레딧 노트로 지운 미수 — 돈은 오가지 않았다).
   */
  kind: "ar" | "income" | "payable" | "ap" | "po" | "credit";
  /** 예정분은 예정일, 실적분은 실제로 오간 날, 상계는 크레딧 노트 발행일. */
  date: string;
  party: string;
  ref: string;
  memo: string;
  amount: number;
  /** true = 이미 오간 돈(실적), false = 아직 안 온 예정. */
  actual: boolean;
  overdue: boolean;
  /**
   * 통장이 움직이지 않은 줄(상계). 목록에는 서지만 합계·잔고 밖이라, 더해 보는 쪽에서
   * 반드시 걸러야 한다. 옛 백엔드는 보내지 않는다(그때는 이런 줄 자체가 없었다).
   */
  noncash?: boolean;
  /** 상계 줄에만 — 깎인 청구서의 청구액과 그 청구서에 남은 잔액. */
  target_amount?: number;
  target_outstanding?: number;
  /**
   * 상계 줄에만 — 그 입금에서 덜어 낸 몫. 입금 줄이 그 내역을 이미 펼치므로 장부는 이
   * 줄을 접는다(한 번 오간 돈에 줄 하나). 건별 목록처럼 줄을 다 세우는 화면은 그대로 쓴다.
   */
  paired?: boolean;
  /** 상계 줄에만 — 깎아 준 청구서 번호. ref 자리는 이 줄의 문서(크레딧 노트 번호)다. */
  invoice_ref?: string;
  /**
   * 입금(ar·actual) 줄에만 — 청구액 중 상계로 깎여 통장에 들어오지 않은 몫과 원래 청구액,
   * 그리고 그 몫을 깎은 크레딧 노트 번호. amount 는 이미 그만큼 덜어 낸 '통장에 꽂힌
   * 금액'이다. set_off=0 이면 청구액이 그대로 들어왔다.
   */
  set_off?: number;
  invoiced?: number;
  set_off_ref?: string;
  row_id: number;
  order_id: number;
  rfq_id: number;
  po_id: number;
};

/** 현금흐름 한 칸을 이루는 여섯 갈래 — 화면의 여섯 줄과 1:1. */
export type CashBucket = "receivables" | "income" | "collected" | "payables" | "other" | "paid";

export type FinanceCashflowItems = {
  start: string;
  end: string;
  currency: string;
  /** 걸린 갈래(없으면 전체). 이 값이 있으면 반대편 목록은 비어 있다. */
  bucket: CashBucket | "";
  inflow: FinanceCashflowItem[];
  outflow: FinanceCashflowItem[];
  /** 현금만 센 합계 — 상계(noncash) 줄은 목록에 서 있어도 여기에는 들지 않는다. */
  total_inflow: number;
  total_outflow: number;
  actual_inflow: number;
  actual_outflow: number;
  /** 그 목록에 함께 선 상계 금액 — 합계 밖이라 화면이 따로 적는다. */
  noncash_inflow?: number;
};

export type FinanceCalendarEvent = {
  kind: "receivable" | "payable";
  date: string;
  title: string;
  amount: number;
  currency: string;
  category?: string;
  overdue?: boolean;
  paid?: boolean;
  paid_on?: string;           // 실제 납부일(예정일과 다를 수 있음)
  scheduled?: string;         // actual=true 인 이벤트의 원래 예정일
  actual?: boolean;           // true = 예정일이 아니라 '실제 납부일' 자리에 찍힌 이벤트
  ref_id: number;
  occurrence?: string | null;
  // 이벤트 출처 — "ap"/"ar" = 프로젝트 단계에서 관리하는 청구·수금(읽기전용),
  // "income" = 수동 등록 기타수입, "manual"(기본) = 수동 등록 지급.
  source?: "manual" | "ap" | "ar" | "income";
};

export type DashboardData = {
  kpi: {
    open_rfq: number;
    total_rfq: number;
    active_orders: number;
    monthly_quotes: number;
    ar_outstanding_usd: number;
    ar_outstanding?: Record<StatCurKey, number>;    // 통화별 미수금(대시보드 토글용, KRWC=환산합)
  };
  ops: {
    urgent: number;
    pending_po: number;
    overdue: number;
    expiring: number;
  };
  perf: {
    handling_rate: number;
    quotation_tat_h: number | null;
    hit_rate: number;
    gross_margin_pct: number;
    negotiating_value_usd: number;
  };
  alerts: {
    urgent_quotes: { qtn_no: string; valid_until: string; status: string }[];
    overdue_ar: {
      ci_no: string;
      currency: string;
      outstanding: number;
      due_date: string;
    }[];
  };
  steps: string[];
  stage_distribution: number[];
  recent: {
    rfq_no: string;
    customer: string;
    stage: number;
    status: string;
    at: string;
  }[];
  rfq_steps: string[];
  order_steps: string[];
  snapshot: SnapshotRfq[];
};

export type SnapshotOrder = {
  customer_vessel: string;
  status: string;
  item_count: number;
  date: string;
  step: number;
};

export type SnapshotRfq = {
  id: number;
  rfq_no: string;
  customer_rfq_no: string;
  project_title: string;
  customer: string;
  vessel: string;
  customer_vessel: string;
  stage_dates: Record<string, string>;
  stage_auto: Record<string, string>;
  status: string;
  item_count: number;
  follow_up_level: string;
  date: string;
  step: number;
  stage: number;
  order: SnapshotOrder | null;
};

/** 통합 파이프라인 1행 = 거래(RFQ) 1건. RFQ→Quote(1~4) + Order→Vendor PO(5~6) 체인. */
export type PipelineRow = {
  rfq_id: number;
  order_id: number;
  customer_rfq_no: string;
  kmaris_rfq_no: string;
  work_type: string;
  trade_type: string;
  customer: string;
  customer_id: number;
  contact_person?: string; // 고객사 담당자(연락 담당)
  vessel: string;
  vessel_id: number;
  project_title: string;
  received_at: string;
  first_rfq_at: string;
  project_no: string;
  assignee: string; // 담당자(PIC) = created_by username
  assignee_id: number; // 담당자(PIC) = created_by user id (0 = 미지정)
  item_count: number;
  first_item: string; // 첫 품목명(사이드바 "(첫 품목) 외 N unit" 표기용)
  crfq_at: string;
  vrfq_vendors: string;
  vrfq_at: string;
  vquote_no: string;
  vquote_at: string;
  vendor_amount: string;
  cquote_no: string;
  cquote_at: string;
  customer_amount: string;
  sales_total: string;        // 프로젝트 수주 합산(오더 여러 건). 없으면 견적금액
  purchase_total: string;     // 프로젝트 발주 합산. 없으면 벤더 견적금액
  margin_amount: string;      // 마진(수주−발주 합산) 이중통화 문자열. 없으면 ""
  margin_pct: number | null;  // 마진율(%). 계산 불가 시 null
  vessels: string;            // 오더별 선박 목록(줄바꿈). 단일이면 1개
  customer_po_nos: string;    // 고객 P/O No. 목록(줄바꿈)
  order_amount: string;
  customer_po_no: string;
  customer_po_at: string;
  vendor_po_no: string;
  vendor_po_at: string;
  vendor: string;
  vendor_email: string;
  // RFQ 발송 벤더 + 상태. quoted=견적 수신, declined=견적 불가 통보(수동 표시).
  // 표시 규칙: 견적 수신=선명, 대기=회색, (견적불가 통보 || 견적단계 넘긴 미수신)=취소선.
  rfq_vendors?: { name: string; quoted: boolean; declined?: boolean; contact?: string }[];
  // RFQ 발송 이력 — 벤더 RFQ 1건 = 발송 1건(중복제거 없음). 업무일지에서 발송별 별도 행 표시.
  rfq_sends?: { id: number; vendor: string; sent_at: string }[];
  // 견적 수신 이력 — 벤더 견적 1건 = 수신 1건. 견적을 실제로 준 벤더는 이 목록이 근거다
  // (RFQ 를 보낸 벤더 전체가 아니다). 3단계 활동을 수신별 별도 행으로 표시.
  quote_receipts?: { id: number; vendor: string; received_at: string; quote_no?: string }[];
  stage: number;
  status: string;
  cancelled?: boolean;            // 종결(취소/실주) — 보드 Cancelled 존 분류
  close_reason?: string;          // 종결 사유 코드(schedule/slow_response/no_quote/other)
  close_reason_note?: string;     // 기타 사유 직접 입력
  closed_at?: string;             // 종결 일시 "YYYY-MM-DDTHH:MM"
  stage_dates: Record<string, string>;
  stage_auto: Record<string, string>;
  stage_notes: Record<string, StageNote[]>;
  next_action?: string;           // 다음 액션 권고(P3)
  next_level?: "normal" | "warn" | "urgent";  // 긴급도
};

export type StageNote = {
  text: string;
  at: string;
  datetime?: string; // 활동 일시 "YYYY-MM-DDTHH:MM"
  party?: string; // 소통 상대(회사): 고객사명 / 벤더사명 / 기타
  person?: string; // 소통 상대 담당자: 고객사 담당자 / 벤더사 담당자 / 기타
  channel?: string; // 이메일 / 통화 / 문자 / 방문 / 기타
  direction?: "in" | "out" | ""; // in=수신(Received) / out=발신(Sent) / 빈값=해당없음
  star?: boolean; // ★ 우선(회의/후속 표시)
  pic?: string; // 담당자(작성자) username
  // 사람이 아니라 시스템이 남긴 줄이라는 표식 — close(종결) / reopen(재활성) / claim(클레임·CN).
  // 화면이 같은 사건을 두 번 그리지 않게 알아보는 데 쓴다(buildActivities).
  system?: string;
};

export type PipelineData = {
  steps: string[];
  rows: PipelineRow[];
};

export type RfqItem = {
  part_no: string;
  description: string;
  type?: string;
  serial_no?: string;
  qty: number;
  unit: string;
  unit_price: number | null;
  amount: number | null;
  remark?: string;
  /** 품목 분류(선택). 저장 시 품목 마스터 분류로 반영된다. */
  category_id?: number | null;
  /** 용역이 닿은 선박 계통(선택). 건마다 달라 품목 마스터로는 올리지 않고 라인에만 남는다. */
  applied_to?: number | null;
};

export type RfqStep = {
  no: number;
  name: string;
  state: "done" | "current" | "todo";
};

// Auto-fill 로 업로드·추출한 소스 파일 메타(RFQ에 영구 보관).
export type RfqSourceFile = {
  name: string;
  media_type?: string;
  item_count: number;
  at?: string;
};

export type RfqDetail = {
  id: number;
  rfq_no: string;
  assignee_id: number; // 담당자(PIC) = RFQ.created_by (0 = 미지정)
  assignee?: string;   // 담당자(PIC) username(비활성/삭제 시 빈값)
  customer_rfq_no: string;
  project_no: string;
  first_rfq_at: string;
  customer: string;
  customer_id: number;
  contact_person: string;
  customer_contact: string;
  customer_email: string;
  vessel: string;
  vessel_id: number;
  project_title: string;
  work_type: string;
  received_at: string;
  date: string;
  notes: string;
  request_channel: string;
  /** 소개자(컨설턴트) — 0 = 없음. 이름도 함께 온다(지워진 소개자를 건 옛 딜 대비). */
  consultant_id: number;
  consultant: string;
  /** 이 딜만의 수수료율(%). null = 컨설턴트 기본율을 따른다. */
  consultant_rate: number | null;
  follow_up_level: string;
  stage: number;
  status: string;
  steps: RfqStep[];
  items: RfqItem[];
  source_files: RfqSourceFile[];
  vendor_rfqs: { id: number; vendor: string; at: string }[];
  vendor_quotes: { vendor_quote_no: string; amount: string; at: string }[];
  quotation: { qtn_no: string; amount: string; status: string; at: string } | null;
};

// ── 목록 행 클릭 상세(수정·삭제)용 단건 상세 타입 ───────────────────────────
export type VendorRfqDetail = {
  id: number;
  rfq_id: number | null;
  assignee_id: number; // 담당자(PIC) = RFQ.created_by (0 = 미지정)
  customer_rfq_no: string;
  kmaris_rfq_no: string;
  project_no: string;
  first_rfq_at: string;
  customer: string;
  customer_contact: string;
  customer_email: string;
  vessel: string;
  project_title: string;
  work_type: string;
  received_at: string;
  vendor_id: number;
  vendor: string;
  vendor_email: string;
  sent_date: string;
  sent_at: string;
  status: string;
  quote_count: number;
  items: RfqItem[];
  project_vendor_rfqs: {
    id: number;
    vendor: string;
    vendor_email: string;
    sent_at: string;
    status: string;
    quote_count: number;
    current: boolean;
  }[];
};

export type VendorQuoteDetail = {
  id: number;
  vendor_quote_no: string;
  vendor_rfq_id: number;
  rfq_id: number | null;
  assignee_id: number; // 담당자(PIC) = RFQ.created_by (0 = 미지정)
  customer_rfq_no: string;
  project_no: string;
  first_rfq_at: string;
  customer: string;
  vessel: string;
  work_type: string;
  project_title: string;
  vendor: string;
  received_date: string;
  received_at: string;
  notes: string;
  currency: string;
  fx_rate?: number | null; // 적용 환율(1 USD = ? KRW). 매매기준율/직접입력
  items: VendorQuoteItem[];
  terms: QuotationTerms;
  source_files: RfqSourceFile[]; // Auto-fill 소스 파일 메타(영구 보관)
  default_payment_terms?: string; // 벤더 정보에 등록된 기본 결제조건
};

export type CustomerQuotationDetail = {
  id: number;
  qtn_no: string;
  rfq_id: number | null;
  // 원가 출처로 선택한 벤더 견적. 편집기 "Select Vendor quote" 드롭다운 시드용.
  vendor_quote_id?: number | null;
  vendor_quote_no?: string; // 위 링크가 가리키는 벤더 견적번호(미링크면 "")
  assignee_id: number; // 담당자(PIC) = RFQ.created_by (0 = 미지정)
  rfq_no: string;
  project_no: string;
  first_rfq_at: string;
  customer: string;
  vessel: string;
  work_type: string;
  project_title: string;
  currency: string;
  cost_currency?: string;
  round_digits?: number;
  margin_pct?: number | null; // Pricing 밴드 기본 마진(%). 저장 전 옛 견적은 null
  discount_pct?: number;
  fx_rate?: number | null; // 적용 환율(1 USD = ? KRW). 매매기준율/직접입력
  amount: number;
  valid_until: string;
  sent_at: string;
  status: string;
  level: string;
  sent_date: string;
  date: string;
  terms: QuotationTerms;
  items: CustomerQuoteItem[];
  default_payment_terms?: string; // 고객 정보에 등록된 기본 결제조건
};

export type PurchaseOrderDetail = {
  id: number;
  po_no: string;
  order_id: number;
  assignee_id: number; // 담당자(PIC) = RFQ.created_by (0 = 미지정)
  customer_po_no: string;
  project_no: string;
  first_rfq_at: string;
  customer: string;
  vessel: string;
  work_type: string;
  trade_type: string;
  project_title: string;
  vendor_id: number;
  vendor: string;
  vendor_email: string;
  date: string;
  sent_date: string;
  status: string;
  sent: boolean;
  currency: string;
  items: PoWorkItem[];
  terms?: QuotationTerms;
  source_files: RfqSourceFile[]; // Auto-fill 소스 파일 메타(영구 보관)
};

// ── 마케팅 활동(잠정 고객사) ──────────────────────────────────────────────────
export type MarketingRow = {
  id: number;
  customer_id: number | null;
  customer: string;        // 대상 표기명(연결 고객사 또는 잠정사)
  prospect_name: string;
  is_prospect: boolean;    // 미등록 잠정사 여부
  contact_person: string;  // 고객사 담당자
  recipient_email: string; // 고객 수신 이메일 주소
  activity_date: string;
  channel: string;
  activity_type: string;
  subject: string;
  notes: string;
  next_action_date: string;
  owner_id: number;
  owner: string;
};

// ── 일정(Schedule) ────────────────────────────────────────────────────────────
export type ScheduleRow = {
  id: number;
  date: string;
  title: string;
  event_type: string;
  notes: string;
  customer_id: number | null;
  customer: string;
  owner_id: number;
  owner: string;
};

// ── 전역 검색 ─────────────────────────────────────────────────────────────────
export type SearchResult = {
  rfq_id: number;
  order_id: number;
  project_no: string;
  customer: string;
  vessel: string;
  project_title: string;
  status: string;
  stage: number;
  matched_label: string; // 매칭된 필드 분류(예: "Item", "Vendor PO No.")
  matched_text: string;  // 매칭된 원본 텍스트(스니펫)
  href: string;          // 클릭 시 이동할 화면 경로
};
export type SearchData = { results: SearchResult[]; query: string };

// ── 통계 대시보드 ─────────────────────────────────────────────────────────────
export type CurrencyKey = "USD" | "KRW";
// 통계 탭의 통화 버킷 — 원통화 둘에 "KRWC"(USD를 매매기준율로 환산해 KRW와 합산한 값)를
// 더한 것. 문서의 통화(CurrencyKey)와는 다른 개념이라 타입을 따로 둔다 — KRWC 로 저장되는
// 문서는 없고, 오직 화면에서 합쳐 보기 위한 키다.
export type StatCurKey = CurrencyKey | "KRWC";
export type StatSeries = Record<StatCurKey, number[]>;
export type StatCustomerTop = Record<StatCurKey, { name: string; amount: number }[]>;
export type StatItemTop = Record<StatCurKey, { part_no: string; description: string; amount: number }[]>;
export type StatKpiCur = {
  revenue: number; revenue_prev: number;
  order: number; order_prev: number;
  quote: number; quote_prev: number;
};
export type StatAlertRow = {
  order_id?: number;
  rfq_id?: number | null;
  ci_no?: string;
  po_no?: string;
  qtn_no?: string;
  project_no?: string;
  customer: string;
  date?: string;
  status?: string;
  currency?: CurrencyKey;
  outstanding?: number;
};
export type StatRfqDetailRow = { rfq_no: string; customer: string; work_type: string };
export type StatFunnel = {
  rfq: number; quote: number; order: number; revenue: number;
  quote_rate: number; order_rate: number; revenue_rate: number;
};
export type StatProjectMargin = {
  project_no: string; project_title: string; customer: string; stage: string;   // Quoted | PO | Invoiced
  sales_usd: number; purchase_usd: number; margin_usd: number; margin_pct: number;
};
export type StatisticsData = {
  months: string[];                    // 그래프 가로축 = 올해 1~12월
  current_month?: string;              // 이번 달("YYYY-MM") — KPI 스트립의 기본·최대 월
  currencies: StatCurKey[];
  series: { revenue: StatSeries; quote: StatSeries; order: StatSeries };
  rfq_count: number[];                 // 월간 RFQ 수신 건수(months 순서)
  rfq_detail: StatRfqDetailRow[][];    // 월별 RFQ 상세(호버용, months 순서)
  funnel: StatFunnel;                  // RFQ→Quote→PO→Revenue 전환
  project_margin: StatProjectMargin[]; // 프로젝트별 마진(USD 환산)
  usd_krw_rate: number;                // 마진 KRW 환산용 고정환율
  fx?: { rate: number; date: string; source: "exim" | "fixed" };  // KRW 환산에 쓴 매매기준율
  customer_top: StatCustomerTop;
  item_top: StatItemTop;
  kpi: Record<StatCurKey, StatKpiCur>;
  delivery_delays: number;
  alerts: {
    today_delivery: StatAlertRow[];
    week_delivery: StatAlertRow[];
    unanswered_quotes: StatAlertRow[];
    unreceived_po: StatAlertRow[];
    uninvoiced: StatAlertRow[];
    long_overdue_ar: StatAlertRow[];
  };
};

// 금액 KPI 감사(statistics-debug) — Orders Won/Quoted/Revenue 행 단위 내역.
export type StatDebugSection<Row> = { rows: Row[]; total: Record<CurrencyKey, number> };
export type StatDebugWonRow = {
  ref: string; customer: string; date: string;
  bucket: CurrencyKey; amount: number; source: string; suspect: boolean;
};
export type StatDebugQuoteRow = {
  ref: string; bucket: CurrencyKey; raw_currency: string | null; amount: number;
};
export type StatDebugRevRow = {
  ref: string; issue_month: string; bucket: CurrencyKey; amount: number; counted: boolean;
};
export type StatDebugData = {
  month: string;
  orders_won: StatDebugSection<StatDebugWonRow>;
  quoted: StatDebugSection<StatDebugQuoteRow>;
  revenue: StatDebugSection<StatDebugRevRow>;
};

export type MarketingOverview = {
  recent: MarketingRow[];
  follow_ups: MarketingRow[];
  month: {
    period: string;
    total: number;
    by_channel: Record<string, number>;
    by_type: Record<string, number>;
  };
};

// ── 프로젝트 메일 이력(회사 메일함 IMAP 동기화) ───────────────────────────────
// 한 통 = MailMessage, 한 대화 = MailThread. summary 는 Claude 가 만든 한두 줄이고,
// 비어 있으면 아직 만들지 않은 것(화면에서 열면 서버가 채운다).
export type MailAttachment = { name: string; size: number };
export type MailMessage = {
  id: number;
  direction: "in" | "out";      // in = 수신, out = 발신
  sent_at: string;              // "YYYY-MM-DDTHH:MM" (KST)
  subject: string;
  from_addr: string;
  from_name: string;
  to_addrs: string[];
  cc_addrs: string[];
  party: string;                // 상대 회사명(등록된 고객·벤더면 이름, 아니면 주소)
  party_kind: "customer" | "vendor" | "";
  summary: string;
  body_text: string;
  truncated: boolean;
  attachments: MailAttachment[];
  match_by: string;             // thread | docno | subject | manual — 이 딜에 붙은 근거
  thread_key: string;
  rfq_id: number | null;
};
export type MailThread = {
  thread_key: string;
  subject: string;
  party: string;
  party_kind: "customer" | "vendor" | "";
  first_at: string;
  last_at: string;
  count: number;
  messages: MailMessage[];
};
export type ProjectMail = {
  rfq_id: number;
  count: number;
  // 한 문의에서 갈라진 형제 딜 — 이 목록의 딜과 메일 이력을 함께 본다(비면 혼자).
  shared_with?: { rfq_id: number; no: string }[];
  threads: MailThread[];
  rollup: string;         // 딜 전체 흐름 요약(3~5줄). 빈 문자열 = 아직 만들지 않음
  rollup_stale: boolean;  // 요약을 만든 뒤 새 메일이 왔다
};
// 대시보드 Mail 탭 — 프로젝트 하나가 카드 하나. 프로젝트 이름·단계·담당자는 여기
// 없다(화면이 이미 갖고 있는 pipeline 목록과 rfq_id 로 맞춘다). 서버는 본문을 싣지
// 않고 요약만 보낸다.
export type MailDigestLine = {
  sent_at: string;
  direction: "in" | "out";
  party: string;
  summary: string;
};
export type MailDigestRow = {
  rfq_id: number;
  count: number;              // 이 딜의 전체 메일 통수
  recent_count: number;       // 그중 조회 기간(days) 안의 통수
  parties: string[];          // 최근 등장 순 상대(최대 4)
  last_at: string;
  last_dir: "in" | "out";
  waiting_days: number;       // 마지막이 수신인 채 지난 날수(0 = 공이 상대에게)
  rollup: string;             // 저장된 AI 요약. 빈 문자열 = 아직 만든 적 없음
  rollup_stale: boolean;      // 요약을 만든 뒤 새 메일이 왔다(요약은 그대로 보여준다)
  new_since: number;          // 그 요약 뒤로 들어온 메일 수
  recent: MailDigestLine[];   // 최근 메일 몇 통(최신이 위)
  // 이 카드가 메일을 함께 보는 형제 딜의 rfq_id(같은 문의에서 갈라진 것). 비면 혼자.
  shared_with?: number[];
};
// 날짜별로 훑는 메일 한 줄 — 업무일지 주간 캘린더용. 본문·제목·첨부는 실리지 않는다.
export type MailDateRow = MailDigestLine & { id: number; rfq_id: number };
export type MailDigest = {
  days: number;
  waiting_after: number;      // 이 날수 이상 쥐고 있으면 "우리 차례"로 올린다
  rows: MailDigestRow[];
  unmatched: number;          // 어느 딜에도 안 붙은 메일 — 카드에 안 잡힌 것들
  // rfq_id(문자열) → 그 딜의 전체 메일 통수. rows 에 못 실린 딜까지 전부 담는다 —
  // 화면이 "메일이 아예 없는 딜"과 "이번 응답에 안 실린 딜"을 혼동하지 않게.
  has_mail: Record<string, number>;
};
export type MailStatus = {
  configured: boolean;
  host: string;
  account: string;
  total: number;
  unmatched: number;
  unknown: number;              // 등록되지 않은 상대 수 — 그만큼의 메일이 버려지고 있다
  auto: {
    enabled: boolean;
    at: string;                 // "06:00" (KST)
    next_run: string;
    last_run_at: string;
    last_result: Record<string, number | string>;
    running_since: string;      // 지금 돌고 있으면 시작 시각, 아니면 빈 문자열
  };
  // 사람이 누른 Sync. 자동 실행과 하는 일이 달라(카드 요약을 만들지 않는다) 따로 남긴다.
  manual: {
    last_at: string;
    last_result: Record<string, number | string>;
  };
  folders: { folder: string; last_uid: number; last_synced_at: string; last_error: string }[];
};
// 메일은 오갔지만 Settings 에 없는 상대. 저장 범위를 등록된 거래처로 좁힌 대가라,
// 이 목록이 곧 "대시보드가 놓치고 있는 것"이다.
export type MailUnknownAddr = {
  addr: string;
  count: number;
  last_at: string;
  name: string;                 // 메일 표시 이름(있으면)
  subject: string;              // 가장 최근 제목 한 줄
};
// 딜에 직접 붙여 둔 주소 — 거래처로 등록하지 않고도 그 주소의 메일을 이 딜로 담는다.
// (검사관·선주 대리인처럼 한 딜에서만 만나는 상대를 위한 길.)
export type MailAddrLink = {
  addr: string;
  name: string;
  rfq_id: number;
  project_no: string;
  linked_at: string;
  stored: number;               // 붙인 뒤로 실제 담긴 통수(0 이면 아직 안 들어왔다)
};
// 미등록 주소를 고객·벤더로 올린 결과. created=false 면 이미 있던 레코드에 주소만 더한 것.
export type MailRegisterResult = {
  ok: boolean;
  created: boolean;
  kind: "customer" | "vendor";
  party: { id: number; name: string };
  fetched: { scanned: number; stored: number; dup: number; skipped: number };
  spread: number;
  warn: string;
  rows: MailUnknownAddr[];
  links: MailAddrLink[];
};
export type MailAttachResult = {
  ok: boolean;
  adopted: number;              // 이미 담겨 있던 미분류 메일 중 이 딜로 옮긴 통수
  fetched: { scanned: number; stored: number; dup: number; skipped: number };
  spread: number;               // 그 메일이 근거가 되어 따라 붙은 통수
  warn: string;
  rows: MailUnknownAddr[];
  links: MailAddrLink[];
};
// 미분류 메일은 '대화' 단위로 다룬다 — 한 번 고르면 그 대화 전체가 같은 딜로 간다.
// suggest 는 서버가 매긴 추천(제목 겹침·거래처·시기)일 뿐, 붙지는 않은 상태다.
export type MailSuggest = { rfq_id: number; why: string };
export type UnmatchedMailGroup = {
  key: string;
  subject: string;              // 답장 표시(RE:/回复:)를 걷어낸 제목
  parties: string[];            // 이 대화에 나온 상대(최근 순, 최대 3)
  party_kind: "customer" | "vendor" | "";
  first_at: string;
  last_at: string;
  count: number;
  ids: number[];
  messages: MailMessage[];
  suggest: MailSuggest | null;
};
// 자동 배정 결과 — 근거별 건수. thread=같은 대화, docno=문서번호, subject=같은 제목.
export type MailAutoMatchResult = {
  ok: boolean;
  thread: number;
  docno: number;
  subject: number;
  total: number;
  unmatched: number;   // 아직 남은 미분류 통수
};
export type MailSyncResult = {
  ok: boolean;
  scanned: number;   // 메일함에서 훑은 통수(저장 여부와 무관)
  stored: number;
  skipped: number;   // 등록된 거래처와 무관해 담지 않은 것
  dup: number;
  pending: number;   // 기간 안에 아직 안 읽은 이전 메일(Sync 를 더 누르면 이어 읽는다)
  summarized?: number;
  auto_matched?: number;  // 동기화 직후 자동으로 딜에 붙은 통수
  folders: Record<
    string,
    { scanned?: number; stored?: number; skipped?: number; dup?: number; pending?: number; error?: string }
  >;
};
