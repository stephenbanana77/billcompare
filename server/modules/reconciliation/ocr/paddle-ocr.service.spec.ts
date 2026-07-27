import { parseOcrWorkerResponse } from './paddle-ocr.service';

describe('PaddleOcrService protocol', () => {
  it('accepts a successful response with coordinate evidence', () => {
    expect(parseOcrWorkerResponse(JSON.stringify({
      id: 'job-1',
      ok: true,
      pages: [{
        page: 1,
        width: 100,
        height: 200,
        boxes: [{ page: 1, text: '销售金额', score: 0.99, polygon: [[1, 2], [9, 2], [9, 5], [1, 5]] }],
      }],
    }))).toMatchObject({ id: 'job-1', ok: true, pages: [{ boxes: [{ text: '销售金额' }] }] });
  });

  it('ignores non-JSON model log lines', () => {
    expect(parseOcrWorkerResponse('Creating model PP-OCRv6')).toBeNull();
  });

  it('rejects malformed successful responses', () => {
    expect(parseOcrWorkerResponse('{"id":"job-1","ok":true,"pages":"bad"}')).toBeNull();
  });
});
