import type {
  OcrExtractionResult,
  VisionExtractionResult,
} from '@shared/reconciliation';
import { reconciliationApi } from '@/api';
import { addOcrLineItemFallback } from '@/lib/ocr-line-item-fallback';
import { reconcileVisionMetadataWithOcr } from '@/lib/reconcile-vision-ocr';
import { renderPdfPagesForVision } from '@/lib/workbook';

export type SettlementPdfRecognitionStage =
  | 'rendering'
  | 'recognizing'
  | 'complete';

export type SettlementPdfRecognitionResult = {
  sourceKind: 'pdf' | 'images';
  pages: File[];
  extraction: VisionExtractionResult;
  ocr: OcrExtractionResult | null;
  ocrWarning: string | null;
};

const supportedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maxImagePages = 2;
const maxImageLongEdge = 2000;
const jpegQuality = 0.86;

export const isSettlementPdfFile = (file: File): boolean =>
  file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

export const isSettlementImageFile = (file: File): boolean =>
  supportedImageTypes.has(file.type) ||
  /\.(jpe?g|png|webp)$/i.test(file.name);

const displayNameFor = (files: File[]): string =>
  files.length === 1
    ? files[0].name
    : `${files[0].name.replace(/\.[^.]+$/, '')}等${files.length}张照片`;

const withoutExtension = (name: string): string =>
  name.replace(/\.[^.]+$/, '') || 'settlement-photo';

async function compressImagePage(file: File, index: number): Promise<File> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, {
      imageOrientation: 'from-image',
    } as ImageBitmapOptions);
  } catch {
    throw new Error('照片无法读取，请重新上传清晰的 JPG、PNG 或 WebP 图片。');
  }

  const scale = Math.min(
    1,
    maxImageLongEdge / Math.max(bitmap.width, bitmap.height),
  );
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    throw new Error('浏览器无法处理照片，请换一张图片后重试。');
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', jpegQuality);
  });
  if (!blob) {
    throw new Error('照片压缩失败，请重新上传清晰图片。');
  }

  return new File([blob], `${withoutExtension(file.name)}-page-${index + 1}.jpg`, {
    type: 'image/jpeg',
  });
}

async function normalizeImagePages(files: File[]): Promise<File[]> {
  if (files.length > maxImagePages) {
    throw new Error('当前最多支持一次上传 2 张账单照片，请按顺序选择关键页面。');
  }
  return Promise.all(files.map((file, index) => compressImagePage(file, index)));
}

/**
 * Browser-side entry point for settlement bill recognition.
 * PDF files are rendered into page images; photos are compressed first and
 * then sent through the same OCR and vision model pipeline.
 */
export async function recognizeSettlementBill(
  files: File[],
  onStage?: (stage: SettlementPdfRecognitionStage) => void,
): Promise<SettlementPdfRecognitionResult> {
  const selected = files.filter(Boolean);
  const [firstFile] = selected;
  if (!firstFile) throw new Error('请上传商场结算单文件。');

  const pdfFiles = selected.filter(isSettlementPdfFile);
  const imageFiles = selected.filter(isSettlementImageFile);
  if (pdfFiles.length && selected.length > 1) {
    throw new Error('PDF 账单请单独上传；多页照片请只选择 JPG、PNG 或 WebP。');
  }
  if (pdfFiles.length && imageFiles.length) {
    throw new Error('请不要混合上传 PDF 和照片。');
  }
  if (!pdfFiles.length && imageFiles.length !== selected.length) {
    throw new Error('请上传 PDF、JPG、PNG 或 WebP 格式的商场结算单。');
  }

  const sourceKind = pdfFiles.length ? 'pdf' : 'images';
  onStage?.('rendering');
  const pages = pdfFiles.length
    ? await renderPdfPagesForVision(firstFile)
    : await normalizeImagePages(selected);

  onStage?.('recognizing');
  const [visionAttempt, ocrAttempt] = await Promise.allSettled([
    reconciliationApi.extractVisionBill(displayNameFor(selected), pages),
    reconciliationApi.extractOcrBill(pages),
  ]);

  if (visionAttempt.status === 'rejected') {
    const message =
      visionAttempt.reason instanceof Error
        ? visionAttempt.reason.message
        : String(visionAttempt.reason ?? '');
    if (/socket hang up|timeout|ECONNRESET|Network Error/i.test(message)) {
      throw new Error(
        '视觉模型处理超时，请重新拍摄更清晰的单页照片，或改用 PDF 后再试。',
      );
    }
    throw visionAttempt.reason;
  }

  onStage?.('complete');
  const ocr = ocrAttempt.status === 'fulfilled' ? ocrAttempt.value : null;
  const extraction = addOcrLineItemFallback(
    reconcileVisionMetadataWithOcr(visionAttempt.value, ocr),
    ocr,
  );
  return {
    sourceKind,
    pages,
    extraction,
    ocr,
    ocrWarning:
      ocrAttempt.status === 'rejected'
        ? 'OCR 校验未完成，识别结果请人工复核后再继续。'
        : null,
  };
}

export async function recognizeSettlementPdf(
  file: File,
  onStage?: (stage: SettlementPdfRecognitionStage) => void,
): Promise<SettlementPdfRecognitionResult> {
  return recognizeSettlementBill([file], onStage);
}
