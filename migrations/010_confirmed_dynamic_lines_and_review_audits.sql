BEGIN;

CREATE TABLE IF NOT EXISTS reconciliation_confirmed_dynamic_lines (
  id uuid PRIMARY KEY,
  bill_id uuid NOT NULL REFERENCES reconciliation_confirmed_bills(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  section varchar(255) NOT NULL,
  label varchar(255) NOT NULL,
  row_type varchar(24) NOT NULL,
  "values" jsonb NOT NULL,
  raw_text text,
  source_page integer,
  confidence numeric(5,4),
  CONSTRAINT uq_confirmed_dynamic_bill_sequence UNIQUE (bill_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_confirmed_dynamic_bill
  ON reconciliation_confirmed_dynamic_lines(bill_id, sequence);

CREATE INDEX IF NOT EXISTS idx_confirmed_dynamic_section
  ON reconciliation_confirmed_dynamic_lines(bill_id, section);

CREATE TABLE IF NOT EXISTS reconciliation_confirmed_review_audits (
  id uuid PRIMARY KEY,
  bill_id uuid NOT NULL UNIQUE REFERENCES reconciliation_confirmed_bills(id) ON DELETE CASCADE,
  issue_count integer NOT NULL,
  issues jsonb NOT NULL,
  manual_edit_count integer NOT NULL,
  manual_edits jsonb NOT NULL,
  acknowledgement_required boolean NOT NULL,
  acknowledged_by_client boolean NOT NULL,
  acknowledgement_note text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_confirmed_review_audit_bill
  ON reconciliation_confirmed_review_audits(bill_id);

CREATE INDEX IF NOT EXISTS idx_confirmed_review_audit_required
  ON reconciliation_confirmed_review_audits(acknowledgement_required, created_at);

COMMIT;
