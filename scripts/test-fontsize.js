'use strict';
/**
 * 字号估计验收：渲染一张「已知字号」的卡片 → 真实 OCR → 真实 estimateFontSize → 比对。
 *
 * 覆盖 4 种字形类别 × 多个字号，中英文各一组，
 * 用来钉住 src/pipeline.js 的 INK_RATIO 标定值。
 *
 * 判据：每行估计字号与真实字号的相对误差。
 *   ≤ 8%  正常
 *   ≤ 15% 警告（会打印 ~）
 *   > 15% 失败（会打印 !!，且退出码非 0）
 * 另有「未识别到」的行也计入失败。
 *
 * 注意：每行之间要拉开距离（ROW_H 远大于字号），
 * 否则会被 groupParagraphs 合并成一段，比对就失效了。
 *
 * 产物：demo/_fontsize.html（卡片源）、demo/fontsize.png（截图）
 * 跑法：npm run test:fontsize
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'demo');

require(path.join(ROOT, 'src', 'gpu.js')).configureGpu(app);
app.on('window-all-closed', () => {});

const ocr = require(path.join(ROOT, 'src', 'ocr'));
const pipeline = require(path.join(ROOT, 'src', 'pipeline'));

const W = 760;
const ROW_H = 68;

// [文本, 字号, 期望类别]
const ROWS = [
  ['Translate any text on your screen', 38, 'desc'],
  ['Press Alt+Shift+A, then drag to select', 19, 'desc'],
  ['Regular weight sample text here', 24, 'desc'],
  ['截图翻译可以直接替换原文', 38, 'cjk'],
  ['识别到的文字会就地替换，保留字号与颜色', 19, 'cjk'],
  ['框选之后点击翻译按钮即可', 15, 'cjk'],
  ['SAVE CHANGES', 20, 'asc'],
  ['Submit', 20, 'asc'],
  ['we assume success', 20, 'xh'],
  ['joggy puppy jumping', 15, 'desc'],
  ['本地识别不需要联网也能用', 13, 'cjk'],
  ['Cancel', 13, 'asc'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(root) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(String(req.url).split('?')[0]).replace(/^\/+/, '');
      const file = path.resolve(root, rel);
      if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buf);
      });
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

// 受限环境里首次 loadURL 可能间歇性 ERR_FAILED，重试几次
async function loadWithRetry(win, url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { await win.loadURL(url); return; } catch (e) {
      console.log(`[test:fontsize] 加载失败（${i + 1}/${tries}）：${e.message.split('\n')[0]}`);
      if (i === tries - 1) throw e;
      await sleep(700);
    }
  }
}

const H = 24 + ROWS.length * ROW_H + 30;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:${W}px;height:${H}px;background:#fff;overflow:hidden;
  font-family:"Microsoft YaHei","Segoe UI",sans-serif;}
.t{position:absolute;left:20px;color:#1a1d21;white-space:nowrap;line-height:1.2}
</style></head><body>
${ROWS.map((r, i) => `<div class="t" style="top:${20 + i * ROW_H}px;font-size:${r[1]}px">${r[0]}</div>`).join('\n')}
</body></html>`;

const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();

(async () => {
  await app.whenReady();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, '_fontsize.html'), HTML, 'utf8');

  const { srv, port } = await startServer(ROOT);
  const win = new BrowserWindow({
    width: W, height: H, show: false, useContentSize: true, backgroundColor: '#fff',
    webPreferences: { backgroundThrottling: false, sandbox: false },
  });
  win.webContents.on('render-process-gone', (e, d) => console.log('!! 渲染进程退出', JSON.stringify(d)));
  await loadWithRetry(win, `http://127.0.0.1:${port}/demo/_fontsize.html`);
  await sleep(900);
  const img = await win.webContents.capturePage();
  win.destroy();
  srv.close();

  const got = img.getSize();
  console.log(`[test:fontsize] 请求 ${W}x${H} → 实得 ${got.width}x${got.height}${got.height < H ? '  ⚠️ 被截断' : ''}`);
  fs.writeFileSync(path.join(OUT, 'fontsize.png'), img.toPNG());
  if (got.height < H) { console.error('截图被截断，无法完整验收'); app.exit(1); }

  const t0 = Date.now();
  const res = await ocr.recognize('data:image/png;base64,' + img.toPNG().toString('base64'));
  console.log(`[test:fontsize] OCR ${Date.now() - t0}ms，${res.lines.length} 行 / ${res.paragraphs.length} 段\n`);

  const byText = new Map();
  for (const p of res.paragraphs) byText.set(norm(p.text), p);

  console.log('真实 | 估计 | 误差  | 类别(期望/判定) | 墨迹 | 文本');
  console.log('-----|------|-------|-----------------|------|-----');
  let worst = 0;
  let n = 0;
  let miss = 0;
  for (const [text, size, expCls] of ROWS) {
    const p = byText.get(norm(text));
    if (!p) { console.log(`  —— |  ——  | 未识别到        | ${expCls} | ${text}`); miss++; continue; }
    const est = pipeline.estimateFontSize(p.lines, p.text);
    const cls = pipeline.classifyInk(p.text);
    const ink = Math.max(...p.lines.map((l) => l.inkHeight || 0));
    const err = est - size;
    const pct = Math.abs(err) / size;
    worst = Math.max(worst, pct);
    n++;
    const flag = pct <= 0.08 ? '  ' : (pct <= 0.15 ? ' ~' : ' !!');
    console.log(
      `${String(size).padStart(4)} | ${String(est).padStart(4)} | ${String(err >= 0 ? '+' + err : err).padStart(5)} | ` +
      `${expCls}/${cls}${expCls === cls ? ' ' : '✗'} | ${String(ink.toFixed(1)).padStart(4)} | ${text}${flag}` +
      (expCls === cls ? '' : `\n     ↳ OCR 原文 = ${JSON.stringify(p.text)}`)
    );
  }

  console.log(`\n[test:fontsize] 共 ${n} 行可比对，${miss} 行未识别；最大误差 ${(worst * 100).toFixed(1)}%`);
  console.log(worst <= 0.08 ? '✅ 全部在 8% 以内' : (worst <= 0.15 ? '⚠️ 有行超过 8%' : '❌ 有行超过 15%'));

  await ocr.terminate().catch(() => {});
  app.exit(worst <= 0.15 && miss === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('失败：', e && e.stack ? e.stack : e);
  await ocr.terminate().catch(() => {});
  app.exit(1);
});
