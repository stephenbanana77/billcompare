import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { getTableName, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { ConfirmSettlementBillInput } from '../../../shared/reconciliation';
import {
  reconciliationConfirmedBills,
  reconciliationConfirmedDynamicLines,
  reconciliationConfirmedFeeLines,
  reconciliationConfirmedReviewAudits,
  reconciliationConfirmedSalesLines,
} from '../../database/reconciliation.schema';
import {
  BILL_IDENTITY_LOCK_NAMESPACE,
  CONFIRMATION_KEY_LOCK_NAMESPACE,
  ConfirmedSettlementService,
} from './confirmed-settlement.service';

const columnNames = (columns: Array<{ name?: string }>) =>
  columns.map((column) => column.name);

const migration = readFileSync(
  join(process.cwd(), 'migrations/007_confirmed_settlement_bills.sql'),
  'utf8',
).replace(/\s+/g, ' ');

const dynamicMigration = readFileSync(
  join(
    process.cwd(),
    'migrations/010_confirmed_dynamic_lines_and_review_audits.sql',
  ),
  'utf8',
).replace(/\s+/g, ' ');

const input = (): ConfirmSettlementBillInput => ({
  fileName: 'SHAD64-202605.pdf',
  extraction: {
    sourceType: 'vision_llm',
    fileName: 'SHAD64-202605.pdf',
    headers: [],
    rows: [],
    metadata: {
      mallName: 'Mall A',
      storeName: 'Store A',
      storeCode: 'SHAD64',
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
      billType: 'standard',
    },
    periodEvidence: null,
    evidence: {},
    additionalFields: [],
    lineItems: [
      {
        section: '商品销售明细',
        label: 'Sales one',
        sequence: 9,
        values: { amount: '100.00' },
        rawText: 'sales one',
        page: 1,
        confidence: 0.98,
      },
      {
        section: '商品销售明细',
        label: 'Sales two',
        sequence: 9,
        values: { amount: '20.00' },
        rawText: 'sales two',
        page: 1,
        confidence: 0.97,
      },
      {
        section: '扣款费用明细',
        label: 'Fee one',
        sequence: 4,
        values: { amount: '5.00' },
        rawText: 'fee one',
        page: 2,
        confidence: 0.96,
      },
      {
        section: '扣款费用明细',
        label: 'Fee two',
        sequence: 4,
        values: { amount: '2.00' },
        rawText: 'fee two',
        page: 2,
        confidence: 0.95,
      },
    ],
    warnings: [],
  },
  reviewedFields: [
    { id: 'mall', label: 'Mall', target: 'mallName', value: 'Mall A' },
    { id: 'store', label: 'Store', target: 'storeName', value: 'Store A' },
    { id: 'code', label: 'Code', target: 'storeCode', value: 'SHAD64' },
    { id: 'start', label: 'Start', target: 'periodStart', value: '2026-05-01' },
    { id: 'end', label: 'End', target: 'periodEnd', value: '2026-05-31' },
    { id: 'sales', label: 'Sales', target: 'salesAmount', value: '120.00' },
    {
      id: 'settlement',
      label: 'Settlement',
      target: 'settlementAmount',
      value: '113.00',
    },
  ],
  confirmationKey: '11111111-1111-4111-8111-111111111111',
  clientReportedOcrVerified: true,
});

type BillRow = typeof reconciliationConfirmedBills.$inferSelect;

const sqlQuery = (expression: SQL) => new PgDialect().sqlToQuery(expression);

class DatabaseDouble {
  readonly events: string[] = [];
  readonly executed: SQL[] = [];
  readonly billInserts: Array<Record<string, unknown>> = [];
  readonly salesInserts: Array<Record<string, unknown>> = [];
  readonly feeInserts: Array<Record<string, unknown>> = [];
  readonly dynamicInserts: Array<Record<string, unknown>> = [];
  readonly reviewAuditInserts: Array<Record<string, unknown>> = [];
  readonly updates: Array<Record<string, unknown>> = [];
  readonly selectWheres: SQL[] = [];
  readonly selectOrders: unknown[][] = [];
  readonly selectLimits: number[] = [];
  existingActive: Pick<BillRow, 'id' | 'version'> | undefined;
  highestHistorical: Pick<BillRow, 'id' | 'version'> | undefined;
  existingByConfirmationKey:
    | Pick<
        BillRow,
        | 'id'
        | 'version'
        | 'mallName'
        | 'storeCode'
        | 'periodStart'
        | 'periodEnd'
        | 'billType'
      >
    | undefined;
  failOn:
    | 'bill:insert'
    | 'sales:insert'
    | 'fee:insert'
    | 'dynamic:insert'
    | 'review-audit:insert'
    | undefined;
  bills: BillRow[] = [];
  salesRows: Array<typeof reconciliationConfirmedSalesLines.$inferSelect> = [];
  feeRows: Array<typeof reconciliationConfirmedFeeLines.$inferSelect> = [];
  dynamicRows: Array<typeof reconciliationConfirmedDynamicLines.$inferSelect> =
    [];
  reviewAuditRows: Array<
    typeof reconciliationConfirmedReviewAudits.$inferSelect
  > = [];
  transaction = jest.fn(
    async (callback: (tx: DatabaseDouble) => Promise<string>) => {
      const snapshot = {
        bills: this.billInserts.length,
        sales: this.salesInserts.length,
        fees: this.feeInserts.length,
        dynamic: this.dynamicInserts.length,
        reviewAudits: this.reviewAuditInserts.length,
        updates: this.updates.length,
      };
      this.events.push('transaction:start');
      try {
        const result = await callback(this);
        this.events.push('transaction:commit');
        return result;
      } catch (error) {
        this.billInserts.splice(snapshot.bills);
        this.salesInserts.splice(snapshot.sales);
        this.feeInserts.splice(snapshot.fees);
        this.dynamicInserts.splice(snapshot.dynamic);
        this.reviewAuditInserts.splice(snapshot.reviewAudits);
        this.updates.splice(snapshot.updates);
        this.events.push('transaction:rollback');
        throw error;
      }
    },
  );

  execute(expression: SQL) {
    this.events.push('lock');
    this.executed.push(expression);
    return Promise.resolve([]);
  }

  select() {
    const state: { table?: unknown; where?: SQL } = {};
    const builder = {
      from: (table: unknown) => {
        state.table = table;
        return builder;
      },
      where: (where: SQL) => {
        state.where = where;
        this.selectWheres.push(where);
        return builder;
      },
      orderBy: (...order: unknown[]) => {
        this.selectOrders.push(order);
        return builder;
      },
      limit: (limit: number) => {
        this.selectLimits.push(limit);
        return builder;
      },
      then: (
        resolve: (rows: unknown[]) => unknown,
        reject: (error: unknown) => unknown,
      ) =>
        Promise.resolve(this.rowsFor(state.table, state.where)).then(
          resolve,
          reject,
        ),
    };
    return builder;
  }

  update(_table: unknown) {
    const record: Record<string, unknown> = {};
    const builder = {
      set: (values: Record<string, unknown>) => {
        Object.assign(record, values);
        return builder;
      },
      where: (where: SQL) => {
        record.where = where;
        this.updates.push(record);
        this.events.push('bill:update');
        return Promise.resolve([]);
      },
    };
    return builder;
  }

  insert(table: unknown) {
    const builder = {
      values: (
        values: Record<string, unknown> | Array<Record<string, unknown>>,
      ) => {
        const rows = Array.isArray(values) ? values : [values];
        if (table === reconciliationConfirmedBills) {
          this.billInserts.push(...rows);
          this.events.push('bill:insert');
        } else if (table === reconciliationConfirmedSalesLines) {
          this.salesInserts.push(...rows);
          this.events.push('sales:insert');
        } else if (table === reconciliationConfirmedFeeLines) {
          this.feeInserts.push(...rows);
          this.events.push('fee:insert');
        } else if (table === reconciliationConfirmedDynamicLines) {
          this.dynamicInserts.push(...rows);
          this.events.push('dynamic:insert');
        } else if (table === reconciliationConfirmedReviewAudits) {
          this.reviewAuditInserts.push(...rows);
          this.events.push('review-audit:insert');
        }
        const event = this.events.at(-1);
        if (event === this.failOn) throw new Error(`forced ${event} failure`);
        return builder;
      },
      returning: () => Promise.resolve([{ id: this.billInserts.at(-1)?.id }]),
      then: (
        resolve: (rows: unknown[]) => unknown,
        reject: (error: unknown) => unknown,
      ) => Promise.resolve([]).then(resolve, reject),
    };
    return builder;
  }

  private rowsFor(table: unknown, where?: SQL) {
    if (table === reconciliationConfirmedBills) {
      const query = where ? sqlQuery(where) : undefined;
      if (query?.sql.includes('confirmation_key')) {
        return this.existingByConfirmationKey
          ? [this.existingByConfirmationKey]
          : [];
      }
      if (query?.params.includes('confirmed')) {
        if (this.existingActive) return [this.existingActive];
        return this.bills.filter((bill) => bill.status === 'confirmed');
      }
      if (where && this.highestHistorical) return [this.highestHistorical];
      return this.bills;
    }
    if (table === reconciliationConfirmedSalesLines) return this.salesRows;
    if (table === reconciliationConfirmedFeeLines) return this.feeRows;
    if (table === reconciliationConfirmedDynamicLines) return this.dynamicRows;
    if (table === reconciliationConfirmedReviewAudits)
      return this.reviewAuditRows;
    return [];
  }
}

describe('confirmed settlement schema', () => {
  it('uses stable table names', () => {
    expect(getTableName(reconciliationConfirmedBills)).toBe(
      'reconciliation_confirmed_bills',
    );
    expect(getTableName(reconciliationConfirmedSalesLines)).toBe(
      'reconciliation_confirmed_sales_lines',
    );
    expect(getTableName(reconciliationConfirmedFeeLines)).toBe(
      'reconciliation_confirmed_fee_lines',
    );
    expect(getTableName(reconciliationConfirmedDynamicLines)).toBe(
      'reconciliation_confirmed_dynamic_lines',
    );
    expect(getTableName(reconciliationConfirmedReviewAudits)).toBe(
      'reconciliation_confirmed_review_audits',
    );
  });

  it('defines bill identity, status safety, and listing indexes', () => {
    const config = getTableConfig(reconciliationConfirmedBills);
    const versionIdentity = config.uniqueConstraints.find(
      (constraint) =>
        constraint.getName() === 'uq_reconciliation_confirmed_bills_version',
    );
    const activeIdentity = config.indexes.find(
      (index) => index.config.name === 'uq_confirmed_bill_active_period',
    );
    const storeQuery = config.indexes.find(
      (index) => index.config.name === 'idx_confirmed_bill_query',
    );
    const defaultList = config.indexes.find(
      (index) => index.config.name === 'idx_confirmed_bill_status_period',
    );

    expect(
      config.columns.find((column) => column.name === 'status')?.notNull,
    ).toBe(true);
    expect(config.checks.map((constraint) => constraint.name)).toContain(
      'ck_reconciliation_confirmed_bills_status',
    );
    expect(columnNames(versionIdentity?.columns ?? [])).toEqual([
      'mall_name',
      'store_code',
      'period_start',
      'period_end',
      'bill_type',
      'version',
    ]);
    expect(activeIdentity?.config.unique).toBe(true);
    expect(activeIdentity?.config.where).toBeDefined();
    expect(columnNames(activeIdentity?.config.columns ?? [])).toEqual([
      'mall_name',
      'store_code',
      'period_start',
      'period_end',
      'bill_type',
    ]);
    expect(columnNames(storeQuery?.config.columns ?? [])).toEqual([
      'mall_name',
      'store_code',
      'period_start',
      'period_end',
      'status',
      'bill_type',
    ]);
    expect(columnNames(defaultList?.config.columns ?? [])).toEqual([
      'status',
      'period_start',
      'period_end',
    ]);
    expect(
      config.columns.find((column) => column.name === 'confirmation_key')
        ?.notNull,
    ).toBe(true);
    expect(
      config.columns.find((column) => column.name === 'ocr_verified')?.name,
    ).toBe('ocr_verified');
    expect(
      config.indexes.find(
        (candidate) =>
          candidate.config.name === 'uq_confirmed_bill_confirmation_key',
      )?.config.unique,
    ).toBe(true);
  });

  it.each([
    [
      'sales',
      reconciliationConfirmedSalesLines,
      'uq_confirmed_sales_bill_sequence',
    ],
    ['fee', reconciliationConfirmedFeeLines, 'uq_confirmed_fee_bill_sequence'],
    [
      'dynamic',
      reconciliationConfirmedDynamicLines,
      'uq_confirmed_dynamic_bill_sequence',
    ],
  ])(
    'defines cascade ownership and sequence uniqueness for %s lines',
    (_, table, uniqueName) => {
      const config = getTableConfig(table);
      const foreignKey = config.foreignKeys.find(
        (candidate) => candidate.reference().columns[0]?.name === 'bill_id',
      );
      const uniqueConstraint = config.uniqueConstraints.find(
        (constraint) => constraint.getName() === uniqueName,
      );

      expect(foreignKey?.onDelete).toBe('cascade');
      expect(getTableName(foreignKey!.reference().foreignTable)).toBe(
        'reconciliation_confirmed_bills',
      );
      expect(columnNames(uniqueConstraint?.columns ?? [])).toEqual([
        'bill_id',
        'sequence',
      ]);
    },
  );

  it('keeps migration 007 aligned with the schema safety contracts', () => {
    expect(migration).toContain(
      "CONSTRAINT ck_reconciliation_confirmed_bills_status CHECK (status IN ('confirmed', 'superseded', 'revoked'))",
    );
    expect(migration).toContain(
      'UNIQUE (mall_name, store_code, period_start, period_end, bill_type, version)',
    );
    expect(migration).toContain(
      "ON reconciliation_confirmed_bills(mall_name, store_code, period_start, period_end, bill_type) WHERE status = 'confirmed'",
    );
    expect(migration).toContain(
      'ON reconciliation_confirmed_bills(status, period_start, period_end)',
    );
    expect(
      migration.match(
        /bill_id uuid NOT NULL REFERENCES reconciliation_confirmed_bills\(id\) ON DELETE CASCADE/g,
      ),
    ).toHaveLength(2);
    expect(migration).toContain(
      'CONSTRAINT uq_confirmed_sales_bill_sequence UNIQUE (bill_id, sequence)',
    );
    expect(migration).toContain(
      'CONSTRAINT uq_confirmed_fee_bill_sequence UNIQUE (bill_id, sequence)',
    );
    expect(migration).toContain('confirmation_key varchar(100) NOT NULL');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_confirmed_bill_confirmation_key',
    );
    expect(migration).toContain(
      "COMMENT ON COLUMN reconciliation_confirmed_bills.ocr_verified IS 'Client-reported OCR cross-check status; not server-verified evidence.'",
    );
    expect(
      existsSync(
        join(
          process.cwd(),
          'migrations/008_confirmed_settlement_idempotency.sql',
        ),
      ),
    ).toBe(true);
  });
});

describe('ConfirmedSettlementService', () => {
  const detailFrom = (db: DatabaseDouble) => ({
    bill: db.billInserts.at(-1) as unknown as BillRow,
    reviewedFields: input().reviewedFields,
    extraction: input().extraction,
    salesLines: [],
    feeLines: [],
  });

  const createService = (db: DatabaseDouble) => {
    const service = new ConfirmedSettlementService(db as never);
    jest.spyOn(service, 'getById').mockImplementation(async () => {
      db.events.push('getById');
      return detailFrom(db);
    });
    return service;
  };

  it('writes the bill and all detail lines in one transaction, then reads after commit', async () => {
    const db = new DatabaseDouble();
    const service = createService(db);

    await service.confirm(input());

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.billInserts).toHaveLength(1);
    expect(db.salesInserts).toHaveLength(2);
    expect(db.feeInserts).toHaveLength(2);
    expect(db.dynamicInserts).toHaveLength(4);
    expect(db.reviewAuditInserts).toHaveLength(1);
    for (const event of [
      'bill:insert',
      'sales:insert',
      'fee:insert',
      'dynamic:insert',
      'review-audit:insert',
    ]) {
      expect(db.events.indexOf('transaction:start')).toBeLessThan(
        db.events.indexOf(event),
      );
      expect(db.events.indexOf(event)).toBeLessThan(
        db.events.indexOf('transaction:commit'),
      );
    }
    expect(db.events.indexOf('transaction:commit')).toBeLessThan(
      db.events.indexOf('getById'),
    );
  });

  it('returns the existing bill for the same confirmation key without creating a version', async () => {
    const db = new DatabaseDouble();
    db.existingByConfirmationKey = {
      id: 'existing-id',
      version: 1,
      mallName: 'Mall A',
      storeCode: 'SHAD64',
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
      billType: 'standard',
    };
    const service = new ConfirmedSettlementService(db as never);
    const existing = detailFrom(db);
    existing.bill = { ...existing.bill, id: 'existing-id', version: 1 };
    jest.spyOn(service, 'getById').mockResolvedValue(existing);

    const result = await service.confirm(input());

    expect(result.bill).toMatchObject({ id: 'existing-id', version: 1 });
    expect(db.billInserts).toHaveLength(0);
    expect(db.updates).toHaveLength(0);
    expect(db.salesInserts).toHaveLength(0);
    expect(db.feeInserts).toHaveLength(0);
    expect(db.dynamicInserts).toHaveLength(0);
    expect(db.reviewAuditInserts).toHaveLength(0);
  });

  it('rejects a reused confirmation key when the logical bill identity differs', async () => {
    const db = new DatabaseDouble();
    db.existingByConfirmationKey = {
      id: 'existing-id',
      version: 1,
      mallName: 'Mall A',
      storeCode: 'OTHER',
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
      billType: 'standard',
    };
    const service = new ConfirmedSettlementService(db as never);

    await expect(service.confirm(input())).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(db.billInserts).toHaveLength(0);
    expect(db.updates).toHaveLength(0);
    expect(db.salesInserts).toHaveLength(0);
    expect(db.feeInserts).toHaveLength(0);
  });

  it('persists a different confirmation key as the next version', async () => {
    const db = new DatabaseDouble();
    db.existingActive = { id: 'old-id', version: 1 };
    db.highestHistorical = { id: 'old-id', version: 1 };
    const service = createService(db);
    const next = input();
    next.confirmationKey = '22222222-2222-4222-8222-222222222222';

    const result = await service.confirm(next);

    expect(result.bill.version).toBe(2);
    expect(db.billInserts[0]).toMatchObject({
      version: 2,
      confirmationKey: next.confirmationKey,
    });
  });

  it('maps and validates input before opening a transaction', async () => {
    const db = new DatabaseDouble();
    const service = new ConfirmedSettlementService(db as never);
    const invalid = input();
    invalid.fileName = '   ';

    await expect(service.confirm(invalid)).rejects.toThrow('fileName');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('allows acknowledged review issues and records the quality audit', async () => {
    const db = new DatabaseDouble();
    const service = createService(db);
    const reviewed = input();
    reviewed.qualityReview = {
      acknowledged: true,
      note: 'Mall bill total needs finance review before ERP closing.',
    };
    reviewed.extraction.warnings = ['Formula check needs review'];
    reviewed.extraction.formulaChecks = [
      {
        id: 'formula-1',
        label: 'Settlement amount check',
        expression: 'sales - fees = settlement',
        formula: { type: 'literal', value: 120 },
        expected: 113,
        fieldValues: {},
        sourceText: 'total check failed',
        page: 1,
        status: 'failed',
        validation: {
          computed: 120,
          expected: 113,
          difference: 7,
          pass: false,
          missingRefs: [],
          issues: [],
        },
      },
    ];

    await service.confirm(reviewed);

    expect(db.reviewAuditInserts[0]).toMatchObject({
      issueCount: 2,
      acknowledgementRequired: true,
      acknowledgedByClient: true,
      acknowledgementNote: 'Mall bill total needs finance review before ERP closing.',
    });
  });

  it('records reviewed field edits for pilot intervention metrics', async () => {
    const db = new DatabaseDouble();
    const service = createService(db);
    const reviewed = input();
    reviewed.extraction.evidence.salesAmount = {
      value: '118.00',
      rawText: 'sales 118.00',
      page: 1,
      confidence: 0.92,
    };

    await service.confirm(reviewed);

    expect(db.reviewAuditInserts[0]).toMatchObject({
      manualEditCount: 1,
    });
    expect(db.reviewAuditInserts[0].manualEdits).toEqual([
      expect.objectContaining({
        target: 'salesAmount',
        originalValue: '118.00',
        reviewedValue: '120.00',
      }),
    ]);
  });

  it('keeps migration 010 aligned with dynamic detail and review audit storage', () => {
    expect(dynamicMigration).toContain(
      'CREATE TABLE IF NOT EXISTS reconciliation_confirmed_dynamic_lines',
    );
    expect(dynamicMigration).toContain(
      'CONSTRAINT uq_confirmed_dynamic_bill_sequence UNIQUE (bill_id, sequence)',
    );
    expect(dynamicMigration).toContain(
      'CREATE TABLE IF NOT EXISTS reconciliation_confirmed_review_audits',
    );
    expect(dynamicMigration).toContain(
      'bill_id uuid NOT NULL UNIQUE REFERENCES reconciliation_confirmed_bills(id) ON DELETE CASCADE',
    );
    expect(dynamicMigration).toContain('acknowledgement_required boolean NOT NULL');
  });

  it('rejects confirmation with unresolved formula issues before opening a transaction', async () => {
    const db = new DatabaseDouble();
    const service = new ConfirmedSettlementService(db as never);
    const invalid = input();
    invalid.extraction.formulaChecks = [
      {
        id: 'formula-1',
        label: 'Settlement amount check',
        expression: 'sales - fees = settlement',
        formula: { type: 'literal', value: 120 },
        expected: 113,
        fieldValues: {},
        sourceText: 'total check failed',
        page: 1,
        status: 'failed',
        validation: {
          computed: 120,
          expected: 113,
          difference: 7,
          pass: false,
          missingRefs: [],
          issues: [],
        },
      },
    ];

    await expect(service.confirm(invalid)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('locks confirmation keys and bill identities in distinct PostgreSQL namespaces', async () => {
    const db = new DatabaseDouble();
    db.existingActive = { id: 'old-id', version: 1 };
    db.highestHistorical = { id: 'old-id', version: 1 };
    const service = createService(db);

    const created = await service.confirm(input());

    const identity = [
      'Mall A',
      'SHAD64',
      '2026-05-01',
      '2026-05-31',
      'standard',
    ];
    const keyLock = sqlQuery(db.executed[0]);
    const identityLock = sqlQuery(db.executed[1]);
    const activeQuery = db.selectWheres
      .map(sqlQuery)
      .find((query) => query.params.includes('confirmed'));
    expect(CONFIRMATION_KEY_LOCK_NAMESPACE).not.toBe(
      BILL_IDENTITY_LOCK_NAMESPACE,
    );
    expect(keyLock.sql).toContain('pg_advisory_xact_lock($1, hashtext($2))');
    expect(keyLock.params).toEqual([
      CONFIRMATION_KEY_LOCK_NAMESPACE,
      input().confirmationKey,
    ]);
    expect(identityLock.sql).toContain(
      'pg_advisory_xact_lock($1, hashtext($2))',
    );
    expect(identityLock.params).toEqual([
      BILL_IDENTITY_LOCK_NAMESPACE,
      JSON.stringify(identity),
    ]);
    expect(activeQuery?.params).toEqual(
      expect.arrayContaining([...identity, 'confirmed']),
    );
    expect(db.updates[0]).toMatchObject({ status: 'superseded' });
    expect(sqlQuery(db.updates[0].where as SQL).params).toContain('old-id');
    expect(db.events.indexOf('bill:update')).toBeLessThan(
      db.events.indexOf('bill:insert'),
    );
    expect(db.billInserts[0].version).toBe(2);
    expect(created.bill.version).toBe(2);
  });

  it('allocates from the highest historical version when no confirmed row is active', async () => {
    const db = new DatabaseDouble();
    db.highestHistorical = { id: 'revoked-id', version: 3 };
    const service = createService(db);

    const created = await service.confirm(input());

    const historyQuery = db.selectWheres
      .map(sqlQuery)
      .find(
        (query) =>
          !query.params.includes('confirmed') &&
          query.params.includes('Mall A'),
      );
    expect(historyQuery?.params).toEqual(
      expect.arrayContaining([
        'Mall A',
        'SHAD64',
        '2026-05-01',
        '2026-05-31',
        'standard',
      ]),
    );
    expect(sqlQuery(db.selectOrders[0][0] as SQL).sql).toContain('desc');
    expect(db.selectLimits).toContain(1);
    expect(db.updates).toHaveLength(0);
    expect(db.billInserts[0].version).toBe(4);
    expect(created.bill.version).toBe(4);
  });

  it('captures the confirmation time only after the advisory lock is acquired', async () => {
    const db = new DatabaseDouble();
    const service = createService(db);
    const originalToISOString = Date.prototype.toISOString;
    const clock = jest
      .spyOn(Date.prototype, 'toISOString')
      .mockImplementation(function (this: Date) {
        expect(db.events).toContain('lock');
        return originalToISOString.call(this);
      });

    try {
      await service.confirm(input());
    } finally {
      clock.mockRestore();
    }
  });

  // This double verifies the service's transaction boundary. Real PostgreSQL
  // lock contention and rollback behavior are exercised after migration in Task 7.
  it('rolls back superseding and all inserts when a detail write fails', async () => {
    const db = new DatabaseDouble();
    db.existingActive = { id: 'old-id', version: 1 };
    db.highestHistorical = { id: 'old-id', version: 1 };
    db.failOn = 'fee:insert';
    const service = new ConfirmedSettlementService(db as never);

    await expect(service.confirm(input())).rejects.toThrow(
      'forced fee:insert failure',
    );

    expect(db.events).toContain('transaction:rollback');
    expect(db.events).not.toContain('transaction:commit');
    expect(db.updates).toHaveLength(0);
    expect(db.billInserts).toHaveLength(0);
    expect(db.salesInserts).toHaveLength(0);
    expect(db.feeInserts).toHaveLength(0);
    expect(db.dynamicInserts).toHaveLength(0);
    expect(db.reviewAuditInserts).toHaveLength(0);
  });

  it('uses the configured demo operator and normalizes duplicate model sequences', async () => {
    const previousOperator = process.env.DEMO_OPERATOR_NAME;
    process.env.DEMO_OPERATOR_NAME = 'Finance Reviewer';
    const db = new DatabaseDouble();
    const service = createService(db);

    try {
      await service.confirm(input());
    } finally {
      if (previousOperator === undefined) delete process.env.DEMO_OPERATOR_NAME;
      else process.env.DEMO_OPERATOR_NAME = previousOperator;
    }

    expect(db.billInserts[0].confirmedBy).toBe('Finance Reviewer');
    expect(db.salesInserts.map((row) => row.sequence)).toEqual([1, 2]);
    expect(db.feeInserts.map((row) => row.sequence)).toEqual([1, 2]);
  });

  it('falls back to Demo Operator', async () => {
    const previousOperator = process.env.DEMO_OPERATOR_NAME;
    delete process.env.DEMO_OPERATOR_NAME;
    const db = new DatabaseDouble();
    const service = createService(db);

    try {
      await service.confirm(input());
    } finally {
      if (previousOperator !== undefined)
        process.env.DEMO_OPERATOR_NAME = previousOperator;
    }

    expect(db.billInserts[0].confirmedBy).toBe('Demo Operator');
  });

  it('lists only confirmed versions by default with filters, descending order, and a cap', async () => {
    const db = new DatabaseDouble();
    db.bills = [
      { id: 'active', status: 'confirmed' } as BillRow,
      { id: 'old', status: 'superseded' } as BillRow,
    ];
    const service = new ConfirmedSettlementService(db as never);

    const rows = await service.list({
      storeCode: 'SHAD64',
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
    });

    const query = sqlQuery(db.selectWheres.at(-1)!);
    expect(query.params).toEqual(
      expect.arrayContaining([
        'confirmed',
        'SHAD64',
        '2026-05-01',
        '2026-05-31',
      ]),
    );
    expect(rows.map((row) => row.id)).toEqual(['active']);
    expect(db.selectOrders.at(-1)).toHaveLength(2);
    expect(db.selectLimits.at(-1)).toBe(200);
  });

  it('omits the status predicate when history is requested', async () => {
    const db = new DatabaseDouble();
    const service = new ConfirmedSettlementService(db as never);

    await service.list({ includeHistory: true });

    expect(db.selectWheres).toHaveLength(0);
  });

  it('orders persisted lines by sequence and reconstructs detail payloads', async () => {
    const db = new DatabaseDouble();
    const fixture = input();
    db.bills = [
      {
        id: 'bill-id',
        reviewedFields: fixture.reviewedFields,
        extractionPayload: fixture.extraction,
      } as BillRow,
    ];
    db.salesRows = [
      {
        id: 'sale-id',
        billId: 'bill-id',
        sequence: 1,
        label: 'Sales one',
        rowType: 'detail',
        values: { amount: '100.00' },
        rawText: 'sales one',
        sourcePage: 1,
        confidence: '0.9800',
      },
    ];
    db.feeRows = [
      {
        id: 'fee-id',
        billId: 'bill-id',
        sequence: 1,
        label: 'Fee one',
        rowType: 'detail',
        values: { amount: '5.00' },
        rawText: 'fee one',
        sourcePage: 2,
        confidence: '0.9600',
      },
    ];
    db.dynamicRows = [
      {
        id: 'dynamic-id',
        billId: 'bill-id',
        sequence: 1,
        section: 'Adjustment table',
        label: 'Adjustment one',
        rowType: 'adjustment',
        values: { amount: '-3.00' },
        rawText: 'adjustment one',
        sourcePage: 3,
        confidence: '0.9100',
      },
    ];
    db.reviewAuditRows = [
      {
        id: 'audit-id',
        billId: 'bill-id',
        issueCount: 1,
        issues: [
          {
            code: 'recognition_warning',
            severity: 'blocking',
            message: 'Needs review',
          },
        ],
        manualEditCount: 0,
        manualEdits: [],
        acknowledgementRequired: true,
        acknowledgedByClient: true,
        acknowledgementNote: 'reviewed',
        createdAt: '2026-07-31T00:00:00.000Z',
      },
    ];
    const service = new ConfirmedSettlementService(db as never);

    const detail = await service.getById('bill-id');

    expect(db.selectOrders).toHaveLength(3);
    expect(detail.reviewedFields).toBe(fixture.reviewedFields);
    expect(detail.extraction).toBe(fixture.extraction);
    expect(detail.salesLines[0]).toMatchObject({
      section: '商品销售明细',
      sequence: 1,
      confidence: 0.98,
    });
    expect(detail.feeLines[0]).toMatchObject({
      section: '扣款费用明细',
      sequence: 1,
      confidence: 0.96,
    });
    expect(detail.dynamicLines[0]).toMatchObject({
      section: 'Adjustment table',
      sequence: 1,
      confidence: 0.91,
    });
    expect(detail.reviewAudit).toMatchObject({
      issueCount: 1,
      acknowledgementRequired: true,
      acknowledgementNote: 'reviewed',
    });
  });

  it('throws when a requested bill does not exist', async () => {
    const service = new ConfirmedSettlementService(
      new DatabaseDouble() as never,
    );

    await expect(service.getById('missing')).rejects.toThrow('not found');
  });
});
