'use strict';
/**
 * 平台适配层。
 *
 * 把 macOS 特有的东西集中在这里，Windows / Linux 上全部是安全 no-op，
 * 调用方（main.js）不需要到处写 `if (process.platform === 'darwin')`。
 *
 * 这里只处理三件在 macOS 上「不做就真的不能用」的事：
 *   1. 屏幕录制 TCC 授权 —— 未授权时 desktopCapturer 返回的是**全黑图**而不是空数组，
 *      不检测的话用户看到的是「遮罩一片黑」，根本猜不到是权限问题。
 *   2. Dock 隐藏 + 应用菜单 —— 托盘应用要藏 Dock，但藏了 Dock 就收不到键盘焦点，
 *      而且没有应用菜单时 Cmd+C / Cmd+V / Cmd+Q 在设置窗口里全部失效（Electron 的已知行为）。
 *   3. 原生模块能力探测 —— onnxruntime-node 1.30 的 darwin 目录**只有 arm64**，
 *      Intel Mac 上 OCR 直接起不来，要在界面上说清楚而不是抛一句原生模块加载失败。
 */
const path = require('path');
const fs = require('fs');

// 允许在纯 Node（自检脚本）下加载：此时 require('electron') 是二进制路径字符串
let electron = null;
try { electron = require('electron'); } catch (_) { electron = null; }
const app = (electron && electron.app) || null;
const Menu = (electron && electron.Menu) || null;
const dialog = (electron && electron.dialog) || null;
const shell = (electron && electron.shell) || null;
const systemPreferences = (electron && electron.systemPreferences) || null;

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const isLinux = process.platform === 'linux';

/** 当前平台给用户看的名字 */
const platformName = isMac ? 'macOS' : isWin ? 'Windows' : 'Linux';

/* ==================== 焦点 ==================== */

/**
 * 托盘应用在 macOS 上是「附件型应用」（app.dock.hide() 之后），
 * 这种应用调用 win.show() **不会**自动把窗口带到前台、也拿不到键盘焦点 ——
 * 遮罩层的 ESC 退出、设置窗口的输入框就都收不到按键。
 * app.focus({ steal: true }) 是官方给附件型应用抢焦点的唯一入口。
 * 非 macOS 上是 no-op（Windows 的遮罩本来就靠 setAlwaysOnTop + focus()）。
 */
function focusApp() {
  if (!isMac || !app) return;
  try { app.focus({ steal: true }); } catch (_) { /* ignore */ }
}

/* ==================== Dock ==================== */

function hideDock() {
  if (!isMac || !app || !app.dock) return;
  try { app.dock.hide(); } catch (_) { /* ignore */ }
}

function showDock() {
  if (!isMac || !app || !app.dock) return;
  try { app.dock.show(); } catch (_) { /* ignore */ }
}

/* ==================== 屏幕录制权限 ==================== */

/** 系统设置 → 隐私与安全性 → 屏幕录制 的深链 */
const SCREEN_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

/**
 * 返回 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'。
 * 非 macOS 恒为 'granted'（Windows 不需要这个权限）。
 */
function screenAccessStatus() {
  if (!isMac) return 'granted';
  if (!systemPreferences || typeof systemPreferences.getMediaAccessStatus !== 'function') return 'unknown';
  try { return systemPreferences.getMediaAccessStatus('screen'); } catch (_) { return 'unknown'; }
}

function openScreenSettings() {
  if (!shell) return;
  try { shell.openExternal(SCREEN_SETTINGS_URL).catch(() => {}); } catch (_) { /* ignore */ }
}

/**
 * 缩略图是不是「全黑」。
 *
 * 为什么需要这个：macOS 未授权屏幕录制时，desktopCapturer.getSources() **不报错、也不返回空数组**，
 * 而是返回尺寸正常、内容全黑的缩略图。只判断 `sources.length` 的话会一路走到「遮罩全黑」，
 * 用户完全看不出是权限问题。实测踩到过。
 *
 * 采样而不是全量扫：一张 4K 缩略图 830 万像素，全量扫要几十毫秒，
 * 这里只需要判断「是不是全黑」，按网格采 ~4000 个点足够。
 * 容差取 8 —— 真正的全黑图（TCC 拦截）三个通道都是 0，而再暗的主题也不至于整屏 < 8。
 */
function looksBlank(img, tol = 8) {
  if (!img) return true;
  let size;
  try { size = img.getSize(); } catch (_) { return true; }
  if (!size || !size.width || !size.height) return true;

  let buf;
  try { buf = img.toBitmap(); } catch (_) { return true; }
  if (!buf || !buf.length) return true;

  const total = size.width * size.height;
  // 步长取整到 ≥1，保证采样点数落在 2000~4000 之间
  const step = Math.max(1, Math.floor(Math.sqrt(total / 3000)));
  let maxSeen = 0;
  for (let y = 0; y < size.height; y += step) {
    for (let x = 0; x < size.width; x += step) {
      const p = (y * size.width + x) * 4;
      // 通道顺序不用管（BGRA/RGBA 都行），只取最大值判断「有没有任何亮度」
      const v = Math.max(buf[p], buf[p + 1], buf[p + 2]);
      if (v > maxSeen) maxSeen = v;
      if (maxSeen > tol) return false;
    }
  }
  return true;
}

/**
 * 纯函数：把「权限状态 + 每块屏幕是否全黑」映射成守卫结论。返回：
 *   { ok: true }
 *   { ok: false, reason: 'denied' }            明确被拒 / 受策略限制
 *   { ok: false, reason: 'blank', status }     状态说授权了，但拿回来的是全黑
 *
 * 之所以把 mac 也做成参数：这样 macOS 的分支能在 Windows 上单测。
 * 否则这段判定永远只能靠真机验证，而它恰好是最需要覆盖的（三种状态 × 全黑与否）。
 */
function decideCapture({ isMac: mac = isMac, status, blank = [] }) {
  if (!mac) return { ok: true };
  if (status === 'denied' || status === 'restricted') return { ok: false, reason: 'denied', status };
  // 全部屏幕源都是全黑 → 基本可以断定是 TCC 没生效
  if (blank.length && blank.every(Boolean)) return { ok: false, reason: 'blank', status };
  return { ok: true, status };
}

/** 截图前的守卫：探测真实状态后交给 decideCapture */
function guardCapture(sources) {
  const list = Array.isArray(sources) ? sources : [];
  return decideCapture({
    status: screenAccessStatus(),
    blank: list.map((s) => looksBlank(s && s.thumbnail)),
  });
}

/**
 * 把守卫的结论翻译成人话，并给出可点的动作。
 * 返回用户选了什么：'settings' | 'relaunch' | 'continue' | 'cancel'
 *
 * 关于「重启应用」这个选项：macOS 的 TCC 授权是在**进程启动时**读取的。
 * 用户刚在系统设置里打开开关，本进程拿到的仍然是黑帧 —— 必须重启才生效。
 * 所以这里不是敷衍的兜底，而是这一步真正的解法。
 */
async function explainCaptureBlocked(info) {
  if (!dialog) return 'cancel';
  const { reason, status } = info || {};

  const isDenied = reason === 'denied';
  const message = isDenied
    ? `${platformName} 拒绝了 SnapTrans 录制屏幕`
    : '截取到的画面是全黑的';

  const detail = isDenied
    ? [
      '系统设置 → 隐私与安全性 → 屏幕录制，勾选 SnapTrans。',
      '',
      '注意：授权后需要**重启应用**才会生效 ——',
      'macOS 只在进程启动时读取这个权限，已经跑着的进程拿到的仍然是黑屏。',
    ].join('\n')
    : [
      status === 'not-determined'
        ? '刚才应该弹出过「SnapTrans 想要录制此电脑的屏幕」，如果没有看到，去系统设置里手动打开。'
        : '权限看起来是开着的，但本次进程拿到的画面是全黑的。',
      '',
      '最常见的原因：刚授权完还没有重启应用。',
      '（如果你的桌面本身确实是纯黑的，可以点「仍然继续」。）',
    ].join('\n');

  const buttons = ['打开系统设置', '重启应用', '仍然继续', '取消'];
  const map = ['settings', 'relaunch', 'continue', 'cancel'];

  // 附件型应用弹模态框：临时把 Dock 图标放出来，用户才找得到这个框、也能 Cmd+Tab 过来。
  showDock();
  focusApp();
  let r;
  try {
    r = await dialog.showMessageBox({
      type: 'warning',
      title: '无法截取屏幕',
      message,
      detail,
      buttons,
      defaultId: 0,
      cancelId: 3,
      noLink: true,
    });
  } catch (_) {
    hideDock();
    return 'cancel';
  }
  hideDock();
  return map[r && r.response] || 'cancel';
}

/* ==================== 应用菜单 ==================== */

/**
 * macOS 上必须显式装一个应用菜单，否则：
 *   - Cmd+Q / Cmd+W 完全没反应
 *   - 设置窗口的输入框里 Cmd+C / Cmd+V / Cmd+A 全部失效
 *     （Chromium 在 macOS 上把编辑快捷键交给菜单的 Edit 角色处理，没有菜单就没有它们）
 * Windows / Linux 上不装（那边窗口自带菜单栏逻辑，装了反而多一条没用的菜单）。
 *
 * 注意：不在「截图翻译」这一项上挂 accelerator。
 * 全局快捷键已经由 globalShortcut 占住了，再挂一次会让人以为是菜单触发的。
 */
function installMenu({ onCapture, onSettings, hotkeyLabel, onQuit } = {}) {
  if (!isMac || !Menu || !app) return false;

  const name = (app && app.getName && app.getName()) || 'SnapTrans';
  const captureLabel = hotkeyLabel ? `截图翻译  ${hotkeyLabel}` : '截图翻译';

  const template = [
    {
      label: name,
      submenu: [
        { label: captureLabel, click: () => onCapture && onCapture() },
        { label: '设置…', accelerator: 'Command+,', click: () => onSettings && onSettings() },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${name}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { label: `退出 ${name}`, accelerator: 'Command+Q', click: () => onQuit && onQuit() },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' },
      ],
    },
  ];

  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    return true;
  } catch (e) {
    console.error('[platform] 应用菜单安装失败：', (e && e.message) || e);
    return false;
  }
}

/* ==================== 原生模块能力探测 ==================== */

/**
 * 本机能不能跑本地 OCR。
 *
 * 为什么要在启动时就探而不是等用的时候报错：
 *   onnxruntime-node@1.30.0 的 `bin/napi-v6/darwin/` 下**只有 arm64**，没有 x64。
 *   Intel Mac 上 `require('onnxruntime-node')` 抛的是原生模块加载失败，
 *   用户完全读不出「你的 CPU 架构没有预编译二进制」这层意思。
 *
 * 探测方式直接看文件在不在 —— 这是唯一可信的依据，
 * 别信 package.json 里 os: ["win32","darwin","linux"] 的声明（它不含 arch）。
 */
function localOcrSupport() {
  if (process.env.SNAPTRANS_SKIP_OCR_ARCH_CHECK) return { ok: true, skipped: true };

  const base = path.join(__dirname, '..', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
  let dir = base;
  try {
    if (fs.existsSync(base)) {
      dir = path.join(base, process.platform, process.arch);
      if (!fs.existsSync(dir)) {
        return {
          ok: false,
          reason: 'arch',
          detail: `onnxruntime-node 没有 ${process.platform}/${process.arch} 的预编译二进制（找的是 ${dir}）。`
            + (isMac && process.arch === 'x64'
              ? ' macOS 上这个包只提供 arm64（Apple Silicon）版本，Intel Mac 无法使用本地 OCR。'
              : ''),
        };
      }
    }
  } catch (_) { /* 探测失败不阻塞启动，让真正的加载错误去报 */ }
  return { ok: true };
}

module.exports = {
  isMac, isWin, isLinux, platformName,
  focusApp, hideDock, showDock,
  screenAccessStatus, openScreenSettings, looksBlank, decideCapture, guardCapture,
  explainCaptureBlocked,
  installMenu,
  localOcrSupport,
};
