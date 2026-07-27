BEGIN;

CREATE TABLE IF NOT EXISTS reconciliation_rules (
  id uuid PRIMARY KEY,
  name varchar(120) NOT NULL,
  mall_name varchar(120),
  bill_type varchar(40) NOT NULL,
  period_type varchar(40) NOT NULL,
  commission_rate numeric(8,4) NOT NULL DEFAULT 0,
  activity_fee numeric(16,2) NOT NULL DEFAULT 0,
  tolerance_amount numeric(16,2) NOT NULL DEFAULT 0.01,
  enabled boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reconciliation_jobs (
  id uuid PRIMARY KEY,
  task_no varchar(40) NOT NULL UNIQUE,
  mall_name varchar(120) NOT NULL,
  store_name varchar(120) NOT NULL,
  store_code varchar(60) NOT NULL,
  period_start varchar(10) NOT NULL,
  period_end varchar(10) NOT NULL,
  status varchar(32) NOT NULL,
  bill_type varchar(40) NOT NULL,
  source_bill_name varchar(255) NOT NULL,
  source_erp_name varchar(255) NOT NULL,
  rule_id uuid REFERENCES reconciliation_rules(id) ON DELETE SET NULL,
  rule_snapshot jsonb NOT NULL,
  bill_snapshot jsonb NOT NULL,
  erp_snapshot jsonb NOT NULL,
  sales_diff numeric(16,2) NOT NULL DEFAULT 0,
  refund_diff numeric(16,2) NOT NULL DEFAULT 0,
  settlement_diff numeric(16,2) NOT NULL DEFAULT 0,
  issue_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_jobs_status ON reconciliation_jobs(status);
CREATE INDEX IF NOT EXISTS idx_reconciliation_jobs_period ON reconciliation_jobs(period_start, period_end);

CREATE TABLE IF NOT EXISTS reconciliation_comparisons (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES reconciliation_jobs(id) ON DELETE CASCADE,
  field_key varchar(60) NOT NULL,
  field_label varchar(80) NOT NULL,
  bill_value numeric(16,2) NOT NULL,
  erp_value numeric(16,2) NOT NULL,
  difference numeric(16,2) NOT NULL,
  result varchar(24) NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order integer NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_comparisons_job ON reconciliation_comparisons(job_id);

CREATE TABLE IF NOT EXISTS reconciliation_issues (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES reconciliation_jobs(id) ON DELETE CASCADE,
  type varchar(60) NOT NULL,
  severity varchar(20) NOT NULL,
  title varchar(160) NOT NULL,
  description text NOT NULL,
  difference_amount numeric(16,2) NOT NULL DEFAULT 0,
  status varchar(24) NOT NULL,
  suggested_action text NOT NULL,
  resolution_note text,
  assigned_to varchar(120),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_issues_job ON reconciliation_issues(job_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_issues_status ON reconciliation_issues(status);

CREATE TABLE IF NOT EXISTS reconciliation_audit_logs (
  id uuid PRIMARY KEY,
  job_id uuid REFERENCES reconciliation_jobs(id) ON DELETE CASCADE,
  action varchar(80) NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  operator_name varchar(120) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_audit_job ON reconciliation_audit_logs(job_id, created_at DESC);

COMMIT;
