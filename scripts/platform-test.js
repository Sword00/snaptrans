'use strict';
/**
 * 平台适配层单测（需要 Electron，用 nativeImage 造图）
 *
 *   npm run test:platform
 *
 * 为什么这些必须单测、不能只靠 Mac 上试：
 *   - 屏幕录制权限的三条分支（denied / 状态已授权但全黑 / 正常）里，
 *     「状态已授权但全黑」这条在真机上极难复现（要恰好卡在刚授权未重启的窗口期），
 *     而它恰恰是最容易踩的 —— 所以把判定抽成纯函数 decideCapture 在这里穷举。
 *   - looksBlank 是整条兜底链路的唯一判据，判错了要么漏报（用户看黑屏一脸懵）、
 *     要么误报（桌面本身就是深色时被反复拦住）。
 *
 * 这里跑在 Windows 上，所有 macOS 专属动作（dock / menu / TCC）都只能验证「不抛异常」。
 * 真机行为仍需在 Mac 上确认，见 README-macOS。
 */
const path = require('path');
const fs = require('fs');
const { app, nativeImage } = require('electron');

const platform = require('../src/platform');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  \u2705 ${name}`); }
  else { fail++; console.log(`  \u274c ${name}${extra ? '  \u2192 ' + extra : ''}`); }
}

const ROOT = path.join(__dirname, '..');

/* ---------- 1. decideCapture 判定表（macOS 分支） ---------- */
console.log('\n[1] decideCapture —— macOS 屏幕录制权限判定表');
const table = [
  // [mac, status, blank[], 期望 ok, 期望 reason]
  [false, 'denied', [true], true, undefined, 'Windows 不看权限，直接放行'],
  [false, 'unknown', [true, true], true, undefined, 'Windows 即使全黑也放行（不做这个判定）'],
  [true, 'granted', [false], true, undefined, '已授权 + 有内容 → 放行'],
  [true, 'granted', [false, false], true, undefined, '多屏都有内容 → 放行'],
  [true, 'granted', [true, false], true, undefined, '只要有一块屏有内容就放行'],
  [true, 'denied', [true], false, 'denied', '明确被拒 → 拦'],
  [true, 'restricted', [false], false, 'denied', '受策略限制 → 拦（哪怕图不黑）'],
  [true, 'granted', [true], false, 'blank', '状态已授权但全黑 → 拦（典型：刚授权未重启）'],
  [true, 'not-determined', [true], false, 'blank', '首次运行、还没弹过授权框 → 拦'],
  [true, 'unknown', [true, true], false, 'blank', '状态读不到但全黑 → 拦'],
  [true, 'granted', [], true, undefined, '没有屏幕源时不越权判定（交给上层报错）'],
];
for (const [mac, status, blank, wantOk, wantReason, desc] of table) {
  const got = platform.decideCapture({ isMac: mac, status, blank });
  const good = got.ok === wantOk && got.reason === wantReason;
  ok(`${desc}  [mac=${mac} ${status} blank=${JSON.stringify(blank)}]`, good, JSON.stringify(got));
}

/* ---------- 2. looksBlank 像素判定 ---------- */
console.log('\n[2] looksBlank —— 「全黑」判据');

/** 造一张纯色 / 带噪点的 BGRA 位图 */
function makeImage(w, h, fill, spots) {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = fill[0]; buf[i * 4 + 1] = fill[1]; buf[i * 4 + 2] = fill[2]; buf[i * 4 + 3] = 255;
  }
  for (const [x, y, c] of spots || []) {
    const p = (y * w + x) * 4;
    buf[p] = c[0]; buf[p + 1] = c[1]; buf[p + 2] = c[2]; buf[p + 3] = 255;
  }
  return nativeImage.createFromBitmap(buf, { width: w, height: h });
}

ok('纯黑 200x150 → 全黑', platform.looksBlank(makeImage(200, 150, [0, 0, 0])) === true);
ok('纯黑 1x1 → 全黑', platform.looksBlank(makeImage(1, 1, [0, 0, 0])) === true);
ok('接近黑（RGB=6）→ 仍算全黑', platform.looksBlank(makeImage(120, 90, [6, 6, 6])) === true);
ok('接近黑（RGB=9）→ 不算全黑', platform.looksBlank(makeImage(120, 90, [9, 9, 9])) === false);
ok('纯白 → 不算全黑', platform.looksBlank(makeImage(200, 150, [255, 255, 255])) === false);
// 全黑图里只有 1 个亮点：采样是网格抽样，1px 亮点可能被跳过 —— 这是已知且有意的取舍
// （真实场景里 TCC 拦截是整屏全黑，不存在「只有一个亮点」）
ok('纯黑 + 一条亮边 → 不算全黑',
  platform.looksBlank(makeImage(200, 150, [0, 0, 0], [[0, 0, [200, 200, 200]], [1, 0, [200, 200, 200]], [2, 0, [200, 200, 200]], [3, 0, [200, 200, 200]]])) === false);
ok('null / undefined → 当全黑（宁可拦也不放行）',
  platform.looksBlank(null) === true && platform.looksBlank(undefined) === true);
ok('空图（0 尺寸）→ 当全黑', platform.looksBlank(nativeImage.createEmpty()) === true);

// 真实截图：这是最接近线上的一次校验
const realShot = path.join(ROOT, 'demo', 'demo-before.png');
if (fs.existsSync(realShot)) {
  const img = nativeImage.createFromPath(realShot);
  ok('真实截图 demo-before.png → 不算全黑', platform.looksBlank(img) === false,
    `size=${JSON.stringify(img.getSize())}`);
} else {
  console.log('  \u26a0\ufe0f  跳过真实截图校验（demo/demo-before.png 不存在）');
}

/* ---------- 3. 非 macOS 上的行为 ---------- */
console.log('\n[3] 非 macOS 平台（当前就是）');
ok('screenAccessStatus() 恒为 granted', platform.screenAccessStatus() === 'granted');
ok('guardCapture() 放行', platform.guardCapture([{ thumbnail: makeImage(8, 8, [0, 0, 0]) }]).ok === true);
ok('installMenu() 在非 macOS 上不安装（返回 false）', platform.installMenu({}) === false);
ok('hideDock / showDock / focusApp 不抛异常', (() => {
  try { platform.hideDock(); platform.showDock(); platform.focusApp(); return true; } catch (_) { return false; }
})());

/* ---------- 4. 本地 OCR 架构探测 ---------- */
console.log('\n[4] localOcrSupport —— 原生模块架构探测');
const sup = platform.localOcrSupport();
ok(`当前机器 ${process.platform}/${process.arch} 支持本地 OCR`, sup.ok === true, JSON.stringify(sup));

// 直接验证「平台目录枚举」这条路径。
// 注意：不能靠改 process.platform 来伪造 macOS —— platform.js 在模块加载时就把
// process.platform 读进常量了（isMac 等），运行时改它不会影响已经加载的模块。
// 所以 macOS 的分支判定统一由上面第 1 节的 decideCapture 纯函数覆盖。
const binBase = path.join(ROOT, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
if (fs.existsSync(binBase)) {
  const platforms = fs.readdirSync(binBase);
  ok(`onnxruntime 平台目录可枚举（${platforms.join(', ')}）`, platforms.length > 0);
  const darwinDir = path.join(binBase, 'darwin');
  if (fs.existsSync(darwinDir)) {
    const archs = fs.readdirSync(darwinDir);
    console.log(`  \u2139\ufe0f  darwin 下可用架构：${archs.join(', ') || '(空)'}`);
    ok('darwin 有 arm64（Apple Silicon 可用）', archs.includes('arm64'));
    if (!archs.includes('x64')) {
      console.log('  \u2139\ufe0f  没有 x64 —— Intel Mac 无法使用本地 OCR，这是上游 onnxruntime-node 的限制');
    }
  } else {
    console.log('  \u26a0\ufe0f  未找到 darwin 目录（Windows 上 npm 只装 win32 二进制时会这样）');
  }
} else {
  console.log('  \u26a0\ufe0f  未找到 onnxruntime-node 的 bin 目录，跳过架构探测');
}

/* ---------- 5. macOS 图标资源 ---------- */
console.log('\n[5] macOS 图标资源');

/** 直接读 PNG 的 IHDR，拿到磁盘上真实的像素尺寸 */
function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.slice(1, 4).toString('ascii') !== 'PNG') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

const trayTemplate = path.join(ROOT, 'assets', 'trayTemplate.png');
const trayTemplate2x = path.join(ROOT, 'assets', 'trayTemplate@2x.png');
const icns = path.join(ROOT, 'assets', 'icon.icns');

if (fs.existsSync(trayTemplate)) {
  const img = nativeImage.createFromPath(trayTemplate);
  ok('assets/trayTemplate.png 可加载', !img.isEmpty());
  const sz = img.getSize();
  ok(`trayTemplate 尺寸为 16x16（实际 ${sz.width}x${sz.height}）`, sz.width === 16 && sz.height === 16);

  // 注意：Electron 的 setTemplateImage 只在 macOS 上生效，其他平台是 no-op，
  // isTemplateImage() 会一直返回 false。所以这条只能在 Mac 上断言。
  if (platform.isMac) {
    img.setTemplateImage(true);
    ok('trayTemplate 可标记为 template image', img.isTemplateImage() === true);
  } else {
    console.log('  \u2139\ufe0f  跳过 template image 标记校验（非 macOS 上 setTemplateImage 是 no-op）');
  }

  // template image 必须是纯黑 + alpha：任何非黑像素都会在菜单栏上显成脏点
  const bmp = img.toBitmap();
  let maxChannel = 0;
  let opaque = 0;
  for (let i = 0; i < bmp.length; i += 4) {
    maxChannel = Math.max(maxChannel, bmp[i], bmp[i + 1], bmp[i + 2]);
    if (bmp[i + 3] > 0) opaque++;
  }
  ok('trayTemplate 的所有可见像素都是纯黑（RGB=0）', maxChannel === 0, `最大通道值 ${maxChannel}`);
  ok('trayTemplate 有实际图形（不透明像素 > 15%）',
    opaque > 16 * 16 * 0.15, `不透明像素 ${opaque}/${16 * 16}`);
} else {
  fail++;
  console.log('  \u274c assets/trayTemplate.png 不存在 —— 运行 npm run icons 生成');
}

if (fs.existsSync(trayTemplate2x)) {
  // 磁盘上必须是 32x32 —— 这里不能看 getSize()：
  // Electron 认识 `@2x` 后缀，会把它当成 trayTemplate 的 Retina 表示，
  // getSize() 返回的是**逻辑尺寸 16x16**，直接断言 32 会误判成失败（踩过）。
  const raw = pngSize(trayTemplate2x);
  ok(`trayTemplate@2x 位图尺寸为 32x32（实际 ${raw && raw.width}x${raw && raw.height}）`,
    !!raw && raw.width === 32 && raw.height === 32);
  ok('trayTemplate@2x 被 Electron 识别为 2x 表示（逻辑尺寸 16）',
    nativeImage.createFromPath(trayTemplate2x).getSize().width === 16);
} else {
  fail++;
  console.log('  \u274c assets/trayTemplate@2x.png 不存在');
}

if (fs.existsSync(icns)) {
  const buf = fs.readFileSync(icns);
  const magic = buf.slice(0, 4).toString('ascii');
  const declared = buf.readUInt32BE(4);
  ok('icon.icns magic = "icns"', magic === 'icns', magic);
  ok(`icon.icns 头部长度与文件实际长度一致（${declared} / ${buf.length}）`, declared === buf.length);

  // 逐个 chunk 走一遍，确认每个 chunk 的 length 都落在文件内
  const types = [];
  let off = 8;
  let badChunk = null;
  while (off + 8 <= buf.length) {
    const type = buf.slice(off, off + 4).toString('ascii');
    const len = buf.readUInt32BE(off + 4);
    if (len < 8 || off + len > buf.length) { badChunk = `${type} len=${len} @${off}`; break; }
    types.push(type);
    off += len;
  }
  ok('icon.icns 所有 chunk 边界合法', badChunk === null, badChunk || '');
  ok('icon.icns 覆盖到 512 与 1024（macOS 图标必须有大尺寸）',
    types.includes('ic09') && types.includes('ic10'), types.join(','));
  ok('icon.icns chunk 遍历正好走到文件末尾', off === buf.length, `off=${off} len=${buf.length}`);
} else {
  fail++;
  console.log('  \u274c assets/icon.icns 不存在 —— 运行 npm run icons 生成');
}

/* ---------- 6. 默认快捷键 ---------- */
console.log('\n[6] 默认快捷键（按平台区分）');
{
  const settings = require('../src/settings');
  const { looksSafe } = require('../src/hotkey');
  const hk = settings.DEFAULTS.hotkey;

  ok(`默认快捷键 ${hk} 通过安全检查`, looksSafe(hk) === true);
  if (platform.isMac) {
    // Alt+Shift+A 在 macOS 上是 Option+Shift+A，系统会把它当特殊字符输入（实际打出 Å），
    // 注册成全局键等于吞掉这个组合的正常用途
    ok('macOS 默认用 Command 开头（不能沿用 Alt）', /^Command\+/.test(hk), hk);
  } else {
    ok('非 macOS 保持 Alt+Shift+A 不变', hk === 'Alt+Shift+A', hk);
  }
  // 两个平台的默认值都必须能过 looksSafe —— 这是设置面板与注册器共用的闸门
  ok('Command+Shift+A 本身也通过安全检查', looksSafe('Command+Shift+A') === true);
}

/* ---------- 汇总 ---------- */
console.log(`\n${fail === 0 ? '\u2705' : '\u274c'} platform 单测：${pass} 通过 / ${fail} 失败`);
app.exit(fail === 0 ? 0 : 1);
