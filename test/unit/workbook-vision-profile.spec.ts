import type { VisionExtractionResult } from '@shared/reconciliation';
import { profileFromVisionExtraction } from '../../client/src/lib/vision-profile';

describe('profileFromVisionExtraction', () => {
  it('adapts normalized metadata and arbitrary summary fields for task import', () => {
    const extraction: VisionExtractionResult = {
      sourceType: 'vision_llm',
      fileName: 'SHNKA2结算单-202605.pdf',
      headers: ['账期开始', '账期结束', '销售金额', '实结金额'],
      rows: [
        {
          账期开始: '',
          账期结束: '',
          销售金额: 512_047,
          实结金额: 410_001,
        },
      ],
      metadata: {
        mallName: '新世界百货集团上海汇雅百货有限公司',
        storeName: '耐克NIKE',
        storeCode: '1500614',
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
        billType: 'standard',
      },
      periodEvidence: {
        rawText: '2026年5月',
        page: 1,
        kind: 'month_only',
      },
      evidence: {},
      additionalFields: [],
      lineItems: [],
      dynamicFields: [
        {
          id: 'field:summary:adjustments',
          label: 'B.调整项（后附明细）',
          value: 13_272.58,
          rawText: 'B.调整项（后附明细） 13,272.58',
          page: 1,
          confidence: 0.99,
          group: 'summary',
          role: 'adjustmentTotal',
          valueType: 'money',
        },
      ],
      formulaChecks: [],
      warnings: [],
    };

    const profile = profileFromVisionExtraction(extraction);
    expect(profile.rows[0]['账期开始']).toBe('2026-05-01');
    expect(profile.rows[0]['账期结束']).toBe('2026-05-31');
    expect(profile.headers).toEqual(
      expect.arrayContaining([
        '商场名称',
        '门店名称',
        '门店编码',
        'B.调整项（后附明细）',
      ]),
    );
    expect(profile.rows[0]).toMatchObject({
      商场名称: '新世界百货集团上海汇雅百货有限公司',
      门店名称: '耐克NIKE',
      门店编码: '1500614',
      'B.调整项（后附明细）': 13_272.58,
    });
  });
});
