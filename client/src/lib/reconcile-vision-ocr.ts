import type {
  OcrExtractionResult,
  OcrFieldEvidence,
  VisionExtractionResult,
} from '@shared/reconciliation';

function trustedLabeledValue(
  field: OcrFieldEvidence | undefined,
  label: RegExp,
) {
  if (!field || field.evidence.score < 0.8 || !label.test(field.label)) return '';
  return field.value.trim();
}

/**
 * Resolve only explicit identity labels. OCR remains evidence; it never
 * replaces amounts, formulas, or the structured vision result.
 */
export function reconcileVisionMetadataWithOcr(
  extraction: VisionExtractionResult,
  ocr: OcrExtractionResult | null,
): VisionExtractionResult {
  if (!ocr) return extraction;

  const mallName =
    extraction.metadata.mallName || ocr.fields.mallName?.value.trim() || '';
  const storeName =
    trustedLabeledValue(ocr.fields.brandName, /^(品牌|专柜名称)[：:]/) ||
    extraction.metadata.storeName;
  const storeCode =
    trustedLabeledValue(
      ocr.fields.storeCode,
      /^(代码|柜号|门店编码|专柜编码)[：:]/,
    ) || extraction.metadata.storeCode;
  const corrected =
    mallName !== extraction.metadata.mallName ||
    storeName !== extraction.metadata.storeName ||
    storeCode !== extraction.metadata.storeCode;
  if (!corrected) return extraction;

  const metadata = {
    ...extraction.metadata,
    mallName,
    storeName,
    storeCode,
  };
  const dynamicFields = extraction.dynamicFields?.map((field) => {
    if (field.role === 'mallName') return { ...field, value: mallName };
    if (field.role === 'storeName') return { ...field, value: storeName };
    if (field.role === 'storeCode') return { ...field, value: storeCode };
    return field;
  });
  const warning =
    'OCR 已按单据中的“专柜名称／专柜编码”标签纠正门店信息，请人工复核。';
  return {
    ...extraction,
    metadata,
    ...(dynamicFields ? { dynamicFields } : {}),
    warnings: extraction.warnings.includes(warning)
      ? extraction.warnings
      : [...extraction.warnings, warning],
  };
}
