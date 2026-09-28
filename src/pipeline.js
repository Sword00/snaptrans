'use strict';
/**
 * OCR + 翻译 的串联
 */
const ocr = require('./ocr');
const translate = require('./translate');

const CJK_CH = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

/**
 * 字形类别 → 「墨迹高度占 em 的比例」。
 *
 * 在 Microsoft YaHei 上实测标定（每类 6 个样本，12~38px，用 ocr.measureInk 同一套判据量的）：
 *   cjk  0.94（12~38px 明细 0.917/0.867/0.947/0.958/0.969/0.974，字号越大越接近 0.97）
 *   desc 1.056（标准差 0.010）—— 升部顶到降部底，YaHei 的拉丁升部偏高
 *   asc  0.752（标准差 0.016）
 *   xh   0.544（标准差 0.016）
 * 取整到两位：cjk 0.95 / desc 1.05 / asc 0.75 / xh 0.55。
 */
const INK_RATIO = { cjk: 0.95, desc: 1.05, asc: 0.75, xh: 0.55 };

/**
 * 按字形内容判类别：决定「墨迹高度」对应几个 em。
 *
 * 两条踩过的坑：
 * 1. 升部字母是 `bdfhklt`，**不含 c/e**（它们跟 x 一样高）。曾经写成 `[A-Zb-df-hklt0-9]`，
 *    把 c 也算进来了，于是纯 x 高度的 "we assume success" 被判成 asc，20px 估成 15px。
 * 2. **词首的大写不可信** —— PP-OCR 会把行首小写字母"纠正"成大写：
 *    实际渲染的是小写 "we assume success"，OCR 给出 "We assume success"。
 *    所以只在「整行没有小写字母」（真·全大写，如 "SAVE CHANGES"、"OK"）时才拿大写字母当墨迹顶部；
 *    有大写小写混排时只认小写升部字母。
 *
 * i 要算进升部：它的点跟升部差不多高（实测 "joggy puppy jumping" 的点顶在基线上方 0.8em）。
 */
function classifyInk(t) {
  const s = String(t || '');
  const visible = s.replace(/\s/g, '').length || 1;
  const cjkCount = (s.match(CJK_CH) || []).length;
  if (cjkCount / visible > 0.4) return 'cjk';
  if (/[gjpqy]/.test(s)) return 'desc';
  const ascenders = /[a-z]/.test(s) ? /[bdfhklti]/ : /[A-Zbdfhklti0-9]/;
  if (ascenders.test(s)) return 'asc';
  return 'xh';
}

/**
 * 由「实测墨迹高度」+ 字形类别推算原文字号。
 *
 * 为什么不用 OCR 框高（上一版的做法，已废弃）：
 *   PP-OCR 的检测框相对墨迹的外扩量**不稳定**，同一张卡片上
 *   38px 标题框高 37（比墨迹 39 还小），19px 正文框高 23（比墨迹 20 大 3px）。
 *   拿框高乘系数推字号，实测误差 38→36、19→22、24→25（最差 +16%）。
 *   改用像素级墨迹后，同一张卡片 38/19/24/24 全部命中。
 *
 * 为什么取「段落内最高那一行」：
 *   段落 bbox 高度会把行距算进去（2 行正文算出 34px，实际 19px）；
 *   而段落里最高的一行最能反映 em 尺寸（其他行可能只有 x 高度）。
 */
function estimateFontSize(lines, text) {
  const arr = lines || [];
  const inks = arr.map((l) => l.inkHeight).filter((h) => h > 0);
  // 兜底：拿不到墨迹（老缓存 / 量失败）时退回框高，框高比墨迹略大，按 0.9 折一下
  const ink = inks.length
    ? Math.max(...inks)
    : Math.max(0, ...arr.map((l) => (l.bbox.y1 - l.bbox.y0) * 0.9));
  if (!ink) return 14;

  return Math.max(8, Math.round(ink / INK_RATIO[classifyInk(text)]));
}

/**
 * 推断对齐方式。
 *   - 多行：各行中心基本对齐 → 居中；参差不齐 → 左对齐。
 *   - 单行：默认左对齐（保留原始 x0 最稳）；只有当它的左边距明显偏离全图多数段落的
 *     左边距、且自身中心接近画面中心时，才判为居中。
 */
function detectAlign(para, allParas, imgW) {
  const lines = para.lines || [];
  if (lines.length >= 2) {
    const ws = lines.map((l) => l.bbox.x1 - l.bbox.x0);
    const maxW = Math.max(...ws);
    const minW = Math.min(...ws);
    // 各行宽度接近时无法区分「居中」和「等宽左对齐」，取更安全的左对齐
    if (maxW - minW < maxW * 0.12) return 'left';
    const cs = lines.map((l) => (l.bbox.x0 + l.bbox.x1) / 2);
    const spread = Math.max(...cs) - Math.min(...cs);
    return spread <= maxW * 0.06 ? 'center' : 'left';
  }
  if (!imgW) return 'left';

  // 全图多数段落的左边距（按 6px 分桶取众数）= 版心的左边界
  const buckets = new Map();
  for (const p of allParas) {
    const k = Math.round(p.bbox.x0 / 6) * 6;
    buckets.set(k, (buckets.get(k) || 0) + 1);
  }
  let modal = para.bbox.x0;
  let best = -1;
  for (const [k, n] of buckets) if (n > best) { best = n; modal = k; }

  const x0 = para.bbox.x0;
  if (Math.abs(x0 - modal) <= 8) return 'left';

  const center = (para.bbox.x0 + para.bbox.x1) / 2;
  return Math.abs(center - imgW / 2) <= imgW * 0.08 ? 'center' : 'left';
}

async function recognizeAndTranslate(dataUrl, opts = {}) {
  const {
    sourceLang = 'auto',
    targetLang = 'zh-Hans',
    translateEngine = 'free',
    freeProvider = 'auto',
    llm = {},
  } = opts;

  const { lines, paragraphs, size } = await ocr.recognize(dataUrl);
  if (!paragraphs.length) {
    return { lines: [], paragraphs: [], provider: null, empty: true, size };
  }

  const res = await translate.translate(paragraphs.map((p) => p.text), {
    from: sourceLang,
    to: targetLang,
    engine: translateEngine,
    freeProvider,
    llm,
  });

  const imgW = size && size.width ? size.width : 0;

  return {
    provider: res.provider,
    empty: false,
    size,
    lines,
    paragraphs: paragraphs.map((p, i) => ({
      bbox: p.bbox,
      text: p.text,
      translation: res.texts[i],
      lineCount: p.lines.length,
      confidence: p.confidence,
      fontSize: estimateFontSize(p.lines, p.text),
      align: detectAlign(p, paragraphs, imgW),
    })),
  };
}

async function recognizeOnly(dataUrl) {
  const { lines, paragraphs, size } = await ocr.recognize(dataUrl);
  return { lines, paragraphs, size };
}

module.exports = {
  recognizeAndTranslate, recognizeOnly, estimateFontSize, detectAlign,
  classifyInk, INK_RATIO,
};
