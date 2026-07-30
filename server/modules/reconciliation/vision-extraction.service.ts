import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
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
import { enrichDynamicSettlement } from './dynamic-settlement';

type ModelField = VisionFieldEvidence;

type ModelResult = {
  metadata: VisionExtractionResult['metadata'];
  periodEvidence?: VisionExtractionResult['periodEvidence'];
  fields: Partial<Record<VisionFieldKey, ModelField>>;
  additionalFields?: VisionAdditionalField[];
  lineItems?: VisionLineItem[];
};

type CompactPrimaryResult = {
  m?: [
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
  ];
  p?: [string | null, number | null, string | null];
  f?: Partial<
    Record<
      VisionFieldKey,
      [number | string | null, string | null, number | null, number | null]
    >
  >;
  a?: Array<
    [
      string,
      string | number | null,
      string | null,
      number | null,
      number | null,
      string | null,
      string | null,
    ]
  >;
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

type ChatCompletionPayload = {
  [key: string]: unknown;
  max_completion_tokens?: number;
  messages?: Array<{
    [key: string]: unknown;
    content?: unknown;
  }>;
};

type ModelResponseDiagnostics = {
  content: string;
  finishReason: unknown;
  usage: unknown;
};

type LineItemExtractionResult = {
  items: VisionLineItem[];
  warnings: string[];
};

class ModelResponseFormatError extends Error {}

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

const toVisionUpstreamException = (error: unknown) => {
  const candidate = error as {
    code?: string;
    message?: string;
    response?: {
      status?: number;
      data?: { error?: { message?: string } };
    };
  };
  const status = candidate.response?.status;
  const upstreamMessage =
    candidate.response?.data?.error?.message || candidate.message || '';
  if (status === 401 || status === 403) {
    return new ServiceUnavailableException(
      `Vision model authentication failed: ${upstreamMessage || 'invalid API key'}`,
    );
  }
  if (status === 429) {
    return new ServiceUnavailableException(
      `Vision model rate limited: ${upstreamMessage || 'too many requests'}`,
    );
  }
  if (typeof status === 'number' && status >= 500) {
    return new ServiceUnavailableException(
      `Vision model upstream error: ${upstreamMessage || `HTTP ${status}`}`,
    );
  }
  return error;
};

const findCompleteJsonValue = (content: string): string | null => {
  const objectStart = content.indexOf('{');
  const arrayStart = content.indexOf('[');
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{' || character === '[') {
      stack.push(character);
      continue;
    }
    if (character === '}' || character === ']') {
      const expected = character === '}' ? '{' : '[';
      if (stack.pop() !== expected) return null;
      if (stack.length === 0) return content.slice(start, index + 1);
    }
  }
  return null;
};

const repairTrailingJsonDelimiters = (content: string): string | null => {
  const objectStart = content.indexOf('{');
  const arrayStart = content.indexOf('[');
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const candidate = content.slice(start).trim();
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const character of candidate) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{' || character === '[') stack.push(character);
    else if (character === '}' || character === ']') {
      const expected = character === '}' ? '{' : '[';
      if (stack.pop() !== expected) return null;
    }
  }
  // Never invent a truncated string/value or discard a trailing property. Only
  // restore missing structural closers after a complete JSON token.
  if (inString || !stack.length || /[:,{\[]\s*$/.test(candidate)) return null;
  const repaired =
    candidate +
    stack
      .reverse()
      .map((open) => (open === '{' ? '}' : ']'))
      .join('');
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return null;
  }
};

const parseModelJson = <T>(content: string, allowTrailingRepair = false): T => {
  const normalized = content.trim().replace(/^\uFEFF/, '');
  const candidates: string[] = [normalized];
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(normalized);
  if (fenced) candidates.unshift(fenced[1].trim());
  const complete = findCompleteJsonValue(normalized);
  if (complete) candidates.push(complete);
  if (allowTrailingRepair) {
    const repaired = repairTrailingJsonDelimiters(fenced?.[1] ?? normalized);
    if (repaired) candidates.push(repaired);
  }
  let lastError: unknown;
  for (const candidate of [...new Set(candidates)].filter(Boolean)) {
    try {
      return JSON.parse(candidate) as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new SyntaxError('Vision model returned empty JSON');
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

const compactSalesDetailPrompt = `Transcribe only the sales/purchase settlement detail table as compact rows. Output JSON immediately with no explanation as {"rows":[]}. Return every visible body row in order, including adjustment, subtotal, total and printed empty rows. Each row is {"section":string,"label":string,"rowType":"detail|adjustment|subtotal|total|empty","sequence":number,"values":object,"rawText":string|null,"page":number|null,"confidence":number|null}. The values object MUST use every printed column header from this document as its keys; never force a fixed mall-specific column list, rename a header, or omit an unfamiliar column. Copy printed text and numbers exactly. Use null for blank cells. Do not include the table header, summary, or fee tables. Start with { and end with }.`;

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

const compactFeeDetailPrompt = `Transcribe every deduction/fee detail table and every other non-sales monetary detail table (adjustment, tax, attached detail) as compact fee rows. Output JSON immediately as {"rows":[]}. Return every visible row in order, including printed detail, subtotal, total, adjustment and empty rows. Each row is {"section":string,"label":string,"rowType":"detail|adjustment|subtotal|total|empty","sequence":number,"values":object,"rawText":string|null,"page":number|null,"confidence":number|null}. The values object MUST use every printed column header from this document as its keys; do not assume A/B/C groups, a fee code, or a single amount column. Never combine multiple printed rows. Use null for blank cells. Do not extract the sales table or period summary. Start with { and end with }.`;

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
m=[mallName,storeName,storeCode,period,billType]. period is only the bill's settlement/accounting period (结算期/账期), as the exact printed YYYY-MM or date range; a contract/agreement validity range is never period. billType is standard, complex, or changed_format.
p=[exactPeriodText,page,kind], where kind is explicit_range, month_only, inferred, or unknown.
f may contain only salesAmount, refundAmount, commissionAmount, activityFee, invoiceAmount, deductionTotal, settlementAmount. Each value is [number,exactLabelAndNumber,page,confidence]. Copy printed numbers exactly; never calculate. Use null when unclear. Use only a printed summary value for activityFee.
a contains EVERY other directly visible labeled header, summary, subtotal, tax rate, and printed formula operand, each as [label,value,exactText,page,confidence,group,suggestedTarget]. Do not omit an unfamiliar mall-specific field. In particular preserve 本月回款小计, A/B/C/D subtotals, 调整项, 本期费用, tax rates, prior balances, and printed formula text/value pairs when visible. suggestedTarget may be any short English semantic role or null; do not force an unrelated role. A contract validity period is never settlementDate. A commission/discount rate (扣点/扣率) is never businessMode. mallName is the project or mall. storeName is the printed brand, never a legal company. Start with { and end with }.`;

const compactExtractionRetryPrompt = `Output JSON immediately. Return exactly one COMPLETE compact primary bill JSON object and nothing else: {"m":[mallName,storeName,storeCode,exactPeriod,billType],"p":[exactPeriodText,page,kind],"f":{},"a":[]}.
Keep it short. f keys: salesAmount,refundAmount,commissionAmount,activityFee,invoiceAmount,deductionTotal,settlementAmount; value=[number,exact label+number,page,confidence]. a row=[label,value,exactText,page,confidence,group,suggestedTarget] and must preserve every visible mall-specific summary/formula operand, especially 回款小计, A/B/C/D subtotals, 调整项, 本期费用 and tax rate. Copy only visible text/numbers; use null when unclear; do not calculate or output detail tables. m[3] is only the settlement/accounting period; contract/agreement validity is neither m[3] nor settlementDate. 扣点/扣率 is not businessMode. Start with { and finish every array/object with its closing delimiter.`;

const compactSalesDetailRetryPrompt = `Return one COMPLETE JSON object only: {"rows":[]}. Transcribe every visible body row of the sales/purchase settlement detail table in order. row={"section":string,"label":string,"rowType":"detail|adjustment|subtotal|total|empty","sequence":number,"values":object,"rawText":string|null,"page":number|null,"confidence":number|null}. values must preserve every printed column header and cell; never use a fixed schema. Use null for blank cells. No prose, summary fields, or fee rows. Close all arrays and objects.`;

const compactFeeDetailRetryPrompt = `Return one COMPLETE JSON object only: {"rows":[]}. Transcribe every visible deduction/fee detail row and other non-sales monetary row from adjustment, tax, or attached-detail tables. row={"section":string,"label":string,"rowType":"detail|adjustment|subtotal|total|empty","sequence":number,"values":object,"rawText":string|null,"page":number|null,"confidence":number|null}. values must preserve every printed column header and cell; never force A/B/C groups or fixed columns. Use null for blanks. No prose or sales rows. Close all arrays and objects.`;

const expandPrimaryResult = (
  input: ModelResult | CompactPrimaryResult,
): ModelResult => {
  const compact = input as CompactPrimaryResult;
  if (
    !Array.isArray(compact.m) &&
    (!compact.f || typeof compact.f !== 'object')
  ) {
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
      billType: ['standard', 'complex', 'changed_format'].includes(
        metadata[4] ?? '',
      )
        ? (metadata[4] as VisionExtractionResult['metadata']['billType'])
        : 'standard',
    },
    periodEvidence: compact.p
      ? {
          rawText: compact.p[0],
          page: compact.p[1],
          kind: [
            'explicit_range',
            'month_only',
            'inferred',
            'unknown',
          ].includes(compact.p[2] ?? '')
            ? (compact.p[2] as NonNullable<
                VisionExtractionResult['periodEvidence']
              >['kind'])
            : 'unknown',
        }
      : undefined,
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isPrimaryModelResult = (
  value: unknown,
): value is ModelResult | CompactPrimaryResult => {
  if (!isRecord(value)) return false;
  if (Array.isArray(value.m)) return isRecord(value.f);
  return isRecord(value.metadata) && isRecord(value.fields);
};

const isVisionLineItem = (value: unknown): value is VisionLineItem =>
  isRecord(value) && typeof value.label === 'string' && isRecord(value.values);

const hasArrayProperty = (
  value: Record<string, unknown>,
  property: string,
): boolean =>
  Object.prototype.hasOwnProperty.call(value, property) &&
  Array.isArray(value[property]);

const withFormatRetryPrompt = (
  payload: ChatCompletionPayload,
  prompt: string,
): ChatCompletionPayload => {
  const currentMaxTokens = Number(payload.max_completion_tokens);
  const retryMaxTokens = Number.isFinite(currentMaxTokens)
    ? Math.max(
        currentMaxTokens,
        Math.min(
          8_000,
          Math.max(currentMaxTokens + 1_000, Math.ceil(currentMaxTokens * 1.5)),
        ),
      )
    : undefined;
  const messages = (payload.messages ?? []).map((message, messageIndex) => {
    if (messageIndex !== 0 || !Array.isArray(message.content)) return message;
    const content = message.content as Array<Record<string, unknown>>;
    let textReplaced = false;
    const nextContent = content.map((item) => {
      if (!textReplaced && item?.type === 'text') {
        textReplaced = true;
        return { ...item, text: prompt };
      }
      return item;
    });
    if (!textReplaced) nextContent.unshift({ type: 'text', text: prompt });
    return { ...message, content: nextContent };
  });
  return {
    ...payload,
    ...(retryMaxTokens ? { max_completion_tokens: retryMaxTokens } : {}),
    messages,
  };
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
        if (
          attempt >= this.config.maxRetries ||
          !isTransientUpstreamError(error)
        ) {
          throw toVisionUpstreamException(error);
        }
        const delayMs = this.config.retryDelayMs * 2 ** attempt;
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    throw lastError;
  }

  private async requestStructuredResult<T>(
    payload: ChatCompletionPayload,
    retryPrompt: string,
    isValid: (value: unknown) => value is T,
    requestName: string,
    allowTrailingRepair = false,
  ): Promise<T> {
    let diagnostics: ModelResponseDiagnostics = {
      content: '',
      finishReason: undefined,
      usage: undefined,
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const attemptPayload =
        attempt === 0 ? payload : withFormatRetryPrompt(payload, retryPrompt);
      const response = await this.postWithRetry(
        '/chat/completions',
        attemptPayload,
      );
      const content = response.data?.choices?.[0]?.message?.content;
      diagnostics = {
        content: typeof content === 'string' ? content : '',
        finishReason: response.data?.choices?.[0]?.finish_reason,
        usage: response.data?.usage,
      };

      // A length stop is always retried/rejected even if a prefix happens to be
      // parseable: accepting it could silently treat incomplete finance data as final.
      if (diagnostics.finishReason !== 'length' && diagnostics.content) {
        try {
          const parsed = parseModelJson<T>(
            diagnostics.content,
            attempt > 0 && allowTrailingRepair,
          );
          if (isValid(parsed)) return parsed;
        } catch {
          // The second request uses a shorter strict schema and may repair only
          // missing trailing object/array delimiters, never incomplete values.
        }
      }
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    console.warn(`[vision-extraction] invalid ${requestName} JSON`, {
      length: diagnostics.content.length,
      finishReason: diagnostics.finishReason,
      usage: diagnostics.usage,
    });
    throw new ModelResponseFormatError(
      `Vision model returned invalid ${requestName} JSON`,
    );
  }

  private async requestPrimaryResult(
    payload: ChatCompletionPayload,
  ): Promise<ModelResult> {
    try {
      const parsed = await this.requestStructuredResult<
        ModelResult | CompactPrimaryResult
      >(
        payload,
        compactExtractionRetryPrompt,
        isPrimaryModelResult,
        'primary',
        true,
      );
      return expandPrimaryResult(parsed);
    } catch (error) {
      if (!(error instanceof ModelResponseFormatError)) throw error;
      throw new BadRequestException(
        '视觉模型返回格式错误，请重试或使用 Excel 导入。',
      );
    }
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
    // Primary fields and the two detail tables are independent reads of the
    // same pages. Start them together so one browser request is bounded by the
    // slowest model call instead of the sum of three calls (which previously
    // crossed the public gateway's ~300 second timeout).
    const [primaryAttempt, lineItemsAttempt] = await Promise.allSettled([
      this.requestPrimaryResult(primaryPayload),
      this.extractLineItems(images),
    ]);
    if (primaryAttempt.status === 'rejected') throw primaryAttempt.reason;
    const primary = primaryAttempt.value;
    const extractedLineItems =
      lineItemsAttempt.status === 'fulfilled'
        ? lineItemsAttempt.value
        : {
            items: [],
            warnings: [
              '明细识别未完成：请人工核对原始单据中的销售与费用明细。',
            ],
          };
    try {
      const lineItems = extractedLineItems.items.length
        ? extractedLineItems.items
        : Array.isArray(primary.lineItems)
          ? primary.lineItems
          : [];
      const normalized = this.normalizeModelResult(
        {
          ...primary,
          lineItems: lineItems.length ? lineItems : primary.lineItems,
        },
        fileName,
      );
      return enrichDynamicSettlement({
        ...normalized,
        warnings: [...normalized.warnings, ...extractedLineItems.warnings],
      });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      console.warn('[vision-extraction] result normalization failed', error);
      throw new BadRequestException(
        '视觉模型返回格式错误，请重试或使用 Excel 导入。',
      );
    }
  }

  async refineLowConfidenceFields(
    images: Buffer[],
    candidates: VisionRefinementCandidate[],
  ): Promise<VisionRefinementResult> {
    if (!images.length || !candidates.length) return { items: [] };
    const candidateJson = JSON.stringify(candidates.slice(0, 16));
    const response = await this.postWithRetry('/chat/completions', {
      model: this.config.model,
      temperature: 0,
      reasoning_effort: 'low',
      max_completion_tokens: 3000,
      response_format: { type: 'json_object' },
      messages: [
        {
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
        },
      ],
    });
    const content = response.data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return { items: [] };
    const parsed = parseModelJson<VisionRefinementResult>(content);
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    return {
      items: (parsed.items ?? []).filter(
        (item) =>
          candidateIds.has(item.id) &&
          ['confirmed', 'conflict', 'unresolved'].includes(item.status),
      ),
    };
  }

  private async verifyFields(
    images: Buffer[],
  ): Promise<Partial<Record<VisionFieldKey, ModelField>>> {
    const response = await this.postWithRetry('/chat/completions', {
      model: this.config.model,
      temperature: 0,
      reasoning_effort: 'low',
      max_completion_tokens: 5000,
      response_format: { type: 'json_object' },
      messages: [
        {
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
        },
      ],
    });
    const content = response.data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return {};
    const parsed = parseModelJson<{
      fields?: Partial<Record<VisionFieldKey, ModelField>>;
    }>(content);
    return parsed.fields ?? {};
  }

  private async extractLineItems(
    images: Buffer[],
  ): Promise<LineItemExtractionResult> {
    const warnings: string[] = [];
    // The two detail tables are independent model requests. Running them in
    // parallel keeps the complete extraction below the HTTP gateway timeout
    // without weakening the primary-result validation or dropping either table.
    const [salesAttempt, feeAttempt] = await Promise.allSettled([
      this.extractCompactSalesLineItems(images),
      this.extractCompactFeeLineItems(images),
    ]);
    const salesItems =
      salesAttempt.status === 'fulfilled' ? salesAttempt.value : [];
    const feeItems = feeAttempt.status === 'fulfilled' ? feeAttempt.value : [];
    if (salesAttempt.status === 'rejected') {
      console.warn(
        '[vision-extraction] sales detail extraction failed',
        salesAttempt.reason,
      );
      warnings.push(
        '销售明细识别失败：视觉模型未返回完整格式，请人工核对原单据。',
      );
    }
    if (feeAttempt.status === 'rejected') {
      console.warn(
        '[vision-extraction] fee detail extraction failed',
        feeAttempt.reason,
      );
      warnings.push(
        '费用明细识别失败：视觉模型未返回完整格式，请人工核对原单据。',
      );
    }
    return { items: [...salesItems, ...feeItems], warnings };
  }

  private async extractCompactFeeLineItems(
    images: Buffer[],
  ): Promise<VisionLineItem[]> {
    type LegacyFeeRow = [
      string,
      VisionLineItem['rowType'],
      string | null,
      string | number | null,
      string | null,
    ];
    type FeeDetailResponse = {
      lineItems?: VisionLineItem[];
      rows?: Array<VisionLineItem | LegacyFeeRow>;
    };
    const payload: ChatCompletionPayload = {
      model: this.config.model,
      temperature: 0,
      reasoning_effort: 'low',
      max_completion_tokens: this.config.feeDetailMaxTokens,
      response_format: { type: 'json_object' },
      messages: [
        {
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
        },
      ],
    };
    const parsed = await this.requestStructuredResult<FeeDetailResponse>(
      payload,
      compactFeeDetailRetryPrompt,
      (value): value is FeeDetailResponse => {
        if (!isRecord(value)) return false;
        if (hasArrayProperty(value, 'lineItems')) {
          return (value.lineItems as unknown[]).every(isVisionLineItem);
        }
        if (!hasArrayProperty(value, 'rows')) return false;
        return (value.rows as unknown[]).every(
          (row) =>
            isVisionLineItem(row) ||
            (Array.isArray(row) && typeof row[0] === 'string'),
        );
      },
      'fee detail',
    );
    if (parsed.lineItems) return normalizeLineItems(parsed.lineItems);
    return (parsed.rows ?? []).flatMap((row, index) => {
      if (isVisionLineItem(row)) {
        return normalizeLineItems([
          { ...row, sequence: row.sequence ?? index + 1 },
        ]);
      }
      return [
        {
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
        },
      ];
    });
  }

  private async extractCompactSalesLineItems(
    images: Buffer[],
  ): Promise<VisionLineItem[]> {
    type CompactSalesRow = {
      section?: string;
      label?: string;
      rowType?: VisionLineItem['rowType'];
      sequence?: number | null;
      values?:
        | Array<string | number | null>
        | Record<string, string | number | null>;
      rawText?: string | null;
      page?: number | null;
      confidence?: number | null;
    };
    type SalesDetailResponse = {
      lineItems?: VisionLineItem[];
      rows?: CompactSalesRow[];
    };
    const payload: ChatCompletionPayload = {
      model: this.config.model,
      temperature: 0,
      reasoning_effort: 'low',
      max_completion_tokens: this.config.salesDetailMaxTokens,
      response_format: { type: 'json_object' },
      messages: [
        {
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
        },
      ],
    };
    const parsed = await this.requestStructuredResult<SalesDetailResponse>(
      payload,
      compactSalesDetailRetryPrompt,
      (value): value is SalesDetailResponse => {
        if (!isRecord(value)) return false;
        if (hasArrayProperty(value, 'lineItems')) {
          return (value.lineItems as unknown[]).every(isVisionLineItem);
        }
        if (!hasArrayProperty(value, 'rows')) return false;
        return (value.rows as unknown[]).every(
          (row) =>
            isRecord(row) &&
            typeof row.label === 'string' &&
            (Array.isArray(row.values) || isRecord(row.values)),
        );
      },
      'sales detail',
    );
    if (parsed.lineItems) return normalizeLineItems(parsed.lineItems);
    return (parsed.rows ?? []).map((row, index) => {
      const values: Record<string, string | number | null> = isRecord(
        row.values,
      )
        ? (row.values as Record<string, string | number | null>)
        : Object.fromEntries(
            salesDetailColumns.map((column, columnIndex) => [
              column,
              row.values?.[columnIndex] ?? '',
            ]),
          );
      return {
        section: row.section?.trim() || '商品销售与进货结算明细',
        label: row.label?.trim() || `第 ${index + 1} 行`,
        rowType: row.rowType ?? 'detail',
        sequence: row.sequence ?? index + 1,
        values,
        rawText: row.rawText?.trim() || null,
        page: Number.isFinite(row.page) ? row.page! : null,
        confidence: typeof row.confidence === 'number' ? row.confidence : null,
      };
    });
  }

  private async extractLineItemsWithPrompt(
    images: Buffer[],
    prompt: string,
    maxCompletionTokens: number,
  ): Promise<VisionLineItem[]> {
    const response = await this.postWithRetry('/chat/completions', {
      model: this.config.model,
      temperature: 0,
      reasoning_effort: 'low',
      max_completion_tokens: maxCompletionTokens,
      response_format: { type: 'json_object' },
      messages: [
        {
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
        },
      ],
    });
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
      if (
        firstValue === null ||
        secondValue === null ||
        firstValue !== secondValue
      ) {
        fields[key] = {
          ...first,
          confidence: Math.min(first.confidence ?? 1, 0.55),
        };
      } else {
        fields[key] = {
          ...first,
          confidence: Math.min(
            first.confidence ?? 1,
            second?.confidence ?? 0.8,
          ),
        };
      }
    }
    return { ...primary, fields };
  }

  normalizeModelResult(
    input: ModelResult,
    fileName = 'vision-extracted-bill.pdf',
  ): VisionExtractionResult {
    const normalizedAdditionalFields = normalizeAdditionalFields(
      input.additionalFields,
    );
    const { fields, additionalFields } = normalizePrimaryFields(
      input.fields ?? {},
      normalizedAdditionalFields,
    );
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
    const invoiceEvidenceText = String(fields.invoiceAmount?.rawText ?? '');
    const deductionEvidenceText = String(fields.deductionTotal?.rawText ?? '');
    const settlementEvidenceText = String(
      fields.settlementAmount?.rawText ?? '',
    );
    const postInvoiceDeductionFormula =
      /发票金额/.test(invoiceEvidenceText) &&
      /扣款费用|扣费/.test(deductionEvidenceText) &&
      /实付|实结/.test(settlementEvidenceText) &&
      !/调整项|A-B|C-D/.test(
        `${invoiceEvidenceText} ${deductionEvidenceText} ${settlementEvidenceText}`,
      );
    if (
      postInvoiceDeductionFormula &&
      invoiceAmount !== null &&
      deductionTotal !== null &&
      settlement !== null
    ) {
      if (Math.abs(invoiceAmount - deductionTotal - settlement) > 0.01) {
        warnings.push(
          '发票金额、扣款费用合计与实付金额未通过交叉校验，请核对原始单据。',
        );
      }
    } else if (
      sales !== null &&
      settlement !== null &&
      (money(fields.commissionAmount?.value) !== null ||
        money(fields.activityFee?.value) !== null) &&
      Math.abs(sales - refund - commission - activity - settlement) > 0.01
    ) {
      warnings.push('结算金额与可见金额勾稽不一致，请核对原始单据。');
    }
    for (const [key, field] of Object.entries(fields) as Array<
      [VisionFieldKey, ModelField]
    >) {
      if (
        field?.confidence !== null &&
        field?.confidence !== undefined &&
        field.confidence < 0.9
      ) {
        warnings.push(`${fieldLabels[key]}识别置信度较低，请核对原始单据。`);
      }
    }
    const normalizedPeriod = normalizeSettlementPeriod(
      input,
      fileName,
      additionalFields,
    );
    if (normalizedPeriod.warning) warnings.push(normalizedPeriod.warning);
    // Keep the compatibility row aligned with the normalized metadata. The
    // task-import flow maps these columns and previously received empty dates
    // even though metadata already contained the correct accounting period.
    row[fieldLabels.periodStart] = normalizedPeriod.metadata.periodStart;
    row[fieldLabels.periodEnd] = normalizedPeriod.metadata.periodEnd;

    return {
      sourceType: 'vision_llm',
      fileName,
      headers,
      rows: [row],
      metadata: normalizedPeriod.metadata,
      periodEvidence: normalizedPeriod.evidence,
      evidence: fields,
      additionalFields,
      lineItems: normalizeLineItems(input.lineItems),
      warnings,
    };
  }
}

function normalizeAdditionalFields(
  input: VisionAdditionalField[] | undefined,
): VisionAdditionalField[] {
  return (Array.isArray(input) ? input : [])
    .filter(
      (field) => field && typeof field.label === 'string' && field.label.trim(),
    )
    .map((field) => {
      const label = field.label.trim();
      const rawText = field.rawText?.trim() || null;
      const semanticText = `${label} ${rawText ?? ''}`;
      let suggestedTarget = field.suggestedTarget?.trim() || null;
      if (
        suggestedTarget === 'settlementDate' &&
        /合同|合约|协议/.test(semanticText) &&
        /有效期|有效期限|期限|起止/.test(semanticText)
      ) {
        suggestedTarget = null;
      }
      if (
        suggestedTarget === 'businessMode' &&
        /扣点|扣率|抽成率|佣金率/.test(semanticText)
      ) {
        suggestedTarget = null;
      }
      return {
        ...field,
        label,
        value: field.value ?? null,
        rawText,
        page: Number.isFinite(field.page) ? field.page : null,
        confidence:
          typeof field.confidence === 'number' ? field.confidence : null,
        group: ['header', 'summary', 'fee', 'other'].includes(field.group)
          ? field.group
          : 'other',
        suggestedTarget,
      };
    });
}

const canonicalFieldSemantics: Partial<Record<VisionFieldKey, RegExp>> = {
  salesAmount: /销售|营业额|销货|销售收入/,
  refundAmount: /退款|退货|销售退回/,
  commissionAmount: /扣点|抽成|佣金|联营扣/,
  activityFee: /活动|促销/,
  invoiceAmount: /发票/,
  deductionTotal: /扣款|扣费|调整|扣除|费用合计/,
  settlementAmount: /实付|实结|应付|应结|结算金额|结算款|付款金额/,
};

function canonicalFieldMatchesLabel(key: VisionFieldKey, rawText: string) {
  const pattern = canonicalFieldSemantics[key];
  if (!pattern || !rawText.trim()) return true;
  if (
    key === 'commissionAmount' &&
    /%|扣率|费率|比例/.test(rawText) &&
    !/金额/.test(rawText)
  ) {
    return false;
  }
  return pattern.test(rawText);
}

function evidenceLabel(rawText: string, fallback: string) {
  return (
    rawText
      .replace(/[￥¥]?\s*[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[：:，,;；/／|]+$/g, '')
      .trim() || fallback
  );
}

function normalizePrimaryFields(
  input: Partial<Record<VisionFieldKey, ModelField>>,
  additionalFields: VisionAdditionalField[],
) {
  const fields = { ...input };
  const movedFields: VisionAdditionalField[] = [];
  for (const [key, field] of Object.entries(fields) as Array<
    [VisionFieldKey, ModelField]
  >) {
    if (!field || field.value === null || field.value === undefined) continue;
    const rawText = String(field.rawText ?? '').trim();
    if (canonicalFieldMatchesLabel(key, rawText)) continue;

    delete fields[key];
    const label = evidenceLabel(rawText, fieldLabels[key]);
    const candidateValue = money(field.value);
    const duplicate = additionalFields.some((candidate) => {
      const existingRaw = String(candidate.rawText ?? '').replace(/\s+/g, '');
      const candidateRaw = rawText.replace(/\s+/g, '');
      const existingValue = money(candidate.value);
      const sameValue =
        candidateValue !== null && existingValue !== null
          ? candidateValue === existingValue
          : String(candidate.value ?? '') === String(field.value ?? '');
      const semanticOverlap =
        existingRaw === candidateRaw ||
        `${candidate.label}${existingRaw}`
          .replace(/\s+/g, '')
          .includes(label.replace(/\s+/g, '')) ||
        candidateRaw.includes(candidate.label.replace(/\s+/g, ''));
      return sameValue && semanticOverlap;
    });
    if (!duplicate) {
      movedFields.push({
        label,
        value: field.value,
        rawText: rawText || null,
        page: Number.isFinite(field.page) ? field.page : null,
        confidence:
          typeof field.confidence === 'number' ? field.confidence : null,
        group: 'summary',
        suggestedTarget: null,
      });
    }
  }
  return {
    fields,
    additionalFields: [...additionalFields, ...movedFields],
  };
}

function normalizeLineItems(input: VisionLineItem[] | undefined) {
  return (Array.isArray(input) ? input : [])
    .filter(
      (item) => item && typeof item.label === 'string' && item.label.trim(),
    )
    .map((item) => ({
      ...item,
      section: item.section?.trim() || '明细',
      label: item.label.trim(),
      rowType: ['detail', 'adjustment', 'subtotal', 'total', 'empty'].includes(
        item.rowType ?? '',
      )
        ? item.rowType
        : 'detail',
      sequence: Number.isFinite(item.sequence) ? item.sequence : null,
      values: item.values && typeof item.values === 'object' ? item.values : {},
      rawText: item.rawText?.trim() || null,
      page: Number.isFinite(item.page) ? item.page : null,
      confidence: typeof item.confidence === 'number' ? item.confidence : null,
    }));
}

const normalizeDate = (input: string): string | null => {
  const normalized = input
    .trim()
    .replace(/年/g, '-')
    .replace(/月/g, '-')
    .replace(/日/g, '')
    .replace(/[/.]/g, '-');
  const match = /^([12]\d{3})-(\d{1,2})-(\d{1,2})$/.exec(normalized);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  )
    return null;
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const parseDateRange = (input: string): [string, string] | null => {
  const dateToken =
    '[12]\\d{3}(?:[-/.]\\d{1,2}[-/.]\\d{1,2}|年\\d{1,2}月\\d{1,2}日?)';
  const match = new RegExp(
    `^\\s*(${dateToken})\\s*(?:~|～|至|到|—|–|-)\\s*(${dateToken})\\s*$`,
  ).exec(input);
  if (!match) return null;
  const start = normalizeDate(match[1]);
  const end = normalizeDate(match[2]);
  return start && end ? [start, end] : null;
};

const parseMonth = (input: string): [string, string] | null => {
  const match = /^([12]\d{3})[-/.年](0?[1-9]|1[0-2])月?$/.exec(input.trim());
  if (!match) return null;
  return [match[1], String(Number(match[2])).padStart(2, '0')];
};

function normalizeMonthlyPeriod(
  metadata: VisionExtractionResult['metadata'] | undefined,
) {
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
  const range = parseDateRange(periodStart) ?? parseDateRange(periodEnd);
  if (range) {
    return { ...normalized, periodStart: range[0], periodEnd: range[1] };
  }
  const exactStart = normalizeDate(periodStart);
  const exactEnd = normalizeDate(periodEnd);
  if (exactStart || exactEnd) {
    return {
      ...normalized,
      periodStart: exactStart ?? periodStart,
      periodEnd: exactEnd ?? periodEnd,
    };
  }
  const month = parseMonth(periodStart) ?? parseMonth(periodEnd);
  if (!month) return normalized;
  const [year, monthNumber] = month;
  const lastDay = new Date(Number(year), Number(monthNumber), 0).getDate();
  return {
    ...normalized,
    periodStart: `${year}-${monthNumber}-01`,
    periodEnd: `${year}-${monthNumber}-${String(lastDay).padStart(2, '0')}`,
  };
}

function normalizeSettlementPeriod(
  input: ModelResult,
  fileName: string,
  additionalFields: ReadonlyArray<
    Pick<VisionAdditionalField, 'label' | 'value' | 'rawText'>
  >,
) {
  const metadata = normalizeMonthlyPeriod(input.metadata);
  const evidence = normalizePeriodEvidence(input);
  const periodSources = [
    input.metadata?.periodStart,
    input.metadata?.periodEnd,
    input.periodEvidence?.rawText,
  ]
    .map((value) => String(value ?? '').replace(/\s+/g, ''))
    .filter(Boolean);
  const periodWasCopiedFromContract = additionalFields.some((field) => {
    const semanticText = `${field.label} ${field.rawText ?? ''}`;
    if (
      !/合同|合约|协议/.test(semanticText) ||
      !/有效期|有效期限|期限|起止/.test(semanticText)
    ) {
      return false;
    }
    const contractText = `${field.value ?? ''} ${field.rawText ?? ''}`.replace(
      /\s+/g,
      '',
    );
    return periodSources.some(
      (period) =>
        contractText.includes(period) ||
        (contractText.length >= 8 && period.includes(contractText)),
    );
  });
  const fileMonth = /(?:^|\D)((?:19|20)\d{2})(0[1-9]|1[0-2])(?:\D|$)/.exec(
    fileName,
  );
  if (!periodWasCopiedFromContract || !fileMonth) {
    return { metadata, evidence, warning: null };
  }

  const year = fileMonth[1];
  const month = fileMonth[2];
  const lastDay = new Date(Number(year), Number(month), 0).getDate();
  return {
    metadata: {
      ...metadata,
      periodStart: `${year}-${month}-01`,
      periodEnd: `${year}-${month}-${String(lastDay).padStart(2, '0')}`,
    },
    evidence: {
      rawText: `文件名 ${year}${month}`,
      page: null,
      kind: 'inferred' as const,
    },
    warning:
      '模型曾把合同有效期当作结算账期；系统已按文件名月份修正，请人工复核账期。',
  };
}

function normalizePeriodEvidence(
  input: ModelResult,
): VisionExtractionResult['periodEvidence'] {
  const evidence = input.periodEvidence;
  if (
    evidence &&
    ['explicit_range', 'month_only', 'inferred', 'unknown'].includes(
      evidence.kind,
    )
  ) {
    return {
      rawText:
        evidence.rawText === null || evidence.rawText === undefined
          ? null
          : String(evidence.rawText).trim() || null,
      page: Number.isFinite(evidence.page) ? evidence.page : null,
      kind: evidence.kind,
    };
  }
  return { rawText: null, page: null, kind: 'unknown' };
}
