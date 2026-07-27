BEGIN;

ALTER TABLE reconciliation_rules
  ADD COLUMN IF NOT EXISTS store_code varchar(60),
  ADD COLUMN IF NOT EXISTS contract_no varchar(80),
  ADD COLUMN IF NOT EXISTS contract_version varchar(40),
  ADD COLUMN IF NOT EXISTS effective_start varchar(10),
  ADD COLUMN IF NOT EXISTS effective_end varchar(10),
  ADD COLUMN IF NOT EXISTS approval_status varchar(24) NOT NULL DEFAULT 'approved';

ALTER TABLE reconciliation_issues
  ADD COLUMN IF NOT EXISTS resolution_evidence text,
  ADD COLUMN IF NOT EXISTS due_date varchar(10),
  ADD COLUMN IF NOT EXISTS reviewer_name varchar(120),
  ADD COLUMN IF NOT EXISTS review_note text,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

CREATE TABLE IF NOT EXISTS reconciliation_issue_events (
  id uuid PRIMARY KEY,
  issue_id uuid NOT NULL REFERENCES reconciliation_issues(id) ON DELETE CASCADE,
  action varchar(80) NOT NULL,
  from_status varchar(24),
  to_status varchar(24) NOT NULL,
  comment text,
  operator_name varchar(120) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_rules_match
  ON reconciliation_rules(mall_name, store_code, effective_start, effective_end);

CREATE INDEX IF NOT EXISTS idx_reconciliation_issue_events_issue_id
  ON reconciliation_issue_events(issue_id, created_at DESC);

COMMIT;
