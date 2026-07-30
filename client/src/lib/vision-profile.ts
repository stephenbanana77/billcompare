import type { VisionExtractionResult } from '@shared/reconciliation';
import type { FileProfile, WorkbookRow } from './workbook';

/** Build the row-shaped compatibility view consumed by task field mapping. */
export function profileFromVisionExtraction(
  result: VisionExtractionResult,
): FileProfile {
  const headers = [...result.headers];
  const row: WorkbookRow = { ...(result.rows[0] ?? {}) };
  const put = (
    label: string,
    value: string | number | boolean | null | undefined,
    overwrite = false,
  ) => {
    const normalizedLabel = label.trim();
    if (!normalizedLabel) return;
    if (!headers.includes(normalizedLabel)) headers.push(normalizedLabel);
    if (
      overwrite ||
      row[normalizedLabel] === '' ||
      row[normalizedLabel] === null ||
      row[normalizedLabel] === undefined
    ) {
      row[normalizedLabel] = value ?? '';
    }
  };

  // Recognition keeps metadata and arbitrary evidence separate. Merge them
  // only for the import mapper so normalized dates and mall-specific summaries
  // are not lost while the complete extraction remains the source of truth.
  put('商场名称', result.metadata.mallName, true);
  put('门店名称', result.metadata.storeName, true);
  put('门店编码', result.metadata.storeCode, true);
  put('账期开始', result.metadata.periodStart, true);
  put('账期结束', result.metadata.periodEnd, true);
  put('账单类型', result.metadata.billType, true);

  for (const field of result.dynamicFields ?? []) {
    if (field.group !== 'detail') put(field.label, field.value);
  }
  for (const field of result.additionalFields ?? []) {
    put(field.label, field.value);
  }

  return {
    fileName: result.fileName,
    sheetName: '视觉识别结果',
    headers,
    rows: [row],
    sourceType: 'vision_llm',
  };
}
