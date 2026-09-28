'use strict';
/**
 * 设置持久化：userData/settings.json
 */
const fs = require('fs');
const path = require('path');

let FILE = null;
let data = null;

const DEFAULTS = {
  hotkey: 'Alt+Shift+A',
  // OCR 引擎：local = 本地 PaddleOCR PP-OCRv4（离线免费）
  ocrEngine: 'local',
  // 翻译引擎：free = 免费接口（Edge/Google/MyMemory）；llm = OpenAI 兼容大模型
  translateEngine: 'free',
  freeProvider: 'auto', // auto | edge | google | mymemory
  sourceLang: 'auto',
  targetLang: 'zh-Hans',
  // LLM 配置
  llm: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
  },
  // 编辑默认样式
  color: '#ff3b30',
  strokeSize: 3,
  // 译文渲染
  fontSizeScale: 1,
  textColorAuto: true,
  fontWeightAuto: true,
  // 完成后自动复制到剪贴板
  autoCopy: true,
};

function init() {
  if (FILE) return;
  const { app } = require('electron');
  FILE = path.join(app.getPath('userData'), 'settings.json');
  data = { ...DEFAULTS };
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      data = { ...DEFAULTS, ...raw, llm: { ...DEFAULTS.llm, ...(raw.llm || {}) } };
    }
  } catch (e) {
    console.error('[settings] 读取失败，使用默认值：', e.message);
  }
}

function all() {
  init();
  return JSON.parse(JSON.stringify(data));
}

function get(k) {
  init();
  return data[k];
}

function set(patch) {
  init();
  data = { ...data, ...patch, llm: { ...data.llm, ...(patch.llm || {}) } };
  try {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[settings] 保存失败：', e.message);
  }
  return all();
}

function filePath() {
  init();
  return FILE;
}

module.exports = { init, all, get, set, filePath, DEFAULTS };
