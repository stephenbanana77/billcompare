jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({
  axiosForBackend: jest.fn(),
}));

import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type {
  ConfirmSettlementBillInput,
  ConfirmedSettlementDetail,
} from '../../shared/reconciliation';
import { reconciliationApi } from '../../client/src/api';
import {
  confirmedMetadataTargets,
  persistSettlementConfirmation,
} from '../../client/src/lib/settlement-confirmation';

const mockedAxios = axiosForBackend as jest.MockedFunction<
  typeof axiosForBackend
>;

const input = {
  fileName: 'SHAD64结算单-202605.pdf',
  extraction: { metadata: { billType: 'mall_settlement' } },
  reviewedFields: [],
  ocrVerified: true,
} as unknown as ConfirmSettlementBillInput;

const detail = {
  bill: {
    id: 'confirmed-bill-1',
    version: 2,
    confirmedBy: 'Demo Operator',
    confirmedAt: '2026-07-27T08:00:00.000Z',
  },
  reviewedFields: [],
  salesLines: [],
  feeLines: [],
} as unknown as ConfirmedSettlementDetail;

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

    await expect(
      persistSettlementConfirmation(input, async () => detail, onConfirmed),
    ).resolves.toBe(detail);
    expect(onConfirmed).toHaveBeenCalledWith(detail);
  });

  it('does not commit confirmed UI state when persistence fails', async () => {
    const onConfirmed = jest.fn();
    const error = new Error('后端暂时不可用');

    await expect(
      persistSettlementConfirmation(
        input,
        async () => Promise.reject(error),
        onConfirmed,
      ),
    ).rejects.toBe(error);
    expect(onConfirmed).not.toHaveBeenCalled();
  });
});
