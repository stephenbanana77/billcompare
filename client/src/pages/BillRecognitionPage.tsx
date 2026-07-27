import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  Check,
  FileSearch,
  LoaderCircle,
  Plus,
  TableProperties,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  VisionAdditionalField,
  VisionExtractionResult,
  VisionFieldKey,
  VisionLineItem,
  VisionRefinementItem,
  OcrExtractionResult,
  OcrFieldEvidence,
  OcrKeyFieldKey,
  OcrPageResult,
} from '@shared/reconciliation';
import { reconciliationApi } from '@/api';
import { renderPdfPagesForVision, renderPdfTilesForVision } from '@/lib/workbook';
import { collectVisionRefinementCandidates, indexVisionRefinements } from '@shared/vision-refinement';

type MappingTarget =
  | ''
  | 'mallName'
  | 'brandName'
  | 'brandMerchantName'
  | 'storeCode'
  | 'settlementNo'
  | 'salesQuantity'
  | 'taxAmount'
  | 'netPurchaseAmount'
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
  ['mallName', '商场名称'],
  ['brandName', '品牌 / 门店'],
  ['brandMerchantName', '品牌商 / 供货单位'],
  ['storeCode', '柜号 / 门店编码'],
  ['settlementNo', '结算单号'],
  ['salesQuantity', '销售数量'],
  ['taxAmount', '税额'],
  ['netPurchaseAmount', '不含税进价'],
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
  const additionalTargets = new Set<MappingTarget>([
    'businessMode', 'counterLocation', 'productCategory', 'settlementDate', 'documentDate', 'printSequence', 'previousBalance',
  ]);
  return {
    id: `additional:${index}`,
    source: field.rawText || `${field.label}${field.value === null ? '' : `：${field.value}`}`,
    evidence: `第 ${field.page ?? '-'} 页 · ${field.group === 'summary' ? '汇总区' : field.group === 'fee' ? '费用区' : '原始字段'}`,
    confidence: field.confidence,
    target,
    value: field.value === null ? '' : String(field.value),
    group: additionalTargets.has(target)
      ? 'additional'
      : target
        ? (field.group === 'summary' ? 'summary' : 'basic')
        : 'unmapped',
  };
}

function mergeFeeLineItems(result: VisionExtractionResult): VisionLineItem[] {
  const items = [...result.lineItems];
  const feeKey = (label: string, value: string | number | null) =>
    `${label.replace(/\s/g, '').replace(/[~～-]\d{4}\s*$/, '')}|${String(value ?? '').replace(/[,，\s]/g, '')}`;
  const existing = new Set(items.map((item) => feeKey(
    item.label,
    item.values['金额'] ?? item.values['费用金额'] ?? null,
  )));

  for (const field of result.additionalFields.filter((item) => item.group === 'fee')) {
    const normalizedLabel = field.label.replace(/[~～-]\d{4}\s*$/, '').trim();
    if (!normalizedLabel || field.value === null || field.value === '') continue;
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
  if (knownTargets.has(field.suggestedTarget as MappingTarget)) {
    return field.suggestedTarget as MappingTarget;
  }
  const label = field.label.replace(/\s/g, '');
  if (/^品牌$|品牌名称/.test(label)) return 'brandName';
  if (/品牌商|供货单位|供应商/.test(label)) return 'brandMerchantName';
  if (/^商场$|柜场|楼层场地|经营场景/.test(label)) return 'counterLocation';
  if (/经营方式|结算方式|联销方式/.test(label)) return 'businessMode';
  if (/商品大类|品类|商品类别/.test(label)) return 'productCategory';
  if (/结算日期/.test(label)) return 'settlementDate';
  if (/制单日期|开单日期/.test(label)) return 'documentDate';
  if (/打印流水号|打印序号|页码流水/.test(label)) return 'printSequence';
  if (/上期结算|上期余额|期初余额/.test(label)) return 'previousBalance';
  return '';
}

function buildReviewRows(result: VisionExtractionResult): ReviewRow[] {
  const periodSource = result.periodEvidence.rawText;
  const periodIsExplicit = result.periodEvidence.kind === 'explicit_range';
  const metadataRows = [
    metadataRow('商场名称', result.metadata.mallName, 'mallName', 'AI 从单据页眉识别'),
    metadataRow('品牌 / 门店', result.metadata.storeName, 'brandName', 'AI 从单据页眉识别'),
    metadataRow('柜号 / 门店编码', result.metadata.storeCode, 'storeCode', 'AI 从单据页眉识别'),
    metadataRow(
      periodSource || '未返回账期原文',
      result.metadata.periodStart,
      'periodStart',
      periodIsExplicit ? `第 ${result.periodEvidence.page ?? '-'} 页 · 原文日期范围` : 'PDF 未显示 5 月 1 日；系统按结算月份推导当月首日',
      !periodIsExplicit,
    ),
    metadataRow(
      periodSource || '未返回账期原文',
      result.metadata.periodEnd,
      'periodEnd',
      periodIsExplicit ? `第 ${result.periodEvidence.page ?? '-'} 页 · 原文日期范围` : '系统按结算月份推导当月末日，并与结算日期交叉核对',
      !periodIsExplicit,
    ),
  ];
  const amountRows = (Object.entries(result.evidence) as Array<
    [VisionFieldKey, NonNullable<VisionExtractionResult['evidence'][VisionFieldKey]>]
  >)
    .filter(([key, evidence]) => !['periodStart', 'periodEnd'].includes(key) && (evidence?.rawText || evidence?.value !== null))
    .map(([key, evidence]): ReviewRow => ({
      id: `field:${key}`,
      source: evidence.rawText || fieldNames[key],
      evidence: `第 ${evidence.page ?? '-'} 页 · 结算汇总区`,
      confidence: evidence.confidence,
      target: key as MappingTarget,
      value: evidence.value === null ? '' : String(evidence.value),
      group: 'summary',
    }));
  const occupiedTargets = new Set<MappingTarget>([
    ...metadataRows.map((row) => row.target),
    ...amountRows.map((row) => row.target),
  ]);
  const additionalRows: ReviewRow[] = [];
  for (const row of result.additionalFields
    .filter((field) => field.group !== 'fee')
    .map(additionalRow)) {
    if (row.target && occupiedTargets.has(row.target)) continue;
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

export default function BillRecognitionPage() {
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<VisionExtractionResult | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [recognizing, setRecognizing] = useState(false);
  const [refining, setRefining] = useState(false);
  const [refinements, setRefinements] = useState<Record<string, VisionRefinementItem>>({});
  const [ocrResult, setOcrResult] = useState<OcrExtractionResult | null>(null);
  const [pageImages, setPageImages] = useState<string[]>([]);
  const [selectedEvidence, setSelectedEvidence] = useState<OcrFieldEvidence | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [recognitionStage, setRecognitionStage] = useState('等待上传');
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const mapped = useMemo(
    () => Object.fromEntries(rows.filter((row) => row.target).map((row) => [row.target, row.value])),
    [rows],
  );
  const displayLineItems = useMemo(() => result ? mergeFeeLineItems(result) : [], [result]);
  const needsReview = Boolean(
    result?.warnings.length || rows.some((row) => row.derived || (row.confidence !== null && row.confidence < 0.9)),
  );
  const ocrBlocksConfirmation = Boolean(ocrResult && hasOcrBlockingIssue(rows, ocrResult));

  const recognize = async (file?: File) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      toast.error('请上传 PDF 格式的商场结算单。');
      return;
    }
    setRecognizing(true);
    setRefining(false);
    setRefinements({});
    setOcrResult(null);
    pageImages.forEach((url) => URL.revokeObjectURL(url));
    setConfirmed(false);
    try {
      setRecognitionStage('正在渲染单据页面');
      const pages = await renderPdfPagesForVision(file);
      setPageImages(pages.map((page) => URL.createObjectURL(page)));
      setRecognitionStage('正在进行视觉识别和 OCR 校验，通常需要 1-2 分钟');
      const [visionAttempt, ocrAttempt] = await Promise.allSettled([
        reconciliationApi.extractVisionBill(file.name, pages),
        reconciliationApi.extractOcrBill(pages),
      ]);
      if (visionAttempt.status === 'rejected') {
        if (ocrAttempt.status === 'fulfilled') {
          setOcrResult(ocrAttempt.value);
          setRecognitionStage('视觉识别失败，OCR 已完成，请稍后重试视觉识别');
          toast.error('视觉识别未完成，但 OCR 已返回。请保留原文件并重试。');
          return;
        }
        throw visionAttempt.reason;
      }
      const extraction = visionAttempt.value;
      const ocr = ocrAttempt.status === 'fulfilled' ? ocrAttempt.value : null;
      if (!ocr) toast.warning('OCR 校验未完成，结果必须人工复核后才能确认。');
      setFileName(extraction.fileName);
      setResult(extraction);
      setOcrResult(ocr);
      setRows(buildReviewRows(extraction));
      setRecognitionStage('识别完成，正在检查金额和证据');
      const candidates = collectVisionRefinementCandidates(extraction);
      if (candidates.length) {
        setRefining(true);
        try {
          const tiles = await renderPdfTilesForVision(
            file,
            candidates.flatMap((candidate) => candidate.page === null ? [] : [candidate.page]),
          );
          const refinementResult = await reconciliationApi.refineVisionBill(candidates, tiles);
          const indexed = indexVisionRefinements(refinementResult);
          setRefinements(indexed);
          setRows((current) => current.map((row) => indexed[row.id]
            ? {
                ...row,
                refinement: indexed[row.id],
                confidence: indexed[row.id].status === 'confirmed'
                  ? Math.max(row.confidence ?? 0, indexed[row.id].confidence ?? 0.9)
                  : row.confidence,
              }
            : row));
        } catch (error) {
          toast.warning(error instanceof Error ? `二次复核未完成：${error.message}` : '低置信字段二次复核未完成。');
        } finally {
          setRefining(false);
        }
      }
      toast.success('AI 已完成结构化识别，请复核推导字段、汇总金额和明细表。');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '视觉识别失败，请重试。');
    } finally {
      setRecognizing(false);
    }
  };

  const saveReview = () => {
    if (!result || !fileName) return;
    const record = { fileName, result, rows, ocrResult, confirmed, savedAt: new Date().toISOString() };
    localStorage.setItem(`reconciliation-review:${fileName}`, JSON.stringify(record));
    setSavedAt(record.savedAt);
    toast.success('复核结果已保存在当前浏览器。');
  };

  const exportReview = () => {
    if (!result || !fileName) return;
    const record = { fileName, result, rows, ocrResult, confirmed, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${fileName.replace(/\.pdf$/i, '')}-review.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const update = (id: string, patch: Partial<ReviewRow>) =>
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  return (
    <div className="page-stack recognition-page">
      <section className="recognition-hero">
        <div>
          <p className="eyebrow">视觉智能识别</p>
          <h2>结算单智能识别</h2>
          <p>上传扫描版结算单，复核单据原文、汇总金额与明细后，再进入 ERP 对账。</p>
        </div>
        <label className="button primary recognition-upload">
          {recognizing ? <LoaderCircle className="spin" size={17} /> : <Upload size={17} />}
          {recognizing ? '正在识别' : '上传结算单'}
          <input type="file" accept=".pdf,application/pdf" disabled={recognizing} onChange={(event) => recognize(event.target.files?.[0])} />
        </label>
      </section>

      {!fileName && (
        <section className="recognition-empty">
          <FileSearch size={30} />
          <h3>上传一份商场结算单开始识别</h3>
          <p>识别结果不会直接入账。系统会区分原文值、推导值、汇总数据和明细数据。</p>
        </section>
      )}

      {fileName && result && !confirmed && (
        <>
          <section className="recognition-status">
            <span className="status-icon"><FileSearch size={19} /></span>
            <div><strong>{fileName}</strong><p>{recognitionStage}</p></div>
            <span className="waiting-badge">{refining ? '低置信字段二次复核中' : '待人工复核'}</span>
          </section>

          <FieldSection title="单据基础信息" description="页眉、主体与账期。系统推导值会明确标识。" rows={rows.filter((row) => row.group === 'basic')} onUpdate={update} />
          <FieldSection title="本期结算汇总" description="仅使用结算汇总区域直接打印的金额作为对账主值。" rows={rows.filter((row) => row.group === 'summary')} onUpdate={update} />

          {ocrResult && (
            <MethodComparison
              rows={rows}
              ocr={ocrResult}
              onEvidence={setSelectedEvidence}
            />
          )}

          <LineItemSections items={displayLineItems} refinements={refinements} />
          <ValidationPanel rows={rows} items={displayLineItems} />

          <AttributeSection rows={rows.filter((row) => row.group === 'additional')} />

          {rows.some((row) => row.group === 'unmapped') && (
            <FieldSection
              title="待确认字段"
              description="仅保留模型无法判断业务语义的字段；不参与 ERP 对账的字段不会阻塞确认。"
              rows={rows.filter((row) => row.group === 'unmapped')}
              onUpdate={update}
              action={<button className="button secondary" onClick={() => setRows((current) => [...current, emptyRow()])}><Plus size={16} />补充字段</button>}
            />
          )}

          <section className={`recognition-review ${needsReview ? 'review' : 'ready'}`}>
            {needsReview ? <AlertTriangle size={20} /> : <BadgeCheck size={20} />}
            <div>
              <strong>{needsReview ? '存在推导值或待复核项' : '识别结果可确认'}</strong>
              <p>{result.warnings[0] ?? '请核对原单后确认；确认结果将作为后续 ERP 对账依据。'}</p>
            </div>
            <button className="button primary" disabled={refining || ocrBlocksConfirmation} onClick={() => { setConfirmed(true); saveReview(); toast.success('结算单已确认，等待 ERP 数据对账。'); }}><Check size={16} />确认结算单</button>
            <button className="button secondary" type="button" onClick={saveReview}>保存复核结果</button>
            <button className="button secondary" type="button" onClick={exportReview}>导出 JSON</button>
            {savedAt && <small>已保存：{new Date(savedAt).toLocaleString()}</small>}
          </section>
        </>
      )}

      {fileName && confirmed && (
        <section className="confirmed-result">
          <div className="confirmed-heading"><BadgeCheck size={23} /><div><h3>结算单已确认</h3><p>{fileName} 已完成结构化复核，等待同账期 ERP 数据。</p></div><span className="waiting-badge">待 ERP 对账</span></div>
          <div className="confirmed-grid">
            {Object.entries(mapped).map(([target, value]) => <div key={target}><span>{targets.find(([key]) => key === target)?.[1]}</span><strong>{value}</strong></div>)}
          </div>
        </section>
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

function FieldSection({ title, description, rows, onUpdate, action, emptyText }: {
  title: string;
  description: string;
  rows: ReviewRow[];
  onUpdate: (id: string, patch: Partial<ReviewRow>) => void;
  action?: React.ReactNode;
  emptyText?: string;
}) {
  return (
    <section className="review-section">
      <div className="section-heading">
        <div><h3>{title}</h3><p>{description}</p></div>
        {action}
      </div>
      {rows.length ? (
        <div className="mapping-table" role="table" aria-label={title}>
          <div className="mapping-row mapping-header" role="row"><span>单据原文 / 来源</span><span>业务字段</span><span>复核确认值</span><span>状态</span></div>
          {rows.map((row) => (
            <div className="mapping-row" role="row" key={row.id}>
              <div><strong>{row.source || '未识别'}</strong><small>{row.evidence}</small></div>
              <select aria-label={`${row.source}的业务字段`} value={row.target} onChange={(event) => onUpdate(row.id, { target: event.target.value as MappingTarget })}>
                {targets.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
              <input aria-label={`${row.source}的确认值`} value={row.value} placeholder="录入或修正字段值" onChange={(event) => onUpdate(row.id, { value: event.target.value })} />
              <span className={`confidence ${row.refinement?.status === 'conflict' || row.refinement?.status === 'unresolved' || row.derived || (row.confidence !== null && row.confidence < 0.9) ? 'low' : ''} ${row.refinement?.status ?? ''}`}>
                {row.refinement?.status === 'confirmed'
                  ? `二次确认 ${Math.round((row.confidence ?? 0.9) * 100)}%`
                  : row.refinement?.status === 'conflict'
                    ? '识别冲突，保留原值'
                    : row.refinement?.status === 'unresolved'
                      ? '二次复核仍不清晰'
                      : row.derived ? '系统推导' : row.confidence === null ? (row.source === '人工补充字段' ? '人工录入' : 'AI 识别') : `${Math.round(row.confidence * 100)}%`}
              </span>
            </div>
          ))}
        </div>
      ) : <div className="review-empty">{emptyText}</div>}
    </section>
  );
}

function LineItemSections({ items, refinements }: { items: VisionLineItem[]; refinements: Record<string, VisionRefinementItem> }) {
  const groups = useMemo(() => {
    const grouped = new Map<string, VisionLineItem[]>();
    for (const item of items) {
      const section = item.section || '其他明细';
      grouped.set(section, [...(grouped.get(section) ?? []), item]);
    }
    return [...grouped.entries()];
  }, [items]);

  if (!groups.length) return null;
  return <>{groups.map(([section, sectionItems]) =>
    /扣款|费用/.test(section)
      ? <FeeDetailTable section={section} items={sectionItems} refinements={refinements} allItems={items} key={section} />
      : <DetailTable section={section} items={sectionItems} refinements={refinements} allItems={items} key={section} />,
  )}</>;
}

function DetailTable({ section, items, refinements, allItems }: { section: string; items: VisionLineItem[]; refinements: Record<string, VisionRefinementItem>; allItems: VisionLineItem[] }) {
  const columns = [...new Set(items.flatMap((item) => Object.keys(item.values)))];
  return (
    <section className="review-section detail-section">
      <div className="section-heading">
        <div><h3>{section}</h3><p>来自单据明细区，保留原始行与各列数值，不参与字段映射。</p></div>
        <span className="detail-count"><TableProperties size={15} />{items.length} 行</span>
      </div>
      <div className="detail-table-wrap">
        <table className="detail-table">
          <thead><tr><th>项目</th>{columns.map((column) => <th key={column}>{column}</th>)}<th>来源</th><th>可信度</th></tr></thead>
          <tbody>{items.map((item, index) => (
            <tr className={`detail-row-${item.rowType ?? 'detail'}`} key={`${item.label}-${index}`}>
              <td><strong>{item.label}</strong></td>
              {columns.map((column) => <td key={column}>{item.values[column] ?? '-'}</td>)}
              <td>第 {item.page ?? '-'} 页</td>
              <td><RefinementBadge item={item} refinement={refinements[`line:${allItems.indexOf(item)}`]} /></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  );
}

function FeeDetailTable({ section, items, refinements, allItems }: { section: string; items: VisionLineItem[]; refinements: Record<string, VisionRefinementItem>; allItems: VisionLineItem[] }) {
  const detailItems = items.filter((item) => !['subtotal', 'total'].includes(item.rowType ?? ''));
  const groups = [...new Set(detailItems.map((item) => String(item.values['分组'] ?? '未分组')))];
  const grandTotal = detailItems.reduce((sum, item) => sum + (numberValue(item.values['金额']) ?? 0), 0);
  return (
    <section className="review-section fee-section">
      <div className="section-heading">
        <div><h3>{section}</h3><p>按原单分组展示，每个费用项目独立成行并自动计算小计。</p></div>
        <span className="detail-count"><TableProperties size={15} />{detailItems.length} 项</span>
      </div>
      {groups.map((group) => {
        const groupItems = detailItems.filter((item) => String(item.values['分组'] ?? '未分组') === group);
        const subtotal = groupItems.reduce((sum, item) => sum + (numberValue(item.values['金额']) ?? 0), 0);
        return (
          <div className="fee-group" key={group}>
            <div className="fee-group-heading"><strong>{group === '未分组' ? '未分组费用' : `${group} 类费用`}</strong><span>小计 {formatNumber(subtotal)}</span></div>
            <div className="detail-table-wrap">
              <table className="detail-table fee-table">
                <thead><tr><th>费用项目</th><th>费用代码</th><th>金额</th><th>来源</th><th>可信度</th></tr></thead>
                <tbody>{groupItems.map((item, index) => (
                  <tr key={`${item.label}-${index}`}>
                    <td><strong>{item.label.replace(/[~～-]\d{4}/, '')}</strong></td>
                    <td>{item.values['费用代码'] ?? '-'}</td>
                    <td>{formatNumber(numberValue(item.values['金额']) ?? 0)}</td>
                    <td>第 {item.page ?? '-'} 页</td>
                    <td><RefinementBadge item={item} refinement={refinements[`line:${allItems.indexOf(item)}`]} /></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        );
      })}
      <div className="fee-grand-total"><span>扣款费用明细合计</span><strong>{formatNumber(grandTotal)}</strong></div>
    </section>
  );
}

function RefinementBadge({ item, refinement }: { item: VisionLineItem; refinement?: VisionRefinementItem }) {
  const low = refinement?.status === 'conflict' || refinement?.status === 'unresolved' || (item.confidence !== null && item.confidence < 0.9);
  const text = refinement?.status === 'confirmed'
    ? `二次确认 ${Math.round((refinement.confidence ?? item.confidence ?? 0.9) * 100)}%`
    : refinement?.status === 'conflict'
      ? '识别冲突'
      : refinement?.status === 'unresolved'
        ? '仍不清晰'
        : item.confidence === null ? '待复核' : `${Math.round(item.confidence * 100)}%`;
  return <span className={`confidence ${low ? 'low' : ''} ${refinement?.status ?? ''}`}>{text}</span>;
}

function AttributeSection({ rows }: { rows: ReviewRow[] }) {
  if (!rows.length) return null;
  return (
    <section className="review-section attribute-section">
      <div className="section-heading"><div><h3>单据附加信息</h3><p>已自动归类，仅用于单据档案与检索，不要求人工映射到 ERP。</p></div></div>
      <div className="attribute-grid">
        {rows.map((row) => (
          <div key={row.id}>
            <span>{targets.find(([target]) => target === row.target)?.[1] ?? row.source}</span>
            <strong>{row.value || '-'}</strong>
            <small>{row.evidence} · {row.confidence === null ? '待复核' : `${Math.round(row.confidence * 100)}%`}</small>
          </div>
        ))}
      </div>
    </section>
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

function MethodComparison({ rows, ocr, onEvidence }: {
  rows: ReviewRow[];
  ocr: OcrExtractionResult;
  onEvidence: (evidence: OcrFieldEvidence) => void;
}) {
  const comparisons = Object.entries(ocrFieldTargets).flatMap(([key, target]) => {
    if (!target) return [];
    const evidence = ocr.fields[key as OcrKeyFieldKey];
    const visionValue = rows.find((row) => row.target === target)?.value ?? '';
    const matches = Boolean(evidence && visionValue && normalizeComparable(target, visionValue) === normalizeComparable(target, evidence.value));
    return [{ key, target, evidence, visionValue, matches }];
  });
  const conflicts = comparisons.filter((item) => !item.matches).length;
  return (
    <section className="review-section method-comparison">
      <div className="section-heading">
        <div>
          <h3>识别方法对比</h3>
          <p>视觉 LLM负责业务理解，PaddleOCR提供独立文字与坐标证据；两边不一致时保留原值并进入复核。</p>
        </div>
        <span className={`detail-count ${conflicts ? 'has-conflict' : ''}`}>
          {ocr.pages.reduce((sum, page) => sum + page.boxes.length, 0)} 个文字框 · {conflicts} 项冲突 · OCR {Math.round(ocr.durationMs / 1000)} 秒
        </span>
      </div>
      <div className="detail-table-wrap">
        <table className="detail-table comparison-table">
          <thead><tr><th>业务字段</th><th>视觉 LLM</th><th>PaddleOCR</th><th>交叉结果</th><th>证据</th></tr></thead>
          <tbody>{comparisons.map((item) => (
            <tr key={item.key}>
              <td><strong>{targets.find(([target]) => target === item.target)?.[1] ?? item.target}</strong></td>
              <td>{item.visionValue || '未识别'}</td>
              <td>{item.evidence?.value ?? '未提取'}</td>
              <td><span className={`confidence ${item.matches ? 'confirmed' : 'low conflict'}`}>{item.matches ? '双路一致' : item.evidence ? '识别冲突' : 'OCR缺失'}</span></td>
              <td>{item.evidence ? <button className="evidence-link" type="button" onClick={() => onEvidence(item.evidence!)}>第 {item.evidence.evidence.page} 页定位</button> : '-'}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  );
}

function hasOcrBlockingIssue(rows: ReviewRow[], ocr: OcrExtractionResult) {
  return Object.entries(ocrFieldTargets).some(([key, target]) => {
    if (!target) return false;
    const visionValue = rows.find((row) => row.target === target)?.value ?? '';
    const evidence = ocr.fields[key as OcrKeyFieldKey];
    return !evidence || !visionValue || normalizeComparable(target, visionValue) !== normalizeComparable(target, evidence.value);
  });
}

function normalizeComparable(target: MappingTarget, value: string) {
  const text = String(value ?? '').trim();
  if (['salesAmount', 'invoiceAmount', 'deductionTotal', 'settlementAmount'].includes(target)) {
    const number = Number(text.replace(/[,，￥¥\s]/g, ''));
    return Number.isFinite(number) ? number.toFixed(2) : text;
  }
  return text.replace(/\s/g, '').toLowerCase();
}

function EvidenceViewer({ evidence, imageUrl, page, onClose }: {
  evidence: OcrFieldEvidence;
  imageUrl: string;
  page?: OcrPageResult;
  onClose: () => void;
}) {
  if (!page) return null;
  const xs = evidence.evidence.polygon.map(([x]) => x);
  const ys = evidence.evidence.polygon.map(([, y]) => y);
  const left = Math.min(...xs) / page.width * 100;
  const top = Math.min(...ys) / page.height * 100;
  const width = (Math.max(...xs) - Math.min(...xs)) / page.width * 100;
  const height = (Math.max(...ys) - Math.min(...ys)) / page.height * 100;
  return (
    <div className="evidence-modal" role="dialog" aria-modal="true" aria-label="原单证据定位">
      <div className="evidence-dialog">
        <div className="evidence-dialog-header">
          <div><strong>{evidence.label}</strong><span>OCR原文：{evidence.value} · 第 {evidence.evidence.page} 页</span></div>
          <button type="button" onClick={onClose} aria-label="关闭证据查看"><X size={19} /></button>
        </div>
        <div className="evidence-canvas">
          <div className="evidence-page">
            <img src={imageUrl} alt={`第 ${evidence.evidence.page} 页原始结算单`} />
            <span className="evidence-box" style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ValidationPanel({ rows, items }: { rows: ReviewRow[]; items: VisionLineItem[] }) {
  const valueFor = (target: MappingTarget) => numberValue(rows.find((row) => row.target === target)?.value);
  const salesItems = items.filter((item) => /销售|进货/.test(item.section) && (!item.rowType || item.rowType === 'detail'));
  const feeItems = items.filter((item) => /扣款|费用|费/.test(item.section) && (!item.rowType || item.rowType === 'detail'));
  const checks = [
    createCheck('销售金额', sumColumn(salesItems, /销售金额/), valueFor('salesAmount'), '销售明细合计', '本期结算汇总'),
    createCheck('销售数量', sumColumn(salesItems, /销售数量/), valueFor('salesQuantity'), '销售明细合计', '本期结算汇总'),
    createCheck('扣款费用', sumColumn(feeItems, /^金额$|费用金额/), valueFor('deductionTotal'), '扣费明细合计', '本期结算汇总'),
    createCheck(
      '实付金额',
      subtract(valueFor('invoiceAmount'), valueFor('deductionTotal')),
      valueFor('settlementAmount'),
      '发票金额 - 扣款费用',
      '本期结算汇总',
    ),
  ].filter((check): check is ValidationCheck => Boolean(check));

  if (!checks.length) return null;
  return (
    <section className="review-section validation-section">
      <div className="section-heading"><div><h3>自动勾稽校验</h3><p>用明细合计反向验证汇总值；不一致时阻断自动确认。</p></div></div>
      <div className="validation-checks">
        {checks.map((check) => (
          <div className={check.passed ? 'validation-check passed' : 'validation-check failed'} key={check.label}>
            {check.passed ? <BadgeCheck size={18} /> : <AlertTriangle size={18} />}
            <div><strong>{check.label} {check.passed ? '一致' : '不一致'}</strong><small>{check.leftLabel} {formatNumber(check.left)}；{check.rightLabel} {formatNumber(check.right)}</small></div>
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

function createCheck(label: string, left: number | null, right: number | null, leftLabel: string, rightLabel: string): ValidationCheck | null {
  if (left === null || right === null) return null;
  return { label, left, right, leftLabel, rightLabel, passed: Math.abs(left - right) <= 0.01 };
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/[,，￥¥\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function sumColumn(items: VisionLineItem[], columnPattern: RegExp): number | null {
  const values = items.flatMap((item) =>
    Object.entries(item.values)
      .filter(([column]) => columnPattern.test(column))
      .map(([, value]) => numberValue(value))
      .filter((value): value is number => value !== null),
  );
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function subtract(left: number | null, right: number | null) {
  return left === null || right === null ? null : left - right;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}
