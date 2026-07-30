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
  pages: File[];
  extraction: VisionExtractionResult;
  ocr: OcrExtractionResult | null;
  ocrWarning: string | null;
};

/**
 * The single browser-side entry point for settlement PDF recognition.
 * Vision owns the structured business result; OCR is independent evidence and
 * must never be promoted to a fabricated settlement result when vision fails.
 */
export async function recognizeSettlementPdf(
  file: File,
  onStage?: (stage: SettlementPdfRecognitionStage) => void,
): Promise<SettlementPdfRecognitionResult> {
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    throw new Error('请上传 PDF 格式的商场结算单。');
  }

  onStage?.('rendering');
  const pages = await renderPdfPagesForVision(file);
  onStage?.('recognizing');
  const [visionAttempt, ocrAttempt] = await Promise.allSettled([
    reconciliationApi.extractVisionBill(file.name, pages),
    reconciliationApi.extractOcrBill(pages),
  ]);

  if (visionAttempt.status === 'rejected') {
    throw visionAttempt.reason;
  }

  onStage?.('complete');
  const ocr = ocrAttempt.status === 'fulfilled' ? ocrAttempt.value : null;
  const extraction = addOcrLineItemFallback(
    reconcileVisionMetadataWithOcr(visionAttempt.value, ocr),
    ocr,
  );
  return {
    pages,
    extraction,
    ocr,
    ocrWarning:
      ocrAttempt.status === 'rejected'
        ? 'OCR 校验未完成，识别结果请人工复核后再继续。'
        : null,
  };
}
