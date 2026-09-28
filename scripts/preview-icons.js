'use strict';
/**
 * 图标预览（开发用，产物落在 demo/_icons-preview.png，已被 .gitignore 忽略）
 *
 *   npm run icons:preview
 *
 * 为什么需要它：图标是「纯代码画出来的」，改一行坐标就得重新确认长什么样。
 * 在 Mac 上装一遍再看菜单栏成本太高，这里直接在本地把成品放大贴到
 * 模拟的菜单栏背景上 —— 浅色栏看黑白 alpha 效果，深色栏看系统反色后的效果。
 * 16pt 的菜单栏图标尤其需要放大看，不然肉眼根本分辨不出糊没糊。
 */
const fs = require('fs');
const path = require('path');

const icons = require('./make-icons');
const { makeCanvas, blend, encodePNG, drawIcon, drawTrayGlyph, MAC_MARGIN } = icons;

const ROOT = path.join(__dirname, '..');

/** 把一张图按 zoom 倍放大贴到画布上；color 为 null 时用原色，否则压成单色 */
function blit(dst, src, dx, dy, zoom, color) {
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      const p = (y * src.w + x) * 4;
      const a = src.px[p + 3];
      if (!a) continue;
      const c = color || [src.px[p], src.px[p + 1], src.px[p + 2]];
      for (let j = 0; j < zoom; j++) {
        for (let i = 0; i < zoom; i++) {
          blend(dst, dx + x * zoom + i, dy + y * zoom + j, c[0], c[1], c[2], a);
        }
      }
    }
  }
}

function fill(dst, x0, y0, x1, y1, rgb) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) blend(dst, x, y, rgb[0], rgb[1], rgb[2], 255);
  }
}

/* ---------------- 版面 ---------------- */
const ZOOM_TRAY = 12;      // 16px × 12 = 192
const ICON = 192;          // 应用图标预览边长
const PAD = 16;
const CELL = 192;

const W = PAD + CELL * 2 + PAD;
const H = PAD + CELL * 2 + PAD;

const canvas = makeCanvas(W, H);
fill(canvas, 0, 0, W, H, [128, 128, 128]); // 中性底，方便看出透明区

// 左上：16pt 菜单栏图标 —— 浅色菜单栏（template image 在浅色栏上就是黑的）
fill(canvas, PAD, PAD, PAD + CELL, PAD + CELL, [242, 242, 242]);
blit(canvas, drawTrayGlyph(16), PAD + (CELL - 16 * ZOOM_TRAY) / 2, PAD + (CELL - 16 * ZOOM_TRAY) / 2, ZOOM_TRAY, [0, 0, 0]);

// 右上：32pt（Retina）菜单栏图标 —— 深色菜单栏（系统把 template image 反成白色）
fill(canvas, PAD + CELL, PAD, PAD + CELL * 2, PAD + CELL, [43, 43, 43]);
blit(canvas, drawTrayGlyph(32), PAD + CELL + (CELL - 32 * (ZOOM_TRAY / 2)) / 2, PAD + (CELL - 32 * (ZOOM_TRAY / 2)) / 2, ZOOM_TRAY / 2, [255, 255, 255]);

// 左下：macOS 应用图标（带 9.5% 透明外边距）
fill(canvas, PAD, PAD + CELL, PAD + CELL, PAD + CELL * 2, [236, 236, 236]);
{
  const icon = drawIcon(ICON, MAC_MARGIN);
  blit(canvas, icon, PAD, PAD + CELL, 1, null);
}

// 右下：Windows 应用图标（铺满画布，无外边距）
fill(canvas, PAD + CELL, PAD + CELL, PAD + CELL * 2, PAD + CELL * 2, [236, 236, 236]);
{
  const icon = drawIcon(ICON, 0);
  blit(canvas, icon, PAD + CELL, PAD + CELL, 1, null);
}

const outDir = path.join(ROOT, 'demo');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, '_icons-preview.png');
fs.writeFileSync(outPath, encodePNG(canvas.px, canvas.w, canvas.h));
console.log(`wrote ${path.relative(ROOT, outPath)}  ${canvas.w}x${canvas.h}`);
console.log('  左上 = macOS 菜单栏 16pt（浅色栏）  右上 = 32pt Retina（深色栏，模拟系统反色）');
console.log('  左下 = macOS 应用图标（留 9.5% 外边距）  右下 = Windows 应用图标（铺满）');
