import type {
  OcrExtractionResult,
  OcrTextBox,
  VisionExtractionResult,
  VisionLineItem,
} from '@shared/reconciliation';

type OcrRow = {
  page: number;
  cells: OcrTextBox[];
};

const bounds = (box: OcrTextBox) => {
  const xs = box.polygon.map(([x]) => x);
  const ys = box.polygon.map(([, y]) => y);
  return {
    left: Math.min(...xs),
    centerY: (Math.min(...ys) + Math.max(...ys)) / 2,
    height: Math.max(...ys) - Math.min(...ys),
  };
};

const looksLikeMoney = (value: string) =>
  /^[￥¥]?\s*[-+]?(?:\d{1,3}(?:[,，]\d{3})+|\d+)(?:\.\d+)?$/.test(
    value.trim(),
  );

function splitOcrCell(text: string) {
  const normalized = text.trim();
  const mixed = /^([￥¥]?\s*[-+]?(?:\d{1,3}(?:[,，]\d{3})+|\d+)(?:\.\d+)?)\s+(.+)$/.exec(
    normalized,
  );
  return mixed ? [mixed[1].trim(), mixed[2].trim()] : [normalized];
}

function groupRows(boxes: OcrTextBox[], page: number): OcrRow[] {
  const ordered = [...boxes].sort(
    (left, right) =>
      bounds(left).centerY - bounds(right).centerY ||
      bounds(left).left - bounds(right).left,
  );
  const rows: OcrRow[] = [];
  for (const box of ordered) {
    const boxBounds = bounds(box);
    const current = rows.at(-1);
    const currentCenter = current
      ? current.cells.reduce((sum, cell) => sum + bounds(cell).centerY, 0) /
        current.cells.length
      : 0;
    const tolerance = Math.max(10, boxBounds.height * 0.55);
    if (!current || Math.abs(boxBounds.centerY - currentCenter) > tolerance) {
      rows.push({ page, cells: [box] });
    } else {
      current.cells.push(box);
    }
  }
  return rows.map((row) => ({
    ...row,
    cells: row.cells.sort((left, right) => bounds(left).left - bounds(right).left),
  }));
}

function rowType(label: string): VisionLineItem['rowType'] {
  if (/总计|总额|合计/.test(label)) return 'total';
  if (/小计/.test(label)) return 'subtotal';
  if (/调整/.test(label)) return 'adjustment';
  return 'detail';
}

export function lineItemsFromOcr(
  ocr: OcrExtractionResult,
): VisionLineItem[] {
  const items: VisionLineItem[] = [];
  let sequence = 0;
  for (const page of ocr.pages) {
    let section = 'OCR 复核明细';
    for (const row of groupRows(page.boxes, page.page)) {
      const texts = row.cells
        .flatMap((cell) => splitOcrCell(cell.text))
        .filter(Boolean);
      if (!texts.length) continue;
      const first = texts[0];
      if (/^[A-D][.．]/i.test(first) || /明细|费用回收/.test(first)) {
        section = `OCR 复核 · ${first}`;
      }
      if (texts.length < 2 || !texts.some(looksLikeMoney)) continue;

      const alternatingPairs =
        texts.length % 2 === 0 &&
        texts.every((text, index) =>
          index % 2 === 0 ? !looksLikeMoney(text) : looksLikeMoney(text),
        );
      const confidence = Math.min(...row.cells.map((cell) => cell.score));
      const rawText = texts.join(' | ');
      if (alternatingPairs) {
        for (let index = 0; index < texts.length; index += 2) {
          sequence += 1;
          items.push({
            section,
            label: texts[index],
            rowType: rowType(texts[index]),
            sequence,
            values: { 金额: texts[index + 1] },
            rawText,
            page: row.page,
            confidence,
          });
        }
        continue;
      }

      sequence += 1;
      items.push({
        section,
        label: first,
        rowType: rowType(first),
        sequence,
        values: Object.fromEntries(
          texts.slice(1).map((text, index) => [`原文列${index + 1}`, text]),
        ),
        rawText,
        page: row.page,
        confidence,
      });
    }
  }
  return items;
}

export function addOcrLineItemFallback(
  extraction: VisionExtractionResult,
  ocr: OcrExtractionResult | null,
): VisionExtractionResult {
  if (!ocr || extraction.lineItems.length) return extraction;
  const lineItems = lineItemsFromOcr(ocr);
  if (!lineItems.length) return extraction;
  const warning =
    '视觉明细未返回完整格式，已展示 OCR 原文行作为复核证据，请逐项核对。';
  return {
    ...extraction,
    lineItems,
    warnings: extraction.warnings.includes(warning)
      ? extraction.warnings
      : [...extraction.warnings, warning],
  };
}
