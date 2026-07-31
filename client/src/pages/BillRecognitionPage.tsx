import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  Check,
  FileSearch,
  History,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  TableProperties,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  VisionAdditionalField,
  VisionDynamicField,
  VisionExtractionResult,
  VisionFieldKey,
  VisionLineItem,
  VisionRefinementItem,
  OcrExtractionResult,
  OcrFieldEvidence,
  OcrKeyFieldKey,
  OcrPageResult,
  ConfirmedSettlementBill,
  ConfirmedSettlementDetail,
} from '@shared/reconciliation';
import { reconciliationApi } from '@/api';
import { renderPdfTilesForVision } from '@/lib/workbook';
import {
  isSettlementPdfFile,
  recognizeSettlementBill,
} from '@/lib/settlement-pdf-recognition';
import {
  confirmedMetadataTargets,
  createSettlementRequestCoordinator,
  getSettlementBillIdentity,
  isBillInteractionLocked,
  mapConfirmedReviewedValues,
  persistSettlementConfirmation,
} from '@/lib/settlement-confirmation';
import {
  collectVisionRefinementCandidates,
  indexVisionRefinements,
} from '@shared/vision-refinement';

type MappingTarget =
  | ''
  | 'supportingInfo'
  | 'mallName'
  | 'storeName'
  | 'brandName'
  | 'brandMerchantName'
  | 'storeCode'
  | 'merchantName'
  | 'leaseUnit'
  | 'contractNo'
  | 'settlementNo'
  | 'salesQuantity'
  | 'taxAmount'
  | 'netPurchaseAmount'
  | 'feeLineItem'
  | 'businessMode'
  | 'counterLocation'
  | 'productCategory'
  | 'settlementDate'
  | 'documentDate'
  | 'printSequence'
  | 'previousBalance'
  | 'periodStart'
  | 'periodEnd'
  | 'salesAmount'
  | 'refundAmount'
  | 'commissionAmount'
  | 'activityFee'
  | 'invoiceAmount'
  | 'deductionTotal'
  | 'settlementAmount';

type ReviewGroup = 'basic' | 'summary' | 'additional' | 'unmapped';

type ReviewRow = {
  id: string;
  source: string;
  evidence: string;
  confidence: number | null;
  target: MappingTarget;
  value: string;
  group: ReviewGroup;
  derived?: boolean;
  refinement?: VisionRefinementItem;
};

const targets: Array<[MappingTarget, string]> = [
  ['', '暂不映射'],
  ['supportingInfo', '不参与 ERP 对账'],
  ['mallName', '商场名称'],
  ['storeName', '门店名称'],
  ['brandName', '品牌 / 门店'],
  ['brandMerchantName', '品牌商 / 供货单位'],
  ['storeCode', '柜号 / 门店编码'],
  ['merchantName', '商户名称'],
  ['leaseUnit', '承租单元'],
  ['contractNo', '合同号'],
  ['settlementNo', '结算单号'],
  ['salesQuantity', '销售数量'],
  ['taxAmount', '税额'],
  ['netPurchaseAmount', '不含税进价'],
  ['feeLineItem', '费用明细项'],
  ['businessMode', '结算 / 经营方式'],
  ['counterLocation', '柜场 / 经营场景'],
  ['productCategory', '商品大类'],
  ['settlementDate', '结算日期'],
  ['documentDate', '制单日期'],
  ['printSequence', '打印流水号'],
  ['previousBalance', '上期结算'],
  ['periodStart', '账期开始'],
  ['periodEnd', '账期结束'],
  ['salesAmount', '销售金额'],
  ['refundAmount', '退款金额'],
  ['commissionAmount', '扣点金额'],
  ['activityFee', '活动费'],
  ['invoiceAmount', '发票金额（含调整）'],
  ['deductionTotal', '扣款费用合计'],
  ['settlementAmount', '实付 / 实结金额'],
];

const fieldNames: Record<VisionFieldKey, string> = {
  periodStart: '账期开始',
  periodEnd: '账期结束',
  salesAmount: '销售金额',
  refundAmount: '退款金额',
  commissionAmount: '扣点金额',
  activityFee: '活动费',
  invoiceAmount: '发票金额（含调整）',
  deductionTotal: '扣款费用合计',
  settlementAmount: '实付金额',
};

const knownTargets = new Set(targets.map(([target]) => target));
const isKnownNonEmptyTarget = (
  target: string | null | undefined,
): target is Exclude<MappingTarget, ''> =>
  Boolean(target) && knownTargets.has(target as MappingTarget);

const additionalTargets = new Set<MappingTarget>([
  'supportingInfo',
  'businessMode',
  'counterLocation',
  'productCategory',
  'settlementDate',
  'documentDate',
  'printSequence',
  'previousBalance',
  'merchantName',
  'leaseUnit',
  'contractNo',
  'feeLineItem',
]);
const repeatableTargets = new Set<MappingTarget>(['feeLineItem']);

function normalizeFieldLabel(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/\s/g, '')
    .replace(/[：:]/g, '')
    .trim();
}

function isSupportingInfoLabel(value: string | null | undefined): boolean {
  const label = normalizeFieldLabel(value);
  return /开户行|银行|户名|账户|账号|帐号|收款方|付款方|收款单位|付款单位/.test(label);
}

function inferTargetFromLabel(
  labelValue: string | null | undefined,
  group?: string | null,
  valueType?: string | null,
): MappingTarget {
  const label = normalizeFieldLabel(labelValue);
  if (!label) return '';
  if (/^商户$|商户名称|商户编码|商户信息|商家/.test(label)) {
    return 'merchantName';
  }
  if (/承租单元|租赁单元|铺位|铺号|专柜|柜位|店铺位置/.test(label)) {
    return 'leaseUnit';
  }
  if (/合同号|合同编号|合同编码/.test(label)) return 'contractNo';
  if (/^品牌$|品牌名称/.test(label)) return 'brandName';
  if (/品牌商|供货单位|供应商/.test(label)) return 'brandMerchantName';
  if (/^商场$|商场名称|商场信息名称|购物中心|门店名称/.test(label)) {
    return 'mallName';
  }
  if (/柜号|门店编码|店号|店铺编码/.test(label)) return 'storeCode';
  if (/结算单号|单据编号|结算编号/.test(label)) return 'settlementNo';
  if (/经营方式|结算方式|联销方式/.test(label)) return 'businessMode';
  if (/柜场|经营场景|楼层场地/.test(label)) return 'counterLocation';
  if (/商品大类|品类|商品类别/.test(label)) return 'productCategory';
  if (/结算日期/.test(label)) return 'settlementDate';
  if (/打印时间|制单日期|开单日期/.test(label)) return 'documentDate';
  if (/打印流水号|打印序号|页码流水/.test(label)) return 'printSequence';
  if (/上期结算|上期余额|期初余额/.test(label)) return 'previousBalance';
  if (/销售数量|销量|数量/.test(label)) return 'salesQuantity';
  if (/税额/.test(label)) return 'taxAmount';
  if (/不含税进价|进价/.test(label)) return 'netPurchaseAmount';
  if (/销售返款|返款合计|退款合计|退货合计/.test(label)) {
    return 'refundAmount';
  }
  if (/销售额|销售金额/.test(label)) return 'salesAmount';
  if (/退款|退货/.test(label)) return 'refundAmount';
  if (/扣点|佣金|手续费/.test(label)) return 'commissionAmount';
  if (/活动费/.test(label)) return 'activityFee';
  if (/开票金额|发票金额/.test(label)) return 'invoiceAmount';
  if (/租金总计|扣款合计|应收项目合计|应收合计|费用合计|商场应收/.test(label)) {
    return 'deductionTotal';
  }
  if (isSupportingInfoLabel(label)) return 'supportingInfo';
  if (/税率/.test(label)) return 'taxAmount';
  if (/应返商户|应付商户|实付|实结|结算金额/.test(label)) {
    return 'settlementAmount';
  }
  if (
    group === 'fee' ||
    valueType === 'money' ||
    /租金|POS费|电费|管理费|耗材费|消杀费|物料|运维费|费用|扣费|扣款/.test(label)
  ) {
    return 'feeLineItem';
  }
  return '';
}

function metadataRow(
  source: string,
  value: string,
  target: MappingTarget,
  evidence: string,
  derived = false,
): ReviewRow {
  return {
    id: crypto.randomUUID(),
    source,
    evidence,
    confidence: null,
    target,
    value,
    group: 'basic',
    derived,
  };
}

function additionalRow(field: VisionAdditionalField, index: number): ReviewRow {
  const target = inferAdditionalTarget(field);
  const isSupportingInfo = target === 'supportingInfo' || isSupportingInfoLabel(field.label);
  return {
    id: `additional:${index}`,
    source: field.label || field.rawText || `动态字段 ${index + 1}`,
    evidence: [
      `第 ${field.page ?? '-'} 页`,
      field.group === 'summary'
        ? '汇总区'
        : field.group === 'fee'
          ? '费用区'
          : `${field.group || 'other'} 字段`,
      field.rawText && field.rawText !== field.label
        ? `原文：${field.rawText}`
        : '',
    ]
      .filter(Boolean)
      .join(' · '),
    confidence: field.confidence,
    target,
    value: field.value === null ? '' : String(field.value),
    group:
      isSupportingInfo
        ? 'additional'
        : field.group === 'summary'
        ? 'summary'
        : additionalTargets.has(target)
          ? 'additional'
          : target
            ? 'basic'
            : 'unmapped',
  };
}

function autoMapReviewRow(row: ReviewRow): ReviewRow {
  if (row.target) return row;
  const inferred = inferTargetFromLabel(row.source, row.group, null);
  if (!inferred) return row;
  return {
    ...row,
    target: inferred,
    group: additionalTargets.has(inferred) ? 'additional' : row.group,
  };
}

function dynamicFieldRow(field: VisionDynamicField, index: number): ReviewRow {
  const target = isKnownNonEmptyTarget(field.role)
    ? field.role
    : inferTargetFromLabel(field.label, field.group, field.valueType);
  const isSupportingInfo = target === 'supportingInfo' || isSupportingInfoLabel(field.label);
  return {
    id: field.id || `dynamic:${index}`,
    source: field.label || `动态字段 ${index + 1}`,
    evidence: [
      `第 ${field.page ?? '-'} 页`,
      field.section || `${field.group || 'other'} 字段`,
      field.valueType ? `类型：${field.valueType}` : '',
      field.rawText && field.rawText !== field.label
        ? `原文：${field.rawText}`
        : '',
    ]
      .filter(Boolean)
      .join(' · '),
    confidence: field.confidence,
    target,
    value: field.value === null ? '' : String(field.value),
    group:
      isSupportingInfo
        ? 'additional'
        : field.group === 'summary' || field.group === 'formula'
        ? 'summary'
        : additionalTargets.has(target)
          ? 'additional'
          : target
            ? 'basic'
            : 'unmapped',
  };
}

function mergeFeeLineItems(result: VisionExtractionResult): VisionLineItem[] {
  const items = [...result.lineItems];
  const feeKey = (label: string, value: string | number | null) =>
    `${label.replace(/\s/g, '').replace(/[~～-]\d{4}\s*$/, '')}|${String(value ?? '').replace(/[,，\s]/g, '')}`;
  const existing = new Set(
    items.map((item) =>
      feeKey(
        item.label,
        item.values['金额'] ?? item.values['费用金额'] ?? null,
      ),
    ),
  );

  for (const field of result.additionalFields.filter(
    (item) => item.group === 'fee',
  )) {
    const normalizedLabel = field.label.replace(/[~～-]\d{4}\s*$/, '').trim();
    if (!normalizedLabel || field.value === null || field.value === '')
      continue;
    const key = feeKey(field.label, field.value);
    if (existing.has(key)) continue;
    const code = field.label.match(/[~～-](\d{4})\s*$/)?.[1] ?? null;
    items.push({
      section: '扣费明细',
      label: field.label,
      rowType: 'detail',
      values: { 费用代码: code, 金额: field.value, 分组: '扣费' },
      rawText: field.rawText,
      page: field.page,
      confidence: field.confidence,
    });
    existing.add(key);
  }
  return items;
}

function inferAdditionalTarget(field: VisionAdditionalField): MappingTarget {
  if (isKnownNonEmptyTarget(field.suggestedTarget)) {
    return field.suggestedTarget;
  }
  return inferTargetFromLabel(field.label, field.group, null);
}

function buildReviewRows(result: VisionExtractionResult): ReviewRow[] {
  const periodSource = result.periodEvidence.rawText;
  const periodIsExplicit = result.periodEvidence.kind === 'explicit_range';
  const metadataRows = [
    metadataRow(
      '商场名称',
      result.metadata.mallName,
      confirmedMetadataTargets.mallName,
      'AI 从单据页眉识别',
    ),
    metadataRow(
      '品牌 / 门店',
      result.metadata.storeName,
      confirmedMetadataTargets.storeName,
      'AI 从单据页眉识别',
    ),
    metadataRow(
      '柜号 / 门店编码',
      result.metadata.storeCode,
      confirmedMetadataTargets.storeCode,
      'AI 从单据页眉识别',
    ),
    metadataRow(
      periodSource || '未返回账期原文',
      result.metadata.periodStart,
      confirmedMetadataTargets.periodStart,
      periodIsExplicit
        ? `第 ${result.periodEvidence.page ?? '-'} 页 · 原文日期范围`
        : 'PDF 未显示 5 月 1 日；系统按结算月份推导当月首日',
      !periodIsExplicit,
    ),
    metadataRow(
      periodSource || '未返回账期原文',
      result.metadata.periodEnd,
      confirmedMetadataTargets.periodEnd,
      periodIsExplicit
        ? `第 ${result.periodEvidence.page ?? '-'} 页 · 原文日期范围`
        : '系统按结算月份推导当月末日，并与结算日期交叉核对',
      !periodIsExplicit,
    ),
  ];
  const amountRows = (
    Object.entries(result.evidence) as Array<
      [
        VisionFieldKey,
        NonNullable<VisionExtractionResult['evidence'][VisionFieldKey]>,
      ]
    >
  )
    .filter(
      ([key, evidence]) =>
        !['periodStart', 'periodEnd'].includes(key) &&
        (evidence?.rawText || evidence?.value !== null),
    )
    .map(
      ([key, evidence]): ReviewRow => ({
        id: `field:${key}`,
        source: evidence.rawText || fieldNames[key],
        evidence: `第 ${evidence.page ?? '-'} 页 · 结算汇总区`,
        confidence: evidence.confidence,
        target: key as MappingTarget,
        value: evidence.value === null ? '' : String(evidence.value),
        group: 'summary',
      }),
    );
  const occupiedTargets = new Set<MappingTarget>([
    ...metadataRows.map((row) => row.target),
    ...amountRows.map((row) => row.target),
  ]);
  const dynamicFields = result.dynamicFields ?? [];
  const fieldSignature = (label: string, value: unknown, page: number | null) =>
    `${label.replace(/\s/g, '')}|${String(value ?? '').replace(/\s/g, '')}|${page ?? '-'}`;
  const dynamicSignatures = new Set(
    dynamicFields.map((field) =>
      fieldSignature(field.label, field.value, field.page),
    ),
  );
  const sourceRows: ReviewRow[] = [
    ...dynamicFields
      .filter(
        (field) =>
          !field.id.startsWith('field:metadata:') &&
          !field.id.startsWith('field:evidence:') &&
          !field.id.startsWith('field:line:'),
      )
      .map(dynamicFieldRow),
    ...result.additionalFields
      .filter(
        (field) =>
          !dynamicSignatures.has(
            fieldSignature(field.label, field.value, field.page),
          ),
      )
      .map(additionalRow),
  ];
  const additionalRows: ReviewRow[] = [];
  for (const candidate of sourceRows) {
    const autoMappedCandidate = autoMapReviewRow(candidate);
    const row =
      autoMappedCandidate.target &&
      occupiedTargets.has(autoMappedCandidate.target) &&
      !repeatableTargets.has(autoMappedCandidate.target)
        ? {
            ...autoMappedCandidate,
            group: 'additional' as ReviewGroup,
          }
        : autoMappedCandidate;
    additionalRows.push(row);
    if (row.target) occupiedTargets.add(row.target);
  }
  return [...metadataRows, ...amountRows, ...additionalRows];
}

const emptyRow = (): ReviewRow => ({
  id: crypto.randomUUID(),
  source: '人工补充字段',
  evidence: '由复核人员补充',
  confidence: null,
  target: '',
  value: '',
  group: 'unmapped',
});

function buildConfirmedReviewRows(
  detail: ConfirmedSettlementDetail,
  extraction: VisionExtractionResult,
): ReviewRow[] {
  const baseRows = buildReviewRows(extraction);
  const used = new Set<number>();
  const rows = baseRows.map((row) => {
    const reviewedIndex = detail.reviewedFields.findIndex(
      (field, index) =>
        !used.has(index) &&
        (field.id === row.id || (row.target && field.target === row.target)),
    );
    if (reviewedIndex < 0) return row;
    used.add(reviewedIndex);
    const field = detail.reviewedFields[reviewedIndex];
    return {
      ...row,
      source: field.label || row.source,
      value: field.value === null ? '' : String(field.value),
      target: knownTargets.has(field.target as MappingTarget)
        ? (field.target as MappingTarget)
        : row.target,
    };
  });

  detail.reviewedFields.forEach((field, index) => {
    if (used.has(index)) return;
    const target = knownTargets.has(field.target as MappingTarget)
      ? (field.target as MappingTarget)
      : '';
    rows.push({
      id: field.id || `confirmed:${index}`,
      source: field.label || field.target || `确认字段 ${index + 1}`,
      evidence: '确认记录中保存的动态字段',
      confidence: null,
      target,
      value: field.value === null ? '' : String(field.value),
      group: 'unmapped',
    });
  });
  return rows;
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

function confirmedStatusLabel(status: ConfirmedSettlementBill['status']) {
  return status === 'confirmed'
    ? '当前确认'
    : status === 'superseded'
      ? '历史版本'
      : '已撤销';
}

export default function BillRecognitionPage() {
  const requestCoordinator = useRef(createSettlementRequestCoordinator());
  const lastRecognitionFiles = useRef<File[]>([]);
  const historyRequestRevision = useRef(0);
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<VisionExtractionResult | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [recognizing, setRecognizing] = useState(false);
  const [attemptedFileName, setAttemptedFileName] = useState('');
  const [recognitionError, setRecognitionError] = useState<string | null>(null);
  const [refining, setRefining] = useState(false);
  const [refinements, setRefinements] = useState<
    Record<string, VisionRefinementItem>
  >({});
  const [ocrResult, setOcrResult] = useState<OcrExtractionResult | null>(null);
  const [pageImages, setPageImages] = useState<string[]>([]);
  const [selectedEvidence, setSelectedEvidence] =
    useState<OcrFieldEvidence | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmedDetail, setConfirmedDetail] =
    useState<ConfirmedSettlementDetail | null>(null);
  const [recognitionStage, setRecognitionStage] = useState('等待上传');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [confirmedBills, setConfirmedBills] = useState<
    ConfirmedSettlementBill[]
  >([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loadingConfirmedId, setLoadingConfirmedId] = useState<string | null>(
    null,
  );
  const confirmed = confirmedDetail !== null;
  const interactionLocked =
    isBillInteractionLocked({ recognizing, confirming }) ||
    loadingConfirmedId !== null;

  const confirmedValues = useMemo(
    () => (confirmedDetail ? mapConfirmedReviewedValues(confirmedDetail) : {}),
    [confirmedDetail],
  );
  const displayLineItems = useMemo(
    () => (result ? mergeFeeLineItems(result) : []),
    [result],
  );
  const dynamicFormulaChecks = useMemo(
    () => (result ? readDynamicFormulaChecks(result) : []),
    [result],
  );
  const needsReview = Boolean(
    result?.warnings.length ||
    dynamicFormulaChecks.some((check) => check.status !== 'passed') ||
    rows.some(
      (row) => row.derived || (row.confidence !== null && row.confidence < 0.9),
    ),
  );
  const ocrHasConflict = Boolean(ocrResult && hasOcrConflict(rows, ocrResult));

  const refreshConfirmedHistory = useCallback(async () => {
    const revision = ++historyRequestRevision.current;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const bills = await reconciliationApi.confirmedSettlements({
        includeHistory: true,
      });
      if (historyRequestRevision.current === revision) setConfirmedBills(bills);
    } catch (error) {
      if (historyRequestRevision.current === revision) {
        setHistoryError(
          error instanceof Error ? error.message : '已确认单据加载失败',
        );
      }
    } finally {
      if (historyRequestRevision.current === revision) setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshConfirmedHistory();
    return () => {
      historyRequestRevision.current += 1;
    };
  }, [refreshConfirmedHistory]);

  const loadConfirmedSettlement = async (bill: ConfirmedSettlementBill) => {
    if (interactionLocked || loadingConfirmedId) return;
    setLoadingConfirmedId(bill.id);
    setHistoryError(null);
    try {
      const detail = await reconciliationApi.confirmedSettlement(bill.id);
      const extraction = detail.extraction.lineItems.length
        ? detail.extraction
        : {
            ...detail.extraction,
            lineItems: [...detail.salesLines, ...detail.feeLines],
          };
      requestCoordinator.current.activateBill(
        getSettlementBillIdentity(detail.bill.sourceFileName, extraction),
      );
      setFileName(detail.bill.sourceFileName);
      setResult(extraction);
      setRows(buildConfirmedReviewRows(detail, extraction));
      setConfirmedDetail(detail);
      setOcrResult(null);
      setRefinements({});
      setRefining(false);
      setSelectedEvidence(null);
      setPageImages((current) => {
        current.forEach((url) => URL.revokeObjectURL(url));
        return [];
      });
      setRecognitionError(null);
      setRecognitionStage('已从确认记录加载');
      setSavedAt(null);
    } catch (error) {
      setHistoryError(
        error instanceof Error ? error.message : '确认单据详情加载失败',
      );
    } finally {
      setLoadingConfirmedId(null);
    }
  };

  const recognize = async (files?: File[]) => {
    const selected = (files ?? []).filter(Boolean);
    if (!selected.length || interactionLocked) return;
    setAttemptedFileName(
      selected.length === 1 ? selected[0].name : `${selected.length} 张照片`,
    );
    lastRecognitionFiles.current = selected;
    setRecognitionError(null);
    const previousBillIdentity =
      requestCoordinator.current.currentBillIdentity();
    const recognitionToken = requestCoordinator.current.beginRecognition();
    if (!recognitionToken) return;
    setRecognizing(true);
    let activeBillIdentity: string | null = null;
    try {
      const { sourceKind, pages, extraction, ocr, ocrWarning } =
        await recognizeSettlementBill(selected, (stage) => {
          if (!requestCoordinator.current.isRecognitionCurrent(recognitionToken))
            return;
          setRecognitionStage(
            stage === 'rendering'
              ? selected.some(isSettlementPdfFile)
                ? '正在渲染单据页面'
                : '正在准备照片页面'
              : stage === 'recognizing'
                ? '正在进行视觉识别和 OCR 校验，通常需要 1-2 分钟'
                : '识别完成，正在检查金额和证据',
          );
        });
      if (!requestCoordinator.current.isRecognitionCurrent(recognitionToken))
        return;
      if (ocrWarning) toast.warning(ocrWarning);
      activeBillIdentity = getSettlementBillIdentity(
        extraction.fileName,
        extraction,
      );
      if (
        !requestCoordinator.current.activateBill(
          activeBillIdentity,
          recognitionToken,
        )
      )
        return;
      setPageImages((current) => {
        current.forEach((url) => URL.revokeObjectURL(url));
        return pages.map((page) => URL.createObjectURL(page));
      });
      setFileName(extraction.fileName);
      setResult(extraction);
      setOcrResult(ocr);
      setRows(buildReviewRows(extraction));
      setSavedAt(null);
      setConfirmedDetail(null);
      setRefinements({});
      setSelectedEvidence(null);
      setRecognitionError(null);
      setRecognitionStage('识别完成，正在检查金额和证据');
      const candidates = collectVisionRefinementCandidates(extraction);
      if (candidates.length) {
        setRefining(true);
        try {
          const pagesNeeded = candidates.flatMap((candidate) =>
            candidate.page === null ? [] : [candidate.page],
          );
          const tiles =
            sourceKind === 'pdf'
              ? await renderPdfTilesForVision(selected[0], pagesNeeded)
              : pagesNeeded
                  .map((pageNumber) => pages[pageNumber - 1])
                  .filter((page): page is File => Boolean(page));
          const refinementResult = await reconciliationApi.refineVisionBill(
            candidates,
            tiles,
          );
          if (
            requestCoordinator.current.currentBillIdentity() !==
            activeBillIdentity
          )
            return;
          const indexed = indexVisionRefinements(refinementResult);
          setRefinements(indexed);
          setRows((current) =>
            current.map((row) =>
              indexed[row.id]
                ? {
                    ...row,
                    refinement: indexed[row.id],
                    confidence:
                      indexed[row.id].status === 'confirmed'
                        ? Math.max(
                            row.confidence ?? 0,
                            indexed[row.id].confidence ?? 0.9,
                          )
                        : row.confidence,
                  }
                : row,
            ),
          );
        } catch (error) {
          if (
            requestCoordinator.current.currentBillIdentity() ===
            activeBillIdentity
          ) {
            toast.warning(
              error instanceof Error
                ? `二次复核未完成：${error.message}`
                : '低置信字段二次复核未完成。',
            );
          }
        } finally {
          if (
            requestCoordinator.current.currentBillIdentity() ===
            activeBillIdentity
          )
            setRefining(false);
        }
      }
      if (
        requestCoordinator.current.currentBillIdentity() === activeBillIdentity
      ) {
        toast.success(
          'AI 已完成结构化识别，请复核推导字段、汇总金额和明细表。',
        );
      }
    } catch (error) {
      if (requestCoordinator.current.isRecognitionCurrent(recognitionToken)) {
        const message = errorMessage(error, '视觉识别失败，请重试。');
        setRecognitionStage('识别失败，可直接重试');
        setRecognitionError(message);
        toast.error(message);
      }
    } finally {
      let requestIsCurrent = activeBillIdentity
        ? requestCoordinator.current.currentBillIdentity() ===
          activeBillIdentity
        : requestCoordinator.current.isRecognitionCurrent(recognitionToken);
      if (!activeBillIdentity && requestIsCurrent && previousBillIdentity) {
        requestCoordinator.current.activateBill(
          previousBillIdentity,
          recognitionToken,
        );
        requestIsCurrent = true;
      }
      if (requestIsCurrent) setRecognizing(false);
    }
  };

  const saveReview = () => {
    if (!result || !fileName || interactionLocked) return;
    const record = {
      draftType: 'local-review-draft',
      fileName,
      result,
      rows,
      ocrResult,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(
      `reconciliation-local-draft:${fileName}`,
      JSON.stringify(record),
    );
    setSavedAt(record.savedAt);
    toast.success('本机草稿已保存，仅用于继续复核，不代表结算单已确认。');
  };

  const confirmSettlement = async () => {
    if (!result || !fileName || interactionLocked) return;
    let qualityReview:
      | { acknowledged: boolean; note: string }
      | undefined = undefined;
    if (needsReview) {
      const note = window.prompt(
        '当前结算单存在待复核项。请填写复核说明或异常原因后再确认入库：',
      );
      if (!note?.trim()) {
        toast.error('存在待复核项时，必须填写复核说明后才能确认。');
        return;
      }
      qualityReview = { acknowledged: true, note: note.trim() };
    }
    const billIdentity = getSettlementBillIdentity(fileName, result);
    const confirmationToken =
      requestCoordinator.current.beginConfirmation(billIdentity);
    if (!confirmationToken) return;
    setConfirming(true);
    let confirmationPersisted = false;
    try {
      const input = {
        fileName,
        confirmationKey: confirmationToken.confirmationKey!,
        extraction: result,
        reviewedFields: rows.map(({ id, source, target, value }) => ({
          id,
          label: source,
          target,
          value,
        })),
        clientReportedOcrVerified: Boolean(ocrResult) && !ocrHasConflict,
        ...(qualityReview ? { qualityReview } : {}),
      };
      const detail = await persistSettlementConfirmation(
        input,
        reconciliationApi.confirmSettlement,
        requestCoordinator.current,
        confirmationToken,
        setConfirmedDetail,
      );
      if (detail) {
        confirmationPersisted = true;
        toast.success(`结算单已确认，版本 V${detail.bill.version}`);
        void refreshConfirmedHistory();
      }
    } catch (error) {
      if (requestCoordinator.current.isConfirmationCurrent(confirmationToken)) {
        toast.error(error instanceof Error ? error.message : '确认结算单失败');
      }
    } finally {
      const requestIsCurrent =
        requestCoordinator.current.isConfirmationCurrent(confirmationToken);
      requestCoordinator.current.finishConfirmation(
        confirmationToken,
        confirmationPersisted,
      );
      if (requestIsCurrent) setConfirming(false);
    }
  };

  const exportReview = () => {
    if (!result || !fileName || interactionLocked) return;
    const record = {
      fileName,
      result,
      rows,
      ocrResult,
      confirmed,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(record, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${fileName.replace(/\.pdf$/i, '')}-review.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const update = (id: string, patch: Partial<ReviewRow>) => {
    if (interactionLocked) return;
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  };

  return (
    <div className="page-stack recognition-page">
      <section className="recognition-hero">
        <div>
          <p className="eyebrow">视觉智能识别</p>
          <h2>结算单智能识别</h2>
          <p>
            上传扫描版结算单，复核单据原文、汇总金额与明细后，再进入 ERP 对账。
          </p>
        </div>
        <label className="button primary recognition-upload">
          {interactionLocked ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <Upload size={17} />
          )}
          {confirming
            ? '正在确认'
            : recognizing
              ? '正在识别'
              : loadingConfirmedId
                ? '正在加载记录'
                : '上传结算单'}
          <input
            type="file"
            accept=".pdf,application/pdf,.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
            multiple
            disabled={interactionLocked}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.currentTarget.value = '';
              void recognize(files);
            }}
          />
        </label>
      </section>

      {(recognizing || recognitionError) && (
        <section
          className={`recognition-attempt ${recognitionError ? 'failed' : 'running'}`}
          role={recognitionError ? 'alert' : 'status'}
        >
          {recognitionError ? (
            <AlertTriangle size={20} />
          ) : (
            <LoaderCircle className="spin" size={20} />
          )}
          <div>
            <strong>
              {recognitionError
                ? `${attemptedFileName || '该文件'}识别未完成`
                : `正在识别 ${attemptedFileName}`}
            </strong>
            <p>
              {recognitionError ?? recognitionStage}
              {result
                ? ' 当前页面中的识别结果已保留，不会因本次失败丢失。'
                : ''}
            </p>
          </div>
          {recognitionError && lastRecognitionFiles.current.length > 0 && (
            <button
              className="button secondary"
              type="button"
              disabled={interactionLocked}
              onClick={() =>
                void recognize(lastRecognitionFiles.current)
              }
            >
              <RotateCcw size={16} />
              重新识别
            </button>
          )}
        </section>
      )}

      <ConfirmedHistorySection
        bills={confirmedBills}
        loading={historyLoading}
        error={historyError}
        activeId={confirmedDetail?.bill.id ?? null}
        loadingId={loadingConfirmedId}
        disabled={interactionLocked}
        onRefresh={() => void refreshConfirmedHistory()}
        onLoad={(bill) => void loadConfirmedSettlement(bill)}
      />

      {!fileName && (
        <section className="recognition-empty">
          <FileSearch size={30} />
          <h3>上传一份商场结算单开始识别</h3>
          <p>
            识别结果不会直接入账。系统会区分原文值、推导值、汇总数据和明细数据。
          </p>
        </section>
      )}

      {fileName && result && !confirmed && (
        <>
          <section className="recognition-status">
            <span className="status-icon">
              <FileSearch size={19} />
            </span>
            <div>
              <strong>{fileName}</strong>
              <p>
                {recognizing
                  ? '当前识别结果已保留；新文件的处理进度见上方。'
                  : recognitionError
                    ? '当前识别结果仍可继续复核；失败的新文件可在上方直接重试。'
                    : recognitionStage}
              </p>
            </div>
            <span className="waiting-badge">
              {refining ? '低置信字段二次复核中' : '待人工复核'}
            </span>
          </section>

          <FieldSection
            title="单据基础信息"
            description="页眉、主体与账期。系统推导值会明确标识。"
            rows={rows.filter((row) => row.group === 'basic')}
            onUpdate={update}
            disabled={interactionLocked}
          />
          <FieldSection
            title="本期结算汇总"
            description="仅使用结算汇总区域直接打印的金额作为对账主值。"
            rows={rows.filter((row) => row.group === 'summary')}
            onUpdate={update}
            disabled={interactionLocked}
          />

          {ocrResult && (
            <MethodComparison
              rows={rows}
              ocr={ocrResult}
              onEvidence={setSelectedEvidence}
            />
          )}

          <LineItemSections
            items={displayLineItems}
            refinements={refinements}
          />
          <ValidationPanel
            rows={rows}
            items={displayLineItems}
            result={result}
          />

          {rows.some((row) => row.group === 'additional') && (
            <FieldSection
              title="已确认附加与动态信息"
              description="按原标签保存的附加字段，只读展示。"
              rows={rows.filter((row) => row.group === 'additional')}
              onUpdate={() => undefined}
              disabled
            />
          )}

          {rows.some((row) => row.group === 'unmapped') && (
            <FieldSection
              title="待确认字段"
              description="仅保留模型无法判断业务语义的字段；不参与 ERP 对账的字段不会阻塞确认。"
              rows={rows.filter((row) => row.group === 'unmapped')}
              onUpdate={update}
              disabled={interactionLocked}
              action={
                <button
                  className="button secondary"
                  disabled={interactionLocked}
                  onClick={() => {
                    if (!interactionLocked)
                      setRows((current) => [...current, emptyRow()]);
                  }}
                >
                  <Plus size={16} />
                  补充字段
                </button>
              }
            />
          )}

          <section
            className={`recognition-review ${needsReview ? 'review' : 'ready'}`}
          >
            {needsReview ? (
              <AlertTriangle size={20} />
            ) : (
              <BadgeCheck size={20} />
            )}
            <div>
              <strong>
                {needsReview ? '存在推导值或待复核项' : '识别结果可确认'}
              </strong>
              <p>
                {result.warnings[0] ??
                  (dynamicFormulaChecks.some(
                    (check) => check.status !== 'passed',
                  )
                    ? '当前单据存在未通过或缺少字段的动态公式，请核对公式证据和代入值。'
                    : '请核对原单后确认；确认结果将作为后续 ERP 对账依据。')}
              </p>
            </div>
            <button
              className="button primary"
              disabled={interactionLocked || refining}
              onClick={confirmSettlement}
            >
              {confirming ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Check size={16} />
              )}
              {confirming ? '正在确认' : '确认结算单'}
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={interactionLocked}
              onClick={saveReview}
            >
              保存本机草稿
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={interactionLocked}
              onClick={exportReview}
            >
              导出 JSON
            </button>
            {savedAt && (
              <small>本机草稿：{new Date(savedAt).toLocaleString()}</small>
            )}
          </section>
        </>
      )}

      {fileName && confirmed && (
        <>
          <section className="confirmed-result">
            <div className="confirmed-heading">
              <BadgeCheck size={23} />
              <div>
                <h3>结算单已确认</h3>
                <p>{fileName} 已完成结构化复核，等待同账期 ERP 数据。</p>
              </div>
              <span className="waiting-badge">待 ERP 对账</span>
            </div>
            <div className="confirmed-grid">
              <div>
                <span>数据库记录 ID</span>
                <strong>{confirmedDetail.bill.id}</strong>
              </div>
              <div>
                <span>确认版本</span>
                <strong>V{confirmedDetail.bill.version}</strong>
              </div>
              <div>
                <span>确认人</span>
                <strong>{confirmedDetail.bill.confirmedBy}</strong>
              </div>
              <div>
                <span>确认时间</span>
                <strong>
                  {new Date(confirmedDetail.bill.confirmedAt).toLocaleString()}
                </strong>
              </div>
              {Object.entries(confirmedValues).map(([target, value]) => (
                <div key={target}>
                  <span>
                    {targets.find(([key]) => key === target)?.[1] ?? target}
                  </span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
          </section>

          <FieldSection
            title="已确认基础信息"
            description="以下为确认时保存的字段与原单证据，只读展示。"
            rows={rows.filter((row) => row.group === 'basic')}
            onUpdate={() => undefined}
            disabled
          />
          <FieldSection
            title="已确认结算汇总"
            description="保留确认时的汇总字段及动态业务映射。"
            rows={rows.filter((row) => row.group === 'summary')}
            onUpdate={() => undefined}
            disabled
          />
          <LineItemSections items={displayLineItems} refinements={{}} />
          <ValidationPanel
            rows={rows}
            items={displayLineItems}
            result={result}
          />
          {rows.some((row) => row.group === 'additional') && (
            <FieldSection
              title="单据附加与动态信息"
              description="保留模型按原单发现的字段名称和值；可选业务映射，不映射也会随确认记录保存。"
              rows={rows.filter((row) => row.group === 'additional')}
              onUpdate={update}
              disabled={interactionLocked}
            />
          )}
          {rows.some((row) => row.group === 'unmapped') && (
            <FieldSection
              title="已确认动态字段"
              description="未映射到固定业务角色的字段也按原标签完整保留。"
              rows={rows.filter((row) => row.group === 'unmapped')}
              onUpdate={() => undefined}
              disabled
            />
          )}
        </>
      )}

      {selectedEvidence && pageImages[selectedEvidence.evidence.page - 1] && (
        <EvidenceViewer
          evidence={selectedEvidence}
          imageUrl={pageImages[selectedEvidence.evidence.page - 1]}
          page={ocrResult?.pages[selectedEvidence.evidence.page - 1]}
          onClose={() => setSelectedEvidence(null)}
        />
      )}
    </div>
  );
}

function ConfirmedHistorySection({
  bills,
  loading,
  error,
  activeId,
  loadingId,
  disabled,
  onRefresh,
  onLoad,
}: {
  bills: ConfirmedSettlementBill[];
  loading: boolean;
  error: string | null;
  activeId: string | null;
  loadingId: string | null;
  disabled: boolean;
  onRefresh: () => void;
  onLoad: (bill: ConfirmedSettlementBill) => void;
}) {
  return (
    <section className="review-section confirmed-history">
      <div className="section-heading">
        <div>
          <h3>
            <History size={18} />
            已确认结算单
          </h3>
          <p>
            确认后的单据保存在服务器中，可随时重新打开查看字段、公式和全部明细。
          </p>
        </div>
        <button
          className="button secondary"
          type="button"
          disabled={loading || disabled}
          onClick={onRefresh}
        >
          <RefreshCw className={loading ? 'spin' : ''} size={16} />
          刷新
        </button>
      </div>
      {error && (
        <div className="history-error" role="alert">
          <AlertTriangle size={17} />
          <span>{error}</span>
          <button type="button" onClick={onRefresh}>
            重试
          </button>
        </div>
      )}
      {loading && !bills.length ? (
        <div className="review-empty">
          <LoaderCircle className="spin" size={18} />
          正在加载已确认单据…
        </div>
      ) : bills.length ? (
        <div className="detail-table-wrap">
          <table className="detail-table history-table">
            <thead>
              <tr>
                <th>文件 / 门店</th>
                <th>商场</th>
                <th>账期</th>
                <th>最终应付</th>
                <th>确认信息</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {bills.map((bill) => (
                <tr
                  className={activeId === bill.id ? 'active-history-row' : ''}
                  key={bill.id}
                >
                  <td>
                    <strong>{bill.sourceFileName}</strong>
                    <small>
                      {bill.storeName || bill.storeCode || '未识别门店'} · V
                      {bill.version} · {confirmedStatusLabel(bill.status)}
                    </small>
                  </td>
                  <td>{bill.mallName || '-'}</td>
                  <td>
                    {bill.periodStart} 至 {bill.periodEnd}
                  </td>
                  <td>
                    {formatNumber(numberValue(bill.settlementAmount) ?? 0)}
                  </td>
                  <td>
                    {new Date(bill.confirmedAt).toLocaleString()}
                    <small>{bill.confirmedBy}</small>
                  </td>
                  <td>
                    <button
                      className="history-load-button"
                      type="button"
                      disabled={disabled || Boolean(loadingId)}
                      onClick={() => onLoad(bill)}
                    >
                      {loadingId === bill.id ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : activeId === bill.id ? (
                        <Check size={14} />
                      ) : (
                        <FileSearch size={14} />
                      )}
                      {loadingId === bill.id
                        ? '加载中'
                        : activeId === bill.id
                          ? '当前查看'
                          : '查看详情'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="review-empty">
          尚无已确认单据。完成确认后会自动出现在这里。
        </div>
      )}
    </section>
  );
}

function FieldSection({
  title,
  description,
  rows,
  onUpdate,
  action,
  emptyText,
  disabled = false,
}: {
  title: string;
  description: string;
  rows: ReviewRow[];
  onUpdate: (id: string, patch: Partial<ReviewRow>) => void;
  action?: React.ReactNode;
  emptyText?: string;
  disabled?: boolean;
}) {
  return (
    <section className="review-section">
      <div className="section-heading">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        {action}
      </div>
      {rows.length ? (
        <div className="mapping-table" role="table" aria-label={title}>
          <div className="mapping-row mapping-header" role="row">
            <span>单据原文 / 来源</span>
            <span>业务字段</span>
            <span>复核确认值</span>
            <span>状态</span>
          </div>
          {rows.map((row) => (
            <div className="mapping-row" role="row" key={row.id}>
              <div>
                <strong>{row.source || '未识别'}</strong>
                <small>{row.evidence}</small>
              </div>
              <select
                aria-label={`${row.source}的业务字段`}
                value={row.target}
                disabled={disabled}
                onChange={(event) =>
                  onUpdate(row.id, {
                    target: event.target.value as MappingTarget,
                  })
                }
              >
                {targets.map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                aria-label={`${row.source}的确认值`}
                value={row.value}
                disabled={disabled}
                placeholder="录入或修正字段值"
                onChange={(event) =>
                  onUpdate(row.id, { value: event.target.value })
                }
              />
              <span
                className={`confidence ${row.refinement?.status === 'conflict' || row.refinement?.status === 'unresolved' || row.derived || (row.confidence !== null && row.confidence < 0.9) ? 'low' : ''} ${row.refinement?.status ?? ''}`}
              >
                {row.refinement?.status === 'confirmed'
                  ? `二次确认 ${Math.round((row.confidence ?? 0.9) * 100)}%`
                  : row.refinement?.status === 'conflict'
                    ? '识别冲突，保留原值'
                    : row.refinement?.status === 'unresolved'
                      ? '二次复核仍不清晰'
                      : row.derived
                        ? '系统推导'
                        : row.confidence === null
                          ? row.source === '人工补充字段'
                            ? '人工录入'
                            : 'AI 识别'
                          : `${Math.round(row.confidence * 100)}%`}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="review-empty">{emptyText}</div>
      )}
    </section>
  );
}

function LineItemSections({
  items,
  refinements,
}: {
  items: VisionLineItem[];
  refinements: Record<string, VisionRefinementItem>;
}) {
  const groups = useMemo(() => {
    const grouped = new Map<string, VisionLineItem[]>();
    for (const item of items) {
      const section = item.section || '其他明细';
      grouped.set(section, [...(grouped.get(section) ?? []), item]);
    }
    return [...grouped.entries()];
  }, [items]);

  if (!groups.length) return null;
  return (
    <>
      {groups.map(([section, sectionItems]) =>
        /扣款|费用/.test(section) ? (
          <FeeDetailTable
            section={section}
            items={sectionItems}
            refinements={refinements}
            allItems={items}
            key={section}
          />
        ) : (
          <DetailTable
            section={section}
            items={sectionItems}
            refinements={refinements}
            allItems={items}
            key={section}
          />
        ),
      )}
    </>
  );
}

function DetailTable({
  section,
  items,
  refinements,
  allItems,
}: {
  section: string;
  items: VisionLineItem[];
  refinements: Record<string, VisionRefinementItem>;
  allItems: VisionLineItem[];
}) {
  const columns = [
    ...new Set(items.flatMap((item) => Object.keys(item.values))),
  ];
  return (
    <section className="review-section detail-section">
      <div className="section-heading">
        <div>
          <h3>{section}</h3>
          <p>来自单据明细区，保留原始行与各列数值，不参与字段映射。</p>
        </div>
        <span className="detail-count">
          <TableProperties size={15} />
          {items.length} 行
        </span>
      </div>
      <div className="detail-table-wrap">
        <table className="detail-table">
          <thead>
            <tr>
              <th>项目</th>
              {columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
              <th>来源</th>
              <th>可信度</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr
                className={`detail-row-${item.rowType ?? 'detail'}`}
                key={`${item.label}-${index}`}
              >
                <td>
                  <strong>{item.label}</strong>
                </td>
                {columns.map((column) => (
                  <td key={column}>{item.values[column] ?? '-'}</td>
                ))}
                <td>
                  <LineItemSource item={item} />
                </td>
                <td>
                  <RefinementBadge
                    item={item}
                    refinement={refinements[`line:${allItems.indexOf(item)}`]}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LineItemSource({ item }: { item: VisionLineItem }) {
  return (
    <div className="line-item-source">
      <span>第 {item.page ?? '-'} 页</span>
      {item.rawText?.trim() ? <small>原文：{item.rawText}</small> : null}
    </div>
  );
}

function FeeDetailTable({
  section,
  items,
  refinements,
  allItems,
}: {
  section: string;
  items: VisionLineItem[];
  refinements: Record<string, VisionRefinementItem>;
  allItems: VisionLineItem[];
}) {
  const columns = [
    ...new Set(items.flatMap((item) => Object.keys(item.values))),
  ];
  const groupColumn = columns.find((column) =>
    /^(分组|类别|group)$/i.test(column),
  );
  const amountColumn = columns.find((column) => /金额|amount/i.test(column));
  const groups = [
    ...new Set(
      items.map((item) =>
        String(
          groupColumn ? (item.values[groupColumn] ?? '未分组') : '全部项目',
        ),
      ),
    ),
  ];
  const amountValues = amountColumn
    ? items
        .filter((item) => !['subtotal', 'total'].includes(item.rowType ?? ''))
        .map((item) => numberValue(item.values[amountColumn]))
        .filter((value): value is number => value !== null)
    : [];
  const grandTotal = amountValues.reduce((sum, value) => sum + value, 0);
  return (
    <section className="review-section fee-section">
      <div className="section-heading">
        <div>
          <h3>{section}</h3>
          <p>
            按原单动态列展示，不限定费用字段名称；小计、合计和附加列均原样保留。
          </p>
        </div>
        <span className="detail-count">
          <TableProperties size={15} />
          {items.length} 项
        </span>
      </div>
      {groups.map((group) => {
        const groupItems = items.filter(
          (item) =>
            String(
              groupColumn ? (item.values[groupColumn] ?? '未分组') : '全部项目',
            ) === group,
        );
        const subtotalValues = amountColumn
          ? groupItems
              .filter(
                (item) => !['subtotal', 'total'].includes(item.rowType ?? ''),
              )
              .map((item) => numberValue(item.values[amountColumn]))
              .filter((value): value is number => value !== null)
          : [];
        const subtotal = subtotalValues.reduce((sum, value) => sum + value, 0);
        return (
          <div className="fee-group" key={group}>
            {(groups.length > 1 || group !== '全部项目') && (
              <div className="fee-group-heading">
                <strong>{group === '未分组' ? '未分组费用' : group}</strong>
                {subtotalValues.length > 0 && (
                  <span>识别明细小计 {formatNumber(subtotal)}</span>
                )}
              </div>
            )}
            <div className="detail-table-wrap">
              <table className="detail-table fee-table">
                <thead>
                  <tr>
                    <th>项目</th>
                    {columns.map((column) => (
                      <th key={column}>{column}</th>
                    ))}
                    <th>来源</th>
                    <th>可信度</th>
                  </tr>
                </thead>
                <tbody>
                  {groupItems.map((item, index) => (
                    <tr
                      className={`detail-row-${item.rowType ?? 'detail'}`}
                      key={`${item.label}-${index}`}
                    >
                      <td>
                        <strong>{item.label}</strong>
                      </td>
                      {columns.map((column) => {
                        const value = item.values[column];
                        const numericValue = /金额|amount/i.test(column)
                          ? numberValue(value)
                          : null;
                        return (
                          <td key={column}>
                            {value === null ||
                            value === undefined ||
                            value === ''
                              ? '-'
                              : numericValue === null
                                ? String(value)
                                : formatNumber(numericValue)}
                          </td>
                        );
                      })}
                      <td>
                        <LineItemSource item={item} />
                      </td>
                      <td>
                        <RefinementBadge
                          item={item}
                          refinement={
                            refinements[`line:${allItems.indexOf(item)}`]
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      {amountValues.length > 0 && (
        <div className="fee-grand-total">
          <span>识别明细合计</span>
          <strong>{formatNumber(grandTotal)}</strong>
        </div>
      )}
    </section>
  );
}

function RefinementBadge({
  item,
  refinement,
}: {
  item: VisionLineItem;
  refinement?: VisionRefinementItem;
}) {
  const low =
    refinement?.status === 'conflict' ||
    refinement?.status === 'unresolved' ||
    (item.confidence !== null && item.confidence < 0.9);
  const text =
    refinement?.status === 'confirmed'
      ? `二次确认 ${Math.round((refinement.confidence ?? item.confidence ?? 0.9) * 100)}%`
      : refinement?.status === 'conflict'
        ? '识别冲突'
        : refinement?.status === 'unresolved'
          ? '仍不清晰'
          : item.confidence === null
            ? '待复核'
            : `${Math.round(item.confidence * 100)}%`;
  return (
    <span
      className={`confidence ${low ? 'low' : ''} ${refinement?.status ?? ''}`}
    >
      {text}
    </span>
  );
}

const ocrFieldTargets: Partial<Record<OcrKeyFieldKey, MappingTarget>> = {
  mallName: 'mallName',
  settlementNo: 'settlementNo',
  brandMerchantName: 'brandMerchantName',
  brandName: 'brandName',
  storeCode: 'storeCode',
  settlementDate: 'settlementDate',
  documentDate: 'documentDate',
  salesQuantity: 'salesQuantity',
  salesAmount: 'salesAmount',
  invoiceAmount: 'invoiceAmount',
  deductionTotal: 'deductionTotal',
  settlementAmount: 'settlementAmount',
};

function MethodComparison({
  rows,
  ocr,
  onEvidence,
}: {
  rows: ReviewRow[];
  ocr: OcrExtractionResult;
  onEvidence: (evidence: OcrFieldEvidence) => void;
}) {
  const comparisons = Object.entries(ocrFieldTargets).flatMap(
    ([key, target]) => {
      if (!target) return [];
      const evidence = ocr.fields[key as OcrKeyFieldKey];
      if (!evidence) return [];
      const visionValue =
        rows.find((row) => row.target === target)?.value ?? '';
      const matches = Boolean(
        evidence &&
        visionValue &&
        normalizeComparable(target, visionValue) ===
          normalizeComparable(target, evidence.value),
      );
      return [{ key, target, evidence, visionValue, matches }];
    },
  );
  const conflicts = comparisons.filter((item) => !item.matches).length;
  return (
    <section className="review-section method-comparison">
      <div className="section-heading">
        <div>
          <h3>识别方法对比</h3>
          <p>
            视觉
            LLM负责业务理解，PaddleOCR提供独立文字与坐标证据；两边不一致时保留原值并进入复核。
          </p>
        </div>
        <span className={`detail-count ${conflicts ? 'has-conflict' : ''}`}>
          {ocr.pages.reduce((sum, page) => sum + page.boxes.length, 0)} 个文字框
          · {conflicts} 项冲突 · OCR {Math.round(ocr.durationMs / 1000)} 秒
        </span>
      </div>
      <div className="detail-table-wrap">
        <table className="detail-table comparison-table">
          <thead>
            <tr>
              <th>业务字段</th>
              <th>视觉 LLM</th>
              <th>PaddleOCR</th>
              <th>交叉结果</th>
              <th>证据</th>
            </tr>
          </thead>
          <tbody>
            {comparisons.map((item) => (
              <tr key={item.key}>
                <td>
                  <strong>
                    {targets.find(([target]) => target === item.target)?.[1] ??
                      item.target}
                  </strong>
                </td>
                <td>{item.visionValue || '未识别'}</td>
                <td>{item.evidence?.value ?? '未提取'}</td>
                <td>
                  <span
                    className={`confidence ${item.matches ? 'confirmed' : 'low conflict'}`}
                  >
                    {item.matches
                      ? '双路一致'
                      : item.evidence
                        ? '识别冲突'
                        : 'OCR缺失'}
                  </span>
                </td>
                <td>
                  {item.evidence ? (
                    <button
                      className="evidence-link"
                      type="button"
                      onClick={() => onEvidence(item.evidence!)}
                    >
                      第 {item.evidence.evidence.page} 页定位
                    </button>
                  ) : (
                    '-'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function hasOcrConflict(rows: ReviewRow[], ocr: OcrExtractionResult) {
  return Object.entries(ocrFieldTargets).some(([key, target]) => {
    if (!target) return false;
    const visionValue = rows.find((row) => row.target === target)?.value ?? '';
    const evidence = ocr.fields[key as OcrKeyFieldKey];
    if (!evidence || !visionValue) return false;
    return (
      normalizeComparable(target, visionValue) !==
      normalizeComparable(target, evidence.value)
    );
  });
}

function normalizeComparable(target: MappingTarget, value: string) {
  const text = String(value ?? '').trim();
  if (
    [
      'salesAmount',
      'invoiceAmount',
      'deductionTotal',
      'settlementAmount',
    ].includes(target)
  ) {
    const number = Number(text.replace(/[,，￥¥\s]/g, ''));
    return Number.isFinite(number) ? number.toFixed(2) : text;
  }
  return text.replace(/\s/g, '').toLowerCase();
}

function EvidenceViewer({
  evidence,
  imageUrl,
  page,
  onClose,
}: {
  evidence: OcrFieldEvidence;
  imageUrl: string;
  page?: OcrPageResult;
  onClose: () => void;
}) {
  if (!page) return null;
  const xs = evidence.evidence.polygon.map(([x]) => x);
  const ys = evidence.evidence.polygon.map(([, y]) => y);
  const left = (Math.min(...xs) / page.width) * 100;
  const top = (Math.min(...ys) / page.height) * 100;
  const width = ((Math.max(...xs) - Math.min(...xs)) / page.width) * 100;
  const height = ((Math.max(...ys) - Math.min(...ys)) / page.height) * 100;
  return (
    <div
      className="evidence-modal"
      role="dialog"
      aria-modal="true"
      aria-label="原单证据定位"
    >
      <div className="evidence-dialog">
        <div className="evidence-dialog-header">
          <div>
            <strong>{evidence.label}</strong>
            <span>
              OCR原文：{evidence.value} · 第 {evidence.evidence.page} 页
            </span>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭证据查看">
            <X size={19} />
          </button>
        </div>
        <div className="evidence-canvas">
          <div className="evidence-page">
            <img
              src={imageUrl}
              alt={`第 ${evidence.evidence.page} 页原始结算单`}
            />
            <span
              className="evidence-box"
              style={{
                left: `${left}%`,
                top: `${top}%`,
                width: `${width}%`,
                height: `${height}%`,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

type DynamicFormulaCheck = {
  id: string;
  label: string;
  formula: string;
  values: string;
  expected: string;
  actual: string;
  status: 'passed' | 'failed' | 'review';
  detail: string;
  source: string;
};

function ValidationPanel({
  rows,
  items,
  result,
}: {
  rows: ReviewRow[];
  items: VisionLineItem[];
  result: VisionExtractionResult;
}) {
  const formulaChecks = readDynamicFormulaChecks(result);
  const valueFor = (target: MappingTarget) =>
    numberValue(rows.find((row) => row.target === target)?.value);
  const salesItems = items.filter(
    (item) =>
      /销售|进货/.test(item.section) &&
      (!item.rowType || item.rowType === 'detail'),
  );
  const feeItems = items.filter(
    (item) =>
      /扣款|费用|费/.test(item.section) &&
      (!item.rowType || item.rowType === 'detail'),
  );
  const legacyChecks = [
    createCheck(
      '销售金额',
      sumColumn(salesItems, /销售金额/),
      valueFor('salesAmount'),
      '销售明细合计',
      '本期结算汇总',
    ),
    createCheck(
      '销售数量',
      sumColumn(salesItems, /销售数量/),
      valueFor('salesQuantity'),
      '销售明细合计',
      '本期结算汇总',
    ),
    createCheck(
      '扣款费用',
      sumColumn(feeItems, /^金额$|费用金额/),
      valueFor('deductionTotal'),
      '扣费明细合计',
      '本期结算汇总',
    ),
  ].filter((check): check is ValidationCheck => Boolean(check));

  if (!formulaChecks.length && !legacyChecks.length) return null;
  return (
    <section className="review-section validation-section">
      <div className="section-heading">
        <div>
          <h3>自动勾稽校验</h3>
          <p>
            {formulaChecks.length
              ? '按当前商场单据中识别出的公式绑定动态字段，并由程序确定性计算。'
              : '该历史结果没有动态公式，暂以通用明细合计规则提示人工复核。'}
          </p>
        </div>
        {formulaChecks.length > 0 && (
          <span className="detail-count">
            动态公式 {formulaChecks.length} 条
          </span>
        )}
      </div>
      <div className="validation-checks">
        {formulaChecks.length
          ? formulaChecks.map((check) => (
              <div
                className={`validation-check ${check.status}`}
                key={check.id}
              >
                {check.status === 'passed' ? (
                  <BadgeCheck size={18} />
                ) : (
                  <AlertTriangle size={18} />
                )}
                <div>
                  <strong>
                    {check.label}{' '}
                    {check.status === 'passed'
                      ? '一致'
                      : check.status === 'failed'
                        ? '不一致'
                        : '待复核'}
                  </strong>
                  {check.formula && (
                    <small className="formula-expression">
                      公式：{check.formula}
                    </small>
                  )}
                  {check.values && <small>代入值：{check.values}</small>}
                  {(check.expected || check.actual) && (
                    <small>
                      单据值：{check.expected || '-'}；计算值：
                      {check.actual || '-'}
                    </small>
                  )}
                  {check.detail && <small>{check.detail}</small>}
                  {check.source && (
                    <small className="formula-source">
                      证据：{check.source}
                    </small>
                  )}
                </div>
              </div>
            ))
          : legacyChecks.map((check) => (
              <div
                className={
                  check.passed
                    ? 'validation-check passed'
                    : 'validation-check failed'
                }
                key={check.label}
              >
                {check.passed ? (
                  <BadgeCheck size={18} />
                ) : (
                  <AlertTriangle size={18} />
                )}
                <div>
                  <strong>
                    {check.label} {check.passed ? '一致' : '不一致'}
                  </strong>
                  <small>
                    {check.leftLabel} {formatNumber(check.left)}；
                    {check.rightLabel} {formatNumber(check.right)}
                  </small>
                </div>
              </div>
            ))}
      </div>
    </section>
  );
}

type ValidationCheck = {
  label: string;
  left: number;
  right: number;
  leftLabel: string;
  rightLabel: string;
  passed: boolean;
};

function readDynamicFormulaChecks(
  result: VisionExtractionResult,
): DynamicFormulaCheck[] {
  const extraction = result as unknown as Record<string, unknown>;
  const dynamicLabels = new Map(
    (result.dynamicFields ?? []).map((field) => [field.id, field.label]),
  );
  const container = extraction.formulaChecks;
  const candidates = Array.isArray(container)
    ? container
    : isRecord(container)
      ? firstArray(
          container.checks,
          container.formulas,
          container.validations,
          container.results,
        )
      : firstArray(
          extraction.formulas,
          extraction.validationChecks,
          extraction.validations,
        );
  if (!candidates) return [];

  return candidates.flatMap((candidate, index) => {
    if (!isRecord(candidate)) return [];
    const validation = isRecord(candidate.validation)
      ? candidate.validation
      : isRecord(candidate.result)
        ? candidate.result
        : {};
    const fieldValues = isRecord(candidate.fieldValues)
      ? candidate.fieldValues
      : isRecord(candidate.operands)
        ? candidate.operands
        : {};
    const label =
      firstText(candidate.label, candidate.name, candidate.title) ||
      `动态公式 ${index + 1}`;
    const formulaValue =
      candidate.expression ?? candidate.formula ?? candidate.equation;
    const formula =
      typeof formulaValue === 'string'
        ? formulaValue
        : isRecord(formulaValue)
          ? formatFormulaNode(formulaValue, dynamicLabels)
          : '';
    const expected = displayFormulaValue(
      candidate.expectedValue ??
        validation.expected ??
        candidate.documentValue ??
        candidate.expected,
    );
    const actual = displayFormulaValue(
      candidate.actualValue ??
        candidate.computedValue ??
        validation.computed ??
        candidate.actual ??
        candidate.computed,
    );
    const passValue =
      candidate.pass ??
      candidate.passed ??
      validation.pass ??
      validation.passed;
    const statusText = firstText(
      candidate.status,
      validation.status,
    ).toLowerCase();
    const status: DynamicFormulaCheck['status'] =
      /review|pending|待复核|推导/.test(statusText)
        ? 'review'
        : /fail|invalid|mismatch|不一致|失败/.test(statusText)
          ? 'failed'
          : /pass|success|一致|通过/.test(statusText)
            ? 'passed'
            : typeof passValue === 'boolean'
              ? passValue
                ? 'passed'
                : 'failed'
              : 'review';
    const issues = [
      candidate.message,
      validation.message,
      candidate.issues,
      validation.issues,
    ]
      .flatMap((value) =>
        Array.isArray(value)
          ? value
          : value === undefined || value === null
            ? []
            : [value],
      )
      .map(displayFormulaValue)
      .filter(Boolean)
      .join('；');
    const missingRefs = [candidate.missingRefs, validation.missingRefs]
      .flatMap((value) => (Array.isArray(value) ? value : []))
      .map(displayFormulaValue)
      .filter(Boolean);
    const sourceText = firstText(
      candidate.sourceText,
      candidate.evidenceText,
      candidate.rawText,
    );
    const page = displayFormulaValue(candidate.page);
    return [
      {
        id: firstText(candidate.id) || `formula:${index}`,
        label,
        formula,
        values: Object.entries(fieldValues)
          .map(
            ([key, value]) =>
              `${dynamicLabels.get(key) ?? key}=${displayFormulaValue(value)}`,
          )
          .join('，'),
        expected,
        actual,
        status,
        detail: [
          issues,
          missingRefs.length ? `缺少字段：${missingRefs.join('、')}` : '',
        ]
          .filter(Boolean)
          .join('；'),
        source: [page ? `第 ${page} 页` : '', sourceText]
          .filter(Boolean)
          .join(' · '),
      },
    ];
  });
}

function formatFormulaNode(
  node: Record<string, unknown>,
  labels: Map<string, string>,
): string {
  const type = firstText(node.type);
  if (type === 'literal') return displayFormulaValue(node.value);
  if (type === 'ref') {
    const fieldId = firstText(node.fieldId, node.id);
    return (
      firstText(node.label) || labels.get(fieldId) || fieldId || '未知字段'
    );
  }
  if (type === 'sum') {
    const operands = Array.isArray(node.operands) ? node.operands : [];
    return operands
      .map((operand) =>
        isRecord(operand)
          ? formatFormulaNode(operand, labels)
          : displayFormulaValue(operand),
      )
      .join(' + ');
  }
  if (['add', 'subtract', 'multiply', 'divide'].includes(type)) {
    const operator =
      { add: '+', subtract: '-', multiply: '×', divide: '÷' }[type] ?? type;
    const left = isRecord(node.left)
      ? formatFormulaNode(node.left, labels)
      : displayFormulaValue(node.left);
    const right = isRecord(node.right)
      ? formatFormulaNode(node.right, labels)
      : displayFormulaValue(node.right);
    return `(${left} ${operator} ${right})`;
  }
  if (type === 'round') {
    const operand = isRecord(node.operand)
      ? formatFormulaNode(node.operand, labels)
      : displayFormulaValue(node.operand);
    return `ROUND(${operand}, ${displayFormulaValue(node.decimals ?? 2)})`;
  }
  return displayFormulaValue(node.expression ?? node.label ?? node);
}

function firstArray(...values: unknown[]): unknown[] | null {
  return (values.find(Array.isArray) as unknown[] | undefined) ?? null;
}

function firstText(...values: unknown[]): string {
  const value = values.find((item) => typeof item === 'string' && item.trim());
  return typeof value === 'string' ? value.trim() : '';
}

function displayFormulaValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return String(value);
  if (Array.isArray(value))
    return value.map(displayFormulaValue).filter(Boolean).join('、');
  if (isRecord(value)) {
    const message = firstText(value.message, value.code, value.label);
    if (message) return message;
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createCheck(
  label: string,
  left: number | null,
  right: number | null,
  leftLabel: string,
  rightLabel: string,
): ValidationCheck | null {
  if (left === null || right === null) return null;
  return {
    label,
    left,
    right,
    leftLabel,
    rightLabel,
    passed: Math.abs(left - right) <= 0.01,
  };
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/[,，￥¥\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function sumColumn(
  items: VisionLineItem[],
  columnPattern: RegExp,
): number | null {
  const values = items.flatMap((item) =>
    Object.entries(item.values)
      .filter(([column]) => columnPattern.test(column))
      .map(([, value]) => numberValue(value))
      .filter((value): value is number => value !== null),
  );
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
