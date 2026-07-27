BEGIN;

CREATE TABLE IF NOT EXISTS reconciliation_mapping_templates (
  id uuid PRIMARY KEY,
  name varchar(160) NOT NULL,
  mall_name varchar(120) NOT NULL,
  bill_type varchar(40) NOT NULL,
  bill_signature varchar(500) NOT NULL,
  erp_signature varchar(500) NOT NULL,
  bill_headers jsonb NOT NULL,
  erp_headers jsonb NOT NULL,
  bill_mapping jsonb NOT NULL,
  erp_mapping jsonb NOT NULL,
  use_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mapping_template_signature
  ON reconciliation_mapping_templates(mall_name, bill_signature, erp_signature);

CREATE INDEX IF NOT EXISTS idx_mapping_template_mall
  ON reconciliation_mapping_templates(mall_name, updated_at DESC);

COMMIT;
