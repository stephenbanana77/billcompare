import { Injectable } from '@nestjs/common';
import type {
  ConfirmedSettlementBill,
  SettlementAnalysisBill,
  SettlementAnalysisDetail,
  SettlementAnalysisFilters,
  SettlementAnalysisSummary,
  SettlementFeeAnalysisLine,
  SettlementFeeAnalysisResult,
  VisionLineItem,
} from '@shared/reconciliation';
import { ConfirmedSettlementService } from './confirmed-settlement.service';

const defaultLimit = 200;
const maxLimit = 200;

@Injectable()
export class SettlementAnalysisService {
  constructor(
    private readonly confirmedSettlementService: ConfirmedSettlementService,
  ) {}

  async listBills(
    filters: SettlementAnalysisFilters = {},
  ): Promise<SettlementAnalysisBill[]> {
    const candidates = await this.confirmedSettlementService.list({
      storeCode: filters.storeCode,
      includeHistory: false,
    });
    return this.filterBills(candidates, filters)
      .slice(0, normalizeLimit(filters.limit))
      .map(toAnalysisBill);
  }

  async getDetail(id: string): Promise<SettlementAnalysisDetail> {
    const detail = await this.confirmedSettlementService.getById(id);
    return {
      bill: toAnalysisBill(detail.bill),
      reviewedFields: detail.reviewedFields,
      metadata: detail.extraction.metadata,
      warnings: detail.extraction.warnings,
      salesLines: detail.salesLines,
      feeLines: detail.feeLines,
      dynamicLines: detail.dynamicLines,
      reviewAudit: detail.reviewAudit,
    };
  }

  async summarize(
    filters: SettlementAnalysisFilters = {},
  ): Promise<SettlementAnalysisSummary> {
    const bills = await this.listBills(filters);

    return {
      filters: normalizeFilters(filters),
      billCount: bills.length,
      periodStart: minText(bills.map((bill) => bill.periodStart)),
      periodEnd: maxText(bills.map((bill) => bill.periodEnd)),
      totals: {
        salesAmount: toMoneyString(sumMoney(bills, 'salesAmount')),
        invoiceAmount: toMoneyString(sumMoney(bills, 'invoiceAmount')),
        deductionTotal: toMoneyString(sumMoney(bills, 'deductionTotal')),
        settlementAmount: toMoneyString(sumMoney(bills, 'settlementAmount')),
      },
      bills,
      generatedAt: new Date().toISOString(),
    };
  }

  async analyzeFees(
    filters: SettlementAnalysisFilters = {},
  ): Promise<SettlementFeeAnalysisResult> {
    const bills = await this.listBills(filters);
    const details = await Promise.all(
      bills.map((bill) => this.confirmedSettlementService.getById(bill.id)),
    );
    const byLabel = new Map<
      string,
      { amount: number; billIds: Set<string>; lines: SettlementFeeAnalysisLine[] }
    >();

    for (const detail of details) {
      for (const line of detail.feeLines) {
        if (!['detail', 'adjustment'].includes(line.rowType ?? 'detail')) {
          continue;
        }
        const amount = extractLineAmount(line);
        if (amount === null) continue;
        const label = line.label.trim() || 'Unlabeled fee';
        const current =
          byLabel.get(label) ?? { amount: 0, billIds: new Set(), lines: [] };
        current.amount += amount;
        current.billIds.add(detail.bill.id);
        current.lines.push({
          billId: detail.bill.id,
          periodStart: detail.bill.periodStart,
          periodEnd: detail.bill.periodEnd,
          mallName: detail.bill.mallName,
          storeCode: detail.bill.storeCode,
          storeName: detail.bill.storeName,
          label,
          amount: toMoneyString(amount),
          rawText: line.rawText,
          page: line.page,
          confidence: line.confidence,
        });
        byLabel.set(label, current);
      }
    }

    const items = Array.from(byLabel.entries())
      .map(([label, item]) => ({
        label,
        amount: toMoneyString(item.amount),
        billCount: item.billIds.size,
        lineCount: item.lines.length,
        lines: item.lines,
      }))
      .sort((left, right) => Number(right.amount) - Number(left.amount));

    return {
      filters: normalizeFilters(filters),
      billCount: bills.length,
      totalFeeAmount: toMoneyString(
        items.reduce((sum, item) => sum + Number(item.amount), 0),
      ),
      items,
      generatedAt: new Date().toISOString(),
    };
  }

  private filterBills(
    bills: ConfirmedSettlementBill[],
    filters: SettlementAnalysisFilters,
  ) {
    return bills.filter((bill) => {
      if (filters.mallName && bill.mallName !== filters.mallName) return false;
      if (filters.periodStart && bill.periodEnd < filters.periodStart) {
        return false;
      }
      if (filters.periodEnd && bill.periodStart > filters.periodEnd) {
        return false;
      }
      return true;
    });
  }
}

function toAnalysisBill(
  bill: ConfirmedSettlementBill,
): SettlementAnalysisBill {
  const { confirmationKey: _confirmationKey, ...analysisBill } = bill;
  return analysisBill;
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit) || !limit || limit < 1) return defaultLimit;
  return Math.min(limit, maxLimit);
}

function normalizeFilters(
  filters: SettlementAnalysisFilters,
): SettlementAnalysisFilters {
  return {
    mallName: filters.mallName,
    storeCode: filters.storeCode,
    periodStart: filters.periodStart,
    periodEnd: filters.periodEnd,
    limit: normalizeLimit(filters.limit),
  };
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function sumMoney<T extends Record<string, unknown>>(
  rows: T[],
  key: keyof T,
): number {
  return rows.reduce((sum, row) => sum + toNumber(row[key] as string), 0);
}

function toMoneyString(value: number): string {
  return value.toFixed(2);
}

function minText(values: string[]): string | null {
  return values.length ? values.reduce((left, right) => (left < right ? left : right)) : null;
}

function maxText(values: string[]): string | null {
  return values.length ? values.reduce((left, right) => (left > right ? left : right)) : null;
}

function extractLineAmount(line: VisionLineItem): number | null {
  const preferredKeys = [
    'amount',
    'feeAmount',
    'deductionAmount',
    'netAmount',
    '金额',
    '费用金额',
    '扣款金额',
    '实扣金额',
    '小计',
    '合计',
  ];
  for (const key of preferredKeys) {
    const amount = parseMaybeMoney(line.values[key]);
    if (amount !== null) return amount;
  }

  for (const [key, value] of Object.entries(line.values)) {
    if (/rate|ratio|percent|率|日期|数量|qty|code/i.test(key)) continue;
    const amount = parseMaybeMoney(value);
    if (amount !== null) return amount;
  }
  return null;
}

function parseMaybeMoney(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}
