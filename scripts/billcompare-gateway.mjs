#!/usr/bin/env node
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const host = process.env.BILLCOMPARE_GATEWAY_HOST || '0.0.0.0';
const port = Number(process.env.BILLCOMPARE_GATEWAY_PORT || '5176');
const appPort = Number(process.env.BILLCOMPARE_APP_PORT || '3001');
const mcpPort = Number(process.env.CHERRY_MCP_PORT || '8791');
const appId = process.env.MIAODA_APP_ID || 'app_17a7d7fdmvg';
const clientRoot = fileURLToPath(new URL('../dist/client/', import.meta.url));

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

async function tryServeClientAsset(req, res, originalUrl) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(originalUrl, 'http://localhost').pathname);
  } catch {
    return false;
  }

  const isClientAsset =
    pathname.startsWith('/assets/') ||
    pathname === '/polyfills.js' ||
    pathname === '/favicon.svg' ||
    pathname === '/routes.json';
  if (!isClientAsset) return false;

  const filePath = resolve(clientRoot, `.${pathname}`);
  const relativePath = relative(clientRoot, filePath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) return false;

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    return false;
  }
  if (!fileStat.isFile()) return false;

  res.writeHead(200, {
    'cache-control': pathname.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=300',
    'content-length': fileStat.size,
    'content-type': contentTypes.get(extname(filePath)) || 'application/octet-stream',
  });
  if (req.method === 'HEAD') {
    res.end();
  } else {
    createReadStream(filePath).pipe(res);
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  const originalUrl = req.url || '/';
  if (originalUrl === '/') {
    res.writeHead(302, { location: `/app/${appId}/` });
    res.end();
    return;
  }

  if (await tryServeClientAsset(req, res, originalUrl)) return;

  const isMcp = originalUrl === '/mcp' || originalUrl.startsWith('/mcp?');
  const isMcpHealth = originalUrl === '/mcp-health';
  const targetPort = isMcp || isMcpHealth ? mcpPort : appPort;
  const targetPath = isMcpHealth ? '/health' : originalUrl;

  const proxy = http.request(
    {
      hostname: '127.0.0.1',
      port: targetPort,
      path: targetPath,
      method: req.method,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${targetPort}`,
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxy.on('error', (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    }
    res.end(
      JSON.stringify({
        error: 'Bad Gateway',
        message: error instanceof Error ? error.message : 'upstream unavailable',
      }),
    );
  });

  req.pipe(proxy);
});

server.listen(port, host, () => {
  console.error(
    `[gateway] listening on http://${host}:${port}, app -> ${appPort}, mcp -> ${mcpPort}`,
  );
});
