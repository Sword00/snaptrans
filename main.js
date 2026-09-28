'use strict';
/**
 * SnapTrans 主进程
 * 托盘常驻 + 全局快捷键 + 多屏遮罩截图 + OCR/翻译 + 贴图窗口
 */
const {
  app, BrowserWindow, globalShortcut, ipcMain, screen, desktopCapturer,
  Tray, Menu, nativeImage, clipboard, dialog, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');

const settings = require('./src/settings');
const pipeline = require('./src/pipeline');
const translateMod = require('./src/translate');
const ocr = require('./src/ocr');
const native = require('./src/native');
const datadir = require('./src/datadir');
const hotkeyUtil = require('./src/hotkey');
const { configureGpu } = require('./src/gpu');

/* ---------------- 数据目录重定向 ----------------
 * 必须跑在**任何**读写 userData 的代码之前（日志、settings、OCR 缓存都在 userData 下），
 * 而且 app.setPath('userData', ...) 只在 app ready 之前有效。
 * 详见 src/datadir.js。
 */
const dataDirInfo = datadir.applyOverride();

/* ---------------- 日志 ----------------
 * 同时输出到控制台和 userData/snaptrans.log。
 * 打包后是 GUI 程序、stdout 拿不到，出问题时让用户直接把日志文件发过来。
 * 注意：必须定义在下面任何调用之前（logStream 是 let，提前调用会踩 TDZ）。
 */
let logStream = null;
function logFile() {
  if (logStream) return logStream;
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    logStream = fs.createWriteStream(path.join(dir, 'snaptrans.log'), { flags: 'a' });
  } catch (_) {
    logStream = false;
  }
  return logStream;
}

function log(...a) {
  console.log('[main]', ...a);
  const s = logFile();
  if (s) {
    try { s.write(`${new Date().toISOString()} [main] ${a.map(String).join(' ')}\n`); } catch (_) {}
  }
}

/* 同步写一行日志。log() 走的是 createWriteStream（异步、有缓冲），
 * 而冒烟模式结尾要立刻 app.exit() —— exit 不会等流刷盘，那一行判定结果会直接丢掉。
 * 踩过：日志里永远看不到「check-ocr： 通过」，只能靠退出码反推。
 * 所以「退出前必须落地」的日志一律用这个。 */
function logSync(...a) {
  console.log('[main]', ...a);
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'snaptrans.log'),
      `${new Date().toISOString()} [main] ${a.map(String).join(' ')}\n`,
    );
  } catch (_) { /* 日志写不进去不能影响主流程 */ }
}

process.on('uncaughtException', (e) => {
  log('未捕获异常：', (e && e.stack) || e);
});
process.on('unhandledRejection', (e) => {
  log('未处理的 Promise 拒绝：', (e && e.stack) || e);
});

log(`模块加载完成，pid=${process.pid}`);
log('数据目录：', dataDirInfo.dir, dataDirInfo.custom ? '(自定义)' : '(默认)');
if (dataDirInfo.error) {
  log('数据目录警告：', dataDirInfo.error, dataDirInfo.wanted ? `（引导文件指向 ${dataDirInfo.wanted}）` : '');
}

/* ---------------- 打包冒烟模式（见 app.whenReady 里的分支） ----------------
 * 两种触发方式：
 *   SNAPTRANS_CHECK_OCR=<图片路径|空>     ← 打包版用这个
 *   --check-ocr [图片路径]                ← 开发态用这个
 * 打包版（改名后的 electron.exe）会对不认识的 `--xxx` 直接报 `bad option` 退出，
 * 所以正式冒烟走环境变量。
 */
const CHECK_OCR_ENV = process.env.SNAPTRANS_CHECK_OCR;
const checkArgIdx = process.argv.indexOf('--check-ocr');
const CHECK_OCR = CHECK_OCR_ENV !== undefined || checkArgIdx >= 0;
const CHECK_OCR_IMG = CHECK_OCR_ENV || (checkArgIdx >= 0 ? process.argv[checkArgIdx + 1] : '') || '';

// 冒烟是一次性 CLI，不参与单实例互斥 ——
// 否则主程序开着的时候跑冒烟，会被「已有实例在运行」直接顶掉
const gotLock = CHECK_OCR || app.requestSingleInstanceLock();
log('单实例锁：', CHECK_OCR ? '跳过（冒烟模式）' : (gotLock ? '获取成功' : '已有实例在运行，本实例退出'));
if (!gotLock) {
  // 已有实例在跑：新实例把截图请求转过去后立刻退出（见 second-instance）
  app.quit();
}

configureGpu(app);

app.setAppUserModelId('com.snaptrans.app');

let tray = null;
let overlays = [];
let pinned = [];
let settingsWin = null;
let capPhase = 'idle';   // idle | starting | active
let quitting = false;

const ROOT = __dirname;
const R = (...p) => path.join(ROOT, ...p);


function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ==================== 截图 ==================== */

async function grabSources() {
  const displays = screen.getAllDisplays();
  let maxW = 1;
  let maxH = 1;
  for (const d of displays) {
    maxW = Math.max(maxW, Math.round(d.size.width * d.scaleFactor));
    maxH = Math.max(maxH, Math.round(d.size.height * d.scaleFactor));
  }
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: maxW, height: maxH },
    fetchWindowIcons: false,
  });
  return { displays, sources };
}

function sourceFor(display, sources, displays) {
  let s = sources.find((x) => x.display_id && String(x.display_id) === String(display.id));
  if (s) return s;
  s = sources.find((x) => {
    const parts = String(x.id).split(':');
    return parts.length >= 2 && String(parts[1]) === String(display.id);
  });
  if (s) return s;
  const idx = displays.indexOf(display);
  return sources[idx] || sources[0] || null;
}

function hidePinned() {
  for (const w of pinned) {
    try { w.hide(); } catch (_) {}
  }
}

function showPinned() {
  for (const w of pinned) {
    try { if (!w.isDestroyed()) w.show(); } catch (_) {}
  }
}

async function startCapture() {
  if (capPhase !== 'idle') return;
  capPhase = 'starting';
  hidePinned();
  closeOverlays();
  try {
    const { displays, sources } = await grabSources();
    if (!sources.length) throw new Error('未获取到任何屏幕源');
    for (const d of displays) {
      const src = sourceFor(d, sources, displays);
      if (!src) continue;
      createOverlay(d, src.thumbnail.toDataURL());
    }
    if (!overlays.length) throw new Error('遮罩窗口创建失败');
    capPhase = 'active';
  } catch (e) {
    console.error('[main] 截图失败', e);
    capPhase = 'idle';
    closeOverlays();
    showPinned();
    dialog.showErrorBox('截图失败', String((e && e.message) || e));
  }
}

function createOverlay(display, dataUrl) {
  const b = display.bounds;
  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    show: false,
    acceptFirstMouse: true,
    webPreferences: {
      preload: R('preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setMenuBarVisibility(false);
  win.loadFile(R('renderer', 'overlay.html'));

  const payload = {
    dataUrl,
    display: {
      id: display.id,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      scaleFactor: display.scaleFactor,
    },
    settings: settings.all(),
    langs: translateMod.TARGET_LANGS,
  };

  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.send('overlay:init', payload);
    win.show();
    win.moveTop();
    try { win.focus(); } catch (_) {}
  });

  win.on('closed', () => {
    overlays = overlays.filter((w) => w !== win);
    if (!overlays.length) endCapture();
  });

  overlays.push(win);
  return win;
}

function endCapture() {
  if (capPhase !== 'active') return;
  capPhase = 'idle';
  showPinned();
  refreshTray();
}

function closeOverlays() {
  const list = overlays.slice();
  overlays = [];
  for (const w of list) {
    try { w.destroy(); } catch (_) {}
  }
}

function closeOthers(senderId) {
  for (const w of overlays.slice()) {
    if (w.webContents && w.webContents.id !== senderId) {
      try { w.destroy(); } catch (_) {}
    }
  }
}

/* ==================== 贴图 ==================== */

function createPin({ dataUrl, x, y, width, height }) {
  const img = nativeImage.createFromDataURL(dataUrl);
  const size = img.getSize();
  const w = Math.max(40, Math.round(width || size.width));
  const h = Math.max(20, Math.round(height || size.height));

  const win = new BrowserWindow({
    x: Math.round(typeof x === 'number' ? x : 120),
    y: Math.round(typeof y === 'number' ? y : 120),
    width: w,
    height: h,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    movable: true,
    skipTaskbar: true,
    hasShadow: true,
    alwaysOnTop: true,
    minWidth: 40,
    minHeight: 20,
    show: false,
    webPreferences: {
      preload: R('preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(R('renderer', 'pin.html'));
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.send('pin:init', { dataUrl, width: w, height: h });
    win.show();
  });

  pinned.push(win);
  win.on('closed', () => {
    pinned = pinned.filter((w2) => w2 !== win);
  });
  return true;
}

/* ==================== 设置窗口 ==================== */

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 720,
    height: 660,
    minWidth: 620,
    minHeight: 520,
    title: 'SnapTrans 设置',
    icon: R('assets', 'app.png'),
    backgroundColor: '#f5f6f8',
    show: false,
    webPreferences: {
      preload: R('preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(R('renderer', 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
}

/* ==================== 托盘 ==================== */

function refreshTray() {
  if (!tray) return;
  const hotkey = settings.get('hotkey');
  const menu = Menu.buildFromTemplate([
    { label: `截图翻译  ${hotkey}`, click: () => startCapture() },
    { type: 'separator' },
    {
      label: `翻译引擎：${settings.get('translateEngine') === 'llm' ? 'AI 大模型' : '免费接口'}`,
      enabled: false,
    },
    {
      label: `目标语言：${translateMod.langName(settings.get('targetLang'))}`,
      enabled: false,
    },
    { type: 'separator' },
    { label: '设置…', click: openSettings },
    { label: '打开数据目录', click: () => shell.openPath(datadir.current()) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  const iconPath = R('assets', 'tray.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('SnapTrans 截图翻译');
  refreshTray();
  tray.on('double-click', () => startCapture());
  tray.on('click', () => startCapture());
}

/* ==================== 全局快捷键 ==================== */

/**
 * 注册策略（含「失败回滚旧键」）在 src/hotkey.js，那边可以脱离 Electron 做单测。
 * 这里只负责把 Electron 的 globalShortcut 适配进去。
 */
const hotkeys = hotkeyUtil.createRegistrar(
  {
    register: (a, cb) => globalShortcut.register(a, cb),
    unregister: (a) => globalShortcut.unregister(a),
    isRegistered: (a) => globalShortcut.isRegistered(a),
  },
  () => startCapture(),
  log
);

/** 兼容旧调用点：返回 { ok, hotkey, error, restored } */
function registerHotkey(accel) {
  const a = accel == null ? settings.get('hotkey') : accel;
  return hotkeys.register(a);
}

/* ==================== IPC ==================== */

function registerIpc() {
  ipcMain.handle('overlay:close-all', () => { closeOverlays(); return true; });
  ipcMain.handle('overlay:close-others', (e) => { closeOthers(e.sender.id); return true; });
  ipcMain.handle('overlay:hide-self', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.hide();
    return true;
  });
  ipcMain.handle('overlay:show-self', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) { w.show(); w.moveTop(); w.focus(); }
    return true;
  });

  ipcMain.handle('ocr:image', async (e, { dataUrl }) => {
    return pipeline.recognizeOnly(dataUrl);
  });

  ipcMain.handle('translate:image', async (e, { dataUrl }) => {
    const s = settings.all();
    return pipeline.recognizeAndTranslate(dataUrl, {
      sourceLang: s.sourceLang,
      targetLang: s.targetLang,
      translateEngine: s.translateEngine,
      freeProvider: s.freeProvider,
      llm: s.llm,
    });
  });

  ipcMain.handle('translate:text', async (e, { texts }) => {
    const s = settings.all();
    return translateMod.translate(texts, {
      from: s.sourceLang,
      to: s.targetLang,
      engine: s.translateEngine,
      freeProvider: s.freeProvider,
      llm: s.llm,
    });
  });

  ipcMain.handle('clipboard:image', (e, dataUrl) => {
    clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
    return true;
  });

  ipcMain.handle('clipboard:text', (e, text) => {
    clipboard.writeText(String(text == null ? '' : text));
    return true;
  });

  ipcMain.handle('file:save-image', async (e, { dataUrl, name }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const s = settings.all();
    const baseDir = s.saveDir && fs.existsSync(s.saveDir) ? s.saveDir : app.getPath('pictures');
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '保存截图',
      defaultPath: path.join(baseDir, name || `SnapTrans_${stamp()}.png`),
      filters: [
        { name: 'PNG 图片', extensions: ['png'] },
        { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] },
      ],
    });
    if (canceled || !filePath) return { ok: false };
    const img = nativeImage.createFromDataURL(dataUrl);
    const buf = /\.jpe?g$/i.test(filePath) ? img.toJPEG(94) : img.toPNG();
    fs.writeFileSync(filePath, buf);
    settings.set({ saveDir: path.dirname(filePath) });
    return { ok: true, filePath };
  });

  ipcMain.handle('pin:create', (e, payload) => createPin(payload || {}));

  ipcMain.handle('pin:resize', (e, { width, height }) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || w.isDestroyed()) return false;
    const b = w.getBounds();
    const nw = Math.max(40, Math.round(width));
    const nh = Math.max(20, Math.round(height));
    w.setBounds({ x: b.x, y: b.y, width: nw, height: nh });
    return true;
  });

  ipcMain.handle('pin:close', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w && !w.isDestroyed()) w.close();
    return true;
  });

  ipcMain.handle('settings:get', () => {
    const hk = settings.get('hotkey');
    return {
      ...settings.all(),
      langs: translateMod.TARGET_LANGS,
      // 空表示主动关闭了快捷键，不算失败，所以给 null 让界面别报红
      hotkeyRegistered: hk ? globalShortcut.isRegistered(hk) : null,
      settingsPath: settings.filePath(),
      version: app.getVersion(),
      electron: process.versions.electron,
      ...datadir.status(),
    };
  });

  ipcMain.handle('settings:set', (e, patch) => {
    const p = { ...(patch || {}) };
    let hotkeyResult = null;

    if (p.hotkey !== undefined) {
      const before = settings.get('hotkey');
      const want = String(p.hotkey || '').trim();
      if (!want) {
        hotkeyResult = registerHotkey('');            // 主动关闭
      } else if (want === before && globalShortcut.isRegistered(want)) {
        hotkeyResult = { ok: true, hotkey: want };
      } else {
        hotkeyResult = registerHotkey(want);
        // 注册失败就不落盘，保持原值（registerHotkey 已把旧键装回去了）
        if (!hotkeyResult.ok) p.hotkey = before;
      }
    }

    const next = settings.set(p);
    refreshTray();
    const hk = next.hotkey;
    return {
      ...next,
      langs: translateMod.TARGET_LANGS,
      hotkeyResult,
      // 空 = 主动关闭，不算失败，给 null 让界面别报红
      hotkeyRegistered: hk ? globalShortcut.isRegistered(hk) : null,
      ...datadir.status(),
    };
  });

  ipcMain.handle('settings:open', () => { openSettings(); return true; });

  /* ---------- 数据目录 ---------- */

  ipcMain.handle('settings:choose-data-dir', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, {
      title: '选择数据目录',
      defaultPath: datadir.current(),
      buttonLabel: '用这个目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, dir: r.filePaths[0] };
  });

  ipcMain.handle('settings:set-data-dir', (e, { dir } = {}) => {
    const r = datadir.setCustom(dir);
    if (r.ok) log('数据目录已改为：', r.dir, `（迁移 ${r.moved} 项，重启后生效）`);
    else log('数据目录修改失败：', r.error);
    return { ...r, ...datadir.status() };
  });

  ipcMain.handle('settings:reset-data-dir', () => {
    const r = datadir.reset();
    log('数据目录已恢复默认：', r.dir, '（重启后生效）');
    return { ...r, ...datadir.status() };
  });

  ipcMain.handle('shell:open-data-dir', () => {
    shell.openPath(datadir.current());
    return true;
  });

  ipcMain.handle('app:relaunch', () => {
    log('重启应用');
    quitting = true;
    app.relaunch();
    app.exit(0);
    return true;
  });

  ipcMain.handle('translate:selftest', async (e, patch) => {
    const s = { ...settings.all(), ...(patch || {}) };
    try {
      return await translateMod.selfTest({
        engine: s.translateEngine,
        freeProvider: s.freeProvider,
        llm: s.llm,
        to: s.targetLang,
      });
    } catch (err) {
      return { ok: false, error: String(err.message || err), details: err.details || [] };
    }
  });

  ipcMain.handle('ocr:warmup', async () => {
    const ok = await ocr.warmup();
    return { ok, modelDir: ocr.modelDir() };
  });

  /* ---------- 长截图 ---------- */

  ipcMain.handle('longshot:capture', async (e, { displayId, rect }) => {
    const displays = screen.getAllDisplays();
    const display = displays.find((d) => String(d.id) === String(displayId)) || screen.getPrimaryDisplay();
    const physW = Math.round(display.size.width * display.scaleFactor);
    const physH = Math.round(display.size.height * display.scaleFactor);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: physW, height: physH },
      fetchWindowIcons: false,
    });
    const src = sourceFor(display, sources, displays);
    if (!src) throw new Error('抓屏失败');
    const img = src.thumbnail;
    const sz = img.getSize();
    const kx = sz.width / physW;
    const ky = sz.height / physH;
    const cropped = img.crop({
      x: Math.max(0, Math.round(rect.x * kx)),
      y: Math.max(0, Math.round(rect.y * ky)),
      width: Math.min(sz.width, Math.round(rect.width * kx)),
      height: Math.min(sz.height, Math.round(rect.height * ky)),
    });
    return { dataUrl: cropped.toDataURL(), width: cropped.getSize().width, height: cropped.getSize().height };
  });

  ipcMain.handle('longshot:scroll', async (e, { x, y, delta }) => {
    await native.scrollAt(x, y, delta);
    return true;
  });

  ipcMain.handle('longshot:probe', async () => ({ ok: await native.probe() }));

  ipcMain.handle('shell:open-external', (e, url) => {
    if (/^https?:\/\//i.test(String(url))) shell.openExternal(url);
    return true;
  });

  ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });
}

/* ==================== 生命周期 ==================== */

app.on('second-instance', () => {
  log('收到第二个实例的请求，开始截图');
  startCapture();
});

app.whenReady().then(async () => {
  log(`启动：版本 ${app.getVersion()}，打包=${app.isPackaged}，资源目录=${process.resourcesPath}`);
  settings.init();

  /* ---------------- 打包冒烟 ----------------
   * 验证 asar 解包后 ONNX 原生模块能加载、模型目录能定位到 resources/models。
   * 打包版是 GUI 程序、stdout 拿不到，所以结果同时写进 snaptrans.log，
   * 并用退出码（0 通过 / 1 未通过）让 CI 或脚本能判断。
   */
  if (CHECK_OCR) {
    const img = CHECK_OCR_IMG;
    log('check-ocr：模型目录=', ocr.modelDir());
    let ok = false;
    try {
      ok = await ocr.warmup();
      log('check-ocr：引擎加载', ok ? '成功' : '失败');
      if (ok && !img) {
        log('check-ocr：未指定图片，只验证引擎加载');
      } else if (ok) {
        // 显式指定了图片却找不到，算失败 ——
        // 否则路径写错会静默跳过识别、ok 仍为 true，看起来像「通过」。
        if (!fs.existsSync(img)) {
          log('check-ocr：找不到图片，无法识别 ——', img);
          ok = false;
        } else {
          const r = await ocr.recognize('data:image/png;base64,' + fs.readFileSync(img).toString('base64'));
          log(`check-ocr：识别 ${r.lines.length} 行 / ${r.paragraphs.length} 段（图 ${r.size.width}x${r.size.height}）`);
          for (const l of r.lines) {
            log(`    conf=${l.confidence} 墨迹=${Math.round(l.inkHeight || 0)} "${l.text}"`);
          }
          ok = r.lines.length > 0;
        }
      }
    } catch (e) {
      log('check-ocr：异常', (e && e.stack) || e);
      ok = false;
    }
    await ocr.terminate().catch(() => {});
    logSync('check-ocr：', ok ? '通过' : '未通过');
    app.exit(ok ? 0 : 1);
    return;
  }

  registerIpc();
  createTray();
  const hk = registerHotkey(settings.get('hotkey'));
  log('已启动，快捷键', hk.hotkey || '(未设置)', hk.ok ? '注册成功' : `注册失败：${hk.error || '未知原因'}`);
  // 后台预热 OCR，第一次用不卡
  setTimeout(async () => {
    log('OCR 预热开始，模型目录=', ocr.modelDir());
    try {
      const ok = await ocr.warmup();
      log('OCR 预热', ok ? '成功' : '失败（模型可能缺失，请检查 resources/models）');
    } catch (e) {
      log('OCR 预热异常：', (e && e.stack) || e);
    }
  }, 4000);
}).catch((e) => {
  log('whenReady 阶段出错：', (e && e.stack) || e);
});

app.on('window-all-closed', () => {
  // 托盘常驻，不退出
  log('所有窗口已关闭（托盘常驻，不退出）');
});

app.on('before-quit', () => {
  log('before-quit');
  quitting = true;
  globalShortcut.unregisterAll();
});

app.on('will-quit', () => {
  log('will-quit');
  globalShortcut.unregisterAll();
});
