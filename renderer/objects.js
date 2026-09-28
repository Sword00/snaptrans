/* 绘图对象模型：绘制 / 命中测试 / 缩放 / 译文排版 / 背景取色 */
(function () {
  'use strict';

  const F_LATIN = '"Segoe UI","Helvetica Neue",Arial,sans-serif';
  const F_MIX = '"Microsoft YaHei","PingFang SC","Segoe UI",Arial,sans-serif';
  const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

  const pickFamily = (t) => (CJK_RE.test(String(t || '')) ? F_MIX : F_LATIN);

  // 离屏测量画布：bboxOf 需要在不依赖外部 ctx 的情况下量文字宽高
  const _measure = document.createElement('canvas').getContext('2d');
  const fontStr = (size, family, bold) => `${bold ? '700 ' : ''}${size}px ${family || F_MIX}`;
  function measureWidth(text, size, family, bold) {
    _measure.font = fontStr(size, family, bold);
    return _measure.measureText(String(text)).width;
  }

  /* ---------------- 基础几何 ---------------- */
  function bboxOf(o) {
    switch (o.type) {
      case 'arrow':
        return { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), x1: Math.max(o.x1, o.x2), y1: Math.max(o.y1, o.y2) };
      case 'text': {
        const lines = String(o.text || '').split('\n');
        const lh = o.size * 1.25;
        let w = 0;
        for (const l of lines) w = Math.max(w, measureWidth(l, o.size, o.family));
        return { x: o.x, y: o.y, x1: o.x + Math.max(w, o.size), y1: o.y + Math.max(lh, lines.length * lh) };
      }
      case 'pen': {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of o.points) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
        if (!isFinite(x0)) return { x: 0, y: 0, x1: 0, y1: 0 };
        return { x: x0, y: y0, x1, y1 };
      }
      case 'emoji':
        return { x: o.x, y: o.y, x1: o.x + o.size, y1: o.y + o.size };
      default:
        return { x: o.x, y: o.y, x1: o.x + o.w, y1: o.y + o.h };
    }
  }

  function translateObj(o, dx, dy) {
    if (o.type === 'arrow') { o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy; }
    else if (o.type === 'pen') { for (const p of o.points) { p.x += dx; p.y += dy; } }
    else { o.x += dx; o.y += dy; }
  }

  function cloneObj(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------------- 绘制 ---------------- */
  function draw(ctx, o, dpr) {
    ctx.save();
    switch (o.type) {
      case 'rect': {
        ctx.strokeStyle = o.color;
        ctx.lineWidth = o.size;
        if (o.fill) { ctx.fillStyle = o.color; ctx.fillRect(o.x, o.y, o.w, o.h); }
        else ctx.strokeRect(o.x, o.y, o.w, o.h);
        break;
      }
      case 'ellipse': {
        ctx.strokeStyle = o.color;
        ctx.lineWidth = o.size;
        ctx.beginPath();
        ctx.ellipse(o.x + o.w / 2, o.y + o.h / 2, Math.abs(o.w / 2), Math.abs(o.h / 2), 0, 0, Math.PI * 2);
        if (o.fill) { ctx.fillStyle = o.color; ctx.fill(); } else ctx.stroke();
        break;
      }
      case 'arrow': drawArrow(ctx, o); break;
      case 'pen': drawPen(ctx, o); break;
      case 'mosaic': drawMosaic(ctx, o, dpr); break;
      case 'text': drawText(ctx, o); break;
      case 'emoji': drawEmoji(ctx, o); break;
      case 'trans': drawTrans(ctx, o, dpr); break;
      default: break;
    }
    ctx.restore();
  }

  function drawArrow(ctx, o) {
    const { x1, y1, x2, y2, color, size } = o;
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const head = Math.max(size * 3.6, 11);
    const shaftEndX = x2 - Math.cos(ang) * head * 0.92;
    const shaftEndY = y2 - Math.sin(ang) * head * 0.92;

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = size;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(shaftEndX, shaftEndY);
    ctx.stroke();

    const w = head * 0.44;
    const px = Math.cos(ang + Math.PI / 2);
    const py = Math.sin(ang + Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - Math.cos(ang) * head + px * w, y2 - Math.sin(ang) * head + py * w);
    ctx.lineTo(x2 - Math.cos(ang) * head - px * w, y2 - Math.sin(ang) * head - py * w);
    ctx.closePath();
    ctx.fill();
  }

  function drawPen(ctx, o) {
    const pts = o.points;
    if (!pts || pts.length < 2) {
      if (pts && pts.length === 1) {
        ctx.fillStyle = o.color;
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, o.size / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    ctx.strokeStyle = o.color;
    ctx.lineWidth = o.size;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();
  }

  function drawMosaic(ctx, o, dpr) {
    const x = Math.round(o.x);
    const y = Math.round(o.y);
    const w = Math.round(o.w);
    const h = Math.round(o.h);
    if (w < 2 || h < 2) return;
    const block = Math.max(3, Math.round((o.block || 9) * (dpr || 1)));
    const tw = Math.max(1, Math.round(w / block));
    const th = Math.max(1, Math.round(h / block));

    const region = document.createElement('canvas');
    region.width = w;
    region.height = h;
    region.getContext('2d').drawImage(ctx.canvas, x, y, w, h, 0, 0, w, h);

    const small = document.createElement('canvas');
    small.width = tw;
    small.height = th;
    const sctx = small.getContext('2d');
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(region, 0, 0, w, h, 0, 0, tw, th);

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, tw, th, x, y, w, h);
    ctx.restore();
  }

  function drawText(ctx, o) {
    const size = o.size;
    const lh = size * 1.25;
    ctx.fillStyle = o.color;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.font = `${size}px ${o.family || F_MIX}`;
    const lines = String(o.text).split('\n');
    lines.forEach((ln, i) => ctx.fillText(ln, o.x, o.y + i * lh));
  }

  function drawEmoji(ctx, o) {
    ctx.font = `${o.size}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(o.char, o.x, o.y);
  }

  function drawTrans(ctx, o, dpr) {
    // 1. 用采样到的背景色覆盖原文
    ctx.fillStyle = o.bg;
    ctx.fillRect(o.x, o.y, o.w, o.h);

    // 2. 译文自适应排版
    const family = pickFamily(o.text);
    const align = o.align || 'center';
    const bold = !!o.bold;
    const fit = fitText(ctx, o.text, o.w, o.h, family, o.fontSize, o.maxLines || 6, dpr, bold);
    ctx.fillStyle = o.fg;
    ctx.font = fontStr(fit.fontSize, family, bold);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    const lh = fit.fontSize * 1.16;
    const total = fit.lines.length * lh;
    let y = o.y + (o.h - total) / 2 + lh / 2;
    for (const ln of fit.lines) {
      const tw = ctx.measureText(ln).width;
      const x = align === 'center' ? o.x + Math.max(1, (o.w - tw) / 2) : o.x + 2;
      ctx.fillText(ln, x, y);
      y += lh;
    }
  }

  /* ---------------- 文本排版 ---------------- */
  function tokenize(s) {
    const out = [];
    const re = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]|[^\s\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]+|\s+/g;
    let m;
    while ((m = re.exec(s))) out.push(m[0]);
    return out;
  }

  function wrapText(ctx, text, maxW) {
    const out = [];
    for (const raw of String(text).split('\n')) {
      if (!raw) { out.push(''); continue; }
      if (ctx.measureText(raw).width <= maxW) { out.push(raw); continue; }
      const tokens = tokenize(raw);
      let line = '';
      for (const tk of tokens) {
        const test = line + tk;
        if (line && ctx.measureText(test).width > maxW) {
          out.push(line.replace(/\s+$/, ''));
          line = /^\s+$/.test(tk) ? '' : tk.replace(/^\s+/, '');
        } else {
          line = test;
        }
      }
      if (line.trim()) out.push(line.replace(/\s+$/, ''));
    }
    return out.length ? out : [String(text)];
  }

  /**
   * 让译文在 boxW x boxH 内尽量大且完整。
   * 返回 { fontSize, lines }
   */
  function fitText(ctx, text, boxW, boxH, family, startSize, maxLines, dpr, bold) {
    const pad = Math.max(1, (dpr || 1) * 1.5);
    const maxW = Math.max(6, boxW - pad * 2);
    const maxH = Math.max(6, boxH);
    let size = Math.max(7, Math.min(startSize || boxH * 0.78, maxH));

    for (let guard = 0; guard < 80; guard++) {
      ctx.font = fontStr(size, family, bold);
      const lines = wrapText(ctx, text, maxW);
      const lh = size * 1.16;
      const fitsW = lines.every((l) => ctx.measureText(l).width <= maxW + 0.5);
      if (fitsW && lines.length <= maxLines && lines.length * lh <= maxH + 0.5) {
        return { fontSize: size, lines };
      }
      if (size <= 7.2) {
        ctx.font = fontStr(size, family, bold);
        return { fontSize: size, lines: wrapText(ctx, text, maxW).slice(0, maxLines) };
      }
      size = Math.max(7, size * 0.93);
    }
    ctx.font = fontStr(size, family, bold);
    return { fontSize: size, lines: wrapText(ctx, text, maxW).slice(0, maxLines) };
  }

  /* ---------------- 命中测试 ---------------- */
  const distToSeg = (p, a, b) => {
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const l2 = vx * vx + vy * vy || 1;
    let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
  };

  function hit(o, p, dpr) {
    const tol = Math.max(5, 6 * (dpr || 1));
    const b = bboxOf(o);
    switch (o.type) {
      case 'arrow':
        return distToSeg(p, { x: o.x1, y: o.y1 }, { x: o.x2, y: o.y2 }) <= tol + o.size;
      case 'pen': {
        for (let i = 1; i < o.points.length; i++) {
          if (distToSeg(p, o.points[i - 1], o.points[i]) <= tol + o.size) return true;
        }
        return false;
      }
      case 'rect':
        if (o.fill) return p.x >= b.x && p.x <= b.x1 && p.y >= b.y && p.y <= b.y1;
        // 空心：只有边框附近算命中
        return (
          (Math.abs(p.x - b.x) <= tol + o.size || Math.abs(p.x - b.x1) <= tol + o.size ||
            Math.abs(p.y - b.y) <= tol + o.size || Math.abs(p.y - b.y1) <= tol + o.size) &&
          p.x >= b.x - tol - o.size && p.x <= b.x1 + tol + o.size &&
          p.y >= b.y - tol - o.size && p.y <= b.y1 + tol + o.size
        );
      case 'ellipse': {
        const cx = (b.x + b.x1) / 2;
        const cy = (b.y + b.y1) / 2;
        const rx = Math.max(1, (b.x1 - b.x) / 2);
        const ry = Math.max(1, (b.y1 - b.y) / 2);
        const v = Math.pow((p.x - cx) / rx, 2) + Math.pow((p.y - cy) / ry, 2);
        if (o.fill) return v <= 1;
        // 未填充：到椭圆轮廓的距离 ≈ |归一化半径 - 1| × 短半轴
        return Math.abs(Math.sqrt(v) - 1) * Math.min(rx, ry) <= tol + o.size;
      }
      default:
        return p.x >= b.x - tol && p.x <= b.x1 + tol && p.y >= b.y - tol && p.y <= b.y1 + tol;
    }
  }

  /** 返回手柄方向：'nw'|'n'|... |'p1'|'p2'|'k0..3' | null */
  function hitHandle(o, p, dpr) {
    const t = Math.max(5, 5.5 * (dpr || 1));
    const near = (x, y) => Math.abs(p.x - x) <= t && Math.abs(p.y - y) <= t;
    if (o.type === 'arrow') {
      if (near(o.x1, o.y1)) return 'p1';
      if (near(o.x2, o.y2)) return 'p2';
      return null;
    }
    const b = bboxOf(o);
    const cx = (b.x + b.x1) / 2;
    const cy = (b.y + b.y1) / 2;
    const pts = {
      nw: [b.x, b.y], n: [cx, b.y], ne: [b.x1, b.y], e: [b.x1, cy],
      se: [b.x1, b.y1], s: [cx, b.y1], sw: [b.x, b.y1], w: [b.x, cy],
    };
    if (o.type === 'pen' || o.type === 'emoji') {
      // 只给 4 个角
      for (const k of ['nw', 'ne', 'se', 'sw']) {
        if (near(pts[k][0], pts[k][1])) return k;
      }
      return null;
    }
    for (const k of Object.keys(pts)) {
      if (near(pts[k][0], pts[k][1])) return k;
    }
    return null;
  }

  function handlePoints(o) {
    if (o.type === 'arrow') {
      return [{ k: 'p1', x: o.x1, y: o.y1 }, { k: 'p2', x: o.x2, y: o.y2 }];
    }
    const b = bboxOf(o);
    const cx = (b.x + b.x1) / 2;
    const cy = (b.y + b.y1) / 2;
    const all = {
      nw: [b.x, b.y], n: [cx, b.y], ne: [b.x1, b.y], e: [b.x1, cy],
      se: [b.x1, b.y1], s: [cx, b.y1], sw: [b.x, b.y1], w: [b.x, cy],
    };
    const keys = o.type === 'pen' || o.type === 'emoji' ? ['nw', 'ne', 'se', 'sw'] : Object.keys(all);
    return keys.map((k) => ({ k, x: all[k][0], y: all[k][1] }));
  }

  /** 按手柄方向调整对象（orig 是拖动开始时的快照） */
  function applyResize(o, dir, orig, dx, dy, minSize) {
    const min = minSize || 8;
    if (o.type === 'arrow') {
      if (dir === 'p1') { o.x1 = orig.x1 + dx; o.y1 = orig.y1 + dy; }
      else { o.x2 = orig.x2 + dx; o.y2 = orig.y2 + dy; }
      return;
    }
    if (o.type === 'pen') {
      const b0 = bboxOf(orig);
      const w0 = Math.max(1, b0.x1 - b0.x);
      const h0 = Math.max(1, b0.y1 - b0.y);
      const sx = (dir.includes('e') ? w0 + dx : dir.includes('w') ? w0 - dx : w0) / w0;
      const sy = (dir.includes('s') ? h0 + dy : dir.includes('n') ? h0 - dy : h0) / h0;
      const anchorX = dir.includes('w') ? b0.x1 : b0.x;
      const anchorY = dir.includes('n') ? b0.y1 : b0.y;
      o.points = orig.points.map((p) => ({
        x: anchorX + (p.x - anchorX) * sx,
        y: anchorY + (p.y - anchorY) * sy,
      }));
      return;
    }
    if (o.type === 'text') {
      const b0 = bboxOf(orig);
      const w0 = Math.max(1, b0.x1 - b0.x);
      const h0 = Math.max(1, b0.y1 - b0.y);
      const sx = (dir.includes('e') ? w0 + dx : dir.includes('w') ? w0 - dx : w0) / w0;
      const sy = (dir.includes('s') ? h0 + dy : dir.includes('n') ? h0 - dy : h0) / h0;
      const s = Math.max(0.12, (sx + sy) / 2);
      o.size = Math.max(6, orig.size * s);
      const anchorX = dir.includes('w') ? b0.x1 : b0.x;
      const anchorY = dir.includes('n') ? b0.y1 : b0.y;
      o.x = anchorX + (orig.x - anchorX) * s;
      o.y = anchorY + (orig.y - anchorY) * s;
      return;
    }
    if (o.type === 'emoji') {
      const b0 = bboxOf(orig);
      const w0 = Math.max(1, b0.x1 - b0.x);
      const s = Math.max(0.1, (dir.includes('e') ? w0 + dx : w0 - dx) / w0);
      o.size = Math.max(min, orig.size * s);
      const anchorX = dir.includes('w') ? b0.x1 : b0.x;
      const anchorY = dir.includes('n') ? b0.y1 : b0.y;
      o.x = anchorX + (orig.x - anchorX) * s;
      o.y = anchorY + (orig.y - anchorY) * s;
      return;
    }
    // 通用 bbox 类型
    let x0 = orig.x;
    let y0 = orig.y;
    let x1 = orig.x + orig.w;
    let y1 = orig.y + orig.h;
    if (dir.includes('w')) x0 = orig.x + dx;
    if (dir.includes('e')) x1 = orig.x + orig.w + dx;
    if (dir.includes('n')) y0 = orig.y + dy;
    if (dir.includes('s')) y1 = orig.y + orig.h + dy;
    if (x1 - x0 < min) { if (dir.includes('w')) x0 = x1 - min; else x1 = x0 + min; }
    if (y1 - y0 < min) { if (dir.includes('n')) y0 = y1 - min; else y1 = y0 + min; }
    o.x = x0; o.y = y0; o.w = x1 - x0; o.h = y1 - y0;
    if (o.type === 'trans') o.autoFit = false;
  }

  /* ---------------- 选区框 / 手柄绘制 ---------------- */
  function drawSelection(ctx, o, dpr) {
    const b = bboxOf(o);
    const pad = 3 * (dpr || 1);
    ctx.save();
    ctx.strokeStyle = '#07c160';
    ctx.lineWidth = 1.2 * (dpr || 1);
    ctx.setLineDash([4 * (dpr || 1), 3 * (dpr || 1)]);
    ctx.strokeRect(b.x - pad, b.y - pad, b.x1 - b.x + pad * 2, b.y1 - b.y + pad * 2);
    ctx.setLineDash([]);

    const hs = 4 * (dpr || 1);
    for (const h of handlePoints(o)) {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#07c160';
      ctx.lineWidth = 1.2 * (dpr || 1);
      ctx.beginPath();
      ctx.rect(h.x - hs, h.y - hs, hs * 2, hs * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------------- 取色 ---------------- */
  function parseColor(s) {
    const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(String(s));
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
    const h = /^#([0-9a-f]{6})$/i.exec(String(s));
    if (h) {
      const n = parseInt(h[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    return [255, 255, 255];
  }

  const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /** 采样背景色：取文字框外扩一圈的众数颜色 */
  function sampleBg(src, b, pad) {
    const ctx = src.getContext('2d', { willReadFrequently: true });
    const grow = Math.max(2, (pad || 2) * 2);
    const x0 = clampI(Math.floor(b.x0 - grow), 0, src.width - 1);
    const y0 = clampI(Math.floor(b.y0 - grow), 0, src.height - 1);
    const x1 = clampI(Math.ceil(b.x1 + grow), x0 + 1, src.width);
    const y1 = clampI(Math.ceil(b.y1 + grow), y0 + 1, src.height);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 2 || h < 2) return '#ffffff';

    const d = ctx.getImageData(x0, y0, w, h).data;
    const counts = new Map();
    const ring = Math.max(1, Math.round(Math.min(w, h) * 0.18));
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const border = xx < ring || yy < ring || xx >= w - ring || yy >= h - ring;
        if (!border) continue;
        const i = (yy * w + xx) * 4;
        const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
        let e = counts.get(key);
        if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; counts.set(key, e); }
        e.n++; e.r += d[i]; e.g += d[i + 1]; e.b += d[i + 2];
      }
    }
    let best = null;
    for (const e of counts.values()) if (!best || e.n > best.n) best = e;
    if (!best) return '#ffffff';
    return `rgb(${Math.round(best.r / best.n)},${Math.round(best.g / best.n)},${Math.round(best.b / best.n)})`;
  }

  /** 采样文字色：框内与背景色差异最大的那批像素的平均色 */
  function sampleFg(src, b, bg) {
    const ctx = src.getContext('2d', { willReadFrequently: true });
    const x0 = clampI(Math.floor(b.x0), 0, src.width - 1);
    const y0 = clampI(Math.floor(b.y0), 0, src.height - 1);
    const x1 = clampI(Math.ceil(b.x1), x0 + 1, src.width);
    const y1 = clampI(Math.ceil(b.y1), y0 + 1, src.height);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 1 || h < 1) return '#000000';

    const [br, bgc, bb] = parseColor(bg);
    const d = ctx.getImageData(x0, y0, w, h).data;
    const lum = (0.299 * br + 0.587 * bgc + 0.114 * bb) / 255;

    const list = [];
    let maxDist = 0;
    for (let i = 0; i < d.length; i += 4) {
      const dist = Math.pow(d[i] - br, 2) + Math.pow(d[i + 1] - bgc, 2) + Math.pow(d[i + 2] - bb, 2);
      list.push({ dist, i });
      if (dist > maxDist) maxDist = dist;
    }
    if (maxDist < 2500) return lum > 0.55 ? '#000000' : '#ffffff';

    list.sort((a, z) => z.dist - a.dist);
    const top = list.slice(0, Math.max(1, Math.floor(list.length * 0.06)));
    let r = 0, g = 0, bl = 0;
    for (const t of top) { r += d[t.i]; g += d[t.i + 1]; bl += d[t.i + 2]; }
    return `rgb(${Math.round(r / top.length)},${Math.round(g / top.length)},${Math.round(bl / top.length)})`;
  }

  /**
   * 量笔画粗细：bbox 内「水平墨迹游程」的中位数 ÷ bbox 高度。
   *
   * 两个关键点：
   * 1) 墨迹阈值必须按**实测的前景/背景对比度**归一化。用绝对阈值时，
   *    低对比度的灰色文字被少算、高对比度的黑色文字被多算 —— 同为常规体，
   *    19px 灰字量出 0.05、24px 黑字量出 0.12，同一个字重量出来差一倍。
   * 2) 除以 bbox 高度而不是字号：字号本身是估出来的，会二次引入误差。
   *
   * 实测标定（同色同底）：
   *   24px 常规 0.080 / 24px 粗体 0.160
   *   19px 常规 0.050 / 20px 粗体 0.235 / 38px 粗体 0.154 / 15px 粗体 0.364
   *
   * 阈值必须**随字高变化**：小字号时栅格化会把笔画下限压到 1px，比值被系统性抬高
   * （15px 粗体量出 0.364，而 38px 粗体只有 0.154）。用固定阈值 0.12 会漏掉
   * 徽章那种小号粗体（"NEW" capH=11 被判定为非粗体）。
   * 故 capH ≥ 20 用 0.12，之后按每 px 线性抬到 capH=11 时的 0.25。
   */
  const BOLD_MIN_H = 9; // 低于此高度笔画测量已无意义
  function boldThreshold(capH) {
    return capH >= 20 ? 0.12 : 0.12 + (20 - capH) * 0.0145;
  }

  function inkStrokeRatio(src, b, bg, fg) {
    const ctx = src.getContext('2d', { willReadFrequently: true });
    const x0 = clampI(Math.floor(b.x0), 0, src.width - 1);
    const y0 = clampI(Math.floor(b.y0), 0, src.height - 1);
    const x1 = clampI(Math.ceil(b.x1), x0 + 1, src.width);
    const y1 = clampI(Math.ceil(b.y1), y0 + 1, src.height);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 2 || h < BOLD_MIN_H) return 0;

    const [br, bgc, bb] = parseColor(bg);
    const [fr, fgc, fb] = parseColor(fg);
    const contrast = Math.abs(fr - br) + Math.abs(fgc - bgc) + Math.abs(fb - bb);
    if (contrast < 120) return 0; // 前景背景几乎同色，量不出笔画
    const TH = Math.max(60, contrast * 0.45);

    const d = ctx.getImageData(x0, y0, w, h).data;
    const runs = [];
    for (let yy = 0; yy < h; yy++) {
      let run = 0;
      for (let xx = 0; xx < w; xx++) {
        const i = (yy * w + xx) * 4;
        const dist = Math.abs(d[i] - br) + Math.abs(d[i + 1] - bgc) + Math.abs(d[i + 2] - bb);
        if (dist > TH) run++;
        else { if (run) runs.push(run); run = 0; }
      }
      if (run) runs.push(run);
    }
    if (!runs.length) return 0;
    runs.sort((a, z) => a - z);
    return runs[Math.floor(runs.length / 2)] / h;
  }

  function detectBold(src, b, bg, fg) {
    const ratio = inkStrokeRatio(src, b, bg, fg);
    const capH = b.y1 - b.y0;
    if (capH < BOLD_MIN_H || !ratio) return false;
    return ratio >= boldThreshold(capH);
  }

  window.OBJ = {
    pickFamily, bboxOf, translateObj, cloneObj,
    draw, hit, hitHandle, handlePoints, applyResize, drawSelection,
    fitText, wrapText, sampleBg, sampleFg, parseColor,
    inkStrokeRatio, detectBold, fontStr,
  };
})();
