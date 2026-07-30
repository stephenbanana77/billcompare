import type {
  VisionDynamicField,
  VisionDynamicFieldValueType,
  VisionExtractionResult,
  VisionFieldKey,
  VisionFormulaCheck,
  VisionLineItem,
} from '@shared/reconciliation';
import type { SettlementFormula } from '@shared/settlement-formula';
import { validateSettlementFormula } from '@shared/settlement-formula';

const evidenceLabels: Record<VisionFieldKey, string> = {
  periodStart: '账期开始',
  periodEnd: '账期结束',
  salesAmount: '销售金额',
  refundAmount: '退款金额',
  commissionAmount: '扣点金额',
  activityFee: '活动费',
  invoiceAmount: '发票金额',
  deductionTotal: '扣款／调整合计',
  settlementAmount: '实付／应付金额',
};

const metadataLabels = {
  mallName: '商场名称',
  storeName: '品牌／门店',
  storeCode: '门店编码',
  periodStart: '账期开始',
  periodEnd: '账期结束',
  billType: '单据类型',
} as const;

const moneyPattern =
  /金额|费用|营业额|回款|扣款|调整|毛利|成本|发票|实付|应付|小计|合计|余额/;
const percentPattern = /税率|扣率|扣点|费率|比例|率$/;
const dateRangePattern =
  /\d{4}[\/-]\d{1,2}[\/-]\d{1,2}\s*(?:-|~|～|至)\s*\d{4}[\/-]\d{1,2}[\/-]\d{1,2}/;
const datePattern = /\d{4}(?:年|[\/-])\d{1,2}(?:月|[\/-])\d{1,2}日?/;

const cleanLabel = (value: unknown) =>
  String(value ?? '')
    .replace(/\s+/g, '')
    .trim();

const numeric = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value ?? '').trim();
  if (!text || /^[-—–]+$/.test(text)) return null;
  const percent = text.endsWith('%');
  const parenthesized = /^\(.*\)$/.test(text);
  const normalized = text
    .replace(/(?:RMB|CNY)/gi, '')
    .replace(/[￥¥,，\s%()]/g, '');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
  let parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  if (parenthesized) parsed = -Math.abs(parsed);
  return percent ? parsed / 100 : parsed;
};

const inferValueType = (
  label: string,
  value: string | number | null,
): VisionDynamicFieldValueType => {
  const text = String(value ?? '').trim();
  if (dateRangePattern.test(text)) return 'date_range';
  if (datePattern.test(text)) return 'date';
  if (percentPattern.test(label) || text.endsWith('%')) return 'percent';
  if (moneyPattern.test(label)) return 'money';
  if (numeric(value) !== null) return 'number';
  if (/编码|单号|编号|代码|序号/.test(label)) return 'identifier';
  return 'text';
};

const semanticRole = (
  label: string,
  suggestedRole?: string | null,
): string | null => {
  const normalized = cleanLabel(label);
  if (
    /合同|合约|协议/.test(normalized) &&
    /有效期|期限|起止/.test(normalized)
  ) {
    return 'contractPeriod';
  }
  if (/本月回款小计|回款小计|结算基数/.test(normalized))
    return 'receivableBase';
  if (/^B[.、．:]?调整项|抽成调整|调整项合计/.test(normalized))
    return 'adjustmentTotal';
  if (/^C[.、．:]?|增值税发票|发票金额/.test(normalized))
    return 'invoiceAmount';
  if (/^D[.、．:]?本期费用|本期费用小计/.test(normalized)) return 'currentFee';
  if (/本期应付总额|最终应付|实付金额|实结金额/.test(normalized))
    return 'settlementAmount';
  if (/增值税率|增值税税率/.test(normalized)) return 'vatRate';
  if (/扣点|扣率|抽成率|佣金率/.test(normalized)) return 'commissionRate';
  return suggestedRole?.trim() || null;
};

const ref = (fieldId: string): SettlementFormula => ({ type: 'ref', fieldId });
const literal = (value: number): SettlementFormula => ({
  type: 'literal',
  value,
});

function buildDynamicFields(
  result: VisionExtractionResult,
): VisionDynamicField[] {
  const fields: VisionDynamicField[] = [];
  const add = (field: VisionDynamicField) => {
    if (!field.label.trim()) return;
    fields.push(field);
  };

  for (const [key, label] of Object.entries(metadataLabels)) {
    const value = result.metadata[key as keyof typeof metadataLabels];
    if (value === null || value === undefined || String(value).trim() === '')
      continue;
    add({
      id: `field:metadata:${key}`,
      label,
      value,
      rawText: key.startsWith('period') ? result.periodEvidence.rawText : null,
      page: key.startsWith('period') ? result.periodEvidence.page : null,
      confidence: null,
      group: 'metadata',
      role: key,
      valueType: inferValueType(label, value),
      section: '单据基础信息',
    });
  }

  for (const [key, evidence] of Object.entries(result.evidence) as Array<
    [
      VisionFieldKey,
      NonNullable<VisionExtractionResult['evidence'][VisionFieldKey]>,
    ]
  >) {
    if (
      !evidence ||
      evidence.value === null ||
      evidence.value === undefined ||
      evidence.value === ''
    )
      continue;
    const label = evidenceLabels[key] ?? key;
    add({
      id: `field:evidence:${key}`,
      label,
      ...evidence,
      group: 'summary',
      role: key,
      valueType: inferValueType(label, evidence.value),
      section: '汇总金额',
    });
  }

  result.additionalFields.forEach((field, index) => {
    const role = semanticRole(field.label, field.suggestedTarget);
    add({
      id: `field:additional:${index + 1}`,
      label: field.label,
      value: field.value,
      rawText: field.rawText,
      page: field.page,
      confidence: field.confidence,
      group:
        field.group === 'fee'
          ? 'fee'
          : field.group === 'summary'
            ? 'summary'
            : 'other',
      role,
      valueType: inferValueType(field.label, field.value),
      section: field.group,
    });
  });

  result.lineItems.forEach((item, itemIndex) => {
    Object.entries(item.values).forEach(([column, value], columnIndex) => {
      if (value === null || value === undefined || String(value).trim() === '')
        return;
      add({
        id: `field:line:${itemIndex + 1}:${columnIndex + 1}`,
        label: `${item.label}／${column}`,
        value,
        rawText: item.rawText,
        page: item.page,
        confidence: item.confidence,
        group: item.rowType === 'detail' ? 'detail' : 'summary',
        role:
          item.rowType === 'subtotal' || item.rowType === 'total'
            ? semanticRole(`${item.section} ${item.label} ${column}`)
            : null,
        valueType: inferValueType(column, value),
        section: item.section,
      });
    });
  });

  return fields;
}

const roleField = (fields: VisionDynamicField[], role: string) =>
  fields.find((field) => field.role === role && numeric(field.value) !== null);

const evidenceField = (fields: VisionDynamicField[], key: VisionFieldKey) =>
  fields.find(
    (field) =>
      field.id === `field:evidence:${key}` && numeric(field.value) !== null,
  );

const calculationValue = (field: VisionDynamicField) => {
  const parsed = numeric(field.value);
  if (
    field.valueType === 'percent' &&
    parsed !== null &&
    Math.abs(parsed) > 1
  ) {
    return parsed / 100;
  }
  return field.value;
};

const calculationValues = (fields: VisionDynamicField[]) =>
  Object.fromEntries(
    fields.map((field) => [field.id, calculationValue(field)]),
  );

function formulaCheck(
  input: Omit<VisionFormulaCheck, 'status' | 'validation'>,
  requiresReview = false,
): VisionFormulaCheck {
  const validation = validateSettlementFormula(
    input.formula,
    input.expected,
    input.fieldValues,
    { tolerance: input.tolerance ?? 0.01 },
  );
  return {
    ...input,
    validation,
    status:
      validation.issues.length || requiresReview
        ? 'review'
        : validation.pass
          ? 'passed'
          : 'failed',
  };
}

function commonVatRate(
  base: number,
  adjustment: number,
  invoice: number,
): number | null {
  if (adjustment === 0) return null;
  const commonRates = [0, 0.01, 0.03, 0.05, 0.06, 0.09, 0.1, 0.11, 0.13];
  return (
    commonRates.find(
      (rate) => Math.abs(base - adjustment * (1 + rate) - invoice) <= 0.01,
    ) ?? null
  );
}

function lineFieldId(itemIndex: number, columnIndex: number) {
  return `field:line:${itemIndex + 1}:${columnIndex + 1}`;
}

function buildLineItemChecks(
  result: VisionExtractionResult,
  fields: VisionDynamicField[],
): VisionFormulaCheck[] {
  const checks: VisionFormulaCheck[] = [];
  const sections = new Map<
    string,
    Array<{ item: VisionLineItem; itemIndex: number }>
  >();
  result.lineItems.forEach((item, itemIndex) => {
    const group = sections.get(item.section) ?? [];
    group.push({ item, itemIndex });
    sections.set(item.section, group);
  });

  for (const [section, items] of sections) {
    const details = items.filter(
      ({ item }) => !item.rowType || item.rowType === 'detail',
    );
    const totals = items.filter(
      ({ item }) => item.rowType === 'subtotal' || item.rowType === 'total',
    );
    if (!details.length || !totals.length) continue;

    const columns = new Set(
      details.flatMap(({ item }) => Object.keys(item.values)),
    );
    const amountColumns = [...columns].filter(
      (column) =>
        moneyPattern.test(column) &&
        details.some(({ item }) => numeric(item.values[column]) !== null),
    );
    const combinedExpected = totals
      .flatMap(({ item, itemIndex }) => {
        const entries = Object.entries(item.values);
        const numericAmounts = entries.flatMap(
          ([column, value], columnIndex) =>
            moneyPattern.test(column) && numeric(value) !== null
              ? [{ column, columnIndex }]
              : [],
        );
        const coversAllAmountColumns = amountColumns.every((column) =>
          Object.prototype.hasOwnProperty.call(item.values, column),
        );
        return amountColumns.length > 1 &&
          numericAmounts.length === 1 &&
          coversAllAmountColumns &&
          /小计|合计|总计/.test(`${item.label} ${item.rawText ?? ''}`)
          ? [
              {
                item,
                fieldId: lineFieldId(itemIndex, numericAmounts[0].columnIndex),
              },
            ]
          : [];
      })
      .at(-1);
    const combinedAmountColumns = new Set<string>();

    if (combinedExpected) {
      const operands = details.flatMap(({ item, itemIndex }) =>
        Object.entries(item.values).flatMap(([column, value], columnIndex) =>
          amountColumns.includes(column) && numeric(value) !== null
            ? [ref(lineFieldId(itemIndex, columnIndex))]
            : [],
        ),
      );
      if (operands.length) {
        amountColumns.forEach((column) => combinedAmountColumns.add(column));
        const fieldValues = calculationValues(fields);
        checks.push(
          formulaCheck({
            id: `formula:line:${checks.length + 1}`,
            label: `${section}／金额明细合计`,
            expression: `全部金额列明细合计 = ${combinedExpected.item.label}`,
            formula: { type: 'sum', operands },
            expected: ref(combinedExpected.fieldId),
            fieldValues,
            sourceText: combinedExpected.item.rawText,
            page: combinedExpected.item.page,
          }),
        );
      }
    }

    for (const column of columns) {
      if (combinedAmountColumns.has(column)) continue;
      const operands = details.flatMap(({ item, itemIndex }) => {
        const entries = Object.entries(item.values);
        const columnIndex = entries.findIndex(([name]) => name === column);
        if (columnIndex < 0 || numeric(entries[columnIndex][1]) === null)
          return [];
        return [ref(lineFieldId(itemIndex, columnIndex))];
      });
      if (!operands.length) continue;

      const expectedEntry = totals
        .flatMap(({ item, itemIndex }) => {
          const entries = Object.entries(item.values);
          const columnIndex = entries.findIndex(([name]) => name === column);
          return columnIndex >= 0 && numeric(entries[columnIndex][1]) !== null
            ? [{ item, fieldId: lineFieldId(itemIndex, columnIndex) }]
            : [];
        })
        .at(-1);
      if (!expectedEntry) continue;

      const fieldValues = calculationValues(fields);
      checks.push(
        formulaCheck({
          id: `formula:line:${checks.length + 1}`,
          label: `${section}／${column}明细合计`,
          expression: `明细 ${column} 合计 = ${expectedEntry.item.label}`,
          formula: { type: 'sum', operands },
          expected: ref(expectedEntry.fieldId),
          fieldValues,
          sourceText: expectedEntry.item.rawText,
          page: expectedEntry.item.page,
        }),
      );
    }
  }
  return checks;
}

function buildSummaryChecks(
  result: VisionExtractionResult,
  fields: VisionDynamicField[],
): VisionFormulaCheck[] {
  const checks: VisionFormulaCheck[] = [];
  const values = calculationValues(fields);
  const base = roleField(fields, 'receivableBase');
  const adjustment =
    roleField(fields, 'adjustmentTotal') ??
    evidenceField(fields, 'deductionTotal');
  const invoice =
    roleField(fields, 'invoiceAmount') ??
    evidenceField(fields, 'invoiceAmount');
  const settlement =
    roleField(fields, 'settlementAmount') ??
    evidenceField(fields, 'settlementAmount');
  let vat = roleField(fields, 'vatRate');

  if (base && adjustment && invoice) {
    let derivedVat = false;
    if (!vat) {
      const baseValue = numeric(base.value)!;
      const adjustmentValue = numeric(adjustment.value)!;
      const invoiceValue = numeric(invoice.value)!;
      const rate = commonVatRate(baseValue, adjustmentValue, invoiceValue);
      if (rate !== null) {
        vat = {
          id: 'field:derived:vatRate',
          label: '增值税率（由单据金额反推）',
          value: rate,
          rawText:
            result.additionalFields.find((field) =>
              /增值税率/.test(field.rawText ?? field.label),
            )?.rawText ?? null,
          page: invoice.page,
          confidence: 0.6,
          group: 'formula',
          role: 'vatRate',
          valueType: 'percent',
          section: '单据公式',
        };
        fields.push(vat);
        values[vat.id] = vat.value;
        derivedVat = true;
      }
    }
    if (vat) {
      checks.push(
        formulaCheck(
          {
            id: 'formula:invoice-from-adjustment',
            label: '发票金额计算',
            expression: '回款小计 - 调整项 × (1 + 增值税率) = 发票金额',
            formula: {
              type: 'subtract',
              left: ref(base.id),
              right: {
                type: 'multiply',
                left: ref(adjustment.id),
                right: { type: 'add', left: literal(1), right: ref(vat.id) },
              },
            },
            expected: ref(invoice.id),
            fieldValues: { ...values },
            sourceText: invoice.rawText,
            page: invoice.page,
          },
          derivedVat,
        ),
      );
    }
  }

  const currentFee = roleField(fields, 'currentFee');
  if (invoice && settlement && currentFee) {
    checks.push(
      formulaCheck({
        id: 'formula:payable-after-current-fee',
        label: '本期应付金额计算',
        expression: '发票金额 - 本期费用 = 本期应付金额',
        formula: {
          type: 'subtract',
          left: ref(invoice.id),
          right: ref(currentFee.id),
        },
        expected: ref(settlement.id),
        fieldValues: { ...values },
        sourceText: settlement.rawText,
        page: settlement.page,
      }),
    );
  }

  const legacyDeduction = evidenceField(fields, 'deductionTotal');
  const legacyEvidence = `${invoice?.rawText ?? ''} ${legacyDeduction?.rawText ?? ''} ${settlement?.rawText ?? ''}`;
  const looksLikePostInvoiceDeduction =
    invoice &&
    legacyDeduction &&
    settlement &&
    /发票金额/.test(invoice.rawText ?? invoice.label) &&
    /扣款费用|扣费/.test(legacyDeduction.rawText ?? legacyDeduction.label) &&
    /实付|实结/.test(settlement.rawText ?? settlement.label) &&
    !/调整项|A-B|C-D/.test(legacyEvidence);
  if (
    looksLikePostInvoiceDeduction &&
    !checks.some((check) => check.id === 'formula:payable-after-current-fee')
  ) {
    checks.push(
      formulaCheck({
        id: 'formula:payable-after-deduction',
        label: '实付金额计算',
        expression: '发票金额 - 扣款费用合计 = 实付金额',
        formula: {
          type: 'subtract',
          left: ref(invoice.id),
          right: ref(legacyDeduction.id),
        },
        expected: ref(settlement.id),
        fieldValues: { ...values },
        sourceText: settlement.rawText,
        page: settlement.page,
      }),
    );
  }
  return checks;
}

/** Adds unrestricted dynamic fields and deterministic formula checks without changing legacy fields. */
export function enrichDynamicSettlement(
  result: VisionExtractionResult,
): VisionExtractionResult {
  const dynamicFields = buildDynamicFields(result);
  const formulaChecks = [
    ...buildLineItemChecks(result, dynamicFields),
    ...buildSummaryChecks(result, dynamicFields),
  ];
  const formulaWarnings = formulaChecks.flatMap((check) => {
    if (check.status === 'failed')
      return [`${check.label}未通过，请复核原始单据。`];
    if (check.status === 'review')
      return [`${check.label}含推导值或证据不足，需要人工复核。`];
    return [];
  });
  return {
    ...result,
    dynamicFields,
    formulaChecks,
    warnings: [...new Set([...result.warnings, ...formulaWarnings])],
  };
}
