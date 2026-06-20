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

export type VendorOption = { id: number; name: string; email: string };

export type DashboardData = {
  kpi: {
    open_rfq: number;
    total_rfq: number;
    active_orders: number;
    monthly_quotes: number;
    ar_outstanding_usd: number;
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
