import type {
  ConfirmSettlementBillInput,
  ConfirmedSettlementDetail,
} from '@shared/reconciliation';

export const confirmedMetadataTargets = {
  mallName: 'mallName',
  storeName: 'storeName',
  storeCode: 'storeCode',
  periodStart: 'periodStart',
  periodEnd: 'periodEnd',
} as const;

export async function persistSettlementConfirmation(
  input: ConfirmSettlementBillInput,
  confirm: (
    input: ConfirmSettlementBillInput,
  ) => Promise<ConfirmedSettlementDetail>,
  onConfirmed: (detail: ConfirmedSettlementDetail) => void,
): Promise<ConfirmedSettlementDetail> {
  const detail = await confirm(input);
  onConfirmed(detail);
  return detail;
}
