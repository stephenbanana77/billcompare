BEGIN;

CREATE TABLE IF NOT EXISTS reconciliation_confirmed_bills (
  id uuid PRIMARY KEY,
  version integer NOT NULL,
  status varchar(24) NOT NULL,
  source_file_name varchar(255) NOT NULL,
  mall_name varchar(120) NOT NULL,
  store_name varchar(120) NOT NULL,
  store_code varchar(60) NOT NULL,
  period_start varchar(10) NOT NULL,
  period_end varchar(10) NOT NULL,
  bill_type varchar(40) NOT NULL,
  settlement_no varchar(120),
  sales_amount numeric(16,2) NOT NULL,
  invoice_amount numeric(16,2),
  deduction_total numeric(16,2),
  settlement_amount numeric(16,2) NOT NULL,
  ocr_verified boolean NOT NULL DEFAULT false,
  reviewed_fields jsonb NOT NULL,
  extraction_payload jsonb NOT NULL,
  confirmed_by varchar(120) NOT NULL,
  confirmed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_reconciliation_confirmed_bills_version
    UNIQUE (store_code, period_start, period_end, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_confirmed_bill_active_period
  ON reconciliation_confirmed_bills(store_code, period_start, period_end)
  WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS idx_confirmed_bill_query
  ON reconciliation_confirmed_bills(store_code, period_start, period_end, status);

CREATE TABLE IF NOT EXISTS reconciliation_confirmed_sales_lines (
  id uuid PRIMARY KEY,
  bill_id uuid NOT NULL REFERENCES reconciliation_confirmed_bills(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  label varchar(255) NOT NULL,
  row_type varchar(24) NOT NULL,
  "values" jsonb NOT NULL,
  raw_text text,
  source_page integer,
  confidence numeric(5,4)
);

CREATE INDEX IF NOT EXISTS idx_confirmed_sales_bill
  ON reconciliation_confirmed_sales_lines(bill_id, sequence);

CREATE TABLE IF NOT EXISTS reconciliation_confirmed_fee_lines (
  id uuid PRIMARY KEY,
  bill_id uuid NOT NULL REFERENCES reconciliation_confirmed_bills(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  label varchar(255) NOT NULL,
  row_type varchar(24) NOT NULL,
  "values" jsonb NOT NULL,
  raw_text text,
  source_page integer,
  confidence numeric(5,4)
);

CREATE INDEX IF NOT EXISTS idx_confirmed_fee_bill
  ON reconciliation_confirmed_fee_lines(bill_id, sequence);

COMMIT;
