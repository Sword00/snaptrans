'use strict';
/**
 * 本地 OCR：PaddleOCR PP-OCRv4 + ONNX Runtime，跑在主进程。
 *
 * 为什么从 Tesseract 换掉（实测，不是推测）：
 *   同一张中文 UI 截图，Tesseract 把「截图翻译设置」认成「戟国翁诉设置」、
 *   把「识别到的文字会就地替换」认成「SBR RE」、把「立即翻译」认成「E」—— 中文基本不可用。
 *   换 PP-OCRv4 后同一张图 6/6 全对，而且稳态更快（347ms vs 612ms）。
 *   1200x800 大图 + 13px 小字也 14/14 全中（稳态 722ms）。
 *
 * 因此下面这些 Tesseract 时代的补丁全部不再需要，已一并删除：
 *   - 放大阶梯重试（UPSCALE_SCALES）：检测模型自己处理小字
 *   - 彩底区块二次识别（detectColorBlocks）：蓝底白字的按钮直接就能认对
 *   - 反色补识别（invertDataUrl）
 *   - 汉字间空格还原以外的各种后处理
 *
 * 对外契约保持不变：recognize(dataUrl) -> { lines, paragraphs, blocks, size, scale }
 *   lines[i]      = { text, bbox:{x0,y0,x1,y1}, inkHeight, confidence, poly }
 *   paragraphs[i] = { text, bbox, lines, confidence }
 *   confidence 沿用 0~100（PaddleOCR 的 mean 是 0~1，这里乘 100）
 *   inkHeight 是本轮新增的：从像素量出来的真实墨迹高度（px，原图坐标系），
 *             下游 estimateFontSize 靠它推字号 —— PP-OCR 的框高推不准，见 measureInk。
 */
const path = require('path');
const fs = require('fs');
const platform = require('./platform');

// 允许在纯 Node（自检脚本）下加载：此时 require('electron') 返回的是二进制路径字符串
let electron = null;
try { electron = require('electron'); } catch (_) { electron = null; }
const app = (electron && electron.app) || null;
const BrowserWindow = (electron && electron.BrowserWindow) || null;
const nativeImage = (electron && electron.nativeImage) || null;

/** 模型文件名（打包时经 extraResources 放到 resources/models/） */
const MODEL_FILES = {
  detectionPath: 'ch_PP-OCRv4_det_infer.onnx',
  recognitionPath: 'ch_PP-OCRv4_rec_infer.onnx',
  dictionaryPath: 'ppocr_keys_v1.txt',
};

/** 识别置信度下限（0~1 的 mean）。实测正常文本都在 0.9 以上，这里只用来滤掉噪声框。 */
const MIN_MEAN = 0.3;

/**
 * 检测模型不做下采样（`multipleOfBaseSize(image)` 调用时没传 maxSize，
 * 那段缩到 960 的代码是死代码），所以大图是按原尺寸推理的，耗时随像素线性上涨。
 * 超过这个边长就先缩一次，纯粹是延迟保护；正常框选出来的区域远达不到。
 */
const MAX_SIDE = 2400;

let enginePromise = null;
let busy = Promise.resolve();

function log(...a) {
  console.log('[ocr]', ...a);
}

function broadcast(channel, payload) {
  if (!BrowserWindow) return;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

/** 模型目录：优先打包资源（resources/models），其次 node_modules 里包自带的 assets */
function modelDir() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'models'));
  candidates.push(path.join(__dirname, '..', 'node_modules', '@gutenye', 'ocr-models', 'assets'));

  for (const dir of candidates) {
    try {
      if (dir && fs.existsSync(path.join(dir, MODEL_FILES.detectionPath))) return dir;
    } catch (_) { /* ignore */ }
  }
  return null;
}

/**
 * 惰性创建引擎。
 * 注意必须显式传 models 路径：@gutenye/ocr-models 内部用 __dirname 解析，
 * 打进 asar 后 onnxruntime 是原生文件读取，读不到 asar 里的虚拟路径。
 */
async function getEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      /* 先探架构，再谈加载。
       * onnxruntime-node@1.30 的 bin/napi-v6/darwin/ 下只有 arm64 —— Intel Mac 上
       * 直接 import 会抛原生模块加载失败，用户读不出「你的 CPU 架构没有预编译二进制」。
       * 这里提前把它翻译成人话（探测逻辑与 src/platform.js 同一份，避免两处判断漂移）。 */
      const support = platform.localOcrSupport();
      if (!support.ok) throw new Error(`本地 OCR 不可用：${support.detail}`);

      const dir = modelDir();
      if (!dir) {
        throw new Error(`找不到 OCR 模型目录（需要 ${MODEL_FILES.detectionPath} 等文件）`);
      }
      const t0 = Date.now();
      broadcast('ocr:progress', { status: 'loading engine' });

      // 包是 ESM，CommonJS 下只能动态 import
      const { default: Ocr } = await import('@gutenye/ocr-node');
      const models = {};
      for (const [key, file] of Object.entries(MODEL_FILES)) models[key] = path.join(dir, file);

      const engine = await Ocr.create({ models });
      log('引擎就绪（PaddleOCR PP-OCRv4 / ONNX Runtime），耗时', Date.now() - t0, 'ms，模型目录=', dir);
      return engine;
    })().catch((e) => {
      enginePromise = null; // 失败不缓存，下次重试
      throw e;
    });
  }
  return enginePromise;
}

/** Electron 的 toBitmap() 在 Windows 上是 BGRA；ONNX 要 RGBA。macOS 本来就是 RGBA。 */
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

/** 四点多边形 ↖↗↘↙ → 轴对齐包围盒 */
function polyToBBox(box) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const p of box) {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  return { x0, y0, x1, y1 };
}

/* ---------------- 墨迹高度测量 ---------------- */

/**
 * 像素亮度偏离「该行中位亮度」超过它，才算这个像素是墨迹。
 * 80 是扫出来的：40 会把抗锯齿的浅色毛边也算进去（38px 标题多算 2px），
 * 120 以上又会把细笔画的升部（"button." 的 b/t 竖干）整段丢掉。
 */
const INK_DEV = 80;
/** 一行至少这么多墨迹像素才算「有墨迹」，滤掉孤立噪点 */
const INK_MIN = 2;

/**
 * 量一行文字的真实墨迹高度（像素）。
 *
 * 为什么要量像素，而不是直接用 OCR 的框高：
 *   实测 PaddleOCR 的检测框高度和墨迹高度**不成比例** ——
 *   38px 标题框高 37（墨迹 39，框比墨迹还小），19px 正文框高 23（墨迹 20，框大 3px）。
 *   拿框高反推字号，同一张卡片上的误差能到 16%；量像素后同类样本离散度只有 0.5%。
 *
 * 做法：在框上下各放开 0.9 倍框高的窗口里算「行剖面」（每行有多少像素明显偏离该行中位亮度），
 * 按剖面切成一维墨迹带，取与 OCR 框竖直重叠最大的那一条。
 * 相邻行之间是空白行，会自然切成两条带，所以放开窗口不会串行。
 */
function measureInk(data, W, H, box) {
  const xa = Math.max(0, Math.floor(box.x0));
  const xb = Math.min(W - 1, Math.ceil(box.x1));
  if (xb - xa < 2) return 0;
  const bh = box.y1 - box.y0;
  if (bh < 2) return 0;

  const pad = Math.max(2, Math.round(bh * 0.9));
  const ya = Math.max(0, Math.floor(box.y0 - pad));
  const yb = Math.min(H - 1, Math.ceil(box.y1 + pad));

  const n = xb - xa + 1;
  const lum = new Float32Array(n);
  const hist = new Uint32Array(256);
  const prof = [];

  for (let y = ya; y <= yb; y++) {
    hist.fill(0);
    for (let i = 0; i < n; i++) {
      const p = (y * W + xa + i) * 4;
      const v = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      lum[i] = v;
      hist[v | 0]++;
    }
    // 该行中位亮度（走直方图，O(256)，比排序快得多）
    let acc = 0;
    let med = 0;
    const half = n >> 1;
    for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc > half) { med = k; break; } }

    let c = 0;
    for (let i = 0; i < n; i++) if (Math.abs(lum[i] - med) > INK_DEV) c++;
    prof.push({ y, c });
  }

  // 切带：允许的空隙随字号放大。
  // 固定允许 1 行是不够的 —— "joggy puppy jumping" 的 i 点与 x 高度带之间隔了 2 行空白，
  // 会被切成两条带，只取下面那条就丢了 4px（15px 的字量成 12px，字号直接少 25%）。
  // 用框高做尺度（框高虽然推字号不准，但当「大概多大」的尺子够用），
  // 相邻两行之间的空白通常远大于这个值，所以不会串行。
  const gapLimit = Math.max(2, Math.round(bh * 0.12));
  const bands = [];
  let cur = null;
  let gap = 0;
  for (const p of prof) {
    if (p.c >= INK_MIN) {
      if (cur) cur.y1 = p.y; else cur = { y0: p.y, y1: p.y };
      gap = 0;
    } else if (cur) {
      if (++gap > gapLimit) { bands.push(cur); cur = null; gap = 0; }
    }
  }
  if (cur) bands.push(cur);
  if (!bands.length) return 0;

  // 取与 OCR 框竖直重叠最大的那条带 —— 相邻行/按钮边框都会被这条规则排掉
  let best = null;
  let bestOv = -1;
  for (const b of bands) {
    const ov = Math.min(b.y1, box.y1) - Math.max(b.y0, box.y0);
    if (ov > bestOv) { bestOv = ov; best = b; }
  }
  return best ? best.y1 - best.y0 + 1 : 0;
}

/* ---------------- 按列空白再切一刀 ---------------- */

/**
 * 把一条检测线按「列空白」拆成多条。
 *
 * 起因：PP-OCR 的检测会把相邻的两个 UI 元素并成一行 —— 测试卡片里蓝底按钮 "Get Started"
 * 和红底徽标 "NEW" 被识别成一行 "Get Started NEW"。就地替换时一段只能取一个背景色，
 * 画出来就是蓝底上盖着红块（实测 demo-after.png 就是这个样子）。
 *
 * 为什么不在引擎侧修：合并发生在检测连通域 + `unclip_ratio = 1.5` 外扩那一步
 * （@gutenye/ocr-common/src/backend/splitIntoLineImages.ts:108 硬编码，Node 路径没有出口）。
 *
 * 判据：列剖面上出现「宽度 > 0.9 倍框高」的连续空白列才切。
 * 普通空格约 0.3em、三个连续空格约 0.9em，都够不到这个阈值，所以正常文本不会被切开；
 * 而两个相邻 UI 元素之间通常隔着几十像素。
 */
function splitByColumnGap(data, W, H, box) {
  const xa = Math.max(0, Math.floor(box.x0));
  const xb = Math.min(W - 1, Math.ceil(box.x1));
  const ya = Math.max(0, Math.floor(box.y0));
  const yb = Math.min(H - 1, Math.ceil(box.y1));
  const boxH = yb - ya + 1;
  if (xb - xa < 8 || boxH < 4) return null;

  const gapMin = Math.max(8, Math.round(boxH * 0.9));
  const minPiece = Math.max(6, Math.round(boxH * 0.6));
  if (xb - xa <= gapMin + minPiece) return null;

  const n = yb - ya + 1;
  const lum = new Float32Array(n);
  const hist = new Uint32Array(256);
  const blank = [];

  for (let x = xa; x <= xb; x++) {
    hist.fill(0);
    for (let i = 0; i < n; i++) {
      const p = ((ya + i) * W + x) * 4;
      const v = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      lum[i] = v;
      hist[v | 0]++;
    }
    let acc = 0;
    let med = 0;
    const half = n >> 1;
    for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc > half) { med = k; break; } }
    let c = 0;
    for (let i = 0; i < n; i++) if (Math.abs(lum[i] - med) > INK_DEV) c++;
    blank.push(c < INK_MIN);
  }

  // 收集够宽的空白段，并据此切出「有墨迹的列区间」
  const pieces = [];
  let start = 0;
  let run = 0;
  for (let i = 0; i < blank.length; i++) {
    if (blank[i]) { run++; continue; }
    if (run >= gapMin) {
      const end = i - run;
      if (end - start >= minPiece) pieces.push({ x0: xa + start, x1: xa + end - 1 });
      start = i;
    }
    run = 0;
  }
  if (xb - (xa + start) + 1 >= minPiece) pieces.push({ x0: xa + start, x1: xb });

  // 一段都没切出来、或切完只剩一段，就当没切
  if (pieces.length < 2) return null;
  return pieces;
}

/**
 * 按切点把识别出来的整行文本也切开。
 * 空白列的位置按 x 比例映射回字符下标，并优先在附近的空格处落刀。
 */
function splitTextAtGaps(text, x0, boxW, pieces) {
  const n = text.length;
  if (!n || boxW <= 0) return null;
  const out = [];
  let prev = 0;
  for (let i = 1; i < pieces.length; i++) {
    const cx = pieces[i].x0 - 1; // 切点取在空白段结束处
    let idx = Math.round(((cx - x0) / boxW) * n);
    idx = Math.max(prev + 1, Math.min(n - 1, idx));
    // 就近（±3 字符）找空格落刀，找不到就按比例切
    let at = -1;
    for (let d = 0; d <= 3 && at < 0; d++) {
      for (const c of [idx - d, idx + d]) {
        if (c > prev && c < n && /\s/.test(text[c - 1])) { at = c; break; }
      }
    }
    const cut = at > 0 ? at : idx;
    out.push(text.slice(prev, cut).trim());
    prev = cut;
  }
  out.push(text.slice(prev).trim());
  return out;
}

/* ---------------- 文本后处理 ---------------- */

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const CJK_RUN = /([\u2e80-\u9fff\u3000-\u303f\uf900-\ufaff\uff00-\uffef])[ \t]+(?=[\u2e80-\u9fff\u3000-\u303f\uf900-\ufaff\uff00-\uffef])/g;

/** 偶尔会在汉字之间插空格（"待 付款"），还原成 "待付款" */
function normalizeCJK(s) {
  let prev;
  let out = s;
  do {
    prev = out;
    out = out.replace(CJK_RUN, '$1');
  } while (out !== prev);
  return out;
}

/** 行内拼接：中文之间不加空格，拉丁文之间加空格 */
function joinText(parts) {
  let out = '';
  for (const p of parts) {
    if (!out) { out = p; continue; }
    const prev = out[out.length - 1];
    const next = p[0];
    out += (CJK.test(prev) || CJK.test(next)) ? p : ' ' + p;
  }
  return out;
}

function union(a, b) {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

/**
 * 把相邻行并成段落。与引擎无关，沿用原实现：
 *   - 字号差太多（大标题 + 正文）不合并
 *   - 行距过大或负重叠不合并
 *   - 水平投影重叠不足不合并
 */
function groupParagraphs(lines) {
  const sorted = lines.slice().sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  const paras = [];
  for (const l of sorted) {
    const lh = Math.max(1, l.bbox.y1 - l.bbox.y0);
    let target = null;
    for (let i = paras.length - 1; i >= 0; i--) {
      const p = paras[i];
      const last = p.lines[p.lines.length - 1];
      const lastH = Math.max(1, last.bbox.y1 - last.bbox.y0);

      const hRatio = Math.max(lh, lastH) / Math.min(lh, lastH);
      if (hRatio > 1.35) continue;

      const gap = l.bbox.y0 - last.bbox.y1;
      if (gap > Math.min(lh, lastH) * 0.8 || gap < -Math.min(lh, lastH) * 0.5) continue;

      const xOv = Math.min(p.bbox.x1, l.bbox.x1) - Math.max(p.bbox.x0, l.bbox.x0);
      const minW = Math.min(p.bbox.x1 - p.bbox.x0, l.bbox.x1 - l.bbox.x0);
      if (xOv < minW * 0.4) continue;

      target = p;
      break;
    }
    if (target) {
      target.lines.push(l);
      target.bbox = union(target.bbox, l.bbox);
    } else {
      paras.push({ lines: [l], bbox: { ...l.bbox } });
    }
  }
  for (const p of paras) {
    p.text = joinText(p.lines.map((l) => l.text));
    p.confidence = p.lines.reduce((s, l) => s + l.confidence, 0) / p.lines.length;
  }
  return paras.filter((p) => p.text.trim());
}

/* ---------------- 主入口 ---------------- */

async function recognize(dataUrl, { minMean = MIN_MEAN, maxSide = MAX_SIDE } = {}) {
  // 串行化，避免多张截图同时抢引擎
  const run = async () => {
    const engine = await getEngine();

    const baseImg = nativeImage ? nativeImage.createFromDataURL(String(dataUrl)) : null;
    if (!baseImg || baseImg.isEmpty()) throw new Error('无法解析截图数据');
    const size = baseImg.getSize();

    let img = baseImg;
    const longest = Math.max(size.width, size.height);
    if (maxSide && longest > maxSide) {
      const k = maxSide / longest;
      img = baseImg.resize({
        width: Math.max(1, Math.round(size.width * k)),
        height: Math.max(1, Math.round(size.height * k)),
        quality: 'good',
      });
      const s = img.getSize();
      log(`图片过大（${size.width}x${size.height}），先缩到 ${s.width}x${s.height} 再识别`);
    }

    broadcast('ocr:progress', { status: 'recognizing text' });
    const t0 = Date.now();
    // 同一份 RGBA 原始像素既喂引擎、也用来量墨迹，不用解两遍
    const buf = toRGBA(img);
    const res = await engine.detect(buf);
    log(`识别完成：${(res.texts || []).length} 行，耗时 ${Date.now() - t0}ms`);

    // 墨迹是在 buffer 坐标系里量的；只有大图被缩过时 kb < 1，量完要换算回原图
    const kb = size.width ? buf.width / size.width : 1;

    // detect() 返回的 box 在「补齐到 32 倍数后」的空间里，必须按比例还原回原图。
    // 中间那层自己缩放的系数会被 resizedImageWidth 抵消，所以这里直接用原图尺寸比。
    const sx = size.width / res.resizedImageWidth;
    const sy = size.height / res.resizedImageHeight;

    const lines = [];
    const seen = new Set();
    for (const t of res.texts || []) {
      const text = normalizeCJK(String(t.text || '').replace(/\s+/g, ' ').trim());
      if (!text) continue;
      if (typeof t.mean === 'number' && t.mean < minMean) continue;
      if (!Array.isArray(t.box) || t.box.length < 4) continue;

      const b = polyToBBox(t.box);
      const bbox = { x0: b.x0 * sx, y0: b.y0 * sy, x1: b.x1 * sx, y1: b.y1 * sy };
      if (bbox.x1 - bbox.x0 < 2 || bbox.y1 - bbox.y0 < 2) continue;

      const key = `${Math.round(bbox.x0)},${Math.round(bbox.y0)},${Math.round(bbox.x1)},${Math.round(bbox.y1)},${text}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const conf = Math.round((typeof t.mean === 'number' ? t.mean : 0) * 100);
      const k = kb || 1;
      const bufBox = { x0: bbox.x0 * k, y0: bbox.y0 * k, x1: bbox.x1 * k, y1: bbox.y1 * k };

      // 相邻 UI 元素被并成一行时按列空白切开（见 splitByColumnGap）；
      // 切不动就是普通一行，走原路径
      const pieces = splitByColumnGap(buf.data, buf.width, buf.height, bufBox);
      const texts = pieces && splitTextAtGaps(text, bufBox.x0, bufBox.x1 - bufBox.x0, pieces);
      const ok = pieces && texts && texts.length === pieces.length && texts.every((s) => s);
      const parts = ok
        ? pieces.map((p, i) => ({
          text: texts[i],
          bbox: { x0: p.x0 / k, y0: bbox.y0, x1: p.x1 / k, y1: bbox.y1 },
        }))
        : [{ text, bbox }];

      for (const part of parts) {
        // 像素级墨迹高度：字号估计的唯一可信依据（框高不可信，见 measureInk 注释）
        const inkBuf = measureInk(buf.data, buf.width, buf.height, {
          x0: part.bbox.x0 * k, y0: part.bbox.y0 * k,
          x1: part.bbox.x1 * k, y1: part.bbox.y1 * k,
        });
        const inkHeight = inkBuf / k;

        lines.push({
          text: part.text,
          bbox: part.bbox,
          inkHeight,
          confidence: conf,
          // 保留四点框：轴对齐的 bbox 对斜排文字会偏大，将来要按角度画/擦都用得上。
          // 切过的段没有原始四点框，用切出来的矩形代替。
          poly: parts.length === 1
            ? t.box.map(([x, y]) => [x * sx, y * sy])
            : [
              [part.bbox.x0, part.bbox.y0], [part.bbox.x1, part.bbox.y0],
              [part.bbox.x1, part.bbox.y1], [part.bbox.x0, part.bbox.y1],
            ],
        });
      }
    }

    const paragraphs = groupParagraphs(lines);
    return { lines, paragraphs, blocks: [], size, scale: 1 };
  };

  busy = busy.then(run, run);
  return busy;
}

/** 预热：把 ONNX 会话建起来，第一次用不卡 */
async function warmup() {
  try {
    await getEngine();
    return true;
  } catch (e) {
    log('预热失败：', (e && e.message) || e);
    return false;
  }
}

/** 释放引擎（退出前调用） */
async function terminate() {
  const p = enginePromise;
  enginePromise = null;
  try { await p; } catch (_) { /* ignore */ }
  log('引擎已释放');
}

module.exports = {
  recognize, warmup, terminate, groupParagraphs, modelDir, MODEL_FILES,
  measureInk, splitByColumnGap, splitTextAtGaps,
};
