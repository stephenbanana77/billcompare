import * as XLSX from 'xlsx';
import type { VisionExtractionResult } from '@shared/reconciliation';

export type WorkbookRow = Record<string, string | number | boolean | null>;

export type FileProfile = {
  fileName: string;
  sheetName: string;
  headers: string[];
  rows: WorkbookRow[];
  sourceType: 'spreadsheet' | 'pdf' | 'vision_llm';
};

const dateHeaderPattern =
  /日期|账期|开始|结束|起日|止日|记账日|businessdate|periodfrom|periodto|date/i;

const aliases: Record<string, string[]> = {
  mallName: [
    '商场名称',
    '项目商场',
    '项目门店',
    'mall',
    'mallname',
    'shoppingmall',
  ],
  storeName: [
    '门店名称',
    '店铺名称',
    '专柜名称',
    '店名',
    'storename',
    'shopname',
  ],
  storeCode: [
    '门店编码',
    '店铺编码',
    '内部柜号',
    '组织代码',
    'storecode',
    'shopcode',
    'outletcode',
  ],
  periodStart: [
    '账期开始',
    '结算开始',
    '结算起日',
    'periodfrom',
    'periodstart',
    'startdate',
  ],
  periodEnd: [
    '账期结束',
    '结算结束',
    '结算止日',
    'periodto',
    'periodend',
    'enddate',
  ],
  transactionDate: [
    '日期',
    '交易日期',
    '营业日期',
    '记账日',
    'businessdate',
    'transactiondate',
    'date',
  ],
  salesAmount: [
    '销售额',
    '销售金额',
    '含税销售额',
    '含税交易总额',
    '营业收入',
    '交易金额',
    'grosssales',
    'salesamount',
    'saleamount',
    'sales',
  ],
  refundAmount: [
    '退款金额',
    '退货金额',
    '退货抵扣',
    '售后冲销',
    '退款',
    'refundamount',
    'refunds',
    'returnamount',
  ],
  commissionAmount: [
    '扣点金额',
    '平台服务扣款',
    '佣金',
    '扣佣',
    'commissionamount',
    'commission',
    'mallcommission',
  ],
  activityFee: [
    '活动费',
    '现场活动分摊',
    '推广费',
    '促销费',
    '市场费',
    'activityfee',
    'marketingfee',
    'promotionfee',
  ],
  settlementAmount: [
    '实结金额',
    '结算金额',
    '应付金额',
    '本期应付',
    '净结算额',
    'netsettlement',
    'settlementamount',
    'payableamount',
  ],
  paymentDate: [
    '到账日期',
    '收款日期',
    '交易日期',
    '入账日期',
    'paymentdate',
    'receiveddate',
    'valuedate',
    'date',
  ],
  payerName: [
    '付款方',
    '对方户名',
    '付款账户名',
    '付款单位',
    'payer',
    'payername',
    'counterparty',
  ],
  bankReference: [
    '银行流水号',
    '流水号',
    '交易流水号',
    '回单编号',
    'reference',
    'bankreference',
    'transactionid',
  ],
  paymentAmount: [
    '到账金额',
    '收款金额',
    '交易金额',
    '贷方金额',
    'amount',
    'paymentamount',
    'receivedamount',
  ],
};

const normalize = (value: string) =>
  value
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[\s_\-()（）]/g, '');

export function createHeaderSignature(headers: string[]) {
  return headers.map(normalize).sort().join('|');
}

const padDatePart = (value: number) => String(value).padStart(2, '0');

function formatDateParts(year: number, month: number, day: number) {
  if (
    year < 1900 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  return `${year}-${padDatePart(month)}-${padDatePart(day)}`;
}

export function formatWorkbookCell(
  header: string,
  value: unknown,
): WorkbookRow[string] {
  if (!dateHeaderPattern.test(normalize(header))) {
    return value as WorkbookRow[string];
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return (
      formatDateParts(
        value.getFullYear(),
        value.getMonth() + 1,
        value.getDate(),
      ) ?? ''
    );
  }

  const text = String(value ?? '').trim();
  if (!text) return '';

  const serial = Number(text);
  if (Number.isFinite(serial) && serial >= 1 && serial < 2_958_466) {
    const parsed = XLSX.SSF.parse_date_code(serial);
    if (parsed) return formatDateParts(parsed.y, parsed.m, parsed.d) ?? text;
  }

  const matched = text.match(/^(\d{4})[\/.\-年](\d{1,2})[\/.\-月](\d{1,2})日?/);
  if (matched) {
    return (
      formatDateParts(
        Number(matched[1]),
        Number(matched[2]),
        Number(matched[3]),
      ) ?? text
    );
  }

  return text;
}

export function guessColumn(
  headers: string[],
  field: keyof typeof aliases,
): string {
  const targets = aliases[field].map(normalize);
  return headers.find((header) => targets.includes(normalize(header))) ?? '';
}

export type InferredBillMetadata = {
  mallName: string;
  storeName: string;
  storeCode: string;
  periodStart: string;
  periodEnd: string;
  billType: 'standard' | 'complex' | 'changed_format';
};

const changedFormatHeaders = new Set(
  [
    '项目门店',
    '内部柜号',
    '结算起日',
    '结算止日',
    '含税交易总额',
    '退货抵扣',
    '平台服务扣款',
    '现场活动分摊',
    '本期应付',
  ].map(normalize),
);

function splitCombinedLocation(value: string) {
  const text = value.trim();
  for (const separator of ['·', '/', '／']) {
    const parts = text.split(separator).map((item) => item.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return { mallName: parts[0], storeName: parts.slice(1).join(separator) };
    }
  }
  for (const suffix of ['中心店', '旗舰店', '总店']) {
    if (text.endsWith(suffix) && text.length > suffix.length) {
      return {
        mallName: text.slice(0, -suffix.length),
        storeName: suffix,
      };
    }
  }
  return { mallName: text, storeName: '' };
}

export function inferBillMetadata(
  profile: FileProfile,
): InferredBillMetadata {
  const mallColumn = guessColumn(profile.headers, 'mallName');
  const storeColumn = guessColumn(profile.headers, 'storeName');
  const storeCodeColumn = guessColumn(profile.headers, 'storeCode');
  const periodStartColumn = guessColumn(profile.headers, 'periodStart');
  const periodEndColumn = guessColumn(profile.headers, 'periodEnd');
  const activityFeeColumn = guessColumn(profile.headers, 'activityFee');
  const rawMallName = firstColumnValue(profile, mallColumn);
  const combinedLocation = splitCombinedLocation(rawMallName);
  const hasChangedFormat = profile.headers.some((header) =>
    changedFormatHeaders.has(normalize(header)),
  );

  return {
    mallName: combinedLocation.mallName,
    storeName:
      firstColumnValue(profile, storeColumn) || combinedLocation.storeName,
    storeCode: firstColumnValue(profile, storeCodeColumn),
    periodStart: firstColumnValue(profile, periodStartColumn),
    periodEnd: firstColumnValue(profile, periodEndColumn),
    billType: hasChangedFormat
      ? 'changed_format'
      : activityFeeColumn && sumColumn(profile, activityFeeColumn) !== 0
        ? 'complex'
        : 'standard',
  };
}

export function inferStoreCode(profile: FileProfile) {
  return firstColumnValue(profile, guessColumn(profile.headers, 'storeCode'));
}

async function readPdfTable(file: File): Promise<FileProfile> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/legacy/build/pdf.worker.mjs',
    import.meta.url,
  ).toString();
  const pdfDocument = await pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    useWorkerFetch: false,
    isEvalSupported: false,
  }).promise;
  const lines: Array<{ page: number; y: number; cells: string[] }> = [];
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const content = await page.getTextContent();
    const grouped = new Map<number, Array<{ x: number; text: string }>>();
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim() || !('transform' in item)) continue;
      const transform = item.transform as number[];
      const y = Math.round((transform[5] ?? 0) / 3) * 3;
      const row = grouped.get(y) ?? [];
      row.push({ x: transform[4] ?? 0, text: item.str.trim() });
      grouped.set(y, row);
    }
    for (const [y, cells] of grouped) {
      const ordered = cells.sort((left, right) => left.x - right.x);
      if (ordered.length >= 2) {
        lines.push({ page: pageNumber, y, cells: ordered.map((item) => item.text) });
      }
    }
  }
  const normalizedAliases = new Set(
    Object.values(aliases).flat().map(normalize),
  );
  const candidates = lines
    .map((line, index) => ({
      ...line,
      index,
      score: line.cells.filter((cell) => normalizedAliases.has(normalize(cell))).length,
    }))
    .filter((line) => line.cells.length >= 2)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const headerLine = candidates[0];
  if (!headerLine || headerLine.score < 1) {
    throw new Error('PDF 中未识别到可映射的表格表头。请使用可复制文字的 PDF，或转为 Excel 后导入。');
  }
  const headers = headerLine.cells.map((header, index) =>
    header || `列${index + 1}`,
  );
  // 多页账单后续页会重复打印表头，按表头内容跳过这些行，其余页的数据行全部纳入。
  const headerKey = headers.map(normalize).join('|');
  const rows = lines
    .filter(
      (line, index) =>
        index > headerLine.index &&
        line.cells.length >= Math.min(2, headers.length) &&
        line.cells.map(normalize).join('|') !== headerKey,
    )
    .map((line) =>
      Object.fromEntries(
        headers.map((header, index) => [header, line.cells[index] ?? '']),
      ),
    )
    .filter((row) => Object.values(row).some(Boolean));
  if (!rows.length) {
    throw new Error('PDF 已识别表头，但未识别到数据行。请使用表格型 PDF，或转为 Excel 后导入。');
  }
  return {
    fileName: file.name,
    sheetName: `PDF 第 ${headerLine.page} 页起`,
    headers,
    rows,
    sourceType: 'pdf',
  };
}

export async function readWorkbook(file: File): Promise<FileProfile> {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'pdf') {
    return readPdfTable(file);
  }
  if (!['xlsx', 'xls', 'csv'].includes(extension ?? '')) {
    throw new Error('当前导入通道支持 Excel、CSV 和可复制文字的 PDF');
  }
  const workbook = XLSX.read(
    extension === 'csv' ? await file.text() : await file.arrayBuffer(),
    {
      type: extension === 'csv' ? 'string' : 'array',
      codepage: 65001,
    cellDates: true,
    },
  );
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('文件中没有可读取的工作表');
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    workbook.Sheets[sheetName],
    { defval: '' },
  );
  if (!rawRows.length) throw new Error('文件中没有数据行');
  const sourceHeaders = Object.keys(rawRows[0]);
  const headers = sourceHeaders.map((header) =>
    header.replace(/^\uFEFF/, '').trim(),
  );
  const rows = rawRows.map((row) =>
    Object.fromEntries(
      sourceHeaders.map((sourceHeader, index) => {
        const header = headers[index];
        return [header, formatWorkbookCell(header, row[sourceHeader])];
      }),
    ),
  );
  return {
    fileName: file.name,
    sheetName,
    headers,
    rows,
    sourceType: 'spreadsheet',
  };
}

export function profileFromVisionExtraction(
  result: VisionExtractionResult,
): FileProfile {
  return {
    fileName: result.fileName,
    sheetName: '视觉识别结果',
    headers: result.headers,
    rows: result.rows,
    sourceType: 'vision_llm',
  };
}

export async function renderPdfPagesForVision(
  file: File,
  maxPages = 2,
): Promise<File[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/legacy/build/pdf.worker.mjs',
    import.meta.url,
  ).toString();
  const pdfDocument = await pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    useWorkerFetch: false,
    isEvalSupported: false,
  }).promise;
  const pages: File[] = [];
  for (let pageNumber = 1; pageNumber <= Math.min(pdfDocument.numPages, maxPages); pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    // Financial amounts are often small text inside dense tables. Preserve enough pixels for VLM reading.
    const viewport = page.getViewport({ scale: 3 });
    const canvas = globalThis.document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建 PDF 页面图像。');
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    if (!blob) throw new Error('无法生成 PDF 页面图像。');
    pages.push(
      new File([blob], `${file.name}-page-${pageNumber}.png`, {
        type: 'image/png',
      }),
    );
  }
  return pages;
}

export async function renderPdfTilesForVision(
  file: File,
  pagesNeeded: number[],
  maxTiles = 12,
): Promise<File[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/legacy/build/pdf.worker.mjs',
    import.meta.url,
  ).toString();
  const pdfDocument = await pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    useWorkerFetch: false,
    isEvalSupported: false,
  }).promise;
  const tiles: File[] = [];
  const pageNumbers = [...new Set(pagesNeeded.filter((page) => page > 0))];
  for (const pageNumber of pageNumbers) {
    if (pageNumber > pdfDocument.numPages || tiles.length >= maxTiles) continue;
    const page = await pdfDocument.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 3 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建 PDF 高清复核图像。');
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const columns = 2;
    const rows = 3;
    const tileWidth = Math.ceil(canvas.width / columns);
    const tileHeight = Math.ceil(canvas.height / rows);
    for (let row = 0; row < rows && tiles.length < maxTiles; row += 1) {
      for (let column = 0; column < columns && tiles.length < maxTiles; column += 1) {
        const tile = document.createElement('canvas');
        tile.width = Math.min(tileWidth, canvas.width - column * tileWidth);
        tile.height = Math.min(tileHeight, canvas.height - row * tileHeight);
        tile.getContext('2d')?.drawImage(
          canvas,
          column * tileWidth,
          row * tileHeight,
          tile.width,
          tile.height,
          0,
          0,
          tile.width,
          tile.height,
        );
        const blob = await new Promise<Blob | null>((resolve) => tile.toBlob(resolve, 'image/jpeg', 0.9));
        if (blob) tiles.push(new File([blob], `${file.name}-p${pageNumber}-${row}-${column}.jpg`, { type: 'image/jpeg' }));
      }
    }
  }
  return tiles;
}

export function parseMoney(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = String(value ?? '').trim();
  if (!text) return 0;
  const negative = /^\(.*\)$/.test(text) || text.startsWith('-');
  const numeric = Number(
    text.replace(/[¥￥$,，%()（）\s]/g, '').replace(/^-/, ''),
  );
  if (!Number.isFinite(numeric)) return 0;
  return Math.round((negative ? -numeric : numeric) * 100) / 100;
}

export function filterRowsByDate(
  profile: FileProfile | null,
  column: string,
  periodStart: string,
  periodEnd: string,
): WorkbookRow[] {
  if (!profile || !column || !periodStart || !periodEnd) return [];
  return profile.rows.filter((row) => {
    const date = String(row[column] ?? '');
    return date >= periodStart && date <= periodEnd;
  });
}

export function firstColumnValue(profile: FileProfile | null, column: string) {
  if (!profile || !column) return '';
  return String(profile.rows.find((row) => row[column] !== '')?.[column] ?? '');
}

// 账单明细常带「合计/总计/小计」行，直接求和会翻倍，需要先剔除；
// 若剔除后没有明细行（纯汇总单），回退到全部行以保证金额可取。
const summaryRowPattern = /^\s*(合计|总计|小计|累计)/;

function isSummaryRow(row: WorkbookRow) {
  return Object.values(row).some(
    (value) => typeof value === 'string' && summaryRowPattern.test(value),
  );
}

export function sumColumn(
  profile: FileProfile | null,
  column: string,
  rows?: WorkbookRow[],
): number {
  if (!profile || !column) return 0;
  const source = rows ?? profile.rows;
  const detailRows = source.filter((row) => !isSummaryRow(row));
  const target = detailRows.length ? detailRows : source;
  return (
    Math.round(
      target.reduce((sum, row) => sum + parseMoney(row[column]), 0) * 100,
    ) / 100
  );
}
