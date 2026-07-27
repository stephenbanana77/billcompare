import type {
  ConfirmSettlementBillInput,
  VisionExtractionResult,
} from '../../../shared/reconciliation';
import { mapConfirmedSettlement } from './confirmed-settlement.mapper';

describe('mapConfirmedSettlement', () => {
  it('maps reviewed canonical dimensions and money values into the bill', () => {
    const extraction: VisionExtractionResult = {
      sourceType: 'vision_llm',
      fileName: 'SHAD64-2026-05-settlement.pdf',
      headers: ['项目', '金额'],
      rows: [
        {
          项目: '本期销售',
          金额: '69843.00',
        },
      ],
      metadata: {
        mallName: '上海久光中心',
        storeName: '南京东路店',
        storeCode: 'SHAD64',
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
        billType: 'standard',
      },
      periodEvidence: {
        rawText: '结算期间：2026年5月1日至2026年5月31日',
        page: 1,
        kind: 'explicit_range',
      },
      evidence: {
        salesAmount: {
          value: '69843.00',
          rawText: '销售金额 69,843.00',
          page: 1,
          confidence: 0.99,
        },
        invoiceAmount: {
          value: '60566.31',
          rawText: '发票金额 60,566.31',
          page: 1,
          confidence: 0.98,
        },
        deductionTotal: {
          value: '5650.47',
          rawText: '扣款合计 5,650.47',
          page: 1,
          confidence: 0.99,
        },
        settlementAmount: {
          value: '54915.84',
          rawText: '实结金额 54,915.84',
          page: 1,
          confidence: 0.99,
        },
      },
      additionalFields: [
        {
          label: '结算单号',
          group: 'header',
          suggestedTarget: 'settlementNo',
          value: 'JS202605-SHAD64',
          rawText: '结算单号 JS202605-SHAD64',
          page: 1,
          confidence: 0.97,
        },
      ],
      lineItems: [
        {
          section: 'sales',
          label: '本期销售',
          rowType: 'detail',
          sequence: 1,
          values: { 金额: '69843.00' },
          rawText: '本期销售 69,843.00',
          page: 1,
          confidence: 0.98,
        },
        {
          section: 'fees',
          label: '扣款合计',
          rowType: 'total',
          sequence: 1,
          values: { 金额: '5650.47' },
          rawText: '扣款合计 5,650.47',
          page: 1,
          confidence: 0.99,
        },
      ],
      warnings: [],
    };
    const input: ConfirmSettlementBillInput = {
      fileName: extraction.fileName,
      extraction,
      reviewedFields: [
        {
          id: 'mall',
          label: '商场名称',
          target: 'mallName',
          value: '上海久光中心',
        },
        {
          id: 'store',
          label: '门店名称',
          target: 'storeName',
          value: '南京东路旗舰店',
        },
        { id: 'code', label: '门店编码', target: 'storeCode', value: 'SHAD64' },
        {
          id: 'start',
          label: '账期开始',
          target: 'periodStart',
          value: '2026-05-01',
        },
        {
          id: 'end',
          label: '账期结束',
          target: 'periodEnd',
          value: '2026-05-31',
        },
        {
          id: 'sales',
          label: '销售金额',
          target: 'salesAmount',
          value: '69843.00',
        },
        {
          id: 'invoice',
          label: '发票金额',
          target: 'invoiceAmount',
          value: '60566.31',
        },
        {
          id: 'deduction',
          label: '扣款合计',
          target: 'deductionTotal',
          value: '5650.47',
        },
        {
          id: 'settlement',
          label: '实结金额',
          target: 'settlementAmount',
          value: '54915.84',
        },
      ],
      ocrVerified: true,
    };

    expect(mapConfirmedSettlement(input).bill).toEqual(
      expect.objectContaining({
        mallName: '上海久光中心',
        storeName: '南京东路旗舰店',
        storeCode: 'SHAD64',
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
        salesAmount: '69843.00',
        invoiceAmount: '60566.31',
        deductionTotal: '5650.47',
        settlementAmount: '54915.84',
      }),
    );
  });
});
