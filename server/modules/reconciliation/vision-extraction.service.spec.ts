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
    process.env.VISION_LLM_BASE_URL = 'https://example.test/v1';
    process.env.VISION_LLM_API_KEY = 'test-key';
    process.env.VISION_LLM_MODEL = 'minimax/minimax-m3';
    const service = new VisionExtractionService();

    await service.extractFromImages('bill.pdf', [Buffer.from('image')]);

    expect(post).toHaveBeenCalledWith(
      '/chat/completions',
      expect.objectContaining({
        model: 'minimax/minimax-m3',
        response_format: { type: 'json_object' },
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    );
    const request = post.mock.calls[0][1];
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
  });
});
