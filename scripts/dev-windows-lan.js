#!/usr/bin/env node
// 局域网（LAN）开发启动脚本：与 dev-windows.js 相同，
// 唯一区别是 Vite 监听 0.0.0.0，允许同网段设备通过本机内网 IP 访问。
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const dotenv = require('dotenv');

const root = path.resolve(__dirname, '..');
process.chdir(root);
dotenv.config({ path: path.join(root, '.env.local') });
dotenv.config({ path: path.join(root, '.env') });
process.env.MIAODA_LOCAL_DEV = '1';
process.env.NODE_ENV = 'development';

const HOST = process.env.LAN_HOST || '0.0.0.0';
const PORT = process.env.LAN_PORT || '5173';

function getLanAddresses() {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  return addrs;
}

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
      HOST,
      '--port',
      PORT,
      '--strictPort',
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
console.log(`[dev:lan] listening on ${HOST}:${PORT}`);
console.log(`[dev:lan] local:   http://127.0.0.1:${PORT}/app/${appId}/`);
for (const ip of getLanAddresses()) {
  console.log(`[dev:lan] network: http://${ip}:${PORT}/app/${appId}/`);
}
