'use strict';
(function () {
  const api = window.api;
  const $ = (id) => document.getElementById(id);
  let cfg = null;

  const status = (msg, cls) => {
    const el = $('status');
    el.textContent = msg || '';
    el.className = cls || '';
  };

  function segInit(id, value, onPick) {
    const box = $(id);
    const btns = [...box.querySelectorAll('button')];
    btns.forEach((b) => {
      b.classList.toggle('on', b.dataset.v === value);
      b.addEventListener('click', () => {
        btns.forEach((x) => x.classList.toggle('on', x === b));
        onPick(b.dataset.v);
      });
    });
  }

  function syncEngineUi() {
    const isLlm = cfg.translateEngine === 'llm';
    $('freeBox').classList.toggle('dep', isLlm);
    $('llmBox').classList.toggle('dep', !isLlm);
    $('engineHint').innerHTML = isLlm
      ? '使用你配置的大模型接口做翻译。质量最好，但需要联网并消耗额度。'
      : '使用必应 / Google / MyMemory 的公开接口，无需任何 Key，开箱即用。中文识别后若原文已是中文则基本保持原样。';
  }

  /* ==================== 快捷键录制 ==================== */

  const MODS = [
    ['ctrlKey', 'Ctrl'],
    ['altKey', 'Alt'],
    ['shiftKey', 'Shift'],
    ['metaKey', 'Super'],
  ];

  /** 浏览器 event.key → Electron accelerator 键名 */
  const KEY_ALIAS = {
    ' ': 'Space',
    Escape: 'Esc',
    Enter: 'Return',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    '+': 'Plus',
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash',
    ';': 'Semicolon',
    "'": 'Quote',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '\\': 'Backslash',
    '-': 'Minus',
    '=': 'Equal',
    '`': 'Backquote',
    Insert: 'Insert',
    Delete: 'Delete',
    Backspace: 'Backspace',
    Tab: 'Tab',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Print: 'PrintScreen',
  };

  const FKEY = /^F([1-9]|1[0-9]|2[0-4])$/;
  const isModKey = (e) => ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(e.key);
  const modsOf = (e) => MODS.filter(([f]) => e[f]).map(([, n]) => n);

  function keyName(e) {
    const k = e.key;
    if (!k) return '';
    if (FKEY.test(k)) return k.toUpperCase();
    if (k.length === 1 && /[a-z]/i.test(k)) return k.toUpperCase();
    if (k.length === 1 && /[0-9]/.test(k)) return k;
    return KEY_ALIAS[k] || (k.length === 1 ? k.toUpperCase() : '');
  }

  let hotkey = '';      // 当前生效的快捷键
  let recOn = false;    // 是否处于录制态
  let recPrefix = '';   // 录制中已按下的修饰键，如 "Ctrl+Alt"
  let recErr = '';      // 录制中的内联错误

  function paintHotkey() {
    const box = $('hotkey');
    box.classList.toggle('rec-on', recOn);
    box.classList.toggle('rec-off', !recOn && !hotkey);

    $('hotkeyText').textContent = recOn
      ? (recErr || (recPrefix ? recPrefix + ' + …' : '请按下组合键…'))
      : (hotkey || '（未设置，快捷键已关闭）');

    const hint = $('hotkeyHint');
    if (recOn) {
      hint.innerHTML = recErr
        ? `<span style="color:#e24b4b">${recErr}</span>`
        : '正在录制：直接按下组合键（例如 <code>Ctrl</code>+<code>Alt</code>+<code>Q</code>）。按 <code>Esc</code> 取消。';
      return;
    }
    if (cfg && cfg.hotkeyRegistered === false) {
      hint.innerHTML = '<span style="color:#e24b4b">⚠ 当前快捷键未注册成功，可能被其他程序占用，请换一个组合。</span>';
      return;
    }
    if (!hotkey) {
      hint.innerHTML = '当前未设置，全局快捷键已关闭。点击上方输入框可重新录制。';
      return;
    }
    hint.innerHTML =
      '点击上方输入框，然后直接按下想要的组合键。至少需要一个修饰键（<code>Ctrl</code> / <code>Alt</code> / <code>Shift</code>），' +
      '或使用 <code>F1</code>~<code>F24</code>。录好后<b>立即生效</b>；点右侧 <code>×</code> 可关闭快捷键。';
  }

  function startRec() {
    recOn = true;
    recPrefix = '';
    recErr = '';
    try { $('hotkey').focus(); } catch (_) { /* ignore */ }
    paintHotkey();
  }

  function stopRec() {
    if (!recOn) return;
    recOn = false;
    recPrefix = '';
    recErr = '';
    paintHotkey();
  }

  async function applyHotkey(accel) {
    status('正在注册快捷键…');
    let r;
    try {
      r = await api.setSettings({ hotkey: accel });
    } catch (e) {
      status('注册失败：' + (e.message || e), 'err');
      return;
    }
    const hk = r.hotkeyResult || {};
    cfg = { ...cfg, ...r };
    hotkey = cfg.hotkey || '';
    recOn = false;
    recPrefix = '';
    recErr = '';
    paintHotkey();
    if (hk.ok) {
      status(hk.disabled ? '快捷键已关闭' : `快捷键已生效：${hk.hotkey}`, 'ok');
      setTimeout(() => status(''), 2600);
    } else {
      status(hk.error || '注册失败', 'err');
    }
  }

  const recBox = $('hotkey');

  recBox.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'hotkeyClear') return;
    if (!recOn) startRec();
  });

  recBox.addEventListener('keydown', (e) => {
    if (!recOn) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') { stopRec(); return; }

    // 只按了修饰键：显示前缀，继续等主键
    if (isModKey(e)) {
      recPrefix = modsOf(e).join('+');
      recErr = '';
      paintHotkey();
      return;
    }

    const main = keyName(e);
    if (!main) return;
    const mods = modsOf(e);
    if (!mods.length && !FKEY.test(main)) {
      recErr = '至少要带一个修饰键（Ctrl / Alt / Shift），或者用 F1~F24';
      paintHotkey();
      return;
    }
    applyHotkey([...mods, main].join('+'));
  });

  recBox.addEventListener('keyup', (e) => {
    if (!recOn || !isModKey(e)) return;
    // 修饰键全松开了还没等到主键 → 回到等待状态
    if (!MODS.some(([f]) => e[f])) {
      recPrefix = '';
      recErr = '';
      paintHotkey();
    }
  });

  recBox.addEventListener('blur', stopRec);

  $('hotkeyClear').addEventListener('click', (e) => {
    e.stopPropagation();
    applyHotkey('');
  });

  /* ==================== 数据目录 ==================== */

  function paintDataDir() {
    const custom = !!cfg.dataDirCustom;
    const el = $('dataDirPath');
    el.textContent = cfg.dataDir || '—';
    el.classList.toggle('custom', custom);
    $('btnDirReset').disabled = !custom;

    let hint = custom
      ? `已配置自定义目录。默认目录是 <code>${cfg.defaultDataDir || ''}</code>。`
      : '正在使用默认目录。';
    if (cfg.dataDirPending) {
      hint += `<br /><span style="color:#8a6d1f">重启后将切换到 <code>${cfg.dataDirPending}</code></span>`;
    }
    $('dataDirHint').innerHTML = hint;
  }

  function showRestart(text) {
    $('restartText').textContent = text;
    $('restartBar').classList.remove('hidden');
    document.body.classList.add('has-restart');
  }

  function hideRestart() {
    $('restartBar').classList.add('hidden');
    document.body.classList.remove('has-restart');
  }

  $('btnDirChange').addEventListener('click', async () => {
    if (!cfg) return;
    const pick = await api.chooseDataDir();
    if (!pick || !pick.ok) return;
    $('btnDirChange').disabled = true;
    status('正在切换并迁移数据…');
    try {
      const r = await api.setDataDir(pick.dir);
      if (!r.ok) { status('切换失败：' + (r.error || ''), 'err'); return; }
      cfg = { ...cfg, ...r };
      paintDataDir();
      status('已切换，重启后生效', 'ok');
      showRestart(`数据目录已改为 ${r.dir}${r.moved ? `（已迁移 ${r.moved} 个文件）` : ''}，重启后生效`);
    } catch (e) {
      status('切换失败：' + (e.message || e), 'err');
    } finally {
      $('btnDirChange').disabled = false;
    }
  });

  $('btnDirReset').addEventListener('click', async () => {
    if (!cfg) return;
    try {
      const r = await api.resetDataDir();
      if (!r.ok) { status('恢复失败：' + (r.error || ''), 'err'); return; }
      cfg = { ...cfg, ...r };
      paintDataDir();
      status('已恢复默认，重启后生效', 'ok');
      showRestart(`已恢复默认目录 ${r.dir}，重启后生效`);
    } catch (e) {
      status('恢复失败：' + (e.message || e), 'err');
    }
  });

  $('btnDirOpen').addEventListener('click', () => api.openDataDir());
  $('btnRestart').addEventListener('click', () => api.relaunch());
  $('btnRestartLater').addEventListener('click', hideRestart);

  /* ==================== 其余设置 ==================== */

  async function load() {
    cfg = await api.getSettings();

    hotkey = cfg.hotkey || '';
    paintHotkey();
    paintDataDir();
    // 上次改了目录但没重启就关掉了设置窗 —— 打开时提醒一下
    if (cfg.dataDirPending) showRestart(`数据目录将在重启后切换到 ${cfg.dataDirPending}`);

    $('freeProvider').value = cfg.freeProvider || 'auto';
    $('llmBase').value = (cfg.llm && cfg.llm.baseUrl) || '';
    $('llmKey').value = (cfg.llm && cfg.llm.apiKey) || '';
    $('llmModel').value = (cfg.llm && cfg.llm.model) || '';
    $('textColorAuto').checked = cfg.textColorAuto !== false;
    $('fontWeightAuto').checked = cfg.fontWeightAuto !== false;
    $('autoCopy').checked = cfg.autoCopy !== false;
    $('fontSizeScale').value = String(cfg.fontSizeScale || 1);

    const tl = $('targetLang');
    tl.innerHTML = '';
    for (const l of cfg.langs || []) {
      const o = document.createElement('option');
      o.value = l.code;
      o.textContent = `${l.name}  (${l.code})`;
      if (l.code === cfg.targetLang) o.selected = true;
      tl.appendChild(o);
    }

    segInit('engineSeg', cfg.translateEngine, (v) => {
      cfg.translateEngine = v;
      syncEngineUi();
      status('');
    });
    syncEngineUi();

    $('paths').innerHTML =
      `配置文件：<code>${cfg.settingsPath}</code><br />版本：v${cfg.version} · Electron ${cfg.electron}`;
  }

  function collect() {
    return {
      translateEngine: cfg.translateEngine,
      freeProvider: $('freeProvider').value,
      targetLang: $('targetLang').value,
      textColorAuto: $('textColorAuto').checked,
      fontWeightAuto: $('fontWeightAuto').checked,
      autoCopy: $('autoCopy').checked,
      fontSizeScale: Number($('fontSizeScale').value) || 1,
      llm: {
        baseUrl: $('llmBase').value.trim(),
        apiKey: $('llmKey').value.trim(),
        model: $('llmModel').value.trim(),
      },
    };
  }

  $('btnSave').addEventListener('click', async () => {
    const patch = collect();
    cfg = { ...cfg, ...(await api.setSettings(patch)) };
    hotkey = cfg.hotkey || hotkey;
    paintHotkey();
    status('已保存 ✓', 'ok');
    setTimeout(() => status(''), 2200);
  });

  $('btnTest').addEventListener('click', async () => {
    const patch = collect();
    status('测试中…');
    $('btnTest').disabled = true;
    try {
      const r = await api.selfTest(patch);
      if (r && r.ok) {
        status(`连通正常 · ${r.provider} · ${r.sample} · ${r.ms}ms`, 'ok');
      } else {
        const d = r && r.details && r.details.length ? '（' + r.details.join('；') + '）' : '';
        status('失败：' + ((r && r.error) || '未知错误') + d, 'err');
      }
    } catch (e) {
      status('失败：' + (e.message || e), 'err');
    } finally {
      $('btnTest').disabled = false;
    }
  });

  $('btnLang').addEventListener('click', async () => {
    status('正在加载识别引擎…');
    $('btnLang').disabled = true;
    try {
      const r = await api.ocrWarmup();
      if (r && r.ok) status('识别引擎就绪 · ' + (r.modelDir || '内置模型'), 'ok');
      else status('识别引擎加载失败，请检查模型文件是否完整', 'err');
    } catch (e) {
      status('失败：' + (e.message || e), 'err');
    } finally {
      $('btnLang').disabled = false;
    }
  });

  load();
})();
