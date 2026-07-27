import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  reconciliationConfirmedBills,
  reconciliationConfirmedFeeLines,
  reconciliationConfirmedSalesLines,
} from '../../database/reconciliation.schema';

const columnNames = (columns: Array<{ name?: string }>) =>
  columns.map((column) => column.name);

const migration = readFileSync(
  join(process.cwd(), 'migrations/007_confirmed_settlement_bills.sql'),
  'utf8',
).replace(/\s+/g, ' ');

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
