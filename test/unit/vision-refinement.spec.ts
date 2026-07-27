import {
  collectVisionRefinementCandidates,
  indexVisionRefinements,
} from '../../shared/vision-refinement';
import type { VisionExtractionResult } from '../../shared/reconciliation';

const result = {
  evidence: {
    salesAmount: { value: 100, rawText: '销售金额 100.00', page: 1, confidence: 0.95 },
    deductionTotal: { value: 20, rawText: '扣费合计 20.00', page: 1, confidence: 0.72 },
  },
  additionalFields: [
    { label: '结算日期', value: '2026-05-31', rawText: '结算日期 2026-05-31', page: 1, confidence: 0.8 },
  ],
  lineItems: [
    { section: '扣费明细', label: '管理费', values: { 金额: 20 }, rawText: '管理费 20.00', page: 1, confidence: 0.88 },
  ],
} as unknown as VisionExtractionResult;

describe('vision refinement helpers', () => {
  it('collects only low-confidence visible fields with stable ids', () => {
    expect(collectVisionRefinementCandidates(result, 0.9)).toEqual([
      expect.objectContaining({ id: 'field:deductionTotal', value: 20, page: 1 }),
      expect.objectContaining({ id: 'additional:0', value: '2026-05-31', page: 1 }),
      expect.objectContaining({ id: 'line:0', value: { 金额: 20 }, page: 1 }),
    ]);
  });

  it('indexes confirmations and conflicts without choosing the second value', () => {
    const indexed = indexVisionRefinements({
      items: [
        { id: 'field:deductionTotal', value: 20, rawText: '20.00', confidence: 0.98, status: 'confirmed' },
        { id: 'line:0', value: { 金额: 28 }, rawText: '28.00', confidence: 0.99, status: 'conflict' },
      ],
    });

    expect(indexed['field:deductionTotal']?.status).toBe('confirmed');
    expect(indexed['line:0']?.status).toBe('conflict');
    expect(indexed['line:0']?.value).toEqual({ 金额: 28 });
  });
});
