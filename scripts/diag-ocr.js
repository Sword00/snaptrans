'use strict';
/**
 * OCR 诊断：对一张真实截图跑识别，把每行的坐标/置信度打出来，并画一张框线图。
 *
 *   npm run diag:ocr                 # 自动取最近一张粘贴到对话里的截图
 *   npm run diag:ocr -- <图片路径>    # 指定图片
 *
 * 产出：
 *   demo/diag-ocr-boxes.png   原图 + 识别框（红框）+ 行号
 *
 * 为什么需要它：这个工具的核心就是「认不认得出来」，出问题时第一件事是看
 * 「框在哪、认成什么、置信度多少」，而不是猜。之前那三个 Tesseract 时代的
 * 诊断脚本（diag-blocks / diag-pad / diag-small）针对的是 Tesseract 特有的
 * 失效模式（彩底丢块、pad 尺寸、小字放大），换引擎后已无意义，删掉换成这个。
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'demo');
const ocr = require(path.join(ROOT, 'src', 'ocr'));
const { configureGpu } = require(path.join(ROOT, 'src', 'gpu'));

configureGpu(app);
app.on('window-all-closed', () => {});

/** 最近一张粘贴进对话的截图（时间戳是 UTC，按 mtime 倒序取最新） */
function newestClipboardShot() {
  const dir = path.join(os.homedir(), '.workbuddy-ai', 'clipboard-images');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => /\.png$/i.test(f))
    .map((f) => {
      const p = path.join(dir, f);
      return { p, t: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => b.t - a.t);
  return files.length ? files[0].p : null;
}

function toDataUrl(p) {
  const mime = /\.jpe?g$/i.test(p) ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
}

/**
 * 起一个极简静态服务。
 * 受限环境（IDE 内置终端 / 沙箱）里 `loadURL('data:text/html,...')` 会间歇性
 * ERR_FAILED (-2)，走本地 HTTP 就稳了（uitest 也是这么干的）。
 */
function startServer(root) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(String(req.url).split('?')[0]).replace(/^\/+/, '');
      const file = path.resolve(root, rel);
      if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buf);
      });
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

const DIAG_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fff}</style></head>
<body><canvas id="c"></canvas><script>
window.render = function(src, boxes) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const c = document.getElementById('c');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      g.lineWidth = 2; g.font = '12px sans-serif';
      boxes.forEach((b, i) => {
        g.strokeStyle = '#e24b4a';
        g.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
        const label = String(i + 1);
        g.fillStyle = '#e24b4a';
        g.fillRect(b.x0, Math.max(0, b.y0 - 14), 8 * label.length + 4, 14);
        g.fillStyle = '#fff';
        g.fillText(label, b.x0 + 2, Math.max(10, b.y0 - 3));
      });
      res({ png: c.toDataURL('image/png'), w: c.width, h: c.height });
    };
    img.onerror = () => res(null);
    img.src = src;
  });
};
</script></body></html>`;

/** 用离屏 canvas 把框画出来 */
async function drawBoxes(dataUrl, lines) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, '_diag.html'), DIAG_HTML, 'utf8');
  const { srv, port } = await startServer(OUT);

  const win = new BrowserWindow({
    width: 900, height: 700, show: false,
    webPreferences: { backgroundThrottling: false, sandbox: false },
  });
  try {
    let last;
    for (let i = 0; i < 5; i++) {
      try { await win.loadURL(`http://127.0.0.1:${port}/_diag.html`); last = null; break; } catch (e) {
        last = e;
        console.log(`页面加载失败（${i + 1}/5）：${e.message.split('\n')[0]}`);
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    if (last) throw last;

    return await win.webContents.executeJavaScript(
      `render(${JSON.stringify(dataUrl)}, ${JSON.stringify(lines.map((l) => l.bbox))})`, true
    );
  } finally {
    try { win.destroy(); } catch (_) { /* ignore */ }
    srv.close();
  }
}

(async () => {
  await app.whenReady();

  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const file = arg || newestClipboardShot();
  if (!file) {
    console.error('找不到图片：请传入路径，或先把截图粘贴到对话里');
    app.exit(1);
    return;
  }
  if (!fs.existsSync(file)) {
    console.error('文件不存在:', file);
    app.exit(1);
    return;
  }

  console.log(`图片: ${file}`);
  console.log(`尺寸: ${JSON.stringify(nativeImage.createFromPath(file).getSize())}`);
  console.log(`模型目录: ${ocr.modelDir() || '(未找到)'}\n`);

  const t0 = Date.now();
  const { lines, paragraphs, size } = await ocr.recognize(toDataUrl(file));
  console.log(`识别耗时 ${Date.now() - t0}ms → ${lines.length} 行 / ${paragraphs.length} 段（图 ${size.width}x${size.height}）\n`);

  console.log('--- 逐行 ---');
  console.log(' #  conf  框高 墨迹  框坐标                                  文本');
  lines.forEach((l, i) => {
    const b = l.bbox;
    const boxH = b.y1 - b.y0;
    console.log(
      `${String(i + 1).padStart(2)}. ${String(l.confidence).padStart(3)} ` +
      `${boxH.toFixed(0).padStart(5)} ${String(Math.round(l.inkHeight || 0)).padStart(4)}  ` +
      `[${Math.round(b.x0)},${Math.round(b.y0)} → ${Math.round(b.x1)},${Math.round(b.y1)}]`.padEnd(38) +
      `  "${l.text}"`
    );
  });

  console.log('\n--- 分段 ---');
  paragraphs.forEach((p, i) => {
    const b = p.bbox;
    console.log(
      `${String(i + 1).padStart(2)}. conf=${p.confidence.toFixed(0).padStart(3)} ` +
      `${p.lines.length} 行 [${Math.round(b.x0)},${Math.round(b.y0)} → ${Math.round(b.x1)},${Math.round(b.y1)}]  "${p.text}"`
    );
  });

  fs.mkdirSync(OUT, { recursive: true });
  const drawn = await drawBoxes(toDataUrl(file), lines);
  if (drawn) {
    fs.writeFileSync(path.join(OUT, 'diag-ocr-boxes.png'), nativeImage.createFromDataURL(drawn.png).toPNG());
    console.log(`\n框线图 → demo/diag-ocr-boxes.png (${drawn.w}x${drawn.h})`);
  }

  await ocr.terminate().catch(() => {});
  app.exit(0);
})().catch(async (e) => {
  console.error('诊断失败：', e && e.stack ? e.stack : e);
  await ocr.terminate().catch(() => {});
  app.exit(1);
});
