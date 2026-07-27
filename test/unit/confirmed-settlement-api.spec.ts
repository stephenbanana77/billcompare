import type {
  ConfirmSettlementBillInput,
  ConfirmedSettlementDetail,
} from '../../shared/reconciliation';

jest.mock('@nestjs/common', () => {
  const actual = jest.requireActual('@nestjs/common');
  const decorator = () => () => undefined;
  return {
    ...actual,
    Body: decorator,
    Controller: decorator,
    Delete: decorator,
    Get: decorator,
    Param: decorator,
    Patch: decorator,
    Post: decorator,
    Put: decorator,
    Query: decorator,
    UploadedFiles: decorator,
    UseInterceptors: decorator,
  };
});

import { ReconciliationController } from '../../server/modules/reconciliation/reconciliation.controller';
import type { ConfirmedSettlementService } from '../../server/modules/reconciliation/confirmed-settlement.service';
import type { PaddleOcrService } from '../../server/modules/reconciliation/ocr/paddle-ocr.service';
import type { ReconciliationService } from '../../server/modules/reconciliation/reconciliation.service';
import type { VisionExtractionService } from '../../server/modules/reconciliation/vision-extraction.service';

describe('confirmed settlement API contract', () => {
  const input = {
    fileName: 'SHAD64-202605.pdf',
    extraction: { fileName: 'SHAD64-202605.pdf' },
    reviewedFields: [],
  } as unknown as ConfirmSettlementBillInput;
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

  it('confirms a reviewed settlement bill', async () => {
    confirmedService.confirm.mockResolvedValue(detail);

    await expect(controller.confirmSettlement(input)).resolves.toEqual(detail);

    expect(confirmedService.confirm).toHaveBeenCalledWith(input);
  });

  it('trims and passes list filters to the confirmed service', async () => {
    await controller.listConfirmedSettlements(
      ' 086203 ',
      ' 2026-05-01 ',
      ' 2026-05-31 ',
      'false',
    );

    expect(confirmedService.list).toHaveBeenCalledWith({
      storeCode: '086203',
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
      includeHistory: false,
    });
  });

  it('turns blank list filters into undefined', async () => {
    await controller.listConfirmedSettlements(' ', '\t', '', undefined);

    expect(confirmedService.list).toHaveBeenCalledWith({
      storeCode: undefined,
      periodStart: undefined,
      periodEnd: undefined,
      includeHistory: false,
    });
  });

  it.each(['TRUE', '1', ' true ', 'false', undefined])(
    'does not enable history for %p',
    async (includeHistory) => {
      await controller.listConfirmedSettlements(
        undefined,
        undefined,
        undefined,
        includeHistory,
      );

      expect(confirmedService.list).toHaveBeenCalledWith({
        storeCode: undefined,
        periodStart: undefined,
        periodEnd: undefined,
        includeHistory: false,
      });
    },
  );

  it('enables history only for the literal true query value', async () => {
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
