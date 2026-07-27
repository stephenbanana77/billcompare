import type {
  VisionExtractionResult,
  VisionFieldKey,
  VisionRefinementCandidate,
  VisionRefinementItem,
  VisionRefinementResult,
} from './reconciliation';

export function collectVisionRefinementCandidates(
  result: VisionExtractionResult,
  threshold = 0.9,
): VisionRefinementCandidate[] {
  const candidates: VisionRefinementCandidate[] = [];
  for (const [key, field] of Object.entries(result.evidence) as Array<
    [VisionFieldKey, VisionExtractionResult['evidence'][VisionFieldKey]]
  >) {
    if (field && field.confidence !== null && field.confidence < threshold) {
      candidates.push({ id: `field:${key}`, label: field.rawText || key, value: field.value, page: field.page });
    }
  }
  result.additionalFields.forEach((field, index) => {
    if (field.confidence !== null && field.confidence < threshold) {
      candidates.push({ id: `additional:${index}`, label: field.label, value: field.value, page: field.page });
    }
  });
  result.lineItems.forEach((item, index) => {
    if (item.confidence !== null && item.confidence < threshold) {
      candidates.push({ id: `line:${index}`, label: `${item.section} / ${item.label}`, value: item.values, page: item.page });
    }
  });
  return candidates.slice(0, 16);
}

export function indexVisionRefinements(result: VisionRefinementResult) {
  return Object.fromEntries(result.items.map((item) => [item.id, item])) as Record<
    string,
    VisionRefinementItem
  >;
}
