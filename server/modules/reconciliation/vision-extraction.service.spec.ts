import { VisionExtractionService } from './vision-extraction.service';
import axios from 'axios';

describe('VisionExtractionService', () => {
  const metadata = {
    mallName: 'SHAD',
    storeName: '南京店',
    storeCode: 'SHAD64',
    periodStart: '2026-05-01',
    periodEnd: '2026-05-31',
    billType: 'standard' as const,
  };

  it('normalizes visible bill fields into one compatible bill row', () => {
    const service = new VisionExtractionService();

    const result = service.normalizeModelResult({
      metadata,
      fields: {
        salesAmount: {
          value: '100000.00',
          rawText: '销售额 100,000.00',
          page: 1,
          confidence: 0.99,
        },
        settlementAmount: {
          value: '85000.00',
          rawText: '本期应付 85,000.00',
          page: 1,
          confidence: 0.99,
        },
      },
    });

    expect(result.headers).toEqual(
      expect.arrayContaining(['销售金额', '实结金额']),
    );
    expect(result.rows).toEqual([
      expect.objectContaining({ 销售金额: '100000.00', 实结金额: '85000.00' }),
    ]);
    expect(result.evidence.salesAmount).toMatchObject({ page: 1, confidence: 0.99 });
  });

  it('warns when visible values do not reconcile', () => {
    const service = new VisionExtractionService();

    const result = service.normalizeModelResult({
      metadata,
      fields: {
        salesAmount: { value: 100, rawText: '销售额 100', page: 1, confidence: 0.99 },
        commissionAmount: { value: 10, rawText: '扣点 10', page: 1, confidence: 0.99 },
        settlementAmount: { value: 70, rawText: '应付 70', page: 1, confidence: 0.99 },
      },
    });

    expect(result.warnings).toContain('结算金额与可见金额勾稽不一致，请核对原始单据。');
  });

  it('sends rendered images and requests JSON-only output', async () => {
    const post = jest.fn().mockResolvedValue({
      data: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                metadata,
                fields: {
                  salesAmount: {
                    value: 100000,
                    rawText: '销售额 100,000.00',
                    page: 1,
                    confidence: 0.99,
                  },
                },
              }),
            },
          },
        ],
      },
    });
    const create = jest.spyOn(axios, 'create').mockReturnValue({ post } as never);
    const originalBaseUrl = process.env.VISION_LLM_BASE_URL;
    const originalApiKey = process.env.VISION_LLM_API_KEY;
    const originalModel = process.env.VISION_LLM_MODEL;
    const originalPrimaryTokens = process.env.VISION_LLM_PRIMARY_MAX_TOKENS;
    process.env.VISION_LLM_BASE_URL = 'https://example.test/v1';
    process.env.VISION_LLM_API_KEY = 'test-key';
    process.env.VISION_LLM_MODEL = 'minimax/minimax-m3';
    process.env.VISION_LLM_PRIMARY_MAX_TOKENS = '1234';
    const service = new VisionExtractionService();

    await service.extractFromImages('bill.pdf', [Buffer.from('image')]);

    expect(post).toHaveBeenCalledWith(
      '/chat/completions',
      expect.objectContaining({
        model: 'minimax/minimax-m3',
        max_completion_tokens: 1234,
        response_format: { type: 'json_object' },
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    );
    const request = post.mock.calls[0][1];
    const textContent = request.messages[0].content.filter(
      (item: { type: string }) => item.type === 'text',
    );
    expect(textContent).toHaveLength(1);
    expect(textContent[0].text).toContain('Output JSON immediately');
    const imageContent = request.messages[0].content.find(
      (item: { type: string }) => item.type === 'image_url',
    );
    expect(imageContent.image_url.url).toContain(
      'data:image/png;base64,',
    );
    create.mockRestore();
    process.env.VISION_LLM_BASE_URL = originalBaseUrl;
    process.env.VISION_LLM_API_KEY = originalApiKey;
    process.env.VISION_LLM_MODEL = originalModel;
    process.env.VISION_LLM_PRIMARY_MAX_TOKENS = originalPrimaryTokens;
  });

  it('waits for the primary extraction before starting line-item requests', async () => {
    let primaryFinished = false;
    let detailStartedEarly = false;
    const post = jest.fn(async (_path: string, payload: any) => {
      const prompt = String(payload.messages[0].content[0].text);
      const isSales = prompt.includes('sales/purchase settlement detail');
      const isFees = prompt.includes('deduction/fee detail table');

      if (isSales || isFees) {
        if (!primaryFinished) detailStartedEarly = true;
        return {
          data: {
            choices: [{ message: { content: JSON.stringify({ lineItems: [] }) } }],
          },
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
      primaryFinished = true;
      return {
        data: {
          choices: [{ message: { content: JSON.stringify({ metadata, fields: {} }) } }],
        },
      };
    });
    const create = jest.spyOn(axios, 'create').mockReturnValue({ post } as never);
    const originalBaseUrl = process.env.VISION_LLM_BASE_URL;
    const originalApiKey = process.env.VISION_LLM_API_KEY;
    process.env.VISION_LLM_BASE_URL = 'https://example.test/v1';
    process.env.VISION_LLM_API_KEY = 'test-key';

    try {
      const service = new VisionExtractionService();
      await service.extractFromImages('bill.pdf', [Buffer.from('image')]);
      expect(detailStartedEarly).toBe(false);
    } finally {
      create.mockRestore();
      process.env.VISION_LLM_BASE_URL = originalBaseUrl;
      process.env.VISION_LLM_API_KEY = originalApiKey;
    }
  });

  it('retries a transient line-item failure without losing the primary result', async () => {
    let salesAttempts = 0;
    const post = jest.fn(async (_path: string, payload: any) => {
      const prompt = String(payload.messages[0].content[0].text);
      if (prompt.includes('sales/purchase settlement detail')) {
        salesAttempts += 1;
        if (salesAttempts === 1) {
          const error = new Error('socket hang up') as Error & { code: string };
          error.code = 'ECONNRESET';
          throw error;
        }
        return {
          data: {
            choices: [{
              message: {
                content: JSON.stringify({
                  lineItems: [{
                    section: 'sales',
                    label: 'total',
                    rowType: 'total',
                    sequence: 1,
                    values: { amount: 100 },
                    rawText: 'total 100',
                    page: 1,
                    confidence: 0.99,
                  }],
                }),
              },
            }],
          },
        };
      }
      if (prompt.includes('deduction/fee detail table')) {
        return {
          data: {
            choices: [{ message: { content: JSON.stringify({ lineItems: [] }) } }],
          },
        };
      }
      return {
        data: {
          choices: [{ message: { content: JSON.stringify({ metadata, fields: {} }) } }],
        },
      };
    });
    const create = jest.spyOn(axios, 'create').mockReturnValue({ post } as never);
    const originalEnv = {
      baseUrl: process.env.VISION_LLM_BASE_URL,
      apiKey: process.env.VISION_LLM_API_KEY,
      retries: process.env.VISION_LLM_MAX_RETRIES,
      delay: process.env.VISION_LLM_RETRY_DELAY_MS,
    };
    process.env.VISION_LLM_BASE_URL = 'https://example.test/v1';
    process.env.VISION_LLM_API_KEY = 'test-key';
    process.env.VISION_LLM_MAX_RETRIES = '1';
    process.env.VISION_LLM_RETRY_DELAY_MS = '0';

    try {
      const service = new VisionExtractionService();
      const result = await service.extractFromImages('bill.pdf', [Buffer.from('image')]);
      expect(salesAttempts).toBe(2);
      expect(result.lineItems).toEqual([
        expect.objectContaining({ label: 'total', values: { amount: 100 } }),
      ]);
      expect(result.metadata).toEqual(metadata);
    } finally {
      create.mockRestore();
      process.env.VISION_LLM_BASE_URL = originalEnv.baseUrl;
      process.env.VISION_LLM_API_KEY = originalEnv.apiKey;
      process.env.VISION_LLM_MAX_RETRIES = originalEnv.retries;
      process.env.VISION_LLM_RETRY_DELAY_MS = originalEnv.delay;
    }
  });

  it('accepts JSON wrapped in a markdown code fence', async () => {
    const post = jest.fn(async (_path: string, payload: any) => {
      const prompt = String(payload.messages[0].content[0].text);
      const output = prompt.includes('settlement detail')
        ? { lineItems: [] }
        : { metadata, fields: {} };
      return {
        data: {
          choices: [{
            message: { content: `\`\`\`json\n${JSON.stringify(output)}\n\`\`\`` },
          }],
        },
      };
    });
    const create = jest.spyOn(axios, 'create').mockReturnValue({ post } as never);
    const originalBaseUrl = process.env.VISION_LLM_BASE_URL;
    const originalApiKey = process.env.VISION_LLM_API_KEY;
    process.env.VISION_LLM_BASE_URL = 'https://example.test/v1';
    process.env.VISION_LLM_API_KEY = 'test-key';

    try {
      const service = new VisionExtractionService();
      const result = await service.extractFromImages('bill.pdf', [Buffer.from('image')]);
      expect(result.metadata).toEqual(metadata);
    } finally {
      create.mockRestore();
      process.env.VISION_LLM_BASE_URL = originalBaseUrl;
      process.env.VISION_LLM_API_KEY = originalApiKey;
    }
  });

  it('does not request line items when the primary response is invalid', async () => {
    const post = jest.fn().mockResolvedValue({
      data: { choices: [{ message: { content: 'not-json' } }] },
    });
    const create = jest.spyOn(axios, 'create').mockReturnValue({ post } as never);
    const originalBaseUrl = process.env.VISION_LLM_BASE_URL;
    const originalApiKey = process.env.VISION_LLM_API_KEY;
    process.env.VISION_LLM_BASE_URL = 'https://example.test/v1';
    process.env.VISION_LLM_API_KEY = 'test-key';

    try {
      const service = new VisionExtractionService();
      await expect(
        service.extractFromImages('bill.pdf', [Buffer.from('image')]),
      ).rejects.toThrow();
      expect(post).toHaveBeenCalledTimes(2);
    } finally {
      create.mockRestore();
      process.env.VISION_LLM_BASE_URL = originalBaseUrl;
      process.env.VISION_LLM_API_KEY = originalApiKey;
    }
  });

  it('expands compact sales rows into the stable line-item schema', async () => {
    const post = jest.fn(async (_path: string, payload: any) => {
      const prompt = String(payload.messages[0].content[0].text);
      if (prompt.includes('compact rows')) {
        return {
          data: {
            choices: [{ message: { content: JSON.stringify({
              rows: [{
                label: 'rate -15',
                rowType: 'detail',
                values: ['rate -15', -15, 131, 49847, 7477.05, 1.13, 42369.95],
              }],
            }) } }],
          },
        };
      }
      if (prompt.includes('deduction/fee detail table')) {
        return {
          data: { choices: [{ message: { content: JSON.stringify({ lineItems: [] }) } }] },
        };
      }
      return {
        data: {
          choices: [{ message: { content: JSON.stringify({ metadata, fields: {} }) } }],
        },
      };
    });
    const create = jest.spyOn(axios, 'create').mockReturnValue({ post } as never);
    const originalBaseUrl = process.env.VISION_LLM_BASE_URL;
    const originalApiKey = process.env.VISION_LLM_API_KEY;
    process.env.VISION_LLM_BASE_URL = 'https://example.test/v1';
    process.env.VISION_LLM_API_KEY = 'test-key';

    try {
      const service = new VisionExtractionService();
      const result = await service.extractFromImages('bill.pdf', [Buffer.from('image')]);
      expect(result.lineItems).toEqual([
        expect.objectContaining({
          section: '商品销售与进货结算明细',
          label: 'rate -15',
          values: expect.objectContaining({
            销售金额: 49847,
            '含税销售成本(含调整)': 42369.95,
          }),
        }),
      ]);
    } finally {
      create.mockRestore();
      process.env.VISION_LLM_BASE_URL = originalBaseUrl;
      process.env.VISION_LLM_API_KEY = originalApiKey;
    }
  });

  it('expands a compact primary response into the stable extraction schema', async () => {
    const post = jest.fn(async (_path: string, payload: any) => {
      const prompt = String(payload.messages[0].content[0].text);
      if (prompt.includes('compact primary bill data')) {
        return {
          data: {
            choices: [{ message: { content: JSON.stringify({
              m: ['百联滨江购物中心', '阿迪达斯', '086203', '2026-05', 'standard'],
              p: ['结算期：2026-05', 1, 'month_only'],
              f: {
                salesAmount: [69843, '销售金额 69843', 1, 0.98],
                activityFee: [5650.47, '扣款费用合计 5650.47', 1, 0.98],
                invoiceAmount: [60566.31, '发票金额 60566.31', 1, 0.98],
                deductionTotal: [5650.47, '扣款费用合计 5650.47', 1, 0.98],
                settlementAmount: [54915.84, '实付金额 54915.84', 1, 0.98],
              },
              a: [['品牌商户', '上海锐力', '品牌商户 上海锐力', 1, 0.96, 'header', 'brandMerchantName']],
            }) } }],
          },
        };
      }
      if (prompt.includes('compact rows')) {
        return { data: { choices: [{ message: { content: '{"rows":[]}' } }] } };
      }
      return { data: { choices: [{ message: { content: '{"lineItems":[]}' } }] } };
    });
    const create = jest.spyOn(axios, 'create').mockReturnValue({ post } as never);
    const originalBaseUrl = process.env.VISION_LLM_BASE_URL;
    const originalApiKey = process.env.VISION_LLM_API_KEY;
    process.env.VISION_LLM_BASE_URL = 'https://example.test/v1';
    process.env.VISION_LLM_API_KEY = 'test-key';

    try {
      const service = new VisionExtractionService();
      const result = await service.extractFromImages('bill.pdf', [Buffer.from('image')]);
      expect(result.metadata).toEqual(expect.objectContaining({
        mallName: '百联滨江购物中心',
        storeName: '阿迪达斯',
        storeCode: '086203',
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
      }));
      expect(result.evidence).toEqual(expect.objectContaining({
        salesAmount: expect.objectContaining({ value: 69843 }),
        activityFee: expect.objectContaining({ value: null }),
        settlementAmount: expect.objectContaining({ value: 54915.84 }),
      }));
      expect(result.additionalFields).toEqual([
        expect.objectContaining({ suggestedTarget: 'brandMerchantName', value: '上海锐力' }),
      ]);
    } finally {
      create.mockRestore();
      process.env.VISION_LLM_BASE_URL = originalBaseUrl;
      process.env.VISION_LLM_API_KEY = originalApiKey;
    }
  });

  it('expands compact fee rows into atomic fee line items', async () => {
    const post = jest.fn(async (_path: string, payload: any) => {
      const prompt = String(payload.messages[0].content[0].text);
      if (prompt.includes('compact fee rows')) {
        return { data: { choices: [{ message: { content: JSON.stringify({ rows: [
          ['支付手续费-0701', 'detail', '0701', 13.98, 'B'],
          ['B小计', 'subtotal', null, 2150.97, 'B'],
          ['合计', 'total', null, 5650.47, null],
        ] }) } }] } };
      }
      if (prompt.includes('compact rows')) {
        return { data: { choices: [{ message: { content: '{"rows":[]}' } }] } };
      }
      return {
        data: { choices: [{ message: { content: JSON.stringify({ metadata, fields: {} }) } }] },
      };
    });
    const create = jest.spyOn(axios, 'create').mockReturnValue({ post } as never);
    const originalBaseUrl = process.env.VISION_LLM_BASE_URL;
    const originalApiKey = process.env.VISION_LLM_API_KEY;
    process.env.VISION_LLM_BASE_URL = 'https://example.test/v1';
    process.env.VISION_LLM_API_KEY = 'test-key';

    try {
      const service = new VisionExtractionService();
      const result = await service.extractFromImages('bill.pdf', [Buffer.from('image')]);
      expect(result.lineItems).toEqual([
        expect.objectContaining({
          section: '扣款费用明细',
          label: '支付手续费-0701',
          values: { 费用代码: '0701', 金额: 13.98, 分组: 'B' },
        }),
        expect.objectContaining({ label: 'B小计', rowType: 'subtotal' }),
        expect.objectContaining({ label: '合计', rowType: 'total' }),
      ]);
    } finally {
      create.mockRestore();
      process.env.VISION_LLM_BASE_URL = originalBaseUrl;
      process.env.VISION_LLM_API_KEY = originalApiKey;
    }
  });

  it('normalizes a valid model response when optional containers are missing', () => {
    const service = new VisionExtractionService();
    const result = service.normalizeModelResult({
      metadata: undefined as any,
      fields: {},
      additionalFields: {} as any,
      lineItems: {} as any,
    });

    expect(result.metadata).toEqual(expect.objectContaining({
      mallName: '',
      storeName: '',
      storeCode: '',
    }));
    expect(result.additionalFields).toEqual([]);
    expect(result.lineItems).toEqual([]);
  });

  it('normalizes a numeric period evidence value returned by the model', () => {
    const service = new VisionExtractionService();
    const result = service.normalizeModelResult({
      metadata,
      fields: {},
      periodEvidence: {
        rawText: 202605 as any,
        page: 1,
        kind: 'month_only',
      },
    });

    expect(result.periodEvidence).toEqual({
      rawText: '202605',
      page: 1,
      kind: 'month_only',
    });
  });

  it('retries once when the primary response is not a JSON object', async () => {
    let primaryAttempts = 0;
    const post = jest.fn(async (_path: string, payload: any) => {
      const prompt = String(payload.messages[0].content[0].text);
      if (
        prompt.includes('Output JSON immediately') &&
        !prompt.includes('compact rows') &&
        !prompt.includes('deduction/fee detail table')
      ) {
        primaryAttempts += 1;
        return {
          data: {
            choices: [{ message: { content: primaryAttempts === 1
              ? 'null'
              : JSON.stringify({ metadata, fields: {} }) } }],
          },
        };
      }
      if (prompt.includes('compact rows')) {
        return { data: { choices: [{ message: { content: '{"rows":[]}' } }] } };
      }
      return { data: { choices: [{ message: { content: '{"lineItems":[]}' } }] } };
    });
    const create = jest.spyOn(axios, 'create').mockReturnValue({ post } as never);
    const originalBaseUrl = process.env.VISION_LLM_BASE_URL;
    const originalApiKey = process.env.VISION_LLM_API_KEY;
    process.env.VISION_LLM_BASE_URL = 'https://example.test/v1';
    process.env.VISION_LLM_API_KEY = 'test-key';

    try {
      const service = new VisionExtractionService();
      const result = await service.extractFromImages('bill.pdf', [Buffer.from('image')]);
      expect(primaryAttempts).toBe(2);
      expect(result.metadata).toEqual(metadata);
    } finally {
      create.mockRestore();
      process.env.VISION_LLM_BASE_URL = originalBaseUrl;
      process.env.VISION_LLM_API_KEY = originalApiKey;
    }
  });
});
