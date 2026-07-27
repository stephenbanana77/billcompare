# Vision LLM Settlement Bill Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a scanned settlement PDF to be sent to an OpenAI-compatible vision model and returned as a reviewable bill profile for the existing reconciliation import flow.

**Architecture:** Add a focused NestJS `VisionExtractionService` and multipart endpoint. It renders a PDF using Poppler `pdftoppm`, sends page images to the configured Chat Completions endpoint, validates the JSON response, and returns an in-memory `FileProfile` compatible object. The import dialog invokes this endpoint only when text-layer PDF parsing fails.

**Tech Stack:** NestJS, Multer file interceptor, Node `child_process`, Poppler `pdftoppm`, Axios, React, TanStack Query, Jest, TypeScript.

---

## File Structure

- Create: `server/modules/reconciliation/vision-extraction.service.ts` - provider request, PDF rendering orchestration, response validation.
- Create: `server/modules/reconciliation/vision-extraction.service.spec.ts` - focused unit tests for normalized results and warnings.
- Modify: `server/modules/reconciliation/reconciliation.controller.ts` - multipart extraction endpoint.
- Modify: `server/modules/reconciliation/reconciliation.module.ts` - register the service.
- Modify: `shared/reconciliation.ts` - API request and response contracts.
- Modify: `client/src/api/index.ts` - client API method.
- Modify: `client/src/lib/workbook.ts` - allow construction of a profile from vision result.
- Modify: `client/src/components/ImportDialog.tsx` - scanned PDF fallback action and recognition state.
- Modify: `.env.example` - non-secret provider configuration documentation.

### Task 1: Define the Shared Vision Extraction Contract

**Files:**
- Modify: `shared/reconciliation.ts`
- Test: `server/modules/reconciliation/vision-extraction.service.spec.ts`

- [ ] **Step 1: Write the failing type-level service test**

```ts
import { VisionExtractionService } from './vision-extraction.service';

describe('VisionExtractionService', () => {
  it('normalizes a visible settlement row into a bill profile', () => {
    const service = new VisionExtractionService();
    expect(service.normalizeModelResult({
      metadata: { mallName: 'SHAD', storeName: '南京店', storeCode: 'SHAD64', periodStart: '2026-05-01', periodEnd: '2026-05-31', billType: 'standard' },
      fields: { salesAmount: { value: '100000.00', rawText: '销售额 100,000.00', page: 1, confidence: 0.99 }, settlementAmount: { value: '85000.00', rawText: '本期应付 85,000.00', page: 1, confidence: 0.99 } },
    })).toMatchObject({ headers: expect.arrayContaining(['销售金额', '实结金额']) });
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- vision-extraction.service.spec.ts --runInBand`

Expected: FAIL because `VisionExtractionService` does not exist.

- [ ] **Step 3: Add explicit shared contracts**

```ts
export type VisionFieldKey = 'periodStart' | 'periodEnd' | 'salesAmount' | 'refundAmount' | 'commissionAmount' | 'activityFee' | 'settlementAmount';

export interface VisionFieldEvidence {
  value: string | number | null;
  rawText: string | null;
  page: number | null;
  confidence: number | null;
}

export interface VisionExtractionResult {
  sourceType: 'vision_llm';
  fileName: string;
  headers: string[];
  rows: Array<Record<string, string | number>>;
  metadata: { mallName: string; storeName: string; storeCode: string; periodStart: string; periodEnd: string; billType: 'standard' | 'complex' | 'changed_format' };
  evidence: Partial<Record<VisionFieldKey, VisionFieldEvidence>>;
  warnings: string[];
}
```

- [ ] **Step 4: Run the focused test and verify it still fails only for the missing service**

Run: `npm test -- vision-extraction.service.spec.ts --runInBand`

Expected: FAIL because the service is not implemented.

### Task 2: Normalize and Validate Model Output

**Files:**
- Create: `server/modules/reconciliation/vision-extraction.service.ts`
- Modify: `server/modules/reconciliation/vision-extraction.service.spec.ts`

- [ ] **Step 1: Add a failing formula-warning test**

```ts
it('warns when visible values do not reconcile', () => {
  const result = service.normalizeModelResult({
    metadata: { mallName: 'SHAD', storeName: '南京店', storeCode: 'SHAD64', periodStart: '2026-05-01', periodEnd: '2026-05-31', billType: 'standard' },
    fields: {
      salesAmount: { value: 100, rawText: '销售额 100', page: 1, confidence: 0.99 },
      commissionAmount: { value: 10, rawText: '扣点 10', page: 1, confidence: 0.99 },
      settlementAmount: { value: 70, rawText: '应付 70', page: 1, confidence: 0.99 },
    },
  });
  expect(result.warnings).toContain('结算金额与可见金额勾稽不一致，请核对原始单据。');
});
```

- [ ] **Step 2: Run the focused test and verify it fails for the missing warning**

Run: `npm test -- vision-extraction.service.spec.ts --runInBand`

Expected: FAIL with the expected warning missing.

- [ ] **Step 3: Implement pure normalization helpers**

Implement `normalizeModelResult` to:

```ts
const fieldLabels = { periodStart: '账期开始', periodEnd: '账期结束', salesAmount: '销售金额', refundAmount: '退款金额', commissionAmount: '扣点金额', activityFee: '活动费', settlementAmount: '实结金额' } as const;

const row = Object.fromEntries(Object.entries(fieldLabels).map(([key, label]) => [label, normalizedFieldValue(fields[key])]))
```

Reject values outside the allowed metadata schema, preserve `null` as an empty string, and append the formula warning when all required visible values are present and differ by more than one cent.

- [ ] **Step 4: Run the focused test suite and verify it passes**

Run: `npm test -- vision-extraction.service.spec.ts --runInBand`

Expected: PASS.

### Task 3: Add OpenAI-Compatible Provider and PDF Rendering

**Files:**
- Modify: `server/modules/reconciliation/vision-extraction.service.ts`
- Modify: `server/modules/reconciliation/vision-extraction.service.spec.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add a failing provider payload test**

```ts
it('sends rendered images and requests JSON-only output', async () => {
  const post = jest.fn().mockResolvedValue({ data: { choices: [{ message: { content: JSON.stringify(validModelResult) } }] } });
  const service = new VisionExtractionService({ post } as never, { baseUrl: 'https://example.test/v1', apiKey: 'test', model: 'gpt-5.4', pdftoppmPath: 'pdftoppm' });
  await service.extractFromImages('bill.pdf', [Buffer.from('image')]);
  expect(post).toHaveBeenCalledWith('/chat/completions', expect.objectContaining({ model: 'gpt-5.4', response_format: { type: 'json_object' } }), expect.anything());
});
```

- [ ] **Step 2: Run the test and verify it fails for the missing provider method**

Run: `npm test -- vision-extraction.service.spec.ts --runInBand`

Expected: FAIL because `extractFromImages` is undefined.

- [ ] **Step 3: Implement the provider boundary**

Create an Axios instance with `baseURL` from `VISION_LLM_BASE_URL`, `Authorization: Bearer <key>`, and a 90 second timeout. Implement `extractFromImages(fileName, images)` using this request body shape:

```ts
{
  model: config.model,
  response_format: { type: 'json_object' },
  messages: [{ role: 'user', content: [
    { type: 'text', text: extractionPrompt },
    ...images.map((image) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${image.toString('base64')}`, detail: 'high' } })),
  ] }],
}
```

Render PDFs by executing `pdftoppm -png -r 200 <input> <prefix>` in a unique temporary directory, read the first two rendered pages, then remove only that temporary directory in `finally`. For image uploads, use the file buffer directly.

Add `.env.example` entries:

```env
VISION_LLM_BASE_URL=https://hub.example.com/v1
VISION_LLM_API_KEY=
VISION_LLM_MODEL=gpt-5.4
VISION_PDFTOPPM_PATH=pdftoppm
```

- [ ] **Step 4: Run the focused test suite and verify it passes**

Run: `npm test -- vision-extraction.service.spec.ts --runInBand`

Expected: PASS.

### Task 4: Expose a Multipart Extraction Endpoint

**Files:**
- Modify: `server/modules/reconciliation/reconciliation.controller.ts`
- Modify: `server/modules/reconciliation/reconciliation.module.ts`
- Modify: `server/modules/reconciliation/vision-extraction.service.spec.ts`

- [ ] **Step 1: Add a failing controller test for missing uploads**

```ts
it('rejects a request without a bill file', async () => {
  await expect(controller.extractVisionBill(undefined as never)).rejects.toThrow('请上传待识别的结算单文件');
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test -- vision-extraction.service.spec.ts --runInBand`

Expected: FAIL because `extractVisionBill` is undefined.

- [ ] **Step 3: Register service and endpoint**

Add `VisionExtractionService` to module providers. Add a controller action using `@UseInterceptors(FileInterceptor('file'))` and `@UploadedFile()` that accepts PDF, PNG, JPEG, or WebP up to 15 MB, rejects an absent/unsupported file with `BadRequestException`, then calls `service.extract(file)`.

- [ ] **Step 4: Run focused server tests and server type check**

Run: `npm test -- vision-extraction.service.spec.ts --runInBand && npm run type:check:server`

Expected: all focused tests PASS and TypeScript exits 0.

### Task 5: Consume Vision Results in the Import Dialog

**Files:**
- Modify: `client/src/api/index.ts`
- Modify: `client/src/lib/workbook.ts`
- Modify: `client/src/components/ImportDialog.tsx`

- [ ] **Step 1: Add the API method and profile converter**

Add `reconciliationApi.extractVisionBill(file)` using `FormData` and `POST /api/reconciliation/vision-extractions`. Add `profileFromVisionExtraction(result)` in `workbook.ts` returning the existing `FileProfile` shape with `sourceType: 'vision_llm'`.

- [ ] **Step 2: Add a failing client type check expectation**

Run: `npm run type:check:client`

Expected: FAIL until `FileProfile.sourceType` and the import dialog's source handling include `vision_llm`.

- [ ] **Step 3: Add the scanned-PDF fallback interaction**

In `handleFile`, keep normal `readWorkbook` first. If a bill PDF raises the no-mappable-header error, show a `使用视觉识别` action. That action calls `extractVisionBill`, replaces `billProfile`, applies returned metadata and auto-mapping, and displays warnings in the dialog. Disable the action while pending and preserve the ERP profile.

- [ ] **Step 4: Run client type check**

Run: `npm run type:check:client`

Expected: exits 0.

### Task 6: Manual Acceptance With the SHAD64 Sample

**Files:**
- Modify: `.env.local` (local only; never commit)

- [ ] **Step 1: Configure local provider variables without checking in secrets**

```env
VISION_LLM_BASE_URL=https://hub.5188866.xyz/v1
VISION_LLM_API_KEY=<rotated secret>
VISION_LLM_MODEL=gpt-5.4
VISION_PDFTOPPM_PATH=pdftoppm
```

- [ ] **Step 2: Start the application and import the sample**

Run: `npm run dev:windows`

Upload `D:/710/SHAD64结算单-202605.pdf`, choose `使用视觉识别`, and verify that the dialog advances with metadata, one normalized bill row, evidence warnings if needed, and the existing field-mapping step.

- [ ] **Step 3: Run the full verification set**

Run: `npm test -- --runInBand && npm run type:check`

Expected: all tests PASS and both server/client type checks exit 0.

## Plan Self-Review

- Spec coverage: Tasks 1-4 cover the server contract, provider, PDF rendering, validation, failure handling, and configuration; Task 5 covers user review and existing-flow reuse; Task 6 covers the requested SHAD64 acceptance sample.
- Placeholder scan: no deferred behavior is required for the stated first-version scope; persistent storage, model consensus, and OCR remain explicitly out of scope.
- Type consistency: `VisionExtractionResult` is shared by the server endpoint, client API, and `profileFromVisionExtraction`; `sourceType: 'vision_llm'` is the only new profile source value.
