import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import type {
  ConfirmSettlementBillInput,
  ConfirmedSettlementBill,
  ConfirmedSettlementDetail,
  SettlementManualEdit,
  SettlementReviewAudit,
  SettlementReviewIssue,
  VisionExtractionResult,
  VisionLineItem,
} from '../../../shared/reconciliation';
import {
  reconciliationConfirmedBills,
  reconciliationConfirmedDynamicLines,
  reconciliationConfirmedFeeLines,
  reconciliationConfirmedReviewAudits,
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
  | typeof reconciliationConfirmedFeeLines.$inferSelect
  | typeof reconciliationConfirmedDynamicLines.$inferSelect;

type BillIdentity = Pick<
  typeof reconciliationConfirmedBills.$inferSelect,
  'mallName' | 'storeCode' | 'periodStart' | 'periodEnd' | 'billType'
>;

export const CONFIRMATION_KEY_LOCK_NAMESPACE = 0x434f4e46; // "CONF"
export const BILL_IDENTITY_LOCK_NAMESPACE = 0x42494c4c; // "BILL"

@Injectable()
export class ConfirmedSettlementService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async confirm(
    input: ConfirmSettlementBillInput,
  ): Promise<ConfirmedSettlementDetail> {
    const mapped = mapConfirmedSettlement(input);
    const reviewAudit = buildReviewAudit(input);
    if (
      reviewAudit.acknowledgementRequired &&
      !reviewAudit.acknowledgedByClient
    ) {
      throw new BadRequestException(
        'qualityReview acknowledgement is required before confirming a settlement with review issues',
      );
    }
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
        sql`select 1 as locked from pg_advisory_xact_lock(${CONFIRMATION_KEY_LOCK_NAMESPACE}, hashtext(${mapped.bill.confirmationKey}))`,
      );
      const [existingConfirmation] = await tx
        .select({
          id: reconciliationConfirmedBills.id,
          mallName: reconciliationConfirmedBills.mallName,
          storeCode: reconciliationConfirmedBills.storeCode,
          periodStart: reconciliationConfirmedBills.periodStart,
          periodEnd: reconciliationConfirmedBills.periodEnd,
          billType: reconciliationConfirmedBills.billType,
        })
        .from(reconciliationConfirmedBills)
        .where(
          eq(
            reconciliationConfirmedBills.confirmationKey,
            mapped.bill.confirmationKey,
          ),
        )
        .limit(1);
      if (existingConfirmation) {
        if (!this.hasSameIdentity(existingConfirmation, mapped.bill)) {
          throw new ConflictException(
            'confirmationKey already belongs to a different confirmed settlement identity',
          );
        }
        return existingConfirmation.id;
      }

      await tx.execute(
        sql`select 1 as locked from pg_advisory_xact_lock(${BILL_IDENTITY_LOCK_NAMESPACE}, hashtext(${identityKey}))`,
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

      const dynamicLines = this.dynamicLineValues(billId, mapped.dynamicLines);
      if (dynamicLines.length) {
        await tx
          .insert(reconciliationConfirmedDynamicLines)
          .values(dynamicLines);
      }

      await tx.insert(reconciliationConfirmedReviewAudits).values({
        id: randomUUID(),
        billId,
        ...reviewAudit,
        createdAt: confirmedAt,
      });

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

    const [salesRows, feeRows, dynamicRows, reviewRows] = await Promise.all([
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
      this.db
        .select()
        .from(reconciliationConfirmedDynamicLines)
        .where(eq(reconciliationConfirmedDynamicLines.billId, id))
        .orderBy(asc(reconciliationConfirmedDynamicLines.sequence)),
      this.db
        .select()
        .from(reconciliationConfirmedReviewAudits)
        .where(eq(reconciliationConfirmedReviewAudits.billId, id))
        .limit(1),
    ]);

    return {
      bill: this.toBill(bill),
      reviewedFields: bill.reviewedFields,
      extraction: bill.extractionPayload,
      salesLines: this.restoreLines(salesRows, bill.extractionPayload, 'sales'),
      feeLines: this.restoreLines(feeRows, bill.extractionPayload, 'fee'),
      dynamicLines: dynamicRows.length
        ? this.restoreDynamicLines(dynamicRows)
        : bill.extractionPayload.lineItems,
      reviewAudit: reviewRows[0]
        ? this.toReviewAudit(reviewRows[0])
        : undefined,
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

  private dynamicLineValues(billId: string, lines: VisionLineItem[]) {
    return lines.map((line, index) => ({
      id: randomUUID(),
      billId,
      sequence: index + 1,
      section: line.section,
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

  private hasSameIdentity(left: BillIdentity, right: BillIdentity): boolean {
    return (
      left.mallName === right.mallName &&
      left.storeCode === right.storeCode &&
      left.periodStart === right.periodStart &&
      left.periodEnd === right.periodEnd &&
      left.billType === right.billType
    );
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

  private restoreDynamicLines(rows: StoredLine[]): VisionLineItem[] {
    return rows.map((row) => ({
      section: 'section' in row ? row.section : '',
      label: row.label,
      rowType: row.rowType as VisionLineItem['rowType'],
      sequence: row.sequence,
      values: row.values,
      rawText: row.rawText,
      page: row.sourcePage,
      confidence: row.confidence === null ? null : Number(row.confidence),
    }));
  }

  private toReviewAudit(
    row: typeof reconciliationConfirmedReviewAudits.$inferSelect,
  ): SettlementReviewAudit {
    return {
      issueCount: row.issueCount,
      issues: row.issues,
      manualEditCount: row.manualEditCount,
      manualEdits: row.manualEdits,
      acknowledgementRequired: row.acknowledgementRequired,
      acknowledgedByClient: row.acknowledgedByClient,
      acknowledgementNote: row.acknowledgementNote,
      createdAt: row.createdAt,
    };
  }
}

const normalizeReviewValue = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  return String(value).trim();
};

const sourceValueForTarget = (
  extraction: VisionExtractionResult,
  target: string,
): string | number | null | undefined => {
  if (target in extraction.metadata) {
    return extraction.metadata[target as keyof VisionExtractionResult['metadata']];
  }
  const evidenceValue =
    extraction.evidence[target as keyof VisionExtractionResult['evidence']]
      ?.value;
  if (evidenceValue !== undefined) return evidenceValue;
  const additional = extraction.additionalFields.find(
    (field) => field.suggestedTarget === target,
  );
  return additional?.value;
};

const buildReviewAudit = (
  input: ConfirmSettlementBillInput,
): Omit<SettlementReviewAudit, 'createdAt'> => {
  const issues: SettlementReviewIssue[] = [];
  for (const warning of input.extraction.warnings) {
    if (warning.trim()) {
      issues.push({
        code: 'recognition_warning',
        severity: 'blocking',
        message: warning,
      });
    }
  }
  for (const check of input.extraction.formulaChecks ?? []) {
    if (check.status === 'passed') continue;
    issues.push({
      code: `formula_${check.status}`,
      severity: 'blocking',
      message: `${check.label}: ${check.expression}`,
      fieldId: check.id,
    });
  }

  const manualEdits: SettlementManualEdit[] = [];
  for (const field of input.reviewedFields) {
    const target = field.target.trim();
    if (!target) continue;
    const originalValue = sourceValueForTarget(input.extraction, target);
    if (originalValue === undefined) continue;
    if (
      normalizeReviewValue(originalValue) !== normalizeReviewValue(field.value)
    ) {
      manualEdits.push({
        target,
        label: field.label,
        originalValue,
        reviewedValue: field.value,
      });
    }
  }

  const note = input.qualityReview?.note?.trim() || null;
  return {
    issueCount: issues.length,
    issues,
    manualEditCount: manualEdits.length,
    manualEdits,
    acknowledgementRequired: issues.length > 0,
    acknowledgedByClient: Boolean(input.qualityReview?.acknowledged),
    acknowledgementNote: note,
  };
};
