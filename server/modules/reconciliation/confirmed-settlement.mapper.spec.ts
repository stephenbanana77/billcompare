import type {
  ConfirmSettlementBillInput,
  VisionExtractionResult,
} from '../../../shared/reconciliation';
import { mapConfirmedSettlement } from './confirmed-settlement.mapper';

const createInput = (): ConfirmSettlementBillInput => {
  const extraction: VisionExtractionResult = {
    sourceType: 'vision_llm',
    fileName: 'extraction-file.pdf',
    headers: ['项目', '金额'],
    rows: [{ 项目: '本期销售', 金额: '69843.00' }],
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
        section: '商品销售明细',
        label: '本期销售',
        rowType: 'detail',
        sequence: 1,
        values: { 金额: '69843.00' },
        rawText: '本期销售 69,843.00',
        page: 1,
        confidence: 0.98,
      },
      {
        section: '扣款费用明细',
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

  return {
    fileName: '  SHAD64-2026-05-settlement.pdf  ',
    extraction,
    reviewedFields: [
      {
        id: 'mall',
        label: '商场名称',
        target: 'mallName',
        value: '  上海久光中心  ',
      },
      {
        id: 'store',
        label: '门店名称',
        target: 'storeName',
        value: '  南京东路旗舰店  ',
      },
      { id: 'code', label: '门店编码', target: 'storeCode', value: ' SHAD64 ' },
      {
        id: 'start',
        label: '账期开始',
        target: 'periodStart',
        value: ' 2026-05-01 ',
      },
      {
        id: 'end',
        label: '账期结束',
        target: 'periodEnd',
        value: ' 2026-05-31 ',
      },
      {
        id: 'sales',
        label: '销售金额',
        target: 'salesAmount',
        value: '69,843',
      },
      {
        id: 'invoice',
        label: '发票金额',
        target: 'invoiceAmount',
        value: '60,566.31',
      },
      {
        id: 'deduction',
        label: '扣款合计',
        target: 'deductionTotal',
        value: null,
      },
      {
        id: 'settlement',
        label: '实结金额',
        target: 'settlementAmount',
        value: 54915.84,
      },
      {
        id: 'settlement-no',
        label: '结算单号',
        target: 'settlementNo',
        value: ' JS202605-SHAD64 ',
      },
      { id: 'ignored', label: '忽略字段', target: '', value: 'ignored' },
    ],
    confirmationKey: '11111111-1111-4111-8111-111111111111',
    clientReportedOcrVerified: true,
  };
};

const setReviewedValue = (
  input: ConfirmSettlementBillInput,
  target: string,
  value: string | number | null,
) => {
  const field = input.reviewedFields.find(
    (candidate) => candidate.target === target,
  );
  if (!field) throw new Error(`missing test fixture target: ${target}`);
  field.value = value;
};

describe('mapConfirmedSettlement', () => {
  it('maps reviewed canonical dimensions and money values into the bill', () => {
    const input = createInput();

    expect(mapConfirmedSettlement(input).bill).toEqual({
      sourceFileName: 'SHAD64-2026-05-settlement.pdf',
      mallName: '上海久光中心',
      storeName: '南京东路旗舰店',
      storeCode: 'SHAD64',
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
      billType: 'standard',
      settlementNo: 'JS202605-SHAD64',
      salesAmount: '69843.00',
      invoiceAmount: '60566.31',
      deductionTotal: null,
      settlementAmount: '54915.84',
      confirmationKey: '11111111-1111-4111-8111-111111111111',
      clientReportedOcrVerified: true,
      reviewedFields: input.reviewedFields,
      extractionPayload: input.extraction,
    });
  });

  it('rejects a duplicate non-empty reviewed target', () => {
    const input = createInput();
    input.reviewedFields.push({
      id: 'sales-copy',
      label: '销售金额副本',
      target: 'salesAmount',
      value: '1',
    });

    expect(() => mapConfirmedSettlement(input)).toThrow('salesAmount');
  });

  it('rejects a missing required store code', () => {
    const input = createInput();
    input.reviewedFields = input.reviewedFields.filter(
      (field) => field.target !== 'storeCode',
    );

    expect(() => mapConfirmedSettlement(input)).toThrow('storeCode');
  });

  it('separates sales and fee line items while preserving order and labels', () => {
    const input = createInput();
    input.extraction.lineItems = [
      {
        section: '商品销售与进货结算明细',
        label: '扣率:-15',
        rowType: 'detail',
        sequence: 1,
        values: { 销售金额: 49847 },
        rawText: null,
        page: 1,
        confidence: 0.98,
      },
      {
        section: '其他调整明细',
        label: '不相关项目',
        rowType: 'adjustment',
        sequence: 2,
        values: { 金额: 100 },
        rawText: null,
        page: 1,
        confidence: 0.9,
      },
      {
        section: '商品销售与进货结算明细',
        label: '扣率:-20',
        rowType: 'detail',
        sequence: 3,
        values: { 销售金额: 19996 },
        rawText: null,
        page: 1,
        confidence: 0.97,
      },
      {
        section: '扣款费用明细',
        label: '管理费-0201',
        rowType: 'detail',
        sequence: 4,
        values: { 金额: 2517.5 },
        rawText: null,
        page: 1,
        confidence: 0.98,
      },
      {
        section: '扣款费用明细',
        label: '推广费-0202',
        rowType: 'detail',
        sequence: 5,
        values: { 金额: 800 },
        rawText: null,
        page: 1,
        confidence: 0.96,
      },
    ];

    const mapped = mapConfirmedSettlement(input);

    expect(mapped.salesLines.map((line) => line.label)).toEqual([
      '扣率:-15',
      '扣率:-20',
    ]);
    expect(mapped.feeLines.map((line) => line.label)).toEqual([
      '管理费-0201',
      '推广费-0202',
    ]);
  });

  it('preserves every extracted line as dynamic detail lines', () => {
    const input = createInput();
    input.extraction.lineItems = [
      {
        section: 'Sales table',
        label: 'sales-row',
        rowType: 'detail',
        sequence: 1,
        values: { amount: 100 },
        rawText: null,
        page: 1,
        confidence: 0.98,
      },
      {
        section: 'Adjustment table',
        label: 'dynamic-adjustment-row',
        rowType: 'adjustment',
        sequence: 2,
        values: { amount: -5 },
        rawText: null,
        page: 1,
        confidence: 0.9,
      },
      {
        section: 'Fee table',
        label: 'fee-row',
        rowType: 'detail',
        sequence: 3,
        values: { amount: 2 },
        rawText: null,
        page: 1,
        confidence: 0.96,
      },
    ];

    const mapped = mapConfirmedSettlement(input);

    expect(mapped.dynamicLines.map((line) => line.label)).toEqual([
      'sales-row',
      'dynamic-adjustment-row',
      'fee-row',
    ]);
  });

  it.each([
    ['salesAmount', ','],
    ['settlementAmount', ','],
  ])('rejects malformed required money for %s', (target, amount) => {
    const input = createInput();
    setReviewedValue(input, target, amount);

    expect(() => mapConfirmedSettlement(input)).toThrow(target);
  });

  it.each(['1,2', '1e3', '0x10', 'NaN', 'Infinity', '1.234'])(
    'rejects invalid money syntax %s',
    (amount) => {
      const input = createInput();
      setReviewedValue(input, 'salesAmount', amount);

      expect(() => mapConfirmedSettlement(input)).toThrow('salesAmount');
    },
  );

  it('preserves the numeric(16,2) boundary and rejects overflow', () => {
    const boundaryInput = createInput();
    setReviewedValue(boundaryInput, 'salesAmount', '99,999,999,999,999.99');

    expect(mapConfirmedSettlement(boundaryInput).bill.salesAmount).toBe(
      '99999999999999.99',
    );

    const overflowInput = createInput();
    setReviewedValue(overflowInput, 'salesAmount', '100,000,000,000,000.00');

    expect(() => mapConfirmedSettlement(overflowInput)).toThrow('salesAmount');
  });

  it('rejects malformed optional money', () => {
    const input = createInput();
    setReviewedValue(input, 'invoiceAmount', '1,2');

    expect(() => mapConfirmedSettlement(input)).toThrow('invoiceAmount');
  });

  it.each([1.005, Number.NaN, Number.POSITIVE_INFINITY, 100_000_000_000_000])(
    'rejects unsafe number money input %s',
    (amount) => {
      const input = createInput();
      setReviewedValue(input, 'salesAmount', amount);

      expect(() => mapConfirmedSettlement(input)).toThrow('salesAmount');
    },
  );

  it.each([
    ['periodStart', '2026-02-30'],
    ['periodEnd', '2026-13-01'],
    ['periodStart', '2026-2-01'],
  ])('rejects invalid calendar date for %s', (target, date) => {
    const input = createInput();
    setReviewedValue(input, target, date);

    expect(() => mapConfirmedSettlement(input)).toThrow(target);
  });

  it('rejects a reversed settlement period', () => {
    const input = createInput();
    setReviewedValue(input, 'periodStart', '2026-06-01');
    setReviewedValue(input, 'periodEnd', '2026-05-31');

    expect(() => mapConfirmedSettlement(input)).toThrow('periodStart');
  });

  it.each([
    [
      'fileName',
      255,
      (input: ConfirmSettlementBillInput, value: string) => {
        input.fileName = value;
      },
    ],
    [
      'mallName',
      120,
      (input: ConfirmSettlementBillInput, value: string) => {
        setReviewedValue(input, 'mallName', value);
      },
    ],
    [
      'storeName',
      120,
      (input: ConfirmSettlementBillInput, value: string) => {
        setReviewedValue(input, 'storeName', value);
      },
    ],
    [
      'storeCode',
      60,
      (input: ConfirmSettlementBillInput, value: string) => {
        setReviewedValue(input, 'storeCode', value);
      },
    ],
    [
      'settlementNo',
      120,
      (input: ConfirmSettlementBillInput, value: string) => {
        setReviewedValue(input, 'settlementNo', value);
      },
    ],
  ])(
    'accepts the %s database boundary and rejects one character over it',
    (field, limit, assign) => {
      const boundary = createInput();
      assign(boundary, 'x'.repeat(limit));
      expect(() => mapConfirmedSettlement(boundary)).not.toThrow();

      const overflow = createInput();
      assign(overflow, 'x'.repeat(limit + 1));
      expect(() => mapConfirmedSettlement(overflow)).toThrow(
        `${field} must not exceed ${limit} characters`,
      );
    },
  );

  it('rejects a missing or oversized confirmation key', () => {
    const missing = createInput();
    missing.confirmationKey = '';
    expect(() => mapConfirmedSettlement(missing)).toThrow('confirmationKey');

    const oversized = createInput();
    oversized.confirmationKey = 'x'.repeat(101);
    expect(() => mapConfirmedSettlement(oversized)).toThrow(
      'confirmationKey must not exceed 100 characters',
    );
  });

  it('detaches returned audit data from later input mutations', () => {
    const input = createInput();
    const mapped = mapConfirmedSettlement(input);

    input.reviewedFields[0].label = '已修改商场名称';
    input.extraction.metadata.mallName = '已修改商场';
    input.extraction.lineItems[0].label = '已修改销售行';
    input.extraction.lineItems[1].label = '已修改费用行';
    input.extraction.lineItems.push({
      section: '扣款费用明细',
      label: '新增费用',
      values: { 金额: 1 },
      rawText: null,
      page: 1,
      confidence: 1,
    });

    expect(mapped.bill.reviewedFields[0].label).toBe('商场名称');
    expect(mapped.bill.extractionPayload.metadata.mallName).toBe(
      '上海久光中心',
    );
    expect(mapped.salesLines[0].label).toBe('本期销售');
    expect(mapped.feeLines.map((line) => line.label)).toEqual(['扣款合计']);
  });
});
