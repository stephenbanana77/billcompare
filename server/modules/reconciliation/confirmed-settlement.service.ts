import { randomUUID } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import type {
  ConfirmSettlementBillInput,
  ConfirmedSettlementBill,
  ConfirmedSettlementDetail,
  VisionExtractionResult,
  VisionLineItem,
} from '../../../shared/reconciliation';
import {
  reconciliationConfirmedBills,
  reconciliationConfirmedFeeLines,
  reconciliationConfirmedSalesLines,
} from '../../database/reconciliation.schema';
import { mapConfirmedSettlement } from './confirmed-settlement.mapper';

export interface ConfirmedSettlementListFilters {
  storeCode?: string;
  periodStart?: string;
  periodEnd?: string;
  includeHistory?: boolean;
}

type StoredLine =
  | typeof reconciliationConfirmedSalesLines.$inferSelect
  | typeof reconciliationConfirmedFeeLines.$inferSelect;

@Injectable()
export class ConfirmedSettlementService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async confirm(
    input: ConfirmSettlementBillInput,
  ): Promise<ConfirmedSettlementDetail> {
    const mapped = mapConfirmedSettlement(input);
    const identity = [
      mapped.bill.mallName,
      mapped.bill.storeCode,
      mapped.bill.periodStart,
      mapped.bill.periodEnd,
      mapped.bill.billType,
    ];
    const identityKey = JSON.stringify(identity);

    const id = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select 1 as locked from pg_advisory_xact_lock(hashtext(${identityKey}))`,
      );
      const confirmedAt = new Date().toISOString();
      const identityConditions = [
        eq(reconciliationConfirmedBills.mallName, mapped.bill.mallName),
        eq(reconciliationConfirmedBills.storeCode, mapped.bill.storeCode),
        eq(reconciliationConfirmedBills.periodStart, mapped.bill.periodStart),
        eq(reconciliationConfirmedBills.periodEnd, mapped.bill.periodEnd),
        eq(reconciliationConfirmedBills.billType, mapped.bill.billType),
      ];

      const [latest] = await tx
        .select({
          id: reconciliationConfirmedBills.id,
          version: reconciliationConfirmedBills.version,
        })
        .from(reconciliationConfirmedBills)
        .where(and(...identityConditions))
        .orderBy(desc(reconciliationConfirmedBills.version))
        .limit(1);

      const [current] = await tx
        .select({
          id: reconciliationConfirmedBills.id,
          version: reconciliationConfirmedBills.version,
        })
        .from(reconciliationConfirmedBills)
        .where(
          and(
            ...identityConditions,
            eq(reconciliationConfirmedBills.status, 'confirmed'),
          ),
        );

      if (current) {
        await tx
          .update(reconciliationConfirmedBills)
          .set({ status: 'superseded', updatedAt: confirmedAt })
          .where(eq(reconciliationConfirmedBills.id, current.id));
      }

      const billId = randomUUID();
      await tx.insert(reconciliationConfirmedBills).values({
        id: billId,
        version: (latest?.version ?? 0) + 1,
        status: 'confirmed',
        ...mapped.bill,
        confirmedBy: process.env.DEMO_OPERATOR_NAME ?? 'Demo Operator',
        confirmedAt,
        createdAt: confirmedAt,
        updatedAt: confirmedAt,
      });

      const salesLines = this.lineValues(billId, mapped.salesLines);
      if (salesLines.length) {
        await tx.insert(reconciliationConfirmedSalesLines).values(salesLines);
      }

      const feeLines = this.lineValues(billId, mapped.feeLines);
      if (feeLines.length) {
        await tx.insert(reconciliationConfirmedFeeLines).values(feeLines);
      }

      return billId;
    });

    return this.getById(id);
  }

  async list(
    filters: ConfirmedSettlementListFilters = {},
  ): Promise<ConfirmedSettlementBill[]> {
    const conditions: SQL[] = [];
    if (!filters.includeHistory) {
      conditions.push(eq(reconciliationConfirmedBills.status, 'confirmed'));
    }
    if (filters.storeCode) {
      conditions.push(
        eq(reconciliationConfirmedBills.storeCode, filters.storeCode),
      );
    }
    if (filters.periodStart) {
      conditions.push(
        eq(reconciliationConfirmedBills.periodStart, filters.periodStart),
      );
    }
    if (filters.periodEnd) {
      conditions.push(
        eq(reconciliationConfirmedBills.periodEnd, filters.periodEnd),
      );
    }

    const baseQuery = this.db.select().from(reconciliationConfirmedBills);
    const filteredQuery = conditions.length
      ? baseQuery.where(and(...conditions))
      : baseQuery;
    const rows = await filteredQuery
      .orderBy(
        desc(reconciliationConfirmedBills.periodStart),
        desc(reconciliationConfirmedBills.periodEnd),
      )
      .limit(200);

    return rows.map((row) => this.toBill(row));
  }

  async getById(id: string): Promise<ConfirmedSettlementDetail> {
    const [bill] = await this.db
      .select()
      .from(reconciliationConfirmedBills)
      .where(eq(reconciliationConfirmedBills.id, id));
    if (!bill) {
      throw new NotFoundException(`confirmed settlement ${id} not found`);
    }

    const [salesRows, feeRows] = await Promise.all([
      this.db
        .select()
        .from(reconciliationConfirmedSalesLines)
        .where(eq(reconciliationConfirmedSalesLines.billId, id))
        .orderBy(asc(reconciliationConfirmedSalesLines.sequence)),
      this.db
        .select()
        .from(reconciliationConfirmedFeeLines)
        .where(eq(reconciliationConfirmedFeeLines.billId, id))
        .orderBy(asc(reconciliationConfirmedFeeLines.sequence)),
    ]);

    return {
      bill: this.toBill(bill),
      reviewedFields: bill.reviewedFields,
      extraction: bill.extractionPayload,
      salesLines: this.restoreLines(salesRows, bill.extractionPayload, 'sales'),
      feeLines: this.restoreLines(feeRows, bill.extractionPayload, 'fee'),
    };
  }

  private lineValues(billId: string, lines: VisionLineItem[]) {
    return lines.map((line, index) => ({
      id: randomUUID(),
      billId,
      sequence: index + 1,
      label: line.label,
      rowType: line.rowType ?? 'detail',
      values: line.values,
      rawText: line.rawText,
      sourcePage: line.page,
      confidence:
        typeof line.confidence === 'number' ? String(line.confidence) : null,
    }));
  }

  private toBill(
    row: typeof reconciliationConfirmedBills.$inferSelect,
  ): ConfirmedSettlementBill {
    const {
      reviewedFields: _reviewed,
      extractionPayload: _extraction,
      ...bill
    } = row;
    return {
      ...bill,
      billType: bill.billType as ConfirmedSettlementBill['billType'],
    };
  }

  private restoreLines(
    rows: StoredLine[],
    extraction: VisionExtractionResult,
    kind: 'sales' | 'fee',
  ): VisionLineItem[] {
    const candidates = extraction.lineItems.filter((line) =>
      kind === 'sales'
        ? line.section.includes('销售')
        : line.section.includes('费用'),
    );

    return rows.map((row, index) => ({
      section:
        candidates[index]?.section ??
        (kind === 'sales' ? '销售明细' : '费用明细'),
      label: row.label,
      rowType: row.rowType as VisionLineItem['rowType'],
      sequence: row.sequence,
      values: row.values,
      rawText: row.rawText,
      page: row.sourcePage,
      confidence: row.confidence === null ? null : Number(row.confidence),
    }));
  }
}
