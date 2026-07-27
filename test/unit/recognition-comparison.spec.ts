import {
  compareRecognitionValue,
  extractOcrKeyFields,
  normalizeOcrBox,
} from '../../server/modules/reconciliation/recognition-comparison';

describe('recognition comparison', () => {
  it('normalizes a valid OCR box with page and polygon evidence', () => {
    expect(normalizeOcrBox({
      page: 1,
      text: '5,650.47',
      score: 0.98,
      polygon: [[10, 20], [90, 20], [90, 45], [10, 45]],
    })).toEqual({
      page: 1,
      text: '5,650.47',
      score: 0.98,
      polygon: [[10, 20], [90, 20], [90, 45], [10, 45]],
    });
  });

  it('rejects OCR boxes without usable text or four finite points', () => {
    expect(normalizeOcrBox({ page: 1, text: ' ', score: 0.8, polygon: [] })).toBeNull();
    expect(normalizeOcrBox({ page: 1, text: '金额', score: 2, polygon: [[0, 0]] })).toBeNull();
  });

  it('confirms equivalent money and dates after typed normalization', () => {
    expect(compareRecognitionValue('money', '5,650.47', '5650.47')).toMatchObject({ status: 'confirmed' });
    expect(compareRecognitionValue('date', '2026年05月31日', '2026-05-31')).toMatchObject({ status: 'confirmed' });
  });

  it('preserves leading zeroes for identifiers and reports conflicts', () => {
    expect(compareRecognitionValue('identifier', '086203', '86203')).toMatchObject({ status: 'conflict' });
    expect(compareRecognitionValue('money', '5,650.47', '5,650.41')).toMatchObject({ status: 'conflict' });
  });

  it('reports either missing source as a blocking result', () => {
    expect(compareRecognitionValue('text', '', '阿迪达斯')).toMatchObject({ status: 'vision_missing', blocking: true });
    expect(compareRecognitionValue('text', '阿迪达斯', null)).toMatchObject({ status: 'ocr_missing', blocking: true });
  });

  it('extracts inline, right-hand and below-label values from OCR coordinates', () => {
    const box = (text: string, x1: number, y1: number, x2: number, y2: number) => ({
      page: 1, text, score: 0.99,
      polygon: [[x1, y1], [x2, y1], [x2, y2], [x1, y2]] as [[number, number], [number, number], [number, number], [number, number]],
    });
    const fields = extractOcrKeyFields([{ page: 1, width: 1000, height: 1000, boxes: [
      box('结算单号：ABC001', 10, 10, 200, 30),
      box('结算日期：', 500, 10, 600, 30),
      box('2026-05-31', 620, 10, 730, 30),
      box('销售金额', 200, 100, 300, 130),
      box('69843.00', 210, 145, 290, 170),
    ] }]);
    expect(fields.settlementNo?.value).toBe('ABC001');
    expect(fields.settlementDate?.value).toBe('2026-05-31');
    expect(fields.salesAmount?.value).toBe('69843.00');
    expect(fields.salesAmount?.evidence.text).toBe('69843.00');
  });

  it('prefers a repeated field inside the printed settlement-summary region', () => {
    const box = (text: string, x1: number, y1: number, x2: number, y2: number) => ({
      page: 1, text, score: 0.99,
      polygon: [[x1, y1], [x2, y1], [x2, y2], [x1, y2]] as [[number, number], [number, number], [number, number], [number, number]],
    });
    const fields = extractOcrKeyFields([{ page: 1, width: 1000, height: 1000, boxes: [
      box('销售金额', 200, 100, 300, 130),
      box('19996.00', 210, 145, 290, 170),
      box('本期结算汇总', 20, 500, 180, 530),
      box('销售金额', 200, 550, 300, 580),
      box('69843.00', 210, 595, 290, 620),
    ] }]);
    expect(fields.salesAmount?.value).toBe('69843.00');
  });
});
