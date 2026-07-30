import type { OcrExtractionResult, OcrTextBox } from '@shared/reconciliation';
import {
  addOcrLineItemFallback,
  lineItemsFromOcr,
} from '../../client/src/lib/ocr-line-item-fallback';

describe('OCR line-item fallback', () => {
  const box = (text: string, x: number, y: number): OcrTextBox => ({
    page: 1,
    text,
    score: 0.99,
    polygon: [
      [x, y],
      [x + 120, y],
      [x + 120, y + 24],
      [x, y + 24],
    ],
  });

  it('splits two-column fee pairs into atomic review rows', () => {
    const ocr = {
      pages: [
        {
          page: 1,
          width: 1600,
          height: 2400,
          boxes: [
            box('B.抽成调整及费用回收（不含税金额）', 10, 100),
            box('信用卡手续费', 10, 150),
            box('5,178.18 E-清洁费', 300, 150),
            box('100.00', 900, 150),
          ],
        },
      ],
    } as OcrExtractionResult;

    expect(lineItemsFromOcr(ocr)).toEqual([
      expect.objectContaining({
        section: 'OCR 复核 · B.抽成调整及费用回收（不含税金额）',
        label: '信用卡手续费',
        values: { 金额: '5,178.18' },
      }),
      expect.objectContaining({
        label: 'E-清洁费',
        values: { 金额: '100.00' },
      }),
    ]);
  });

  it('uses OCR rows only when visual line items are absent', () => {
    const ocr = {
      pages: [
        {
          page: 1,
          width: 1000,
          height: 1000,
          boxes: [box('月管理费', 10, 100), box('3,850.00', 200, 100)],
        },
      ],
    } as OcrExtractionResult;
    const extraction = {
      lineItems: [],
      warnings: [],
    } as never;

    const result = addOcrLineItemFallback(extraction, ocr);
    expect(result.lineItems).toHaveLength(1);
    expect(result.warnings).toContain(
      '视觉明细未返回完整格式，已展示 OCR 原文行作为复核证据，请逐项核对。',
    );
  });
});
