'use strict';
/**
 * 设置面板 UI 测试（Electron）
 *
 *   npm run test:settings
 *
 * 用**真实的** preload.js + settings.html/settings.js 起一个窗口，
 * 只把主进程的 IPC 换成可断言的桩，然后模拟用户操作：
 *   - 点击快捷键框进入录制 → 按组合键 → 断言值被规范化并已提交
 *   - 只按裸字母 → 断言被拒绝、且没有提交
 *   - 按 Esc → 断言取消、值不变
 *   - 点 × → 断言关闭快捷键
 *   - 点「更改…」→ 断言调用 setDataDir、重启提示条出现
 * 最后断言整个过程没有 console 报错 / 未捕获异常。
 *
 * 注册策略本身由 scripts/hotkey-test.js 覆盖，这里只测渲染层。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { configureGpu } = require(path.join(ROOT, 'src', 'gpu'));

configureGpu(app);
app.on('window-all-closed', () => {});

let pass = 0;
let fail = 0;
const errors = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  \u2705 ${name}`); }
  else { fail++; console.log(`  \u274c ${name}${extra !== undefined ? '  \u2192 ' + extra : ''}`); }
}

const DEF_DIR = 'C:\\Users\\Z\\AppData\\Roaming\\SnapTrans';
const PICK_DIR = 'D:\\SnapTransData';
const TAKEN = 'Ctrl+Alt+Q';   // 假装这个组合被别的程序占用

const FAKE = {
  hotkey: 'Alt+Shift+A',
  hotkeyRegistered: true,
  translateEngine: 'free',
  freeProvider: 'auto',
  targetLang: 'zh-Hans',
  langs: [{ code: 'zh-Hans', name: '简体中文' }, { code: 'en', name: 'English' }],
  llm: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
  textColorAuto: true,
  fontWeightAuto: true,
  autoCopy: true,
  fontSizeScale: 1,
  settingsPath: DEF_DIR + '\\settings.json',
  version: '1.0.0',
  electron: '33.4.11',
  dataDir: DEF_DIR,
  defaultDataDir: DEF_DIR,
  dataDirCustom: false,
  dataDirConfigured: '',
  dataDirPending: '',
  dataDirBootstrap: DEF_DIR + '\\datadir.txt',
  dataDirApplied: null,
};

const calls = { set: [], setDir: [], resetDir: [], opened: 0, relaunch: 0 };
let state = { ...FAKE };

function installStubs() {
  ipcMain.handle('settings:get', () => ({ ...state }));

  ipcMain.handle('settings:set', (e, patch) => {
    calls.set.push(patch);
    if (patch.hotkey === undefined) return { ...state, hotkeyResult: null };

    const want = String(patch.hotkey || '').trim();
    if (!want) {
      state = { ...state, hotkey: '', hotkeyRegistered: null };
      return { ...state, hotkeyResult: { ok: true, hotkey: '' } };
    }
    if (want === TAKEN) {
      // 模拟主进程「注册失败 → 保留旧键」的返回
      return {
        ...state,
        hotkeyResult: { ok: false, hotkey: state.hotkey, error: `${want} 注册失败（可能被其他程序占用）`, restored: state.hotkey },
      };
    }
    state = { ...state, hotkey: want, hotkeyRegistered: true };
    return { ...state, hotkeyResult: { ok: true, hotkey: want } };
  });

  ipcMain.handle('settings:choose-data-dir', () => ({ ok: true, dir: PICK_DIR }));
  ipcMain.handle('settings:set-data-dir', (e, { dir }) => {
    calls.setDir.push(dir);
    state = { ...state, dataDirCustom: true, dataDirConfigured: dir, dataDirPending: dir };
    return { ok: true, dir, from: DEF_DIR, moved: 3, needRestart: true, ...pickStatus() };
  });
  ipcMain.handle('settings:reset-data-dir', () => {
    calls.resetDir.push(1);
    state = { ...state, dataDirCustom: false, dataDirConfigured: '', dataDirPending: '' };
    return { ok: true, dir: DEF_DIR, from: PICK_DIR, needRestart: true, ...pickStatus() };
  });
  ipcMain.handle('shell:open-data-dir', () => { calls.opened++; return true; });
  ipcMain.handle('app:relaunch', () => { calls.relaunch++; return true; });
  ipcMain.handle('translate:selftest', () => ({ ok: true, provider: 'youdao', sample: 'ok', ms: 12 }));
  ipcMain.handle('ocr:warmup', () => ({ ok: true, modelDir: 'resources/models' }));
}

function pickStatus() {
  return {
    dataDir: state.dataDir,
    defaultDataDir: state.defaultDataDir,
    dataDirCustom: state.dataDirCustom,
    dataDirConfigured: state.dataDirConfigured,
    dataDirPending: state.dataDirPending,
    dataDirBootstrap: state.dataDirBootstrap,
    dataDirApplied: state.dataDirApplied,
  };
}

/** 在页面里执行一段代码，返回结果 */
const js = (win, code) => win.webContents.executeJavaScript(code, true);

/** 等某个条件成立（页面里求值） */
async function waitFor(win, code, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    const v = await js(win, code).catch(() => false);
    if (v) return v;
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 60));
  }
}

/** 模拟：点一下快捷键框，然后按一串键 */
function pressKeys(win, keys) {
  return js(win, `(() => {
    const el = document.getElementById('hotkey');
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const seq = ${JSON.stringify(keys)};
    for (const k of seq) {
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: k.key, ctrlKey: !!k.ctrl, altKey: !!k.alt, shiftKey: !!k.shift, metaKey: !!k.meta,
        bubbles: true, cancelable: true,
      }));
      if (k.up) {
        el.dispatchEvent(new KeyboardEvent('keyup', {
          key: k.key, ctrlKey: !!k.ctrl, altKey: !!k.alt, shiftKey: !!k.shift, metaKey: !!k.meta,
          bubbles: true, cancelable: true,
        }));
      }
    }
    return document.getElementById('hotkeyText').textContent;
  })()`);
}

app.whenReady().then(async () => {
  installStubs();

  const win = new BrowserWindow({
    width: 760,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on('console-message', (e, level, message) => {
    // level: 0=verbose 1=info 2=warning 3=error
    if (level >= 3) errors.push('console.error: ' + message);
  });
  win.webContents.on('preload-error', (e, p, err) => errors.push('preload-error: ' + err.message));
  win.webContents.on('render-process-gone', (e, d) => errors.push('render-process-gone: ' + JSON.stringify(d)));

  try {
    await win.loadFile(path.join(ROOT, 'renderer', 'settings.html'));

    /* ---------- 0. 页面加载 ---------- */
    console.log('\n[0] 加载');
    const loaded = await waitFor(win, 'document.getElementById("paths").textContent.length > 0');
    ok('settings.js 执行完毕（load() 已 resolve）', !!loaded);
    ok('未发生未捕获异常', errors.length === 0, errors.join(' | '));

    /* ---------- 1. 初始渲染 ---------- */
    console.log('\n[1] 初始渲染');
    let t = await js(win, 'document.getElementById("hotkeyText").textContent');
    ok('快捷键显示配置值', t === 'Alt+Shift+A', t);
    t = await js(win, 'document.getElementById("dataDirPath").textContent');
    ok('数据目录显示当前目录', t === DEF_DIR, t);
    ok('未配置自定义目录 → 提示语正确',
      /正在使用默认目录/.test(await js(win, 'document.getElementById("dataDirHint").textContent')),
      await js(win, 'document.getElementById("dataDirHint").textContent'));
    ok('「恢复默认」按钮被禁用',
      await js(win, 'document.getElementById("btnDirReset").disabled') === true);
    ok('重启提示条初始隐藏',
      await js(win, 'document.getElementById("restartBar").classList.contains("hidden")') === true);

    /* ---------- 2. 录制：只按修饰键 ---------- */
    console.log('\n[2] 录制：只按修饰键时显示前缀、不提交');
    await pressKeys(win, [{ key: 'Control', ctrl: true }]);
    t = await js(win, 'document.getElementById("hotkeyText").textContent');
    ok('显示已按下的修饰键前缀', t === 'Ctrl + …', t);
    ok('尚未提交任何设置', calls.set.length === 0, JSON.stringify(calls.set));

    /* ---------- 3. 录制：完整组合键 ---------- */
    console.log('\n[3] 录制：Ctrl+Alt+F9 应被规范化并提交');
    await pressKeys(win, [
      { key: 'Control', ctrl: true },
      { key: 'Alt', ctrl: true, alt: true },
      { key: 'F9', ctrl: true, alt: true },
    ]);
    await new Promise((r) => setTimeout(r, 300));
    ok('提交了一次 setSettings', calls.set.length === 1, JSON.stringify(calls.set));
    ok('提交的值 = Ctrl+Alt+F9', calls.set[0] && calls.set[0].hotkey === 'Ctrl+Alt+F9',
      JSON.stringify(calls.set[0]));
    t = await js(win, 'document.getElementById("hotkeyText").textContent');
    ok('框里显示新快捷键', t === 'Ctrl+Alt+F9', t);
    ok('已退出录制态',
      await js(win, 'document.getElementById("hotkey").classList.contains("rec-on")') === false);

    /* ---------- 4. 裸字母被拒绝 ---------- */
    console.log('\n[4] 录制：裸字母应被拒绝');
    const before = calls.set.length;
    await pressKeys(win, [{ key: 'a' }]);
    t = await js(win, 'document.getElementById("hotkeyText").textContent');
    ok('框里显示拒绝原因', /至少要带一个修饰键/.test(t), t);
    ok('没有提交', calls.set.length === before, JSON.stringify(calls.set.slice(before)));
    ok('仍在录制态（等用户重按）',
      await js(win, 'document.getElementById("hotkey").classList.contains("rec-on")') === true);

    /* ---------- 5. Esc 取消 ---------- */
    console.log('\n[5] Esc 取消录制');
    await pressKeys(win, [{ key: 'Escape' }]);
    t = await js(win, 'document.getElementById("hotkeyText").textContent');
    ok('取消后回到当前值', t === 'Ctrl+Alt+F9', t);
    ok('已退出录制态',
      await js(win, 'document.getElementById("hotkey").classList.contains("rec-on")') === false);
    ok('取消不产生提交', calls.set.length === before, JSON.stringify(calls.set.slice(before)));

    /* ---------- 6. 被占用的组合 ---------- */
    console.log('\n[6] 录制：被占用的组合 → 提示失败且保留旧键');
    await pressKeys(win, [
      { key: 'Control', ctrl: true },
      { key: 'Alt', ctrl: true, alt: true },
      { key: 'Q', ctrl: true, alt: true },
    ]);
    await new Promise((r) => setTimeout(r, 300));
    t = await js(win, 'document.getElementById("hotkeyText").textContent');
    ok('\u2605 框里仍是旧快捷键（没被改坏）', t === 'Ctrl+Alt+F9', t);
    const st = await js(win, 'document.getElementById("status").textContent');
    ok('状态栏给出失败原因', /注册失败/.test(st), st);

    /* ---------- 7. 清除快捷键 ---------- */
    console.log('\n[7] 点 × 关闭快捷键');
    await js(win, 'document.getElementById("hotkeyClear").dispatchEvent(new MouseEvent("click", { bubbles: true }))');
    await new Promise((r) => setTimeout(r, 300));
    t = await js(win, 'document.getElementById("hotkeyText").textContent');
    ok('显示「未设置」', /未设置/.test(t), t);
    ok('提交了空值', calls.set[calls.set.length - 1].hotkey === '',
      JSON.stringify(calls.set[calls.set.length - 1]));

    /* ---------- 8. 数据目录 ---------- */
    console.log('\n[8] 数据目录：更改 / 重启提示 / 恢复默认');
    await js(win, 'document.getElementById("btnDirChange").dispatchEvent(new MouseEvent("click", { bubbles: true }))');
    await new Promise((r) => setTimeout(r, 400));
    ok('调用了 setDataDir', calls.setDir.length === 1 && calls.setDir[0] === PICK_DIR,
      JSON.stringify(calls.setDir));
    ok('重启提示条出现',
      await js(win, 'document.getElementById("restartBar").classList.contains("hidden")') === false);
    const rt = await js(win, 'document.getElementById("restartText").textContent');
    ok('提示条说明了新目录和迁移数量', rt.includes(PICK_DIR) && rt.includes('3'), rt);
    ok('「恢复默认」按钮已启用',
      await js(win, 'document.getElementById("btnDirReset").disabled') === false);
    ok('提示语显示「重启后将切换到」',
      /重启后将切换到/.test(await js(win, 'document.getElementById("dataDirHint").textContent')),
      await js(win, 'document.getElementById("dataDirHint").textContent'));

    await js(win, 'document.getElementById("btnDirReset").dispatchEvent(new MouseEvent("click", { bubbles: true }))');
    await new Promise((r) => setTimeout(r, 400));
    ok('调用了 resetDataDir', calls.resetDir.length === 1);
    ok('「恢复默认」按钮回到禁用',
      await js(win, 'document.getElementById("btnDirReset").disabled') === true);

    await js(win, 'document.getElementById("btnDirOpen").dispatchEvent(new MouseEvent("click", { bubbles: true }))');
    await new Promise((r) => setTimeout(r, 200));
    ok('调用了 openDataDir', calls.opened === 1, String(calls.opened));

    /* ---------- 9. 无报错 ---------- */
    console.log('\n[9] 全程无报错');
    ok('没有 console.error / 未捕获异常', errors.length === 0, errors.join(' | '));
  } catch (e) {
    fail++;
    console.error('\n[test] 异常：', (e && e.stack) || e);
  } finally {
    try { win.destroy(); } catch (_) { /* ignore */ }
    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    app.exit(fail ? 1 : 0);
  }
}).catch((e) => {
  console.error('[test] 启动异常：', (e && e.stack) || e);
  app.exit(1);
});
