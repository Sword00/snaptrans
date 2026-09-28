'use strict';
/**
 * 启动器。
 *
 * 某些环境（IDE 内置终端、CI、部分开发容器）会注入 ELECTRON_RUN_AS_NODE=1，
 * 这会让 electron.exe 退化成普通 Node —— 表现为 require('electron') 拿不到 app，
 * 报 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`。
 * 这里统一清掉这些变量再拉起 Electron。
 *
 * 用法：
 *   node scripts/start.js                    启动应用
 *   node scripts/start.js scripts/uitest.js  用 Electron 跑指定脚本
 */
const { spawn } = require('child_process');
const path = require('path');

let exePath;
try {
  // 纯 Node 环境下返回 electron.exe 的绝对路径
  exePath = require('electron');
} catch (e) {
  console.error('未找到 electron，请先执行 npm install');
  process.exit(1);
}
if (typeof exePath !== 'string') {
  // 已经运行在 Electron 主进程里了
  exePath = process.execPath;
}

const first = process.argv[2];
const isScript = first && /\.(c?js|mjs)$/i.test(first);
const entry = isScript ? path.resolve(first) : path.join(__dirname, '..');
const rest = isScript ? process.argv.slice(3) : process.argv.slice(2);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

const child = spawn(exePath, [entry, ...rest], { stdio: 'inherit', env });

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code == null ? 0 : code);
});
child.on('error', (e) => {
  console.error('启动失败：', e.message);
  process.exit(1);
});
