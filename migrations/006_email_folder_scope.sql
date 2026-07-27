BEGIN;

ALTER TABLE reconciliation_email_sources
  ADD COLUMN IF NOT EXISTS mailbox_folder varchar(160) NOT NULL DEFAULT '账单待处理';

COMMIT;
