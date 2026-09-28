'use strict';
/**
 * 纯 Node 生成应用图标（不依赖任何图形库）。
 * 产出：assets/tray.png (32)  assets/app.png (256)  assets/app.ico (多尺寸)
 *
 * 图形：微信绿圆角方块 + 白色取景框角标 + 白色字母 A（翻译意象）
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
function drawIcon(size) {
  const c = makeCanvas(size, size);
  const S = size;
  const k = S / 256; // 归一化比例

  // 背景：绿色圆角方块（微信绿 -> 深一点的绿，竖向渐变）
  const pad = 6 * k;
  for (let y = 0; y < S; y++) {
    const t = y / S;
    const r = Math.round(7 + (5 - 7) * t);
    const g = Math.round(193 + (150 - 193) * t);
    const b = Math.round(96 + (70 - 96) * t);
    for (let x = 0; x < S; x++) {
      const dx = Math.max(pad + 52 * k - x, 0, x - (S - pad - 52 * k));
      const dy = Math.max(pad + 52 * k - y, 0, y - (S - pad - 52 * k));
      const cov = 52 * k - Math.hypot(dx, dy) + 0.5;
      if (cov > 0) fillSuper(c, x, y, r, g, b, cov);
    }
  }

  const W = [255, 255, 255];

  // 取景框四角
  const m = 52 * k;        // 边距
  const arm = 46 * k;      // 角标长度
  const lw = 13 * k;       // 线宽
  const corners = [
    [m, m, 1, 1],
    [S - m, m, -1, 1],
    [m, S - m, 1, -1],
    [S - m, S - m, -1, -1],
  ];
  for (const [cx, cy, sx, sy] of corners) {
    thickLine(c, cx, cy, cx + sx * arm, cy, lw, W);
    thickLine(c, cx, cy, cx, cy + sy * arm, lw, W);
  }

  // 中间字母 A
  const ax0 = 96 * k, ax1 = 160 * k;
  const ay0 = 92 * k, ay1 = 168 * k;
  const apex = [(ax0 + ax1) / 2, ay0];
  thickLine(c, apex[0], apex[1], ax0, ay1, 15 * k, W);
  thickLine(c, apex[0], apex[1], ax1, ay1, 15 * k, W);
  const by = ay0 + (ay1 - ay0) * 0.66;
  const bx0 = ax0 + (ax1 - ax0) * 0.24;
  const bx1 = ax0 + (ax1 - ax0) * 0.76;
  thickLine(c, bx0, by, bx1, by, 13 * k, W);

  return c;
}

/* ---------------- ICO 封装 ---------------- */
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
    e[0] = p.size >= 256 ? 0 : p.size;
    e[1] = p.size >= 256 ? 0 : p.size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(p.data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += p.data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

/* ---------------- main ---------------- */
fs.mkdirSync(OUT, { recursive: true });

for (const size of [32, 256]) {
  const c = drawIcon(size);
  const png = encodePNG(c.px, c.w, c.h);
  const name = size === 32 ? 'tray.png' : 'app.png';
  fs.writeFileSync(path.join(OUT, name), png);
  console.log('wrote', name, png.length, 'bytes');
}

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = icoSizes.map((size) => ({ size, data: encodePNG(drawIcon(size).px, size, size) }));
fs.writeFileSync(path.join(OUT, 'app.ico'), buildICO(pngs));
console.log('wrote app.ico');
