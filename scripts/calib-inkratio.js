'use strict';
/**
 * 标定「墨迹高度 / 字号」比值，按字形类别各一个 —— 即 src/pipeline.js 里 INK_RATIO 的来源。
 *
 * 为什么不用 OCR 的框高来标定：
 *   PP-OCR 的框高相对墨迹的外扩量不稳定（38px 的标题框高 37、比墨迹还小；
 *   19px 的正文框高 23、比墨迹大 3px），框高乘系数最差能偏 16%。
 *   所以标定不能信框，只能信像素。
 *
 * 为什么复用 ocr.measureInk 而不是自己再写一遍：
 *   measureInk 就是生产路径里量墨迹的那个函数（含 INK_DEV=80 / INK_MIN=2 与
 *   0.9×框高的扫描余量）。直接调它，标定值与实现不可能漂移。
 *
 * 做法：渲染「字号已知」的卡片 → 截图 → 对每一行调用 measureInk → ink/size 即比值。
 *
 * 注意 capturePage 会把高度截断在约 1353px，所以按字号分两组渲染。
 *
 * 跑法：npm run calib:inkratio
 * 产物：demo/_calib-g1.html / demo/_calib-g2.html、demo/calib-g1.png / demo/calib-g2.png
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

// 每类 6 个互不相同的串，长度接近，保证同类内墨迹高度可比
const CLASSES = {
  cjk: ['识别到的文字会就地替换', '翻译结果保留原来的字号', '框选之后点击翻译按钮', '支持中英文混合排版识别', '截图后可直接复制到剪贴板', '本地识别不需要联网也能用'],
  desc: ['joggy puppy jumping', 'quickly typing pages', 'jumpy dogs playing', 'gaps between paragraphs', 'query pages quickly', 'sleepy puppy yawns'],
  asc: ['TEXT LINE SAMPLE', 'ANOTHER TEXT BLOCK', 'HELLO WORLD TEST', 'BLACK TEXT HERE', 'SAMPLE HEADLINE', 'MAIN HEADING NOW'],
  xh: ['answer or murmur', 'we assume success', 'measure our errors', 'no more zones were seen', 'same zone was seen', 'ensure more revenue'],
};
const SIZES = [12, 15, 19, 24, 32, 38];
const GROUPS = [[12, 15, 19], [24, 32, 38]];
const KEYS = Object.keys(CLASSES);

const W = 700;
const ROW_H = 74;
const TOP0 = 24;
const LINE_H = 1.2; // 卡片里 .t 的 line-height

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

async function loadWithRetry(win, url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { await win.loadURL(url); return; } catch (e) {
      console.log(`[calib] 加载失败（${i + 1}/${tries}）：${e.message.split('\n')[0]}`);
      if (i === tries - 1) throw e;
      await sleep(700);
    }
  }
}

/** Electron 的 toBitmap() 在 Windows 上是 BGRA；measureInk 要 RGBA。macOS 本来就是 RGBA。 */
function toRGBA(img) {
  const { width, height } = img.getSize();
  const src = img.toBitmap();
  if (process.platform === 'darwin') return { data: src, width, height };
  const out = Buffer.alloc(src.length);
  for (let i = 0; i < src.length; i += 4) {
    out[i] = src[i + 2];
    out[i + 1] = src[i + 1];
    out[i + 2] = src[i];
    out[i + 3] = src[i + 3];
  }
  return { data: out, width, height };
}

(async () => {
  await app.whenReady();
  fs.mkdirSync(OUT, { recursive: true });

  // 自检：样本必须真的属于它声明的字形类别。
  // 踩过坑：原来 xh 组里放了 'no errors occurred'，它含升部字母 d，
  // 实测墨迹被升部撑高（24px 量到 19px、比值 0.792），把 xh 的均值从 0.55 抬到 0.58。
  let badSample = 0;
  for (const cls of KEYS) {
    for (const text of CLASSES[cls]) {
      const got = pipeline.classifyInk(text);
      if (got !== cls) { console.log(`⚠️ 样本类别不符：声明 ${cls}，classifyInk 判为 ${got} —— ${JSON.stringify(text)}`); badSample++; }
    }
  }
  if (badSample) { console.error(`\n有 ${badSample} 个样本类别不符，标定结果不可信，请先修样本。`); app.exit(1); return; }

  const { srv, port } = await startServer(ROOT);
  const stats = new Map(); // cls -> [{size, ink, ratio}]

  for (let gi = 0; gi < GROUPS.length; gi++) {
    const sizes = GROUPS[gi];
    const rows = [];
    const plan = [];
    let n = 0;
    for (const size of sizes) {
      for (const cls of KEYS) {
        const text = CLASSES[cls][SIZES.indexOf(size)];
        plan.push({ text, size, cls, top: TOP0 + n * ROW_H });
        rows.push(`<div class="t" style="top:${TOP0 + n * ROW_H}px;font-size:${size}px">${text}</div>`);
        n++;
      }
    }
    const H = TOP0 + n * ROW_H + 40;

    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0}
  body{width:${W}px;height:${H}px;background:#fff;position:relative;font-family:"Microsoft YaHei"}
  .t{position:absolute;left:16px;color:#000;white-space:nowrap;line-height:${LINE_H}}
</style></head><body>${rows.join('\n')}</body></html>`;
    fs.writeFileSync(path.join(OUT, `_calib-g${gi + 1}.html`), html, 'utf8');

    const win = new BrowserWindow({
      width: W, height: H, show: false, useContentSize: true, backgroundColor: '#fff',
      webPreferences: { backgroundThrottling: false, sandbox: false },
    });
    win.webContents.on('render-process-gone', (e, d) => console.log('!! 渲染进程退出', JSON.stringify(d)));
    await loadWithRetry(win, `http://127.0.0.1:${port}/demo/_calib-g${gi + 1}.html`);
    await sleep(800);
    const img = await win.webContents.capturePage();
    win.destroy();

    const got = img.getSize();
    console.log(`\n--- 组 ${gi + 1}（字号 ${sizes.join(',')}）请求 ${W}x${H} → 实得 ${got.width}x${got.height}${got.height < H ? '  ⚠️ 被截断' : ''} ---`);
    fs.writeFileSync(path.join(OUT, `calib-g${gi + 1}.png`), img.toPNG());

    const buf = toRGBA(img);
    console.log(' cls  | 字号 | 墨迹 | 比值  | 文本');
    for (const p of plan) {
      // 给一个覆盖整行的近似框，measureInk 自己会按 0.9×框高上下放开再找墨迹带
      const box = { x0: 16, y0: p.top, x1: W - 20, y1: p.top + p.size * LINE_H };
      const ink = ocr.measureInk(buf.data, buf.width, buf.height, box);
      if (!ink) { console.log(` ${p.cls.padEnd(4)} | ${String(p.size).padStart(4)} |  ——  | ——    | ${p.text}  (没量到墨迹)`); continue; }
      const ratio = ink / p.size;
      if (!stats.has(p.cls)) stats.set(p.cls, []);
      stats.get(p.cls).push({ size: p.size, ink, ratio });
      console.log(` ${p.cls.padEnd(4)} | ${String(p.size).padStart(4)} | ${String(ink).padStart(4)} | ${ratio.toFixed(3)} | ${p.text}`);
    }
  }
  srv.close();

  console.log('\n=== 每类 inkRatio 汇总（inkRatio = 墨迹高度 / 字号）===');
  const out = {};
  for (const cls of KEYS) {
    const arr = stats.get(cls) || [];
    if (!arr.length) continue;
    const rs = arr.map((a) => a.ratio);
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
    const sd = Math.sqrt(rs.reduce((s, v) => s + (v - mean) ** 2, 0) / rs.length);
    out[cls] = +mean.toFixed(4);
    console.log(`  ${cls.padEnd(4)}  inkRatio=${mean.toFixed(4)}  标准差 ${sd.toFixed(4)}  范围 ${Math.min(...rs).toFixed(3)}~${Math.max(...rs).toFixed(3)}  (n=${rs.length})`);
  }

  console.log('\n=== 与 src/pipeline.js 现值对比 ===');
  let drift = 0;
  for (const cls of KEYS) {
    if (!(cls in out)) continue;
    const cur = pipeline.INK_RATIO[cls];
    const d = Math.abs(out[cls] - cur);
    drift = Math.max(drift, d);
    console.log(`  ${cls.padEnd(4)}  标定 ${out[cls].toFixed(4)}  现值 ${cur}  差 ${d.toFixed(4)}${d > 0.03 ? '  ⚠️ 偏差偏大' : ''}`);
  }
  console.log(`\n最大偏差 ${drift.toFixed(4)}${drift > 0.03 ? '  → 建议更新 INK_RATIO' : '  → 与现值一致，无需改动'}`);
  console.log('\n' + JSON.stringify(out, null, 2));

  await ocr.terminate().catch(() => {});
  app.exit(0);
})().catch(async (e) => {
  console.error('失败：', e && e.stack ? e.stack : e);
  await ocr.terminate().catch(() => {});
  app.exit(1);
});
