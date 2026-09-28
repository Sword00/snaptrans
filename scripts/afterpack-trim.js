'use strict';
/**
 * electron-builder afterPack 钩子：按目标平台裁剪 onnxruntime 的原生二进制。
 *
 * 为什么需要它：
 *   onnxruntime-node 一个包就把**所有平台**的二进制都塞进来了（实测 darwin 86MB、
 *   linux 69MB、win32 134MB，合计约 290MB）。它没法靠 npm 的 os/cpu 字段自动裁剪，
 *   因为 package.json 里写的是 `os: ["win32","darwin","linux"]` —— 三个平台都算「支持」。
 *   不裁的话，一个 Windows 安装包里会白扛 155MB 的 macOS + Linux 二进制。
 *
 * 为什么不用 `files` 里写死 `!**\/darwin\/**`：
 *   那种写法把「排除哪个平台」和「当前在打哪个平台」耦合成了同一份静态配置，
 *   打包脚本必须按平台改 package.json。而且 electron-builder 里
 *   根 files 与 win/mac/linux.files 的合并语义（谁覆盖谁）没有明确文档，
 *   踩过一次就会静默多带 155MB。
 *   afterPack 拿得到确定的 context.electronPlatformName / arch，行为没有歧义。
 *
 * 时机：afterPack 在「app 目录已生成」之后、「安装包开始制作」之前执行，
 * 所以这里删掉的文件不会进最终产物。
 */
const fs = require('fs');
const path = require('path');

/** electron-builder 的 Arch 枚举（数字）→ 目录名 */
const ARCH_NAME = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

/** 每个平台下真正需要的目录（相对 bin/napi-v6） */
const NEEDED = {
  win32: { ia32: 'win32/x64', x64: 'win32/x64', arm64: 'win32/arm64' },
  darwin: { x64: 'darwin/x64', arm64: 'darwin/arm64' },
  linux: { x64: 'linux/x64', arm64: 'linux/arm64' },
};

function dirSize(dir) {
  let total = 0;
  let stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { total += fs.statSync(p).size; } catch (_) { /* ignore */ } }
    }
  }
  return total;
}

/** macOS 的 app 在 <appOutDir>/<名字>.app 里，resources 要多下两层 */
function findResources(appOutDir, platformName) {
  if (platformName === 'darwin') {
    let entries = [];
    try { entries = fs.readdirSync(appOutDir); } catch (_) { return null; }
    for (const e of entries) {
      if (!e.endsWith('.app')) continue;
      const r = path.join(appOutDir, e, 'Contents', 'Resources');
      if (fs.existsSync(r)) return r;
    }
    return null;
  }
  const r = path.join(appOutDir, 'resources');
  return fs.existsSync(r) ? r : null;
}

exports.default = async function afterPack(context) {
  const platformName = context.electronPlatformName;
  const archName = ARCH_NAME[context.arch]
    || (context.packager && context.packager.arch)
    || process.arch;

  const resources = findResources(context.appOutDir, platformName);
  if (!resources) {
    console.warn(`[trim] 找不到 resources 目录（${context.appOutDir}），跳过裁剪`);
    return;
  }

  const base = path.join(
    resources, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6',
  );
  if (!fs.existsSync(base)) {
    console.warn(`[trim] 未找到 onnxruntime 的 bin 目录，跳过裁剪：${base}`);
    return;
  }

  const keep = (NEEDED[platformName] || {})[archName];
  if (!keep) {
    console.warn(`[trim] 不认识的目标平台 ${platformName}/${archName}，不做裁剪（保守起见全留）`);
    return;
  }

  const [keepOs, keepArch] = keep.split('/');
  const keepPath = path.join(base, keepOs, keepArch);

  // 先确认要保留的东西真的在 —— 万一上游改了目录结构，
  // 宁可不裁也不能把唯一的可用二进制删掉。
  if (!fs.existsSync(keepPath)) {
    const available = [];
    for (const os of fs.readdirSync(base)) {
      const p = path.join(base, os);
      if (!fs.statSync(p).isDirectory()) continue;
      available.push(`${os}: ${fs.readdirSync(p).join('|')}`);
    }
    console.error(`[trim] ❌ 目标 ${keepPath} 不存在，为安全起见不裁剪。`);
    console.error(`[trim]    实际可用：${available.join('  ')}`);
    if (platformName === 'darwin' && archName === 'x64') {
      console.error('[trim]    提示：onnxruntime-node 在 macOS 上只提供 arm64，'
        + '这个包打出来在 Intel Mac 上无法使用本地 OCR。');
    }
    return;
  }

  let removedDirs = 0;
  let freedBytes = 0;

  for (const os of fs.readdirSync(base)) {
    const osPath = path.join(base, os);
    if (!fs.statSync(osPath).isDirectory()) continue;

    if (os !== keepOs) {
      freedBytes += dirSize(osPath);
      fs.rmSync(osPath, { recursive: true, force: true });
      removedDirs++;
      continue;
    }
    for (const arch of fs.readdirSync(osPath)) {
      if (arch === keepArch) continue;
      const archPath = path.join(osPath, arch);
      if (!fs.statSync(archPath).isDirectory()) continue;
      freedBytes += dirSize(archPath);
      fs.rmSync(archPath, { recursive: true, force: true });
      removedDirs++;
    }
  }

  const mb = (freedBytes / 1048576).toFixed(1);
  console.log(`[trim] ${platformName}/${archName}：保留 ${keepOs}/${keepArch}，`
    + `删除 ${removedDirs} 个非目标目录，释放 ${mb} MB`);

  // 收尾核对：目标二进制真的还在
  const files = fs.readdirSync(keepPath);
  console.log(`[trim] 保留目录内容：${files.join(', ')}`);
};
