import 'reflect-metadata';
import { BadRequestException, RequestMethod } from '@nestjs/common';
import {
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import type {
  ConfirmSettlementBillInput,
  ConfirmedSettlementDetail,
} from '../../shared/reconciliation';
import { ReconciliationController } from '../../server/modules/reconciliation/reconciliation.controller';
import type { ConfirmedSettlementService } from '../../server/modules/reconciliation/confirmed-settlement.service';
import type { PaddleOcrService } from '../../server/modules/reconciliation/ocr/paddle-ocr.service';
import type { ReconciliationService } from '../../server/modules/reconciliation/reconciliation.service';
import type { VisionExtractionService } from '../../server/modules/reconciliation/vision-extraction.service';

const validInput = (): ConfirmSettlementBillInput => ({
  fileName: 'SHAD64-202605.pdf',
  extraction: {
    sourceType: 'vision_llm',
    fileName: 'SHAD64-202605.pdf',
    headers: [],
    rows: [],
    metadata: {
      mallName: 'Mall A',
      storeName: 'Store A',
      storeCode: '086203',
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
      billType: 'standard',
    },
    periodEvidence: {
      rawText: '2026-05',
      page: 1,
      kind: 'month_only',
    },
    evidence: {},
    additionalFields: [],
    lineItems: [],
    warnings: [],
  },
  reviewedFields: [
    { id: 'mall', label: 'Mall', target: 'mallName', value: 'Mall A' },
    { id: 'store', label: 'Store', target: 'storeName', value: 'Store A' },
    { id: 'code', label: 'Code', target: 'storeCode', value: '086203' },
    { id: 'start', label: 'Start', target: 'periodStart', value: '2026-05-01' },
    { id: 'end', label: 'End', target: 'periodEnd', value: '2026-05-31' },
    { id: 'sales', label: 'Sales', target: 'salesAmount', value: '100.00' },
    {
      id: 'settlement',
      label: 'Settlement',
      target: 'settlementAmount',
      value: '90.00',
    },
  ],
  confirmationKey: '11111111-1111-4111-8111-111111111111',
  clientReportedOcrVerified: true,
});

const inputWithLine = (overrides: Record<string, unknown>) => {
  const input = validInput();
  return {
    ...input,
    extraction: {
      ...input.extraction,
      lineItems: [
        {
          section: '商品销售明细',
          label: '销售行',
          rowType: 'detail',
          sequence: 1,
          values: { amount: '100.00' },
          rawText: null,
          page: 1,
          confidence: 0.98,
          ...overrides,
        },
      ],
    },
  };
};

describe('confirmed settlement API contract', () => {
  const detail = { bill: { id: 'bill-1' } } as ConfirmedSettlementDetail;
  const confirmedService = {
    confirm: jest.fn(),
    list: jest.fn(),
    getById: jest.fn(),
  };
  const controller = new ReconciliationController(
    {} as ReconciliationService,
    {} as VisionExtractionService,
    {} as PaddleOcrService,
    confirmedService as unknown as ConfirmedSettlementService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('publishes the expected Nest routes and HTTP methods', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ReconciliationController)).toBe(
      'api/reconciliation',
    );
    expectRoute(
      'confirmSettlement',
      'confirmed-settlements',
      RequestMethod.POST,
    );
    expectRoute(
      'listConfirmedSettlements',
      'confirmed-settlements',
      RequestMethod.GET,
    );
    expectRoute(
      'getConfirmedSettlement',
      'confirmed-settlements/:id',
      RequestMethod.GET,
    );
    expectRoute(
      'summarizeSettlementAnalysis' as keyof ReconciliationController,
      'analysis/settlements/summary',
      RequestMethod.GET,
    );
    expectRoute(
      'analyzeSettlementFees' as keyof ReconciliationController,
      'analysis/settlements/fees',
      RequestMethod.GET,
    );
    expectRoute(
      'getSettlementAnalysisDetail' as keyof ReconciliationController,
      'analysis/settlements/:id',
      RequestMethod.GET,
    );
  });

  it('wires body, query, and path parameters through real Nest metadata', () => {
    expectRouteArgs('confirmSettlement', {
      [`${RouteParamtypes.BODY}:0`]: { index: 0, data: undefined, pipes: [] },
    });
    expectRouteArgs('listConfirmedSettlements', {
      [`${RouteParamtypes.QUERY}:0`]: {
        index: 0,
        data: 'storeCode',
        pipes: [],
      },
      [`${RouteParamtypes.QUERY}:1`]: {
        index: 1,
        data: 'periodStart',
        pipes: [],
      },
      [`${RouteParamtypes.QUERY}:2`]: {
        index: 2,
        data: 'periodEnd',
        pipes: [],
      },
      [`${RouteParamtypes.QUERY}:3`]: {
        index: 3,
        data: 'includeHistory',
        pipes: [],
      },
    });
    expectRouteArgs('getConfirmedSettlement', {
      [`${RouteParamtypes.PARAM}:0`]: { index: 0, data: 'id', pipes: [] },
    });
  });

  it('confirms a structurally valid reviewed settlement bill', async () => {
    const input = validInput();
    confirmedService.confirm.mockResolvedValue(detail);

    await expect(controller.confirmSettlement(input)).resolves.toEqual(detail);

    expect(confirmedService.confirm).toHaveBeenCalledWith(input);
  });

  it.each([
    null,
    {},
    { ...validInput(), reviewedFields: null },
    { ...validInput(), extraction: null },
    { ...validInput(), clientReportedOcrVerified: 'true' },
    {
      ...validInput(),
      extraction: { ...validInput().extraction, metadata: null },
    },
    {
      ...validInput(),
      extraction: { ...validInput().extraction, lineItems: [null] },
    },
  ])(
    'rejects malformed confirmation body %# before calling the service',
    (body) => {
      expect(() =>
        controller.confirmSettlement(
          body as unknown as ConfirmSettlementBillInput,
        ),
      ).toThrow(BadRequestException);
      expect(confirmedService.confirm).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['rowType', { rowType: 'unknown' }],
    ['page object', { page: { number: 1 } }],
    ['fractional page', { page: 1.5 }],
    ['confidence type', { confidence: '0.98' }],
    ['confidence range', { confidence: 1.1 }],
    ['rawText', { rawText: { text: 'sales' } }],
    ['label length', { label: 'x'.repeat(256) }],
    ['values entry', { values: { amount: { nested: true } } }],
    ['sequence', { sequence: 1.5 }],
  ])('rejects invalid persisted line field %s', (_field, overrides) => {
    const input = inputWithLine(overrides as Record<string, unknown>);

    expect(() =>
      controller.confirmSettlement(
        input as unknown as ConfirmSettlementBillInput,
      ),
    ).toThrow(BadRequestException);
    expect(confirmedService.confirm).not.toHaveBeenCalled();
  });

  it('trims and passes valid list filters to the confirmed service', async () => {
    await controller.listConfirmedSettlements(
      ' 086203 ',
      ' 2026-05-01 ',
      ' 2026-05-31 ',
      ' false ',
    );

    expect(confirmedService.list).toHaveBeenCalledWith({
      storeCode: '086203',
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
      includeHistory: false,
    });
  });

  it('turns blank list filters into undefined and defaults history to false', async () => {
    await controller.listConfirmedSettlements(' ', '\t', '', ' ');

    expect(confirmedService.list).toHaveBeenCalledWith({
      storeCode: undefined,
      periodStart: undefined,
      periodEnd: undefined,
      includeHistory: false,
    });
  });

  it.each(['2026-02-30', '2026-2-01', 'not-a-date'])(
    'rejects invalid periodStart %p before querying the service',
    (periodStart) => {
      expect(() =>
        controller.listConfirmedSettlements(undefined, periodStart),
      ).toThrow(BadRequestException);
      expect(confirmedService.list).not.toHaveBeenCalled();
    },
  );

  it('rejects a reversed query period before querying the service', () => {
    expect(() =>
      controller.listConfirmedSettlements(
        undefined,
        '2026-06-01',
        '2026-05-31',
      ),
    ).toThrow(BadRequestException);
    expect(confirmedService.list).not.toHaveBeenCalled();
  });

  it.each(['TRUE', '1', 'yes'])(
    'rejects invalid includeHistory value %p',
    (includeHistory) => {
      expect(() =>
        controller.listConfirmedSettlements(
          undefined,
          undefined,
          undefined,
          includeHistory,
        ),
      ).toThrow(BadRequestException);
      expect(confirmedService.list).not.toHaveBeenCalled();
    },
  );

  it.each([
    () =>
      controller.listConfirmedSettlements(
        [] as unknown as string,
        undefined,
        undefined,
        undefined,
      ),
    () =>
      controller.listConfirmedSettlements(
        undefined,
        ['2026-05-01'] as unknown as string,
        undefined,
        undefined,
      ),
    () =>
      controller.listConfirmedSettlements(undefined, undefined, undefined, {
        value: 'true',
      } as unknown as string),
  ])('rejects non-string query values before querying the service', (call) => {
    expect(call).toThrow(BadRequestException);
    expect(confirmedService.list).not.toHaveBeenCalled();
  });

  it('enables history for the literal true query value', async () => {
    await controller.listConfirmedSettlements(
      undefined,
      undefined,
      undefined,
      'true',
    );

    expect(confirmedService.list).toHaveBeenCalledWith({
      storeCode: undefined,
      periodStart: undefined,
      periodEnd: undefined,
      includeHistory: true,
    });
  });

  it('loads a confirmed settlement detail by id', async () => {
    confirmedService.getById.mockResolvedValue(detail);

    await expect(controller.getConfirmedSettlement('bill-1')).resolves.toEqual(
      detail,
    );

    expect(confirmedService.getById).toHaveBeenCalledWith('bill-1');
  });
});

function expectRoute(
  methodName: keyof ReconciliationController,
  path: string,
  requestMethod: RequestMethod,
) {
  const handler = ReconciliationController.prototype[methodName];
  expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
  expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(requestMethod);
}

function expectRouteArgs(
  methodName: keyof ReconciliationController,
  expected: Record<string, unknown>,
) {
  expect(
    Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      ReconciliationController,
      methodName,
    ),
  ).toEqual(expected);
}
