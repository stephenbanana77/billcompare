import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

const gatewayPort = 25176;

async function waitForGateway(child) {
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
    await waitForGateway(child);
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
