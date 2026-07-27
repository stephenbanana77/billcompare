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

const invalidMoney = (target: string): never => {
  throw new BadRequestException(
    `${target} must be a valid numeric(16,2) amount`,
  );
};

const money = (value: unknown, target: string): string | null => {
  if (value === null || value === undefined || text(value) === '') return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value * 100)) {
      return invalidMoney(target);
    }

    const formatted = value.toFixed(2);
    const integerDigits = formatted.replace(/^-/, '').split('.')[0].length;
    if (integerDigits > 14) return invalidMoney(target);
    return formatted;
  }

  const match = text(value).match(
    /^(-?)(?:(\d+)|(\d{1,3}(?:,\d{3})+))(?:\.(\d{1,2}))?$/,
  );
  if (!match) return invalidMoney(target);

  const sign = match[1];
  const integer = (match[2] ?? match[3])
    .replace(/,/g, '')
    .replace(/^0+(?=\d)/, '');
  const fraction = (match[4] ?? '').padEnd(2, '0');
  if (integer.length > 14) return invalidMoney(target);

  return `${sign}${integer}.${fraction}`;
};

const requiredMoney = (value: unknown, target: string): string => {
  const normalized = money(value, target);
  if (normalized === null) {
    throw new BadRequestException(`${target} is required`);
  }
  return normalized;
};

const calendarDate = (value: unknown, target: string): string => {
  const normalized = text(value);
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new BadRequestException(`${target} must be a valid YYYY-MM-DD date`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  if (
    year === 0 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]
  ) {
    throw new BadRequestException(`${target} must be a valid YYYY-MM-DD date`);
  }

  return normalized;
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
  const periodStart = calendarDate(value('periodStart'), 'periodStart');
  const periodEnd = calendarDate(value('periodEnd'), 'periodEnd');
  if (periodStart > periodEnd) {
    throw new BadRequestException('periodStart must not be after periodEnd');
  }

  const reviewedFields = structuredClone(input.reviewedFields);
  const extractionPayload = structuredClone(input.extraction);

  return {
    bill: {
      sourceFileName,
      mallName: text(value('mallName')),
      storeName: text(value('storeName')),
      storeCode: text(value('storeCode')),
      periodStart,
      periodEnd,
      billType: input.extraction.metadata.billType,
      settlementNo: text(value('settlementNo')) || null,
      salesAmount: requiredMoney(value('salesAmount'), 'salesAmount'),
      invoiceAmount: money(value('invoiceAmount'), 'invoiceAmount'),
      deductionTotal: money(value('deductionTotal'), 'deductionTotal'),
      settlementAmount: requiredMoney(
        value('settlementAmount'),
        'settlementAmount',
      ),
      ocrVerified: Boolean(input.ocrVerified),
      reviewedFields,
      extractionPayload,
    },
    salesLines: extractionPayload.lineItems.filter(isSalesLine),
    feeLines: extractionPayload.lineItems.filter(isFeeLine),
  };
};
