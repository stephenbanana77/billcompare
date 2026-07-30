import type { VisionExtractionResult } from '@shared/reconciliation';
import { enrichDynamicSettlement } from '../../server/modules/reconciliation/dynamic-settlement';

const baseResult = (): VisionExtractionResult => ({
  sourceType: 'vision_llm',
  fileName: 'bill.pdf',
  headers: [],
  rows: [],
  metadata: {
    mallName: '测试商场',
    storeName: '测试门店',
    storeCode: 'S001',
    periodStart: '2026-05-01',
    periodEnd: '2026-05-31',
    billType: 'standard',
  },
  periodEvidence: {
    rawText: '2026/05/01-2026/05/31',
    page: 1,
    kind: 'explicit_range',
  },
  evidence: {},
  additionalFields: [],
  lineItems: [],
  warnings: [],
});

describe('dynamic settlement enrichment', () => {
  it('uses the SHNKA2 printed A - B * (1 + VAT) relationship without deducting B twice', () => {
    const result = baseResult();
    result.evidence = {
      deductionTotal: {
        value: 13_272.58,
        rawText: 'B.调整项（后附明细） 13,272.58',
        page: 1,
        confidence: 0.98,
      },
      invoiceAmount: {
        value: 410_001,
        rawText: 'C.贵司需提供之增值税发票 410,001.00',
        page: 1,
        confidence: 0.98,
      },
      settlementAmount: {
        value: 410_001,
        rawText: '本期应付总额：(C-D) 410,001.00',
        page: 1,
        confidence: 0.98,
      },
    };
    result.additionalFields = [
      {
        label: '本月回款小计',
        value: 424_999.01,
        rawText: '本月回款小计 424,999.01',
        page: 1,
        confidence: 0.98,
        group: 'summary',
        suggestedTarget: null,
      },
    ];
    result.lineItems = [
      ...[5_178.18, 550, 464, 3_850, 100, 50, 3_080.4].map((amount, index) => ({
        section: 'B.抽成调整及费用回收',
        label: `费用${index + 1}`,
        rowType: 'detail' as const,
        sequence: index + 1,
        values: { 金额: amount },
        rawText: null,
        page: 1,
        confidence: 0.95,
      })),
      {
        section: 'B.抽成调整及费用回收',
        label: '小计',
        rowType: 'subtotal',
        sequence: 8,
        values: { 金额: 13_272.58 },
        rawText: '小计 13,272.58',
        page: 1,
        confidence: 0.98,
      },
    ];

    const enriched = enrichDynamicSettlement(result);
    const invoiceCheck = enriched.formulaChecks?.find(
      (check) => check.id === 'formula:invoice-from-adjustment',
    );
    expect(invoiceCheck?.validation.pass).toBe(true);
    // The statement's displayed operands introduce a 0.01 rounding delta;
    // validation deliberately accepts the printed 410,001.00 within tolerance.
    expect(invoiceCheck?.validation.computed).toBe(410_000.99);
    expect(invoiceCheck?.validation.expected).toBe(410_001);
    expect(invoiceCheck?.status).toBe('review');
    expect(
      enriched.formulaChecks?.some(
        (check) => check.id === 'formula:payable-after-deduction',
      ),
    ).toBe(false);
    expect(
      enriched.formulaChecks?.find((check) => check.label.includes('明细合计'))
        ?.validation.pass,
    ).toBe(true);
  });

  it('normalizes a printed whole-number tax percentage for calculation', () => {
    const result = baseResult();
    result.evidence = {
      deductionTotal: {
        value: 13_272.58,
        rawText: 'B.调整项 13,272.58',
        page: 1,
        confidence: 0.98,
      },
      invoiceAmount: {
        value: 410_001,
        rawText: 'C.增值税发票 410,001.00',
        page: 1,
        confidence: 0.98,
      },
    };
    result.additionalFields = [
      {
        label: '本月回款小计',
        value: 424_999.01,
        rawText: '本月回款小计 424,999.01',
        page: 1,
        confidence: 0.98,
        group: 'summary',
        suggestedTarget: null,
      },
      {
        label: '增值税率',
        value: 13,
        rawText: '增值税率 13%',
        page: 1,
        confidence: 0.98,
        group: 'summary',
        suggestedTarget: 'vatRate',
      },
    ];

    const check = enrichDynamicSettlement(result).formulaChecks?.find(
      (item) => item.id === 'formula:invoice-from-adjustment',
    );
    expect(check?.fieldValues['field:additional:2']).toBe(0.13);
    expect(check?.validation.pass).toBe(true);
    expect(check?.status).toBe('passed');
  });

  it('sums both sides of a paired fee table into one printed subtotal', () => {
    const result = baseResult();
    result.lineItems = [
      {
        section: 'B.抽成调整及费用回收（不含税金额）',
        label: '信用卡手续费 / E-清洁费',
        rowType: 'detail',
        sequence: 1,
        values: {
          左侧项目: '信用卡手续费',
          左侧金额: '5,178.18',
          右侧项目: 'E-清洁费',
          右侧金额: '100.00',
        },
        rawText: '信用卡手续费 5,178.18 E-清洁费 100.00',
        page: 1,
        confidence: 0.95,
      },
      {
        section: 'B.抽成调整及费用回收（不含税金额）',
        label: 'E-人事费用 / E-维修及保养费用',
        rowType: 'detail',
        sequence: 2,
        values: {
          左侧项目: 'E-人事费用',
          左侧金额: '550.00',
          右侧项目: 'E-维修及保养费用',
          右侧金额: '50.00',
        },
        rawText: 'E-人事费用 550.00 E-维修及保养费用 50.00',
        page: 1,
        confidence: 0.95,
      },
      {
        section: 'B.抽成调整及费用回收（不含税金额）',
        label: 'POP&花车&DM / E-公共设施服务费',
        rowType: 'detail',
        sequence: 3,
        values: {
          左侧项目: 'POP&花车&DM',
          左侧金额: '464.00',
          右侧项目: 'E-公共设施服务费',
          右侧金额: '3,080.40',
        },
        rawText: 'POP&花车&DM 464.00 E-公共设施服务费 3,080.40',
        page: 1,
        confidence: 0.95,
      },
      {
        section: 'B.抽成调整及费用回收（不含税金额）',
        label: '月管理费',
        rowType: 'detail',
        sequence: 4,
        values: {
          左侧项目: '月管理费',
          左侧金额: '3,850.00',
          右侧项目: null,
          右侧金额: null,
        },
        rawText: '月管理费 3,850.00',
        page: 1,
        confidence: 0.95,
      },
      {
        section: 'B.抽成调整及费用回收（不含税金额）',
        label: '小计',
        rowType: 'subtotal',
        sequence: 5,
        values: {
          左侧项目: '小计',
          左侧金额: null,
          右侧项目: null,
          右侧金额: '13,272.58',
        },
        rawText: '小计 13,272.58',
        page: 1,
        confidence: 0.95,
      },
    ];

    const checks = enrichDynamicSettlement(result).formulaChecks ?? [];
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      label: 'B.抽成调整及费用回收（不含税金额）／金额明细合计',
      status: 'passed',
      validation: {
        computed: 13_272.58,
        expected: 13_272.58,
        pass: true,
      },
    });
  });

  it('keeps the SHAD64 post-invoice deduction formula as a deterministic check', () => {
    const result = baseResult();
    result.evidence = {
      invoiceAmount: {
        value: 60_566.31,
        rawText: '发票金额（含调整） 60,566.31',
        page: 1,
        confidence: 0.98,
      },
      deductionTotal: {
        value: 5_650.47,
        rawText: '扣款费用（合计） 5,650.47',
        page: 1,
        confidence: 0.98,
      },
      settlementAmount: {
        value: 54_915.84,
        rawText: '实付金额 54,915.84',
        page: 1,
        confidence: 0.98,
      },
    };

    const enriched = enrichDynamicSettlement(result);
    const check = enriched.formulaChecks?.find(
      (item) => item.id === 'formula:payable-after-deduction',
    );
    expect(check?.status).toBe('passed');
    expect(check?.validation).toMatchObject({
      computed: 54_915.84,
      expected: 54_915.84,
      pass: true,
    });
  });

  it('keeps arbitrary labels and values in the dynamic field layer', () => {
    const result = baseResult();
    result.additionalFields = [
      {
        label: '商场自定义能源管理分摊',
        value: '888.66',
        rawText: '商场自定义能源管理分摊 888.66',
        page: 2,
        confidence: 0.91,
        group: 'fee',
        suggestedTarget: null,
      },
    ];

    const enriched = enrichDynamicSettlement(result);
    expect(enriched.dynamicFields).toContainEqual(
      expect.objectContaining({
        label: '商场自定义能源管理分摊',
        value: '888.66',
        group: 'fee',
      }),
    );
  });
});
