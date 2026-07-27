import { Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { OcrExtractionResult, OcrPageResult } from '@shared/reconciliation';
import { extractOcrKeyFields, normalizeOcrBox } from '../recognition-comparison';

type WorkerResponse = {
  id: string;
  ok: boolean;
  pages?: OcrPageResult[];
  error?: string;
};

type PendingRequest = {
  resolve: (pages: OcrPageResult[]) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export function parseOcrWorkerResponse(line: string): WorkerResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const candidate = parsed as Partial<WorkerResponse>;
  if (typeof candidate.id !== 'string' || typeof candidate.ok !== 'boolean') return null;
  if (candidate.ok && !Array.isArray(candidate.pages)) return null;
  return candidate as WorkerResponse;
}

@Injectable()
export class PaddleOcrService implements OnModuleDestroy {
  private worker: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingRequest>();

  async extractFromImages(images: Buffer[]): Promise<OcrExtractionResult> {
    if (!images.length || images.length > 2 || images.some((image) => image.length > 10 * 1024 * 1024)) {
      throw new ServiceUnavailableException('OCR页面数量或大小超出限制。');
    }
    const startedAt = Date.now();
    const directory = await mkdtemp(join(tmpdir(), 'settlement-ocr-'));
    try {
      const paths = await Promise.all(images.map(async (image, index) => {
        const path = join(directory, `page-${index + 1}.png`);
        await writeFile(path, image);
        return path;
      }));
      const pages = await this.request(paths);
      return {
        engine: 'paddleocr',
        device: (process.env.PADDLEOCR_DEVICE ?? 'cpu').toLowerCase() === 'gpu' ? 'gpu' : 'cpu',
        durationMs: Date.now() - startedAt,
        pages,
        fields: extractOcrKeyFields(pages),
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  onModuleDestroy() {
    this.worker?.kill();
    this.worker = null;
  }

  private request(images: string[]): Promise<OcrPageResult[]> {
    const worker = this.ensureWorker();
    const id = randomUUID();
    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error('PaddleOCR识别超时。'));
      }, 180_000);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timeout });
      worker.stdin.write(`${JSON.stringify({ id, images })}\n`);
    });
  }

  private ensureWorker() {
    if (this.worker && !this.worker.killed) return this.worker;
    const python = resolve(process.env.PADDLEOCR_PYTHON ?? '.runtime/paddleocr/Scripts/python.exe');
    const script = resolve('tools/paddleocr/worker.py');
    const worker = spawn(python, [script], {
      cwd: process.cwd(),
      env: { ...process.env, PADDLEOCR_DEVICE: process.env.PADDLEOCR_DEVICE ?? 'cpu' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    createInterface({ input: worker.stdout }).on('line', (line) => this.handleLine(line));
    worker.on('error', (error) => this.failAll(error));
    worker.on('exit', () => {
      this.worker = null;
      this.failAll(new Error('PaddleOCR工作进程已退出。'));
    });
    this.worker = worker;
    return worker;
  }

  private handleLine(line: string) {
    const response = parseOcrWorkerResponse(line);
    if (!response) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(response.id);
    if (!response.ok) {
      pending.reject(new Error(response.error || 'PaddleOCR识别失败。'));
      return;
    }
    const pages = (response.pages ?? []).map((page) => ({
      page: page.page,
      width: page.width,
      height: page.height,
      boxes: page.boxes.map(normalizeOcrBox).filter((box): box is NonNullable<typeof box> => box !== null),
    }));
    pending.resolve(pages);
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
