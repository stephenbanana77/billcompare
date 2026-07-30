import type {
  OcrExtractionResult,
  VisionExtractionResult,
} from '@shared/reconciliation';
import { reconcileVisionMetadataWithOcr } from '../../client/src/lib/reconcile-vision-ocr';

describe('reconcileVisionMetadataWithOcr', () => {
  it('corrects only explicitly labeled counter identity fields', () => {
    const extraction = {
      metadata: {
        mallName: '新世界百货',
        storeName: '锐力体育（浙江）有限公司',
        storeCode: '29990',
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
        billType: 'standard',
      },
      dynamicFields: [
        { role: 'storeName', value: '锐力体育（浙江）有限公司' },
        { role: 'storeCode', value: '29990' },
      ],
      warnings: [],
    } as unknown as VisionExtractionResult;
    const evidence = (text: string) => ({
      page: 1,
      text,
      score: 0.99,
      polygon: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ] as [[number, number], [number, number], [number, number], [number, number]],
    });
    const ocr = {
      fields: {
        brandMerchantName: {
          value: '锐力体育（浙江）有限公司',
          label: '供货商名称：锐力体育（浙江）有限公司',
          evidence: evidence('供货商名称：锐力体育（浙江）有限公司'),
        },
        brandName: {
          value: '耐克NIKE',
          label: '专柜名称：耐克NIKE',
          evidence: evidence('专柜名称：耐克NIKE'),
        },
        storeCode: {
          value: '1500614',
          label: '专柜编码：1500614',
          evidence: evidence('专柜编码：1500614'),
        },
      },
    } as unknown as OcrExtractionResult;

    const result = reconcileVisionMetadataWithOcr(extraction, ocr);

    expect(result.metadata.storeName).toBe('耐克NIKE');
    expect(result.metadata.storeCode).toBe('1500614');
    expect(result.dynamicFields).toEqual([
      expect.objectContaining({ role: 'storeName', value: '耐克NIKE' }),
      expect.objectContaining({ role: 'storeCode', value: '1500614' }),
    ]);
    expect(result.warnings).toContain(
      'OCR 已按单据中的“专柜名称／专柜编码”标签纠正门店信息，请人工复核。',
    );
  });
});
