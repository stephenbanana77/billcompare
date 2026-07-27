import type {
  OcrTextBox,
  OcrPageResult,
  OcrFieldEvidence,
  OcrKeyFieldKey,
  RecognitionComparisonItem,
  RecognitionValueType,
} from '@shared/reconciliation';

type OcrBoxInput = {
  page?: unknown;
  text?: unknown;
  score?: unknown;
  polygon?: unknown;
};

export function normalizeOcrBox(input: OcrBoxInput): OcrTextBox | null {
  const page = Number(input.page);
  const score = Number(input.score);
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!Number.isInteger(page) || page < 1 || !text || !Number.isFinite(score) || score < 0 || score > 1) {
    return null;
  }
  if (!Array.isArray(input.polygon) || input.polygon.length !== 4) return null;
  const points = input.polygon.map((point) => {
    if (!Array.isArray(point) || point.length !== 2) return null;
    const x = Number(point[0]);
    const y = Number(point[1]);
    return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 ? [x, y] as [number, number] : null;
  });
  if (points.some((point) => point === null)) return null;
  return { page, text, score, polygon: points as OcrTextBox['polygon'] };
}

const ocrFieldDefinitions: Array<{
  key: OcrKeyFieldKey;
  label: RegExp;
  direction: 'self' | 'inline-right' | 'below';
}> = [
  { key: 'mallName', label: /^(?!.*预览)(?=.*(?:购物中心|商场|广场|百货)).+$/, direction: 'self' },
  { key: 'settlementNo', label: /结算单号/, direction: 'inline-right' },
  { key: 'brandMerchantName', label: /品牌商名称/, direction: 'inline-right' },
  { key: 'brandName', label: /^品牌[：:]/, direction: 'inline-right' },
  { key: 'storeCode', label: /^(代码|柜号|门店编码)[：:]/, direction: 'inline-right' },
  { key: 'settlementDate', label: /^结算日期[：:]?$/, direction: 'inline-right' },
  { key: 'documentDate', label: /^制单日期[：:]?$/, direction: 'inline-right' },
  { key: 'salesQuantity', label: /^销售数量$/, direction: 'below' },
  { key: 'salesAmount', label: /^销售金额$/, direction: 'below' },
  { key: 'invoiceAmount', label: /发票金额.*含调整/, direction: 'below' },
  { key: 'deductionTotal', label: /扣款费用.*合计/, direction: 'below' },
  { key: 'settlementAmount', label: /^(实付金额|实结金额)$/, direction: 'below' },
];

export function extractOcrKeyFields(pages: OcrPageResult[]) {
  const fields: Partial<Record<OcrKeyFieldKey, OcrFieldEvidence>> = {};
  for (const definition of ocrFieldDefinitions) {
    for (const page of pages) {
      const matchingAnchors = page.boxes.filter((box) => definition.label.test(box.text.replace(/\s/g, '')));
      const anchor = selectOcrAnchor(page.boxes, matchingAnchors, definition.direction);
      if (!anchor) continue;
      const inline = definition.direction === 'self' ? anchor.text.trim() : valueAfterLabel(anchor.text);
      const evidence = inline
        ? { box: anchor, value: inline }
        : definition.direction === 'self'
          ? null
          : findNeighborValue(page.boxes, anchor, definition.direction);
      if (evidence) {
        fields[definition.key] = { value: evidence.value, label: anchor.text, evidence: evidence.box };
        break;
      }
    }
  }
  return fields;
}

function selectOcrAnchor(
  boxes: OcrTextBox[],
  anchors: OcrTextBox[],
  direction: 'self' | 'inline-right' | 'below',
) {
  if (anchors.length <= 1 || direction !== 'below') return anchors[0];
  const summaryTitle = boxes.find((box) => /本期.*结算.*汇总/.test(box.text.replace(/\s/g, '')));
  if (summaryTitle) {
    const titleBottom = boxBounds(summaryTitle).bottom;
    const summaryAnchor = anchors
      .filter((anchor) => {
        const top = boxBounds(anchor).top;
        return top >= titleBottom && top - titleBottom < 250;
      })
      .sort((left, right) => boxBounds(left).top - boxBounds(right).top)[0];
    if (summaryAnchor) return summaryAnchor;
  }
  return [...anchors].sort((left, right) => boxBounds(right).top - boxBounds(left).top)[0];
}

function valueAfterLabel(text: string) {
  const parts = text.split(/[：:]/);
  return parts.length > 1 ? parts.slice(1).join(':').trim() : '';
}

function findNeighborValue(
  boxes: OcrTextBox[],
  anchor: OcrTextBox,
  direction: 'inline-right' | 'below',
) {
  const bounds = boxBounds(anchor);
  const candidates = boxes.flatMap((box) => {
    if (box === anchor || !looksLikeValue(box.text)) return [];
    const other = boxBounds(box);
    if (direction === 'inline-right') {
      const verticalDistance = Math.abs(other.centerY - bounds.centerY);
      const horizontalGap = other.left - bounds.right;
      return horizontalGap >= -4 && horizontalGap < 250 && verticalDistance < 25
        ? [{ box, value: box.text.trim(), distance: horizontalGap + verticalDistance * 4 }]
        : [];
    }
    const verticalGap = other.top - bounds.bottom;
    const horizontallyAligned = other.centerX >= bounds.left - 35 && other.centerX <= bounds.right + 35;
    return verticalGap >= -15 && verticalGap < 90 && horizontallyAligned
      ? [{ box, value: box.text.trim(), distance: verticalGap + Math.abs(other.centerX - bounds.centerX) }]
      : [];
  });
  return candidates.sort((left, right) => left.distance - right.distance)[0] ?? null;
}

function looksLikeValue(text: string) {
  return /\d/.test(text) || /^[A-Za-z][A-Za-z0-9._/-]+$/.test(text);
}

function boxBounds(box: OcrTextBox) {
  const xs = box.polygon.map(([x]) => x);
  const ys = box.polygon.map(([, y]) => y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return { left, right, top, bottom, centerX: (left + right) / 2, centerY: (top + bottom) / 2 };
}

export function compareRecognitionValue(
  type: RecognitionValueType,
  visionValue: string | number | null,
  ocrValue: string | number | null,
): RecognitionComparisonItem {
  const normalizedVision = normalizeValue(type, visionValue);
  const normalizedOcr = normalizeValue(type, ocrValue);
  if (normalizedVision === null) {
    return { status: 'vision_missing', blocking: true, visionValue, ocrValue, normalizedVision, normalizedOcr };
  }
  if (normalizedOcr === null) {
    return { status: 'ocr_missing', blocking: true, visionValue, ocrValue, normalizedVision, normalizedOcr };
  }
  const status = normalizedVision === normalizedOcr ? 'confirmed' : 'conflict';
  return { status, blocking: status !== 'confirmed', visionValue, ocrValue, normalizedVision, normalizedOcr };
}

function normalizeValue(type: RecognitionValueType, value: string | number | null): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (type === 'money') {
    const number = Number(text.replace(/[￥¥,，\s]/g, ''));
    return Number.isFinite(number) ? number.toFixed(2) : null;
  }
  if (type === 'date') {
    const match = /([12]\d{3})\D*(\d{1,2})\D*(\d{1,2})/.exec(text);
    return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : null;
  }
  if (type === 'identifier') return text.replace(/\s/g, '').toUpperCase();
  return text.replace(/\s+/g, '').toLocaleLowerCase('zh-CN');
}
