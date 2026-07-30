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
      expect.objectContaining({
        账期开始: '2026-05-01',
        账期结束: '2026-05-31',
        销售金额: '100000.00',
        实结金额: '85000.00',
      }),
    ]);
    expect(result.evidence.salesAmount).toMatchObject({
      page: 1,
      confidence: 0.99,
    });
  });

  it('warns when visible values do not reconcile', () => {
    const service = new VisionExtractionService();

    const result = service.normalizeModelResult({
      metadata,
      fields: {
        salesAmount: {
          value: 100,
          rawText: '销售额 100',
          page: 1,
          confidence: 0.99,
        },
        commissionAmount: {
          value: 10,
          rawText: '扣点 10',
          page: 1,
          confidence: 0.99,
        },
        settlementAmount: {
          value: 70,
          rawText: '应付 70',
          page: 1,
          confidence: 0.99,
        },
      },
    });

    expect(result.warnings).toContain(
      '结算金额与可见金额勾稽不一致，请核对原始单据。',
    );
  });

  it('demotes a fixed field whose printed label has different semantics', () => {
    const service = new VisionExtractionService();

    const result = service.normalizeModelResult({
      metadata,
      fields: {
        salesAmount: {
          value: 512_047,
          rawText: '本月结算营业额小计 512,047.00',
          page: 1,
          confidence: 0.99,
        },
        commissionAmount: {
          value: 424_999.01,
          rawText: '本月回款小计 424,999.01',
          page: 1,
          confidence: 0.99,
        },
        activityFee: {
          value: 0,
          rawText: 'D.本期费用小计 0.00',
          page: 1,
          confidence: 0.99,
        },
        settlementAmount: {
          value: 410_001,
          rawText: '本期应付总额 410,001.00',
          page: 1,
          confidence: 0.99,
        },
      },
      additionalFields: [
        {
          label: '本月回款小计',
          value: 424_999.01,
          rawText: '本月回款小计 424,999.01',
          page: 1,
          confidence: 0.99,
          group: 'summary',
          suggestedTarget: 'receivableBase',
        },
      ],
    });

    expect(result.evidence.commissionAmount).toBeUndefined();
    expect(result.evidence.activityFee).toBeUndefined();
    expect(
      result.additionalFields.filter((field) => field.label === '本月回款小计'),
    ).toHaveLength(1);
    expect(result.additionalFields).toContainEqual(
      expect.objectContaining({
        label: 'D.本期费用小计',
        value: 0,
        suggestedTarget: null,
      }),
    );
    expect(result.warnings).not.toContain(
      '结算金额与可见金额勾稽不一致，请核对原始单据。',
    );
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
    const create = jest
      .spyOn(axios, 'create')
      .mockReturnValue({ post } as never);
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
    expect(imageContent.image_url.url).toContain('data:image/png;base64,');
    create.mockRestore();
    process.env.VISION_LLM_BASE_URL = originalBaseUrl;
    process.env.VISION_LLM_API_KEY = originalApiKey;
    process.env.VISION_LLM_MODEL = originalModel;
    process.env.VISION_LLM_PRIMARY_MAX_TOKENS = originalPrimaryTokens;
  });

  it('starts primary and both line-item requests concurrently', async () => {
    let primaryFinished = false;
    let detailsStartedBeforePrimary = 0;
    const post = jest.fn(async (_path: string, payload: any) => {
      const prompt = String(payload.messages[0].content[0].text);
      const isSales = prompt.includes('sales/purchase settlement detail');
      const isFees = prompt.includes('deduction/fee detail table');

      if (isSales || isFees) {
        if (!primaryFinished) detailsStartedBeforePrimary += 1;
        return {
          data: {
            choices: [
              { message: { content: JSON.stringify({ lineItems: [] }) } },
            ],
          },
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
      primaryFinished = true;
      return {
        data: {
          choices: [
            { message: { content: JSON.stringify({ metadata, fields: {} }) } },
          ],
        },
      };
    });
    const create = jest
      .spyOn(axios, 'create')
      .mockReturnValue({ post } as never);
    const originalBaseUrl = process.env.VISION_LLM_BASE_URL;
    const originalApiKey = process.env.VISION_LLM_API_KEY;
    process.env.VISION_LLM_BASE_URL = 'https://example.test/v1';
    process.env.VISION_LLM_API_KEY = 'test-key';

    try {
      const service = new VisionExtractionService();
      await service.extractFromImages('bill.pdf', [Buffer.from('image')]);
      expect(detailsStartedBeforePrimary).toBe(2);
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
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    lineItems: [
                      {
                        section: 'sales',
                        label: 'total',
                        rowType: 'total',
                        sequence: 1,
                        values: { amount: 100 },
                        rawText: 'total 100',
                        page: 1,
                        confidence: 0.99,
                      },
                    ],
                  }),
                },
              },
            ],
          },
        };
      }
      if (prompt.includes('deduction/fee detail table')) {
        return {
          data: {
            choices: [
              { message: { content: JSON.stringify({ lineItems: [] }) } },
            ],
          },
        };
      }
      return {
        data: {
          choices: [
            { message: { content: JSON.stringify({ metadata, fields: {} }) } },
          ],
        },
      };
    });
    const create = jest
      .spyOn(axios, 'create')
      .mockReturnValue({ post } as never);
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
      const result = await service.extractFromImages('bill.pdf', [
        Buffer.from('image'),
      ]);
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
          choices: [
            {
              message: {
                content: `\`\`\`json\n${JSON.stringify(output)}\n\`\`\``,
              },
            },
          ],
        },
      };
    });
    const create = jest
      .spyOn(axios, 'create')
      .mockReturnValue({ post } as never);
    const originalBaseUrl = process.env.VISION_LLM_BASE_URL;
    const originalApiKey = process.env.VISION_LLM_API_KEY;
    process.env.VISION_LLM_BASE_URL = 'https://example.test/v1';
    process.env.VISION_LLM_API_KEY = 'test-key';

    try {
      const service = new VisionExtractionService();
      const result = await service.extractFromImages('bill.pdf', [
        Buffer.from('image'),
      ]);
      expect(result.metadata).toEqual(metadata);
    } finally {
      create.mockRestore();
      process.env.VISION_LLM_BASE_URL = originalBaseUrl;
      process.env.VISION_LLM_API_KEY = originalApiKey;
    }
  });

  it('rejects an invalid primary response even when detail requests succeed', async () => {
    const post = jest.fn(async (_path: string, payload: any) => {
      const prompt = String(payload.messages[0].content[0].text);
      const isDetail =
        prompt.includes('sales/purchase settlement detail') ||
        prompt.includes('deduction/fee detail table');
      return {
        data: {
          choices: [
            {
              message: {
                content: isDetail
                  ? JSON.stringify({ lineItems: [] })
                  : 'not-json',
              },
            },
          ],
        },
      };
    });
    const create = jest
      .spyOn(axios, 'create')
      .mockReturnValue({ post } as never);
    const originalBaseUrl = process.env.VISION_LLM_BASE_URL;
    const originalApiKey = process.env.VISION_LLM_API_KEY;
    process.env.VISION_LLM_BASE_URL = 'https://example.test/v1';
    process.env.VISION_LLM_API_KEY = 'test-key';

    try {
      const service = new VisionExtractionService();
      await expect(
        service.extractFromImages('bill.pdf', [Buffer.from('image')]),
      ).rejects.toThrow();
      expect(post).toHaveBeenCalledTimes(4);
    } finally {
      create.mockRestore();
      process.env.VISION_LLM_BASE_URL = originalBaseUrl;
      process.env.VISION_LLM_API_KEY = originalApiKey;
    }
  });

  it('preserves arbitrary sales and adjustment detail columns', async () => {
    const service = new VisionExtractionService() as any;
    service.client.post = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  rows: [
                    {
                      section: '销售对账明细',
                      label: '女装',
                      rowType: 'detail',
                      sequence: 1,
                      values: {
                        净销售额: 123.45,
                        联营扣率: '15%',
                        自定义返利: 2.5,
                      },
                      rawText: '女装 123.45 15% 2.5',
                      page: 2,
                      confidence: 0.96,
                    },
                  ],
                }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  rows: [
                    {
                      section: 'B.调整项（后附明细）',
                      label: '跨期调整',
                      rowType: 'detail',
                      sequence: 1,
                      values: {
                        调整原因: '上月差异',
                        金额: 88.8,
                        税率: '13%',
                      },
                      rawText: '跨期调整 上月差异 88.80 13%',
                      page: 3,
                      confidence: 0.94,
                    },
                  ],
                }),
              },
            },
          ],
        },
      });

    const sales = await service.extractCompactSalesLineItems([
      Buffer.from('image'),
    ]);
    const adjustments = await service.extractCompactFeeLineItems([
      Buffer.from('image'),
    ]);

    expect(sales).toEqual([
      expect.objectContaining({
        section: '销售对账明细',
        page: 2,
        values: {
          净销售额: 123.45,
          联营扣率: '15%',
          自定义返利: 2.5,
        },
      }),
    ]);
    expect(adjustments).toEqual([
      expect.objectContaining({
        section: 'B.调整项（后附明细）',
        page: 3,
        values: { 调整原因: '上月差异', 金额: 88.8, 税率: '13%' },
      }),
    ]);
  });

  it('expands compact sales rows into the stable line-item schema', async () => {
    const post = jest.fn(async (_path: string, payload: any) => {
      const prompt = String(payload.messages[0].content[0].text);
      if (prompt.includes('compact rows')) {
        return {
          data: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    rows: [
                      {
                        label: 'rate -15',
                        rowType: 'detail',
                        values: [
                          'rate -15',
                          -15,
                          131,
                          49847,
                          7477.05,
                          1.13,
                          42369.95,
                        ],
                      },
                    ],
                  }),
                },
              },
            ],
          },
        };
      }
      if (prompt.includes('deduction/fee detail table')) {
        return {
          data: {
            choices: [
              { message: { content: JSON.stringify({ lineItems: [] }) } },
            ],
          },
        };
      }
      return {
        data: {
          choices: [
            { message: { content: JSON.stringify({ metadata, fields: {} }) } },
          ],
        },
      };
    });
    const create = jest
      .spyOn(axios, 'create')
      .mockReturnValue({ post } as never);
    const originalBaseUrl = process.env.VISION_LLM_BASE_URL;
    const originalApiKey = process.env.VISION_LLM_API_KEY;
    process.env.VISION_LLM_BASE_URL = 'https://example.test/v1';
    process.env.VISION_LLM_API_KEY = 'test-key';

    try {
      const service = new VisionExtractionService();
      const result = await service.extractFromImages('bill.pdf', [
        Buffer.from('image'),
      ]);
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
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    m: [
                      '百联滨江购物中心',
                      '阿迪达斯',
                      '086203',
                      '2026-05',
                      'standard',
                    ],
                    p: ['结算期：2026-05', 1, 'month_only'],
                    f: {
                      salesAmount: [69843, '销售金额 69843', 1, 0.98],
                      activityFee: [5650.47, '扣款费用合计 5650.47', 1, 0.98],
                      invoiceAmount: [60566.31, '发票金额 60566.31', 1, 0.98],
                      deductionTotal: [
                        5650.47,
                        '扣款费用合计 5650.47',
                        1,
                        0.98,
                      ],
                      settlementAmount: [
                        54915.84,
                        '实付金额 54915.84',
                        1,
                        0.98,
                      ],
                    },
                    a: [
                      [
                        '品牌商户',
                        '上海锐力',
                        '品牌商户 上海锐力',
                        1,
                        0.96,
                        'header',
                        'brandMerchantName',
                      ],
                    ],
                  }),
                },
              },
            ],
          },
        };
      }
      if (prompt.includes('compact rows')) {
        return { data: { choices: [{ message: { content: '{"rows":[]}' } }] } };
      }
      return {
        data: { choices: [{ message: { content: '{"lineItems":[]}' } }] },
      };
    });
    const create = jest
      .spyOn(axios, 'create')
      .mockReturnValue({ post } as never);
    const originalBaseUrl = process.env.VISION_LLM_BASE_URL;
    const originalApiKey = process.env.VISION_LLM_API_KEY;
    process.env.VISION_LLM_BASE_URL = 'https://example.test/v1';
    process.env.VISION_LLM_API_KEY = 'test-key';

    try {
      const service = new VisionExtractionService();
      const result = await service.extractFromImages('bill.pdf', [
        Buffer.from('image'),
      ]);
      expect(result.metadata).toEqual(
        expect.objectContaining({
          mallName: '百联滨江购物中心',
          storeName: '阿迪达斯',
          storeCode: '086203',
          periodStart: '2026-05-01',
          periodEnd: '2026-05-31',
        }),
      );
      expect(result.evidence).toEqual(
        expect.objectContaining({
          salesAmount: expect.objectContaining({ value: 69843 }),
          activityFee: expect.objectContaining({ value: null }),
          settlementAmount: expect.objectContaining({ value: 54915.84 }),
        }),
      );
      expect(result.additionalFields).toEqual([
        expect.objectContaining({
          suggestedTarget: 'brandMerchantName',
          value: '上海锐力',
        }),
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
        return {
          data: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    rows: [
                      ['支付手续费-0701', 'detail', '0701', 13.98, 'B'],
                      ['B小计', 'subtotal', null, 2150.97, 'B'],
                      ['合计', 'total', null, 5650.47, null],
                    ],
                  }),
                },
              },
            ],
          },
        };
      }
      if (prompt.includes('compact rows')) {
        return { data: { choices: [{ message: { content: '{"rows":[]}' } }] } };
      }
      return {
        data: {
          choices: [
            { message: { content: JSON.stringify({ metadata, fields: {} }) } },
          ],
        },
      };
    });
    const create = jest
      .spyOn(axios, 'create')
      .mockReturnValue({ post } as never);
    const originalBaseUrl = process.env.VISION_LLM_BASE_URL;
    const originalApiKey = process.env.VISION_LLM_API_KEY;
    process.env.VISION_LLM_BASE_URL = 'https://example.test/v1';
    process.env.VISION_LLM_API_KEY = 'test-key';

    try {
      const service = new VisionExtractionService();
      const result = await service.extractFromImages('bill.pdf', [
        Buffer.from('image'),
      ]);
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

    expect(result.metadata).toEqual(
      expect.objectContaining({
        mallName: '',
        storeName: '',
        storeCode: '',
      }),
    );
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
            choices: [
              {
                message: {
                  content:
                    primaryAttempts === 1
                      ? 'null'
                      : JSON.stringify({ metadata, fields: {} }),
                },
              },
            ],
          },
        };
      }
      if (prompt.includes('compact rows')) {
        return { data: { choices: [{ message: { content: '{"rows":[]}' } }] } };
      }
      return {
        data: { choices: [{ message: { content: '{"lineItems":[]}' } }] },
      };
    });
    const create = jest
      .spyOn(axios, 'create')
      .mockReturnValue({ post } as never);
    const originalBaseUrl = process.env.VISION_LLM_BASE_URL;
    const originalApiKey = process.env.VISION_LLM_API_KEY;
    process.env.VISION_LLM_BASE_URL = 'https://example.test/v1';
    process.env.VISION_LLM_API_KEY = 'test-key';

    try {
      const service = new VisionExtractionService();
      const result = await service.extractFromImages('bill.pdf', [
        Buffer.from('image'),
      ]);
      expect(primaryAttempts).toBe(2);
      expect(result.metadata).toEqual(metadata);
    } finally {
      create.mockRestore();
      process.env.VISION_LLM_BASE_URL = originalBaseUrl;
      process.env.VISION_LLM_API_KEY = originalApiKey;
    }
  });

  it('retries a length-stopped primary response with a shorter stricter prompt', async () => {
    let primaryAttempts = 0;
    const primaryPrompts: string[] = [];
    const primaryTokenLimits: number[] = [];
    const post = jest.fn(async (_path: string, payload: any) => {
      const prompt = String(payload.messages[0].content[0].text);
      if (prompt.includes('sales/purchase settlement detail')) {
        return { data: { choices: [{ message: { content: '{"rows":[]}' } }] } };
      }
      if (prompt.includes('deduction/fee detail')) {
        return { data: { choices: [{ message: { content: '{"rows":[]}' } }] } };
      }
      primaryAttempts += 1;
      primaryPrompts.push(prompt);
      primaryTokenLimits.push(payload.max_completion_tokens);
      return {
        data: {
          choices: [
            {
              finish_reason: primaryAttempts === 1 ? 'length' : 'stop',
              message: { content: JSON.stringify({ metadata, fields: {} }) },
            },
          ],
        },
      };
    });
    const create = jest
      .spyOn(axios, 'create')
      .mockReturnValue({ post } as never);
    const originalBaseUrl = process.env.VISION_LLM_BASE_URL;
    const originalApiKey = process.env.VISION_LLM_API_KEY;
    process.env.VISION_LLM_BASE_URL = 'https://example.test/v1';
    process.env.VISION_LLM_API_KEY = 'test-key';

    try {
      const service = new VisionExtractionService();
      const result = await service.extractFromImages('bill.pdf', [
        Buffer.from('image'),
      ]);
      expect(result.metadata).toEqual(metadata);
      expect(primaryAttempts).toBe(2);
      expect(primaryPrompts[1]).toContain('COMPLETE compact primary bill JSON');
      expect(primaryPrompts[1].length).toBeLessThan(primaryPrompts[0].length);
      expect(primaryTokenLimits[1]).toBeGreaterThan(primaryTokenLimits[0]);
    } finally {
      create.mockRestore();
      process.env.VISION_LLM_BASE_URL = originalBaseUrl;
      process.env.VISION_LLM_API_KEY = originalApiKey;
    }
  });

  it('does not accept a parseable primary object when both responses stop for length', async () => {
    const post = jest.fn(async (_path: string, payload: any) => {
      const prompt = String(payload.messages[0].content[0].text);
      const isDetail =
        prompt.includes('sales/purchase settlement detail') ||
        prompt.includes('deduction/fee detail table');
      return {
        data: {
          choices: [
            isDetail
              ? { message: { content: JSON.stringify({ lineItems: [] }) } }
              : {
                  finish_reason: 'length',
                  message: {
                    content: JSON.stringify({ metadata, fields: {} }),
                  },
                },
          ],
        },
      };
    });
    const create = jest
      .spyOn(axios, 'create')
      .mockReturnValue({ post } as never);
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const originalBaseUrl = process.env.VISION_LLM_BASE_URL;
    const originalApiKey = process.env.VISION_LLM_API_KEY;
    process.env.VISION_LLM_BASE_URL = 'https://example.test/v1';
    process.env.VISION_LLM_API_KEY = 'test-key';

    try {
      const service = new VisionExtractionService();
      await expect(
        service.extractFromImages('bill.pdf', [Buffer.from('image')]),
      ).rejects.toThrow('视觉模型返回格式错误');
      expect(post).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
      create.mockRestore();
      process.env.VISION_LLM_BASE_URL = originalBaseUrl;
      process.env.VISION_LLM_API_KEY = originalApiKey;
    }
  });

  it('parses a JSON object with surrounding text and repairs only trailing closers after retry', async () => {
    let primaryAttempts = 0;
    const post = jest.fn(async (_path: string, payload: any) => {
      const prompt = String(payload.messages[0].content[0].text);
      if (prompt.includes('sales/purchase settlement detail')) {
        return { data: { choices: [{ message: { content: '{"rows":[]}' } }] } };
      }
      if (prompt.includes('deduction/fee detail')) {
        return { data: { choices: [{ message: { content: '{"rows":[]}' } }] } };
      }
      primaryAttempts += 1;
      const valid = JSON.stringify({ metadata, fields: {} });
      return {
        data: {
          choices: [
            {
              message: {
                content:
                  primaryAttempts === 1
                    ? `${valid.slice(0, -1)}`
                    : `result follows\n${valid.slice(0, -1)}`,
              },
            },
          ],
        },
      };
    });
    const create = jest
      .spyOn(axios, 'create')
      .mockReturnValue({ post } as never);
    const originalBaseUrl = process.env.VISION_LLM_BASE_URL;
    const originalApiKey = process.env.VISION_LLM_API_KEY;
    process.env.VISION_LLM_BASE_URL = 'https://example.test/v1';
    process.env.VISION_LLM_API_KEY = 'test-key';

    try {
      const service = new VisionExtractionService();
      const result = await service.extractFromImages('bill.pdf', [
        Buffer.from('image'),
      ]);
      expect(result.metadata).toEqual(metadata);
      expect(primaryAttempts).toBe(2);
    } finally {
      create.mockRestore();
      process.env.VISION_LLM_BASE_URL = originalBaseUrl;
      process.env.VISION_LLM_API_KEY = originalApiKey;
    }
  });

  it('retries malformed sales and fee detail JSON before returning line items', async () => {
    let salesAttempts = 0;
    let feeAttempts = 0;
    const post = jest.fn(async (_path: string, payload: any) => {
      const prompt = String(payload.messages[0].content[0].text);
      if (prompt.includes('sales/purchase settlement detail')) {
        salesAttempts += 1;
        return {
          data: {
            choices: [
              {
                message: {
                  content:
                    salesAttempts === 1
                      ? '{"rows":['
                      : JSON.stringify({
                          rows: [
                            {
                              label: '销售合计',
                              rowType: 'total',
                              values: [
                                '合计',
                                null,
                                null,
                                100,
                                null,
                                null,
                                null,
                              ],
                            },
                          ],
                        }),
                },
              },
            ],
          },
        };
      }
      if (prompt.includes('deduction/fee detail')) {
        feeAttempts += 1;
        return {
          data: {
            choices: [
              {
                message: {
                  content:
                    feeAttempts === 1
                      ? ''
                      : JSON.stringify({
                          rows: [['B小计', 'subtotal', null, 10, 'B']],
                        }),
                },
              },
            ],
          },
        };
      }
      return {
        data: {
          choices: [
            { message: { content: JSON.stringify({ metadata, fields: {} }) } },
          ],
        },
      };
    });
    const create = jest
      .spyOn(axios, 'create')
      .mockReturnValue({ post } as never);
    const originalBaseUrl = process.env.VISION_LLM_BASE_URL;
    const originalApiKey = process.env.VISION_LLM_API_KEY;
    process.env.VISION_LLM_BASE_URL = 'https://example.test/v1';
    process.env.VISION_LLM_API_KEY = 'test-key';

    try {
      const service = new VisionExtractionService();
      const result = await service.extractFromImages('bill.pdf', [
        Buffer.from('image'),
      ]);
      expect(salesAttempts).toBe(2);
      expect(feeAttempts).toBe(2);
      expect(result.lineItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: '销售合计' }),
          expect.objectContaining({ label: 'B小计' }),
        ]),
      );
      expect(result.warnings).not.toEqual(
        expect.arrayContaining([expect.stringContaining('明细识别失败')]),
      );
    } finally {
      create.mockRestore();
      process.env.VISION_LLM_BASE_URL = originalBaseUrl;
      process.env.VISION_LLM_API_KEY = originalApiKey;
    }
  });

  it('returns visible warnings instead of silently dropping malformed detail responses', async () => {
    const post = jest.fn(async (_path: string, payload: any) => {
      const prompt = String(payload.messages[0].content[0].text);
      if (
        prompt.includes('sales/purchase settlement detail') ||
        prompt.includes('deduction/fee detail')
      ) {
        return { data: { choices: [{ message: { content: '{"rows":[' } }] } };
      }
      return {
        data: {
          choices: [
            { message: { content: JSON.stringify({ metadata, fields: {} }) } },
          ],
        },
      };
    });
    const create = jest
      .spyOn(axios, 'create')
      .mockReturnValue({ post } as never);
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const originalBaseUrl = process.env.VISION_LLM_BASE_URL;
    const originalApiKey = process.env.VISION_LLM_API_KEY;
    process.env.VISION_LLM_BASE_URL = 'https://example.test/v1';
    process.env.VISION_LLM_API_KEY = 'test-key';

    try {
      const service = new VisionExtractionService();
      const result = await service.extractFromImages('bill.pdf', [
        Buffer.from('image'),
      ]);
      expect(result.lineItems).toEqual([]);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('销售明细识别失败'),
          expect.stringContaining('费用明细识别失败'),
        ]),
      );
    } finally {
      warn.mockRestore();
      create.mockRestore();
      process.env.VISION_LLM_BASE_URL = originalBaseUrl;
      process.env.VISION_LLM_API_KEY = originalApiKey;
    }
  });

  it.each([
    ['2026/05/01-2026/05/31', '2026/05/01-2026/05/31'],
    ['2026-05-01~2026-05-31', '2026-05-01~2026-05-31'],
    ['2026-05-01～2026-05-31', ''],
  ])(
    'splits a printed settlement period range %s',
    (periodStart, periodEnd) => {
      const service = new VisionExtractionService();
      const result = service.normalizeModelResult({
        metadata: { ...metadata, periodStart, periodEnd },
        fields: {},
      });

      expect(result.metadata).toEqual(
        expect.objectContaining({
          periodStart: '2026-05-01',
          periodEnd: '2026-05-31',
        }),
      );
    },
  );

  it('rejects a contract-validity range copied into the settlement period', () => {
    const service = new VisionExtractionService();
    const result = service.normalizeModelResult(
      {
        metadata: {
          ...metadata,
          periodStart: '2020/07/01-2027/03/31',
          periodEnd: '',
        },
        periodEvidence: {
          rawText: '合同有效期 2020/07/01-2027/03/31',
          page: 1,
          kind: 'explicit_range',
        },
        fields: {},
        additionalFields: [
          {
            label: '合同有效期',
            value: '2020/07/01-2027/03/31',
            rawText: '合同有效期 2020/07/01-2027/03/31',
            page: 1,
            confidence: 0.98,
            group: 'header',
            suggestedTarget: 'settlementDate',
          },
        ],
      },
      'SHNKA2结算单-202605.pdf',
    );

    expect(result.metadata).toEqual(
      expect.objectContaining({
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
      }),
    );
    expect(result.periodEvidence).toEqual(
      expect.objectContaining({ kind: 'inferred', rawText: '文件名 202605' }),
    );
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('合同有效期')]),
    );
  });

  it('removes unsafe semantic targets while preserving the original dynamic fields', () => {
    const service = new VisionExtractionService();
    const result = service.normalizeModelResult({
      metadata,
      fields: {},
      additionalFields: [
        {
          label: '合同有效期',
          value: '2020/07/01-2027/03/31',
          rawText: '合同有效期 2020/07/01-2027/03/31',
          page: 1,
          confidence: 0.98,
          group: 'header',
          suggestedTarget: 'settlementDate',
        },
        {
          label: '结算扣率',
          value: 17,
          rawText: '结算扣率 17%',
          page: 1,
          confidence: 0.98,
          group: 'summary',
          suggestedTarget: 'businessMode',
        },
      ],
    });

    expect(result.additionalFields).toEqual([
      expect.objectContaining({ label: '合同有效期', suggestedTarget: null }),
      expect.objectContaining({ label: '结算扣率', suggestedTarget: null }),
    ]);
  });
});
