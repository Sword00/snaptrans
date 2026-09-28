'use strict';
(function () {
  const api = window.api;
  const img = document.getElementById('img');
  const tip = document.getElementById('tip');

  let baseW = 0;
  let baseH = 0;
  let scale = 1;
  let timer = null;

  function showTip(t) {
    tip.textContent = t;
    tip.style.display = 'block';
    clearTimeout(timer);
    timer = setTimeout(() => { tip.style.display = 'none'; }, 1600);
  }

  api.onPinInit((p) => {
    img.src = p.dataUrl;
    baseW = p.width;
    baseH = p.height;
    scale = 1;
  });

  document.addEventListener('wheel', async (e) => {
    e.preventDefault();
    if (!baseW) return;
    const step = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    const next = Math.max(0.15, Math.min(6, scale * step));
    if (Math.abs(next - scale) < 0.001) return;
    scale = next;
    await api.pinResize(baseW * scale, baseH * scale);
    showTip(Math.round(scale * 100) + '%');
  }, { passive: false });

  document.getElementById('btnCopy').addEventListener('click', async (e) => {
    e.stopPropagation();
    await api.copyImage(img.src);
    showTip('已复制到剪贴板');
  });

  document.getElementById('btnSave').addEventListener('click', async (e) => {
    e.stopPropagation();
    const r = await api.saveImage(img.src, null);
    if (r && r.ok) showTip('已保存');
  });

  document.getElementById('btnClose').addEventListener('click', (e) => {
    e.stopPropagation();
    api.pinClose();
  });

  document.addEventListener('dblclick', () => api.pinClose());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.pinClose();
  });
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.pinClose();
  });
})();
