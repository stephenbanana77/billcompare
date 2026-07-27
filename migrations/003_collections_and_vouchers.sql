BEGIN;

CREATE TABLE IF NOT EXISTS reconciliation_collections (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES reconciliation_jobs(id) ON DELETE CASCADE,
  expected_amount numeric(16, 2) NOT NULL,
  due_date varchar(10),
  received_amount numeric(16, 2) NOT NULL DEFAULT 0,
  difference_amount numeric(16, 2) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'pending',
  last_receipt_at varchar(10),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reconciliation_receipts (
  id uuid PRIMARY KEY,
  collection_id uuid NOT NULL REFERENCES reconciliation_collections(id) ON DELETE CASCADE,
  source_file_name varchar(255) NOT NULL,
  bank_reference varchar(120) NOT NULL,
  payer_name varchar(160) NOT NULL,
  payment_date varchar(10) NOT NULL,
  amount numeric(16, 2) NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reconciliation_vouchers (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES reconciliation_jobs(id) ON DELETE CASCADE,
  collection_id uuid NOT NULL UNIQUE REFERENCES reconciliation_collections(id) ON DELETE CASCADE,
  voucher_no varchar(60) NOT NULL UNIQUE,
  status varchar(24) NOT NULL DEFAULT 'draft',
  voucher_date varchar(10) NOT NULL,
  summary varchar(255) NOT NULL,
  total_amount numeric(16, 2) NOT NULL,
  debit_account varchar(120) NOT NULL,
  credit_account varchar(120) NOT NULL,
  lines jsonb NOT NULL,
  confirmed_by varchar(120),
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_receipts_collection_id
  ON reconciliation_receipts(collection_id);

CREATE INDEX IF NOT EXISTS idx_reconciliation_receipts_payment_date
  ON reconciliation_receipts(payment_date);

COMMIT;
