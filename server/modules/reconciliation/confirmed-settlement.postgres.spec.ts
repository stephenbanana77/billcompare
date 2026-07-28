import { randomUUID } from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { ConflictException } from '@nestjs/common';
import type { PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import type { ConfirmSettlementBillInput } from '../../../shared/reconciliation';
import { ConfirmedSettlementService } from './confirmed-settlement.service';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), quiet: true });
dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });

const runPostgres = process.env.RUN_POSTGRES_INTEGRATION === '1';
const describePostgres = runPostgres ? describe : describe.skip;

describePostgres('ConfirmedSettlementService PostgreSQL integration', () => {
  const runId = randomUUID();
  const mallName = `Codex Integration ${runId}`;
  const storeCode = `CI-${runId.slice(0, 8)}`;
  const databaseUrl = process.env.SUDA_DATABASE_URL;
  let client: ReturnType<typeof postgres>;
  let service: ConfirmedSettlementService;
  let connected = false;

  const cleanup = async () => {
    await client`
      DELETE FROM reconciliation_confirmed_bills
      WHERE mall_name = ${mallName}
    `;
  };

  const createInput = (
    fileName: string,
    confidence = 0.99,
    confirmationKey = randomUUID(),
    inputStoreCode = storeCode,
  ): ConfirmSettlementBillInput => ({
    fileName,
    confirmationKey,
    clientReportedOcrVerified: true,
    extraction: {
      sourceType: 'vision_llm',
      fileName,
      headers: ['item', 'amount'],
      rows: [],
      metadata: {
        mallName,
        storeName: 'Integration Store',
        storeCode: inputStoreCode,
        periodStart: '2099-01-01',
        periodEnd: '2099-01-31',
        billType: 'standard',
      },
      periodEvidence: {
        rawText: '2099-01-01 to 2099-01-31',
        page: 1,
        kind: 'explicit_range',
      },
      evidence: {},
      additionalFields: [],
      lineItems: [
        {
          section: '销售明细',
          label: 'Sales line',
          rowType: 'detail',
          values: { amount: '100.00' },
          rawText: 'Sales line 100.00',
          page: 1,
          confidence: 0.99,
        },
        {
          section: '费用明细',
          label: 'Fee line',
          rowType: 'detail',
          values: { amount: '10.00' },
          rawText: 'Fee line 10.00',
          page: 1,
          confidence,
        },
      ],
      warnings: [],
    },
    reviewedFields: [
      { id: 'mall', label: 'Mall', target: 'mallName', value: mallName },
      {
        id: 'store',
        label: 'Store',
        target: 'storeName',
        value: 'Integration Store',
      },
      {
        id: 'code',
        label: 'Code',
        target: 'storeCode',
        value: inputStoreCode,
      },
      {
        id: 'start',
        label: 'Start',
        target: 'periodStart',
        value: '2099-01-01',
      },
      {
        id: 'end',
        label: 'End',
        target: 'periodEnd',
        value: '2099-01-31',
      },
      {
        id: 'sales',
        label: 'Sales',
        target: 'salesAmount',
        value: '100.00',
      },
      {
        id: 'settlement',
        label: 'Settlement',
        target: 'settlementAmount',
        value: '90.00',
      },
    ],
  });

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('SUDA_DATABASE_URL is not configured');
    client = postgres(databaseUrl, { max: 6 });
    await client`SELECT 1`;
    connected = true;
    service = new ConfirmedSettlementService(
      drizzle(client) as unknown as PostgresJsDatabase,
    );
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (!client) return;
    if (connected) await cleanup();
    await client.end();
  });

  it('serializes concurrent confirmations and rolls back a failed detail insert', async () => {
    const confirmations = await Promise.all([
      service.confirm(createInput('concurrent-a.pdf')),
      service.confirm(createInput('concurrent-b.pdf')),
    ]);

    expect(confirmations.map(({ bill }) => bill.version).sort()).toEqual([
      1, 2,
    ]);

    const beforeFailure = await client`
      SELECT version, status
      FROM reconciliation_confirmed_bills
      WHERE mall_name = ${mallName}
        AND store_code = ${storeCode}
        AND period_start = '2099-01-01'
        AND period_end = '2099-01-31'
        AND bill_type = 'standard'
      ORDER BY version
    `;
    expect(beforeFailure).toMatchObject([
      { version: 1, status: 'superseded' },
      { version: 2, status: 'confirmed' },
    ]);

    await expect(
      service.confirm(createInput('forced-rollback.pdf', 10)),
    ).rejects.toThrow();

    const afterFailure = await client`
      SELECT version, status
      FROM reconciliation_confirmed_bills
      WHERE mall_name = ${mallName}
        AND store_code = ${storeCode}
        AND period_start = '2099-01-01'
        AND period_end = '2099-01-31'
        AND bill_type = 'standard'
      ORDER BY version
    `;
    expect(afterFailure).toMatchObject([
      { version: 1, status: 'superseded' },
      { version: 2, status: 'confirmed' },
    ]);
  }, 30_000);

  it('returns one version for a retried key and creates V2 for a new key', async () => {
    const idempotentStoreCode = `${storeCode}-IDEM`;
    const confirmationKey = randomUUID();

    const first = await service.confirm(
      createInput('idempotent.pdf', 0.99, confirmationKey, idempotentStoreCode),
    );
    const retry = await service.confirm(
      createInput('idempotent.pdf', 0.99, confirmationKey, idempotentStoreCode),
    );
    const next = await service.confirm(
      createInput('idempotent-v2.pdf', 0.99, randomUUID(), idempotentStoreCode),
    );

    expect(retry.bill).toMatchObject({
      id: first.bill.id,
      version: first.bill.version,
    });
    expect(first.bill.version).toBe(1);
    expect(next.bill.version).toBe(2);

    const persisted = await client`
      SELECT id, version, status, confirmation_key
      FROM reconciliation_confirmed_bills
      WHERE mall_name = ${mallName}
        AND store_code = ${idempotentStoreCode}
      ORDER BY version
    `;
    expect(persisted).toMatchObject([
      {
        id: first.bill.id,
        version: 1,
        status: 'superseded',
        confirmation_key: confirmationKey,
      },
      { id: next.bill.id, version: 2, status: 'confirmed' },
    ]);
  }, 30_000);

  it('serializes a shared confirmation key before identity handling and returns 409 for a different identity', async () => {
    const sharedKey = randomUUID();
    const firstStoreCode = `${storeCode}-KEY-A`;
    const secondStoreCode = `${storeCode}-KEY-B`;

    const results = await Promise.allSettled([
      service.confirm(
        createInput('shared-key-a.pdf', 0.99, sharedKey, firstStoreCode),
      ),
      service.confirm(
        createInput('shared-key-b.pdf', 0.99, sharedKey, secondStoreCode),
      ),
    ]);

    const fulfilled = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof service.confirm>>
      > => result.status === 'fulfilled',
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);
    expect(rejected[0].reason.getStatus()).toBe(409);

    const persisted = await client`
      SELECT id, store_code, version, status, confirmation_key
      FROM reconciliation_confirmed_bills
      WHERE mall_name = ${mallName}
        AND confirmation_key = ${sharedKey}
      ORDER BY store_code
    `;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      id: fulfilled[0].value.bill.id,
      version: 1,
      status: 'confirmed',
      confirmation_key: sharedKey,
    });
  }, 30_000);
});
