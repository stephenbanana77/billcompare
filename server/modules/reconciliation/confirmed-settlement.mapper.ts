import { BadRequestException } from '@nestjs/common';
import type {
  ConfirmSettlementBillInput,
  ConfirmedFieldValue,
  VisionLineItem,
} from '../../../shared/reconciliation';

const requiredTargets = [
  'mallName',
  'storeName',
  'storeCode',
  'periodStart',
  'periodEnd',
  'salesAmount',
  'settlementAmount',
] as const;

const text = (value: unknown): string => String(value ?? '').trim();

const money = (value: unknown, target: string): string | null => {
  const normalized = text(value).replace(/[,\s]/g, '');
  if (!normalized) return null;

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    throw new BadRequestException(`${target} must be numeric`);
  }

  return parsed.toFixed(2);
};

const indexReviewedFields = (fields: ConfirmedFieldValue[]) => {
  const reviewed = new Map<string, ConfirmedFieldValue>();

  for (const field of fields) {
    const target = text(field.target);
    if (!target) continue;
    if (reviewed.has(target)) {
      throw new BadRequestException(`duplicate reviewed target: ${target}`);
    }
    reviewed.set(target, field);
  }

  for (const target of requiredTargets) {
    if (!text(reviewed.get(target)?.value)) {
      throw new BadRequestException(`missing reviewed target: ${target}`);
    }
  }

  return reviewed;
};

const isSalesLine = (line: VisionLineItem): boolean =>
  line.section.includes('销售');
const isFeeLine = (line: VisionLineItem): boolean =>
  line.section.includes('费用');

export const mapConfirmedSettlement = (input: ConfirmSettlementBillInput) => {
  const sourceFileName = text(input.fileName);
  if (!sourceFileName) {
    throw new BadRequestException('fileName is required');
  }

  const reviewed = indexReviewedFields(input.reviewedFields);
  const value = (target: string) => reviewed.get(target)?.value;

  return {
    bill: {
      sourceFileName,
      mallName: text(value('mallName')),
      storeName: text(value('storeName')),
      storeCode: text(value('storeCode')),
      periodStart: text(value('periodStart')),
      periodEnd: text(value('periodEnd')),
      billType: input.extraction.metadata.billType,
      settlementNo: text(value('settlementNo')) || null,
      salesAmount: money(value('salesAmount'), 'salesAmount')!,
      invoiceAmount: money(value('invoiceAmount'), 'invoiceAmount'),
      deductionTotal: money(value('deductionTotal'), 'deductionTotal'),
      settlementAmount: money(value('settlementAmount'), 'settlementAmount')!,
      ocrVerified: Boolean(input.ocrVerified),
      reviewedFields: input.reviewedFields,
      extractionPayload: input.extraction,
    },
    salesLines: input.extraction.lineItems.filter(isSalesLine),
    feeLines: input.extraction.lineItems.filter(isFeeLine),
  };
};
