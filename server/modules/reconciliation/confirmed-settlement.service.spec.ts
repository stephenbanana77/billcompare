import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableName, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { ConfirmSettlementBillInput } from '../../../shared/reconciliation';
import {
  reconciliationConfirmedBills,
  reconciliationConfirmedFeeLines,
  reconciliationConfirmedSalesLines,
} from '../../database/reconciliation.schema';
import { ConfirmedSettlementService } from './confirmed-settlement.service';

const columnNames = (columns: Array<{ name?: string }>) =>
  columns.map((column) => column.name);

const migration = readFileSync(
  join(process.cwd(), 'migrations/007_confirmed_settlement_bills.sql'),
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
  ocrVerified: true,
});

type BillRow = typeof reconciliationConfirmedBills.$inferSelect;

const sqlQuery = (expression: SQL) => new PgDialect().sqlToQuery(expression);

class DatabaseDouble {
  readonly events: string[] = [];
  readonly executed: SQL[] = [];
  readonly billInserts: Array<Record<string, unknown>> = [];
  readonly salesInserts: Array<Record<string, unknown>> = [];
  readonly feeInserts: Array<Record<string, unknown>> = [];
  readonly updates: Array<Record<string, unknown>> = [];
  readonly selectWheres: SQL[] = [];
  readonly selectOrders: unknown[][] = [];
  readonly selectLimits: number[] = [];
  existingActive: Pick<BillRow, 'id' | 'version'> | undefined;
  bills: BillRow[] = [];
  salesRows: Array<typeof reconciliationConfirmedSalesLines.$inferSelect> = [];
  feeRows: Array<typeof reconciliationConfirmedFeeLines.$inferSelect> = [];
  transaction = jest.fn(
    async (callback: (tx: DatabaseDouble) => Promise<string>) => {
      this.events.push('transaction:start');
      const result = await callback(this);
      this.events.push('transaction:commit');
      return result;
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
        }
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
      if (query?.params.includes('confirmed')) {
        if (this.existingActive) return [this.existingActive];
        return this.bills.filter((bill) => bill.status === 'confirmed');
      }
      return this.bills;
    }
    if (table === reconciliationConfirmedSalesLines) return this.salesRows;
    if (table === reconciliationConfirmedFeeLines) return this.feeRows;
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
  });

  it.each([
    [
      'sales',
      reconciliationConfirmedSalesLines,
      'uq_confirmed_sales_bill_sequence',
    ],
    ['fee', reconciliationConfirmedFeeLines, 'uq_confirmed_fee_bill_sequence'],
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
    for (const event of ['bill:insert', 'sales:insert', 'fee:insert']) {
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

  it('maps and validates input before opening a transaction', async () => {
    const db = new DatabaseDouble();
    const service = new ConfirmedSettlementService(db as never);
    const invalid = input();
    invalid.fileName = '   ';

    await expect(service.confirm(invalid)).rejects.toThrow('fileName');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('locks the full logical identity and supersedes V1 before inserting V2', async () => {
    const db = new DatabaseDouble();
    db.existingActive = { id: 'old-id', version: 1 };
    const service = createService(db);

    const created = await service.confirm(input());

    const identity = [
      'Mall A',
      'SHAD64',
      '2026-05-01',
      '2026-05-31',
      'standard',
    ];
    const lock = sqlQuery(db.executed[0]);
    const activeQuery = db.selectWheres
      .map(sqlQuery)
      .find((query) => query.params.includes('confirmed'));
    expect(lock.sql).toContain('pg_advisory_xact_lock');
    expect(lock.params).toContain(JSON.stringify(identity));
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
    const service = new ConfirmedSettlementService(db as never);

    const detail = await service.getById('bill-id');

    expect(db.selectOrders).toHaveLength(2);
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
  });

  it('throws when a requested bill does not exist', async () => {
    const service = new ConfirmedSettlementService(
      new DatabaseDouble() as never,
    );

    await expect(service.getById('missing')).rejects.toThrow('not found');
  });
});
