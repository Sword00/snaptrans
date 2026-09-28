'use strict';
/**
 * 端到端验证：造一张「翻译前」的截图 → 真实 OCR + 真实翻译 → 真实渲染逻辑就地替换。
 *
 *   npm run uitest
 *
 * 产出：
 *   demo/demo-before.png    翻译前的原图
 *   demo/demo-after.png     就地替换后的结果
 *   demo/uitest-report.json 每段原文/译文/取到的背景色与文字色
 *
 * 说明：页面通过本地 HTTP 加载（受限环境里 file:// 会间歇性 ERR_FAILED）；
 * OCR 与翻译在主进程跑（和真实应用一致，都是 src/pipeline.js）。
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'demo');
const W = 760;
const H = 460;

const pipeline = require(path.join(ROOT, 'src', 'pipeline'));
const translateMod = require(path.join(ROOT, 'src', 'translate'));
const settings = require(path.join(ROOT, 'src', 'settings'));
const ocrMod = require(path.join(ROOT, 'src', 'ocr'));
const { configureGpu } = require(path.join(ROOT, 'src', 'gpu'));

configureGpu(app);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 关键：销毁临时窗口后不能让它自动退出（默认 window-all-closed 会 app.quit()）
app.on('window-all-closed', () => {});

/* ---------------- 极简静态服务 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

function startServer(root) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(String(req.url).split('?')[0]).replace(/^\/+/, '');
      const file = path.resolve(root, rel);
      if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(buf);
      });
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

/* ---------------- 测试用的「翻译前」界面 ---------------- */
const CARD_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:${W}px;height:${H}px;background:#eef1f5;
  font-family:"Microsoft YaHei","Segoe UI",sans-serif;overflow:hidden;}
.card{position:absolute;left:30px;top:30px;width:700px;height:400px;background:#fff;
  border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.09);padding:32px 38px;box-sizing:border-box;}
h1{font-size:38px;font-weight:700;color:#1a1d21;margin:0 0 16px;letter-spacing:-.5px;}
p{font-size:19px;color:#6b7280;margin:0 0 30px;}
.btn{display:inline-block;background:#0a84ff;color:#fff;font-size:20px;font-weight:600;
  padding:12px 30px;border-radius:10px;margin-right:16px;}
.badge{display:inline-block;background:#ff3b30;color:#fff;font-size:15px;font-weight:700;
  padding:7px 13px;border-radius:6px;vertical-align:7px;}
/* 下面两行是字重标定样本：同为 24px，一个常规一个粗体。
   行距必须拉开，否则会被 groupParagraphs 合并成一段，标定就失效了 */
.cal{margin-top:30px;font-size:24px;color:#1a1d21;line-height:1.25;}
.cal + .cal{margin-top:44px;}
.cal .r{font-weight:400;}
.cal .b{font-weight:700;}
</style></head><body>
<div class="card">
  <h1>Translate any text on your screen</h1>
  <p>Press Alt+Shift+A, drag to select a region, then hit the translate button.</p>
  <span class="btn">Get Started</span><span class="badge">NEW</span>
  <div class="cal"><span class="r">Regular weight sample</span></div>
  <div class="cal"><span class="b">Bold weight sample</span></div>
</div>
</body></html>`;

/* ---------------- 渲染页 ---------------- */
const RENDER_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#eef1f5;}
canvas{display:block;}
</style></head><body>
<canvas id="c"></canvas>
<script src="/renderer/objects.js"></script>
</body></html>`;

async function newWindow(opts) {
  const win = new BrowserWindow(Object.assign({
    width: W, height: H, show: false, frame: false,
    webPreferences: { backgroundThrottling: false, sandbox: false },
  }, opts));
  win.webContents.on('render-process-gone', (e, d) => {
    console.log('[uitest] !! 渲染进程退出:', JSON.stringify(d));
  });
  return win;
}

async function loadWithRetry(win, url, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      await win.loadURL(url);
      return true;
    } catch (e) {
      last = e;
      console.log(`[uitest] 加载失败（${i + 1}/${tries}）：${e.message.split('\n')[0]}`);
      await sleep(700);
    }
  }
  throw last;
}

/** 渲染脚本：用 src 里的真实取色 / 排版 / 绘制逻辑做就地替换 */
function renderScript(imgDataUrl, paragraphs) {
  return `(async () => {
    const paras = ${JSON.stringify(paragraphs)};
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = ${JSON.stringify(imgDataUrl)}; });

    const W0 = img.naturalWidth, H0 = img.naturalHeight;
    const c = document.getElementById('c');
    c.width = W0; c.height = H0;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);

    // 取色用的原图副本（不能被覆盖）
    const src = document.createElement('canvas');
    src.width = W0; src.height = H0;
    src.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);

    const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().toLowerCase();
    const drawn = [];
    const skipped = [];

    for (const para of paras) {
      const translated = para.translation || '';
      if (!translated.trim() || norm(translated) === norm(para.text)) { skipped.push(para.text); continue; }
      const b = para.bbox;
      const bh = Math.max(6, b.y1 - b.y0);
      const pad = Math.max(2, Math.round(bh * 0.14));
      const x0 = Math.max(0, b.x0 - pad), y0 = Math.max(0, b.y0 - pad);
      const x1 = Math.min(W0, b.x1 + pad), y1 = Math.min(H0, b.y1 + pad);
      const bg = OBJ.sampleBg(src, b, pad);
      const fg = OBJ.sampleFg(src, b, bg);
      const ratio = OBJ.inkStrokeRatio(src, b, bg, fg);
      const bold = OBJ.detectBold(src, b, bg, fg);
      const o = {
        type: 'trans', x: x0, y: y0, w: x1 - x0, h: y1 - y0,
        text: translated, bg, fg, bold,
        fontSize: Math.round(para.fontSize || bh * 0.96),
        align: para.align || 'left',
        maxLines: Math.max(1, Math.min(8, (para.lineCount || 1) + 2)),
      };
      OBJ.draw(ctx, o, 1);
      drawn.push({ from: para.text, to: translated, bbox: [x0, y0, x1, y1], bg, fg, bold, strokeRatio: +ratio.toFixed(3), fontSize: o.fontSize, align: o.align });
    }

    return { png: c.toDataURL('image/png'), drawn, skipped, w: W0, h: H0 };
  })()`;
}

(async () => {
  await app.whenReady();
  settings.init();
  settings.set({ targetLang: 'zh-Hans', translateEngine: 'free', sourceLang: 'auto', freeProvider: 'auto' });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, '_card.html'), CARD_HTML, 'utf8');
  fs.writeFileSync(path.join(OUT, '_render.html'), RENDER_HTML, 'utf8');

  const { srv, port } = await startServer(ROOT);
  const base = `http://127.0.0.1:${port}`;
  console.log('[uitest] 静态服务', base);

  /* ---------- 1. 造一张「翻译前」的截图 ---------- */
  let shot = null;
  for (let i = 0; i < 4 && !shot; i++) {
    const win = await newWindow({ backgroundColor: '#eef1f5' });
    try {
      await loadWithRetry(win, `${base}/demo/_card.html`);
      await sleep(900);
      const img = await win.capturePage();
      if (!img.isEmpty()) shot = img;
      else console.log('[uitest] capturePage 空图，重试');
    } catch (e) {
      console.log('[uitest] 卡片截图失败：', e.message.split('\n')[0]);
    }
    try { win.destroy(); } catch (_) {}
    if (!shot) await sleep(700);
  }
  if (!shot) { console.error('[uitest] 无法截取测试卡片'); app.exit(1); }

  const shotPng = shot.toPNG();
  fs.writeFileSync(path.join(OUT, 'demo-before.png'), shotPng);
  console.log('[uitest] demo-before.png', JSON.stringify(shot.getSize()));

  /* ---------- 2. 真实 OCR + 真实翻译 ---------- */
  const s = settings.all();
  const dataUrl = 'data:image/png;base64,' + shotPng.toString('base64');
  const t0 = Date.now();
  const res = await pipeline.recognizeAndTranslate(dataUrl, {
    sourceLang: s.sourceLang,
    targetLang: s.targetLang,
    translateEngine: s.translateEngine,
    freeProvider: s.freeProvider,
    llm: s.llm,
  });
  console.log(`[uitest] OCR+翻译 ${Date.now() - t0}ms，引擎 ${res.provider}，${res.paragraphs.length} 段`);
  res.paragraphs.forEach((p) => console.log(`    "${p.text}"  →  "${p.translation}"`));

  /* ---------- 3. 用真实渲染逻辑就地替换 ---------- */
  const rw = await newWindow({ backgroundColor: '#eef1f5' });
  await loadWithRetry(rw, `${base}/demo/_render.html`);
  await sleep(400);
  const out = await rw.webContents.executeJavaScript(renderScript(dataUrl, res.paragraphs), true);
  if (!out || !out.png) { console.error('[uitest] 渲染失败'); app.exit(1); }

  fs.writeFileSync(path.join(OUT, 'demo-after.png'), nativeImage.createFromDataURL(out.png).toPNG());
  fs.writeFileSync(
    path.join(OUT, 'uitest-report.json'),
    JSON.stringify({ provider: res.provider, size: [out.w, out.h], drawn: out.drawn, skipped: out.skipped, all: res.paragraphs }, null, 2),
    'utf8'
  );

  console.log(`[uitest] demo-after.png 画布 ${out.w}x${out.h}`);
  console.log(`[uitest] 就地替换 ${out.drawn.length} 处，跳过 ${out.skipped.length} 处`);
  out.drawn.forEach((d) => {
    console.log(
      `    "${d.from}" → "${d.to}"  bg=${d.bg} fg=${d.fg} size=${d.fontSize} ` +
      `align=${d.align} bold=${d.bold} stroke=${d.strokeRatio}`
    );
  });

  /* ---------- 4. 小字回归 ----------
   * 背景：用户在小屏（738x536）上框了 90x39 的区域，里面那行字只有约 11px 高，
   * 当时用的 Tesseract 对字高低于 ~20px 的文本基本失效，报「没有识别到文字」，
   * 后来靠逐级放大重试才勉强救回来。
   *
   * 现在换成 PaddleOCR：检测模型只在必要时把图向上补齐到 32 的倍数、不做下采样，
   * 小字天然就能认（实测 1200x800 + 13px 中文 14/14 全中）。这条用例保留下来，
   * 钉住「11px 级别的英文小字仍然识别得到」这个能力，防止以后调参把它弄丢。
   */
  const SMALL_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:200px;height:60px;background:#fff;overflow:hidden;
  font-family:"Segoe UI",Arial,sans-serif;}
.row{position:absolute;left:10px;top:10px;width:180px;height:40px;display:flex;align-items:center;gap:6px;}
.ico{width:20px;height:20px;background:#0a84ff;border-radius:4px;flex:0 0 auto;}
.nm{font-size:11px;color:#1a1d21;white-space:nowrap;}
</style></head><body>
<div class="row"><span class="ico"></span><span class="nm">SnapTrans 1.0.0.exe</span></div>
</body></html>`;
  fs.writeFileSync(path.join(OUT, '_small.html'), SMALL_HTML, 'utf8');

  let smallOk = false;
  try {
    const sw = await newWindow({ width: 200, height: 60, backgroundColor: '#fff' });
    await loadWithRetry(sw, `${base}/demo/_small.html`);
    await sleep(700);
    const shot2 = await sw.capturePage();
    try { sw.destroy(); } catch (_) {}
    if (shot2 && !shot2.isEmpty()) {
      // 裁出和用户实际选区同量级的 90x39
      const crop = shot2.crop({ x: 10, y: 10, width: 90, height: 39 });
      fs.writeFileSync(path.join(OUT, 'demo-small-before.png'), crop.toPNG());
      fs.writeFileSync(
        path.join(OUT, 'demo-small-before-x4.png'),
        crop.resize({ width: 360, height: 156, quality: 'best' }).toPNG()
      );
      const small = await ocrMod.recognize(crop.toDataURL());
      console.log(`[uitest] 小字回归：90x39 裁片 → ${small.lines.length} 行`);
      small.lines.forEach((l) => console.log(`    "${l.text}" conf=${l.confidence}`));
      smallOk = small.lines.length > 0;
      console.log(smallOk ? '[uitest] ✅ 小字回归通过' : '[uitest] ❌ 小字回归失败：小字区域仍识别不到');
    }
  } catch (e) {
    console.log('[uitest] 小字回归出错：', e.message.split('\n')[0]);
  }

  await ocrMod.terminate().catch(() => {});
  srv.close();
  app.exit(smallOk ? 0 : 1);
})().catch(async (e) => {
  console.error('[uitest] 异常：', e && e.stack ? e.stack : e);
  await ocrMod.terminate().catch(() => {});
  app.exit(1);
});
