#!/usr/bin/env node
import http from 'node:http';

const host = process.env.BILLCOMPARE_GATEWAY_HOST || '0.0.0.0';
const port = Number(process.env.BILLCOMPARE_GATEWAY_PORT || '5176');
const appPort = Number(process.env.BILLCOMPARE_APP_PORT || '3001');
const mcpPort = Number(process.env.CHERRY_MCP_PORT || '8791');

const server = http.createServer((req, res) => {
  const originalUrl = req.url || '/';
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
