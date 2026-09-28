'use strict';
/**
 * 自检脚本：对一张本地图片跑「OCR → 翻译」，把结果打印出来。
 *
 * 必须用 Electron 跑（不是纯 Node）—— 新引擎用 nativeImage 解码 dataURL 拿 RGBA 像素，
 * 纯 Node 下拿不到 nativeImage。
 *
 * 用法：
 *   node scripts/start.js scripts/selftest.js <图片路径> [目标语言=zh-Hans]
 *   node scripts/start.js scripts/selftest.js <图片路径> --ocr-only
 */
const path = require('path');
const fs = require('fs');
const ocr = require('../src/ocr');
const translate = require('../src/translate');

const toDataUrl = (p) => {
  const ext = path.extname(p).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
};

(async () => {
  const file = process.argv[2];
  const ocrOnly = process.argv.includes('--ocr-only');
  const target = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'zh-Hans';

  if (!file) {
    console.error('用法: node scripts/start.js scripts/selftest.js <图片路径> [目标语言] [--ocr-only]');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error('文件不存在:', file);
    process.exit(1);
  }

  console.log('模型目录:', ocr.modelDir() || '(未找到)');
  const t0 = Date.now();
  const { lines, paragraphs } = await ocr.recognize(toDataUrl(file));
  console.log(`\n=== OCR 完成（${Date.now() - t0} ms）共 ${lines.length} 行 / ${paragraphs.length} 段 ===`);
  for (const p of paragraphs) {
    const b = p.bbox;
    const conf = typeof p.confidence === 'number' ? p.confidence.toFixed(0) : '?';
    console.log(`  [conf ${conf}] [${b.x0},${b.y0} - ${b.x1},${b.y1}]  "${p.text}"`);
  }
  if (ocrOnly) { await done(); return; }

  if (!paragraphs.length) { console.log('\n没有识别到文字，跳过翻译'); await done(); return; }

  const t1 = Date.now();
  const res = await translate.translate(paragraphs.map((p) => p.text), {
    from: 'auto', to: target, engine: 'free', freeProvider: 'auto',
  });
  console.log(`\n=== 翻译完成（${Date.now() - t1} ms）引擎 ${res.provider} ===`);
  paragraphs.forEach((p, i) => {
    console.log(`  原文: ${p.text}`);
    console.log(`  译文: ${res.texts[i]}`);
    console.log('');
  });
  await done();
})().catch(async (e) => {
  console.error('\n自检失败：', e && e.message ? e.message : e);
  if (e && e.details) console.error('详情：', e.details.join(' | '));
  await done();
  process.exitCode = 1;
});

// 收尾：释放 ONNX 会话
async function done() {
  await ocr.terminate().catch(() => {});
  process.exit(process.exitCode || 0);
}
