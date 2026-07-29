BEGIN;

-- 清理历史重复流水：同一回款计划下相同银行流水号只保留最早一条
DELETE FROM reconciliation_receipts a
USING reconciliation_receipts b
WHERE a.collection_id = b.collection_id
  AND a.bank_reference = b.bank_reference
  AND (
    a.created_at > b.created_at
    OR (a.created_at = b.created_at AND a.id > b.id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_reconciliation_receipts_reference
  ON reconciliation_receipts(collection_id, bank_reference);

COMMIT;
