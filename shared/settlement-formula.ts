export const DEFAULT_CURRENCY_DECIMALS = 2;
export const DEFAULT_CURRENCY_TOLERANCE = 0.01;

export type SettlementFormula =
  | SettlementLiteralFormula
  | SettlementReferenceFormula
  | SettlementSumFormula
  | SettlementBinaryFormula
  | SettlementRoundFormula;

export interface SettlementLiteralFormula {
  type: 'literal';
  value: number;
}

export interface SettlementReferenceFormula {
  type: 'ref';
  /** Stable id assigned to a dynamically extracted field. */
  fieldId: string;
}

export interface SettlementSumFormula {
  type: 'sum';
  operands: SettlementFormula[];
}

export interface SettlementBinaryFormula {
  type: 'add' | 'subtract' | 'multiply' | 'divide';
  left: SettlementFormula;
  right: SettlementFormula;
}

export interface SettlementRoundFormula {
  type: 'round';
  operand: SettlementFormula;
  decimals?: number;
}

export type SettlementFormulaIssueCode =
  | 'invalid_formula'
  | 'invalid_literal'
  | 'invalid_field_value'
  | 'missing_reference'
  | 'division_by_zero'
  | 'non_finite_result'
  | 'formula_too_complex'
  | 'invalid_validation_options';

export interface SettlementFormulaIssue {
  code: SettlementFormulaIssueCode;
  message: string;
  path: string;
  fieldId?: string;
}

export type SettlementFieldValues = Readonly<Record<string, unknown>>;

export interface SettlementFormulaEvaluationResult {
  ok: boolean;
  value: number | null;
  missingRefs: string[];
  issues: SettlementFormulaIssue[];
}

export interface SettlementFormulaValidationOptions {
  /** Number of decimal places exposed by the currency. Defaults to 2. */
  decimals?: number;
  /** Allowed absolute variance. Defaults to one unit at `decimals` precision. */
  tolerance?: number;
}

export interface SettlementFormulaValidationResult {
  computed: number | null;
  expected: number | null;
  difference: number | null;
  pass: boolean;
  missingRefs: string[];
  issues: SettlementFormulaIssue[];
}

interface EvaluationContext {
  fields: SettlementFieldValues;
  missingRefs: Set<string>;
  issues: SettlementFormulaIssue[];
  activeNodes: Set<object>;
  visitedNodes: number;
}

const MAX_FORMULA_DEPTH = 64;
const MAX_FORMULA_NODES = 1_000;
const MAX_DECIMALS = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function roundDecimal(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded =
    Math.round((Math.abs(value) + Number.EPSILON) * factor) / factor;
  return Object.is(value, -0) || value < 0 ? -rounded : rounded;
}

function parseFieldNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') {
    return null;
  }

  let normalized = value.trim();
  if (!normalized) {
    return null;
  }

  const isPercent = normalized.endsWith('%');
  if (isPercent) {
    normalized = normalized.slice(0, -1).trim();
  }

  const isParenthesizedNegative = /^\(.*\)$/.test(normalized);
  if (isParenthesizedNegative) {
    normalized = normalized.slice(1, -1);
  }

  normalized = normalized
    .replace(/(?:RMB|CNY)/gi, '')
    .replace(/[￥¥,，\s]/g, '');

  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
    return null;
  }

  let parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  if (isParenthesizedNegative) {
    parsed = -Math.abs(parsed);
  }
  return isPercent ? parsed / 100 : parsed;
}

function addIssue(
  context: EvaluationContext,
  code: SettlementFormulaIssueCode,
  message: string,
  path: string,
  fieldId?: string,
): null {
  context.issues.push({ code, message, path, ...(fieldId ? { fieldId } : {}) });
  return null;
}

function evaluateNode(
  node: unknown,
  context: EvaluationContext,
  path: string,
  depth: number,
): number | null {
  context.visitedNodes += 1;
  if (depth > MAX_FORMULA_DEPTH || context.visitedNodes > MAX_FORMULA_NODES) {
    return addIssue(
      context,
      'formula_too_complex',
      'Formula exceeds the safe complexity limit.',
      path,
    );
  }
  if (!isRecord(node) || typeof node.type !== 'string') {
    return addIssue(
      context,
      'invalid_formula',
      'Formula node must be an object with a type.',
      path,
    );
  }
  if (context.activeNodes.has(node)) {
    return addIssue(
      context,
      'invalid_formula',
      'Formula contains a cycle.',
      path,
    );
  }

  context.activeNodes.add(node);
  try {
    switch (node.type) {
      case 'literal': {
        if (typeof node.value !== 'number' || !Number.isFinite(node.value)) {
          return addIssue(
            context,
            'invalid_literal',
            'Literal must be a finite number.',
            path,
          );
        }
        return node.value;
      }
      case 'ref': {
        if (typeof node.fieldId !== 'string' || node.fieldId.trim() === '') {
          return addIssue(
            context,
            'invalid_formula',
            'Reference must contain a non-empty stable field id.',
            path,
          );
        }
        const fieldId = node.fieldId;
        if (!Object.prototype.hasOwnProperty.call(context.fields, fieldId)) {
          context.missingRefs.add(fieldId);
          return addIssue(
            context,
            'missing_reference',
            `No value was supplied for field "${fieldId}".`,
            path,
            fieldId,
          );
        }
        const value = parseFieldNumber(context.fields[fieldId]);
        if (value === null) {
          return addIssue(
            context,
            'invalid_field_value',
            `Field "${fieldId}" does not contain a finite numeric value.`,
            path,
            fieldId,
          );
        }
        return value;
      }
      case 'sum': {
        if (!Array.isArray(node.operands)) {
          return addIssue(
            context,
            'invalid_formula',
            'Sum operands must be an array.',
            path,
          );
        }
        let sum = 0;
        let valid = true;
        node.operands.forEach((operand, index) => {
          const value = evaluateNode(
            operand,
            context,
            `${path}.operands[${index}]`,
            depth + 1,
          );
          if (value === null) {
            valid = false;
          } else {
            sum += value;
          }
        });
        if (!valid) {
          return null;
        }
        if (!Number.isFinite(sum)) {
          return addIssue(
            context,
            'non_finite_result',
            'Sum produced a non-finite result.',
            path,
          );
        }
        return sum;
      }
      case 'add':
      case 'subtract':
      case 'multiply':
      case 'divide': {
        const left = evaluateNode(
          node.left,
          context,
          `${path}.left`,
          depth + 1,
        );
        const right = evaluateNode(
          node.right,
          context,
          `${path}.right`,
          depth + 1,
        );
        if (left === null || right === null) {
          return null;
        }
        if (node.type === 'divide' && right === 0) {
          return addIssue(
            context,
            'division_by_zero',
            'Formula attempted to divide by zero.',
            path,
          );
        }
        const result =
          node.type === 'add'
            ? left + right
            : node.type === 'subtract'
              ? left - right
              : node.type === 'multiply'
                ? left * right
                : left / right;
        if (!Number.isFinite(result)) {
          return addIssue(
            context,
            'non_finite_result',
            'Arithmetic produced a non-finite result.',
            path,
          );
        }
        return result;
      }
      case 'round': {
        const decimals = node.decimals ?? DEFAULT_CURRENCY_DECIMALS;
        if (
          typeof decimals !== 'number' ||
          !Number.isInteger(decimals) ||
          decimals < 0 ||
          decimals > MAX_DECIMALS
        ) {
          return addIssue(
            context,
            'invalid_formula',
            `Round decimals must be an integer from 0 to ${MAX_DECIMALS}.`,
            path,
          );
        }
        const value = evaluateNode(
          node.operand,
          context,
          `${path}.operand`,
          depth + 1,
        );
        return value === null ? null : roundDecimal(value, decimals);
      }
      default:
        return addIssue(
          context,
          'invalid_formula',
          `Unsupported formula node type "${node.type}".`,
          path,
        );
    }
  } finally {
    context.activeNodes.delete(node);
  }
}

/** Evaluates a data-only formula AST. It never executes source text or model-generated code. */
export function evaluateSettlementFormula(
  formula: SettlementFormula,
  fields: SettlementFieldValues,
): SettlementFormulaEvaluationResult {
  const context: EvaluationContext = {
    fields,
    missingRefs: new Set<string>(),
    issues: [],
    activeNodes: new Set<object>(),
    visitedNodes: 0,
  };
  const value = evaluateNode(formula, context, '$', 0);
  return {
    ok: value !== null && context.issues.length === 0,
    value,
    missingRefs: [...context.missingRefs],
    issues: context.issues,
  };
}

/**
 * Compares a calculated formula with an expected formula (normally a stable
 * field reference). Both values and their difference are normalized to the
 * configured currency precision before applying the tolerance.
 */
export function validateSettlementFormula(
  formula: SettlementFormula,
  expectedFormula: SettlementFormula | number,
  fields: SettlementFieldValues,
  options: SettlementFormulaValidationOptions = {},
): SettlementFormulaValidationResult {
  const computedResult = evaluateSettlementFormula(formula, fields);
  const expectedResult = evaluateSettlementFormula(
    typeof expectedFormula === 'number'
      ? ({
          type: 'literal',
          value: expectedFormula,
        } satisfies SettlementLiteralFormula)
      : expectedFormula,
    fields,
  );
  const issues = [...computedResult.issues, ...expectedResult.issues];
  const missingRefs = [
    ...new Set([...computedResult.missingRefs, ...expectedResult.missingRefs]),
  ];

  const decimals = options.decimals ?? DEFAULT_CURRENCY_DECIMALS;
  const defaultTolerance =
    decimals >= 0 && decimals <= MAX_DECIMALS ? 10 ** -decimals : NaN;
  const tolerance = options.tolerance ?? defaultTolerance;
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > MAX_DECIMALS ||
    !Number.isFinite(tolerance) ||
    tolerance < 0
  ) {
    issues.push({
      code: 'invalid_validation_options',
      message: `Validation decimals must be an integer from 0 to ${MAX_DECIMALS} and tolerance must be non-negative.`,
      path: '$validation',
    });
  }

  const canCompare =
    computedResult.value !== null &&
    expectedResult.value !== null &&
    issues.length === 0;
  const computed = canCompare
    ? roundDecimal(computedResult.value!, decimals)
    : null;
  const expected = canCompare
    ? roundDecimal(expectedResult.value!, decimals)
    : null;
  const difference =
    computed !== null && expected !== null
      ? roundDecimal(computed - expected, decimals)
      : null;

  return {
    computed,
    expected,
    difference,
    pass: difference !== null && Math.abs(difference) <= tolerance,
    missingRefs,
    issues,
  };
}
