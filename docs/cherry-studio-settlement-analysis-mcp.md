# Cherry Studio Settlement Analysis MCP

## Purpose

This MCP server lets Cherry Studio analyze settlement bills that were already
uploaded, mapped by OCR + LLM, reviewed by a user, and confirmed into the
reconciliation system database.

Cherry Studio does not read the database directly and does not analyze
unconfirmed OCR/LLM drafts. It calls read-only tools exposed by the local demo
backend.

## Current Tools

- `list_settlement_bills`: list confirmed settlement bills.
- `get_settlement_bill`: return one confirmed bill with reviewed fields, sales
  lines, and fee lines.
- `summarize_store_period`: summarize sales, invoice amount, deductions, and
  settlement amount for a selected period.
- `analyze_fee_changes`: group fee lines by label and return fee totals with
  source bill references.

## Local Demo Configuration

Make sure the backend is running first. In the current local demo, the backend
usually listens on:

```text
http://127.0.0.1:3001
```

Add an MCP server in Cherry Studio:

```json
{
  "name": "mall-reconciliation-analysis",
  "command": "npm",
  "args": ["run", "mcp:cherry"],
  "cwd": "D:\\710\\mall-reconciliation-workbench",
  "env": {
    "MALL_RECONCILIATION_API_BASE": "http://127.0.0.1:3001/api/reconciliation"
  }
}
```

If the backend port changes, only update `MALL_RECONCILIATION_API_BASE`.

## Server Deployment Configuration

For Cherry Studio Enterprise, run the HTTP MCP bridge on the same server or on a
network-accessible middleware host:

```powershell
$env:SUDA_DATABASE_URL="postgres://..."
$env:MALL_RECONCILIATION_MCP_SOURCE="database"
$env:CHERRY_MCP_HOST="0.0.0.0"
$env:CHERRY_MCP_PORT="8787"
$env:CHERRY_MCP_ACCESS_TOKEN="replace-with-enterprise-token"
npm run mcp:cherry:http
```

Then configure Cherry Studio Enterprise with the MCP endpoint:

```text
https://your-mcp-domain.example.com/mcp
```

If Enterprise asks for an authorization header, use:

```text
Authorization: Bearer replace-with-enterprise-token
```

The HTTP bridge exposes a health endpoint:

```text
https://your-mcp-domain.example.com/health
```

In Enterprise mode, the recommended data source is `database`: Cherry Studio
connects only to the MCP endpoint, while the MCP service reads the same
confirmed settlement tables used by the business system. This avoids depending
on browser session cookies or the Miaoda page route. Cherry Studio still does
not receive database credentials.

If a future deployment exposes a stable internal analysis REST API, set:

```powershell
$env:MALL_RECONCILIATION_MCP_SOURCE="api"
$env:MALL_RECONCILIATION_API_BASE="https://your-domain.example.com/api/reconciliation"
```

If Cherry Studio Enterprise also supports local command MCP, you can still use
the stdio bridge after deploying the backend:

```json
{
  "name": "mall-reconciliation-analysis",
  "command": "npm",
  "args": ["run", "mcp:cherry"],
  "cwd": "D:\\710\\mall-reconciliation-workbench",
  "env": {
    "MALL_RECONCILIATION_API_BASE": "https://your-domain.example.com/api/reconciliation"
  }
}
```

The first version does not enforce store or role-based data scopes. The service
is intentionally read-only, so Cherry Studio can analyze confirmed data without
modifying settlement records.
