#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { z } from 'zod';
import dotenv from 'dotenv';
import postgres from 'postgres';

dotenv.config({ path: '.env.local', quiet: true });
dotenv.config({ path: '.env', quiet: true });

const host = process.env.CHERRY_MCP_HOST || '0.0.0.0';
const port = Number(process.env.CHERRY_MCP_PORT || '8787');
const endpoint = process.env.CHERRY_MCP_ENDPOINT || '/mcp';
const accessToken = process.env.CHERRY_MCP_ACCESS_TOKEN || '';
const defaultApiPort = process.env.SERVER_PORT || '3001';
const apiBase =
  process.env.MALL_RECONCILIATION_API_BASE ||
  `http://127.0.0.1:${defaultApiPort}/api/reconciliation`;
const databaseUrl =
  process.env.MALL_RECONCILIATION_DATABASE_URL || process.env.SUDA_DATABASE_URL;
const dataSource =
  process.env.MALL_RECONCILIATION_MCP_SOURCE ||
  (databaseUrl ? 'database' : 'api');
const sql = databaseUrl ? postgres(databaseUrl, { max: 4 }) : null;

const filterShape = {
  mallName: z.string().min(1).optional(),
  storeCode: z.string().min(1).optional(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.number().int().min(1).max(200).optional(),
};

if (process.argv.includes('--self-test')) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        transport: 'streamable-http',
        url: `http://${host}:${port}${endpoint}`,
        apiBase,
        dataSource,
        accessTokenEnabled: Boolean(accessToken),
        tools: [
          'list_settlement_bills',
          'get_settlement_bill',
          'summarize_store_period',
          'analyze_fee_changes',
        ],
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const app = createMcpExpressApp({
  host,
  allowedHosts: process.env.CHERRY_MCP_ALLOWED_HOSTS
    ? process.env.CHERRY_MCP_ALLOWED_HOSTS.split(',').map((item) => item.trim())
    : undefined,
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'mall-reconciliation-analysis-mcp',
    transport: 'streamable-http',
    dataSource,
    apiBase,
  });
});

// CherryStudio 会自动探测 OAuth 元数据端点，返回合法 JSON 避免其解析崩溃
app.all('/.well-known/oauth-authorization-server', (_req, res) => {
  res.status(404).json({
    error: 'oauth_not_supported',
    message: 'This MCP server uses Bearer token authentication, not OAuth.',
  });
});

app.post(endpoint, async (req, res) => {
  if (!isAuthorized(req)) {
    res
      .status(401)
      .set('WWW-Authenticate', 'Bearer')
      .json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    });
    return;
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('[mcp] request failed', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal error',
        },
        id: null,
      });
    }
  } finally {
    res.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
  }
});

app.get(endpoint, (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed' },
    id: null,
  });
});

app.delete(endpoint, (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed' },
    id: null,
  });
});

app.listen(port, host, (error) => {
  if (error) {
    console.error('[mcp] failed to start', error);
    process.exit(1);
  }
  console.error(`[mcp] listening on http://${host}:${port}${endpoint}`);
  console.error(`[mcp] reading reconciliation API at ${apiBase}`);
});

function createServer() {
  const server = new McpServer({
    name: 'mall-reconciliation-analysis',
    version: '1.0.0',
  });

  server.registerTool(
    'list_settlement_bills',
    {
      title: 'List confirmed settlement bills',
      description:
        'List manually confirmed mall settlement bills from the reconciliation system.',
      inputSchema: filterShape,
    },
    async (args) =>
      jsonToolResult(
        dataSource === 'database'
          ? await listBills(args)
          : await getJson('/analysis/settlements', args),
      ),
  );

  server.registerTool(
    'get_settlement_bill',
    {
      title: 'Get confirmed settlement bill',
      description:
        'Get one confirmed settlement bill with reviewed fields, sales lines, and fee lines.',
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) =>
      jsonToolResult(
        dataSource === 'database'
          ? await getDetail(id)
          : await getJson(`/analysis/settlements/${encodeURIComponent(id)}`),
      ),
  );

  server.registerTool(
    'summarize_store_period',
    {
      title: 'Summarize confirmed settlement period',
      description:
        'Summarize confirmed settlement sales, invoice, deductions, and settlement totals for a period.',
      inputSchema: filterShape,
    },
    async (args) =>
      jsonToolResult(
        dataSource === 'database'
          ? await summarize(args)
          : await getJson('/analysis/settlements/summary', args),
      ),
  );

  server.registerTool(
    'analyze_fee_changes',
    {
      title: 'Analyze settlement fees',
      description:
        'Group confirmed settlement fee lines by label and return fee totals and source bill lines.',
      inputSchema: filterShape,
    },
    async (args) =>
      jsonToolResult(
        dataSource === 'database'
          ? await analyzeFees(args)
          : await getJson('/analysis/settlements/fees', args),
      ),
  );

  return server;
}

async function listBills(filters = {}) {
  assertDatabase();
  const conditions = ['status = $1'];
  const values = ['confirmed'];
  addTextCondition(conditions, values, 'mall_name', filters.mallName);
  addTextCondition(conditions, values, 'store_code', filters.storeCode);
  if (filters.periodStart) {
    values.push(filters.periodStart);
    conditions.push(`period_end >= $${values.length}`);
  }
  if (filters.periodEnd) {
    values.push(filters.periodEnd);
    conditions.push(`period_start <= $${values.length}`);
  }
  const limit = normalizeLimit(filters.limit);
  values.push(limit);

  const rows = await sql.unsafe(
    `
      SELECT id, version, status, source_file_name, mall_name, store_name,
             store_code, period_start, period_end, bill_type, settlement_no,
             sales_amount, invoice_amount, deduction_total, settlement_amount,
             ocr_verified, confirmed_by, confirmed_at, created_at, updated_at
      FROM reconciliation_confirmed_bills
      WHERE ${conditions.join(' AND ')}
      ORDER BY period_start DESC, period_end DESC
      LIMIT $${values.length}
    `,
    values,
  );
  return rows.map(toBill);
}

async function getDetail(id) {
  assertDatabase();
  const [bill] = await sql`
    SELECT id, version, status, source_file_name, mall_name, store_name,
           store_code, period_start, period_end, bill_type, settlement_no,
           sales_amount, invoice_amount, deduction_total, settlement_amount,
           ocr_verified, reviewed_fields, extraction_payload, confirmed_by,
           confirmed_at, created_at, updated_at
    FROM reconciliation_confirmed_bills
    WHERE id = ${id} AND status = 'confirmed'
  `;
  if (!bill) throw new Error(`confirmed settlement ${id} not found`);

  const [salesRows, feeRows] = await Promise.all([
    sql`
      SELECT sequence, label, row_type, values, raw_text, source_page, confidence
      FROM reconciliation_confirmed_sales_lines
      WHERE bill_id = ${id}
      ORDER BY sequence
    `,
    sql`
      SELECT sequence, label, row_type, values, raw_text, source_page, confidence
      FROM reconciliation_confirmed_fee_lines
      WHERE bill_id = ${id}
      ORDER BY sequence
    `,
  ]);

  return {
    bill: toBill(bill),
    reviewedFields: bill.reviewed_fields,
    metadata: bill.extraction_payload?.metadata ?? {},
    warnings: bill.extraction_payload?.warnings ?? [],
    salesLines: salesRows.map(toLine),
    feeLines: feeRows.map(toLine),
  };
}

async function summarize(filters = {}) {
  const bills = await listBills(filters);
  return {
    filters: normalizeFilters(filters),
    billCount: bills.length,
    periodStart: minText(bills.map((bill) => bill.periodStart)),
    periodEnd: maxText(bills.map((bill) => bill.periodEnd)),
    totals: {
      salesAmount: toMoneyString(sumMoney(bills, 'salesAmount')),
      invoiceAmount: toMoneyString(sumMoney(bills, 'invoiceAmount')),
      deductionTotal: toMoneyString(sumMoney(bills, 'deductionTotal')),
      settlementAmount: toMoneyString(sumMoney(bills, 'settlementAmount')),
    },
    bills,
    generatedAt: new Date().toISOString(),
  };
}

async function analyzeFees(filters = {}) {
  const bills = await listBills(filters);
  if (!bills.length) {
    return {
      filters: normalizeFilters(filters),
      billCount: 0,
      totalFeeAmount: '0.00',
      items: [],
      generatedAt: new Date().toISOString(),
    };
  }

  const ids = bills.map((bill) => bill.id);
  const billById = new Map(bills.map((bill) => [bill.id, bill]));
  const rows = await sql`
    SELECT bill_id, sequence, label, row_type, values, raw_text, source_page,
           confidence
    FROM reconciliation_confirmed_fee_lines
    WHERE bill_id IN ${sql(ids)}
    ORDER BY bill_id, sequence
  `;

  const byLabel = new Map();
  for (const row of rows) {
    if (!['detail', 'adjustment'].includes(row.row_type || 'detail')) continue;
    const amount = extractLineAmount(toLine(row));
    if (amount === null) continue;
    const bill = billById.get(row.bill_id);
    const label = String(row.label || '').trim() || 'Unlabeled fee';
    const current =
      byLabel.get(label) ?? { amount: 0, billIds: new Set(), lines: [] };
    current.amount += amount;
    current.billIds.add(row.bill_id);
    current.lines.push({
      billId: row.bill_id,
      periodStart: bill.periodStart,
      periodEnd: bill.periodEnd,
      mallName: bill.mallName,
      storeCode: bill.storeCode,
      storeName: bill.storeName,
      label,
      amount: toMoneyString(amount),
      rawText: row.raw_text,
      page: row.source_page,
      confidence: row.confidence === null ? null : Number(row.confidence),
    });
    byLabel.set(label, current);
  }

  const items = Array.from(byLabel.entries())
    .map(([label, item]) => ({
      label,
      amount: toMoneyString(item.amount),
      billCount: item.billIds.size,
      lineCount: item.lines.length,
      lines: item.lines,
    }))
    .sort((left, right) => Number(right.amount) - Number(left.amount));

  return {
    filters: normalizeFilters(filters),
    billCount: bills.length,
    totalFeeAmount: toMoneyString(
      items.reduce((sum, item) => sum + Number(item.amount), 0),
    ),
    items,
    generatedAt: new Date().toISOString(),
  };
}

async function getJson(path, params = {}) {
  const url = new URL(`${apiBase}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Reconciliation API ${response.status}: ${body || response.statusText}`,
    );
  }
  return response.json();
}

function jsonToolResult(data) {
  const structuredContent = Array.isArray(data) ? { items: data } : data;
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent,
  };
}

function isAuthorized(req) {
  if (!accessToken) return true;
  const authorization = req.header('authorization') || '';
  return authorization === `Bearer ${accessToken}`;
}

function assertDatabase() {
  if (!sql) {
    throw new Error('database mode requires SUDA_DATABASE_URL');
  }
}

function addTextCondition(conditions, values, column, value) {
  if (!value) return;
  values.push(value);
  conditions.push(`${column} = $${values.length}`);
}

function toBill(row) {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    sourceFileName: row.source_file_name,
    mallName: row.mall_name,
    storeName: row.store_name,
    storeCode: row.store_code,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    billType: row.bill_type,
    settlementNo: row.settlement_no,
    salesAmount: toMoneyString(Number(row.sales_amount)),
    invoiceAmount:
      row.invoice_amount === null ? null : toMoneyString(Number(row.invoice_amount)),
    deductionTotal:
      row.deduction_total === null
        ? null
        : toMoneyString(Number(row.deduction_total)),
    settlementAmount: toMoneyString(Number(row.settlement_amount)),
    clientReportedOcrVerified: Boolean(row.ocr_verified),
    confirmedBy: row.confirmed_by,
    confirmedAt: toIsoText(row.confirmed_at),
    createdAt: toIsoText(row.created_at),
    updatedAt: toIsoText(row.updated_at),
  };
}

function toLine(row) {
  return {
    section: '',
    label: row.label,
    rowType: row.row_type,
    sequence: row.sequence,
    values: row.values,
    rawText: row.raw_text,
    page: row.source_page,
    confidence: row.confidence === null ? null : Number(row.confidence),
  };
}

function normalizeLimit(limit) {
  if (!Number.isInteger(limit) || !limit || limit < 1) return 200;
  return Math.min(limit, 200);
}

function normalizeFilters(filters) {
  return {
    mallName: filters.mallName,
    storeCode: filters.storeCode,
    periodStart: filters.periodStart,
    periodEnd: filters.periodEnd,
    limit: normalizeLimit(filters.limit),
  };
}

function toIsoText(value) {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function sumMoney(rows, key) {
  return rows.reduce((sum, row) => sum + toNumber(row[key]), 0);
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function toMoneyString(value) {
  return Number(value || 0).toFixed(2);
}

function minText(values) {
  return values.length
    ? values.reduce((left, right) => (left < right ? left : right))
    : null;
}

function maxText(values) {
  return values.length
    ? values.reduce((left, right) => (left > right ? left : right))
    : null;
}

function extractLineAmount(line) {
  const preferredKeys = [
    'amount',
    'feeAmount',
    'deductionAmount',
    'netAmount',
    '金额',
    '费用金额',
    '扣款金额',
    '实扣金额',
    '小计',
    '合计',
  ];
  for (const key of preferredKeys) {
    const amount = parseMaybeMoney(line.values?.[key]);
    if (amount !== null) return amount;
  }
  for (const [key, value] of Object.entries(line.values ?? {})) {
    if (/rate|ratio|percent|率|日期|数量|qty|code/i.test(key)) continue;
    const amount = parseMaybeMoney(value);
    if (amount !== null) return amount;
  }
  return null;
}

function parseMaybeMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}
