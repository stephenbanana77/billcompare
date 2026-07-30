import {
  evaluateSettlementFormula,
  validateSettlementFormula,
  type SettlementFormula,
} from '../../shared/settlement-formula';

const ref = (fieldId: string): SettlementFormula => ({ type: 'ref', fieldId });
const literal = (value: number): SettlementFormula => ({
  type: 'literal',
  value,
});

describe('settlement formula engine', () => {
  it('validates SHAD64 invoice minus deductions equals paid amount', () => {
    const result = validateSettlementFormula(
      {
        type: 'subtract',
        left: ref('invoice-total'),
        right: ref('deduction-total'),
      },
      ref('paid-total'),
      {
        'invoice-total': '69,843.00',
        'deduction-total': '8,407.30',
        'paid-total': '61,435.70',
      },
    );

    expect(result).toEqual({
      computed: 61435.7,
      expected: 61435.7,
      difference: 0,
      pass: true,
      missingRefs: [],
      issues: [],
    });
  });

  it('validates SHNKA2 A - B * (1 + VAT) = C, then C - D = payable', () => {
    const invoiceFormula: SettlementFormula = {
      type: 'subtract',
      left: ref('collection-subtotal'),
      right: {
        type: 'multiply',
        left: ref('adjustment-total'),
        right: { type: 'add', left: literal(1), right: ref('vat-rate') },
      },
    };
    const fields = {
      'collection-subtotal': 424999.01,
      'adjustment-total': 13272.58,
      'vat-rate': '13%',
      'invoice-total': 410001,
      'period-fees': 0,
      'payable-total': 410001,
    };

    const invoiceCheck = validateSettlementFormula(
      invoiceFormula,
      ref('invoice-total'),
      fields,
    );
    expect(invoiceCheck).toMatchObject({
      computed: 410000.99,
      expected: 410001,
      difference: -0.01,
      pass: true,
      missingRefs: [],
    });

    const payableCheck = validateSettlementFormula(
      {
        type: 'subtract',
        left: { type: 'round', operand: invoiceFormula, decimals: 0 },
        right: ref('period-fees'),
      },
      ref('payable-total'),
      fields,
    );
    expect(payableCheck).toMatchObject({
      computed: 410001,
      expected: 410001,
      difference: 0,
      pass: true,
    });
  });

  it('supports sum, divide, explicit rounding, and negative accounting values', () => {
    const formula: SettlementFormula = {
      type: 'round',
      decimals: 2,
      operand: {
        type: 'divide',
        left: {
          type: 'sum',
          operands: [ref('fee-a'), ref('fee-b'), ref('fee-credit')],
        },
        right: literal(3),
      },
    };

    expect(
      evaluateSettlementFormula(formula, {
        'fee-a': '￥1,000.00',
        'fee-b': '500',
        'fee-credit': '(200.00)',
      }),
    ).toMatchObject({ ok: true, value: 433.33, missingRefs: [], issues: [] });
  });

  it('collects stable missing field ids and returns a non-passing validation', () => {
    const result = validateSettlementFormula(
      {
        type: 'add',
        left: ref('missing-a'),
        right: { type: 'sum', operands: [ref('present'), ref('missing-b')] },
      },
      ref('missing-payable'),
      { present: 10 },
    );

    expect(result).toMatchObject({
      computed: null,
      expected: null,
      difference: null,
      pass: false,
      missingRefs: ['missing-a', 'missing-b', 'missing-payable'],
    });
    expect(
      result.issues.every((issue) => issue.code === 'missing_reference'),
    ).toBe(true);
  });

  it('fails safely for malformed AST nodes and invalid field values', () => {
    const malformed = evaluateSettlementFormula(
      {
        type: 'multiply',
        left: { type: 'literal', value: 'not-a-number' },
        right: null,
      } as unknown as SettlementFormula,
      {},
    );
    expect(malformed).toMatchObject({
      ok: false,
      value: null,
      missingRefs: [],
    });
    expect(malformed.issues.map((issue) => issue.code)).toEqual([
      'invalid_literal',
      'invalid_formula',
    ]);

    const invalidField = evaluateSettlementFormula(ref('amount'), {
      amount: 'about 100 yuan',
    });
    expect(invalidField).toMatchObject({
      ok: false,
      value: null,
      missingRefs: [],
    });
    expect(invalidField.issues[0]?.code).toBe('invalid_field_value');
  });

  it('fails safely on division by zero and cyclic formulas', () => {
    const zeroDivision = evaluateSettlementFormula(
      { type: 'divide', left: literal(100), right: literal(0) },
      {},
    );
    expect(zeroDivision).toMatchObject({ ok: false, value: null });
    expect(zeroDivision.issues[0]?.code).toBe('division_by_zero');

    const cyclic: Record<string, unknown> = { type: 'round', decimals: 2 };
    cyclic.operand = cyclic;
    const cyclicResult = evaluateSettlementFormula(
      cyclic as unknown as SettlementFormula,
      {},
    );
    expect(cyclicResult).toMatchObject({ ok: false, value: null });
    expect(cyclicResult.issues[0]?.code).toBe('invalid_formula');
  });
});
