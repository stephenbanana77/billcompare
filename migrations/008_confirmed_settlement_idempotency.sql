BEGIN;

ALTER TABLE reconciliation_confirmed_bills
  ADD COLUMN IF NOT EXISTS confirmation_key varchar(100);

UPDATE reconciliation_confirmed_bills
SET confirmation_key = id::text
WHERE confirmation_key IS NULL OR btrim(confirmation_key) = '';

ALTER TABLE reconciliation_confirmed_bills
  ALTER COLUMN confirmation_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_confirmed_bill_confirmation_key
  ON reconciliation_confirmed_bills(confirmation_key);

COMMENT ON COLUMN reconciliation_confirmed_bills.ocr_verified IS
  'Client-reported OCR cross-check status; not server-verified evidence.';

COMMIT;
