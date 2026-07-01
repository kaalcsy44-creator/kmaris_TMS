export type RfqRow = {
  id: number;
  customer_rfq_no: string;
  project_title: string;
  contact_person?: string;
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

export type CustomerOption = { id: number; name: string; contact?: string; logo?: string };

export type SettingsCustomer = {
  id: number;
  name: string;
  contact: string;
  contact_phone: string;
  email: string;
  country: string;
  address: string;
  tax_id: string;
  logo: string;
};
export type SettingsVendor = {
  id: number;
  name: string;
  contact: string;
  contact_phone: string;
  email: string;
  specialization: string;
  country: string;
  address: string;
  logo: string;
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
  address: string;
  business_no: string;
  phone: string;
  general_email: string;
  sales_email: string;
  tax_email: string;
  website: string;
  bank_name: string;
  bank_account: string;
  bank_holder: string;
  swift: string;
  tagline: string;
};

export type VendorOption = { id: number; name: string; email: string; logo?: string };

export type PoRow = {
  id: number;
  customer_rfq_no: string;
  crfq_at: string;
  kmaris_rfq_no: string;
  vrfq_at: string;
  customer: string;
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
  maker?: string;
  qty: number;
  unit: string;
  unit_price: number | null;
  amount: number | null;
  remark?: string;
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
    maker?: string;
    qty?: number;
    unit?: string;
    lead_time_req?: string;
    remark?: string;
  }[];
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
    items: PoWorkItem[];
  }[];
  orders: {
    id: number;
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
  subject: string;
  body: string;
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
  qty: number;
  unit: string;
  cost_price: number | null;
  margin_pct: number | null;
  unit_price: number | null;
  amount: number | null;
  remark?: string;
};

export type QuotationTerms = {
  incoterms?: string;
  payment_terms?: string;
  delivery_place?: string;
  shipment_method?: string;
  packing?: string;
  warranty?: string;
  remarks?: string;
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
  level?: string;
  status?: string;
  vessel: string;
  work_type: string;
  first_rfq_at: string;
  project_no: string;
};

export type VendorQuoteForImport = {
  id: number;
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
  vendor: string;
  vendor_email: string;
  sent_date: string;
  status: string;
  item_count: number;
  quote_count: number;
  customer: string;
  project_title?: string;
  contact_person?: string;
  level?: string;
  vessel: string;
  work_type: string;
  first_rfq_at: string;
  project_no: string;
};

export type DocRow = {
  id: number;
  customer: string;
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
  svc_arr_done: boolean;
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
  net_weight?: string | number;
  gross_weight?: string | number;
  dimension?: string;
};

export type DocumentDetail = {
  order: {
    id: number;
    rfq_id: number;
    assignee_id: number; // 담당자(PIC) = RFQ.created_by (0 = 미지정)
    po_no: string;
    date: string;
    status: string;
    customer: string;
    customer_email: string;
    customer_tax_id: string;
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
    items: DocumentWorkItem[];
  };
  pod: null | { id: number; filename: string; uploaded_at: string };
  stage_done: { "7": boolean; "8": boolean; "9": boolean; "11": boolean; "12": boolean };
  ci: null | {
    id: number;
    ci_no: string;
    date: string;
    currency: string;
    vat_rate: number;
    items: DocumentWorkItem[];
    shipping: Record<string, string>;
    missing: { part_no: string; description: string; order_qty: number; doc_qty: number }[];
  };
  pl: null | {
    id: number;
    pl_no: string;
    date: string;
    items: DocumentWorkItem[];
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
  ci_no: string;
  customer: string;
  currency: string;
  invoice_amount: number;
  paid_amount: number;
  outstanding: number;
  due_date: string;
  status: string;
  overdue: boolean;
  notes: string;
  tax_issued: boolean;
  tax_issued_date: string;
  paid_done: boolean;
  paid_date: string;
  vessel: string;
  work_type: string;
  trade_type: string;
  vendor: string;
  first_rfq_at: string;
  project_no: string;
};

export type ArData = {
  kpi: { outstanding_usd: number; overdue_usd: number; count: number };
  rows: ArRow[];
};

export type DashboardData = {
  kpi: {
    open_rfq: number;
    total_rfq: number;
    active_orders: number;
    monthly_quotes: number;
    ar_outstanding_usd: number;
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
  vessel: string;
  vessel_id: number;
  project_title: string;
  received_at: string;
  first_rfq_at: string;
  project_no: string;
  assignee: string; // 담당자(PIC) = created_by username
  assignee_id: number; // 담당자(PIC) = created_by user id (0 = 미지정)
  item_count: number;
  crfq_at: string;
  vrfq_vendors: string;
  vrfq_at: string;
  vquote_no: string;
  vquote_at: string;
  vendor_amount: string;
  cquote_no: string;
  cquote_at: string;
  customer_amount: string;
  customer_po_no: string;
  customer_po_at: string;
  vendor_po_no: string;
  vendor_po_at: string;
  vendor: string;
  vendor_email: string;
  stage: number;
  status: string;
  stage_dates: Record<string, string>;
  stage_auto: Record<string, string>;
  stage_notes: Record<string, StageNote[]>;
};

export type StageNote = {
  text: string;
  at: string;
  datetime?: string; // 활동 일시 "YYYY-MM-DDTHH:MM"
  party?: string; // Customer / Vendor / 기타
  channel?: string; // 이메일 / 통화 / 문자 / 방문 / 기타
};

export type PipelineData = {
  steps: string[];
  rows: PipelineRow[];
};

export type RfqItem = {
  part_no: string;
  description: string;
  qty: number;
  unit: string;
  unit_price: number | null;
  amount: number | null;
  remark?: string;
};

export type RfqStep = {
  no: number;
  name: string;
  state: "done" | "current" | "todo";
};

export type RfqDetail = {
  id: number;
  rfq_no: string;
  assignee_id: number; // 담당자(PIC) = RFQ.created_by (0 = 미지정)
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
  follow_up_level: string;
  stage: number;
  status: string;
  steps: RfqStep[];
  items: RfqItem[];
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
  items: VendorQuoteItem[];
  terms: QuotationTerms;
};

export type CustomerQuotationDetail = {
  id: number;
  qtn_no: string;
  rfq_id: number | null;
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
  discount_pct?: number;
  amount: number;
  valid_until: string;
  sent_at: string;
  status: string;
  level: string;
  sent_date: string;
  date: string;
  terms: QuotationTerms;
  items: CustomerQuoteItem[];
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
};
