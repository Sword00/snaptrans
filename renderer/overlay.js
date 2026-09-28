/* SnapTrans 遮罩层主逻辑：框选 → 编辑 → 翻译替换 → 输出 */
(function () {
  'use strict';

  const api = window.api;
  const OBJ = window.OBJ;
  const ICONS = window.ICONS;

  /* ==================== 状态 ==================== */
  const S = {
    cfg: null,
    display: null,
    dpr: 1,
    shot: null,
    phase: 'idle',       // idle | dragging | ready
    sel: null,           // { x, y, w, h }  CSS px（相对当前屏幕）
    tool: null,
    color: '#ff3b30',
    strokeSize: 3,
    textSize: 18,
    objects: [],
    undoStack: [],
    redoStack: [],
    selectedId: null,
    action: null,
    busy: false,
    targetLang: 'zh-Hans',
    langs: [],
    baseImage: null,     // 长截图结果
    emojiAt: null,
    platform: null,      // 主进程给的平台能力（决定长截图按钮显不显示）
  };

  const dom = {};
  const body = document.body;
  let uidSeq = 1;
  const uid = () => 'o' + (uidSeq++) + '_' + Date.now().toString(36);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#07c160', '#0a84ff', '#af52de', '#1c1c1e', '#ffffff'];
  const WIDTHS = [2, 4, 7, 11];
  const FONTS = [14, 18, 24, 34];
  const EMOJIS = ('😀 😄 😁 😂 🤣 😊 😍 😘 😎 🤔 😅 😇 🙃 😉 😌 😜 🤗 😴 😢 😭 😡 🥰 🤩 😱 👍 👎 👌 🙏 👏 💪 🤝 ✌️ 🤞 👀 ❤️ 💔 ⭐ ✨ 🔥 🎉 ✅ ❌ ❗ ❓ 💡 📌 🚀 🎯').split(' ');

  const TOOLBAR = [
    { t: 'tool', id: 'rect', icon: 'rect', title: '矩形  R' },
    { t: 'tool', id: 'ellipse', icon: 'ellipse', title: '椭圆  E' },
    { t: 'tool', id: 'emoji', icon: 'emoji', title: '表情  M' },
    { t: 'tool', id: 'arrow', icon: 'arrow', title: '箭头  A' },
    { t: 'tool', id: 'pen', icon: 'pen', title: '画笔  P' },
    { t: 'tool', id: 'mosaic', icon: 'mosaic', title: '马赛克  B' },
    { t: 'tool', id: 'text', icon: 'text', title: '文字  T' },
    { t: 'sep' },
    { t: 'action', id: 'translate', icon: 'translate', title: '翻译并就地替换  Ctrl+T' },
    { t: 'action', id: 'ocr', icon: 'ocr', title: '提取文字并复制  Ctrl+O' },
    { t: 'action', id: 'longshot', icon: 'longshot', title: '长截图（滚动拼接）' },
    { t: 'sep' },
    { t: 'action', id: 'undo', icon: 'undo', title: '撤销  Ctrl+Z' },
    { t: 'action', id: 'save', icon: 'save', title: '保存到文件  Ctrl+S' },
    { t: 'action', id: 'pin', icon: 'pin', title: '贴到桌面' },
    { t: 'action', id: 'copy', icon: 'share', title: '复制到剪贴板  Ctrl+C' },
    { t: 'action', id: 'cancel', icon: 'close', title: '取消  Esc', cls: 'danger' },
    { t: 'action', id: 'ok', icon: 'check', title: '完成  Enter', cls: 'primary' },
  ];

  /* ==================== 初始化 ==================== */
  function cacheDom() {
    ['shot', 'catch', 'frame', 'layer', 'sizeTip', 'hint', 'toolbar', 'styleBar',
      'swatches', 'widths', 'langMenu', 'emojiPanel', 'toast', 'busy', 'busyText', 'textEditor']
      .forEach((id) => { dom[id] = document.getElementById(id); });
  }

  api.onInit(async (payload) => {
    cacheDom();
    S.cfg = payload.settings || {};
    S.display = payload.display;
    S.langs = payload.langs || [];
    S.platform = payload.platform || null;
    // 老版本主进程不带 platform 时兜底问一次，避免长截图按钮在不支持的系统上还留着
    if (!S.platform && api.platformStatus) {
      S.platform = await api.platformStatus().catch(() => null);
    }
    S.color = S.cfg.color || '#ff3b30';
    S.strokeSize = S.cfg.strokeSize || 3;
    S.targetLang = S.cfg.targetLang || 'zh-Hans';

    const img = new Image();
    img.onload = () => {
      const c = dom.shot;
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.style.width = payload.display.width + 'px';
      c.style.height = payload.display.height + 'px';
      c.getContext('2d').drawImage(img, 0, 0);
      S.shot = c;
      S.dpr = img.naturalWidth / payload.display.width || 1;
      enterIdle();
    };
    img.onerror = () => toast('截图载入失败');
    img.src = payload.dataUrl;
  });

  api.onOcrProgress((p) => {
    if (!S.busy) return;
    const map = {
      'loading engine': '加载识别引擎',
      'recognizing text': '识别文字',
    };
    // PaddleOCR 是一次性推理，没有细粒度进度；没带 progress 时就只显示状态文字
    const pct = typeof p.progress === 'number' ? ` ${Math.round(p.progress * 100)}%` : '';
    dom.busyText.textContent = `${map[p.status] || '处理中'}…${pct}`;
  });

  /* ==================== 框选 ==================== */
  function enterIdle() {
    S.phase = 'idle';
    S.sel = null;
    dom.frame.classList.add('hidden');
    dom.catch.classList.remove('hidden', 'drag');
    dom.sizeTip.classList.add('hidden');
    dom.hint.textContent = '拖动鼠标框选区域 · 按 Esc 退出';
    dom.hint.classList.remove('hidden');
    body.classList.add('selecting');
  }

  document.addEventListener('mousedown', onDocDown, true);

  function onDocDown(e) {
    if (e.button !== 0) return;
    if (!S.shot) return;

    // 点在工具栏 / 弹层 / 文字编辑框里 → 交给它们自己处理
    if (
      dom.toolbar.contains(e.target) || dom.styleBar.contains(e.target) ||
      dom.langMenu.contains(e.target) || dom.emojiPanel.contains(e.target) ||
      dom.textEditor.contains(e.target)
    ) return;

    if (S.phase === 'idle' || S.phase === 'ready') {
      if (S.phase === 'ready') {
        // 点击选区外 → 重新框选；点选区内 → 交给 canvas 处理
        if (dom.frame.contains(e.target)) return;
      }
      beginSelect(e);
    }
  }

  function beginSelect(e) {
    hidePopups();
    commitTextIfOpen();
    S.selectedId = null;
    S.action = null;
    S.phase = 'dragging';
    S.dragStart = { x: e.clientX, y: e.clientY };
    S.sel = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
    dom.hint.classList.add('hidden');
    dom.catch.classList.remove('hidden');
    dom.catch.classList.add('drag');
    body.classList.add('selecting');
    dom.frame.classList.remove('hidden');
    layoutFrame();
    syncSizeTip();
    placeToolbar();
    dom.toolbar.classList.add('hidden');
    dom.styleBar.classList.add('hidden');
    api.closeOthers();
    render();
  }

  window.addEventListener('mousemove', (e) => {
    if (S.phase === 'dragging') {
      const a = S.dragStart;
      let x = Math.min(a.x, e.clientX);
      let y = Math.min(a.y, e.clientY);
      let w = Math.abs(e.clientX - a.x);
      let h = Math.abs(e.clientY - a.y);
      x = Math.max(0, x);
      y = Math.max(0, y);
      w = Math.min(w, window.innerWidth - x);
      h = Math.min(h, window.innerHeight - y);
      S.sel = { x, y, w, h };
      layoutFrame();
      syncSizeTip();
      render();
      return;
    }
    if (S.action) onActionMove(e);
  });

  window.addEventListener('mouseup', (e) => {
    if (S.phase === 'dragging') {
      if (S.sel && S.sel.w >= 6 && S.sel.h >= 6) {
        S.phase = 'ready';
        dom.catch.classList.add('hidden');
        dom.catch.classList.remove('drag');
        body.classList.remove('selecting');
        layoutFrame();
        render();
        syncSizeTip();
        dom.toolbar.classList.remove('hidden');
        placeToolbar();
      } else {
        enterIdle();
      }
      return;
    }
    if (S.action) onActionUp(e);
  });

  /* ==================== 选区布局 ==================== */
  function layoutFrame() {
    const s = S.sel;
    if (!s) return;
    dom.frame.style.left = s.x + 'px';
    dom.frame.style.top = s.y + 'px';
    dom.frame.style.width = Math.max(1, s.w) + 'px';
    dom.frame.style.height = Math.max(1, s.h) + 'px';

    const pw = Math.max(1, Math.round(s.w * S.dpr));
    const ph = Math.max(1, Math.round(s.h * S.dpr));
    if (dom.layer.width !== pw || dom.layer.height !== ph) {
      dom.layer.width = pw;
      dom.layer.height = ph;
    }
    dom.layer.style.width = Math.max(1, s.w) + 'px';
    dom.layer.style.height = Math.max(1, s.h) + 'px';
  }

  function syncSizeTip() {
    const s = S.sel;
    if (!s) { dom.sizeTip.classList.add('hidden'); return; }
    dom.sizeTip.textContent = `${Math.round(s.w * S.dpr)} x ${Math.round(s.h * S.dpr)}`;
    dom.sizeTip.classList.remove('hidden');
    dom.sizeTip.style.left = s.x + 'px';
    dom.sizeTip.style.top = Math.max(4, s.y - 26) + 'px';
  }

  function layerCtx() {
    return dom.layer.getContext('2d', { willReadFrequently: true });
  }

  function drawBase(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    if (S.baseImage) {
      ctx.drawImage(S.baseImage, 0, 0, S.baseImage.width, S.baseImage.height, 0, 0, w, h);
      return;
    }
    const sx = Math.max(0, Math.round(S.sel.x * S.dpr));
    const sy = Math.max(0, Math.round(S.sel.y * S.dpr));
    const sw = Math.min(S.shot.width - sx, Math.round(S.sel.w * S.dpr));
    const sh = Math.min(S.shot.height - sy, Math.round(S.sel.h * S.dpr));
    if (sw <= 0 || sh <= 0) return;
    ctx.drawImage(S.shot, sx, sy, sw, sh, 0, 0, w, h);
  }

  function render() {
    if (!S.sel) return;
    const c = dom.layer;
    const ctx = layerCtx();
    drawBase(ctx, c.width, c.height);
    for (const o of S.objects) OBJ.draw(ctx, o, S.dpr);
    const selObj = S.objects.find((o) => o.id === S.selectedId);
    if (selObj) OBJ.drawSelection(ctx, selObj, S.dpr);
    updateUndoState();
  }

  function toLocal(e) {
    const r = dom.layer.getBoundingClientRect();
    return { x: (e.clientX - r.left) * S.dpr, y: (e.clientY - r.top) * S.dpr };
  }

  const byId = (id) => S.objects.find((o) => o.id === id);
  const topHit = (p) => {
    for (let i = S.objects.length - 1; i >= 0; i--) {
      if (OBJ.hit(S.objects[i], p, S.dpr)) return S.objects[i];
    }
    return null;
  };

  /* ==================== 撤销 / 重做 ==================== */
  function pushHistory() {
    S.undoStack.push(JSON.stringify(S.objects));
    if (S.undoStack.length > 120) S.undoStack.shift();
    S.redoStack.length = 0;
  }
  function dropLastHistory() { S.undoStack.pop(); }
  function undo() {
    if (!S.undoStack.length) { toast('没有可撤销的操作'); return; }
    S.redoStack.push(JSON.stringify(S.objects));
    S.objects = JSON.parse(S.undoStack.pop());
    S.selectedId = null;
    render();
  }
  function redo() {
    if (!S.redoStack.length) { toast('没有可重做的操作'); return; }
    S.undoStack.push(JSON.stringify(S.objects));
    S.objects = JSON.parse(S.redoStack.pop());
    S.selectedId = null;
    render();
  }
  function updateUndoState() {
    const u = dom.toolbar.querySelector('[data-id="undo"]');
    if (u) u.disabled = !S.undoStack.length;
  }

  /* ==================== 画布交互 ==================== */
  function onLayerDown(e) {
    if (e.button !== 0) return;
    if (S.phase !== 'ready') return;
    e.stopPropagation();
    const p = toLocal(e);
    hidePopups();
    commitTextIfOpen();

    // 1) 先判手柄
    const selObj = byId(S.selectedId);
    if (selObj) {
      const dir = OBJ.hitHandle(selObj, p, S.dpr);
      if (dir) {
        S.action = { kind: 'resize', id: selObj.id, dir, orig: OBJ.cloneObj(selObj), start: p, pushed: false };
        return;
      }
    }

    // 2) 有工具 → 开始绘制
    if (S.tool) { startDraw(e, p); return; }

    // 3) 无工具 → 选中 / 拖动
    const hit = topHit(p);
    if (hit) {
      S.selectedId = hit.id;
      S.action = { kind: 'move', id: hit.id, orig: OBJ.cloneObj(hit), start: p, pushed: false };
      render();
    } else {
      S.selectedId = null;
      render();
    }
  }

  function startDraw(e, p) {
    const color = S.color;
    const size = Math.max(1, S.strokeSize * S.dpr);
    switch (S.tool) {
      case 'rect':
      case 'ellipse':
      case 'mosaic': {
        pushHistory();
        const o = {
          id: uid(), type: S.tool, x: p.x, y: p.y, w: 0, h: 0, color, size,
          block: S.tool === 'mosaic' ? 9 : undefined,
        };
        S.objects.push(o);
        S.selectedId = o.id;
        S.action = { kind: 'draw-bbox', id: o.id, start: p, pushed: true };
        render();
        break;
      }
      case 'arrow': {
        pushHistory();
        const o = { id: uid(), type: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, size };
        S.objects.push(o);
        S.selectedId = o.id;
        S.action = { kind: 'draw-arrow', id: o.id, start: p, pushed: true };
        render();
        break;
      }
      case 'pen': {
        pushHistory();
        const o = { id: uid(), type: 'pen', points: [p], color, size };
        S.objects.push(o);
        S.selectedId = o.id;
        S.action = { kind: 'draw-pen', id: o.id, start: p, pushed: true };
        render();
        break;
      }
      case 'text':
        openTextEditor(p);
        break;
      case 'emoji':
        openEmojiPanel(p, e.clientX, e.clientY);
        break;
      default:
        break;
    }
  }

  function onActionMove(e) {
    const a = S.action;
    if (!a) return;
    if (a.kind !== 'move' && a.kind !== 'resize' && a.kind !== 'draw-bbox' && a.kind !== 'draw-arrow' && a.kind !== 'draw-pen') return;
    const p = toLocal(e);
    const dx = p.x - a.start.x;
    const dy = p.y - a.start.y;

    if ((a.kind === 'move' || a.kind === 'resize') && !a.pushed) {
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      pushHistory();
      a.pushed = true;
    }

    const idx = S.objects.findIndex((o) => o.id === a.id);
    if (idx < 0) return;

    if (a.kind === 'move') {
      const o = OBJ.cloneObj(a.orig);
      OBJ.translateObj(o, dx, dy);
      S.objects[idx] = o;
    } else if (a.kind === 'resize') {
      const o = OBJ.cloneObj(a.orig);
      OBJ.applyResize(o, a.dir, a.orig, dx, dy, Math.max(6, 8 * S.dpr));
      S.objects[idx] = o;
    } else if (a.kind === 'draw-bbox') {
      const o = S.objects[idx];
      o.x = Math.min(a.start.x, p.x);
      o.y = Math.min(a.start.y, p.y);
      o.w = Math.abs(p.x - a.start.x);
      o.h = Math.abs(p.y - a.start.y);
    } else if (a.kind === 'draw-arrow') {
      const o = S.objects[idx];
      o.x2 = p.x;
      o.y2 = p.y;
    } else if (a.kind === 'draw-pen') {
      const o = S.objects[idx];
      const last = o.points[o.points.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) > 1.5 * S.dpr) o.points.push(p);
    }
    render();
  }

  function onActionUp() {
    const a = S.action;
    S.action = null;
    if (!a) return;
    if (a.kind === 'draw-bbox' || a.kind === 'draw-arrow') {
      const o = byId(a.id);
      if (o) {
        const b = OBJ.bboxOf(o);
        if (b.x1 - b.x < 4 || b.y1 - b.y < 4) { removeObj(a.id); dropLastHistory(); }
      }
    } else if (a.kind === 'draw-pen') {
      const o = byId(a.id);
      if (o && o.points.length < 2) { removeObj(a.id); dropLastHistory(); }
    }
    render();
  }

  function removeObj(id) {
    S.objects = S.objects.filter((o) => o.id !== id);
    if (S.selectedId === id) S.selectedId = null;
  }

  function updateCursor(e) {
    if (S.phase !== 'ready') return;
    if (S.tool) { dom.layer.className = 'draw'; return; }
    const r = dom.layer.getBoundingClientRect();
    const inside =
      e.clientX >= r.left - 8 && e.clientX <= r.right + 8 &&
      e.clientY >= r.top - 8 && e.clientY <= r.bottom + 8;
    if (!inside) { dom.layer.className = ''; return; }
    const p = toLocal(e);
    const selObj = byId(S.selectedId);
    if (selObj && OBJ.hitHandle(selObj, p, S.dpr)) { dom.layer.className = 'move'; return; }
    dom.layer.className = topHit(p) ? 'move' : '';
  }
  window.addEventListener('mousemove', updateCursor);

  /* ==================== 工具栏 ==================== */

  /** macOS 上把提示里的 Ctrl 换成 ⌘ —— 按钮上写着 Ctrl+T、实际要按 Cmd+T 会让人以为坏了 */
  function fixAccel(text) {
    if (!S.platform || !S.platform.isMac) return text;
    return String(text).replace(/\bCtrl\b/g, '\u2318');
  }

  function buildToolbar() {
    const el = dom.toolbar;
    el.innerHTML = '';
    for (const item of TOOLBAR) {
      // 长截图靠模拟滚轮 + 抓屏拼接，底层是 Windows 的 user32.dll；
      // macOS / Linux 上点了只会弹一句「不可用」，不如直接不显示。
      if (item.id === 'longshot' && S.platform && S.platform.longshotSupported === false) continue;
      if (item.t === 'sep') {
        const d = document.createElement('div');
        d.className = 'sep';
        el.appendChild(d);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tbtn' + (item.cls ? ' ' + item.cls : '');
      b.title = fixAccel(item.title);
      b.dataset.kind = item.t;
      b.dataset.id = item.id;
      b.innerHTML = ICONS[item.icon] || '';
      el.appendChild(b);

      if (item.id === 'translate') {
        const lb = document.createElement('button');
        lb.type = 'button';
        lb.id = 'langBtn';
        lb.title = '翻译目标语言（点击切换）';
        lb.textContent = shortLang(S.targetLang);
        lb.addEventListener('click', (ev) => { ev.stopPropagation(); toggleLangMenu(lb); });
        el.appendChild(lb);
      }
    }

    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('.tbtn');
      if (!btn) return;
      e.stopPropagation();
      const kind = btn.dataset.kind;
      const id = btn.dataset.id;
      if (kind === 'tool') setTool(S.tool === id ? null : id);
      else runAction(id);
    });
  }

  const shortLang = (code) => {
    const m = { 'zh-Hans': '简中', 'zh-Hant': '繁中', en: 'EN', ja: '日', ko: '韩', fr: 'FR', de: 'DE', es: 'ES', ru: 'RU', pt: 'PT', it: 'IT', ar: 'AR', th: 'TH', vi: 'VI' };
    return m[code] || code;
  };

  function setTool(t) {
    S.tool = t;
    if (t) S.selectedId = null;
    for (const b of dom.toolbar.querySelectorAll('[data-kind="tool"]')) {
      b.classList.toggle('active', b.dataset.id === t);
    }
    dom.layer.className = t ? 'draw' : '';
    updateStyleBar();
    hidePopups();
    render();
  }

  function runAction(id) {
    switch (id) {
      case 'translate': doTranslate(); break;
      case 'ocr': doOcr(); break;
      case 'longshot': doLongshot(); break;
      case 'undo': undo(); break;
      case 'save': doSave(); break;
      case 'pin': doPin(); break;
      case 'copy': doCopy(); break;
      case 'cancel': cancelAll(); break;
      case 'ok': finish(); break;
      default: break;
    }
  }

  function placeToolbar() {
    const s = S.sel;
    if (!s) return;
    const tb = dom.toolbar;
    const tw = tb.offsetWidth || 700;
    const th = tb.offsetHeight || 44;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = s.x + s.w / 2 - tw / 2;
    let y = s.y + s.h + 10;
    if (y + th > vh - 8) y = s.y - th - 10;
    if (y < 8) y = Math.min(vh - th - 8, Math.max(8, s.y + s.h + 10));
    x = Math.max(8, Math.min(vw - tw - 8, x));
    tb.style.left = Math.round(x) + 'px';
    tb.style.top = Math.round(y) + 'px';
    placeStyleBar();
    placePopups();
  }

  /* ==================== 样式条 ==================== */
  function buildStyleBar() {
    dom.swatches.innerHTML = '';
    for (const c of COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch' + (c === S.color ? ' active' : '');
      b.style.background = c;
      b.dataset.color = c;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        S.color = c;
        for (const s of dom.swatches.children) s.classList.toggle('active', s.dataset.color === c);
        applyStyleToSelection();
      });
      dom.swatches.appendChild(b);
    }

    dom.widths.innerHTML = '';
    for (const w of WIDTHS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wbtn';
      b.dataset.w = String(w);
      b.innerHTML = `<i style="height:${Math.max(2, w)}px"></i>`;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (S.tool === 'text') { S.textSize = FONTS[WIDTHS.indexOf(w)] || 18; }
        else S.strokeSize = w;
        applyStyleToSelection();
        updateStyleBar();
      });
      dom.widths.appendChild(b);
    }
    dom.styleBar.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  function updateStyleBar() {
    const show = !!S.tool;
    dom.styleBar.classList.toggle('hidden', !show);
    if (!show) return;
    const isText = S.tool === 'text';
    const cur = isText ? S.textSize : S.strokeSize;
    for (const b of dom.widths.children) {
      const w = Number(b.dataset.w);
      const match = isText ? (FONTS[WIDTHS.indexOf(w)] === cur) : (w === cur);
      b.classList.toggle('active', match);
      b.querySelector('i').style.height = isText ? Math.max(4, FONTS[WIDTHS.indexOf(w)] / 3) + 'px' : Math.max(2, w) + 'px';
    }
    for (const s of dom.swatches.children) s.classList.toggle('active', s.dataset.color === S.color);
    placeStyleBar();
  }

  function placeStyleBar() {
    if (dom.styleBar.classList.contains('hidden')) return;
    const tb = dom.toolbar.getBoundingClientRect();
    const sw = dom.styleBar.offsetWidth || 260;
    const sh = dom.styleBar.offsetHeight || 38;
    let x = tb.left;
    let y = tb.top - sh - 8;
    if (y < 8) y = tb.bottom + 8;
    x = Math.max(8, Math.min(window.innerWidth - sw - 8, x));
    dom.styleBar.style.left = Math.round(x) + 'px';
    dom.styleBar.style.top = Math.round(y) + 'px';
  }

  function applyStyleToSelection() {
    const o = byId(S.selectedId);
    if (!o) return;
    pushHistory();
    if (o.type === 'text') { o.color = S.color; o.size = S.textSize * S.dpr; }
    else if (o.type === 'trans') { o.fg = S.color; }
    else { o.color = S.color; if (o.type !== 'pen' && o.type !== 'arrow') o.size = Math.max(1, S.strokeSize * S.dpr); else o.size = Math.max(1, S.strokeSize * S.dpr); }
    render();
  }

  /* ==================== 文字工具 ==================== */
  function openTextEditor(p) {
    const ed = dom.textEditor;
    ed.classList.remove('hidden');
    ed.style.left = p.x / S.dpr + 'px';
    ed.style.top = p.y / S.dpr + 'px';
    ed.style.color = S.color;
    ed.style.fontSize = S.textSize + 'px';
    ed.style.fontFamily = OBJ.pickFamily('中文');
    ed.style.fontWeight = '600';
    ed.textContent = '';
    ed.dataset.px = String(p.x);
    ed.dataset.py = String(p.y);
    ed.focus();
  }

  function onTextKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); cancelText(); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); }
    e.stopPropagation();
  }

  function commitTextIfOpen() {
    if (!dom.textEditor || dom.textEditor.classList.contains('hidden')) return;
    commitText();
  }

  function commitText() {
    const ed = dom.textEditor;
    if (!ed || ed.classList.contains('hidden')) return;
    const text = (ed.innerText || '').replace(/\u00a0/g, ' ').replace(/\n$/, '');
    ed.classList.add('hidden');
    ed.textContent = '';
    if (!text.trim()) return;
    pushHistory();
    const o = {
      id: uid(), type: 'text',
      x: Number(ed.dataset.px), y: Number(ed.dataset.py),
      text, color: S.color, size: S.textSize * S.dpr,
      family: OBJ.pickFamily(text),
    };
    S.objects.push(o);
    S.selectedId = o.id;
    render();
  }

  function cancelText() {
    const ed = dom.textEditor;
    ed.classList.add('hidden');
    ed.textContent = '';
    render();
  }

  /* ==================== 表情面板 ==================== */
  function openEmojiPanel(p, cx, cy) {
    S.emojiAt = p;
    const panel = dom.emojiPanel;
    if (!panel.dataset.built) {
      panel.dataset.built = '1';
      for (const em of EMOJIS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'em';
        b.textContent = em;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          placeEmoji(em);
        });
        panel.appendChild(b);
      }
      panel.addEventListener('mousedown', (e) => e.stopPropagation());
    }
    panel.classList.remove('hidden');
    panel.style.left = Math.max(8, Math.min(window.innerWidth - 300, cx - 140)) + 'px';
    panel.style.top = Math.min(window.innerHeight - 200, cy + 12) + 'px';
  }

  function placeEmoji(ch) {
    if (!S.emojiAt) return;
    pushHistory();
    const size = Math.max(18, 28 * S.dpr);
    const o = { id: uid(), type: 'emoji', x: S.emojiAt.x, y: S.emojiAt.y, size, char: ch };
    S.objects.push(o);
    S.selectedId = o.id;
    hidePopups();
    render();
  }

  /* ==================== 语言菜单 ==================== */
  function toggleLangMenu(anchor) {
    const m = dom.langMenu;
    if (!m.classList.contains('hidden')) { m.classList.add('hidden'); return; }
    m.innerHTML = '';
    for (const l of S.langs) {
      const d = document.createElement('div');
      d.className = 'item' + (l.code === S.targetLang ? ' active' : '');
      d.innerHTML = `<span>${l.name}</span><span class="code">${l.code}</span>`;
      d.addEventListener('click', async (e) => {
        e.stopPropagation();
        S.targetLang = l.code;
        dom.langMenu.classList.add('hidden');
        const lb = document.getElementById('langBtn');
        if (lb) lb.textContent = shortLang(l.code);
        S.cfg = await api.setSettings({ targetLang: l.code });
        toast('翻译目标语言：' + l.name);
      });
      m.appendChild(d);
    }
    const r = anchor.getBoundingClientRect();
    m.classList.remove('hidden');
    m.style.left = Math.max(8, Math.min(window.innerWidth - 160, r.left)) + 'px';
    m.style.top = Math.min(window.innerHeight - 320, r.bottom + 6) + 'px';
  }

  function hidePopups() {
    dom.langMenu.classList.add('hidden');
    dom.emojiPanel.classList.add('hidden');
  }

  function placePopups() {
    if (!dom.langMenu.classList.contains('hidden')) {
      const lb = document.getElementById('langBtn');
      if (lb) {
        const r = lb.getBoundingClientRect();
        dom.langMenu.style.left = Math.max(8, Math.min(window.innerWidth - 160, r.left)) + 'px';
        dom.langMenu.style.top = Math.min(window.innerHeight - 320, r.bottom + 6) + 'px';
      }
    }
  }

  /* ==================== 翻译 ==================== */
  function cropSelection() {
    const s = S.sel;
    const w = Math.max(1, Math.round(s.w * S.dpr));
    const h = Math.max(1, Math.round(s.h * S.dpr));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (S.baseImage) {
      ctx.drawImage(S.baseImage, 0, 0, S.baseImage.width, S.baseImage.height, 0, 0, w, h);
    } else {
      const sx = Math.max(0, Math.round(s.x * S.dpr));
      const sy = Math.max(0, Math.round(s.y * S.dpr));
      const sw = Math.min(S.shot.width - sx, w);
      const sh = Math.min(S.shot.height - sy, h);
      ctx.drawImage(S.shot, sx, sy, sw, sh, 0, 0, w, h);
    }
    return c;
  }

  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();

  async function doTranslate() {
    if (S.busy) return;
    if (!S.sel) return;
    S.busy = true;
    showBusy('正在识别文字…');
    try {
      const src = cropSelection();
      const res = await api.translateImage(src.toDataURL('image/png'));
      if (!res || !res.paragraphs || !res.paragraphs.length) {
        toast('没有识别到文字');
        return;
      }
      pushHistory();
      let n = 0;
      let skipped = 0;
      for (const para of res.paragraphs) {
        const translated = para.translation || '';
        // 译文和原文一致 = 无需替换。这一步同时挡掉了「图标被误识别成文字」这类噪音，
        // 避免在没有任何变化的地方盖一个色块。
        if (!translated.trim() || norm(translated) === norm(para.text)) {
          skipped++;
          continue;
        }
        const b = para.bbox;
        const bh = Math.max(6, b.y1 - b.y0);
        const pad = Math.max(2, Math.round(bh * 0.14));
        const x0 = Math.max(0, b.x0 - pad);
        const y0 = Math.max(0, b.y0 - pad);
        const x1 = Math.min(src.width, b.x1 + pad);
        const y1 = Math.min(src.height, b.y1 + pad);
        const bg = OBJ.sampleBg(src, b, pad);
        const fg = S.cfg.textColorAuto === false ? '#1c1c1e' : OBJ.sampleFg(src, b, bg);
        // 字重：按原文字形的笔画粗细判定（见 objects.js inkStrokeRatio 的实测标定）
        const bold = S.cfg.fontWeightAuto === false ? false : OBJ.detectBold(src, b, bg, fg);
        S.objects.push({
          id: uid(), type: 'trans',
          x: x0, y: y0, w: x1 - x0, h: y1 - y0,
          text: translated,
          srcText: para.text,
          bg, fg, bold,
          // 字号/对齐由 pipeline 按 OCR 行高与字形内容推算（见 src/pipeline.js），
          // 比直接拿段落 bbox 高度乘系数准得多（多行段落会把行距算进去）
          fontSize: Math.round((para.fontSize || bh * 0.96) * (S.cfg.fontSizeScale || 1)),
          align: para.align || 'left',
          maxLines: Math.max(1, Math.min(8, (para.lineCount || 1) + 2)),
        });
        n++;
      }
      if (!n) {
        S.undoStack.pop(); // 没有实际改动，撤销栈不留痕
        toast(skipped ? '框选内容已经是目标语言，无需替换' : '没有可替换的文字');
        return;
      }
      S.selectedId = null;
      render();
      toast(`已替换 ${n} 处文字${skipped ? `，跳过 ${skipped} 处无需翻译` : ''} · ${res.provider || '-'}`);
    } catch (err) {
      toast('翻译失败：' + ((err && err.message) || err));
    } finally {
      S.busy = false;
      hideBusy();
    }
  }

  async function doOcr() {
    if (S.busy) return;
    S.busy = true;
    showBusy('正在识别文字…');
    try {
      const src = cropSelection();
      const res = await api.ocrImage(src.toDataURL('image/png'));
      const text = (res.paragraphs || []).map((p) => p.text).join('\n');
      if (!text.trim()) { toast('没有识别到文字'); return; }
      await api.copyText(text);
      toast(`已识别 ${res.paragraphs.length} 段文字并复制到剪贴板`);
    } catch (err) {
      toast('识别失败：' + ((err && err.message) || err));
    } finally {
      S.busy = false;
      hideBusy();
    }
  }

  /* ==================== 输出 ==================== */
  function exportImage() {
    const keep = S.selectedId;
    S.selectedId = null;
    render();
    const url = dom.layer.toDataURL('image/png');
    S.selectedId = keep;
    render();
    return url;
  }

  async function finish() {
    if (S.busy) return;
    commitTextIfOpen();
    const url = exportImage();
    if (S.cfg.autoCopy !== false) await api.copyImage(url);
    await api.closeAll();
  }

  async function cancelAll() {
    await api.closeAll();
  }

  async function doCopy() {
    commitTextIfOpen();
    await api.copyImage(exportImage());
    toast('已复制到剪贴板');
  }

  async function doSave() {
    commitTextIfOpen();
    try {
      const r = await api.saveImage(exportImage(), null);
      if (r && r.ok) toast('已保存到 ' + r.filePath);
    } catch (e) {
      toast('保存失败：' + ((e && e.message) || e));
    }
  }

  async function doPin() {
    commitTextIfOpen();
    const url = exportImage();
    await api.pin({
      dataUrl: url,
      x: S.display.x + S.sel.x,
      y: S.display.y + S.sel.y,
      width: Math.round(S.sel.w),
      height: Math.round(S.sel.h),
    });
    await api.closeAll();
  }

  /* ==================== 长截图 ==================== */
  function loadImage(url) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('图片解码失败'));
      im.src = url;
    });
  }

  function findOffset(accData, accW, accH, nd, newW, newH) {
    // 对比条带高度取帧高的 30%，但不超过 56px
    const k = Math.max(6, Math.min(56, Math.floor(newH * 0.3)));
    let best = -1;
    let bestScore = Infinity;
    const maxS = Math.min(newH - 4, accH - k - 1);
    for (let s = 2; s < maxS; s++) {
      let diff = 0;
      let n = 0;
      for (let y = 0; y < k; y += 2) {
        const ay = accH - s + y;
        if (ay < 0) continue;
        const ia0 = ay * accW * 4;
        const ib0 = y * newW * 4;
        for (let x = 0; x < newW; x += 6) {
          const ia = ia0 + x * 4;
          const ib = ib0 + x * 4;
          diff += Math.abs(accData[ia] - nd[ib]) + Math.abs(accData[ia + 1] - nd[ib + 1]) + Math.abs(accData[ia + 2] - nd[ib + 2]);
          n += 3;
        }
      }
      const score = diff / Math.max(1, n);
      if (score < bestScore) { bestScore = score; best = s; }
    }
    return { offset: best, score: bestScore };
  }

  async function stitch(frames) {
    if (!frames.length) return null;
    const imgs = [];
    for (const f of frames) imgs.push(await loadImage(f.dataUrl));
    const w = imgs[0].naturalWidth;
    const h = imgs[0].naturalHeight;

    const acc = document.createElement('canvas');
    acc.width = w;
    acc.height = h;
    let actx = acc.getContext('2d', { willReadFrequently: true });
    actx.drawImage(imgs[0], 0, 0);
    let accH = h;
    let accData = actx.getImageData(0, 0, w, accH).data;
    let added = 0;

    for (let i = 1; i < imgs.length; i++) {
      const tmp = document.createElement('canvas');
      tmp.width = w;
      tmp.height = h;
      tmp.getContext('2d', { willReadFrequently: true }).drawImage(imgs[i], 0, 0);
      const nd = tmp.getContext('2d').getImageData(0, 0, w, h).data;

      const { offset, score } = findOffset(accData, w, accH, nd, w, h);
      if (offset <= 0 || score > 16) break;
      const addH = h - offset;
      if (addH <= 2) break;

      const next = document.createElement('canvas');
      next.width = w;
      next.height = accH + addH;
      const nctx = next.getContext('2d', { willReadFrequently: true });
      nctx.drawImage(acc, 0, 0);
      nctx.drawImage(tmp, 0, offset, w, addH, 0, accH, w, addH);

      acc.width = next.width;
      acc.height = next.height;
      actx = acc.getContext('2d', { willReadFrequently: true });
      actx.drawImage(next, 0, 0);
      accH = next.height;
      accData = actx.getImageData(0, 0, w, accH).data;
      added += addH;
    }
    if (added < 12) return null;
    return { canvas: acc, added };
  }

  async function doLongshot() {
    if (S.busy) return;
    const probe = await api.longshotProbe().catch(() => null);
    if (!probe || !probe.ok) {
      const os = (S.platform && S.platform.platformName) || '当前系统';
      toast(`长截图依赖 Windows 的输入模拟，${os} 上暂不支持`);
      return;
    }
    S.busy = true;
    showBusy('长截图中…（请勿操作鼠标）');
    const sel = { ...S.sel };
    const displayId = S.display.id;
    const rect = {
      x: Math.round(sel.x * S.dpr),
      y: Math.round(sel.y * S.dpr),
      width: Math.round(sel.w * S.dpr),
      height: Math.round(sel.h * S.dpr),
    };
    const cx = S.display.x + sel.x + sel.w / 2;
    const cy = S.display.y + sel.y + sel.h / 2;

    // 每步滚动量控制在选区高度的 ~40%，否则重叠区太小、拼不上
    const notches = Math.max(1, Math.min(6, Math.round((rect.height * 0.4) / 75)));
    const wheelDelta = -120 * notches;

    const frames = [];
    try {
      await api.hideSelf();
      await sleep(240);
      for (let i = 0; i < 12; i++) {
        // eslint-disable-next-line no-await-in-loop
        const f = await api.longshotCapture({ displayId, rect });
        frames.push(f);
        // eslint-disable-next-line no-await-in-loop
        await api.longshotScroll({ x: cx, y: cy, delta: wheelDelta });
        // eslint-disable-next-line no-await-in-loop
        await sleep(400);
      }
    } catch (e) {
      console.error(e);
    } finally {
      await api.showSelf();
    }

    try {
      const r = await stitch(frames);
      if (!r) { toast('长截图失败：没有检测到滚动内容'); return; }
      S.baseImage = r.canvas;
      S.sel.h = r.canvas.height / S.dpr;
      layoutFrame();
      render();
      syncSizeTip();
      placeToolbar();
      toast(`长截图完成：${r.canvas.width} x ${r.canvas.height}`);
    } finally {
      S.busy = false;
      hideBusy();
    }
  }

  /* ==================== 提示 ==================== */
  let toastTimer = null;
  function toast(msg, ms) {
    dom.toast.textContent = msg;
    dom.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => dom.toast.classList.add('hidden'), ms || 2600);
  }
  function showBusy(text) {
    dom.busyText.textContent = text || '处理中…';
    dom.busy.classList.remove('hidden');
  }
  function hideBusy() { dom.busy.classList.add('hidden'); }

  /* ==================== 键盘 ==================== */
  window.addEventListener('keydown', (e) => {
    const editing = dom.textEditor && !dom.textEditor.classList.contains('hidden');
    if (editing) return; // 交给 textEditor 自己的 handler

    if (e.key === 'Escape') { e.preventDefault(); cancelAll(); return; }
    if (e.key === 'Enter') { e.preventDefault(); finish(); return; }

    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (k === 'y') { e.preventDefault(); redo(); return; }
      if (k === 'c') { e.preventDefault(); doCopy(); return; }
      if (k === 's') { e.preventDefault(); doSave(); return; }
      if (k === 't') { e.preventDefault(); doTranslate(); return; }
      if (k === 'o') { e.preventDefault(); doOcr(); return; }
      if (k === 'a') { e.preventDefault(); return; }
      return;
    }
    if (e.altKey) return;

    const map = { r: 'rect', e: 'ellipse', m: 'emoji', a: 'arrow', p: 'pen', b: 'mosaic', t: 'text' };
    const k = e.key.toLowerCase();
    if (map[k]) { e.preventDefault(); setTool(S.tool === map[k] ? null : map[k]); return; }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (S.selectedId) { e.preventDefault(); pushHistory(); removeObj(S.selectedId); render(); }
    }
  });

  /* ==================== 启动 ==================== */
  function boot() {
    cacheDom();
    buildToolbar();
    buildStyleBar();
    dom.layer.addEventListener('mousedown', onLayerDown);

    // 文字编辑框的监听只挂一次，避免重复叠加
    dom.textEditor.addEventListener('mousedown', (e) => e.stopPropagation());
    dom.textEditor.addEventListener('keydown', onTextKey);
    dom.textEditor.addEventListener('blur', () => { setTimeout(() => commitTextIfOpen(), 120); });

    dom.frame.querySelectorAll('.h').forEach((h) => {
      h.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        if (S.phase !== 'ready') return;
        S.action = {
          kind: 'resize-sel', dir: h.dataset.d, start: { x: e.clientX, y: e.clientY },
          orig: { ...S.sel },
        };
        window.addEventListener('mousemove', onSelResize);
        window.addEventListener('mouseup', onSelResizeEnd, { once: true });
      });
    });
  }

  function onSelResize(e) {
    const a = S.action;
    if (!a || a.kind !== 'resize-sel') return;
    const dx = e.clientX - a.start.x;
    const dy = e.clientY - a.start.y;
    const o = a.orig;
    let x0 = o.x;
    let y0 = o.y;
    let x1 = o.x + o.w;
    let y1 = o.y + o.h;
    const d = a.dir;
    if (d.includes('w')) x0 = o.x + dx;
    if (d.includes('e')) x1 = o.x + o.w + dx;
    if (d.includes('n')) y0 = o.y + dy;
    if (d.includes('s')) y1 = o.y + o.h + dy;
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(window.innerWidth, x1);
    y1 = Math.min(window.innerHeight, y1);
    if (x1 - x0 < 8) return;
    if (y1 - y0 < 8) return;
    S.sel = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    layoutFrame();
    render();
    syncSizeTip();
    placeToolbar();
  }

  function onSelResizeEnd() {
    if (S.action && S.action.kind === 'resize-sel') S.action = null;
    window.removeEventListener('mousemove', onSelResize);
  }

  boot();
})();
