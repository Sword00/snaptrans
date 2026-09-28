'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  /* 遮罩层 */
  onInit: on('overlay:init'),
  closeAll: () => ipcRenderer.invoke('overlay:close-all'),
  closeOthers: () => ipcRenderer.invoke('overlay:close-others'),
  hideSelf: () => ipcRenderer.invoke('overlay:hide-self'),
  showSelf: () => ipcRenderer.invoke('overlay:show-self'),

  /* 识别 / 翻译 */
  ocrImage: (dataUrl) => ipcRenderer.invoke('ocr:image', { dataUrl }),
  translateImage: (dataUrl) => ipcRenderer.invoke('translate:image', { dataUrl }),
  translateText: (texts) => ipcRenderer.invoke('translate:text', { texts }),
  onOcrProgress: on('ocr:progress'),
  ocrWarmup: () => ipcRenderer.invoke('ocr:warmup'),

  /* 输出 */
  copyImage: (dataUrl) => ipcRenderer.invoke('clipboard:image', dataUrl),
  copyText: (text) => ipcRenderer.invoke('clipboard:text', text),
  saveImage: (dataUrl, name) => ipcRenderer.invoke('file:save-image', { dataUrl, name }),
  pin: (payload) => ipcRenderer.invoke('pin:create', payload),

  /* 贴图窗口 */
  onPinInit: on('pin:init'),
  pinResize: (width, height) => ipcRenderer.invoke('pin:resize', { width, height }),
  pinClose: () => ipcRenderer.invoke('pin:close'),

  /* 设置 */
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  openSettings: () => ipcRenderer.invoke('settings:open'),
  selfTest: (patch) => ipcRenderer.invoke('translate:selftest', patch),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  /* 数据目录 */
  chooseDataDir: () => ipcRenderer.invoke('settings:choose-data-dir'),
  setDataDir: (dir) => ipcRenderer.invoke('settings:set-data-dir', { dir }),
  resetDataDir: () => ipcRenderer.invoke('settings:reset-data-dir'),
  openDataDir: () => ipcRenderer.invoke('shell:open-data-dir'),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),

  /* 长截图 */
  longshotCapture: (payload) => ipcRenderer.invoke('longshot:capture', payload),
  longshotScroll: (payload) => ipcRenderer.invoke('longshot:scroll', payload),
  longshotProbe: () => ipcRenderer.invoke('longshot:probe'),

  quit: () => ipcRenderer.invoke('app:quit'),
});
