import { getTableName } from 'drizzle-orm';
import {
  reconciliationConfirmedBills,
  reconciliationConfirmedFeeLines,
  reconciliationConfirmedSalesLines,
} from '../../database/reconciliation.schema';

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
});
