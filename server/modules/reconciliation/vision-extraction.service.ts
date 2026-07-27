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

type VisionConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
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

const feeDetailPrompt = `Transcribe only the deduction/fee detail table from this document. Return JSON only as { "lineItems": [...] }. For each A/B/C group, split every printed fee-name and amount pair into one atomic item. Also preserve printed group subtotal rows and the grand total row. Each item is { "section":"扣款费用明细", "label":string, "rowType":"detail|subtotal|total|empty", "sequence":number, "values":{"费用代码":string|null,"金额":number|string|null,"分组":string|null}, "rawText":string|null, "page":number|null, "confidence":number|null }. Never combine multiple fees into one item. Do not extract the sales table or period summary.`;

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
    };
  private readonly client: Pick<AxiosInstance, 'post'> = axios.create({
    baseURL: this.config.baseUrl,
    timeout: 90_000,
  });

  private async postWithRetry(path: string, payload: unknown) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.client.post(path, payload, {
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
        });
      } catch (error) {
        lastError = error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    throw lastError;
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
      max_completion_tokens: 4000,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: extractionPrompt },
            { type: 'text', text: evidenceFirstAddendum },
            { type: 'text', text: metadataSemanticsAddendum },
            {
              type: 'text',
              text: `Also return fields.invoiceAmount and fields.deductionTotal using the same { value, rawText, page, confidence } shape. For a monthly bill headed only YYYY-MM, set periodStart to the first calendar day and periodEnd to the last calendar day. For every monetary value, copy the exact printed number, preserve two decimals, and set confidence below 0.9 whenever it was inferred, summed, or visually uncertain.`,
            },
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
    const primaryRequest = this.postWithRetry(
      '/chat/completions',
      primaryPayload,
    );
    const [response, extractedLineItems] = await Promise.all([
      primaryRequest,
      this.extractLineItems(images).catch(() => []),
    ]);
    const content = response.data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new BadRequestException('视觉模型未返回可解析的识别结果，请重试。');
    }
    try {
      const primary = JSON.parse(content) as ModelResult;
      const lineItems = extractedLineItems.length ? extractedLineItems : (primary.lineItems ?? []);
      return this.normalizeModelResult(
        {
          ...primary,
          lineItems: lineItems.length ? lineItems : primary.lineItems,
        },
        fileName,
      );
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('视觉模型返回格式错误，请重试或使用 Excel 导入。');
    }
  }

  async refineLowConfidenceFields(
    images: Buffer[],
    candidates: VisionRefinementCandidate[],
  ): Promise<VisionRefinementResult> {
    if (!images.length || !candidates.length) return { items: [] };
    const candidateJson = JSON.stringify(candidates.slice(0, 16));
    const response = await this.client.post(
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
      {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
      },
    );
    const content = response.data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return { items: [] };
    const parsed = JSON.parse(content) as VisionRefinementResult;
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    return {
      items: (parsed.items ?? []).filter((item) =>
        candidateIds.has(item.id) && ['confirmed', 'conflict', 'unresolved'].includes(item.status),
      ),
    };
  }

  private async verifyFields(images: Buffer[]): Promise<Partial<Record<VisionFieldKey, ModelField>>> {
    const response = await this.client.post(
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
      {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
      },
    );
    const content = response.data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return {};
    const parsed = JSON.parse(content) as { fields?: Partial<Record<VisionFieldKey, ModelField>> };
    return parsed.fields ?? {};
  }

  private async extractLineItems(images: Buffer[]): Promise<VisionLineItem[]> {
    const [salesItems, feeItems] = await Promise.all([
      this.extractLineItemsWithPrompt(images, salesDetailPrompt, 3500),
      this.extractLineItemsWithPrompt(images, feeDetailPrompt, 3000),
    ]);
    return [...salesItems, ...feeItems];
  }

  private async extractLineItemsWithPrompt(
    images: Buffer[],
    prompt: string,
    maxCompletionTokens: number,
  ): Promise<VisionLineItem[]> {
    const response = await this.client.post(
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
      {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
      },
    );
    const content = response.data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return [];
    const parsed = JSON.parse(content) as { lineItems?: VisionLineItem[] };
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
  return (input ?? [])
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
  return (input ?? [])
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

function normalizeMonthlyPeriod(metadata: VisionExtractionResult['metadata']) {
  const periodStart = metadata.periodStart?.trim() ?? '';
  const periodEnd = metadata.periodEnd?.trim() ?? '';
  const month = /^([12]\d{3})-(0[1-9]|1[0-2])$/.exec(periodStart || periodEnd);
  if (!month) return metadata;
  const [, year, monthNumber] = month;
  const lastDay = new Date(Number(year), Number(monthNumber), 0).getDate();
  return {
    ...metadata,
    periodStart: `${year}-${monthNumber}-01`,
    periodEnd: `${year}-${monthNumber}-${String(lastDay).padStart(2, '0')}`,
  };
}

function normalizePeriodEvidence(input: ModelResult): VisionExtractionResult['periodEvidence'] {
  const evidence = input.periodEvidence;
  if (evidence && ['explicit_range', 'month_only', 'inferred', 'unknown'].includes(evidence.kind)) {
    return {
      rawText: evidence.rawText?.trim() || null,
      page: Number.isFinite(evidence.page) ? evidence.page : null,
      kind: evidence.kind,
    };
  }
  return { rawText: null, page: null, kind: 'unknown' };
}
