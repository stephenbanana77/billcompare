import type {
  ConfirmSettlementBillInput,
  ConfirmedSettlementDetail,
  VisionExtractionResult,
} from '@shared/reconciliation';

export const confirmedMetadataTargets = {
  mallName: 'mallName',
  storeName: 'storeName',
  storeCode: 'storeCode',
  periodStart: 'periodStart',
  periodEnd: 'periodEnd',
} as const;

export type SettlementRequestToken = Readonly<{
  kind: 'recognition' | 'confirmation';
  revision: number;
  billIdentity: string | null;
}>;

export type SettlementRequestCoordinator = ReturnType<
  typeof createSettlementRequestCoordinator
>;

export function getSettlementBillIdentity(
  fileName: string,
  extraction: VisionExtractionResult,
): string {
  const { mallName, storeCode, periodStart, periodEnd, billType } =
    extraction.metadata;
  return JSON.stringify([
    fileName,
    mallName,
    storeCode,
    periodStart,
    periodEnd,
    billType,
  ]);
}

export function isBillInteractionLocked(state: {
  recognizing: boolean;
  confirming: boolean;
}): boolean {
  return state.recognizing || state.confirming;
}

export function mapConfirmedReviewedValues(
  detail: ConfirmedSettlementDetail,
): Record<string, string> {
  return Object.fromEntries(
    detail.reviewedFields
      .filter((field) => field.target.trim())
      .map((field) => [field.target, String(field.value ?? '')]),
  );
}

export function createSettlementRequestCoordinator() {
  let revision = 0;
  let billIdentity: string | null = null;
  let activeConfirmation: SettlementRequestToken | null = null;

  const matches = (
    left: SettlementRequestToken | null,
    right: SettlementRequestToken | null,
  ) =>
    Boolean(
      left &&
      right &&
      left.kind === right.kind &&
      left.revision === right.revision &&
      left.billIdentity === right.billIdentity,
    );

  const isRecognitionCurrent = (
    token: SettlementRequestToken | null,
  ): boolean =>
    Boolean(
      token &&
      token.kind === 'recognition' &&
      token.revision === revision &&
      billIdentity === null,
    );

  return {
    beginRecognition(): SettlementRequestToken | null {
      if (activeConfirmation) return null;
      revision += 1;
      billIdentity = null;
      return { kind: 'recognition', revision, billIdentity: null };
    },
    isRecognitionCurrent,
    activateBill(
      identity: string,
      recognitionToken?: SettlementRequestToken,
    ): boolean {
      if (recognitionToken && !isRecognitionCurrent(recognitionToken)) {
        return false;
      }
      revision += 1;
      billIdentity = identity;
      activeConfirmation = null;
      return true;
    },
    beginConfirmation(identity: string): SettlementRequestToken | null {
      if (activeConfirmation || identity !== billIdentity) return null;
      activeConfirmation = {
        kind: 'confirmation',
        revision,
        billIdentity: identity,
      };
      return activeConfirmation;
    },
    isConfirmationCurrent(token: SettlementRequestToken | null): boolean {
      return Boolean(
        matches(activeConfirmation, token) &&
        token?.billIdentity === billIdentity &&
        token?.revision === revision,
      );
    },
    finishConfirmation(token: SettlementRequestToken | null): void {
      if (matches(activeConfirmation, token)) activeConfirmation = null;
    },
    currentBillIdentity(): string | null {
      return billIdentity;
    },
  };
}

export async function persistSettlementConfirmation(
  input: ConfirmSettlementBillInput,
  confirm: (
    input: ConfirmSettlementBillInput,
  ) => Promise<ConfirmedSettlementDetail>,
  coordinator: SettlementRequestCoordinator,
  token: SettlementRequestToken | null,
  onConfirmed: (detail: ConfirmedSettlementDetail) => void,
): Promise<ConfirmedSettlementDetail | null> {
  const detail = await confirm(input);
  if (!coordinator.isConfirmationCurrent(token)) return null;
  const responseIdentity = getSettlementBillIdentity(
    detail.bill.sourceFileName,
    detail.extraction,
  );
  if (token?.billIdentity !== responseIdentity) return null;
  onConfirmed(detail);
  return detail;
}
