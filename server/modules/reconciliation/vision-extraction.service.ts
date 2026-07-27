import { BadRequestException, Injectable } from '@nestjs/common';
import axios, { type AxiosInstance } from 'axios';
import type {
  VisionExtractionResult,
  VisionAdditionalField,
  VisionLineItem,
  VisionRefinementCandidate,
  VisionRefinementResult,
  VisionFieldEvidence,
  VisionFieldKey,
} from '@shared/reconciliation';

type ModelField = VisionFieldEvidence;

type ModelResult = {
  metadata: VisionExtractionResult['metadata'];
  periodEvidence?: VisionExtractionResult['periodEvidence'];
  fields: Partial<Record<VisionFieldKey, ModelField>>;
  additionalFields?: VisionAdditionalField[];
  lineItems?: VisionLineItem[];
};

type CompactPrimaryResult = {
  m?: [string | null, string | null, string | null, string | null, string | null];
  p?: [string | null, number | null, string | null];
  f?: Partial<Record<VisionFieldKey, [number | string | null, string | null, number | null, number | null]>>;
  a?: Array<[
    string,
    string | number | null,
    string | null,
    number | null,
    number | null,
    string | null,
    string | null,
  ]>;
};

type VisionConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  primaryMaxTokens: number;
  salesDetailMaxTokens: number;
  feeDetailMaxTokens: number;
};

const envNumber = (name: string, fallback: number, minimum = 0) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
};

const transientErrorCodes = new Set([
  'ECONNABORTED',
  'ECONNRESET',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

const isTransientUpstreamError = (error: unknown) => {
  const candidate = error as {
    code?: string;
    response?: { status?: number };
  };
  const status = candidate.response?.status;
  return (
    transientErrorCodes.has(String(candidate.code ?? '')) ||
    status === 429 ||
    (typeof status === 'number' && status >= 500)
  );
};

const parseModelJson = <T>(content: string): T => {
  let normalized = content.trim().replace(/^\uFEFF/, '');
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(normalized);
  if (fenced) normalized = fenced[1].trim();
  return JSON.parse(normalized) as T;
};

const extractionPrompt = `你是财务结算单识别助手。只根据图片中清晰可见的信息返回 JSON，不得猜测、补全或计算不可见金额。
输出格式必须是：
{
  "metadata": { "mallName": "", "storeName": "", "storeCode": "", "periodStart": "YYYY-MM-DD", "periodEnd": "YYYY-MM-DD", "billType": "standard|complex|changed_format" },
  "fields": {
    "salesAmount": { "value": number|null, "rawText": string|null, "page": number|null, "confidence": number|null },
    "refundAmount": { "value": number|null, "rawText": string|null, "page": number|null, "confidence": number|null },
    "commissionAmount": { "value": number|null, "rawText": string|null, "page": number|null, "confidence": number|null },
    "activityFee": { "value": number|null, "rawText": string|null, "page": number|null, "confidence": number|null },
    "settlementAmount": { "value": number|null, "rawText": string|null, "page": number|null, "confidence": number|null }
  }
}`;

const fieldLabels: Record<VisionFieldKey, string> = {
  periodStart: '账期开始',
  periodEnd: '账期结束',
  salesAmount: '销售金额',
  refundAmount: '退款金额',
  commissionAmount: '扣点金额',
  activityFee: '活动费',
  invoiceAmount: '发票金额（含调整）',
  deductionTotal: '扣款费用合计',
  settlementAmount: '实结金额',
};

const verificationPrompt = `Independently verify the settlement-bill values visible in these images. Return JSON only: {"fields": { "salesAmount": {"value": number|null,"rawText":string|null,"page":number|null,"confidence":number|null}, "refundAmount": {...}, "commissionAmount": {...}, "activityFee": {...}, "invoiceAmount": {...}, "deductionTotal": {...}, "settlementAmount": {...} }}. Copy printed numbers exactly; do not calculate, infer, or reuse values from another run. Return null when a value is not explicitly visible.`;

const salesDetailPrompt = `Transcribe only the sales/purchase settlement detail table from this document. Return JSON only as { "lineItems": [...] }. Output one item for every visible horizontal body row between the table header and bottom border, including rows containing only dashes, adjustments, subtotal, and total. Never omit an empty-value row when its row label is printed. Each item is { "section":"商品销售与进货结算明细", "label":string, "rowType":"detail|adjustment|subtotal|total|empty", "sequence":number, "values":object, "rawText":string|null, "page":number|null, "confidence":number|null }. Copy every printed column name and cell value exactly. Do not extract the separate period summary or fee table.`;

const compactSalesDetailPrompt = `Transcribe only the sales/purchase settlement detail table as compact rows. Output JSON immediately with no explanation as {"rows":[]}. Return every visible body row in order, including adjustment, subtotal, total and printed empty rows. Each row is {"label":string,"rowType":"detail|adjustment|subtotal|total|empty","values":[类别,结算扣率,销售数量,销售金额,销售毛利含调整,税率,含税销售成本含调整]}. Copy printed text and numbers exactly. Use null for blank cells. Do not include the table header, summary, or fee tables. Start with { and end with }.`;

const salesDetailColumns = [
  '类别',
  '结算扣率',
  '销售数量',
  '销售金额',
  '销售毛利(含调整)',
  '税率',
  '含税销售成本(含调整)',
] as const;

const feeDetailPrompt = `Transcribe only the deduction/fee detail table from this document. Return JSON only as { "lineItems": [...] }. For each A/B/C group, split every printed fee-name and amount pair into one atomic item. Also preserve printed group subtotal rows and the grand total row. Each item is { "section":"扣款费用明细", "label":string, "rowType":"detail|subtotal|total|empty", "sequence":number, "values":{"费用代码":string|null,"金额":number|string|null,"分组":string|null}, "rawText":string|null, "page":number|null, "confidence":number|null }. Never combine multiple fees into one item. Do not extract the sales table or period summary.`;

const compactFeeDetailPrompt = `Transcribe only the deduction/fee detail table as compact fee rows. Output JSON immediately as {"rows":[]}. Return every printed fee-name and amount pair as one atomic row, followed by each printed A/B/C subtotal and the grand total. Each row is [label,rowType,feeCode,amount,group], where rowType is detail, subtotal, total, or empty. Never combine fees. Use null for blank cells. Do not extract the sales table or period summary. Start with { and end with }.`;

const evidenceFirstAddendum = `This is a finance document extraction task. Follow this procedure before producing JSON:
1. Find the printed field label and its printed value in the image. Read the label and digits together.
2. For totals, use the directly printed value in the document's summary/total area. Do not add detail rows and do not infer a value from nearby figures.
3. rawText is mandatory whenever value is not null and must contain BOTH the printed label and the exact printed number, for example "Sales amount: 12345.67". Never return a bare number as rawText.
4. Keep all printed decimal digits. Never round, correct, or complete a partially visible number. If even one digit is unclear, return value null and confidence below 0.5.
5. Only return a confidence of 0.90 or higher when the label and every digit are clearly visible in one source region. Otherwise return at most 0.75.
6. Return the following fields when directly visible: salesAmount, refundAmount, commissionAmount, activityFee, invoiceAmount, deductionTotal, settlementAmount. A field not printed in the document must be null. Do not substitute a semantically similar value.
7. Return additionalFields for every important labeled header, summary, and fee field that does not fit the standard fields. Each item is { label, value, rawText, page, confidence, group, suggestedTarget }. group is header, summary, fee, or other. suggestedTarget may be one of brandMerchantName, brandName, storeName, storeCode, settlementNo, salesQuantity, taxAmount, netPurchaseAmount, businessMode, counterLocation, productCategory, settlementDate, documentDate, printSequence, previousBalance, or null. A field literally labeled 商场 that describes a floor/counter scenario is counterLocation; 联销 or another settlement method is businessMode.
8. Return top-level periodEvidence as { rawText, page, kind }. rawText must be the exact visible period text. kind is explicit_range only when both start and end dates are printed, month_only when only YYYY-MM is printed, inferred when the dates were derived, or unknown. Never claim that a derived first day was printed in the PDF. Do not extract detail-table rows in this response.`;
const metadataSemanticsAddendum = `Metadata semantics: mallName is the mall/project name. storeName is an actual shop name or the brand shown on a "brand" label. Never put a merchant legal entity, supplier, or brand operator into storeName. Put those legal-entity fields in additionalFields with suggestedTarget "brandMerchantName". Put a printed bill/settlement number in additionalFields with suggestedTarget "settlementNo".`;

const compactExtractionPrompt = `Extract compact primary bill data from this Chinese mall settlement bill. Output JSON immediately with no explanation as {"m":[],"p":[],"f":{},"a":[]}.
m=[mallName,storeName,storeCode,period,billType]. period is the exact printed YYYY-MM or date range. billType is standard, complex, or changed_format.
p=[exactPeriodText,page,kind], where kind is explicit_range, month_only, inferred, or unknown.
f may contain only salesAmount, refundAmount, commissionAmount, activityFee, invoiceAmount, deductionTotal, settlementAmount. Each value is [number,exactLabelAndNumber,page,confidence]. Copy printed numbers exactly; never calculate. Use null when unclear. Use only a printed summary value for activityFee.
a contains only directly visible extra fields, each as [label,value,exactText,page,confidence,group,suggestedTarget]. suggestedTarget may be brandMerchantName, brandName, settlementNo, salesQuantity, businessMode, counterLocation, settlementDate, documentDate, or printSequence. mallName is the project or mall. storeName is the printed brand, never a legal company. Start with { and end with }.`;

const expandPrimaryResult = (input: ModelResult | CompactPrimaryResult): ModelResult => {
  const compact = input as CompactPrimaryResult;
  if (!Array.isArray(compact.m) && (!compact.f || typeof compact.f !== 'object')) {
    return input as ModelResult;
  }
  const metadata = compact.m ?? [];
  const period = metadata[3] ?? '';
  const fields = Object.fromEntries(
    Object.entries(compact.f ?? {}).map(([key, value]) => [
      key,
      {
        value: value?.[0] ?? null,
        rawText: value?.[1] ?? null,
        page: value?.[2] ?? null,
        confidence: typeof value?.[3] === 'number' ? value[3] : null,
      },
    ]),
  ) as ModelResult['fields'];
  const activityRawText = String(fields.activityFee?.rawText ?? '');
  if (/扣款|实付|发票/.test(activityRawText)) {
    fields.activityFee = {
      ...fields.activityFee,
      value: null,
      confidence: null,
    };
  }
  return {
    metadata: {
      mallName: metadata[0] ?? '',
      storeName: metadata[1] ?? '',
      storeCode: metadata[2] ?? '',
      periodStart: period,
      periodEnd: period,
      billType: ['standard', 'complex', 'changed_format'].includes(metadata[4] ?? '')
        ? metadata[4] as VisionExtractionResult['metadata']['billType']
        : 'standard',
    },
    periodEvidence: compact.p ? {
      rawText: compact.p[0],
      page: compact.p[1],
      kind: ['explicit_range', 'month_only', 'inferred', 'unknown'].includes(compact.p[2] ?? '')
        ? compact.p[2] as NonNullable<VisionExtractionResult['periodEvidence']>['kind']
        : 'unknown',
    } : undefined,
    fields,
    additionalFields: (compact.a ?? []).map((item) => ({
      label: item[0],
      value: item[1],
      rawText: item[2],
      page: item[3],
      confidence: typeof item[4] === 'number' ? item[4] : null,
      group: item[5] as VisionAdditionalField['group'],
      suggestedTarget: item[6],
    })),
  };
};

const money = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;
  const negative = /^\(.*\)$/.test(text) || text.startsWith('-');
  const parsed = Number(text.replace(/[,$￥¥()\s]/g, '').replace(/^-/, ''));
  if (!Number.isFinite(parsed)) return null;
  return Math.round((negative ? -parsed : parsed) * 100) / 100;
};

const fieldText = (field: ModelField | undefined) => {
  if (!field || field.value === null || field.value === undefined) return '';
  const numeric = money(field.value);
  return numeric === null ? String(field.value).trim() : numeric.toFixed(2);
};

@Injectable()
export class VisionExtractionService {
  private readonly config: VisionConfig = {
      baseUrl: String(process.env.VISION_LLM_BASE_URL ?? '').replace(/\/$/, ''),
      apiKey: String(process.env.VISION_LLM_API_KEY ?? ''),
      model: String(process.env.VISION_LLM_MODEL ?? 'minimax/minimax-m3'),
      timeoutMs: envNumber('VISION_LLM_TIMEOUT_MS', 120_000, 1),
      maxRetries: envNumber('VISION_LLM_MAX_RETRIES', 1),
      retryDelayMs: envNumber('VISION_LLM_RETRY_DELAY_MS', 1500),
      primaryMaxTokens: envNumber('VISION_LLM_PRIMARY_MAX_TOKENS', 4000, 1),
      salesDetailMaxTokens: envNumber('VISION_LLM_SALES_MAX_TOKENS', 3500, 1),
      feeDetailMaxTokens: envNumber('VISION_LLM_FEE_MAX_TOKENS', 3000, 1),
    };
  private readonly client: Pick<AxiosInstance, 'post'> = axios.create({
    baseURL: this.config.baseUrl,
    timeout: this.config.timeoutMs,
  });

  private async postWithRetry(path: string, payload: unknown) {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        return await this.client.post(path, payload, {
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
        });
      } catch (error) {
        lastError = error;
        if (attempt >= this.config.maxRetries || !isTransientUpstreamError(error)) {
          throw error;
        }
        const delayMs = this.config.retryDelayMs * (2 ** attempt);
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    throw lastError;
  }

  private async requestPrimaryResult(payload: unknown): Promise<ModelResult> {
    let lastContent = '';
    let lastFinishReason: unknown;
    let lastUsage: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.postWithRetry('/chat/completions', payload);
      const content = response.data?.choices?.[0]?.message?.content;
      lastFinishReason = response.data?.choices?.[0]?.finish_reason;
      lastUsage = response.data?.usage;
      lastContent = typeof content === 'string' ? content : '';
      try {
        const parsed = parseModelJson<ModelResult | CompactPrimaryResult>(lastContent);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return expandPrimaryResult(parsed);
        }
      } catch {
        // Retry once when the provider returns empty, fenced-truncated, or non-JSON output.
      }
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    console.warn('[vision-extraction] invalid primary JSON', {
      length: lastContent.length,
      finishReason: lastFinishReason,
      usage: lastUsage,
    });
    throw new BadRequestException('视觉模型返回格式错误，请重试或使用 Excel 导入。');
  }

  async extractFromImages(
    fileName: string,
    images: Buffer[],
  ): Promise<VisionExtractionResult> {
    if (!this.config.baseUrl || !this.config.apiKey) {
      throw new BadRequestException(
        '未配置视觉模型服务，请设置 VISION_LLM_BASE_URL 和 VISION_LLM_API_KEY。',
      );
    }
    if (!images.length) {
      throw new BadRequestException('未获取到可供视觉模型识别的页面图片。');
    }
    const primaryPayload = {
      model: this.config.model,
      temperature: 0,
      reasoning_effort: 'low',
      max_completion_tokens: this.config.primaryMaxTokens,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: compactExtractionPrompt },
            ...images.map((image) => ({
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${image.toString('base64')}`,
                detail: 'high',
              },
            })),
          ],
        },
      ],
    };
    const primary = await this.requestPrimaryResult(primaryPayload);

    const extractedLineItems = await this.extractLineItems(images);
    try {
      const lineItems = extractedLineItems.length
        ? extractedLineItems
        : (Array.isArray(primary.lineItems) ? primary.lineItems : []);
      return this.normalizeModelResult(
        {
          ...primary,
          lineItems: lineItems.length ? lineItems : primary.lineItems,
        },
        fileName,
      );
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      console.warn('[vision-extraction] result normalization failed', error);
      throw new BadRequestException('视觉模型返回格式错误，请重试或使用 Excel 导入。');
    }
  }

  async refineLowConfidenceFields(
    images: Buffer[],
    candidates: VisionRefinementCandidate[],
  ): Promise<VisionRefinementResult> {
    if (!images.length || !candidates.length) return { items: [] };
    const candidateJson = JSON.stringify(candidates.slice(0, 16));
    const response = await this.postWithRetry(
      '/chat/completions',
      {
        model: this.config.model,
        temperature: 0,
        reasoning_effort: 'low',
        max_completion_tokens: 3000,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Re-read only the low-confidence finance-document candidates below using the enlarged image tiles. Return JSON only as {"items":[{"id":string,"value":string|number|object|null,"rawText":string|null,"confidence":number|null,"status":"confirmed|conflict|unresolved"}]}. Use confirmed only when every visible character agrees with the supplied value. Use conflict when the image clearly shows a different value; return the image value but do not silently choose it. Use unresolved when any character remains unclear. Preserve object keys for table rows. Candidates: ${candidateJson}`,
            },
            ...images.map((image) => ({
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${image.toString('base64')}`,
                detail: 'high',
              },
            })),
          ],
        }],
      },
    );
    const content = response.data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return { items: [] };
    const parsed = parseModelJson<VisionRefinementResult>(content);
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    return {
      items: (parsed.items ?? []).filter((item) =>
        candidateIds.has(item.id) && ['confirmed', 'conflict', 'unresolved'].includes(item.status),
      ),
    };
  }

  private async verifyFields(images: Buffer[]): Promise<Partial<Record<VisionFieldKey, ModelField>>> {
    const response = await this.postWithRetry(
      '/chat/completions',
      {
        model: this.config.model,
        temperature: 0,
        reasoning_effort: 'low',
        max_completion_tokens: 5000,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: verificationPrompt },
            ...images.map((image) => ({
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${image.toString('base64')}`,
                detail: 'high',
              },
            })),
          ],
        }],
      },
    );
    const content = response.data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return {};
    const parsed = parseModelJson<{
      fields?: Partial<Record<VisionFieldKey, ModelField>>;
    }>(content);
    return parsed.fields ?? {};
  }

  private async extractLineItems(images: Buffer[]): Promise<VisionLineItem[]> {
    const salesItems = await this.extractCompactSalesLineItems(
      images,
    ).catch(() => []);
    const feeItems = await this.extractCompactFeeLineItems(images).catch((error) => {
      console.warn('[vision-extraction] fee detail extraction failed', error);
      return [];
    });
    return [...salesItems, ...feeItems];
  }

  private async extractCompactFeeLineItems(images: Buffer[]): Promise<VisionLineItem[]> {
    const response = await this.postWithRetry('/chat/completions', {
      model: this.config.model,
      temperature: 0,
      reasoning_effort: 'low',
      max_completion_tokens: this.config.feeDetailMaxTokens,
      response_format: { type: 'json_object' },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: compactFeeDetailPrompt },
          ...images.map((image) => ({
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${image.toString('base64')}`,
              detail: 'high',
            },
          })),
        ],
      }],
    });
    const content = response.data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      console.warn('[vision-extraction] empty fee detail response', {
        finishReason: response.data?.choices?.[0]?.finish_reason,
        usage: response.data?.usage,
      });
      return [];
    }
    const parsed = parseModelJson<{
      lineItems?: VisionLineItem[];
      rows?: Array<[
        string,
        VisionLineItem['rowType'],
        string | null,
        string | number | null,
        string | null,
      ]>;
    }>(content);
    if (parsed.lineItems?.length) return parsed.lineItems;
    return (parsed.rows ?? []).map((row, index) => ({
      section: '扣款费用明细',
      label: row[0],
      rowType: row[1] ?? 'detail',
      sequence: index + 1,
      values: {
        费用代码: row[2] ?? '',
        金额: row[3] ?? '',
        分组: row[4] ?? '',
      },
      rawText: null,
      page: 1,
      confidence: null,
    }));
  }

  private async extractCompactSalesLineItems(
    images: Buffer[],
  ): Promise<VisionLineItem[]> {
    const response = await this.postWithRetry(
      '/chat/completions',
      {
        model: this.config.model,
        temperature: 0,
        reasoning_effort: 'low',
        max_completion_tokens: this.config.salesDetailMaxTokens,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: compactSalesDetailPrompt },
            ...images.map((image) => ({
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${image.toString('base64')}`,
                detail: 'high',
              },
            })),
          ],
        }],
      },
    );
    const content = response.data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return [];
    const parsed = parseModelJson<{
      lineItems?: VisionLineItem[];
      rows?: Array<{
        label?: string;
        rowType?: VisionLineItem['rowType'];
        values?: Array<string | number | null>;
      }>;
    }>(content);
    if (parsed.lineItems?.length) return parsed.lineItems;
    return (parsed.rows ?? []).map((row, index) => {
      const values: Record<string, string | number> = Object.fromEntries(
        salesDetailColumns.map((column, columnIndex) => [
          column,
          row.values?.[columnIndex] ?? '',
        ]),
      );
      return {
        section: '商品销售与进货结算明细',
        label: row.label?.trim() || `第 ${index + 1} 行`,
        rowType: row.rowType ?? 'detail',
        sequence: index + 1,
        values,
        rawText: null,
        page: 1,
        confidence: null,
      };
    });
  }

  private async extractLineItemsWithPrompt(
    images: Buffer[],
    prompt: string,
    maxCompletionTokens: number,
  ): Promise<VisionLineItem[]> {
    const response = await this.postWithRetry(
      '/chat/completions',
      {
        model: this.config.model,
        temperature: 0,
        reasoning_effort: 'low',
        max_completion_tokens: maxCompletionTokens,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            ...images.map((image) => ({
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${image.toString('base64')}`,
                detail: 'high',
              },
            })),
          ],
        }],
      },
    );
    const content = response.data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return [];
    const parsed = parseModelJson<{ lineItems?: VisionLineItem[] }>(content);
    return parsed.lineItems ?? [];
  }

  private applyIndependentVerification(
    primary: ModelResult,
    verified: Partial<Record<VisionFieldKey, ModelField>>,
  ): ModelResult {
    const fields = { ...(primary.fields ?? {}) };
    for (const key of Object.keys(fields) as VisionFieldKey[]) {
      const first = fields[key];
      const second = verified[key];
      if (!first) continue;
      const firstValue = money(first.value);
      const secondValue = money(second?.value);
      if (firstValue === null || secondValue === null || firstValue !== secondValue) {
        fields[key] = { ...first, confidence: Math.min(first.confidence ?? 1, 0.55) };
      } else {
        fields[key] = { ...first, confidence: Math.min(first.confidence ?? 1, second?.confidence ?? 0.8) };
      }
    }
    return { ...primary, fields };
  }

  normalizeModelResult(
    input: ModelResult,
    fileName = 'vision-extracted-bill.pdf',
  ): VisionExtractionResult {
    const fields = input.fields ?? {};
    const headers = Object.values(fieldLabels);
    const row = Object.fromEntries(
      Object.entries(fieldLabels).map(([key, label]) => [
        label,
        fieldText(fields[key as VisionFieldKey]),
      ]),
    );
    const warnings: string[] = [];
    const sales = money(fields.salesAmount?.value);
    const refund = money(fields.refundAmount?.value) ?? 0;
    const commission = money(fields.commissionAmount?.value) ?? 0;
    const activity = money(fields.activityFee?.value) ?? 0;
    const invoiceAmount = money(fields.invoiceAmount?.value);
    const deductionTotal = money(fields.deductionTotal?.value);
    const settlement = money(fields.settlementAmount?.value);
    if (invoiceAmount !== null && deductionTotal !== null && settlement !== null) {
      if (Math.abs(invoiceAmount - deductionTotal - settlement) > 0.01) {
        warnings.push('发票金额、扣款费用合计与实付金额未通过交叉校验，请核对原始单据。');
      }
    } else if (
      sales !== null &&
      settlement !== null &&
      (fields.commissionAmount?.value !== null || fields.activityFee?.value !== null) &&
      Math.abs(sales - refund - commission - activity - settlement) > 0.01
    ) {
      warnings.push('结算金额与可见金额勾稽不一致，请核对原始单据。');
    }
    for (const [key, field] of Object.entries(fields) as Array<
      [VisionFieldKey, ModelField]
    >) {
      if (field?.confidence !== null && field?.confidence !== undefined && field.confidence < 0.9) {
        warnings.push(`${fieldLabels[key]}识别置信度较低，请核对原始单据。`);
      }
    }

    return {
      sourceType: 'vision_llm',
      fileName,
      headers,
      rows: [row],
      metadata: normalizeMonthlyPeriod(input.metadata),
      periodEvidence: normalizePeriodEvidence(input),
      evidence: fields,
      additionalFields: normalizeAdditionalFields(input.additionalFields),
      lineItems: normalizeLineItems(input.lineItems),
      warnings,
    };
  }
}

function normalizeAdditionalFields(input: VisionAdditionalField[] | undefined) {
  return (Array.isArray(input) ? input : [])
    .filter((field) => field && typeof field.label === 'string' && field.label.trim())
    .map((field) => ({
      ...field,
      label: field.label.trim(),
      value: field.value ?? null,
      rawText: field.rawText?.trim() || null,
      page: Number.isFinite(field.page) ? field.page : null,
      confidence: typeof field.confidence === 'number' ? field.confidence : null,
      group: ['header', 'summary', 'fee', 'other'].includes(field.group) ? field.group : 'other',
      suggestedTarget: field.suggestedTarget?.trim() || null,
    }));
}

function normalizeLineItems(input: VisionLineItem[] | undefined) {
  return (Array.isArray(input) ? input : [])
    .filter((item) => item && typeof item.label === 'string' && item.label.trim())
    .map((item) => ({
      ...item,
      section: item.section?.trim() || '明细',
      label: item.label.trim(),
      rowType: ['detail', 'adjustment', 'subtotal', 'total', 'empty'].includes(item.rowType ?? '')
        ? item.rowType
        : 'detail',
      sequence: Number.isFinite(item.sequence) ? item.sequence : null,
      values: item.values && typeof item.values === 'object' ? item.values : {},
      rawText: item.rawText?.trim() || null,
      page: Number.isFinite(item.page) ? item.page : null,
      confidence: typeof item.confidence === 'number' ? item.confidence : null,
    }));
}

function normalizeMonthlyPeriod(metadata: VisionExtractionResult['metadata'] | undefined) {
  const normalized = {
    mallName: '',
    storeName: '',
    storeCode: '',
    periodStart: '',
    periodEnd: '',
    billType: 'standard' as const,
    ...(metadata ?? {}),
  };
  const periodStart = normalized.periodStart?.trim() ?? '';
  const periodEnd = normalized.periodEnd?.trim() ?? '';
  const month = /^([12]\d{3})-(0[1-9]|1[0-2])$/.exec(periodStart || periodEnd);
  if (!month) return normalized;
  const [, year, monthNumber] = month;
  const lastDay = new Date(Number(year), Number(monthNumber), 0).getDate();
  return {
    ...normalized,
    periodStart: `${year}-${monthNumber}-01`,
    periodEnd: `${year}-${monthNumber}-${String(lastDay).padStart(2, '0')}`,
  };
}

function normalizePeriodEvidence(input: ModelResult): VisionExtractionResult['periodEvidence'] {
  const evidence = input.periodEvidence;
  if (evidence && ['explicit_range', 'month_only', 'inferred', 'unknown'].includes(evidence.kind)) {
    return {
      rawText: evidence.rawText === null || evidence.rawText === undefined
        ? null
        : String(evidence.rawText).trim() || null,
      page: Number.isFinite(evidence.page) ? evidence.page : null,
      kind: evidence.kind,
    };
  }
  return { rawText: null, page: null, kind: 'unknown' };
}
