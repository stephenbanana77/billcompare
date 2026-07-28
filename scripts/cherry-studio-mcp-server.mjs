#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const defaultPort = process.env.SERVER_PORT || '3001';
const apiBase =
  process.env.MALL_RECONCILIATION_API_BASE ||
  `http://127.0.0.1:${defaultPort}/api/reconciliation`;

const filterShape = {
  mallName: z.string().min(1).optional(),
  storeCode: z.string().min(1).optional(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.number().int().min(1).max(200).optional(),
};

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
  async (args) => jsonToolResult(await getJson('/analysis/settlements', args)),
);

server.registerTool(
  'get_settlement_bill',
  {
    title: 'Get confirmed settlement bill',
    description:
      'Get one confirmed settlement bill with reviewed fields, sales lines, and fee lines.',
    inputSchema: {
      id: z.string().min(1),
    },
  },
  async ({ id }) =>
    jsonToolResult(
      await getJson(`/analysis/settlements/${encodeURIComponent(id)}`),
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
    jsonToolResult(await getJson('/analysis/settlements/summary', args)),
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
    jsonToolResult(await getJson('/analysis/settlements/fees', args)),
);

if (process.argv.includes('--self-test')) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        apiBase,
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

await server.connect(new StdioServerTransport());

async function getJson(path, params = {}) {
  const url = new URL(`${apiBase}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
    },
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
  const text = JSON.stringify(data, null, 2);
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
    structuredContent,
  };
}
