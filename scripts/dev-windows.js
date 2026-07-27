#!/usr/bin/env node
const path = require('node:path');
const { spawn } = require('node:child_process');
const dotenv = require('dotenv');

const root = path.resolve(__dirname, '..');
process.chdir(root);
dotenv.config({ path: path.join(root, '.env.local') });
dotenv.config({ path: path.join(root, '.env') });
process.env.MIAODA_LOCAL_DEV = '1';
process.env.NODE_ENV = 'development';

const commands = [
  {
    name: 'server',
    args: [
      path.join(root, 'node_modules', '@nestjs', 'cli', 'bin', 'nest.js'),
      'start',
      '--watch',
    ],
  },
  {
    name: 'client',
    args: [
      path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
      '--config',
      'vite.config.ts',
      '--host',
      '127.0.0.1',
      '--port',
      '5173',
    ],
  },
];

const children = commands.map(({ name, args }) => {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  child.on('error', (error) => console.error(`[${name}]`, error));
  return child;
});

const stop = () => {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) {
  child.on('exit', (code) => {
    if (code && code !== 0) {
      stop();
      process.exitCode = code;
    }
  });
}

const appId = process.env.MIAODA_APP_ID || 'app_17a7d7fdmvg';
console.log(`[dev] http://127.0.0.1:5173/app/${appId}/`);
