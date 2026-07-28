#!/usr/bin/env node
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const result = spawnSync(
  process.execPath,
  [
    path.join(root, 'node_modules', 'jest', 'bin', 'jest.js'),
    'server/modules/reconciliation/confirmed-settlement.postgres.spec.ts',
    '--runInBand',
  ],
  {
    cwd: root,
    env: { ...process.env, RUN_POSTGRES_INTEGRATION: '1' },
    stdio: 'inherit',
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
