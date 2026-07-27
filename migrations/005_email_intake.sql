BEGIN;

CREATE TABLE IF NOT EXISTS reconciliation_email_sources (
  id uuid PRIMARY KEY,
  name varchar(120) NOT NULL,
  provider varchar(40) NOT NULL,
  mailbox_address varchar(160) NOT NULL,
  routing_rule text,
  status varchar(32) NOT NULL DEFAULT 'awaiting_authorization',
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reconciliation_inbound_emails (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES reconciliation_email_sources(id) ON DELETE CASCADE,
  external_message_id varchar(255) NOT NULL,
  sender varchar(255) NOT NULL,
  subject varchar(500) NOT NULL,
  received_at timestamptz NOT NULL,
  attachments jsonb NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'pending_confirmation',
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_reconciliation_inbound_email_message UNIQUE (source_id, external_message_id)
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_inbound_emails_status
  ON reconciliation_inbound_emails(status, received_at DESC);

COMMIT;
