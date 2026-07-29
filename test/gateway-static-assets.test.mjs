import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

async function waitForGateway(child, gatewayPort) {
  const timeout = AbortSignal.timeout(5_000);

  while (!timeout.aborted) {
    if (child.exitCode !== null) {
      throw new Error(`gateway exited with code ${child.exitCode}`);
    }

    try {
      await fetch(`http://127.0.0.1:${gatewayPort}/mcp-health`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw new Error('gateway did not start in time');
}

test('serves built frontend assets without the app upstream', async () => {
  const gatewayPort = 25176;
  const child = spawn(process.execPath, ['scripts/billcompare-gateway.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BILLCOMPARE_GATEWAY_HOST: '127.0.0.1',
      BILLCOMPARE_GATEWAY_PORT: String(gatewayPort),
      BILLCOMPARE_APP_PORT: '25177',
      CHERRY_MCP_PORT: '25178',
    },
    stdio: 'ignore',
  });

  try {
    await waitForGateway(child, gatewayPort);
    const response = await fetch(
      `http://127.0.0.1:${gatewayPort}/assets/index-DMmTYRb-.js`,
    );

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /javascript/);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  } finally {
    child.kill();
    if (child.exitCode === null) {
      await once(child, 'exit');
    }
  }
});

test('redirects the root URL to the configured app', async () => {
  const gatewayPort = 25179;
  const child = spawn(process.execPath, ['scripts/billcompare-gateway.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BILLCOMPARE_GATEWAY_HOST: '127.0.0.1',
      BILLCOMPARE_GATEWAY_PORT: String(gatewayPort),
      BILLCOMPARE_APP_PORT: '25180',
      CHERRY_MCP_PORT: '25181',
      MIAODA_APP_ID: 'app_test',
    },
    stdio: 'ignore',
  });

  try {
    await waitForGateway(child, gatewayPort);
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/`, {
      redirect: 'manual',
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/app/app_test/');
  } finally {
    child.kill();
    if (child.exitCode === null) {
      await once(child, 'exit');
    }
  }
});
