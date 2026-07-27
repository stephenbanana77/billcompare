# Confirmed Settlement Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist manually reviewed settlement bills and their sales/fee lines in PostgreSQL so later REST analytics and Cherry Studio MCP tools have a durable, confirmed-only data source.

**Architecture:** Add focused confirmed-bill tables and a `ConfirmedSettlementService` beside the existing reconciliation workflow. The recognition page sends the original extraction plus final reviewed field values to a transactional confirmation endpoint; the server validates and derives canonical columns, supersedes an older active version for the same store and period, and writes line items and audit data atomically.

**Tech Stack:** NestJS 10, TypeScript 5, Drizzle ORM/PostgreSQL, React 19, Axios, Jest/ts-jest

---

## Scope And File Map

This plan implements only the persistence foundation. Organization scopes, analytics, MCP, and embedded chat are separate follow-up plans that consume the API and tables created here.

**Create:**

- `migrations/007_confirmed_settlement_bills.sql` - durable tables, indexes, version constraints, and foreign keys.
- `server/modules/reconciliation/confirmed-settlement.mapper.ts` - pure validation and canonical field/line mapping.
- `server/modules/reconciliation/confirmed-settlement.mapper.spec.ts` - mapper behavior and edge cases.
- `server/modules/reconciliation/confirmed-settlement.service.ts` - database transaction, version replacement, listing, and detail retrieval.
- `server/modules/reconciliation/confirmed-settlement.service.spec.ts` - transactional persistence and query tests with a controlled database double.
- `test/unit/confirmed-settlement-api.spec.ts` - controller contract tests.

**Modify:**

- `server/database/reconciliation.schema.ts` - Drizzle definitions for the new tables.
- `shared/reconciliation.ts` - shared confirmation input/output contracts.
- `server/modules/reconciliation/reconciliation.module.ts` - register the focused service.
- `server/modules/reconciliation/reconciliation.controller.ts` - confirmation, list, and detail routes.
- `client/src/types/reconciliation.ts` - re-export/use shared confirmed-bill contracts where needed by UI.
- `client/src/api/index.ts` - typed confirmed-bill API methods.
- `client/src/pages/BillRecognitionPage.tsx` - replace local-only confirmation with the server transaction and display the confirmed record ID/version.

## Task 1: Shared Confirmation Contracts

**Files:**

- Modify: `shared/reconciliation.ts`
- Test: `server/modules/reconciliation/confirmed-settlement.mapper.spec.ts`

- [ ] **Step 1: Add a failing type-driven mapper test fixture**

Create `server/modules/reconciliation/confirmed-settlement.mapper.spec.ts` with the desired input contract:

```ts
import type { ConfirmSettlementBillInput } from '@shared/reconciliation';
import { mapConfirmedSettlement } from './confirmed-settlement.mapper';

const input: ConfirmSettlementBillInput = {
  fileName: 'SHAD64结算单-202605.pdf',
  extraction: {
    sourceType: 'vision_llm',
    fileName: 'SHAD64结算单-202605.pdf',
    headers: [],
    rows: [],
    metadata: {
      mallName: '百联滨江购物中心',
      storeName: '阿迪达斯',
      storeCode: '086203',
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
      billType: 'standard',
    },
    periodEvidence: { rawText: '2026-05', page: 1, kind: 'month_only' },
    evidence: {},
    additionalFields: [],
    lineItems: [],
    warnings: [],
  },
  reviewedFields: [
    { id: 'mall', label: '商场名称', target: 'mallName', value: '百联滨江购物中心' },
    { id: 'store', label: '品牌/门店', target: 'storeName', value: '阿迪达斯' },
    { id: 'code', label: '柜号', target: 'storeCode', value: '086203' },
    { id: 'start', label: '账期开始', target: 'periodStart', value: '2026-05-01' },
    { id: 'end', label: '账期结束', target: 'periodEnd', value: '2026-05-31' },
    { id: 'sales', label: '销售金额', target: 'salesAmount', value: '69843' },
    { id: 'invoice', label: '发票金额', target: 'invoiceAmount', value: '60566.31' },
    { id: 'deduction', label: '扣款合计', target: 'deductionTotal', value: '5650.47' },
    { id: 'settlement', label: '实付金额', target: 'settlementAmount', value: '54915.84' },
  ],
  ocrVerified: true,
};

describe('mapConfirmedSettlement', () => {
  it('uses final reviewed fields for canonical dimensions and money', () => {
    expect(mapConfirmedSettlement(input).bill).toMatchObject({
      mallName: '百联滨江购物中心',
      storeName: '阿迪达斯',
      storeCode: '086203',
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
      salesAmount: '69843.00',
      invoiceAmount: '60566.31',
      deductionTotal: '5650.47',
      settlementAmount: '54915.84',
    });
  });
});
```

- [ ] **Step 2: Run the mapper test to verify RED**

Run:

```powershell
npm test -- --runInBand server/modules/reconciliation/confirmed-settlement.mapper.spec.ts
```

Expected: FAIL because `ConfirmSettlementBillInput` and `mapConfirmedSettlement` do not exist.

- [ ] **Step 3: Add shared request and response types**

Append to `shared/reconciliation.ts`:

```ts
export interface ConfirmedFieldValue {
  id: string;
  label: string;
  target: string;
  value: string | number | null;
}

export interface ConfirmSettlementBillInput {
  fileName: string;
  extraction: VisionExtractionResult;
  reviewedFields: ConfirmedFieldValue[];
  ocrVerified: boolean;
}

export type ConfirmedSettlementStatus = 'confirmed' | 'superseded' | 'revoked';

export interface ConfirmedSettlementBill {
  id: string;
  version: number;
  status: ConfirmedSettlementStatus;
  sourceFileName: string;
  mallName: string;
  storeName: string;
  storeCode: string;
  periodStart: string;
  periodEnd: string;
  billType: VisionExtractionResult['metadata']['billType'];
  settlementNo: string | null;
  salesAmount: string;
  invoiceAmount: string | null;
  deductionTotal: string | null;
  settlementAmount: string;
  ocrVerified: boolean;
  confirmedBy: string;
  confirmedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConfirmedSettlementDetail {
  bill: ConfirmedSettlementBill;
  reviewedFields: ConfirmedFieldValue[];
  extraction: VisionExtractionResult;
  salesLines: VisionLineItem[];
  feeLines: VisionLineItem[];
}
```

- [ ] **Step 4: Re-run TypeScript compilation to expose only the missing mapper**

Run:

```powershell
npm run type:check:server
```

Expected: shared contracts compile; the mapper test still fails until Task 2.

- [ ] **Step 5: Commit shared contracts and the red test**

```powershell
git add shared/reconciliation.ts server/modules/reconciliation/confirmed-settlement.mapper.spec.ts
git commit -m "test: define confirmed settlement contract"
```

## Task 2: Pure Confirmation Mapper

**Files:**

- Create: `server/modules/reconciliation/confirmed-settlement.mapper.ts`
- Modify: `server/modules/reconciliation/confirmed-settlement.mapper.spec.ts`

- [ ] **Step 1: Add validation and line-classification test cases**

Extend the spec with:

```ts
it('rejects duplicate targets and missing required fields', () => {
  expect(() => mapConfirmedSettlement({
    ...input,
    reviewedFields: [
      ...input.reviewedFields,
      { id: 'sales-2', label: '销售金额副本', target: 'salesAmount', value: '1' },
    ],
  })).toThrow('salesAmount');

  expect(() => mapConfirmedSettlement({
    ...input,
    reviewedFields: input.reviewedFields.filter((field) => field.target !== 'storeCode'),
  })).toThrow('storeCode');
});

it('separates sales and fee rows while preserving source order', () => {
  const mapped = mapConfirmedSettlement({
    ...input,
    extraction: {
      ...input.extraction,
      lineItems: [
        { section: '商品销售与进货结算明细', label: '扣率:-15', rowType: 'detail', sequence: 1, values: { 销售金额: 49847 }, rawText: null, page: 1, confidence: 0.98 },
        { section: '扣款费用明细', label: '管理费-0201', rowType: 'detail', sequence: 2, values: { 金额: 2517.5 }, rawText: null, page: 1, confidence: 0.98 },
      ],
    },
  });
  expect(mapped.salesLines.map((line) => line.label)).toEqual(['扣率:-15']);
  expect(mapped.feeLines.map((line) => line.label)).toEqual(['管理费-0201']);
});
```

- [ ] **Step 2: Run tests to verify the new cases fail**

Run the mapper spec and confirm failures are caused by missing validation/classification.

- [ ] **Step 3: Implement the mapper**

Create `confirmed-settlement.mapper.ts` with:

```ts
import { BadRequestException } from '@nestjs/common';
import type {
  ConfirmSettlementBillInput,
  ConfirmedFieldValue,
  VisionLineItem,
} from '@shared/reconciliation';

const requiredTargets = [
  'mallName', 'storeName', 'storeCode', 'periodStart', 'periodEnd',
  'salesAmount', 'settlementAmount',
] as const;

const money = (value: unknown, target: string): string | null => {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(/[,\s]/g, ''));
  if (!Number.isFinite(parsed)) throw new BadRequestException(`${target} must be numeric`);
  return parsed.toFixed(2);
};

const text = (value: unknown) => String(value ?? '').trim();

const indexReviewedFields = (fields: ConfirmedFieldValue[]) => {
  const values = new Map<string, ConfirmedFieldValue>();
  for (const field of fields) {
    if (!field.target) continue;
    if (values.has(field.target)) {
      throw new BadRequestException(`duplicate reviewed target: ${field.target}`);
    }
    values.set(field.target, field);
  }
  for (const target of requiredTargets) {
    if (!text(values.get(target)?.value)) {
      throw new BadRequestException(`missing reviewed target: ${target}`);
    }
  }
  return values;
};

const isFeeLine = (line: VisionLineItem) => line.section.includes('费用');
const isSalesLine = (line: VisionLineItem) => line.section.includes('销售');

export const mapConfirmedSettlement = (input: ConfirmSettlementBillInput) => {
  if (!input.fileName.trim()) throw new BadRequestException('fileName is required');
  const reviewed = indexReviewedFields(input.reviewedFields);
  const value = (target: string) => reviewed.get(target)?.value;
  return {
    bill: {
      sourceFileName: input.fileName.trim(),
      mallName: text(value('mallName')),
      storeName: text(value('storeName')),
      storeCode: text(value('storeCode')),
      periodStart: text(value('periodStart')),
      periodEnd: text(value('periodEnd')),
      billType: input.extraction.metadata.billType,
      settlementNo: text(value('settlementNo')) || null,
      salesAmount: money(value('salesAmount'), 'salesAmount')!,
      invoiceAmount: money(value('invoiceAmount'), 'invoiceAmount'),
      deductionTotal: money(value('deductionTotal'), 'deductionTotal'),
      settlementAmount: money(value('settlementAmount'), 'settlementAmount')!,
      ocrVerified: Boolean(input.ocrVerified),
      reviewedFields: input.reviewedFields,
      extractionPayload: input.extraction,
    },
    salesLines: input.extraction.lineItems.filter(isSalesLine),
    feeLines: input.extraction.lineItems.filter(isFeeLine),
  };
};
```

- [ ] **Step 4: Run mapper tests and server typecheck**

Expected: mapper tests PASS and `npm run type:check:server` exits 0.

- [ ] **Step 5: Commit the mapper**

```powershell
git add server/modules/reconciliation/confirmed-settlement.mapper.ts server/modules/reconciliation/confirmed-settlement.mapper.spec.ts
git commit -m "feat: validate confirmed settlement payloads"
```

## Task 3: Database Migration And Drizzle Schema

**Files:**

- Create: `migrations/007_confirmed_settlement_bills.sql`
- Modify: `server/database/reconciliation.schema.ts`

- [ ] **Step 1: Add a schema contract assertion to the service spec**

Create `confirmed-settlement.service.spec.ts` and import the three table objects. Assert table names through `getTableName`:

```ts
import { getTableName } from 'drizzle-orm';
import {
  reconciliationConfirmedBills,
  reconciliationConfirmedSalesLines,
  reconciliationConfirmedFeeLines,
} from '@server/database/reconciliation.schema';

it('maps confirmed settlement tables to stable database names', () => {
  expect(getTableName(reconciliationConfirmedBills)).toBe('reconciliation_confirmed_bills');
  expect(getTableName(reconciliationConfirmedSalesLines)).toBe('reconciliation_confirmed_sales_lines');
  expect(getTableName(reconciliationConfirmedFeeLines)).toBe('reconciliation_confirmed_fee_lines');
});
```

- [ ] **Step 2: Run the spec to verify RED**

Expected: FAIL because the table exports do not exist.

- [ ] **Step 3: Write migration 007**

Create SQL that defines:

```sql
BEGIN;

CREATE TABLE reconciliation_confirmed_bills (
  id uuid PRIMARY KEY,
  version integer NOT NULL,
  status varchar(24) NOT NULL,
  source_file_name varchar(255) NOT NULL,
  mall_name varchar(120) NOT NULL,
  store_name varchar(120) NOT NULL,
  store_code varchar(60) NOT NULL,
  period_start varchar(10) NOT NULL,
  period_end varchar(10) NOT NULL,
  bill_type varchar(40) NOT NULL,
  settlement_no varchar(120),
  sales_amount numeric(16,2) NOT NULL,
  invoice_amount numeric(16,2),
  deduction_total numeric(16,2),
  settlement_amount numeric(16,2) NOT NULL,
  ocr_verified boolean NOT NULL DEFAULT false,
  reviewed_fields jsonb NOT NULL,
  extraction_payload jsonb NOT NULL,
  confirmed_by varchar(120) NOT NULL,
  confirmed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (store_code, period_start, period_end, version)
);

CREATE UNIQUE INDEX uq_confirmed_bill_active_period
  ON reconciliation_confirmed_bills(store_code, period_start, period_end)
  WHERE status = 'confirmed';

CREATE INDEX idx_confirmed_bill_query
  ON reconciliation_confirmed_bills(store_code, period_start, period_end, status);

CREATE TABLE reconciliation_confirmed_sales_lines (
  id uuid PRIMARY KEY,
  bill_id uuid NOT NULL REFERENCES reconciliation_confirmed_bills(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  label varchar(255) NOT NULL,
  row_type varchar(24) NOT NULL,
  values jsonb NOT NULL,
  raw_text text,
  source_page integer,
  confidence numeric(5,4)
);

CREATE TABLE reconciliation_confirmed_fee_lines (
  id uuid PRIMARY KEY,
  bill_id uuid NOT NULL REFERENCES reconciliation_confirmed_bills(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  label varchar(255) NOT NULL,
  row_type varchar(24) NOT NULL,
  values jsonb NOT NULL,
  raw_text text,
  source_page integer,
  confidence numeric(5,4)
);

CREATE INDEX idx_confirmed_sales_bill ON reconciliation_confirmed_sales_lines(bill_id, sequence);
CREATE INDEX idx_confirmed_fee_bill ON reconciliation_confirmed_fee_lines(bill_id, sequence);

COMMIT;
```

- [ ] **Step 4: Mirror the migration in Drizzle schema**

Add table definitions using existing `pgTable`, `uuid`, `varchar`, `numeric`, `boolean`, `integer`, `jsonb`, `text`, and `timestamp` patterns. Type `reviewedFields` as `ConfirmedFieldValue[]`, `extractionPayload` as `VisionExtractionResult`, and line `values` as `VisionLineItem['values']`.

- [ ] **Step 5: Run schema spec and typecheck**

Expected: table-name test PASS; server and client typechecks exit 0.

- [ ] **Step 6: Commit migration and schema**

```powershell
git add migrations/007_confirmed_settlement_bills.sql server/database/reconciliation.schema.ts server/modules/reconciliation/confirmed-settlement.service.spec.ts
git commit -m "feat: add confirmed settlement storage schema"
```

## Task 4: Transactional Confirmed Settlement Service

**Files:**

- Create: `server/modules/reconciliation/confirmed-settlement.service.ts`
- Modify: `server/modules/reconciliation/confirmed-settlement.service.spec.ts`

- [ ] **Step 1: Write failing service behavior tests**

Use a controlled Drizzle database double and assert these behaviors independently:

```ts
it('writes bill and all detail lines in one transaction', async () => {
  const created = await service.confirm(input);
  expect(created.bill.status).toBe('confirmed');
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(insertedSalesLines).toHaveLength(10);
  expect(insertedFeeLines).toHaveLength(11);
});

it('supersedes the current version before inserting the next version', async () => {
  existingActiveBill = { id: 'old-id', version: 1 };
  const created = await service.confirm(input);
  expect(updatedBill).toMatchObject({ id: 'old-id', status: 'superseded' });
  expect(created.bill.version).toBe(2);
});

it('lists only confirmed versions by default', async () => {
  await service.list({ storeCode: '086203', periodStart: '2026-05-01', periodEnd: '2026-05-31' });
  expect(queryFilters).toContainEqual(expect.objectContaining({ status: 'confirmed' }));
});

it('throws when a requested bill does not exist', async () => {
  await expect(service.getById('missing')).rejects.toThrow('not found');
});
```

- [ ] **Step 2: Run the service spec to verify RED**

Expected: FAIL because `ConfirmedSettlementService` does not exist.

- [ ] **Step 3: Implement `confirm()` as one database transaction**

The service must:

1. Call `mapConfirmedSettlement(input)` before opening a transaction.
2. Use `pg_advisory_xact_lock(hashtext(storeCode || ':' || periodStart || ':' || periodEnd))` to serialize confirmation of the same logical period.
3. Query the active version for the store and period.
4. Mark it `superseded` when present.
5. Insert version `existing.version + 1`, otherwise version `1`.
6. Set `confirmedBy` from `process.env.DEMO_OPERATOR_NAME ?? 'Demo Operator'` until the identity plan replaces this source.
7. Insert mapped sales and fee rows with stable sequence numbers.
8. Return `getById(newId)` after the transaction commits.

Use a private helper for line inserts:

```ts
private lineValues(billId: string, lines: VisionLineItem[]) {
  return lines.map((line, index) => ({
    id: randomUUID(),
    billId,
    sequence: line.sequence ?? index + 1,
    label: line.label,
    rowType: line.rowType ?? 'detail',
    values: line.values,
    rawText: line.rawText,
    sourcePage: line.page,
    confidence: typeof line.confidence === 'number' ? String(line.confidence) : null,
  }));
}
```

- [ ] **Step 4: Implement `list()` and `getById()`**

`list()` accepts optional `storeCode`, `periodStart`, `periodEnd`, and `includeHistory`. It defaults to `status = confirmed`, orders by period descending, and caps results at 200. `getById()` fetches bill and both line tables, orders lines by sequence, and reconstructs `ConfirmedSettlementDetail` using the stored payloads.

- [ ] **Step 5: Run service tests and typecheck**

Expected: all service tests PASS and server typecheck exits 0.

- [ ] **Step 6: Commit service implementation**

```powershell
git add server/modules/reconciliation/confirmed-settlement.service.ts server/modules/reconciliation/confirmed-settlement.service.spec.ts
git commit -m "feat: persist confirmed settlement versions"
```

## Task 5: REST Confirmation And Query Endpoints

> Scope note: these endpoints use the platform's existing global authentication. Store, region, and finance/admin authorization is intentionally deferred to the separately approved permissions and analytics plan.

**Files:**

- Modify: `server/modules/reconciliation/reconciliation.module.ts`
- Modify: `server/modules/reconciliation/reconciliation.controller.ts`
- Create: `test/unit/confirmed-settlement-api.spec.ts`

- [ ] **Step 1: Write failing controller contract tests**

Test direct controller calls with a mocked `ConfirmedSettlementService`:

```ts
it('confirms a reviewed settlement bill', async () => {
  confirmedService.confirm.mockResolvedValue(detail);
  await expect(controller.confirmSettlement(input)).resolves.toEqual(detail);
  expect(confirmedService.confirm).toHaveBeenCalledWith(input);
});

it('passes list filters to the confirmed service', async () => {
  await controller.listConfirmedSettlements('086203', '2026-05-01', '2026-05-31', 'false');
  expect(confirmedService.list).toHaveBeenCalledWith({
    storeCode: '086203',
    periodStart: '2026-05-01',
    periodEnd: '2026-05-31',
    includeHistory: false,
  });
});
```

- [ ] **Step 2: Run the controller test to verify RED**

Expected: FAIL because the controller methods and injected service do not exist.

- [ ] **Step 3: Register the service and add routes**

Add `ConfirmedSettlementService` to module providers and controller constructor. Add:

```ts
@Post('confirmed-settlements')
confirmSettlement(@Body() input: ConfirmSettlementBillInput) {
  return this.confirmedSettlementService.confirm(input);
}

@Get('confirmed-settlements')
listConfirmedSettlements(
  @Query('storeCode') storeCode?: string,
  @Query('periodStart') periodStart?: string,
  @Query('periodEnd') periodEnd?: string,
  @Query('includeHistory') includeHistory?: string,
) {
  return this.confirmedSettlementService.list({
    storeCode: storeCode?.trim() || undefined,
    periodStart: periodStart?.trim() || undefined,
    periodEnd: periodEnd?.trim() || undefined,
    includeHistory: includeHistory === 'true',
  });
}

@Get('confirmed-settlements/:id')
getConfirmedSettlement(@Param('id') id: string) {
  return this.confirmedSettlementService.getById(id);
}
```

- [ ] **Step 4: Run controller tests, full unit tests, and server build**

Expected: controller tests PASS, all Jest suites PASS, and `npx nest build` exits 0.

- [ ] **Step 5: Commit REST endpoints**

```powershell
git add server/modules/reconciliation/reconciliation.module.ts server/modules/reconciliation/reconciliation.controller.ts test/unit/confirmed-settlement-api.spec.ts
git commit -m "feat: expose confirmed settlement API"
```

## Task 6: Client API And Recognition Page Confirmation

**Files:**

- Modify: `client/src/api/index.ts`
- Modify: `client/src/types/reconciliation.ts`
- Modify: `client/src/pages/BillRecognitionPage.tsx`

- [ ] **Step 1: Add typed client methods and let typecheck fail at missing imports**

Add to `reconciliationApi`:

```ts
confirmSettlement: (input: ConfirmSettlementBillInput) =>
  request<ConfirmedSettlementDetail>({
    url: '/api/reconciliation/confirmed-settlements',
    method: 'POST',
    data: input,
  }),
confirmedSettlements: (params?: {
  storeCode?: string;
  periodStart?: string;
  periodEnd?: string;
  includeHistory?: boolean;
}) => request<ConfirmedSettlementBill[]>({
  url: '/api/reconciliation/confirmed-settlements',
  method: 'GET',
  params,
}),
confirmedSettlement: (id: string) =>
  request<ConfirmedSettlementDetail>({
    url: `/api/reconciliation/confirmed-settlements/${id}`,
    method: 'GET',
  }),
```

- [ ] **Step 2: Run client typecheck to verify RED**

Expected: FAIL until the shared types are imported and the page uses the new response shape.

- [ ] **Step 3: Replace local-only confirmation with an async server call**

In `BillRecognitionPage.tsx`:

- Add `confirming` and `confirmedDetail` state.
- Keep “保存复核结果” as a local draft action, but rename its toast to explicitly say “本机草稿”.
- Replace the current inline `setConfirmed(true); saveReview()` handler with:

```ts
const confirmSettlement = async () => {
  if (!result || !fileName || confirming) return;
  setConfirming(true);
  try {
    const detail = await reconciliationApi.confirmSettlement({
      fileName,
      extraction: result,
      reviewedFields: rows.map(({ id, label, target, value }) => ({
        id,
        label,
        target,
        value,
      })),
      ocrVerified: Boolean(ocrResult) && !ocrBlocksConfirmation,
    });
    setConfirmedDetail(detail);
    setConfirmed(true);
    toast.success(`结算单已确认，版本 V${detail.bill.version}`);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '确认结算单失败');
  } finally {
    setConfirming(false);
  }
};
```

- Disable the confirm button while `confirming`, `refining`, or OCR has a blocking conflict.
- Display `detail.bill.id`, version, confirmer, and confirmation time in the confirmed result section.
- Do not set `confirmed` when the server request fails.

- [ ] **Step 4: Run client/server typechecks and production client build**

Run:

```powershell
npm run type:check
$env:NODE_ENV='production'; npx vite build --config vite.config.ts
```

Expected: both typechecks exit 0 and Vite build succeeds.

- [ ] **Step 5: Commit client confirmation flow**

```powershell
git add client/src/api/index.ts client/src/types/reconciliation.ts client/src/pages/BillRecognitionPage.tsx
git commit -m "feat: confirm recognized bills through backend"
```

## Task 7: Migration And End-To-End Verification

**Files:**

- Verify: `migrations/007_confirmed_settlement_bills.sql`
- Verify: `client/src/pages/BillRecognitionPage.tsx`
- Verify: API routes under `server/modules/reconciliation/reconciliation.controller.ts`

- [ ] **Step 1: Apply migration 007 to the configured development PostgreSQL database**

Use the same migration execution path used for migrations 001-006 in the target environment. Verify with:

For Miaoda development databases, run the migration through the platform DDL
channel rather than the public `SUDA_DATABASE_URL` connection:

```powershell
lark-cli apps +db-execute --app-id <app-id> --environment dev --file ./migrations/007_confirmed_settlement_bills.sql --dry-run --as user
lark-cli apps +db-execute --app-id <app-id> --environment dev --file ./migrations/007_confirmed_settlement_bills.sql --yes --as user
```

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_name IN (
  'reconciliation_confirmed_bills',
  'reconciliation_confirmed_sales_lines',
  'reconciliation_confirmed_fee_lines'
)
ORDER BY table_name;
```

Expected: exactly three rows.

- [ ] **Step 2: Run the complete automated verification suite**

The repository has no dedicated PostgreSQL test database configuration. Task 4
therefore verifies transaction boundaries with a controlled database double.
In this step, add or run real PostgreSQL integration checks proving that
concurrent confirmations for the same full logical identity allocate sequential
versions, and that a forced detail-line insert failure rolls back both the bill
insert and any active-version supersede update.

```powershell
npm test -- --runInBand
npm run type:check
$env:NODE_ENV='production'; npx nest build
$env:NODE_ENV='production'; npx vite build --config vite.config.ts
git diff --check
```

Expected: all tests pass, both typechecks pass, both builds exit 0, and `git diff --check` reports no errors.

- [ ] **Step 3: Start one backend and one frontend process**

Run the Windows development launcher with ports `3001` and `5176`. Before launching, terminate duplicate watchers for this workspace only and verify exactly one listener per port.

- [ ] **Step 4: Confirm the SHAD64 sample through the browser**

Upload `D:\710\SHAD64结算单-202605.pdf`, wait for OCR and vision completion, review the values, and click “确认结算单”. Verify the UI displays a database ID and `V1`.

- [ ] **Step 5: Verify persistence outside the recognition page**

Call:

```text
GET /api/reconciliation/confirmed-settlements?storeCode=086203&periodStart=2026-05-01&periodEnd=2026-05-31
GET /api/reconciliation/confirmed-settlements/{returned-id}
```

Expected:

- One active confirmed bill.
- Core values: sales `69843.00`, invoice `60566.31`, deduction `5650.47`, settlement `54915.84`.
- Ten sales lines.
- Eight fee detail rows plus stored subtotal/total rows from the confirmed extraction.

- [ ] **Step 6: Verify version replacement**

Confirm the same store and period again. Verify the new row is `V2`, the earlier row is `superseded`, and the default list endpoint returns only V2.

- [ ] **Step 7: Commit final verification-only fixes, if any**

Stage only files changed to fix a reproduced verification failure, rerun the relevant failing check, then commit with a message naming that behavior. Do not commit screenshots, API keys, `.env.local`, or temporary response files.

## Follow-Up Plan Boundaries

After this plan passes end to end:

1. **Permissions and analytics plan:** organization, region, store, user data scopes, confirmed-only aggregate queries, fee analysis, anomaly rules, and audit records.
2. **MCP and Cherry Studio plan:** MCP transport/authentication, eight read-only tools, Cherry Studio enterprise configuration, embedded analysis UI, and cross-entry consistency tests.

Neither follow-up may query transient recognition state or browser `localStorage`; both must use the confirmed settlement service and tables delivered here.
