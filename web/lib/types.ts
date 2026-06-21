export type RfqRow = {
  id: number;
  customer_rfq_no: string;
  customer: string;
  vessel: string;
  item_count: number;
  crfq_no: string;
  crfq_at: string;
  vrfq_no: string;
  vrfq_at: string;
  vquote_no: string;
  vquote_at: string;
  vendor_amount: string;
  cquote_no: string;
  cquote_at: string;
  customer_amount: string;
  stage: number;
  status: string;
};

export type RfqOverview = {
  steps: string[];
  rows: RfqRow[];
};

export type CustomerOption = { id: number; name: string };

export type SettingsCustomer = {
  id: number;
  name: string;
  contact: string;
  email: string;
  country: string;
};
export type SettingsVendor = {
  id: number;
  name: string;
  contact: string;
  email: string;
  specialization: string;
};
export type SettingsVessel = {
  id: number;
  name: string;
  imo: string;
  customer: string;
};

export type VendorOption = { id: number; name: string; email: string };

export type PoRow = {
  id: number;
  customer_rfq_no: string;
  customer: string;
  vessel: string;
  customer_po_no: string;
  customer_po_at: string;
  ord_no: string;
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
  ord_no: string;
  customer_po_no: string;
  customer_po_at: string;
  rfq_no: string;
  customer_rfq_no: string;
  quotation_no: string;
  customer: string;
  customer_contact: string;
  customer_email: string;
  vessel: string;
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
};

export type RfqOcrResult = {
  vessel_name?: string | null;
  rfq_date?: string | null;
  customer_rfq_no?: string | null;
  customer_hint?: string | null;
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
    ord_no: string;
    customer_id: number;
    customer: string;
    vessel_id: number | null;
    vessel: string;
    po_no: string;
    date: string;
    status: string;
    items: PoWorkItem[];
  }[];
  purchase_orders: {
    id: number;
    po_no: string;
    order_id: number;
    ord_no: string;
    vendor_id: number;
    vendor: string;
    vendor_email: string;
    date: string;
    sent_date: string;
    status: string;
    sent: boolean;
    items: PoWorkItem[];
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

export type QtnRow = {
  id: number;
  qtn_no: string;
  rfq_no: string;
  customer: string;
  vessel: string;
  currency: string;
  amount: number;
  item_count: number;
  status: string;
  level: string;
  valid_until: string;
  sent_date: string;
  date: string;
  stage: number;
  pipeline: string;
};

export type VrfqRow = {
  id: number;
  vrfq_no: string;
  customer_rfq_no: string;
  vendor: string;
  vendor_email: string;
  sent_date: string;
  status: string;
  item_count: number;
  quote_count: number;
};

export type DocRow = {
  id: number;
  ord_no: string;
  customer: string;
  vessel: string;
  po_no: string;
  ci_no: string;
  pl_no: string;
  sa_no: string;
  tax_no: string;
  has_ci: boolean;
  has_pl: boolean;
  has_sa: boolean;
  has_tax: boolean;
};

export type VendorPoRow = {
  id: number;
  po_no: string;
  ord_no: string;
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
  ci_no: string;
  customer: string;
  ord_no: string;
  currency: string;
  invoice_amount: number;
  paid_amount: number;
  outstanding: number;
  due_date: string;
  status: string;
  overdue: boolean;
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
  ord_no: string;
  customer_vessel: string;
  status: string;
  item_count: number;
  date: string;
  step: number;
};

export type SnapshotRfq = {
  rfq_no: string;
  customer_rfq_no: string;
  customer_vessel: string;
  status: string;
  item_count: number;
  follow_up_level: string;
  date: string;
  step: number;
  stage: number;
  order: SnapshotOrder | null;
};

export type RfqItem = {
  part_no: string;
  description: string;
  qty: number;
  unit: string;
  unit_price: number | null;
  amount: number | null;
};

export type RfqStep = {
  no: number;
  name: string;
  state: "done" | "current" | "todo";
};

export type RfqDetail = {
  id: number;
  rfq_no: string;
  customer_rfq_no: string;
  customer: string;
  customer_contact: string;
  customer_email: string;
  vessel: string;
  date: string;
  notes: string;
  stage: number;
  status: string;
  steps: RfqStep[];
  items: RfqItem[];
  vendor_rfqs: { id: number; vrfq_no: string; vendor: string; at: string }[];
  vendor_quotes: { vendor_quote_no: string; amount: string; at: string }[];
  quotation: { qtn_no: string; amount: string; status: string; at: string } | null;
};
