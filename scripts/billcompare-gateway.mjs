#!/usr/bin/env node
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const host = process.env.BILLCOMPARE_GATEWAY_HOST || '0.0.0.0';
const port = Number(process.env.BILLCOMPARE_GATEWAY_PORT || '5176');
const appPort = Number(process.env.BILLCOMPARE_APP_PORT || '3001');
const mcpPort = Number(process.env.CHERRY_MCP_PORT || '8791');
const appId = process.env.MIAODA_APP_ID || 'app_17a7d7fdmvg';
const staticDir = path.resolve(
  process.env.BILLCOMPARE_STATIC_DIR || path.join(process.cwd(), 'dist/client'),
);

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
]);

function sendJson(req, res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function servePlatformCompatibility(req, res, requestUrl) {
  const { pathname } = requestUrl;

  if (
    (req.method === 'GET' || req.method === 'HEAD') &&
    /^\/spark\/api\/v1\/observability\/app\/(?:null|undefined)?\/current_server_timestamp$/.test(
      pathname,
    )
  ) {
    sendJson(req, res, 200, {
      data: { timestampNs: String(BigInt(Date.now()) * 1_000_000n) },
    });
    return true;
  }

  if (
    req.method === 'POST' &&
    /^\/spark\/app\/(?:null|undefined)?\/runtime\/api\/v1\/permissions\/roles$/.test(
      pathname,
    )
  ) {
    sendJson(req, res, 200, { data: { roleList: [] } });
    return true;
  }

  if (
    (req.method === 'GET' || req.method === 'HEAD') &&
    /^\/spark\/b\/(?:null|undefined)?\/tenant_info$/.test(pathname)
  ) {
    sendJson(req, res, 200, {
      code: 0,
      data: { tenant_info: { name: '' }, is_internet_visible: false },
    });
    return true;
  }

  if (
    req.method === 'POST' &&
    /^\/spark\/app\/(?:null|undefined)?\/runtime\/api\/v1\/observability\/(?:logs|traces|metrics)\/collect$/.test(
      pathname,
    )
  ) {
    sendJson(req, res, 200, { code: 0, data: {} });
    return true;
  }

  return false;
}

async function serveStaticAsset(originalUrl, req, res) {
  const { pathname } = new URL(originalUrl, 'http://billcompare.local');
  const isStaticAsset =
    pathname === '/polyfills.js' ||
    pathname === '/favicon.ico' ||
    pathname === '/favicon.svg' ||
    pathname.startsWith('/assets/');
  if (!isStaticAsset) return false;

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return true;
  }

  const relativePath =
    decodedPath === '/favicon.ico'
      ? 'favicon.svg'
      : decodedPath.replace(/^\/+/, '');
  const filePath = path.resolve(staticDir, relativePath);
  if (!filePath.startsWith(`${staticDir}${path.sep}`)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return true;
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    return false;
  }
  if (!fileStat.isFile()) return false;

  const ext = path.extname(filePath);
  const etag = `W/"${fileStat.size.toString(16)}-${Math.trunc(fileStat.mtimeMs).toString(16)}"`;
  const lastModified = fileStat.mtime.toUTCString();
  const cacheControl = pathname.startsWith('/assets/')
    ? 'public, max-age=0, must-revalidate'
    : 'no-cache';
  const notModified =
    req.headers['if-none-match'] === etag ||
    (req.headers['if-none-match'] === undefined &&
      req.headers['if-modified-since'] !== undefined &&
      Date.parse(req.headers['if-modified-since']) >=
        Math.floor(fileStat.mtimeMs / 1000) * 1000);
  const sharedHeaders = {
    'cache-control': cacheControl,
    etag,
    'last-modified': lastModified,
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
    'x-content-type-options': 'nosniff',
  };

  if (notModified) {
    res.writeHead(304, sharedHeaders);
    res.end();
    return true;
  }

  res.writeHead(200, {
    ...sharedHeaders,
    'content-length': fileStat.size,
    'content-type': contentTypes.get(ext) || 'application/octet-stream',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(filePath).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  const originalUrl = req.url || '/';
  const requestUrl = new URL(originalUrl, 'http://billcompare.local');
  const appBasePath = `/app/${appId}`;
  const isHtmlNavigation =
    (req.method === 'GET' || req.method === 'HEAD') &&
    (requestUrl.pathname === '/' ||
      req.headers.accept?.includes('text/html') ||
      req.headers['sec-fetch-mode'] === 'navigate' ||
      req.headers['sec-fetch-dest'] === 'document');

  if (
    isHtmlNavigation &&
    (requestUrl.pathname === appBasePath ||
      requestUrl.pathname.startsWith(`${appBasePath}/`))
  ) {
    const cleanPath = requestUrl.pathname.slice(appBasePath.length) || '/';
    res.writeHead(302, {
      'cache-control': 'no-store',
      location: `${cleanPath}${requestUrl.search}`,
    });
    res.end();
    return;
  }

  if (servePlatformCompatibility(req, res, requestUrl)) return;

  try {
    if (await serveStaticAsset(originalUrl, req, res)) return;
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    }
    res.end(
      JSON.stringify({
        error: 'Static Asset Error',
        message: error instanceof Error ? error.message : 'asset unavailable',
      }),
    );
    return;
  }

  const isMcp = originalUrl === '/mcp' || originalUrl.startsWith('/mcp?');
  const isMcpHealth = originalUrl === '/mcp-health';
  const targetPort = isMcp || isMcpHealth ? mcpPort : appPort;
  const placeholderAppPath = requestUrl.pathname.match(
    /^\/app\/(?:null|undefined)?\/(.*)$/,
  );
  const targetPath = isMcpHealth
    ? '/health'
    : isHtmlNavigation
      ? `${appBasePath}${requestUrl.pathname}${requestUrl.search}`
      : placeholderAppPath
        ? `${appBasePath}/${placeholderAppPath[1]}${requestUrl.search}`
        : requestUrl.pathname === '/api' ||
            requestUrl.pathname.startsWith('/api/')
          ? `${appBasePath}${requestUrl.pathname}${requestUrl.search}`
          : originalUrl;

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
      const responseHeaders = { ...proxyRes.headers };
      if (proxyRes.headers['content-type']?.includes('text/html')) {
        responseHeaders['cache-control'] = 'no-store, no-cache, must-revalidate';
        responseHeaders.pragma = 'no-cache';
        responseHeaders.expires = '0';
      }
      res.writeHead(proxyRes.statusCode || 502, responseHeaders);
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
