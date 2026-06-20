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
