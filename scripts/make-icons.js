'use strict';
/**
 * 纯 Node 生成应用图标（不依赖任何图形库）。
 *
 * 产出：
 *   assets/tray.png            32   —— Windows/Linux 托盘（彩色）
 *   assets/app.png             256  —— 运行时的窗口图标（Windows/Linux）
 *   assets/app.ico             多尺寸 —— Windows 应用图标
 *   assets/trayTemplate.png    16   —— macOS 菜单栏（纯黑 + alpha，系统自动反色）
 *   assets/trayTemplate@2x.png 32   —— 上面那个的 Retina 版，Electron 按文件名自动配对
 *   assets/icon.icns           多尺寸 —— macOS 应用图标（含 1024）
 *   assets/icon-1024.png       1024 —— 备用（Linux / electron-builder 兜底）
 *
 * 图形：微信绿圆角方块 + 白色取景框角标 + 白色字母 A（翻译意象）
 * macOS 版额外留出 9.5% 的透明外边距 —— 这是 macOS 图标栅格的要求，
 * 不留的话图标在 Dock 里会比别的应用大一圈。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'assets');

/* ---------------- PNG 编码 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** rgba: Uint8Array(w*h*4) -> PNG Buffer */
function encodePNG(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 简易光栅绘制 ---------------- */
function makeCanvas(w, h) {
  return { w, h, px: new Uint8Array(w * h * 4) };
}

function blend(c, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h || a <= 0) return;
  const i = (y * c.w + x) * 4;
  const sa = a / 255;
  const da = c.px[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  c.px[i] = Math.round((r * sa + c.px[i] * da * (1 - sa)) / oa);
  c.px[i + 1] = Math.round((g * sa + c.px[i + 1] * da * (1 - sa)) / oa);
  c.px[i + 2] = Math.round((b * sa + c.px[i + 2] * da * (1 - sa)) / oa);
  c.px[i + 3] = Math.round(oa * 255);
}

/** 覆盖率抗锯齿：在 (x,y) 处按到图形的距离给 alpha */
function fillSuper(c, x, y, r, g, b, cov) {
  blend(c, x, y, r, g, b, Math.max(0, Math.min(1, cov)) * 255);
}

function roundRect(c, x0, y0, x1, y1, radius, color) {
  const [r, g, b] = color;
  for (let y = Math.floor(y0) - 1; y <= Math.ceil(y1) + 1; y++) {
    for (let x = Math.floor(x0) - 1; x <= Math.ceil(x1) + 1; x++) {
      const dx = Math.max(x0 + radius - x, 0, x - (x1 - radius));
      const dy = Math.max(y0 + radius - y, 0, y - (y1 - radius));
      const dist = Math.hypot(dx, dy);
      const cov = radius - dist + 0.5;
      if (cov > 0) fillSuper(c, x, y, r, g, b, cov);
    }
  }
}

/** 圆头粗线段 */
function thickLine(c, x0, y0, x1, y1, width, color) {
  const [r, g, b] = color;
  const half = width / 2;
  const minX = Math.floor(Math.min(x0, x1) - half - 1);
  const maxX = Math.ceil(Math.max(x0, x1) + half + 1);
  const minY = Math.floor(Math.min(y0, y1) - half - 1);
  const maxY = Math.ceil(Math.max(y0, y1) + half + 1);
  const vx = x1 - x0, vy = y1 - y0;
  const len2 = vx * vx + vy * vy || 1;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let t = ((x - x0) * vx + (y - y0) * vy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = x0 + t * vx, py = y0 + t * vy;
      const cov = half - Math.hypot(x - px, y - py) + 0.5;
      if (cov > 0) fillSuper(c, x, y, r, g, b, cov);
    }
  }
}

/* ---------------- 图标构图 ---------------- */

/**
 * 应用图标。
 *
 * @param size   输出边长
 * @param margin 透明外边距占比（0 = 铺满画布，Windows/Linux 用；0.095 = macOS 栅格）
 *
 * 所有几何都按 256 的坐标系写，用 k 缩放。margin 用**整数像素**内缩
 * （而不是 size*margin 这种小数）—— blend() 是按整数像素索引写数组的，
 * 坐标一旦带小数就会写出 undefined 下标，图形直接消失。
 * 取整也顺带保证左右上下完全对称（小数会让对称图形差 1px）。
 */
function drawIcon(size, margin = 0) {
  const c = makeCanvas(size, size);
  const inset = margin > 0 ? Math.max(1, Math.round(size * margin)) : 0;
  const inner = size - inset * 2;
  const k = inner / 256; // 归一化比例
  const off = inset;

  // 背景：绿色圆角方块（微信绿 -> 深一点的绿，竖向渐变）
  const pad = 6 * k;
  for (let iy = 0; iy < inner; iy++) {
    const t = iy / inner;
    const r = Math.round(7 + (5 - 7) * t);
    const g = Math.round(193 + (150 - 193) * t);
    const b = Math.round(96 + (70 - 96) * t);
    for (let ix = 0; ix < inner; ix++) {
      const dx = Math.max(pad + 52 * k - ix, 0, ix - (inner - pad - 52 * k));
      const dy = Math.max(pad + 52 * k - iy, 0, iy - (inner - pad - 52 * k));
      const cov = 52 * k - Math.hypot(dx, dy) + 0.5;
      if (cov > 0) fillSuper(c, off + ix, off + iy, r, g, b, cov);
    }
  }

  const W = [255, 255, 255];

  // 取景框四角
  const m = 52 * k;        // 边距
  const arm = 46 * k;      // 角标长度
  const lw = 13 * k;       // 线宽
  const corners = [
    [m, m, 1, 1],
    [inner - m, m, -1, 1],
    [m, inner - m, 1, -1],
    [inner - m, inner - m, -1, -1],
  ];
  for (const [cx, cy, sx, sy] of corners) {
    thickLine(c, off + cx, off + cy, off + cx + sx * arm, off + cy, lw, W);
    thickLine(c, off + cx, off + cy, off + cx, off + cy + sy * arm, lw, W);
  }

  // 中间字母 A
  const ax0 = 96 * k, ax1 = 160 * k;
  const ay0 = 92 * k, ay1 = 168 * k;
  const apex = [(ax0 + ax1) / 2, ay0];
  thickLine(c, off + apex[0], off + apex[1], off + ax0, off + ay1, 15 * k, W);
  thickLine(c, off + apex[0], off + apex[1], off + ax1, off + ay1, 15 * k, W);
  const by = ay0 + (ay1 - ay0) * 0.66;
  const bx0 = ax0 + (ax1 - ax0) * 0.24;
  const bx1 = ax0 + (ax1 - ax0) * 0.76;
  thickLine(c, off + bx0, off + by, off + bx1, off + by, 13 * k, W);

  return c;
}

/**
 * macOS 菜单栏图标。
 *
 * 与 drawIcon 的区别（三条都是 macOS 菜单栏的硬性要求）：
 *   1. 纯黑 + alpha，**不能有颜色** —— 系统按 template image 处理时会拿 alpha 当蒙版，
 *      自己反色成黑/白，彩色像素会被压成一块脏斑。
 *   2. 不要背景方块 —— 菜单栏图标就是一条细图形，带底色会显得又重又脏。
 *   3. 笔画要够粗：16pt 下 1px 的线在非 Retina 屏上会直接消失。
 */
function drawTrayGlyph(size) {
  const c = makeCanvas(size, size);
  const k = size / 16;          // 按 16 的坐标系设计
  const K = [0, 0, 0];          // 纯黑

  // 取景框四角
  const m = 1.2 * k;
  const arm = 3.3 * k;
  const lw = 1.3 * k;
  const inner = size - m;
  const corners = [
    [m, m, 1, 1],
    [inner, m, -1, 1],
    [m, inner, 1, -1],
    [inner, inner, -1, -1],
  ];
  for (const [cx, cy, sx, sy] of corners) {
    thickLine(c, cx, cy, cx + sx * arm, cy, lw, K);
    thickLine(c, cx, cy, cx, cy + sy * arm, lw, K);
  }

  // 中间字母 A
  // 横杠放在 0.56 而不是常见的 0.66 —— 16pt 下横杠越靠下、和两条腿围出的三角就越小，
  // 整个字会糊成一个实心三角。抬高一点「A」的骨架才看得出来。
  const apexX = 8 * k, apexY = 5.5 * k;
  const baseY = 11.6 * k;
  const leftX = 5.5 * k, rightX = 10.5 * k;
  thickLine(c, apexX, apexY, leftX, baseY, 1.6 * k, K);
  thickLine(c, apexX, apexY, rightX, baseY, 1.6 * k, K);
  const barY = apexY + (baseY - apexY) * 0.56;
  thickLine(c, 6.5 * k, barY, 9.5 * k, barY, 1.4 * k, K);

  return c;
}

/* ---------------- ICO 封装 ---------------- */

/** Windows .ico：6 字节头 + 每张图 16 字节目录项 + 各图 PNG 数据 */
function buildICO(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const entries = [];
  let offset = 6 + count * 16;
  for (const p of pngs) {
    const e = Buffer.alloc(16);
    // 宽高字段是 1 字节，256 用 0 表示
    e[0] = p.size >= 256 ? 0 : p.size;
    e[1] = p.size >= 256 ? 0 : p.size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);   // 色彩平面
    e.writeUInt16LE(32, 6);  // 位深
    e.writeUInt32LE(p.data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += p.data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

/* ---------------- ICNS 封装 ---------------- */

/**
 * macOS .icns 容器：8 字节文件头（'icns' + 总长）+ 若干 chunk（4 字节类型 + 4 字节长度 + 数据）。
 * 长度字段**包含自己的 8 字节头**，不是纯数据长度 —— 写错了 macOS 会直接不认这个图标。
 *
 * 全部用 PNG 型 chunk（macOS 10.7+ 支持），不必再去实现老的 ARGB/JPEG2000 编码。
 * 类型与像素尺寸的对应关系容易记混，这里按实际像素尺寸列：
 *   icp4=16  icp5=32  icp6=64  ic07=128  ic08=256  ic09=512  ic10=1024
 *   ic11=32(16@2x)  ic12=64(32@2x)  ic13=256(128@2x)  ic14=512(256@2x)
 * 同一个像素尺寸被两个类型引用是正常的（不同 DPI 槽位共用一张图）。
 */
function buildICNS(pngBySize) {
  const layout = [
    ['icp4', 16],
    ['ic11', 32], ['icp5', 32],
    ['ic12', 64], ['icp6', 64],
    ['ic07', 128],
    ['ic13', 256], ['ic08', 256],
    ['ic14', 512], ['ic09', 512],
    ['ic10', 1024],
  ];
  const chunks = [];
  for (const [type, size] of layout) {
    const data = pngBySize[size];
    if (!data) throw new Error(`缺少 ${size}x${size} 的 PNG，无法生成 icns`);
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    chunks.push(head, data);
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/* ---------------- main ---------------- */

/** macOS 图标栅格的透明外边距占比（实测：0.095 在 Dock 里和系统应用大小一致） */
const MAC_MARGIN = 0.095;
const MAC_SIZES = [16, 32, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function pngOf(size, margin) {
  const c = drawIcon(size, margin || 0);
  return encodePNG(c.px, c.w, c.h);
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const write = (name, buf) => {
    fs.writeFileSync(path.join(OUT, name), buf);
    console.log(`wrote ${name.padEnd(22)} ${String(buf.length).padStart(8)} bytes`);
  };

  /* --- Windows / Linux --- */
  write('tray.png', pngOf(32));
  write('app.png', pngOf(256));
  write('app.ico', buildICO(ICO_SIZES.map((size) => ({ size, data: pngOf(size) }))));

  /* --- macOS 菜单栏（template image：纯黑 + alpha） --- */
  write('trayTemplate.png', encodePNG(drawTrayGlyph(16).px, 16, 16));
  write('trayTemplate@2x.png', encodePNG(drawTrayGlyph(32).px, 32, 32));

  /* --- macOS 应用图标 --- */
  const macPng = {};
  for (const size of MAC_SIZES) macPng[size] = pngOf(size, MAC_MARGIN);
  write('icon.icns', buildICNS(macPng));
  write('icon-1024.png', macPng[1024]);
}

if (require.main === module) main();

module.exports = {
  drawIcon, drawTrayGlyph, encodePNG, buildICO, buildICNS,
  makeCanvas, blend, fillSuper, roundRect, thickLine,
  MAC_MARGIN, MAC_SIZES, ICO_SIZES, OUT,
};
