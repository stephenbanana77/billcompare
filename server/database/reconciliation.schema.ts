import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type {
  ConfirmedFieldValue,
  FieldMapping,
  MailAttachment,
  MoneySnapshot,
  RuleSnapshot,
  VisionExtractionResult,
  VisionLineItem,
  VoucherLine,
} from '@shared/reconciliation';

export const reconciliationConfirmedBills = pgTable(
  'reconciliation_confirmed_bills',
  {
    id: uuid('id').primaryKey(),
    version: integer('version').notNull(),
    status: varchar('status', { length: 24 }).notNull(),
    sourceFileName: varchar('source_file_name', { length: 255 }).notNull(),
    mallName: varchar('mall_name', { length: 120 }).notNull(),
    storeName: varchar('store_name', { length: 120 }).notNull(),
    storeCode: varchar('store_code', { length: 60 }).notNull(),
    periodStart: varchar('period_start', { length: 10 }).notNull(),
    periodEnd: varchar('period_end', { length: 10 }).notNull(),
    billType: varchar('bill_type', { length: 40 }).notNull(),
    settlementNo: varchar('settlement_no', { length: 120 }),
    salesAmount: numeric('sales_amount', { precision: 16, scale: 2 }).notNull(),
    invoiceAmount: numeric('invoice_amount', { precision: 16, scale: 2 }),
    deductionTotal: numeric('deduction_total', { precision: 16, scale: 2 }),
    settlementAmount: numeric('settlement_amount', {
      precision: 16,
      scale: 2,
    }).notNull(),
    ocrVerified: boolean('ocr_verified').notNull().default(false),
    reviewedFields: jsonb('reviewed_fields')
      .$type<ConfirmedFieldValue[]>()
      .notNull(),
    extractionPayload: jsonb('extraction_payload')
      .$type<VisionExtractionResult>()
      .notNull(),
    confirmedBy: varchar('confirmed_by', { length: 120 }).notNull(),
    confirmedAt: timestamp('confirmed_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('uq_reconciliation_confirmed_bills_version').on(
      table.storeCode,
      table.periodStart,
      table.periodEnd,
      table.version,
    ),
    uniqueIndex('uq_confirmed_bill_active_period')
      .on(table.storeCode, table.periodStart, table.periodEnd)
      .where(sql`${table.status} = 'confirmed'`),
    index('idx_confirmed_bill_query').on(
      table.storeCode,
      table.periodStart,
      table.periodEnd,
      table.status,
    ),
  ],
);

export const reconciliationConfirmedSalesLines = pgTable(
  'reconciliation_confirmed_sales_lines',
  {
    id: uuid('id').primaryKey(),
    billId: uuid('bill_id')
      .notNull()
      .references(() => reconciliationConfirmedBills.id, {
        onDelete: 'cascade',
      }),
    sequence: integer('sequence').notNull(),
    label: varchar('label', { length: 255 }).notNull(),
    rowType: varchar('row_type', { length: 24 }).notNull(),
    values: jsonb('values').$type<VisionLineItem['values']>().notNull(),
    rawText: text('raw_text'),
    sourcePage: integer('source_page'),
    confidence: numeric('confidence', { precision: 5, scale: 4 }),
  },
  (table) => [
    index('idx_confirmed_sales_bill').on(
      table.billId,
      table.sequence,
    ),
  ],
);

export const reconciliationConfirmedFeeLines = pgTable(
  'reconciliation_confirmed_fee_lines',
  {
    id: uuid('id').primaryKey(),
    billId: uuid('bill_id')
      .notNull()
      .references(() => reconciliationConfirmedBills.id, {
        onDelete: 'cascade',
      }),
    sequence: integer('sequence').notNull(),
    label: varchar('label', { length: 255 }).notNull(),
    rowType: varchar('row_type', { length: 24 }).notNull(),
    values: jsonb('values').$type<VisionLineItem['values']>().notNull(),
    rawText: text('raw_text'),
    sourcePage: integer('source_page'),
    confidence: numeric('confidence', { precision: 5, scale: 4 }),
  },
  (table) => [
    index('idx_confirmed_fee_bill').on(
      table.billId,
      table.sequence,
    ),
  ],
);

export const reconciliationEmailSources = pgTable('reconciliation_email_sources', {
  id: uuid('id').primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  provider: varchar('provider', { length: 40 }).notNull(),
  mailboxAddress: varchar('mailbox_address', { length: 160 }).notNull(),
  mailboxFolder: varchar('mailbox_folder', { length: 160 })
    .notNull()
    .default('账单待处理'),
  routingRule: text('routing_rule'),
  status: varchar('status', { length: 32 }).notNull().default('awaiting_authorization'),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true, mode: 'string' }),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .defaultNow()
    .notNull(),
});

export const reconciliationInboundEmails = pgTable(
  'reconciliation_inbound_emails',
  {
    id: uuid('id').primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => reconciliationEmailSources.id, { onDelete: 'cascade' }),
    externalMessageId: varchar('external_message_id', { length: 255 }).notNull(),
    sender: varchar('sender', { length: 255 }).notNull(),
    subject: varchar('subject', { length: 500 }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'string' }).notNull(),
    attachments: jsonb('attachments').$type<MailAttachment[]>().notNull(),
    status: varchar('status', { length: 32 }).notNull().default('pending_confirmation'),
    rejectionReason: text('rejection_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('uq_reconciliation_inbound_email_message').on(
      table.sourceId,
      table.externalMessageId,
    ),
  ],
);

export const reconciliationRules = pgTable('reconciliation_rules', {
  id: uuid('id').primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  mallName: varchar('mall_name', { length: 120 }),
  storeCode: varchar('store_code', { length: 60 }),
  contractNo: varchar('contract_no', { length: 80 }),
  contractVersion: varchar('contract_version', { length: 40 }),
  effectiveStart: varchar('effective_start', { length: 10 }),
  effectiveEnd: varchar('effective_end', { length: 10 }),
  billType: varchar('bill_type', { length: 40 }).notNull(),
  periodType: varchar('period_type', { length: 40 }).notNull(),
  commissionRate: numeric('commission_rate', {
    precision: 8,
    scale: 4,
  }).notNull(),
  activityFee: numeric('activity_fee', { precision: 16, scale: 2 }).notNull(),
  toleranceAmount: numeric('tolerance_amount', {
    precision: 16,
    scale: 2,
  }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
  approvalStatus: varchar('approval_status', { length: 24 })
    .notNull()
    .default('approved'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .defaultNow()
    .notNull(),
});

export const reconciliationJobs = pgTable('reconciliation_jobs', {
  id: uuid('id').primaryKey(),
  taskNo: varchar('task_no', { length: 40 }).notNull().unique(),
  mallName: varchar('mall_name', { length: 120 }).notNull(),
  storeName: varchar('store_name', { length: 120 }).notNull(),
  storeCode: varchar('store_code', { length: 60 }).notNull(),
  periodStart: varchar('period_start', { length: 10 }).notNull(),
  periodEnd: varchar('period_end', { length: 10 }).notNull(),
  status: varchar('status', { length: 32 }).notNull(),
  billType: varchar('bill_type', { length: 40 }).notNull(),
  sourceBillName: varchar('source_bill_name', { length: 255 }).notNull(),
  sourceErpName: varchar('source_erp_name', { length: 255 }).notNull(),
  ruleId: uuid('rule_id').references(() => reconciliationRules.id, {
    onDelete: 'set null',
  }),
  ruleSnapshot: jsonb('rule_snapshot').$type<RuleSnapshot>().notNull(),
  billSnapshot: jsonb('bill_snapshot').$type<MoneySnapshot>().notNull(),
  erpSnapshot: jsonb('erp_snapshot').$type<MoneySnapshot>().notNull(),
  salesDiff: numeric('sales_diff', { precision: 16, scale: 2 }).notNull(),
  refundDiff: numeric('refund_diff', { precision: 16, scale: 2 }).notNull(),
  settlementDiff: numeric('settlement_diff', {
    precision: 16,
    scale: 2,
  }).notNull(),
  issueCount: integer('issue_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .defaultNow()
    .notNull(),
});

export const reconciliationComparisons = pgTable('reconciliation_comparisons', {
  id: uuid('id').primaryKey(),
  jobId: uuid('job_id')
    .notNull()
    .references(() => reconciliationJobs.id, { onDelete: 'cascade' }),
  fieldKey: varchar('field_key', { length: 60 }).notNull(),
  fieldLabel: varchar('field_label', { length: 80 }).notNull(),
  billValue: numeric('bill_value', { precision: 16, scale: 2 }).notNull(),
  erpValue: numeric('erp_value', { precision: 16, scale: 2 }).notNull(),
  difference: numeric('difference', { precision: 16, scale: 2 }).notNull(),
  result: varchar('result', { length: 24 }).notNull(),
  evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),
  sortOrder: integer('sort_order').notNull(),
});

export const reconciliationIssues = pgTable('reconciliation_issues', {
  id: uuid('id').primaryKey(),
  jobId: uuid('job_id')
    .notNull()
    .references(() => reconciliationJobs.id, { onDelete: 'cascade' }),
  type: varchar('type', { length: 60 }).notNull(),
  severity: varchar('severity', { length: 20 }).notNull(),
  title: varchar('title', { length: 160 }).notNull(),
  description: text('description').notNull(),
  differenceAmount: numeric('difference_amount', {
    precision: 16,
    scale: 2,
  }).notNull(),
  status: varchar('status', { length: 24 }).notNull(),
  suggestedAction: text('suggested_action').notNull(),
  resolutionNote: text('resolution_note'),
  resolutionEvidence: text('resolution_evidence'),
  assignedTo: varchar('assigned_to', { length: 120 }),
  dueDate: varchar('due_date', { length: 10 }),
  reviewerName: varchar('reviewer_name', { length: 120 }),
  reviewNote: text('review_note'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .defaultNow()
    .notNull(),
});

export const reconciliationIssueEvents = pgTable(
  'reconciliation_issue_events',
  {
    id: uuid('id').primaryKey(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => reconciliationIssues.id, { onDelete: 'cascade' }),
    action: varchar('action', { length: 80 }).notNull(),
    fromStatus: varchar('from_status', { length: 24 }),
    toStatus: varchar('to_status', { length: 24 }).notNull(),
    comment: text('comment'),
    operatorName: varchar('operator_name', { length: 120 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
);

export const reconciliationAuditLogs = pgTable('reconciliation_audit_logs', {
  id: uuid('id').primaryKey(),
  jobId: uuid('job_id').references(() => reconciliationJobs.id, {
    onDelete: 'cascade',
  }),
  action: varchar('action', { length: 80 }).notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
  operatorName: varchar('operator_name', { length: 120 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .defaultNow()
    .notNull(),
});

export const reconciliationMappingTemplates = pgTable(
  'reconciliation_mapping_templates',
  {
    id: uuid('id').primaryKey(),
    name: varchar('name', { length: 160 }).notNull(),
    mallName: varchar('mall_name', { length: 120 }).notNull(),
    billType: varchar('bill_type', { length: 40 }).notNull(),
    billSignature: varchar('bill_signature', { length: 500 }).notNull(),
    erpSignature: varchar('erp_signature', { length: 500 }).notNull(),
    billHeaders: jsonb('bill_headers').$type<string[]>().notNull(),
    erpHeaders: jsonb('erp_headers').$type<string[]>().notNull(),
    billMapping: jsonb('bill_mapping').$type<FieldMapping>().notNull(),
    erpMapping: jsonb('erp_mapping').$type<FieldMapping>().notNull(),
    useCount: integer('use_count').notNull().default(0),
    lastUsedAt: timestamp('last_used_at', {
      withTimezone: true,
      mode: 'string',
    }),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('uq_mapping_template_signature').on(
      table.mallName,
      table.billSignature,
      table.erpSignature,
    ),
  ],
);

export const reconciliationCollections = pgTable('reconciliation_collections', {
  id: uuid('id').primaryKey(),
  jobId: uuid('job_id')
    .notNull()
    .unique()
    .references(() => reconciliationJobs.id, { onDelete: 'cascade' }),
  expectedAmount: numeric('expected_amount', {
    precision: 16,
    scale: 2,
  }).notNull(),
  dueDate: varchar('due_date', { length: 10 }),
  receivedAmount: numeric('received_amount', {
    precision: 16,
    scale: 2,
  })
    .notNull()
    .default('0'),
  differenceAmount: numeric('difference_amount', {
    precision: 16,
    scale: 2,
  }).notNull(),
  status: varchar('status', { length: 24 }).notNull().default('pending'),
  lastReceiptAt: varchar('last_receipt_at', { length: 10 }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .defaultNow()
    .notNull(),
});

export const reconciliationReceipts = pgTable('reconciliation_receipts', {
  id: uuid('id').primaryKey(),
  collectionId: uuid('collection_id')
    .notNull()
    .references(() => reconciliationCollections.id, { onDelete: 'cascade' }),
  sourceFileName: varchar('source_file_name', { length: 255 }).notNull(),
  bankReference: varchar('bank_reference', { length: 120 }).notNull(),
  payerName: varchar('payer_name', { length: 160 }).notNull(),
  paymentDate: varchar('payment_date', { length: 10 }).notNull(),
  amount: numeric('amount', { precision: 16, scale: 2 }).notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .defaultNow()
    .notNull(),
});

export const reconciliationVouchers = pgTable('reconciliation_vouchers', {
  id: uuid('id').primaryKey(),
  jobId: uuid('job_id')
    .notNull()
    .unique()
    .references(() => reconciliationJobs.id, { onDelete: 'cascade' }),
  collectionId: uuid('collection_id')
    .notNull()
    .unique()
    .references(() => reconciliationCollections.id, { onDelete: 'cascade' }),
  voucherNo: varchar('voucher_no', { length: 60 }).notNull().unique(),
  status: varchar('status', { length: 24 }).notNull().default('draft'),
  voucherDate: varchar('voucher_date', { length: 10 }).notNull(),
  summary: varchar('summary', { length: 255 }).notNull(),
  totalAmount: numeric('total_amount', { precision: 16, scale: 2 }).notNull(),
  debitAccount: varchar('debit_account', { length: 120 }).notNull(),
  creditAccount: varchar('credit_account', { length: 120 }).notNull(),
  lines: jsonb('lines').$type<VoucherLine[]>().notNull(),
  confirmedBy: varchar('confirmed_by', { length: 120 }),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .defaultNow()
    .notNull(),
});
