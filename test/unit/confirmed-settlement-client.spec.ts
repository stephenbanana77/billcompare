jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({
  axiosForBackend: jest.fn(),
}));

import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type {
  ConfirmSettlementBillInput,
  ConfirmedSettlementDetail,
  VisionExtractionResult,
} from '../../shared/reconciliation';
import { reconciliationApi } from '../../client/src/api';
import {
  confirmedMetadataTargets,
  createSettlementRequestCoordinator,
  getSettlementBillIdentity,
  isBillInteractionLocked,
  mapConfirmedReviewedValues,
  persistSettlementConfirmation,
} from '../../client/src/lib/settlement-confirmation';

const mockedAxios = axiosForBackend as jest.MockedFunction<
  typeof axiosForBackend
>;

const extraction: VisionExtractionResult = {
  sourceType: 'vision_llm',
  fileName: 'SHAD64结算单-202605.pdf',
  headers: [],
  rows: [],
  metadata: {
    mallName: '上海久光中心',
    storeName: '阿迪达斯门店',
    storeCode: 'SHAD64',
    periodStart: '2026-05-01',
    periodEnd: '2026-05-31',
    billType: 'complex',
  },
  periodEvidence: {
    rawText: '2026-05-01 至 2026-05-31',
    page: 1,
    kind: 'explicit_range',
  },
  evidence: {},
  additionalFields: [],
  lineItems: [],
  warnings: [],
};

const reviewedFields = [
  { id: 'mall', label: '商场名称', target: 'mallName', value: '上海久光中心' },
  {
    id: 'store',
    label: '门店名称',
    target: 'storeName',
    value: '阿迪达斯门店',
  },
] satisfies ConfirmSettlementBillInput['reviewedFields'];

const input: ConfirmSettlementBillInput = {
  fileName: 'SHAD64结算单-202605.pdf',
  extraction,
  reviewedFields,
  confirmationKey: '11111111-1111-4111-8111-111111111111',
  clientReportedOcrVerified: true,
};

const detail: ConfirmedSettlementDetail = {
  bill: {
    id: 'confirmed-bill-1',
    version: 2,
    status: 'confirmed',
    sourceFileName: input.fileName,
    mallName: extraction.metadata.mallName,
    storeName: extraction.metadata.storeName,
    storeCode: extraction.metadata.storeCode,
    periodStart: extraction.metadata.periodStart,
    periodEnd: extraction.metadata.periodEnd,
    billType: extraction.metadata.billType,
    settlementNo: null,
    salesAmount: '69843.00',
    invoiceAmount: '60566.31',
    deductionTotal: '5650.47',
    settlementAmount: '54915.84',
    confirmationKey: input.confirmationKey,
    clientReportedOcrVerified: true,
    confirmedBy: 'Demo Operator',
    confirmedAt: '2026-07-27T08:00:00.000Z',
    createdAt: '2026-07-27T08:00:00.000Z',
    updatedAt: '2026-07-27T08:00:00.000Z',
  },
  reviewedFields,
  extraction,
  salesLines: [],
  feeLines: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('confirmed settlement client', () => {
  beforeEach(() => {
    mockedAxios.mockReset();
  });

  it('uses the backend canonical target for the required store name', () => {
    expect(confirmedMetadataTargets.storeName).toBe('storeName');
  });

  it('posts the reviewed extraction to the confirmation endpoint', async () => {
    mockedAxios.mockResolvedValue({ data: { data: detail } });

    await expect(reconciliationApi.confirmSettlement(input)).resolves.toBe(
      detail,
    );
    expect(mockedAxios).toHaveBeenCalledWith({
      url: '/api/reconciliation/confirmed-settlements',
      method: 'POST',
      data: input,
    });
  });

  it('lists and loads confirmed settlements through typed endpoints', async () => {
    mockedAxios
      .mockResolvedValueOnce({ data: { data: [detail.bill] } })
      .mockResolvedValueOnce({ data: { data: detail } });

    await reconciliationApi.confirmedSettlements({
      storeCode: 'SHAD64',
      includeHistory: true,
    });
    await reconciliationApi.confirmedSettlement('confirmed-bill-1');

    expect(mockedAxios).toHaveBeenNthCalledWith(1, {
      url: '/api/reconciliation/confirmed-settlements',
      method: 'GET',
      params: { storeCode: 'SHAD64', includeHistory: true },
    });
    expect(mockedAxios).toHaveBeenNthCalledWith(2, {
      url: '/api/reconciliation/confirmed-settlements/confirmed-bill-1',
      method: 'GET',
    });
  });

  it('commits confirmed UI state only after persistence succeeds', async () => {
    const onConfirmed = jest.fn();
    const coordinator = createSettlementRequestCoordinator();
    const identity = getSettlementBillIdentity(input.fileName, extraction);
    coordinator.activateBill(identity);
    const token = coordinator.beginConfirmation(identity);

    await expect(
      persistSettlementConfirmation(
        input,
        async () => detail,
        coordinator,
        token,
        onConfirmed,
      ),
    ).resolves.toBe(detail);
    expect(onConfirmed).toHaveBeenCalledWith(detail);
  });

  it('does not commit confirmed UI state when persistence fails', async () => {
    const onConfirmed = jest.fn();
    const error = new Error('后端暂时不可用');
    const coordinator = createSettlementRequestCoordinator();
    const identity = getSettlementBillIdentity(input.fileName, extraction);
    coordinator.activateBill(identity);
    const token = coordinator.beginConfirmation(identity);

    await expect(
      persistSettlementConfirmation(
        input,
        async () => Promise.reject(error),
        coordinator,
        token,
        onConfirmed,
      ),
    ).rejects.toBe(error);
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('locks all bill interactions while recognizing or confirming', () => {
    expect(
      isBillInteractionLocked({ recognizing: false, confirming: false }),
    ).toBe(false);
    expect(
      isBillInteractionLocked({ recognizing: true, confirming: false }),
    ).toBe(true);
    expect(
      isBillInteractionLocked({ recognizing: false, confirming: true }),
    ).toBe(true);
  });

  it('rejects new recognition while a confirmation request is active', () => {
    const coordinator = createSettlementRequestCoordinator();
    const identity = getSettlementBillIdentity(input.fileName, extraction);
    coordinator.activateBill(identity);
    coordinator.beginConfirmation(identity);

    expect(coordinator.beginRecognition()).toBeNull();
    expect(coordinator.currentBillIdentity()).toBe(identity);
  });

  it('reuses one confirmation key after a failed request and rotates it after success', () => {
    const coordinator = createSettlementRequestCoordinator();
    const identity = getSettlementBillIdentity(input.fileName, extraction);
    coordinator.activateBill(identity);

    const first = coordinator.beginConfirmation(identity);
    expect(first?.confirmationKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    coordinator.finishConfirmation(first, false);

    const retry = coordinator.beginConfirmation(identity);
    expect(retry?.confirmationKey).toBe(first?.confirmationKey);
    coordinator.finishConfirmation(retry, true);

    const next = coordinator.beginConfirmation(identity);
    expect(next?.confirmationKey).not.toBe(first?.confirmationKey);
  });

  it('ignores a delayed confirmation response after the active bill changes', async () => {
    const coordinator = createSettlementRequestCoordinator();
    const identity = getSettlementBillIdentity(input.fileName, extraction);
    coordinator.activateBill(identity);
    const token = coordinator.beginConfirmation(identity);
    const pendingResponse = deferred<ConfirmedSettlementDetail>();
    const onConfirmed = jest.fn();
    const pending = persistSettlementConfirmation(
      input,
      async () => pendingResponse.promise,
      coordinator,
      token,
      onConfirmed,
    );

    coordinator.finishConfirmation(token);
    const recognitionToken = coordinator.beginRecognition();
    expect(recognitionToken).not.toBeNull();
    coordinator.activateBill('other.pdf|OTHER|2026-06-01|2026-06-30');
    pendingResponse.resolve(detail);

    await expect(pending).resolves.toBeNull();
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('ignores a response whose bill identity does not match the request', async () => {
    const coordinator = createSettlementRequestCoordinator();
    const identity = getSettlementBillIdentity(input.fileName, extraction);
    coordinator.activateBill(identity);
    const token = coordinator.beginConfirmation(identity);
    const mismatchedDetail = structuredClone(detail);
    mismatchedDetail.bill.storeCode = 'OTHER';
    mismatchedDetail.extraction.metadata.storeCode = 'OTHER';
    const onConfirmed = jest.fn();

    await expect(
      persistSettlementConfirmation(
        input,
        async () => mismatchedDetail,
        coordinator,
        token,
        onConfirmed,
      ),
    ).resolves.toBeNull();
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('maps confirmed display values only from the server response', () => {
    const mutableRows = [{ target: 'mallName', value: '被继续修改的页面值' }];
    const values = mapConfirmedReviewedValues(detail);
    mutableRows[0].value = '另一个页面值';

    expect(values).toEqual({
      mallName: '上海久光中心',
      storeName: '阿迪达斯门店',
    });
  });
});
