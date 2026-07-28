import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { ConfirmSettlementBillInput } from '../../shared/reconciliation';
import { ReconciliationModule } from '../../server/modules/reconciliation/reconciliation.module';
import { ReconciliationController } from '../../server/modules/reconciliation/reconciliation.controller';
import { ConfirmedSettlementService } from '../../server/modules/reconciliation/confirmed-settlement.service';
import { ReconciliationService } from '../../server/modules/reconciliation/reconciliation.service';
import { VisionExtractionService } from '../../server/modules/reconciliation/vision-extraction.service';
import { PaddleOcrService } from '../../server/modules/reconciliation/ocr/paddle-ocr.service';

const validInput = (): ConfirmSettlementBillInput => ({
  fileName: 'SHAD64-202605.pdf',
  confirmationKey: '11111111-1111-4111-8111-111111111111',
  clientReportedOcrVerified: true,
  extraction: {
    sourceType: 'vision_llm',
    fileName: 'SHAD64-202605.pdf',
    headers: [],
    rows: [],
    metadata: {
      mallName: 'Mall A',
      storeName: 'Store A',
      storeCode: 'SHAD64',
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
    { id: 'code', label: 'Code', target: 'storeCode', value: 'SHAD64' },
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
});

describe('confirmed settlement HTTP contract', () => {
  let app: INestApplication;
  const detail = { bill: { id: 'bill-1', version: 1 } };
  const confirmedService = {
    confirm: jest.fn().mockResolvedValue(detail),
    list: jest.fn().mockResolvedValue([detail.bill]),
    getById: jest.fn().mockResolvedValue(detail),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [ReconciliationModule],
    })
      .overrideProvider(ReconciliationService)
      .useValue({})
      .overrideProvider(VisionExtractionService)
      .useValue({})
      .overrideProvider(PaddleOcrService)
      .useValue({})
      .overrideProvider(ConfirmedSettlementService)
      .useValue(confirmedService)
      .compile();

    expect(module.get(ReconciliationController)).toBeInstanceOf(
      ReconciliationController,
    );
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  it('returns 201 from the wired confirmation route', async () => {
    await request(app.getHttpServer())
      .post('/api/reconciliation/confirmed-settlements')
      .send(validInput())
      .expect(201)
      .expect(detail);

    expect(confirmedService.confirm).toHaveBeenCalledTimes(1);
  });

  it('returns 200 from wired list and detail routes', async () => {
    await request(app.getHttpServer())
      .get('/api/reconciliation/confirmed-settlements')
      .expect(200)
      .expect([detail.bill]);
    await request(app.getHttpServer())
      .get('/api/reconciliation/confirmed-settlements/bill-1')
      .expect(200)
      .expect(detail);
  });

  it('returns 400 with the audit-safe field name for malformed OCR status', async () => {
    const body = validInput() as unknown as Record<string, unknown>;
    body.clientReportedOcrVerified = 'true';

    const response = await request(app.getHttpServer())
      .post('/api/reconciliation/confirmed-settlements')
      .send(body)
      .expect(400);

    expect(response.body.message).toContain('clientReportedOcrVerified');
    expect(confirmedService.confirm).not.toHaveBeenCalled();
  });

  it.each([
    [
      'fileName',
      256,
      (body: ConfirmSettlementBillInput, value: string) => {
        body.fileName = value;
      },
    ],
    [
      'mallName',
      121,
      (body: ConfirmSettlementBillInput, value: string) => {
        body.reviewedFields.find(
          (field) => field.target === 'mallName',
        )!.value = value;
      },
    ],
    [
      'storeName',
      121,
      (body: ConfirmSettlementBillInput, value: string) => {
        body.reviewedFields.find(
          (field) => field.target === 'storeName',
        )!.value = value;
      },
    ],
    [
      'storeCode',
      61,
      (body: ConfirmSettlementBillInput, value: string) => {
        body.reviewedFields.find(
          (field) => field.target === 'storeCode',
        )!.value = value;
      },
    ],
    [
      'settlementNo',
      121,
      (body: ConfirmSettlementBillInput, value: string) => {
        body.reviewedFields.push({
          id: 'number',
          label: 'Number',
          target: 'settlementNo',
          value,
        });
      },
    ],
  ])(
    'returns 400 before persistence for oversized %s',
    async (_field, size, assign) => {
      const body = validInput();
      assign(body, 'x'.repeat(size));

      await request(app.getHttpServer())
        .post('/api/reconciliation/confirmed-settlements')
        .send(body)
        .expect(400);

      expect(confirmedService.confirm).not.toHaveBeenCalled();
    },
  );
});
